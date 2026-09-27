/**
 * Telegram-бот для поиска и скачивания книг из библиотеки.
 * Long polling по умолчанию; при TELEGRAM_WEBHOOK_URL — webhook.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import cluster from 'node:cluster';
import { config } from '../config.js';
import { getSharp } from './sharp-loader.js';
import { getMeta, setMeta, resolveTelegramRuntimeConfig, getTelegramSettings, getUserByTelegramId, completeTelegramLink, unlinkTelegramByTelegramId, getUserShelves, getShelfBooks, getShelfById, isTelegramBotAllowedForUser, registerTelegramChat, removeTelegramChat, listTelegramAnnounceChats, getPublicBaseUrlSetting, syncTelegramChatsFromLinkedUsers } from '../db.js';
import {
  searchCatalog,
  searchOverview,
  getBookById,
  getBooksByFacet,
  getAuthorBooksGrouped,
  getFavoriteAuthorsLight,
  getFavoriteSeriesLight,
  findDidYouMeanSuggestions,
} from '../inpx.js';
import { getRecommendedLibraryView } from './recommendations.js';
import { resolveDownload } from '../conversion.js';
import { getDetailsFull, resolveBestCoverDetails } from '../routes/library.js';
import {
  getCachedCoverThumb,
  setCachedCoverThumb,
  getDiskCachedCoverThumb,
  setDiskCachedCoverThumb,
  normalizeBookImageForClient,
} from './cover.js';
import { logSystemEvent } from './system-events.js';
import {
  BOT_MENU_SECTIONS,
  flattenBotMenuCommands,
  TELEGRAM_DEFAULT_PROFILE_DESCRIPTION,
  TELEGRAM_DEFAULT_PROFILE_SHORT,
  TELEGRAM_DEFAULT_WELCOME,
  TELEGRAM_DEFAULT_NEW_BOOKS_ANNOUNCE,
  renderNewBooksAnnounceMessage,
} from '../telegram-bot-defaults.js';

const TG_API = 'https://api.telegram.org';
const POLL_TIMEOUT_SEC = 30;
/** Книг/элементов на страницу (Telegram: каждая книга — отдельное сообщение). */
const PAGE_SIZE = 10;
/** Рекомендации в TG — короткая подборка, не весь кеш (до 72 на сайте). */
const TG_RECOMMENDED_PAGE_SIZE = 5;
const TG_RECOMMENDED_MAX_ITEMS = 10;
/** Лимит Telegram Bot API для sendDocument */
const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Лимит подписи к фото в Telegram */
const TG_CAPTION_MAX = 1024;
/** Путь к логотипу сайта (Админка → Внешний вид) */
const SITE_LOGO_PATH = path.join(config.dataDir, 'ui', 'logo.png');
const TG_PROFILE_PHOTO_HASH_META = 'telegram_bot_profile_photo_hash';
/** Макс. длина аннотации в карточке */
const ANNOTATION_MAX = 600;
/** Параллельное извлечение обложек/аннотаций (не грузить архивы) */
const PRESENTATION_CONCURRENCY = 2;
/** Мин. интервал между вызовами Telegram API */
const TG_MIN_INTERVAL_MS = 40;
/** TTL сессий чата (состояние, стек навигации, id сообщений) */
const CHAT_SESSION_TTL_MS = 2 * 60 * 60_000;
/** TTL кэшей callback-ключей */
const CALLBACK_CACHE_TTL_MS = 12 * 60 * 60_000;

/** @typedef {{ navStack: object[], messages: { headerId?: number, cardIds: number[], footerId?: number, progressId?: number }, state: object|null, ts: number }} ChatSession */

class TtlMap {
  constructor(ttlMs, maxEntries = 5000) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    /** @type {Map<string|number, { value: unknown, expiresAt: number }>} */
    this.map = new Map();
  }

  set(key, value) {
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    entry.expiresAt = Date.now() + this.ttlMs;
    return entry.value;
  }

  delete(key) {
    this.map.delete(key);
  }

  prune() {
    const now = Date.now();
    for (const [key, entry] of this.map) {
      if (now > entry.expiresAt) this.map.delete(key);
    }
  }
}

const _chatSessions = new TtlMap(CHAT_SESSION_TTL_MS, 2000);
const _dlCache = new TtlMap(CALLBACK_CACHE_TTL_MS, 10000);
const _facetCache = new TtlMap(CALLBACK_CACHE_TTL_MS, 10000);
const _authorGroupedCache = new TtlMap(CALLBACK_CACHE_TTL_MS, 500);
let _dlSeq = 0;

let _token = '';
/** null = все пользователи разрешены; Set<string> = конкретные Telegram user ID */
let _allowedUsers = null;
/** @type {'open'|'linked_only'|'whitelist_or_linked'} */
let _accessMode = 'whitelist_or_linked';
let _offset = 0;
let _abortCtrl = null;
/** @type {'polling'|'webhook'} */
let _transportMode = 'polling';
let _webhookSecret = '';
/** Поколение polling-цикла: инкремент останавливает предыдущий цикл без гонок. */
let _generation = 0;
let _loopPromise = null;
let _running = false;
let _lastAppliedRestartAt = '';
let _configWatchTimer = null;
let _cachePruneTimer = null;
let _lastTgCallAt = 0;
let _lastTgConflictLogAt = 0;

/** Прерывает текущий long poll, чтобы sendMessage не ждал до 30 с в очереди Telegram. */
async function releaseTelegramPollingSlot() {
  if (_transportMode !== 'polling' || !_running) return;
  try {
    _abortCtrl?.abort();
  } catch { /* ignore */ }
  await sleep(80);
}

/** Long polling + запас; если heartbeat старше — считаем бот остановленным. */
const CLUSTER_HEARTBEAT_STALE_MS = (POLL_TIMEOUT_SEC + 15) * 1000;
const CONFIG_WATCH_INTERVAL_MS = 5_000;

/** В cluster-режиме long polling допустим только в одном воркере (id === 1). */
export function shouldRunTelegramBotInThisProcess() {
  return !cluster.isWorker || cluster.worker.id === 1;
}

function setClusterTelegramState() {
  setMeta('telegram_bot_active', '1');
  setMeta('telegram_bot_pid', String(process.pid));
  setMeta('telegram_bot_heartbeat', new Date().toISOString());
}

function clearClusterTelegramState() {
  setMeta('telegram_bot_active', '');
  setMeta('telegram_bot_pid', '');
  setMeta('telegram_bot_heartbeat', '');
}

function touchClusterHeartbeat() {
  if (_running) {
    setMeta('telegram_bot_heartbeat', new Date().toISOString());
  }
}

function isClusterTelegramBotActive() {
  if (getMeta('telegram_bot_active') !== '1') return false;
  const hb = getMeta('telegram_bot_heartbeat');
  if (!hb) return false;
  return Date.now() - new Date(hb).getTime() <= CLUSTER_HEARTBEAT_STALE_MS;
}

// ─── Telegram Bot API ─────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function resolveWebhookUrl() {
  if (config.telegramWebhookUrl) return config.telegramWebhookUrl;
  if (config.telegramWebhookBase) {
    const pathPart = config.telegramWebhookPath.startsWith('/')
      ? config.telegramWebhookPath
      : `/${config.telegramWebhookPath}`;
    return `${config.telegramWebhookBase}${pathPart}`;
  }
  return '';
}

/** @returns {ChatSession} */
function getChatSession(chatId) {
  let session = _chatSessions.get(chatId);
  if (!session) {
    session = { navStack: [], messages: { cardIds: [] }, state: null, ts: Date.now() };
    _chatSessions.set(chatId, session);
  }
  session.ts = Date.now();
  if (!session.messages) session.messages = { cardIds: [] };
  if (!session.navStack) session.navStack = [];
  return session;
}

function getSearchState(chatId) {
  return getChatSession(chatId).state;
}

function setSearchState(chatId, state) {
  getChatSession(chatId).state = state;
}

function resetNavForNewSearch(chatId) {
  const session = getChatSession(chatId);
  session.navStack = [];
}

function pushNavSnapshot(chatId) {
  const session = getChatSession(chatId);
  const state = session.state;
  if (!state) return;
  session.navStack.push({ ...state });
  if (session.navStack.length > 10) session.navStack.shift();
}

function popNavSnapshot(chatId) {
  const session = getChatSession(chatId);
  return session.navStack.pop() || null;
}

function canNavigateBack(chatId) {
  return getChatSession(chatId).navStack.length > 0;
}

async function clearListMessages(chatId) {
  const session = getChatSession(chatId);
  const ids = [
    session.messages.headerId,
    ...session.messages.cardIds,
    session.messages.footerId,
    session.messages.progressId,
  ].filter(Boolean);
  session.messages = { cardIds: [] };
  for (const messageId of ids) {
    await deleteMessage(chatId, messageId);
  }
}

