import { randomInt } from 'node:crypto';
import { requireRole, verifySecret, type Actor } from '../auth.js';
import type { Ctx } from '../context.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { acct, GAL, type Line } from '../ledger.js';
import { GRADES, nowIso, toMgal, valueOf } from '../units.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 10 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

/** QR payload shown on the station terminal. */
export const qrPayload = (code: string) => `BOUSOL:R:${code}`;
export const parseCode = (scanned: string) => scanned.trim().toUpperCase().replace(/^BOUSOL:R:/, '');

function attendantContext(ctx: Ctx, actor: Actor) {
  requireRole(actor, ['st_attendant']);
  if (!actor.terminalId) throw forbidden('Attendant must be signed in on a station terminal');
  const terminal = ctx.db.get('SELECT * FROM terminals WHERE id = ?', actor.terminalId);
  const station = ctx.db.get('SELECT * FROM stations WHERE id = ?', terminal.station_id);
  if (terminal.status !== 'active') throw conflict('frozen', 'Terminal is frozen');
  if (station.status !== 'active') throw conflict('frozen', 'Station is frozen');
  return { terminal, station };
}

// ---------------------------------------------------------------------------
// Shifts

export function currentShift(ctx: Ctx, actor: Actor) {
  if (!actor.terminalId) return null;
  return ctx.db.get("SELECT * FROM shifts WHERE terminal_id = ? AND status = 'open'", actor.terminalId) ?? null;
}

export function openShift(ctx: Ctx, actor: Actor) {
  const { terminal, station } = attendantContext(ctx, actor);
  return ctx.db.tx(() => {
    const open = currentShift(ctx, actor);
    if (open) {
      if (open.attendant_id !== actor.userId) throw conflict('shift_open', 'Another attendant has an open shift on this terminal');
      return open;
    }
    const id = ctx.db.run(
      'INSERT INTO shifts (station_id, terminal_id, attendant_id) VALUES (?,?,?)',
      station.id, terminal.id, actor.userId,
    ).id;
    ctx.db.audit(actor.userId, 'shift.open', 'shift', id);
    return ctx.db.get('SELECT * FROM shifts WHERE id = ?', id);
  });
}

function shiftDigitalTotals(ctx: Ctx, shiftId: number) {
  const out: Record<string, number> = {};
  for (const r of ctx.db.all(
    "SELECT grade, SUM(dispensed_mgal) AS m FROM redemptions WHERE shift_id = ? AND status = 'completed' GROUP BY grade",
    shiftId,
  )) out[r.grade] = Number(r.m);
  return out;
}

/**
 * Closes a shift by comparing digital redemptions with the attendant's pump meter and POS totals
 * for program sales. Variance beyond tolerance holds the shift and opens an exception.
 */
export function closeShift(
  ctx: Ctx,
  actor: Actor,
  input: { pumpTotals: Record<string, number>; posTotals: Record<string, number> },
) {
  attendantContext(ctx, actor);
  return ctx.db.tx(() => {
    const shift = currentShift(ctx, actor);
    if (!shift) throw conflict('no_shift', 'No open shift on this terminal');
    if (shift.attendant_id !== actor.userId) throw forbidden('Only the shift attendant can close it');
    expireStale(ctx);
    const inFlight = ctx.db.get(
      "SELECT COUNT(*) AS n FROM redemptions WHERE shift_id = ? AND status IN ('pending','approved')", shift.id,
    ).n;
    if (inFlight > 0) throw conflict('in_flight', 'Complete or cancel open redemption requests before closing');

    const digital = shiftDigitalTotals(ctx, shift.id);
    const pump: Record<string, number> = {};
    const pos: Record<string, number> = {};
    let pumpVar = 0;
    let posVar = 0;
    for (const g of GRADES) {
      pump[g] = toMgal(input.pumpTotals[g] ?? 0);
      pos[g] = toMgal(input.posTotals[g] ?? 0);
      pumpVar += Math.abs(pump[g] - (digital[g] ?? 0));
      posVar += Math.abs(pos[g] - (digital[g] ?? 0));
    }
    const variance = Math.max(pumpVar, posVar);
    const held = variance > ctx.config.varianceToleranceMgal;
    ctx.db.run(
      `UPDATE shifts SET status = ?, closed_at = ?, digital_json = ?, pump_json = ?, pos_json = ?, variance_mgal = ? WHERE id = ?`,
      held ? 'held' : 'closed', nowIso(), JSON.stringify(digital), JSON.stringify(pump), JSON.stringify(pos), variance, shift.id,
    );
    if (held) {
      const station = ctx.db.get('SELECT name FROM stations WHERE id = ?', shift.station_id);
      ctx.db.run(
        `INSERT INTO exceptions (kind, ref_type, ref_id, station_id, summary, detail, created_by)
         VALUES ('shift_variance', 'shift', ?, ?, ?, ?, ?)`,
        shift.id, shift.station_id,
        `${station.name} shift close: ${(variance / 1000).toFixed(1)} gal variance awaiting explanation`,
        JSON.stringify({ digital, pump, pos }), actor.userId,
      );
    }
    ctx.db.audit(actor.userId, 'shift.close', 'shift', shift.id, { variance, held });
    return ctx.db.get('SELECT * FROM shifts WHERE id = ?', shift.id);
  });
}

