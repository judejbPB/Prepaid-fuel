import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createCtx } from '../src/context.js';
import { seedDemo } from '../src/demo.js';
import { localize, localizeData, localizePayload, requestLang } from '../src/i18n.js';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });

/** Text of a call's arguments, from just after "(" to the matching ")", skipping over string contents. */
function callArgs(src: string, start: number): string {
  let depth = 1;
  let i = start;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') { i = skipLiteral(src, i).end; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    i++;
  }
  return src.slice(start, i - 1);
}

/** Reads a string or template literal starting at `i`; templates keep their ${...} expressions. */
function skipLiteral(src: string, i: number): { end: number; text: string; parts: (string | { expr: string })[] } {
  const q = src[i];
  const parts: (string | { expr: string })[] = [];
  let buf = '';
  let j = i + 1;
  while (j < src.length && src[j] !== q) {
    if (src[j] === '\\') { buf += src[j + 1]; j += 2; continue; }
    if (q === '`' && src[j] === '$' && src[j + 1] === '{') {
      parts.push(buf); buf = '';
      let depth = 1; let k = j + 2;
      while (depth > 0) {
        const c = src[k];
        if (c === "'" || c === '"' || c === '`') { k = skipLiteral(src, k).end; continue; }
        if (c === '{') depth++;
        if (c === '}') depth--;
        k++;
      }
      parts.push({ expr: src.slice(j + 2, k - 1) });
      j = k;
      continue;
    }
    buf += src[j]; j++;
  }
  parts.push(buf);
  return { end: j + 1, text: parts.map((p) => (typeof p === 'string' ? p : '${…}')).join(''), parts };
}

/** Top-level literals in an argument list (not those nested inside template expressions). */
function literals(args: string) {
  const out: ReturnType<typeof skipLiteral>[] = [];
  for (let i = 0; i < args.length;) {
    const c = args[i];
    if (c === "'" || c === '"' || c === '`') { const l = skipLiteral(args, i); out.push(l); i = l.end; } else i++;
  }
  return out;
}

/** Sample value for a template expression, shaped like what the code puts there. */
function sample(expr: string): string {
  if (/roles\.join/.test(expr)) return 'dist_admin or dist_approver';
  if (/status/.test(expr)) return 'approved';
  if (/grade/.test(expr)) return 'gasoline';
  if (/^entity$/.test(expr.trim())) return 'lot';
  if (/toFixed|Minor|minor|diff|Failures|failures|Id\b/.test(expr)) return '42';
  if (/station/.test(expr)) return 'Station Delmas';
  if (/name/.test(expr)) return 'Marie Joseph';
  return 'X-17';
}

