// AI help with fueling disputes. For the station manager or distributor handling a dispute, Claude summarises
// the facts behind it (the fueling, its shift, the employee's usual fuelings, earlier disputes at the pump or
// with the attendant, any fuel alerts), suggests what to check and a likely outcome, and drafts a reply to the
// employee in French and Haitian Creole. It decides nothing: the refund or rejection still goes through the
// existing proposal and second-approver decision, and staff edit the reply before sending it.
//
// No names, phone numbers or keys are sent: people are referred to by role ("the employee", "the attendant").
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { DISTRIBUTOR, requireRole, type Actor } from '../auth.js';
import type { Ctx } from '../context.js';
import { AppError, badRequest, forbidden, notFound } from '../errors.js';
import type { Lang } from '../i18n.js';
import { AI_MODEL } from './bank-ai.js';
import { getException } from './exceptions.js';

const DisputeHelp = z.object({
  summary: z.array(z.string()).max(8),
  checks: z.array(z.string()).max(6),
  suggestion: z.object({
    action: z.enum(['refund', 'reject', 'investigate']),
    amount: z.string(),
    why: z.string(),
  }),
  reply_fr: z.string(),
  reply_ht: z.string(),
});
export type RawDisputeHelp = z.infer<typeof DisputeHelp>;
export type DisputeAdvisor = (facts: Record<string, unknown>, lang: Lang) => Promise<RawDisputeHelp>;

