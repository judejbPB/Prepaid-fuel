import { beforeEach, describe, expect, it } from 'vitest';
import { actorFor, hashSecret, type Actor } from '../src/auth.js';
import { createCtx, type Ctx } from '../src/context.js';
import { acct } from '../src/ledger.js';
import * as admin from '../src/services/admin.js';
import * as alloc from '../src/services/allocation.js';
import * as exc from '../src/services/exceptions.js';
import * as funding from '../src/services/funding.js';
import * as red from '../src/services/redemption.js';

const PIN = '4321';

function setup() {
  const ctx = createCtx(':memory:', { varianceToleranceMgal: 2000 });
  const as = (u: { id: number }, extra: Partial<Actor> = {}): Actor => ({ ...actorFor(ctx.db, u.id, null, null), ...extra });
  const mk = (name: string, role: any, extra = {}) =>
    admin.createUser(ctx, null, { name, login: name.toLowerCase().replace(/\W/g, '') + '@t', password: 'password1', role, ...extra });

  const company = admin.createCompany(ctx, null, { name: 'Acme', approvalThresholdGallons: 100 });
  admin.setContractPrice(ctx, null, { companyId: company.id, grade: 'diesel', priceMinor: 50000 });
  admin.setContractPrice(ctx, null, { companyId: company.id, grade: 'gasoline', priceMinor: 40000 });
  const station = admin.createStation(ctx, null, { name: 'Station X' });
  const terminal = admin.createTerminal(ctx, null, { stationId: station.id, label: 'T-X' });

  const treasury = as(mk('Treasury', 'dist_treasury'));
  const approver = as(mk('Approver', 'dist_approver'));
  const approver2 = as(mk('Approver Two', 'dist_approver'));
  const preparer = as(mk('Prep', 'co_preparer', { companyId: company.id }));
  const coApprover = as(mk('CoApp', 'co_approver', { companyId: company.id }));
  const attendant = as(mk('Att', 'st_attendant', { stationId: station.id }), { terminalId: terminal.id });
  const manager = as(mk('Mgr', 'st_manager', { stationId: station.id }));

  const emp = admin.createEmployee(ctx, null, { companyId: company.id, name: 'Jean', phone: '50930000001', password: 'password1' });
  ctx.db.run('UPDATE employees SET pin_hash = ? WHERE id = ?', hashSecret(PIN), emp.id);
  const employee = as({ id: emp.user_id });

  const fundAndActivate = (grade: string, gallons: number, price: number) => {
    const f = funding.createFunding(ctx, preparer, { companyId: company.id, grade, amountMinor: gallons * price });
    funding.matchFunding(ctx, treasury, f.id, { bankReference: `BANK-${f.id}`, bankAmountMinor: f.amount_minor });
    return funding.approveFunding(ctx, approver, f.id);
  };
  const allocate = (gallons: number, grade = 'diesel') => {
    const b = alloc.createBatch(ctx, preparer, { companyId: company.id, title: 'benefit', lines: [{ employeeId: emp.id, grade, gallons }] });
    return alloc.submitBatch(ctx, preparer, b.id);
  };
  const fuel = (gallons: number, dispensed = gallons, grade = 'diesel') => {
    const r = red.createRequest(ctx, attendant, { grade, pump: 3, gallons });
    red.approveRequest(ctx, employee, { code: red.qrPayload(r.code), pin: PIN });
    return red.completeRequest(ctx, attendant, r.id, dispensed);
  };
  return { ctx, company, station, terminal, treasury, approver, approver2, preparer, coApprover, attendant, manager, emp, employee, fundAndActivate, allocate, fuel };
}

let t: ReturnType<typeof setup>;
let ctx: Ctx;
beforeEach(() => {
  t = setup();
  ctx = t.ctx;
});

const bal = (account: string) => ctx.ledger.balance(account);

describe('ledger', () => {
  it('rejects unbalanced entries', () => {
    expect(() =>
      ctx.ledger.post({ kind: 'x', createdBy: null, lines: [
        { account: 'a', unit: 'HTG', debit: 10 }, { account: 'b', unit: 'HTG', credit: 9 },
      ] }),
    ).toThrow(/unbalanced/);
  });

  it('is append-only', () => {
    t.fundAndActivate('diesel', 100, 50000);
    expect(() => ctx.db.run('UPDATE journal_lines SET debit = debit + 1')).toThrow(/append-only/);
    expect(() => ctx.db.run('DELETE FROM journal_entries')).toThrow(/append-only/);
  });

  it('never lets a holding account go negative', () => {
    t.fundAndActivate('diesel', 10, 50000);
    expect(() => t.allocate(11)).toThrow(/Insufficient/);
    expect(bal(acct.unallocated(t.company.id))).toBe(10_000);
  });
});

