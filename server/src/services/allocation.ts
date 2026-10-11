import { COMPANY, DISTRIBUTOR, requireCompany, requireRole, type Actor } from '../auth.js';
import type { Ctx } from '../context.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { acct, GAL, type Line } from '../ledger.js';
import { GRADES, nowIso, toMgal } from '../units.js';

export interface BatchLineInput {
  employeeId: number;
  grade: string;
  gallons: number;
}

export function getBatch(ctx: Ctx, id: number) {
  const b = ctx.db.get(
    `SELECT b.*, up.name AS prepared_by_name, ua.name AS approved_by_name
       FROM allocation_batches b
       LEFT JOIN users up ON up.id = b.prepared_by
       LEFT JOIN users ua ON ua.id = b.approved_by
      WHERE b.id = ?`,
    id,
  );
  if (!b) throw notFound('Allocation batch');
  const lines = ctx.db.all(
    `SELECT al.*, e.name AS employee_name, e.dept, e.phone
       FROM allocation_lines al JOIN employees e ON e.id = al.employee_id
      WHERE al.batch_id = ? ORDER BY al.id`,
    id,
  );
  const readyMgal = lines.filter((l) => l.status !== 'held').reduce((s, l) => s + l.gallons_mgal, 0);
  return { ...b, lines, ready_mgal: readyMgal, held_count: lines.filter((l) => l.status === 'held').length };
}

export function listBatches(ctx: Ctx, actor: Actor, companyId: number) {
  requireCompany(actor, companyId);
  return ctx.db
    .all('SELECT id FROM allocation_batches WHERE company_id = ? ORDER BY id DESC', companyId)
    .map((r) => getBatch(ctx, r.id));
}

/** Phones shared by more than one active employee are held for review (possible ghost or duplicate record). */
function duplicatePhones(ctx: Ctx, companyId: number): Set<string> {
  const rows = ctx.db.all(
    `SELECT phone FROM employees WHERE company_id = ? AND status != 'inactive' GROUP BY phone HAVING COUNT(*) > 1`,
    companyId,
  );
  return new Set(rows.map((r) => r.phone));
}

export function createBatch(
  ctx: Ctx,
  actor: Actor | null,
  input: { companyId: number; title: string; lines: BatchLineInput[]; recurringId?: number },
) {
  if (actor) {
    requireRole(actor, COMPANY);
    requireCompany(actor, input.companyId);
  }
  if (input.lines.length === 0) throw badRequest('empty_batch', 'Add at least one employee');
  const dupes = duplicatePhones(ctx, input.companyId);
  return ctx.db.tx(() => {
    const id = ctx.db.run(
      'INSERT INTO allocation_batches (company_id, title, prepared_by, recurring_id) VALUES (?,?,?,?)',
      input.companyId, input.title, actor?.userId ?? null, input.recurringId ?? null,
    ).id;
    const seen = new Set<string>();
    for (const line of input.lines) {
      if (!GRADES.includes(line.grade as any)) throw badRequest('bad_grade', `Unknown grade ${line.grade}`);
      const mgal = toMgal(line.gallons);
      if (mgal <= 0) throw badRequest('bad_quantity', 'Gallons must be positive');
      const emp = ctx.db.get('SELECT * FROM employees WHERE id = ?', line.employeeId);
      if (!emp || emp.company_id !== input.companyId) throw badRequest('bad_employee', `Employee ${line.employeeId} not in company`);
      if (emp.status !== 'active') throw conflict('employee_inactive', `${emp.name} is ${emp.status}`);
      const key = `${line.employeeId}:${line.grade}`;
      if (seen.has(key)) throw badRequest('duplicate_line', `${emp.name} appears twice for ${line.grade}`);
      seen.add(key);
      const held = dupes.has(emp.phone);
      ctx.db.run(
        'INSERT INTO allocation_lines (batch_id, employee_id, grade, gallons_mgal, status, hold_reason) VALUES (?,?,?,?,?,?)',
        id, line.employeeId, line.grade, mgal, held ? 'held' : 'ready', held ? 'Duplicate phone number' : null,
      );
    }
    ctx.db.audit(actor?.userId ?? null, 'batch.create', 'batch', id, { title: input.title, lines: input.lines.length });
    return getBatch(ctx, id);
  });
}

