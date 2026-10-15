// Suspicious fueling alerts. Fixed, explainable rules look at the last 30 days of fuel sales and shifts and
// raise an alert for a person to review: they never block a sale, freeze anyone or move money. Each alert
// keeps the facts that triggered it; the screen turns them into a sentence in the reader's language.
//
// Rules (thresholds in RULES below):
// - large_fill: one fueling above the per-grade limit.
// - rapid_repeat: the same employee fuels twice within an hour; "high" when at two different stations.
// - daily_volume: one employee's total for a Haiti day above the limit.
// - night: a fueling between 23:00 and 05:00 Haiti time.
// - attendant_variances: an attendant with several shifts held for cash or meter differences.
// - offline_share: a terminal whose sales are mostly offline (offline sales are checked later, not live).
import { DISTRIBUTOR, requireRole, type Actor } from '../auth.js';
import type { Ctx } from '../context.js';
import { conflict, notFound } from '../errors.js';

export const RULES = {
  largeFillMgal: { gasoline: 25_000, diesel: 60_000 },
  repeatWithinMinutes: 60,
  dailyVolumeMgal: 60_000,
  nightFromHour: 23,
  nightToHour: 5,
  heldShifts: 3,
  offlineMinSales: 10,
  offlineShare: 0.5,
  windowDays: 30,
} as const;

export type AlertRule = 'large_fill' | 'rapid_repeat' | 'daily_volume' | 'night' | 'attendant_variances' | 'offline_share';
type Severity = 'high' | 'medium' | 'low';

