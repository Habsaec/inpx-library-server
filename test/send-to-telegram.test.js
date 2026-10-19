import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { initDb, db, createUser, setSetting, setUserTelegramBotAllowed, setUserTelegramId } from '../src/db.js';
import { registerUserApiRoutes } from '../src/routes/user-api.js';
import { enrichBookRow, parseLine } from '../src/inpx.js';
import { config } from '../src/config.js';
import { sendBookCardToChat } from '../src/services/telegram-bot.js';
import { bookRefUrlRewrite } from '../src/middleware/book-ref-rewrite.js';
import { encodeBookRef } from '../src/utils/book-ref.js';

const USER = 'tg_send_user';
const SEP = String.fromCharCode(4);
let bookId;
let server;
let baseUrl;

const authHeaders = () => ({
  Authorization: `Basic ${Buffer.from(`${USER}:TgSendPass1!`).toString('base64')}`,
  'Content-Type': 'application/json'
});

const send = (id = bookId) => fetch(`${baseUrl}/api/send-to-telegram/${encodeURIComponent(id)}`, {
  method: 'POST', headers: authHeaders(), body: '{}'
});

before(async () => {
  initDb();
  if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(USER)) {
    createUser({ username: USER, password: 'TgSendPass1!' });
  }
  const line = ['Author', 'sf', 'Telegram Book', '', '', 'tgbook', '100', '9001', '0', 'fb2', '', 'ru', '0', ''].join(SEP);
  const row = enrichBookRow(parseLine(line, 'test.zip'));
  db.prepare(`
    INSERT OR REPLACE INTO books (
      id, title, authors, genres, series, series_no, title_sort, author_sort,
      series_sort, series_index, title_search, authors_search, series_search,
      genres_search, keywords_search, file_name, archive_name, size, lib_id, deleted,
      ext, date, lang, keywords, lib_rate, source_id
    ) VALUES (
      @id, @title, @authors, @genres, @series, @seriesNo, @titleSort, @authorSort,
      @seriesSort, @seriesIndex, @titleSearch, @authorsSearch, @seriesSearch,
      @genresSearch, @keywordsSearch, @fileName, @archiveName, @size, @libId, @deleted,
      @ext, @date, @lang, @keywords, @libRate, @sourceId
    )
  `).run({ ...row, sourceId: null });
  bookId = row.id;

  const app = express();
  app.use(express.json());
  app.use(bookRefUrlRewrite);
  registerUserApiRoutes(app, { batchEmailLocks: new Set() });
  server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('send-to-telegram requires authentication', async () => {
  const res = await fetch(`${baseUrl}/api/send-to-telegram/${encodeURIComponent(bookId)}`, { method: 'POST' });
  assert.equal(res.status, 401);
});

test('send-to-telegram: unknown book, disabled bot, denied, not linked', async () => {
  assert.equal((await send('no-such-book')).status, 404);

  setSetting('telegram_enabled', '0');
  const disabled = await send();
  assert.equal(disabled.status, 400);
  assert.equal((await disabled.json()).code, 'TELEGRAM_DISABLED');

  setSetting('telegram_bot_token', '123456:test-token');
  setSetting('telegram_enabled', '1');
  setSetting('telegram_configured', '1');

  setUserTelegramBotAllowed(USER, false);
  const denied = await send();
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, 'TELEGRAM_DENIED');

  setUserTelegramBotAllowed(USER, true);
  const notLinked = await send();
  assert.equal(notLinked.status, 400);
  const body = await notLinked.json();
  assert.equal(body.code, 'TELEGRAM_NOT_LINKED');
  assert.equal(body.linkUrl, '/profile#settings');
});

test('send-to-telegram accepts the /b64/ book ref form', async () => {
  const res = await fetch(`${baseUrl}/api/send-to-telegram/b64/${encodeBookRef(bookId)}`, {
    method: 'POST', headers: authHeaders(), body: '{}'
  });
  assert.notEqual(res.status, 404, 'b64 ref must be rewritten to the id route');
});

test('sendBookCardToChat rejects with BOT_DISABLED when the bot is off', async () => {
  setSetting('telegram_enabled', '0');
  await assert.rejects(
    () => sendBookCardToChat('123456', bookId),
    (err) => err.code === 'BOT_DISABLED'
  );
});

