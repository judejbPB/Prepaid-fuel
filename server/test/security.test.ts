import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createCtx, type Ctx } from '../src/context.js';
import { DEMO_PASSWORD, seedDemo } from '../src/demo.js';
import { passwordProblem, purgeExpired } from '../src/security.js';
import * as admin from '../src/services/admin.js';

let ctx: Ctx;
let app: ReturnType<typeof buildApp>;
const IP = '203.0.113.7';

const call = async (method: string, url: string, opts: { body?: unknown; token?: string; ip?: string; headers?: Record<string, string> } = {}) => {
  const res = await app.inject({
    method: method as any, url, payload: opts.body as any, remoteAddress: opts.ip ?? IP,
    headers: { 'x-lang': 'en', 'x-device-id': 'dev-1', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers },
  });
  return { status: res.statusCode, json: res.json() as any, headers: res.headers };
};
const signIn = (login: string, password = DEMO_PASSWORD, ip = IP) => call('POST', '/api/auth/login', { body: { login, password }, ip });

beforeEach(() => {
  ctx = createCtx(':memory:');
  seedDemo(ctx);
  app = buildApp(ctx);
});

describe('sign-in protection', () => {
  it('locks an account after 5 wrong passwords, even for the right password, then lets it in after the lock', async () => {
    for (let i = 0; i < 5; i++) expect((await signIn('admin@bousol', 'wrong-password')).status).toBe(401);
    const locked = await signIn('admin@bousol');
    expect(locked.status).toBe(429);
    expect(locked.json.message).toMatch(/Try again in 15 minute/);
    expect(ctx.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'login.locked'").n).toBe(1);
    // Another account from the same address is not affected.
    expect((await signIn('treasury@bousol')).status).toBe(200);
    ctx.db.run("UPDATE auth_throttle SET locked_until = datetime('now', '-1 minute') WHERE key = 'login:admin@bousol'");
    expect((await signIn('admin@bousol')).status).toBe(200);
  });

  it('treats an unknown login like a wrong password, and a success clears the count', async () => {
    const unknown = await signIn('nobody@bousol', 'whatever');
    const wrong = await signIn('admin@bousol', 'wrong-password');
    expect([unknown.status, unknown.json.error]).toEqual([401, 'bad_credentials']);
    expect(unknown.json).toEqual(wrong.json);
    for (let i = 0; i < 3; i++) await signIn('admin@bousol', 'wrong-password');
    expect((await signIn('admin@bousol')).status).toBe(200);
    expect(ctx.db.get("SELECT COUNT(*) AS n FROM auth_throttle WHERE key = 'login:admin@bousol'").n).toBe(0);
  });

  it('locks a network address trying many accounts, without locking other addresses', async () => {
    for (let i = 0; i < 30; i++) await signIn(`guess${i}@bousol`, 'x');
    expect((await signIn('admin@bousol')).status).toBe(429);
    expect((await signIn('admin@bousol', DEMO_PASSWORD, '198.51.100.9')).status).toBe(200);
  });

  it('slows down terminal activation-code guessing and refuses expired codes', async () => {
    ctx.config.demoTerminals = false;
    for (let i = 0; i < 10; i++) expect((await call('POST', '/api/terminals/activate', { body: { code: `NOPE${i}AAA` } })).status).toBe(404);
    expect((await call('POST', '/api/terminals/activate', { body: { code: 'STATION1' } })).status).toBe(429);
    const station = ctx.db.get('SELECT id FROM stations LIMIT 1').id;
    const t = admin.createTerminal(ctx, null, { stationId: station, label: 'T-NEW' });
    ctx.db.run("UPDATE terminals SET activation_expires_at = datetime('now', '-1 hour') WHERE id = ?", t.id);
    const expired = await call('POST', '/api/terminals/activate', { body: { code: t.activation_code }, ip: '198.51.100.20' });
    expect([expired.status, expired.json.error]).toEqual([400, 'code_expired']);
  });
});

describe('sessions', () => {
  it('signs back-office users out after an hour idle, but not terminals or wallets', async () => {
    const token = (await signIn('admin@bousol')).json.token;
    expect((await call('GET', '/api/me', { token })).status).toBe(200);
    ctx.db.run("UPDATE sessions SET last_seen = datetime('now', '-61 minutes')");
    const out = await call('GET', '/api/me', { token });
    expect(out.status).toBe(401);
    expect(out.json.message).toMatch(/hour without activity/);
    expect((await call('GET', '/api/me', { token })).status).toBe(401); // the session is gone

    const emp = ctx.db.get('SELECT u.login FROM users u WHERE u.role = \'employee\' LIMIT 1').login;
    const wallet = (await signIn(emp)).json.token;
    ctx.db.run("UPDATE sessions SET last_seen = datetime('now', '-5 hours')");
    expect((await call('GET', '/api/me', { token: wallet })).status).toBe(200);
  });

  it('changing the password needs the current one, applies the rules and signs out the other sessions', async () => {
    const a = (await signIn('admin@bousol')).json.token;
    const b = (await signIn('admin@bousol')).json.token;
    expect((await call('POST', '/api/auth/password', { token: a, body: { current: 'wrong', next: 'Une-phrase-solide-2026' } })).status).toBe(403);
    const weak = await call('POST', '/api/auth/password', { token: a, body: { current: DEMO_PASSWORD, next: 'short' } });
    expect([weak.status, weak.json.message]).toEqual([400, 'Use at least 10 characters']);
    expect((await call('POST', '/api/auth/password', { token: a, body: { current: DEMO_PASSWORD, next: 'admin-and-more-2026' } })).json.message).toMatch(/login/);
    expect((await call('POST', '/api/auth/password', { token: a, body: { current: DEMO_PASSWORD, next: 'Une-phrase-solide-2026' } })).status).toBe(200);
    expect((await call('GET', '/api/me', { token: a })).status).toBe(200);
    expect((await call('GET', '/api/me', { token: b })).status).toBe(401);
    expect((await signIn('admin@bousol')).status).toBe(401);
    expect((await signIn('admin@bousol', 'Une-phrase-solide-2026')).status).toBe(200);
  });

  it('removes expired sessions and stale throttle rows', () => {
    ctx.db.run("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('old', 1, datetime('now', '-1 hour'))");
    ctx.db.run("INSERT INTO auth_throttle (key, failures, first_at) VALUES ('ip:x', 3, datetime('now', '-2 days'))");
    purgeExpired(ctx.db);
    expect(ctx.db.get("SELECT COUNT(*) AS n FROM sessions WHERE token_hash = 'old'").n).toBe(0);
    expect(ctx.db.get('SELECT COUNT(*) AS n FROM auth_throttle').n).toBe(0);
  });
});

describe('passwords', () => {
  it('applies the staff password rules', async () => {
    expect(passwordProblem('demo1234')).toBe('Use at least 10 characters');
    expect(passwordProblem('aaaaaaaaaaaa')).toBe('This password is too easy to guess');
    expect(passwordProblem('Motdepasse')).toBe('This password is too easy to guess');
    expect(passwordProblem('Kenscoff-pluie-42')).toBeNull();
    const token = (await signIn('admin@bousol')).json.token;
    const station = ctx.db.get('SELECT id FROM stations LIMIT 1').id;
    const weak = await call('POST', '/api/users', { token, body: { name: 'New Manager', login: 'new@bousol', password: 'demo1234', role: 'st_manager', stationId: station } });
    expect(weak.status).toBe(400);
    expect((await call('POST', '/api/users', { token, body: { name: 'New Manager', login: 'new@bousol', password: 'Kenscoff-pluie-42', role: 'st_manager', stationId: station } })).status).toBe(200);
  });
});

describe('every protected route', () => {
  it('refuses a caller who is not signed in', async () => {
    await app.ready();
    const PUBLIC = new Set(['/api/health', '/api/auth/login', '/api/terminals/activate']);
    const routes = app.routeList.filter((r) => r.url.startsWith('/api/') && !PUBLIC.has(r.url) && r.method !== 'HEAD' && r.method !== 'OPTIONS');
    expect(routes.length).toBeGreaterThan(60);
    const open: string[] = [];
    for (const r of routes) {
      const url = r.url.replace(/:[a-zA-Z]+/g, '1');
      const res = await app.inject({ method: r.method as any, url, payload: r.method === 'GET' ? undefined : {} });
      if (res.statusCode !== 401) open.push(`${r.method} ${r.url} → ${res.statusCode}`);
    }
    expect(open).toEqual([]);
  });

  it('sends the security headers, and no-store on the API', async () => {
    const res = await call('GET', '/api/health');
    expect(res.headers['content-security-policy']).toMatch(/default-src 'self'/);
    expect(res.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['permissions-policy']).toMatch(/geolocation=\(self\)/);
  });
});