async function tgCall(method, body, { multipart = false } = {}) {
  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const waitMs = _lastTgCallAt + TG_MIN_INTERVAL_MS - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    _lastTgCallAt = Date.now();

    let res;
    if (multipart) {
      res = await fetch(`${TG_API}/bot${_token}/${method}`, { method: 'POST', body });
    } else {
      res = await fetch(`${TG_API}/bot${_token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
    const data = await res.json();
    if (data.ok) return data;
    if (data.error_code === 429) {
      const retrySec = Number(data.parameters?.retry_after) || 1;
      logSystemEvent('warn', 'telegram-bot', 'rate limit', { method, retry_after: retrySec });
      await sleep(retrySec * 1000);
      continue;
    }
    return data;
  }
  return { ok: false, description: 'too many retries' };
}

async function tgPost(method, body) {
  return tgCall(method, body);
}

function sendText(chatId, text, extra = {}) {
  return tgCall('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
}

function editMessageText(chatId, messageId, text, extra = {}) {
  return tgCall('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    ...extra,
  }).catch(() => ({}));
}

function deleteMessage(chatId, messageId) {
  return tgCall('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => ({}));
}

function answerCb(cbId, text = '') {
  return tgCall('answerCallbackQuery', { callback_query_id: cbId, text }).catch(() => ({}));
}

async function sendDoc(chatId, buffer, filename, caption) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption.slice(0, 1024));
  form.append('document', new Blob([buffer]), filename);
  return tgCall('sendDocument', form, { multipart: true });
}

async function sendPhoto(chatId, buffer, contentType, caption, replyMarkup) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) {
    form.append('caption', caption.slice(0, TG_CAPTION_MAX));
    form.append('parse_mode', 'HTML');
  }
  if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
  const ext = contentType?.includes('png') ? 'cover.png' : 'cover.jpg';
  form.append('photo', new Blob([buffer], { type: contentType || 'image/jpeg' }), ext);
  return tgCall('sendPhoto', form, { multipart: true });
}

async function updateProgress(chatId, session, text) {
  if (session.messages.progressId) {
    await editMessageText(chatId, session.messages.progressId, text);
    return;
  }
  const res = await sendText(chatId, text);
  if (res?.ok) session.messages.progressId = res.result.message_id;
}

async function registerBotCommands() {
  await tgCall('setMyCommands', { commands: flattenBotMenuCommands() });
}

function buildBotHelpMessage() {
  const lines = [
    '🔍 <b>Как пользоваться</b>',
    '',
    '<b>Просто напишите запрос</b> — сначала счётчики: Книги / Авторы / Серии.',
    'Откройте раздел кнопкой — полный список, как на сайте.',
    '',
    'У автора сначала показываются <b>серии</b>, затем книги серии по номерам.',
    'Каждая книга — карточка с <b>обложкой</b> и <b>аннотацией</b> (если есть).',
    'Кнопки 📥 — сразу под каждой книгой. ◀ ▶ — страницы, ⬅️ — назад.',
    '',
  ];

  const sectionEmoji = { Поиск: '📚', Личное: '👤', Аккаунт: '⚙️' };
  for (const section of BOT_MENU_SECTIONS) {
    if (section.title === 'Основное') continue;
    const emoji = sectionEmoji[section.title] || '•';
    const suffix = section.hint ? ` (${section.hint})` : '';
    lines.push(`${emoji} <b>${section.title}${suffix}:</b>`);
    for (const { command, description, example } of section.commands) {
      if (example) {
        lines.push(`<code>/${command} ${esc(example)}</code> — ${description}`);
      } else {
        lines.push(`<code>/${command}</code> — ${description}`);
      }
    }
    lines.push('');
  }

  lines.push('📥 Кнопки формата под книгой — скачать файл.');
  return lines.join('\n');
}

/** Описание в профиле бота (экран «Начать» до первого сообщения). */
async function registerBotProfile() {
  const tg = getTelegramSettings();
  const description = String(tg.profileDescription || '').trim() || TELEGRAM_DEFAULT_PROFILE_DESCRIPTION;
  const shortDescription = String(tg.profileShortDescription || '').trim() || TELEGRAM_DEFAULT_PROFILE_SHORT;
  await tgCall('setMyDescription', { description: description.slice(0, 512) });
  await tgCall('setMyShortDescription', { short_description: shortDescription.slice(0, 120) });
  await syncTelegramBotProfilePhoto().catch((err) => {
    logSystemEvent('warn', 'telegram-bot', 'не удалось синхронизировать аватар бота', { error: err.message });
  });
}

function siteLogoSha256() {
  try {
    if (!fsSync.existsSync(SITE_LOGO_PATH)) return '';
    return crypto.createHash('sha256').update(fsSync.readFileSync(SITE_LOGO_PATH)).digest('hex');
  } catch {
    return '';
  }
}

async function prepareSiteLogoProfilePhoto() {
  if (!fsSync.existsSync(SITE_LOGO_PATH)) return null;
  const raw = fsSync.readFileSync(SITE_LOGO_PATH);
  if (!raw?.length) return null;
  return sharp(raw, { failOn: 'error' })
    .rotate()
    .resize(640, 640, { fit: 'cover' })
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function callTelegramMultipart(token, method, form) {
  const res = await fetch(`${TG_API}/bot${token}/${method}`, { method: 'POST', body: form });
  return res.json();
}

async function setBotProfilePhotoWithToken(token, buffer) {
  const form = new FormData();
  form.append('photo', JSON.stringify({ type: 'static', photo: 'attach://bot-logo' }));
  form.append('bot-logo', new Blob([buffer], { type: 'image/jpeg' }), 'bot-logo.jpg');
  return callTelegramMultipart(token, 'setMyProfilePhoto', form);
}

async function removeBotProfilePhotoWithToken(token) {
  const res = await fetch(`${TG_API}/bot${token}/removeMyProfilePhoto`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  return res.json();
}

/**
 * Ставит аватар бота из логотипа сайта (data/ui/logo.png).
 * @param {{ force?: boolean, token?: string }} options
 */
export async function syncTelegramBotProfilePhoto({ force = false, token: tokenOverride = '' } = {}) {
  const token = String(tokenOverride || _token || resolveTelegramRuntimeConfig().token || '').trim();
  if (!token) return { skipped: true, reason: 'no_token' };

  const hash = siteLogoSha256();
  if (!hash) {
    if (getMeta(TG_PROFILE_PHOTO_HASH_META)) {
      await removeBotProfilePhotoWithToken(token).catch(() => ({}));
      setMeta(TG_PROFILE_PHOTO_HASH_META, '');
    }
    return { skipped: true, reason: 'no_logo' };
  }
  if (!force && getMeta(TG_PROFILE_PHOTO_HASH_META) === hash) {
    return { skipped: true, reason: 'unchanged' };
  }

  const buffer = await prepareSiteLogoProfilePhoto();
  if (!buffer) return { skipped: true, reason: 'no_logo' };

  await releaseTelegramPollingSlot();
  const result = await setBotProfilePhotoWithToken(token, buffer);
  if (!result?.ok) {
    const description = String(result?.description || 'unknown');
    logSystemEvent('warn', 'telegram-bot', 'не удалось обновить аватар бота', { description });
    return { ok: false, error: description };
  }
  setMeta(TG_PROFILE_PHOTO_HASH_META, hash);
  logSystemEvent('info', 'telegram-bot', 'аватар бота обновлён из логотипа сайта');
  return { ok: true };
}

async function fetchUpdates(signal) {
  const params = new URLSearchParams({
    offset: String(_offset),
    timeout: String(POLL_TIMEOUT_SEC),
    allowed_updates: JSON.stringify(['message', 'callback_query', 'my_chat_member']),
  });
  const res = await fetch(`${TG_API}/bot${_token}/getUpdates?${params}`, { signal });
  const data = await res.json();
  if (!data.ok) {
    const isConflict = data.error_code === 409;
    if (isConflict) {
      const now = Date.now();
      if (now - _lastTgConflictLogAt > 60_000) {
        _lastTgConflictLogAt = now;
        logSystemEvent('warn', 'telegram-bot', 'getUpdates конфликт: другой экземпляр бота уже опрашивает Telegram', {
          description: data.description || 'conflict',
          error_code: data.error_code,
        });
      }
      await sleep(5_000);
      return [];
    }
    logSystemEvent('warn', 'telegram-bot', 'getUpdates ошибка', {
      description: data.description || 'unknown',
      error_code: data.error_code,
    });
    return [];
  }
  touchClusterHeartbeat();
  return data.result ?? [];
}

// ─── Утилиты ─────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function touchTelegramChat(chat) {
  if (!chat?.id) return;
  const title = chat.title
    || [chat.first_name, chat.last_name].filter(Boolean).join(' ')
    || chat.username
    || '';
  registerTelegramChat({
    chatId: String(chat.id),
    chatType: chat.type || 'private',
    title,
  });
}

function resolveAnnounceBaseUrl() {
  const fromSetting = getPublicBaseUrlSetting() || String(config.publicBaseUrl || '').trim().replace(/\/+$/, '');
  if (fromSetting) return fromSetting;
  const tmpl = String(getTelegramSettings().newBooksAnnounceTemplate || '');
  const embedded = tmpl.match(/\{\{(https?:\/\/[^}\s]+)\}\}/i);
  if (embedded?.[1]) {
    return embedded[1].replace(/\/library\/recent\/?$/i, '').replace(/\/+$/, '');
  }
  return '';
}

function resolveNewBooksAnnounceTemplate() {
  const tg = getTelegramSettings();
  return String(tg.newBooksAnnounceTemplate || '').trim() || TELEGRAM_DEFAULT_NEW_BOOKS_ANNOUNCE;
}

export function buildNewBooksAnnounceMessage(count) {
  return renderNewBooksAnnounceMessage(resolveNewBooksAnnounceTemplate(), count, resolveAnnounceBaseUrl(), esc);
}

function isTelegramChatGoneError(description = '') {
  const text = String(description).toLowerCase();
  return text.includes('chat not found')
    || text.includes('bot was blocked')
    || text.includes('user is deactivated')
    || text.includes('group chat was deactivated')
    || text.includes('bot was kicked');
}

async function sendTelegramHtmlWithToken(token, chatId, text) {
  const res = await fetch(`${TG_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    }),
  });
  return res.json();
}

