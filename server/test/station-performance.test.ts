import { beforeEach, describe, expect, it } from 'vitest';
import { actorFor, type Actor } from '../src/auth.js';
import { createCtx, type Ctx } from '../src/context.js';
import { seedDemo } from '../src/demo.js';
import { importActuals, parseMonth, recordActuals, stationPerformance } from '../src/services/station-performance.js';

let ctx: Ctx;
let manager: Actor;
let stationId: number;
const as = (login: string): Actor => actorFor(ctx.db, ctx.db.get('SELECT id FROM users WHERE login = ?', login).id, null, null);
const month = (ago: number) => {
  const [y, m] = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Port-au-Prince' }).format(new Date()).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 - ago, 1)).toISOString().slice(0, 7);
};

beforeEach(() => {
  ctx = createCtx(':memory:');
  seedDemo(ctx);
  manager = as('manager1@bousol');
  stationId = manager.stationId!;
});

describe('station performance', () => {
  it('compares the last full month with the month before and the same month last year', () => {
    recordActuals(ctx, manager, stationId, month(13), [{ grade: 'diesel', gallons: 800 }, { grade: 'gasoline', gallons: 200 }]);
    recordActuals(ctx, manager, stationId, month(2), [{ grade: 'diesel', gallons: 1000 }, { grade: 'gasoline', gallons: 500 }]);
    const out = recordActuals(ctx, manager, stationId, month(1), [{ grade: 'diesel', gallons: 1100, amount: 900_000 }, { grade: 'gasoline', gallons: 400 }]);
    expect(out.summary).toMatchObject({
      month: month(1), actual_mgal: 1_500_000, prev_month_mgal: 1_500_000, mom_pct: 0, last_year_mgal: 1_000_000, yoy_pct: 50,
    });
    const row = out.rows.find((r) => r.month === month(1))!;
    expect(row).toMatchObject({ actual_mgal: 1_500_000, mom_pct: 0, yoy_pct: 50 });
    expect(out.rows.at(-1)!.in_progress).toBe(true);
    expect(out.rows).toHaveLength(12);

    // Diesel only: 1100 vs 1000 (+10 %), and 1100 vs 800 a year earlier (+38 %).
    const diesel = stationPerformance(ctx, manager, { grade: 'diesel' });
    expect(diesel.summary).toMatchObject({ actual_mgal: 1_100_000, mom_pct: 10, yoy_pct: 38 });

    // Correcting a month replaces it.
    recordActuals(ctx, manager, stationId, month(1), [{ grade: 'gasoline', gallons: 900 }]);
    expect(stationPerformance(ctx, manager).summary.actual_mgal).toBe(2_000_000);
  });

  it('counts the share sold through ALFA wallets', () => {
    const cur = month(0);
    const alfa = ctx.db.get("SELECT COALESCE(SUM(dispensed_mgal), 0) AS g FROM redemptions WHERE status = 'completed' AND station_id = ?", stationId).g;
    expect(alfa).toBeGreaterThan(0);
    const out = recordActuals(ctx, manager, stationId, cur, [{ grade: 'diesel', gallons: alfa / 250 }, { grade: 'gasoline', gallons: 0 }]);
    const row = out.rows.find((r) => r.month === cur)!;
    expect(row.alfa_mgal).toBe(alfa);
    expect(row.alfa_share_pct).toBe(25);
  });

  it('imports history from a sheet, in long or wide layout, and skips lines it cannot read', () => {
    const long = `Mois;Carburant;Gallons;Montant HTG\n${month(14)};Diesel;1 200,5;950 000\n${month(13)};Gazoline;300;\nmauvais;Diesel;5;\n`;
    const r1 = importActuals(ctx, manager, long);
    expect(r1).toMatchObject({ imported: 2, from: month(14), to: month(13) });
    expect(r1.skipped).toEqual([{ line: 4, reason: 'bad_month' }]);

    const station = ctx.db.get('SELECT name FROM stations WHERE id = ?', stationId).name;
    const wide = [['Rapport annuel'], ['Station', 'Mois', 'Diesel', 'Gazoline'], [station, month(12), '900', '250'], ['Inconnue', month(12), '1', '1']];
    const r2 = importActuals(ctx, as('admin@bousol'), wide);
    expect(r2.imported).toBe(2);
    expect(r2.skipped).toEqual([{ line: 4, reason: 'unknown_station' }]);
    const rows = ctx.db.all('SELECT month, grade, gallons_mgal, amount_minor FROM station_actuals WHERE station_id = ? ORDER BY month, grade', stationId);
    expect(rows).toContainEqual({ month: month(14), grade: 'diesel', gallons_mgal: 1_200_500, amount_minor: 95_000_000 });
    expect(rows).toContainEqual({ month: month(12), grade: 'gasoline', gallons_mgal: 250_000, amount_minor: null });
    expect(() => importActuals(ctx, as('admin@bousol'), 'Mois;Gallons\n2025-01;5\n')).toThrow(/station column/);
  });

  it('reads the month formats stations use', () => {
    expect(parseMonth('2025-09')).toBe('2025-09');
    expect(parseMonth('2025-09-30')).toBe('2025-09');
    expect(parseMonth('9/2025')).toBe('2025-09');
    expect(parseMonth('30/09/2025')).toBe('2025-09');
    expect(parseMonth('septembre 2025')).toBe('2025-09');
    expect(parseMonth('Juin 2025')).toBe('2025-06');
    expect(parseMonth('juil. 2025')).toBe('2025-07');
    expect(parseMonth('Aug-2025')).toBe('2025-08');
    expect(parseMonth('Février 2025')).toBe('2025-02');
    expect(parseMonth('n/a')).toBeNull();
  });

  it('compares all stations like for like, leaving out a station that has not entered the month', () => {
    const admin = as('admin@bousol');
    const [a, b] = ctx.db.all('SELECT id FROM stations ORDER BY id LIMIT 2').map((x: any) => x.id);
    recordActuals(ctx, admin, a, month(2), [{ grade: 'diesel', gallons: 1000 }]);
    recordActuals(ctx, admin, b, month(2), [{ grade: 'diesel', gallons: 1000 }]);
    recordActuals(ctx, admin, a, month(1), [{ grade: 'diesel', gallons: 1200 }]); // b has not entered last month yet
    recordActuals(ctx, admin, a, month(13), [{ grade: 'diesel', gallons: 1000 }]);
    const all = stationPerformance(ctx, admin);
    expect(all.summary).toMatchObject({ actual_mgal: 1_200_000, prev_month_mgal: 2_000_000, mom_pct: 20, yoy_pct: 20 });
    expect(all.by_station.find((x) => x.id === b)).toMatchObject({ missing_last_month: true, mom_pct: null });
  });

  it('lets the distributor see all stations and keeps managers to their own station', () => {
    recordActuals(ctx, manager, stationId, month(1), [{ grade: 'diesel', gallons: 100 }]);
    const all = stationPerformance(ctx, as('approver@bousol'));
    expect(all.station).toBeNull();
    expect(all.by_station.length).toBe(all.total_stations);
    expect(all.by_station.find((s) => s.id === stationId)!.actual_mgal).toBe(100_000);
    expect(all.missing_months).toContain(month(1)); // the other stations have not entered it
    const other = ctx.db.get('SELECT id FROM stations WHERE id != ? LIMIT 1', stationId).id;
    expect(() => stationPerformance(ctx, manager, { stationId: other })).toThrow();
    expect(() => recordActuals(ctx, manager, other, month(1), [{ grade: 'diesel', gallons: 1 }])).toThrow();
    expect(() => recordActuals(ctx, as('approver@bousol'), stationId, month(1), [{ grade: 'diesel', gallons: 1 }])).toThrow();
    expect(() => recordActuals(ctx, manager, stationId, month(-1), [{ grade: 'diesel', gallons: 1 }])).toThrow(/future/);
    expect(() => stationPerformance(ctx, as('prep@companya'))).toThrow();
  });
});
