import { randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { actorFor, type Actor } from '../src/auth.js';
import { createCtx, type Ctx } from '../src/context.js';
import { acct } from '../src/ledger.js';
import { encodeChallenge } from '../src/offline.js';
import { SimulatedPhone } from '../src/phone-sim.js';
import * as admin from '../src/services/admin.js';
import * as alloc from '../src/services/allocation.js';
import * as exc from '../src/services/exceptions.js';
import * as funding from '../src/services/funding.js';
import * as red from '../src/services/redemption.js';
import { offlinePack, syncOfflineSales, type OfflineSale } from '../src/services/station-offline.js';

const PIN = '2468';
const HTG = (n: number) => Math.round(n * 100);
const PRICE = HTG(500); // diesel, per gallon

function setup() {
  const ctx = createCtx(':memory:');
  const as = (u: { id: number }, extra: Partial<Actor> = {}): Actor => ({ ...actorFor(ctx.db, u.id, null, null), ...extra });
  const mk = (name: string, role: any, extra = {}) =>
    admin.createUser(ctx, null, { name, login: name.toLowerCase().replace(/\W/g, '') + '@t', password: 'password1', role, ...extra });

  const company = admin.createCompany(ctx, null, { name: 'Acme', approvalThreshold: 1_000_000 });
  admin.setContractPrice(ctx, null, { companyId: company.id, grade: 'diesel', priceMinor: PRICE });
  const treasury = as(mk('Treasury', 'dist_treasury'));
  const approver = as(mk('Approver', 'dist_approver'));
  const approver2 = as(mk('Approver Two', 'dist_approver'));
  const preparer = as(mk('Prep', 'co_preparer', { companyId: company.id }));
  const coApprover = as(mk('CoApp', 'co_approver', { companyId: company.id }));

  const terminals = [1, 2].map((n) => {
    const station = admin.createStation(ctx, null, { name: `Station ${n}` });
    const terminal = admin.createTerminal(ctx, null, { stationId: station.id, label: `T-${n}` });
    const attendant = as(mk(`Att ${n}`, 'st_attendant', { stationId: station.id }), { terminalId: terminal.id });
    const shift = red.openShift(ctx, attendant);
    return { station, terminal, attendant, shift };
  });

  const emp = admin.createEmployee(ctx, null, { companyId: company.id, name: 'Jean', phone: '50930000001', password: 'password1' });
  const employee = as({ id: emp.user_id }, { deviceId: 'phone-1' });
  const phone = new SimulatedPhone();
  phone.enroll(ctx, employee, 'password1', PIN);

  const fund = (htg: number) => {
    const f = funding.createFunding(ctx, preparer, { companyId: company.id, amountMinor: HTG(htg) });
    funding.matchFunding(ctx, treasury, f.id, { bankReference: `BANK-${f.id}`, bankAmountMinor: f.amount_minor });
    funding.approveFunding(ctx, approver, f.id);
  };
  const allocate = (htg: number) => {
    const b = alloc.createBatch(ctx, preparer, { companyId: company.id, title: 'benefit', lines: [{ employeeId: emp.id, amount: htg }] });
    alloc.submitBatch(ctx, preparer, b.id);
  };

  /** What an offline terminal queues after a full offline sale (its own challenge, the phone's answer). */
  const offlineSale = (t: (typeof terminals)[number], htg: number, opts: { pin?: string; counter?: number; tamper?: Partial<OfflineSale> } = {}): OfflineSale => {
    const code = `OF${t.terminal.id}-${randomBytes(4).toString('hex').toUpperCase()}`;
    const nonce = randomBytes(9).toString('base64url');
    const challenge = encodeChallenge({ c: code, n: nonce, s: t.station.name, p: 1, g: 'diesel', a: HTG(htg), q: null });
    const token = phone.approve(challenge, opts.pin ?? PIN, () => PRICE, { counter: opts.counter });
    const now = new Date().toISOString();
    return {
      clientId: randomUUID(), code, nonce, shiftId: t.shift.id, grade: 'diesel', pump: 1,
      requestedMinor: HTG(htg), requestedMgal: null, priceMinor: PRICE, currency: 'HTG',
      approvedMinor: HTG(htg), approvedMgal: Math.floor((HTG(htg) * 1000) / PRICE),
      dispensedMgal: Math.floor((HTG(htg) * 1000) / PRICE), chargedMinor: HTG(htg),
      token, approvedAt: now, completedAt: now, ...opts.tamper,
    };
  };
  return { ctx, company, terminals, emp, employee, phone, approver, approver2, coApprover, fund, allocate, offlineSale };
}

let t: ReturnType<typeof setup>;
let ctx: Ctx;
beforeEach(() => {
  t = setup();
  ctx = t.ctx;
  t.fund(100_000);
  t.allocate(10_000);
});
const bal = (a: string) => ctx.ledger.balance(a);

describe('offline pack', () => {
  it('carries what a terminal needs to verify approvals offline, and nothing secret beyond the verifier', () => {
    const pack = offlinePack(ctx, t.terminals[0].attendant);
    const me = pack.employees.find((e) => e.employee_id === t.emp.id)!;
    expect(me).toMatchObject({ name: 'Jean', company_name: 'Acme', key_id: t.phone.keyId, available_minor: HTG(10_000) });
    expect(me.public_key_jwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(me.public_key_jwk).not.toHaveProperty('d');
    expect(me).not.toHaveProperty('pin_key');
    expect(pack.prices[t.company.id].diesel.price_minor).toBe(PRICE);
    expect(pack.limits.per_employee_minor).toBe(500_000);
  });

  it('leaves out frozen wallets and is only for registered terminals', () => {
    admin.setFrozen(ctx, t.approver, 'employee', t.emp.id, true);
    expect(offlinePack(ctx, t.terminals[0].attendant).employees).toHaveLength(0);
    expect(() => offlinePack(ctx, { ...t.terminals[0].attendant, terminalId: null })).toThrow(/registered station terminal/);
  });
});

describe('offline sync', () => {
  it('posts an offline sale once, even if the batch is sent again', () => {
    const sale = t.offlineSale(t.terminals[0], 2000);
    const [r] = syncOfflineSales(ctx, t.terminals[0].attendant, [sale]).results;
    expect(r).toMatchObject({ status: 'posted', shortfallMinor: 0, coveredByCompanyMinor: 0 });
    expect(bal(acct.available(t.emp.id))).toBe(HTG(8000));
    expect(bal(acct.clearing(t.terminals[0].station.id))).toBe(HTG(2000));
    expect(red.getRedemption(ctx, (r as any).redemptionId)).toMatchObject({ status: 'completed', offline: 1, employee_name: 'Jean', charged_minor: HTG(2000) });

    const again = syncOfflineSales(ctx, t.terminals[0].attendant, [sale]).results[0];
    expect(again.status).toBe('duplicate');
    expect(bal(acct.available(t.emp.id))).toBe(HTG(8000));
    expect(ctx.ledger.checkBalanceRule().ok).toBe(true);
  });

  it('accepts sales synced out of order from two terminals', () => {
    const later = t.offlineSale(t.terminals[1], 1000, { counter: 2 });
    const earlier = t.offlineSale(t.terminals[0], 1000, { counter: 1 });
    expect(syncOfflineSales(ctx, t.terminals[1].attendant, [later]).results[0].status).toBe('posted');
    expect(syncOfflineSales(ctx, t.terminals[0].attendant, [earlier]).results[0].status).toBe('posted');
    expect(bal(acct.available(t.emp.id))).toBe(HTG(8000));
  });

  it('rejects a replayed approval code submitted as a different sale', () => {
    const sale = t.offlineSale(t.terminals[0], 1000);
    syncOfflineSales(ctx, t.terminals[0].attendant, [sale]);
    const replay = { ...sale, clientId: randomUUID() };
    const [r] = syncOfflineSales(ctx, t.terminals[0].attendant, [replay]).results;
    expect(r).toMatchObject({ status: 'rejected', reason: 'approval code already used' });
    expect(bal(acct.available(t.emp.id))).toBe(HTG(9000));
  });

  it('covers a double-spend from the company pool, then flags what is still uncovered', () => {
    // 10,000 HTG balance spent twice offline at two terminals (8,000 each).
    const a = t.offlineSale(t.terminals[0], 8000);
    const b = t.offlineSale(t.terminals[1], 8000);
    syncOfflineSales(ctx, t.terminals[0].attendant, [a]);
    const [r] = syncOfflineSales(ctx, t.terminals[1].attendant, [b]).results;
    expect(r).toMatchObject({ status: 'posted', coveredByCompanyMinor: HTG(6000), shortfallMinor: 0 });
    expect(bal(acct.unallocated(t.company.id))).toBe(HTG(84_000));

    // Drain the company pool, then overspend again: the shortfall becomes an exception.
    ctx.db.run("UPDATE lots SET status = 'frozen'"); // nothing spendable left anywhere
    const c = t.offlineSale(t.terminals[0], 500);
    const [r2] = syncOfflineSales(ctx, t.terminals[0].attendant, [c]).results;
    expect(r2).toMatchObject({ status: 'posted', shortfallMinor: HTG(500) });
    const [ex] = exc.listExceptions(ctx, t.approver, 'open');
    expect(ex).toMatchObject({ kind: 'offline_shortfall' });
    expect(ctx.ledger.checkBalanceRule().ok).toBe(true);
  });

  it('rejects a wrong PIN at sync, counts it against the wallet and opens an exception', () => {
    const [r] = syncOfflineSales(ctx, t.terminals[0].attendant, [t.offlineSale(t.terminals[0], 1000, { pin: '0000' })]).results;
    expect(r).toMatchObject({ status: 'rejected', reason: 'wrong PIN' });
    expect(ctx.db.get('SELECT pin_failures FROM employees WHERE id = ?', t.emp.id).pin_failures).toBe(1);
    const [ex] = exc.listExceptions(ctx, t.approver, 'open');
    expect(ex.kind).toBe('offline_rejected');
    exc.propose(ctx, t.approver, ex.id, { action: 'acknowledge', note: 'Recovered from company by invoice' });
    expect(exc.decide(ctx, t.approver2, ex.id, true).status).toBe('resolved');
  });

  it('rejects tampered amounts', () => {
    const sale = t.offlineSale(t.terminals[0], 1000);
    const [r] = syncOfflineSales(ctx, t.terminals[0].attendant, [{ ...sale, approvedMinor: HTG(5000), chargedMinor: HTG(5000) }]).results;
    expect(r).toMatchObject({ status: 'rejected', reason: 'amount exceeds what the employee approved' });
  });

  it('honours phone revocation by time: before the sale rejects, after the sale posts', () => {
    const sale = t.offlineSale(t.terminals[0], 1000);
    admin.recoverEmployee(ctx, t.coApprover, t.emp.id, { resetPin: true, resetDevice: false });
    // Revoked after the sale was made offline: still valid.
    expect(syncOfflineSales(ctx, t.terminals[0].attendant, [sale]).results[0].status).toBe('posted');
    // A sale stamped after the revocation is refused.
    const late = { ...t.offlineSale(t.terminals[0], 1000), approvedAt: new Date(Date.now() + 60_000).toISOString() };
    expect(syncOfflineSales(ctx, t.terminals[0].attendant, [late]).results[0]).toMatchObject({ status: 'rejected', reason: 'phone key was revoked before the sale' });
  });

  it('only accepts sales for shifts on the submitting terminal, and counts them in the shift close', () => {
    const foreign = t.offlineSale(t.terminals[1], 1000);
    expect(syncOfflineSales(ctx, t.terminals[0].attendant, [foreign]).results[0]).toMatchObject({ status: 'rejected', reason: 'unknown shift for this terminal' });
    syncOfflineSales(ctx, t.terminals[0].attendant, [t.offlineSale(t.terminals[0], 2000)]);
    const closed = red.closeShift(ctx, t.terminals[0].attendant, { pumpTotals: { diesel: 4 }, posTotals: { diesel: 2000 } });
    expect(closed).toMatchObject({ status: 'closed', variance_minor: 0 });
  });
});
