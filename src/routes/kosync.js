/**
 * KOReader sync server (kosync): /kosync/*.
 * В KOReader: Cloud storage → Progress sync → Custom sync server = `http://<host>/kosync`,
 * логин и пароль — из профиля (Настройки → KOReader).
 * Протокол: https://github.com/koreader/koreader-sync-server
 */
import { verifyKosyncCredentials, saveKosyncProgress, getKosyncProgress } from '../kosync.js';
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
