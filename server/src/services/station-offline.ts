import { requireRole, type Actor } from '../auth.js';
import type { Ctx } from '../context.js';
import { badRequest, forbidden } from '../errors.js';
import { acct, type Line } from '../ledger.js';
import {
  decodeResponse, offlineVerifier, tokenMessage, verifyOfflineProof, verifyPinProof, verifySignature,
} from '../offline.js';
import { GRADES } from '../units.js';
import { consumeCounter, counterUsed, recordPinFailure } from './redemption.js';

/**
 * Station offline mode.
 *
 * While online, a terminal downloads an OFFLINE PACK: for every employee with an enrolled phone, the
 * phone's public key, a PIN verifier (see offline.ts) and a balance snapshot, plus contract prices and
 * spending limits. While offline the terminal runs the same two-way QR exchange, verifies approval codes
 * locally against the pack, enforces the limits, and queues each completed sale. When the connection
 * returns it syncs the queue here, where everything is verified again and posted to the ledger.
 *
 * Double-spending (the same balance spent at two offline terminals) is bounded by the limits. At sync,
 * a sale the employee's balance no longer covers is taken from the company's unallocated funds
 * (companies stand behind their employees); anything still uncovered opens an exception.
 */

function terminalContext(ctx: Ctx, actor: Actor) {
  requireRole(actor, ['st_attendant']);
  if (!actor.terminalId) throw forbidden('Offline mode is only available on a registered station terminal');
  const terminal = ctx.db.get('SELECT * FROM terminals WHERE id = ?', actor.terminalId);
  const station = ctx.db.get('SELECT * FROM stations WHERE id = ?', terminal.station_id);
  return { terminal, station };
}

export function offlinePack(ctx: Ctx, actor: Actor) {
  const { terminal, station } = terminalContext(ctx, actor);
  if (terminal.status !== 'active' || station.status !== 'active') throw forbidden('This terminal or station is frozen');
  const rows = ctx.db.all(
    `SELECT e.id AS employee_id, e.name, e.company_id, c.name AS company_name, d.id AS key_id, d.public_key_jwk, d.pin_key
       FROM employees e
       JOIN employee_devices d ON d.employee_id = e.id AND d.status = 'active'
       JOIN companies c ON c.id = e.company_id
      WHERE e.status = 'active' AND c.status = 'active'
        AND (e.pin_locked_until IS NULL OR e.pin_locked_until <= datetime('now'))`,
  );
  const employees = rows.map((r) => ({
    employee_id: r.employee_id,
    name: r.name,
    company_id: r.company_id,
    company_name: r.company_name,
    key_id: r.key_id,
    public_key_jwk: JSON.parse(r.public_key_jwk),
    verifier: offlineVerifier(Buffer.from(r.pin_key, 'base64')).toString('base64'),
    available_minor: ctx.ledger.spendable(acct.available(r.employee_id)),
  }));
  const prices: Record<number, Record<string, { price_minor: number; currency: string }>> = {};
  for (const c of ctx.db.all('SELECT company_id, grade, price_minor, currency FROM contracts WHERE active = 1')) {
    (prices[c.company_id] ??= {})[c.grade] = { price_minor: c.price_minor, currency: c.currency };
  }
  const now = new Date();
  const validUntil = new Date(now.getTime() + ctx.config.offlinePackHours * 3_600_000);
  ctx.db.audit(actor.userId, 'offline.pack', 'terminal', terminal.id, { employees: employees.length });
  return {
    generated_at: now.toISOString(),
    valid_until: validUntil.toISOString(),
    terminal_id: terminal.id,
    station_id: station.id,
    station_name: station.name,
    limits: {
      per_employee_minor: ctx.config.offlinePerEmployeeMinor,
      terminal_minor: ctx.config.offlineTerminalMinor,
      max_pin_failures: ctx.config.maxPinFailures,
      challenge_rotate_seconds: ctx.config.challengeRotateSeconds,
    },
    employees,
    prices,
  };
}

export interface OfflineSale {
  clientId: string;
  code: string;
  nonce: string;
  shiftId: number;
  grade: string;
  pump: number;
  requestedMinor: number | null;
  requestedMgal: number | null;
  priceMinor: number;
  currency: string;
  approvedMinor: number;
  approvedMgal: number;
  dispensedMgal: number;
  chargedMinor: number;
  token: string;
  approvedAt: string;
  completedAt: string;
}