async function dispatchNewBooksAnnounce({ count, template = '', test = false, token: tokenOverride = '' } = {}) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n <= 0) return { sent: 0, skipped: true, reason: 'empty' };

  const tg = getTelegramSettings();
  if (!test && (!tg.enabled || !tg.newBooksAnnounceEnabled)) {
    return { sent: 0, skipped: true, reason: 'disabled' };
  }

  const token = String(tokenOverride || resolveTelegramRuntimeConfig().token || '').trim();
  if (!token) {
    return { sent: 0, skipped: true, reason: 'no_token' };
  }

  syncTelegramChatsFromLinkedUsers();
  const chats = listTelegramAnnounceChats();
  if (!chats.length) {
    return { sent: 0, skipped: true, reason: 'no_chats' };
  }

  const tmpl = String(template || '').trim() || resolveNewBooksAnnounceTemplate();
  const text = renderNewBooksAnnounceMessage(tmpl, n, resolveAnnounceBaseUrl(), esc);
  await releaseTelegramPollingSlot();
  let sent = 0;
  const errors = [];
  for (let i = 0; i < chats.length; i++) {
    const chat = chats[i];
    try {
      const result = await sendTelegramHtmlWithToken(token, chat.chatId, text);
      if (result?.ok) {
        sent += 1;
      } else {
        const description = String(result?.description || 'unknown Telegram API error');
        errors.push({ chatId: chat.chatId, description });
        logSystemEvent('warn', 'telegram-bot', 'анонс новинок не доставлен в чат', {
          chatId: chat.chatId,
          description,
          test,
        });
        if (isTelegramChatGoneError(description)) {
          removeTelegramChat(chat.chatId);
        }
      }
    } catch (err) {
      errors.push({ chatId: chat.chatId, description: err.message });
      logSystemEvent('warn', 'telegram-bot', 'ошибка анонса новинок в чат', {
        chatId: chat.chatId,
        error: err.message,
        test,
      });
    }
    if (i + 1 < chats.length) {
      await sleep(TG_MIN_INTERVAL_MS);
    }
  }

  if (sent > 0) {
    logSystemEvent('info', 'telegram-bot', test ? 'тестовый анонс новинок отправлен' : 'анонс новинок отправлен', {
      count: n,
      chats: sent,
    });
  }
  return { sent, totalChats: chats.length, skipped: false, errors };
}

/**
 * Рассылает анонс о новых книгах во все зарегистрированные чаты (если включено в настройках).
 * @param {number} count
 */
export async function announceNewBooksInTelegram(count) {
  return dispatchNewBooksAnnounce({ count, test: false });
}

/**
 * Тестовая рассылка анонса (без проверки «включён анонс»; шаблон можно передать из формы).
 * @param {{ count?: number, template?: string }} params
 */
export async function testAnnounceNewBooksInTelegram({ count = 3, template = '', token = '' } = {}) {
  const n = Math.max(1, Math.min(99_999, Math.floor(Number(count) || 3)));
  return dispatchNewBooksAnnounce({ count: n, template, test: true, token });
}

function isAllowed(userId) {
  const id = String(userId ?? '');
  if (!id) return false;

  const linkedUser = getUserByTelegramId(id);
  if (linkedUser) return isTelegramBotAllowedForUser(linkedUser);

  if (_accessMode === 'open') return true;
  if (_accessMode === 'linked_only') return false;

  // whitelist_or_linked: пустый whitelist = без ограничения для непривязанных
  return !_allowedUsers || _allowedUsers.size === 0 || _allowedUsers.has(id);
}

function parseStartLinkToken(text) {
  const trimmed = String(text || '').trim();
  if (trimmed === '/start') return null;
  if (!trimmed.startsWith('/start ')) return null;
  const payload = trimmed.slice('/start '.length).trim();
  if (!payload.startsWith('link_')) return null;
  return payload.slice('link_'.length);
}

function resolveLinkedUser(userId) {
  const user = getUserByTelegramId(userId);
  return isTelegramBotAllowedForUser(user) ? user : null;
}

function telegramAccessDeniedMessage(userId) {
  const user = getUserByTelegramId(userId);
  if (user && !user.blocked && !Number(user.telegramBotAllowed ?? 1)) {
    return '⛔ Доступ к боту для вашего аккаунта отключён администратором.';
  }
  return '⛔ У вас нет доступа к этому боту.';
}

async function handleTelegramLink(chatId, telegramUserId, token) {
  try {
    const result = completeTelegramLink(token, telegramUserId);
    await sendText(
      chatId,
      `✅ <b>Аккаунт привязан</b>\n\n` +
        `Вы вошли как <b>${esc(result.username)}</b>.\n` +
        `Доступны: <code>/shelves</code> · <code>/favorites</code> · <code>/recommended</code>\n\n` +
        `Справка: <code>/help</code> · Статус: <code>/me</code>`,
    );
    logSystemEvent('info', 'telegram-bot', 'telegram account linked', {
      username: result.username,
      telegramId: result.telegramId,
    });
  } catch (err) {
    const msg = String(err.message || '');
    let userMsg = '⚠️ Не удалось привязать аккаунт. Ссылка устарела или недействительна.';
    if (msg.includes('already linked')) {
      userMsg = '⚠️ Этот Telegram уже привязан к другому аккаунту библиотеки.';
    } else if (msg.includes('different Telegram')) {
      userMsg = '⚠️ У аккаунта библиотеки уже привязан другой Telegram.';
    } else if (msg.includes('blocked')) {
      userMsg = '⛔ Аккаунт библиотеки заблокирован.';
    } else if (msg.includes('access denied')) {
      userMsg = '⛔ Доступ к Telegram-боту для вашего аккаунта отключён администратором.';
    }
    await sendText(chatId, userMsg);
  }
}

async function handleTelegramMe(chatId, telegramUserId) {
  const linked = resolveLinkedUser(telegramUserId);
  if (!linked) {
    await sendText(
      chatId,
      'ℹ️ Telegram не привязан к аккаунту библиотеки.\n\n' +
        'Привяжите в профиле на сайте: Настройки → Telegram.',
    );
    return;
  }
  await sendText(
    chatId,
    `👤 <b>${esc(linked.username)}</b>\n` +
      `Telegram ID: <code>${esc(linked.telegramId)}</code>\n` +
      (linked.telegramLinkedAt ? `Привязан: ${esc(linked.telegramLinkedAt)}\n` : '') +
      '\n<b>Ваше на сайте:</b>\n' +
      '<code>/shelves</code> — полки\n' +
      '<code>/favorites</code> — избранное\n' +
      '<code>/recommended</code> — рекомендации\n\n' +
      'Отвязать: <code>/unlink</code>',
  );
}

async function handleTelegramUnlink(chatId, telegramUserId) {
  const linked = resolveLinkedUser(telegramUserId);
  if (!linked) {
    await sendText(chatId, 'ℹ️ Telegram не привязан к аккаунту библиотеки.');
    return;
  }
  unlinkTelegramByTelegramId(telegramUserId);
  logSystemEvent('info', 'telegram-bot', 'telegram account unlinked', {
    username: linked.username,
    telegramId: linked.telegramId,
  });
  await sendText(chatId, `✅ Аккаунт <b>${esc(linked.username)}</b> отвязан от Telegram.`);
}

/**
 * Регистрирует пару (bookId, format) и возвращает короткий числовой ключ.
 * Ключ автоматически удаляется через 12 часов.
 */
function regDlKey(bookId, format) {
  _dlSeq = (_dlSeq + 1) % 99999;
  const key = String(_dlSeq);
  _dlCache.set(key, { bookId, format });
  return key;
}

/** Регистрирует навигационный ключ (автор, серия, …) для callback_data fa:ключ. */
function regNavKey(entry) {
  _dlSeq = (_dlSeq + 1) % 99999;
  const key = String(_dlSeq);
  _facetCache.set(key, entry);
  return key;
}

function cacheAuthorGrouped(authorName, grouped) {
  _authorGroupedCache.set(authorName, grouped);
}

