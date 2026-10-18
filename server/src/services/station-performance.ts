// Station performance: each station's own monthly sales (all customers, not only ALFA), entered by the station
// manager or the distributor or imported from Excel/CSV, including history from before ALFA. The report compares
// each month with the month before and with the same month a year earlier, and shows how much of it went through
// ALFA wallets. Months are Haiti months.
import { DISTRIBUTOR, requireRole, type Actor } from '../auth.js';
import type { Ctx } from '../context.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { GRADES, type Grade } from '../units.js';
import { parseAmount, parseCsv } from './bank.js';

const TZ = 'America/Port-au-Prince';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const haitiMonth = (utc: string) => dayFmt.format(new Date(utc.replace(' ', 'T') + 'Z')).slice(0, 7);
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const currentMonth = () => dayFmt.format(new Date()).slice(0, 7);
const shiftMonth = (mo: string, n: number) => {
  const [y, m] = mo.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};
const pct = (now: number | null, prev: number | null) => (now == null || prev == null || prev === 0 ? null : Math.round(((now - prev) / prev) * 100));

const WRITERS = ['st_manager', 'dist_admin', 'dist_treasury'] as const;

/** The station an actor may see: a station manager only their own; the distributor any (or all, when none is given). */
function stationScope(ctx: Ctx, actor: Actor, stationId?: number) {
  requireRole(actor, ['st_manager', ...DISTRIBUTOR]);
  if (actor.role === 'st_manager') {
    if (stationId && stationId !== actor.stationId) throw forbidden();
    stationId = actor.stationId!;
  }
  if (!stationId) return null;
  const station = ctx.db.get<{ id: number; name: string }>('SELECT id, name FROM stations WHERE id = ?', stationId);
  if (!station) throw notFound('Station');
  return station;
}

function checkMonth(month: string) {
  if (!MONTH.test(month) || month < '2000-01') throw badRequest('bad_month', 'Use a month like 2026-09');
  if (month > currentMonth()) throw badRequest('bad_month', 'You cannot enter sales for a future month');
}

function upsert(ctx: Ctx, actor: Actor, stationId: number, month: string, grade: Grade, mgal: number, minor: number | null, source: 'entry' | 'import') {
  ctx.db.run(
    `INSERT INTO station_actuals (station_id, month, grade, gallons_mgal, amount_minor, source, entered_by, updated_at)
     VALUES (?,?,?,?,?,?,?, datetime('now'))
     ON CONFLICT (station_id, month, grade) DO UPDATE SET gallons_mgal = excluded.gallons_mgal, amount_minor = excluded.amount_minor,
       source = excluded.source, entered_by = excluded.entered_by, updated_at = excluded.updated_at`,
    stationId, month, grade, mgal, minor, source, actor.userId,
  );
}

/** Records (or corrects) one month's sales for a station, per fuel. Gallons and HTG are plain numbers. */
export function recordActuals(ctx: Ctx, actor: Actor, stationId: number, month: string, lines: { grade: Grade; gallons: number; amount?: number | null }[]) {
  requireRole(actor, [...WRITERS]);
  const station = stationScope(ctx, actor, stationId)!;
  checkMonth(month);
  if (!lines.length) throw badRequest('no_lines', 'Enter the gallons sold for at least one fuel');
  ctx.db.tx(() => {
    for (const l of lines) {
      if (!(l.gallons >= 0) || l.gallons > 10_000_000) throw badRequest('bad_gallons', 'Enter gallons as a number of 0 or more');
      if (l.amount != null && !(l.amount >= 0)) throw badRequest('bad_amount', 'Enter the amount as a number of 0 or more');
      upsert(ctx, actor, station.id, month, l.grade, Math.round(l.gallons * 1000), l.amount == null ? null : Math.round(l.amount * 100), 'entry');
    }
    ctx.db.audit(actor.userId, 'station.actuals', 'station', station.id, { month, lines: lines.length });
  });
  return stationPerformance(ctx, actor, { stationId: station.id });
}

