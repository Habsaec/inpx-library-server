#!/usr/bin/env node
/**
 * build-release.js
 * Собирает ZIP-архив для чистой установки и обновления через админку.
 *
 * Использование:  node scripts/build-release.js
 * Результат:      release/inpx-library-server-<version>.zip
 */
import fs from 'node:fs';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import archiver from 'archiver';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1')));
const PROJECT = path.resolve(ROOT, '..');

const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT, 'package.json'), 'utf8'));
const version = pkg.version || '0.0.0';
const archiveName = `inpx-library-server-${version}.zip`;
const prefix = `inpx-library-server-${version}`;

const outDir = path.join(PROJECT, 'release');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, archiveName);

// --- Directories to include (recursively) ---
const DIRS = [
  'src',
  'public',
  'scripts',
];

// --- Individual files from project root ---
const ROOT_FILES = [
  'package.json',
  'package-lock.json',
  '.env.example',
  '.dockerignore',
  'Dockerfile',
  'docker-compose.yml',
  'docker-entrypoint.sh',
  'install.sh',
  'install.cmd',
  'start.sh',
  'start-server.cmd',
  'stop.sh',
  'stop-server.cmd',
  'restart.sh',
  'restart-server.cmd',
  'reset-admin.sh',
  'reset-admin.cmd',
  'LICENSE',
  'README.md',
];

// --- Files from subdirectories (not recursively) ---
const EXTRA_FILES = [
  'converter/fb2cng.yaml',
];

// --- Excluded from directory scans ---
const EXCLUDED_NAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  'build-release.js',   // don't include this script itself
]);

console.log(`\n  Building release archive: ${archiveName}`);
console.log(`  Project version: ${version}`);
console.log();

const output = createWriteStream(outPath);
const archive = archiver('zip', { zlib: { level: 9 } });

archive.on('warning', (err) => {
  if (err.code === 'ENOENT') console.warn('  WARN:', err.message);
  else throw err;
});
archive.on('error', (err) => { throw err; });

output.on('close', () => {
  const sizeMB = (archive.pointer() / 1024 / 1024).toFixed(2);
  console.log(`  ✅ ${outPath}`);
  console.log(`     ${sizeMB} MB, ${fileCount} files`);
  console.log();
});

archive.pipe(output);

let fileCount = 0;

// --- Add directories ---
for (const dir of DIRS) {
  const dirPath = path.join(PROJECT, dir);
  if (!fs.existsSync(dirPath)) {
    console.warn(`  WARN: directory ${dir}/ not found, skipping`);
    continue;
  }
  addDirRecursive(dirPath, dir);
}

function addDirRecursive(absDir, relDir) {
  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDED_NAMES.has(entry.name)) continue;
    const absPath = path.join(absDir, entry.name);
    const relPath = relDir + '/' + entry.name;
    if (entry.isDirectory()) {
      addDirRecursive(absPath, relPath);
    } else if (entry.isFile()) {
      archive.file(absPath, { name: `${prefix}/${relPath}` });
      fileCount++;
    }
  }
}

// --- Add root files ---
for (const file of ROOT_FILES) {
  const absPath = path.join(PROJECT, file);
  if (!fs.existsSync(absPath)) {
    console.warn(`  WARN: ${file} not found, skipping`);
    continue;
  }
  archive.file(absPath, { name: `${prefix}/${file}` });
  fileCount++;
}

// --- Add extra files ---
for (const file of EXTRA_FILES) {
  const absPath = path.join(PROJECT, file);
  if (!fs.existsSync(absPath)) {
    console.warn(`  WARN: ${file} not found, skipping`);
    continue;
  }
  archive.file(absPath, { name: `${prefix}/${file}` });
  fileCount++;
}

await archive.finalize();
