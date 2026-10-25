import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import archiver from 'archiver';
import iconv from 'iconv-lite';
import { initDb, db, addSource } from '../src/db.js';
import { rebuildIndex } from '../src/inpx.js';

initDb();

function inpLine({ author, title, libId }) {
  // AUTHOR;GENRE;TITLE;SERIES;SERNO;FILE;SIZE;LIBID;DEL;EXT;DATE;LANG
  return [`${author}:`, 'sf:', title, '', '', libId, '1000', libId, '0', 'fb2', '2024-01-01', 'ru'].join('\x04');
}

async function writeInpx(filePath, inps) {
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(filePath);
    const zip = archiver('zip');
    out.on('close', resolve);
    zip.on('error', reject);
    zip.pipe(out);
    for (const [name, lines] of Object.entries(inps)) {
      zip.append(iconv.encode(`${lines.map(inpLine).join('\r\n')}\r\n`, 'win1251'), { name });
    }
    zip.finalize();
  });
}

test('incremental INPX keeps user data of a book that moved to another .inp', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inpx-moved-'));
  const inpxPath = path.join(dir, 'lib.inpx');
  const moved = { author: 'Лем,Станислав', title: 'Солярис', libId: '101' };
  const gone = { author: 'Азимов,Айзек', title: 'Основание', libId: '102' };
  const stays = { author: 'Брэдбери,Рэй', title: 'Вино из одуванчиков', libId: '201' };
  let source;
  try {
    await writeInpx(inpxPath, { 'daily-1.inp': [moved, gone], 'main.inp': [stays] });
    source = addSource({ name: 'Moved', type: 'inpx', path: inpxPath });
    await rebuildIndex(inpxPath, false, source.id);

    const movedId = `${source.id}:101`;
    const goneId = `${source.id}:102`;
    assert.ok(db.prepare('SELECT 1 FROM books WHERE id = ?').get(movedId));
    db.prepare('INSERT INTO read_books(username, book_id) VALUES(?, ?)').run('mover', movedId);
    db.prepare('INSERT INTO read_books(username, book_id) VALUES(?, ?)').run('mover', goneId);

    // Daily .inp merged into main.inp: the moved book keeps its lib_id, the other one vanished.
    await writeInpx(inpxPath, { 'main.inp': [stays, moved] });
    await rebuildIndex(inpxPath, true, source.id);

    const row = db.prepare('SELECT archive_name AS archive FROM books WHERE id = ?').get(movedId);
    assert.ok(row, 'moved book still indexed');
    assert.equal(row.archive, 'main.zip');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM read_books WHERE book_id = ?').get(movedId).c, 1,
      'read mark of the moved book survives');
    assert.equal(db.prepare('SELECT 1 FROM books WHERE id = ?').get(goneId), undefined, 'vanished book purged');
  } finally {
    if (source) {
      db.prepare('DELETE FROM books WHERE source_id = ?').run(source.id);
      db.prepare('DELETE FROM sources WHERE id = ?').run(source.id);
    }
    db.prepare("DELETE FROM read_books WHERE username = 'mover'").run();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
