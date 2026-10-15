// Hosted demo only: keeps the SQLite database in an object store (Vercel Blob) so the demo survives
// serverless cold starts, redeploys and requests that land on different instances. Every instance keeps a
// local copy; before a request it reloads when another instance has saved a newer snapshot, and after a
// request that changed data it uploads a new snapshot (conditional on the version it started from).
// Fine for a demo with a handful of testers; a real deployment runs one server with a disk (see Dockerfile).
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    /** How long a version check stays fresh; avoids one store call per poll request. */
    private recheckMs = 1500,
  ) {
    this.ctx = {} as Ctx;
  }

  async init() {
    const snap = await this.store.load().catch((e) => { this.log(`snapshot load failed: ${e}`); return null; });
    if (snap) {
      this.open(snap.bytes);
      this.version = snap.version;
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
    this.log(`seeded demo database (${this.version ?? 'not saved'})`);
  }

  /** Call before handling a request. */
  async beforeRequest() {
    const now = Date.now();
    if (now - this.checkedAt >= this.recheckMs) {
      this.checkedAt = now;
      try {
        const remote = await this.store.version();
        if (remote && remote !== this.version) {
          const snap = await this.store.load();
          if (snap) { this.open(snap.bytes); this.version = snap.version; this.log(`reloaded snapshot ${snap.version}`); }
        }
      } catch (e) {
        this.log(`snapshot check failed, serving the local copy: ${e}`);
      }
    }
    this.changesBefore = this.totalChanges();
  }

  /** Call after the handler ran and before the response is sent. */
  async afterRequest() {
    if (this.totalChanges() === this.changesBefore) return;
    const next = await this.store.save(this.bytes(), this.version).catch((e) => { this.log(`snapshot save failed: ${e}`); return undefined; });
    if (next === undefined) return;
    if (next) { this.version = next; this.checkedAt = Date.now(); return; }
    // Another instance saved in between; this request's write is lost. Rare with a few testers.
    this.log('snapshot conflict: another instance saved first; reloading');
    this.checkedAt = 0;
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
