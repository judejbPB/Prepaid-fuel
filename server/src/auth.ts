import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.js';
import { AppError, forbidden } from './errors.js';

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

export function login(
  db: Db,
  input: { login: string; password: string; deviceId?: string; terminalKey?: string },
) {
  const user = db.get("SELECT * FROM users WHERE login = ? AND status = 'active'", input.login.trim().toLowerCase());
  if (!user || !verifySecret(input.password, user.password_hash)) {
    throw new AppError(401, 'bad_credentials', 'Invalid login or password');
  }

  let terminalId: number | null = null;
  if (user.role === 'st_attendant') {
    // Attendants can only work from their station's registered terminal.
    const terminal = resolveTerminal(db, input.terminalKey);
    if (!terminal || terminal.station_id !== user.station_id) {
      throw new AppError(403, 'terminal_required', 'Sign in from your station’s registered terminal');
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
    "INSERT INTO sessions (token_hash, user_id, device_id, terminal_id, expires_at) VALUES (?,?,?,?, datetime('now', ?))",
    sha256(token), user.id, input.deviceId ?? null, terminalId, `+${SESSION_HOURS} hours`,
  );
  db.audit(user.id, 'login', 'user', user.id, { terminalId });
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
  const s = db.get(
    `SELECT s.*, u.status FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > datetime('now')`,
    sha256(token),
  );
  if (!s || s.status !== 'active') throw new AppError(401, 'unauthenticated', 'Session expired');
  return actorFor(db, s.user_id, s.terminal_id, s.device_id);
}

export function logout(db: Db, token: string) {
  db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}
