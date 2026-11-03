/**
 * KOReader ↔ web / Android reading position (KOSync, src/routes/kosync.js).
 *
 * PUT  (KOReader → reader): a book downloaded through the server gets a reader position from the
 *      KOReader progress — the exact v4 text anchor for FB2 (`fb2XPointerToAnchor`), the fraction
 *      only for other reflowable formats. Written as a CAS revision by session `kosync:<device>`
 *      and released at once, so an open reader is never blocked; skipped while another reader
 *      session is active or when it would land on the same spot (no revision churn).
 * GET  (reader → KOReader): when the reader position is newer than the stored KOReader progress
 *      and was not written by this bridge, KOSync answers with the xpointer of that block (FB2 only).
 */
import { getBookById } from '../inpx.js';
import { readBookBuffer } from '../fb2.js';
import {
  getReadingPosition, setReadingPositionCas, releaseReadingPositionSession,
} from '../db.js';
import { fractionToProgress, normalizeReadingFraction } from '../../public/position-sync.js';
import {
  fb2XPointerToAnchor, fb2AnchorToXPointer, truncateFb2AfterFirstBody, decodeFb2LikeReader,
} from '../kosync-position.js';
import { getKosyncDocument } from '../kosync.js';
import { invalidateUserPageCaches } from './cache.js';
import { logSystemEvent } from './system-events.js';

export const KOSYNC_SESSION_PREFIX = 'kosync:';
export const KOSYNC_SERVER_DEVICE = 'INPX Library';
export const KOSYNC_SERVER_DEVICE_ID = 'inpx-library-server';
const REFLOWABLE_EXTS = new Set(['fb2', 'epub', 'mobi', 'azw3']);
/** Same spot for formats without a text anchor: closer than this fraction. */
const SAME_SPOT_FRACTION = 0.002;
const XML_CACHE_MAX = 4;
const XML_CACHE_TTL_MS = 10 * 60 * 1000;
const XML_MAX_CHARS = 40 * 1024 * 1024;

const xmlCache = new Map();
const xmlInflight = new Map();

/** First <body> of the book's FB2 (cached a few books for 10 min; KOReader pushes every few pages). */
async function loadFb2Body(book) {
  const key = String(book.id);
  const hit = xmlCache.get(key);
  if (hit && Date.now() - hit.at < XML_CACHE_TTL_MS) {
    xmlCache.delete(key);
    xmlCache.set(key, hit);
    return hit.xml;
  }
  if (xmlInflight.has(key)) return xmlInflight.get(key);
  const job = (async () => {
    const xml = truncateFb2AfterFirstBody(decodeFb2LikeReader(await readBookBuffer(book)));
    if (xml.length > XML_MAX_CHARS) return null;
    xmlCache.set(key, { xml, at: Date.now() });
    while (xmlCache.size > XML_CACHE_MAX) xmlCache.delete(xmlCache.keys().next().value);
    return xml;
  })().finally(() => xmlInflight.delete(key));
  xmlInflight.set(key, job);
  return job;
}

export function clearKosyncXmlCache() {
  xmlCache.clear();
}

/** The KOReader file is the book's own FB2 (not a converted EPUB): xpointers follow its tree. */
function isFb2Document(doc, book, xpointer = '') {
  if (String(book?.ext || '').toLowerCase() !== 'fb2') return false;
  if (doc.format) return doc.format === 'fb2' || doc.format === 'fb2zip';
  // Remembered before formats were stored: trust the shape of what KOReader sent.
  return String(xpointer || '').startsWith('/FictionBook');
}

