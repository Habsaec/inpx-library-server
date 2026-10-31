/**
 * Per-user home page layout, shared by the web UI and the Android app
 * (`/api/preferences.homeLayout`, column `users.home_layout`).
 *
 * `{ order: string[], hidden: string[] }`: `order` always lists every known section
 * (unknown ids dropped, missing ones inserted at their default position), `hidden` the
 * switched-off ones. Each client renders only the sections it has: `recent`
 * («Недавно читали») exists only in the app.
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

/** @returns {{ order: string[], hidden: string[] }} */
export function normalizeHomeLayout(raw) {
  const input = parseLayoutInput(raw);
  const order = idList(input.order);
  // A section the client did not know about goes back to its default place.
  HOME_SECTION_IDS.forEach((id, index) => {
    if (order.includes(id)) return;
    const before = HOME_SECTION_IDS.slice(0, index).reverse().find((prev) => order.includes(prev));
    order.splice(before ? order.indexOf(before) + 1 : 0, 0, id);
  });
  return { order, hidden: idList(input.hidden) };
}

export function getUserHomeLayout(username) {
  return normalizeHomeLayout(getUserHomeLayoutRaw(username));
}

export function setUserHomeLayout(username, raw) {
  const layout = normalizeHomeLayout(raw);
  const isDefault = !layout.hidden.length && layout.order.every((id, i) => id === HOME_SECTION_IDS[i]);
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
  return { order, hidden: layout.hidden.slice() };
}
