import { randomBytes, randomInt } from 'node:crypto';
import { requireRole, type Actor } from '../auth.js';
import type { Ctx } from '../context.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { acct, type Line } from '../ledger.js';
import { gallonsFor, GRADES, nowIso, toMgal, toMinor, valueOf } from '../units.js';
import {
  decodeResponse, encodeChallenge, tokenMessage, verifyOfflineProof, verifyPinProof, verifySignature,
} from '../offline.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 10 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

const newNonce = () => randomBytes(9).toString('base64url');

export function attendantContext(ctx: Ctx, actor: Actor) {
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
  const gallons: Record<string, number> = {};
  const amounts: Record<string, number> = {};
  for (const r of ctx.db.all(
    `SELECT grade, SUM(dispensed_mgal) AS m, SUM(charged_minor) AS a FROM redemptions
      WHERE shift_id = ? AND status = 'completed' GROUP BY grade`,
    shiftId,
  )) {
    gallons[r.grade] = Number(r.m);
    amounts[r.grade] = Number(r.a);
  }
  return { gallons, amounts };
}

/**
 * Closes a shift. Pump meters count gallons, so meter totals are compared with the gallons recorded on
 * each redemption; the POS totals for program sales are compared in currency with what was charged.
 * Variance beyond either tolerance holds the shift and opens an exception.
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
    let gallonVar = 0;
    let moneyVar = 0;
    for (const g of GRADES) {
      pump[g] = toMgal(input.pumpTotals[g] ?? 0);
      pos[g] = toMinor(input.posTotals[g] ?? 0);
      gallonVar += Math.abs(pump[g] - (digital.gallons[g] ?? 0));
      moneyVar += Math.abs(pos[g] - (digital.amounts[g] ?? 0));
    }
    const held = gallonVar > ctx.config.varianceToleranceMgal || moneyVar > ctx.config.varianceToleranceMinor;
    ctx.db.run(
      `UPDATE shifts SET status = ?, closed_at = ?, digital_json = ?, pump_json = ?, pos_json = ?, variance_mgal = ?, variance_minor = ?
        WHERE id = ?`,
      held ? 'held' : 'closed', nowIso(), JSON.stringify(digital), JSON.stringify(pump), JSON.stringify(pos),
      gallonVar, moneyVar, shift.id,
    );
    if (held) {
      const station = ctx.db.get('SELECT name FROM stations WHERE id = ?', shift.station_id);
      const parts = [];
      if (moneyVar > ctx.config.varianceToleranceMinor) parts.push(`${(moneyVar / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} HTG`);
      if (gallonVar > ctx.config.varianceToleranceMgal) parts.push(`${(gallonVar / 1000).toFixed(1)} gal`);
      ctx.db.run(
        `INSERT INTO exceptions (kind, ref_type, ref_id, station_id, summary, detail, created_by)
         VALUES ('shift_variance', 'shift', ?, ?, ?, ?, ?)`,
        shift.id, shift.station_id,
        `${station.name} shift close: ${parts.join(' / ')} variance awaiting explanation`,
        JSON.stringify({ digital, pump, pos }), actor.userId,
      );
    }
    ctx.db.audit(actor.userId, 'shift.close', 'shift', shift.id, { gallonVar, moneyVar, held });
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
  const { challenge_nonce, prev_nonce, ...rest } = r;
  return {
    ...rest,
    // Only an open request exposes its challenge; it is shown as the terminal QR.
    challenge: r.status === 'pending'
      ? encodeChallenge({ c: r.code, n: challenge_nonce, s: r.station_name, p: r.pump, g: r.grade, a: r.requested_minor, q: r.requested_mgal })
      : null,
  };
}

/**
 * Rotates the challenge nonce once it is older than the rotation period. The terminal calls this
 * while it shows the QR, so a photo or screenshot of the QR stops working within one or two periods.
 */
export function refreshChallenge(ctx: Ctx, actor: Actor, id: number) {
  attendantContext(ctx, actor);
  return ctx.db.tx(() => {
    const red = getRedemption(ctx, id);
    if (red.terminal_id !== actor.terminalId) throw forbidden('Request belongs to another terminal');
    if (red.status !== 'pending') return red;
    ctx.db.run(
      `UPDATE redemptions SET prev_nonce = challenge_nonce, challenge_nonce = ?, nonce_at = datetime('now')
        WHERE id = ? AND nonce_at <= datetime('now', ?)`,
      newNonce(), id, `-${ctx.config.challengeRotateSeconds} seconds`,
    );
    return getRedemption(ctx, id);
  });
}

