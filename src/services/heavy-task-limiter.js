/**
 * Admission control for heavy work (book extraction / conversion): at most `max` tasks run,
 * up to `maxQueue` wait (each at most `timeoutMs`), the rest are refused at once with a
 * SERVER_BUSY error that the HTTP layer turns into 503 + Retry-After.
 */

export const SERVER_BUSY = 'SERVER_BUSY';

export function serverBusyError(message = 'Server is busy, retry later') {
  const err = new Error(message);
  err.code = SERVER_BUSY;
  return err;
}

export function isServerBusyError(err) {
  return err?.code === SERVER_BUSY;
}

function envInt(name, fallback, min, max) {
  const n = Number.parseInt(String(process.env[name] ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function createTaskLimiter({ name, max, maxQueue, timeoutMs }) {
  let active = 0;
  const queue = [];

  function grant() {
    while (active < max && queue.length) {
      const entry = queue.shift();
      clearTimeout(entry.timer);
      active++;
      entry.start();
    }
  }

  function run(task) {
    return new Promise((resolve, reject) => {
      const start = () => {
        Promise.resolve()
          .then(task)
          .finally(() => {
            active = Math.max(0, active - 1);
            grant();
          })
          .then(resolve, reject);
      };
      if (active < max) {
        active++;
        start();
        return;
      }
      if (queue.length >= maxQueue) {
        reject(serverBusyError(`${name}: queue is full`));
        return;
      }
      const entry = { start, timer: null };
      entry.timer = setTimeout(() => {
        const idx = queue.indexOf(entry);
        if (idx !== -1) queue.splice(idx, 1);
        reject(serverBusyError(`${name}: waited too long in queue`));
      }, timeoutMs);
      queue.push(entry);
    });
  }

  return {
    run,
    stats: () => ({ active, queued: queue.length, max, maxQueue })
  };
}

/*
 * Downloads, e-mail and Telegram sends all go through resolveDownload(); one book can need
 * several 7z runs (book, sidecar images, cover). Keeping this below SEVEN_Z_MAX_CONCURRENT (6)
 * leaves 7z slots for catalog covers and the reader while a download wave is queued.
 */
export const downloadLimiter = createTaskLimiter({
  name: 'downloads',
  max: envInt('DOWNLOAD_MAX_CONCURRENT', 4, 1, 64),
  maxQueue: envInt('DOWNLOAD_MAX_QUEUE', 100, 0, 10_000),
  timeoutMs: envInt('DOWNLOAD_QUEUE_TIMEOUT_MS', 120_000, 1_000, 3_600_000)
});
