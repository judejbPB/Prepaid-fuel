import { beforeEach, describe, expect, it } from 'vitest';
import { actorFor, type Actor } from '../src/auth.js';
import { createCtx, type Ctx } from '../src/context.js';
import { seedDemo } from '../src/demo.js';
import * as sage from '../src/services/sage.js';

let ctx: Ctx;
const as = (login: string): Actor => actorFor(ctx.db, ctx.db.get('SELECT id FROM users WHERE login = ?', login).id, null, null);
const ALL = { from: '2000-01-01', to: '2100-12-31', mode: 'detail' as const, onlyNew: true };

beforeEach(() => {
  ctx = createCtx(':memory:');
  seedDemo(ctx);
});

describe('Sage export', () => {
  it('turns the ledger into balanced entries on ALFA accounts, leaving out internal moves', () => {
    const out = sage.preview(ctx, as('treasury@bousol'), ALL);
    expect(out.entries.length).toBeGreaterThan(3);
    for (const e of out.entries) {
      expect(e.lines.reduce((s, l) => s + l.debit, 0)).toBe(e.lines.reduce((s, l) => s + l.credit, 0));
      for (const l of e.lines) expect(['512000', '419100', '701000', '758000', '467100']).toContain(l.account);
    }
    expect(out.totals.debit).toBe(out.totals.credit);
    // Allocations from a company to its employees stay inside 419100 for the same customer: no entry.
    const allocations = ctx.db.all("SELECT id FROM journal_entries WHERE kind = 'employee_allocation'").map((e) => `E${e.id}`);
    expect(allocations.length).toBeGreaterThan(0);
    expect(out.entries.filter((e) => allocations.includes(e.piece))).toEqual([]);
    // A deposit: bank debited, the client's prepayment account credited under its customer code.
    const deposit = out.entries.find((e) => e.label.startsWith('Dépôt'))!;
    expect(deposit.lines[0]).toMatchObject({ account: '512000', tiers: '' });
    expect(deposit.lines[1]).toMatchObject({ account: '419100', tiers: expect.stringMatching(/^ENTREPRISE[ABC]$/) });
    expect(deposit.lines[0].debit).toBe(deposit.lines[1].credit);
  });

  it('uses the codes finance sets, and only the admin can change them', () => {
    const admin = as('admin@bousol');
    const company = ctx.db.get("SELECT id FROM companies WHERE name = 'Entreprise A'");
    const station = ctx.db.get('SELECT id FROM stations ORDER BY id LIMIT 1');
    expect(() => sage.saveSettings(ctx, as('treasury@bousol'), { journal: 'VT' })).toThrow();
    expect(() => sage.saveSettings(ctx, admin, { accounts: { bank: '512 000' } })).toThrow(/Account codes/);
    sage.saveSettings(ctx, admin, {
      journal: 'vt', accounts: { bank: '521100', sales: '7011' },
      companies: [{ id: company.id, tiers: 'cliA' }], stations: [{ id: station.id, section: 'STN1' }],
    });
    const out = sage.preview(ctx, admin, { ...ALL, mode: 'summary' });
    expect(out.journal).toBe('VT');
    const lines = out.entries.flatMap((e) => e.lines);
    expect(lines.some((l) => l.account === '521100')).toBe(true);
    expect(lines.some((l) => l.tiers === 'CLIA')).toBe(true);
    expect(lines.filter((l) => l.account === '7011').every((l) => l.credit > 0)).toBe(true);
    expect(lines.some((l) => l.account === '7011' && l.section === 'STN1')).toBe(true);
  });

  it('summarises a day per kind, exports each ledger entry once and keeps past files', () => {
    const user = as('treasury@bousol');
    const first = sage.exportFile(ctx, user, { ...ALL, mode: 'summary', format: 'sage100' });
    const text = Buffer.from(first.contentBase64, 'base64').toString('latin1');
    const rows = text.trimEnd().split('\r\n');
    expect(rows[0].split(';')).toHaveLength(9);
    expect(rows[0]).toMatch(/^CARB;\d{6};[A-Z]\d{6}-1;/);
    expect(text).toContain('Dépôts clients activés'); // read back as Windows-1252
    expect(Buffer.from(first.contentBase64, 'base64').includes(Buffer.from([0xe9]))).toBe(true); // é
    expect(() => sage.exportFile(ctx, user, { ...ALL, format: 'sage100' })).toThrow(/Nothing to export/);
    expect(sage.preview(ctx, user, { ...ALL, onlyNew: false }).entries.length).toBeGreaterThan(0);
    expect(sage.downloadExport(ctx, user, first.id).contentBase64).toBe(first.contentBase64);
    expect(sage.listExports(ctx, user)).toMatchObject([{ id: 1, format: 'sage100', mode: 'summary' }]);
  });

  it('writes an Excel-friendly CSV with a header and French amounts', () => {
    const file = sage.exportFile(ctx, as('admin@bousol'), { ...ALL, format: 'csv' });
    const text = Buffer.from(file.contentBase64, 'base64').toString('utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const [header, line] = text.slice(1).split('\r\n');
    expect(header).toBe(sage.SAGE_COLUMNS.join(';'));
    expect(line).toMatch(/^CARB;\d{2}\/\d{2}\/\d{4};E\d+;512000;;;.+;\d+,\d{2};$/);
    expect(file.filename).toMatch(/^ALFA-Sage-0001-2000-01-01_2100-12-31\.csv$/);
  });

  it('dates entries in Haiti time', () => {
    const user = as('admin@bousol');
    const out = sage.preview(ctx, user, ALL);
    const anEntry = ctx.db.get("SELECT created_at FROM journal_entries WHERE kind = 'funding_activated' ORDER BY id LIMIT 1");
    const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Port-au-Prince' }).format(new Date(anEntry.created_at.replace(' ', 'T') + 'Z'));
    expect(out.entries.map((e) => e.date)).toContain(local);
    expect(sage.toCp1252('é’€✓').toJSON().data).toEqual([0xe9, 0x92, 0x80, 0x3f]);
  });
});
