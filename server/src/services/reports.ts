import { COMPANY, DISTRIBUTOR, requireCompany, requireRole, type Actor } from '../auth.js';
import type { Ctx } from '../context.js';
import { forbidden } from '../errors.js';
import { acct } from '../ledger.js';
import { gallonsFor } from '../units.js';
import { listBatches, listRecurring } from './allocation.js';
import { listExceptions } from './exceptions.js';
import { listFunding } from './funding.js';
import { listRedemptions } from './redemption.js';

/** Sum of credits minus debits (minor units) of accounts matching a LIKE pattern, optionally for one company's lots. */
export function sumAccounts(ctx: Ctx, pattern: string, companyId?: number) {
  const row = ctx.db.get(
    `SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS b FROM journal_lines jl
       ${companyId ? 'JOIN lots l ON l.id = jl.lot_id AND l.company_id = ?' : ''}
      WHERE jl.account LIKE ?`,
    ...(companyId ? [companyId, pattern] : [pattern]),
  );
  return Number(row?.b ?? 0);
}

const contractsOf = (ctx: Ctx, companyId: number) =>
  ctx.db.all('SELECT grade, price_minor, currency FROM contracts WHERE company_id = ? AND active = 1 ORDER BY grade', companyId);

/** Reference only: how many gallons of each grade an amount buys at the company's contract prices. */
const gallonsReference = (contracts: { grade: string; price_minor: number }[], minor: number) =>
  Object.fromEntries(contracts.map((c) => [c.grade, gallonsFor(minor, c.price_minor)]));

export function distributorDashboard(ctx: Ctx, actor: Actor) {
  requireRole(actor, DISTRIBUTOR);
  const unallocated = sumAccounts(ctx, 'co:%:unallocated');
  const available = sumAccounts(ctx, 'emp:%:available');
  const reserved = sumAccounts(ctx, 'emp:%:reserved');
  const salesToday = ctx.db.all(
    `SELECT s.id, s.name, COALESCE(SUM(r.charged_minor), 0) AS minor, COALESCE(SUM(r.dispensed_mgal), 0) AS mgal, COUNT(r.id) AS count
       FROM stations s LEFT JOIN redemptions r ON r.station_id = s.id AND r.status = 'completed'
        AND date(r.completed_at) = date('now')
      GROUP BY s.id ORDER BY minor DESC, s.name`,
  );
  const companies = ctx.db.all('SELECT * FROM companies ORDER BY name').map((c) => ({
    ...c,
    unallocated_minor: sumAccounts(ctx, acct.unallocated(c.id), c.id),
    allocated_minor: sumAccounts(ctx, 'emp:%:available', c.id) + sumAccounts(ctx, 'emp:%:reserved', c.id),
    redeemed_minor: sumAccounts(ctx, 'stn:%:clearing', c.id),
    contracts: contractsOf(ctx, c.id),
  }));
  const funding = listFunding(ctx, actor);
  return {
    kpis: {
      deposits_verified: funding.filter((f) => f.status === 'matched' || f.status === 'approved').length,
      bank_verified_minor: -ctx.ledger.balance(acct.bankVerified),
      prepaid_owed_minor: unallocated + available + reserved,
      allocated_minor: available + reserved,
      redeemed_minor: sumAccounts(ctx, 'stn:%:clearing'),
      expired_minor: sumAccounts(ctx, 'co:%:expired'),
      open_exceptions: ctx.db.get("SELECT COUNT(*) AS n FROM exceptions WHERE status IN ('open','proposed')").n,
      refunds_payable_minor: ctx.ledger.balance(acct.refundsPayable),
      unmatched_bank_lines: ctx.db.get("SELECT COUNT(*) AS n FROM bank_transactions WHERE status = 'unmatched'").n,
      refunds_pending: ctx.db.get("SELECT COUNT(*) AS n FROM refunds WHERE status IN ('requested','approved')").n,
    },
    funding_queue: funding.slice(0, 12),
    sales_today: salesToday,
    companies,
    alerts: listExceptions(ctx, actor, 'open').slice(0, 5),
    balance_rule: ctx.ledger.checkBalanceRule(),
  };
}

export function companyDashboard(ctx: Ctx, actor: Actor, companyId: number) {
  requireCompany(actor, companyId);
  if (!DISTRIBUTOR.includes(actor.role)) requireRole(actor, COMPANY);
  const company = ctx.db.get('SELECT * FROM companies WHERE id = ?', companyId);
  const batches = listBatches(ctx, actor, companyId);
  const recurring = listRecurring(ctx, actor, companyId);
  const lots = ctx.db.all('SELECT * FROM lots WHERE company_id = ? ORDER BY expires_on, id', companyId).map((l) => ({
    ...l,
    unallocated_minor: ctx.ledger.balance(acct.unallocated(companyId), l.id),
    redeemed_minor: Number(ctx.db.get(
      `SELECT COALESCE(SUM(credit - debit), 0) AS b FROM journal_lines WHERE lot_id = ? AND account LIKE 'stn:%:clearing'`, l.id,
    ).b),
  }));
  const unallocated = sumAccounts(ctx, acct.unallocated(companyId), companyId);
  const contracts = contractsOf(ctx, companyId);
  return {
    company,
    contracts,
    kpis: {
      unallocated_minor: unallocated,
      spendable_unallocated_minor: ctx.ledger.spendable(acct.unallocated(companyId)),
      unallocated_gallons_ref: gallonsReference(contracts, unallocated),
      allocated_minor: sumAccounts(ctx, 'emp:%:available', companyId) + sumAccounts(ctx, 'emp:%:reserved', companyId),
      redeemed_minor: sumAccounts(ctx, 'stn:%:clearing', companyId),
      redeemed_mgal: Number(ctx.db.get("SELECT COALESCE(SUM(dispensed_mgal), 0) AS m FROM redemptions WHERE company_id = ? AND status = 'completed'", companyId).m),
      batch_ready_minor: batches.filter((b) => b.status === 'draft' || b.status === 'pending_approval').reduce((s, b) => s + b.ready_minor, 0),
      recurring: recurring.find((r) => r.status !== 'cancelled') ?? null,
    },
    batches,
    recurring,
    lots,
    funding: listFunding(ctx, actor, companyId),
  };
}

