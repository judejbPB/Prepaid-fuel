import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCtx } from './context.js';
import { seedDemo } from './demo.js';

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH ?? resolve(here, '../data/bousol.db');

// Seeding wipes the database: never on a production server unless explicitly forced (e.g. a staging copy).
if (process.env.NODE_ENV === 'production' && !process.argv.includes('--force')) {
  console.error('Refusing to seed: NODE_ENV=production. This deletes the database and loads demo accounts. Use --force on a staging server only.');
  process.exit(1);
}

mkdirSync(dirname(dbPath), { recursive: true });
for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });

const ctx = createCtx(dbPath);
const info = seedDemo(ctx);
console.log(`Seeded demo data into ${dbPath}`);
console.log(JSON.stringify(info, null, 2));
