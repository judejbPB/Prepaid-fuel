import { COMPANY, DISTRIBUTOR, hashSecret, randomToken, requireCompany, requireRole, sha256, verifySecret, type Actor, type Role } from '../auth.js';
import type { Ctx } from '../context.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { acct, type Line } from '../ledger.js';
import { PIN_KDF, validatePublicJwk } from '../offline.js';
import { GRADES, toMinor, today } from '../units.js';

// ---------------------------------------------------------------------------
// Organisation setup (distributor)

/** `approvalThreshold`: allocation batches above this amount (HTG) need a second approver. */
export function createCompany(ctx: Ctx, actor: Actor | null, input: { name: string; approvalThreshold?: number }) {
  if (actor) requireRole(actor, ['dist_admin']);
  const id = ctx.db.run(
    'INSERT INTO companies (name, approval_threshold_minor) VALUES (?,?)',
    input.name, toMinor(input.approvalThreshold ?? 500_000),
  ).id;
  ctx.db.audit(actor?.userId ?? null, 'company.create', 'company', id, input);
  return ctx.db.get('SELECT * FROM companies WHERE id = ?', id);
}

export function setContractPrice(
  ctx: Ctx, actor: Actor | null, input: { companyId: number; grade: string; priceMinor: number; currency?: string },
) {
  if (actor) requireRole(actor, ['dist_admin']);
  if (!GRADES.includes(input.grade as any)) throw badRequest('bad_grade', 'Only diesel and gasoline are sold');
  if (!Number.isInteger(input.priceMinor) || input.priceMinor <= 0) throw badRequest('bad_price', 'Price must be positive');
  return ctx.db.tx(() => {
    // Existing lots keep the price they were funded at; only new funding uses the new price.
    ctx.db.run('UPDATE contracts SET active = 0 WHERE company_id = ? AND grade = ? AND active = 1', input.companyId, input.grade);
    const id = ctx.db.run(
      'INSERT INTO contracts (company_id, grade, price_minor, currency) VALUES (?,?,?,?)',
      input.companyId, input.grade, input.priceMinor, input.currency ?? 'HTG',
    ).id;
    ctx.db.audit(actor?.userId ?? null, 'contract.set', 'contract', id, input);
    return ctx.db.get('SELECT * FROM contracts WHERE id = ?', id);
  });
}

export function createStation(ctx: Ctx, actor: Actor | null, input: { name: string; address?: string }) {
  if (actor) requireRole(actor, ['dist_admin']);
  const id = ctx.db.run('INSERT INTO stations (name, address) VALUES (?,?)', input.name, input.address ?? null).id;
  ctx.db.audit(actor?.userId ?? null, 'station.create', 'station', id, input);
  return ctx.db.get('SELECT * FROM stations WHERE id = ?', id);
}

/** Registers the station's single terminal and returns a one-time activation code for the device. */
export function createTerminal(ctx: Ctx, actor: Actor | null, input: { stationId: number; label: string }) {
  if (actor) requireRole(actor, ['dist_admin']);
  return ctx.db.tx(() => {
    ctx.db.run("UPDATE terminals SET status = 'retired', device_key_hash = NULL WHERE station_id = ? AND status != 'retired'", input.stationId);
    const code = randomToken(6).toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 8);
    const id = ctx.db.run(
      'INSERT INTO terminals (station_id, label, activation_code) VALUES (?,?,?)',
      input.stationId, input.label, code,
    ).id;
    ctx.db.audit(actor?.userId ?? null, 'terminal.create', 'terminal', id, input);
    return { ...ctx.db.get('SELECT id, station_id, label, status FROM terminals WHERE id = ?', id), activation_code: code };
  });
}

/** Binds a physical device to a terminal. The returned key is stored only on the device. */
export function activateTerminal(ctx: Ctx, activationCode: string) {
  return ctx.db.tx(() => {
    const t = ctx.db.get(
      "SELECT t.*, s.name AS station_name FROM terminals t JOIN stations s ON s.id = t.station_id WHERE activation_code = ? AND t.status != 'retired'",
      activationCode.trim().toUpperCase(),
    );
    if (!t) throw notFound('Activation code');
    const key = randomToken(32);
    ctx.db.run('UPDATE terminals SET device_key_hash = ?, activation_code = NULL WHERE id = ?', sha256(key), t.id);
    ctx.db.audit(null, 'terminal.activate', 'terminal', t.id);
    return { terminalKey: key, terminal: { id: t.id, label: t.label, station_id: t.station_id, station_name: t.station_name } };
  });
}