export function listShifts(ctx: Ctx, stationId?: number) {
  return ctx.db.all(
    `SELECT s.*, st.name AS station_name, u.name AS attendant_name, t.label AS terminal_label
       FROM shifts s JOIN stations st ON st.id = s.station_id JOIN users u ON u.id = s.attendant_id
       JOIN terminals t ON t.id = s.terminal_id
      ${stationId ? 'WHERE s.station_id = ?' : ''} ORDER BY s.id DESC LIMIT 100`,
    ...(stationId ? [stationId] : []),
  );
}

// ---------------------------------------------------------------------------
// Redemption requests

function expireStale(ctx: Ctx) {
  ctx.db.run("UPDATE redemptions SET status = 'expired' WHERE status = 'pending' AND expires_at < datetime('now')");
}

export function getRedemption(ctx: Ctx, id: number) {
  expireStale(ctx);
  const r = ctx.db.get(
    `SELECT r.*, s.name AS station_name, e.name AS employee_name, c.name AS company_name, u.name AS attendant_name
       FROM redemptions r JOIN stations s ON s.id = r.station_id JOIN users u ON u.id = r.attendant_id
       LEFT JOIN employees e ON e.id = r.employee_id LEFT JOIN companies c ON c.id = r.company_id
      WHERE r.id = ?`,
    id,
  );
  if (!r) throw notFound('Redemption');
  return { ...r, qr: qrPayload(r.code) };
}

/** Step 1 · Attendant creates a one-time request for an exact quantity, grade and pump. */
export function createRequest(ctx: Ctx, actor: Actor, input: { grade: string; pump: number; gallons: number }) {
  const { terminal, station } = attendantContext(ctx, actor);
  if (!GRADES.includes(input.grade as any)) throw badRequest('bad_grade', 'Unknown grade');
  const mgal = toMgal(input.gallons);
  if (mgal <= 0) throw badRequest('bad_quantity', 'Quantity must be positive');
  if (!Number.isInteger(input.pump) || input.pump < 1) throw badRequest('bad_pump', 'Pump number required');
  return ctx.db.tx(() => {
    const shift = currentShift(ctx, actor);
    if (!shift || shift.attendant_id !== actor.userId) throw conflict('no_shift', 'Open your shift first');
    const id = ctx.db.run(
      `INSERT INTO redemptions (code, station_id, terminal_id, shift_id, attendant_id, pump, grade, requested_mgal, expires_at)
       VALUES (?,?,?,?,?,?,?,?, datetime('now', ?))`,
      newCode(), station.id, terminal.id, shift.id, actor.userId, input.pump, input.grade, mgal,
      `+${ctx.config.redemptionTtlSeconds} seconds`,
    ).id;
    ctx.db.audit(actor.userId, 'redemption.request', 'redemption', id, input);
    return getRedemption(ctx, id);
  });
}

function employeeContext(ctx: Ctx, actor: Actor) {
  requireRole(actor, ['employee']);
  const emp = ctx.db.get('SELECT * FROM employees WHERE id = ?', actor.employeeId);
  const company = ctx.db.get('SELECT * FROM companies WHERE id = ?', emp.company_id);
  if (emp.bound_device_id && emp.bound_device_id !== actor.deviceId) {
    throw forbidden('This wallet is bound to another phone');
  }
  return { emp, company };
}

