import type { Db } from './db.js';
import { AppError, badRequest } from './errors.js';

export const GAL = 'mgal';

/** Chart of accounts. Gallon accounts are tracked per fuel lot so every gallon traces to cleared funds. */
export const acct = {
  // gallons
  issued: (companyId: number) => `co:${companyId}:issued`,
  unallocated: (companyId: number) => `co:${companyId}:unallocated`,
  available: (employeeId: number) => `emp:${employeeId}:available`,
  reserved: (employeeId: number) => `emp:${employeeId}:reserved`,
  clearing: (stationId: number) => `stn:${stationId}:clearing`,
  expired: (companyId: number) => `co:${companyId}:expired`,
  refunded: (companyId: number) => `co:${companyId}:refunded`,
  adjustment: (companyId: number) => `co:${companyId}:adjustment`,
  // money
  bankVerified: 'dist:bank_verified',
  prepaidLiability: (companyId: number) => `co:${companyId}:prepaid_liability`,
  fuelRevenue: 'dist:fuel_revenue',
  breakage: 'dist:breakage',
};

/** Accounts that hold gallons and must never go negative at the lot level. */
const NON_NEGATIVE = /^(co:\d+:unallocated|emp:\d+:(available|reserved)|stn:\d+:clearing)$/;

export interface Line {
  account: string;
  unit: string;
  lotId?: number | null;
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

  /** Posts a balanced journal entry. Debits must equal credits for every unit. */
  post(input: EntryInput): number {
    const lines = input.lines.filter((l) => (l.debit ?? 0) + (l.credit ?? 0) > 0);
    if (lines.length < 2) throw badRequest('empty_entry', 'Journal entry needs at least two non-zero lines');
    const totals = new Map<string, number>();
    for (const l of lines) {
      const d = l.debit ?? 0;
      const c = l.credit ?? 0;
      if (!Number.isInteger(d) || !Number.isInteger(c) || d < 0 || c < 0 || (d > 0 && c > 0)) {
        throw badRequest('bad_line', `Invalid journal line on ${l.account}`);
      }
      totals.set(l.unit, (totals.get(l.unit) ?? 0) + d - c);
    }
    for (const [unit, diff] of totals) {
      if (diff !== 0) throw badRequest('unbalanced', `Entry is unbalanced in ${unit} by ${diff}`);
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
          entryId, l.account, l.unit, l.lotId ?? null, l.debit ?? 0, l.credit ?? 0,
        );
      }
      for (const l of lines) {
        if (l.unit !== GAL || !NON_NEGATIVE.test(l.account)) continue;
        if (this.balance(l.account, l.lotId ?? undefined) < 0) {
          throw new AppError(409, 'insufficient_balance', `Insufficient gallons in ${l.account}`);
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

  /** Balance as credits minus debits (positive = holding). Optionally restricted to one lot. */
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

  /** Positive per-lot balances of a gallon account, earliest expiry first (FIFO consumption order). */
  lotBalances(account: string, opts: { grade?: string; activeOnly?: boolean } = {}) {
    const rows = this.db.all<{ lot_id: number; balance: number; grade: string; expires_on: string; status: string; price_minor: number; currency: string; code: string }>(
      `SELECT jl.lot_id, SUM(jl.credit - jl.debit) AS balance,
              l.grade, l.expires_on, l.status, l.price_minor, l.currency, l.code
         FROM journal_lines jl JOIN lots l ON l.id = jl.lot_id
        WHERE jl.account = ? AND jl.unit = '${GAL}'
        GROUP BY jl.lot_id
       HAVING balance > 0
        ORDER BY l.expires_on, l.id`,
      account,
    );
    return rows
      .map((r) => ({ ...r, balance: Number(r.balance) }))
      .filter((r) => (!opts.grade || r.grade === opts.grade) && (!opts.activeOnly || r.status === 'active'));
  }

  /** Gallon balance of an account broken down by grade. */
  byGrade(account: string, activeOnly = false): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.lotBalances(account, { activeOnly })) out[r.grade] = (out[r.grade] ?? 0) + r.balance;
    return out;
  }

  /**
   * Picks quantities from lots FIFO to cover `mgal` of `grade` held in `account`.
   * Throws if the active balance is insufficient.
   */
  pickFifo(account: string, grade: string, mgal: number) {
    const picks: { lotId: number; mgal: number; priceMinor: number; currency: string }[] = [];
    let remaining = mgal;
    for (const lot of this.lotBalances(account, { grade, activeOnly: true })) {
      if (remaining <= 0) break;
      const take = Math.min(lot.balance, remaining);
      picks.push({ lotId: lot.lot_id, mgal: take, priceMinor: lot.price_minor, currency: lot.currency });
      remaining -= take;
    }
    if (remaining > 0) throw new AppError(409, 'insufficient_balance', `Insufficient ${grade} gallons`);
    return picks;
  }

  /**
   * Daily balance rule, per company and per lot:
   * funded = unallocated + employee available + reserved + redeemed + expired + refunded + adjustments.
   * With double entry this holds iff every lot's gallon lines sum to zero.
   */
  checkBalanceRule() {
    const lots = this.db.all<{ lot_id: number; code: string; company_id: number; funded: number; net: number }>(
      `SELECT l.id AS lot_id, l.code, l.company_id, l.gallons_mgal AS funded,
              COALESCE(SUM(jl.credit - jl.debit), 0) AS net
         FROM lots l LEFT JOIN journal_lines jl ON jl.lot_id = l.id AND jl.unit = '${GAL}'
        GROUP BY l.id`,
    );
    const issues = [];
    for (const lot of lots) {
      const issued = -this.balance(acct.issued(lot.company_id), lot.lot_id);
      if (Number(lot.net) !== 0) issues.push({ lot: lot.code, problem: `lot lines net ${lot.net}, expected 0` });
      if (issued !== Number(lot.funded)) issues.push({ lot: lot.code, problem: `issued ${issued} != funded ${lot.funded}` });
    }
    const unbalanced = this.db.all(
      `SELECT entry_id, unit, SUM(debit) - SUM(credit) AS diff FROM journal_lines
        GROUP BY entry_id, unit HAVING diff != 0`,
    );
    for (const u of unbalanced) issues.push({ entry: u.entry_id, problem: `unbalanced ${u.unit} by ${u.diff}` });
    return { ok: issues.length === 0, lotsChecked: lots.length, issues };
  }
}
