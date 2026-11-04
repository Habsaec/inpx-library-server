/**
 * Optional encryption of a portable backup with a password the admin sets once.
 *
 * File layout: "INPXENC1" (8) + salt (16) + iv (12) + AES-256-GCM ciphertext of the gzip stream + auth tag (16).
 * The key is scrypt(password, salt). The server keeps only the derived key (itself encrypted with the install
 * key) and the salt, never the password, so scheduled backups can be encrypted without asking; to restore on
 * another server the admin types the password again and the key is derived from the salt in the file header.
 * GCM only verifies at the very end, so `openEncryptedBackup` reads the whole file once to check the tag
 * before any row is applied.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Transform } from 'node:stream';

export const ENC_MAGIC = Buffer.from('INPXENC1');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = ENC_MAGIC.length + SALT_LEN + IV_LEN;
export const MIN_PASSWORD_LENGTH = 8;

export class BackupPasswordError extends Error {
  constructor(message = 'Wrong backup password') {
    super(message);
    this.code = 'BACKUP_PASSWORD';
  }
}

export function newSalt() {
  return crypto.randomBytes(SALT_LEN);
}

export function deriveBackupKey(password, salt) {
  return crypto.scryptSync(String(password), salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
}

/** Transform that writes header + ciphertext + tag. */
export function createEncryptTransform(key, salt) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let started = false;
  return new Transform({
    transform(chunk, _enc, cb) {
      if (!started) {
        started = true;
        this.push(Buffer.concat([ENC_MAGIC, salt, iv]));
      }
      cb(null, cipher.update(chunk));
    },
    flush(cb) {
      if (!started) this.push(Buffer.concat([ENC_MAGIC, salt, iv]));
      this.push(cipher.final());
      this.push(cipher.getAuthTag());
      cb();
    }
  });
}

export function isEncryptedBackupFile(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(ENC_MAGIC.length);
      fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.equals(ENC_MAGIC);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < HEADER_LEN + TAG_LEN) return null;
    const head = Buffer.alloc(HEADER_LEN);
    fs.readSync(fd, head, 0, HEADER_LEN, 0);
    const tag = Buffer.alloc(TAG_LEN);
    fs.readSync(fd, tag, 0, TAG_LEN, size - TAG_LEN);
    if (!head.subarray(0, ENC_MAGIC.length).equals(ENC_MAGIC)) return null;
    return {
      size,
      salt: head.subarray(ENC_MAGIC.length, ENC_MAGIC.length + SALT_LEN),
      iv: head.subarray(ENC_MAGIC.length + SALT_LEN, HEADER_LEN),
      tag
    };
  } finally {
    fs.closeSync(fd);
  }
}

function decipherStream(file, key, head) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, head.iv);
  decipher.setAuthTag(head.tag);
  const source = fs.createReadStream(file, { start: HEADER_LEN, end: head.size - TAG_LEN - 1 });
  source.on('error', (e) => decipher.destroy(e));
  return source.pipe(decipher);
}

/**
 * Verifies password + integrity (one full pass), then returns a fresh stream of the decrypted gzip bytes.
 * @throws BackupPasswordError when the password is wrong or the file was modified
 */
export async function openEncryptedBackup(file, password) {
  const head = readHeader(file);
  if (!head) throw new BackupPasswordError('Not an encrypted backup');
  if (!password) throw new BackupPasswordError('Backup password required');
  const key = deriveBackupKey(password, head.salt);
  await new Promise((resolve, reject) => {
    const s = decipherStream(file, key, head);
    s.on('data', () => {});
    s.on('end', resolve);
    s.on('error', () => reject(new BackupPasswordError()));
  });
  return decipherStream(file, key, head);
}

/** Plain gzip file or encrypted one → Readable of gzip bytes. */
export async function openBackupSource(file, password) {
  if (isEncryptedBackupFile(file)) return openEncryptedBackup(file, password);
  return fs.createReadStream(file);
}
