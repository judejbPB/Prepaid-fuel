import { Db } from './db.js';
import { Ledger } from './ledger.js';

export interface Ctx {
  db: Db;
  ledger: Ledger;
  config: Config;
}

export interface Config {
  /** Months a fuel lot stays redeemable after activation. */
  lotValidityMonths: number;
  /** Seconds an attendant's request stays open for approval. */
  redemptionTtlSeconds: number;
  /** Seconds between challenge QR rotations; the previous challenge stays valid one more period. */
  challengeRotateSeconds: number;
  /** Pump meter variance (absolute mgal) tolerated before the shift is held for review. */
  varianceToleranceMgal: number;
  /** POS vs charged variance (absolute minor units) tolerated before the shift is held. */
  varianceToleranceMinor: number;
  /** Offline terminals: max an employee can spend per terminal between syncs (minor units). */
  offlinePerEmployeeMinor: number;
  /** Offline terminals: max total a terminal can approve between syncs (minor units). */
  offlineTerminalMinor: number;
  /** Hours an offline pack stays usable after it was downloaded. */
  offlinePackHours: number;
  /** Failed PIN attempts before the wallet locks. */
  maxPinFailures: number;
}

export const defaultConfig: Config = {
  lotValidityMonths: 9,
  redemptionTtlSeconds: 180,
  challengeRotateSeconds: 30,
  varianceToleranceMgal: 2000,
  varianceToleranceMinor: 150000,
  maxPinFailures: 5,
  offlinePerEmployeeMinor: 500_000,
  offlineTerminalMinor: 10_000_000,
  offlinePackHours: 24,
};

export function createCtx(path = ':memory:', config: Partial<Config> = {}): Ctx {
  const db = new Db(path);
  return { db, ledger: new Ledger(db), config: { ...defaultConfig, ...config } };
}
