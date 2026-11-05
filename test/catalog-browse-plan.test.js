import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, db, ensureActiveBooksProjection, isActiveBooksProjectionFresh } from '../src/db.js';
import { searchCatalog } from '../src/inpx.js';

before(() => { initDb(); });

test('plain catalog browse (books driven first) returns exactly the pages of the projection view', async () => {
  db.pragma('foreign_keys = OFF');
  const sourceId = Number(db.prepare("INSERT INTO sources(name, type, path, enabled) VALUES('browse-plan', 'folder', 'browse-plan-path', 1)").run().lastInsertRowid);
  const insert = db.prepare(`INSERT OR REPLACE INTO books(id, title, authors, lib_id, archive_name, file_name, ext, deleted, source_id, title_sort, author_sort, date, imported_at)
    VALUES(?, ?, 'A,B', ?, 'a.zip', ?, 'fb2', 0, ?, ?, 'a b', ?, ?)`);
  const ids = [];
  for (let i = 0; i < 40; i += 1) {
    const id = `bp${String(i).padStart(2, '0')}`;
    ids.push(id);
    insert.run(id, `Title ${39 - i}`, `l${i}`, `f${i}.fb2`, sourceId, `title ${String(39 - i).padStart(2, '0')}`, `2026-01-${String(1 + (i % 28)).padStart(2, '0')}`, `2026-02-${String(1 + (i % 28)).padStart(2, '0')} 10:00:00`);
  }
  db.pragma('foreign_keys = ON');
  try {
    await ensureActiveBooksProjection();
    assert.equal(isActiveBooksProjectionFresh(), true, 'the projection is built');
    const orderBy = {
      title: 'b.title_sort ASC, b.title COLLATE NOCASE ASC, b.id DESC',
      recent: "COALESCE(NULLIF(b.date, ''), b.imported_at) DESC, b.imported_at DESC, b.id DESC"
    };
    for (const sort of ['title', 'recent']) {
      for (const page of [1, 2]) {
        const expected = db.prepare(`SELECT b.id FROM catalog_active_books b LEFT JOIN sources s ON s.id = b.source_id ORDER BY ${orderBy[sort]} LIMIT 24 OFFSET ?`)
          .all((page - 1) * 24).map((r) => r.id);
        const got = searchCatalog({ query: '', page, pageSize: 24, sort }).items.map((b) => b.id);
        assert.deepEqual(got, expected, `${sort} page ${page}`);
      }
    }
  } finally {
    db.pragma('foreign_keys = OFF');
    db.prepare("DELETE FROM books WHERE id LIKE 'bp%'").run();
    db.prepare("DELETE FROM sources WHERE path = 'browse-plan-path'").run();
    db.pragma('foreign_keys = ON');
  }
});
