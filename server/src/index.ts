import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { createCtx } from './context.js';
import { runRecurring } from './services/allocation.js';

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH ?? resolve(here, '../data/bousol.db');
const port = Number(process.env.PORT ?? 8787);

mkdirSync(dirname(dbPath), { recursive: true });
const ctx = createCtx(dbPath);
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
