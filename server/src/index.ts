import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { createCtx } from './context.js';
import { createUser } from './services/admin.js';
import { runRecurring } from './services/allocation.js';

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH ?? resolve(here, '../data/bousol.db');
const port = Number(process.env.PORT ?? 8787);

mkdirSync(dirname(dbPath), { recursive: true });
const ctx = createCtx(dbPath);
// First boot of a real deployment: create the distributor admin from the environment.
if (!ctx.db.get('SELECT 1 FROM users LIMIT 1')) {
  const login = process.env.ADMIN_LOGIN;
  const password = process.env.ADMIN_PASSWORD;
  if (login && password) {
    if (password.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters');
    createUser(ctx, null, { name: process.env.ADMIN_NAME ?? 'Distributor admin', login, password, role: 'dist_admin' });
    console.log(`Created distributor admin ${login}`);
  } else {
    console.warn('Database has no users. Set ADMIN_LOGIN and ADMIN_PASSWORD, or run `npm run seed` for demo data.');
  }
}

const app = buildApp(ctx, { staticDir: resolve(here, '../../web/dist'), logger: true });

// Recurring monthly benefits: check hourly; each schedule posts at most once per month.
setInterval(() => {
  try {
    const results = runRecurring(ctx, null);
    if (results.length) app.log.info({ results }, 'recurring allocations run');
  } catch (err) {
    app.log.error(err, 'recurring run failed');
  }
}, 60 * 60 * 1000).unref();

app.listen({ port, host: process.env.HOST ?? '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
