/**
 * Self-update service: extracts a ZIP with new source code over the project root,
 * with path safety, quota checks, backup/restore and npm install.
 *
 * Extracted from routes/admin.js to keep the admin registrar focused on HTTP wiring.
 * The caller (routes/admin.js) still owns the Express routing + auth + i18n; this
 * module is pure domain logic with callbacks for logging.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import {
  UPDATE_TIMEOUT_MS, UPDATE_PROTECTED_DIRS, UPDATE_PROTECTED_FILES,
  MAX_UNCOMPRESSED_TOTAL, MAX_SINGLE_FILE
} from '../constants.js';
import { logSystemEvent } from './system-events.js';
import { rotateIfNeeded } from '../utils/log-rotate.js';

const UPDATE_LOG_PATH = path.join(config.dataDir, 'update.log');
const UPDATABLE_DIRS = ['src', 'public', 'scripts'];

const state = {
  running: false,
  startedAt: 0
};

export function getUpdateState() {
  return { running: state.running, startedAt: state.startedAt };
}

export function isUpdateTimedOut() {
  return state.running && Date.now() - state.startedAt > UPDATE_TIMEOUT_MS;
}

export function readUpdateLog() {
  return fs.existsSync(UPDATE_LOG_PATH) ? fs.readFileSync(UPDATE_LOG_PATH, 'utf8') : '';
}

export function appendUpdateLog(line) {
  rotateIfNeeded(UPDATE_LOG_PATH);
  fs.appendFileSync(UPDATE_LOG_PATH, line + '\n', 'utf8');
}

function resetUpdateLog() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(UPDATE_LOG_PATH, '', 'utf8');
}

function isProtectedPath(relativePath) {
  const top = relativePath.split(/[/\\]/)[0];
  if (UPDATE_PROTECTED_DIRS.has(top) || UPDATE_PROTECTED_DIRS.has(relativePath)) return true;
  const normalized = relativePath.replace(/\\/g, '/');
  return UPDATE_PROTECTED_FILES.has(normalized);
}

function isSafePath(relativePath) {
  if (/\0/.test(relativePath)) return false;
  const normalized = path.normalize(relativePath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return false;
  if (/\.\.[/\\]/.test(relativePath)) return false;
  return true;
}

function copyRecursive(srcDir, destDir) {
  let copied = 0;
  const walk = (src, dest) => {
    const items = fs.readdirSync(src, { withFileTypes: true });
    for (const item of items) {
      const srcPath = path.join(src, item.name);
      const destPath = path.join(dest, item.name);
      if (item.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true });
        walk(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
        copied += 1;
      }
    }
  };
  walk(srcDir, destDir);
  return copied;
}

async function runNpmInstall() {
  return new Promise((resolve) => {
    const npmCliCandidates = [
      path.join(config.rootDir, 'runtime', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      path.join(config.rootDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    ];
    const npmCli = npmCliCandidates.find((c) => fs.existsSync(c));
    let spawnCmd, spawnArgs, spawnOpts;
    if (npmCli) {
      spawnCmd = process.execPath;
      spawnArgs = [npmCli, 'install', '--omit=dev'];
      spawnOpts = {};
    } else {
      spawnCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      spawnArgs = ['install', '--omit=dev'];
      spawnOpts = { shell: true };
    }
    try {
      const child = spawn(spawnCmd, spawnArgs, {
        cwd: config.rootDir, stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true, ...spawnOpts,
        env: { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '') }
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data) => { stdout += data; });
      child.stderr.on('data', (data) => { stderr += data; });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.on('error', (err) => resolve({ code: -1, stdout: '', stderr: err.message }));
    } catch (spawnErr) {
      resolve({ code: -1, stdout: '', stderr: spawnErr.message });
    }
  });
}

/**
 * Mark update as running; caller should first check `getUpdateState().running`.
 * Returns false if another update is already in progress and not timed out.
 */
