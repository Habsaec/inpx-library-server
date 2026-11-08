import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBotButtons, botButtonsMarkup } from '../src/telegram-bot-buttons.js';

test('bot buttons: rows, commands, links and site pages', () => {
  const raw = [
    '📚 Полки | /shelves',
    '⭐ Избранное | /favorites',
    '',
    '🆕 Новинки | site:/library/recent',
    'Сайт | https://example.com/a?b=1',
  ].join('\n');
  const { rows, errors } = parseBotButtons(raw);
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].map((b) => b.kind), ['cmd', 'cmd']);

  const markup = botButtonsMarkup(raw, 'https://lib.example/');
  assert.deepEqual(markup.inline_keyboard[0][0], { text: '📚 Полки', callback_data: 'bc:shelves' });
  assert.equal(markup.inline_keyboard[1][0].url, 'https://lib.example/library/recent');
  assert.equal(markup.inline_keyboard[1][1].url, 'https://example.com/a?b=1');

  // без публичного URL кнопка site: пропускается, остальные остаются
  const noBase = botButtonsMarkup(raw, '');
  assert.equal(noBase.inline_keyboard[1].length, 1);
});

test('bot buttons: invalid lines are reported, empty input gives no markup', () => {
  const { errors } = parseBotButtons('без действия\nX | /nope\nY | javascript:alert(1)\n | /help');
  assert.equal(errors.length, 4);
  assert.equal(botButtonsMarkup('', 'https://x'), null);
  assert.equal(parseBotButtons('a | /help\nb | /me\nc | /want\nd | /shelves').errors.length, 1);
});
