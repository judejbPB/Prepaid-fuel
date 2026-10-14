import { generateKeyPairSync, pbkdf2Sync, randomBytes, sign, type KeyObject } from 'node:crypto';
import type { Actor } from './auth.js';
import type { Ctx } from './context.js';
import { decodeChallenge, encodeResponse, pinProof, PIN_KDF, tokenMessage } from './offline.js';
import { enrollDevice } from './services/admin.js';
import { valueOf } from './units.js';

/**
 * Node implementation of the employee phone's offline approval (same algorithm as web/src/offline.ts).
 * Used by tests and demo seeding; production approvals are produced in the browser.
 */
export class SimulatedPhone {
  private privateKey: KeyObject;
  private publicJwk: object;
  private salt = randomBytes(16);
  private counter = 0;
  employeeId = 0;
  keyId = 0;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    this.publicJwk = publicKey.export({ format: 'jwk' });
  }

  private pinKey(pin: string) {
    return pbkdf2Sync(pin, this.salt, PIN_KDF.iterations, PIN_KDF.bytes, 'sha256');
  }

  /** Body for POST /api/wallet/enroll (minus the password). */
  enrollment(pin: string) {
    return { publicKeyJwk: this.publicJwk, pinKey: this.pinKey(pin).toString('base64') };
  }

  enrolled(out: { employeeId: number; deviceKeyId: number }) {
    this.employeeId = out.employeeId;
    this.keyId = out.deviceKeyId;
    return out;
  }

  enroll(ctx: Ctx, actor: Actor, password: string, pin: string) {
    return this.enrolled(enrollDevice(ctx, actor, { password, ...this.enrollment(pin) }));
  }

  /** Scans a station challenge and returns the approval code the phone would display. */
  approve(challenge: string, pin: string, priceMinor: (grade: string) => number, opts: { counter?: number } = {}) {
    const ch = decodeChallenge(challenge);
    const max = ch.a ?? valueOf(ch.q!, priceMinor(ch.g));
    const t = opts.counter ?? ++this.counter;
    const base = { c: ch.c, n: ch.n, e: this.employeeId, k: this.keyId, t, m: max };
    const message = tokenMessage(base);
    return encodeResponse({
      ...base,
      h: pinProof(this.pinKey(pin), message).toString('base64url'),
      s: sign('sha256', Buffer.from(message), { key: this.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'),
    });
  }
}
