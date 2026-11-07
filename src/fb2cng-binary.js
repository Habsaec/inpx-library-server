/**
 * Бинарник fbc (fb2cng): какой используется и обновление из Админки (Контент → Конвертация).
 *
 * Приоритет пути: FB2CNG_PATH (явный) → data/converter/bin/fbc[.exe] (установлен из админки) → поставляемый
 * converter/fbc[.exe] (config.fb2cngPath). «Вернуть встроенный» просто удаляет установленный файл.
 * Обновление: официальный релиз rupor-github/fb2cng на GitHub, SHA-256 сверяется с дайджестом релиза из API
 * (нет дайджеста — отказ), из архива берётся только запись fbc[.exe]; новый файл проверяется запуском
 * `--version` и `dumpconfig` с текущим конфигом, и лишь потом заменяет установленный.
 * Сеть — только по нажатию кнопки администратором.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import unzipper from 'unzipper';
import { config } from './config.js';

const REPO = 'rupor-github/fb2cng';
const MAX_ZIP_BYTES = 200 * 1024 * 1024;
const MAX_BIN_BYTES = 300 * 1024 * 1024;
const exeName = process.platform === 'win32' ? 'fbc.exe' : 'fbc';

export function getInstalledFbcPath() {
  return path.join(config.dataDir, 'converter', 'bin', exeName);
}

/** Путь, которым реально запускаем fbc. */
export function getFb2cngBinaryPath() {
  if (process.env.FB2CNG_PATH) return config.fb2cngPath;
  const installed = getInstalledFbcPath();
  try {
    if (fs.statSync(installed).isFile()) return installed;
  } catch { /* not installed */ }
  return config.fb2cngPath;
}

export function isFbcInstalledFromAdmin() {
  return !process.env.FB2CNG_PATH && getFb2cngBinaryPath() === getInstalledFbcPath();
}

/** Имя архива релиза для этой платформы или '' (неподдерживаемая). */
export function fbcAssetName(platform = process.platform, arch = process.arch) {
  const os = { win32: 'windows', linux: 'linux', darwin: 'darwin' }[platform];
  const cpu = { x64: 'amd64', arm64: 'arm64', ia32: '386' }[arch];
  if (!os || !cpu) return '';
  if (os === 'darwin' && cpu === '386') return '';
  return `fbc-${os}-${cpu}.zip`;
}

export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'inpx-library-server' },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`GitHub API: HTTP ${res.status}`);
  return res.json();
}

let latestMemo = null; // { at, info }

