// AI suggestions for bank lines that did not match automatically (no TR- reference, a typo, a different
// payer name). Claude compares the line with the open funding requests and proposes up to three, with its
// reasons. It only suggests: treasury still confirms with the existing Match action (which requires the exact
// amount), and a different approver still activates the lot.
//
// Only what the match needs leaves the server: the bank line (reference, date, amount, description) and the
// open funding requests (reference, company name, amount, date). No employee data, PINs or keys.
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { requireRole, type Actor } from '../auth.js';
import type { Ctx } from '../context.js';
import { AppError, conflict, notFound } from '../errors.js';
import type { Lang } from '../i18n.js';

export const AI_MODEL = 'claude-opus-5-5';
const MAX_CANDIDATES = 60;

export interface BankLine { bank_reference: string; value_date: string | null; amount_minor: number; currency: string; memo: string | null }
export interface Candidate { reference: string; company: string; amount_minor: number; currency: string; created_at: string }

const Suggestions = z.object({
  suggestions: z.array(z.object({
    reference: z.string(),
    confidence: z.enum(['high', 'medium', 'low']),
    reason: z.string(),
  })).max(3),
});
export type RawSuggestions = z.infer<typeof Suggestions>;

/** Asks the model; swapped for a fake in tests. */
export type Suggester = (line: BankLine, candidates: Candidate[], lang: Lang) => Promise<RawSuggestions>;

const SYSTEM = `You help the treasury team of ALFA, a prepaid fuel distributor in Haiti, reconcile bank statements.
Client companies announce a deposit and receive a funding reference (TR- followed by digits), then pay by bank transfer.
Some transfers arrive without the reference, with a typo in it, or under a different payer name, so they don't match automatically.

You get one bank credit line and the list of open funding requests. Suggest which requests the line most likely pays, best first, at most three.
Weigh: a reference written with a typo or partly; the company name or an abbreviation of it in the description; the amount (exact, or close because of bank charges); the transfer date shortly after the request.
Only suggest references from the list. If nothing is plausible, return an empty list: a wrong suggestion costs more than none.
confidence: high = reference or name and exact amount agree; medium = two signals agree; low = one weak signal.
reason: one short sentence naming the signals, in the requested language. Amounts are in the line's currency.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          reference: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          reason: { type: 'string' },
        },
        required: ['reference', 'confidence', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['suggestions'],
  additionalProperties: false,
};

const fmt = (minor: number) => (minor / 100).toFixed(2);

export const claudeSuggester: Suggester = async (line, candidates, lang) => {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new AppError(503, 'ai_unavailable', 'AI suggestions are not set up on this server yet');
  }
  // Suggestions should feel instant; one try within 20 seconds.
  const client = new Anthropic({ timeout: 20_000, maxRetries: 0 });
  const input = {
    language: lang === 'fr' ? 'French' : 'English',
    bank_line: { reference: line.bank_reference, date: line.value_date, amount: fmt(line.amount_minor), currency: line.currency, description: line.memo ?? '' },
    open_funding_requests: candidates.map((c) => ({ reference: c.reference, company: c.company, amount: fmt(c.amount_minor), currency: c.currency, requested_on: c.created_at.slice(0, 10) })),
  };
  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await client.beta.messages.create({
      model: AI_MODEL,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(input) }],
    });
  } catch (e) {
    if (e instanceof Anthropic.APIError) throw new AppError(502, 'ai_error', 'The AI service did not answer. Try again, or match the line by hand.');
    throw e;
  }
  if (response.stop_reason === 'refusal') throw new AppError(502, 'ai_error', 'The AI service did not answer. Try again, or match the line by hand.');
  const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  const parsed = Suggestions.safeParse((() => { try { return JSON.parse(text); } catch { return null; } })());
  if (!parsed.success) throw new AppError(502, 'ai_error', 'The AI service did not answer. Try again, or match the line by hand.');
  return parsed.data;
};

/** Suggestions for one unmatched bank line, checked against the open funding requests. */
export async function suggestMatches(ctx: Ctx, actor: Actor, txnId: number, lang: Lang, ask: Suggester = claudeSuggester) {
  requireRole(actor, ['dist_treasury', 'dist_admin']);
  const line = ctx.db.get('SELECT * FROM bank_transactions WHERE id = ?', txnId);
  if (!line) throw notFound('Bank line');
  if (line.status !== 'unmatched') throw conflict('bad_state', `Bank line is ${line.status}`);

  // Open requests, closest amount first, so the most relevant ones fit the list.
  const open = ctx.db.all<Candidate & { id: number }>(
    `SELECT f.id, f.reference, c.name AS company, f.amount_minor, f.currency, f.created_at
       FROM funding_requests f JOIN companies c ON c.id = f.company_id
      WHERE f.status = 'awaiting_bank' AND f.currency = ?
      ORDER BY ABS(f.amount_minor - ?), f.id DESC LIMIT ${MAX_CANDIDATES}`,
    line.currency, line.amount_minor,
  );
  if (!open.length) return { suggestions: [], candidates: 0 };

  const raw = await ask(line, open.map(({ id: _id, ...c }) => c), lang);
  const byRef = new Map(open.map((c) => [c.reference.toUpperCase(), c]));
  const seen = new Set<string>();
  const suggestions = raw.suggestions.flatMap((s) => {
    const f = byRef.get(s.reference.trim().toUpperCase());
    if (!f || seen.has(f.reference)) return []; // never show a request that isn't open
    seen.add(f.reference);
    return [{
      fundingId: f.id, reference: f.reference, company: f.company, amountMinor: f.amount_minor, currency: f.currency,
      confidence: s.confidence, reason: s.reason.slice(0, 300), amountMatches: f.amount_minor === line.amount_minor,
    }];
  });
  ctx.db.audit(actor.userId, 'bank.ai_suggest', 'bank_transaction', txnId, { suggestions: suggestions.map((s) => s.reference).join(', ') || '—' });
  return { suggestions, candidates: open.length };
}