/** Step 2a · Employee scans the QR and sees exactly what they are approving. */
export function previewRequest(ctx: Ctx, actor: Actor, scanned: string) {
  const { emp } = employeeContext(ctx, actor);
  expireStale(ctx);
  const r = ctx.db.get('SELECT id FROM redemptions WHERE code = ?', parseCode(scanned));
  if (!r) throw notFound('Fueling request');
  const red = getRedemption(ctx, r.id);
  if (red.status !== 'pending') throw conflict('not_pending', `This request is ${red.status}`);
  const available = ctx.ledger.byGrade(acct.available(emp.id), true)[red.grade] ?? 0;
  return {
    id: red.id, code: red.code, station_name: red.station_name, pump: red.pump, grade: red.grade,
    requested_mgal: red.requested_mgal, expires_at: red.expires_at, available_mgal: available,
  };
}

/** Step 2b · Employee confirms with PIN. Gallons move available -> reserved. */
export function approveRequest(ctx: Ctx, actor: Actor, input: { code: string; pin: string }) {
  const { emp, company } = employeeContext(ctx, actor);
  if (emp.status !== 'active') throw conflict('frozen', 'Your fuel wallet is frozen');
  if (company.status !== 'active') throw conflict('frozen', 'Your company’s program is frozen');
  if (!emp.pin_hash) throw conflict('no_pin', 'Set your PIN first');
  if (emp.pin_locked_until && emp.pin_locked_until > nowIso()) {
    throw new AppError(423, 'pin_locked', 'Too many wrong PINs. Ask your company admin for assisted recovery.');
  }
  if (!verifySecret(input.pin, emp.pin_hash)) {
    const failures = emp.pin_failures + 1;
    const lock = failures >= ctx.config.maxPinFailures;
    ctx.db.run(
      "UPDATE employees SET pin_failures = ?, pin_locked_until = CASE WHEN ? THEN datetime('now', '+1 day') ELSE pin_locked_until END WHERE id = ?",
      failures, lock ? 1 : 0, emp.id,
    );
    ctx.db.audit(actor.userId, 'pin.failed', 'employee', emp.id, { failures });
    throw new AppError(401, 'bad_pin', lock ? 'Wallet locked after too many wrong PINs' : `Wrong PIN (${ctx.config.maxPinFailures - failures} tries left)`);
  }

  return ctx.db.tx(() => {
    ctx.db.run('UPDATE employees SET pin_failures = 0 WHERE id = ?', emp.id);
    expireStale(ctx);
    const row = ctx.db.get('SELECT id FROM redemptions WHERE code = ?', parseCode(input.code));
    if (!row) throw notFound('Fueling request');
    const red = getRedemption(ctx, row.id);
    if (red.status !== 'pending') throw conflict('not_pending', `This request is ${red.status}`);
    const station = ctx.db.get('SELECT status FROM stations WHERE id = ?', red.station_id);
    const terminal = ctx.db.get('SELECT status FROM terminals WHERE id = ?', red.terminal_id);
    if (station.status !== 'active' || terminal.status !== 'active') throw conflict('frozen', 'Station is not accepting redemptions');

    const picks = ctx.ledger.pickFifo(acct.available(emp.id), red.grade, red.requested_mgal);
    const lines: Line[] = picks.flatMap((p) => [
      { account: acct.available(emp.id), unit: GAL, lotId: p.lotId, debit: p.mgal },
      { account: acct.reserved(emp.id), unit: GAL, lotId: p.lotId, credit: p.mgal },
    ]);
    const entryId = ctx.ledger.post({
      kind: 'redemption_reserved', refType: 'redemption', refId: red.id, companyId: emp.company_id,
      memo: `${red.station_name} pump ${red.pump}`, createdBy: actor.userId, lines,
    });
    // Single use: the conditional update guarantees only one approval wins.
    const upd = ctx.db.run(
      `UPDATE redemptions SET status = 'approved', employee_id = ?, company_id = ?, reserve_entry_id = ?, approved_at = ?
        WHERE id = ? AND status = 'pending'`,
      emp.id, emp.company_id, entryId, nowIso(), red.id,
    );
    if (upd.changes !== 1) throw conflict('not_pending', 'Request already used');
    ctx.db.audit(actor.userId, 'redemption.approve', 'redemption', red.id);
    return getRedemption(ctx, red.id);
  });
}

