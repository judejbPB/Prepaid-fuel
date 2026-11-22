import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { lastSnapshotAgeHours, pruneSnapshots, snapshot } from './backup.js';
import { createCtx } from './context.js';
import { createUser } from './services/admin.js';
import { runRecurring } from './services/allocation.js';

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const production = env.NODE_ENV === 'production';
const dbPath = env.DB_PATH ?? resolve(here, '../data/bousol.db');
const port = Number(env.PORT ?? 8787);
// Local snapshots: on by default in production (next to the database), every BACKUP_INTERVAL_HOURS.
const backupDir = env.BACKUP_DIR ?? (production ? join(dirname(dbPath), 'backups') : '');
const backupHours = Number(env.BACKUP_INTERVAL_HOURS ?? 6);
const backupKeep = Number(env.BACKUP_KEEP ?? 28);

mkdirSync(dirname(dbPath), { recursive: true });
const ctx = createCtx(dbPath);

// First boot of a real deployment: create the distributor admin from the environment.
if (!ctx.db.get('SELECT 1 FROM users LIMIT 1')) {
  const login = env.ADMIN_LOGIN;
  const password = env.ADMIN_PASSWORD;
  if (login && password) {
    if (password.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters');
    createUser(ctx, null, { name: env.ADMIN_NAME ?? 'Distributor admin', login, password, role: 'dist_admin' });
    console.log(`Created distributor admin ${login}`);
  } else if (production) {
    throw new Error('Empty database: set ADMIN_LOGIN and ADMIN_PASSWORD for the first start');
  } else {
    console.warn('Database has no users. Set ADMIN_LOGIN and ADMIN_PASSWORD, or run `npm run seed` for demo data.');
  }
}

// Demo accounts share a published password: never serve them with real money.
if (production && ctx.db.get("SELECT 1 FROM users WHERE login = 'admin@bousol'") && env.ALLOW_DEMO_DATA !== '1') {
  throw new Error('This database holds the demo accounts. Start production on an empty database (or set ALLOW_DEMO_DATA=1 for a staging copy).');
}

const backupHealth = () => {
  if (!backupDir) return { ok: true, backups: 'off' };
  const age = lastSnapshotAgeHours(backupDir);
  // Stale when two snapshots in a row were missed (a fresh server gets one interval of grace).
  const ok = age == null ? process.uptime() < backupHours * 3600 : age <= backupHours * 2;
  return { ok, last_backup_hours_ago: age };
};

const app = buildApp(ctx, {
  staticDir: resolve(here, '../../web/dist'),
  logger: true,
  trustProxy: env.TRUST_PROXY === '1',
  health: () => ({ ...backupHealth(), version: env.APP_VERSION ?? 'dev' }),
});

// Recurring monthly benefits: check hourly; each schedule posts at most once per month.
setInterval(() => {
  try {
    const results = runRecurring(ctx, null);
    if (results.length) app.log.info({ results }, 'recurring allocations run');
  } catch (err) {
    app.log.error(err, 'recurring run failed');
  }
}, 60 * 60 * 1000).unref();

if (backupDir) {
  const backup = () => {
    try {
      const s = snapshot(ctx.db, backupDir);
      const removed = pruneSnapshots(backupDir, backupKeep);
      app.log.info({ file: s.file, bytes: s.bytes, removed: removed.length }, 'database snapshot written');
    } catch (err) {
      app.log.error(err, 'database snapshot failed');
    }
  };
  const age = lastSnapshotAgeHours(backupDir);
  if (age == null || age >= backupHours) setTimeout(backup, 60_000).unref(); // shortly after start
  setInterval(backup, backupHours * 3600 * 1000).unref();
}

// docker stop / redeploy: finish requests in flight, then write the WAL back and close the database.
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    app.log.info(`${signal}: shutting down`);
    try { await app.close(); } catch (err) { app.log.error(err); }
    ctx.db.close();
    process.exit(0);
  });
}

app.listen({ port, host: env.HOST ?? '0.0.0.0' }).then(() => {
  app.log.info({ production, dbPath, backupDir: backupDir || 'off', backupHours, trustProxy: env.TRUST_PROXY === '1' }, 'ALFA server started');
}).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