function postBatch(ctx: Ctx, batchId: number, actorId: number | null) {
  const batch = getBatch(ctx, batchId);
  const company = ctx.db.get('SELECT * FROM companies WHERE id = ?', batch.company_id);
  if (company.status !== 'active') throw conflict('frozen', 'Company is frozen');
  const ready = batch.lines.filter((l: any) => l.status === 'ready');
  if (ready.length === 0) throw conflict('nothing_ready', 'No lines are ready to post');

  // Pick lots per grade for the whole batch, then split per employee in order.
  const lines: Line[] = [];
  for (const grade of GRADES) {
    const gl = ready.filter((l: any) => l.grade === grade);
    if (gl.length === 0) continue;
    const total = gl.reduce((s: number, l: any) => s + l.gallons_mgal, 0);
    const picks = ctx.ledger.pickFifo(acct.unallocated(batch.company_id), grade, total);
    let pi = 0;
    let left = picks[0].mgal;
    for (const l of gl) {
      let need = l.gallons_mgal;
      while (need > 0) {
        const take = Math.min(need, left);
        lines.push({ account: acct.unallocated(batch.company_id), unit: GAL, lotId: picks[pi].lotId, debit: take });
        lines.push({ account: acct.available(l.employee_id), unit: GAL, lotId: picks[pi].lotId, credit: take });
        need -= take;
        left -= take;
        if (left === 0 && pi < picks.length - 1) left = picks[++pi].mgal;
      }
    }
  }
  const entryId = ctx.ledger.post({
    kind: 'employee_allocation',
    refType: 'batch',
    refId: batchId,
    companyId: batch.company_id,
    memo: batch.title,
    createdBy: actorId,
    lines,
  });
  ctx.db.run("UPDATE allocation_lines SET status = 'posted' WHERE batch_id = ? AND status = 'ready'", batchId);
  ctx.db.run(
    "UPDATE allocation_batches SET status = 'posted', entry_id = ?, posted_at = ? WHERE id = ?",
    entryId, nowIso(), batchId,
  );
}

/** Preparer submits. Small batches post immediately; large ones wait for a different approver. */
export function submitBatch(ctx: Ctx, actor: Actor, id: number) {
  requireRole(actor, COMPANY);
  return ctx.db.tx(() => {
    const b = getBatch(ctx, id);
    requireCompany(actor, b.company_id);
    if (b.status !== 'draft') throw conflict('bad_state', `Batch is ${b.status}`);
    const company = ctx.db.get('SELECT * FROM companies WHERE id = ?', b.company_id);
    if (b.ready_mgal > company.approval_threshold_mgal) {
      ctx.db.run("UPDATE allocation_batches SET status = 'pending_approval' WHERE id = ?", id);
      ctx.db.audit(actor.userId, 'batch.submit', 'batch', id, { needsApproval: true });
    } else {
      postBatch(ctx, id, actor.userId);
      ctx.db.audit(actor.userId, 'batch.post', 'batch', id, { needsApproval: false });
    }
    return getBatch(ctx, id);
  });
}

export function approveBatch(ctx: Ctx, actor: Actor, id: number) {
  requireRole(actor, ['co_approver']);
  return ctx.db.tx(() => {
    const b = getBatch(ctx, id);
    requireCompany(actor, b.company_id);
    if (b.status !== 'pending_approval') throw conflict('bad_state', `Batch is ${b.status}`);
    if (b.prepared_by === actor.userId) throw forbidden('Maker-checker: the preparer cannot approve their own batch');
    ctx.db.run('UPDATE allocation_batches SET approved_by = ? WHERE id = ?', actor.userId, id);
    postBatch(ctx, id, actor.userId);
    ctx.db.audit(actor.userId, 'batch.approve', 'batch', id);
    return getBatch(ctx, id);
  });
}

export function rejectBatch(ctx: Ctx, actor: Actor, id: number) {
  requireRole(actor, COMPANY);
  return ctx.db.tx(() => {
    const b = getBatch(ctx, id);
    requireCompany(actor, b.company_id);
    if (b.status === 'posted' || b.status === 'rejected') throw conflict('bad_state', `Batch is ${b.status}`);
    ctx.db.run("UPDATE allocation_batches SET status = 'rejected', approved_by = ? WHERE id = ?", actor.userId, id);
    ctx.db.audit(actor.userId, 'batch.reject', 'batch', id);
    return getBatch(ctx, id);
  });
}

/** An approver who verified a held record releases it into the batch. */
export function releaseHeldLine(ctx: Ctx, actor: Actor, lineId: number) {
  requireRole(actor, ['co_approver']);
  return ctx.db.tx(() => {
    const line = ctx.db.get('SELECT * FROM allocation_lines WHERE id = ?', lineId);
    if (!line) throw notFound('Allocation line');
    const b = getBatch(ctx, line.batch_id);
    requireCompany(actor, b.company_id);
    if (line.status !== 'held') throw conflict('bad_state', 'Line is not held');
    if (b.status === 'posted' || b.status === 'rejected') throw conflict('bad_state', `Batch is ${b.status}`);
    ctx.db.run("UPDATE allocation_lines SET status = 'ready', hold_reason = NULL WHERE id = ?", lineId);
    ctx.db.audit(actor.userId, 'batch.release_hold', 'allocation_line', lineId);
    return getBatch(ctx, line.batch_id);
  });
}

