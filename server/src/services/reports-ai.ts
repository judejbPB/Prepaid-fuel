// Reports assistant: staff ask a question in plain French or English ("combien de diesel Entreprise B ce mois-ci ?")
// and Claude answers from the platform's figures. It cannot query the database freely: it calls a fixed set of
// read-only report tools below, and every tool is limited to what the signed-in user may see (the distributor sees
// everything; a company user only their company; a station manager only their station). It never changes anything.
//
// Employees and attendants are sent to Claude as [[emp:ID]] / [[user:ID]] placeholders, never by name; the server
// puts the names back into the answer for the user, within their scope.
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { COMPANY, DISTRIBUTOR, type Actor } from '../auth.js';
import type { Ctx } from '../context.js';
import { AppError, forbidden } from '../errors.js';
import type { Lang } from '../i18n.js';
import { acct } from '../ledger.js';
import { AI_MODEL } from './bank-ai.js';
import { sumAccounts } from './reports.js';

const TZ = 'America/Port-au-Prince';
const DEADLINE_MS = 50_000; // the hosted API function stops at 60 seconds
const MAX_TURNS = 6;

// ---------------------------------------------------------------- scope

interface Scope { kind: 'distributor' | 'company' | 'station'; companyId: number | null; stationId: number | null }

function scopeOf(actor: Actor): Scope {
  if (DISTRIBUTOR.includes(actor.role)) return { kind: 'distributor', companyId: null, stationId: null };
  if (COMPANY.includes(actor.role) && actor.companyId) return { kind: 'company', companyId: actor.companyId, stationId: null };
  if (actor.role === 'st_manager' && actor.stationId) return { kind: 'station', companyId: null, stationId: actor.stationId };
  throw forbidden();
}

/** Applies the user's scope to a tool's filters; a filter outside the scope is an error the model sees. */
function scoped(scope: Scope, input: { company_id?: number | null; station_id?: number | null }) {
  const companyId = scope.companyId ?? input.company_id ?? null;
  const stationId = scope.stationId ?? input.station_id ?? null;
  if (scope.companyId && input.company_id && input.company_id !== scope.companyId) throw new ToolError('This user can only see their own company.');
  if (scope.stationId && input.station_id && input.station_id !== scope.stationId) throw new ToolError('This user can only see their own station.');
  return { companyId, stationId };
}

class ToolError extends Error {}

// ---------------------------------------------------------------- dates (Haiti time)

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const haitiDay = (utc: string) => dayFmt.format(new Date(utc.replace(' ', 'T') + 'Z'));
export const todayInHaiti = () => dayFmt.format(new Date());
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** UTC bounds a day wider than the Haiti period; rows are then filtered on their Haiti date. */
const utcWindow = (from: string, to: string) => [`${from} 00:00:00`, `${to} 23:59:59`].map((d, i) => {
  const t = new Date(d.replace(' ', 'T') + 'Z'); t.setUTCDate(t.getUTCDate() + (i === 0 ? -1 : 1)); return t.toISOString().replace('T', ' ').slice(0, 19);
});

const gal = (mgal: number) => Math.round(mgal / 10) / 100;
const htg = (minor: number) => Math.round(minor) / 100;

// ---------------------------------------------------------------- tools

const SalesInput = z.object({
  from: DATE, to: DATE,
  group_by: z.enum(['none', 'company', 'station', 'grade', 'day', 'month', 'employee', 'attendant']),
  company_id: z.number().int().nullable().optional(), station_id: z.number().int().nullable().optional(),
  grade: z.enum(['diesel', 'gasoline']).nullable().optional(),
  limit: z.number().int().min(1).max(50).nullable().optional(),
});
const PeriodInput = z.object({ from: DATE, to: DATE, company_id: z.number().int().nullable().optional(), station_id: z.number().int().nullable().optional() });
const DepositsInput = PeriodInput.extend({ group_by: z.enum(['none', 'company', 'month']) });
const BalancesInput = z.object({ company_id: z.number().int().nullable().optional() });

type Rows = Record<string, unknown>[];

