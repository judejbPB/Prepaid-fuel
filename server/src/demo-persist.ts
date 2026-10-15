// Hosted demo only: keeps the SQLite database in an object store (Vercel Blob) so the demo survives
// serverless cold starts, redeploys and requests that land on different instances. Every instance keeps a
// local copy; before a request it reloads when another instance has saved a newer snapshot, and after a
// request that changed data it uploads a new snapshot (conditional on the version it started from).
// Fine for a demo with a handful of testers; a real deployment runs one server with a disk (see Dockerfile).
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { createCtx, type Ctx } from './context.js';

export interface SnapshotStore {
  /** Current version tag, or null when no snapshot exists yet. */
  version(): Promise<string | null>;
  /** Snapshot bytes and their version, or null when none exists. */
  load(): Promise<{ bytes: Uint8Array; version: string } | null>;
  /** Save bytes only if the stored version is still `expected` (null: only if none exists). Returns the new version, or null on conflict. */
  save(bytes: Uint8Array, expected: string | null): Promise<string | null>;
}

export class PersistentDemo {
  /** Mutated in place on reload, so the Fastify app built around it always sees the current database. */
  readonly ctx: Ctx;
  private version: string | null = null;
  private checkedAt = 0;
  private changesBefore = 0;

  constructor(
    private store: SnapshotStore,
    private file: string,
    private seed: (ctx: Ctx) => void,
    private log: (msg: string) => void = () => {},
    /** How long a plain read may go without checking the store (keeps polling screens cheap). */
    private recheckMs = 30_000,
  ) {
    this.ctx = {} as Ctx;
  }

  async init() {
    const snap = await this.store.load().catch((e) => { this.log(`snapshot load failed: ${e}`); return null; });
    if (snap) {
      this.open(snap.bytes);
      this.version = snap.version;
      this.checkedAt = Date.now();
      this.log(`loaded demo snapshot ${snap.version}`);
      return;
    }
    this.open(null);
    this.seed(this.ctx);
    this.version = await this.store.save(this.bytes(), null).catch((e) => { this.log(`snapshot save failed: ${e}`); return null; });
    if (this.version === null) {
      // Another instance seeded first: use theirs so everyone shares one database.
      const theirs = await this.store.load().catch(() => null);
      if (theirs) { this.open(theirs.bytes); this.version = theirs.version; }
    }
    this.checkedAt = Date.now();
    this.log(`seeded demo database (${this.version ?? 'not saved'})`);
  }

  /** The snapshot version this instance is serving; sent to clients so their next request can ask for it. */
  get currentVersion() { return this.version; }

  /**
   * Call before handling a request. Checks the store for a newer snapshot when the request writes (so writes
   * start from the latest data), when the client has seen a version this instance doesn't serve (read-your-
   * writes across instances, e.g. sign in on one instance then load the next screen on another), or when the
   * last check is older than `recheckMs`. Plain reads otherwise skip the store round trip.
   */
  async beforeRequest(opts: { write: boolean; clientVersion?: string | null } = { write: true }) {
    const now = Date.now();
    const clientAhead = !!opts.clientVersion && opts.clientVersion !== this.version;
    if (opts.write || clientAhead || now - this.checkedAt >= this.recheckMs) {
      this.checkedAt = now;
      try {
        await this.reloadIfStale();
      } catch (e) {
        this.log(`snapshot check failed, serving the local copy: ${e}`);
      }
    }
    this.changesBefore = this.totalChanges();
  }

  /**
   * Call after the handler ran and before the response is sent. Returns false when another instance saved
   * first: this request's changes were discarded (the local copy is reloaded) and the caller must not
   * report success.
   */
  async afterRequest(opts: { write: boolean } = { write: true }): Promise<boolean> {
    if (this.totalChanges() === this.changesBefore) return true;
    const next = await this.store.save(this.bytes(), this.version).catch((e) => { this.log(`snapshot save failed: ${e}`); return undefined; });
    // Store unreachable: keep the change locally; it is uploaded with this instance's next successful save.
    if (next === undefined) return true;
    if (next) { this.version = next; this.checkedAt = Date.now(); return true; }
    this.log('snapshot conflict: another instance saved first; discarding this request');
    await this.reloadIfStale().catch((e) => this.log(`reload after conflict failed: ${e}`));
    // A read that only left a side record (e.g. an audit row) still answered correctly.
    return !opts.write;
  }

  private async reloadIfStale() {
    const remote = await this.store.version();
    if (remote && remote !== this.version) {
      const snap = await this.store.load();
      if (snap) { this.open(snap.bytes); this.version = snap.version; this.log(`reloaded snapshot ${snap.version}`); }
    }
  }

  private totalChanges(): number {
    return Number((this.ctx.db.raw.prepare('SELECT total_changes() AS n').get() as any).n);
  }

  private bytes(): Uint8Array {
    this.ctx.db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return readFileSync(this.file);
  }

  private open(bytes: Uint8Array | null) {
    try { this.ctx.db?.raw.close(); } catch { /* already closed */ }
    for (const f of [this.file, `${this.file}-wal`, `${this.file}-shm`]) if (existsSync(f)) rmSync(f);
    if (bytes) writeFileSync(this.file, bytes);
    const next = createCtx(this.file);
    next.config.demoTerminals = true;
    Object.assign(this.ctx, next);
  }
}

/** Response/request header carrying the snapshot version a client has seen (read-your-writes across instances). */
export const DEMO_VERSION_HEADER = 'x-demo-version';

/** Wire a PersistentDemo into a Fastify app. Requests must reach the app one at a time per instance. */
export function attachDemoPersistence(app: FastifyInstance, demo: PersistentDemo) {
  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/api/health')) return;
    const clientVersion = req.headers[DEMO_VERSION_HEADER];
    await demo.beforeRequest({
      write: req.method !== 'GET' && req.method !== 'HEAD',
      clientVersion: typeof clientVersion === 'string' ? clientVersion : null,
    });
  });
  // Save before the response leaves, so the client's next request (maybe on another instance) sees it.
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/health')) return payload;
    const saved = await demo.afterRequest({ write: req.method !== 'GET' && req.method !== 'HEAD' });
    if (demo.currentVersion) reply.header(DEMO_VERSION_HEADER, demo.currentVersion);
    if (saved) return payload;
    reply.code(503).header('content-type', 'application/json; charset=utf-8');
    return JSON.stringify({ error: 'busy', message: 'The demo server was busy and nothing was saved. Please try again.' });
  });
}