/** Fallback without the REST API (60 requests/hour per IP, often exhausted behind a NAT): release page redirect + asset list. */
async function checkLatestViaWeb(assetName) {
  const head = await fetch(`https://github.com/${REPO}/releases/latest`, {
    redirect: 'manual', headers: { 'User-Agent': 'inpx-library-server' }, signal: AbortSignal.timeout(15000)
  });
  const loc = String(head.headers.get('location') || '');
  const tag = /\/releases\/tag\/(v?\d+\.\d+\.\d+)$/.exec(loc)?.[1] || '';
  if (!tag) throw new Error('Cannot determine the latest release');
  const res = await fetch(`https://github.com/${REPO}/releases/expanded_assets/${tag}`, {
    headers: { 'User-Agent': 'inpx-library-server' }, signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
  const html = await res.text();
  const at = html.indexOf(`/releases/download/${tag}/${assetName}`);
  if (at < 0) throw new Error(`Release ${tag} has no ${assetName}`);
  const sha = /sha256:([0-9a-f]{64})/i.exec(html.slice(at, at + 1500));
  return {
    tag, assetName,
    url: `https://github.com/${REPO}/releases/download/${tag}/${assetName}`,
    sha256: sha ? sha[1].toLowerCase() : '', size: 0, publishedAt: ''
  };
}

/**
 * Последний релиз для этой платформы: { tag, version, asset, url, sha256, size, publishedAt }.
 * Память 1 час; force — перечитать.
 */
export async function checkLatestFbc({ force = false } = {}) {
  if (!force && latestMemo && Date.now() - latestMemo.at < 3600_000) return latestMemo.info;
  const assetName = fbcAssetName();
  if (!assetName) throw new Error(`Unsupported platform ${process.platform}/${process.arch}`);
  let found;
  try {
    const rel = await fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`);
    const tag = String(rel?.tag_name || '');
    const asset = (rel.assets || []).find((a) => a.name === assetName);
    if (!asset) throw new Error(`Release ${tag} has no ${assetName}`);
    const sha = /^sha256:([0-9a-f]{64})$/i.exec(String(asset.digest || ''));
    found = {
      tag, assetName, url: String(asset.browser_download_url || ''), sha256: sha ? sha[1].toLowerCase() : '',
      size: Number(asset.size) || 0, publishedAt: String(rel.published_at || '')
    };
  } catch (err) {
    if (!/HTTP (403|429)/.test(String(err.message))) throw err;
    found = await checkLatestViaWeb(assetName);
  }
  if (!/^v?\d+\.\d+\.\d+$/.test(found.tag)) throw new Error('Unexpected release tag');
  const info = {
    tag: found.tag,
    version: found.tag.replace(/^v/, ''),
    asset: assetName,
    url: found.url,
    sha256: found.sha256,
    size: found.size,
    publishedAt: found.publishedAt
  };
  latestMemo = { at: Date.now(), info };
  return info;
}

export function getCachedLatestFbc() {
  return latestMemo?.info || null;
}

function runBinary(bin, args, cwd) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ ok: false, out: 'timeout' }); }, 20000);
    child.stdout.on('data', (c) => { if (out.length < 4000) out += String(c); });
    child.stderr.on('data', (c) => { if (out.length < 4000) out += String(c); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, out: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out: out.trim() }); });
  });
}

let installing = false;

/**
 * Скачать, проверить и установить последний fbc. `validateConfigPath` — YAML, который новый бинарник обязан принять.
 * @returns {Promise<{ version: string, previous: string }>}
 */
export async function installLatestFbc({ validateConfigPath = '', previousVersion = '' } = {}) {
  if (installing) throw new Error('Update is already running');
  installing = true;
  const work = path.join(config.conversionTempDir, `fbc-update-${crypto.randomBytes(6).toString('hex')}`);
  try {
    const info = await checkLatestFbc({ force: true });
    if (!info.sha256) throw new Error('Release has no SHA-256 digest — refusing to install');
    if (info.size > MAX_ZIP_BYTES) throw new Error('Archive is too large');
    await fs.promises.mkdir(work, { recursive: true });

    // 1. download + hash
    const zipPath = path.join(work, 'fbc.zip');
    const res = await fetch(info.url, { headers: { 'User-Agent': 'inpx-library-server' }, signal: AbortSignal.timeout(300_000) });
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
    const hash = crypto.createHash('sha256');
    let total = 0;
    const out = fs.createWriteStream(zipPath);
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_ZIP_BYTES) throw new Error('Archive is too large');
        hash.update(value);
        if (!out.write(value)) await new Promise((r) => out.once('drain', r));
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    if (hash.digest('hex') !== info.sha256) throw new Error('SHA-256 mismatch — download discarded');

    // 2. only the fbc executable out of the archive
    const dir = await unzipper.Open.file(zipPath);
    const entry = dir.files.find((f) => f.type === 'File' && path.posix.basename(f.path.replace(/\\/g, '/')) === exeName);
    if (!entry) throw new Error(`${exeName} not found in the archive`);
    if (entry.uncompressedSize > MAX_BIN_BYTES) throw new Error('Executable is too large');
    const candidate = path.join(work, exeName);
    await pipeline(entry.stream(), fs.createWriteStream(candidate, { mode: 0o755 }));
    if (process.platform !== 'win32') await fs.promises.chmod(candidate, 0o755);

    // 3. the new binary has to run and to accept the current configuration
    const ver = await runBinary(candidate, ['--version'], work);
    const vm = /(\d+\.\d+\.\d+)/.exec(ver.out);
    if (!ver.ok || !vm || vm[1] !== info.version) throw new Error(`New binary check failed: ${ver.out.slice(0, 200)}`);
    if (validateConfigPath) {
      const dump = await runBinary(candidate, ['-c', validateConfigPath, 'dumpconfig', path.join(work, 'dump.yaml')], work);
      if (!dump.ok || /error/i.test(dump.out)) {
        throw new Error(`The new fbc rejects the current conversion settings: ${dump.out.slice(0, 300)}`);
      }
    }

    // 4. swap in (a running Windows exe cannot be overwritten, but can be renamed)
    const target = getInstalledFbcPath();
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const old = `${target}.old`;
    await fs.promises.rm(old, { force: true }).catch(() => {});
    let hadOld = false;
    try {
      await fs.promises.rename(target, old);
      hadOld = true;
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`Cannot replace the installed fbc (in use?): ${err.message}`);
    }
    try {
      await fs.promises.copyFile(candidate, target);
      if (process.platform !== 'win32') await fs.promises.chmod(target, 0o755);
    } catch (err) {
      if (hadOld) await fs.promises.rename(old, target).catch(() => {});
      throw err;
    }
    if (hadOld) await fs.promises.rm(old, { force: true }).catch(() => {});
    latestMemo = null;
    return { version: info.version, previous: previousVersion };
  } finally {
    installing = false;
    await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** Удалить установленный из админки fbc — дальше используется поставляемый. */
export async function resetInstalledFbc() {
  await fs.promises.rm(getInstalledFbcPath(), { force: true });
  await fs.promises.rm(`${getInstalledFbcPath()}.old`, { force: true }).catch(() => {});
}
