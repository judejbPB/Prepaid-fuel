/**
 * Station terminal offline mode (see server/src/services/station-offline.ts for the server half).
 *
 * Online, the terminal keeps an OFFLINE PACK fresh: enrolled employees' phone public keys, PIN
 * verifiers, balance snapshots, contract prices and limits. Offline, it creates requests and rotating
 * challenges itself, verifies the phone's approval code locally, enforces the limits, and queues each
 * completed sale. The queue survives reloads and is synced as soon as the connection returns.
 */
import { cap } from './api';
import { t } from './i18n';
import { CHALLENGE_PREFIX, fromB64url, RESPONSE_PREFIX, toB64url, tokenMessage } from './offline';

export interface PackEmployee {
  employee_id: number;
  name: string;
  company_id: number;
  company_name: string;
  key_id: number;
  public_key_jwk: JsonWebKey;
  verifier: string;
  available_minor: number;
}

export interface OfflinePack {
  generated_at: string;
  valid_until: string;
  terminal_id: number;
  station_name: string;
  limits: { per_employee_minor: number; terminal_minor: number; max_pin_failures: number; challenge_rotate_seconds: number };
  employees: PackEmployee[];
  prices: Record<string, Record<string, { price_minor: number; currency: string }>>;
}

export interface OfflineSale {
  clientId: string; code: string; nonce: string; shiftId: number; grade: string; pump: number;
  requestedMinor: number | null; requestedMgal: number | null; priceMinor: number; currency: string;
  approvedMinor: number; approvedMgal: number; dispensedMgal: number; chargedMinor: number;
  token: string; approvedAt: string; completedAt: string;
}

/** A request handled entirely on the terminal; shaped like the server's redemption so the UI can share code. */
export interface LocalRequest {
  id: string;
  local: true;
  code: string;
  nonce: string;
  prev_nonce: string | null;
  nonce_at: string;
  challenge: string | null;
  status: 'pending' | 'approved' | 'completed' | 'cancelled' | 'expired';
  station_name: string;
  shift_id: number;
  pump: number;
  grade: string;
  requested_minor: number | null;
  requested_mgal: number | null;
  expires_at: string;
  employee_id?: number;
  employee_name?: string;
  company_name?: string;
  price_minor?: number;
  currency?: string;
  approved_minor?: number;
  approved_mgal?: number;
  dispensed_mgal?: number;
  charged_minor?: number;
  token?: string;
  approved_at?: string;
}

interface OfflineState {
  /** Amount approved offline per employee since the pack was downloaded. */
  spent: Record<string, number>;
  terminalTotal: number;
  pinFailures: Record<string, number>;
  /** Counters accepted per device key since the pack was downloaded (local replay guard). */
  used: Record<string, number[]>;
}

const KEYS = { pack: 'bousol.station.pack', queue: 'bousol.station.queue', state: 'bousol.station.offlineState', active: 'bousol.station.localRequest' };
const read = <T,>(k: string, fallback: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };
const emptyState = (): OfflineState => ({ spent: {}, terminalTotal: 0, pinFailures: {}, used: {} });

export const offlineStore = {
  pack: () => read<OfflinePack | null>(KEYS.pack, null),
  queue: () => read<OfflineSale[]>(KEYS.queue, []),
  state: () => read<OfflineState>(KEYS.state, emptyState()),
  activeRequest: () => read<LocalRequest | null>(KEYS.active, null),
  saveActive: (r: LocalRequest | null) => write(KEYS.active, r),
};

export const packUsable = (p: OfflinePack | null): p is OfflinePack => !!p && Date.parse(p.valid_until) > Date.now();

class OfflineError extends Error {}

const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
const newNonce = () => toB64url(crypto.getRandomValues(new Uint8Array(9)));
const encodeChallenge = (r: LocalRequest) =>
  CHALLENGE_PREFIX + toB64url(new TextEncoder().encode(JSON.stringify({
    c: r.code, n: r.nonce, s: r.station_name, p: r.pump, g: r.grade, a: r.requested_minor, q: r.requested_mgal,
  })));

// ------------------------------------------------------------------ requests

export function createLocalRequest(pack: OfflinePack, shiftId: number, input: { grade: string; pump: number; amount?: number; gallons?: number }): LocalRequest {
  if (!packUsable(pack)) throw new OfflineError(t('The offline pack has expired. Reconnect to refresh it.'));
  if (!['diesel', 'gasoline'].includes(input.grade)) throw new OfflineError(t('Only diesel and gasoline are sold'));
  const minor = input.amount != null ? Math.round(input.amount * 100) : null;
  const mgal = input.gallons != null ? Math.round(input.gallons * 1000) : null;
  if ((minor ?? mgal ?? 0) <= 0) throw new OfflineError(t('Quantity must be positive'));
  const r: LocalRequest = {
    id: `local-${randomHex(8)}`, local: true,
    code: `OF${pack.terminal_id}-${randomHex(4).toUpperCase()}`,
    nonce: newNonce(), prev_nonce: null, nonce_at: new Date().toISOString(), challenge: null,
    status: 'pending', station_name: pack.station_name, shift_id: shiftId, pump: input.pump, grade: input.grade,
    requested_minor: minor, requested_mgal: mgal,
    expires_at: new Date(Date.now() + 180_000).toISOString(),
  };
  r.challenge = encodeChallenge(r);
  offlineStore.saveActive(r);
  return r;
}