test('sendBookCardToChat sends the bot card with a button for every format', async () => {
  setSetting('telegram_bot_token', '123456:test-token');
  setSetting('telegram_enabled', '1');
  setSetting('telegram_configured', '1');
  const prevFb2cng = config.fb2cngPath;
  const realFetch = globalThis.fetch;
  const calls = [];
  config.fb2cngPath = 'fb2cng';
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.telegram.org/')) return realFetch(url, init);
    const method = String(url).split('/').pop();
    // No cover in the test DB → the card goes out as sendMessage (JSON), same as in the bot.
    calls.push({ method, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
    return { json: async () => ({ ok: true, result: { message_id: 77 } }) };
  };
  try {
    const result = await sendBookCardToChat('555', bookId);
    assert.equal(result.messageId, 77);
    const card = calls.find((c) => c.method === 'sendMessage');
    assert.ok(card, 'card is sent through the bot sendMessage/sendPhoto path');
    assert.equal(card.body.chat_id, '555');
    assert.match(card.body.text, /Telegram Book/);
    const buttons = card.body.reply_markup.inline_keyboard.flat();
    assert.deepEqual(buttons.map((b) => b.text), ['📥 FB2', '📥 FB2.ZIP', '📥 EPUB', '📥 EPUB3', '📥 KEPUB', '📥 KFX', '📥 AZW8']);
    assert.ok(buttons.every((b) => /^dl:\d+$/.test(b.callback_data)));
    assert.ok(card.body.reply_markup.inline_keyboard.every((row) => row.length <= 3));
  } finally {
    globalThis.fetch = realFetch;
    config.fb2cngPath = prevFb2cng;
  }
});

test('send-to-telegram/batch sends a card per selected book and reports skipped ones', async () => {
  setSetting('telegram_bot_token', '123456:test-token');
  setSetting('telegram_enabled', '1');
  setSetting('telegram_configured', '1');
  setUserTelegramBotAllowed(USER, true);
  const sendBatch = (ids) => fetch(`${baseUrl}/api/send-to-telegram/batch`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ ids })
  });

  setUserTelegramId(USER, '');
  const notLinked = await sendBatch([bookId]);
  assert.equal(notLinked.status, 400);
  assert.equal((await notLinked.json()).code, 'TELEGRAM_NOT_LINKED');

  setUserTelegramId(USER, '424242');
  assert.equal((await sendBatch([])).status, 400);
  const tooMany = await sendBatch(Array.from({ length: 21 }, (_, i) => `id-${i}`));
  assert.equal(tooMany.status, 400);

  const realFetch = globalThis.fetch;
  const chats = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.telegram.org/')) return realFetch(url, init);
    chats.push(JSON.parse(init.body).chat_id);
    return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  try {
    const res = await sendBatch([bookId, 'no-such-book']);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sent, 1);
    assert.equal(body.requested, 2);
    assert.equal(body.skipped, 1);
    assert.equal(body.partial, true);
    assert.deepEqual(chats, ['424242']);
  } finally {
    globalThis.fetch = realFetch;
    setUserTelegramId(USER, '');
  }
});

test('list rows and the selection toolbar merge email and Telegram into one «Отправить» menu', async () => {
  setSetting('telegram_bot_token', '123456:test-token');
  setSetting('telegram_enabled', '1');
  setSetting('telegram_configured', '1');
  const { renderAuthorFlibustaList, renderBatchDownloadToolbar } = await import('../src/templates/shared.js');
  const user = { username: USER, telegramBotAllowed: true, ereaderEmailAllowed: true };
  const row = renderAuthorFlibustaList({ standaloneBooks: [{ id: '1', title: 'Книга', ext: 'fb2' }], user });
  assert.match(row, /author-flibusta-send/);
  assert.match(row, /data-send-to-ereader="1"/);
  assert.match(row, /data-send-to-telegram="1"/);

  const emailOnly = renderAuthorFlibustaList({
    standaloneBooks: [{ id: '1', title: 'Книга', ext: 'fb2' }],
    user: { ...user, telegramBotAllowed: false }
  });
  assert.doesNotMatch(emailOnly, /author-flibusta-send|data-send-to-telegram/);
  assert.match(emailOnly, /class="button author-flibusta-email"[^>]*data-send-to-ereader="1"/);

  const { renderBookGrid } = await import('../src/templates/shared.js');
  const card = { id: '77', title: 'Обложка', ext: 'fb2' };
  const grid = renderBookGrid([card], { isAuthenticated: true, batchSelect: true, user });
  assert.match(grid, /card-send-menu/);
  assert.match(grid, /class="batch-select-cb"/);
  assert.doesNotMatch(grid, /card-cover-action" href=/, '«Подробнее» is replaced by «Отправить»');
  const anonGrid = renderBookGrid([card], { batchSelect: false, user: null });
  assert.match(anonGrid, /card-cover-action" href=/, 'without send targets the card keeps «Подробнее»');

  const toolbar = renderBatchDownloadToolbar({ adhoc: true }, { user });
  assert.match(toolbar, /data-batch-email-format="fb2zip"/);
  assert.match(toolbar, /data-batch-send-telegram="20"/);
});

test('sendBookCardToChat reports SEND_FAILED when Telegram rejects the message', async () => {
  setSetting('telegram_enabled', '1');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).startsWith('https://api.telegram.org/')
    ? { json: async () => ({ ok: false, error_code: 400, description: 'chat not found' }) }
    : realFetch(url, init));
  try {
    await assert.rejects(
      () => sendBookCardToChat('555', bookId),
      (err) => err.code === 'SEND_FAILED'
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