/** Whether this phone holds the employee's enrolled signing key (needed to approve fuelings offline). */
function walletDevice(ctx: Ctx, employeeId: number, deviceId: string | null) {
  const d = ctx.db.get("SELECT id, device_id FROM employee_devices WHERE employee_id = ? AND status = 'active'", employeeId);
  return { enrolled: !!d, key_id: d && d.device_id === deviceId ? d.id : null, on_this_phone: !!d && d.device_id === deviceId };
}

export function wallet(ctx: Ctx, actor: Actor) {
  requireRole(actor, ['employee']);
  const emp = ctx.db.get(
    'SELECT e.*, c.name AS company_name, c.status AS company_status FROM employees e JOIN companies c ON c.id = e.company_id WHERE e.id = ?',
    actor.employeeId,
  );
  const lots = ctx.ledger.lotBalances(acct.available(emp.id));
  const available = lots.filter((l) => l.status === 'active').reduce((s, l) => s + l.balance, 0);
  const contracts = contractsOf(ctx, emp.company_id);
  return {
    employee: { id: emp.id, name: emp.name, status: emp.status, company_name: emp.company_name, company_status: emp.company_status },
    device: walletDevice(ctx, emp.id, actor.deviceId),
    synced_at: new Date().toISOString(),
    currency: lots[0]?.currency ?? contracts[0]?.currency ?? 'HTG',
    available_minor: available,
    reserved_minor: ctx.ledger.balance(acct.reserved(emp.id)),
    prices: contracts,
    gallons_ref: gallonsReference(contracts, available),
    next_expiry: lots.find((l) => l.status === 'active')?.expires_on ?? null,
    lots: lots.map((l) => ({ code: l.code, balance: l.balance, currency: l.currency, expires_on: l.expires_on, status: l.status })),
    history: listRedemptions(ctx, { employeeId: emp.id, limit: 30 }),
    disputes: listExceptions(ctx, actor),
  };
}

export function journal(ctx: Ctx, actor: Actor, companyId?: number) {
  if (!DISTRIBUTOR.includes(actor.role)) {
    if (!COMPANY.includes(actor.role)) throw forbidden();
    companyId = actor.companyId!;
  }
  const entries = ctx.db.all(
    `SELECT je.*, u.name AS created_by_name, c.name AS company_name FROM journal_entries je
       LEFT JOIN users u ON u.id = je.created_by LEFT JOIN companies c ON c.id = je.company_id
      ${companyId ? 'WHERE je.company_id = ?' : ''} ORDER BY je.id DESC LIMIT 150`,
    ...(companyId ? [companyId] : []),
  );
  const label = accountLabeler(ctx);
  return entries.map((e) => ({
    ...e,
    lines: ctx.db
      .all('SELECT jl.*, l.code AS lot_code FROM journal_lines jl LEFT JOIN lots l ON l.id = jl.lot_id WHERE entry_id = ? ORDER BY jl.id', e.id)
      .map((l) => ({ ...l, account_label: label(l.account) })),
  }));
}

const ACCOUNT_NAMES: Record<string, string> = {
  unallocated: 'unallocated', available: 'available', reserved: 'reserved', clearing: 'fuel sales',
  expired: 'expired', bank_verified: 'verified bank funds', refunds_payable: 'refunds payable',
};

/** Turns account keys like `emp:3:available` into "Paul D. · available". */
export function accountLabeler(ctx: Ctx) {
  const names = {
    co: new Map(ctx.db.all('SELECT id, name FROM companies').map((r) => [String(r.id), r.name])),
    emp: new Map(ctx.db.all('SELECT id, name FROM employees').map((r) => [String(r.id), r.name])),
    stn: new Map(ctx.db.all('SELECT id, name FROM stations').map((r) => [String(r.id), r.name])),
  };
  return (account: string) => {
    const [kind, idOrName, sub] = account.split(':');
    if (kind === 'dist') return `Distributor · ${ACCOUNT_NAMES[idOrName] ?? idOrName}`;
    const owner = names[kind as 'co' | 'emp' | 'stn']?.get(idOrName) ?? `${kind} ${idOrName}`;
    return `${owner} · ${ACCOUNT_NAMES[sub] ?? sub}`;
  };
}

export function stationOverview(ctx: Ctx, actor: Actor, stationId: number) {
  if (!DISTRIBUTOR.includes(actor.role) && actor.stationId !== stationId) throw forbidden();
  return {
    station: ctx.db.get('SELECT * FROM stations WHERE id = ?', stationId),
    terminal: ctx.db.get("SELECT id, label, status, activation_code IS NULL AND device_key_hash IS NOT NULL AS activated FROM terminals WHERE station_id = ? AND status != 'retired'", stationId),
    redemptions: listRedemptions(ctx, { stationId, limit: 50 }),
    exceptions: listExceptions(ctx, actor).filter((e) => e.station_id === stationId),
  };
}