// Column names as stations keep them, in French and English (compared without accents or case).
const ALIASES: Record<string, string[]> = {
  station: ['station', 'nom station', 'nom de la station', 'site', 'point de vente'],
  month: ['month', 'mois', 'periode', 'period', 'date'],
  grade: ['grade', 'fuel', 'carburant', 'produit', 'product', 'type'],
  gallons: ['gallons', 'gallon', 'gal', 'volume', 'quantite', 'quantity', 'volume gallons', 'gallons vendus', 'quantite gallons'],
  amount: ['amount', 'montant', 'ventes', 'sales', 'montant htg', 'ventes htg', 'chiffre d affaires', "chiffre d'affaires", 'ca'],
  diesel: ['diesel', 'gallons diesel', 'diesel gallons', 'diesel gal'],
  gasoline: ['gasoline', 'gazoline', 'essence', 'gallons gazoline', 'gazoline gallons', 'gasoline gallons', 'gazoline gal', 'gasoline gal'],
};
const norm = (h: string) => h.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’`]/g, "'")
  .replace(/[°º.:#()]/g, ' ').replace(/\s+/g, ' ').trim();
// Month names in French and English, checked in this order (so "juin" and "juil" are not confused).
const MONTH_NAMES: [string, number][] = [['janv', 1], ['jan', 1], ['fev', 2], ['feb', 2], ['mars', 3], ['mar', 3], ['avr', 4], ['apr', 4],
  ['mai', 5], ['may', 5], ['juin', 6], ['jun', 6], ['juil', 7], ['jul', 7], ['aou', 8], ['aug', 8], ['sep', 9], ['oct', 10], ['nov', 11], ['dec', 12]];

/** "2025-09", "2025-09-30", "09/2025", "9/2025", "30/09/2025", "sept 2025", "septembre 2025", "Sep-2025" → "2025-09". */
export function parseMonth(raw: string): string | null {
  const s = norm(raw);
  let m = s.match(/^(\d{4})-(\d{1,2})(-\d{1,2})?/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}`;
  m = s.match(/^(?:\d{1,2}\/)?(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[2]}-${m[1].padStart(2, '0')}`;
  m = s.match(/^([a-z]+)[\s-]+(\d{4})$/);
  const hit = m && MONTH_NAMES.find(([p]) => m![1].startsWith(p));
  return hit ? `${m![2]}-${String(hit[1]).padStart(2, '0')}` : null;
}
const parseGrade = (raw: string): Grade | null => {
  const s = norm(raw);
  if (/^(diesel|gasoil|gas-oil|gazole)/.test(s)) return 'diesel';
  if (/^(gasoline|gazoline|essence|gaz|petrol|premium|regular)/.test(s)) return 'gasoline';
  return null;
};
const parseGallons = (raw: string) => { const minor = parseAmount(raw ?? ''); return minor == null ? null : minor * 10; }; // minor (1/100) → mgal (1/1000)

/**
 * Imports monthly sales from a sheet. Either one row per month and fuel (month, fuel, gallons, optional amount) or one
 * row per month with a diesel and a gazoline column. The distributor adds a station column; a station manager's rows
 * are for their own station. Existing months are replaced. Lines that cannot be read are listed and skipped.
 */
export function importActuals(ctx: Ctx, actor: Actor, sheet: string | string[][]) {
  requireRole(actor, [...WRITERS]);
  const all = typeof sheet === 'string' ? parseCsv(sheet) : sheet;
  let headerAt = -1;
  let col: Record<string, number> = {};
  for (let i = 0; i < Math.min(all.length, 20); i++) {
    const header = all[i].map((h) => norm(h ?? ''));
    const c = Object.fromEntries(Object.entries(ALIASES).map(([k, names]) => [k, header.findIndex((h) => names.includes(h))]));
    if (c.month >= 0 && (c.gallons >= 0 || c.diesel >= 0 || c.gasoline >= 0)) { headerAt = i; col = c; break; }
  }
  if (headerAt < 0) throw badRequest('bad_columns', 'The sheet needs a month column and either a gallons column or diesel and gazoline columns');
  const isDist = DISTRIBUTOR.includes(actor.role);
  if (isDist && col.station < 0) throw badRequest('bad_columns', 'Add a station column so each line can be matched to a station');
  const stations = new Map(ctx.db.all<{ id: number; name: string }>('SELECT id, name FROM stations').map((s) => [norm(s.name), s.id]));

  const skipped: { line: number; reason: string }[] = [];
  let imported = 0;
  const months = new Set<string>();
  ctx.db.tx(() => {
    all.slice(headerAt + 1).forEach((row, i) => {
      const line = headerAt + i + 2;
      const cell = (k: string) => (col[k] >= 0 ? String(row[col[k]] ?? '').trim() : '');
      const stationId = isDist ? stations.get(norm(cell('station'))) : actor.stationId!;
      if (!stationId) return skipped.push({ line, reason: 'unknown_station' });
      const month = parseMonth(cell('month'));
      if (!month || month < '2000-01' || month > currentMonth()) return skipped.push({ line, reason: 'bad_month' });
      const entries: [Grade, number | null, number | null][] = col.grade >= 0 && col.gallons >= 0
        ? [[parseGrade(cell('grade'))!, parseGallons(cell('gallons')), col.amount >= 0 && cell('amount') ? parseAmount(cell('amount')) : null]]
        : GRADES.filter((g) => col[g] >= 0 && cell(g)).map((g) => [g, parseGallons(cell(g)), null]);
      if (!entries.length) return skipped.push({ line, reason: 'no_gallons' });
      for (const [grade, mgal, minor] of entries) {
        if (!grade) { skipped.push({ line, reason: 'bad_fuel' }); continue; }
        if (mgal == null || mgal < 0) { skipped.push({ line, reason: 'no_gallons' }); continue; }
        upsert(ctx, actor, stationId, month, grade, mgal, minor != null && minor >= 0 ? minor : null, 'import');
        imported++; months.add(month);
      }
    });
    ctx.db.audit(actor.userId, 'station.actuals_import', 'station', isDist ? null : actor.stationId!, { imported, skipped: skipped.length });
  });
  const sorted = [...months].sort();
  return { imported, skipped, from: sorted[0] ?? null, to: sorted.at(-1) ?? null };
}

/** Deletes one month's entries for a station (e.g. a wrong month imported). */
export function deleteActuals(ctx: Ctx, actor: Actor, stationId: number, month: string) {
  requireRole(actor, [...WRITERS]);
  const station = stationScope(ctx, actor, stationId)!;
  if (!MONTH.test(month)) throw badRequest('bad_month', 'Use a month like 2026-09');
  ctx.db.run('DELETE FROM station_actuals WHERE station_id = ? AND month = ?', station.id, month);
  ctx.db.audit(actor.userId, 'station.actuals_delete', 'station', station.id, { month });
  return stationPerformance(ctx, actor, { stationId: station.id });
}


/** Month-to-month and year-to-year comparison of a station's sales (or all stations together, for the distributor). */
export function stationPerformance(ctx: Ctx, actor: Actor, opts: { stationId?: number; months?: number; grade?: Grade } = {}) {
  const station = stationScope(ctx, actor, opts.stationId);
  const n = opts.months ?? 12;
  if (![12, 24].includes(n)) throw badRequest('bad_period', 'Choose 12 or 24 months');
  const cur = currentMonth();
  const lastFull = shiftMonth(cur, -1);
  const months = Array.from({ length: n }, (_, i) => shiftMonth(cur, i - n + 1));
  const from = shiftMonth(months[0], -13); // the month before, a year earlier
  const gradeSql = opts.grade ? 'AND grade = ?' : '';
  const scopeArgs = [...(station ? [station.id] : []), ...(opts.grade ? [opts.grade] : [])];

  const actualRows = ctx.db.all<{ station_id: number; month: string; grade: string; gallons_mgal: number; amount_minor: number | null }>(
    `SELECT station_id, month, grade, gallons_mgal, amount_minor FROM station_actuals
      WHERE month >= ? ${station ? 'AND station_id = ?' : ''} ${gradeSql}`, from, ...scopeArgs);
  const actual = new Map<string, { mgal: number; minor: number | null; stations: Set<number> }>();
  for (const r of actualRows) {
    const a = actual.get(r.month) ?? { mgal: 0, minor: 0, stations: new Set<number>() };
    a.mgal += r.gallons_mgal;
    a.minor = a.minor == null || r.amount_minor == null ? null : a.minor + r.amount_minor;
    a.stations.add(r.station_id);
    actual.set(r.month, a);
  }

  // What went through ALFA wallets, per month (completed fuelings).
  const since = `${from}-01 00:00:00`;
  const alfa = new Map<string, { mgal: number; minor: number }>();
  const alfaByStation = new Map<string, number>(); // "stationId|month" → mgal
  for (const r of ctx.db.all<{ station_id: number; completed_at: string; mgal: number; minor: number }>(
    `SELECT station_id, completed_at, COALESCE(dispensed_mgal, 0) AS mgal, COALESCE(charged_minor, 0) AS minor FROM redemptions
      WHERE status = 'completed' AND completed_at >= ? ${station ? 'AND station_id = ?' : ''} ${gradeSql}`, since, ...scopeArgs)) {
    const mo = haitiMonth(r.completed_at);
    const a = alfa.get(mo) ?? { mgal: 0, minor: 0 };
    a.mgal += r.mgal; a.minor += r.minor; alfa.set(mo, a);
    alfaByStation.set(`${r.station_id}|${mo}`, (alfaByStation.get(`${r.station_id}|${mo}`) ?? 0) + r.mgal);
  }

  const totalStations = station ? 1 : Number(ctx.db.get('SELECT COUNT(*) AS n FROM stations').n);
  // Per station and month, so changes compare like with like: a station that has not entered a month is left out of
  // that comparison instead of making the total look like a drop.
  const perStation = new Map<number, Map<string, number>>();
  for (const r of actualRows) {
    const m = perStation.get(r.station_id) ?? new Map<string, number>();
    m.set(r.month, (m.get(r.month) ?? 0) + r.gallons_mgal);
    perStation.set(r.station_id, m);
  }
  const allIds = [...perStation.keys()];
  const total = (ids: number[], mo: string) => {
    const vals = ids.map((id) => perStation.get(id)?.get(mo)).filter((v): v is number => v != null);
    return vals.length ? vals.reduce((t, v) => t + v, 0) : null;
  };
  const change = (ids: number[], mo: string, before: string) => {
    let now = 0; let prev = 0; let pairs = 0;
    for (const id of ids) {
      const a = perStation.get(id)?.get(mo); const b = perStation.get(id)?.get(before);
      if (a != null && b != null) { now += a; prev += b; pairs++; }
    }
    return pairs ? pct(now, prev) : null;
  };
  // Year to date: January to the last full month; the change counts only months entered in both years.
  const year = lastFull.slice(0, 4);
  const ytdOf = (ids: number[]) => {
    let y = 0; let yp = 0; let anyY = false; let anyP = false; let likeNow = 0; let likePrev = 0; let pairs = 0;
    for (let mo = `${year}-01`; mo <= lastFull; mo = shiftMonth(mo, 1)) {
      for (const id of ids) {
        const a = perStation.get(id)?.get(mo); const b = perStation.get(id)?.get(shiftMonth(mo, -12));
        if (a != null) { y += a; anyY = true; }
        if (b != null) { yp += b; anyP = true; }
        if (a != null && b != null) { likeNow += a; likePrev += b; pairs++; }
      }
    }
    return { ytd_mgal: anyY ? y : null, ytd_prev_mgal: anyP ? yp : null, ytd_pct: pairs ? pct(likeNow, likePrev) : null, year };
  };

  const rows = months.map((mo) => {
    const a = actual.get(mo);
    const al = alfa.get(mo) ?? { mgal: 0, minor: 0 };
    const now = a?.mgal ?? null;
    return {
      month: mo, in_progress: mo === cur,
      actual_mgal: now, actual_minor: a?.minor ?? null, stations_entered: a?.stations.size ?? 0,
      prev_month_mgal: total(allIds, shiftMonth(mo, -1)), mom_pct: change(allIds, mo, shiftMonth(mo, -1)),
      last_year_mgal: total(allIds, shiftMonth(mo, -12)), yoy_pct: change(allIds, mo, shiftMonth(mo, -12)),
      alfa_mgal: al.mgal, alfa_minor: al.minor, alfa_share_pct: now ? Math.round((al.mgal / now) * 100) : null,
    };
  });

  const summaryOf = (ids: number[], alfaOf: (mo: string) => number) => {
    const now = total(ids, lastFull);
    return {
      month: lastFull, actual_mgal: now,
      prev_month_mgal: total(ids, shiftMonth(lastFull, -1)), mom_pct: change(ids, lastFull, shiftMonth(lastFull, -1)),
      last_year_mgal: total(ids, shiftMonth(lastFull, -12)), yoy_pct: change(ids, lastFull, shiftMonth(lastFull, -12)),
      ...ytdOf(ids),
      alfa_share_pct: now ? Math.round((alfaOf(lastFull) / now) * 100) : null,
    };
  };

  // For the distributor's all-stations view: one summary line per station.
  const byStation = station ? [] : ctx.db.all<{ id: number; name: string }>('SELECT id, name FROM stations ORDER BY name').map((s) => ({
    id: s.id, name: s.name, ...summaryOf([s.id], (mo) => alfaByStation.get(`${s.id}|${mo}`) ?? 0),
    missing_last_month: perStation.get(s.id)?.get(lastFull) == null,
  }));

  const entries = station ? ctx.db.all<{ month: string; grade: string; gallons_mgal: number; amount_minor: number | null; source: string; updated_at: string }>(
    'SELECT month, grade, gallons_mgal, amount_minor, source, updated_at FROM station_actuals WHERE station_id = ? ORDER BY month DESC, grade', station.id) : [];

  return {
    station, stations: DISTRIBUTOR.includes(actor.role) ? ctx.db.all('SELECT id, name FROM stations ORDER BY name') : [],
    total_stations: totalStations, months, current_month: cur, last_full_month: lastFull,
    can_edit: (WRITERS as readonly string[]).includes(actor.role) && !!station,
    rows,
    summary: summaryOf(allIds, (mo) => alfa.get(mo)?.mgal ?? 0),
    missing_months: months.filter((mo) => mo !== cur && (actual.get(mo)?.stations.size ?? 0) < totalStations),
    by_station: byStation,
    entries,
  };
}
