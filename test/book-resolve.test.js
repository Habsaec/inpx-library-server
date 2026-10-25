import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createUser, db, getReaderSyncIndex, initDb } from '../src/db.js';
import { createSortKey } from '../src/inpx.js';
import { resolveBookRef } from '../src/book-resolve.js';
import { registerReaderRoutes } from '../src/routes/reader.js';

const USERNAME = 'book_resolve_user';
const PASSWORD = 'BookResolvePass1';

function insertBook({ id, title, authors, ext = 'fb2', libId = null }) {
  db.prepare(`
    INSERT OR REPLACE INTO books (id, title, authors, genres, file_name, archive_name, ext, lib_id, title_sort)
    VALUES (?, ?, ?, '', ?, '', ?, ?, ?)
  `).run(id, title, authors, libId || id, ext, libId, createSortKey(title));
}

describe('resolve book ids from another catalog', () => {
  let server;
  let baseUrl = '';

  before(async () => {
    initDb();
    // Same Flibusta book; the other server indexed it as source 9, this one as source 6.
    insertBook({ id: '6:857614', title: 'Кодекс Охотника #41', authors: 'Винокуров,Юрий,:Сапфир,Олег,:', libId: '857614' });
    // Same lib id in another library (Librusec numbering) with a different title.
    insertBook({ id: '7:857614', title: 'Совсем другая книга', authors: 'Иванов,Иван,:', libId: '857614' });
    // Folder-style books: no lib id, matched by title + authors.
    insertBook({ id: 'f'.repeat(64), title: 'Основание', authors: 'Азимов,Айзек,:', ext: 'epub' });
    insertBook({ id: 'a'.repeat(64), title: 'Дубль', authors: 'Автор,Один,:' });
    insertBook({ id: 'b'.repeat(64), title: 'Дубль', authors: 'Автор,Один,:' });

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

  it('keeps a known id and maps a foreign INPX id by lib id + title', () => {
    assert.deepEqual(resolveBookRef({ id: '6:857614' }), { id: '6:857614', bookId: '6:857614', match: 'id' });
    assert.deepEqual(
      resolveBookRef({ id: '9:857614', title: 'Кодекс Охотника #41', authors: 'Винокуров Юрий, Сапфир Олег', ext: 'fb2' }),
      { id: '9:857614', bookId: '6:857614', match: 'libId' },
    );
  });

  it('never maps a lib id collision with another title or format', () => {
    assert.equal(resolveBookRef({ id: '9:857614', title: 'Неизвестная', authors: 'Кто-то' }).bookId, null);
    assert.equal(resolveBookRef({ id: '9:857614', title: 'Кодекс Охотника #41', ext: 'epub' }).bookId, null);
    assert.equal(resolveBookRef({ id: '9:857614' }).bookId, null, 'no title → no guess');
  });

  it('falls back to title + authors and rejects ambiguous matches', () => {
    assert.deepEqual(
      resolveBookRef({ id: 'c'.repeat(64), title: 'основание', authors: ['Айзек Азимов'], ext: 'epub' }),
      { id: 'c'.repeat(64), bookId: 'f'.repeat(64), match: 'title' },
    );
    assert.equal(resolveBookRef({ id: 'c'.repeat(64), title: 'Основание', authors: 'Другой Автор' }).bookId, null);
    assert.equal(resolveBookRef({ id: 'd'.repeat(64), title: 'Дубль', authors: 'Один Автор' }).bookId, null);
  });

  it('reader-sync-index lists ids this catalog does not have', () => {
    const local = `local:${'e'.repeat(64)}`;
    const index = getReaderSyncIndex(USERNAME, ['6:857614', '9:857614', local]);
    assert.deepEqual(index.unknownIds, ['9:857614']);
    assert.equal(index.books.length, 3);
  });

  it('POST /api/books/resolve maps ids; the position saves under the server id', async () => {
    const auth = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`;
    const resolved = await fetch(`${baseUrl}/api/books/resolve`, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ books: [
        { id: '9:857614', title: 'Кодекс Охотника #41', authors: 'Винокуров Юрий, Сапфир Олег', ext: 'fb2' },
        { id: '9:1', title: 'Нет такой' },
      ] }),
    });
    assert.equal(resolved.status, 200);
    assert.deepEqual((await resolved.json()).items, [
      { id: '9:857614', bookId: '6:857614', match: 'libId' },
      { id: '9:1', bookId: null, match: null },
    ]);

    const foreign = await fetch(`${baseUrl}/api/books/9%3A857614/position`, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ position: '', progress: 30, positionVersion: 4, baseRevision: 0 }),
    });
    assert.equal(foreign.status, 404, 'a foreign id is still unknown here');

    const saved = await fetch(`${baseUrl}/api/books/6%3A857614/position`, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ position: '', progress: 30, positionVersion: 4, baseRevision: 0 }),
    });
    assert.equal(saved.status, 200);

    const tooMany = await fetch(`${baseUrl}/api/books/resolve`, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ books: 'nope' }),
    });
    assert.equal(tooMany.status, 400);
  });
});
