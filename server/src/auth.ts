import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.js';
import { AppError, badRequest, forbidden } from './errors.js';
import { assertNotLocked, clearFailures, passwordProblem, recordFailure, RULES } from './security.js';

export type Role =
  | 'dist_admin' | 'dist_treasury' | 'dist_approver'
  | 'co_preparer' | 'co_approver'
  | 'st_manager' | 'st_attendant'
  | 'employee';

export interface Actor {
  userId: number;
  name: string;
  role: Role;
  companyId: number | null;
  stationId: number | null;
  employeeId: number | null;
  terminalId: number | null;
  deviceId: string | null;
}

export const DISTRIBUTOR: Role[] = ['dist_admin', 'dist_treasury', 'dist_approver'];
export const COMPANY: Role[] = ['co_preparer', 'co_approver'];
export const STATION: Role[] = ['st_manager', 'st_attendant'];

export function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(secret, salt, 32);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

export function verifySecret(secret: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [saltHex, keyHex] = stored.split(':');
  const key = scryptSync(secret, Buffer.from(saltHex, 'hex'), 32);
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 24) => randomBytes(bytes).toString('base64url');

export function requireRole(actor: Actor, roles: Role[]) {
  if (!roles.includes(actor.role)) throw forbidden(`Requires role: ${roles.join(' or ')}`);
}

export function requireCompany(actor: Actor, companyId: number) {
  if (DISTRIBUTOR.includes(actor.role)) return;
  if (actor.companyId !== companyId) throw forbidden('Other company data is not accessible');
}

export function resolveTerminal(db: Db, terminalKey: string | undefined) {
  if (!terminalKey) return undefined;
  return db.get("SELECT * FROM terminals WHERE device_key_hash = ? AND status != 'retired'", sha256(terminalKey));
}

const SESSION_HOURS = 12;
/** Back-office sessions (distributor, company, station manager) end after this long without use. */
export const IDLE_MINUTES = 60;
const BACK_OFFICE: Role[] = [...DISTRIBUTOR, ...COMPANY, 'st_manager'];

// Compared against when the login does not exist, so an unknown login takes as long as a wrong password.
let dummyHash: string | null = null;

export function login(
  db: Db,
  input: { login: string; password: string; deviceId?: string; terminalKey?: string; ip?: string },
) {
  const name = input.login.trim().toLowerCase();
  const accountKey = `login:${name}`;
  const ipKey = `ip:${input.ip ?? 'unknown'}`;
  assertNotLocked(db, [accountKey, ipKey]);
  const user = db.get("SELECT * FROM users WHERE login = ? AND status = 'active'", name);
  const ok = user ? verifySecret(input.password, user.password_hash) : (verifySecret(input.password, dummyHash ??= hashSecret('x')), false);
  if (!ok) {
    const locked = recordFailure(db, accountKey, RULES.login);
    recordFailure(db, ipKey, RULES.loginIp);
    db.audit(null, locked ? 'login.locked' : 'login.failed', 'user', user?.id ?? null, { login: name, ip: input.ip ?? null });
    throw new AppError(401, 'bad_credentials', 'Invalid login or password');
  }
  clearFailures(db, accountKey);

  let terminalId: number | null = null;
  if (user.role === 'st_attendant') {
    // Attendants can only work from their station's registered terminal.
    const terminal = resolveTerminal(db, input.terminalKey);
    if (!terminal) {
      throw new AppError(403, 'terminal_unknown', 'This device is not a registered terminal. Activate it with your station’s code, then sign in.');
    }
    if (terminal.station_id !== user.station_id) {
      const station = db.get('SELECT name FROM stations WHERE id = ?', terminal.station_id)?.name ?? 'another station';
      throw new AppError(403, 'terminal_wrong_station', `This terminal belongs to ${station}. Sign in with an attendant account for ${station}, or activate this device for your own station.`);
    }
    if (terminal.status !== 'active') throw new AppError(403, 'terminal_frozen', 'This terminal is frozen');
    terminalId = terminal.id;
  }

  if (user.role === 'employee') {
    // Device binding: an employee wallet lives on one phone until assisted recovery resets it.
    const emp = db.get('SELECT * FROM employees WHERE user_id = ?', user.id);
    if (!emp) throw forbidden('No employee profile');
    if (!input.deviceId) throw new AppError(400, 'device_required', 'Device id required');
    if (emp.bound_device_id && emp.bound_device_id !== input.deviceId) {
      throw new AppError(403, 'device_mismatch', 'This account is bound to another phone. Ask your company admin for recovery.');
    }
    if (!emp.bound_device_id) db.run('UPDATE employees SET bound_device_id = ? WHERE id = ?', input.deviceId, emp.id);
  }

  const token = randomToken();
  db.run(
    "INSERT INTO sessions (token_hash, user_id, device_id, terminal_id, expires_at, last_seen) VALUES (?,?,?,?, datetime('now', ?), datetime('now'))",
    sha256(token), user.id, input.deviceId ?? null, terminalId, `+${SESSION_HOURS} hours`,
  );
  db.audit(user.id, 'login', 'user', user.id, { terminalId, ip: input.ip ?? null });
  return { token, actor: actorFor(db, user.id, terminalId, input.deviceId ?? null) };
}

