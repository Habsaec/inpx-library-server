/**
 * Worker thread: JPEG XL → JPEG (без прозрачности) или PNG (с альфой).
 * Декод через libjxl (@jsquash/jxl, сырые пиксели RGBA), кодирование — sharp.
 * В отличие от jxl-oxide-wasm не строит промежуточный PNG (это ~70% времени) и не блокирует event loop сервера.
 */
import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import decodeJxl, { init as initJxl } from '@jsquash/jxl/decode.js';

const require = createRequire(import.meta.url);
const wasmPath = path.join(path.dirname(require.resolve('@jsquash/jxl/package.json')), 'codec', 'dec', 'jxl_dec.wasm');
await initJxl(await WebAssembly.compile(fs.readFileSync(wasmPath)));

const JPEG_QUALITY = 85;

async function convert(bytes) {
  const img = await decodeJxl(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const rgba = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  let hasAlpha = false;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) {
      hasAlpha = true;
      break;
    }
  }
  const raw = { raw: { width: img.width, height: img.height, channels: 4 } };
  if (hasAlpha) {
    return { contentType: 'image/png', data: await sharp(rgba, raw).png({ compressionLevel: 6 }).toBuffer() };
  }
  return { contentType: 'image/jpeg', data: await sharp(rgba, raw).removeAlpha().jpeg({ quality: JPEG_QUALITY }).toBuffer() };
}

parentPort.postMessage({ ready: true });

parentPort.on('message', async ({ id, bytes }) => {
  try {
    const { contentType, data } = await convert(bytes);
    const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    parentPort.postMessage({ id, contentType, data: ab }, [ab]);
  } catch (err) {
    parentPort.postMessage({ id, error: String(err?.message || err) });
  }
});
