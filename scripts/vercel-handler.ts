// Vercel function entry: the whole API on a seeded demo database.
// With a Blob store connected (BLOB_READ_WRITE_TOKEN, or BLOB_STORE_ID with Vercel OIDC), the database is saved there so the demo survives
// cold starts, redeploys and requests that reach different instances. Without one it lives in memory and
// resets whenever the platform starts a new instance.
import { BlobNotFoundError, get, head, put } from '@vercel/blob';
import { buildApp } from '../server/src/app.js';
import { createCtx, type Ctx } from '../server/src/context.js';
import { attachDemoPersistence, PersistentDemo, type SnapshotStore } from '../server/src/demo-persist.js';
import { seedDemo } from '../server/src/demo.js';

const SNAPSHOT = 'demo/bousol-demo.db';

// Blob credentials: a read-write token (older stores) or a store id with Vercel OIDC (newer stores). With
// OIDC the token arrives on each request in the x-vercel-oidc-token header; keep the latest one.
let oidcToken: string | undefined = process.env.VERCEL_OIDC_TOKEN;
const blobAuth = () =>
  process.env.BLOB_READ_WRITE_TOKEN ? {} : { storeId: process.env.BLOB_STORE_ID, ...(oidcToken ? { oidcToken } : {}) };

const blobStore: SnapshotStore = {
  async version() {
    try { return (await head(SNAPSHOT, blobAuth())).etag; } catch (e) { if (e instanceof BlobNotFoundError) return null; throw e; }
  },
  async load() {
    const r = await get(SNAPSHOT, { access: 'private', useCache: false, ...blobAuth() });
    if (!r || r.statusCode !== 200) return null;
    return { bytes: new Uint8Array(await new Response(r.stream).arrayBuffer()), version: r.blob.etag };
  },
  async save(bytes, expected) {
    try {
      const r = await put(SNAPSHOT, Buffer.from(bytes), {
        access: 'private', addRandomSuffix: false, allowOverwrite: expected !== null,
        contentType: 'application/vnd.sqlite3', ...(expected ? { ifMatch: expected } : {}), ...blobAuth(),
      });
      return r.etag;
    } catch (e: any) {
      if (e?.name === 'BlobPreconditionFailedError' || /already exists|precondition/i.test(String(e?.message))) return null;
      throw e;
    }
  },
};

// What /api/health reports about storage, so a tester can see whether the demo is saving (no secrets).
const status = { mode: 'memory' as 'memory' | 'blob', startedAt: new Date().toISOString(), lastError: null as string | null };
const log = (m: string) => {
  console.log(`[demo] ${m}`);
  if (/failed|conflict/i.test(m)) status.lastError = `${new Date().toISOString()} ${m}`.slice(0, 300);
};

const persistent = process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID
  ? new PersistentDemo(blobStore, '/tmp/bousol-demo.db', (ctx) => { seedDemo(ctx); }, log)
  : null;
if (persistent) status.mode = 'blob';

let ctx: Ctx;
if (persistent) {
  ctx = persistent.ctx;
} else {
  ctx = createCtx(':memory:');
  seedDemo(ctx);
}
const app = buildApp(ctx);
if (persistent) attachDemoPersistence(app, persistent);
// Started on the first request, which carries the OIDC token the store needs.
let ready: Promise<void> | null = null;
const start = () => (ready ??= (async () => { if (persistent) await persistent.init(); await app.ready(); })());

// One request at a time per instance: a snapshot reload must never swap the database under a running request.
let queue: Promise<void> = Promise.resolve();

export default async function handler(req: any, res: any) {
  const oidc = req.headers?.['x-vercel-oidc-token'];
  if (typeof oidc === 'string' && oidc) oidcToken = oidc;
  await start();
  // Requests are routed here as /api?__path=<rest>; restore the original /api/<rest> URL for Fastify.
  const url = new URL(req.url, 'http://local');
  const path = url.searchParams.get('__path');
  if (path !== null) {
    url.searchParams.delete('__path');
    const qs = url.searchParams.toString();
    req.url = `/api/${path}${qs ? `?${qs}` : ''}`;
  }
  if (req.url.startsWith('/api/health')) {
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({ ok: true, demo: { ...status, version: persistent?.currentVersion ?? null } }));
    return;
  }
  if (!persistent) {
    app.server.emit('request', req, res);
    return;
  }
  const run = queue.then(async () => {
    const done = new Promise<void>((resolve) => { res.on('finish', resolve); res.on('close', resolve); });
    app.server.emit('request', req, res);
    await done;
  });
  queue = run.catch((e) => console.error('[demo] request failed', e));
  await run;
}
