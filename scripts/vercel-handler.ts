// Vercel function entry: the whole API on a seeded demo database.
// With a Blob store connected (BLOB_READ_WRITE_TOKEN), the database is saved there so the demo survives
// cold starts, redeploys and requests that reach different instances. Without one it lives in memory and
// resets whenever the platform starts a new instance.
import { BlobNotFoundError, get, head, put } from '@vercel/blob';
import { buildApp } from '../server/src/app.js';
import { createCtx, type Ctx } from '../server/src/context.js';
import { PersistentDemo, type SnapshotStore } from '../server/src/demo-persist.js';
import { seedDemo } from '../server/src/demo.js';

const SNAPSHOT = 'demo/bousol-demo.db';

const blobStore: SnapshotStore = {
  async version() {
    try { return (await head(SNAPSHOT)).etag; } catch (e) { if (e instanceof BlobNotFoundError) return null; throw e; }
  },
  async load() {
    const r = await get(SNAPSHOT, { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200) return null;
    return { bytes: new Uint8Array(await new Response(r.stream).arrayBuffer()), version: r.blob.etag };
  },
  async save(bytes, expected) {
    try {
      const r = await put(SNAPSHOT, Buffer.from(bytes), {
        access: 'private', addRandomSuffix: false, allowOverwrite: expected !== null,
        contentType: 'application/vnd.sqlite3', ...(expected ? { ifMatch: expected } : {}),
      });
      return r.etag;
    } catch (e: any) {
      if (e?.name === 'BlobPreconditionFailedError' || /already exists|precondition/i.test(String(e?.message))) return null;
      throw e;
    }
  },
};

const persistent = process.env.BLOB_READ_WRITE_TOKEN
  ? new PersistentDemo(blobStore, '/tmp/bousol-demo.db', (ctx) => { seedDemo(ctx); }, (m) => console.log(`[demo] ${m}`))
  : null;

let ctx: Ctx;
if (persistent) {
  ctx = persistent.ctx;
} else {
  ctx = createCtx(':memory:');
  seedDemo(ctx);
}
const app = buildApp(ctx);
if (persistent) {
  // Save before the response leaves, so the client's next request (maybe on another instance) sees it.
  app.addHook('onSend', async (_req, _reply, payload) => { await persistent.afterRequest(); return payload; });
}
const ready = (async () => { if (persistent) await persistent.init(); await app.ready(); })();

// One request at a time per instance: a snapshot reload must never swap the database under a running request.
let queue: Promise<void> = Promise.resolve();

export default async function handler(req: any, res: any) {
  await ready;
  // Requests are routed here as /api?__path=<rest>; restore the original /api/<rest> URL for Fastify.
  const url = new URL(req.url, 'http://local');
  const path = url.searchParams.get('__path');
  if (path !== null) {
    url.searchParams.delete('__path');
    const qs = url.searchParams.toString();
    req.url = `/api/${path}${qs ? `?${qs}` : ''}`;
  }
  if (!persistent || req.url.startsWith('/api/health')) {
    app.server.emit('request', req, res);
    return;
  }
  const run = queue.then(async () => {
    await persistent.beforeRequest();
    const done = new Promise<void>((resolve) => { res.on('finish', resolve); res.on('close', resolve); });
    app.server.emit('request', req, res);
    await done;
  });
  queue = run.catch((e) => console.error('[demo] request failed', e));
  await run;
}
