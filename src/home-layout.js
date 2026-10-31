/**
 * Per-user home page layout, shared by the web UI and the Android app
 * (`/api/preferences.homeLayout`, column `users.home_layout`).
 *
 * `{ order: string[], hidden: string[], shelfOrder: string[] }`: `order` always lists every
 * known section (unknown ids dropped, missing ones inserted at their default position), `hidden`
 * the switched-off ones. Each client renders only the sections it has: `recent`
 * («Недавно читали») exists only in the app. `shelfOrder` is the user's order of all shelves
 * (`shelf:<id>` / `smart:<id>`), set by dragging them in the shelves lists: the lists follow it
 * and so do the pinned shelves on the home page. Shelves not listed (new ones) follow in the old
 * order — regular, then smart, by name.
 */
import { getUserHomeLayoutRaw, setUserHomeLayoutRaw } from './db.js';

export const HOME_SECTION_IDS = ['continue', 'recent', 'novinki', 'recommended', 'following', 'shelves'];

/** Sections the web home renders (in the shared order). */
export const WEB_HOME_SECTION_IDS = ['continue', 'novinki', 'recommended', 'following', 'shelves'];

const KNOWN = new Set(HOME_SECTION_IDS);

function parseLayoutInput(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) || {};
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' ? raw : {};
}

function idList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const id = String(item || '').trim();
    if (!KNOWN.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

const SHELF_KEY_RE = /^(shelf|smart):\d{1,12}$/;
const SHELF_ORDER_MAX = 100;

function shelfKeyList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const key = String(item || '').trim();
    if (SHELF_KEY_RE.test(key) && !out.includes(key)) out.push(key);
    if (out.length >= SHELF_ORDER_MAX) break;
  }
  return out;
}

export function homeShelfKey(shelf) {
  return `${shelf.kind === 'smart' ? 'smart' : 'shelf'}:${shelf.id}`;
}

/** @returns {{ order: string[], hidden: string[], shelfOrder: string[] }} */
export function normalizeHomeLayout(raw) {
  const input = parseLayoutInput(raw);
  const order = idList(input.order);
  // A section the client did not know about goes back to its default place.
  HOME_SECTION_IDS.forEach((id, index) => {
    if (order.includes(id)) return;
    const before = HOME_SECTION_IDS.slice(0, index).reverse().find((prev) => order.includes(prev));
    order.splice(before ? order.indexOf(before) + 1 : 0, 0, id);
  });
  return { order, hidden: idList(input.hidden), shelfOrder: shelfKeyList(input.shelfOrder) };
}

export function getUserHomeLayout(username) {
  return normalizeHomeLayout(getUserHomeLayoutRaw(username));
}

export function setUserHomeLayout(username, raw) {
  const layout = normalizeHomeLayout(raw);
  const isDefault = !layout.hidden.length && !layout.shelfOrder.length
    && layout.order.every((id, i) => id === HOME_SECTION_IDS[i]);
  setUserHomeLayoutRaw(username, isDefault ? '' : JSON.stringify(layout));
  return layout;
}

export function isHomeSectionVisible(layout, id) {
  return !layout.hidden.includes(id);
}

/**
 * Moves `id` one step up/down among `visibleIds` (the sections a client shows), so the app-only
 * `recent` keeps its place when the web reorders its own blocks.
 */
export function moveHomeSection(layout, id, direction, visibleIds = HOME_SECTION_IDS) {
  const order = layout.order.slice();
  const shown = order.filter((item) => visibleIds.includes(item));
  const pos = shown.indexOf(id);
  const target = shown[direction === 'up' ? pos - 1 : pos + 1];
  if (pos < 0 || !target) return layout;
  const a = order.indexOf(id);
  const b = order.indexOf(target);
  [order[a], order[b]] = [order[b], order[a]];
  return { ...layout, order, hidden: layout.hidden.slice() };
}

/** Shelves (`{ id, kind }`) in the user's order; unlisted ones keep their place after the listed. */
export function orderShelves(shelves, shelfOrder = []) {
  const rank = new Map(shelfOrder.map((key, i) => [key, i]));
  return shelves
    .map((shelf, i) => ({ shelf, i, r: rank.has(homeShelfKey(shelf)) ? rank.get(homeShelfKey(shelf)) : Infinity }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.shelf);
}

/** Drag-and-drop: `ids` is the new order of the `visibleIds` blocks; other ids keep their slots. */
export function reorderHomeSections(layout, ids, visibleIds = HOME_SECTION_IDS) {
  const wanted = idList(ids).filter((id) => visibleIds.includes(id));
  const slots = layout.order.filter((id) => visibleIds.includes(id));
  if (wanted.length !== slots.length || !slots.every((id) => wanted.includes(id))) return layout;
  let next = 0;
  return { ...layout, order: layout.order.map((id) => (visibleIds.includes(id) ? wanted[next++] : id)) };
}

/**
 * Drag in a shelves list: `groupKeys` is the new order of one list (all regular or all smart
 * shelves); `allKeys` is every shelf in the current order. The other kind keeps its slots, the
 * whole order is stored. Anything but a permutation of that list leaves the layout as is.
 */
export function reorderShelfGroup(layout, allKeys, groupKeys) {
  const wanted = shelfKeyList(groupKeys);
  const kind = wanted[0]?.split(':')[0];
  const slots = allKeys.filter((key) => key.split(':')[0] === kind);
  if (!kind || wanted.length !== slots.length || !slots.every((key) => wanted.includes(key))) return layout;
  let next = 0;
  return { ...layout, shelfOrder: allKeys.map((key) => (key.split(':')[0] === kind ? wanted[next++] : key)) };
}
