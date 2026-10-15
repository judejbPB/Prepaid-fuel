// AI reading of bank statements the normal import can't read: PDF statements, and Excel/CSV files laid out
// in a way the column detection doesn't recognise. Claude lists the credit lines (date, bank reference,
// description, amount, currency); the server checks them and returns a preview. Nothing is imported here:
// treasury reviews the preview and imports it through the normal statement import, which then matches
// deposits as usual (exact amount, second approver to activate).
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { requireRole, type Actor } from '../auth.js';
import type { Ctx } from '../context.js';
import { AppError, badRequest } from '../errors.js';
import { AI_MODEL } from './bank-ai.js';
import { parseAmount } from './bank.js';
import { readXlsx } from './spreadsheet.js';

const MAX_TEXT_CHARS = 150_000;
const MAX_LINES = 500;

export type StatementSource = { kind: 'pdf'; base64: string } | { kind: 'text'; text: string };

const Extracted = z.object({
  credits: z.array(z.object({
    date: z.string(),
    reference: z.string(),
    description: z.string(),
    amount: z.string(),
    currency: z.string(),
  })),
  notes: z.string(),
});
export type RawStatement = z.infer<typeof Extracted>;

/** Asks the model; swapped for a fake in tests. */
export type StatementReader = (source: StatementSource) => Promise<RawStatement>;

const SYSTEM = `You read bank statements for the treasury team of ALFA, a prepaid fuel distributor in Haiti.
Statements come from Haitian banks (e.g. Unibank, Sogebank, BNC, Capital Bank), in French or English, as PDF or spreadsheet exports.

List every CREDIT line (money received into the account), in statement order. Leave out debits, fees, opening/closing balances, totals and page headers.
For each credit:
- date: the value or posting date as YYYY-MM-DD, or "" if unreadable.
- reference: the bank's own transaction number or reference for that line, exactly as printed; "" if the line has none. Never invent one.
- description: the line's wording (libellé), including any payer name and any reference such as TR-1234, as printed.
- amount: the credited amount as plain digits with a dot for decimals, no thousands separators (e.g. "12345.50"). Statements may write "12 345,50" or "12,345.50".
- currency: "HTG" or "USD" as shown on the statement or line; "" if not shown.
notes: one short sentence on anything uncertain (unreadable pages, a total that doesn't add up, mixed currencies), or "".
Copy only what the statement says.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    credits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string' }, reference: { type: 'string' }, description: { type: 'string' },
          amount: { type: 'string' }, currency: { type: 'string' },
        },
        required: ['date', 'reference', 'description', 'amount', 'currency'],
        additionalProperties: false,
      },
    },
    notes: { type: 'string' },
  },
  required: ['credits', 'notes'],
  additionalProperties: false,
};

const unavailable = () => new AppError(502, 'ai_error', 'The AI service could not read this statement. Try again, or export it from the bank as Excel or CSV.');

export const claudeStatementReader: StatementReader = async (source) => {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new AppError(503, 'ai_unavailable', 'AI suggestions are not set up on this server yet');
  }
  // The hosted API function stops at 60 seconds.
  const client = new Anthropic({ timeout: 55_000, maxRetries: 0 });
  const content: Anthropic.Beta.BetaContentBlockParam[] = source.kind === 'pdf'
    ? [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: source.base64 } },
        { type: 'text', text: 'List the credit lines of this bank statement.' },
      ]
    : [{ type: 'text', text: `List the credit lines of this bank statement export:\n\n${source.text}` }];
  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await client.beta.messages.create({
      model: AI_MODEL,
      max_tokens: 32000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content }],
    });
  } catch (e) {
    if (e instanceof Anthropic.APIError) throw unavailable();
    throw e;
  }
  if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') throw unavailable();
  const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  const parsed = Extracted.safeParse((() => { try { return JSON.parse(text); } catch { return null; } })());
  if (!parsed.success) throw unavailable();
  return parsed.data;
};

/** One field for a CSV line (quoted, inner quotes doubled). */
const cell = (s: string) => `"${s.replace(/"/g, '""').replace(/[\r\n]+/g, ' ')}"`;

export interface PreviewLine { date: string; reference: string; description: string; amountMinor: number; currency: string; generatedReference: boolean }

/**
 * Reads a statement with AI and returns the credit lines as a preview plus a CSV the normal import accepts.
 * Lines without a usable amount are dropped and counted. A line with no bank reference gets one built from
 * its date, amount and position, so importing the same statement twice is still caught as a duplicate.
 */
export async function readStatement(ctx: Ctx, actor: Actor, input: { pdf?: string; xlsx?: string; csv?: string }, read: StatementReader = claudeStatementReader) {
  requireRole(actor, ['dist_treasury', 'dist_admin']);
  let source: StatementSource;
  if (input.pdf) {
    if (!Buffer.from(input.pdf.slice(0, 8), 'base64').toString('latin1').startsWith('%PDF')) throw badRequest('bad_pdf', 'This file is not a PDF');
    source = { kind: 'pdf', base64: input.pdf };
  } else {
    const text = input.xlsx
      ? readXlsx(Buffer.from(input.xlsx, 'base64')).map((r) => r.join(' ; ')).join('\n')
      : input.csv ?? '';
    if (!text.trim()) throw badRequest('empty_statement', 'Statement needs a header row and at least one line');
    if (text.length > MAX_TEXT_CHARS) throw badRequest('too_large', 'This statement is too long for AI reading. Split it by month and try again.');
    source = { kind: 'text', text };
  }

  const raw = await read(source);
  const lines: PreviewLine[] = [];
  let dropped = 0;
  const seq = new Map<string, number>();
  for (const c of raw.credits.slice(0, MAX_LINES)) {
    const amountMinor = parseAmount(c.amount);
    if (amountMinor === null || amountMinor <= 0) { dropped++; continue; }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(c.date.trim()) ? c.date.trim() : '';
    const currency = /^(HTG|USD)$/i.test(c.currency.trim()) ? c.currency.trim().toUpperCase() : 'HTG';
    let reference = c.reference.trim().slice(0, 60);
    const generatedReference = !reference;
    if (!reference) {
      const key = `${date || 'SANS-DATE'}-${amountMinor}`;
      const n = (seq.get(key) ?? 0) + 1;
      seq.set(key, n);
      reference = `AUTO-${key}-${n}`;
    }
    lines.push({ date, reference, description: c.description.trim().slice(0, 300), amountMinor, currency, generatedReference });
  }
  dropped += Math.max(0, raw.credits.length - MAX_LINES);

  const csv = ['Date,Reference,Description,Amount,Currency',
    ...lines.map((l) => [l.date, l.reference, l.description, (l.amountMinor / 100).toFixed(2), l.currency].map(cell).join(','))].join('\n');
  ctx.db.audit(actor.userId, 'bank.ai_read', 'bank_statement', null, { lines: lines.length, source: input.pdf ? 'pdf' : input.xlsx ? 'xlsx' : 'csv' });
  return { lines, dropped, notes: raw.notes.slice(0, 300), csv };
}