type SyncResult =
  | { clientId: string; status: 'posted'; redemptionId: number; shortfallMinor: number; coveredByCompanyMinor: number }
  | { clientId: string; status: 'duplicate'; redemptionId: number | null }
  | { clientId: string; status: 'rejected'; reason: string; exceptionId: number };

const sqlTime = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw badRequest('bad_time', 'Invalid timestamp in offline sale');
  return d.toISOString().replace('T', ' ').slice(0, 19);
};

function openException(ctx: Ctx, kind: string, sale: OfflineSale, stationId: number, companyId: number | null, summary: string, detail: object, actorId: number) {
  return ctx.db.run(
    `INSERT INTO exceptions (kind, ref_type, ref_id, company_id, station_id, summary, detail, created_by)
     VALUES (?, 'offline_sale', ?, ?, ?, ?, ?, ?)`,
    kind, sale.shiftId, companyId, stationId, summary, JSON.stringify({ ...detail, code: sale.code, clientId: sale.clientId }), actorId,
  ).id;
}

/** Verifies and posts sales an offline terminal approved. Safe to call again with the same batch. */
export function syncOfflineSales(ctx: Ctx, actor: Actor, sales: OfflineSale[]) {
  const { terminal, station } = terminalContext(ctx, actor);
  const results: SyncResult[] = [];
  for (const sale of sales) {
    const done = ctx.db.get('SELECT * FROM offline_sync_log WHERE client_id = ?', sale.clientId);
    if (done) {
      results.push(done.result === 'rejected'
        ? { clientId: sale.clientId, status: 'rejected', reason: done.detail, exceptionId: done.exception_id }
        : { clientId: sale.clientId, status: 'duplicate', redemptionId: done.redemption_id });
      continue;
    }
    results.push(syncOne(ctx, actor, terminal, station, sale));
  }
  ctx.db.audit(actor.userId, 'offline.sync', 'terminal', terminal.id, {
    sales: sales.length,
    posted: results.filter((r) => r.status === 'posted').length,
    rejected: results.filter((r) => r.status === 'rejected').length,
  });
  return { results };
}

