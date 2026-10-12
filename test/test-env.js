/**
 * Preload for npm test: force an isolated DATA_DIR so tests never touch data/library.db.
 *
 * Usage: node --import <fileURL to this file> --test test/*.test.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!process.env.DATA_DIR) {
  // Fresh dir per process: a pid-named dir gets reused after pid recycling, and tests that
  // insert unique rows (genres_catalog.name, ...) then fail on leftover data from an old run.
  const autoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inpx-test-'));
  process.env.DATA_DIR = autoDir;
  process.on('exit', () => {
    try { fs.rmSync(autoDir, { recursive: true, force: true }); } catch { /* DB may still be open on Windows */ }
  });
}

process.env.INPX_TEST_RUN = '1';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

if (!process.env.INPX_TEST_ROOT) {
  process.env.INPX_TEST_ROOT = rootDir;
}
