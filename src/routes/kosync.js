/**
 * KOReader sync server (kosync): /kosync/*.
 * В KOReader: Cloud storage → Progress sync → Custom sync server = `http://<host>/kosync`,
 * логин и пароль — из профиля (Настройки → KOReader).
 * Протокол: https://github.com/koreader/koreader-sync-server
 */
import { verifyKosyncCredentials, saveKosyncProgress, getKosyncProgress, getKosyncDocumentBookId } from '../kosync.js';
import { getBookById, isBookRead, addReadBooksIfMissing, recordKosyncReading } from '../inpx.js';
import { invalidateUserPageCaches } from '../services/cache.js';
import { logSystemEvent } from '../services/system-events.js';
import { scheduleKosyncPositionBridge, readerProgressForKosync } from '../services/kosync-position-bridge.js';
import { asyncHandler } from '../utils/async-handler.js';

/** GET waits this long for the reader-position xpointer, then answers with the stored record. */
const READER_PROGRESS_WAIT_MS = 5000;

const DOCUMENT_RE = /^[\w.-]{1,128}$/;

function kosyncAuth(req, res, next) {
  const username = String(req.get('x-auth-user') || '').trim();
  if (verifyKosyncCredentials(username, req.get('x-auth-key'))) {
    req.kosyncUser = username;
    return next();
  }
  if (username) {
    logSystemEvent('warn', 'auth', 'KOSync auth failed', { username, ip: req.ip || '' });
  }
  return res.status(401).json({ code: 2001, message: 'Unauthorized' });
}

/**
 * Progress of a book downloaded through the server → «Читаю» / «Прочитано» (web + Android).
 * The position itself is bridged by services/kosync-position-bridge.js.
 * A low percentage never unmarks «Прочитано» (an old copy on another device could do that).
 */
function bridgeKosyncProgress(username, document, percentage) {
  try {
    const bookId = getKosyncDocumentBookId(document);
    if (!bookId || !getBookById(bookId)) return;
    const pct = (Number(percentage) || 0) * 100;
    if (pct >= 99) {
      if (!isBookRead(username, bookId)) addReadBooksIfMissing(username, [bookId]);
    } else if (pct > 0 && !isBookRead(username, bookId)) {
      recordKosyncReading(username, bookId);
    } else {
      return;
    }
    invalidateUserPageCaches(username);
  } catch (error) {
    logSystemEvent('warn', 'kosync', 'progress bridge failed', { username, error: String(error?.message || error) });
  }
}

/** @param {import('express').Application} app */
export function registerKosyncRoutes(app) {
  // Регистрация через KOReader отключена: пароль выдаётся в профиле.
  app.post('/kosync/users/create', (req, res) => {
    res.status(403).json({ code: 2005, message: 'Registration is disabled. Create the KOReader password in your profile.' });
  });

  app.get('/kosync/users/auth', kosyncAuth, (req, res) => {
    res.json({ authorized: 'OK' });
  });

  app.put('/kosync/syncs/progress', kosyncAuth, (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const document = String(body.document ?? '');
    if (!DOCUMENT_RE.test(document)) {
      return res.status(403).json({ code: 2004, message: "Field 'document' not provided." });
    }
    const previous = getKosyncProgress(req.kosyncUser, document);
    const timestamp = saveKosyncProgress(req.kosyncUser, { ...body, document });
    bridgeKosyncProgress(req.kosyncUser, document, body.percentage);
    // KOReader re-sends an unchanged position on every sync: nothing to move then.
    if (!previous || previous.progress !== String(body.progress ?? '')) {
      scheduleKosyncPositionBridge(req.kosyncUser, document, body);
    }
    res.json({ document, timestamp });
  });

  app.get('/kosync/syncs/progress/:document', kosyncAuth, asyncHandler(async (req, res) => {
    const document = String(req.params.document || '');
    if (!DOCUMENT_RE.test(document)) {
      return res.status(403).json({ code: 2004, message: "Field 'document' not provided." });
    }
    const stored = getKosyncProgress(req.kosyncUser, document);
    // Read further on the web / in the app since the last KOReader push → that position.
    let fromReader = null;
    let timer = null;
    try {
      fromReader = await Promise.race([
        readerProgressForKosync(req.kosyncUser, document, stored),
        new Promise((resolve) => { timer = setTimeout(resolve, READER_PROGRESS_WAIT_MS, null); }),
      ]);
    } catch (error) {
      logSystemEvent('warn', 'kosync', 'reader position lookup failed', { username: req.kosyncUser, error: String(error?.message || error) });
    } finally {
      clearTimeout(timer);
    }
    // Как у эталонного сервера: нет прогресса — 200 и пустой объект (плагин KOReader ждёт 200/401).
    res.json(fromReader || stored || {});
  }));
}