// ---------------------------------------------------------------------------
// Recurring monthly benefits

export function makeRecurring(ctx: Ctx, actor: Actor, batchId: number, dayOfMonth: number) {
  requireRole(actor, ['co_approver']);
  const b = getBatch(ctx, batchId);
  requireCompany(actor, b.company_id);
  if (b.status !== 'posted') throw conflict('bad_state', 'Only a posted (approved) batch can become recurring');
  if (dayOfMonth < 1 || dayOfMonth > 28) throw badRequest('bad_day', 'Day of month must be 1–28');
  const template = b.lines
    .filter((l: any) => l.status === 'posted')
    .map((l: any) => ({ employeeId: l.employee_id, grade: l.grade, gallons: l.gallons_mgal / 1000 }));
  const period = new Date().toISOString().slice(0, 7);
  const id = ctx.db.run(
    `INSERT INTO recurring_allocations (company_id, title, template_json, day_of_month, last_period, source_batch_id)
     VALUES (?,?,?,?,?,?)`,
    b.company_id, b.title, JSON.stringify(template), dayOfMonth, period, batchId,
  ).id;
  ctx.db.audit(actor.userId, 'recurring.create', 'recurring', id, { batchId, dayOfMonth });
  return ctx.db.get('SELECT * FROM recurring_allocations WHERE id = ?', id);
}

export function listRecurring(ctx: Ctx, actor: Actor, companyId: number) {
  requireCompany(actor, companyId);
  return ctx.db.all('SELECT * FROM recurring_allocations WHERE company_id = ? ORDER BY id DESC', companyId);
}

export function setRecurringStatus(ctx: Ctx, actor: Actor, id: number, status: 'active' | 'paused' | 'cancelled') {
  requireRole(actor, ['co_approver']);
  const r = ctx.db.get('SELECT * FROM recurring_allocations WHERE id = ?', id);
  if (!r) throw notFound('Recurring allocation');
  requireCompany(actor, r.company_id);
  ctx.db.run(
    'UPDATE recurring_allocations SET status = ?, pause_reason = ? WHERE id = ?',
    status, status === 'paused' ? `Paused by ${actor.name}` : null, id,
  );
  ctx.db.audit(actor.userId, `recurring.${status}`, 'recurring', id);
  return ctx.db.get('SELECT * FROM recurring_allocations WHERE id = ?', id);
}

/**
 * Runs due recurring benefits. A run that the funded balance can't cover pauses the schedule
 * instead of posting a partial batch.
 */
export function runRecurring(ctx: Ctx, actor: Actor | null, now = new Date()) {
  if (actor) requireRole(actor, [...DISTRIBUTOR, 'co_approver']);
  const period = now.toISOString().slice(0, 7);
  const day = now.getUTCDate();
  const results: { id: number; outcome: string; batchId?: number }[] = [];
  const due = ctx.db.all(
    "SELECT * FROM recurring_allocations WHERE status = 'active' AND (last_period IS NULL OR last_period < ?) AND day_of_month <= ?",
    period, day,
  );
  for (const r of due) {
    if (actor?.role === 'co_approver' && actor.companyId !== r.company_id) continue;
    const template: BatchLineInput[] = JSON.parse(r.template_json);
    const unallocated = ctx.ledger.byGrade(acct.unallocated(r.company_id), true);
    const need: Record<string, number> = {};
    for (const l of template) need[l.grade] = (need[l.grade] ?? 0) + toMgal(l.gallons);
    const short = Object.entries(need).find(([g, m]) => (unallocated[g] ?? 0) < m);
    if (short) {
      ctx.db.run(
        "UPDATE recurring_allocations SET status = 'paused', pause_reason = ? WHERE id = ?",
        `Funded ${short[0]} balance too low for ${period} run`, r.id,
      );
      ctx.db.audit(null, 'recurring.auto_pause', 'recurring', r.id, { period, grade: short[0] });
      results.push({ id: r.id, outcome: 'paused_low_balance' });
      continue;
    }
    try {
      const batchId = ctx.db.tx(() => {
        const active = template.filter(
          (l) => ctx.db.get("SELECT 1 FROM employees WHERE id = ? AND status = 'active'", l.employeeId),
        );
        const batch = createBatch(ctx, null, {
          companyId: r.company_id, title: `${r.title} · ${period}`, lines: active, recurringId: r.id,
        });
        postBatch(ctx, batch.id, null);
        ctx.db.run('UPDATE recurring_allocations SET last_period = ? WHERE id = ?', period, r.id);
        return batch.id;
      });
      results.push({ id: r.id, outcome: 'posted', batchId });
    } catch (err: any) {
      ctx.db.run("UPDATE recurring_allocations SET status = 'paused', pause_reason = ? WHERE id = ?", err.message, r.id);
      results.push({ id: r.id, outcome: `paused: ${err.message}` });
    }
  }
  return results;
}
