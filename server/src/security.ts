// Protections against guessing and against a stolen or forgotten browser session:
//   - throttles: too many failed sign-ins (per account and per network address) or terminal-activation tries
//     lock that key for a while, stored in the database so a restart does not reset them
//   - password rules for staff accounts
//   - security headers on every response (the reverse proxy adds HSTS in production)
import type { FastifyInstance } from 'fastify';
import type { Db } from './db.js';
import { AppError } from './errors.js';
import SECURITY_HEADERS from './security-headers.json' with { type: 'json' };

export interface ThrottleRule {
  /** Failures allowed inside the window before the key is locked. */
  max: number;
  windowMinutes: number;
  lockMinutes: number;
}

export const RULES = {
  /** One account: 5 wrong passwords in 15 minutes lock it for 15 minutes (the owner can retry after). */
  login: { max: 5, windowMinutes: 15, lockMinutes: 15 },
  /** One network address trying many accounts. A whole office can share one address, so this is looser. */
  loginIp: { max: 30, windowMinutes: 15, lockMinutes: 15 },
  /** Guessing terminal activation codes. */
  activateIp: { max: 10, windowMinutes: 15, lockMinutes: 30 },
} satisfies Record<string, ThrottleRule>;

const minutesFrom = (iso: string) => Math.max(1, Math.ceil((Date.parse(iso.replace(' ', 'T') + 'Z') - Date.now()) / 60_000));

/** Throws 429 when any of these keys is locked. */
export function assertNotLocked(db: Db, keys: string[]) {
  for (const key of keys) {
    const row = db.get<{ locked_until: string | null }>(
      "SELECT locked_until FROM auth_throttle WHERE key = ? AND locked_until > datetime('now')", key);
    if (row?.locked_until) {
      throw new AppError(429, 'too_many_attempts', `Too many failed attempts. Try again in ${minutesFrom(row.locked_until)} minute(s).`);
    }
  }
}

/** Counts a failure; returns true when this failure locked the key. */
export function recordFailure(db: Db, key: string, rule: ThrottleRule): boolean {
  const row = db.get<{ failures: number; first_at: string }>(
    "SELECT failures, first_at FROM auth_throttle WHERE key = ? AND first_at > datetime('now', ?)", key, `-${rule.windowMinutes} minutes`);
  const failures = (row?.failures ?? 0) + 1;
  const lock = failures >= rule.max;
  db.run(
    `INSERT INTO auth_throttle (key, failures, first_at, locked_until) VALUES (?, ?, COALESCE(?, datetime('now')), CASE WHEN ? THEN datetime('now', ?) END)
     ON CONFLICT (key) DO UPDATE SET failures = excluded.failures, first_at = excluded.first_at, locked_until = excluded.locked_until`,
    key, lock ? 0 : failures, row?.first_at ?? null, lock ? 1 : 0, `+${rule.lockMinutes} minutes`,
  );
  return lock;
}

export function clearFailures(db: Db, key: string) {
  db.run('DELETE FROM auth_throttle WHERE key = ?', key);
}

/** Drops expired sessions and throttle rows that no longer matter (run hourly). */
export function purgeExpired(db: Db) {
  db.run("DELETE FROM sessions WHERE expires_at <= datetime('now')");
  db.run("DELETE FROM auth_throttle WHERE (locked_until IS NULL OR locked_until <= datetime('now')) AND first_at <= datetime('now', '-1 day')");
}

// A short list of passwords people actually use; the full check is length plus not being the login.
const COMMON = new Set(['password', 'password1', 'motdepasse', 'azertyuiop', 'qwertyuiop', '1234567890', '0123456789',
  'bonjour123', 'bandari123', 'alfa123456', 'bousol123', 'haiti12345', 'changeme123', 'admin12345', 'welcome123', 'demo123456']);

/** Why a new staff password is not acceptable, or null when it is. Messages are translated in i18n.ts. */
export function passwordProblem(password: string, login?: string): string | null {
  const p = password.trim();
  if (p.length < 10) return 'Use at least 10 characters';
  if (p.length > 200) return 'Use at most 200 characters';
  if (/^(.)\1+$/.test(p) || COMMON.has(p.toLowerCase())) return 'This password is too easy to guess';
  if (login && p.toLowerCase().includes(login.toLowerCase().split('@')[0]) && login.split('@')[0].length >= 3) return 'Do not use your login in your password';
  return null;
}

export function securityHeaders(app: FastifyInstance) {
  app.addHook('onSend', async (req, reply) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!name.startsWith('_')) reply.header(name, value);
    // Balances, statements and personal data must not stay in shared caches or the browser's back-forward cache.
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });
}
