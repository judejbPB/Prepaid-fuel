import { beforeEach, describe, expect, it } from 'vitest';
import { actorFor, hashSecret, type Actor } from '../src/auth.js';
import { createCtx, type Ctx } from '../src/context.js';
import { acct } from '../src/ledger.js';
import * as admin from '../src/services/admin.js';
import * as alloc from '../src/services/allocation.js';
import * as bank from '../src/services/bank.js';
import * as exc from '../src/services/exceptions.js';
import * as funding from '../src/services/funding.js';
import * as red from '../src/services/redemption.js';
import * as refunds from '../src/services/refunds.js';

const PIN = '4321';
const HTG = (n: number) => Math.round(n * 100);

function setup() {
  const ctx = createCtx(':memory:');
  const as = (u: { id: number }, extra: Partial<Actor> = {}): Actor => ({ ...actorFor(ctx.db, u.id, null, null), ...extra });
  const mk = (name: string, role: any, extra = {}) =>
    admin.createUser(ctx, null, { name, login: name.toLowerCase().replace(/\W/g, '') + '@t', password: 'password1', role, ...extra });

  const company = admin.createCompany(ctx, null, { name: 'Acme', approvalThreshold: 50_000 });
  admin.setContractPrice(ctx, null, { companyId: company.id, grade: 'diesel', priceMinor: HTG(500) });
  admin.setContractPrice(ctx, null, { companyId: company.id, grade: 'gasoline', priceMinor: HTG(400) });
  const station = admin.createStation(ctx, null, { name: 'Station X' });
  const terminal = admin.createTerminal(ctx, null, { stationId: station.id, label: 'T-X' });

  const treasury = as(mk('Treasury', 'dist_treasury'));
  const approver = as(mk('Approver', 'dist_approver'));
  const approver2 = as(mk('Approver Two', 'dist_approver'));
  const distAdmin = as(mk('Boss', 'dist_admin'));
  const preparer = as(mk('Prep', 'co_preparer', { companyId: company.id }));
  const coApprover = as(mk('CoApp', 'co_approver', { companyId: company.id }));
  const attendant = as(mk('Att', 'st_attendant', { stationId: station.id }), { terminalId: terminal.id });
  const manager = as(mk('Mgr', 'st_manager', { stationId: station.id }));

  const emp = admin.createEmployee(ctx, null, { companyId: company.id, name: 'Jean', phone: '50930000001', password: 'password1' });
  ctx.db.run('UPDATE employees SET pin_hash = ? WHERE id = ?', hashSecret(PIN), emp.id);
  const employee = as({ id: emp.user_id });

  const fundAndActivate = (htg: number) => {
    const f = funding.createFunding(ctx, preparer, { companyId: company.id, amountMinor: HTG(htg) });
    funding.matchFunding(ctx, treasury, f.id, { bankReference: `BANK-${f.id}`, bankAmountMinor: f.amount_minor });
    return funding.approveFunding(ctx, approver, f.id);
  };
  const allocate = (htg: number) => {
    const b = alloc.createBatch(ctx, preparer, { companyId: company.id, title: 'benefit', lines: [{ employeeId: emp.id, amount: htg }] });
    return alloc.submitBatch(ctx, preparer, b.id);
  };
  const fuel = (qty: red.Quantity, dispensed: red.Quantity = qty, grade = 'diesel') => {
    const r = red.createRequest(ctx, attendant, { grade, pump: 3, ...qty });
    red.approveRequest(ctx, employee, { code: red.qrPayload(r.code), pin: PIN });
    return red.completeRequest(ctx, attendant, r.id, dispensed);
  };
  return { ctx, company, station, terminal, treasury, approver, approver2, distAdmin, preparer, coApprover, attendant, manager, emp, employee, fundAndActivate, allocate, fuel };
}

let t: ReturnType<typeof setup>;
let ctx: Ctx;
beforeEach(() => {
  t = setup();
  ctx = t.ctx;
});