const SYSTEM = `You help station managers and the distributor of ALFA, a prepaid fuel network in Haiti, handle fueling disputes.
An employee of a client company disputes a fueling paid from their fuel wallet. You get the facts as JSON. You do not decide:
a manager proposes a refund or a rejection, and a second approver decides.

Return:
- summary: 3 to 6 short bullet sentences stating what happened and what the data shows (requested vs approved vs dispensed vs charged, timing, shift differences, history). Neutral, factual, no blame.
- checks: up to 4 concrete things the manager should verify (e.g. pump meter for that pump, camera, the receipt, the attendant's account).
- suggestion: action "refund" when the data supports the employee (e.g. charged for more than dispensed, a shift difference on that fuel matching the claim), "reject" when the data clearly contradicts the claim, otherwise "investigate". amount: for "refund", the amount to refund in HTG as plain digits with a dot (never more than charged), else "". why: one sentence.
- reply_fr and reply_ht: a short, polite message to the employee, in French and in Haitian Creole (Kreyòl ayisyen), 3 to 5 sentences, "vous"/"ou" form. Say what was looked at and the next step. Never promise a refund as final: a refund still needs approval. Do not mention other employees, attendants by name, alerts or internal rules.
Write summary, checks and why in the requested language. Use only the facts given.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'array', items: { type: 'string' } },
    checks: { type: 'array', items: { type: 'string' } },
    suggestion: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['refund', 'reject', 'investigate'] }, amount: { type: 'string' }, why: { type: 'string' } },
      required: ['action', 'amount', 'why'],
      additionalProperties: false,
    },
    reply_fr: { type: 'string' },
    reply_ht: { type: 'string' },
  },
  required: ['summary', 'checks', 'suggestion', 'reply_fr', 'reply_ht'],
  additionalProperties: false,
};

const aiFailed = () => new AppError(502, 'ai_error', 'The AI service did not answer. Try again, or handle the dispute by hand.');

export const claudeDisputeAdvisor: DisputeAdvisor = async (facts, lang) => {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new AppError(503, 'ai_unavailable', 'AI suggestions are not set up on this server yet');
  }
  const client = new Anthropic({ timeout: 30_000, maxRetries: 0 });
  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await client.beta.messages.create({
      model: AI_MODEL,
      max_tokens: 8000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify({ language: lang === 'fr' ? 'French' : 'English', ...facts }) }],
    });
  } catch (e) {
    if (e instanceof Anthropic.APIError) throw aiFailed();
    throw e;
  }
  if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') throw aiFailed();
  const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  const parsed = DisputeHelp.safeParse((() => { try { return JSON.parse(text); } catch { return null; } })());
  if (!parsed.success) throw aiFailed();
  return parsed.data;
};

/** Who may work on a dispute: the distributor, or the manager of the station where it happened. */
function loadDispute(ctx: Ctx, actor: Actor, exceptionId: number) {
  requireRole(actor, ['st_manager', ...DISTRIBUTOR]);
  const e = getException(ctx, exceptionId);
  if (e.kind !== 'dispute') throw badRequest('not_a_dispute', 'Only disputes have a summary and replies');
  if (actor.role === 'st_manager' && e.station_id !== actor.stationId) throw forbidden();
  return e;
}

const gal = (mgal: number | null) => (mgal == null ? null : Number((mgal / 1000).toFixed(2)));
const htg = (minor: number | null) => (minor == null ? null : Number((minor / 100).toFixed(2)));

/** The facts Claude gets: the fueling, its shift and the surrounding history, without names. */
export function disputeFacts(ctx: Ctx, e: any) {
  const r = ctx.db.get('SELECT * FROM redemptions WHERE id = ?', e.ref_id);
  if (!r) throw notFound('Redemption');
  const shift = ctx.db.get('SELECT status, variance_mgal, variance_minor, manager_note, pump_json, digital_json FROM shifts WHERE id = ?', r.shift_id);
  const since = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
  const history = ctx.db.get(
    `SELECT COUNT(*) AS n, AVG(dispensed_mgal) AS avg_mgal, MAX(dispensed_mgal) AS max_mgal FROM redemptions
      WHERE employee_id = ? AND status = 'completed' AND completed_at >= ? AND id != ?`, r.employee_id, since(60), r.id);
  const pastDisputes = (where: string, ...args: (string | number)[]) => ctx.db.all(
    `SELECT x.status, x.resolution IS NOT NULL AS has_resolution, x.proposal_json FROM exceptions x JOIN redemptions rr ON rr.id = x.ref_id
      WHERE x.kind = 'dispute' AND x.id != ? AND x.created_at >= ? AND ${where}`, e.id, since(90), ...args,
  ).map((d: any) => ({ status: d.status, outcome: d.proposal_json ? JSON.parse(d.proposal_json).action : null }));
  const alerts = ctx.db.all<{ rule: string; severity: string; status: string; redemption_ids: string }>(
    'SELECT rule, severity, status, redemption_ids FROM fuel_alerts WHERE redemption_ids LIKE ?', `%${r.id}%`,
  ).filter((a) => (JSON.parse(a.redemption_ids) as number[]).includes(r.id)).map(({ rule, severity, status }) => ({ rule, severity, status }));
  return {
    dispute: { employee_says: typeof e.detail === 'string' ? e.detail : '', opened_at: e.created_at, status: e.status },
    fueling: {
      station: e.station_name, pump: r.pump, grade: r.grade, offline_sale: !!r.offline,
      requested_gal: gal(r.requested_mgal), requested_htg: htg(r.requested_minor),
      approved_gal: gal(r.approved_mgal), approved_htg: htg(r.approved_minor),
      dispensed_gal: gal(r.dispensed_mgal), charged_htg: htg(r.charged_minor), price_htg_per_gal: htg(r.price_minor),
      requested_at: r.created_at, approved_at: r.approved_at, completed_at: r.completed_at,
    },
    shift: shift ? {
      status: shift.status, difference_gal: gal(shift.variance_mgal), difference_htg: htg(shift.variance_minor), manager_note: shift.manager_note,
      pump_meters_gal: shift.pump_json ? JSON.parse(shift.pump_json) : null, recorded_by_wallets: shift.digital_json ? JSON.parse(shift.digital_json) : null,
    } : null,
    employee_last_60_days: { other_fuelings: Number(history?.n ?? 0), average_gal: gal(history?.avg_mgal ?? null), largest_gal: gal(history?.max_mgal ?? null) },
    earlier_disputes_last_90_days: {
      by_this_employee: pastDisputes('rr.employee_id = ?', r.employee_id),
      on_this_attendants_sales: pastDisputes('rr.attendant_id = ?', r.attendant_id),
      at_this_pump: pastDisputes('rr.station_id = ? AND rr.pump = ?', r.station_id, r.pump),
    },
    fuel_alerts_on_this_fueling: alerts,
  };
}

/** AI summary, suggestion and reply drafts for one dispute. Nothing is changed or sent. */
export async function adviseOnDispute(ctx: Ctx, actor: Actor, exceptionId: number, lang: Lang, advise: DisputeAdvisor = claudeDisputeAdvisor) {
  const e = loadDispute(ctx, actor, exceptionId);
  const facts = disputeFacts(ctx, e);
  const raw = await advise(facts, lang);
  const charged = ctx.db.get('SELECT charged_minor FROM redemptions WHERE id = ?', e.ref_id).charged_minor as number;
  const amountMinor = raw.suggestion.action === 'refund' ? Math.round(Number(raw.suggestion.amount) * 100) : null;
  const suggestion = {
    action: raw.suggestion.action,
    // A refund suggestion must be a positive amount within what was charged, or it is not shown as an amount.
    amountMinor: amountMinor && amountMinor > 0 && amountMinor <= charged ? amountMinor : null,
    why: raw.suggestion.why.slice(0, 400),
  };
  ctx.db.audit(actor.userId, 'exception.ai_summary', 'exception', e.id, { suggestion: suggestion.action });
  return {
    summary: raw.summary.map((s) => s.slice(0, 400)),
    checks: raw.checks.map((s) => s.slice(0, 300)),
    suggestion,
    replies: { fr: raw.reply_fr.slice(0, 2000), ht: raw.reply_ht.slice(0, 2000) },
  };
}

/** A message from the station or distributor to the employee who raised the dispute; shown in their wallet. */
export function replyToDispute(ctx: Ctx, actor: Actor, exceptionId: number, text: string) {
  const e = loadDispute(ctx, actor, exceptionId);
  const id = ctx.db.run('INSERT INTO dispute_messages (exception_id, author_id, body) VALUES (?,?,?)', e.id, actor.userId, text.trim()).id;
  ctx.db.audit(actor.userId, 'exception.reply', 'exception', e.id, { message: id });
  return getException(ctx, e.id);
}
