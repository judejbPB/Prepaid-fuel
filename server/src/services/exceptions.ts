import { DISTRIBUTOR, requireRole, type Actor } from '../auth.js';
import type { Ctx } from '../context.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { acct, type Line } from '../ledger.js';
import { nowIso, toMinor } from '../units.js';

const fmt = (minor: number, ccy = 'HTG') => `${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} ${ccy}`;

export type Proposal =
  | { action: 'accept_variance'; note: string }
  | { action: 'acknowledge'; note: string }
  | { action: 'reverse'; amount: number; note: string }
  | { action: 'reject_dispute'; note: string }
  | { action: 'return_to_company'; employeeId: number; amount: number; note: string };

export function getException(ctx: Ctx, id: number) {
  const e = ctx.db.get(
    `SELECT x.*, up.name AS proposed_by_name, ur.name AS resolved_by_name, s.name AS station_name, c.name AS company_name
       FROM exceptions x
       LEFT JOIN users up ON up.id = x.proposed_by LEFT JOIN users ur ON ur.id = x.resolved_by
       LEFT JOIN stations s ON s.id = x.station_id LEFT JOIN companies c ON c.id = x.company_id
      WHERE x.id = ?`,
    id,
  );
  if (!e) throw notFound('Exception');
  return { ...e, proposal: e.proposal_json ? JSON.parse(e.proposal_json) : null, detail: e.detail ? safeJson(e.detail) : null };
}

const safeJson = (s: string) => { try { return JSON.parse(s); } catch { return s; } };

function canSee(actor: Actor, e: any) {
  if (DISTRIBUTOR.includes(actor.role)) return true;
  if (actor.role === 'st_manager') return e.station_id === actor.stationId;
  if (actor.role === 'co_preparer' || actor.role === 'co_approver') return e.company_id === actor.companyId;
  if (actor.role === 'employee') return e.kind === 'dispute' && e.created_by === actor.userId;
  return false;
}

export function listExceptions(ctx: Ctx, actor: Actor, status?: string) {
  const rows = ctx.db.all(
    `SELECT id FROM exceptions ${status === 'open' ? "WHERE status IN ('open','proposed')" : ''} ORDER BY id DESC LIMIT 200`,
  );
  return rows.map((r) => getException(ctx, r.id)).filter((e) => canSee(actor, e));
}

/** Employee disputes a completed fueling from the receipt screen. */
export function raiseDispute(ctx: Ctx, actor: Actor, redemptionId: number, reason: string) {
  requireRole(actor, ['employee']);
  return ctx.db.tx(() => {
    const red = ctx.db.get(
      'SELECT r.*, s.name AS station_name FROM redemptions r JOIN stations s ON s.id = r.station_id WHERE r.id = ?',
      redemptionId,
    );
    if (!red || red.employee_id !== actor.employeeId) throw notFound('Redemption');
    if (red.status !== 'completed') throw conflict('bad_state', 'Only completed fuelings can be disputed');
    const open = ctx.db.get(
      "SELECT id FROM exceptions WHERE kind = 'dispute' AND ref_id = ? AND status IN ('open','proposed')", redemptionId,
    );
    if (open) throw conflict('already_disputed', 'A dispute is already open for this fueling');
    const id = ctx.db.run(
      `INSERT INTO exceptions (kind, ref_type, ref_id, company_id, station_id, summary, detail, created_by)
       VALUES ('dispute', 'redemption', ?, ?, ?, ?, ?, ?)`,
      red.id, red.company_id, red.station_id,
      `Dispute on ${fmt(red.charged_minor, red.currency)} (${(red.dispensed_mgal / 1000).toFixed(1)} gal ${red.grade}) at ${red.station_name} pump ${red.pump}`,
      reason, actor.userId,
    ).id;
    ctx.db.audit(actor.userId, 'exception.dispute', 'exception', id, { redemptionId, reason });
    return getException(ctx, id);
  });
}