function getCachedAuthorGrouped(authorName) {
  return _authorGroupedCache.get(authorName);
}

function loadAuthorGrouped(authorName) {
  let grouped = getCachedAuthorGrouped(authorName);
  if (!grouped) {
    grouped = getAuthorBooksGrouped(authorName, 'series');
    cacheAuthorGrouped(authorName, grouped);
  }
  return grouped;
}

/** Элементы обзора автора: серии + блок «без серии». */
function buildAuthorOverviewItems(grouped) {
  const items = grouped.series.map((s) => ({
    type: 'series',
    name: s.name,
    displayName: s.displayName || s.name,
    bookCount: s.bookCount,
  }));
  if (grouped.standaloneBooks?.length) {
    items.push({ type: 'standalone', bookCount: grouped.standaloneBooks.length });
  }
  return items;
}

function resolveWelcomeMessage() {
  const custom = String(getTelegramSettings().welcomeMessage || '').trim();
  return custom || TELEGRAM_DEFAULT_WELCOME;
}

function parsePersonalCommand(text) {
  const cmd = String(text || '').trim().split(/\s+/)[0]?.replace(/@\w+$/, '').toLowerCase() || '';
  if (['/shelves', '/полки', '/shelf', '/полка'].includes(cmd)) return { kind: 'shelves' };
  if (['/favorites', '/favourites', '/избранное', '/favorite'].includes(cmd)) return { kind: 'favorites' };
  if (['/recommended', '/recommendations', '/рекомендации', '/recs'].includes(cmd)) return { kind: 'recommended' };
  return null;
}

function parseUserQuery(text) {
  const trimmed = text.trim();
  const rules = [
    { re: /^\/search(?:@\w+)?(?:\s+(.*))?$/i, kind: 'books', empty: 'Введите запрос. Например:\n<code>/search Толстой война мир</code>' },
    { re: /^\/book(?:@\w+)?(?:\s+(.*))?$/i, kind: 'books', empty: 'Введите запрос. Например:\n<code>/book война и мир</code>' },
    { re: /^\/authors?(?:@\w+)?(?:\s+(.*))?$/i, kind: 'authors', empty: 'Введите имя автора. Например:\n<code>/author Кораблев</code>' },
    { re: /^\/series(?:@\w+)?(?:\s+(.*))?$/i, kind: 'series', empty: 'Введите название серии. Например:\n<code>/series другая сторона</code>' },
  ];
  for (const { re, kind, empty } of rules) {
    const m = trimmed.match(re);
    if (m) {
      const query = (m[1] || '').trim();
      return { kind, query, emptyHint: empty };
    }
  }
  if (trimmed.startsWith('/')) return null;
  return { kind: 'smart', query: trimmed, emptyHint: '' };
}

/** Форматирует книгу для вывода в Telegram (HTML). */
function fmtBook(book) {
  const authors = book.authorsList?.join(', ') || book.authors || '—';
  const series = book.series
    ? ` <i>[${esc(book.series)}${book.seriesNo ? ` #${esc(String(book.seriesNo))}` : ''}]</i>`
    : '';
  const year = book.date ? ` (${String(book.date).slice(0, 4)})` : '';
  const lang = book.lang ? ` · ${book.lang.toUpperCase()}` : '';
  const ext = book.ext ? ` · ${book.ext.toUpperCase()}` : '';
  return `📖 <b>${esc(book.title)}</b>${series}\n👤 ${esc(authors)}${esc(year)}${lang}${ext}`;
}

/** Кнопки скачивания сразу под карточкой книги. */
function bookMarkup(book) {
  const formats = book.downloadFormats?.length
    ? book.downloadFormats.slice(0, 4)
    : [{ format: book.ext || 'fb2', label: (book.ext || 'fb2').toUpperCase() }];
  return {
    inline_keyboard: [formats.map((f) => ({
      text: `📥 ${f.label}`,
      callback_data: `dl:${regDlKey(book.id, f.format)}`,
    }))],
  };
}

function plainAnnotation(text, isHtml) {
  if (!text) return '';
  const raw = isHtml
    ? String(text).replace(/<[^>]*>/g, ' ')
    : String(text);
  return raw.replace(/\s+/g, ' ').trim();
}

function bookCaption(book, annotation, annotationIsHtml) {
  let cap = fmtBook(book);
  const plain = plainAnnotation(annotation, annotationIsHtml);
  if (plain) {
    const prefixLen = cap.length + 5; // \n\n📄
    const room = TG_CAPTION_MAX - prefixLen - 1;
    const maxLen = Math.min(ANNOTATION_MAX, Math.max(0, room));
    const chunk = plain.slice(0, maxLen);
    const suffix = chunk.length < plain.length ? '…' : '';
    cap += `\n\n📄 ${esc(chunk)}${suffix}`;
  }
  return cap.slice(0, TG_CAPTION_MAX);
}

let _presentationActive = 0;
const _presentationQueue = [];

function withPresentationLimit(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      _presentationActive++;
      try {
        resolve(await fn());
      } catch (err) {
        reject(err);
      } finally {
        _presentationActive--;
        const next = _presentationQueue.shift();
        if (next) next();
      }
    };
    if (_presentationActive < PRESENTATION_CONCURRENCY) run();
    else _presentationQueue.push(run);
  });
}

async function loadBookPresentation(book) {
  let cover = getCachedCoverThumb(book.id);
  if (!cover?.data?.length) {
    cover = await getDiskCachedCoverThumb(book.id);
  }

  let details = null;
  try {
    details = await getDetailsFull(book);
  } catch (err) {
    logSystemEvent('warn', 'telegram-bot', 'getDetailsFull', {
      bookId: book.id,
      error: err?.message || String(err),
    });
  }

  if (!cover?.data?.length) {
    let src = details?.cover;
    if (!src?.data?.length) {
      try {
        const best = await resolveBestCoverDetails(book);
        src = best?.cover;
      } catch {
        /* ignore */
      }
    }
    if (src?.data?.length) {
      try {
        const normalized = await normalizeBookImageForClient(src);
        if (normalized?.data?.length) {
          setCachedCoverThumb(book.id, normalized.contentType, normalized.data);
          setDiskCachedCoverThumb(book.id, normalized.contentType, normalized.data);
          cover = normalized;
        }
      } catch {
        /* ignore */
      }
    }
  }

  return {
    cover,
    annotation: details?.annotation || '',
    annotationIsHtml: Boolean(details?.annotationIsHtml),
  };
}

async function sendBookCard(chatId, book) {
  const pres = await withPresentationLimit(() => loadBookPresentation(book));
  const caption = bookCaption(book, pres.annotation, pres.annotationIsHtml);
  const markup = bookMarkup(book);
  if (pres.cover?.data?.length) {
    const res = await sendPhoto(chatId, pres.cover.data, pres.cover.contentType, caption, markup);
    if (res?.ok) return res.result?.message_id;
    logSystemEvent('warn', 'telegram-bot', 'sendPhoto', {
      bookId: book.id,
      description: res?.description || 'unknown',
    });
  }
  const res = await sendText(chatId, caption, { reply_markup: markup });
  return res?.result?.message_id;
}

function pgRow(page, total, pageSize = PAGE_SIZE) {
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) return null;
  const btns = [];
  if (page > 1) btns.push({ text: '◀', callback_data: 'pgp' });
  btns.push({ text: `${page}/${totalPages}`, callback_data: 'noop' });
  if (page < totalPages) btns.push({ text: '▶', callback_data: 'pgn' });
  return btns;
}

function listFooterMarkup(chatId, page, total, pageSize = PAGE_SIZE) {
  const rows = [];
  if (canNavigateBack(chatId)) {
    rows.push([{ text: '⬅️ Назад', callback_data: 'nav:back' }]);
  }
  const pg = pgRow(page, total, pageSize);
  if (pg) rows.push(pg);
  return rows.length ? { inline_keyboard: rows } : null;
}

async function sendBookResults(chatId, items, page, total, header, pageSize = PAGE_SIZE) {
  const session = getChatSession(chatId);
  await clearListMessages(chatId);

  const totalPages = Math.ceil(total / pageSize);
  const pageInfo = totalPages > 1 ? ` · ${page}/${totalPages}` : '';
  const headerRes = await sendText(chatId, `${header}${pageInfo}`);
  if (headerRes?.ok) session.messages.headerId = headerRes.result.message_id;

  if (items.length > 2) {
    await updateProgress(chatId, session, `⏳ Загружаю 0/${items.length}…`);
  }

  for (let i = 0; i < items.length; i++) {
    if (session.messages.progressId) {
      await updateProgress(chatId, session, `⏳ Загружаю ${i + 1}/${items.length}…`);
    }
    const messageId = await sendBookCard(chatId, items[i]);
    if (messageId) session.messages.cardIds.push(messageId);
  }

  if (session.messages.progressId) {
    await deleteMessage(chatId, session.messages.progressId);
    session.messages.progressId = undefined;
  }

  const footer = listFooterMarkup(chatId, page, total, pageSize);
  if (footer) {
    const shown = (page - 1) * pageSize + items.length;
    const footerRes = await sendText(chatId, `<i>${shown} из ${total}</i>`, { reply_markup: footer });
    if (footerRes?.ok) session.messages.footerId = footerRes.result.message_id;
  }
}

