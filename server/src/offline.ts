import { createHmac, createPublicKey, timingSafeEqual, verify, type JsonWebKey } from 'node:crypto';
import { badRequest } from './errors.js';

/**
 * Two-way QR protocol that lets an employee approve a fueling with a phone that is offline.
 *
 * 1. The station terminal (online) shows a CHALLENGE QR for one request. Its nonce rotates every
 *    few seconds, so a screenshot of it goes stale almost immediately.
 * 2. The phone scans it, shows the amount, takes the PIN and displays a RESPONSE QR containing:
 *      - an ECDSA P-256 signature by a non-extractable key generated on that phone at enrollment,
 *      - a PIN proof: HMAC(PBKDF2(PIN), message). The phone never stores the PIN or its derivative;
 *        only the server can check it, so a stolen phone cannot try PINs offline,
 *      - a strictly increasing counter, so no response can ever be accepted twice.
 *    All of it is bound to the request code, the current challenge nonce and the maximum amount
 *    the employee saw on screen.
 * 3. The terminal scans the response and the server verifies everything before reserving funds.
 *
 * A screenshot of either QR is useless anywhere else or a minute later.
 */

export const CHALLENGE_PREFIX = 'BSL1C.';
export const RESPONSE_PREFIX = 'BSL1R.';

export interface Challenge {
  /** Request code */
  c: string;
  /** Current nonce */
  n: string;
  /** Station name, pump, grade */
  s: string;
  p: number;
  g: string;
  /** Requested amount (minor units) or quantity (milligallons); exactly one is set. */
  a: number | null;
  q: number | null;
}

export interface ResponseToken {
  c: string;
  n: string;
  /** Employee id, device key id, counter, maximum amount approved (minor units) */
  e: number;
  k: number;
  t: number;
  m: number;
  /** PIN proof (checked by the server), offline PIN proof (checked by an offline terminal) and signature, base64url */
  h: string;
  o: string;
  s: string;
}

const b64url = (buf: Buffer) => buf.toString('base64url');

export const encodeChallenge = (c: Challenge) => CHALLENGE_PREFIX + b64url(Buffer.from(JSON.stringify(c)));

/** The exact bytes the phone signs and MACs. */
export const tokenMessage = (t: Pick<ResponseToken, 'c' | 'n' | 'e' | 'k' | 't' | 'm'>) =>
  `BSL1|${t.c}|${t.n}|${t.e}|${t.k}|${t.t}|${t.m}`;

export function decodeResponse(raw: string): ResponseToken {
  const s = raw.trim();
  if (!s.startsWith(RESPONSE_PREFIX)) throw badRequest('bad_token', 'This is not an ALFA approval code');
  let t: any;
  try {
    t = JSON.parse(Buffer.from(s.slice(RESPONSE_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw badRequest('bad_token', 'Unreadable approval code');
  }
  const ints = ['e', 'k', 't', 'm'] as const;
  const strs = ['c', 'n', 'h', 'o', 's'] as const;
  if (!t || ints.some((f) => !Number.isSafeInteger(t[f]) || t[f] < 0) || strs.some((f) => typeof t[f] !== 'string' || t[f].length > 200)) {
    throw badRequest('bad_token', 'Malformed approval code');
  }
  return t as ResponseToken;
}

/** Accepts only an EC P-256 public key (no private component). */
export function validatePublicJwk(jwk: any): JsonWebKey {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string' || 'd' in jwk) {
    throw badRequest('bad_key', 'Device key must be an EC P-256 public key');
  }
  try {
    createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
  } catch {
    throw badRequest('bad_key', 'Invalid device public key');
  }
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}

export function verifySignature(jwk: JsonWebKey, message: string, sigB64url: string): boolean {
  try {
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    // WebCrypto produces raw r||s (IEEE P1363), not DER.
    return verify('sha256', Buffer.from(message), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sigB64url, 'base64url'));
  } catch {
    return false;
  }
}

/** PIN proof is the first 16 bytes of HMAC-SHA256(pinKey, message). */
export const PIN_PROOF_BYTES = 16;

export function pinProof(pinKey: Buffer, message: string): Buffer {
  return createHmac('sha256', pinKey).update(message).digest().subarray(0, PIN_PROOF_BYTES);
}

export function verifyPinProof(pinKeyB64: string, message: string, proofB64url: string): boolean {
  const expected = pinProof(Buffer.from(pinKeyB64, 'base64'), message);
  const got = Buffer.from(proofB64url, 'base64url');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** PBKDF2 parameters shared with the phone (web/src/offline.ts). */
export const PIN_KDF = { hash: 'SHA-256', iterations: 150_000, bytes: 32 } as const;

export function decodeChallenge(raw: string): Challenge {
  const s = raw.trim();
  if (!s.startsWith(CHALLENGE_PREFIX)) throw badRequest('bad_challenge', 'Not an ALFA station code');
  return JSON.parse(Buffer.from(s.slice(CHALLENGE_PREFIX.length), 'base64url').toString('utf8'));
}

export const encodeResponse = (t: ResponseToken) => RESPONSE_PREFIX + b64url(Buffer.from(JSON.stringify(t)));

/**
 * Offline terminals can't hold pinKey (it is the server's PIN check). Instead each terminal's offline
 * pack carries verifier = HMAC(pinKey, label), and the phone adds o = HMAC(verifier, message). On its own
 * the verifier can't produce a valid code: that also needs the phone's non-extractable signing key.
 */
const VERIFIER_LABEL = 'BSL1-offline-verifier';

export function offlineVerifier(pinKey: Buffer): Buffer {
  return createHmac('sha256', pinKey).update(VERIFIER_LABEL).digest();
}

export function offlineProof(verifier: Buffer, message: string): Buffer {
  return createHmac('sha256', verifier).update(message).digest().subarray(0, PIN_PROOF_BYTES);
}

export function verifyOfflineProof(pinKeyB64: string, message: string, proofB64url: string): boolean {
  const expected = offlineProof(offlineVerifier(Buffer.from(pinKeyB64, 'base64')), message);
  const got = Buffer.from(proofB64url, 'base64url');
  return got.length === expected.length && timingSafeEqual(got, expected);
}
