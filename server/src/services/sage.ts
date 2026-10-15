// Accounting export for Sage. Turns the platform ledger into journal entries for ALFA's books, using the
// account codes finance sets once (bank, customer prepayments, fuel sales, breakage, refunds payable), a
// customer code (compte tiers) per client company and an optional analytic section per station.
//
// Internal moves (company → employee, employee → reserved) stay inside the customer prepayment account and
// net to zero, so Sage only sees what changes ALFA's books: deposits, fuel sold, refunds, expirations.
// Each ledger entry is exported once; a past export can be downloaded again, unchanged.
import { DISTRIBUTOR, requireRole, type Actor } from '../auth.js';
import type { Ctx } from '../context.js';
import { badRequest, notFound } from '../errors.js';
import { localizeMemo } from '../i18n-ledger.js';

export const SAGE_TIME_ZONE = 'America/Port-au-Prince';

type Category = 'bank' | 'customer' | 'sales' | 'breakage' | 'refunds';
export const CATEGORIES: Category[] = ['bank', 'customer', 'sales', 'breakage', 'refunds'];

/** Defaults follow the French chart of accounts most Sage 100 files use; finance replaces them with theirs. */
const DEFAULTS: Record<string, string> = {
  journal: 'CARB',
  'account.bank': '512000',
  'account.customer': '419100',
  'account.sales': '701000',
  'account.breakage': '758000',
  'account.refunds': '467100',
};

const CODE = /^[A-Za-z0-9]{1,13}$/;
const TIERS = /^[A-Za-z0-9]{1,17}$/;
const JOURNAL = /^[A-Za-z0-9]{1,6}$/;

/** "Entreprise A" → "ENTREPRISEA" (Sage codes: letters and digits only). */
const codeFrom = (name: string, max: number) =>
  name.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, max) || 'X';

function readSettings(ctx: Ctx) {
  const stored = new Map(ctx.db.all<{ key: string; value: string }>('SELECT key, value FROM sage_settings').map((r) => [r.key, r.value]));
  const get = (key: string, fallback: string) => stored.get(key) ?? fallback;
  const companies = ctx.db.all<{ id: number; name: string }>('SELECT id, name FROM companies ORDER BY name')
    .map((c) => ({ ...c, tiers: get(`tiers.company.${c.id}`, codeFrom(c.name, 17)) }));
  const stations = ctx.db.all<{ id: number; name: string }>('SELECT id, name FROM stations ORDER BY name')
    .map((s) => ({ ...s, section: get(`section.station.${s.id}`, '') }));
  const accounts = Object.fromEntries(CATEGORIES.map((c) => [c, get(`account.${c}`, DEFAULTS[`account.${c}`])])) as Record<Category, string>;
  return { journal: get('journal', DEFAULTS.journal), accounts, companies, stations };
}

export function getSettings(ctx: Ctx, actor: Actor) {
  requireRole(actor, DISTRIBUTOR);
  return readSettings(ctx);
}

export interface SettingsInput {
  journal?: string;
  accounts?: Partial<Record<Category, string>>;
  companies?: { id: number; tiers: string }[];
  stations?: { id: number; section: string }[];
}

