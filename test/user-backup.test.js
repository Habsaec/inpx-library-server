import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const {
  initDb, db, createUser, deleteUser, getUserByUsername, setUserTelegramId, setUserEreaderEmail,
  getEreaderEmail
} = await import('../src/db.js');
const { hashPassword, verifyPassword } = await import('../src/auth.js');
const { exportUsersBackup, importUsersBackup } = await import('../src/services/user-backup.js');

const USER = 'userbackup_alice';
const OTHER = 'userbackup_bob';
const PASSWORD = 'BackupPass1';
const TG_ID = '555001122';
const EMAIL = 'alice-backup@example.com';
const EREADER = 'alice-ereader@example.com';
const AUTHOR_NAME = 'толстой,лев';
const SERIES_NAME = 'Война и мир';

before(() => {
  initDb();
  for (const name of [USER, OTHER]) {
    try { deleteUser(name); } catch { /* ignore */ }
  }
  db.prepare('DELETE FROM favorite_authors WHERE username IN (?, ?)').run(USER, OTHER);
  db.prepare('DELETE FROM favorite_series WHERE username IN (?, ?)').run(USER, OTHER);
  db.prepare('DELETE FROM authors WHERE name = ?').run(AUTHOR_NAME);
  db.prepare('DELETE FROM series_catalog WHERE name = ?').run(SERIES_NAME);

  createUser({ username: USER, password: PASSWORD });
  db.prepare('UPDATE users SET email = ? WHERE username = ?').run(EMAIL, USER);
  setUserTelegramId(USER, TG_ID);
  setUserEreaderEmail(USER, EREADER);

  const insertAuthor = db.prepare(`
    INSERT INTO authors (name, display_name, sort_name, search_name, book_count)
    VALUES (?, ?, ?, ?, 1)
  `);
  insertAuthor.run(AUTHOR_NAME, 'Толстой Лев', 'толстой лев', 'толстой лев');
  const authorId = db.prepare('SELECT id FROM authors WHERE name = ?').get(AUTHOR_NAME).id;
  db.prepare('INSERT INTO favorite_authors(username, author_id) VALUES(?, ?)').run(USER, authorId);

  db.prepare(`
    INSERT INTO series_catalog (name, display_name, sort_name, search_name, book_count)
    VALUES (?, ?, ?, ?, 1)
  `).run(SERIES_NAME, SERIES_NAME, 'война и мир', 'война и мир');
  const seriesId = db.prepare('SELECT id FROM series_catalog WHERE name = ?').get(SERIES_NAME).id;
  db.prepare('INSERT INTO favorite_series(username, series_id) VALUES(?, ?)').run(USER, seriesId);
});

after(() => {
  for (const name of [USER, OTHER]) {
    try { deleteUser(name); } catch { /* ignore */ }
  }
});

test('exportUsersBackup includes password hash, telegram, email and favorites by name', () => {
  const payload = exportUsersBackup();
  const row = payload.users.find((item) => item.username === USER);
  assert.ok(row);
  assert.match(row.passwordHash, /^scrypt\$/);
  assert.equal(row.email, EMAIL);
  assert.equal(row.telegramId, TG_ID);
  assert.equal(row.ereaderEmail, EREADER);
  assert.ok(row.favoriteAuthors.includes(AUTHOR_NAME));
  assert.ok(row.favoriteSeries.includes(SERIES_NAME));
});

test('importUsersBackup recreates a deleted user and restores favorites', () => {
  const payload = exportUsersBackup();
  const exported = payload.users.find((item) => item.username === USER);
  deleteUser(USER);

  const summary = importUsersBackup(payload);
  assert.ok(summary.created >= 1);
  const restored = getUserByUsername(USER);
  assert.ok(restored);
  assert.equal(restored.email, EMAIL);
  assert.equal(restored.telegramId, TG_ID);
  assert.equal(getEreaderEmail(USER), EREADER);
  assert.equal(verifyPassword(PASSWORD, restored.passwordHash), true);
  assert.equal(restored.passwordHash, exported.passwordHash);

  const favAuthor = db.prepare(`
    SELECT a.name AS name FROM favorite_authors fa
    JOIN authors a ON a.id = fa.author_id
    WHERE fa.username = ?
  `).get(USER);
  assert.equal(favAuthor?.name, AUTHOR_NAME);
  const favSeries = db.prepare(`
    SELECT s.name AS name FROM favorite_series fs
    JOIN series_catalog s ON s.id = fs.series_id
    WHERE fs.username = ?
  `).get(USER);
  assert.equal(favSeries?.name, SERIES_NAME);
});

test('importUsersBackup skips existing usernames and fills empty telegram', () => {
  try { deleteUser(OTHER); } catch { /* ignore */ }
  createUser({ username: OTHER, password: 'OtherPass1' });
  const payload = {
    version: 1,
    users: [{
      username: OTHER,
      passwordHash: hashPassword('ShouldNotApply1'),
      role: 'user',
      email: 'bob-backup@example.com',
      telegramId: '555009999',
      favoriteAuthors: [AUTHOR_NAME],
      favoriteSeries: []
    }]
  };
  const before = getUserByUsername(OTHER);
  const summary = importUsersBackup(payload);
  assert.equal(summary.skipped >= 1, true);
  const after = getUserByUsername(OTHER);
  assert.equal(after.passwordHash, before.passwordHash);
  assert.equal(verifyPassword('OtherPass1', after.passwordHash), true);
  assert.equal(after.email, 'bob-backup@example.com');
  assert.equal(after.telegramId, '555009999');
  const fav = db.prepare(`
    SELECT 1 AS ok FROM favorite_authors fa
    JOIN authors a ON a.id = fa.author_id
    WHERE fa.username = ? AND a.name = ?
  `).get(OTHER, AUTHOR_NAME);
  assert.ok(fav);
});

test('importUsersBackup rejects a payload without users', () => {
  assert.throws(() => importUsersBackup({ version: 1 }), { code: 'INVALID_BACKUP' });
});
