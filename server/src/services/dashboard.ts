// Reporting dashboard for the distributor: key figures for a period (Haiti dates), compared with the same-length
// period just before, optionally filtered to one client company and/or one station. Read-only.
import { DISTRIBUTOR, requireRole, type Actor } from '../auth.js';
import type { Ctx } from '../context.js';
import { badRequest } from '../errors.js';
import { acct } from '../ledger.js';
import { sumAccounts } from './reports.js';

const TZ = 'America/Port-au-Prince';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const haitiDay = (utc: string) => dayFmt.format(new Date(utc.replace(' ', 'T') + 'Z'));
const ISO = /^\d{4}-\d{2}-\d{2}$/;

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
/** UTC timestamps a day wider than the Haiti period; rows are then kept by their Haiti date. */
const utcBounds = (from: string, to: string) => [`${addDays(from, -1)} 00:00:00`, `${addDays(to, 1)} 23:59:59`];

export interface DashboardFilter { from: string; to: string; companyId?: number; stationId?: number }

interface Sale { day: string; company_id: number; company: string; station_id: number; station: string; grade: string; employee_id: number; mgal: number; minor: number; offline: number }

function salesBetween(ctx: Ctx, from: string, to: string, f: DashboardFilter): Sale[] {
  const [a, b] = utcBounds(from, to);
  return ctx.db.all<any>(
    `SELECT r.completed_at, r.company_id, c.name AS company, r.station_id, s.name AS station, r.grade, r.employee_id,
            COALESCE(r.dispensed_mgal, 0) AS mgal, COALESCE(r.charged_minor, 0) AS minor, r.offline
       FROM redemptions r JOIN companies c ON c.id = r.company_id JOIN stations s ON s.id = r.station_id
      WHERE r.status = 'completed' AND r.completed_at BETWEEN ? AND ?
        ${f.companyId ? 'AND r.company_id = ?' : ''} ${f.stationId ? 'AND r.station_id = ?' : ''}`,
    a, b, ...[f.companyId, f.stationId].filter((x): x is number => !!x),
  ).map((r) => ({ ...r, day: haitiDay(r.completed_at) })).filter((r) => r.day >= from && r.day <= to);
}

function depositsBetween(ctx: Ctx, from: string, to: string, f: DashboardFilter) {
  if (f.stationId && !f.companyId) return { count: 0, minor: 0, byCompany: [] as { name: string; minor: number }[] };
  const [a, b] = utcBounds(from, to);
  const rows = ctx.db.all<any>(
    `SELECT f.approved_at, COALESCE(f.bank_amount_minor, f.amount_minor) AS minor, c.name FROM funding_requests f
       JOIN companies c ON c.id = f.company_id
      WHERE f.status = 'approved' AND f.approved_at BETWEEN ? AND ? ${f.companyId ? 'AND f.company_id = ?' : ''}`,
    a, b, ...(f.companyId ? [f.companyId] : []),
  ).filter((r) => { const d = haitiDay(r.approved_at); return d >= from && d <= to; });
  const byCompany = new Map<string, number>();
  for (const r of rows) byCompany.set(r.name, (byCompany.get(r.name) ?? 0) + r.minor);
  return { count: rows.length, minor: rows.reduce((t, r) => t + r.minor, 0), byCompany: [...byCompany].map(([name, minor]) => ({ name, minor })) };
}

const totals = (sales: Sale[]) => ({
  minor: sales.reduce((t, s) => t + s.minor, 0),
  mgal: sales.reduce((t, s) => t + s.mgal, 0),
  fuelings: sales.length,
  employees: new Set(sales.map((s) => s.employee_id)).size,
  offline: sales.filter((s) => s.offline).length,
});

function groupBy(sales: Sale[], key: (s: Sale) => string) {
  const m = new Map<string, { minor: number; mgal: number; fuelings: number }>();
  for (const s of sales) {
    const g = m.get(key(s)) ?? { minor: 0, mgal: 0, fuelings: 0 };
    g.minor += s.minor; g.mgal += s.mgal; g.fuelings++;
    m.set(key(s), g);
  }
  return [...m].map(([name, g]) => ({ name, ...g })).sort((x, y) => y.minor - x.minor);
}

