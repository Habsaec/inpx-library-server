/**
 * Formal SQL migrations runner backed by SQLite's PRAGMA user_version.
 *
 * The existing schema is bootstrapped via idempotent `CREATE TABLE IF NOT EXISTS`
 * and `ALTER TABLE` statements in `db.js#initDb()`. This runner is layered on top
 * of that for future *forward-only* schema changes that need versioning,
 * one-time data migrations, or atomic multi-statement upgrades.
 *
 * Each migration is an object: { version: number, name: string, up(db) }.
 * Migrations are applied in ascending order, transactionally, and the version is
 * recorded in PRAGMA user_version. A migration runs at most once.
 *
 * Adding a migration:
 *   1. Append a new entry to MIGRATIONS with version = max+1.
 *   2. Implement `up(db)` using `db.exec(...)` / `db.prepare(...).run(...)`.
 *   3. Restart the server — the runner executes pending migrations on init.
 */

import { logSystemEvent } from './system-events.js';

/** @typedef {{ version: number, name: string, up: (db: import('better-sqlite3').Database) => void }} Migration */

/** @type {Migration[]} */
export const MIGRATIONS = [
  // Example placeholder — keep here for reference. Real migrations get appended below.
  // {
  //   version: 1,
  //   name: 'example_noop',
  //   up(db) { /* db.exec('...'); */ }
  // },
];

export function getCurrentSchemaVersion(db) {
  const row = db.prepare('PRAGMA user_version').get();
  return Number(row?.user_version ?? 0);
}

export function setSchemaVersion(db, version) {
  // PRAGMA does not accept bound parameters; version comes from a number-only constant.
  const safe = Math.max(0, Math.floor(Number(version) || 0));
  db.exec(`PRAGMA user_version = ${safe}`);
}

/**
 * Applies pending migrations in ascending order. Each migration runs in its own
 * transaction; on failure the transaction is rolled back and the error is
 * re-thrown so the caller (server bootstrap) can decide how to handle it.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Migration[]} [migrations]
 * @returns {{ applied: number[], current: number }}
 */
export function runMigrations(db, migrations = MIGRATIONS) {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  // Validate: monotonic, unique, positive integers.
  const seen = new Set();
  for (const m of sorted) {
    if (!Number.isInteger(m.version) || m.version < 1) {
      throw new Error(`Invalid migration version: ${m.version} (${m.name})`);
    }
    if (seen.has(m.version)) {
      throw new Error(`Duplicate migration version: ${m.version}`);
    }
    seen.add(m.version);
    if (typeof m.up !== 'function') {
      throw new Error(`Migration ${m.version} (${m.name}) must define up(db)`);
    }
  }

  const current = getCurrentSchemaVersion(db);
  const pending = sorted.filter((m) => m.version > current);
  const applied = [];

  for (const migration of pending) {
    const tx = db.transaction(() => {
      migration.up(db);
      setSchemaVersion(db, migration.version);
    });
    try {
      tx();
      applied.push(migration.version);
      try {
        logSystemEvent('info', 'db', `migration applied: v${migration.version} (${migration.name})`);
      } catch { /* logger may be unavailable in tests */ }
    } catch (error) {
      try {
        logSystemEvent('error', 'db', `migration failed: v${migration.version} (${migration.name})`, {
          error: error?.message || String(error)
        });
      } catch { /* ignore */ }
      throw error;
    }
  }

  return { applied, current: getCurrentSchemaVersion(db) };
}