function fuelSales(ctx: Ctx, scope: Scope, raw: unknown): Rows {
  const q = SalesInput.parse(raw);
  const { companyId, stationId } = scoped(scope, q);
  const [a, b] = utcWindow(q.from, q.to);
  const sales = ctx.db.all<any>(
    `SELECT r.employee_id, r.attendant_id, r.grade, r.dispensed_mgal, r.charged_minor, r.completed_at, c.name AS company, s.name AS station
       FROM redemptions r JOIN companies c ON c.id = r.company_id JOIN stations s ON s.id = r.station_id
      WHERE r.status = 'completed' AND r.completed_at BETWEEN ? AND ?
        ${companyId ? 'AND r.company_id = ?' : ''} ${stationId ? 'AND r.station_id = ?' : ''} ${q.grade ? 'AND r.grade = ?' : ''}`,
    a, b, ...([companyId, stationId, q.grade].filter((x) => x != null) as (number | string)[]),
  ).filter((s) => { const d = haitiDay(s.completed_at); return d >= q.from && d <= q.to; });
  const keyOf = (s: any): string => {
    switch (q.group_by) {
      case 'company': return s.company;
      case 'station': return s.station;
      case 'grade': return s.grade;
      case 'day': return haitiDay(s.completed_at);
      case 'month': return haitiDay(s.completed_at).slice(0, 7);
      case 'employee': return `[[emp:${s.employee_id}]]`;
      case 'attendant': return `[[user:${s.attendant_id}]]`;
      default: return 'total';
    }
  };
  const groups = new Map<string, { fuelings: number; mgal: number; minor: number }>();
  for (const s of sales) {
    const g = groups.get(keyOf(s)) ?? { fuelings: 0, mgal: 0, minor: 0 };
    g.fuelings++; g.mgal += s.dispensed_mgal ?? 0; g.minor += s.charged_minor ?? 0;
    groups.set(keyOf(s), g);
  }
  const rows = [...groups].map(([group, g]) => ({ group, fuelings: g.fuelings, gallons: gal(g.mgal), htg: htg(g.minor) }));
  if (q.group_by === 'day' || q.group_by === 'month') rows.sort((x, y) => x.group.localeCompare(y.group));
  else rows.sort((x, y) => y.htg - x.htg);
  return rows.length ? rows.slice(0, q.limit ?? 31) : [{ group: 'total', fuelings: 0, gallons: 0, htg: 0 }];
}

function deposits(ctx: Ctx, scope: Scope, raw: unknown): Rows {
  if (scope.kind === 'station') throw new ToolError('Station managers cannot see client deposits.');
  const q = DepositsInput.parse(raw);
  const { companyId } = scoped(scope, q);
  const [a, b] = utcWindow(q.from, q.to);
  const rows = ctx.db.all<any>(
    `SELECT f.approved_at, COALESCE(f.bank_amount_minor, f.amount_minor) AS minor, c.name AS company FROM funding_requests f
       JOIN companies c ON c.id = f.company_id
      WHERE f.status = 'approved' AND f.approved_at BETWEEN ? AND ? ${companyId ? 'AND f.company_id = ?' : ''}`,
    a, b, ...(companyId ? [companyId] : []),
  ).filter((f) => { const d = haitiDay(f.approved_at); return d >= q.from && d <= q.to; });
  const groups = new Map<string, { deposits: number; minor: number }>();
  for (const f of rows) {
    const key = q.group_by === 'company' ? f.company : q.group_by === 'month' ? haitiDay(f.approved_at).slice(0, 7) : 'total';
    const g = groups.get(key) ?? { deposits: 0, minor: 0 };
    g.deposits++; g.minor += f.minor; groups.set(key, g);
  }
  const out = [...groups].map(([group, g]) => ({ group, activated_deposits: g.deposits, htg: htg(g.minor) }));
  return out.length ? out : [{ group: 'total', activated_deposits: 0, htg: 0 }];
}

