// Station map: where the stations are, with what each kind of user needs to see on it.
//   employee          where can I fuel: open stations with an active terminal, opening hours, the ones I use
//   company staff     where our employees fuel: our gallons and employees per station (last 30 days)
//   station manager   my station's exact location (which they can set from the pump) among the network
//   distributor       the network's health: this month's volume, open alerts and exceptions, terminal status,
//                     and stations still missing a location
import { COMPANY, DISTRIBUTOR, requireRole, type Actor } from '../auth.js';
import type { Ctx } from '../context.js';
import { badRequest, forbidden, notFound } from '../errors.js';

// Haiti, with a margin: catches swapped or mistyped coordinates.
const BOUNDS = { latMin: 17.8, latMax: 20.2, lngMin: -74.6, lngMax: -71.5 };

type Station = { id: number; name: string; address: string | null; lat: number | null; lng: number | null; hours: string | null; status: string };

const since = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);

export function stationMap(ctx: Ctx, actor: Actor) {
  const stations = ctx.db.all<Station>('SELECT id, name, address, lat, lng, hours, status FROM stations ORDER BY name');
  const terminal = new Map(ctx.db.all<{ station_id: number; status: string; activated: number }>(
    "SELECT station_id, status, device_key_hash IS NOT NULL AS activated FROM terminals WHERE status != 'retired'",
  ).map((t) => [t.station_id, t]));
  const located = (s: Station) => s.lat != null && s.lng != null;
  const base = (s: Station) => ({ id: s.id, name: s.name, address: s.address, lat: s.lat, lng: s.lng, hours: s.hours });

  if (actor.role === 'employee') {
    // Only where the wallet can actually be used: an open station with a working terminal.
    const mine = new Map(ctx.db.all<{ station_id: number; n: number; last: string }>(
      `SELECT station_id, COUNT(*) AS n, MAX(completed_at) AS last FROM redemptions
        WHERE employee_id = ? AND status = 'completed' AND completed_at >= ? GROUP BY station_id`, actor.employeeId, since(90),
    ).map((r) => [r.station_id, r]));
    return {
      view: 'employee' as const,
      stations: stations.filter((s) => s.status === 'active' && located(s) && terminal.get(s.id)?.status === 'active')
        .map((s) => ({ ...base(s), my_fuelings: mine.get(s.id)?.n ?? 0, my_last: mine.get(s.id)?.last ?? null })),
    };
  }

  if (COMPANY.includes(actor.role)) {
    const usage = new Map(ctx.db.all<{ station_id: number; mgal: number; fuelings: number; employees: number }>(
      `SELECT station_id, COALESCE(SUM(dispensed_mgal), 0) AS mgal, COUNT(*) AS fuelings, COUNT(DISTINCT employee_id) AS employees
         FROM redemptions WHERE company_id = ? AND status = 'completed' AND completed_at >= ? GROUP BY station_id`, actor.companyId, since(30),
    ).map((r) => [r.station_id, r]));
    return {
      view: 'company' as const,
      stations: stations.filter((s) => located(s) && (s.status === 'active' || usage.has(s.id))).map((s) => ({
        ...base(s), open: s.status === 'active',
        mgal_30d: Number(usage.get(s.id)?.mgal ?? 0), fuelings_30d: Number(usage.get(s.id)?.fuelings ?? 0), employees_30d: Number(usage.get(s.id)?.employees ?? 0),
      })),
    };
  }

  requireRole(actor, ['st_manager', ...DISTRIBUTOR]);
  const monthStart = `${new Date().toISOString().slice(0, 7)}-01 00:00:00`;
  const volume = new Map(ctx.db.all<{ station_id: number; mgal: number; fuelings: number; last: string }>(
    `SELECT station_id, COALESCE(SUM(dispensed_mgal), 0) AS mgal, COUNT(*) AS fuelings, MAX(completed_at) AS last
       FROM redemptions WHERE status = 'completed' AND completed_at >= ? GROUP BY station_id`, monthStart,
  ).map((r) => [r.station_id, r]));
  const count = (sql: string) => new Map(ctx.db.all<{ station_id: number; n: number }>(sql).map((r) => [r.station_id, Number(r.n)]));
  const alerts = count("SELECT station_id, COUNT(*) AS n FROM fuel_alerts WHERE status = 'open' AND station_id IS NOT NULL GROUP BY station_id");
  const exceptions = count("SELECT station_id, COUNT(*) AS n FROM exceptions WHERE status IN ('open','proposed') AND station_id IS NOT NULL GROUP BY station_id");
  const detail = (s: Station) => ({
    ...base(s), status: s.status,
    terminal: terminal.get(s.id) ? (terminal.get(s.id)!.status !== 'active' ? 'frozen' : terminal.get(s.id)!.activated ? 'active' : 'not_activated') : 'none',
    mgal_month: Number(volume.get(s.id)?.mgal ?? 0), fuelings_month: Number(volume.get(s.id)?.fuelings ?? 0), last_fueling: volume.get(s.id)?.last ?? null,
    open_alerts: alerts.get(s.id) ?? 0, open_exceptions: exceptions.get(s.id) ?? 0,
  });

  if (actor.role === 'st_manager') {
    // Their own station in full; the rest of the network as plain points, without other stations' figures.
    return {
      view: 'station' as const, own_station_id: actor.stationId,
      stations: stations.filter((s) => s.id === actor.stationId || located(s))
        .map((s) => (s.id === actor.stationId ? { ...detail(s), own: true } : { ...base(s), own: false })),
    };
  }
  return { view: 'distributor' as const, stations: stations.map(detail), missing_location: stations.filter((s) => !located(s)).length };
}

/** Sets a station's location (and optionally address and opening hours): the distributor for any station, a manager for theirs. */
export function setStationLocation(ctx: Ctx, actor: Actor, stationId: number, input: { lat: number; lng: number; address?: string | null; hours?: string | null }) {
  requireRole(actor, ['st_manager', 'dist_admin']);
  if (actor.role === 'st_manager' && actor.stationId !== stationId) throw forbidden();
  const station = ctx.db.get<Station>('SELECT * FROM stations WHERE id = ?', stationId);
  if (!station) throw notFound('Station');
  const { lat, lng } = input;
  if (!(lat >= BOUNDS.latMin && lat <= BOUNDS.latMax && lng >= BOUNDS.lngMin && lng <= BOUNDS.lngMax)) {
    throw badRequest('bad_location', 'That point is outside Haiti. Check the latitude and longitude.');
  }
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
  ctx.db.run('UPDATE stations SET lat = ?, lng = ?, address = COALESCE(?, address), hours = COALESCE(?, hours) WHERE id = ?',
    r6(lat), r6(lng), input.address?.trim() || null, input.hours?.trim() || null, stationId);
  ctx.db.audit(actor.userId, 'station.location', 'station', stationId, { lat: r6(lat), lng: r6(lng), from: station.lat == null ? null : [station.lat, station.lng] });
  return stationMap(ctx, actor);
}
