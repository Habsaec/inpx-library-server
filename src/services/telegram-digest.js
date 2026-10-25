/**
 * Weekly Telegram digest of «Новое у любимых» (Profile → Telegram → «Присылать по понедельникам…»).
 *
 * Runs in the process that polls the bot (the `dl:` buttons of book cards live in its memory).
 * Checked hourly; on Mondays from 10:00 server time each opted-in user with a linked Telegram gets
 * the books of favorite authors / series that appeared in the catalog since the previous digest
 * (first digest: the last 7 days), at most DIGEST_MAX cards plus a «more» line. Nothing new → nothing sent.
 * meta `telegram_digest_sent:<user>` = { week, since } (since = newest catalog date already covered).
 */
import { db, getMeta, setMeta } from '../db.js';
import { getFollowingNewBooks, followingCutoffDate } from '../inpx.js';
import { effectiveContentLangs } from '../user-content-langs.js';
import { t, tp } from '../i18n.js';
import { logSystemEvent } from './system-events.js';

const CHECK_INTERVAL_MS = 60 * 60_000;
const DIGEST_HOUR = 10;
const DIGEST_MAX = 10;

let timer = null;
let running = false;

/** ISO-like week key (Monday-based) for «already sent this week». */
export function digestWeekKey(date = new Date()) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function digestKey(username) {
  return `telegram_digest_sent:${username}`;
}

function readState(username) {
  try {
    const parsed = JSON.parse(String(getMeta(digestKey(username)) || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function minusDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function escapeTelegramHtml(text) {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * One pass. `force` skips the Monday/hour/week checks (tests, admin tooling).
 * `send` = { sendText(chatId, html), sendCard(chatId, bookId) } — injectable for tests.
 */
export async function runTelegramDigest({ now = new Date(), force = false, send = null } = {}) {
  if (running) return { users: 0, sent: 0 };
  if (!force && (now.getDay() !== 1 || now.getHours() < DIGEST_HOUR)) return { users: 0, sent: 0 };
  const window = followingCutoffDate();
  if (!window) return { users: 0, sent: 0 };
  running = true;
  let users = 0;
  let sent = 0;
  try {
    let sender = send;
    if (!sender) {
      const bot = await import('./telegram-bot.js');
      if (!bot.isTelegramBotRunning()) return { users: 0, sent: 0 };
      sender = {
        sendText: (chatId, html) => bot.sendText(chatId, html),
        sendCard: (chatId, bookId) => bot.sendBookCardToChat(chatId, bookId)
      };
    }
    const week = digestWeekKey(now);
    const rows = db.prepare(`
      SELECT username, telegram_id AS chatId
      FROM users
      WHERE telegram_digest = 1
        AND telegram_id IS NOT NULL AND telegram_id != ''
        AND COALESCE(blocked, 0) = 0
        AND COALESCE(telegram_bot_allowed, 1) = 1
    `).all();
    for (const row of rows) {
      const state = readState(row.username);
      if (!force && state.week === week) continue;
      const since = state.since || minusDays(window.maxDate, 7);
      const result = getFollowingNewBooks(row.username, {
        pageSize: DIGEST_MAX,
        langs: effectiveContentLangs(row.username),
        newerThan: since
      });
      // Remember the covered date even when nothing new came, so the next week starts from here.
      setMeta(digestKey(row.username), JSON.stringify({ week, since: window.maxDate }));
      if (!result.items.length) continue;
      users++;
      try {
        await sender.sendText(row.chatId, `<b>${escapeTelegramHtml(t('telegram.digest.title'))}</b>`);
        for (const book of result.items) {
          try {
            await sender.sendCard(row.chatId, book.id);
            sent++;
          } catch {
            /* one book the bot could not send — keep going */
          }
        }
        if (result.total > result.items.length) {
          await sender.sendText(row.chatId, escapeTelegramHtml(tp('telegram.digest.more', { n: result.total - result.items.length })));
        }
      } catch (err) {
        logSystemEvent('warn', 'telegram-bot', 'weekly digest failed', { user: row.username, error: err.message });
      }
    }
    if (users) logSystemEvent('info', 'telegram-bot', 'weekly digest sent', { users, books: sent });
  } finally {
    running = false;
  }
  return { users, sent };
}

export function startTelegramDigest() {
  if (timer) return;
  const tick = () => {
    runTelegramDigest().catch((err) => console.warn('[telegram-digest]', err.message));
  };
  timer = setInterval(tick, CHECK_INTERVAL_MS);
  timer.unref?.();
  setTimeout(tick, 60_000).unref?.();
}

export function stopTelegramDigest() {
  if (timer) clearInterval(timer);
  timer = null;
}