function balances(ctx: Ctx, scope: Scope, raw: unknown): Rows {
  if (scope.kind === 'station') throw new ToolError('Station managers cannot see company balances.');
  const q = BalancesInput.parse(raw);
  const { companyId } = scoped(scope, q);
  const companies = ctx.db.all<{ id: number; name: string; status: string }>(
    `SELECT id, name, status FROM companies ${companyId ? 'WHERE id = ?' : ''} ORDER BY name`, ...(companyId ? [companyId] : []));
  return companies.map((c) => ({
    company: c.name, frozen: c.status === 'frozen',
    not_yet_allocated_htg: htg(sumAccounts(ctx, acct.unallocated(c.id), c.id)),
    in_employee_wallets_htg: htg(sumAccounts(ctx, 'emp:%:available', c.id) + sumAccounts(ctx, 'emp:%:reserved', c.id)),
    fuel_used_to_date_htg: htg(sumAccounts(ctx, 'stn:%:clearing', c.id)),
    expired_htg: htg(sumAccounts(ctx, acct.expired(c.id), c.id)),
  }));
}

function refunds(ctx: Ctx, scope: Scope, raw: unknown): Rows {
  if (scope.kind === 'station') throw new ToolError('Station managers cannot see refunds.');
  const q = PeriodInput.parse(raw);
  const { companyId } = scoped(scope, q);
  const [a, b] = utcWindow(q.from, q.to);
  const rows = ctx.db.all<any>(
    `SELECT status, amount_minor, created_at FROM refunds WHERE created_at BETWEEN ? AND ? ${companyId ? 'AND company_id = ?' : ''}`,
    a, b, ...(companyId ? [companyId] : []),
  ).filter((r) => { const d = haitiDay(r.created_at); return d >= q.from && d <= q.to; });
  const by = new Map<string, { n: number; minor: number }>();
  for (const r of rows) { const g = by.get(r.status) ?? { n: 0, minor: 0 }; g.n++; g.minor += r.amount_minor; by.set(r.status, g); }
  return [...by].map(([status, g]) => ({ status, refunds: g.n, htg: htg(g.minor) }));
}

function issues(ctx: Ctx, scope: Scope, raw: unknown): Rows {
  const q = PeriodInput.parse(raw);
  const { companyId, stationId } = scoped(scope, q);
  const [a, b] = utcWindow(q.from, q.to);
  const where = `${companyId ? 'AND company_id = ?' : ''} ${stationId ? 'AND station_id = ?' : ''}`;
  const args = [companyId, stationId].filter((x): x is number => x != null);
  const inPeriod = (r: any) => { const d = haitiDay(r.created_at); return d >= q.from && d <= q.to; };
  const exceptions = ctx.db.all<any>(`SELECT kind, status, created_at FROM exceptions WHERE created_at BETWEEN ? AND ? ${where}`, a, b, ...args).filter(inPeriod);
  const alerts = scope.kind === 'company' ? [] : ctx.db.all<any>(`SELECT rule, status, created_at FROM fuel_alerts WHERE created_at BETWEEN ? AND ? ${where}`, a, b, ...args).filter(inPeriod);
  const count = (list: any[], key: (x: any) => string, type: string) => {
    const m = new Map<string, number>();
    for (const x of list) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
    return [...m].map(([k, n]) => ({ type, item: k, count: n }));
  };
  const out = [...count(exceptions, (e) => `${e.kind}:${e.status}`, 'exception'), ...count(alerts, (x) => `${x.rule}:${x.status}`, 'fuel_alert')];
  return out.length ? out : [{ type: 'none', item: 'no exceptions or alerts in this period', count: 0 }];
}

const PERIOD_PROPS = {
  from: { type: 'string', description: 'First day, YYYY-MM-DD (Haiti date)' },
  to: { type: 'string', description: 'Last day, YYYY-MM-DD (Haiti date), inclusive' },
  company_id: { type: ['integer', 'null'], description: 'Limit to one client company (id from the list), or null' },
  station_id: { type: ['integer', 'null'], description: 'Limit to one station (id from the list), or null' },
};

