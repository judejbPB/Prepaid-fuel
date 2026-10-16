import { beforeEach, describe, expect, it } from 'vitest';
import { actorFor, type Actor } from '../src/auth.js';
import { createCtx, type Ctx } from '../src/context.js';
import { seedDemo } from '../src/demo.js';
import { dashboard } from '../src/services/dashboard.js';

let ctx: Ctx;
const as = (login: string): Actor => actorFor(ctx.db, ctx.db.get('SELECT id FROM users WHERE login = ?', login).id, null, null);
const haitiToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Port-au-Prince' }).format(new Date());
const shift = (day: string, n: number) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

beforeEach(() => {
  ctx = createCtx(':memory:');
  seedDemo(ctx);
});

describe('reporting dashboard', () => {
  it('sums the period, compares with the previous one and fills every day', () => {
    const to = haitiToday(); const from = shift(to, -6);
    const out = dashboard(ctx, as('admin@bousol'), { from, to });
    const sold = ctx.db.get("SELECT SUM(charged_minor) AS m, SUM(dispensed_mgal) AS g, COUNT(*) AS n FROM redemptions WHERE status = 'completed'");
    expect(out.kpis).toMatchObject({ sales_minor: sold.m, gallons_mgal: sold.g, fuelings: sold.n, sales_minor_prev: 0 });
    expect(out.period).toMatchObject({ days: 7, previous: { from: shift(from, -7), to: shift(from, -1) }, grain: 'day' });
    expect(out.series).toHaveLength(7);
    expect(out.series.at(-1)!.minor).toBe(sold.m);
    expect(out.series.reduce((t, p) => t + p.minor, 0)).toBe(out.kpis.sales_minor);
    expect(out.by_station.reduce((t, s) => t + s.minor, 0)).toBe(out.kpis.sales_minor);
    expect(out.by_grade.map((g) => g.name).sort()).toEqual([...new Set(ctx.db.all("SELECT grade FROM redemptions WHERE status = 'completed'").map((r: any) => r.grade))].sort());
    expect(out.kpis.deposits_minor).toBeGreaterThan(0);
    expect(out.prepaid.length).toBe(ctx.db.get('SELECT COUNT(*) AS n FROM companies').n);
  });

  it('filters by company and station, uses months for long periods, and is distributor-only', () => {
    const to = haitiToday();
    const b = ctx.db.get("SELECT id FROM companies WHERE name = 'Entreprise B'").id;
    const onlyB = dashboard(ctx, as('treasury@bousol'), { from: shift(to, -29), to, companyId: b });
    expect(onlyB.kpis.sales_minor).toBe(0);
    expect(onlyB.prepaid.map((p) => p.name)).toEqual(['Entreprise B']);
    const station = ctx.db.get("SELECT station_id FROM redemptions WHERE status = 'completed' LIMIT 1").station_id;
    const other = ctx.db.get('SELECT id FROM stations WHERE id != ? LIMIT 1', station).id;
    expect(dashboard(ctx, as('admin@bousol'), { from: to, to, stationId: other }).kpis.fuelings).toBe(0);
    expect(dashboard(ctx, as('admin@bousol'), { from: shift(to, -364), to }).period.grain).toBe('month');
    expect(() => dashboard(ctx, as('admin@bousol'), { from: to, to: shift(to, -1) })).toThrow(/start date/);
    expect(() => dashboard(ctx, as('prep@companya'), { from: to, to })).toThrow();
  });
});