export function createUser(
  ctx: Ctx, actor: Actor | null,
  input: { name: string; login: string; password: string; role: Role; companyId?: number; stationId?: number },
) {
  if (actor) {
    if (DISTRIBUTOR.includes(actor.role)) requireRole(actor, ['dist_admin']);
    else if (actor.role === 'co_approver' && COMPANY.includes(input.role)) input.companyId = actor.companyId!;
    else throw forbidden();
  }
  if (input.role === 'employee') throw badRequest('use_employee', 'Create employees through the employee roster');
  if (COMPANY.includes(input.role) && !input.companyId) throw badRequest('company_required', 'Company required');
  if ((input.role === 'st_manager' || input.role === 'st_attendant') && !input.stationId) throw badRequest('station_required', 'Station required');
  const id = ctx.db.run(
    'INSERT INTO users (name, login, password_hash, role, company_id, station_id) VALUES (?,?,?,?,?,?)',
    input.name, input.login.toLowerCase(), hashSecret(input.password), input.role, input.companyId ?? null, input.stationId ?? null,
  ).id;
  ctx.db.audit(actor?.userId ?? null, 'user.create', 'user', id, { login: input.login, role: input.role });
  return ctx.db.get('SELECT id, name, login, role, company_id, station_id, status FROM users WHERE id = ?', id);
}

// ---------------------------------------------------------------------------
// Employee roster (corporate portal)

export function createEmployee(
  ctx: Ctx, actor: Actor | null,
  input: { companyId: number; name: string; dept?: string; phone: string; password: string },
) {
  if (actor) {
    requireRole(actor, [...COMPANY, 'dist_admin']);
    requireCompany(actor, input.companyId);
  }
  const phone = input.phone.replace(/[^\d+]/g, '');
  if (phone.length < 8) throw badRequest('bad_phone', 'Valid phone number required');
  return ctx.db.tx(() => {
    // Employees sign in with their phone number. If the phone already has a wallet login, the roster
    // entry is still created (without a login) so duplicate-phone checks can hold it for review.
    const login = phone;
    const userId = ctx.db.get('SELECT 1 FROM users WHERE login = ?', login)
      ? null
      : ctx.db.run(
          "INSERT INTO users (name, login, password_hash, role, company_id) VALUES (?,?,?, 'employee', ?)",
          input.name, login, hashSecret(input.password), input.companyId,
        ).id;
    const id = ctx.db.run(
      'INSERT INTO employees (user_id, company_id, name, dept, phone) VALUES (?,?,?,?,?)',
      userId, input.companyId, input.name, input.dept ?? null, phone,
    ).id;
    ctx.db.audit(actor?.userId ?? null, 'employee.create', 'employee', id, { name: input.name, phone });
    return ctx.db.get('SELECT * FROM employees WHERE id = ?', id);
  });
}

export function listEmployees(ctx: Ctx, actor: Actor, companyId: number) {
  requireCompany(actor, companyId);
  return ctx.db
    .all(
      `SELECT e.id, e.name, e.dept, e.phone, e.status, EXISTS (SELECT 1 FROM employee_devices d WHERE d.employee_id = e.id AND d.status = 'active') AS has_pin,
              e.pin_locked_until > datetime('now') AS pin_locked, e.bound_device_id IS NOT NULL AS device_bound,
              (SELECT COUNT(*) FROM employees e2 WHERE e2.company_id = e.company_id AND e2.phone = e.phone AND e2.status != 'inactive') > 1 AS duplicate_phone
         FROM employees e WHERE e.company_id = ? ORDER BY e.name`,
      companyId,
    )
    .map((e) => ({
      ...e,
      available_minor: ctx.ledger.balance(acct.available(e.id)),
      reserved_minor: ctx.ledger.balance(acct.reserved(e.id)),
    }));
}

/**
 * Enrolls the employee's phone as their wallet device (first use or after assisted recovery). Must be
 * done online, with the account password. The phone generates a non-extractable signing key and sends
 * only its public half, plus pinKey = PBKDF2(PIN) so the server can check PIN proofs in offline codes.
 */
export function enrollDevice(
  ctx: Ctx, actor: Actor, input: { password: string; publicKeyJwk: unknown; pinKey: string },
) {
  requireRole(actor, ['employee']);
  const user = ctx.db.get('SELECT password_hash FROM users WHERE id = ?', actor.userId);
  if (!verifySecret(input.password, user.password_hash)) throw forbidden('Password is incorrect');
  const jwk = validatePublicJwk(input.publicKeyJwk);
  const pinKey = Buffer.from(input.pinKey, 'base64');
  if (pinKey.length !== PIN_KDF.bytes) throw badRequest('bad_pin_key', 'Invalid PIN key');
  const emp = ctx.db.get('SELECT * FROM employees WHERE id = ?', actor.employeeId);
  if (!actor.deviceId || (emp.bound_device_id && emp.bound_device_id !== actor.deviceId)) {
    throw forbidden('Enroll from the phone this wallet is bound to');
  }
  return ctx.db.tx(() => {
    if (ctx.db.get("SELECT 1 FROM employee_devices WHERE employee_id = ? AND status = 'active'", emp.id)) {
      throw conflict('already_enrolled', 'A phone is already enrolled. Ask your company admin for assisted recovery.');
    }
    const id = ctx.db.run(
      'INSERT INTO employee_devices (employee_id, device_id, public_key_jwk, pin_key) VALUES (?,?,?,?)',
      emp.id, actor.deviceId, JSON.stringify(jwk), pinKey.toString('base64'),
    ).id;
    ctx.db.run('UPDATE employees SET pin_failures = 0, pin_locked_until = NULL WHERE id = ?', emp.id);
    ctx.db.audit(actor.userId, 'device.enroll', 'employee', emp.id, { deviceKeyId: id });
    return { deviceKeyId: id, employeeId: emp.id };
  });
}

