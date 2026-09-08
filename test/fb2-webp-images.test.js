import { test } from 'node:test';
import assert from 'node:assert/strict';
import iconv from 'iconv-lite';
import {
  FB2_WEBP_MODES,
  DEFAULT_FB2_WEBP_MODE,
  normalizeFb2WebpMode,
  setFb2WebpMode,
  getFb2WebpMode,
  convertFb2WebpBinariesToPng
} from '../src/fb2-webp-images.js';
import { getSharp } from '../src/services/sharp-loader.js';
import { detectImageMimeFromBuffer } from '../src/services/cover.js';

const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x02]);

function binaryBlock(id, contentType, data) {
  return `<binary id="${id}" content-type="${contentType}">${data.toString('base64')}</binary>`;
}

function extractBinary(xml, id) {
  const m = xml.match(new RegExp(`<binary\\b([^>]*\\bid="${id}"[^>]*)>([\\s\\S]*?)</binary>`, 'i'));
  assert.ok(m, `binary ${id} missing`);
  return { attrs: m[1], data: Buffer.from(m[2].replace(/\s+/g, ''), 'base64') };
}

test('fb2 webp mode normalizes unknown values to keep', () => {
  assert.deepEqual(FB2_WEBP_MODES, ['keep', 'png']);
  assert.equal(normalizeFb2WebpMode(''), DEFAULT_FB2_WEBP_MODE);
  assert.equal(normalizeFb2WebpMode('PNG '), 'png');
  assert.equal(normalizeFb2WebpMode('jpeg'), 'keep');
  setFb2WebpMode('png');
  assert.equal(getFb2WebpMode(), 'png');
  setFb2WebpMode(undefined);
  assert.equal(getFb2WebpMode(), 'keep');
});

test('convertFb2WebpBinariesToPng leaves FB2 without webp untouched', async () => {
  const src = Buffer.from(`<FictionBook><body><p>Текст</p></body>${binaryBlock('cover.jpg', 'image/jpeg', FAKE_JPEG)}</FictionBook>`, 'utf8');
  const out = await convertFb2WebpBinariesToPng(src);
  assert.equal(out, src);
});

test('convertFb2WebpBinariesToPng recodes webp binaries (sniffed by bytes) and keeps encoding', async (t) => {
  const sharp = await getSharp();
  if (!sharp) {
    t.skip('sharp is not available');
    return;
  }
  const webp = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#3366cc' } }).webp().toBuffer();
  assert.equal(detectImageMimeFromBuffer(webp), 'image/webp');

  const body = '<FictionBook><description><title-info><book-title>Тест — «WebP»</book-title></title-info></description>' +
    '<body><p>Привет</p></body>' +
    // как в сжатых сборках: content-type объявлен jpeg, внутри — WebP
    binaryBlock('cover.jpg', 'image/jpeg', webp) +
    binaryBlock('pic.webp', 'image/webp', webp) +
    binaryBlock('real.jpg', 'image/jpeg', FAKE_JPEG) +
    '</FictionBook>';

  for (const encoding of ['utf8', 'win1251']) {
    const src = iconv.encode(`<?xml version="1.0" encoding="${encoding === 'utf8' ? 'utf-8' : 'windows-1251'}"?>${body}`, encoding);
    const out = await convertFb2WebpBinariesToPng(src);
    assert.notEqual(out, src);
    const xml = iconv.decode(out, encoding);
    assert.ok(xml.includes('Тест — «WebP»'), `${encoding}: text preserved`);
    assert.ok(xml.includes('<p>Привет</p>'));

    for (const id of ['cover.jpg', 'pic.webp']) {
      const bin = extractBinary(xml, id);
      assert.match(bin.attrs, /content-type="image\/png"/, `${encoding}: ${id} content-type`);
      assert.ok(bin.attrs.includes(`id="${id}"`), `${encoding}: ${id} id preserved`);
      assert.equal(detectImageMimeFromBuffer(bin.data), 'image/png', `${encoding}: ${id} bytes`);
      const meta = await sharp(bin.data).metadata();
      assert.equal(meta.width, 8);
      assert.equal(meta.height, 6);
    }
    const jpeg = extractBinary(xml, 'real.jpg');
    assert.match(jpeg.attrs, /content-type="image\/jpeg"/);
    assert.ok(jpeg.data.equals(FAKE_JPEG), `${encoding}: non-webp binary untouched`);
  }
});
