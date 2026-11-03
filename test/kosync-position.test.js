import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { initDb, db, createUser, addSource, getReadingPosition, setReadingPositionCas } from '../src/db.js';
import { createKosyncPassword, rememberKosyncDocument, kosyncFormatFromFileName } from '../src/kosync.js';
import {
  scanFb2Body, parseXPointer, fb2XPointerToAnchor, fb2AnchorToXPointer, truncateFb2AfterFirstBody,
} from '../src/kosync-position.js';
import {
  bridgeKosyncPositionToReader, readerProgressForKosync, clearKosyncXmlCache,
  KOSYNC_SERVER_DEVICE_ID,
} from '../src/services/kosync-position-bridge.js';
import { registerKosyncRoutes } from '../src/routes/kosync.js';
import { positionForBookFormat } from '../public/position-sync.js';

const md5 = (value) => crypto.createHash('md5').update(value).digest('hex');
const LONG = 'Долгий абзац о том, как текст длинный. '.repeat(20).trim();

const FB2 = `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info><book-title>Тест</book-title><annotation><p>Не в тексте</p></annotation></title-info></description>
<body>
<title><p>Название книги</p></title>
<section>
<title><p>Глава первая</p></title>
<p>Первый абзац с <emphasis>выделением</emphasis> &amp; сущностью.</p>
<p>${LONG}</p>
<poem><title><p>Заголовок стиха выпадает</p></title><stanza><v>Строка один</v>
<v>Строка <emphasis>два</emphasis></v></stanza></poem>
<empty-line/>
<p>После стиха.</p>
<!-- комментарий не текст -->
</section>
<section>
<title><p>Глава вторая</p></title>
<p>Абзац второй главы.</p>
<p>Последний абзац<![CDATA[ & CDATA]]>.</p>
</section>
</body>
<body name="notes"><section id="n1"><p>Примечание</p></section></body>
<binary id="x" content-type="image/png">AAAA</binary>
</FictionBook>`;

/* Text of reader section 0 as Foliate builds it (fb2.js + normalizedSectionText): body-level
   whitespace dropped, poem title dropped, stanza verses glued after the stanza, notes not included. */
const EXPECTED_TEXT = 'Название книги Глава первая Первый абзац с выделением & сущностью. '
  + `${LONG} Строка одинСтрока два После стиха. Глава вторая Абзац второй главы. Последний абзац & CDATA.`;

test('scanFb2Body rebuilds the Foliate section text of the first body', () => {
  assert.equal(scanFb2Body(FB2).text, EXPECTED_TEXT);
  assert.equal(scanFb2Body('<FictionBook><description/></FictionBook>'), null);
  assert.equal(scanFb2Body(truncateFb2AfterFirstBody(FB2)).text, EXPECTED_TEXT);
  assert.ok(!truncateFb2AfterFirstBody(FB2).includes('binary'));
});

test('parseXPointer: V1 / V2 forms, boxing nodes, text offsets', () => {
  assert.deepEqual(parseXPointer('/FictionBook/body/section[2]/p[3]/text().15'), {
    steps: [['FictionBook', 1], ['body', 1], ['section', 2], ['p', 3]], textIndex: 1, textOffset: 15,
  });
  assert.deepEqual(parseXPointer('/FictionBook[1]/body[1]/section[1]/autoBoxing/p[2]/text()[2].4').steps,
    [['FictionBook', 1], ['body', 1], ['section', 1], ['p', 2]]);
  assert.equal(parseXPointer('/FictionBook/body/p[2]/text()[2].4').textIndex, 2);
  assert.equal(parseXPointer('/FictionBook/body/section.3').textIndex, null);
  assert.equal(parseXPointer('epubcfi(/6/4!/4/2)'), null);
  assert.equal(parseXPointer(''), null);
});