const bal = (account: string) => ctx.ledger.balance(account);

describe('ledger', () => {
  it('rejects entries that do not balance per lot', () => {
    t.fundAndActivate(1000);
    const lot = ctx.db.get('SELECT id FROM lots').id;
    expect(() =>
      ctx.ledger.post({ kind: 'x', createdBy: null, lines: [
        { account: 'a', unit: 'HTG', lotId: lot, debit: 10 }, { account: 'b', unit: 'HTG', lotId: lot, credit: 9 },
      ] }),
    ).toThrow(/unbalanced/);
  });

  it('is append-only', () => {
    t.fundAndActivate(1000);
    expect(() => ctx.db.run('UPDATE journal_lines SET debit = debit + 1')).toThrow(/append-only/);
    expect(() => ctx.db.run('DELETE FROM journal_entries')).toThrow(/append-only/);
  });

  it('never lets a holding account go negative', () => {
    t.fundAndActivate(10_000);
    expect(() => t.allocate(10_000.01)).toThrow(/Insufficient/);
    expect(bal(acct.unallocated(t.company.id))).toBe(HTG(10_000));
  });
});

describe('fund and activate', () => {
  it('requires a matched deposit and a second approver; funds are held in currency', () => {
    const f = funding.createFunding(ctx, t.preparer, { companyId: t.company.id, amountMinor: HTG(250_000) });
    expect(f.reference).toMatch(/^TR-\d+$/);
    expect(() => funding.approveFunding(ctx, t.approver, f.id)).toThrow(/matched first/);
    expect(() => funding.matchFunding(ctx, t.treasury, f.id, { bankReference: 'B1', bankAmountMinor: 999 })).toThrow(/does not equal/);
    funding.matchFunding(ctx, t.distAdmin, f.id, { bankReference: 'B1', bankAmountMinor: HTG(250_000) });
    expect(() => funding.approveFunding(ctx, t.distAdmin, f.id)).toThrow(/Maker-checker/);

    const done = funding.approveFunding(ctx, t.approver, f.id);
    expect(done.status).toBe('approved');
    expect(done.lot_code).toBeTruthy();
    expect(bal(acct.unallocated(t.company.id))).toBe(HTG(250_000));
    expect(-bal(acct.bankVerified)).toBe(HTG(250_000));
    expect(ctx.ledger.checkBalanceRule().ok).toBe(true);
  });

  it('refuses to reuse a bank reference', () => {
    const f1 = funding.createFunding(ctx, t.preparer, { companyId: t.company.id, amountMinor: HTG(5000) });
    const f2 = funding.createFunding(ctx, t.preparer, { companyId: t.company.id, amountMinor: HTG(5000) });
    funding.matchFunding(ctx, t.treasury, f1.id, { bankReference: 'SAME', bankAmountMinor: HTG(5000) });
    expect(() => funding.matchFunding(ctx, t.treasury, f2.id, { bankReference: 'SAME', bankAmountMinor: HTG(5000) })).toThrow(/already matched/);
  });
});