/** Exactly one of `gallons` (pump preset) or `amount` (currency, e.g. "2,000 gourdes") is given. */
export interface Quantity {
  gallons?: number;
  amount?: number;
}

function parseQuantity(q: Quantity): { mgal: number | null; minor: number | null } {
  const hasG = q.gallons !== undefined && q.gallons !== null;
  const hasA = q.amount !== undefined && q.amount !== null;
  if (hasG === hasA) throw badRequest('bad_quantity', 'Give either gallons or an amount');
  const mgal = hasG ? toMgal(q.gallons!) : null;
  const minor = hasA ? toMinor(q.amount!) : null;
  if ((mgal ?? 1) <= 0 || (minor ?? 1) <= 0) throw badRequest('bad_quantity', 'Quantity must be positive');
  return { mgal, minor };
}

/** Step 1 · Attendant creates a one-time request for a grade and pump, in gallons or in currency. */
export function createRequest(ctx: Ctx, actor: Actor, input: { grade: string; pump: number } & Quantity) {
  const { terminal, station } = attendantContext(ctx, actor);
  if (!GRADES.includes(input.grade as any)) throw badRequest('bad_grade', 'Only diesel and gasoline are sold');
  const { mgal, minor } = parseQuantity(input);
  if (!Number.isInteger(input.pump) || input.pump < 1) throw badRequest('bad_pump', 'Pump number required');
  return ctx.db.tx(() => {
    const shift = currentShift(ctx, actor);
    if (!shift || shift.attendant_id !== actor.userId) throw conflict('no_shift', 'Open your shift first');
    const id = ctx.db.run(
      `INSERT INTO redemptions (code, station_id, terminal_id, shift_id, attendant_id, pump, grade, requested_mgal, requested_minor, challenge_nonce, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, datetime('now', ?))`,
      newCode(), station.id, terminal.id, shift.id, actor.userId, input.pump, input.grade, mgal, minor, newNonce(),
      `+${ctx.config.redemptionTtlSeconds} seconds`,
    ).id;
    ctx.db.audit(actor.userId, 'redemption.request', 'redemption', id, input);
    return getRedemption(ctx, id);
  });
}

/** Prices a request at the employee's company contract price. Gallons are for reference only. */
function priceRequest(ctx: Ctx, companyId: number, red: any) {
  const contract = ctx.db.get('SELECT * FROM contracts WHERE company_id = ? AND grade = ? AND active = 1', companyId, red.grade);
  if (!contract) throw conflict('no_contract', `Your company has no ${red.grade} price yet`);
  const price = contract.price_minor;
  const amount = red.requested_minor ?? valueOf(red.requested_mgal, price);
  const gallons = red.requested_mgal ?? gallonsFor(red.requested_minor, price);
  return { price, currency: contract.currency as string, amount, gallons };
}

/** Proof that the challenge in the token is the one on screen now (or the one just before it). */
function challengeIsFresh(ctx: Ctx, red: any, nonce: string) {
  const row = ctx.db.get(
    `SELECT challenge_nonce = ? AS cur,
            prev_nonce = ? AND nonce_at > datetime('now', ?) AS prev
       FROM redemptions WHERE id = ?`,
    nonce, nonce, `-${ctx.config.challengeRotateSeconds} seconds`, red.id,
  );
  return Boolean(row.cur || row.prev);
}

export const counterUsed = (ctx: Ctx, deviceKeyId: number, counter: number) =>
  !!ctx.db.get('SELECT 1 FROM used_counters WHERE device_key_id = ? AND counter = ?', deviceKeyId, counter);

/** Marks an approval-code counter as used (each counter is accepted once, in any order). */
export function consumeCounter(ctx: Ctx, deviceKeyId: number, counter: number, code: string) {
  ctx.db.run('INSERT INTO used_counters (device_key_id, counter, redemption_code) VALUES (?,?,?)', deviceKeyId, counter, code);
  ctx.db.run('UPDATE employee_devices SET last_counter = MAX(last_counter, ?) WHERE id = ?', counter, deviceKeyId);
}

