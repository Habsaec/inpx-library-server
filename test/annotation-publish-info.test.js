import test from 'node:test';
import assert from 'node:assert/strict';
import { annotationBbCodeToHtml, hasBbCode } from '../src/html-sanitize.js';
import { sanitizeHtml } from '../src/templates/shared.js';
import { extractPublishInfo } from '../src/fb2.js';
import { buildDownloadBaseName, EMAIL_FILENAME_STYLE } from '../src/download-filename.js';

const render = (text, isHtml = false) => {
  const out = annotationBbCodeToHtml(text, isHtml);
  return out.annotationIsHtml ? sanitizeHtml(out.annotation) : out.annotation;
};

test('annotation without BB-code is left untouched', () => {
  assert.equal(hasBbCode('Просто [текст] в скобках'), false);
  assert.deepEqual(annotationBbCodeToHtml('a < b', false), { annotation: 'a < b', annotationIsHtml: false });
});

test('BB-code formatting, spoilers, quotes, lists and links', () => {
  const html = render('[b]Жирный[/b] и [i][u]курсив[/u][/i]\n[spoiler=Финал]Все умерли[/spoiler][quote=Автор]цитата[/quote][list][*]раз[*]два[/list] [color=red]красный[/color] [url=https://example.com/?a=1&b=2]ссылка[/url]');
  assert.match(html, /<strong>Жирный<\/strong> и <em><u>курсив<\/u><\/em><br>/);
  assert.match(html, /<details><summary>Финал<\/summary><div>Все умерли<\/div><\/details>/);
  assert.match(html, /<blockquote><p><strong>Автор:<\/strong><\/p>цитата<\/blockquote>/);
  assert.match(html, /<ul><li>раз<\/li><li>два<\/li><\/ul>/);
  assert.match(html, / красный /);
  assert.match(html, /<a href="https:\/\/example\.com\/\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">ссылка<\/a>/);
});

test('BB-code conversion cannot inject markup', () => {
  const html = render('<script>alert(1)</script> [spoiler=x" onclick="alert(1)]a[/spoiler] [spoiler=<img src=x onerror=alert(1)>]b[/spoiler] [url=javascript:alert(1)]c[/url] [url=https://x.y/" onmouseover="z]d[/url] [b]unclosed');
  assert.doesNotMatch(html, /<script|<img|onclick=|onerror=|onmouseover=|javascript:/i);
  assert.match(html, /&lt;script&gt;/);
  assert.equal((html.match(/<summary>/g) || []).length, (html.match(/<\/summary>/g) || []).length);
  assert.match(html, / c /, 'unsafe link keeps only its text');
  assert.doesNotMatch(html, /\[b\]/, 'unpaired tag dropped');
});

test('BB-code inside an HTML annotation keeps the markup', () => {
  assert.equal(render('<p>[b]x[/b]</p>', true), '<p><strong>x</strong></p>');
  // Flibusta annotations.7z stores entity-encoded markup.
  assert.equal(render('&lt;p&gt;[spoiler]y[/spoiler]&lt;/p&gt;', true), '<p><details><summary>Спойлер</summary><div>y</div></details></p>');
});

test('extractPublishInfo: <publish-info> year + first ISBN, <title-info><date> fallback', () => {
  const xml = `<description><title-info><date value="1965-01-01">1965</date></title-info>
    <publish-info><publisher>АСТ</publisher><year>2003 г.</year><isbn>ISBN 5-17-012345-6, 978-5-17-012345-7</isbn></publish-info></description>`;
  assert.deepEqual(extractPublishInfo(xml), { publishYear: 2003, isbn: '5-17-012345-6' });
  assert.deepEqual(extractPublishInfo('<title-info><date value="1965-03-01"/></title-info>'), { publishYear: 1965, isbn: '' });
  assert.deepEqual(extractPublishInfo('<title-info><date>около 1840</date></title-info>'), { publishYear: 1840, isbn: '' });
  assert.deepEqual(extractPublishInfo('<publish-info><year>9999</year><isbn>нет</isbn></publish-info>'), { publishYear: null, isbn: '' });
  assert.equal(extractPublishInfo('<publish-info><isbn>978-5-389-07435-x</isbn></publish-info>').isbn, '978-5-389-07435-X');
});

test('e-mail attachments are named by the book title', () => {
  assert.equal(EMAIL_FILENAME_STYLE, 'title');
  const book = { authors: 'Uolles,Devid Foster', title: 'Бесконечная шутка', series: 'Великие романы', seriesNo: '1' };
  assert.equal(buildDownloadBaseName(book, EMAIL_FILENAME_STYLE), 'Бесконечная шутка');
});