async function sendTextListResults(chatId, items, page, total, header, renderItem) {
  const session = getChatSession(chatId);
  await clearListMessages(chatId);

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const pageInfo = totalPages > 1 ? ` · ${page}/${totalPages}` : '';
  const headerRes = await sendText(chatId, `${header}${pageInfo}`);
  if (headerRes?.ok) session.messages.headerId = headerRes.result.message_id;

  for (const item of items) {
    const card = await renderItem(item);
    if (card?.messageId) session.messages.cardIds.push(card.messageId);
  }

  const footer = listFooterMarkup(chatId, page, total);
  if (footer) {
    const shown = (page - 1) * PAGE_SIZE + items.length;
    const footerRes = await sendText(chatId, `<i>${shown} из ${total}</i>`, { reply_markup: footer });
    if (footerRes?.ok) session.messages.footerId = footerRes.result.message_id;
  }
}

async function doShelvesList(chatId, username, page = 1, { fresh = false } = {}) {
  const shelves = getUserShelves(username);
  if (!shelves.length) {
    await sendText(chatId, '📚 У вас пока нет полок. Создайте их на сайте.');
    return;
  }
  const total = shelves.length;
  const slice = shelves.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  if (fresh) resetNavForNewSearch(chatId);
  setSearchState(chatId, { kind: 'shelves-list', username, page, total });
  await sendTextListResults(
    chatId,
    slice,
    page,
    total,
    '📚 <b>Мои полки</b>',
    async (item) => {
      const key = regNavKey({ kind: 'shelf', username, shelfId: item.id, shelfName: item.name });
      const count = Number(item.bookCount) || 0;
      const res = await sendText(chatId, `📚 <b>${esc(item.name)}</b> — ${count} кн.`, {
        reply_markup: { inline_keyboard: [[{ text: '📖 Книги полки', callback_data: `fa:${key}` }]] },
      });
      return { messageId: res?.result?.message_id };
    },
  );
}

async function doShelfBooks(chatId, username, shelfId, shelfName, page = 1) {
  const shelf = getShelfById(shelfId, username);
  if (!shelf) {
    await sendText(chatId, '❌ Полка не найдена.');
    return;
  }
  const books = getShelfBooks(shelfId, username)
    .map((row) => getBookById(row.id))
    .filter(Boolean);
  const total = books.length;
  if (!total) {
    await sendText(chatId, `📚 Полка «${esc(shelfName)}» пока пуста.`);
    return;
  }
  const items = books.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  setSearchState(chatId, { kind: 'shelf-books', username, shelfId, shelfName, page, total });
  await sendBookResults(chatId, items, page, total, `📚 <b>${esc(shelfName)}</b> — ${total} кн.`);
}

async function doFavoritesList(chatId, username, page = 1, { fresh = false } = {}) {
  const authors = getFavoriteAuthorsLight(username, 200);
  const series = getFavoriteSeriesLight(username, 200);
  const items = [
    ...authors.map((a) => ({ type: 'author', name: a.name, displayName: a.displayName || a.name })),
    ...series.map((s) => ({ type: 'series', name: s.name, displayName: s.displayName || s.name })),
  ];
  if (!items.length) {
    await sendText(chatId, '⭐ Избранное пусто. Добавьте авторов и серии на сайте.');
    return;
  }
  const total = items.length;
  const slice = items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  if (fresh) resetNavForNewSearch(chatId);
  setSearchState(chatId, { kind: 'favorites-list', username, page, total });
  await sendTextListResults(
    chatId,
    slice,
    page,
    total,
    '⭐ <b>Избранное</b>',
    async (item) => {
      if (item.type === 'author') {
        const key = regNavKey({ kind: 'author', author: item.name });
        const res = await sendText(chatId, `👤 <b>${esc(item.displayName)}</b>`, {
          reply_markup: { inline_keyboard: [[{ text: '📚 Серии автора', callback_data: `fa:${key}` }]] },
        });
        return { messageId: res?.result?.message_id };
      }
      const key = regNavKey({ kind: 'series', series: item.name });
      const res = await sendText(chatId, `📚 <b>${esc(item.displayName)}</b>`, {
        reply_markup: { inline_keyboard: [[{ text: '📖 Книги серии', callback_data: `fa:${key}` }]] },
      });
      return { messageId: res?.result?.message_id };
    },
  );
}

async function doRecommendedBooks(chatId, username, page = 1, { fresh = false } = {}) {
  let view = getRecommendedLibraryView({ username, page, pageSize: TG_RECOMMENDED_PAGE_SIZE });
  if (view.computing) {
    await sendText(chatId, '⏳ Рекомендации ещё собираются. Попробуйте через минуту.');
    return;
  }
  if (!view.total) {
    await sendText(
      chatId,
      '💡 Рекомендаций пока нет. Добавьте избранное или откройте несколько книг на сайте.',
    );
    return;
  }
  const cappedTotal = Math.min(view.total, TG_RECOMMENDED_MAX_ITEMS);
  const maxPage = Math.max(1, Math.ceil(cappedTotal / TG_RECOMMENDED_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), maxPage);
  if (safePage !== page) {
    view = getRecommendedLibraryView({ username, page: safePage, pageSize: TG_RECOMMENDED_PAGE_SIZE });
  }
  const books = view.items
    .slice(0, Math.max(0, cappedTotal - (safePage - 1) * TG_RECOMMENDED_PAGE_SIZE))
    .map((row) => getBookById(row.id))
    .filter(Boolean);
  if (!books.length) {
    await sendText(chatId, '💡 Рекомендации пока недоступны.');
    return;
  }
  if (fresh) resetNavForNewSearch(chatId);
  setSearchState(chatId, { kind: 'recommended-books', username, page: safePage, total: cappedTotal });
  const moreOnSite = view.total > cappedTotal
    ? `\n<i>Ещё ${view.total - cappedTotal} на сайте: /library/recommended</i>`
    : '';
  await sendBookResults(
    chatId,
    books,
    safePage,
    cappedTotal,
    `💡 <b>Рекомендации для вас</b>${moreOnSite}`,
    TG_RECOMMENDED_PAGE_SIZE,
  );
}

async function dispatchPersonalCommand(chatId, username, cmd) {
  if (cmd.kind === 'shelves') await doShelvesList(chatId, username, 1, { fresh: true });
  else if (cmd.kind === 'favorites') await doFavoritesList(chatId, username, 1, { fresh: true });
  else if (cmd.kind === 'recommended') await doRecommendedBooks(chatId, username, 1, { fresh: true });
}

// ─── Обработчики команд ───────────────────────────────────────────────────────

async function doBookSearch(chatId, query, page = 1, { fresh = false } = {}) {
  const q = query.trim();
  if (!q) {
    await sendText(chatId, 'Введите запрос. Например:\n<code>Кораблев другая сторона</code>');
    return;
  }
  const result = searchCatalog({ query: q, field: 'books', page, pageSize: PAGE_SIZE, sort: 'series' });
  if (!result?.items?.length || result.total === 0) {
    await sendText(chatId, `😔 Книги по запросу «${esc(q)}» не найдены.`);
    return;
  }
  if (fresh) resetNavForNewSearch(chatId);
  setSearchState(chatId, { kind: 'books', query: q, page, total: result.total });
  await sendBookResults(chatId, result.items, page, result.total, `🔍 <b>Книги:</b> ${esc(q)} — найдено: ${result.total}`);
}

/**
 * Умный поиск (свободный текст) — тот же хаб, что `/catalog?q=` и `/api/search`:
 * только счётчики Книги / Авторы / Серии; список открывается по кнопке раздела.
 */
async function doSmartSearch(chatId, query, { fresh = true } = {}) {
  const q = query.trim();
  if (!q) return;
  if (fresh) resetNavForNewSearch(chatId);

  const overview = searchOverview({ query: q });
  const booksTotal = Math.max(0, Math.floor(Number(overview.books?.total) || 0));
  const authorsTotal = Math.max(0, Math.floor(Number(overview.authors?.total) || 0));
  const seriesTotal = Math.max(0, Math.floor(Number(overview.series?.total) || 0));
  const booksLabel = overview.books?.capped ? `${booksTotal}+` : String(booksTotal);

  if (!booksTotal && !authorsTotal && !seriesTotal) {
    const typos = findDidYouMeanSuggestions(q, 3);
    let msg = `😔 По запросу «${esc(q)}» ничего не найдено.`;
    if (typos.length) {
      msg += '\n\nВозможно, вы имели в виду:';
      const rows = typos.map((hint) => {
        const key = regNavKey({ kind: 'smart-query', query: hint.query });
        return [{ text: hint.label || hint.query, callback_data: `fa:${key}` }];
      });
      await sendText(chatId, msg, { reply_markup: { inline_keyboard: rows } });
      return;
    }
    await sendText(chatId, `${msg}\nПопробуйте <code>/author</code> или <code>/series</code>.`);
    return;
  }

  setSearchState(chatId, {
    kind: 'smart',
    query: q,
    page: 1,
    total: booksTotal + authorsTotal + seriesTotal,
    booksTotal,
    authorsTotal,
    seriesTotal,
  });

  const session = getChatSession(chatId);
  await clearListMessages(chatId);

  const rows = [];
  if (booksTotal > 0) rows.push([{ text: `Книги · ${booksLabel}`, callback_data: 'sm:b' }]);
  if (authorsTotal > 0) rows.push([{ text: `Авторы · ${authorsTotal}`, callback_data: 'sm:a' }]);
  if (seriesTotal > 0) rows.push([{ text: `Серии · ${seriesTotal}`, callback_data: 'sm:s' }]);
  if (canNavigateBack(chatId)) {
    rows.push([{ text: '⬅️ Назад', callback_data: 'nav:back' }]);
  }

  const headerRes = await sendText(
    chatId,
    `🔍 <b>Результаты поиска</b>\nЗапрос «${esc(q)}»\n\n` +
      `<i>Откройте раздел, чтобы увидеть полный список</i>`,
    { reply_markup: { inline_keyboard: rows } },
  );
  if (headerRes?.ok) session.messages.headerId = headerRes.result.message_id;
}

