/**
 * Update check service: queries GitHub Releases for the latest published
 * version and downloads the release ZIP asset for the self-update pipeline
 * (services/self-update.js).
 *
 * Pure result-building logic (buildUpdateCheckResult, compareVersions) is
 * exported separately so it can be unit-tested without network access.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const GITHUB_REPO = 'Habsaec/inpx-library-server';
const RELEASES_LATEST_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const CHECK_CACHE_TTL_MS = 30 * 60 * 1000; // повторная проверка не чаще раза в 30 минут (без force)
const CHECK_TIMEOUT_MS = 15 * 1000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_DOWNLOAD_SIZE = 200 * 1024 * 1024; // синхронно с limit '200mb' у POST /api/operations/update

let checkCache = null; // { at: number, result: object }

function readCurrentVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(config.rootDir, 'package.json'), 'utf8')).version || '?';
  } catch {
    return '?';
  }
}

/** '2.6.2' → [2, 6, 2]; null если строка не похожа на версию. */
function parseVersion(value) {
  const m = String(value || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Сравнение версий: 1 если a > b, -1 если a < b, 0 если равны или нераспознаны. */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

/** Собирает результат проверки из ответа GitHub /releases/latest. */
export function buildUpdateCheckResult(release, currentVersion) {
  const latestVersion = String(release?.tag_name || '').trim().replace(/^v/i, '');
  const asset = (Array.isArray(release?.assets) ? release.assets : [])
    .find((a) => /^inpx-library-server-.+\.zip$/i.test(String(a?.name || '')));
  return {
    currentVersion,
    latestVersion,
    updateAvailable: Boolean(asset) && compareVersions(latestVersion, currentVersion) > 0,
    releaseUrl: String(release?.html_url || ''),
    publishedAt: String(release?.published_at || ''),
    notes: String(release?.body || '').slice(0, 4000),
    assetName: asset ? String(asset.name) : '',
    assetSize: asset ? Number(asset.size) || 0 : 0,
    assetUrl: asset ? String(asset.browser_download_url || '') : '',
    checkedAt: new Date().toISOString()
  };
}

/**
 * Запись релиза из адреса `https://github.com/<repo>/releases/tag/v1.2.3` (редирект /releases/latest).
 * Формат как у ответа API, но без описания и даты; ZIP — по имени `inpx-library-server-<версия>.zip`.
 * null — адрес не похож на страницу релиза.
 */
export function releaseFromTagUrl(url) {
  const m = String(url || '').match(/\/releases\/tag\/([^/?#]+)/);
  if (!m) return null;
  const tag = decodeURIComponent(m[1]);
  const version = tag.replace(/^v/i, '');
  if (!parseVersion(version)) return null;
  const name = `inpx-library-server-${version}.zip`;
  return {
    tag_name: tag,
    html_url: `https://github.com/${GITHUB_REPO}/releases/tag/${encodeURIComponent(tag)}`,
    body: '',
    published_at: '',
    assets: [{
      name,
      size: 0,
      browser_download_url: `https://github.com/${GITHUB_REPO}/releases/download/${encodeURIComponent(tag)}/${name}`
    }]
  };
}

/** Последний релиз без GitHub API: редирект страницы /releases/latest + проверка, что ZIP на месте. */
async function fetchLatestReleaseViaWeb(currentVersion) {
  const headers = { 'User-Agent': `inpx-library-server/${currentVersion}` };
  const page = await fetch(`https://github.com/${GITHUB_REPO}/releases/latest`, {
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS)
  });
  const release = releaseFromTagUrl(page.headers.get('location'));
  if (!release) throw new Error(`release page HTTP ${page.status}`);
  const asset = release.assets[0];
  // Релиз без ZIP (или ещё не загруженным) не должен выглядеть как доступное обновление.
  const head = await fetch(asset.browser_download_url, {
    method: 'HEAD',
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS)
  }).catch(() => null);
  if (!head?.ok) {
    release.assets = [];
  } else {
    asset.size = Number(head.headers.get('content-length') || 0) || 0;
  }
  return release;
}

/**
 * Проверить наличие новой версии на GitHub.
 * Результат кешируется в памяти на CHECK_CACHE_TTL_MS; force=true обходит кеш.
 * @returns {Promise<object>} результат buildUpdateCheckResult
 * @throws {Error} при сетевой ошибке / не-2xx ответе GitHub API
 */
export async function checkForUpdate({ force = false } = {}) {
  if (!force && checkCache && Date.now() - checkCache.at < CHECK_CACHE_TTL_MS) {
    return checkCache.result;
  }
  const currentVersion = readCurrentVersion();
  const res = await fetch(RELEASES_LATEST_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `inpx-library-server/${currentVersion}`
    },
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS)
  });
  let release;
  if (res.ok) {
    release = await res.json();
  } else if (res.status === 403 || res.status === 429) {
    // Лимит GitHub API без токена — 60 запросов в час на IP (общий адрес, VPN, NAT его легко выбирают).
    // Страница релиза на github.com лимита не имеет: версию берём из её редиректа.
    try {
      release = await fetchLatestReleaseViaWeb(currentVersion);
    } catch (fallbackError) {
      throw new Error(`GitHub API HTTP ${res.status} (${fallbackError.message})`);
    }
  } else {
    throw new Error(`GitHub API HTTP ${res.status}`);
  }
  const result = buildUpdateCheckResult(release, currentVersion);
  checkCache = { at: Date.now(), result };
  return result;
}

/**
 * Скачать ZIP-ассет релиза в память (для runUpdateFromZip).
 * URL берётся только из результата checkForUpdate (не из запроса клиента).
 * @returns {Promise<Buffer>}
 */
export async function downloadUpdateAsset(assetUrl) {
  const res = await fetch(assetUrl, {
    headers: { 'User-Agent': `inpx-library-server/${readCurrentVersion()}` },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > MAX_DOWNLOAD_SIZE) throw new Error(`archive too large: ${declared} bytes`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD_SIZE) throw new Error(`archive too large: ${buf.length} bytes`);
  return buf;
}