function syncOne(ctx: Ctx, actor: Actor, terminal: any, station: any, sale: OfflineSale): SyncResult {
  const amountText = `${(sale.chargedMinor / 100).toFixed(2)} ${sale.currency}`;
  const reject = (reason: string, companyId: number | null, extra: object = {}) =>
    ctx.db.tx(() => {
      const exceptionId = openException(
        ctx, 'offline_rejected', sale, station.id, companyId,
        `${station.name}: offline sale of ${amountText} rejected at sync (${reason})`,
        { reason, chargedMinor: sale.chargedMinor, grade: sale.grade, pump: sale.pump, ...extra }, actor.userId,
      );
      ctx.db.run(
        "INSERT INTO offline_sync_log (client_id, terminal_id, result, exception_id, detail) VALUES (?,?, 'rejected', ?, ?)",
        sale.clientId, terminal.id, exceptionId, reason,
      );
      return { clientId: sale.clientId, status: 'rejected' as const, reason, exceptionId };
    });

  // Shape checks: these come from our own terminal code, so a failure means tampering or a bug.
  if (!GRADES.includes(sale.grade as any) || !(sale.chargedMinor > 0) || sale.chargedMinor > sale.approvedMinor || !(sale.priceMinor > 0)) {
    return reject('invalid sale data', null);
  }
  const shift = ctx.db.get('SELECT * FROM shifts WHERE id = ? AND terminal_id = ?', sale.shiftId, terminal.id);
  if (!shift) return reject('unknown shift for this terminal', null);

  let token;
  try { token = decodeResponse(sale.token); } catch { return reject('unreadable approval code', null); }
  const message = tokenMessage(token);
  if (token.c !== sale.code || token.n !== sale.nonce) return reject('approval code does not match the sale', null);
  if (sale.approvedMinor > token.m) return reject('amount exceeds what the employee approved', null);

  const device = ctx.db.get('SELECT * FROM employee_devices WHERE id = ? AND employee_id = ?', token.k, token.e);
  const emp = device ? ctx.db.get('SELECT * FROM employees WHERE id = ?', token.e) : null;
  if (!device || !emp || !verifySignature(JSON.parse(device.public_key_jwk), message, token.s)) {
    return reject('signature does not match a registered phone', emp?.company_id ?? null);
  }
  if (device.status === 'revoked' && device.revoked_at && device.revoked_at < sqlTime(sale.approvedAt)) {
    return reject('phone key was revoked before the sale', emp.company_id);
  }
  if (counterUsed(ctx, device.id, token.t)) return reject('approval code already used', emp.company_id);
  if (!verifyPinProof(device.pin_key, message, token.h) || !verifyOfflineProof(device.pin_key, message, token.o)) {
    consumeCounter(ctx, device.id, token.t, sale.code);
    recordPinFailure(ctx, emp, actor.userId);
    return reject('wrong PIN', emp.company_id, { employeeId: emp.id });
  }

  return ctx.db.tx(() => {
    consumeCounter(ctx, device.id, token.t, sale.code);
    // Funds: the employee's balance first, then the company's unallocated pool for any double-spend.
    const fromEmployee = ctx.ledger.pickUpTo(acct.available(emp.id), sale.chargedMinor);
    const fromCompany = ctx.ledger.pickUpTo(acct.unallocated(emp.company_id), fromEmployee.short);
    const shortfall = fromCompany.short;
    const lines: Line[] = [
      ...fromEmployee.picks.flatMap((p) => [
        { account: acct.available(emp.id), unit: p.currency, lotId: p.lotId, debit: p.amount },
        { account: acct.clearing(station.id), unit: p.currency, lotId: p.lotId, credit: p.amount },
      ]),
      ...fromCompany.picks.flatMap((p) => [
        { account: acct.unallocated(emp.company_id), unit: p.currency, lotId: p.lotId, debit: p.amount },
        { account: acct.clearing(station.id), unit: p.currency, lotId: p.lotId, credit: p.amount },
      ]),
    ];
    const entryId = lines.length
      ? ctx.ledger.post({
          kind: 'offline_sale', refType: 'redemption', companyId: emp.company_id, createdBy: actor.userId,
          memo: `${station.name} pump ${sale.pump} · offline ${sale.code} · ${(sale.dispensedMgal / 1000).toFixed(2)} gal ${sale.grade}`,
          lines,
        })
      : null;
    const redemptionId = ctx.db.run(
      `INSERT INTO redemptions (code, station_id, terminal_id, shift_id, attendant_id, pump, grade, requested_mgal, requested_minor,
                                challenge_nonce, nonce_at, status, employee_id, company_id, device_key_id, offline, client_id,
                                price_minor, currency, approved_minor, approved_mgal, dispensed_mgal, charged_minor,
                                confirm_entry_id, expires_at, created_at, approved_at, completed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, 'completed', ?,?,?, 1, ?, ?,?,?,?,?,?, ?, ?,?,?,?)`,
      sale.code, station.id, terminal.id, shift.id, shift.attendant_id, sale.pump, sale.grade, sale.requestedMgal, sale.requestedMinor,
      sale.nonce, sqlTime(sale.approvedAt), emp.id, emp.company_id, device.id, sale.clientId,
      sale.priceMinor, sale.currency, sale.approvedMinor, sale.approvedMgal, sale.dispensedMgal, sale.chargedMinor,
      entryId, sqlTime(sale.completedAt), sqlTime(sale.approvedAt), sqlTime(sale.approvedAt), sqlTime(sale.completedAt),
    ).id;
    let exceptionId: number | null = null;
    if (shortfall > 0) {
      exceptionId = openException(
        ctx, 'offline_shortfall', sale, station.id, emp.company_id,
        `${station.name}: offline sale to ${emp.name} not covered by ${(shortfall / 100).toFixed(2)} ${sale.currency}`,
        { shortfallMinor: shortfall, chargedMinor: sale.chargedMinor, employeeId: emp.id, redemptionId }, actor.userId,
      );
    }
    ctx.db.run(
      "INSERT INTO offline_sync_log (client_id, terminal_id, result, redemption_id, exception_id) VALUES (?,?, 'posted', ?, ?)",
      sale.clientId, terminal.id, redemptionId, exceptionId,
    );
    return {
      clientId: sale.clientId, status: 'posted' as const, redemptionId,
      shortfallMinor: shortfall, coveredByCompanyMinor: fromCompany.covered,
    };
  });
}
