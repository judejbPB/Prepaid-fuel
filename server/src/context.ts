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
  /** Seconds an attendant's QR request stays valid. */
  redemptionTtlSeconds: number;
  /** Pump meter variance (absolute mgal) tolerated before the shift is held for review. */
  varianceToleranceMgal: number;
  /** POS vs charged variance (absolute minor units) tolerated before the shift is held. */
  varianceToleranceMinor: number;
  /** Failed PIN attempts before the wallet locks. */
  maxPinFailures: number;
}

export const defaultConfig: Config = {
  lotValidityMonths: 9,
  redemptionTtlSeconds: 300,
  varianceToleranceMgal: 2000,
  varianceToleranceMinor: 150000,
  maxPinFailures: 5,
};

export function createCtx(path = ':memory:', config: Partial<Config> = {}): Ctx {
  const db = new Db(path);
  return { db, ledger: new Ledger(db), config: { ...defaultConfig, ...config } };
}
