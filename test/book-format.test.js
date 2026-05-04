import { test } from 'node:test';
import assert from 'node:assert/strict';
import archiver from 'archiver';
import { Writable } from 'node:stream';
import { detectBookFormat, classifyReaderExt } from '../src/utils/book-format.js';

function buildZip(entries) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sink = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk); cb(); }
    });
    const zip = archiver('zip', { zlib: { level: 0 } });
    zip.on('error', reject);
    sink.on('finish', () => resolve(Buffer.concat(chunks)));
    zip.pipe(sink);
    for (const { name, data } of entries) {
      zip.append(data, { name });
    }
    zip.finalize();
  });
}

const PDF_BYTES = Buffer.concat([
  Buffer.from('%PDF-1.4\n', 'utf8'),
  Buffer.from('%\xe2\xe3\xcf\xd3\n', 'binary'),
  Buffer.alloc(64, 0x20)
]);

test('classifyReaderExt: pdf.zip composite ext is treated as pdf', () => {
  assert.equal(classifyReaderExt('pdf.zip'), 'pdf');
  assert.equal(classifyReaderExt('PDF.ZIP'), 'pdf');
  assert.equal(classifyReaderExt('.pdf.zip'), 'pdf');
});

test('classifyReaderExt: djvu.zip / djv.zip → djvu', () => {
  assert.equal(classifyReaderExt('djvu.zip'), 'djvu');
  assert.equal(classifyReaderExt('djv.zip'), 'djvu');
});

test('classifyReaderExt: regular formats unchanged', () => {
  assert.equal(classifyReaderExt('pdf'), 'pdf');
  assert.equal(classifyReaderExt('fb2'), 'foliate');
  assert.equal(classifyReaderExt('epub'), 'foliate');
  assert.equal(classifyReaderExt('djvu'), 'djvu');
  assert.equal(classifyReaderExt('xyz'), 'unsupported');
});

test('detectBookFormat: bare PDF buffer is recognized', async () => {
  const result = await detectBookFormat(PDF_BYTES);
  assert.equal(result.kind, 'pdf');
  assert.equal(result.contentType, 'application/pdf');
});

test('detectBookFormat: Flibusta pdf.zip with .fbd descriptor unwraps to PDF', async () => {
  const fbd = Buffer.from('<?xml version="1.0"?><fictionbook-description/>', 'utf8');
  const zip = await buildZip([
    { name: 'book.fbd', data: fbd },
    { name: 'book.pdf', data: PDF_BYTES }
  ]);
  const result = await detectBookFormat(zip, 'pdf.zip');
  assert.equal(result.kind, 'pdf');
  assert.equal(result.contentType, 'application/pdf');
  // Returned buffer must be the inner PDF (starts with %PDF-)
  assert.ok(result.buffer.slice(0, 5).toString('utf8') === '%PDF-');
});

test('detectBookFormat: zip with multiple PDFs (no fbd) stays as plain zip', async () => {
  const zip = await buildZip([
    { name: 'a.pdf', data: PDF_BYTES },
    { name: 'b.pdf', data: PDF_BYTES }
  ]);
  const result = await detectBookFormat(zip);
  // Two content entries → can't unambiguously unwrap → falls through
  assert.equal(result.kind, 'zip');
});
