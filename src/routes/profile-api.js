/**
 * JSON API профиля пользователя (мобильные клиенты).
 */
import { requireApiAuth } from '../middleware/auth.js';
import { getUserStats, getAllReaderBookmarks, getAllReaderAnnotations, getUserByUsername } from '../db.js';
import { getReadingHistory } from '../inpx.js';
import { formatAuthorLabel } from '../genre-map.js';

/**
 * @param {import('express').Application} app
 */
export function registerProfileApiRoutes(app) {
  app.get('/api/profile', requireApiAuth, (req, res) => {
    const username = req.user.username;
    res.json({
      user: { username, role: req.user.role || 'user', email: getUserByUsername(username)?.email || '' },
      userStats: getUserStats(username),
      recentBooks: getReadingHistory(username, 10).map((item) => ({
        ...item,
        authorsDisplay: formatAuthorLabel(item.authors)
      })),
      readerBookmarks: getAllReaderBookmarks(username, 20),
      readerAnnotations: getAllReaderAnnotations(username, 20)
    });
  });
}