/** Rotates the challenge on the same schedule as the server, so a photo of the terminal QR goes stale. */
export function refreshLocalRequest(pack: OfflinePack, r: LocalRequest): LocalRequest {
  if (r.status !== 'pending') return r;
  if (Date.parse(r.expires_at) < Date.now()) return save({ ...r, status: 'expired', challenge: null });
  if (Date.now() - Date.parse(r.nonce_at) < pack.limits.challenge_rotate_seconds * 1000) return r;
  const next = { ...r, prev_nonce: r.nonce, nonce: newNonce(), nonce_at: new Date().toISOString() };
  return save({ ...next, challenge: encodeChallenge(next) });
}

const save = (r: LocalRequest) => { offlineStore.saveActive(r.status === 'completed' || r.status === 'cancelled' || r.status === 'expired' ? null : r); return r; };

async function verifySignature(jwk: JsonWebKey, message: Uint8Array, sig: Uint8Array) {
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig as BufferSource, message as BufferSource);
}

async function offlineProof(verifierB64: string, message: Uint8Array) {
  const raw = Uint8Array.from(atob(verifierB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, message as BufferSource)).slice(0, 16);
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Checks the phone's approval code with no connection: signature by the enrolled phone, PIN (offline
 * proof), the request and live challenge it answers, a never-used counter, the balance snapshot and the
 * offline limits. On success the amount is held against the limits until the sale is confirmed.
 */
export async function authorizeLocal(pack: OfflinePack, r: LocalRequest, raw: string): Promise<LocalRequest> {
  if (!packUsable(pack)) throw new OfflineError(t('The offline pack has expired. Reconnect to refresh it.'));
  if (r.status !== 'pending' || Date.parse(r.expires_at) < Date.now()) throw new OfflineError(t('This request is no longer open'));
  if (!raw.startsWith(RESPONSE_PREFIX)) throw new OfflineError(t('This is not an ALFA approval code'));
  let tok: any;
  try { tok = JSON.parse(new TextDecoder().decode(fromB64url(raw.slice(RESPONSE_PREFIX.length)))); } catch { throw new OfflineError(t('Unreadable approval code')); }
  if (tok.c !== r.code) throw new OfflineError(t('This approval was made for a different request'));
  const freshPrev = tok.n === r.prev_nonce && Date.now() - Date.parse(r.nonce_at) < pack.limits.challenge_rotate_seconds * 1000;
  if (tok.n !== r.nonce && !freshPrev) throw new OfflineError(t('Approval code is too old. Ask the employee to scan the QR again.'));

  const emp = pack.employees.find((e) => e.employee_id === tok.e && e.key_id === tok.k);
  if (!emp) throw new OfflineError(t('This phone is not in the offline pack (new or recovered wallet). It can be used once the terminal is online.'));
  const state = offlineStore.state();
  const failures = state.pinFailures[emp.employee_id] ?? 0;
  if (failures >= pack.limits.max_pin_failures) throw new OfflineError(t('Wallet locked after too many wrong PINs'));
  if ((state.used[emp.key_id] ?? []).includes(tok.t)) throw new OfflineError(t('This approval code was already used'));

  const message = new TextEncoder().encode(tokenMessage(tok));
  if (!(await verifySignature(emp.public_key_jwk, message, fromB64url(tok.s)))) {
    throw new OfflineError(t('Approval code is not from this employee’s registered phone'));
  }
  const used = { ...state.used, [emp.key_id]: [...(state.used[emp.key_id] ?? []), tok.t] };
  if (!sameBytes(await offlineProof(emp.verifier, message), fromB64url(tok.o ?? ''))) {
    write(KEYS.state, { ...state, used, pinFailures: { ...state.pinFailures, [emp.employee_id]: failures + 1 } });
    const left = pack.limits.max_pin_failures - failures - 1;
    throw new OfflineError(left > 0 ? t('Wrong PIN ({n} tries left). Ask the employee to try again.', { n: left }) : t('Wallet locked after too many wrong PINs'));
  }

  const price = pack.prices[emp.company_id]?.[r.grade];
  if (!price) throw new OfflineError(t('No {grade} price for {company}', { grade: cap(r.grade), company: emp.company_name }));
  const amount = r.requested_minor ?? Math.round((r.requested_mgal! * price.price_minor) / 1000);
  const gallons = r.requested_mgal ?? Math.floor((r.requested_minor! * 1000) / price.price_minor);
  if (amount > tok.m) throw new OfflineError(t('The price changed since the phone last synced. Connect the phone once and try again.'));
  const spent = state.spent[emp.employee_id] ?? 0;
  if (amount > emp.available_minor - spent) throw new OfflineError(t('Balance too low for this amount'));
  if (spent + amount > pack.limits.per_employee_minor) throw new OfflineError(t('Over the offline limit for this employee. Wait for the connection to return.'));
  if (state.terminalTotal + amount > pack.limits.terminal_minor) throw new OfflineError(t('This terminal reached its offline limit. Wait for the connection to return.'));

  write(KEYS.state, {
    spent: { ...state.spent, [emp.employee_id]: spent + amount },
    terminalTotal: state.terminalTotal + amount,
    pinFailures: { ...state.pinFailures, [emp.employee_id]: 0 },
    used,
  });
  return save({
    ...r, status: 'approved', challenge: null, employee_id: emp.employee_id, employee_name: emp.name, company_name: emp.company_name,
    price_minor: price.price_minor, currency: price.currency, approved_minor: amount, approved_mgal: gallons,
    token: raw, approved_at: new Date().toISOString(),
  });
}

