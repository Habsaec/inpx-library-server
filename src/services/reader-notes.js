/**
 * Заметки читателя: разбор фильтров (страница и API) и экспорт в Markdown / HTML.
 */
import { t, tp, getLocale } from '../i18n.js';
import { formatAuthorLabel } from '../genre-map.js';
import { READER_ANNOTATION_COLORS } from '../db.js';
import { decodeBookRef } from '../utils/book-ref.js';

export const NOTES_SORTS = ['new', 'old', 'title'];
export const NOTES_EXPORT_FORMATS = {
  md: { ext: 'md', mimeType: 'text/markdown; charset=utf-8' },
  html: { ext: 'html', mimeType: 'text/html; charset=utf-8' }
};

/** Фильтр из query/body: `book` — base64url-ссылка книги, `bookId` — исходный id. */
export function parseNotesFilter(src = {}) {
  const color = String(src.color || '');
  const sort = String(src.sort || '');
  const bookId = src.bookId ? String(src.bookId).slice(0, 600) : (decodeBookRef(String(src.book || '')) || '');
  return {
    color: READER_ANNOTATION_COLORS.includes(color) ? color : '',
    bookId,
    q: String(src.q || '').trim().slice(0, 200),
    sort: NOTES_SORTS.includes(sort) ? sort : 'new',
    group: src.group === 'color' ? 'color' : 'book'
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function colorLabel(color) {
  return READER_ANNOTATION_COLORS.includes(color) ? t(`notes.color.${color}`) : String(color || '');
}

function datePart(createdAt) {
  return String(createdAt || '').slice(0, 10);
}

function bookHeading(item) {
  const author = formatAuthorLabel(item.authors);
  return author ? `${item.bookTitle} — ${author}` : String(item.bookTitle || '');
}

/** Группы идут подряд (запрос уже отсортирован по книге или цвету). */
function groupNotes(items, group) {
  const groups = [];
  for (const item of items) {
    const key = group === 'color' ? `c:${item.color}` : `b:${item.bookId}`;
    let last = groups[groups.length - 1];
    if (!last || last.key !== key) {
      last = {
        key,
        title: group === 'color' ? colorLabel(item.color) : bookHeading(item),
        notes: []
      };
      groups.push(last);
    }
    last.notes.push(item);
  }
  return groups;
}

function noteMeta(item, group) {
  const parts = group === 'color' ? [bookHeading(item)] : [colorLabel(item.color)];
  const date = datePart(item.createdAt);
  if (date) parts.push(date);
  return parts.join(' · ');
}

function buildMarkdown(groups, group, total, date) {
  const lines = [`# ${t('notes.export.title')}`, '', `_${tp('notes.export.generated', { date, count: total })}_`, ''];
  for (const g of groups) {
    lines.push(`## ${g.title}`, '');
    for (const item of g.notes) {
      const quote = String(item.text || '').trim();
      if (quote) {
        for (const line of quote.split(/\r?\n/)) lines.push(`> ${line}`);
        lines.push('');
      }
      const note = String(item.note || '').trim();
      if (note) lines.push(note, '');
      lines.push(`*${noteMeta(item, group)}*`, '');
    }
  }
  return lines.join('\n');
}

function buildHtml(groups, group, total, date) {
  const sections = groups.map((g) => {
    const notes = g.notes.map((item) => {
      const quote = String(item.text || '').trim();
      const note = String(item.note || '').trim();
      return `<article class="note note-${escapeHtml(item.color)}">
${quote ? `<blockquote>${escapeHtml(quote).replace(/\r?\n/g, '<br>')}</blockquote>` : ''}
${note ? `<p class="note-text">${escapeHtml(note).replace(/\r?\n/g, '<br>')}</p>` : ''}
<p class="meta">${escapeHtml(noteMeta(item, group))}</p>
</article>`;
    }).join('\n');
    return `<section><h2>${escapeHtml(g.title)}</h2>\n${notes}</section>`;
  }).join('\n');
  const title = escapeHtml(t('notes.export.title'));
  return `<!doctype html>
<html lang="${getLocale() === 'ru' ? 'ru' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
body{font-family:Georgia,serif;max-width:46rem;margin:2rem auto;padding:0 1rem;line-height:1.55;color:#222}
h1{font-size:1.6rem}h2{font-size:1.2rem;margin-top:2rem;border-bottom:1px solid #ccc;padding-bottom:.25rem}
.sub,.meta{color:#777;font-size:.85rem}
blockquote{margin:1rem 0 .5rem;padding:.25rem 1rem;border-left:4px solid #e0b400}
.note-green blockquote{border-color:#3fa34d}.note-blue blockquote{border-color:#3b82d6}
.note-pink blockquote{border-color:#d6508f}.note-underline blockquote{border-color:#888}
.note-text{margin:.25rem 0}
</style>
</head>
<body>
<h1>${title}</h1>
<p class="sub">${escapeHtml(tp('notes.export.generated', { date, count: total }))}</p>
${sections}
</body>
</html>
`;
}

/** items — результат queryReaderAnnotations (уже отсортирован под group). */
export function buildNotesExport(items, { format = 'md', group = 'book', now = new Date() } = {}) {
  const spec = NOTES_EXPORT_FORMATS[format] || NOTES_EXPORT_FORMATS.md;
  const date = now.toISOString().slice(0, 10);
  const groups = groupNotes(items, group);
  const content = spec === NOTES_EXPORT_FORMATS.html
    ? buildHtml(groups, group, items.length, date)
    : buildMarkdown(groups, group, items.length, date);
  return {
    fileName: `notes-${date}.${spec.ext}`,
    mimeType: spec.mimeType,
    content
  };
}
