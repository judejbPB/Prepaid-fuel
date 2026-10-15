import { beforeEach, describe, expect, it } from 'vitest';
import { actorFor, type Actor } from '../src/auth.js';
import { createCtx, type Ctx } from '../src/context.js';
import { seedDemo } from '../src/demo.js';
import { listFuelAlerts, reviewFuelAlert, RULES, scanFuelAlerts } from '../src/services/fuel-alerts.js';

let ctx: Ctx;
const as = (login: string): Actor => actorFor(ctx.db, ctx.db.get('SELECT id FROM users WHERE login = ?', login).id, null, null);
/** UTC timestamp `minutesAgo` before now, in the database format. */
const ago = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString().replace('T', ' ').slice(0, 19);
let n = 0;

/** Records a completed sale like the station flow does (only the fields the rules read matter). */
function sale(opts: { employee: number; station?: number; gallons: number; grade?: 'diesel' | 'gasoline'; at: string; offline?: boolean; terminal?: number }) {
  const shift = ctx.db.get('SELECT * FROM shifts ORDER BY id LIMIT 1');
  const emp = ctx.db.get('SELECT * FROM employees WHERE id = ?', opts.employee);
  ctx.db.run(
    `INSERT INTO redemptions (code, station_id, terminal_id, shift_id, attendant_id, pump, grade, challenge_nonce, expires_at, status,
       employee_id, company_id, dispensed_mgal, charged_minor, offline, completed_at, created_at)
     VALUES (?,?,?,?,?,1,?,'x',?, 'completed', ?,?,?,?,?,?,?)`,
    `T-${++n}`, opts.station ?? shift.station_id, opts.terminal ?? shift.terminal_id, shift.id, shift.attendant_id, opts.grade ?? 'gasoline', opts.at,
    emp.id, emp.company_id, Math.round(opts.gallons * 1000), Math.round(opts.gallons * 66500), opts.offline ? 1 : 0, opts.at, opts.at,
  );
}
const rules = () => listFuelAlerts(ctx, as('admin@bousol'), { status: 'all' }).map((a: any) => a.rule).sort();

beforeEach(() => {
  ctx = createCtx(':memory:');
  seedDemo(ctx);
  ctx.db.run('DELETE FROM redemptions'); // tests add their own sales
  ctx.db.run('DELETE FROM fuel_alerts');
});

describe('suspicious fueling alerts', () => {
  it('flags a fill above the limit, more so far above it', () => {
    const emp = ctx.db.get('SELECT id FROM employees ORDER BY id LIMIT 1').id;
    sale({ employee: emp, gallons: 30, at: ago(600) });
    sale({ employee: emp, gallons: 40, grade: 'diesel', at: ago(300) }); // under the diesel limit
    const alerts = listFuelAlerts(ctx, as('admin@bousol')).filter((a: any) => a.rule === 'large_fill');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: 'medium', facts: { mgal: 30_000, limitMgal: RULES.largeFillMgal.gasoline } });
  });

  it('flags the same employee twice within the hour, high at two different stations', () => {
    const [e1, e2] = ctx.db.all('SELECT id FROM employees ORDER BY id LIMIT 2').map((e: any) => e.id);
    const stations = ctx.db.all('SELECT id, name FROM stations ORDER BY id LIMIT 2');
    sale({ employee: e1, gallons: 5, at: ago(200), station: stations[0].id });
    sale({ employee: e1, gallons: 5, at: ago(185), station: stations[0].id });
    sale({ employee: e2, gallons: 5, at: ago(120), station: stations[0].id });
    sale({ employee: e2, gallons: 5, at: ago(100), station: stations[1].id });
    sale({ employee: e2, gallons: 5, at: ago(10), station: stations[1].id }); // 90 minutes later: fine
    const repeats = listFuelAlerts(ctx, as('admin@bousol')).filter((a: any) => a.rule === 'rapid_repeat');
    expect(repeats.map((a: any) => [a.severity, a.facts.minutes])).toEqual([['high', 20], ['medium', 15]]);
    expect(repeats[0].facts.stationNames).toEqual([stations[0].name, stations[1].name]);
  });

  it('flags a large daily total, night fuelings, held shifts and mostly-offline terminals', () => {
    const emp = ctx.db.get('SELECT id FROM employees ORDER BY id LIMIT 1').id;
    // Three fills of 22 gal, 3 hours apart, on one Haiti day (each under the per-fill limit).
    const noonHaiti = new Date(); noonHaiti.setUTCHours(16, 0, 0, 0); // 12:00 in Haiti (UTC-4)
    if (noonHaiti.getTime() > Date.now()) noonHaiti.setUTCDate(noonHaiti.getUTCDate() - 1);
    for (const h of [0, 3, 6]) sale({ employee: emp, gallons: 22, at: new Date(noonHaiti.getTime() - h * 3_600_000).toISOString().replace('T', ' ').slice(0, 19) });
    // 02:00 Haiti time
    const night = new Date(noonHaiti.getTime() - 10 * 3_600_000).toISOString().replace('T', ' ').slice(0, 19);
    const emp2 = ctx.db.all('SELECT id FROM employees ORDER BY id LIMIT 2')[1].id;
    sale({ employee: emp2, gallons: 4, at: night });
    // Three held shifts for one attendant
    const shift = ctx.db.get('SELECT * FROM shifts ORDER BY id LIMIT 1');
    for (let i = 0; i < 3; i++) {
      ctx.db.run("INSERT INTO shifts (station_id, terminal_id, attendant_id, status, opened_at, variance_minor) VALUES (?,?,?,'held',?,?)",
        shift.station_id, shift.terminal_id, shift.attendant_id, ago(2000 + i), 15000);
    }
    expect(rules()).toEqual(['attendant_variances', 'daily_volume', 'night']);
    // Mostly offline terminal this week
    for (let i = 0; i < 10; i++) sale({ employee: emp2, gallons: 1, at: ago(5000 + i * 200), offline: i < 9 }); // 9 of the terminal's 14 sales
    expect(rules()).toContain('offline_share');
  });

  it('raises each pattern once, and a person must review it with a note', () => {
    const emp = ctx.db.get('SELECT id FROM employees ORDER BY id LIMIT 1').id;
    sale({ employee: emp, gallons: 45, at: ago(60) });
    expect(scanFuelAlerts(ctx)).toBeGreaterThan(0);
    expect(scanFuelAlerts(ctx)).toBe(0);
    const [alert] = listFuelAlerts(ctx, as('treasury@bousol'));
    expect(alert).toMatchObject({ rule: 'large_fill', severity: 'high', status: 'open' });
    expect(() => reviewFuelAlert(ctx, as('treasury@bousol'), alert.id, 'cleared', 'ok')).toThrow();
    reviewFuelAlert(ctx, as('approver@bousol'), alert.id, 'cleared', 'Camion de livraison, réservoir de 50 gal');
    expect(() => reviewFuelAlert(ctx, as('admin@bousol'), alert.id, 'confirmed', 'x y')).toThrow(/already been reviewed/);
    expect(listFuelAlerts(ctx, as('admin@bousol'))).toEqual([]);
    expect(ctx.db.get("SELECT action FROM audit_log WHERE entity = 'fuel_alert'").action).toBe('alert.cleared');
  });
});