/**
 * Assisted recovery for lost phones and forgotten PINs: revokes the enrolled phone key, optionally unbinds
 * the phone,
 * revokes the employee's sessions and optionally issues a temporary password.
 */
export function recoverEmployee(
  ctx: Ctx, actor: Actor, employeeId: number, input: { resetPin: boolean; resetDevice: boolean; tempPassword?: string },
) {
  requireRole(actor, ['co_approver', 'dist_admin']);
  const emp = ctx.db.get('SELECT * FROM employees WHERE id = ?', employeeId);
  if (!emp) throw notFound('Employee');
  requireCompany(actor, emp.company_id);
  return ctx.db.tx(() => {
    // A new PIN or a new phone both mean a new device key, so the enrolled key is revoked either way.
    if (input.resetPin || input.resetDevice) {
      ctx.db.run(
        "UPDATE employee_devices SET status = 'revoked', revoked_at = datetime('now') WHERE employee_id = ? AND status = 'active'", emp.id,
      );
      ctx.db.run('UPDATE employees SET pin_failures = 0, pin_locked_until = NULL WHERE id = ?', emp.id);
    }
    if (input.resetDevice) ctx.db.run('UPDATE employees SET bound_device_id = NULL WHERE id = ?', emp.id);
    if (emp.user_id) {
      ctx.db.run('DELETE FROM sessions WHERE user_id = ?', emp.user_id);
      if (input.tempPassword) ctx.db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashSecret(input.tempPassword), emp.user_id);
    }
    ctx.db.audit(actor.userId, 'employee.recover', 'employee', emp.id, { resetPin: input.resetPin, resetDevice: input.resetDevice });
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Freezes

const FREEZABLE = { company: 'companies', employee: 'employees', station: 'stations', terminal: 'terminals', lot: 'lots' } as const;
export type Freezable = keyof typeof FREEZABLE;

export function setFrozen(ctx: Ctx, actor: Actor, entity: Freezable, id: number, frozen: boolean, reason?: string) {
  const table = FREEZABLE[entity];
  if (!table) throw badRequest('bad_entity', 'Cannot freeze that');
  if (entity === 'employee' && (actor.role === 'co_approver')) {
    requireCompany(actor, ctx.db.get('SELECT company_id FROM employees WHERE id = ?', id)?.company_id ?? -1);
  } else {
    requireRole(actor, ['dist_admin', 'dist_approver']);
  }
  const row = ctx.db.get(`SELECT status FROM ${table} WHERE id = ?`, id);
  if (!row) throw notFound(entity);
  if (row.status === 'expired' || row.status === 'retired') throw conflict('bad_state', `${entity} is ${row.status}`);
  ctx.db.run(`UPDATE ${table} SET status = ? WHERE id = ?`, frozen ? 'frozen' : 'active', id);
  ctx.db.audit(actor.userId, frozen ? 'freeze' : 'unfreeze', entity, id, { reason });
  return ctx.db.get(`SELECT * FROM ${table} WHERE id = ?`, id);
}

// ---------------------------------------------------------------------------
// Expiration

/**
 * Expires lots past their date: the remaining unallocated and employee-available balance of the lot moves
 * to the company's expired account (breakage). Amounts reserved for an in-flight fueling are left alone.
 */
export function runExpirations(ctx: Ctx, actor: Actor, asOf = today()) {
  requireRole(actor, ['dist_approver', 'dist_admin']);
  const lots = ctx.db.all("SELECT * FROM lots WHERE status != 'expired' AND expires_on < ?", asOf);
  const results = [];
  for (const lot of lots) {
    const entryId = ctx.db.tx(() => {
      const holders = ctx.db.all(
        `SELECT account, SUM(credit - debit) AS bal FROM journal_lines
          WHERE lot_id = ? AND (account = ? OR account LIKE 'emp:%:available')
          GROUP BY account HAVING bal > 0`,
        lot.id, acct.unallocated(lot.company_id),
      );
      const total = holders.reduce((s, h) => s + Number(h.bal), 0);
      let id: number | null = null;
      if (total > 0) {
        const lines: Line[] = [
          ...holders.map((h) => ({ account: h.account, unit: lot.currency, lotId: lot.id, debit: Number(h.bal) })),
          { account: acct.expired(lot.company_id), unit: lot.currency, lotId: lot.id, credit: total },
        ];
        id = ctx.ledger.post({
          kind: 'expiration', refType: 'lot', refId: lot.id, companyId: lot.company_id,
          memo: `${lot.code} expired ${lot.expires_on}`, createdBy: actor.userId, lines,
        });
      }
      ctx.db.run("UPDATE lots SET status = 'expired' WHERE id = ?", lot.id);
      ctx.db.audit(actor.userId, 'lot.expire', 'lot', lot.id, { expiredMinor: total });
      return id;
    });
    results.push({ lot: lot.code, entryId });
  }
  return results;
}
