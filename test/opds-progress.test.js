import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { initDb, db } from '../src/db.js';
import { opdsProgressIcon, getOpdsProgressMap, withOpdsProgress } from '../src/opds-progress.js';
import { rememberKosyncDocument, partialMd5, saveKosyncProgress } from '../src/kosync.js';
import { renderOpdsBooksFeed, renderOpdsBookDetail } from '../src/templates/opds.js';

const USER = 'opds_progress_user';
const book = (id, title) => ({ id, title, authors: 'Автор', ext: 'epub', lang: 'ru', genres: 'sf' });

before(() => {
  initDb();
});

test('opdsProgressIcon buckets like Kavita and skips unstarted books', () => {
  assert.equal(opdsProgressIcon(0), '');
  assert.equal(opdsProgressIcon(10), '\u25D4');
  assert.equal(opdsProgressIcon(25), '\u25D4');
  assert.equal(opdsProgressIcon(40), '\u25D1');
  assert.equal(opdsProgressIcon(80), '\u25D5');
  assert.equal(opdsProgressIcon(99.5), '\u2B24');
  assert.equal(opdsProgressIcon(3, true), '\u2B24');
});

test('progress map merges reader position and KOReader progress, per user', () => {
  db.prepare('INSERT OR REPLACE INTO reading_positions(username, book_id, progress) VALUES(?, ?, ?)').run(USER, 'op:1', 30);

  const koBuf = crypto.randomBytes(2500);
  rememberKosyncDocument('op:2', koBuf);
  saveKosyncProgress(USER, { document: partialMd5(koBuf), progress: 'x', percentage: 0.8, device: 'd', device_id: 'i' });

  // reader says 30 %, KOReader says 60 % for the same book → the larger one wins
  db.prepare('INSERT OR REPLACE INTO reading_positions(username, book_id, progress) VALUES(?, ?, ?)').run(USER, 'op:3', 30);
  const koBuf3 = crypto.randomBytes(2500);
  rememberKosyncDocument('op:3', koBuf3);
  saveKosyncProgress(USER, { document: partialMd5(koBuf3), progress: 'x', percentage: 0.6, device: 'd', device_id: 'i' });

  const map = getOpdsProgressMap(USER, ['op:1', 'op:2', 'op:3', 'op:none']);
  assert.equal(map.get('op:1').percent, 30);
  assert.equal(map.get('op:2').percent, 80);
  assert.equal(map.get('op:3').percent, 60);
  assert.equal(map.has('op:none'), false);
  assert.equal(getOpdsProgressMap('someone_else', ['op:1']).size, 0);
  assert.equal(getOpdsProgressMap('', ['op:1']).size, 0);

  const items = [book('op:1', 'A'), book('op:none', 'B')];
  const out = withOpdsProgress(items, USER);
  assert.equal(out[0].opdsProgressIcon, '\u25D1');
  assert.equal(out[1], items[1], 'unstarted books are passed through untouched');
  assert.equal(items[0].opdsProgressIcon, undefined, 'source objects are not mutated');
  assert.equal(withOpdsProgress(items, ''), items);
});

test('OPDS feed prefixes titles of started books for the signed-in user only', () => {
  const items = [book('op:1', 'Начатая'), book('op:none', 'Новая')];
  const xml = renderOpdsBooksFeed('http://example', { id: 'x', title: 'x', selfPath: '/opds/x', items, username: USER });
  assert.match(xml, /<title>\u25D1 Начатая \(epub\)<\/title>/);
  assert.match(xml, /<title>Новая \(epub\)<\/title>/);

  const anon = renderOpdsBooksFeed('http://example', { id: 'x', title: 'x', selfPath: '/opds/x', items });
  assert.match(anon, /<title>Начатая \(epub\)<\/title>/);

  const detail = renderOpdsBookDetail('http://example', items[0], { username: USER });
  assert.match(detail, /<title>\u25D1 Начатая \(epub\)<\/title>/);
});