const TZ = 'America/Port-au-Prince';
const haitiParts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
/** "2026-10-15 23:10:00" (UTC) → Haiti date and hour. */
function haiti(utc: string) {
  const p = Object.fromEntries(haitiParts.formatToParts(new Date(utc.replace(' ', 'T') + 'Z')).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}
const minutesBetween = (a: string, b: string) => Math.abs(Date.parse(a.replace(' ', 'T') + 'Z') - Date.parse(b.replace(' ', 'T') + 'Z')) / 60_000;

interface Sale {
  id: number; code: string; employee_id: number; company_id: number; station_id: number; terminal_id: number; attendant_id: number;
  grade: 'diesel' | 'gasoline'; dispensed_mgal: number; charged_minor: number; offline: number; completed_at: string;
}

interface NewAlert {
  rule: AlertRule; severity: Severity; key: string; facts: Record<string, unknown>;
  companyId?: number | null; stationId?: number | null; employeeId?: number | null; attendantId?: number | null; terminalId?: number | null;
  redemptionIds?: number[];
}

/** Runs every rule over the window and records new alerts (each pattern once, by its key). Returns how many were added. */
export function scanFuelAlerts(ctx: Ctx): number {
  const since = new Date(Date.now() - RULES.windowDays * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
  const sales = ctx.db.all<Sale>(
    `SELECT id, code, employee_id, company_id, station_id, terminal_id, attendant_id, grade, dispensed_mgal, charged_minor, offline, completed_at
       FROM redemptions WHERE status = 'completed' AND completed_at >= ? AND employee_id IS NOT NULL ORDER BY completed_at, id`, since);
  const found: NewAlert[] = [];
  const base = (s: Sale) => ({ companyId: s.company_id, stationId: s.station_id, employeeId: s.employee_id, attendantId: s.attendant_id, terminalId: s.terminal_id });

  for (const s of sales) {
    const limit = RULES.largeFillMgal[s.grade];
    if (s.dispensed_mgal > limit) {
      found.push({ rule: 'large_fill', severity: s.dispensed_mgal > limit * 1.5 ? 'high' : 'medium', key: `large_fill:${s.id}`, ...base(s),
        redemptionIds: [s.id], facts: { code: s.code, grade: s.grade, mgal: s.dispensed_mgal, limitMgal: limit, at: s.completed_at } });
    }
    const h = haiti(s.completed_at).hour;
    if (h >= RULES.nightFromHour || h < RULES.nightToHour) {
      found.push({ rule: 'night', severity: 'low', key: `night:${s.id}`, ...base(s), redemptionIds: [s.id],
        facts: { code: s.code, mgal: s.dispensed_mgal, at: s.completed_at, hour: h } });
    }
  }

  // Same employee twice within the hour (sales are in time order).
  const byEmployee = new Map<number, Sale[]>();
  for (const s of sales) byEmployee.set(s.employee_id, [...(byEmployee.get(s.employee_id) ?? []), s]);
  for (const list of byEmployee.values()) {
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1]; const b = list[i];
      const minutes = minutesBetween(a.completed_at, b.completed_at);
      if (minutes > RULES.repeatWithinMinutes) continue;
      const twoStations = a.station_id !== b.station_id;
      found.push({ rule: 'rapid_repeat', severity: twoStations ? 'high' : 'medium', key: `rapid_repeat:${a.id}:${b.id}`, ...base(b),
        redemptionIds: [a.id, b.id],
        facts: { codes: [a.code, b.code], minutes: Math.round(minutes), twoStations, stations: [a.station_id, b.station_id], mgal: a.dispensed_mgal + b.dispensed_mgal, at: b.completed_at } });
    }
    // Daily total per Haiti day.
    const days = new Map<string, Sale[]>();
    for (const s of list) { const d = haiti(s.completed_at).date; days.set(d, [...(days.get(d) ?? []), s]); }
    for (const [day, ds] of days) {
      const mgal = ds.reduce((t, s) => t + s.dispensed_mgal, 0);
      if (mgal > RULES.dailyVolumeMgal) {
        found.push({ rule: 'daily_volume', severity: mgal > RULES.dailyVolumeMgal * 1.5 ? 'high' : 'medium', key: `daily_volume:${ds[0].employee_id}:${day}`,
          ...base(ds[ds.length - 1]), redemptionIds: ds.map((s) => s.id), facts: { day, mgal, count: ds.length, limitMgal: RULES.dailyVolumeMgal } });
      }
    }
  }

  // Attendants with several shifts held for differences.
  const held = ctx.db.all<{ attendant_id: number; station_id: number; n: number; last_id: number }>(
    `SELECT attendant_id, MAX(station_id) AS station_id, COUNT(*) AS n, MAX(id) AS last_id FROM shifts
      WHERE opened_at >= ? AND (status = 'held' OR COALESCE(variance_minor, 0) != 0 OR COALESCE(variance_mgal, 0) != 0)
      GROUP BY attendant_id HAVING n >= ?`, since, RULES.heldShifts);
  for (const r of held) {
    // Keyed on the latest shift, so a new run of differences raises a new alert after one was cleared.
    found.push({ rule: 'attendant_variances', severity: r.n >= RULES.heldShifts * 2 ? 'high' : 'medium', key: `attendant_variances:${r.attendant_id}:${r.last_id}`,
      attendantId: r.attendant_id, stationId: r.station_id, facts: { shifts: r.n, days: RULES.windowDays } });
  }

  // Terminals selling mostly offline over the last 7 days.
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
  const terminals = ctx.db.all<{ terminal_id: number; station_id: number; total: number; offline: number; last_id: number }>(
    `SELECT terminal_id, MAX(station_id) AS station_id, COUNT(*) AS total, SUM(offline) AS offline, MAX(id) AS last_id FROM redemptions
      WHERE status = 'completed' AND completed_at >= ? GROUP BY terminal_id HAVING total >= ?`, weekAgo, RULES.offlineMinSales);
  for (const r of terminals) {
    const share = Number(r.offline) / Number(r.total);
    if (share <= RULES.offlineShare) continue;
    found.push({ rule: 'offline_share', severity: share >= 0.8 ? 'high' : 'medium', key: `offline_share:${r.terminal_id}:${haiti(nowUtc()).date}`,
      terminalId: r.terminal_id, stationId: r.station_id, facts: { total: Number(r.total), offline: Number(r.offline), share: Math.round(share * 100) } });
  }

  let added = 0;
  ctx.db.tx(() => {
    for (const a of found) {
      const r = ctx.db.run(
        `INSERT OR IGNORE INTO fuel_alerts (rule, severity, dedupe_key, company_id, station_id, employee_id, attendant_id, terminal_id, redemption_ids, facts_json)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        a.rule, a.severity, a.key, a.companyId ?? null, a.stationId ?? null, a.employeeId ?? null, a.attendantId ?? null, a.terminalId ?? null,
        JSON.stringify(a.redemptionIds ?? []), JSON.stringify(a.facts),
      );
      added += r.changes;
    }
  });
  return added;
}

const nowUtc = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/** Alerts, newest first, with names for the screen. Scans first so the list is always current. */
export function listFuelAlerts(ctx: Ctx, actor: Actor, opts: { status?: 'open' | 'all' } = {}) {
  requireRole(actor, DISTRIBUTOR);
  scanFuelAlerts(ctx);
  const rows = ctx.db.all(
    `SELECT a.*, c.name AS company_name, s.name AS station_name, e.name AS employee_name, u.name AS attendant_name, r.name AS reviewed_by_name
       FROM fuel_alerts a
       LEFT JOIN companies c ON c.id = a.company_id LEFT JOIN stations s ON s.id = a.station_id
       LEFT JOIN employees e ON e.id = a.employee_id LEFT JOIN users u ON u.id = a.attendant_id LEFT JOIN users r ON r.id = a.reviewed_by
      ${opts.status === 'all' ? '' : "WHERE a.status = 'open'"}
      ORDER BY a.status = 'open' DESC, CASE a.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, a.id DESC LIMIT 300`,
  );
  const stationNames = new Map(ctx.db.all<{ id: number; name: string }>('SELECT id, name FROM stations').map((s) => [s.id, s.name]));
  return rows.map((a: any) => {
    const facts = JSON.parse(a.facts_json);
    if (Array.isArray(facts.stations)) facts.stationNames = facts.stations.map((id: number) => stationNames.get(id) ?? `#${id}`);
    return { ...a, facts, redemption_ids: JSON.parse(a.redemption_ids), facts_json: undefined };
  });
}

/** Count of open alerts for the dashboard. */
export function openAlertCount(ctx: Ctx) {
  scanFuelAlerts(ctx);
  return Number(ctx.db.get("SELECT COUNT(*) AS n FROM fuel_alerts WHERE status = 'open'")!.n);
}

/** A person decides: "cleared" (explained, nothing wrong) or "confirmed" (needs follow-up). A note is required. */
export function reviewFuelAlert(ctx: Ctx, actor: Actor, alertId: number, outcome: 'cleared' | 'confirmed', note: string) {
  requireRole(actor, ['dist_admin', 'dist_approver']);
  const a = ctx.db.get('SELECT * FROM fuel_alerts WHERE id = ?', alertId);
  if (!a) throw notFound('Alert');
  if (a.status !== 'open') throw conflict('bad_state', 'This alert has already been reviewed');
  ctx.db.tx(() => {
    ctx.db.run("UPDATE fuel_alerts SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?", outcome, note, actor.userId, alertId);
    ctx.db.audit(actor.userId, `alert.${outcome}`, 'fuel_alert', alertId, { rule: a.rule, note });
  });
  return ctx.db.get('SELECT * FROM fuel_alerts WHERE id = ?', alertId);
}