function release(employeeId: number, amount: number) {
  const s = offlineStore.state();
  write(KEYS.state, {
    ...s,
    spent: { ...s.spent, [employeeId]: Math.max(0, (s.spent[employeeId] ?? 0) - amount) },
    terminalTotal: Math.max(0, s.terminalTotal - amount),
  });
}

/** Records what was dispensed and queues the sale for sync; any unused part is released. */
export function completeLocal(r: LocalRequest, q: { amount?: number; gallons?: number }): LocalRequest {
  if (r.status !== 'approved') throw new OfflineError(t('Request is not approved'));
  const price = r.price_minor!;
  let charged: number;
  let mgal: number;
  if (q.gallons != null) {
    mgal = Math.round(q.gallons * 1000);
    charged = mgal === r.approved_mgal ? r.approved_minor! : Math.round((mgal * price) / 1000);
  } else {
    charged = Math.round((q.amount ?? 0) * 100);
    mgal = Math.floor((charged * 1000) / price);
  }
  if (!(charged > 0)) throw new OfflineError(t('Use cancel if nothing was dispensed'));
  if (charged > r.approved_minor!) throw new OfflineError(t('Cannot dispense more than the employee approved'));
  release(r.employee_id!, r.approved_minor! - charged);
  const now = new Date().toISOString();
  const sale: OfflineSale = {
    clientId: crypto.randomUUID(), code: r.code, nonce: JSON.parse(new TextDecoder().decode(fromB64url(r.token!.slice(RESPONSE_PREFIX.length)))).n,
    shiftId: r.shift_id, grade: r.grade, pump: r.pump, requestedMinor: r.requested_minor, requestedMgal: r.requested_mgal,
    priceMinor: price, currency: r.currency!, approvedMinor: r.approved_minor!, approvedMgal: r.approved_mgal!,
    dispensedMgal: mgal, chargedMinor: charged, token: r.token!, approvedAt: r.approved_at!, completedAt: now,
  };
  write(KEYS.queue, [...offlineStore.queue(), sale]);
  return save({ ...r, status: 'completed', dispensed_mgal: mgal, charged_minor: charged });
}

export function cancelLocal(r: LocalRequest): LocalRequest {
  if (r.status === 'approved') release(r.employee_id!, r.approved_minor!);
  return save({ ...r, status: 'cancelled', challenge: null });
}

// ------------------------------------------------------------------ sync

export interface SyncSummary { posted: number; rejected: number; shortfallMinor: number; remaining: number }

/**
 * Sends queued sales, then downloads a fresh pack. Sales the server answered (posted, duplicate or
 * rejected) leave the queue; the local spending counters reset only once a new pack reflects them.
 */
export async function syncAndRefresh(
  post: (path: string, body: unknown) => Promise<any>,
  get: (path: string) => Promise<any>,
): Promise<SyncSummary> {
  const queue = offlineStore.queue();
  let posted = 0, rejected = 0, shortfallMinor = 0;
  if (queue.length) {
    const { results } = await post('/api/station/offline-sync', { sales: queue });
    const answered = new Set<string>();
    for (const r of results) {
      answered.add(r.clientId);
      if (r.status === 'posted') { posted++; shortfallMinor += r.shortfallMinor ?? 0; }
      if (r.status === 'rejected') rejected++;
    }
    write(KEYS.queue, offlineStore.queue().filter((s) => !answered.has(s.clientId)));
  }
  const remaining = offlineStore.queue().length;
  if (!remaining) {
    write(KEYS.pack, await get('/api/station/offline-pack'));
    // Keep holds for a request approved offline that is still being dispensed.
    const active = offlineStore.activeRequest();
    const fresh = emptyState();
    if (active?.status === 'approved') {
      fresh.spent[active.employee_id!] = active.approved_minor!;
      fresh.terminalTotal = active.approved_minor!;
    }
    write(KEYS.state, fresh);
  }
  return { posted, rejected, shortfallMinor, remaining };
}

export const isLocal = (r: any): r is LocalRequest => !!r && r.local === true;