const HELPERS = /\b(new AppError|badRequest|forbidden|notFound|conflict)\(/g;
const IS_CODE = /^[a-z][a-z0-9_]*$/;

function collectMessages() {
  const found: { file: string; english: string; template: string }[] = [];
  for (const file of files(SRC)) {
    if (file.endsWith('errors.ts') || file.endsWith('i18n.ts')) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(HELPERS)) {
      const helper = m[1];
      for (const lit of literals(callArgs(src, m.index! + m[0].length))) {
        if (lit.parts.length === 1 && IS_CODE.test(lit.text)) continue; // machine error codes
        let english = lit.parts.map((p) => (typeof p === 'string' ? p : sample(p.expr))).join('');
        if (helper === 'notFound') english = `${english} not found`;
        found.push({ file: file.slice(SRC.length + 1), english, template: lit.text });
      }
    }
    // Messages sent directly (app.ts error and 404 handlers, demo-persist busy reply).
    for (const m of src.matchAll(/(?:message: |\blocalize\()'([^']+)'/g)) found.push({ file: file.slice(SRC.length + 1), english: m[1], template: m[1] });
  }
  found.push({ file: 'errors.ts', english: 'Not allowed', template: 'Not allowed' }); // forbidden() default
  return found;
}

describe('i18n coverage', () => {
  const messages = collectMessages();

  it('finds the API error messages', () => {
    expect(messages.length).toBeGreaterThan(120);
  });

  it('translates every error message the API can send', () => {
    const untranslated = messages.filter((m) => localize(m.english, 'fr') === m.english);
    expect(untranslated.map((m) => `${m.file}: ${m.template}`)).toEqual([]);
    for (const m of messages) expect(localize(m.english, 'en')).toBe(m.english);
  });

  it('keeps the dynamic parts of templated messages', () => {
    expect(localize('Wrong PIN (2 tries left). Ask the employee to try again.', 'fr'))
      .toBe('Code PIN incorrect (2 essais restants). Demandez à l’employé de réessayer.');
    expect(localize('This terminal belongs to Station 2. Sign in with an attendant account for Station 2, or activate this device for your own station.', 'fr'))
      .toContain('Ce terminal appartient à Station 2');
    expect(localize('Refund is approved', 'fr')).toBe('Le remboursement est approuvé');
    expect(localize('Bank line BNK-9 is matched', 'fr')).toBe('La ligne bancaire BNK-9 est rapprochée');
    expect(localize('Allocation batch not found', 'fr')).toBe('Lot d’allocation introuvable');
    expect(localize('Your company has no gasoline price yet', 'fr')).toBe('Votre entreprise n’a pas encore de prix pour la gazoline');
    expect(localize('Some brand new message', 'fr')).toBe('Some brand new message');
  });

  it('translates offline-sync reasons and exception summaries in response data', () => {
    const src = readFileSync(join(SRC, 'services/station-offline.ts'), 'utf8');
    const reasons = [...src.matchAll(/reject\('([^']+)'/g)].map((m) => m[1]);
    expect(reasons.length).toBeGreaterThan(5);
    for (const r of reasons) expect(localizeData(r, 'fr')).not.toBe(r);
    expect(localizeData('Station 1: offline sale of 500.00 HTG rejected at sync (wrong PIN)', 'fr'))
      .toBe('Station 1 : vente hors ligne de 500.00 HTG rejetée à la synchronisation (code PIN incorrect)');
    expect(localizeData('Station 1 shift close: 2,000.00 HTG variance awaiting explanation', 'fr')).toMatch(/^Station 1, fermeture de quart/);
    // User-entered text is left alone.
    expect(localizePayload({ items: [{ reason: 'Program ended', summary: 'wrong PIN' }] }, 'fr'))
      .toEqual({ items: [{ reason: 'Program ended', summary: 'code PIN incorrect' }] });
  });

  it('defaults to French unless the client asks for English', () => {
    expect(requestLang({})).toBe('fr');
    expect(requestLang({ 'x-lang': 'fr' })).toBe('fr');
    expect(requestLang({ 'x-lang': 'de' })).toBe('fr');
    expect(requestLang({ 'x-lang': 'EN' })).toBe('en');
  });
});

describe('i18n over HTTP', () => {
  const ctx = createCtx(':memory:');
  const app = buildApp(ctx);
  beforeAll(() => { seedDemo(ctx); });

  const badLogin = (headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'admin@bousol', password: 'nope' }, headers });

  it('answers in French by default and in English with x-lang: en', async () => {
    const fr = await badLogin();
    expect(fr.statusCode).toBe(401);
    expect(fr.json()).toEqual({ error: 'bad_credentials', message: 'Identifiant ou mot de passe invalide' });
    expect((await badLogin({ 'x-lang': 'fr' })).json().message).toBe('Identifiant ou mot de passe invalide');
    expect((await badLogin({ 'x-lang': 'en' })).json()).toEqual({ error: 'bad_credentials', message: 'Invalid login or password' });
  });

  it('translates validation errors too', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'admin@bousol' } });
    expect(res.json()).toMatchObject({ error: 'invalid', message: 'password: Obligatoire' });
    const en = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'admin@bousol' }, headers: { 'x-lang': 'en' } });
    expect(en.json().message).toBe('password: Required');
  });
});
