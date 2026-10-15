import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import archiver from 'archiver';
import sharp from 'sharp';
import { config } from '../src/config.js';
import { decodeJxlInWorker } from '../src/services/jxl-pool.js';
import { mergeSidecarBinariesIntoFb2Xml } from '../src/flibusta-sidecar.js';
import { mergedFb2CacheKey, readMergedFb2, storeMergedFb2, withMergedFb2Lock } from '../src/fb2-sidecar-cache.js';

const OPAQUE = fs.readFileSync(new URL('./fixtures/opaque.jxl', import.meta.url));
const ALPHA = fs.readFileSync(new URL('./fixtures/alpha.jxl', import.meta.url));
const skipNoSharp = config.coverProcessingEnabled ? false : 'sharp/libvips disabled on this CPU';

function buildZip(entries) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sink = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
    const zip = archiver('zip', { zlib: { level: 0 } });
    zip.on('error', reject);
    sink.on('finish', () => resolve(Buffer.concat(chunks)));
    zip.pipe(sink);
    for (const { name, data } of entries) zip.append(data, { name });
    zip.finalize();
  });
}

test('JXL without alpha is decoded in a worker into a JPEG', { skip: skipNoSharp }, async () => {
  const out = await decodeJxlInWorker(OPAQUE);
  assert.equal(out.contentType, 'image/jpeg');
  assert.deepEqual([out.data[0], out.data[1]], [0xff, 0xd8]);
  const meta = await sharp(out.data).metadata();
  assert.equal(meta.width, 48);
  assert.equal(meta.height, 32);
});

test('JXL with alpha keeps transparency as PNG', { skip: skipNoSharp }, async () => {
  const out = await decodeJxlInWorker(ALPHA);
  assert.equal(out.contentType, 'image/png');
  const meta = await sharp(out.data).metadata();
  assert.equal(meta.hasAlpha, true);
  assert.equal(meta.width, 48);
});

test('broken JXL gives null so callers fall back to the main-thread decoder', { skip: skipNoSharp }, async () => {
  assert.equal(await decodeJxlInWorker(Buffer.from('not a jxl at all')), null);
  assert.equal((await decodeJxlInWorker(OPAQUE)).contentType, 'image/jpeg', 'pool survives a bad task');
});

test('JXL_WORKERS=0 disables the pool', async () => {
  const prev = process.env.JXL_WORKERS;
  process.env.JXL_WORKERS = '0';
  try {
    assert.equal(await decodeJxlInWorker(OPAQUE), null);
  } finally {
    if (prev === undefined) delete process.env.JXL_WORKERS;
    else process.env.JXL_WORKERS = prev;
  }
});

test('sidecar merge inlines illustrations in order, skips sufficient binaries, fills stubs', { skip: skipNoSharp }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb2-merge-'));
  try {
    fs.mkdirSync(path.join(root, 'images'));
    fs.writeFileSync(
      path.join(root, 'images', 'f.fb2-1-2.zip'),
      await buildZip([
        { name: '100/0', data: OPAQUE },
        { name: '100/1', data: ALPHA },
        { name: '100/2', data: OPAQUE }
      ])
    );
    const filled = 'A'.repeat(200);
    const xml = `<?xml version="1.0" encoding="utf-8"?><FictionBook xmlns:l="http://www.w3.org/1999/xlink"><body>`
      + `<image l:href="#a"/><image l:href="#have"/><image l:href="#b"/><image l:href="#stub"/></body>`
      + `<binary id="have" content-type="image/png">${filled}</binary><binary id="stub" content-type="image/png"></binary></FictionBook>`;
    const book = { id: '1:100', libId: '100', fileName: '100', archiveName: 'f.fb2-1-2.zip' };

    const merged = await mergeSidecarBinariesIntoFb2Xml(xml, book, root);
    const blocks = [...merged.matchAll(/<binary id="([^"]+)" content-type="([^"]+)">([^<]*)<\/binary>/g)]
      .map((m) => ({ id: m[1], type: m[2], len: m[3].length }));
    const byId = Object.fromEntries(blocks.map((b) => [b.id, b]));

    assert.equal(byId.have.len, filled.length, 'sufficient binary is untouched');
    assert.equal(byId.a.type, 'image/jpeg', 'first reference gets illustration 0');
    assert.equal(byId.b.type, 'image/png', 'second reference gets illustration 1 (alpha stays PNG)');
    assert.ok(byId.stub.len > 48, 'empty stub is filled');
    assert.ok(merged.trimEnd().endsWith('</FictionBook>'));
    assert.ok(merged.indexOf('id="a"') < merged.indexOf('id="b"'), 'blocks are appended in reference order');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('merged FB2 cache stores only slow builds and shares in-flight work', async () => {
  const slow = mergedFb2CacheKey(['test', 'slow', String(Date.now())]);
  const fast = mergedFb2CacheKey(['test', 'fast', String(Date.now())]);
  storeMergedFb2(fast, Buffer.from('fast'), 10);
  storeMergedFb2(slow, Buffer.from('slow-book'), 60_000);
  let hit = null;
  for (let i = 0; i < 50 && !hit; i++) {
    hit = await readMergedFb2(slow);
    if (!hit) await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(hit?.toString(), 'slow-book');
  assert.equal(await readMergedFb2(fast), null, 'fast builds are not cached');

  let runs = 0;
  const job = () => new Promise((resolve) => setTimeout(() => { runs += 1; resolve(runs); }, 30));
  const [x, y] = await Promise.all([withMergedFb2Lock('k', job), withMergedFb2Lock('k', job)]);
  assert.equal(x, y);
  assert.equal(runs, 1);
  fs.rmSync(path.join(config.conversionCacheDir, `fb2-sidecar-${slow}.fb2`), { force: true });
});
