/**
 * JSON API профиля пользователя (мобильные клиенты).
 */
import { requireApiAuth } from '../middleware/auth.js';
import {
  getUserStats, getAllReaderBookmarks, getAllReaderAnnotations, getUserByUsername,
  getUserHideRead, setUserHideRead, getUserDownloadFormat, setUserDownloadFormat,
  getUserTelegramDigest, setUserTelegramDigest
} from '../db.js';
import { getReadingHistory } from '../inpx.js';
import { formatAuthorLabel } from '../genre-map.js';
import { invalidateUserPageCaches } from '../services/cache.js';

/** Per-account switches shared by the web UI and the Android app. */
export function readUserPreferences(username) {
  return {
    hideRead: getUserHideRead(username),
    downloadFormat: getUserDownloadFormat(username),
    telegramDigest: getUserTelegramDigest(username)
  };
}

/**
 * @param {import('express').Application} app
 */
export function registerProfileApiRoutes(app) {
  app.get('/api/profile', requireApiAuth, (req, res) => {
    const username = req.user.username;
    res.json({
      user: {
        username,
        role: req.user.role || 'user',
        email: getUserByUsername(username)?.email || '',
        ...readUserPreferences(username)
      },
      userStats: getUserStats(username),
      recentBooks: getReadingHistory(username, 10).map((item) => ({
        ...item,
        authorsDisplay: formatAuthorLabel(item.authors)
      })),
      readerBookmarks: getAllReaderBookmarks(username, 20),
      readerAnnotations: getAllReaderAnnotations(username, 20)
    });
  });

  /* { hideRead, downloadFormat, telegramDigest } — POST takes any subset. */
  app.get('/api/preferences', requireApiAuth, (req, res) => {
    res.json(readUserPreferences(req.user.username));
  });

  app.post('/api/preferences', requireApiAuth, (req, res) => {
    const username = req.user.username;
    const body = req.body || {};
    if (body.hideRead !== undefined) {
      setUserHideRead(username, body.hideRead === true || body.hideRead === 1 || body.hideRead === '1' || body.hideRead === 'true');
      invalidateUserPageCaches(username);
    }
    if (body.downloadFormat !== undefined) setUserDownloadFormat(username, body.downloadFormat);
    if (body.telegramDigest !== undefined) {
      setUserTelegramDigest(username, body.telegramDigest === true || body.telegramDigest === 1 || body.telegramDigest === '1' || body.telegramDigest === 'true');
    }
    res.json(readUserPreferences(username));
  });
}
