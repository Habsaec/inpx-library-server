/**
 * Express 4 does not catch a rejected promise from an `async` route handler: the client gets no
 * response until it times out, and with the process-level handler in `server-entry.js` an
 * unhandled rejection ends the worker. The project has already lived through this — 2.17.0 lists
 * it under Fixed: "an OPDS feed with HTML in the annotation was invalid; a feed with an error did
 * not answer until the timeout".
 *
 * So every `async` route handler must either be wrapped in `asyncHandler(...)` or carry a
 * `try/catch` of its own (a `catch` that answers, or one that calls `next`). This test reads the
 * source and holds that line; it is static and deterministic, no server is started.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILES = [
  ...fs.readdirSync(path.join(ROOT, 'src', 'routes'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join('src', 'routes', name)),
  path.join('src', 'server.js')
];

/** The body of one registration: from the `app.<verb>(` line to its closing `});`. */
function registrationBody(lines, start) {
  let body = '';
  for (let i = start; i < Math.min(lines.length, start + 500); i++) {
    body += lines[i] + '\n';
    if (/^\s{2}\}\);\s*$/.test(lines[i])) break;
    if (/^\s{4}\}\);\s*$/.test(lines[i])) break;
  }
  return body;
}

test('every async route handler catches its own rejections', () => {
  const violations = [];
  for (const file of FILES) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!/app\.(get|post|put|patch|delete|all)\(/.test(line)) return;
      if (!/async\s*\([^)]*\)\s*=>/.test(line) && !/async\s+function/.test(line)) return;
      if (/asyncHandler\s*\(/.test(line)) return;
      const body = registrationBody(lines, index);
      /* A `catch` anywhere in the handler is enough: it either answers or forwards through next.
         Checking the call site instead (`next(` present) would flag the handlers that answer
         themselves with apiFail, which is a deliberate pattern here. */
      if (/\bcatch\s*\(/.test(body)) return;
      violations.push(`${file}:${index + 1} ${line.trim().slice(0, 110)}`);
    });
  }
  assert.deepEqual(violations, [], 'async route handlers must use asyncHandler() or try/catch');
});
