/**
 * Portable backups kept on disk: `data/backups/portable/inpx-portable-<stamp>.jsonl.gz`, a daily schedule and
 * their own rotation. The names never match `library-*.db`, so the keep-5 rotation of the database safety
 * copies (`createDatabaseBackup`) and this one cannot delete each other's files.
 */
import cluster from 'node:cluster';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getSetting, setSetting, getMeta, setMeta, encryptValue, decryptValue } from '../db.js';
import { writePortableBackupFile } from './portable-backup.js';
import { deriveBackupKey, newSalt, MIN_PASSWORD_LENGTH } from './portable-backup-crypto.js';
import { logSystemEvent } from './system-events.js';

const NAME_RE = /^inpx-portable-[0-9TZ-]{10,40}\.jsonl\.gz(\.enc)?$/;
const DEFAULT_KEEP = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const LAST_META = 'portable_backup_last_ok';

/* ── backup password: only the derived key (encrypted with the install key) + salt are stored ── */

export function hasBackupPassword() {
  return Boolean(getSetting('backup_key') && getSetting('backup_key_salt'));
}

export function setBackupPassword(password) {
  const text = String(password || '');
  if (text.length < MIN_PASSWORD_LENGTH) {
    const err = new Error('Password too short');
    err.code = 'BACKUP_PASSWORD_SHORT';
    throw err;
  }
  const salt = getSetting('backup_key_salt') ? Buffer.from(getSetting('backup_key_salt'), 'hex') : newSalt();
  setSetting('backup_key_salt', salt.toString('hex'));
  setSetting('backup_key', encryptValue(deriveBackupKey(text, salt).toString('hex')));
}

export function clearBackupPassword() {
  setSetting('backup_key', '');
  setSetting('backup_key_salt', '');
}

/** { key, salt } for writePortableBackup, or null when no password is set (plain file, no secrets). */
export function getBackupEncryption() {
  const saltHex = getSetting('backup_key_salt');
  const keyHex = decryptValue(getSetting('backup_key'));
  if (!saltHex || !keyHex) return null;
  return { key: Buffer.from(keyHex, 'hex'), salt: Buffer.from(saltHex, 'hex') };
}

export function portableBackupDir() {
  return path.join(config.dataDir, 'backups', 'portable');
}

export function getPortableBackupSchedule() {
  const enabled = getSetting('portable_backup_enabled');
  const keep = Math.floor(Number(getSetting('portable_backup_keep')));
  return {
    enabled: enabled == null || enabled === '' ? true : enabled === '1',
    keep: Number.isFinite(keep) && keep >= 1 && keep <= 60 ? keep : DEFAULT_KEEP
  };
}

export function savePortableBackupSchedule({ enabled, keep }) {
  const n = Math.floor(Number(keep));
  setSetting('portable_backup_enabled', enabled ? '1' : '0');
  setSetting('portable_backup_keep', String(Number.isFinite(n) ? Math.min(60, Math.max(1, n)) : DEFAULT_KEEP));
}

/** Strict name check: only files this module created, no path separators. */
export function resolvePortableBackupPath(name) {
  const clean = String(name || '');
  if (!NAME_RE.test(clean)) return null;
  return path.join(portableBackupDir(), clean);
}

export async function listPortableBackups() {
  let names = [];
  try { names = await fs.promises.readdir(portableBackupDir()); } catch { return []; }
  const out = [];
  for (const name of names.filter((n) => NAME_RE.test(n))) {
    const stat = await fs.promises.stat(path.join(portableBackupDir(), name)).catch(() => null);
    if (stat?.isFile()) out.push({ name, size: stat.size, mtime: stat.mtime.toISOString(), encrypted: name.endsWith('.enc') });
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

async function rotate(keep) {
  const all = await listPortableBackups();
  for (const old of all.slice(keep)) {
    await fs.promises.unlink(path.join(portableBackupDir(), old.name)).catch(() => {});
  }
}

let running = false;

/** Writes one backup file now and applies the rotation. Single-flight. */
export async function createPortableBackupNow({ reason = 'manual', appVersion = '' } = {}) {
  if (running) {
    const err = new Error('A backup is already running');
    err.code = 'BACKUP_BUSY';
    throw err;
  }
  running = true;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const encryption = getBackupEncryption();
    const name = `inpx-portable-${stamp}.jsonl.gz${encryption ? '.enc' : ''}`;
    const counts = await writePortableBackupFile(path.join(portableBackupDir(), name), { appVersion, encryption });
    setMeta(LAST_META, new Date().toISOString());
    await rotate(getPortableBackupSchedule().keep);
    logSystemEvent('info', 'backup', 'portable backup written', { reason, name, counts });
    return { name, counts };
  } finally {
    running = false;
  }
}

export async function deletePortableBackup(name) {
  const full = resolvePortableBackupPath(name);
  if (!full) return false;
  await fs.promises.unlink(full);
  return true;
}

export function isPortableBackupRunning() {
  return running;
}

let timer = null;

/** Daily backup: checked every hour, first check 10 minutes after boot; worker 1 only in a cluster. */
export function startPortableBackupSchedule({ appVersion = '' } = {}) {
  if (timer || (cluster.isWorker && cluster.worker.id !== 1)) return;
  const tick = async () => {
    try {
      const { enabled } = getPortableBackupSchedule();
      if (!enabled) return;
      const last = Date.parse(getMeta(LAST_META) || '') || 0;
      if (Date.now() - last < DAY_MS - 5 * 60_000) return;
      await createPortableBackupNow({ reason: 'schedule', appVersion });
    } catch (error) {
      if (error?.code !== 'BACKUP_BUSY') {
        logSystemEvent('warn', 'backup', 'scheduled portable backup failed', { error: error.message });
      }
    }
  };
  timer = setInterval(() => { void tick(); }, 60 * 60_000);
  timer.unref?.();
  setTimeout(() => { void tick(); }, 10 * 60_000).unref?.();
}

export function stopPortableBackupSchedule() {
  if (timer) clearInterval(timer);
  timer = null;
}
