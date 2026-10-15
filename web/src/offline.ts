/**
 * Offline approval on the employee's phone. Mirrors server/src/offline.ts.
 *
 * At enrollment (online, once) the phone creates an ECDSA P-256 key pair with a NON-EXTRACTABLE private
 * key, kept in IndexedDB, and sends the server the public key plus pinKey = PBKDF2(PIN, salt). The phone
 * keeps only the salt, never the PIN or pinKey, so a stolen phone can't check PIN guesses offline.
 *
 * At the pump (no connection needed) the phone scans the terminal's challenge, the employee enters the
 * PIN, and the phone shows an approval code bound to that request, that challenge, the amount shown and
 * a counter that never repeats.
 */

import { t } from './i18n';

export const CHALLENGE_PREFIX = 'BSL1C.';
export const RESPONSE_PREFIX = 'BSL1R.';
const PIN_KDF = { hash: 'SHA-256', iterations: 150_000, bits: 256 };
export const OFFLINE_VERIFIER_LABEL = 'BSL1-offline-verifier';

export interface Challenge {
  c: string;
  n: string;
  s: string;
  p: number;
  g: string;
  a: number | null;
  q: number | null;
}

interface KeyRecord {
  employeeId: number;
  keyId: number;
  privateKey: CryptoKey;
  salt: Uint8Array<ArrayBuffer>;
  counter: number;
}

// ------------------------------------------------------------------ encoding

const enc = new TextEncoder();
export const toB64url = (bytes: ArrayBuffer | Uint8Array) => {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const toB64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
export const fromB64url = (s: string) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
};

export function decodeChallenge(raw: string): Challenge {
  const s = raw.trim();
  if (!s.startsWith(CHALLENGE_PREFIX)) throw new Error(t('This is not a BOUSOL station code'));
  return JSON.parse(new TextDecoder().decode(fromB64url(s.slice(CHALLENGE_PREFIX.length))));
}

export const tokenMessage = (t: { c: string; n: string; e: number; k: number; t: number; m: number }) =>
  `BSL1|${t.c}|${t.n}|${t.e}|${t.k}|${t.t}|${t.m}`;

// ------------------------------------------------------------------ key storage (IndexedDB)

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('bousol-wallet', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('keys', { keyPath: 'employeeId' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('keys', mode);
    const req = fn(tx.objectStore('keys'));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}

const getRecord = (employeeId: number) => withStore<KeyRecord | undefined>('readonly', (s) => s.get(employeeId));
const putRecord = (rec: KeyRecord) => withStore('readwrite', (s) => s.put(rec));
export const forgetKey = (employeeId: number) => withStore('readwrite', (s) => s.delete(employeeId));

export async function localKeyId(employeeId: number): Promise<number | null> {
  try {
    return (await getRecord(employeeId))?.keyId ?? null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ crypto

async function derivePinKey(pin: string, salt: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PIN_KDF.iterations, hash: PIN_KDF.hash }, base, PIN_KDF.bits);
}

export function cryptoAvailable() {
  return typeof crypto !== 'undefined' && !!crypto.subtle && typeof indexedDB !== 'undefined';
}

/** Creates the device key. Returns the body for /api/wallet/enroll and a function to persist the key once the server accepts it. */
export async function prepareEnrollment(pin: string) {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const pinKey = toB64(await derivePinKey(pin, salt));
  return {
    body: { publicKeyJwk: { kty: publicKeyJwk.kty, crv: publicKeyJwk.crv, x: publicKeyJwk.x, y: publicKeyJwk.y }, pinKey },
    save: (employeeId: number, keyId: number) => putRecord({ employeeId, keyId, privateKey: pair.privateKey, salt, counter: 0 }),
  };
}

/** Amount the phone will approve at most: the requested amount, or the gallons at the synced contract price. */
export function maxAmount(ch: Challenge, prices: { grade: string; price_minor: number }[]): number | null {
  if (ch.a != null) return ch.a;
  const p = prices.find((x) => x.grade === ch.g);
  return p ? Math.round((ch.q! * p.price_minor) / 1000) : null;
}

/** Produces the approval code shown as a QR. Works with no network. */
export async function approveChallenge(employeeId: number, challenge: Challenge, max: number, pin: string): Promise<string> {
  const rec = await getRecord(employeeId);
  if (!rec) throw new Error(t('This phone is not enrolled'));
  // Persist the counter before signing so a code can never be produced twice with the same counter.
  rec.counter += 1;
  await putRecord(rec);
  const base = { c: challenge.c, n: challenge.n, e: employeeId, k: rec.keyId, t: rec.counter, m: max };
  const message = enc.encode(tokenMessage(base));
  const pinKey = await derivePinKey(pin, rec.salt);
  const hmacKey = await crypto.subtle.importKey('raw', pinKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const proof = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, message)).slice(0, 16);
  // Second PIN proof that an offline station terminal can check with its verifier (see server/src/offline.ts).
  const verifier = await crypto.subtle.sign('HMAC', hmacKey, enc.encode(OFFLINE_VERIFIER_LABEL));
  const offlineKey = await crypto.subtle.importKey('raw', verifier, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const offlineProof = new Uint8Array(await crypto.subtle.sign('HMAC', offlineKey, message)).slice(0, 16);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, rec.privateKey, message);
  return RESPONSE_PREFIX + toB64url(enc.encode(JSON.stringify({ ...base, h: toB64url(proof), o: toB64url(offlineProof), s: toB64url(sig) })));
}

// ------------------------------------------------------------------ cached wallet + pending approvals

const store = {
  get: <T,>(k: string): T | null => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } },
  set: (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
};

export interface PendingApproval { code: string; max: number; at: string; station: string; grade: string }

export const walletCache = {
  load: (userKey: string) => store.get<any>(`bousol.wallet.${userKey}`),
  save: (userKey: string, w: any) => store.set(`bousol.wallet.${userKey}`, w),
};

export const pendingApprovals = {
  list: (employeeId: number) => store.get<PendingApproval[]>(`bousol.pending.${employeeId}`) ?? [],
  add: (employeeId: number, p: PendingApproval) =>
    store.set(`bousol.pending.${employeeId}`, [...pendingApprovals.list(employeeId).filter((x) => x.code !== p.code), p]),
  /**
   * Called after a successful sync. Drops approvals the server already shows, and any older than ten
   * minutes: a terminal can no longer submit those (requests expire), so the synced balance is final.
   */
  reconcile: (employeeId: number, history: { code: string }[]) => {
    const known = new Set(history.map((h) => h.code));
    const cutoff = Date.now() - 10 * 60_000;
    store.set(`bousol.pending.${employeeId}`, pendingApprovals.list(employeeId).filter((p) => !known.has(p.code) && Date.parse(p.at) > cutoff));
  },
};
