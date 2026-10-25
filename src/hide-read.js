import { getUserHideRead } from './db.js';

/**
 * Username whose read books leave the list, or '' to show everything.
 * `?hideRead=1|0` overrides the saved account switch (Android passes nothing and gets the saved one).
 */
export function resolveHideReadUser(req) {
  const username = String(req?.user?.username || '').trim();
  if (!username) return '';
  const raw = String(req?.query?.hideRead ?? '').trim().toLowerCase();
  if (raw === '1' || raw === 'true') return username;
  if (raw === '0' || raw === 'false') return '';
  return getUserHideRead(username) ? username : '';
}
