// Fuel usage dashboard for a client company: what it gave its employees, what they used, at which stations and
// which fuel, month by month (Haiti dates), with simple flags for usage that stands out. Read-only. The company sees
// its own figures; the distributor can open any company's.
import { COMPANY, DISTRIBUTOR, requireCompany, requireRole, type Actor } from '../auth.js';
import type { Ctx } from '../context.js';
import { badRequest, notFound } from '../errors.js';

const TZ = 'America/Port-au-Prince';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const haitiDay = (utc: string) => dayFmt.format(new Date(utc.replace(' ', 'T') + 'Z'));

/** Flag thresholds, kept simple so a company can read them: */
export const USAGE_RULES = {
  /** Last full month (or the current month so far) at least this much above the employee's usual month... */
  abovePct: 50,
  /** ...and by at least this many gallons (so 2 → 4 gal is not flagged). */
  aboveMinMgal: 10_000,
  /** Employees fueling at this many different stations in the last full month or the current one. */
  manyStations: 3,
};

/** The last n months ending with the current Haiti month, oldest first ("2026-05"…"2026-10"). */
function lastMonths(n: number) {
  const [y, m] = dayFmt.format(new Date()).split('-').map(Number);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (n - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}

type Cell = { mgal: number; minor: number; fuelings: number };
const cell = (): Cell => ({ mgal: 0, minor: 0, fuelings: 0 });
const add = (c: Cell, mgal: number, minor: number) => { c.mgal += mgal; c.minor += minor; c.fuelings++; };
const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

export function companyUsage(ctx: Ctx, actor: Actor, companyId: number, opts: { months?: number; dept?: string } = {}) {
  requireCompany(actor, companyId);
  if (!DISTRIBUTOR.includes(actor.role)) requireRole(actor, COMPANY);
  const company = ctx.db.get('SELECT id, name, status FROM companies WHERE id = ?', companyId);
  if (!company) throw notFound('Company');
  const n = opts.months ?? 6;
  if (![3, 6, 12].includes(n)) throw badRequest('bad_period', 'Choose 3, 6 or 12 months');
  const months = lastMonths(n);
  const first = months[0];
  const inRange = (utc: string) => { const mo = haitiDay(utc).slice(0, 7); return mo >= first ? mo : null; };
  // A day earlier in UTC than the first Haiti day, then kept by Haiti month.
  const since = `${new Date(Date.parse(`${first}-01T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)} 00:00:00`;

  const employees = ctx.db.all<{ id: number; name: string; dept: string | null; status: string }>(
    `SELECT id, name, dept, status FROM employees WHERE company_id = ? ${opts.dept ? 'AND dept = ?' : ''} ORDER BY name`,
    companyId, ...(opts.dept ? [opts.dept] : []));
  const depts = ctx.db.all<{ dept: string }>("SELECT DISTINCT dept FROM employees WHERE company_id = ? AND dept IS NOT NULL AND dept != '' ORDER BY dept", companyId).map((r) => r.dept);
  const inScope = new Set(employees.map((e) => e.id));

  // Given to employees: posted allocation lines, by the month the batch was posted.
  const given = ctx.db.all<{ employee_id: number; amount_minor: number; posted_at: string }>(
    `SELECT l.employee_id, l.amount_minor, b.posted_at FROM allocation_lines l JOIN allocation_batches b ON b.id = l.batch_id
      WHERE b.company_id = ? AND b.status = 'posted' AND l.status = 'posted' AND b.posted_at >= ?`, companyId, since,
  ).filter((r) => inScope.has(r.employee_id));

  // Used: completed fuelings, by the month they were completed.
  const used = ctx.db.all<{ employee_id: number; station: string; grade: string; mgal: number; minor: number; completed_at: string }>(
    `SELECT r.employee_id, s.name AS station, r.grade, COALESCE(r.dispensed_mgal, 0) AS mgal, COALESCE(r.charged_minor, 0) AS minor, r.completed_at
       FROM redemptions r JOIN stations s ON s.id = r.station_id
      WHERE r.company_id = ? AND r.status = 'completed' AND r.completed_at >= ?`, companyId, since,
  ).filter((r) => inScope.has(r.employee_id));

  const monthly = new Map(months.map((m) => [m, { given_minor: 0, ...cell(), employees: new Set<number>() }]));
  const stations = new Map<string, { total: Cell; months: Map<string, Cell>; employees: Set<number> }>();
  const grades = new Map<string, { total: Cell; months: Map<string, Cell> }>();
  type Emp = { given: number; total: Cell; months: Map<string, Cell>; stations: Map<string, number>; grades: Map<string, number>; recentStations: Map<string, Set<string>> };
  const per = new Map<number, Emp>(employees.map((e) => [e.id, { given: 0, total: cell(), months: new Map(), stations: new Map(), grades: new Map(), recentStations: new Map() }]));
  // The current month is still running: comparisons and flags use the last full month, plus the month so far.
  const current = months[months.length - 1];
  const lastFull = months[months.length - 2];

  for (const g of given) {
    const mo = inRange(g.posted_at); if (!mo || !monthly.has(mo)) continue;
    monthly.get(mo)!.given_minor += g.amount_minor;
    per.get(g.employee_id)!.given += g.amount_minor;
  }
  for (const u of used) {
    const mo = inRange(u.completed_at); if (!mo || !monthly.has(mo)) continue;
    const m = monthly.get(mo)!; add(m, u.mgal, u.minor); m.employees.add(u.employee_id);
    const s = stations.get(u.station) ?? { total: cell(), months: new Map(), employees: new Set<number>() };
    add(s.total, u.mgal, u.minor); s.employees.add(u.employee_id);
    if (!s.months.has(mo)) s.months.set(mo, cell()); add(s.months.get(mo)!, u.mgal, u.minor);
    stations.set(u.station, s);
    const g = grades.get(u.grade) ?? { total: cell(), months: new Map() };
    add(g.total, u.mgal, u.minor);
    if (!g.months.has(mo)) g.months.set(mo, cell()); add(g.months.get(mo)!, u.mgal, u.minor);
    grades.set(u.grade, g);
    const e = per.get(u.employee_id)!;
    add(e.total, u.mgal, u.minor);
    if (!e.months.has(mo)) e.months.set(mo, cell()); add(e.months.get(mo)!, u.mgal, u.minor);
    e.stations.set(u.station, (e.stations.get(u.station) ?? 0) + 1);
    e.grades.set(u.grade, (e.grades.get(u.grade) ?? 0) + u.mgal);
    if (mo === current || mo === lastFull) {
      if (!e.recentStations.has(mo)) e.recentStations.set(mo, new Set());
      e.recentStations.get(mo)!.add(u.station);
    }
  }

  // Wallet balance now, per employee (available + reserved, across lots).
  const balances = new Map(ctx.db.all<{ account: string; b: number }>(
    `SELECT jl.account, SUM(jl.credit - jl.debit) AS b FROM journal_lines jl JOIN lots l ON l.id = jl.lot_id AND l.company_id = ?
      WHERE jl.account LIKE 'emp:%' GROUP BY jl.account`, companyId,
  ).map((r) => [r.account, Number(r.b)]));
  const balanceOf = (id: number) => (balances.get(`emp:${id}:available`) ?? 0) + (balances.get(`emp:${id}:reserved`) ?? 0);

  const favorites = new Map<string, number>();
  const rows = employees.map((emp) => {
    const e = per.get(emp.id)!;
    const favorite = top(e.stations);
    if (favorite) favorites.set(favorite, (favorites.get(favorite) ?? 0) + 1);
    // "Usual" = average of the full months before the last full one, counted from the employee's first fueling.
    const all = months.slice(0, -2).map((m) => e.months.get(m)?.mgal ?? 0);
    const earlier = all.slice(Math.max(0, all.findIndex((v) => v > 0)));
    if (all.every((v) => v === 0)) earlier.length = 0;
    const usual = earlier.length ? Math.round(earlier.reduce((t, v) => t + v, 0) / earlier.length) : 0;
    const lastMonth = e.months.get(lastFull)?.mgal ?? 0;
    const soFar = e.months.get(current)?.mgal ?? 0;
    const above = (v: number) => usual > 0 && v - usual >= USAGE_RULES.aboveMinMgal && v >= usual * (1 + USAGE_RULES.abovePct / 100);
    const flags: string[] = [];
    if (above(lastMonth) || above(soFar)) flags.push('above_usual');
    if ([...e.recentStations.values()].some((set) => set.size >= USAGE_RULES.manyStations)) flags.push('many_stations');
    if (e.given > 0 && e.total.fuelings === 0) flags.push('not_used');
    return {
      id: emp.id, name: emp.name, dept: emp.dept, status: emp.status,
      given_minor: e.given, used_minor: e.total.minor, used_mgal: e.total.mgal, fuelings: e.total.fuelings,
      balance_minor: balanceOf(emp.id),
      favorite_station: favorite, stations_used: e.stations.size, main_grade: top(e.grades),
      last_month_mgal: lastMonth, month_so_far_mgal: soFar, usual_mgal: usual, flags,
    };
  });

  const byMonth = (m: Map<string, Cell>) => months.map((mo) => ({ month: mo, ...(m.get(mo) ?? cell()) }));
  const monthList = [...monthly].map(([month, m]) => ({ month, given_minor: m.given_minor, used_minor: m.minor, used_mgal: m.mgal, fuelings: m.fuelings, employees: m.employees.size }));
  const sum = (k: 'given_minor' | 'used_minor' | 'used_mgal' | 'fuelings') => monthList.reduce((t, m) => t + m[k], 0);
  return {
    company: { id: company.id, name: company.name, frozen: company.status === 'frozen' },
    months, depts, rules: USAGE_RULES,
    kpis: {
      given_minor: sum('given_minor'), used_minor: sum('used_minor'), used_mgal: sum('used_mgal'), fuelings: sum('fuelings'),
      active_employees: rows.filter((r) => r.fuelings > 0).length, employees: rows.length,
      balance_minor: rows.reduce((t, r) => t + r.balance_minor, 0),
      flagged: rows.filter((r) => r.flags.length).length,
    },
    monthly: monthList,
    stations: [...stations].map(([name, s]) => ({
      name, mgal: s.total.mgal, minor: s.total.minor, fuelings: s.total.fuelings, employees: s.employees.size,
      favorite_of: favorites.get(name) ?? 0, months: byMonth(s.months),
    })).sort((a, b) => b.mgal - a.mgal),
    grades: [...grades].map(([grade, g]) => ({ grade, mgal: g.total.mgal, minor: g.total.minor, fuelings: g.total.fuelings, months: byMonth(g.months) }))
      .sort((a, b) => b.mgal - a.mgal),
    employees: rows,
  };
}
