# Telegram bot

Part of the INPX Library Server agent spec. The rules every task must obey are in
[`AGENTS.md`](../../AGENTS.md); this file is the detailed reference of one subsystem.
Read it before changing that area and update it in the same commit as the code.

Scope: the bot process in `src/services/telegram-*.js` and the «В Telegram» web action

---

## Rules

| Rule | Meaning |
|------|---------|
| Telegram bot personal commands | `/shelves`, `/favorites` (a menu with counts → «Книги» = `bookmarks`, «Авторы», «Серии», as on the web `/favorites`; direct `/fav_books` `/fav_authors` `/fav_series`), `/want` = «Хочу прочитать» (`getLibraryView('want')`, the same list as `/library/want`: opened / read books drop out), `/following` = «Новое у любимых» (`getFollowingNewBooks` with the profile content languages; the first page marks it seen like `/library/following`), `/recommended`; pagination / back via the `*-list` search states in `src/services/telegram-bot.js`. Bot only (needs a linked account) — Android has its own screens for these lists. Web topbar on phones (≤ 900 px) shows the signed-in user as a chip (`.topbar-user-chip`: initial + name, initial only ≤ 340 px) linking to `/profile`, so the name is visible without opening the drawer (outlined on `/profile`); the bottom tab bar has no «Профиль» tab any more (signed in: Главная · Каталог · Библиотека) — web only |

## Sending a book card

- `POST /api/send-to-telegram/:id` (also `/api/send-to-telegram/b64/<ref>`) — web «В Telegram» button: sends the same book card the bot shows in search (cover + annotation + one `dl:` button per available format, 3 per row; the file arrives on button press) to the Telegram account linked in the profile. Errors (`code`): `TELEGRAM_DISABLED` 400, `TELEGRAM_DENIED` 403, `TELEGRAM_NOT_LINKED` 400 (+`linkUrl`), `TELEGRAM_SEND_FAILED` 500, `SEND_IN_PROGRESS` 429. `dl:` keys live in the bot process memory, so with `CLUSTER_WORKERS>1` the card must be sent from the worker that polls the bot. Not used by the Android reader. `POST /api/send-to-telegram/batch` `{ ids[] }` (max `TELEGRAM_BATCH_MAX` = 20) sends one card per book sequentially → `{ ok, message, requested, sent, skipped, partial }`, same error codes. Web list rows, cover cards (replaces «Подробнее»; anonymous users keep «Подробнее») and the selection toolbar show one «Отправить» menu (email + Telegram) like the book page; a single available target stays a plain button. Catalog / library pages allow multi-select in both cover and list view
