#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const publicDir = path.join(projectRoot, 'public');

const args = new Set(process.argv.slice(2));
const watch = args.has('--watch');

async function main() {
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
}

main().catch((error) => {
  console.error('[assets] build failed:', error?.message || error);
  process.exitCode = 1;
});