export function actorFor(db: Db, userId: number, terminalId: number | null, deviceId: string | null): Actor {
  const u = db.get('SELECT * FROM users WHERE id = ?', userId);
  const emp = u.role === 'employee' ? db.get('SELECT id, company_id FROM employees WHERE user_id = ?', userId) : undefined;
  return {
    userId: u.id,
    name: u.name,
    role: u.role,
    companyId: emp?.company_id ?? u.company_id ?? null,
    stationId: u.station_id ?? null,
    employeeId: emp?.id ?? null,
    terminalId,
    deviceId,
  };
}

export function authenticate(db: Db, token: string | undefined): Actor {
  if (!token) throw new AppError(401, 'unauthenticated', 'Sign in required');
  const hash = sha256(token);
  const s = db.get(
    `SELECT s.*, u.status, u.role, s.last_seen < datetime('now', ?) AS idle, s.last_seen < datetime('now', '-5 minutes') AS stale
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > datetime('now')`,
    `-${IDLE_MINUTES} minutes`, hash,
  );
  if (!s || s.status !== 'active') throw new AppError(401, 'unauthenticated', 'Session expired');
  // A back-office screen left open: sign out after an hour without use. Terminals and wallets are exempt
  // (a shift runs all day; the wallet works offline and asks for the PIN at every payment).
  if (BACK_OFFICE.includes(s.role) && s.idle) {
    db.run('DELETE FROM sessions WHERE token_hash = ?', hash);
    throw new AppError(401, 'unauthenticated', 'Signed out after an hour without activity. Sign in again.');
  }
  // Recorded at most every 5 minutes, to keep reads from writing on every request.
  if (s.stale || !s.last_seen) db.run("UPDATE sessions SET last_seen = datetime('now') WHERE token_hash = ?", hash);
  return actorFor(db, s.user_id, s.terminal_id, s.device_id);
}

export function logout(db: Db, token: string) {
  db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

/**
 * The signed-in user changes their own password: the current one is required (and counts towards the sign-in
 * lock), the new one must meet the rules, and every other session of the account is signed out.
 */
export function changePassword(db: Db, actor: Actor, token: string, current: string, next: string) {
  const user = db.get('SELECT id, login, password_hash FROM users WHERE id = ?', actor.userId);
  const accountKey = `login:${user.login}`;
  assertNotLocked(db, [accountKey]);
  if (!verifySecret(current, user.password_hash)) {
    const locked = recordFailure(db, accountKey, RULES.login);
    db.audit(actor.userId, locked ? 'login.locked' : 'password.change_failed', 'user', actor.userId);
    throw forbidden('Your current password is incorrect');
  }
  // Employees keep the shorter rule they were created with; staff accounts get the full rules.
  const problem = actor.role === 'employee' ? (next.trim().length < 8 ? 'Use at least 8 characters' : null) : passwordProblem(next, user.login);
  if (problem) throw badRequest('weak_password', problem);
  if (verifySecret(next, user.password_hash)) throw badRequest('weak_password', 'Choose a password different from the current one');
  db.tx(() => {
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashSecret(next.trim()), actor.userId);
    const others = db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', actor.userId, sha256(token)).changes;
    db.audit(actor.userId, 'password.change', 'user', actor.userId, { other_sessions_ended: others });
  });
  clearFailures(db, accountKey);
  return { ok: true };
}
