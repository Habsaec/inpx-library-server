import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  alignSpokenText,
  cleanTtsText,
  clampTtsRate,
  createMotionDetector,
  formatSleepLeft,
  normalizeTtsSettings,
  parseTtsSsmlSegments,
  prettyVoiceName,
  sleepFadeVolume,
  TTS_SETTING_DEFAULTS,
  wordLengthAt,
} from '../public/reader-shared/reader-tts.js';

const NS = 'xmlns="http://www.w3.org/2001/10/synthesis"';

describe('parseTtsSsmlSegments', () => {
  it('pairs each mark with the sentence that follows it', () => {
    const ssml = `<speak ${NS} xml:lang="ru"><mark name="0"/>Первая фраза. <mark name="1"/>Вторая  фраза.</speak>`;
    assert.deepEqual(parseTtsSsmlSegments(ssml), [
      { mark: '0', text: 'Первая фраза.' },
      { mark: '1', text: 'Вторая фраза.' },
    ]);
  });

  it('keeps unmarked lead text, decodes entities and treats break as a space', () => {
    const ssml = `<speak ${NS}>Вступ<break/>ление <mark name="3"/>Tom &amp; Jerry &#x2014; &lt;ok&gt;<emphasis>!</emphasis></speak>`;
    assert.deepEqual(parseTtsSsmlSegments(ssml), [
      { mark: null, text: 'Вступ ление' },
      { mark: '3', text: 'Tom & Jerry — <ok>!' },
    ]);
  });

  it('handles prefixed elements and empty input', () => {
    assert.deepEqual(parseTtsSsmlSegments('<ns:speak><ns:mark name="7"/>Hi</ns:speak>'), [{ mark: '7', text: 'Hi' }]);
    assert.deepEqual(parseTtsSsmlSegments(''), []);
    assert.deepEqual(parseTtsSsmlSegments(null), []);
  });
});

describe('cleanTtsText', () => {
  it('drops footnote markers and soft hyphens', () => {
    assert.equal(cleanTtsText('Сло­во[12] и {3} ещё*. Конец'), 'Слово и ещё. Конец');
  });
  it('keeps markers when asked', () => {
    assert.equal(cleanTtsText('Слово[12]', { skipNoteRefs: false }), 'Слово[12]');
  });
});

describe('alignSpokenText', () => {
  it('maps spoken chars onto the source and skips extra source chars', () => {
    const spoken = 'Слово и ещё';
    const source = 'Сло­во[12] и ещё';
    const map = alignSpokenText(spoken, source);
    assert.equal(map[0], 0);
    assert.equal(map[3], 4);
    assert.equal(map[5], -1);
    assert.equal(source[map[6]], 'и');
    assert.equal(source[map[10]], 'ё');
  });
});

describe('helpers', () => {
  it('wordLengthAt', () => {
    assert.equal(wordLengthAt('Как-то раз, однажды', 0), 6);
    assert.equal(wordLengthAt('Как-то раз, однажды', 7), 3);
    assert.equal(wordLengthAt('...', 0), 1);
  });

  it('formatSleepLeft', () => {
    assert.equal(formatSleepLeft(65_000), '1:05');
    assert.equal(formatSleepLeft(3_600_000 + 61_000), '1:01:01');
    assert.equal(formatSleepLeft(-5), '0:00');
  });

  it('prettyVoiceName', () => {
    assert.equal(prettyVoiceName({ name: 'ru-ru-x-ruf-local' }), 'ru-RU · ruf');
    assert.equal(prettyVoiceName({ name: 'en-us-x-sfg#male_1-network' }, { network: 'сеть' }), 'en-US · sfg male 1 (сеть)');
    assert.equal(prettyVoiceName({ name: 'ru-RU-language' }, { isDefault: 'по умолчанию' }), 'ru-RU (по умолчанию)');
    assert.equal(prettyVoiceName({ name: 'Google русский', localService: false }, { network: 'сеть' }), 'Google русский (сеть)');
  });

  it('normalizeTtsSettings fills defaults and clamps', () => {
    const s = normalizeTtsSettings({ ttsRate: 9, ttsPitch: 'x', ttsHighlight: 'bogus', ttsParaPause: 5, ttsFollow: false });
    assert.equal(s.ttsRate, 3);
    assert.equal(s.ttsPitch, 1);
    assert.equal(s.ttsHighlight, TTS_SETTING_DEFAULTS.ttsHighlight);
    assert.equal(s.ttsParaPause, 0);
    assert.equal(s.ttsFollow, false);
    assert.equal(s.ttsHlColor, 'yellow');
    assert.equal(clampTtsRate('1.234'), 1.23);
  });
});

describe('sleep timer helpers', () => {
  it('sleepFadeVolume fades only in the last minute', () => {
    assert.equal(sleepFadeVolume(5 * 60_000), 1);
    assert.equal(sleepFadeVolume(60_000), 1);
    assert.equal(sleepFadeVolume(30_000), 0.63);
    assert.equal(sleepFadeVolume(0), 0.25);
    assert.equal(sleepFadeVolume(-1000), 0.25);
  });

  it('createMotionDetector: quiet on a table, fires when the phone is tilted', () => {
    const moved = createMotionDetector();
    const g = 9.81;
    assert.equal(moved(0, 0, g), false);
    for (let i = 0; i < 50; i++) assert.equal(moved(0.01 * (i % 3), -0.01, g + 0.02 * (i % 2)), false);
    const tilt = (deg) => [0, g * Math.sin((deg * Math.PI) / 180), g * Math.cos((deg * Math.PI) / 180)];
    assert.equal(moved(...tilt(4)), true);
  });
});
