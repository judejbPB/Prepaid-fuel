import type { Db } from './db.js';
import { AppError, badRequest } from './errors.js';

/**
 * Chart of accounts. Every amount is money in minor units (HTG cents). Each line carries the lot it
 * belongs to, so every gourde traces back to one cleared bank deposit. Gallons are reference data
 * kept on redemptions, never a ledger unit.
 */
export const acct = {
  /** Distributor's bank. Debited per lot when a deposit is activated, credited when a refund is paid out. */
  bankVerified: 'dist:bank_verified',
  refundsPayable: 'dist:refunds_payable',
  unallocated: (companyId: number) => `co:${companyId}:unallocated`,
  expired: (companyId: number) => `co:${companyId}:expired`,
  available: (employeeId: number) => `emp:${employeeId}:available`,
  reserved: (employeeId: number) => `emp:${employeeId}:reserved`,
  /** Fuel sales confirmed at a station (value redeemed). */
  clearing: (stationId: number) => `stn:${stationId}:clearing`,
};

/** Accounts holding value that must never go negative at the lot level. */
const NON_NEGATIVE = /^(co:\d+:unallocated|emp:\d+:(available|reserved)|stn:\d+:clearing|dist:refunds_payable)$/;

export interface Line {
  account: string;
  /** Currency code of the amount, e.g. HTG. */
  unit: string;
  lotId: number;
  debit?: number;
  credit?: number;
}

export interface EntryInput {
  kind: string;
  refType?: string;
  refId?: number;
  companyId?: number | null;
  memo?: string;
  reversesEntryId?: number;
  createdBy: number | null;
  lines: Line[];
}

export class Ledger {
  constructor(private db: Db) {}

  /** Posts a journal entry. Debits must equal credits for every currency and every lot. */
  post(input: EntryInput): number {
    const lines = input.lines.filter((l) => (l.debit ?? 0) + (l.credit ?? 0) > 0);
    if (lines.length < 2) throw badRequest('empty_entry', 'Journal entry needs at least two non-zero lines');
    const totals = new Map<string, number>();
    for (const l of lines) {
      const d = l.debit ?? 0;
      const c = l.credit ?? 0;
      if (!Number.isInteger(d) || !Number.isInteger(c) || d < 0 || c < 0 || (d > 0 && c > 0) || !l.lotId) {
        throw badRequest('bad_line', `Invalid journal line on ${l.account}`);
      }
      const key = `${l.unit}:${l.lotId}`;
      totals.set(key, (totals.get(key) ?? 0) + d - c);
    }
    for (const [key, diff] of totals) {
      if (diff !== 0) throw badRequest('unbalanced', `Entry is unbalanced for ${key} by ${diff}`);
    }

    return this.db.tx(() => {
      const entryId = this.db.run(
        `INSERT INTO journal_entries (kind, ref_type, ref_id, company_id, memo, reverses_entry_id, created_by)
         VALUES (?,?,?,?,?,?,?)`,
        input.kind, input.refType ?? null, input.refId ?? null, input.companyId ?? null,
        input.memo ?? null, input.reversesEntryId ?? null, input.createdBy,
      ).id;
      for (const l of lines) {
        this.db.run(
          'INSERT INTO journal_lines (entry_id, account, unit, lot_id, debit, credit) VALUES (?,?,?,?,?,?)',
          entryId, l.account, l.unit, l.lotId, l.debit ?? 0, l.credit ?? 0,
        );
      }
      for (const l of lines) {
        if (!NON_NEGATIVE.test(l.account)) continue;
        if (this.balance(l.account, l.lotId) < 0) {
          throw new AppError(409, 'insufficient_balance', `Insufficient balance in ${l.account}`);
        }
      }
      return entryId;
    });
  }

  /** Posts the exact mirror of an entry (debits and credits swapped). */
  reverse(entryId: number, createdBy: number, memo: string): number {
    const entry = this.db.get('SELECT * FROM journal_entries WHERE id = ?', entryId);
    if (!entry) throw badRequest('no_entry', 'Entry to reverse not found');
    const lines = this.db.all('SELECT * FROM journal_lines WHERE entry_id = ?', entryId);
    return this.post({
      kind: 'reversal',
      refType: entry.ref_type,
      refId: entry.ref_id,
      companyId: entry.company_id,
      memo,
      reversesEntryId: entryId,
      createdBy,
      lines: lines.map((l) => ({ account: l.account, unit: l.unit, lotId: l.lot_id, debit: l.credit, credit: l.debit })),
    });
  }

