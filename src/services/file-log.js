import fs from 'node:fs';
import util from 'node:util';
import path from 'node:path';
import { config } from '../config.js';
import { rotateIfNeeded } from '../utils/log-rotate.js';

/** Строки с этими маркерами дублируются в data/index.log (индексация без консоли). */
const MIRROR_MARKERS = [
  '[index]',
  '[sidecar]',
  '[folder-index]',
  '[folder-indexer]',
  'Error indexing source',
  '[FTS]',
  '[analyze]',
  '[backfill]'
];

function formatArg(a) {
  if (a instanceof Error) {
    return a.stack || a.message || String(a);
  }
  if (typeof a === 'string') return a;
  try {
    return util.inspect(a, { depth: 3, maxArrayLength: 30, breakLength: 120 });
  } catch {
    return String(a);
  }
}

function shouldMirror(merged) {
  return MIRROR_MARKERS.some((m) => merged.includes(m));
}

let installed = false;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function localHumanTimestamp() {
  const date = new Date();
  const day = pad2(date.getDate());
  const month = pad2(date.getMonth() + 1);
  const year = date.getFullYear();
  const hours = pad2(date.getHours());
  const minutes = pad2(date.getMinutes());
  const seconds = pad2(date.getSeconds());
  return `${day}.${month}.${year} ${hours}:${minutes}:${seconds}`;
}

/** Путь файла дневника индексации или null, если отключено (INDEX_LOG_FILE=0). */
export function getIndexLogPathForAppend() {
  const override = process.env.INDEX_LOG_FILE;
  if (override === '0' || override === 'false') return null;
  if (override && String(override).trim() !== '' && override !== '1') {
    return path.resolve(String(override).trim());
  }
  return path.join(config.dataDir, 'index.log');
}

/** Запись в index.log в обход фильтра shouldMirror (удобно для «сердцебиения» внутри тяжёлых чанков). */
export function appendIndexDiaryLine(text) {
  safeAppendText(getIndexLogPathForAppend(), `[${localHumanTimestamp()}] DIA ${text}\n`);
}

function safeAppendText(logPath, line) {
  if (!logPath) return;
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    rotateIfNeeded(logPath);
    fs.appendFileSync(logPath, line, 'utf8');
  } catch {
    /* нет места и т.п. */
  }
}

/**
 * Дублирует в файл часть console.log / warn / error, связанную с индексацией.
 * Выключить: INDEX_LOG_FILE=0
 * Свой путь: INDEX_LOG_FILE=D:\path\to\my-index.log
 */
export function mirrorIndexingLogsToDataFile() {
  if (installed) return;
  const logPath = getIndexLogPathForAppend();
  if (!logPath) return;

  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  const origWarn = console.warn.bind(console);

  const append = (level, args) => {
    const text = args.map(formatArg).join(' ');
    if (!shouldMirror(text)) return;
    safeAppendText(logPath, `[${localHumanTimestamp()}] ${level} ${text}\n`);
  };

  console.log = (...args) => {
    append('LOG', args);
    origLog(...args);
  };
  console.error = (...args) => {
    append('ERR', args);
    origErr(...args);
  };
  console.warn = (...args) => {
    append('WRN', args);
    origWarn(...args);
  };

  installed = true;
  origLog(`[log] Индексация и связанные сообщения пишутся в файл: ${logPath}`);
  safeAppendText(
    logPath,
    `\n---------- ${localHumanTimestamp()} сервер запущен ----------\n` +
      `Файл лога индексации (откройте в Блокноте): ${logPath}\n`
  );
}