describe('fund and activate', () => {
  it('requires a matched deposit and a second approver', () => {
    const f = funding.createFunding(ctx, t.preparer, { companyId: t.company.id, grade: 'diesel', amountMinor: 1_000_000 });
    expect(f.reference).toMatch(/^TR-\d+$/);
    expect(f.gallons_mgal).toBe(20_000);
    expect(() => funding.approveFunding(ctx, t.approver, f.id)).toThrow(/matched first/);
    expect(() => funding.matchFunding(ctx, t.treasury, f.id, { bankReference: 'B1', bankAmountMinor: 999 })).toThrow(/does not equal/);

    const admin1 = actorFor(ctx.db, admin.createUser(ctx, null, { name: 'Boss', login: 'boss@t', password: 'password1', role: 'dist_admin' }).id, null, null);
    funding.matchFunding(ctx, admin1, f.id, { bankReference: 'B1', bankAmountMinor: 1_000_000 });
    expect(() => funding.approveFunding(ctx, admin1, f.id)).toThrow(/Maker-checker/);

    const done = funding.approveFunding(ctx, t.approver, f.id);
    expect(done.status).toBe('approved');
    expect(done.lot_code).toBeTruthy();
    expect(bal(acct.unallocated(t.company.id))).toBe(20_000);
    expect(bal(acct.prepaidLiability(t.company.id))).toBe(1_000_000);
    expect(-bal(acct.bankVerified)).toBe(1_000_000);
  });

  it('refuses to reuse a bank reference', () => {
    const f1 = funding.createFunding(ctx, t.preparer, { companyId: t.company.id, grade: 'diesel', amountMinor: 500_000 });
    const f2 = funding.createFunding(ctx, t.preparer, { companyId: t.company.id, grade: 'diesel', amountMinor: 500_000 });
    funding.matchFunding(ctx, t.treasury, f1.id, { bankReference: 'SAME', bankAmountMinor: 500_000 });
    expect(() => funding.matchFunding(ctx, t.treasury, f2.id, { bankReference: 'SAME', bankAmountMinor: 500_000 })).toThrow(/already matched/);
  });
});

describe('allocate', () => {
  it('moves value, never creates it', () => {
    t.fundAndActivate('diesel', 200, 50000);
    t.allocate(80);
    expect(bal(acct.unallocated(t.company.id))).toBe(120_000);
    expect(bal(acct.available(t.emp.id))).toBe(80_000);
    expect(ctx.ledger.checkBalanceRule().ok).toBe(true);
  });

  it('splits preparer and approver on large batches', () => {
    t.fundAndActivate('diesel', 500, 50000);
    const b = t.allocate(150); // threshold is 100 gal
    expect(b.status).toBe('pending_approval');
    expect(() => alloc.approveBatch(ctx, { ...t.preparer, role: 'co_approver' }, b.id)).toThrow(/Maker-checker/);
    expect(alloc.approveBatch(ctx, t.coApprover, b.id).status).toBe('posted');
    expect(bal(acct.available(t.emp.id))).toBe(150_000);
  });

  it('holds records that share a phone number', () => {
    t.fundAndActivate('diesel', 100, 50000);
    const twin = admin.createEmployee(ctx, null, { companyId: t.company.id, name: 'Jean bis', phone: '50930000001', password: 'password1' });
    const b = alloc.createBatch(ctx, t.preparer, {
      companyId: t.company.id, title: 'x',
      lines: [{ employeeId: twin.id, grade: 'diesel', gallons: 10 }, { employeeId: t.emp.id, grade: 'diesel', gallons: 10 }],
    });
    expect(b.held_count).toBe(2);
    expect(() => alloc.submitBatch(ctx, t.preparer, b.id)).toThrow(/No lines are ready/);
  });

  it('pauses recurring benefits when the funded balance is low', () => {
    t.fundAndActivate('diesel', 100, 50000);
    const b = t.allocate(60);
    alloc.makeRecurring(ctx, t.coApprover, b.id, 1);
    const next = new Date();
    next.setUTCMonth(next.getUTCMonth() + 1, 2);
    const out = alloc.runRecurring(ctx, null, next);
    expect(out[0].outcome).toBe('paused_low_balance');
    t.fundAndActivate('diesel', 100, 50000);
    alloc.setRecurringStatus(ctx, t.coApprover, out[0].id, 'active');
    expect(alloc.runRecurring(ctx, null, next)[0].outcome).toBe('posted');
    expect(alloc.runRecurring(ctx, null, next)).toHaveLength(0); // once per month
    expect(bal(acct.available(t.emp.id))).toBe(120_000);
  });
});

