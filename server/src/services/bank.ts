import { DISTRIBUTOR, requireRole, type Actor } from '../auth.js';
import type { Ctx } from '../context.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { getFunding, matchFunding } from './funding.js';

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',' || ch === ';') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

const COLUMN_ALIASES: Record<string, string[]> = {
  date: ['date', 'value date', 'value_date', 'posting date', 'transaction date'],
  reference: ['reference', 'bank reference', 'transaction id', 'transaction reference', 'ref', 'txn id'],
  amount: ['amount', 'credit', 'credit amount', 'montant'],
  memo: ['memo', 'description', 'narration', 'details', 'libelle', 'libellé', 'remarks'],
  currency: ['currency', 'ccy', 'devise'],
};

/** Parses "1,234.56", "1 234,56" or "HTG 1234.56" into minor units. */
export function parseAmount(raw: string): number | null {
  let s = raw.replace(/[^\d.,-]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.'); // European format
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

const FUNDING_REF = /TR-?\s?(\d{3,})/i;

/**
 * Imports a bank statement and auto-matches deposits whose memo carries a funding reference
 * (TR-xxxx) and whose amount equals the expected transfer. The importer counts as the matcher,
 * so a different approver still has to activate each lot.
 */
export function importStatement(ctx: Ctx, actor: Actor, csv: string) {
  requireRole(actor, ['dist_treasury', 'dist_admin']);
  const rows = parseCsv(csv);
  if (rows.length < 2) throw badRequest('empty_statement', 'Statement needs a header row and at least one line');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.findIndex((h) => COLUMN_ALIASES[name].includes(h));
  const idx = { date: col('date'), reference: col('reference'), amount: col('amount'), memo: col('memo'), currency: col('currency') };
  if (idx.reference < 0 || idx.amount < 0) {
    throw badRequest('bad_columns', 'Statement needs at least "reference" and "amount" columns');
  }

  const summary = { imported: 0, duplicates: 0, skipped: 0, matched: [] as string[], unmatched: 0 };
  return ctx.db.tx(() => {
  for (const r of rows.slice(1)) {
    const reference = (r[idx.reference] ?? '').trim();
    const amount = parseAmount(r[idx.amount] ?? '');
    if (!reference || amount === null || amount <= 0) { summary.skipped++; continue; } // debits and blank lines
    if (ctx.db.get('SELECT 1 FROM bank_transactions WHERE bank_reference = ?', reference)) { summary.duplicates++; continue; }
    const memo = idx.memo >= 0 ? (r[idx.memo] ?? '').trim() : '';
    const txnId = ctx.db.run(
      'INSERT INTO bank_transactions (bank_reference, value_date, amount_minor, currency, memo, imported_by) VALUES (?,?,?,?,?,?)',
      reference, idx.date >= 0 ? (r[idx.date] ?? '').trim() : null, amount,
      idx.currency >= 0 && r[idx.currency]?.trim() ? r[idx.currency].trim().toUpperCase() : 'HTG', memo, actor.userId,
    ).id;
    summary.imported++;

    const m = FUNDING_REF.exec(memo) ?? FUNDING_REF.exec(reference);
    const funding = m ? ctx.db.get("SELECT * FROM funding_requests WHERE reference = ?", `TR-${m[1]}`) : undefined;
    let note: string;
    if (!funding) note = m ? `No funding request TR-${m[1]}` : 'No TR- reference in memo';
    else if (funding.status !== 'awaiting_bank') note = `TR-${m![1]} is already ${funding.status}`;
    else if (funding.amount_minor !== amount) note = `Amount differs from TR-${m![1]} (expected ${(funding.amount_minor / 100).toFixed(2)})`;
    else {
      matchFunding(ctx, actor, funding.id, { bankReference: reference, bankAmountMinor: amount });
      summary.matched.push(funding.reference);
      continue;
    }
    ctx.db.run('UPDATE bank_transactions SET note = ? WHERE id = ?', note, txnId);
    summary.unmatched++;
  }
  ctx.db.audit(actor.userId, 'bank.import', 'bank_statement', null, summary);
  return summary;
  });
}

export function listBankTransactions(ctx: Ctx, actor: Actor) {
  requireRole(actor, DISTRIBUTOR);
  return ctx.db.all(
    `SELECT b.*, f.reference AS funding_reference, c.name AS company_name FROM bank_transactions b
       LEFT JOIN funding_requests f ON f.id = b.funding_id LEFT JOIN companies c ON c.id = f.company_id
      ORDER BY b.status = 'unmatched' DESC, b.id DESC LIMIT 300`,
  );
}

/** Treasury links an unmatched bank line to a funding request by hand (e.g. memo was missing). */
export function matchTransaction(ctx: Ctx, actor: Actor, txnId: number, fundingId: number) {
  requireRole(actor, ['dist_treasury', 'dist_admin']);
  return ctx.db.tx(() => {
    const txn = ctx.db.get('SELECT * FROM bank_transactions WHERE id = ?', txnId);
    if (!txn) throw notFound('Bank line');
    matchFunding(ctx, actor, fundingId, { bankReference: txn.bank_reference, bankAmountMinor: txn.amount_minor });
    return getFunding(ctx, fundingId);
  });
}

export function ignoreTransaction(ctx: Ctx, actor: Actor, txnId: number, note: string) {
  requireRole(actor, ['dist_treasury', 'dist_admin']);
  const txn = ctx.db.get('SELECT * FROM bank_transactions WHERE id = ?', txnId);
  if (!txn) throw notFound('Bank line');
  if (txn.status !== 'unmatched') throw conflict('bad_state', `Bank line is ${txn.status}`);
  ctx.db.run("UPDATE bank_transactions SET status = 'ignored', note = ? WHERE id = ?", note, txnId);
  ctx.db.audit(actor.userId, 'bank.ignore', 'bank_transaction', txnId, { note });
  return ctx.db.get('SELECT * FROM bank_transactions WHERE id = ?', txnId);
}
