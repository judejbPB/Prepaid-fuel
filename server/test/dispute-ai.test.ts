import { beforeEach, describe, expect, it } from 'vitest';
import { actorFor, type Actor } from '../src/auth.js';
import { createCtx, type Ctx } from '../src/context.js';
import { seedDemo } from '../src/demo.js';
import { adviseOnDispute, claudeDisputeAdvisor, replyToDispute, type DisputeAdvisor } from '../src/services/dispute-ai.js';
import * as exc from '../src/services/exceptions.js';

let ctx: Ctx;
const as = (login: string): Actor => actorFor(ctx.db, ctx.db.get('SELECT id FROM users WHERE login = ?', login).id, null, null);
const asUser = (userId: number): Actor => actorFor(ctx.db, userId, null, null);

beforeEach(() => {
  ctx = createCtx(':memory:');
  seedDemo(ctx);
});

/** The employee of the first completed fueling disputes it. */
function openDispute() {
  const r = ctx.db.get("SELECT r.*, e.user_id FROM redemptions r JOIN employees e ON e.id = r.employee_id WHERE r.status = 'completed' ORDER BY r.id LIMIT 1");
  const employee = asUser(r.user_id);
  const e = exc.raiseDispute(ctx, employee, r.id, 'La pompe affichait 10 gal, on m’a débité 12 gal');
  return { r, e, employee };
}

describe('AI dispute help', () => {
  it('sends the facts without names, keeps the suggestion within what was charged, and changes nothing', async () => {
    const { r, e } = openDispute();
    let facts: any;
    const fake: DisputeAdvisor = async (f, lang) => {
      facts = { ...f, lang };
      return {
        summary: ['Débité 12 gal ; le reçu indique 12 gal.'], checks: ['Compteur de la pompe 1'],
        suggestion: { action: 'refund', amount: '999999', why: 'Écart possible' },
        reply_fr: 'Bonjour, nous vérifions votre plein.', reply_ht: 'Bonjou, n ap verifye plen ou a.',
      };
    };
    const out = await adviseOnDispute(ctx, as('approver@bousol'), e.id, 'fr', fake);
    expect(facts.lang).toBe('fr');
    expect(facts.dispute.employee_says).toContain('10 gal');
    expect(facts.fueling).toMatchObject({ pump: r.pump, dispensed_gal: r.dispensed_mgal / 1000, charged_htg: r.charged_minor / 100 });
    const sent = JSON.stringify(facts);
    for (const name of ctx.db.all('SELECT name FROM employees').map((x: any) => x.name)) expect(sent).not.toContain(name);
    expect(sent).not.toMatch(/509\d{8}/);
    expect(out.suggestion).toEqual({ action: 'refund', amountMinor: null, why: 'Écart possible' }); // over the charge: no amount
    expect(out.replies.ht).toContain('Bonjou');
    expect(exc.getException(ctx, e.id)).toMatchObject({ status: 'open', proposal: null, messages: [] });

    const ok = await adviseOnDispute(ctx, as('approver@bousol'), e.id, 'en', async () => ({
      summary: [], checks: [], suggestion: { action: 'refund', amount: (r.charged_minor / 200).toFixed(2), why: 'x' }, reply_fr: '', reply_ht: '',
    }));
    expect(ok.suggestion.amountMinor).toBe(Math.round(r.charged_minor / 2));
  });

  it('lets the station manager or distributor reply; the employee sees it on their dispute', async () => {
    const { e, employee, r } = openDispute();
    const manager = ctx.db.get("SELECT login FROM users WHERE role = 'st_manager' AND station_id = ?", r.station_id).login;
    const other = ctx.db.get("SELECT login FROM users WHERE role = 'st_manager' AND station_id != ?", r.station_id).login;
    expect(() => replyToDispute(ctx, as(other), e.id, 'Bonjour')).toThrow();
    expect(() => replyToDispute(ctx, as('prep@companya'), e.id, 'Bonjour')).toThrow();
    replyToDispute(ctx, as(manager), e.id, 'Bonjour, nous vérifions le compteur de la pompe.');
    const seen = exc.listExceptions(ctx, employee).find((x: any) => x.id === e.id);
    expect(seen.messages).toEqual([expect.objectContaining({ body: 'Bonjour, nous vérifions le compteur de la pompe.' })]);
    expect(ctx.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'exception.reply'").n).toBe(1);
  });

  it('only works on disputes, and explains when AI is not set up', async () => {
    const { e } = openDispute();
    const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN };
    delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN;
    try {
      await expect(adviseOnDispute(ctx, as('admin@bousol'), e.id, 'fr', claudeDisputeAdvisor)).rejects.toMatchObject({ code: 'ai_unavailable' });
    } finally {
      if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key;
      if (saved.token !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved.token;
    }
    const variance = ctx.db.run("INSERT INTO exceptions (kind, ref_type, ref_id, summary) VALUES ('shift_variance', 'shift', 1, 'x')").id;
    await expect(adviseOnDispute(ctx, as('admin@bousol'), variance, 'fr', async () => { throw new Error('not called'); })).rejects.toThrow(/Only disputes/);
  });
});
