import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { lastSnapshotAgeHours, listSnapshots, pruneSnapshots, snapshot } from '../src/backup.js';
import { createCtx, type Ctx } from '../src/context.js';
import { seedDemo } from '../src/demo.js';

let dir: string;
let ctx: Ctx;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'alfa-prod-'));
  ctx = createCtx(join(dir, 'alfa.db'));
  seedDemo(ctx);
});
afterEach(() => {
  ctx.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('production database', () => {
  it('syncs every commit to disk and survives a close and reopen', () => {
    expect(ctx.db.get('PRAGMA synchronous').synchronous).toBe(2); // FULL
    expect(ctx.db.get('PRAGMA journal_mode').journal_mode).toBe('wal');
    const users = ctx.db.get('SELECT COUNT(*) AS n FROM users').n;
    ctx.db.close();
    ctx = createCtx(join(dir, 'alfa.db'));
    expect(ctx.db.get('SELECT COUNT(*) AS n FROM users').n).toBe(users);
  });

  it('writes intact snapshots with the same data, keeps the newest and reports their age', () => {
    const backups = join(dir, 'backups');
    const t0 = new Date('2026-10-19T06:00:00Z');
    for (let h = 0; h < 5; h++) snapshot(ctx.db, backups, new Date(t0.getTime() + h * 3_600_000));
    const list = listSnapshots(backups);
    expect(list).toHaveLength(5);
    expect(list[0].at).toBe('2026-10-19T10:00:00.000Z');

    const copy = new DatabaseSync(list[0].file, { readOnly: true });
    const count = (db: { prepare: (s: string) => { get: () => unknown } }, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n;
    for (const table of ['users', 'journal_lines', 'redemptions', 'lots']) expect(count(copy, table)).toBe(count(ctx.db.raw, table));
    copy.close();

    expect(pruneSnapshots(backups, 3)).toHaveLength(2);
    expect(listSnapshots(backups).map((s) => s.at)).toEqual(['2026-10-19T10:00:00.000Z', '2026-10-19T09:00:00.000Z', '2026-10-19T08:00:00.000Z']);
    expect(lastSnapshotAgeHours(backups, Date.parse('2026-10-19T16:30:00Z'))).toBe(6.5);
    expect(lastSnapshotAgeHours(join(dir, 'none'))).toBeNull();
  });
});

describe('health check', () => {
  it('answers 200 when the database and backups are fine, 503 when backups are stale', async () => {
    let fresh = true;
    const app = buildApp(ctx, { health: () => ({ ok: fresh, last_backup_hours_ago: fresh ? 1 : 30 }) });
    const ok = await app.inject({ url: '/api/health' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, db: 'ok', last_backup_hours_ago: 1 });
    fresh = false;
    const stale = await app.inject({ url: '/api/health' });
    expect(stale.statusCode).toBe(503);
    expect(stale.json()).toMatchObject({ ok: false, db: 'ok' });
    await app.close();
  });
});
