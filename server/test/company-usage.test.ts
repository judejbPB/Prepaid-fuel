import { beforeEach, describe, expect, it } from 'vitest';
import { actorFor, type Actor } from '../src/auth.js';
import { createCtx, type Ctx } from '../src/context.js';
import { seedDemo } from '../src/demo.js';
import { companyUsage } from '../src/services/company-usage.js';

let ctx: Ctx;
let companyA: number;
const as = (login: string): Actor => actorFor(ctx.db, ctx.db.get('SELECT id FROM users WHERE login = ?', login).id, null, null);
const haitiMonth = (monthsAgo: number) => {
  const [y, m] = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Port-au-Prince' }).format(new Date()).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 - monthsAgo, 1)).toISOString().slice(0, 7);
};

/** A completed fueling copied from a demo one, moved to the 15th of a month (noon UTC is the same Haiti day). */
function fueling(employeeId: number, month: string, gallons: number, stationId?: number) {
  const r = ctx.db.get("SELECT * FROM redemptions WHERE status = 'completed' LIMIT 1");
  const code = `T${Math.random().toString(36).slice(2, 10)}`;
  ctx.db.run(
    `INSERT INTO redemptions (code, station_id, terminal_id, shift_id, attendant_id, pump, grade, requested_mgal, price_minor, currency,
       approved_minor, approved_mgal, dispensed_mgal, charged_minor, status, employee_id, company_id, challenge_nonce, expires_at, created_at, completed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'completed', ?,?,?,?,?,?)`,
    code, stationId ?? r.station_id, r.terminal_id, r.shift_id, r.attendant_id, r.pump, r.grade, gallons * 1000, r.price_minor, r.currency,
    gallons * r.price_minor, gallons * 1000, gallons * 1000, gallons * r.price_minor, employeeId, r.company_id, 'x', `${month}-15 12:10:00`,
    `${month}-15 12:00:00`, `${month}-15 12:05:00`,
  );
}

beforeEach(() => {
  ctx = createCtx(':memory:');
  seedDemo(ctx);
  companyA = ctx.db.get("SELECT company_id FROM redemptions WHERE status = 'completed' LIMIT 1").company_id;
});

describe('company fuel usage dashboard', () => {
  it('adds up given and used per month, station and fuel, and matches the ledger', () => {
    const out = companyUsage(ctx, as('prep@companya'), companyA, { months: 6 });
    expect(out.months).toHaveLength(6);
    expect(out.months.at(-1)).toBe(haitiMonth(0));
    const sold = ctx.db.get("SELECT SUM(charged_minor) AS m, SUM(dispensed_mgal) AS g, COUNT(*) AS n FROM redemptions WHERE status = 'completed' AND company_id = ?", companyA);
    expect(out.kpis).toMatchObject({ used_minor: sold.m, used_mgal: sold.g, fuelings: sold.n });
    const posted = ctx.db.get(
      "SELECT SUM(l.amount_minor) AS m FROM allocation_lines l JOIN allocation_batches b ON b.id = l.batch_id WHERE b.company_id = ? AND l.status = 'posted'", companyA);
    expect(out.kpis.given_minor).toBe(posted.m);
    expect(out.monthly.reduce((t, m) => t + m.used_minor, 0)).toBe(out.kpis.used_minor);
    expect(out.stations.reduce((t, s) => t + s.mgal, 0)).toBe(out.kpis.used_mgal);
    expect(out.grades.reduce((t, g) => t + g.mgal, 0)).toBe(out.kpis.used_mgal);
    expect(out.employees.reduce((t, e) => t + e.used_minor, 0)).toBe(out.kpis.used_minor);
    expect(out.stations.reduce((t, s) => t + s.favorite_of, 0)).toBe(out.kpis.active_employees);
    const wallets = ctx.db.get(
      "SELECT SUM(jl.credit - jl.debit) AS b FROM journal_lines jl JOIN lots l ON l.id = jl.lot_id WHERE l.company_id = ? AND jl.account LIKE 'emp:%'", companyA);
    expect(out.kpis.balance_minor).toBe(Number(wallets.b));
  });

  it('shows volumes month by month and flags usage well above the usual', () => {
    const emp = ctx.db.get("SELECT employee_id AS id FROM redemptions WHERE status = 'completed' AND company_id = ? LIMIT 1", companyA).id;
    ctx.db.run("DELETE FROM redemptions WHERE employee_id = ? AND status = 'completed'", emp);
    for (const ago of [3, 2, 1]) fueling(emp, haitiMonth(ago), 10);
    fueling(emp, haitiMonth(0), 30);
    const out = companyUsage(ctx, as('approve@companya'), companyA, { months: 6 });
    const row = out.employees.find((e) => e.id === emp)!;
    expect(row.month_so_far_mgal).toBe(30_000);
    expect(row.last_month_mgal).toBe(10_000);
    expect(row.usual_mgal).toBe(10_000); // full months before last month, since the first fueling
    expect(row.flags).toContain('above_usual');
    const station = out.stations.find((s) => s.name === row.favorite_station)!;
    expect(station.months.map((m) => m.month)).toEqual(out.months);
    expect(station.months.find((m) => m.month === haitiMonth(2))!.mgal).toBeGreaterThanOrEqual(10_000);

    // Three different stations in the latest month.
    const stations = ctx.db.all('SELECT id FROM stations LIMIT 3').map((s: any) => s.id);
    for (const s of stations) fueling(emp, haitiMonth(0), 1, s);
    expect(companyUsage(ctx, as('prep@companya'), companyA).employees.find((e) => e.id === emp)!.flags).toContain('many_stations');
  });

  it('filters by department, lets the distributor in, and keeps other companies out', () => {
    const dept = ctx.db.get("SELECT dept FROM employees WHERE company_id = ? AND dept IS NOT NULL LIMIT 1", companyA)?.dept;
    if (dept) {
      const out = companyUsage(ctx, as('prep@companya'), companyA, { dept });
      expect(out.employees.every((e) => e.dept === dept)).toBe(true);
      expect(out.depts).toContain(dept);
    }
    expect(companyUsage(ctx, as('admin@bousol'), companyA).company.id).toBe(companyA);
    const other = ctx.db.get('SELECT id FROM companies WHERE id != ? LIMIT 1', companyA).id;
    expect(() => companyUsage(ctx, as('prep@companya'), other)).toThrow();
    expect(() => companyUsage(ctx, as('attendant1@bousol'), companyA)).toThrow();
    expect(() => companyUsage(ctx, as('prep@companya'), companyA, { months: 5 })).toThrow(/3, 6 or 12/);
  });
});
