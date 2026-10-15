import fs from 'node:fs';

/*
 * Неблокирующая запись строк лога. `fs.appendFileSync` в логгере останавливал event loop
 * на 2–3 с (профиль: writeFileUtf8 из logSystemEvent), когда ОС/антивирус задерживали запись
 * в большой runtime.log. Строки копятся в памяти и пишутся пачкой через fs.promises.appendFile
 * (open-append-close, как раньше, чтобы ротация по rename продолжала работать).
 */

const MAX_PENDING_BYTES = 8 * 1024 * 1024;
const queues = new Map();

function getQueue(filePath) {
  let q = queues.get(filePath);
  if (!q) {
    q = { chunks: [], bytes: 0, busy: false };
    queues.set(filePath, q);
  }
  return q;
}

function takeAll(q) {
  const data = q.chunks.join('');
  q.chunks = [];
  q.bytes = 0;
  return data;
}

function flush(filePath, q) {
  const data = takeAll(q);
  if (!data) {
    q.busy = false;
    return;
  }
  fs.promises.appendFile(filePath, data, 'utf8')
    .catch(() => { /* нет места, файл занят и т.п. — лог best-effort */ })
    .finally(() => {
      if (q.chunks.length) flush(filePath, q);
      else q.busy = false;
    });
}

export function appendLineAsync(filePath, text) {
  if (!filePath || !text) return;
  const q = getQueue(filePath);
  /* Диск завис — не растим память бесконечно, теряем новые строки. */
  if (q.bytes > MAX_PENDING_BYTES) return;
  q.chunks.push(text);
  q.bytes += text.length;
  if (!q.busy) {
    q.busy = true;
    setImmediate(() => flush(filePath, q));
  }
}

/** Синхронно дописывает всё, что ещё не ушло на диск (вызывается на выходе процесса). */
export function flushAsyncLogsSync() {
  for (const [filePath, q] of queues) {
    const data = takeAll(q);
    if (!data) continue;
    try { fs.appendFileSync(filePath, data, 'utf8'); } catch { /* best-effort */ }
  }
}

process.on('exit', flushAsyncLogsSync);
