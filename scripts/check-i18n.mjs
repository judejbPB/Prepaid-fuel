// Every t('...') literal in web/src must have a French entry (i18n/fr/*.ts). Run: node scripts/check-i18n.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const files = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
});
const unescape = (s) => s.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
const keys = new Set();
for (const f of files('web/src/i18n/fr')) {
  for (const m of readFileSync(f, 'utf8').matchAll(/^\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*:/gm)) keys.add(unescape(m[1] ?? m[2]));
}
const missing = [];
const dynamic = [];
for (const f of files('web/src').filter((f) => !f.includes('/i18n/'))) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\bt\(\s*('((?:[^'\\]|\\.)*)'|[`"a-zA-Z_])/g)) {
    if (m[2] !== undefined) { if (!keys.has(unescape(m[2]))) missing.push(`${f}: ${m[2]}`); }
    else dynamic.push(`${f}: t(${m[1]}…`);
  }
}
if (dynamic.length) console.log(`Non-literal t() calls (not checkable):\n  ${dynamic.join('\n  ')}`);
if (missing.length) { console.error(`Missing French for ${missing.length} string(s):\n  ${missing.join('\n  ')}`); process.exit(1); }
console.log(`OK: every t() literal has French (${keys.size} entries).`);
