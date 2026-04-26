#!/usr/bin/env node
/**
 * Lightweight HTTP load tester. Hits configured endpoints with N concurrent
 * workers for D seconds; reports latency percentiles and RPS per endpoint.
 *
 * Usage: node scripts/load-test.js [--base=http://localhost:3000] [--duration=20] [--concurrency=16]
 */

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));

const BASE = args.base || 'http://localhost:3000';
const DURATION_MS = Number(args.duration || 15) * 1000;
const CONCURRENCY = Number(args.concurrency || 16);
const COOKIE = args.cookie || '';
const HEADERS = COOKIE ? { Cookie: COOKIE } : {};

const ENDPOINTS = [
  { name: 'home',          path: '/' },
  { name: 'catalog',       path: '/catalog' },
  { name: 'catalog-q',     path: '/catalog?q=война&field=title' },
  { name: 'catalog-page',  path: '/catalog?page=5' },
  { name: 'authors',       path: '/authors' },
  { name: 'series',        path: '/series' },
  { name: 'genres',        path: '/genres' },
  { name: 'health',        path: '/health' },
  { name: 'index-status',  path: '/api/index-status' },
];

function pickEndpoint() { return ENDPOINTS[Math.floor(Math.random() * ENDPOINTS.length)]; }

const stats = new Map(); // endpoint name -> { count, errors, samples: number[] }
function record(name, ms, ok, status) {
  let s = stats.get(name);
  if (!s) { s = { count: 0, errors: 0, samples: [], statuses: {} }; stats.set(name, s); }
  s.count++;
  if (!ok) s.errors++;
  s.samples.push(ms);
  s.statuses[status] = (s.statuses[status] || 0) + 1;
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a,b)=>a-b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

async function worker(deadline) {
  while (Date.now() < deadline) {
    const ep = pickEndpoint();
    const t0 = process.hrtime.bigint();
    let ok = false;
    let status = 0;
    try {
      const res = await fetch(BASE + ep.path, { redirect: 'manual', headers: HEADERS });
      status = res.status;
      // drain body to release sockets
      await res.text();
      ok = res.status < 400;
    } catch {
      ok = false;
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    record(ep.name, ms, ok, status);
  }
}

async function snapshotMem() {
  try {
    const res = await fetch(BASE + '/health/perf');
    const j = await res.json();
    return j;
  } catch { return null; }
}

(async () => {
  console.log(`[load-test] base=${BASE} concurrency=${CONCURRENCY} duration=${DURATION_MS/1000}s`);
  const memBefore = await snapshotMem();
  const deadline = Date.now() + DURATION_MS;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(deadline)));
  const totalMs = Date.now() - t0;
  const memAfter = await snapshotMem();

  let total = 0, errors = 0;
  const rows = [];
  for (const [name, s] of stats) {
    total += s.count;
    errors += s.errors;
    rows.push({
      endpoint: name,
      count: s.count,
      errors: s.errors,
      'p50ms': +pct(s.samples, 0.5).toFixed(1),
      'p95ms': +pct(s.samples, 0.95).toFixed(1),
      'p99ms': +pct(s.samples, 0.99).toFixed(1),
      'maxms': +Math.max(...s.samples).toFixed(1),
      statuses: JSON.stringify(s.statuses),
    });
  }
  rows.sort((a,b)=>b.count - a.count);
  console.log('');
  console.table(rows);
  console.log('');
  console.log(`Total: ${total} req in ${(totalMs/1000).toFixed(1)}s = ${(total/(totalMs/1000)).toFixed(1)} RPS, errors=${errors}`);
  if (memBefore?.perf && memAfter?.perf) {
    console.log('Server perf snapshot before:', JSON.stringify(memBefore.perf, null, 2).slice(0, 500));
    console.log('Server perf snapshot after :', JSON.stringify(memAfter.perf, null, 2).slice(0, 500));
  }
})();
