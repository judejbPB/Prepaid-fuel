import { beforeEach, describe, expect, it } from 'vitest';
import { actorFor, type Actor } from '../src/auth.js';
import { createCtx, type Ctx } from '../src/context.js';
import { seedDemo } from '../src/demo.js';
import { askReports, todayInHaiti, type ModelTurn } from '../src/services/reports-ai.js';

let ctx: Ctx;
const as = (login: string): Actor => actorFor(ctx.db, ctx.db.get('SELECT id FROM users WHERE login = ?', login).id, null, null);
const today = () => todayInHaiti();

const msg = (content: any[], stop: string) => ({ id: 'm', type: 'message', role: 'assistant', model: 'x', content, stop_reason: stop, usage: {} }) as any;
const callTool = (name: string, input: any) => msg([{ type: 'tool_use', id: `t-${name}`, name, input }], 'tool_use');
const say = (text: string) => msg([{ type: 'text', text }], 'end_turn');

/** A scripted model: returns the steps in order and records what it was sent. */
function script(...steps: ((sent: any) => any)[]) {
  const seen: any[] = [];
  const turn: ModelTurn = async (req) => { seen.push(structuredClone(req)); return steps[seen.length - 1](req); };
  return { turn, seen };
}

beforeEach(() => {
  ctx = createCtx(':memory:');
  seedDemo(ctx);
});

describe('reports assistant', () => {
  it('answers from the report tools and puts employee names back for the user', async () => {
    const { turn, seen } = script(
      () => callTool('fuel_sales', { from: today(), to: today(), group_by: 'employee', company_id: null, station_id: null, grade: null, limit: 5 }),
      (req) => {
        const rows = JSON.parse(req.messages.at(-1).content[0].content);
        return say(`${rows[0].group} a fait le plus de pleins aujourd’hui : ${rows[0].fuelings} pleins, ${rows[0].gallons} gal.`);
      },
    );
    const out = await askReports(ctx, as('admin@bousol'), { question: 'Qui a fait le plus de pleins aujourd’hui ?' }, 'fr', turn);
    expect(out.answer).toBe('Jean P. a fait le plus de pleins aujourd’hui : 2 pleins, 32 gal.');
    expect(out.sources[0]).toMatchObject({ tool: 'fuel_sales', rows: [{ group: 'Jean P.', fuelings: 2, gallons: 32 }, expect.anything()] });
    // Claude never saw a name: only placeholders, company and station names.
    const sent = JSON.stringify(seen);
    for (const e of ctx.db.all('SELECT name FROM employees')) expect(sent).not.toContain(e.name);
    expect(sent).toContain('[[emp:');
    expect(seen[0].system).toContain(`Today is ${today()}`);
    expect(ctx.db.get("SELECT action FROM audit_log WHERE entity = 'report'").action).toBe('report.ai_question');
  });

  it('keeps a company user to their own company', async () => {
    const a = ctx.db.get("SELECT id FROM companies WHERE name = 'Entreprise A'").id;
    const { turn, seen } = script(
      () => callTool('fuel_sales', { from: today(), to: today(), group_by: 'none', company_id: a, station_id: null, grade: null, limit: null }),
      () => callTool('fuel_sales', { from: today(), to: today(), group_by: 'none', company_id: null, station_id: null, grade: null, limit: null }),
      () => say('Aucun plein pour votre entreprise aujourd’hui.'),
    );
    const out = await askReports(ctx, as('prep@companyb'), { question: 'Combien a consommé Entreprise A ?' }, 'fr', turn);
    const first = seen[1].messages.at(-1).content[0];
    expect(first).toMatchObject({ is_error: true, content: 'This user can only see their own company.' });
    expect(out.sources[1].rows).toEqual([{ group: 'total', fuelings: 0, gallons: 0, htg: 0 }]); // Entreprise B: nothing today
    expect(seen[0].system).toContain('Client companies: ');
    expect(seen[0].system).not.toContain('Entreprise A');
  });

  it('keeps a station manager to their station, and hides names outside it', async () => {
    const manager = ctx.db.get("SELECT login, station_id FROM users WHERE role = 'st_manager' AND station_id != (SELECT station_id FROM redemptions LIMIT 1) LIMIT 1");
    const { turn, seen } = script(
      () => callTool('balances', { company_id: null }),
      () => say('[[emp:1]] — pas d’accès aux soldes.'),
    );
    const out = await askReports(ctx, as(manager.login), { question: 'Soldes des entreprises ?' }, 'fr', turn);
    expect(seen[1].messages.at(-1).content[0]).toMatchObject({ is_error: true });
    expect(out.answer).toBe('un employé — pas d’accès aux soldes.');
  });

  it('stops after a few rounds, and refuses users with no reports', async () => {
    const loop = () => callTool('refunds', { from: today(), to: today(), company_id: null, station_id: null });
    const { turn } = script(loop, loop, loop, loop, loop, loop, loop);
    await expect(askReports(ctx, as('admin@bousol'), { question: 'Remboursements ?' }, 'fr', turn)).rejects.toMatchObject({ code: 'ai_timeout' });
    const employee = ctx.db.get("SELECT user_id FROM employees WHERE user_id IS NOT NULL LIMIT 1").user_id;
    await expect(askReports(ctx, actorFor(ctx.db, employee, null, null), { question: 'Mon solde ?' }, 'fr', turn)).rejects.toThrow();
  });
});