/** Company approver asks to return an employee's unused balance to the company pool (e.g. departure). */
export function requestReturnToCompany(
  ctx: Ctx, actor: Actor, input: { employeeId: number; amount: number; note: string },
) {
  requireRole(actor, ['co_approver']);
  const emp = ctx.db.get('SELECT * FROM employees WHERE id = ?', input.employeeId);
  if (!emp || emp.company_id !== actor.companyId) throw notFound('Employee');
  const proposal: Proposal = { action: 'return_to_company', ...input };
  const id = ctx.db.run(
    `INSERT INTO exceptions (kind, status, ref_type, ref_id, company_id, summary, proposal_json, proposed_by, created_by)
     VALUES ('adjustment', 'proposed', 'employee', ?, ?, ?, ?, ?, ?)`,
    emp.id, emp.company_id, `Return ${fmt(toMinor(input.amount))} from ${emp.name} to company pool`,
    JSON.stringify(proposal), actor.userId, actor.userId,
  ).id;
  ctx.db.audit(actor.userId, 'exception.adjustment', 'exception', id, input);
  return getException(ctx, id);
}

/** Station manager explains a held shift, or anyone authorized proposes a resolution. */
export function propose(ctx: Ctx, actor: Actor, id: number, proposal: Proposal) {
  return ctx.db.tx(() => {
    const e = getException(ctx, id);
    if (!canSee(actor, e)) throw forbidden();
    if (e.status === 'resolved' || e.status === 'rejected') throw conflict('bad_state', `Exception is ${e.status}`);
    if (e.kind === 'shift_variance') {
      requireRole(actor, ['st_manager', ...DISTRIBUTOR]);
      if (proposal.action !== 'accept_variance') throw badRequest('bad_action', 'Variance can only be explained and accepted');
      ctx.db.run('UPDATE shifts SET manager_note = ? WHERE id = ?', proposal.note, e.ref_id);
    } else if (e.kind === 'dispute') {
      requireRole(actor, ['st_manager', ...DISTRIBUTOR]);
      if (proposal.action === 'reverse') {
        const red = ctx.db.get('SELECT charged_minor FROM redemptions WHERE id = ?', e.ref_id);
        const amount = toMinor(proposal.amount);
        if (amount <= 0 || amount > red.charged_minor) throw badRequest('bad_amount', 'Reversal must be within the amount charged');
      } else if (proposal.action !== 'reject_dispute') {
        throw badRequest('bad_action', 'Disputes are reversed or rejected');
      }
    } else if (e.kind === 'offline_shortfall' || e.kind === 'offline_rejected') {
      // Fuel was already dispensed; the decision records how the loss is handled (recovered or written off).
      requireRole(actor, ['st_manager', ...DISTRIBUTOR]);
      if (proposal.action !== 'acknowledge') throw badRequest('bad_action', 'Offline exceptions are acknowledged with a note');
    } else {
      throw badRequest('bad_action', 'Adjustments are proposed at creation');
    }
    ctx.db.run(
      "UPDATE exceptions SET status = 'proposed', proposal_json = ?, proposed_by = ? WHERE id = ?",
      JSON.stringify(proposal), actor.userId, id,
    );
    ctx.db.audit(actor.userId, 'exception.propose', 'exception', id, proposal);
    return getException(ctx, id);
  });
}

