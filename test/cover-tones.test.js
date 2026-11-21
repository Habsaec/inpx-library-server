import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { db, initDb } from '../src/db.js';
import {
  computeCoverTone, setCoverTone, getCoverTones, attachCoverTones, deleteCoverTone, hasCoverTone,
} from '../src/services/cover-tones.js';
import { renderCover, renderCoverLqip, coverToneStyle } from '../src/templates/shared.js';

async function sampleCover() {
  /* mostly deep red with a light band: the dominant color must be the red */
  return sharp({ create: { width: 220, height: 320, channels: 3, background: { r: 150, g: 20, b: 30 } } })
    .composite([{ input: { create: { width: 220, height: 60, channels: 3, background: { r: 240, g: 230, b: 210 } } }, top: 20, left: 0 }])
    .webp({ quality: 62 })
    .toBuffer();
}

test('computeCoverTone: dominant color and a small WebP placeholder', async () => {
  const tone = await computeCoverTone(await sampleCover());
  assert.match(tone.color, /^#[0-9a-f]{6}$/);
  const r = parseInt(tone.color.slice(1, 3), 16);
  const g = parseInt(tone.color.slice(3, 5), 16);
  assert.ok(r > 100 && g < 80, `dominant is the red: ${tone.color}`);
  assert.match(tone.lqip, /^data:image\/webp;base64,/);
  assert.ok(tone.lqip.length < 400, `placeholder stays tiny: ${tone.lqip.length} chars`);
  assert.equal(await computeCoverTone(Buffer.from('not an image')), null);
});

test('stored tones ride on book payloads and cover markup; invalidation drops them', async () => {
  const id = 'tone-test-book';
  initDb();
  db.pragma('foreign_keys = OFF'); // no source row needed for this fixture
  db.prepare(`
    INSERT OR IGNORE INTO books (
      id, title, authors, genres, series, series_no, title_sort, author_sort,
      series_sort, series_index, title_search, authors_search, series_search,
      genres_search, keywords_search, file_name, archive_name, size, lib_id, deleted,
      ext, date, lang, keywords, lib_rate, source_id
    ) VALUES (?, 'T', 'A', '', '', '', 't', 'a', '', 0, 't', 'a', '', '', '', 'f.fb2', 'a.zip', 1, ?, 0, 'fb2', '', 'ru', '', 0, 1)
  `).run(id, id);
  db.pragma('foreign_keys = ON');
  const tone = await computeCoverTone(await sampleCover());
  setCoverTone(id, tone.color, tone.lqip);
  assert.equal(hasCoverTone(id), true);
  assert.equal(getCoverTones([id, 'missing']).size, 1);

  const books = [{ id, title: 'T', authors: 'A' }, { id: 'missing', title: 'M', authors: 'B' }];
  attachCoverTones(books);
  assert.equal(books[0].coverColor, tone.color);
  assert.equal(books[0].coverLqip, tone.lqip);
  assert.equal(books[1].coverColor, undefined);

  const html = renderCover(books[0]);
  assert.match(html, /--cover-tone:#[0-9a-f]{6}/);
  assert.match(html, /class="cover-lqip"/);
  assert.doesNotMatch(renderCover(books[1]), /cover-lqip|--cover-tone/);
  /* only safe values reach the markup */
  assert.equal(renderCoverLqip({ coverLqip: 'javascript:alert(1)' }), '');
  assert.equal(coverToneStyle({ coverColor: 'red;}' }), '');

  setCoverTone(id, 'not-a-color');
  assert.equal(getCoverTones([id]).get(id).color, tone.color, 'invalid color ignored');
  deleteCoverTone(id);
  assert.equal(hasCoverTone(id), false);
  db.prepare('DELETE FROM books WHERE id = ?').run(id);
});
