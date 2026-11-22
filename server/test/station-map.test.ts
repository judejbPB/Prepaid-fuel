import { beforeEach, describe, expect, it } from 'vitest';
import { actorFor, type Actor } from '../src/auth.js';
import { createCtx, type Ctx } from '../src/context.js';
import { DEMO_STATION_PLACES, placeDemoStations, seedDemo } from '../src/demo.js';
import { setStationLocation, stationMap } from '../src/services/station-map.js';

let ctx: Ctx;
const as = (login: string): Actor => actorFor(ctx.db, ctx.db.get('SELECT id FROM users WHERE login = ?', login).id, null, null);
const employee = (): Actor => {
  const u = ctx.db.get('SELECT user_id FROM employees WHERE user_id IS NOT NULL AND id IN (SELECT employee_id FROM redemptions WHERE status = \'completed\') LIMIT 1');
  return actorFor(ctx.db, u.user_id, null, null);
};

beforeEach(() => {
  ctx = createCtx(':memory:');
  seedDemo(ctx);
});

describe('station map', () => {
  it('shows each kind of user what they need', () => {
    const fuelings = ctx.db.get("SELECT station_id, COUNT(*) AS n, SUM(dispensed_mgal) AS g, company_id FROM redemptions WHERE status = 'completed' GROUP BY station_id LIMIT 1");

    const dist = stationMap(ctx, as('admin@bousol'));
    expect(dist.view).toBe('distributor');
    expect(dist.stations).toHaveLength(4);
    expect(dist.missing_location).toBe(0);
    const busy = dist.stations.find((s: any) => s.id === fuelings.station_id) as any;
    expect(busy).toMatchObject({ fuelings_month: fuelings.n, mgal_month: fuelings.g, terminal: expect.any(String) });

    const company = stationMap(ctx, as('prep@companya'));
    expect(company.view).toBe('company');
    const mine = company.stations.find((s: any) => s.id === fuelings.station_id) as any;
    expect(mine.fuelings_30d).toBeGreaterThan(0);
    expect(mine).not.toHaveProperty('open_alerts');

    const mgr = stationMap(ctx, as('manager1@bousol')) as any;
    expect(mgr.view).toBe('station');
    const own = mgr.stations.find((s: any) => s.own);
    expect(own.id).toBe(mgr.own_station_id);
    expect(own).toHaveProperty('mgal_month');
    expect(mgr.stations.filter((s: any) => !s.own).every((s: any) => !('mgal_month' in s))).toBe(true); // no other stations' figures

    const emp = stationMap(ctx, employee()) as any;
    expect(emp.view).toBe('employee');
    expect(emp.stations.every((s: any) => s.lat != null && !('mgal_month' in s))).toBe(true);
    expect(emp.stations.some((s: any) => s.my_fuelings > 0)).toBe(true);
  });

  it('hides from employees the stations they cannot use, and flags missing locations for the distributor', () => {
    const [a, b] = ctx.db.all('SELECT id FROM stations ORDER BY id LIMIT 2').map((s: any) => s.id);
    ctx.db.run("UPDATE stations SET status = 'frozen' WHERE id = ?", a);
    ctx.db.run('UPDATE stations SET lat = NULL, lng = NULL WHERE id = ?', b);
    const emp = stationMap(ctx, employee()) as any;
    expect(emp.stations.map((s: any) => s.id)).not.toContain(a);
    expect(emp.stations.map((s: any) => s.id)).not.toContain(b);
    expect((stationMap(ctx, as('admin@bousol')) as any).missing_location).toBe(1);
  });

  it('lets a manager set their own station’s location, inside Haiti only', () => {
    const mgr = as('manager1@bousol');
    const out = setStationLocation(ctx, mgr, mgr.stationId!, { lat: 18.53901, lng: -72.33512, hours: '24h/24' }) as any;
    expect(out.stations.find((s: any) => s.own)).toMatchObject({ lat: 18.53901, lng: -72.33512, hours: '24h/24' });
    expect(() => setStationLocation(ctx, mgr, mgr.stationId!, { lat: 40.7, lng: -74.0 })).toThrow(/outside Haiti/);
    const other = ctx.db.get('SELECT id FROM stations WHERE id != ? LIMIT 1', mgr.stationId).id;
    expect(() => setStationLocation(ctx, mgr, other, { lat: 18.5, lng: -72.3 })).toThrow();
    expect(() => setStationLocation(ctx, as('prep@companya'), other, { lat: 18.5, lng: -72.3 })).toThrow();
    setStationLocation(ctx, as('admin@bousol'), other, { lat: 18.6, lng: -72.3 });
    expect(ctx.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'station.location'").n).toBe(2);
  });

  it('places the demo stations in a demo database saved before stations had a location', () => {
    ctx.db.run('UPDATE stations SET lat = NULL, lng = NULL, hours = NULL');
    placeDemoStations(ctx);
    const s1 = ctx.db.get("SELECT lat, lng, hours FROM stations WHERE name = 'Station 1'");
    expect(s1).toEqual({ lat: DEMO_STATION_PLACES[0].lat, lng: DEMO_STATION_PLACES[0].lng, hours: DEMO_STATION_PLACES[0].hours });
  });
});