export const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'fuel_sales',
    description: 'Completed fuelings in a period: number of fuelings, gallons dispensed and HTG charged, optionally grouped. Employees appear as [[emp:ID]] and attendants as [[user:ID]].',
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: {
        ...PERIOD_PROPS,
        group_by: { type: 'string', enum: ['none', 'company', 'station', 'grade', 'day', 'month', 'employee', 'attendant'] },
        grade: { type: ['string', 'null'], enum: ['diesel', 'gasoline', null] },
        limit: { type: ['integer', 'null'], description: 'Max rows (default 31), e.g. 5 for a top 5' },
      },
      required: ['from', 'to', 'group_by', 'company_id', 'station_id', 'grade', 'limit'],
    },
  },
  {
    name: 'deposits',
    description: 'Client deposits activated as fuel credit in a period (count and HTG), optionally by company or month.',
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: { ...PERIOD_PROPS, group_by: { type: 'string', enum: ['none', 'company', 'month'] } },
      required: ['from', 'to', 'company_id', 'station_id', 'group_by'],
    },
  },
  {
    name: 'balances',
    description: 'Current fuel credit per client company: not yet allocated, in employee wallets, used to date, expired (HTG).',
    input_schema: { type: 'object', additionalProperties: false, properties: { company_id: PERIOD_PROPS.company_id }, required: ['company_id'] },
  },
  {
    name: 'refunds',
    description: 'Refund requests created in a period, by status (requested, approved, paid, rejected), with HTG totals.',
    input_schema: { type: 'object', additionalProperties: false, properties: PERIOD_PROPS, required: ['from', 'to', 'company_id', 'station_id'] },
  },
  {
    name: 'exceptions_and_alerts',
    description: 'Exceptions (disputes, shift differences, offline issues, adjustments) and suspicious fueling alerts raised in a period, counted by type and status.',
    input_schema: { type: 'object', additionalProperties: false, properties: PERIOD_PROPS, required: ['from', 'to', 'company_id', 'station_id'] },
  },
];

const RUN: Record<string, (ctx: Ctx, scope: Scope, input: unknown) => Rows> = {
  fuel_sales: fuelSales, deposits, balances, refunds, exceptions_and_alerts: issues,
};

// ---------------------------------------------------------------- the conversation

/** One model call; swapped for a scripted fake in tests. */
export type ModelTurn = (req: { system: string; messages: Anthropic.Beta.BetaMessageParam[]; tools: Anthropic.Beta.BetaTool[]; timeoutMs: number }) => Promise<Anthropic.Beta.BetaMessage>;

const aiFailed = () => new AppError(502, 'ai_error', 'The AI service did not answer. Try again, or use the reports.');

export const claudeTurn: ModelTurn = async ({ system, messages, tools, timeoutMs }) => {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new AppError(503, 'ai_unavailable', 'AI suggestions are not set up on this server yet');
  }
  const client = new Anthropic({ timeout: timeoutMs, maxRetries: 0 });
  try {
    return await client.beta.messages.create({
      model: AI_MODEL, max_tokens: 8000,
      betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      output_config: { effort: 'low' },
      system, messages, tools,
    });
  } catch (e) {
    if (e instanceof Anthropic.APIError) throw aiFailed();
    throw e;
  }
};

function systemPrompt(ctx: Ctx, scope: Scope, lang: Lang) {
  const companies = ctx.db.all<{ id: number; name: string }>(
    `SELECT id, name FROM companies ${scope.companyId ? 'WHERE id = ?' : ''} ORDER BY name`, ...(scope.companyId ? [scope.companyId] : []));
  const stations = ctx.db.all<{ id: number; name: string }>(
    `SELECT id, name FROM stations ${scope.stationId ? 'WHERE id = ?' : ''} ORDER BY name`, ...(scope.stationId ? [scope.stationId] : []));
  const who = scope.kind === 'distributor' ? 'ALFA distributor staff (sees every company and station)'
    : scope.kind === 'company' ? `a user of the client company ${companies[0]?.name} (sees only that company)`
    : `the manager of ${stations[0]?.name} (sees only that station's fuelings and issues)`;
  return `You answer questions about ALFA's prepaid fuel platform in Haiti, using the report tools. The user is ${who}.
Today is ${todayInHaiti()} in Haiti. Weeks start on Monday. Amounts are in HTG (gourdes); fuel in US gallons.
Client companies: ${companies.map((c) => `${c.id} = ${c.name}`).join('; ') || 'none'}.
Stations: ${stations.map((s) => `${s.id} = ${s.name}`).join('; ') || 'none'}.

Rules:
- Get every number from the tools; never estimate or invent. If the tools can't answer, say what you can't see.
- Answer in ${lang === 'fr' ? 'French' : 'English'}, short and direct: the answer first, then at most a few lines of detail.
  ${lang === 'fr' ? 'Write numbers the French way (12 345,50 HTG; 1 234,5 gal).' : 'Write numbers like 12,345.50 HTG; 1,234.5 gal.'}
- Say which period you used when the question was vague (e.g. "ce mois-ci" = the 1st of this month to today).
- Refer to employees and attendants exactly as the tools give them, like [[emp:12]] or [[user:4]]; never guess names.
- You can only read. If asked to change, approve, pay or freeze something, say it has to be done in the app.`;
}

