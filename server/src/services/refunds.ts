import { DISTRIBUTOR, requireCompany, requireRole, type Actor } from '../auth.js';
import type { Ctx } from '../context.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { acct, GAL } from '../ledger.js';
import { nowIso, toMgal, valueOf } from '../units.js';

export function getRefund(ctx: Ctx, id: number) {
  const r = ctx.db.get(
    `SELECT r.*, c.name AS company_name, l.code AS lot_code, l.grade, l.price_minor,
            ur.name AS requested_by_name, ua.name AS approved_by_name, up.name AS paid_by_name
       FROM refunds r JOIN companies c ON c.id = r.company_id JOIN lots l ON l.id = r.lot_id
       LEFT JOIN users ur ON ur.id = r.requested_by LEFT JOIN users ua ON ua.id = r.approved_by
       LEFT JOIN users up ON up.id = r.paid_by
      WHERE r.id = ?`,
    id,
  );
  if (!r) throw notFound('Refund');
  return r;
}

export function listRefunds(ctx: Ctx, actor: Actor) {
  const own = !DISTRIBUTOR.includes(actor.role);
  return ctx.db
    .all(`SELECT id FROM refunds ${own ? 'WHERE company_id = ?' : ''} ORDER BY id DESC`, ...(own ? [actor.companyId ?? -1] : []))
    .map((r) => getRefund(ctx, r.id));
}

/** Company approver asks for unused, unallocated gallons of a lot to be refunded at the lot's contract price. */
export function requestRefund(ctx: Ctx, actor: Actor, input: { lotId: number; gallons: number; reason: string }) {
  requireRole(actor, ['co_approver']);
  return ctx.db.tx(() => {
    const lot = ctx.db.get('SELECT * FROM lots WHERE id = ?', input.lotId);
    if (!lot) throw notFound('Lot');
    requireCompany(actor, lot.company_id);
    const mgal = toMgal(input.gallons);
    if (mgal <= 0) throw badRequest('bad_quantity', 'Gallons must be positive');
    const pending = ctx.db.get(
      "SELECT COALESCE(SUM(gallons_mgal), 0) AS m FROM refunds WHERE lot_id = ? AND status = 'requested'", lot.id,
    ).m;
    const free = ctx.ledger.balance(acct.unallocated(lot.company_id), lot.id) - pending;
    if (mgal > free) throw conflict('insufficient_balance', `Only ${(free / 1000).toFixed(1)} gal of ${lot.code} are unallocated`);
    const id = ctx.db.run(
      `INSERT INTO refunds (company_id, lot_id, gallons_mgal, amount_minor, currency, reason, requested_by)
       VALUES (?,?,?,?,?,?,?)`,
      lot.company_id, lot.id, mgal, valueOf(mgal, lot.price_minor), lot.currency, input.reason, actor.userId,
    ).id;
    ctx.db.audit(actor.userId, 'refund.request', 'refund', id, input);
    return getRefund(ctx, id);
  });
}

/**
 * Distributor approves: gallons leave the company pool for good and the prepaid liability becomes
 * a refund payable. Cash leaves only when treasury records the payout.
 */
export function approveRefund(ctx: Ctx, actor: Actor, id: number) {
  requireRole(actor, ['dist_approver', 'dist_admin']);
  return ctx.db.tx(() => {
    const r = getRefund(ctx, id);
    if (r.status !== 'requested') throw conflict('bad_state', `Refund is ${r.status}`);
    const entryId = ctx.ledger.post({
      kind: 'refund_approved', refType: 'refund', refId: r.id, companyId: r.company_id,
      memo: `Refund #${r.id}: ${(r.gallons_mgal / 1000).toFixed(1)} gal of ${r.lot_code}`, createdBy: actor.userId,
      lines: [
        { account: acct.unallocated(r.company_id), unit: GAL, lotId: r.lot_id, debit: r.gallons_mgal },
        { account: acct.refunded(r.company_id), unit: GAL, lotId: r.lot_id, credit: r.gallons_mgal },
        { account: acct.prepaidLiability(r.company_id), unit: r.currency, debit: r.amount_minor },
        { account: acct.refundsPayable, unit: r.currency, credit: r.amount_minor },
      ],
    });
    ctx.db.run(
      "UPDATE refunds SET status = 'approved', approved_by = ?, approve_entry_id = ?, decided_at = ? WHERE id = ?",
      actor.userId, entryId, nowIso(), id,
    );
    ctx.db.audit(actor.userId, 'refund.approve', 'refund', id);
    return getRefund(ctx, id);
  });
}

export function rejectRefund(ctx: Ctx, actor: Actor, id: number, reason: string) {
  const r = getRefund(ctx, id);
  if (DISTRIBUTOR.includes(actor.role)) requireRole(actor, ['dist_approver', 'dist_admin']);
  else { requireRole(actor, ['co_approver']); requireCompany(actor, r.company_id); }
  if (r.status !== 'requested') throw conflict('bad_state', `Refund is ${r.status}`);
  ctx.db.run("UPDATE refunds SET status = 'rejected', reject_reason = ?, decided_at = ? WHERE id = ?", reason, nowIso(), id);
  ctx.db.audit(actor.userId, 'refund.reject', 'refund', id, { reason });
  return getRefund(ctx, id);
}

/** Treasury records the outgoing bank transfer. Must be a different person from the approver. */
export function payRefund(ctx: Ctx, actor: Actor, id: number, payoutReference: string) {
  requireRole(actor, ['dist_treasury', 'dist_admin']);
  return ctx.db.tx(() => {
    const r = getRefund(ctx, id);
    if (r.status !== 'approved') throw conflict('bad_state', `Refund is ${r.status}`);
    if (r.approved_by === actor.userId) throw forbidden('Maker-checker: the approver cannot also record the payout');
    const entryId = ctx.ledger.post({
      kind: 'refund_paid', refType: 'refund', refId: r.id, companyId: r.company_id,
      memo: `Refund #${r.id} paid · ${payoutReference}`, createdBy: actor.userId,
      lines: [
        { account: acct.refundsPayable, unit: r.currency, debit: r.amount_minor },
        { account: acct.bankVerified, unit: r.currency, credit: r.amount_minor },
      ],
    });
    ctx.db.run(
      "UPDATE refunds SET status = 'paid', paid_by = ?, payout_reference = ?, paid_entry_id = ?, paid_at = ? WHERE id = ?",
      actor.userId, payoutReference, entryId, nowIso(), id,
    );
    ctx.db.audit(actor.userId, 'refund.pay', 'refund', id, { payoutReference });
    return getRefund(ctx, id);
  });
}
