/**
 * System event logging and querying.
 */
import { db } from '../db.js';
import { SYSTEM_EVENTS_MAX_COUNT, SYSTEM_EVENTS_RETAIN_COUNT } from '../constants.js';
import { config } from '../config.js';
import { emitRuntimeLog } from './runtime-logs.js';

const systemEventSubscribers = new Set();
const MAX_EVENT_SUBSCRIBERS = 50;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function toLocalHumanTimestamp(input = new Date()) {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return '';
  const day = pad2(date.getDate());
  const month = pad2(date.getMonth() + 1);
  const year = date.getFullYear();
  const hours = pad2(date.getHours());
  const minutes = pad2(date.getMinutes());
  const seconds = pad2(date.getSeconds());
  return `${day}.${month}.${year} ${hours}:${minutes}:${seconds}`;
}

function normalizeEventTimestamp(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) {
    return `${raw.replace(' ', 'T')}Z`;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(raw)) {
    return `${raw}Z`;
  }
  return raw;
}

export function subscribeSystemEvents(listener) {
  if (typeof listener !== 'function') return () => {};
  if (systemEventSubscribers.size >= MAX_EVENT_SUBSCRIBERS) {
    console.warn(`[system-events] subscriber limit reached (${MAX_EVENT_SUBSCRIBERS}), rejecting new subscription`);
    return () => {};  // no-op unsubscribe
  }
  systemEventSubscribers.add(listener);
  return () => systemEventSubscribers.delete(listener);
}

function publishSystemEvent(event) {
  for (const listener of [...systemEventSubscribers]) {
    try {
      listener(event);
    } catch {
      // Isolate subscriber failures.
    }
  }
}

export function logSystemEvent(level, category, message, details = '') {
  try {
    const det = details ? (typeof details === 'string' ? details : JSON.stringify(details)) : '';
    const objectDetails = typeof details === 'object' && details !== null;
    const line = objectDetails
      ? `[${category}] ${message}`
      : `[${category}] ${message}${det ? ` ${det}` : ''}`;
    emitRuntimeLog(level, line, 'system-event', {
      category,
      systemEvent: true,
      ...(objectDetails ? { details } : {})
    });
  } catch {
    // Runtime log channel should never break system events.
  }
  if (config.eventsLogStdout) {
    let detStr = '';
    if (details !== undefined && details !== null && details !== '') {
      detStr = typeof details === 'string' ? details : JSON.stringify(details);
      if (detStr.length > 800) detStr = `${detStr.slice(0, 800)}…`;
    }
    const line = `[system-event] ${toLocalHumanTimestamp()} ${level} [${category}] ${message}${detStr ? ` ${detStr}` : ''}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }
  try {
    const result = db.prepare(`
      INSERT INTO system_events(level, category, message, details)
      VALUES(?, ?, ?, ?)
    `).run(level, category, message, details ? JSON.stringify(details) : null);
    publishSystemEvent({
      id: Number(result.lastInsertRowid || 0),
      level,
      category,
      message,
      details: details ? JSON.stringify(details) : null,
      createdAt: new Date().toISOString()
    });
    db.prepare(`
      DELETE FROM system_events
      WHERE id NOT IN (
        SELECT id FROM system_events ORDER BY id DESC LIMIT ?
      )
    `).run(SYSTEM_EVENTS_MAX_COUNT);
  } catch (error) {
    console.error('Failed to write system event', error);
  }
}

export function getSystemEventCategories() {
  return db.prepare(`
    SELECT DISTINCT category
    FROM system_events
    ORDER BY category COLLATE NOCASE ASC
  `).all().map((row) => row.category).filter(Boolean);
}

/** Parse query filters for /admin/events and GET /api/admin/system-events */
export function parseSystemEventsFilters(query = {}) {
  const preset = String(query.preset || '').trim();
  let level = String(query.level || '').trim().toLowerCase();
  let category = String(query.category || '').trim();
  if (preset === 'errors') {
    level = 'error';
  } else if (preset === 'operations') {
    category = 'operations';
  } else if (preset === 'auth') {
    category = 'auth';
  }
  return { level, category, preset };
}

export function getRecentSystemEvents({ page = 1, pageSize = 30, level = '', category = '' } = {}) {
  const conditions = [];
  const params = [];

  if (level) {
    conditions.push('level = ?');
    params.push(level);
  }
  if (category) {
    conditions.push('category = ?');
    params.push(category);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = db.prepare(`
    SELECT COUNT(*) AS count FROM system_events ${whereClause}
  `).get(...params).count;

  const offset = Math.max(0, (page - 1) * pageSize);
  const itemsRaw = db.prepare(`
    SELECT id, level, category, message, details, created_at AS createdAt
    FROM system_events ${whereClause}
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);
  const items = itemsRaw.map((row) => {
    return {
      ...row,
      createdAt: normalizeEventTimestamp(row.createdAt)
    };
  });

  return { total, items };
}

export function retainRecentSystemEvents(limit = SYSTEM_EVENTS_RETAIN_COUNT) {
  return db.prepare(`
    DELETE FROM system_events
    WHERE id NOT IN (
      SELECT id FROM system_events ORDER BY id DESC LIMIT ?
    )
  `).run(limit).changes;
}

export function clearSystemEventsTable() {
  return db.prepare('DELETE FROM system_events').run().changes;
}