describe('allocate', () => {
  it('moves currency, never creates it', () => {
    t.fundAndActivate(100_000);
    t.allocate(40_000);
    expect(bal(acct.unallocated(t.company.id))).toBe(HTG(60_000));
    expect(bal(acct.available(t.emp.id))).toBe(HTG(40_000));
    expect(ctx.ledger.checkBalanceRule().ok).toBe(true);
  });

  it('spans lots FIFO by expiry', () => {
    t.fundAndActivate(30_000);
    t.fundAndActivate(30_000);
    t.allocate(45_000);
    const lots = ctx.ledger.lotBalances(acct.available(t.emp.id));
    expect(lots.map((l) => l.balance)).toEqual([HTG(30_000), HTG(15_000)]);
  });

  it('splits preparer and approver on large batches', () => {
    t.fundAndActivate(200_000);
    const b = t.allocate(60_000); // threshold is 50,000 HTG
    expect(b.status).toBe('pending_approval');
    expect(() => alloc.approveBatch(ctx, { ...t.preparer, role: 'co_approver' }, b.id)).toThrow(/Maker-checker/);
    expect(alloc.approveBatch(ctx, t.coApprover, b.id).status).toBe('posted');
    expect(bal(acct.available(t.emp.id))).toBe(HTG(60_000));
  });

  it('holds records that share a phone number', () => {
    t.fundAndActivate(100_000);
    const twin = admin.createEmployee(ctx, null, { companyId: t.company.id, name: 'Jean bis', phone: '50930000001', password: 'password1' });
    const b = alloc.createBatch(ctx, t.preparer, {
      companyId: t.company.id, title: 'x',
      lines: [{ employeeId: twin.id, amount: 1000 }, { employeeId: t.emp.id, amount: 1000 }],
    });
    expect(b.held_count).toBe(2);
    expect(() => alloc.submitBatch(ctx, t.preparer, b.id)).toThrow(/No lines are ready/);
  });

  it('pauses recurring benefits when the funded balance is low', () => {
    t.fundAndActivate(40_000);
    const b = t.allocate(30_000);
    alloc.makeRecurring(ctx, t.coApprover, b.id, 1);
    const next = new Date();
    next.setUTCMonth(next.getUTCMonth() + 1, 2);
    const out = alloc.runRecurring(ctx, null, next);
    expect(out[0].outcome).toBe('paused_low_balance');
    t.fundAndActivate(40_000);
    alloc.setRecurringStatus(ctx, t.coApprover, out[0].id, 'active');
    expect(alloc.runRecurring(ctx, null, next)[0].outcome).toBe('posted');
    expect(alloc.runRecurring(ctx, null, next)).toHaveLength(0); // once per month
    expect(bal(acct.available(t.emp.id))).toBe(HTG(60_000));
  });
});

