/**
 * Поток-наблюдатель за одной папкой (fs.watch recursive).
 * На Linux рекурсивный fs.watch синхронно обходит всё дерево каталогов при старте — на большой
 * библиотеке это блокировало бы event loop сервера, поэтому наблюдение живёт в отдельном потоке.
 *
 * Сообщения в основной поток: { type: 'ready' } | { type: 'event' } (не чаще раза в секунду)
 * | { type: 'error', message, code }.
 * Файл же экспортирует isRelevantWatchName() — его импортирует основной поток (там побочных эффектов нет).
 */
import fs from 'node:fs';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';

const BOOK_EXTENSIONS = new Set(['fb2', 'epub', 'mobi', 'azw3', 'zip', '7z', 'pdf', 'djvu', 'cbz', 'cbr', 'txt', 'rtf', 'docx', 'opf']);
const COALESCE_MS = 1000;

const CALIBRE_DB_NAMES = new Set(['metadata.db', 'metadata.db-journal']);

/** Calibre-библиотека: каталог — только metadata.db (файлы книг и cover.jpg Calibre меняет вместе с ним). */
export function isRelevantCalibreWatchName(filename) {
  const name = String(filename ?? '').replace(/\\/g, '/').split('/').pop() || '';
  return CALIBRE_DB_NAMES.has(name.toLowerCase());
}

/** Событие интересно, если это книга/архив или каталог (имя без расширения). Временные .part/.tmp и картинки — нет. */
export function isRelevantWatchName(filename) {
  const name = String(filename ?? '').replace(/\\/g, '/').split('/').pop() || '';
  if (!name) return true;
  const dot = name.lastIndexOf('.');
  if (dot < 0) return true;
  if (dot === 0) return false;
  return BOOK_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

if (!isMainThread && parentPort) {
  let pending = false;
  const post = (message) => parentPort.postMessage(message);
  try {
    // Calibre: только корень (metadata.db), без рекурсивного обхода дерева.
    const calibre = Boolean(workerData.calibre);
    const relevant = calibre ? isRelevantCalibreWatchName : isRelevantWatchName;
    const watcher = fs.watch(workerData.path, { recursive: !calibre }, (_eventType, filename) => {
      if (!relevant(filename) || pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        post({ type: 'event' });
      }, COALESCE_MS);
    });
    watcher.on('error', (err) => post({ type: 'error', message: err.message, code: err.code || '' }));
    post({ type: 'ready' });
  } catch (err) {
    post({ type: 'error', message: err.message, code: err.code || '' });
  }
}
