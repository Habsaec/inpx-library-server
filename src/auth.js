import crypto from 'node:crypto';

const HASH_ALGORITHM = 'scrypt';
const SCRYPT_KEYLEN = 64;

const MAX_PASSWORD_LENGTH = 1024;

export function hashPassword(password) {
  const normalized = String(password || '');
  if (!normalized) {
    throw new Error('Password is required');
  }
  if (normalized.length > MAX_PASSWORD_LENGTH) {
    throw new Error('Password is too long');
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(normalized, salt, SCRYPT_KEYLEN).toString('hex');
  return `${HASH_ALGORITHM}$${salt}$${derivedKey}`;
}

export function verifyPassword(password, passwordHash) {
  const normalized = String(password || '');
  const stored = String(passwordHash || '');
  if (!normalized || !stored || normalized.length > MAX_PASSWORD_LENGTH) {
    return false;
  }

  const [algorithm, salt, expected] = stored.split('$');
  if (algorithm !== HASH_ALGORITHM || !salt || !expected) {
    return false;
  }

  const derivedKey = crypto.scryptSync(normalized, salt, SCRYPT_KEYLEN).toString('hex');
  const actualBuffer = Buffer.from(derivedKey, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}