export function beginUpdate() {
  if (state.running && !isUpdateTimedOut()) return false;
  // Сначала готовим лог: если mkdir/writeFile упадёт (диск R/O, нет прав) —
  // не оставляем state.running=true, иначе апдейт «залипает» до UPDATE_TIMEOUT_MS.
  try {
    resetUpdateLog();
  } catch (err) {
    state.running = false;
    throw err;
  }
  state.running = true;
  state.startedAt = Date.now();
  return true;
}

export function endUpdate() {
  state.running = false;
}

/**
 * Core update procedure.
 * @param {Buffer} zipBuffer
 * @param {object} opts
 * @param {(line: string) => void} opts.log - append user-facing (localized) log line
 * @param {(msg: string) => void} opts.sysLog - info-level system-events logger bound to user/context
 * @param {(msg: string, meta?: object) => void} opts.sysLogError - error-level
 * @param {string} opts.username
 * @param {() => void} opts.scheduleRestart - invoked on success, caller controls process restart
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function runUpdateFromZip(zipBuffer, opts) {
  const { log, sysLog, sysLogError, scheduleRestart } = opts;
  const backupDir = path.join(config.dataDir, 'update-backup');
  const tmpDir = path.join(config.dataDir, 'update-tmp-' + Date.now());

  const finishError = (reason, meta = {}) => {
    appendUpdateLog('[update:done] error');
    sysLogError(reason, meta);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    endUpdate();
    return { ok: false, reason };
  };

  try {
    log('archiveReceived', { size: (zipBuffer.length / 1024 / 1024).toFixed(1) });
    const unzipper = await import('unzipper');
    fs.mkdirSync(tmpDir, { recursive: true });
    log('unzipStart');
    const directory = await unzipper.Open.buffer(zipBuffer);

    let rootPrefix = '';
    const firstEntry = directory.files.find((f) => f.type === 'File');
    if (firstEntry) {
      const parts = firstEntry.path.split(/[/\\]/);
      if (parts.length > 1) {
        const candidate = parts[0] + '/';
        const allUnderCandidate = directory.files.every((f) => f.path.startsWith(candidate) || f.path === parts[0]);
        if (allUnderCandidate) {
          rootPrefix = candidate;
          log('archiveRoot', { root: parts[0] });
        }
      }
    }

    let totalUncompressed = 0;
    let extracted = 0;
    let skipped = 0;
    let blocked = 0;
    for (const entry of directory.files) {
      if (entry.type === 'Directory') continue;
      let relativePath = entry.path;
      if (rootPrefix && relativePath.startsWith(rootPrefix)) {
        relativePath = relativePath.slice(rootPrefix.length);
      }
      if (!relativePath) continue;
      if (!isSafePath(relativePath)) {
        log('unsafePath', { path: relativePath });
        blocked += 1;
        continue;
      }
      if (isProtectedPath(relativePath)) {
        skipped += 1;
        continue;
      }
      const targetPath = path.join(tmpDir, relativePath);
      const resolvedTarget = path.resolve(targetPath);
      const resolvedTmp = path.resolve(tmpDir);
      const relToTmp = path.relative(resolvedTmp, resolvedTarget);
      if (relToTmp.startsWith('..') || path.isAbsolute(relToTmp)) {
        log('pathEscape', { path: relativePath });
        blocked += 1;
        continue;
      }
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      const content = await entry.buffer();
      if (content.length > MAX_SINGLE_FILE) {
        log('fileTooBig', { size: (content.length / 1024 / 1024).toFixed(1), path: relativePath });
        blocked += 1;
        continue;
      }
      totalUncompressed += content.length;
      if (totalUncompressed > MAX_UNCOMPRESSED_TOTAL) {
        log('zipBomb', { max: (MAX_UNCOMPRESSED_TOTAL / 1024 / 1024).toFixed(0) });
        return finishError('update rejected: zip bomb detected', { totalUncompressed });
      }
      fs.writeFileSync(targetPath, content);
      extracted += 1;
    }

    if (blocked > 0) log('blockedSummary', { n: blocked });
    log('extractedSummary', { extracted, skipped });

    const newPkgPath = path.join(tmpDir, 'package.json');
    if (!fs.existsSync(newPkgPath)) {
      log('noPackageJson');
      return finishError('update rejected: no package.json');
    }
    let newPkg;
    try { newPkg = JSON.parse(fs.readFileSync(newPkgPath, 'utf8')); } catch { newPkg = {}; }
    if (newPkg.name !== 'inpx-library-server') {
      log('wrongPackage', { name: newPkg.name || '?' });
      return finishError('update rejected: wrong package name', { name: newPkg.name });
    }
    if (!fs.existsSync(path.join(tmpDir, 'src', 'server.js'))) {
      log('noServerJs');
      return finishError('update rejected: missing src/server.js');
    }
    log('archiveValid', { name: newPkg.name, version: newPkg.version || '?' });

    log('backupStart');
    fs.rmSync(backupDir, { recursive: true, force: true });
    fs.mkdirSync(backupDir, { recursive: true });
    const backupItems = [...UPDATABLE_DIRS, 'package.json'];
    for (const item of backupItems) {
      const srcPath = path.join(config.rootDir, item);
      const destPath = path.join(backupDir, item);
      if (!fs.existsSync(srcPath)) continue;
      const stat = fs.statSync(srcPath);
      if (stat.isDirectory()) fs.cpSync(srcPath, destPath, { recursive: true });
      else fs.copyFileSync(srcPath, destPath);
    }
    log('backupDone');

    log('cleanOld');
    for (const dir of UPDATABLE_DIRS) {
      const dirInTmp = path.join(tmpDir, dir);
      const dirInRoot = path.join(config.rootDir, dir);
      if (fs.existsSync(dirInTmp) && fs.existsSync(dirInRoot)) {
        fs.rmSync(dirInRoot, { recursive: true, force: true });
      }
    }

    log('copyFiles');
    const copied = copyRecursive(tmpDir, config.rootDir);
    log('copiedCount', { n: copied });

    log('cleanTmp');
    fs.rmSync(tmpDir, { recursive: true, force: true });

    let oldDeps = {};
    try { oldDeps = JSON.parse(fs.readFileSync(path.join(backupDir, 'package.json'), 'utf8')).dependencies || {}; } catch {}
    const newDeps = newPkg.dependencies || {};
    const normalizeDeps = (deps) => {
      if (!deps || typeof deps !== 'object') return {};
      const sorted = {};
      for (const k of Object.keys(deps).sort()) sorted[k] = deps[k];
      return sorted;
    };
    const depsChanged = JSON.stringify(normalizeDeps(oldDeps)) !== JSON.stringify(normalizeDeps(newDeps));
    if (!depsChanged) {
      log('depsUnchanged');
    } else {
      log('depsChanged');
      const npmResult = await runNpmInstall();
      if (npmResult.code === 0) {
        log('depsOk');
      } else {
        const hint = process.platform === 'win32' ? 'install.cmd' : 'sudo ./install.sh';
        log('npmFail', { code: npmResult.code, hint });
        if (npmResult.stderr) appendUpdateLog(npmResult.stderr.trim().slice(0, 500));
      }
    }

    log('doneVersion', { version: newPkg.version || '?' });
    log('restartingSoon');
    appendUpdateLog('[update:done] restart');
    sysLog('update completed, restarting', { version: newPkg.version });
    endUpdate();
    setTimeout(() => {
      try { scheduleRestart(); } catch { /* swallow — already restarting */ }
    }, 2000);
    return { ok: true };
  } catch (error) {
    log('errorLine', { message: error.message });
    appendUpdateLog('[update:done] error');
    if (fs.existsSync(backupDir) && fs.readdirSync(backupDir).length > 0) {
      log('restoreStart');
      try {
        copyRecursive(backupDir, config.rootDir);
        log('restoreOk');
      } catch (restoreErr) {
        log('restoreErr', { message: restoreErr.message });
      }
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    sysLogError('update failed', { error: error.message });
    endUpdate();
    return { ok: false, reason: error.message };
  }
}

export { UPDATE_LOG_PATH };