async function doAuthorSearch(chatId, query, page = 1, { fresh = false } = {}) {
  const q = query.trim();
  if (!q) {
    await sendText(chatId, 'Введите имя автора. Например:\n<code>Кораблев</code>');
    return;
  }
  const result = searchCatalog({ query: q, field: 'authors', page, pageSize: PAGE_SIZE, sort: 'name' });
  if (!result?.items?.length || result.total === 0) {
    await sendText(chatId, `😔 Авторы по запросу «${esc(q)}» не найдены.`);
    return;
  }
  if (result.total === 1 && page === 1) {
    if (fresh) resetNavForNewSearch(chatId);
    await doAuthorOverview(chatId, result.items[0].name, 1, { fresh: false });
    return;
  }
  if (fresh) resetNavForNewSearch(chatId);
  setSearchState(chatId, { kind: 'authors', query: q, page, total: result.total });
  await sendTextListResults(
    chatId,
    result.items,
    page,
    result.total,
    `👤 <b>Авторы:</b> ${esc(q)} — ${result.total}`,
    async (item) => {
      const name = item.displayName || item.name;
      const key = regNavKey({ kind: 'author', author: item.name });
      const res = await sendText(chatId, `👤 <b>${esc(name)}</b> — ${item.bookCount} кн.`, {
        reply_markup: { inline_keyboard: [[{ text: '📚 Серии', callback_data: `fa:${key}` }]] },
      });
      return { messageId: res?.result?.message_id };
    },
  );
}

async function doAuthorOverview(chatId, authorName, page = 1, { fresh = false } = {}) {
  const grouped = loadAuthorGrouped(authorName);
  const overviewItems = buildAuthorOverviewItems(grouped);
  if (!overviewItems.length) {
    await sendText(chatId, `😔 У автора «${esc(authorName)}» нет книг в каталоге.`);
    return;
  }

  const total = overviewItems.length;
  const slice = overviewItems.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  if (fresh) resetNavForNewSearch(chatId);
  setSearchState(chatId, { kind: 'author-overview', authorName, page, total });

  const seriesCount = grouped.series.length;
  await sendTextListResults(
    chatId,
    slice,
    page,
    total,
    `👤 <b>${esc(authorName)}</b>\n` +
      `Всего ${grouped.total} кн. · серий: ${seriesCount}` +
      (grouped.standaloneBooks?.length ? ` · вне серий: ${grouped.standaloneBooks.length}` : ''),
    async (item) => {
      if (item.type === 'series') {
        const key = regNavKey({ kind: 'author-series', author: authorName, series: item.name });
        const res = await sendText(chatId, `📚 <b>${esc(item.displayName)}</b> — ${item.bookCount} кн.`, {
          reply_markup: { inline_keyboard: [[{ text: '📖 Книги серии', callback_data: `fa:${key}` }]] },
        });
        return { messageId: res?.result?.message_id };
      }
      const key = regNavKey({ kind: 'author-standalone', author: authorName });
      const res = await sendText(chatId, `📖 <b>Без серии</b> — ${item.bookCount} кн.`, {
        reply_markup: { inline_keyboard: [[{ text: '📖 Книги', callback_data: `fa:${key}` }]] },
      });
      return { messageId: res?.result?.message_id };
    },
  );
}

async function doAuthorSeriesBooks(chatId, authorName, seriesName, page = 1) {
  const result = getBooksByFacet({
    facet: 'series',
    value: seriesName,
    author: authorName,
    page,
    pageSize: PAGE_SIZE,
    sort: 'series',
  });
  if (!result?.items?.length || result.total === 0) {
    await sendText(chatId, '❌ Книги не найдены.');
    return;
  }
  setSearchState(chatId, { kind: 'author-series', authorName, seriesName, page, total: result.total });
  await sendBookResults(
    chatId,
    result.items,
    page,
    result.total,
    `👤 ${esc(authorName)}\n📚 <b>${esc(seriesName)}</b> — ${result.total} кн.`,
  );
}

async function doAuthorStandaloneBooks(chatId, authorName, page = 1) {
  const grouped = loadAuthorGrouped(authorName);
  const books = grouped.standaloneBooks || [];
  const total = books.length;
  if (!total) {
    await sendText(chatId, '❌ Книги вне серий не найдены.');
    return;
  }
  const items = books.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  setSearchState(chatId, { kind: 'author-standalone', authorName, page, total });
  await sendBookResults(chatId, items, page, total, `👤 ${esc(authorName)} · <b>без серии</b> — ${total} кн.`);
}

async function doSeriesSearch(chatId, query, page = 1, { fresh = false } = {}) {
  const q = query.trim();
  if (!q) {
    await sendText(chatId, 'Введите название серии. Например:\n<code>/series другая сторона</code>');
    return;
  }
  const result = searchCatalog({ query: q, field: 'series', page, pageSize: PAGE_SIZE, sort: 'name', nameOnly: true });
  if (!result?.items?.length || result.total === 0) {
    await sendText(chatId, `😔 Серии по запросу «${esc(q)}» не найдены.`);
    return;
  }
  if (result.total === 1 && page === 1) {
    if (fresh) resetNavForNewSearch(chatId);
    await doSeriesBooks(chatId, result.items[0].name, 1, { fresh: false });
    return;
  }
  if (fresh) resetNavForNewSearch(chatId);
  setSearchState(chatId, { kind: 'series', query: q, page, total: result.total });
  await sendTextListResults(
    chatId,
    result.items,
    page,
    result.total,
    `📚 <b>Серии:</b> ${esc(q)} — ${result.total}`,
    async (item) => {
      const name = item.displayName || item.name;
      const key = regNavKey({ kind: 'series', series: item.name });
      const res = await sendText(chatId, `📚 <b>${esc(name)}</b> — ${item.bookCount} кн.`, {
        reply_markup: { inline_keyboard: [[{ text: '📖 Книги', callback_data: `fa:${key}` }]] },
      });
      return { messageId: res?.result?.message_id };
    },
  );
}

async function doSeriesBooks(chatId, seriesName, page = 1, { fresh = false } = {}) {
  const result = getBooksByFacet({
    facet: 'series',
    value: seriesName,
    page,
    pageSize: PAGE_SIZE,
    sort: 'series',
  });
  if (!result?.items?.length || result.total === 0) {
    await sendText(chatId, '❌ Книги не найдены.');
    return;
  }
  if (fresh) resetNavForNewSearch(chatId);
  setSearchState(chatId, { kind: 'series-books', seriesName, page, total: result.total });
  await sendBookResults(chatId, result.items, page, result.total, `📚 <b>${esc(seriesName)}</b> — ${result.total} кн.`);
}

async function openNavEntry(chatId, entry, page = 1) {
  switch (entry.kind) {
    case 'author':
      await doAuthorOverview(chatId, entry.author, page);
      break;
    case 'author-series':
      await doAuthorSeriesBooks(chatId, entry.author, entry.series, page);
      break;
    case 'author-standalone':
      await doAuthorStandaloneBooks(chatId, entry.author, page);
      break;
    case 'series':
      await doSeriesBooks(chatId, entry.series, page);
      break;
    case 'shelf':
      await doShelfBooks(chatId, entry.username, entry.shelfId, entry.shelfName, page);
      break;
    case 'smart-query':
      await doSmartSearch(chatId, entry.query, { fresh: false });
      break;
    default:
      await sendText(chatId, '⚠️ Ссылка устарела. Повторите поиск.');
  }
}