describe('redeem', () => {
  beforeEach(() => {
    t.fundAndActivate(100_000);
    t.allocate(50_000);
    red.openShift(ctx, t.attendant);
  });

  it('prices a gallon request at the contract price and charges only after confirmation', () => {
    const r = red.createRequest(ctx, t.attendant, { grade: 'diesel', pump: 3, gallons: 12 });
    const preview = red.previewRequest(ctx, t.employee, red.qrPayload(r.code));
    expect(preview).toMatchObject({ station_name: 'Station X', pump: 3, grade: 'diesel', amount_minor: HTG(6000), gallons_mgal: 12_000, price_minor: HTG(500) });

    red.approveRequest(ctx, t.employee, { code: r.code, pin: PIN });
    expect(bal(acct.available(t.emp.id))).toBe(HTG(44_000));
    expect(bal(acct.reserved(t.emp.id))).toBe(HTG(6000));
    expect(bal(acct.clearing(t.station.id))).toBe(0);

    const done = red.completeRequest(ctx, t.attendant, r.id, { gallons: 11.5 }); // pump stopped early
    expect(done).toMatchObject({ charged_minor: HTG(5750), dispensed_mgal: 11_500 });
    expect(bal(acct.reserved(t.emp.id))).toBe(0);
    expect(bal(acct.clearing(t.station.id))).toBe(HTG(5750));
    expect(bal(acct.available(t.emp.id))).toBe(HTG(44_250));
    expect(ctx.ledger.checkBalanceRule().ok).toBe(true);
  });

  it('accepts a request by amount and records reference gallons', () => {
    const done = t.fuel({ amount: 2000 }, { amount: 2000 }, 'gasoline');
    expect(done).toMatchObject({ approved_minor: HTG(2000), charged_minor: HTG(2000), dispensed_mgal: 5000, price_minor: HTG(400) });
    expect(bal(acct.available(t.emp.id))).toBe(HTG(48_000));
  });

  it('locks the price at approval even if the contract changes before dispensing', () => {
    const r = red.createRequest(ctx, t.attendant, { grade: 'diesel', pump: 1, gallons: 10 });
    red.approveRequest(ctx, t.employee, { code: r.code, pin: PIN });
    admin.setContractPrice(ctx, null, { companyId: t.company.id, grade: 'diesel', priceMinor: HTG(600) });
    expect(red.completeRequest(ctx, t.attendant, r.id, { gallons: 10 }).charged_minor).toBe(HTG(5000));
  });

  it('only sells diesel and gasoline', () => {
    expect(() => red.createRequest(ctx, t.attendant, { grade: 'premium', pump: 1, gallons: 5 })).toThrow(/diesel and gasoline/);
    expect(() => red.createRequest(ctx, t.attendant, { grade: 'diesel', pump: 1, gallons: 5, amount: 100 })).toThrow(/either/);
  });

  it('QR codes are single use', () => {
    const r = red.createRequest(ctx, t.attendant, { grade: 'diesel', pump: 1, gallons: 5 });
    red.approveRequest(ctx, t.employee, { code: r.code, pin: PIN });
    expect(() => red.approveRequest(ctx, t.employee, { code: r.code, pin: PIN })).toThrow(/approved/);
  });

  it('expired requests cannot be approved', () => {
    const r = red.createRequest(ctx, t.attendant, { grade: 'diesel', pump: 1, gallons: 5 });
    ctx.db.run("UPDATE redemptions SET expires_at = datetime('now', '-1 minute') WHERE id = ?", r.id);
    expect(() => red.approveRequest(ctx, t.employee, { code: r.code, pin: PIN })).toThrow(/expired/);
  });

  it('locks the wallet after repeated wrong PINs', () => {
    const r = red.createRequest(ctx, t.attendant, { grade: 'diesel', pump: 1, gallons: 5 });
    for (let i = 0; i < 5; i++) expect(() => red.approveRequest(ctx, t.employee, { code: r.code, pin: '0000' })).toThrow(/PIN|locked/);
    expect(() => red.approveRequest(ctx, t.employee, { code: r.code, pin: PIN })).toThrow(/Too many wrong PINs/);
    admin.recoverEmployee(ctx, t.coApprover, t.emp.id, { resetPin: true, resetDevice: false });
    expect(ctx.db.get('SELECT pin_hash FROM employees WHERE id = ?', t.emp.id).pin_hash).toBeNull();
  });

  it('cancelling an approved request releases the reservation', () => {
    const r = red.createRequest(ctx, t.attendant, { grade: 'diesel', pump: 1, gallons: 30 });
    red.approveRequest(ctx, t.employee, { code: r.code, pin: PIN });
    red.cancelRequest(ctx, t.attendant, r.id);
    expect(bal(acct.available(t.emp.id))).toBe(HTG(50_000));
    expect(bal(acct.reserved(t.emp.id))).toBe(0);
  });

  it('cannot charge more than approved or spend beyond the balance', () => {
    const r = red.createRequest(ctx, t.attendant, { grade: 'diesel', pump: 1, gallons: 10 });
    red.approveRequest(ctx, t.employee, { code: r.code, pin: PIN });
    expect(() => red.completeRequest(ctx, t.attendant, r.id, { gallons: 10.5 })).toThrow(/more than/);
    expect(() => red.completeRequest(ctx, t.attendant, r.id, { amount: 5000.01 })).toThrow(/more than/);
    const big = red.createRequest(ctx, t.attendant, { grade: 'diesel', pump: 1, amount: 45_000.01 });
    expect(() => red.approveRequest(ctx, t.employee, { code: big.code, pin: PIN })).toThrow(/Insufficient/);
  });

  it('honours freezes', () => {
    admin.setFrozen(ctx, t.approver, 'employee', t.emp.id, true);
    const r = red.createRequest(ctx, t.attendant, { grade: 'diesel', pump: 1, gallons: 5 });
    expect(() => red.approveRequest(ctx, t.employee, { code: r.code, pin: PIN })).toThrow(/frozen/);
    admin.setFrozen(ctx, t.approver, 'employee', t.emp.id, false);
    admin.setFrozen(ctx, t.approver, 'terminal', t.terminal.id, true);
    expect(() => red.createRequest(ctx, t.attendant, { grade: 'diesel', pump: 1, gallons: 5 })).toThrow(/frozen/);
  });

  it('frozen lots are skipped', () => {
    admin.setFrozen(ctx, t.approver, 'lot', ctx.db.get('SELECT id FROM lots').id, true);
    const r = red.createRequest(ctx, t.attendant, { grade: 'diesel', pump: 1, gallons: 5 });
    expect(() => red.approveRequest(ctx, t.employee, { code: r.code, pin: PIN })).toThrow(/Insufficient/);
  });
});

