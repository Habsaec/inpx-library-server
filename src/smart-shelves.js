/**
 * Умные полки: сохранённый фильтр каталога (те же параметры, что у /catalog и /api/catalog).
 * Книги не хранятся — подбираются при открытии полки, поэтому полка «сама» пополняется после индексации.
 */
import { db } from './db.js';
import { parseGenreList, parseGenreMode, parseHasSeries, searchCatalog } from './inpx.js';

const SORTS = ['recent', 'title', 'author', 'series', 'rating'];
const NAME_MAX = 100;
const PREVIEW_COUNT = 8;

function readParams(input) {
  if (typeof input === 'string' || input instanceof URLSearchParams) {
    const params = new URLSearchParams(typeof input === 'string' ? input.replace(/^\?/, '') : input);
    return (key) => params.getAll(key);
  }
  const obj = input && typeof input === 'object' ? input : {};
  return (key) => {
    const value = obj[key];
    return (Array.isArray(value) ? value : [value]).filter((v) => v !== undefined && v !== null).map(String);
  };
}

/** Разбирает фильтр (строка запроса или объект) в нормализованный объект; пустой фильтр — ошибка. */
export function parseSmartShelfFilter(input) {
  const all = readParams(input);
  const first = (key) => all(key)[0] ?? '';
  const year = Math.floor(Number(first('year')) || 0);
  const sort = first('sort');
  const order = first('order');
  const filter = {
    q: first('q').trim().slice(0, 200),
    genre: parseGenreList(all('genre')),
    genreMode: parseGenreMode(first('genreMode')),
    lang: first('lang').trim().slice(0, 10),
    format: first('format').trim().slice(0, 20),
    year: year >= 1800 && year <= 2100 ? year : 0,
    minRate: Math.min(5, Math.max(0, Math.floor(Number(first('minRate')) || 0))),
    hasSeries: parseHasSeries(first('hasSeries')),
    sort: SORTS.includes(sort) ? sort : 'title',
    order: order === 'asc' || order === 'desc' ? order : ''
  };
  const hasFilter = filter.q || filter.genre.length || filter.lang || filter.format || filter.year
    || filter.minRate || filter.hasSeries !== null;
  if (!hasFilter) throw new Error('Фильтр умной полки пуст');
  return filter;
}

/** Стабильная строка запроса, пригодная и для `/catalog?…`. */
export function serializeSmartShelfFilter(filter) {
  const p = new URLSearchParams();
  if (filter.q) p.set('q', filter.q);
  for (const g of filter.genre) p.append('genre', g);
  if (filter.genre.length > 1 && filter.genreMode === 'and') p.set('genreMode', 'and');
  if (filter.lang) p.set('lang', filter.lang);
  if (filter.format) p.set('format', filter.format);
  if (filter.year) p.set('year', String(filter.year));
  if (filter.minRate) p.set('minRate', String(filter.minRate));
  if (filter.hasSeries === 0 || filter.hasSeries === 1) p.set('hasSeries', String(filter.hasSeries));
  p.set('sort', filter.sort);
  if (filter.order) p.set('order', filter.order);
  return p.toString();
}

function cleanName(name) {
  const trimmed = String(name || '').trim().slice(0, NAME_MAX);
  if (!trimmed) throw new Error('Название полки не указано');
  return trimmed;
}

function toShelf(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    query: row.query,
    catalogUrl: `/catalog?${row.query}`,
    createdAt: row.created_at,
    onHome: row.on_home ? 1 : 0
  };
}

/** `withPreview` — добавляет `bookCount` и `previewBookIds` (обложки, как у обычных полок); это поиск на каждую полку. */
export function listSmartShelves(username, { withPreview = false } = {}) {
  const shelves = db.prepare('SELECT * FROM smart_shelves WHERE username = ? ORDER BY name COLLATE NOCASE, id').all(username).map(toShelf);
  if (!withPreview) return shelves;
  for (const shelf of shelves) {
    try {
      const { items, total } = getSmartShelfBooks(shelf, { page: 1, pageSize: PREVIEW_COUNT });
      shelf.bookCount = total;
      shelf.previewBookIds = items.map((book) => book.id);
    } catch {
      shelf.bookCount = 0;
      shelf.previewBookIds = [];
    }
  }
  return shelves;
}

export function getSmartShelf(id, username) {
  return toShelf(db.prepare('SELECT * FROM smart_shelves WHERE id = ? AND username = ?').get(Number(id) || 0, username));
}

function assertNameFree(username, name, exceptId = 0) {
  if (db.prepare('SELECT 1 FROM smart_shelves WHERE username = ? AND name = ? AND id != ?').get(username, name, exceptId)) {
    throw new Error('Полка с таким названием уже существует');
  }
}

export function createSmartShelf(username, name, filterInput) {
  const cleanedName = cleanName(name);
  const query = serializeSmartShelfFilter(parseSmartShelfFilter(filterInput));
  assertNameFree(username, cleanedName);
  return Number(db.prepare('INSERT INTO smart_shelves(username, name, query) VALUES(?, ?, ?)').run(username, cleanedName, query).lastInsertRowid);
}

/** `name` и/или `filterInput` — что не передано, остаётся как было. Возвращает число изменённых строк. */
export function updateSmartShelf(id, username, { name, filter: filterInput } = {}) {
  const shelf = getSmartShelf(id, username);
  if (!shelf) return 0;
  const cleanedName = name === undefined ? shelf.name : cleanName(name);
  const query = filterInput === undefined ? shelf.query : serializeSmartShelfFilter(parseSmartShelfFilter(filterInput));
  assertNameFree(username, cleanedName, shelf.id);
  return db.prepare('UPDATE smart_shelves SET name = ?, query = ? WHERE id = ? AND username = ?').run(cleanedName, query, shelf.id, username).changes;
}

export function setSmartShelfOnHome(id, username, onHome) {
  return db.prepare('UPDATE smart_shelves SET on_home = ? WHERE id = ? AND username = ?').run(onHome ? 1 : 0, Number(id) || 0, username).changes;
}

export function deleteSmartShelf(id, username) {
  return db.prepare('DELETE FROM smart_shelves WHERE id = ? AND username = ?').run(Number(id) || 0, username).changes;
}

/** Страница книг полки: `{ items, total }` как у searchCatalog. */
export function getSmartShelfBooks(shelf, { page = 1, pageSize = 24 } = {}) {
  const f = parseSmartShelfFilter(shelf.query);
  return searchCatalog({
    query: f.q, field: 'books', page, pageSize, sort: f.sort, order: f.order,
    genre: f.genre.join(','), genreMode: f.genreMode, lang: f.lang, format: f.format,
    year: f.year, minRate: f.minRate, hasSeries: f.hasSeries
  });
}
