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
 * Coordinates stay in kosync_progress: KOReader xpointers do not map to reader v4 anchors.
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
    const timestamp = saveKosyncProgress(req.kosyncUser, { ...body, document });
    bridgeKosyncProgress(req.kosyncUser, document, body.percentage);
    res.json({ document, timestamp });
  });

  app.get('/kosync/syncs/progress/:document', kosyncAuth, (req, res) => {
    const document = String(req.params.document || '');
    if (!DOCUMENT_RE.test(document)) {
      return res.status(403).json({ code: 2004, message: "Field 'document' not provided." });
    }
    // Как у эталонного сервера: нет прогресса — 200 и пустой объект (плагин KOReader ждёт 200/401).
    res.json(getKosyncProgress(req.kosyncUser, document) || {});
  });
}