export function saveSettings(ctx: Ctx, actor: Actor, input: SettingsInput) {
  requireRole(actor, ['dist_admin']);
  const writes: [string, string][] = [];
  if (input.journal !== undefined) {
    if (!JOURNAL.test(input.journal)) throw badRequest('bad_code', 'Journal code: 1 to 6 letters or digits');
    writes.push(['journal', input.journal.toUpperCase()]);
  }
  for (const [cat, code] of Object.entries(input.accounts ?? {})) {
    if (!CATEGORIES.includes(cat as Category) || code === undefined) continue;
    if (!CODE.test(code)) throw badRequest('bad_code', 'Account codes: 1 to 13 letters or digits');
    writes.push([`account.${cat}`, code.toUpperCase()]);
  }
  for (const c of input.companies ?? []) {
    if (!TIERS.test(c.tiers)) throw badRequest('bad_code', 'Customer codes: 1 to 17 letters or digits');
    writes.push([`tiers.company.${c.id}`, c.tiers.toUpperCase()]);
  }
  for (const s of input.stations ?? []) {
    if (s.section !== '' && !CODE.test(s.section)) throw badRequest('bad_code', 'Analytic sections: up to 13 letters or digits');
    writes.push([`section.station.${s.id}`, s.section.toUpperCase()]);
  }
  ctx.db.tx(() => {
    for (const [key, value] of writes) {
      ctx.db.run('INSERT INTO sage_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
    }
    ctx.db.audit(actor.userId, 'sage.settings', 'sage_settings', null, Object.fromEntries(writes));
  });
  return readSettings(ctx);
}

// ---- building the entries

export interface SageLine { account: string; tiers: string; section: string; label: string; debit: number; credit: number }
export interface SageEntry { piece: string; date: string; label: string; lines: SageLine[] }

const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: SAGE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
/** Ledger timestamps are UTC ("2026-10-15 23:10:00"); books are kept in Haiti time. */
const toLocalDate = (utc: string) => localDate.format(new Date(utc.replace(' ', 'T') + 'Z'));

/** Groups for the daily summary: one Sage entry per day per group. */
const GROUP: Record<string, { letter: string; label: string }> = {
  funding_activated: { letter: 'D', label: 'Dépôts clients activés' },
  fuel_confirmed: { letter: 'V', label: 'Ventes de carburant' },
  offline_sale: { letter: 'V', label: 'Ventes de carburant' },
  redemption_reserved: { letter: 'V', label: 'Ventes de carburant' },
  refund_approved: { letter: 'R', label: 'Remboursements approuvés' },
  refund_paid: { letter: 'P', label: 'Remboursements payés' },
  expiration: { letter: 'E', label: 'Soldes expirés' },
};
const OTHER_GROUP = { letter: 'A', label: 'Corrections et ajustements' };

const fit = (s: string, max: number) => s.replace(/[;\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const shortDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

interface LedgerRow { entry_id: number; kind: string; memo: string | null; created_at: string; account: string; debit: number; credit: number }

export interface ExportOptions { from: string; to: string; mode: 'summary' | 'detail'; onlyNew: boolean }

/** Ledger entries in the period (Haiti dates), mapped and netted into balanced Sage entries. */
function build(ctx: Ctx, opts: ExportOptions & { exportNo: number }) {
  const s = readSettings(ctx);
  const tiersOf = new Map(s.companies.map((c) => [c.id, c.tiers]));
  const sectionOf = new Map(s.stations.map((st) => [st.id, st.section]));
  const companyOfEmployee = new Map(ctx.db.all<{ id: number; company_id: number }>('SELECT id, company_id FROM employees').map((e) => [e.id, e.company_id]));

  const map = (account: string): { account: string; tiers: string; section: string } => {
    let m: RegExpMatchArray | null;
    if (account === 'dist:bank_verified') return { account: s.accounts.bank, tiers: '', section: '' };
    if (account === 'dist:refunds_payable') return { account: s.accounts.refunds, tiers: '', section: '' };
    if ((m = account.match(/^co:(\d+):unallocated$/))) return { account: s.accounts.customer, tiers: tiersOf.get(+m[1]) ?? '', section: '' };
    if ((m = account.match(/^emp:(\d+):(available|reserved)$/))) {
      return { account: s.accounts.customer, tiers: tiersOf.get(companyOfEmployee.get(+m[1]) ?? -1) ?? '', section: '' };
    }
    if (account.match(/^co:\d+:expired$/)) return { account: s.accounts.breakage, tiers: '', section: '' };
    if ((m = account.match(/^stn:(\d+):clearing$/))) return { account: s.accounts.sales, tiers: '', section: sectionOf.get(+m[1]) ?? '' };
    throw badRequest('unmapped_account', `No Sage account for ledger account ${account}`);
  };

  // Widen the UTC window by a day each side, then keep entries whose Haiti date is in the period.
  const rows = ctx.db.all<LedgerRow>(
        `SELECT je.id AS entry_id, je.kind, je.memo, je.created_at, jl.account, jl.debit, jl.credit
           FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id
          WHERE je.created_at >= date(?, '-1 day') AND je.created_at < date(?, '+2 day')
            ${opts.onlyNew ? 'AND je.id NOT IN (SELECT entry_id FROM sage_exported_entries)' : ''}
          ORDER BY je.id, jl.id`,
        opts.from, opts.to)
        .filter((r) => { const d = toLocalDate(r.created_at); return d >= opts.from && d <= opts.to; });

  const entryIds = [...new Set(rows.map((r) => r.entry_id))];
  type Bucket = { piece: string; date: string; label: string; sums: Map<string, { key: { account: string; tiers: string; section: string }; net: number }> };
  const buckets = new Map<string, Bucket>();
  const yymmdd = (d: string) => d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10);

  for (const r of rows) {
    const date = toLocalDate(r.created_at);
    let id: string; let piece: string; let label: string;
    if (opts.mode === 'detail') {
      id = `e${r.entry_id}`;
      piece = `E${r.entry_id}`;
      label = localizeMemo(r.memo ?? '', 'fr') || (GROUP[r.kind] ?? OTHER_GROUP).label;
    } else {
      const g = GROUP[r.kind] ?? OTHER_GROUP;
      id = `${date}:${g.letter}`;
      piece = `${g.letter}${yymmdd(date)}-${opts.exportNo}`;
      label = `${g.label} ${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(2, 4)}`; // fits Sage's 35 characters
    }
    let b = buckets.get(id);
    if (!b) buckets.set(id, (b = { piece, date, label, sums: new Map() }));
    const key = map(r.account);
    const k = `${key.account}|${key.tiers}|${key.section}`;
    const cur = b.sums.get(k) ?? { key, net: 0 };
    cur.net += Number(r.debit) - Number(r.credit);
    b.sums.set(k, cur);
  }

  const entries: SageEntry[] = [];
  for (const b of buckets.values()) {
    const lines = [...b.sums.values()].filter((x) => x.net !== 0).map((x) => ({
      ...x.key, label: fit(b.label, 35), debit: x.net > 0 ? x.net : 0, credit: x.net < 0 ? -x.net : 0,
    }));
    // Debits first, then by account: how accountants read an entry.
    lines.sort((a, z) => (z.debit > 0 ? 1 : 0) - (a.debit > 0 ? 1 : 0) || a.account.localeCompare(z.account) || a.tiers.localeCompare(z.tiers));
    if (lines.length) entries.push({ piece: fit(b.piece, 13), date: b.date, label: fit(b.label, 35), lines });
  }
  entries.sort((a, z) => a.date.localeCompare(z.date) || a.piece.localeCompare(z.piece, undefined, { numeric: true }));
  const debit = entries.reduce((t, e) => t + e.lines.reduce((u, l) => u + l.debit, 0), 0);
  const credit = entries.reduce((t, e) => t + e.lines.reduce((u, l) => u + l.credit, 0), 0);
  return { journal: s.journal, entries, entryIds, totals: { debit, credit, lines: entries.reduce((t, e) => t + e.lines.length, 0) } };
}

// ---- files

export type SageFormat = 'sage100' | 'csv';

const amount = (minor: number) => (minor ? (minor / 100).toFixed(2).replace('.', ',') : '');

/** Windows-1252, the encoding Sage 100 imports expect. Characters outside it become "?". */
const CP1252_EXTRA: Record<string, number> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b,
  'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99,
  'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};
export function toCp1252(text: string): Buffer {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) out.push(c);
    else out.push(CP1252_EXTRA[ch] ?? 0x3f);
  }
  return Buffer.from(out);
}