export function dashboard(ctx: Ctx, actor: Actor, f: DashboardFilter) {
  requireRole(actor, DISTRIBUTOR);
  if (!ISO.test(f.from) || !ISO.test(f.to) || f.from > f.to) throw badRequest('bad_period', 'Choose a start date on or before the end date');
  const length = daysBetween(f.from, f.to) + 1;
  if (length > 400) throw badRequest('bad_period', 'Choose a period of at most 400 days');
  const prevTo = addDays(f.from, -1);
  const prevFrom = addDays(prevTo, -(length - 1));

  const sales = salesBetween(ctx, f.from, f.to, f);
  const prevSales = salesBetween(ctx, prevFrom, prevTo, f);

  // One point per day (zeros included), or per month when the period is long.
  const monthly = length > 92;
  const bucket = (day: string) => (monthly ? day.slice(0, 7) : day);
  const series = new Map<string, { minor: number; mgal: number; fuelings: number }>();
  for (let d = f.from; d <= f.to; d = addDays(d, 1)) series.set(bucket(d), { minor: 0, mgal: 0, fuelings: 0 });
  for (const s of sales) { const p = series.get(bucket(s.day))!; p.minor += s.minor; p.mgal += s.mgal; p.fuelings++; }

  const companies = ctx.db.all<{ id: number; name: string; status: string }>(
    `SELECT id, name, status FROM companies ${f.companyId ? 'WHERE id = ?' : ''} ORDER BY name`, ...(f.companyId ? [f.companyId] : []));
  const prepaid = companies.map((c) => ({
    name: c.name, frozen: c.status === 'frozen',
    unallocated_minor: sumAccounts(ctx, acct.unallocated(c.id), c.id),
    wallets_minor: sumAccounts(ctx, 'emp:%:available', c.id) + sumAccounts(ctx, 'emp:%:reserved', c.id),
    used_minor: sumAccounts(ctx, 'stn:%:clearing', c.id),
    expired_minor: sumAccounts(ctx, acct.expired(c.id), c.id),
  }));

  const [a, b] = utcBounds(f.from, f.to);
  const inPeriod = (col: string) => (r: any) => { const d = haitiDay(r[col]); return d >= f.from && d <= f.to; };
  const scopeSql = `${f.companyId ? 'AND company_id = ?' : ''} ${f.stationId ? 'AND station_id = ?' : ''}`;
  const scopeArgs = [f.companyId, f.stationId].filter((x): x is number => !!x);
  const exceptions = ctx.db.all<any>(`SELECT kind, status, created_at FROM exceptions WHERE created_at BETWEEN ? AND ? ${scopeSql}`, a, b, ...scopeArgs).filter(inPeriod('created_at'));
  const alertsOpen = Number(ctx.db.get(`SELECT COUNT(*) AS n FROM fuel_alerts WHERE status = 'open' ${scopeSql}`, ...scopeArgs)!.n);
  const shifts = ctx.db.all<any>(
    `SELECT status, variance_minor, variance_mgal, opened_at FROM shifts WHERE opened_at BETWEEN ? AND ? ${f.stationId ? 'AND station_id = ?' : ''}`,
    a, b, ...(f.stationId ? [f.stationId] : []),
  ).filter(inPeriod('opened_at'));
  const refundsPaid = ctx.db.all<any>(
    `SELECT amount_minor, decided_at FROM refunds WHERE status = 'paid' AND decided_at BETWEEN ? AND ? ${f.companyId ? 'AND company_id = ?' : ''}`,
    a, b, ...(f.companyId ? [f.companyId] : []),
  ).filter(inPeriod('decided_at'));

  const now = totals(sales);
  const before = totals(prevSales);
  return {
    period: { from: f.from, to: f.to, days: length, previous: { from: prevFrom, to: prevTo }, grain: monthly ? 'month' : 'day' },
    kpis: {
      sales_minor: now.minor, sales_minor_prev: before.minor,
      gallons_mgal: now.mgal, gallons_mgal_prev: before.mgal,
      fuelings: now.fuelings, fuelings_prev: before.fuelings,
      active_employees: now.employees, active_employees_prev: before.employees,
      avg_fill_mgal: now.fuelings ? Math.round(now.mgal / now.fuelings) : 0,
      avg_fill_mgal_prev: before.fuelings ? Math.round(before.mgal / before.fuelings) : 0,
      deposits_minor: depositsBetween(ctx, f.from, f.to, f).minor,
      deposits_minor_prev: depositsBetween(ctx, prevFrom, prevTo, f).minor,
      prepaid_owed_minor: prepaid.reduce((t, c) => t + c.unallocated_minor + c.wallets_minor, 0),
      refunds_paid_minor: refundsPaid.reduce((t, r) => t + r.amount_minor, 0),
    },
    series: [...series].map(([period, p]) => ({ period, ...p })),
    by_station: groupBy(sales, (s) => s.station),
    by_company: groupBy(sales, (s) => s.company),
    by_grade: groupBy(sales, (s) => s.grade),
    deposits_by_company: depositsBetween(ctx, f.from, f.to, f).byCompany,
    prepaid,
    operations: {
      disputes: exceptions.filter((e) => e.kind === 'dispute').length,
      open_exceptions: exceptions.filter((e) => e.status === 'open' || e.status === 'proposed').length,
      shift_differences: shifts.filter((s) => s.status === 'held' || (s.variance_minor ?? 0) !== 0 || (s.variance_mgal ?? 0) !== 0).length,
      shifts: shifts.length,
      open_fuel_alerts: alertsOpen,
      offline_share_pct: now.fuelings ? Math.round((now.offline / now.fuelings) * 100) : 0,
      unmatched_bank_lines: Number(ctx.db.get("SELECT COUNT(*) AS n FROM bank_transactions WHERE status = 'unmatched'")!.n),
    },
  };
}
