import { COMPANY, DISTRIBUTOR, requireCompany, requireRole, type Actor } from '../auth.js';
import type { Ctx } from '../context.js';
import { forbidden } from '../errors.js';
import { acct, GAL } from '../ledger.js';
import { listBatches, listRecurring } from './allocation.js';
import { listExceptions } from './exceptions.js';
import { listFunding } from './funding.js';
import { listRedemptions } from './redemption.js';

/** Sum of credits minus debits of gallon accounts matching a LIKE pattern, optionally by company lots. */
function sumGallons(ctx: Ctx, pattern: string, companyId?: number) {
  const row = ctx.db.get(
    `SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS b FROM journal_lines jl
       ${companyId ? 'JOIN lots l ON l.id = jl.lot_id AND l.company_id = ?' : ''}
      WHERE jl.unit = '${GAL}' AND jl.account LIKE ?`,
    ...(companyId ? [companyId, pattern] : [pattern]),
  );
  return Number(row?.b ?? 0);
}

export function distributorDashboard(ctx: Ctx, actor: Actor) {
  requireRole(actor, DISTRIBUTOR);
  const unallocated = sumGallons(ctx, 'co:%:unallocated');
  const available = sumGallons(ctx, 'emp:%:available');
  const reserved = sumGallons(ctx, 'emp:%:reserved');
  const redemptionsToday = ctx.db.all(
    `SELECT s.id, s.name, COALESCE(SUM(r.dispensed_mgal), 0) AS mgal, COUNT(r.id) AS count
       FROM stations s LEFT JOIN redemptions r ON r.station_id = s.id AND r.status = 'completed'
        AND date(r.completed_at) = date('now')
      GROUP BY s.id ORDER BY mgal DESC, s.name`,
  );
  const companies = ctx.db.all('SELECT * FROM companies ORDER BY name').map((c) => ({
    ...c,
    unallocated_mgal: sumGallons(ctx, acct.unallocated(c.id), c.id),
    allocated_mgal: sumGallons(ctx, 'emp:%:available', c.id) + sumGallons(ctx, 'emp:%:reserved', c.id),
    redeemed_mgal: sumGallons(ctx, 'stn:%:clearing', c.id),
    liability_minor: ctx.ledger.balance(acct.prepaidLiability(c.id)),
    contracts: ctx.db.all('SELECT grade, price_minor, currency FROM contracts WHERE company_id = ? AND active = 1', c.id),
  }));
  const funding = listFunding(ctx, actor);
  return {
    kpis: {
      deposits_verified: funding.filter((f) => f.status === 'matched' || f.status === 'approved').length,
      gallons_owed_mgal: unallocated + available + reserved,
      gallons_allocated_mgal: available + reserved,
      open_exceptions: ctx.db.get("SELECT COUNT(*) AS n FROM exceptions WHERE status IN ('open','proposed')").n,
      bank_verified_minor: -ctx.ledger.balance(acct.bankVerified),
      revenue_minor: ctx.ledger.balance(acct.fuelRevenue),
      breakage_minor: ctx.ledger.balance(acct.breakage),
    },
    funding_queue: funding.slice(0, 12),
    redemptions_today: redemptionsToday,
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
    unallocated_mgal: ctx.ledger.balance(acct.unallocated(companyId), l.id),
    redeemed_mgal: ctx.db.get(
      `SELECT COALESCE(SUM(credit - debit), 0) AS b FROM journal_lines WHERE lot_id = ? AND account LIKE 'stn:%:clearing'`, l.id,
    ).b,
  }));
  return {
    company,
    contracts: ctx.db.all('SELECT * FROM contracts WHERE company_id = ? AND active = 1 ORDER BY grade', companyId),
    kpis: {
      unallocated_mgal: sumGallons(ctx, acct.unallocated(companyId), companyId),
      unallocated_by_grade: ctx.ledger.byGrade(acct.unallocated(companyId), true),
      allocated_mgal: sumGallons(ctx, 'emp:%:available', companyId) + sumGallons(ctx, 'emp:%:reserved', companyId),
      redeemed_mgal: sumGallons(ctx, 'stn:%:clearing', companyId),
      batch_ready_mgal: batches.filter((b) => b.status === 'draft' || b.status === 'pending_approval').reduce((s, b) => s + b.ready_mgal, 0),
      recurring: recurring.find((r) => r.status !== 'cancelled') ?? null,
      liability_minor: ctx.ledger.balance(acct.prepaidLiability(companyId)),
    },
    batches,
    recurring,
    lots,
    funding: listFunding(ctx, actor, companyId),
  };
}

export function wallet(ctx: Ctx, actor: Actor) {
  requireRole(actor, ['employee']);
  const emp = ctx.db.get(
    'SELECT e.*, c.name AS company_name, c.status AS company_status FROM employees e JOIN companies c ON c.id = e.company_id WHERE e.id = ?',
    actor.employeeId,
  );
  const lots = ctx.ledger.lotBalances(acct.available(emp.id));
  const byGrade: Record<string, number> = {};
  for (const l of lots) if (l.status === 'active') byGrade[l.grade] = (byGrade[l.grade] ?? 0) + l.balance;
  const programGrades = ctx.db.all('SELECT grade FROM contracts WHERE company_id = ? AND active = 1', emp.company_id).map((r) => r.grade);
  return {
    employee: { id: emp.id, name: emp.name, status: emp.status, company_name: emp.company_name, company_status: emp.company_status, has_pin: !!emp.pin_hash },
    available_mgal: Object.values(byGrade).reduce((s, v) => s + v, 0),
    by_grade: byGrade,
    program_grades: programGrades,
    reserved_mgal: ctx.ledger.balance(acct.reserved(emp.id)),
    next_expiry: lots.find((l) => l.status === 'active')?.expires_on ?? null,
    lots: lots.map((l) => ({ code: l.code, grade: l.grade, balance: l.balance, expires_on: l.expires_on, status: l.status })),
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
  return entries.map((e) => ({
    ...e,
    lines: ctx.db.all(
      'SELECT jl.*, l.code AS lot_code FROM journal_lines jl LEFT JOIN lots l ON l.id = jl.lot_id WHERE entry_id = ? ORDER BY jl.id', e.id,
    ),
  }));
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
