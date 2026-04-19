/**
 * Таймауты для промисов без нативного AbortSignal (unzipper, старые API).
 * Таймер снимается в finally; отклонённая «гонка» не отменяет фоновую работу зависимости.
 */

export function parseEnvTimeoutMs(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function promiseWithTimeout(promise, ms, label) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label}: таймаут ${Math.round(ms / 1000)} с`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