  /** Balance as credits minus debits (positive = holding value). Optionally restricted to one lot. */
  balance(account: string, lotId?: number): number {
    const row =
      lotId === undefined
        ? this.db.get('SELECT COALESCE(SUM(credit - debit), 0) AS b FROM journal_lines WHERE account = ?', account)
        : this.db.get(
            'SELECT COALESCE(SUM(credit - debit), 0) AS b FROM journal_lines WHERE account = ? AND lot_id = ?',
            account, lotId,
          );
    return Number(row?.b ?? 0);
  }

  /** Positive per-lot balances of an account, earliest expiry first (FIFO consumption order). */
  lotBalances(account: string, opts: { activeOnly?: boolean } = {}) {
    const rows = this.db.all<{ lot_id: number; balance: number; expires_on: string; status: string; currency: string; code: string }>(
      `SELECT jl.lot_id, SUM(jl.credit - jl.debit) AS balance, l.expires_on, l.status, l.currency, l.code
         FROM journal_lines jl JOIN lots l ON l.id = jl.lot_id
        WHERE jl.account = ?
        GROUP BY jl.lot_id
       HAVING balance > 0
        ORDER BY l.expires_on, l.id`,
      account,
    );
    return rows.map((r) => ({ ...r, balance: Number(r.balance) })).filter((r) => !opts.activeOnly || r.status === 'active');
  }

  /** Spendable balance: positive balances on active (not frozen, not expired) lots. */
  spendable(account: string): number {
    return this.lotBalances(account, { activeOnly: true }).reduce((s, l) => s + l.balance, 0);
  }

  /** Picks amounts from lots FIFO (earliest expiry first) to cover `amount` held in `account`. */
  pickFifo(account: string, amount: number) {
    const picks: { lotId: number; amount: number; currency: string }[] = [];
    let remaining = amount;
    for (const lot of this.lotBalances(account, { activeOnly: true })) {
      if (remaining <= 0) break;
      const take = Math.min(lot.balance, remaining);
      picks.push({ lotId: lot.lot_id, amount: take, currency: lot.currency });
      remaining -= take;
    }
    if (remaining > 0) throw new AppError(409, 'insufficient_balance', 'Insufficient balance');
    return picks;
  }

  /**
   * Daily balance rule, per lot:
   * funded = unallocated + employee available + reserved + redeemed + expired + refunded + adjustments.
   * Every entry balances per lot, so each lot's lines must net to zero, and the funding debit to the
   * bank must equal the lot's cleared amount.
   */
  checkBalanceRule() {
    const lots = this.db.all<{ lot_id: number; code: string; amount: number; net: number; funded: number }>(
      `SELECT l.id AS lot_id, l.code, l.amount_minor AS amount,
              COALESCE(SUM(jl.credit - jl.debit), 0) AS net,
              COALESCE(SUM(CASE WHEN je.kind = 'funding_activated' AND jl.account = '${acct.bankVerified}' THEN jl.debit END), 0) AS funded
         FROM lots l
         LEFT JOIN journal_lines jl ON jl.lot_id = l.id
         LEFT JOIN journal_entries je ON je.id = jl.entry_id
        GROUP BY l.id`,
    );
    const issues: { lot?: string; entry?: number; problem: string }[] = [];
    for (const lot of lots) {
      if (Number(lot.net) !== 0) issues.push({ lot: lot.code, problem: `lot lines net ${lot.net}, expected 0` });
      if (Number(lot.funded) !== Number(lot.amount)) issues.push({ lot: lot.code, problem: `funded ${lot.funded} != cleared ${lot.amount}` });
    }
    const unbalanced = this.db.all(
      `SELECT entry_id, unit, lot_id, SUM(debit) - SUM(credit) AS diff FROM journal_lines
        GROUP BY entry_id, unit, lot_id HAVING diff != 0`,
    );
    for (const u of unbalanced) issues.push({ entry: u.entry_id, problem: `unbalanced ${u.unit} lot ${u.lot_id} by ${u.diff}` });
    return { ok: issues.length === 0, lotsChecked: lots.length, issues };
  }
}