describe('redeem', () => {
  beforeEach(() => {
    t.fundAndActivate('diesel', 200, 50000);
    t.allocate(100);
    red.openShift(ctx, t.attendant);
  });

  it('counts fuel only after the employee approves and the attendant confirms', () => {
    const r = red.createRequest(ctx, t.attendant, { grade: 'diesel', pump: 3, gallons: 12 });
    expect(bal(acct.available(t.emp.id))).toBe(100_000);
    const preview = red.previewRequest(ctx, t.employee, red.qrPayload(r.code));
    expect(preview).toMatchObject({ station_name: 'Station X', pump: 3, grade: 'diesel', requested_mgal: 12_000 });

    red.approveRequest(ctx, t.employee, { code: r.code, pin: PIN });
    expect(bal(acct.available(t.emp.id))).toBe(88_000);
    expect(bal(acct.reserved(t.emp.id))).toBe(12_000);
    expect(bal(acct.clearing(t.station.id))).toBe(0);

    red.completeRequest(ctx, t.attendant, r.id, 11.5); // pump stopped early: remainder released
    expect(bal(acct.reserved(t.emp.id))).toBe(0);
    expect(bal(acct.clearing(t.station.id))).toBe(11_500);
    expect(bal(acct.available(t.emp.id))).toBe(88_500);
    expect(bal(acct.fuelRevenue)).toBe(575_000);
    expect(ctx.ledger.checkBalanceRule().ok).toBe(true);
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
    expect(bal(acct.available(t.emp.id))).toBe(100_000);
    expect(bal(acct.reserved(t.emp.id))).toBe(0);
  });

  it('cannot dispense more than approved or redeem beyond balance', () => {
    const r = red.createRequest(ctx, t.attendant, { grade: 'diesel', pump: 1, gallons: 10 });
    red.approveRequest(ctx, t.employee, { code: r.code, pin: PIN });
    expect(() => red.completeRequest(ctx, t.attendant, r.id, 10.5)).toThrow(/more than/);
    const big = red.createRequest(ctx, t.attendant, { grade: 'diesel', pump: 1, gallons: 95 });
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
    const lot = ctx.db.get('SELECT id FROM lots LIMIT 1');
    admin.setFrozen(ctx, t.approver, 'lot', lot.id, true);
    const r = red.createRequest(ctx, t.attendant, { grade: 'diesel', pump: 1, gallons: 5 });
    expect(() => red.approveRequest(ctx, t.employee, { code: r.code, pin: PIN })).toThrow(/Insufficient/);
  });
});

describe('reconcile and exceptions', () => {
  beforeEach(() => {
    t.fundAndActivate('diesel', 200, 50000);
    t.allocate(100);
    red.openShift(ctx, t.attendant);
  });

  it('holds a shift with variance until explained and accepted by a different person', () => {
    t.fuel(20);
    const closed = red.closeShift(ctx, t.attendant, { pumpTotals: { diesel: 32 }, posTotals: { diesel: 20 } });
    expect(closed.status).toBe('held');
    expect(closed.variance_mgal).toBe(12_000);
    const [ex] = exc.listExceptions(ctx, t.manager, 'open');
    expect(ex.kind).toBe('shift_variance');
    exc.propose(ctx, t.manager, ex.id, { action: 'accept_variance', note: 'Pump 2 calibration test' });
    exc.decide(ctx, t.approver, ex.id, true);
    expect(ctx.db.get('SELECT status FROM shifts WHERE id = ?', closed.id).status).toBe('accepted');
  });

  it('a clean shift closes without an exception', () => {
    t.fuel(20);
    const closed = red.closeShift(ctx, t.attendant, { pumpTotals: { diesel: 20.5 }, posTotals: { diesel: 20 } });
    expect(closed.status).toBe('closed');
  });

  it('approved dispute reversal returns gallons to the employee on the same lot', () => {
    const r = t.fuel(12);
    const dispute = exc.raiseDispute(ctx, t.employee, r.id, 'Only 7 gallons went in');
    exc.propose(ctx, t.approver, dispute.id, { action: 'reverse', gallons: 5, note: 'Meter confirms 7 gal' });
    expect(() => exc.decide(ctx, t.approver, dispute.id, true)).toThrow(/Maker-checker/);
    exc.decide(ctx, t.approver2, dispute.id, true);
    expect(bal(acct.clearing(t.station.id))).toBe(7_000);
    expect(bal(acct.available(t.emp.id))).toBe(93_000);
    expect(ctx.ledger.checkBalanceRule().ok).toBe(true);
  });

  it('expires lots and recognises breakage', () => {
    t.fuel(10);
    ctx.db.run("UPDATE lots SET expires_on = '2000-01-01'");
    admin.runExpirations(ctx, t.approver);
    expect(bal(acct.available(t.emp.id))).toBe(0);
    expect(bal(acct.unallocated(t.company.id))).toBe(0);
    expect(bal(acct.expired(t.company.id))).toBe(190_000);
    expect(bal(acct.breakage)).toBe(9_500_000);
    expect(bal(acct.prepaidLiability(t.company.id))).toBe(0);
    expect(ctx.ledger.checkBalanceRule().ok).toBe(true);
  });
});

