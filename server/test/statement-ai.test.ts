import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { actorFor, type Actor } from '../src/auth.js';
import { createCtx, type Ctx } from '../src/context.js';
import { seedDemo } from '../src/demo.js';
import * as bank from '../src/services/bank.js';
import * as funding from '../src/services/funding.js';
import { claudeStatementReader, readStatement, type StatementReader } from '../src/services/statement-ai.js';

let ctx: Ctx;
const as = (login: string): Actor => actorFor(ctx.db, ctx.db.get('SELECT id FROM users WHERE login = ?', login).id, null, null);
const pdf = () => readFileSync(new URL('./fixtures/releve-banque.pdf', import.meta.url)).toString('base64');

beforeEach(() => {
  ctx = createCtx(':memory:');
  seedDemo(ctx);
});

describe('AI statement reader', () => {
  it('turns a PDF into a checked preview that the normal import then matches', async () => {
    const prep = as('prep@companyb');
    const f = funding.createFunding(ctx, prep, { companyId: prep.companyId!, amountMinor: 1_000_000 });
    let got: any;
    const fake: StatementReader = async (source) => {
      got = source;
      return {
        notes: '',
        credits: [
          { date: '2026-10-12', reference: 'UNI-X1', description: `Virement Entreprise B ${f.reference}`, amount: '10000.00', currency: 'HTG' },
          { date: '14/10/2026', reference: '', description: 'Dépôt, "espèces"', amount: '5 000,50', currency: '' },
          { date: '2026-10-14', reference: '', description: 'Dépôt', amount: '5000.50', currency: 'htg' },
          { date: '2026-10-15', reference: 'UNI-X9', description: 'illisible', amount: 'n/a', currency: 'HTG' },
        ],
      };
    };
    const out = await readStatement(ctx, as('treasury@bousol'), { pdf: pdf() }, fake);
    expect(got.kind).toBe('pdf');
    expect(out.dropped).toBe(1);
    expect(out.lines.map((l) => [l.reference, l.amountMinor, l.date])).toEqual([
      ['UNI-X1', 1_000_000, '2026-10-12'],
      ['AUTO-SANS-DATE-500050-1', 500_050, ''],
      ['AUTO-2026-10-14-500050-1', 500_050, '2026-10-14'],
    ]);
    expect(out.lines[1].generatedReference).toBe(true);
    expect(out.lines[2].currency).toBe('HTG');

    // Nothing imported yet; the preview's CSV goes through the normal import and its matching.
    expect(ctx.db.get('SELECT COUNT(*) AS n FROM bank_transactions').n).toBe(0);
    const imported = bank.importStatement(ctx, as('treasury@bousol'), out.csv);
    expect(imported).toMatchObject({ imported: 3, matched: [f.reference], unmatched: 2 });
    expect(ctx.db.get("SELECT memo FROM bank_transactions WHERE bank_reference = 'AUTO-SANS-DATE-500050-1'").memo).toBe('Dépôt, "espèces"');
    // Reading the same statement again gives the same references, so a second import is caught as duplicates.
    const again = await readStatement(ctx, as('treasury@bousol'), { pdf: pdf() }, fake);
    expect(bank.importStatement(ctx, as('treasury@bousol'), again.csv).duplicates).toBe(3);
  });

  it('sends Excel and CSV as text, and checks the file and the role', async () => {
    let got: any;
    const fake: StatementReader = async (source) => { got = source; return { credits: [], notes: 'Page 2 illisible' }; };
    const xlsx = readFileSync(new URL('./fixtures/releve-banque.xlsx', import.meta.url)).toString('base64');
    const out = await readStatement(ctx, as('admin@bousol'), { xlsx }, fake);
    expect(got.kind).toBe('text');
    expect(got.text).toContain('Crédit');
    expect(out).toMatchObject({ lines: [], notes: 'Page 2 illisible' });
    await expect(readStatement(ctx, as('treasury@bousol'), { pdf: Buffer.from('hello world').toString('base64') }, fake)).rejects.toThrow(/not a PDF/);
    await expect(readStatement(ctx, as('approver@bousol'), { csv: 'a,b\n1,2' }, fake)).rejects.toThrow();
    const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN };
    delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN;
    try {
      await expect(readStatement(ctx, as('treasury@bousol'), { pdf: pdf() }, claudeStatementReader)).rejects.toMatchObject({ code: 'ai_unavailable' });
    } finally {
      if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key;
      if (saved.token !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved.token;
    }
  });
});