async function restoreSearchState(chatId, state) {
  if (!state) return;
  setSearchState(chatId, state);
  if (state.kind === 'smart') await doSmartSearch(chatId, state.query, { fresh: false });
  else if (state.kind === 'books') await doBookSearch(chatId, state.query, state.page);
  else if (state.kind === 'authors') await doAuthorSearch(chatId, state.query, state.page);
  else if (state.kind === 'series') await doSeriesSearch(chatId, state.query, state.page);
  else if (state.kind === 'author-overview') await doAuthorOverview(chatId, state.authorName, state.page);
  else if (state.kind === 'author-series') await doAuthorSeriesBooks(chatId, state.authorName, state.seriesName, state.page);
  else if (state.kind === 'author-standalone') await doAuthorStandaloneBooks(chatId, state.authorName, state.page);
  else if (state.kind === 'series-books') await doSeriesBooks(chatId, state.seriesName, state.page);
  else if (state.kind === 'shelves-list') await doShelvesList(chatId, state.username, state.page);
  else if (state.kind === 'shelf-books') await doShelfBooks(chatId, state.username, state.shelfId, state.shelfName, state.page);
  else if (state.kind === 'favorites-list') await doFavoritesList(chatId, state.username, state.page);
  else if (state.kind === 'recommended-books') await doRecommendedBooks(chatId, state.username, state.page);
}

async function continueListedSearch(chatId, page) {
  const state = getSearchState(chatId);
  if (!state) return;
  const next = { ...state, page };
  setSearchState(chatId, next);
  if (state.kind === 'books') await doBookSearch(chatId, state.query, page);
  else if (state.kind === 'authors') await doAuthorSearch(chatId, state.query, page);
  else if (state.kind === 'series') await doSeriesSearch(chatId, state.query, page);
  else if (state.kind === 'author-overview') await doAuthorOverview(chatId, state.authorName, page);
  else if (state.kind === 'author-series') await doAuthorSeriesBooks(chatId, state.authorName, state.seriesName, page);
  else if (state.kind === 'author-standalone') await doAuthorStandaloneBooks(chatId, state.authorName, page);
  else if (state.kind === 'series-books') await doSeriesBooks(chatId, state.seriesName, page);
  else if (state.kind === 'shelves-list') await doShelvesList(chatId, state.username, page);
  else if (state.kind === 'shelf-books') await doShelfBooks(chatId, state.username, state.shelfId, state.shelfName, page);
  else if (state.kind === 'favorites-list') await doFavoritesList(chatId, state.username, page);
  else if (state.kind === 'recommended-books') await doRecommendedBooks(chatId, state.username, page);
}

async function dispatchSearch(chatId, parsed) {
  if (parsed.kind === 'authors') await doAuthorSearch(chatId, parsed.query, 1, { fresh: true });
  else if (parsed.kind === 'series') await doSeriesSearch(chatId, parsed.query, 1, { fresh: true });
  else if (parsed.kind === 'books') await doBookSearch(chatId, parsed.query, 1, { fresh: true });
  else if (parsed.kind === 'smart') await doSmartSearch(chatId, parsed.query);
}

let _downloadActive = 0;
const _downloadQueue = [];

/** Ограничивает число параллельных извлечений файлов из архивов. */
function withDownloadLimit(fn) {
  const MAX_CONCURRENT = 2;
  if (_downloadActive < MAX_CONCURRENT) {
    _downloadActive++;
    return fn().finally(() => {
      _downloadActive--;
      _downloadQueue.shift()?.();
    });
  }
  return new Promise((resolve, reject) => {
    _downloadQueue.push(() => {
      _downloadActive++;
      fn().then(resolve, reject).finally(() => {
        _downloadActive--;
        _downloadQueue.shift()?.();
      });
    });
  });
}

async function doDownload(chatId, dlKey, cbId) {
  const entry = _dlCache.get(dlKey);
  if (!entry) {
    await answerCb(cbId, '⚠️ Ссылка устарела. Повторите поиск.');
    return;
  }
  await answerCb(cbId, '⏳ Готовлю файл…');
  const book = getBookById(entry.bookId);
  if (!book) {
    await sendText(chatId, '❌ Книга не найдена в базе.');
    return;
  }
  await sendText(chatId, `⏳ Извлекаю «${esc(book.title)}»…`);
  try {
    await withDownloadLimit(async () => {
      const dl = await resolveDownload(book, entry.format, { skipFb2DeliveryProcessing: true });
      let buffer;
      if (dl.content) {
        buffer = dl.content;
      } else if (dl.filePath) {
        buffer = await fs.readFile(dl.filePath);
      } else {
        throw new Error('пустой ответ от resolveDownload');
      }
      if (buffer.length > MAX_FILE_BYTES) {
        await sendText(
          chatId,
          `⚠️ Файл слишком большой (${Math.round(buffer.length / 1_048_576)} МБ). Telegram принимает файлы до 50 МБ.`,
        );
        return;
      }
      const caption = fmtBook(book).replace(/<[^>]+>/g, '');
      const result = await sendDoc(chatId, buffer, dl.fileName, caption);
      if (!result.ok) {
        await sendText(chatId, `❌ Telegram: ${esc(result.description || 'неизвестная ошибка')}`);
      }
    });
  } catch (err) {
    logSystemEvent('warn', 'telegram-bot', 'ошибка скачивания', { bookId: entry.bookId, error: err.message });
    await sendText(chatId, `❌ Ошибка: ${esc(err.message)}`);
  }
}

async function handleUpdate(upd) {
  try {
    touchClusterHeartbeat();

    if (upd.my_chat_member) {
      const mcm = upd.my_chat_member;
      const chat = mcm.chat;
      const status = mcm.new_chat_member?.status;
      if (chat?.id) {
        if (status === 'member' || status === 'administrator') {
          touchTelegramChat(chat);
        } else if (status === 'left' || status === 'kicked') {
          removeTelegramChat(String(chat.id));
        }
      }
      return;
    }

    if (upd.callback_query) {
      const cq = upd.callback_query;
      const chatId = cq.message?.chat?.id;
      if (!chatId) return;
      touchTelegramChat(cq.message.chat);
      if (!isAllowed(cq.from?.id)) {
        await answerCb(cq.id, '⛔ Нет доступа.');
        await sendText(chatId, telegramAccessDeniedMessage(cq.from?.id));
        return;
      }
      const data = cq.data ?? '';
      if (data === 'noop') {
        await answerCb(cq.id);
      } else if (data.startsWith('dl:')) {
        await doDownload(chatId, data.slice(3), cq.id);
      } else if (data.startsWith('fa:')) {
        await answerCb(cq.id);
        const entry = _facetCache.get(data.slice(3));
        if (!entry) {
          await sendText(chatId, '⚠️ Ссылка устарела. Повторите поиск.');
          return;
        }
        pushNavSnapshot(chatId);
        await openNavEntry(chatId, entry, 1);
      } else if (data === 'sm:b' || data === 'sm:a' || data === 'sm:s') {
        await answerCb(cq.id);
        const state = getSearchState(chatId);
        const q = String(state?.query || '').trim();
        if (!q || state?.kind !== 'smart') {
          await sendText(chatId, '⚠️ Ссылка устарела. Повторите поиск.');
          return;
        }
        pushNavSnapshot(chatId);
        if (data === 'sm:b') await doBookSearch(chatId, q, 1, { fresh: false });
        else if (data === 'sm:a') await doAuthorSearch(chatId, q, 1, { fresh: false });
        else await doSeriesSearch(chatId, q, 1, { fresh: false });
      } else if (data === 'nav:back') {
        await answerCb(cq.id);
        const prev = popNavSnapshot(chatId);
        if (!prev) {
          await sendText(chatId, '⚠️ Некуда возвращаться.');
          return;
        }
        await restoreSearchState(chatId, prev);
      } else if (data === 'pgn' || data === 'pgp') {
        await answerCb(cq.id);
        const state = getSearchState(chatId);
        if (state) {
          const newPage = data === 'pgn' ? state.page + 1 : state.page - 1;
          await continueListedSearch(chatId, newPage);
        }
      }
      return;
    }

    const msg = upd.message;
    if (!msg?.text) return;
    const chatId = msg.chat.id;
    touchTelegramChat(msg.chat);
    const text = msg.text.trim();

    const linkToken = parseStartLinkToken(text);
    if (linkToken) {
      await handleTelegramLink(chatId, msg.from?.id, linkToken);
      return;
    }

    if (!isAllowed(msg.from?.id)) {
      await sendText(chatId, telegramAccessDeniedMessage(msg.from?.id));
      return;
    }

    if (text === '/start' || text.startsWith('/start ')) {
      const linked = resolveLinkedUser(msg.from?.id);
      if (linked) {
        await sendText(
          chatId,
          resolveWelcomeMessage() +
            `\n\n👤 Вы вошли как <b>${esc(linked.username)}</b>.\n` +
            'Поиск: <code>/search</code> · <code>/author</code> · <code>/series</code>\n' +
            'Личное: <code>/shelves</code> · <code>/favorites</code> · <code>/recommended</code>',
        );
        return;
      }
      await sendText(chatId, resolveWelcomeMessage());
      return;
    }

    if (text === '/me' || text.startsWith('/me ') || text === '/account' || text.startsWith('/account ')) {
      await handleTelegramMe(chatId, msg.from?.id);
      return;
    }

    if (text === '/unlink' || text.startsWith('/unlink ')) {
      await handleTelegramUnlink(chatId, msg.from?.id);
      return;
    }

    if (text === '/help') {
      await sendText(chatId, buildBotHelpMessage());
      return;
    }

    const personalCmd = parsePersonalCommand(text);
    if (personalCmd) {
      const linked = resolveLinkedUser(msg.from?.id);
      if (!linked) {
        await sendText(
          chatId,
          'ℹ️ Эта команда доступна после привязки аккаунта.\n' +
            'Профиль на сайте → Настройки → Telegram → «Привязать».',
        );
        return;
      }
      try {
        await dispatchPersonalCommand(chatId, linked.username, personalCmd);
      } catch (err) {
        logSystemEvent('warn', 'telegram-bot', 'ошибка личной команды', {
          chatId,
          kind: personalCmd.kind,
          username: linked.username,
          error: err.message,
        });
        await sendText(chatId, `❌ Ошибка: ${esc(err.message)}`);
      }
      return;
    }

    const parsed = parseUserQuery(text);
    if (parsed) {
      if (!parsed.query && parsed.emptyHint) {
        await sendText(chatId, parsed.emptyHint);
        return;
      }
      try {
        await dispatchSearch(chatId, parsed);
      } catch (err) {
        logSystemEvent('warn', 'telegram-bot', 'ошибка поиска', { chatId, query: parsed.query, kind: parsed.kind, error: err.message });
        await sendText(chatId, `❌ Ошибка при поиске: ${esc(err.message)}`);
      }
    }
  } catch (err) {
    logSystemEvent('warn', 'telegram-bot', 'ошибка обработки update', { error: err.message });
  }
}

