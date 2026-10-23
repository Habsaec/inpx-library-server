/**
 * Precompressed JS/CSS from public/: each file is brotli- (q11) and gzip- (level 9)
 * compressed once, off the main thread, and kept in memory keyed by mtime/size.
 * Before this, compression gzipped app.js / styles.css (300+ KB) on every request.
 *
 * Until a file's compressed copy is ready the request falls through to express.static
 * (+ the on-the-fly compression middleware), so nothing waits for the first build.
 */
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, gzip, constants as zlibConstants } from 'node:zlib';

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

const COMPRESSIBLE = /\.(js|mjs|css)$/i;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const NEVER = new Set(['sw.js']);

/** path -> { mtimeMs, size, etag, lastModified, br, gz } (ready) */
const ready = new Map();
/** path -> Promise (being built) */
const building = new Map();

function resolvePublicFile(publicDir, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(String(urlPath || ''));
  } catch {
    return null;
  }
  if (!COMPRESSIBLE.test(rel) || rel.includes('\0')) return null;
  const abs = path.resolve(publicDir, '.' + path.posix.normalize('/' + rel));
  const root = path.resolve(publicDir) + path.sep;
  if (!abs.startsWith(root)) return null;
  if (NEVER.has(path.basename(abs))) return null;
  return abs;
}

async function build(abs, stat) {
  const data = await fs.promises.readFile(abs);
  const [br, gz] = await Promise.all([
    brotliAsync(data, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: data.length
      }
    }),
    gzipAsync(data, { level: 9 })
  ]);
  ready.set(abs, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    etag: `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`,
    lastModified: stat.mtime.toUTCString(),
    br,
    gz
  });
}

function scheduleBuild(abs, stat) {
  if (building.has(abs)) return;
  const p = build(abs, stat)
    .catch((err) => console.warn(`[static] precompress failed for ${path.basename(abs)}: ${err.message}`))
    .finally(() => building.delete(abs));
  building.set(abs, p);
}

function pickEncoding(acceptEncoding) {
  const ae = String(acceptEncoding || '');
  if (/\bbr\b/.test(ae)) return 'br';
  if (/\bgzip\b/.test(ae)) return 'gzip';
  return '';
}

/** Start building compressed copies for files that every page loads (relative to publicDir). */
export function warmPrecompressedStatic(publicDir, relPaths = []) {
  for (const rel of relPaths) {
    const abs = resolvePublicFile(publicDir, '/' + rel);
    if (!abs) continue;
    fs.promises.stat(abs).then((stat) => {
      if (stat.isFile() && stat.size <= MAX_FILE_BYTES) scheduleBuild(abs, stat);
    }).catch(() => { /* missing optional asset */ });
  }
}

/**
 * @param {object} opts
 * @param {string} opts.publicDir
 * @param {(req) => string} opts.cacheControl  Cache-Control value for this request
 */
export function precompressedStatic({ publicDir, cacheControl }) {
  return function servePrecompressed(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const encoding = pickEncoding(req.headers['accept-encoding']);
    if (!encoding) return next();
    const abs = resolvePublicFile(publicDir, req.path);
    if (!abs) return next();
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      return next();
    }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return next();
    const entry = ready.get(abs);
    if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
      scheduleBuild(abs, stat);
      return next();
    }
    const body = encoding === 'br' ? entry.br : entry.gz;
    const etag = `${entry.etag.slice(0, -1)}-${encoding === 'br' ? 'br' : 'gz'}"`;
    res.type(path.extname(abs));
    res.setHeader('Cache-Control', cacheControl(req));
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', entry.lastModified);
    if (req.headers['if-none-match'] === etag) {
      res.statusCode = 304;
      return res.end();
    }
    res.setHeader('Content-Encoding', encoding);
    res.setHeader('Content-Length', body.length);
    if (req.method === 'HEAD') return res.end();
    return res.end(body);
  };
}
