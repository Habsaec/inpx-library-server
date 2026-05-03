/**
 * Detect the real format of a book file from its bytes, ignoring the extension
 * recorded in the catalog. Also transparently unwraps "PDF inside a ZIP" that
 * some Flibusta archives use (e.g. f.usr-xxxx-xxxx.zip → book.pdf.zip → PDF).
 *
 * Returns `{ kind, buffer, contentType }`:
 *   - `kind` is one of: 'pdf' | 'djvu' | 'epub' | 'fb2' | 'fbz' | 'mobi' |
 *                       'cbz' | 'zip' | 'unknown'
 *   - `buffer` is the effective payload (may be the inner PDF after unwrap)
 *   - `contentType` is a reasonable HTTP Content-Type for that kind
 *
 * Keeps zero runtime dependencies at module load — unzipper is imported lazily
 * only when we actually need to peek inside a ZIP for an inner PDF.
 */

const PDF_MAGIC = Buffer.from('%PDF-', 'utf8');
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);       // "PK\x03\x04"
const DJVU_MAGIC_AT_T = Buffer.from('AT&TFORM', 'utf8');       // DJVU container prefix
const DJVU_MAGIC_FORM = Buffer.from('FORM', 'utf8');
const DJVU_MAGIC_DJVM = Buffer.from('DJVM', 'utf8');
const DJVU_MAGIC_DJVU = Buffer.from('DJVU', 'utf8');
const FB2_SNIFF = '<FictionBook';
const MOBI_BOOKMOBI = Buffer.from('BOOKMOBI', 'utf8');         // at offset 60
const EPUB_MIMETYPE_ENTRY = 'application/epub+zip';

const CONTENT_TYPES = {
  pdf: 'application/pdf',
  djvu: 'image/vnd.djvu',
  epub: 'application/epub+zip',
  fb2: 'application/x-fictionbook+xml; charset=utf-8',
  fbz: 'application/x-zip-compressed-fb2',
  mobi: 'application/x-mobipocket-ebook',
  cbz: 'application/vnd.comicbook+zip',
  zip: 'application/zip',
  unknown: 'application/octet-stream'
};

function startsWith(buf, magic, offset = 0) {
  if (!Buffer.isBuffer(buf) || buf.length < offset + magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (buf[offset + i] !== magic[i]) return false;
  }
  return true;
}

function isPdf(buf) { return startsWith(buf, PDF_MAGIC); }
function isZip(buf) { return startsWith(buf, ZIP_MAGIC); }

function isDjvu(buf) {
  if (startsWith(buf, DJVU_MAGIC_AT_T)) return true;
  // Some DJVU files start with FORM + length(4) + DJVU/DJVM
  if (startsWith(buf, DJVU_MAGIC_FORM) && buf.length >= 12) {
    return startsWith(buf, DJVU_MAGIC_DJVM, 8) || startsWith(buf, DJVU_MAGIC_DJVU, 8);
  }
  return false;
}

function isMobi(buf) {
  // MOBI/PalmDOC: "BOOKMOBI" or "TPZ3" at offset 60
  return startsWith(buf, MOBI_BOOKMOBI, 60);
}

function looksLikeFb2(buf) {
  if (!Buffer.isBuffer(buf)) return false;
  // Check the first 512 bytes for `<FictionBook` — tolerates BOM and whitespace
  const head = buf.slice(0, 512).toString('utf8');
  if (head.includes(FB2_SNIFF)) return true;
  // Fallback: try latin1 in case the file uses a non-UTF-8 encoding and the
  // XML prolog contains only ASCII up to the root tag.
  const head2 = buf.slice(0, 512).toString('latin1');
  return head2.includes(FB2_SNIFF);
}

/**
 * Peek into a ZIP buffer to determine whether it is an EPUB (has the
 * "mimetype" entry == "application/epub+zip"), a CBZ, or just a plain ZIP
 * wrapping a single PDF/DJVU/FB2 that we can unwrap.
 */