// ─── Polling loop ─────────────────────────────────────────────────────────────

async function pollingLoop(generation) {
  let backoffMs = 1_000;
  try {
    while (generation === _generation) {
      _abortCtrl = new AbortController();
      try {
        const updates = await fetchUpdates(_abortCtrl.signal);
        if (generation !== _generation) break;
        backoffMs = 1_000;
        for (const upd of updates) {
          if (generation !== _generation) break;
          _offset = upd.update_id + 1;
          handleUpdate(upd).catch(() => {});
        }
      } catch (err) {
        if (generation !== _generation) break;
        if (err.name !== 'AbortError') {
          logSystemEvent('warn', 'telegram-bot', 'ошибка polling', { error: err.message });
          await new Promise((r) => setTimeout(r, backoffMs));
          if (generation !== _generation) break;
          backoffMs = Math.min(backoffMs * 2, 30_000);
        }
      }
    }
  } finally {
    if (generation === _generation) {
      _running = false;
      clearClusterTelegramState();
    }
  }
}

async function stopTelegramBotAndWait() {
  _generation++;
  _abortCtrl?.abort();
  const prevLoop = _loopPromise;
  _loopPromise = null;
  if (prevLoop) {
    await prevLoop.catch(() => {});
  }
  if (_transportMode === 'webhook' && _token) {
    try {
      await tgPost('deleteWebhook', { drop_pending_updates: false });
    } catch { /* ignore */ }
  }
  _running = false;
  _transportMode = 'polling';
  clearClusterTelegramState();
}

async function applyTelegramConfig() {
  if (!shouldRunTelegramBotInThisProcess()) return;

  const { token, allowedUsers, accessMode, enabled } = resolveTelegramRuntimeConfig();

  await stopTelegramBotAndWait();

  if (!enabled || !token) return;

  syncTelegramChatsFromLinkedUsers();
  _token = token;
  _allowedUsers = allowedUsers?.length ? new Set(allowedUsers.map(String)) : null;
  _accessMode = accessMode || 'whitelist_or_linked';
  _offset = 0;
  _webhookSecret = config.telegramWebhookSecret || '';

  const me = await tgPost('getMe', {});
  if (!me.ok) {
    throw new Error(me.description || 'invalid bot token');
  }

  await registerBotCommands();
  await registerBotProfile();

  const username = me.result?.username ?? '?';
  setMeta('telegram_bot_username', username);
  const webhookUrl = resolveWebhookUrl();
  const generation = _generation;
  _running = true;
  setClusterTelegramState();

  if (webhookUrl) {
    const whBody = {
      url: webhookUrl,
      allowed_updates: ['message', 'callback_query', 'my_chat_member'],
      drop_pending_updates: false,
    };
    if (_webhookSecret) whBody.secret_token = _webhookSecret;
    const wh = await tgPost('setWebhook', whBody);
    if (!wh.ok) {
      _running = false;
      clearClusterTelegramState();
      throw new Error(wh.description || 'setWebhook failed');
    }
    _transportMode = 'webhook';
    console.log(`[telegram-bot] Бот @${username} — webhook (${webhookUrl})`);
    logSystemEvent('info', 'telegram-bot', 'бот запущен (webhook)', { username, webhookUrl, pid: process.pid });
  } else {
    await tgPost('deleteWebhook', { drop_pending_updates: false });
    _transportMode = 'polling';
    console.log(`[telegram-bot] Бот @${username} — long polling`);
    logSystemEvent('info', 'telegram-bot', 'бот запущен (polling)', { username, pid: process.pid });
    _loopPromise = pollingLoop(generation);
  }
}

function startCachePruneTimer() {
  if (_cachePruneTimer) return;
  _cachePruneTimer = setInterval(() => {
    _chatSessions.prune();
    _dlCache.prune();
    _facetCache.prune();
    _authorGroupedCache.prune();
  }, 10 * 60_000);
  _cachePruneTimer.unref?.();
}

function setupTelegramClusterRelay() {
  if (!cluster.isWorker) return;
  process.on('message', (msg) => {
    if (msg?.type === 'telegram-update' && shouldRunTelegramBotInThisProcess() && _running) {
      handleUpdate(msg.update).catch(() => {});
    }
  });
}

/** POST-обработчик webhook (монтируется в Express). */
export async function handleTelegramWebhook(req, res) {
  const secret = config.telegramWebhookSecret || _webhookSecret;
  if (secret) {
    const hdr = req.headers['x-telegram-bot-api-secret-token'];
    if (hdr !== secret) {
      res.sendStatus(403);
      return;
    }
  }
  const update = req.body;
  if (!update || typeof update !== 'object') {
    res.sendStatus(400);
    return;
  }
  if (!shouldRunTelegramBotInThisProcess()) {
    if (cluster.isWorker && typeof process.send === 'function') {
      process.send({ type: 'telegram-update-forward', update });
      res.sendStatus(200);
      return;
    }
    res.sendStatus(503);
    return;
  }
  if (!_running) {
    res.sendStatus(503);
    return;
  }
  res.sendStatus(200);
  handleUpdate(update).catch((err) => {
    logSystemEvent('warn', 'telegram-bot', 'ошибка webhook update', { error: err.message });
  });
}

/** Регистрирует маршрут webhook в Express (на всех воркерах). */
export function registerTelegramBotRoutes(app) {
  const routePath = config.telegramWebhookPath.startsWith('/')
    ? config.telegramWebhookPath
    : `/${config.telegramWebhookPath}`;
  app.post(routePath, (req, res) => {
    void handleTelegramWebhook(req, res);
  });
}

function startConfigWatcher() {
  if (_configWatchTimer || !shouldRunTelegramBotInThisProcess()) return;
  _configWatchTimer = setInterval(() => {
    void syncTelegramConfigFromMeta().catch((err) => {
      logSystemEvent('warn', 'telegram-bot', 'ошибка синхронизации конфигурации', { error: err.message });
    });
  }, CONFIG_WATCH_INTERVAL_MS);
  _configWatchTimer.unref?.();
}

async function syncTelegramConfigFromMeta() {
  if (!shouldRunTelegramBotInThisProcess()) return;
  const restartAt = getMeta('telegram_bot_restart_at') || '';
  if (!restartAt || restartAt === _lastAppliedRestartAt) return;
  _lastAppliedRestartAt = restartAt;
  await applyTelegramConfig();
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Запускает watcher конфигурации (cluster worker #1), polling или webhook.
 */
export async function startTelegramBot() {
  setupTelegramClusterRelay();
  startCachePruneTimer();
  startConfigWatcher();
  if (!shouldRunTelegramBotInThisProcess()) return;
  _lastAppliedRestartAt = getMeta('telegram_bot_restart_at') || '';
  await applyTelegramConfig();
}

/**
 * Останавливает бота (polling / webhook).
 */
export function stopTelegramBot() {
  _generation++;
  _abortCtrl?.abort();
  _running = false;
  clearClusterTelegramState();
  if (_token && _transportMode === 'webhook') {
    void tgPost('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
  }
}

/**
 * Сигнализирует всем воркерам о смене настроек и применяет их в worker #1.
 */
export async function restartTelegramBot() {
  setMeta('telegram_bot_restart_at', new Date().toISOString());
  if (shouldRunTelegramBotInThisProcess()) {
    await syncTelegramConfigFromMeta();
  }
}

/**
 * Возвращает true, если бот активен (polling или webhook).
 */
export function isTelegramBotRunning() {
  if (_running) return true;
  return isClusterTelegramBotActive();
}