describe('reconcile and exceptions', () => {
  beforeEach(() => {
    t.fundAndActivate(100_000);
    t.allocate(50_000);
    red.openShift(ctx, t.attendant);
  });

  it('holds a shift whose POS takings differ from what was charged', () => {
    t.fuel({ gallons: 20 }); // 10,000 HTG
    const closed = red.closeShift(ctx, t.attendant, { pumpTotals: { diesel: 20 }, posTotals: { diesel: 8000 } });
    expect(closed.status).toBe('held');
    expect(closed.variance_minor).toBe(HTG(2000));
    const [ex] = exc.listExceptions(ctx, t.manager, 'open');
    expect(ex.summary).toMatch(/2,000.00 HTG/);
    exc.propose(ctx, t.manager, ex.id, { action: 'accept_variance', note: 'POS keyed one sale as cash' });
    exc.decide(ctx, t.approver, ex.id, true);
    expect(ctx.db.get('SELECT status FROM shifts WHERE id = ?', closed.id).status).toBe('accepted');
  });

  it('holds a shift whose pump meters differ from recorded gallons', () => {
    t.fuel({ gallons: 20 });
    const closed = red.closeShift(ctx, t.attendant, { pumpTotals: { diesel: 32 }, posTotals: { diesel: 10_000 } });
    expect(closed).toMatchObject({ status: 'held', variance_mgal: 12_000, variance_minor: 0 });
  });

  it('a clean shift closes without an exception', () => {
    t.fuel({ gallons: 20 });
    expect(red.closeShift(ctx, t.attendant, { pumpTotals: { diesel: 20.5 }, posTotals: { diesel: 10_000 } }).status).toBe('closed');
  });

  it('approved dispute reversal returns currency to the employee on the same lot', () => {
    const r = t.fuel({ gallons: 12 }); // 6,000 HTG
    const dispute = exc.raiseDispute(ctx, t.employee, r.id, 'Only 7 gallons went in');
    exc.propose(ctx, t.approver, dispute.id, { action: 'reverse', amount: 2500, note: 'Meter confirms 7 gal' });
    expect(() => exc.decide(ctx, t.approver, dispute.id, true)).toThrow(/Maker-checker/);
    exc.decide(ctx, t.approver2, dispute.id, true);
    expect(bal(acct.clearing(t.station.id))).toBe(HTG(3500));
    expect(bal(acct.available(t.emp.id))).toBe(HTG(46_500));
    expect(ctx.ledger.checkBalanceRule().ok).toBe(true);
  });

  it('returns an employee balance to the company after distributor approval', () => {
    const ex = exc.requestReturnToCompany(ctx, t.coApprover, { employeeId: t.emp.id, amount: 10_000, note: 'Left the company' });
    exc.decide(ctx, t.approver, ex.id, true);
    expect(bal(acct.available(t.emp.id))).toBe(HTG(40_000));
    expect(bal(acct.unallocated(t.company.id))).toBe(HTG(60_000));
  });

  it('expires lots into breakage', () => {
    t.fuel({ gallons: 10 }); // 5,000 HTG
    ctx.db.run("UPDATE lots SET expires_on = '2000-01-01'");
    admin.runExpirations(ctx, t.approver);
    expect(bal(acct.available(t.emp.id))).toBe(0);
    expect(bal(acct.unallocated(t.company.id))).toBe(0);
    expect(bal(acct.expired(t.company.id))).toBe(HTG(95_000));
    expect(ctx.ledger.checkBalanceRule().ok).toBe(true);
  });
});

