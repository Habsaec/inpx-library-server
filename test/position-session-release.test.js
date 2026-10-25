import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createUser, db, getReadingPosition, initDb } from '../src/db.js';
import { registerReaderRoutes } from '../src/routes/reader.js';

const USERNAME = 'position_release_user';
const PASSWORD = 'PositionRelease1';
const BOOK_ID = 'position-release-book';

describe('reader closes → position session released', () => {
  let server;
  let baseUrl = '';
  const auth = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`;

  before(async () => {
    initDb();
    db.prepare(`
      INSERT OR IGNORE INTO books (id, title, authors, genres, file_name, archive_name, ext)
      VALUES (?, ?, '', '', ?, '', 'fb2')
    `).run(BOOK_ID, BOOK_ID, `${BOOK_ID}.fb2`);
    if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(USERNAME)) {
      createUser({ username: USERNAME, password: PASSWORD });
    }
    const app = express();
    app.use(express.json());
    registerReaderRoutes(app);
    app.use((error, req, res, next) => {
      void next;
      res.status(500).json({ ok: false, error: error.message });
    });
    server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  async function post(path, body) {
    const response = await fetch(`${baseUrl}/api/books/${BOOK_ID}${path}`, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  function save(sessionId, progress, baseRevision, extra = {}) {
    return post('/position', { position: '', progress, positionVersion: 4, baseRevision, sessionId, ...extra });
  }

  it('a new open writes at once after the previous open released, not 409 for 4 minutes', async () => {
    db.prepare('DELETE FROM reading_positions WHERE username = ? AND book_id = ?').run(USERNAME, BOOK_ID);
    const first = await save('open-1', 30, 0);
    assert.equal(first.status, 200);

    // Before the fix: the closed open-1 still held the position as «active».
    const blocked = await save('open-2', 34, first.body.revision);
    assert.equal(blocked.status, 409);

    const foreign = await post('/position/release', { sessionId: 'someone-else' });
    assert.deepEqual(foreign.body, { ok: true, released: false }, 'only the holder releases');

    const released = await post('/position/release', { sessionId: 'open-1' });
    assert.deepEqual(released.body, { ok: true, released: true });
    assert.equal(getReadingPosition(USERNAME, BOOK_ID).sessionStatus, 'idle');

    const second = await save('open-2', 34, first.body.revision);
    assert.equal(second.status, 200);
    assert.equal(Math.round(getReadingPosition(USERNAME, BOOK_ID).progress), 34);
  });

  it('releaseSession on the last save writes and releases in one request', async () => {
    const current = getReadingPosition(USERNAME, BOOK_ID);
    const last = await save('open-2', 36, current.revision, { releaseSession: true });
    assert.equal(last.status, 200);
    const after = getReadingPosition(USERNAME, BOOK_ID);
    assert.equal(Math.round(after.progress), 36);
    assert.equal(after.sessionStatus, 'idle');

    const next = await save('open-3', 37, after.revision);
    assert.equal(next.status, 200);
  });

  it('rejects a release without sessionId', async () => {
    const missing = await post('/position/release', {});
    assert.equal(missing.status, 400);
  });
});
