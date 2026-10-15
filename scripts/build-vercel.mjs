// Builds a Vercel Build Output API (v3) bundle: static web app + one Node function for /api.
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const out = '.vercel/output';
rmSync(out, { recursive: true, force: true });
execSync('npm run build -w web', { stdio: 'inherit' });
cpSync('web/dist', `${out}/static`, { recursive: true });

const fn = `${out}/functions/api.func`;
mkdirSync(fn, { recursive: true });
await build({
  entryPoints: ['scripts/vercel-handler.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: `${fn}/index.mjs`,
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  logLevel: 'warning',
});
writeFileSync(`${fn}/.vc-config.json`, JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', maxDuration: 60 }, null, 2));
writeFileSync(`${out}/config.json`, JSON.stringify({
  version: 3,
  routes: [
    { src: '/sw.js', headers: { 'cache-control': 'no-cache' }, continue: true },
    { handle: 'filesystem' },
    { src: '/api/(.*)', dest: '/api?__path=$1' },
    { src: '/(.*)', dest: '/index.html' },
  ],
}, null, 2));
console.log('Vercel output written to', out);
