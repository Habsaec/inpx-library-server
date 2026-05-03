import fs from 'node:fs';

/** Максимальный размер лог-файла до ротации (50 МБ). */
const MAX_LOG_SIZE = 50 * 1024 * 1024;

/** Интервал между проверками размера (60 секунд). */
const THROTTLE_MS = 60_000;

/**
 * Время последней проверки для каждого файла.
 * Ключ — абсолютный путь, значение — Date.now() последней проверки.
 * @type {Map<string, number>}
 */
const lastCheckMap = new Map();

/**
 * Проверяет размер лог-файла и выполняет ротацию при превышении лимита.
 *
 * Схема ротации:
 *   file.log.3  — удаляется
 *   file.log.2  → file.log.3
 *   file.log.1  → file.log.2
 *   file.log    → file.log.1
 *
 * Проверка выполняется не чаще одного раза в 60 секунд для каждого файла,
 * чтобы не нагружать FS на каждой строке лога.
 *
 * @param {string} filePath — абсолютный путь к лог-файлу
 */
export function rotateIfNeeded(filePath) {
  if (!filePath) return;

  const now = Date.now();
  const lastCheck = lastCheckMap.get(filePath) || 0;
  if (now - lastCheck < THROTTLE_MS) return;
  lastCheckMap.set(filePath, now);

  try {
    const stat = fs.statSync(filePath);
    if (stat.size < MAX_LOG_SIZE) return;
  } catch {
    // Файл не существует или недоступен — ротация не нужна.
    return;
  }

  try {
    const p3 = filePath + '.3';
    const p2 = filePath + '.2';
    const p1 = filePath + '.1';

    // Удаляем самый старый архив
    try { fs.unlinkSync(p3); } catch { /* нет файла — ОК */ }
    // Сдвигаем цепочку
    try { fs.renameSync(p2, p3); } catch { /* нет файла — ОК */ }
    try { fs.renameSync(p1, p2); } catch { /* нет файла — ОК */ }
    // Текущий лог → .1
    fs.renameSync(filePath, p1);
  } catch {
    // Не удалось выполнить ротацию — продолжаем писать в текущий файл.
  }
}
