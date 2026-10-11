import { COMPANY, DISTRIBUTOR, requireCompany, requireRole, type Actor } from '../auth.js';
import type { Ctx } from '../context.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { acct, GAL } from '../ledger.js';
import { nowIso } from '../units.js';

export function activeContract(ctx: Ctx, companyId: number, grade: string) {
  const c = ctx.db.get('SELECT * FROM contracts WHERE company_id = ? AND grade = ? AND active = 1', companyId, grade);
  if (!c) throw badRequest('no_contract', `No active ${grade} contract price for this company`);
  return c;
}

/** Step 01 · Fund: company announces a bank transfer and receives a unique payment reference. */
export function createFunding(ctx: Ctx, actor: Actor, input: { companyId: number; grade: string; amountMinor: number }) {
  requireRole(actor, [...COMPANY, 'dist_admin', 'dist_treasury']);
  requireCompany(actor, input.companyId);
  const company = ctx.db.get('SELECT * FROM companies WHERE id = ?', input.companyId);
  if (!company) throw notFound('Company');
  if (company.status !== 'active') throw conflict('frozen', 'Company is frozen');
  const contract = activeContract(ctx, input.companyId, input.grade);
  const gallons = Math.floor((input.amountMinor * 1000) / contract.price_minor);
  if (gallons <= 0) throw badRequest('too_small', 'Amount buys less than one milligallon');

  return ctx.db.tx(() => {
    const next = (ctx.db.get('SELECT COALESCE(MAX(id), 0) + 4821 AS n FROM funding_requests')!.n as number);
    const id = ctx.db.run(
      `INSERT INTO funding_requests (reference, company_id, grade, amount_minor, price_minor, currency, gallons_mgal, created_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      `TR-${next}`, input.companyId, input.grade, input.amountMinor, contract.price_minor, contract.currency, gallons, actor.userId,
    ).id;
    ctx.db.audit(actor.userId, 'funding.create', 'funding', id, input);
    return getFunding(ctx, id);
  });
}

export function getFunding(ctx: Ctx, id: number) {
  const f = ctx.db.get(
    `SELECT f.*, c.name AS company_name, l.code AS lot_code
       FROM funding_requests f JOIN companies c ON c.id = f.company_id
       LEFT JOIN lots l ON l.funding_id = f.id WHERE f.id = ?`,
    id,
  );
  if (!f) throw notFound('Funding request');
  return f;
}

/** Step 02a · Treasury matches a cleared bank deposit to the reference. */
export function matchFunding(ctx: Ctx, actor: Actor, id: number, input: { bankReference: string; bankAmountMinor: number }) {
  requireRole(actor, ['dist_treasury', 'dist_admin']);
  return ctx.db.tx(() => {
    const f = getFunding(ctx, id);
    if (f.status !== 'awaiting_bank') throw conflict('bad_state', `Funding is ${f.status}`);
    if (input.bankAmountMinor !== f.amount_minor) {
      throw conflict('amount_mismatch', `Bank amount ${input.bankAmountMinor} does not equal expected ${f.amount_minor}`);
    }
    const dup = ctx.db.get('SELECT reference FROM funding_requests WHERE bank_reference = ?', input.bankReference);
    if (dup) throw conflict('bank_ref_used', `Bank reference already matched to ${dup.reference}`);
    ctx.db.run(
      `UPDATE funding_requests SET status = 'matched', bank_reference = ?, bank_amount_minor = ?, matched_by = ?, matched_at = ?
        WHERE id = ?`,
      input.bankReference, input.bankAmountMinor, actor.userId, nowIso(), id,
    );
    ctx.db.audit(actor.userId, 'funding.match', 'funding', id, input);
    return getFunding(ctx, id);
  });
}

/** Step 02b · A second approver activates the fuel lot. Posts the funding entry. */
export function approveFunding(ctx: Ctx, actor: Actor, id: number) {
  requireRole(actor, ['dist_approver', 'dist_admin']);
  return ctx.db.tx(() => {
    const f = getFunding(ctx, id);
    if (f.status !== 'matched') throw conflict('bad_state', `Funding is ${f.status}; it must be matched first`);
    if (f.matched_by === actor.userId) throw forbidden('Maker-checker: the person who matched the deposit cannot activate it');
    const company = ctx.db.get('SELECT status FROM companies WHERE id = ?', f.company_id);
    if (company.status !== 'active') throw conflict('frozen', 'Company is frozen');

    const expires = new Date();
    expires.setMonth(expires.getMonth() + ctx.config.lotValidityMonths);
    const lotId = ctx.db.run(
      `INSERT INTO lots (code, company_id, funding_id, grade, price_minor, currency, gallons_mgal, expires_on)
       VALUES (?,?,?,?,?,?,?,?)`,
      `LOT-${f.reference.slice(3)}`, f.company_id, f.id, f.grade, f.price_minor, f.currency, f.gallons_mgal,
      expires.toISOString().slice(0, 10),
    ).id;

    ctx.ledger.post({
      kind: 'funding_activated',
      refType: 'funding',
      refId: f.id,
      companyId: f.company_id,
      memo: `${f.reference} activated as LOT-${f.reference.slice(3)}`,
      createdBy: actor.userId,
      lines: [
        { account: acct.bankVerified, unit: f.currency, debit: f.amount_minor },
        { account: acct.prepaidLiability(f.company_id), unit: f.currency, credit: f.amount_minor },
        { account: acct.issued(f.company_id), unit: GAL, lotId, debit: f.gallons_mgal },
        { account: acct.unallocated(f.company_id), unit: GAL, lotId, credit: f.gallons_mgal },
      ],
    });
    ctx.db.run(
      "UPDATE funding_requests SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?",
      actor.userId, nowIso(), id,
    );
    ctx.db.audit(actor.userId, 'funding.approve', 'funding', id, { lotId });
    return getFunding(ctx, id);
  });
}

export function rejectFunding(ctx: Ctx, actor: Actor, id: number, reason: string) {
  requireRole(actor, DISTRIBUTOR);
  return ctx.db.tx(() => {
    const f = getFunding(ctx, id);
    if (f.status === 'approved' || f.status === 'rejected') throw conflict('bad_state', `Funding is ${f.status}`);
    ctx.db.run("UPDATE funding_requests SET status = 'rejected', reject_reason = ? WHERE id = ?", reason, id);
    ctx.db.audit(actor.userId, 'funding.reject', 'funding', id, { reason });
    return getFunding(ctx, id);
  });
}

export function listFunding(ctx: Ctx, actor: Actor, companyId?: number) {
  if (!DISTRIBUTOR.includes(actor.role)) companyId = actor.companyId ?? -1;
  return ctx.db.all(
    `SELECT f.*, c.name AS company_name, l.code AS lot_code, um.name AS matched_by_name, ua.name AS approved_by_name
       FROM funding_requests f JOIN companies c ON c.id = f.company_id
       LEFT JOIN lots l ON l.funding_id = f.id
       LEFT JOIN users um ON um.id = f.matched_by
       LEFT JOIN users ua ON ua.id = f.approved_by
      ${companyId ? 'WHERE f.company_id = ?' : ''}
      ORDER BY f.id DESC`,
    ...(companyId ? [companyId] : []),
  );
}
