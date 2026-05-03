#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const publicDir = path.join(projectRoot, 'public');

const args = new Set(process.argv.slice(2));
const watch = args.has('--watch');
const ifStale = args.has('--if-stale');

/**
 * When invoked with --if-stale, skip the build if every minified output is at
 * least as new as its source. Used by `npm prestart` so that starting the
 * server never serves stale minified assets but the startup penalty is zero
 * when everything is already fresh.
 */
function isOutputFresh(src, out) {
  try {
    if (!existsSync(out)) return false;
    return statSync(out).mtimeMs >= statSync(src).mtimeMs;
  } catch {
    return false;
  }
}

async function main() {
  if (ifStale && !watch) {
    const freshJs = isOutputFresh(path.join(publicDir, 'app.js'), path.join(publicDir, 'app.min.js'));
    const freshCss = isOutputFresh(path.join(publicDir, 'styles.css'), path.join(publicDir, 'styles.min.css'));
    if (freshJs && freshCss) {
      console.log('[assets] up-to-date, skipping rebuild');
      return;
    }
    console.log('[assets] source newer than bundle — rebuilding…');
  }
  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch {
    console.error('[assets] esbuild is not installed. Run: npm install');
    process.exitCode = 1;
    return;
  }

  const common = {
    bundle: false,
    minify: true,
    legalComments: 'none',
    target: 'es2020',
    logLevel: 'info'
  };

  const jobs = [
    {
      entryPoints: [path.join(publicDir, 'app.js')],
      outfile: path.join(publicDir, 'app.min.js'),
      loader: { '.js': 'js' },
      ...common
    },
    {
      entryPoints: [path.join(publicDir, 'styles.css')],
      outfile: path.join(publicDir, 'styles.min.css'),
      loader: { '.css': 'css' },
      ...common
    }
  ];

  if (watch) {
    const contexts = await Promise.all(jobs.map((cfg) => esbuild.context(cfg)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log('[assets] watching public/app.js and public/styles.css ...');
    return;
  }

  await Promise.all(jobs.map((cfg) => esbuild.build(cfg)));
  console.log('[assets] built public/app.min.js and public/styles.min.css');

  // Обновляем CACHE_NAME в sw.js хешем от собранного кода: и клиентского JS,
  // и reader.js (последний обслуживается как отдельный файл, не входит в
  // app.min.js), чтобы Service Worker гарантированно инвалидировал кэш при
  // любых изменениях клиентского кода. Также миксуем hash styles.min.css.
  const swPath = path.join(publicDir, 'sw.js');
  const hashInputs = [
    readFileSync(path.join(publicDir, 'app.min.js'), 'utf8'),
    readFileSync(path.join(publicDir, 'styles.min.css'), 'utf8'),
    readFileSync(path.join(publicDir, 'reader.js'), 'utf8'),
    readFileSync(path.join(publicDir, 'reader.css'), 'utf8')
  ].join('\n');
  const hash = createHash('md5').update(hashInputs).digest('hex').slice(0, 8);
  let sw = readFileSync(swPath, 'utf8');
  // Handle both ''-string and `...`-template literal forms — sw.js currently
  // uses a template literal, but the project's own history has used both.
  const prev = sw;
  sw = sw.replace(/const CACHE_NAME = '[^']*';/, `const CACHE_NAME = 'inpx-v1-${hash}';`);
  sw = sw.replace(/const CACHE_NAME = `[^`]*`;/, `const CACHE_NAME = \`inpx-v1-${hash}\`;`);
  if (sw === prev) {
    console.warn('[assets] WARNING: could not update CACHE_NAME in sw.js — regex did not match');
  } else {
    writeFileSync(swPath, sw, 'utf8');
    console.log(`[assets] sw.js CACHE_NAME → inpx-v1-${hash}`);
  }
}

main().catch((error) => {
  console.error('[assets] build failed:', error?.message || error);
  process.exitCode = 1;
});
