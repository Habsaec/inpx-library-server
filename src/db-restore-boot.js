/**
 * Full database restore, boot half. Imports only node built-ins: it runs from `server-entry.js` BEFORE
 * `db.js` opens `library.db` (a file that is open must never be replaced, and a stale `-wal` left next to
 * a restored file would be replayed into it and corrupt it — so library.db, -wal and -shm move together).
 *
 * The admin side (`services/db-restore.js`) validates a candidate, writes `data/restore-pending.json`
 * and restarts the server. This function then:
 *   1. renames library.db(+wal,+shm) to library.db.pre-restore-<ts> (only when library.db exists, so a
 *      crash between the steps is finished by the next boot — the marker stays until the copy is done)
 *   2. copies (backups/) or moves (restore/ uploads) the candidate to library.db
 *   3. on failure puts the original back, and always leaves data/restore-result.json for the admin page.
 */
import fs from 'node:fs';
import path from 'node:path';

const SOURCE_PATTERNS = [
  { dir: 'backups', re: /^library-[0-9T-]+-[a-z0-9-]+\.db$/, move: false },
  { dir: 'restore', re: /^upload-\d+\.db$/, move: true },
  { dir: '.', re: /^library\.db\.pre-restore-\d+$/, move: false }
];

export const RESTORE_MARKER = 'restore-pending.json';
export const RESTORE_RESULT = 'restore-result.json';

/** `id` = `<dir>/<name>` (dir `backups`, `restore` or `.`). Strict allow-list, never a free path. */
export function resolveRestoreSource(dataDir, id) {
  const text = String(id || '');
  const slash = text.lastIndexOf('/');
  if (slash < 0) return null;
  const dir = text.slice(0, slash);
  const name = text.slice(slash + 1);
  const rule = SOURCE_PATTERNS.find((p) => p.dir === dir && p.re.test(name));
  if (!rule) return null;
  return { id: text, full: path.join(dataDir, rule.dir, name), move: rule.move, name, dir: rule.dir };
}

export function listRestoreSources(dataDir) {
  const out = [];
  for (const rule of SOURCE_PATTERNS) {
    let names = [];
    try { names = fs.readdirSync(path.join(dataDir, rule.dir)); } catch { continue; }
    for (const name of names.filter((n) => rule.re.test(n))) {
      try {
        const stat = fs.statSync(path.join(dataDir, rule.dir, name));
        if (stat.isFile()) out.push({ id: `${rule.dir}/${name}`, name, dir: rule.dir, size: stat.size, mtime: stat.mtime.toISOString() });
      } catch { /* vanished */ }
    }
  }
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function renameWithRetry(from, to) {
  // Windows: the previous process may still be releasing the file for a moment after it exits
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      sleepSync(500);
    }
  }
  throw lastError;
}

const SIDE_FILES = ['', '-wal', '-shm'];

function writeResult(dataDir, result) {
  try {
    fs.writeFileSync(path.join(dataDir, RESTORE_RESULT), JSON.stringify({ ...result, at: new Date().toISOString() }));
  } catch { /* the admin page just shows nothing */ }
}

/**
 * @returns {null | { ok: boolean, message?: string }} null when nothing was pending
 */
export function applyPendingDbRestore(dataDir, log = console) {
  const markerPath = path.join(dataDir, RESTORE_MARKER);
  if (!fs.existsSync(markerPath)) return null;

  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    fs.rmSync(markerPath, { force: true });
    writeResult(dataDir, { ok: false, message: 'marker unreadable' });
    return { ok: false, message: 'marker unreadable' };
  }
  const source = resolveRestoreSource(dataDir, marker.source);
  const dbPath = path.join(dataDir, 'library.db');
  const fail = (message) => {
    fs.rmSync(markerPath, { force: true });
    writeResult(dataDir, { ok: false, message, source: marker.source });
    log.error?.(`[restore] failed: ${message}`);
    return { ok: false, message };
  };

  if (!source || !fs.existsSync(source.full)) return fail('source file is missing');
  const stat = fs.statSync(source.full);
  if (Number(marker.size) && stat.size !== Number(marker.size)) return fail('source file changed after validation');

  const stamp = String(Date.now());
  const original = SIDE_FILES.map((suffix) => ({ from: dbPath + suffix, to: `${dbPath}.pre-restore-${stamp}${suffix}` }));
  const moved = [];
  try {
    if (fs.existsSync(dbPath)) {
      for (const pair of original) {
        if (fs.existsSync(pair.from)) {
          renameWithRetry(pair.from, pair.to);
          moved.push(pair);
        }
      }
    }
    // a leftover -wal/-shm of a database that no longer exists would be replayed into the new file
    for (const suffix of ['-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
    if (source.move) renameWithRetry(source.full, dbPath);
    else fs.copyFileSync(source.full, dbPath);
    if (fs.statSync(dbPath).size !== stat.size) throw new Error('size mismatch after copy');
  } catch (error) {
    try {
      fs.rmSync(dbPath, { force: true });
      for (const pair of moved.reverse()) fs.renameSync(pair.to, pair.from);
    } catch (rollbackError) {
      log.error?.(`[restore] ROLLBACK FAILED: ${rollbackError.message}; original is data/library.db.pre-restore-${stamp}`);
    }
    return fail(error.message);
  }

  fs.rmSync(markerPath, { force: true });
  // keep only the newest pre-restore copy (each one is a full database)
  try {
    for (const name of fs.readdirSync(dataDir)) {
      if (/^library\.db\.pre-restore-\d+(-wal|-shm)?$/.test(name) && !name.includes(`pre-restore-${stamp}`)) {
        fs.rmSync(path.join(dataDir, name), { force: true });
      }
    }
  } catch { /* best effort */ }
  writeResult(dataDir, { ok: true, source: marker.source, preRestore: moved.length ? `library.db.pre-restore-${stamp}` : '' });
  log.log?.(`[restore] database replaced from ${marker.source}`);
  return { ok: true };
}
