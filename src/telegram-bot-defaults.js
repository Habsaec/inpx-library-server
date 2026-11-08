/** Тексты Telegram-бота по умолчанию (профиль, /start) и структура меню команд. */

/** Секции меню «/» — порядок секций и команд сохраняется в Telegram. */
export const BOT_MENU_SECTIONS = [
  {
    title: 'Основное',
    commands: [
      { command: 'start', description: 'Приветствие' },
      { command: 'help', description: 'Справка по командам' },
    ],
  },
  {
    title: 'Поиск',
    commands: [
      { command: 'search', description: 'Поиск книг', example: 'Толстой война мир' },
      { command: 'author', description: 'Поиск автора', example: 'Кораблев' },
      { command: 'series', description: 'Поиск серии', example: 'другая сторона' },
    ],
  },
  {
    title: 'Личное',
    hint: 'нужна привязка на сайте',
    commands: [
      { command: 'shelves', description: 'Мои полки' },
      { command: 'favorites', description: 'Избранное: книги, авторы, серии' },
      { command: 'want', description: 'Хочу прочитать' },
      { command: 'following', description: 'Новое у любимых авторов и серий' },
      { command: 'recommended', description: 'Рекомендации' },
    ],
  },
  {
    title: 'Аккаунт',
    commands: [
      { command: 'me', description: 'Статус привязки' },
      { command: 'unlink', description: 'Отвязать Telegram' },
    ],
  },
];

export function flattenBotMenuCommands() {
  return BOT_MENU_SECTIONS.flatMap((section) => section.commands.map(({ command, description }) => ({
    command,
    description,
  })));
}

export function buildBotProfileDescription() {
  const parts = BOT_MENU_SECTIONS.map((section) => {
    const lines = section.commands.map(({ command, description }) => `/${command} - ${description}`);
    return `${section.title}:\n${lines.join('\n')}`;
  });
  return parts.join('\n\n').slice(0, 512);
}

export const TELEGRAM_DEFAULT_PROFILE_DESCRIPTION = buildBotProfileDescription();

export const TELEGRAM_DEFAULT_PROFILE_SHORT =
  'Книжный бот: поиск, скачивание, полки и рекомендации';

export const TELEGRAM_DEFAULT_WELCOME =
  '📚 <b>Библиотека книг</b>\n\n' +
  'Напишите запрос — откроются разделы Книги / Авторы / Серии.\n\n' +
  '<b>Поиск:</b> просто текст · /search · /author · /series\n' +
  '<b>Личное:</b> /shelves · /favorites · /want · /following · /recommended <i>(после привязки)</i>\n\n' +
  '/help — полная справка';

/** Анонс в чаты после индексации, если появились новые книги. Плейсхолдеры: {{count}}, {{url}}, {{link}} */
export const TELEGRAM_DEFAULT_NEW_BOOKS_ANNOUNCE =
  '📚 В нашей библиотеке появилось <b>{{count}}</b> новых книг.\n\n' +
  'Ознакомиться с ними вы сможете в разделе «Новинки» нашей библиотеки.\n\n' +
  '{{link}}';

/**
 * @param {string} template
 * @param {number} count
 * @param {string} baseUrl — публичный URL сайта без завершающего /
 * @param {(s: string) => string} [escapeHtml]
 */
export function renderNewBooksAnnounceMessage(template, count, baseUrl = '', escapeHtml = (s) => String(s ?? '')) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const root = String(baseUrl || '').trim().replace(/\/+$/, '');
  const url = root ? `${root}/library/recent` : '';
  const link = url
    ? `<a href="${escapeHtml(url)}">Открыть раздел «Новинки»</a>`
    : '';
  let text = String(template || TELEGRAM_DEFAULT_NEW_BOOKS_ANNOUNCE);
  // Частая ошибка в админке: вместо {{url}} вставляют {{https://site/...}}
  text = text.replace(/\{\{(https?:\/\/[^}]+)\}\}/gi, (_, rawUrl) => escapeHtml(rawUrl.trim()));
  text = text.replace(/\{\{count\}\}/g, String(n));
  text = text.replace(/\{\{url\}\}/g, escapeHtml(url));
  text = text.replace(/\{\{link\}\}/g, link);
  return text;
}

/** Предупреждает о неизвестных плейсхолдерах в шаблоне анонса. */
export function validateNewBooksAnnounceTemplate(template = '') {
  const text = String(template || '').trim();
  if (!text) return { ok: true, warnings: [] };
  const warnings = [];
  const unknown = text.match(/\{\{(?!count\}\}|url\}\}|link\}\})[^}]+\}\}/gi) || [];
  for (const token of unknown) {
    if (/^\{\{https?:\/\//i.test(token)) {
      warnings.push(`Используйте {{url}} или {{link}} вместо ${token}`);
    } else {
      warnings.push(`Неизвестный плейсхолдер: ${token}`);
    }
  }
  return { ok: warnings.length === 0, warnings };
}

/** Кнопки под приветствием /start по умолчанию (формат — src/telegram-bot-buttons.js). */
export const TELEGRAM_DEFAULT_WELCOME_BUTTONS =
  '📚 Полки | /shelves\n' +
  '⭐ Избранное | /favorites\n' +
  '📖 Хочу прочитать | /want\n\n' +
  '🔥 Новое у любимых | /following\n' +
  '✨ Рекомендации | /recommended';

/** Кнопки под анонсом новинок по умолчанию. */
export const TELEGRAM_DEFAULT_ANNOUNCE_BUTTONS = '🆕 Открыть новинки | site:/library/recent';