test('xpointer → text anchor lands on the KOReader paragraph', () => {
  const text = EXPECTED_TEXT;
  const second = fb2XPointerToAnchor(FB2, '/FictionBook/body/section[1]/p[2]/text().0');
  assert.equal(second.sectionIndex, 0);
  assert.equal(second.textOffset, text.indexOf('Долгий абзац'));
  assert.equal(second.textQuote, text.slice(second.textOffset, second.textOffset + 96));
  assert.equal(second.textSectionLength, text.length);
  assert.ok(Math.abs(second.fraction - second.textOffset / text.length) < 1e-9);

  const mid = fb2XPointerToAnchor(FB2, '/FictionBook[1]/body[1]/section[1]/p[2]/text()[1].40');
  assert.equal(mid.textOffset, second.textOffset + 40);
  assert.ok(mid.textQuote.startsWith(text.slice(mid.textOffset, mid.textOffset + 10)));

  const inEmphasis = fb2XPointerToAnchor(FB2, '/FictionBook/body/section[1]/p[1]/emphasis/text().3');
  assert.equal(inEmphasis.textOffset, text.indexOf('выделением') + 3);

  const verse = fb2XPointerToAnchor(FB2, '/FictionBook/body/section[1]/poem/stanza/v[2]/text().0');
  assert.equal(verse.textOffset, text.indexOf('Строка два'));

  const chapter = fb2XPointerToAnchor(FB2, '/FictionBook/body/section[2]');
  assert.equal(chapter.textOffset, text.indexOf('Глава вторая'));

  // Near a paragraph end the quote would be too short: the paragraph start is used.
  const tail = fb2XPointerToAnchor(FB2, '/FictionBook/body/section[2]/p[1]/text().18');
  assert.equal(tail.textOffset, text.indexOf('Абзац второй главы.'));

  assert.equal(fb2XPointerToAnchor(FB2, '/FictionBook/body[2]/section/p/text().0'), null, 'notes body');
  assert.equal(fb2XPointerToAnchor(FB2, '/FictionBook/body/section[7]/p'), null, 'stale path');
  assert.equal(fb2XPointerToAnchor(FB2, '/body/DocFragment[3]/body/p[2]'), null, 'EPUB xpointer');
});

test('text anchor → xpointer of the block, with explicit indexes', () => {
  const text = EXPECTED_TEXT;
  const at = (needle, extra = 0) => text.indexOf(needle) + extra;
  assert.equal(fb2AnchorToXPointer(FB2, { textOffset: at('Долгий абзац', 120) }).xpointer,
    '/FictionBook[1]/body[1]/section[1]/p[2]');
  assert.equal(fb2AnchorToXPointer(FB2, { textOffset: at('Строка два') }).xpointer,
    '/FictionBook[1]/body[1]/section[1]/poem[1]/stanza[1]/v[2]');
  assert.equal(fb2AnchorToXPointer(FB2, { textOffset: at('Глава вторая') }).xpointer,
    '/FictionBook[1]/body[1]/section[2]/title[1]/p[1]');
  // A drifted offset is corrected by the quote (the reader's own ±2000 rule).
  assert.equal(fb2AnchorToXPointer(FB2, { textOffset: 3, textQuote: 'После стиха.' }).xpointer,
    '/FictionBook[1]/body[1]/section[1]/p[3]');
  assert.equal(fb2AnchorToXPointer(FB2, { fraction: 0.999 }).xpointer, '/FictionBook[1]/body[1]/section[2]/p[2]');
  assert.equal(fb2AnchorToXPointer(FB2, {}), null);

  // Round trip: every generated xpointer resolves back to its block start.
  for (const needle of ['Первый абзац', 'Долгий', 'Строка один', 'После стиха', 'Абзац второй', 'Последний']) {
    const hit = fb2AnchorToXPointer(FB2, { textOffset: at(needle) });
    assert.equal(fb2XPointerToAnchor(FB2, hit.xpointer).textOffset, at(needle), needle);
  }
});

test('kosyncFormatFromFileName', () => {
  assert.equal(kosyncFormatFromFileName('Автор - Книга.fb2.zip'), 'fb2zip');
  assert.equal(kosyncFormatFromFileName('book.FB2'), 'fb2');
  assert.equal(kosyncFormatFromFileName('book.epub'), 'epub');
  assert.equal(kosyncFormatFromFileName(''), '');
});

