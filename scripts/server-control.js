import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const command = String(process.argv[2] || 'status').toLowerCase();
const explicitPort = Number(process.argv[3] || 0);
const targetPort = Number.isInteger(explicitPort) && explicitPort > 0 ? explicitPort : config.port;
const statePath = path.join(config.dataDir, `server-process-${targetPort}.json`);
const serverLogPath = path.join(config.dataDir, 'server.log');
const STARTUP_TIMEOUT_MS = Math.max(
  20_000,
  Number.parseInt(String(process.env.SERVER_STARTUP_TIMEOUT_MS || ''), 10) || 900_000
);

function resolveNodeExecutable() {
  const runtimeNode = path.join(config.rootDir, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  if (fs.existsSync(runtimeNode)) return runtimeNode;
  return process.execPath;
}

function ensureStateDir() {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

function readState() {
  try {
    if (!fs.existsSync(statePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(payload) {
  ensureStateDir();
  fs.writeFileSync(statePath, JSON.stringify(payload, null, 2), 'utf8');
}

function removeState() {
  try {
    if (fs.existsSync(statePath)) {
      fs.unlinkSync(statePath);
    }
  } catch {
  }
}

function isProcessAlive(pid) {
  if (!pid || !Number.isInteger(Number(pid))) {
    return false;
  }
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function findPidByPort(port) {
  let result;
  if (process.platform === 'win32') {
    result = spawnSync('cmd', ['/c', `netstat -ano | findstr LISTENING | findstr :${port}`], {
      cwd: config.rootDir,
      encoding: 'utf8',
      windowsHide: true
    });
  } else {
    result = spawnSync('sh', ['-c', `lsof -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null || ss -tlnp sport = :${port} 2>/dev/null | grep -oP 'pid=\K[0-9]+'`], {
      cwd: config.rootDir,
      encoding: 'utf8'
    });
  }

  if (result.status !== 0 || !result.stdout) {
    return 0;
  }

  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const parts = line.split(/\s+/).filter(Boolean);
    const pid = Number(parts[parts.length - 1] || 0);
    if (Number.isInteger(pid) && pid > 0) {
      return pid;
    }
  }

  return 0;
}

function getLiveState() {
  const state = readState();
  if (!state) {
    const portPid = findPidByPort(targetPort);
    if (!portPid) {
      return null;
    }
    const inferred = {
      pid: portPid,
      port: targetPort,
      startedAt: '',
      rootDir: config.rootDir,
      script: path.join(config.rootDir, 'src', 'server-entry.js')
    };
    writeState(inferred);
    return inferred;
  }
  if (!isProcessAlive(Number(state.pid))) {
    const portPid = findPidByPort(targetPort);
    if (!portPid) {
      removeState();
      return null;
    }
    const inferred = {
      ...state,
      pid: portPid,
      port: targetPort,
      rootDir: config.rootDir,
      script: path.join(config.rootDir, 'src', 'server-entry.js')
    };
    writeState(inferred);
    return inferred;
  }
  return state;
}

function readServerLogTail(maxLines = 10) {
  try {
    if (!fs.existsSync(serverLogPath)) return '';
    const lines = fs.readFileSync(serverLogPath, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}

async function waitForServerListen(pid, port, { timeoutMs = STARTUP_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return { ok: false, reason: 'process-exited' };
    }
    const portPid = findPidByPort(port);
    if (portPid === pid) {
      return { ok: true };
    }
    await delay(250);
  }
  if (!isProcessAlive(pid)) {
    return { ok: false, reason: 'process-exited' };
  }
  return { ok: false, reason: 'listen-timeout' };
}

function formatStartFailure(reason) {
  const tail = readServerLogTail();
  const logHint = tail
    ? `\nLast log lines (${path.relative(config.rootDir, serverLogPath)}):\n${tail}`
    : `\nSee ${path.relative(config.rootDir, serverLogPath)} for details.`;
  if (reason === 'process-exited') {
    return `Server process exited during startup.${logHint}`;
  }
  if (reason === 'listen-timeout') {
    return `Server did not open port ${targetPort} in time.${logHint}`;
  }
  return `Server failed to start.${logHint}`;
}

async function startServer() {
  const active = getLiveState();
  if (active) {
    console.log(`Server is already running on port ${active.port} (PID ${active.pid}).`);
    return;
  }

  const blockedPid = findPidByPort(targetPort);
  if (blockedPid) {
    throw new Error(
      `Port ${targetPort} is already in use by PID ${blockedPid}. ` +
      'Run stop-server.cmd or restart-server.cmd, then try again.'
    );
  }

  ensureStateDir();
  fs.appendFileSync(serverLogPath, `\n--- start ${new Date().toISOString()} ---\n`);
  const logFd = fs.openSync(serverLogPath, 'a');

  const child = spawn(resolveNodeExecutable(), [path.join('src', 'server-entry.js')], {
    cwd: config.rootDir,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, PORT: String(targetPort) }
  });
  try {
    fs.closeSync(logFd);
  } catch {
    /* ignore */
  }
  child.unref();

  if (!child.pid) {
    throw new Error('Failed to spawn server process.');
  }

  writeState({
    pid: child.pid,
    port: targetPort,
    startedAt: new Date().toISOString(),
    rootDir: config.rootDir,
    script: path.join(config.rootDir, 'src', 'server-entry.js')
  });

  const ready = await waitForServerListen(child.pid, targetPort);
  if (!ready.ok) {
    removeState();
    if (isProcessAlive(child.pid)) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        try {
          process.kill(child.pid);
        } catch {
          /* ignore */
        }
      }
    }
    throw new Error(formatStartFailure(ready.reason));
  }

  console.log(`Server started on http://localhost:${targetPort} (PID ${child.pid}).`);
}

async function stopServer() {
  const active = getLiveState();
  if (!active) {
    console.log('Server is not running.');
    return;
  }

  let result;
  if (process.platform === 'win32') {
    result = spawnSync('taskkill', ['/PID', String(active.pid), '/T', '/F'], {
      cwd: config.rootDir,
      stdio: 'ignore',
      windowsHide: true
    });
  } else {
    result = spawnSync('kill', ['-TERM', String(active.pid)], {
      cwd: config.rootDir,
      stdio: 'ignore'
    });
  }

  if (result.status !== 0 && isProcessAlive(Number(active.pid))) {
    throw new Error(`Failed to stop server process ${active.pid}.`);
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!isProcessAlive(Number(active.pid))) {
      removeState();
      console.log(`Server stopped (PID ${active.pid}).`);
      return;
    }
    await delay(250);
  }

  removeState();
  console.log(`Stop signal sent to PID ${active.pid}.`);
}

async function restartServer() {
  await stopServer();
  await delay(600);
  await startServer();
}

function printStatus() {
  const active = getLiveState();
  if (!active) {
    console.log('Server status: stopped.');
    return;
  }
  console.log(`Server status: running on http://localhost:${active.port} (PID ${active.pid}).`);
}

try {
  if (command === 'start') {
    await startServer();
  } else if (command === 'stop') {
    await stopServer();
  } else if (command === 'restart') {
    await restartServer();
  } else {
    printStatus();
  }
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
}