describe('bank statement import', () => {
  it('auto-matches deposits by reference and amount, and still needs a second approver', () => {
    const f1 = funding.createFunding(ctx, t.preparer, { companyId: t.company.id, amountMinor: HTG(10_000) });
    const f2 = funding.createFunding(ctx, t.preparer, { companyId: t.company.id, amountMinor: HTG(20_000) });
    const csv = [
      'Date,Reference,Description,Amount',
      `2026-10-10,UNI-1,"Transfer ACME ${f1.reference}","10,000.00"`,
      `2026-10-10,UNI-2,"ACME fuel ${f2.reference}",19999.00`,
      '2026-10-10,UNI-3,Bank fee,-50.00',
      '2026-10-10,UNI-4,No reference here,5000.00',
    ].join('\n');
    const out = bank.importStatement(ctx, t.treasury, csv);
    expect(out).toMatchObject({ imported: 3, skipped: 1, matched: [f1.reference], unmatched: 2 });
    expect(funding.getFunding(ctx, f1.id).status).toBe('matched');
    expect(funding.getFunding(ctx, f2.id).status).toBe('awaiting_bank');
    expect(bank.importStatement(ctx, t.treasury, csv).duplicates).toBe(3);

    const treasuryAsApprover = { ...t.treasury, role: 'dist_admin' as const };
    expect(() => funding.approveFunding(ctx, treasuryAsApprover, f1.id)).toThrow(/Maker-checker/);
    expect(funding.approveFunding(ctx, t.approver, f1.id).status).toBe('approved');

    const line = ctx.db.get("SELECT id FROM bank_transactions WHERE bank_reference = 'UNI-2'");
    expect(() => bank.matchTransaction(ctx, t.treasury, line.id, f2.id)).toThrow(/does not equal/);
  });

  it('parses European and currency-prefixed amounts', () => {
    expect(bank.parseAmount('1.234,56')).toBe(123456);
    expect(bank.parseAmount('HTG 1,234.56')).toBe(123456);
    expect(bank.parseAmount('abc')).toBeNull();
  });
});

describe('refunds', () => {
  it('approve then pay, with maker-checker and ledger effects', () => {
    t.fundAndActivate(100_000);
    t.allocate(40_000);
    const lot = ctx.db.get('SELECT id FROM lots LIMIT 1');
    expect(() => refunds.requestRefund(ctx, t.coApprover, { lotId: lot.id, amount: 60_000.01, reason: 'x' })).toThrow(/unallocated/);
    const r = refunds.requestRefund(ctx, t.coApprover, { lotId: lot.id, amount: 60_000, reason: 'Program ended' });
    expect(() => refunds.requestRefund(ctx, t.coApprover, { lotId: lot.id, amount: 1, reason: 'x' })).toThrow(/unallocated/);

    refunds.approveRefund(ctx, t.distAdmin, r.id);
    expect(bal(acct.unallocated(t.company.id))).toBe(0);
    expect(bal(acct.refundsPayable)).toBe(HTG(60_000));
    expect(() => refunds.payRefund(ctx, t.distAdmin, r.id, 'OUT-1')).toThrow(/Maker-checker/);
    refunds.payRefund(ctx, t.treasury, r.id, 'OUT-1');
    expect(bal(acct.refundsPayable)).toBe(0);
    expect(-bal(acct.bankVerified)).toBe(HTG(40_000));
    expect(ctx.ledger.checkBalanceRule().ok).toBe(true);
  });
});