export function recordPinFailure(ctx: Ctx, emp: any, actorId: number) {
  const failures = emp.pin_failures + 1;
  const lock = failures >= ctx.config.maxPinFailures;
  ctx.db.run(
    "UPDATE employees SET pin_failures = ?, pin_locked_until = CASE WHEN ? THEN datetime('now', '+1 day') ELSE pin_locked_until END WHERE id = ?",
    failures, lock ? 1 : 0, emp.id,
  );
  ctx.db.audit(actorId, 'pin.failed', 'employee', emp.id, { failures });
  return new AppError(401, 'bad_pin', lock ? 'Wallet locked after too many wrong PINs' : `Wrong PIN (${ctx.config.maxPinFailures - failures} tries left). Ask the employee to try again.`);
}

/**
 * Step 2 · The terminal scans the approval code shown on the employee's phone (which may be offline)
 * and submits it. Everything the phone signed is checked here; only then is the amount reserved
 * and the price locked.
 */
export function authorizeRequest(ctx: Ctx, actor: Actor, id: number, rawToken: string) {
  attendantContext(ctx, actor);
  const token = decodeResponse(rawToken);
  const message = tokenMessage(token);

  const red = getRedemption(ctx, id);
  if (red.terminal_id !== actor.terminalId) throw forbidden('Request belongs to another terminal');
  if (red.status !== 'pending') throw conflict('not_pending', `This request is ${red.status}`);
  if (token.c !== red.code) throw conflict('wrong_request', 'This approval was made for a different request');
  if (!challengeIsFresh(ctx, red, token.n)) {
    throw conflict('stale_challenge', 'Approval code is too old. Ask the employee to scan the QR again.');
  }

  const device = ctx.db.get(
    "SELECT * FROM employee_devices WHERE id = ? AND employee_id = ? AND status = 'active'", token.k, token.e,
  );
  if (!device || !verifySignature(JSON.parse(device.public_key_jwk), message, token.s)) {
    ctx.db.audit(actor.userId, 'redemption.bad_signature', 'redemption', red.id, { employee: token.e, key: token.k });
    throw conflict('bad_signature', 'Approval code is not from this employee’s registered phone');
  }
  if (counterUsed(ctx, device.id, token.t)) {
    ctx.db.audit(actor.userId, 'redemption.replay', 'redemption', red.id, { device: device.id, counter: token.t });
    throw conflict('replayed', 'This approval code was already used');
  }

  const emp = ctx.db.get('SELECT * FROM employees WHERE id = ?', token.e);
  const company = ctx.db.get('SELECT * FROM companies WHERE id = ?', emp.company_id);
  if (emp.status !== 'active') throw conflict('frozen', 'This fuel wallet is frozen');
  if (company.status !== 'active') throw conflict('frozen', 'This company’s program is frozen');
  if (emp.pin_locked_until && emp.pin_locked_until > nowIso()) {
    throw new AppError(423, 'pin_locked', 'Wallet locked after too many wrong PINs. The company admin must do assisted recovery.');
  }

  // The counter is consumed even when the PIN is wrong, so a failed code can't be retried.
  consumeCounter(ctx, device.id, token.t, red.code);
  if (!verifyPinProof(device.pin_key, message, token.h) || !verifyOfflineProof(device.pin_key, message, token.o)) {
    throw recordPinFailure(ctx, emp, actor.userId);
  }

  return ctx.db.tx(() => {
    ctx.db.run('UPDATE employees SET pin_failures = 0 WHERE id = ?', emp.id);
    const station = ctx.db.get('SELECT status FROM stations WHERE id = ?', red.station_id);
    const terminal = ctx.db.get('SELECT status FROM terminals WHERE id = ?', red.terminal_id);
    if (station.status !== 'active' || terminal.status !== 'active') throw conflict('frozen', 'Station is not accepting redemptions');

    const priced = priceRequest(ctx, emp.company_id, red);
    if (priced.amount > token.m) {
      throw conflict('price_changed', 'The price changed since the phone last synced. Connect the phone once and try again.');
    }
    const picks = ctx.ledger.pickFifo(acct.available(emp.id), priced.amount);
    const lines: Line[] = picks.flatMap((p) => [
      { account: acct.available(emp.id), unit: p.currency, lotId: p.lotId, debit: p.amount },
      { account: acct.reserved(emp.id), unit: p.currency, lotId: p.lotId, credit: p.amount },
    ]);
    const entryId = ctx.ledger.post({
      kind: 'redemption_reserved', refType: 'redemption', refId: red.id, companyId: emp.company_id,
      memo: `${red.station_name} pump ${red.pump} · ${red.grade} ≈ ${(priced.gallons / 1000).toFixed(2)} gal`,
      createdBy: emp.user_id, lines,
    });
    // Single use: the conditional update guarantees only one approval wins.
    const upd = ctx.db.run(
      `UPDATE redemptions SET status = 'approved', employee_id = ?, company_id = ?, device_key_id = ?, reserve_entry_id = ?,
              approved_at = ?, price_minor = ?, currency = ?, approved_minor = ?, approved_mgal = ?
        WHERE id = ? AND status = 'pending'`,
      emp.id, emp.company_id, device.id, entryId, nowIso(), priced.price, priced.currency, priced.amount, priced.gallons, red.id,
    );
    if (upd.changes !== 1) throw conflict('not_pending', 'Request already used');
    ctx.db.audit(actor.userId, 'redemption.authorize', 'redemption', red.id, { employee: emp.id, device: device.id, counter: token.t, amount: priced.amount });
    return getRedemption(ctx, red.id);
  });
}

