// Builds a Vercel Build Output API (v3) bundle: static web app + one Node function for /api.
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';
const securityHeaders = Object.fromEntries(Object.entries(JSON.parse(readFileSync(new URL('../server/src/security-headers.json', import.meta.url), 'utf8'))).filter(([k]) => !k.startsWith('_')));

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
    // Same security headers as the server sends, plus HSTS (the test site is HTTPS only).
    { src: '/(.*)', headers: { ...securityHeaders, 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' }, continue: true },
    { src: '/sw.js', headers: { 'cache-control': 'no-cache' }, continue: true },
    { handle: 'filesystem' },
    { src: '/api/(.*)', dest: '/api?__path=$1' },
    { src: '/(.*)', dest: '/index.html' },
  ],
}, null, 2));
console.log('Vercel output written to', out);