function isEpubCfi(position) {
  return /^epubcfi\(/i.test(String(position || '').trim());
}

/** Reader position written by this bridge (KOReader's own position echoed back). */
function isBridgeWrite(pos) {
  return String(pos?.sessionId || '').startsWith(KOSYNC_SESSION_PREFIX);
}

/** `updated_at` (SQLite UTC without zone) → epoch seconds. */
function sqliteUtcSeconds(value) {
  const ms = Date.parse(`${String(value || '').replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

function sameSpot(current, next) {
  if (!current) return false;
  if (next.textOffset != null && current.sectionIndex === 0 && current.textOffset != null) {
    // KOReader is in the paragraph the reader is in (e.g. it just jumped to the xpointer we served).
    return current.textOffset >= next.blockStart && current.textOffset < next.blockEnd;
  }
  return current.fraction != null && Math.abs(current.fraction - next.fraction) < SAME_SPOT_FRACTION;
}

/**
 * KOReader pushed `progress` (xpointer) / `percentage` for `document` → reader position.
 * Returns 'saved' | 'same' | 'busy' | 'skip' (for tests and logs).
 */
export async function bridgeKosyncPositionToReader(username, document, { progress, percentage, deviceId } = {}) {
  const doc = getKosyncDocument(document);
  if (!doc) return 'skip';
  const book = getBookById(doc.bookId);
  if (!book) return 'skip';
  const ext = String(book.ext || '').toLowerCase();
  let next = null;
  if (isFb2Document(doc, book, progress)) {
    const xml = await loadFb2Body(book);
    const anchor = xml ? fb2XPointerToAnchor(xml, progress) : null;
    if (anchor) next = { ...anchor, fraction: normalizeReadingFraction(anchor.fraction) };
    // An xpointer that does not resolve in this FB2 (notes body, edited file): percentage only.
  }
  if (!next) {
    const pct = Number(percentage);
    if (!REFLOWABLE_EXTS.has(ext) || !Number.isFinite(pct) || pct <= 0) return 'skip';
    next = { fraction: normalizeReadingFraction(pct), sectionIndex: null, textOffset: null, textQuote: null, textSectionLength: null };
  }
  const current = getReadingPosition(username, book.id);
  if (sameSpot(current, next)) return 'same';
  const sessionId = `${KOSYNC_SESSION_PREFIX}${String(deviceId || 'koreader').slice(0, 100)}`;
  // fb2Href '0' marks the anchor as an FB2 one, like a native web save: `positionForBookFormat`
  // then drops it for the app's converted EPUB copy (fraction only there).
  const fb2Href = next.textOffset != null ? '0' : null;
  const saved = setReadingPositionCas(
    username, book.id, current ? current.revision : 0, '', fractionToProgress(next.fraction), next.fraction, fb2Href,
    {
      sectionIndex: next.sectionIndex,
      textOffset: next.textOffset,
      textQuote: next.textQuote,
      textSectionLength: next.textSectionLength,
      sessionId,
    },
  );
  // Another reader session is active right now (or the row moved meanwhile): its position wins.
  if (!saved) return 'busy';
  // Never hold the position: the next web / Android open must be able to save at once.
  releaseReadingPositionSession(username, book.id, sessionId);
  invalidateUserPageCaches(username);
  return 'saved';
}

/** Fire-and-forget wrapper for the PUT route (the response never waits for the book file). */
export function scheduleKosyncPositionBridge(username, document, body) {
  setImmediate(() => {
    bridgeKosyncPositionToReader(username, document, {
      progress: body?.progress,
      percentage: body?.percentage,
      deviceId: body?.device_id,
    }).catch((error) => {
      logSystemEvent('warn', 'kosync', 'position bridge failed', { username, error: String(error?.message || error) });
    });
  });
}

/**
 * KOSync progress record built from the reader position, when that position is newer than
 * `stored` (the KOReader record) and did not come from KOReader itself. Null otherwise.
 */
export async function readerProgressForKosync(username, document, stored = null) {
  const doc = getKosyncDocument(document);
  if (!doc) return null;
  const book = getBookById(doc.bookId);
  if (!book || !isFb2Document(doc, book, stored?.progress || '')) return null;
  const pos = getReadingPosition(username, book.id);
  if (!pos || isBridgeWrite(pos) || pos.positionVersion < 4) return null;
  const timestamp = sqliteUtcSeconds(pos.updatedAt);
  if (!timestamp || (stored && timestamp <= Number(stored.timestamp || 0))) return null;
  const useAnchor = pos.sectionIndex === 0 && pos.textOffset != null && !isEpubCfi(pos.position);
  if (!useAnchor && !(pos.fraction > 0)) return null;
  const xml = await loadFb2Body(book);
  if (!xml) return null;
  const hit = fb2AnchorToXPointer(xml, useAnchor
    ? { textOffset: pos.textOffset, textQuote: pos.textQuote }
    : { fraction: pos.fraction });
  if (!hit) return null;
  return {
    document,
    progress: hit.xpointer,
    percentage: Math.round((pos.fraction ?? hit.fraction) * 10000) / 10000,
    device: KOSYNC_SERVER_DEVICE,
    device_id: KOSYNC_SERVER_DEVICE_ID,
    timestamp,
  };
}
