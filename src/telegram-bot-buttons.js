/**
 * Кнопки под сообщениями бота (приветствие /start, анонс новинок), которые админ задаёт текстом.
 * Один блок строк = один ряд кнопок, пустая строка между блоками разделяет ряды. Строка: `Текст | действие`.
 * Действие:
 *   /shelves, /favorites, /want, /following, /recommended, /help, /me — то же, что набрать команду;
 *   https://…                — внешняя ссылка;
 *   site:/library/recent     — страница этой библиотеки (нужен публичный URL сайта).
 * Модуль без зависимостей: им пользуются админка (проверка) и бот (разметка).
 */

export const BOT_BUTTON_COMMANDS = ['shelves', 'favorites', 'want', 'following', 'recommended', 'help', 'me'];

const MAX_ROWS = 8;
const MAX_PER_ROW = 3;
const MAX_TEXT = 40;

/** @returns {{ rows: Array<Array<{text:string, kind:'cmd'|'url'|'site', value:string}>>, errors: string[] }} */
export function parseBotButtons(raw) {
  const rows = [];
  const errors = [];
  let current = [];
  const flush = () => {
    if (current.length) rows.push(current);
    current = [];
  };
  const lines = String(raw ?? '').replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      flush();
      continue;
    }
    const sep = line.lastIndexOf('|');
    const text = sep > 0 ? line.slice(0, sep).trim() : '';
    const action = sep > 0 ? line.slice(sep + 1).trim() : '';
    const where = `строка ${i + 1}`;
    if (!text || !action) {
      errors.push(`${where}: нужен формат «Текст | действие»`);
      continue;
    }
    if ([...text].length > MAX_TEXT) {
      errors.push(`${where}: текст кнопки длиннее ${MAX_TEXT} символов`);
      continue;
    }
    let button = null;
    if (action.startsWith('/')) {
      const cmd = action.slice(1).toLowerCase();
      if (BOT_BUTTON_COMMANDS.includes(cmd)) button = { text, kind: 'cmd', value: cmd };
      else errors.push(`${where}: команда ${action} не поддерживается (доступны: ${BOT_BUTTON_COMMANDS.map((c) => `/${c}`).join(', ')})`);
    } else if (/^site:\/[^\s]*$/i.test(action)) {
      button = { text, kind: 'site', value: action.slice(5) };
    } else if (/^https?:\/\/[^\s]+$/i.test(action)) {
      try {
        const url = new URL(action);
        button = { text, kind: 'url', value: url.href };
      } catch {
        errors.push(`${where}: некорректная ссылка`);
      }
    } else {
      errors.push(`${where}: действие — /команда, https://ссылка или site:/страница`);
    }
    if (!button) continue;
    if (current.length >= MAX_PER_ROW) {
      errors.push(`${where}: в ряду не больше ${MAX_PER_ROW} кнопок (отделите ряд пустой строкой)`);
      continue;
    }
    current.push(button);
  }
  flush();
  if (rows.length > MAX_ROWS) errors.push(`Рядов не больше ${MAX_ROWS}`);
  return { rows: rows.slice(0, MAX_ROWS), errors };
}

/** inline_keyboard или null. Кнопки `site:` без публичного URL пропускаются. */
export function botButtonsMarkup(raw, baseUrl = '') {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const keyboard = [];
  for (const row of parseBotButtons(raw).rows) {
    const out = [];
    for (const b of row) {
      if (b.kind === 'cmd') out.push({ text: b.text, callback_data: `bc:${b.value}` });
      else if (b.kind === 'url') out.push({ text: b.text, url: b.value });
      else if (base) out.push({ text: b.text, url: base + b.value });
    }
    if (out.length) keyboard.push(out);
  }
  return keyboard.length ? { inline_keyboard: keyboard } : null;
}
