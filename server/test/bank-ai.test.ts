import { beforeEach, describe, expect, it } from 'vitest';
import { actorFor, type Actor } from '../src/auth.js';
import { createCtx, type Ctx } from '../src/context.js';
import { seedDemo } from '../src/demo.js';
import * as bank from '../src/services/bank.js';
import { claudeSuggester, suggestMatches, type Suggester } from '../src/services/bank-ai.js';
import * as funding from '../src/services/funding.js';

let ctx: Ctx;
const as = (login: string): Actor => actorFor(ctx.db, ctx.db.get('SELECT id FROM users WHERE login = ?', login).id, null, null);

beforeEach(() => {
  ctx = createCtx(':memory:');
  seedDemo(ctx);
});

/** One unmatched line paying an open request without its reference. */
function setup() {
  const prep = as('prep@companyb');
  const f = funding.createFunding(ctx, prep, { companyId: prep.companyId!, amountMinor: 1_234_500 });
  bank.importStatement(ctx, as('treasury@bousol'), 'Date,Reference,Description,Amount\n2026-10-15,UNI-77,Virement ENTREPRISE B SA,12345.00');
  const line = ctx.db.get("SELECT id FROM bank_transactions WHERE bank_reference = 'UNI-77'");
  return { f, lineId: line.id };
}

describe('AI bank match suggestions', () => {
  it('sends the line and open requests, keeps only real open requests, and flags the amount', async () => {
    const { f, lineId } = setup();
    let sent: any;
    const fake: Suggester = async (line, candidates, lang) => {
      sent = { line, candidates, lang };
      return { suggestions: [
        { reference: f.reference.toLowerCase(), confidence: 'high', reason: 'Nom de l’entreprise et montant exact' },
        { reference: 'TR-999999', confidence: 'low', reason: 'invented' },
        { reference: f.reference, confidence: 'medium', reason: 'duplicate' },
      ] };
    };
    const out = await suggestMatches(ctx, as('treasury@bousol'), lineId, 'fr', fake);
    expect(sent.lang).toBe('fr');
    expect(sent.line.memo).toBe('Virement ENTREPRISE B SA');
    expect(sent.candidates[0]).toMatchObject({ reference: f.reference, company: 'Entreprise B', amount_minor: 1_234_500 });
    expect(Object.keys(sent.candidates[0]).sort()).toEqual(['amount_minor', 'company', 'created_at', 'currency', 'reference']);
    expect(out.suggestions).toEqual([expect.objectContaining({ fundingId: f.id, reference: f.reference, confidence: 'high', amountMatches: true })]);

    // Suggestion only: the existing Match action still does the work and the checks.
    bank.matchTransaction(ctx, as('treasury@bousol'), lineId, out.suggestions[0].fundingId);
    expect(funding.getFunding(ctx, f.id).status).toBe('matched');
    await expect(suggestMatches(ctx, as('treasury@bousol'), lineId, 'fr', fake)).rejects.toThrow(/is matched/);
  });

  it('is limited to treasury and admin, and explains when AI is not set up', async () => {
    const { lineId } = setup();
    await expect(suggestMatches(ctx, as('approver@bousol'), lineId, 'en', async () => ({ suggestions: [] }))).rejects.toThrow();
    const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN };
    delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN;
    try {
      await expect(suggestMatches(ctx, as('treasury@bousol'), lineId, 'en', claudeSuggester)).rejects.toMatchObject({ code: 'ai_unavailable', status: 503 });
    } finally {
      if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key;
      if (saved.token !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved.token;
    }
  });
});