/** Distributor decision. The approver must differ from the proposer (maker-checker). */
export function decide(ctx: Ctx, actor: Actor, id: number, approve: boolean, note?: string) {
  requireRole(actor, ['dist_approver', 'dist_admin']);
  return ctx.db.tx(() => {
    const e = getException(ctx, id);
    if (e.status !== 'proposed') throw conflict('bad_state', 'Nothing proposed yet');
    if (e.proposed_by === actor.userId) throw forbidden('Maker-checker: the proposer cannot approve their own proposal');

    if (!approve) {
      ctx.db.run(
        "UPDATE exceptions SET status = 'open', proposal_json = NULL, proposed_by = NULL, resolution = ? WHERE id = ?",
        `Proposal declined by ${actor.name}${note ? ': ' + note : ''}`, id,
      );
      if (e.kind === 'adjustment') ctx.db.run("UPDATE exceptions SET status = 'rejected', resolved_by = ?, resolved_at = ? WHERE id = ?", actor.userId, nowIso(), id);
      ctx.db.audit(actor.userId, 'exception.decline', 'exception', id, { note });
      return getException(ctx, id);
    }

    const p: Proposal = e.proposal;
    let entryId: number | null = null;
    if (p.action === 'accept_variance') {
      ctx.db.run("UPDATE shifts SET status = 'accepted' WHERE id = ?", e.ref_id);
    } else if (p.action === 'reverse') {
      entryId = reverseRedemption(ctx, actor, e.ref_id, toMinor(p.amount), id);
    } else if (p.action === 'return_to_company') {
      entryId = returnToCompany(ctx, actor, p, id);
    }
    ctx.db.run(
      "UPDATE exceptions SET status = 'resolved', resolved_by = ?, resolved_at = ?, resolution = ?, entry_id = ? WHERE id = ?",
      actor.userId, nowIso(), note ?? p.action, entryId, id,
    );
    ctx.db.audit(actor.userId, 'exception.resolve', 'exception', id, { action: p.action, entryId });
    return getException(ctx, id);
  });
}

/** Reversal approved: station clearing -> employee available, on the same lots that were charged. */
function reverseRedemption(ctx: Ctx, actor: Actor, redemptionId: number, amount: number, exceptionId: number) {
  const red = ctx.db.get('SELECT * FROM redemptions WHERE id = ?', redemptionId);
  const reversedAlready = ctx.db.get(
    `SELECT COALESCE(SUM(jl.debit), 0) AS m FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id
      WHERE je.kind = 'reversal_approved' AND je.ref_type = 'redemption' AND je.ref_id = ? AND jl.account = ?`,
    redemptionId, acct.clearing(red.station_id),
  ).m;
  if (amount + reversedAlready > red.charged_minor) throw conflict('over_reversal', 'Reversal exceeds the amount charged');
  const charged = ctx.db.all(
    'SELECT lot_id, credit AS amount, unit FROM journal_lines WHERE entry_id = ? AND account = ? ORDER BY id DESC',
    red.confirm_entry_id, acct.clearing(red.station_id),
  );
  const lines: Line[] = [];
  let left = amount;
  for (const c of charged) {
    const take = Math.min(left, c.amount);
    if (take <= 0) break;
    left -= take;
    lines.push(
      { account: acct.clearing(red.station_id), unit: c.unit, lotId: c.lot_id, debit: take },
      { account: acct.available(red.employee_id), unit: c.unit, lotId: c.lot_id, credit: take },
    );
  }
  return ctx.ledger.post({
    kind: 'reversal_approved', refType: 'redemption', refId: redemptionId, companyId: red.company_id,
    memo: `Exception #${exceptionId}`, createdBy: actor.userId, lines,
  });
}

function returnToCompany(ctx: Ctx, actor: Actor, p: Extract<Proposal, { action: 'return_to_company' }>, exceptionId: number) {
  const emp = ctx.db.get('SELECT * FROM employees WHERE id = ?', p.employeeId);
  const picks = ctx.ledger.pickFifo(acct.available(emp.id), toMinor(p.amount));
  return ctx.ledger.post({
    kind: 'adjustment', refType: 'employee', refId: emp.id, companyId: emp.company_id,
    memo: `Exception #${exceptionId}: ${p.note}`, createdBy: actor.userId,
    lines: picks.flatMap((pk) => [
      { account: acct.available(emp.id), unit: pk.currency, lotId: pk.lotId, debit: pk.amount },
      { account: acct.unallocated(emp.company_id), unit: pk.currency, lotId: pk.lotId, credit: pk.amount },
    ]),
  });
}