/**
 * Step 4 · Attendant confirms what was actually dispensed, from the pump display (gallons or amount).
 * Only now is the money charged; anything approved but not dispensed goes back to the employee.
 */
export function completeRequest(ctx: Ctx, actor: Actor, id: number, dispensed: Quantity) {
  attendantContext(ctx, actor);
  return ctx.db.tx(() => {
    const red = getRedemption(ctx, id);
    if (red.terminal_id !== actor.terminalId) throw forbidden('Request belongs to another terminal');
    if (red.status !== 'approved') throw conflict('bad_state', `Request is ${red.status}`);
    const q = parseQuantity(dispensed);
    let charged = q.minor ?? valueOf(q.mgal!, red.price_minor);
    // A full fill of a gallon request charges exactly what was approved (no rounding drift).
    if (q.mgal !== null && q.mgal === red.approved_mgal) charged = red.approved_minor;
    const mgal = q.mgal ?? gallonsFor(charged, red.price_minor);
    if (charged > red.approved_minor) throw badRequest('over_dispense', 'Cannot dispense more than the employee approved');

    const reserved = ctx.db.all(
      'SELECT lot_id, credit AS amount, unit FROM journal_lines WHERE entry_id = ? AND account = ? ORDER BY id',
      red.reserve_entry_id, acct.reserved(red.employee_id),
    );
    const lines: Line[] = [];
    let toCharge = charged;
    for (const r of reserved) {
      const take = Math.min(toCharge, r.amount);
      const release = r.amount - take;
      toCharge -= take;
      if (take > 0) {
        lines.push(
          { account: acct.reserved(red.employee_id), unit: r.unit, lotId: r.lot_id, debit: take },
          { account: acct.clearing(red.station_id), unit: r.unit, lotId: r.lot_id, credit: take },
        );
      }
      if (release > 0) {
        lines.push(
          { account: acct.reserved(red.employee_id), unit: r.unit, lotId: r.lot_id, debit: release },
          { account: acct.available(red.employee_id), unit: r.unit, lotId: r.lot_id, credit: release },
        );
      }
    }
    const entryId = ctx.ledger.post({
      kind: 'fuel_confirmed', refType: 'redemption', refId: red.id, companyId: red.company_id,
      memo: `${red.station_name} pump ${red.pump} · ${(mgal / 1000).toFixed(2)} gal ${red.grade} @ ${(red.price_minor / 100).toFixed(2)}`,
      createdBy: actor.userId, lines,
    });
    ctx.db.run(
      "UPDATE redemptions SET status = 'completed', dispensed_mgal = ?, charged_minor = ?, confirm_entry_id = ?, completed_at = ? WHERE id = ?",
      mgal, charged, entryId, nowIso(), red.id,
    );
    ctx.db.audit(actor.userId, 'redemption.complete', 'redemption', red.id, { mgal, charged });
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
