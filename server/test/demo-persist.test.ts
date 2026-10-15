import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { DEMO_PASSWORD, seedDemo } from '../src/demo.js';
import { attachDemoPersistence, DEMO_VERSION_HEADER, PersistentDemo, type SnapshotStore } from '../src/demo-persist.js';

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
async function instance(store: SnapshotStore, opts: { recheckMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bousol-demo-'));
  const demo = new PersistentDemo(store, join(dir, 'demo.db'), seedDemo, () => {}, opts.recheckMs);
  const app = buildApp(demo.ctx);
  attachDemoPersistence(app, demo);
  await demo.init();
  await app.ready();
  const call = async (method: 'GET' | 'POST', url: string, o: { body?: any; headers?: Record<string, string> } = {}) => {
    const res = await app.inject({ method, url, payload: o.body, headers: o.headers });
    return { status: res.statusCode, json: res.json(), version: res.headers[DEMO_VERSION_HEADER] as string | undefined };
  };
  return Object.assign(call, { demo });
}

describe('persistent hosted demo', () => {
  it('seeds once, and every instance shares sign-ins and data', async () => {
    const store = memoryStore();
    // Like the browser: every request echoes the last snapshot version the client saw.
    let seen: string | undefined;
    const client = (inst: Awaited<ReturnType<typeof instance>>) =>
      async (method: 'GET' | 'POST', url: string, o: { body?: any; headers?: Record<string, string> } = {}) => {
        const r = await inst(method, url, { ...o, headers: { ...o.headers, ...(seen ? { [DEMO_VERSION_HEADER]: seen } : {}) } });
        seen = r.version ?? seen;
        return r;
      };
    const a = client(await instance(store));
    const b = client(await instance(store)); // started later: loads A's snapshot instead of seeding its own
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
    const c = client(await instance(store));
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

describe('persistent hosted demo: consistency', () => {
  it('serves a fresh sign-in on another instance right away, even inside its recheck window', async () => {
    const store = memoryStore();
    const a = await instance(store, { recheckMs: 60_000 });
    const b = await instance(store, { recheckMs: 60_000 });
    await b('GET', '/api/health'); // b is warm and would otherwise trust its copy for a minute
    const login = await a('POST', '/api/auth/login', { body: { login: 'admin@bousol', password: DEMO_PASSWORD } });
    const auth = { authorization: `Bearer ${login.json.token}` };
    // Without the version the client saw, b still serves its own (older) copy...
    expect((await b('GET', '/api/me', { headers: auth })).status).toBe(401);
    // ...with it, b catches up before answering.
    const me = await b('GET', '/api/me', { headers: { ...auth, [DEMO_VERSION_HEADER]: login.version! } });
    expect(me.status).toBe(200);
  });

  it('reports a write lost to a concurrent save as an error, never as success', async () => {
    const store = memoryStore();
    const a = await instance(store, { recheckMs: 60_000 });
    const b = await instance(store, { recheckMs: 60_000 });
    // Make b's next write race a save by a: b checks the store, then a saves before b does.
    const realVersion = store.version.bind(store);
    let raced = false;
    store.version = async () => {
      const v = await realVersion();
      if (!raced) { raced = true; await a('POST', '/api/auth/login', { body: { login: 'admin@bousol', password: DEMO_PASSWORD } }); }
      return v;
    };
    const res = await b('POST', '/api/auth/login', { body: { login: 'treasury@bousol', password: DEMO_PASSWORD } });
    expect(res).toMatchObject({ status: 503, json: { error: 'busy' } });
    // b dropped its unsaved copy and now serves the winning snapshot.
    expect(b.demo.currentVersion).toBe(await realVersion());
  });
});