export const SAGE_COLUMNS = ['Code journal', 'Date', 'N° pièce', 'Compte général', 'Compte tiers', 'Section analytique', 'Libellé', 'Débit', 'Crédit'];

/**
 * sage100: no header, ";" separated, dates DDMMYY, Windows-1252, CRLF: for a Sage 100 parameterised import
 * whose columns are set up once in the order of SAGE_COLUMNS.
 * csv: same columns with a header, dates DD/MM/YYYY, UTF-8: opens in Excel and suits Sage 50 / other imports.
 */
export function renderFile(journal: string, entries: SageEntry[], format: SageFormat): Buffer {
  const rows: string[] = [];
  if (format === 'csv') rows.push(SAGE_COLUMNS.join(';'));
  for (const e of entries) {
    const d = format === 'sage100' ? `${e.date.slice(8, 10)}${e.date.slice(5, 7)}${e.date.slice(2, 4)}` : shortDate(e.date);
    for (const l of e.lines) {
      rows.push([journal, d, e.piece, l.account, l.tiers, l.section, l.label, amount(l.debit), amount(l.credit)].join(';'));
    }
  }
  const text = rows.join('\r\n') + '\r\n';
  return format === 'sage100' ? toCp1252(text) : Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
}

const nextExportNo = (ctx: Ctx) => Number(ctx.db.get('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM sage_exports')!.n);

