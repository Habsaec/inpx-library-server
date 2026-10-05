import test from 'node:test';
import assert from 'node:assert/strict';
import { balanceHtmlFragment, stripFlibustaMediaPlaceholders } from '../src/html-sanitize.js';
import { sanitizeHtml } from '../src/templates/shared.js';
import { sanitizeRichAnnotationHtml } from '../src/flibusta-sidecar.js';

test('balanceHtmlFragment closes unclosed anchors', () => {
  const html = '<p>See <a href="https://example.com/author">Author</p>';
  assert.equal(
    balanceHtmlFragment(html),
    '<p>See <a href="https://example.com/author">Author</p></a>'
  );
});

test('sanitizeHtml keeps closing </a> tags', () => {
  const html = '<p>Bio <a href="https://example.com/wiki">Wiki</a> end</p>';
  const out = sanitizeHtml(html);
  assert.match(out, /<a href="https:\/\/example\.com\/wiki"[^>]*>Wiki<\/a>/);
  assert.ok(!out.includes('<a href="https://example.com/wiki"') || out.includes('</a>'));
  assert.equal((out.match(/<a\b/g) || []).length, (out.match(/<\/a>/g) || []).length);
});

test('sanitizeHtml does not leave open anchors that wrap later siblings', () => {
  const html = 'Text <a href="https://evil.example/author">link</a>';
  const out = sanitizeHtml(html);
  assert.ok(out.includes('</a>'));
  assert.equal((out.match(/<a\b/g) || []).length, (out.match(/<\/a>/g) || []).length);
});

test('sanitizeRichAnnotationHtml balances unclosed author links', () => {
  const html = '<p>Автор на <a href="https://flibusta.example/a/123">сайте</p>';
  const out = sanitizeRichAnnotationHtml(html);
  assert.ok(out.includes('href="https://flibusta.example/a/123"'));
  assert.equal((out.match(/<a\b/g) || []).length, (out.match(/<\/a>/g) || []).length);
});

test('stripFlibustaMediaPlaceholders removes float portrait slots', () => {
  const raw = '[float=right]$$0$$[/float]<br/><a href="http://www.libbabray.com/">Официальный сайт</a>';
  assert.equal(
    stripFlibustaMediaPlaceholders(raw),
    '<a href="http://www.libbabray.com/">Официальный сайт</a>'
  );
  const out = sanitizeRichAnnotationHtml(raw);
  assert.equal(out.includes('$$0$$'), false);
  assert.equal(out.includes('[float'), false);
  assert.match(out, /href="http:\/\/www\.libbabray\.com\/"/);
});

test('sanitizeHtml strips bare $$N$$ slots left in bio text', () => {
  const out = sanitizeHtml('$$0$$<p>Биография автора</p>$$1$$');
  assert.equal(out.includes('$$'), false);
  assert.match(out, /Биография автора/);
});

test('flibusta annotations.7z entity-encoded paragraphs become real tags', () => {
  const raw = '&lt;p&gt;Я был Охотником.&lt;/p&gt;&lt;p&gt;Но, что-то пошло не так.&lt;/p&gt;&lt;image l:href="#1"&gt;&lt;/image&gt;';
  const rich = sanitizeRichAnnotationHtml(raw);
  assert.equal(rich.includes('&lt;'), false);
  assert.equal(rich.includes('image'), false);
  assert.match(rich, /<p>Я был Охотником\.<\/p><p>Но, что-то пошло не так\.<\/p>/);
  const page = sanitizeHtml(raw);
  assert.match(page, /<p>Я был Охотником\.<\/p><p>Но, что-то пошло не так\.<\/p>/);
  assert.equal(page.includes('image'), false);
});

test('unwrap leaves real HTML and an intentional escaped less-than', () => {
  const html = '<p>Смотри &lt;b&gt; так &lt;/b&gt;</p>';
  assert.equal(sanitizeHtml(html), '<p>Смотри &lt;b&gt; так &lt;/b&gt;</p>');
});

test('stripFlibustaMediaPlaceholders removes filename image slots', () => {
  const raw = '[float=left]$$jimcarrey_countolaf_inline1.jpg$$[/float]<p>Bio</p>';
  const out = stripFlibustaMediaPlaceholders(raw);
  assert.equal(out.includes('$$'), false);
  assert.equal(out.includes('[float'), false);
  assert.match(out, /Bio/);
});