const Ask = z.object({
  question: z.string().trim().min(3).max(500),
  history: z.array(z.object({ q: z.string().max(500), a: z.string().max(4000) })).max(3).default([]),
});
export type AskInput = z.input<typeof Ask>;

/** Replaces [[emp:ID]] / [[user:ID]] with names the user is allowed to see, or a neutral label. */
function withNames(ctx: Ctx, scope: Scope, lang: Lang, text: string) {
  return text.replace(/\[\[(emp|user):(\d+)\]\]/g, (_, kind: string, id: string) => {
    if (kind === 'emp') {
      const e = ctx.db.get('SELECT name, company_id FROM employees WHERE id = ?', Number(id));
      const visible = e && (scope.kind === 'distributor' || (scope.kind === 'company' && e.company_id === scope.companyId)
        || (scope.kind === 'station' && ctx.db.get('SELECT 1 FROM redemptions WHERE employee_id = ? AND station_id = ? LIMIT 1', Number(id), scope.stationId)));
      return visible ? e.name : lang === 'fr' ? 'un employé' : 'an employee';
    }
    const u = ctx.db.get('SELECT name, station_id FROM users WHERE id = ?', Number(id));
    const visible = u && (scope.kind === 'distributor' || (scope.kind === 'station' && u.station_id === scope.stationId));
    return visible ? u.name : lang === 'fr' ? 'un pompiste' : 'an attendant';
  });
}

export async function askReports(ctx: Ctx, actor: Actor, input: AskInput, lang: Lang, turn: ModelTurn = claudeTurn) {
  const scope = scopeOf(actor);
  const { question, history } = Ask.parse(input);
  const system = systemPrompt(ctx, scope, lang);
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...history.flatMap((h) => [{ role: 'user' as const, content: h.q }, { role: 'assistant' as const, content: h.a }]),
    { role: 'user', content: question },
  ];
  const sources: { tool: string; input: unknown; rows: Rows; error?: string }[] = [];
  const started = Date.now();

  for (let i = 0; i < MAX_TURNS; i++) {
    const left = DEADLINE_MS - (Date.now() - started);
    if (left < 5_000) break;
    const response = await turn({ system, messages, tools: TOOLS, timeoutMs: left });
    if (response.stop_reason === 'refusal') throw aiFailed();
    messages.push({ role: 'assistant', content: response.content });
    const calls = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || !calls.length) {
      const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
      if (!text) throw aiFailed();
      ctx.db.audit(actor.userId, 'report.ai_question', 'report', null, { question, tools: sources.map((s) => s.tool).join(', ') || '—' });
      return {
        answer: withNames(ctx, scope, lang, text),
        sources: sources.map((s) => ({ ...s, rows: JSON.parse(withNames(ctx, scope, lang, JSON.stringify(s.rows))) })),
      };
    }
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = calls.map((call) => {
      const run = RUN[call.name];
      try {
        if (!run) throw new ToolError(`Unknown report ${call.name}`);
        const rows = run(ctx, scope, call.input);
        sources.push({ tool: call.name, input: call.input, rows });
        return { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(rows) };
      } catch (e) {
        const message = e instanceof ToolError ? e.message : e instanceof z.ZodError ? `Invalid input: ${e.issues.map((x) => x.message).join('; ')}` : 'Report failed';
        sources.push({ tool: call.name, input: call.input, rows: [], error: message });
        return { type: 'tool_result', tool_use_id: call.id, content: message, is_error: true };
      }
    });
    messages.push({ role: 'user', content: results });
  }
  throw new AppError(504, 'ai_timeout', 'The question took too long to answer. Try a narrower question (one company or one month).');
}