function checkPeriod(opts: ExportOptions) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.from) || !/^\d{4}-\d{2}-\d{2}$/.test(opts.to) || opts.from > opts.to) {
    throw badRequest('bad_period', 'Choose a start date on or before the end date');
  }
}

export function preview(ctx: Ctx, actor: Actor, opts: ExportOptions) {
  requireRole(actor, DISTRIBUTOR);
  checkPeriod(opts);
  const out = build(ctx, { ...opts, exportNo: nextExportNo(ctx) });
  return { journal: out.journal, entries: out.entries, totals: out.totals, ledgerEntries: out.entryIds.length };
}

const fileName = (id: number, from: string, to: string, format: SageFormat) =>
  `ALFA-Sage-${String(id).padStart(4, '0')}-${from}_${to}.${format === 'sage100' ? 'txt' : 'csv'}`;

/** Records the export (so its ledger entries are not exported twice) and returns the file. */
export function exportFile(ctx: Ctx, actor: Actor, opts: ExportOptions & { format: SageFormat }) {
  requireRole(actor, DISTRIBUTOR);
  checkPeriod(opts);
  return ctx.db.tx(() => {
    const exportNo = nextExportNo(ctx);
    const out = build(ctx, { ...opts, exportNo });
    if (!out.entries.length) throw badRequest('nothing_to_export', 'Nothing to export for this period');
    const file = renderFile(out.journal, out.entries, opts.format);
    ctx.db.run(
      `INSERT INTO sage_exports (id, date_from, date_to, mode, format, entries, lines, debit_minor, filename, file, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      exportNo, opts.from, opts.to, opts.mode, opts.format, out.entries.length, out.totals.lines, out.totals.debit,
      fileName(exportNo, opts.from, opts.to, opts.format), file, actor.userId,
    );
    for (const id of out.entryIds) ctx.db.run('INSERT OR IGNORE INTO sage_exported_entries (entry_id, export_id) VALUES (?, ?)', id, exportNo);
    ctx.db.audit(actor.userId, 'sage.export', 'sage_export', exportNo, { from: opts.from, to: opts.to, mode: opts.mode, format: opts.format, entries: out.entries.length });
    return { id: exportNo, filename: fileName(exportNo, opts.from, opts.to, opts.format), contentBase64: file.toString('base64'), entries: out.entries.length, totals: out.totals };
  });
}

export function listExports(ctx: Ctx, actor: Actor) {
  requireRole(actor, DISTRIBUTOR);
  return ctx.db.all(
    `SELECT x.id, x.date_from, x.date_to, x.mode, x.format, x.entries, x.lines, x.debit_minor, x.filename, x.created_at,
            u.name AS created_by_name FROM sage_exports x LEFT JOIN users u ON u.id = x.created_by ORDER BY x.id DESC LIMIT 100`,
  );
}

/** A past export, byte for byte the file that was downloaded then. */
export function downloadExport(ctx: Ctx, actor: Actor, exportId: number) {
  requireRole(actor, DISTRIBUTOR);
  const x = ctx.db.get('SELECT id, filename, file FROM sage_exports WHERE id = ?', exportId);
  if (!x) throw notFound('Sage export');
  return { id: x.id, filename: x.filename, contentBase64: Buffer.from(x.file).toString('base64') };
}
