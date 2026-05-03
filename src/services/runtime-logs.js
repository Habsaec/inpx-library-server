import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import { config } from '../config.js';
import { rotateIfNeeded } from '../utils/log-rotate.js';

const MAX_RUNTIME_LOGS = 5000;
const runtimeLogs = [];
const runtimeLogSubscribers = new Set();
const runtimeLogPath = path.join(config.dataDir, 'runtime.log');
let nextRuntimeLogId = 1;
let installed = false;
const hostname = (() => {
  try {
    return os.hostname();
  } catch {
    return '';
  }
})();

function pad2(v) {
  return String(v).padStart(2, '0');
}

function pad3(v) {
  return String(v).padStart(3, '0');
}

function localTimestamp(input = new Date()) {
  const d = input instanceof Date ? input : new Date(input);
  const day = pad2(d.getDate());
  const mon = pad2(d.getMonth() + 1);
  const y = d.getFullYear();
  const h = pad2(d.getHours());
  const m = pad2(d.getMinutes());
  const s = pad2(d.getSeconds());
  const ms = pad3(d.getMilliseconds());
  return `${day}.${mon}.${y} ${h}:${m}:${s}.${ms}`;
}

function truncateStr(s, max) {
  const t = String(s);
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function sanitizeMetaValue(value, depth) {
  if (depth <= 0) return '[max-depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncateStr(value, 6000);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncateStr(value.message || '', 2000),
      stack: truncateStr(value.stack || '', 8000)
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeMetaValue(item, depth - 1));
  }
  if (typeof value === 'object') {
    const out = {};
    let n = 0;
    for (const [k, v] of Object.entries(value)) {
      if (n++ >= 40) {
        out._truncatedKeys = true;
        break;
      }
      out[truncateStr(k, 120)] = sanitizeMetaValue(v, depth - 1);
    }
    return out;
  }
  return truncateStr(String(value), 500);
}

function sanitizeMeta(meta) {
  if (meta == null) return undefined;
  if (Array.isArray(meta)) {
    const list = sanitizeMetaValue(meta, 5);
    return Array.isArray(list) && list.length ? { list } : undefined;
  }
  if (typeof meta !== 'object') return undefined;
  const cleaned = sanitizeMetaValue(meta, 5);
  return cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned) && Object.keys(cleaned).length
    ? cleaned
    : undefined;
}

function normalizeLevel(level = 'info') {
  const v = String(level || '').toLowerCase();
  if (v === 'error' || v === 'warn' || v === 'debug') return v;
  return 'info';
}

function formatArg(value) {
  if (value instanceof Error) return value.stack || value.message || String(value);
  if (typeof value === 'string') return value;
  try {
    return util.inspect(value, { depth: 4, maxArrayLength: 40, breakLength: 120 });
  } catch {
    return String(value);
  }
}

function publishRuntimeLog(entry) {
  for (const sub of [...runtimeLogSubscribers]) {
    try {
      sub(entry);
    } catch {
      // Isolate subscriber failures.
    }
  }
}

function appendFileLine(line) {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    rotateIfNeeded(runtimeLogPath);
    fs.appendFileSync(runtimeLogPath, line + '\n', 'utf8');
  } catch {
    // Ignore I/O errors in logging path.
  }
}

export function emitRuntimeLog(level, message, source = 'app', meta = null) {
  const normalizedLevel = normalizeLevel(level);
  const text = String(message || '').trim().slice(0, 12000);
  if (!text) return;
  const now = new Date();
  const metaClean = sanitizeMeta(meta);
  const entry = {
    id: nextRuntimeLogId++,
    level: normalizedLevel,
    source: String(source || 'app'),
    message: text,
    createdAt: localTimestamp(now),
    createdAtIso: now.toISOString(),
    pid: process.pid,
    hostname: hostname || undefined,
    uptimeSec: Math.round(process.uptime()),
    ...(metaClean ? { meta: metaClean } : {})
  };
  runtimeLogs.push(entry);
  if (runtimeLogs.length > MAX_RUNTIME_LOGS) {
    runtimeLogs.splice(0, runtimeLogs.length - MAX_RUNTIME_LOGS);
  }
  let fileLine = `[${entry.createdAt}] ${entry.level.toUpperCase()} [${entry.source}] pid=${entry.pid}${entry.hostname ? ` host=${entry.hostname}` : ''} ${entry.message}`;
  if (metaClean) {
    try {
      const metaJson = JSON.stringify(metaClean);
      fileLine += metaJson.length <= 3500 ? ` | meta=${metaJson}` : ` | meta=${truncateStr(metaJson, 3500)}`;
    } catch {
      fileLine += ' | meta=[unserializable]';
    }
  }
  appendFileLine(fileLine);
  publishRuntimeLog(entry);
}

export function subscribeRuntimeLogs(listener) {
  if (typeof listener !== 'function') return () => {};
  runtimeLogSubscribers.add(listener);
  return () => runtimeLogSubscribers.delete(listener);
}

export function getRecentRuntimeLogs(limit = 400) {
  const safeLimit = Math.max(1, Math.min(5000, Math.floor(Number(limit) || 400)));
  return runtimeLogs.slice(-safeLimit);
}

export function getRuntimeLogFilePath() {
  return runtimeLogPath;
}

export function installRuntimeLogCapture() {
  if (installed) return;

  const origLog = console.log.bind(console);
  const origInfo = console.info.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  const origDebug = console.debug ? console.debug.bind(console) : null;

  const wrap = (orig, level) => (...args) => {
    try {
      if (!args.length) {
        emitRuntimeLog(level, '(empty console line)', 'console');
      } else if (args.length === 1) {
        emitRuntimeLog(level, formatArg(args[0]), 'console');
      } else {
        const head = formatArg(args[0]);
        const rest = args.slice(1).map((arg) => {
          try {
            return typeof arg === 'string' ? arg : util.inspect(arg, {
              depth: 5,
              maxArrayLength: 40,
              breakLength: 100,
              maxStringLength: 2000
            });
          } catch {
            return String(arg);
          }
        });
        emitRuntimeLog(level, head, 'console', { args: rest, argCount: args.length });
      }
    } catch {
      // Ignore capture failures.
    }
    orig(...args);
  };

  console.log = wrap(origLog, 'info');
  console.info = wrap(origInfo, 'info');
  console.warn = wrap(origWarn, 'warn');
  console.error = wrap(origError, 'error');
  if (origDebug) {
    console.debug = wrap(origDebug, 'debug');
  }

  process.on('uncaughtExceptionMonitor', (error) => {
    emitRuntimeLog('error', `[uncaughtException] ${formatArg(error)}`, 'process', { kind: 'uncaughtException' });
  });
  process.on('unhandledRejection', (reason) => {
    emitRuntimeLog('error', `[unhandledRejection] ${formatArg(reason)}`, 'process', { kind: 'unhandledRejection' });
  });

  emitRuntimeLog('info', `Runtime logging enabled: ${runtimeLogPath}`, 'runtime', {
    dataDir: config.dataDir,
    node: process.version
  });
  installed = true;
}

