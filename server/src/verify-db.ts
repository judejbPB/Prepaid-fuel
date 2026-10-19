// Checks a database file, e.g. one restored from a backup: SQLite integrity, the ledger's balance rules, and how
// many records it holds. Exits with 1 when something is wrong. Usage: npm run verify-db -w server -- <file>
import { existsSync } from 'node:fs';
import { createCtx } from './context.js';

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.error('Usage: verify-db <database file>');
  process.exit(2);
}
const ctx = createCtx(file);
const integrity = (ctx.db.get('PRAGMA integrity_check') as { integrity_check: string }).integrity_check;
const ledger = ctx.ledger.checkBalanceRule();
const count = (table: string) => Number(ctx.db.get(`SELECT COUNT(*) AS n FROM ${table}`).n);
const last = ctx.db.get<{ at: string | null }>('SELECT MAX(created_at) AS at FROM journal_entries')?.at ?? null;
const report = {
  file, integrity, ledger_ok: ledger.ok, ledger_issues: ledger.issues.slice(0, 10), lots_checked: ledger.lotsChecked,
  users: count('users'), companies: count('companies'), employees: count('employees'), stations: count('stations'),
  journal_entries: count('journal_entries'), fuelings: count('redemptions'), last_ledger_entry: last,
};
console.log(JSON.stringify(report, null, 2));
ctx.db.close();
process.exit(integrity === 'ok' && ledger.ok ? 0 : 1);