/** Step 4 · Attendant confirms the dispensed quantity. Only now does fuel count as redeemed. */
export function completeRequest(ctx: Ctx, actor: Actor, id: number, dispensedGallons: number) {
  attendantContext(ctx, actor);
  return ctx.db.tx(() => {
    const red = getRedemption(ctx, id);
    if (red.terminal_id !== actor.terminalId) throw forbidden('Request belongs to another terminal');
    if (red.status !== 'approved') throw conflict('bad_state', `Request is ${red.status}`);
    const dispensed = toMgal(dispensedGallons);
    if (dispensed <= 0) throw badRequest('bad_quantity', 'Use cancel if nothing was dispensed');
    if (dispensed > red.requested_mgal) throw badRequest('over_dispense', 'Cannot dispense more than the employee approved');

    const reserved = ctx.db.all(
      `SELECT jl.lot_id, jl.credit AS mgal, l.price_minor, l.currency FROM journal_lines jl JOIN lots l ON l.id = jl.lot_id
        WHERE jl.entry_id = ? AND jl.account = ? ORDER BY jl.id`,
      red.reserve_entry_id, acct.reserved(red.employee_id),
    );
    const lines: Line[] = [];
    let toConfirm = dispensed;
    for (const r of reserved) {
      const confirm = Math.min(toConfirm, r.mgal);
      const release = r.mgal - confirm;
      toConfirm -= confirm;
      if (confirm > 0) {
        const value = valueOf(confirm, r.price_minor);
        lines.push(
          { account: acct.reserved(red.employee_id), unit: GAL, lotId: r.lot_id, debit: confirm },
          { account: acct.clearing(red.station_id), unit: GAL, lotId: r.lot_id, credit: confirm },
          { account: acct.prepaidLiability(red.company_id), unit: r.currency, debit: value },
          { account: acct.fuelRevenue, unit: r.currency, credit: value },
        );
      }
      if (release > 0) {
        lines.push(
          { account: acct.reserved(red.employee_id), unit: GAL, lotId: r.lot_id, debit: release },
          { account: acct.available(red.employee_id), unit: GAL, lotId: r.lot_id, credit: release },
        );
      }
    }
    const entryId = ctx.ledger.post({
      kind: 'fuel_confirmed', refType: 'redemption', refId: red.id, companyId: red.company_id,
      memo: `${red.station_name} pump ${red.pump} · ${(dispensed / 1000).toFixed(3)} gal`, createdBy: actor.userId, lines,
    });
    ctx.db.run(
      "UPDATE redemptions SET status = 'completed', dispensed_mgal = ?, confirm_entry_id = ?, completed_at = ? WHERE id = ?",
      dispensed, entryId, nowIso(), red.id,
    );
    ctx.db.audit(actor.userId, 'redemption.complete', 'redemption', red.id, { dispensed });
    return getRedemption(ctx, red.id);
  });
}

/** Cancels a request; an approved one releases its reservation with a reversing entry. */
export function cancelRequest(ctx: Ctx, actor: Actor, id: number) {
  return ctx.db.tx(() => {
    const red = getRedemption(ctx, id);
    if (actor.role === 'st_attendant') {
      if (red.terminal_id !== actor.terminalId) throw forbidden('Request belongs to another terminal');
    } else if (actor.role === 'employee') {
      if (red.employee_id !== actor.employeeId || red.status !== 'approved') throw forbidden('Not your request');
    } else {
      throw forbidden();
    }
    if (red.status === 'pending') {
      ctx.db.run("UPDATE redemptions SET status = 'cancelled' WHERE id = ?", id);
    } else if (red.status === 'approved') {
      ctx.ledger.reverse(red.reserve_entry_id, actor.userId, `Cancelled request ${red.code}`);
      ctx.db.run("UPDATE redemptions SET status = 'cancelled' WHERE id = ?", id);
    } else {
      throw conflict('bad_state', `Request is ${red.status}`);
    }
    ctx.db.audit(actor.userId, 'redemption.cancel', 'redemption', id);
    return getRedemption(ctx, id);
  });
}

export function listRedemptions(ctx: Ctx, filter: { shiftId?: number; employeeId?: number; stationId?: number; limit?: number }) {
  expireStale(ctx);
  const where: string[] = [];
  const params: (number | string)[] = [];
  if (filter.shiftId) { where.push('r.shift_id = ?'); params.push(filter.shiftId); }
  if (filter.employeeId) { where.push('r.employee_id = ?'); params.push(filter.employeeId); }
  if (filter.stationId) { where.push('r.station_id = ?'); params.push(filter.stationId); }
  return ctx.db.all(
    `SELECT r.*, s.name AS station_name, e.name AS employee_name, c.name AS company_name
       FROM redemptions r JOIN stations s ON s.id = r.station_id
       LEFT JOIN employees e ON e.id = r.employee_id LEFT JOIN companies c ON c.id = r.company_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.id DESC LIMIT ${filter.limit ?? 100}`,
    ...params,
  );
}
