/**
 * Regression: OPDS book entries must produce well-formed XML.
 *
 * The EPUB conversion link previously emitted a bare '&' in the href
 * ("?opds=1&format=epub2"), violating XML 1.0 §2.4. Strict OPDS clients
 * (FBReader, Kindle) abort the parse and show "каталог пуст". AlReader is
 * lenient and accepts the malformed document — that's why the bug only
 * manifested on some readers.
 *
 * Atom RFC 4287 §4.1.2 also requires every <entry> to contain <updated>;
 * §4.2.6 requires <id> to be an IRI. We pin both here.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { renderOpdsBooksFeed } from '../src/templates/opds.js';

const sampleBook = {
  id: '2:315483',
  title: 'Лорд с планеты Земля',
  authors: 'Лукьяненко, Сергей',
  series: 'Абсолютное оружие',
  seriesNo: '1',
  ext: 'fb2',
  lang: 'ru',
  genres: 'sf'
};

function getXml() {
  return renderOpdsBooksFeed('http://example', {
    id: 'search',
    title: 'Абсолютное оружие',
    selfPath: '/opds/author?author=%3DTest&series=Test',
    items: [sampleBook]
  });
}

test('book entry href values escape & as &amp; (XML 1.0 §2.4 well-formedness)', () => {
  const xml = getXml();
  // No bare '&' allowed in attribute values. Match: & not followed by amp;/lt;/gt;/quot;/apos;/#.
  const bareAmp = xml.match(/&(?!(amp|lt|gt|quot|apos|#)[^;]*;)/);
  assert.strictEqual(
    bareAmp,
    null,
    `XML must not contain bare '&'. Found near: ${bareAmp ? xml.slice(Math.max(0, bareAmp.index - 30), bareAmp.index + 60) : ''}`
  );
});

test('book entry contains mandatory <updated> (Atom RFC 4287 §4.1.2)', () => {
  const xml = getXml();
  const entryMatch = xml.match(/<entry>[\s\S]*?<\/entry>/);
  assert.ok(entryMatch, 'entry should be present');
  assert.ok(/<updated>[^<]+<\/updated>/.test(entryMatch[0]), 'each <entry> must have <updated>');
});

test('book entry <id> is a valid IRI (urn:inpx:book:...)', () => {
  const xml = getXml();
  const entryMatch = xml.match(/<entry>[\s\S]*?<\/entry>/);
  assert.ok(entryMatch);
  const idMatch = entryMatch[0].match(/<id>([^<]+)<\/id>/);
  assert.ok(idMatch, '<id> should be present');
  assert.ok(/^urn:/.test(idMatch[1]), `<id> must be IRI, got: ${idMatch[1]}`);
});

test('feed parses as well-formed XML (smoke test via XMLParser if available)', () => {
  // We do not depend on a parser library; instead, verify all `&` in attribute
  // values are followed by a valid entity reference. (Same idea as above but
  // narrowed to attribute substrings, catching regression in any new attribute.)
  const xml = getXml();
  const attrRegex = /\s[a-zA-Z:]+="([^"]*)"/g;
  let m;
  while ((m = attrRegex.exec(xml)) !== null) {
    const value = m[1];
    const bare = value.match(/&(?!(amp|lt|gt|quot|apos|#)[^;]*;)/);
    assert.strictEqual(bare, null, `attribute contains bare '&': ${value}`);
  }
});
