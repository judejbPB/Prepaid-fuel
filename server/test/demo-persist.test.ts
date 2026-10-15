import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { DEMO_PASSWORD, seedDemo } from '../src/demo.js';
import { PersistentDemo, type SnapshotStore } from '../src/demo-persist.js';

/** In-memory stand-in for Vercel Blob with conditional writes. */
function memoryStore(): SnapshotStore & { saves: number } {
  let data: { bytes: Uint8Array; version: string } | null = null;
  let n = 0;
  return {
    saves: 0,
    async version() { return data?.version ?? null; },
    async load() { return data ? { bytes: data.bytes.slice(), version: data.version } : null; },
    async save(bytes, expected) {
      if ((data?.version ?? null) !== expected) return null;
      data = { bytes: bytes.slice(), version: `v${++n}` };
      this.saves++;
      return data.version;
    },
  };
}

/** One serverless instance: its own local file, the shared store, and the same request wrapping as the handler. */
async function instance(store: SnapshotStore) {
  const dir = mkdtempSync(join(tmpdir(), 'bousol-demo-'));
  const demo = new PersistentDemo(store, join(dir, 'demo.db'), seedDemo, () => {}, 0);
  const app = buildApp(demo.ctx);
  app.addHook('onSend', async (_req, _reply, payload) => { await demo.afterRequest(); return payload; });
  await demo.init();
  await app.ready();
  return async (method: 'GET' | 'POST', url: string, opts: { body?: any; headers?: Record<string, string> } = {}) => {
    await demo.beforeRequest();
    const res = await app.inject({ method, url, payload: opts.body, headers: opts.headers });
    return { status: res.statusCode, json: res.json() };
  };
}

describe('persistent hosted demo', () => {
  it('seeds once, and every instance shares sign-ins and data', async () => {
    const store = memoryStore();
    const a = await instance(store);
    const b = await instance(store); // started later: loads A's snapshot instead of seeding its own
    expect(store.saves).toBe(1);

    const act = await a('POST', '/api/terminals/activate', { body: { code: 'STATION2' } });
    const headers = { 'x-terminal-key': act.json.terminalKey };
    const login = await a('POST', '/api/auth/login', { body: { login: 'attendant2@bousol', password: DEMO_PASSWORD }, headers });
    expect(login.status).toBe(200);
    const auth = { ...headers, authorization: `Bearer ${login.json.token}` };

    // The next request lands on the other instance: the session is there.
    expect((await b('GET', '/api/me', { headers: auth })).status).toBe(200);
    const shift = await b('POST', '/api/shifts/open', { headers: auth });
    expect(shift.status).toBe(200);

    // A cold start after that still knows the session and the open shift.
    const c = await instance(store);
    const req = await c('POST', '/api/redemptions', { body: { grade: 'diesel', pump: 1, amount: 1500 }, headers: auth });
    expect(req.status).toBe(200);
    expect((await a('GET', `/api/redemptions/${req.json.id}`, { headers: auth })).json.status).toBe('pending');
  });

  it('does not upload when a request changed nothing', async () => {
    const store = memoryStore();
    const a = await instance(store);
    const before = store.saves;
    await a('GET', '/api/health');
    await a('POST', '/api/auth/login', { body: { login: 'nobody', password: 'x' } });
    expect(store.saves).toBe(before);
  });
});
