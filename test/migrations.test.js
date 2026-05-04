import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  runMigrations,
  getCurrentSchemaVersion,
  setSchemaVersion
} from '../src/services/migrations.js';

function makeDb() {
  return new Database(':memory:');
}

test('runMigrations applies pending migrations in order', () => {
  const db = makeDb();
  const order = [];
  const migrations = [
    {
      version: 1, name: 'create_t1',
      up(d) { d.exec('CREATE TABLE t1 (id INTEGER)'); order.push(1); }
    },
    {
      version: 2, name: 'create_t2',
      up(d) { d.exec('CREATE TABLE t2 (id INTEGER)'); order.push(2); }
    }
  ];
  const result = runMigrations(db, migrations);
  assert.deepEqual(result.applied, [1, 2]);
  assert.equal(result.current, 2);
  assert.deepEqual(order, [1, 2]);
  // Idempotent re-run
  const result2 = runMigrations(db, migrations);
  assert.deepEqual(result2.applied, []);
  assert.equal(result2.current, 2);
});

test('runMigrations skips already-applied versions', () => {
  const db = makeDb();
  setSchemaVersion(db, 5);
  const calls = [];
  const migrations = [
    { version: 3, name: 'old', up() { calls.push(3); } },
    { version: 5, name: 'same', up() { calls.push(5); } },
    { version: 7, name: 'new', up() { calls.push(7); } }
  ];
  const result = runMigrations(db, migrations);
  assert.deepEqual(result.applied, [7]);
  assert.deepEqual(calls, [7]);
  assert.equal(getCurrentSchemaVersion(db), 7);
});

test('runMigrations is transactional: failed migration rolls back', () => {
  const db = makeDb();
  const migrations = [
    {
      version: 1, name: 'good',
      up(d) { d.exec('CREATE TABLE good (id INTEGER)'); }
    },
    {
      version: 2, name: 'bad',
      up(d) {
        d.exec('CREATE TABLE bad (id INTEGER)');
        throw new Error('boom');
      }
    }
  ];
  assert.throws(() => runMigrations(db, migrations), /boom/);
  // version stays at 1 (good was applied)
  assert.equal(getCurrentSchemaVersion(db), 1);
  // bad table was rolled back
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
  assert.ok(tables.includes('good'));
  assert.ok(!tables.includes('bad'));
});

test('runMigrations rejects duplicate or invalid versions', () => {
  const db = makeDb();
  assert.throws(() => runMigrations(db, [
    { version: 1, name: 'a', up() {} },
    { version: 1, name: 'b', up() {} }
  ]), /Duplicate/);
  assert.throws(() => runMigrations(db, [
    { version: 0, name: 'zero', up() {} }
  ]), /Invalid migration version/);
  assert.throws(() => runMigrations(db, [
    { version: 1, name: 'no-up' }
  ]), /must define up/);
});

test('runMigrations with empty migration list is a no-op', () => {
  const db = makeDb();
  const result = runMigrations(db, []);
  assert.deepEqual(result.applied, []);
  assert.equal(result.current, 0);
});