async function inspectZipBuffer(buf) {
  const unzipper = (await import('unzipper')).default || (await import('unzipper'));
  let directory;
  try {
    directory = await unzipper.Open.buffer(buf);
  } catch {
    return { kind: 'zip', inner: null };
  }
  const files = (directory?.files || []).filter((f) => f.type !== 'Directory');
  if (!files.length) return { kind: 'zip', inner: null };

  // EPUB detection: "mimetype" entry with the EPUB MIME string
  const mimeEntry = files.find((f) => f.path === 'mimetype');
  if (mimeEntry) {
    try {
      const mime = (await mimeEntry.buffer()).toString('utf8').trim();
      if (mime === EPUB_MIMETYPE_ENTRY) {
        return { kind: 'epub', inner: null };
      }
    } catch { /* fall through */ }
  }

  // If exactly one relevant entry inside → treat as a wrapper archive and unwrap.
  const relevant = files.filter((f) => !/^__macosx\//i.test(f.path) && !/\.ds_store$/i.test(f.path));
  if (relevant.length === 1) {
    const entry = relevant[0];
    const lower = entry.path.toLowerCase();
    let inner = null;
    try { inner = await entry.buffer(); } catch { /* ignore */ }
    if (inner && inner.length > 0) {
      if (lower.endsWith('.pdf') || isPdf(inner)) return { kind: 'pdf', inner };
      if (lower.endsWith('.djvu') || lower.endsWith('.djv') || isDjvu(inner)) return { kind: 'djvu', inner };
      if (lower.endsWith('.fb2') || looksLikeFb2(inner)) return { kind: 'fb2', inner };
    }
  }

  // Multi-entry zip: could be a CBZ if all entries are images
  const imgExt = /\.(jpe?g|png|gif|webp|bmp)$/i;
  if (relevant.length >= 2 && relevant.every((f) => imgExt.test(f.path))) {
    return { kind: 'cbz', inner: null };
  }

  return { kind: 'zip', inner: null };
}

/**
 * Detect (and optionally unwrap) the real format of a book buffer.
 * @param {Buffer} buffer
 * @param {string} [declaredExt] - Extension recorded in the catalog (hint only).
 * @returns {Promise<{kind: string, buffer: Buffer, contentType: string}>}
 */
export async function detectBookFormat(buffer, declaredExt = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { kind: 'unknown', buffer, contentType: CONTENT_TYPES.unknown };
  }
  if (isPdf(buffer)) {
    return { kind: 'pdf', buffer, contentType: CONTENT_TYPES.pdf };
  }
  if (isDjvu(buffer)) {
    return { kind: 'djvu', buffer, contentType: CONTENT_TYPES.djvu };
  }
  if (isMobi(buffer)) {
    return { kind: 'mobi', buffer, contentType: CONTENT_TYPES.mobi };
  }
  if (looksLikeFb2(buffer)) {
    return { kind: 'fb2', buffer, contentType: CONTENT_TYPES.fb2 };
  }
  if (isZip(buffer)) {
    try {
      const info = await inspectZipBuffer(buffer);
      if (info.kind === 'pdf' && info.inner) {
        return { kind: 'pdf', buffer: info.inner, contentType: CONTENT_TYPES.pdf };
      }
      if (info.kind === 'djvu' && info.inner) {
        return { kind: 'djvu', buffer: info.inner, contentType: CONTENT_TYPES.djvu };
      }
      if (info.kind === 'fb2' && info.inner) {
        return { kind: 'fb2', buffer: info.inner, contentType: CONTENT_TYPES.fb2 };
      }
      if (info.kind === 'epub') {
        return { kind: 'epub', buffer, contentType: CONTENT_TYPES.epub };
      }
      if (info.kind === 'cbz') {
        return { kind: 'cbz', buffer, contentType: CONTENT_TYPES.cbz };
      }
    } catch {
      /* Fall through — treat as plain zip below */
    }
    // Plain zip: if catalog says fb2, assume it's FBZ (FB2 in zip); otherwise generic zip
    const ext = String(declaredExt || '').toLowerCase();
    if (ext === 'fb2' || ext === 'fbz') {
      return { kind: 'fbz', buffer, contentType: CONTENT_TYPES.fbz };
    }
    if (ext === 'epub') {
      return { kind: 'epub', buffer, contentType: CONTENT_TYPES.epub };
    }
    return { kind: 'zip', buffer, contentType: CONTENT_TYPES.zip };
  }
  return { kind: 'unknown', buffer, contentType: CONTENT_TYPES.unknown };
}

/**
 * Lightweight classifier used by the reader page to decide which UI path to
 * take (foliate-js vs native PDF iframe vs download-only banner). Returns one
 * of: 'foliate' | 'pdf' | 'djvu' | 'unsupported'. The actual format detection
 * still happens server-side on the content endpoint.
 */
export function classifyReaderExt(ext) {
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  if (e === 'pdf') return 'pdf';
  if (e === 'djvu' || e === 'djv') return 'djvu';
  if (e === 'fb2' || e === 'fbz' || e === 'epub' || e === 'mobi' || e === 'azw3' || e === 'kf8' || e === 'cbz') {
    return 'foliate';
  }
  return 'unsupported';
}
