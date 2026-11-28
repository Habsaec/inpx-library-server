import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundledNode = path.join(rootDir, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
const nodeBin = fs.existsSync(bundledNode) ? bundledNode : process.execPath;
const testDir = path.join(rootDir, 'test');
const testEnvUrl = pathToFileURL(path.join(testDir, 'test-env.js')).href;
const testFiles = fs.readdirSync(testDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
  .map((entry) => path.join(testDir, entry.name))
  .sort();

const result = spawnSync(
  nodeBin,
  [
    '--import',
    testEnvUrl,
    '--test',
    ...coverageArgs(),
    ...testFiles,
  ],
  { cwd: rootDir, stdio: 'inherit' }
);

process.exit(result.status ?? 1);

/**
 * `node scripts/run-tests.js --coverage` prints the built-in coverage report for the server
 * code only (src/**), so the percentage means "the shipped code", not "the tests themselves".
 * No extra dependency: Node 24 reports coverage natively.
 */
function coverageArgs() {
  if (!process.argv.includes('--coverage')) return [];
  return [
    '--experimental-test-coverage',
    '--test-coverage-include=src/**',
    '--test-coverage-exclude=test/**',
    /* A floor, not a target: the numbers now are ~73 / 68 / 73, so a drop of three points fails CI.
       Raise them when the suite gets better, never lower to make a red build green. */
    '--test-coverage-lines=70',
    '--test-coverage-branches=66',
    '--test-coverage-functions=69',
  ];
}