describe('bank statement import', () => {
  it('auto-matches deposits by reference and amount, and still needs a second approver', async () => {
    const bank = await import('../src/services/bank.js');
    const f1 = funding.createFunding(ctx, t.preparer, { companyId: t.company.id, grade: 'diesel', amountMinor: 1_000_000 });
    const f2 = funding.createFunding(ctx, t.preparer, { companyId: t.company.id, grade: 'diesel', amountMinor: 2_000_000 });
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

    // The importer counts as matcher, so the activation needs someone else.
    const treasuryAsApprover = { ...t.treasury, role: 'dist_admin' as const };
    expect(() => funding.approveFunding(ctx, treasuryAsApprover, f1.id)).toThrow(/Maker-checker/);
    expect(funding.approveFunding(ctx, t.approver, f1.id).status).toBe('approved');

    // An unmatched line with the wrong amount cannot be force-linked.
    const line = ctx.db.get("SELECT id FROM bank_transactions WHERE bank_reference = 'UNI-2'");
    expect(() => bank.matchTransaction(ctx, t.treasury, line.id, f2.id)).toThrow(/does not equal/);
  });

  it('parses European and currency-prefixed amounts', async () => {
    const { parseAmount } = await import('../src/services/bank.js');
    expect(parseAmount('1.234,56')).toBe(123456);
    expect(parseAmount('HTG 1,234.56')).toBe(123456);
    expect(parseAmount('abc')).toBeNull();
  });
});

describe('refunds', () => {
  it('approve then pay, with maker-checker and ledger effects', async () => {
    const refunds = await import('../src/services/refunds.js');
    t.fundAndActivate('diesel', 100, 50000);
    t.allocate(40);
    const lot = ctx.db.get('SELECT id FROM lots LIMIT 1');
    expect(() => refunds.requestRefund(ctx, t.coApprover, { lotId: lot.id, gallons: 61, reason: 'x' })).toThrow(/unallocated/);
    const r = refunds.requestRefund(ctx, t.coApprover, { lotId: lot.id, gallons: 60, reason: 'Program ended' });
    expect(r.amount_minor).toBe(3_000_000);
    expect(() => refunds.requestRefund(ctx, t.coApprover, { lotId: lot.id, gallons: 1, reason: 'x' })).toThrow(/unallocated/);

    const admin1 = actorFor(ctx.db, admin.createUser(ctx, null, { name: 'Boss', login: 'boss2@t', password: 'password1', role: 'dist_admin' }).id, null, null);
    refunds.approveRefund(ctx, admin1, r.id);
    expect(bal(acct.unallocated(t.company.id))).toBe(0);
    expect(bal(acct.refunded(t.company.id))).toBe(60_000);
    expect(bal(acct.refundsPayable)).toBe(3_000_000);
    expect(() => refunds.payRefund(ctx, admin1, r.id, 'OUT-1')).toThrow(/Maker-checker/);
    refunds.payRefund(ctx, t.treasury, r.id, 'OUT-1');
    expect(bal(acct.refundsPayable)).toBe(0);
    expect(-bal(acct.bankVerified)).toBe(2_000_000);
    expect(bal(acct.prepaidLiability(t.company.id))).toBe(2_000_000);
    expect(ctx.ledger.checkBalanceRule().ok).toBe(true);
  });
});
