// Local database snapshots for a production server. Every few hours the server writes a consistent copy of the
// SQLite database (VACUUM INTO, safe while the app is running), checks the copy can be opened and is intact,
// and keeps the most recent ones. Off-site copies are Litestream's job (deploy/litestream.yml): it streams
// every change to object storage, so a lost server can be restored to within seconds.
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Db } from './db.js';

const NAME = /^alfa-(\d{8}T\d{6}Z)\.db$/;

export interface SnapshotInfo { file: string; at: string; bytes: number }

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

/** Writes a checked snapshot of the database into dir and returns it. Throws if the copy is not intact. */
export function snapshot(db: Db, dir: string, now = new Date()): SnapshotInfo {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `alfa-${stamp(now)}.db`);
  db.raw.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const copy = new DatabaseSync(file, { readOnly: true });
  try {
    const check = copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    if (check.integrity_check !== 'ok') throw new Error(`snapshot ${file} failed integrity check: ${check.integrity_check}`);
  } finally {
    copy.close();
  }
  return { file, at: now.toISOString(), bytes: statSync(file).size };
}

/** Snapshots in dir, newest first. */
export function listSnapshots(dir: string): SnapshotInfo[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter((n) => NAME.test(n)).sort().reverse().map((n) => {
    const s = NAME.exec(n)![1];
    const at = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`;
    return { file: join(dir, n), at: new Date(at).toISOString(), bytes: statSync(join(dir, n)).size };
  });
}

/** Keeps the newest `keep` snapshots and deletes the rest. Returns the deleted files. */
export function pruneSnapshots(dir: string, keep: number): string[] {
  const old = listSnapshots(dir).slice(Math.max(1, keep));
  for (const s of old) rmSync(s.file, { force: true });
  return old.map((s) => s.file);
}

/** Age of the newest snapshot in hours, or null when there is none. */
export function lastSnapshotAgeHours(dir: string, now = Date.now()): number | null {
  const last = listSnapshots(dir)[0];
  return last ? Math.round(((now - Date.parse(last.at)) / 3_600_000) * 10) / 10 : null;
}