describeBridge();

function describeBridge() {
  const USER = 'kosync_pos_user';
  const BOOK_ID = 'kosync-pos-book-1';
  const EPUB_ID = 'kosync-pos-book-2';
  let dir;
  let sourceId;
  let server;
  let baseUrl;
  let password;
  const fb2Doc = md5('fb2 document');
  const legacyDoc = md5('legacy document');
  const epubDoc = md5('epub converted document');

  before(async () => {
    initDb();
    if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(USER)) createUser({ username: USER, password: 'KosyncPos1!' });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kosync-pos-'));
    fs.writeFileSync(path.join(dir, 'book.fb2'), FB2);
    fs.writeFileSync(path.join(dir, 'other.epub'), 'not really an epub');
    sourceId = addSource({ name: 'KOSync position', type: 'folder', path: dir, fastScan: true }).id;
    const insert = db.prepare(`INSERT OR REPLACE INTO books (id, title, authors, file_name, archive_name, ext, lang, source_id)
      VALUES (?, ?, 'Автор', ?, '', ?, 'ru', ?)`);
    insert.run(BOOK_ID, 'Книга', 'book', 'fb2', sourceId);
    insert.run(EPUB_ID, 'Другая', 'other', 'epub', sourceId);
    const remember = db.prepare('INSERT OR REPLACE INTO kosync_documents(document, book_id, format) VALUES(?, ?, ?)');
    remember.run(fb2Doc, BOOK_ID, 'fb2');
    remember.run(legacyDoc, BOOK_ID, '');
    remember.run(epubDoc, EPUB_ID, 'epub');
    password = createKosyncPassword(USER);
    const app = express();
    app.use(express.json());
    registerKosyncRoutes(app);
    server = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.prepare('DELETE FROM books WHERE id IN (?, ?)').run(BOOK_ID, EPUB_ID);
    db.prepare('DELETE FROM reading_positions WHERE username = ?').run(USER);
    db.prepare('DELETE FROM sources WHERE id = ?').run(sourceId);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const resetPosition = () => {
    db.prepare('DELETE FROM reading_positions WHERE username = ?').run(USER);
    db.prepare('DELETE FROM kosync_progress WHERE username = ?').run(USER);
    clearKosyncXmlCache();
  };

  test('rememberKosyncDocument fills the format of a row remembered without one', () => {
    const buf = Buffer.from(`unique ${Date.now()}`);
    rememberKosyncDocument(BOOK_ID, buf);
    rememberKosyncDocument(BOOK_ID, buf, 'fb2zip');
    rememberKosyncDocument(BOOK_ID, buf, 'epub');
    const row = db.prepare('SELECT format FROM kosync_documents WHERE book_id = ? AND format = ?').get(BOOK_ID, 'fb2zip');
    assert.ok(row, 'the first known format is kept');
  });

  test('KOReader → reader: FB2 xpointer becomes the v4 text anchor, the hold is released', async () => {
    resetPosition();
    const result = await bridgeKosyncPositionToReader(USER, fb2Doc, {
      progress: '/FictionBook/body/section[1]/p[2]/text().40', percentage: 0.31, deviceId: 'kobo-1',
    });
    assert.equal(result, 'saved');
    const pos = getReadingPosition(USER, BOOK_ID);
    assert.equal(pos.sectionIndex, 0);
    assert.equal(pos.textOffset, EXPECTED_TEXT.indexOf('Долгий абзац') + 40);
    assert.equal(pos.textSectionLength, EXPECTED_TEXT.length);
    assert.equal(pos.positionVersion, 4);
    assert.equal(pos.sessionId, 'kosync:kobo-1');
    assert.equal(pos.sessionStatus, 'idle', 'released: web / Android can save at once');
    // Marked as an FB2 position like a native web save: the app's converted EPUB copy drops the anchor.
    assert.equal(pos.fb2Href, '0');
    const asEpub = positionForBookFormat(pos, false);
    assert.equal(asEpub.textOffset, null);
    assert.equal(asEpub.fraction, pos.fraction);
    assert.equal(positionForBookFormat(pos, true).textOffset, pos.textOffset);
    assert.ok(pos.progress > 0 && pos.progress < 100);

    // Same paragraph again (KOReader echoing the spot it was sent) → no new revision.
    const again = await bridgeKosyncPositionToReader(USER, fb2Doc, {
      progress: '/FictionBook/body/section[1]/p[2]/text().0', percentage: 0.3, deviceId: 'kobo-1',
    });
    assert.equal(again, 'same');
    assert.equal(getReadingPosition(USER, BOOK_ID).revision, pos.revision);

    // Reader read on (active session): KOReader cannot overwrite it now.
    setReadingPositionCas(USER, BOOK_ID, pos.revision, '', 80, 0.8, null, {
      sectionIndex: 0, textOffset: EXPECTED_TEXT.indexOf('Абзац второй'), textQuote: 'Абзац второй главы.',
      textSectionLength: EXPECTED_TEXT.length, sessionId: 'web-session',
    });
    const busy = await bridgeKosyncPositionToReader(USER, fb2Doc, {
      progress: '/FictionBook/body/section[1]/p[1]/text().0', percentage: 0.05, deviceId: 'kobo-1',
    });
    assert.equal(busy, 'busy');
    assert.equal(getReadingPosition(USER, BOOK_ID).sessionId, 'web-session');
  });

  test('KOReader → reader: other formats move by percentage, legacy rows need an FB2 xpointer', async () => {
    resetPosition();
    assert.equal(await bridgeKosyncPositionToReader(USER, epubDoc, {
      progress: '/body/DocFragment[3]/body/p[2]/text().0', percentage: 0.42, deviceId: 'kobo-1',
    }), 'saved');
    const epubPos = getReadingPosition(USER, EPUB_ID);
    assert.equal(epubPos.fraction, 0.42);
    assert.equal(epubPos.textOffset, null);

    assert.equal(await bridgeKosyncPositionToReader(USER, legacyDoc, {
      progress: '/FictionBook/body/section[2]/p[1]/text().0', percentage: 0.9, deviceId: 'kobo-1',
    }), 'saved');
    assert.equal(getReadingPosition(USER, BOOK_ID).textOffset, EXPECTED_TEXT.indexOf('Абзац второй'));
    assert.equal(await bridgeKosyncPositionToReader(USER, md5('unknown'), { progress: '/x', percentage: 0.5 }), 'skip');
  });

  test('reader → KOReader: a newer web position is served as an FB2 xpointer, not its own echo', async () => {
    resetPosition();
    assert.equal(await readerProgressForKosync(USER, fb2Doc, null), null, 'no reader position');

    await bridgeKosyncPositionToReader(USER, fb2Doc, {
      progress: '/FictionBook/body/section[1]/p[1]/text().0', percentage: 0.02, deviceId: 'kobo-1',
    });
    assert.equal(await readerProgressForKosync(USER, fb2Doc, null), null, 'KOReader is not sent its own position');

    const current = getReadingPosition(USER, BOOK_ID);
    const offset = EXPECTED_TEXT.indexOf('Строка один') + 4;
    setReadingPositionCas(USER, BOOK_ID, current.revision, '', 60, offset / EXPECTED_TEXT.length, null, {
      sectionIndex: 0, textOffset: offset, textQuote: EXPECTED_TEXT.slice(offset, offset + 96),
      textSectionLength: EXPECTED_TEXT.length, sessionId: 'web-session',
    });
    const served = await readerProgressForKosync(USER, fb2Doc, null);
    assert.equal(served.progress, '/FictionBook[1]/body[1]/section[1]/poem[1]/stanza[1]/v[1]');
    assert.equal(served.device_id, KOSYNC_SERVER_DEVICE_ID);
    assert.equal(served.document, fb2Doc);
    assert.ok(served.percentage > 0 && served.percentage < 1);
    assert.ok(served.timestamp > 0);

    assert.equal(await readerProgressForKosync(USER, fb2Doc, { timestamp: served.timestamp + 10, progress: '/FictionBook/body' }), null,
      'KOReader pushed after the web save → its own record wins');
    assert.equal(await readerProgressForKosync(USER, epubDoc, null), null, 'no xpointers for a converted EPUB');
  });

  test('KOSync routes: GET returns the reader position, PUT moves the reader', async () => {
    resetPosition();
    const headers = { 'x-auth-user': USER, 'x-auth-key': md5(password), 'content-type': 'application/json' };
    const offset = EXPECTED_TEXT.indexOf('После стиха');
    setReadingPositionCas(USER, BOOK_ID, 0, '', 70, offset / EXPECTED_TEXT.length, null, {
      sectionIndex: 0, textOffset: offset, textQuote: 'После стиха.', textSectionLength: EXPECTED_TEXT.length, sessionId: 'web-session',
    });
    const got = await (await fetch(`${baseUrl}/kosync/syncs/progress/${fb2Doc}`, { headers })).json();
    assert.equal(got.progress, '/FictionBook[1]/body[1]/section[1]/p[3]');
    assert.equal(got.device_id, KOSYNC_SERVER_DEVICE_ID);

    const empty = await (await fetch(`${baseUrl}/kosync/syncs/progress/${md5('nothing')}`, { headers })).json();
    assert.deepEqual(empty, {});

    // The web session is idle once released; KOReader's push then moves the reader.
    db.prepare('UPDATE reading_positions SET last_user_activity_at = NULL WHERE username = ?').run(USER);
    const put = await fetch(`${baseUrl}/kosync/syncs/progress`, {
      method: 'PUT', headers,
      body: JSON.stringify({ document: fb2Doc, progress: '/FictionBook/body/section[2]/p[2]/text().0', percentage: 0.97, device: 'Kobo', device_id: 'kobo-1' }),
    });
    assert.equal(put.status, 200);
    for (let i = 0; i < 50 && getReadingPosition(USER, BOOK_ID).sessionId !== 'kosync:kobo-1'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(getReadingPosition(USER, BOOK_ID).textOffset, EXPECTED_TEXT.indexOf('Последний абзац'));

    const after = await (await fetch(`${baseUrl}/kosync/syncs/progress/${fb2Doc}`, { headers })).json();
    assert.equal(after.device_id, 'kobo-1', 'KOReader record again, not the bridged echo');

    // Read on in the web, then KOReader re-sends its unchanged spot (sleep / close): the web stays newer.
    const kobo = db.prepare('SELECT updated_at AS t FROM kosync_progress WHERE username = ? AND document = ?').get(USER, fb2Doc).t;
    db.prepare('UPDATE kosync_progress SET updated_at = ? WHERE username = ? AND document = ?').run(kobo - 120, USER, fb2Doc);
    const pos = getReadingPosition(USER, BOOK_ID);
    const offset2 = EXPECTED_TEXT.indexOf('Глава вторая');
    setReadingPositionCas(USER, BOOK_ID, pos.revision, '', 90, offset2 / EXPECTED_TEXT.length, '0', {
      sectionIndex: 0, textOffset: offset2, textQuote: 'Глава вторая', textSectionLength: EXPECTED_TEXT.length, sessionId: 'web-2',
    });
    db.prepare(`UPDATE reading_positions SET updated_at = datetime('now', '-60 seconds') WHERE username = ?`).run(USER);
    await fetch(`${baseUrl}/kosync/syncs/progress`, {
      method: 'PUT', headers,
      body: JSON.stringify({ document: fb2Doc, progress: '/FictionBook/body/section[2]/p[2]/text().0', percentage: 0.97, device: 'Kobo', device_id: 'kobo-1' }),
    });
    const pulled = await (await fetch(`${baseUrl}/kosync/syncs/progress/${fb2Doc}`, { headers })).json();
    assert.equal(pulled.progress, '/FictionBook[1]/body[1]/section[2]/title[1]/p[1]', 'web position still reaches KOReader');
  });
}
