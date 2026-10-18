import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { z, ZodError } from 'zod';
import { authenticate, DISTRIBUTOR, login, logout, requireRole, type Actor } from './auth.js';
import type { Ctx } from './context.js';
import { AppError } from './errors.js';
import { localize, localizePayload, localizeValidation, requestLang } from './i18n.js';
import { localizeLedgerPayload } from './i18n-ledger.js';
import * as admin from './services/admin.js';
import * as alloc from './services/allocation.js';
import * as bank from './services/bank.js';
import * as alerts from './services/fuel-alerts.js';
import * as bankAi from './services/bank-ai.js';
import * as dashboardSvc from './services/dashboard.js';
import * as reportsAi from './services/reports-ai.js';
import * as disputeAi from './services/dispute-ai.js';
import * as statementAi from './services/statement-ai.js';
import * as sage from './services/sage.js';
import { readXlsx } from './services/spreadsheet.js';
import * as refunds from './services/refunds.js';
import * as stationOffline from './services/station-offline.js';
import * as exc from './services/exceptions.js';
import * as funding from './services/funding.js';
import * as red from './services/redemption.js';
import * as reports from './services/reports.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor;
  }
}

const grade = z.enum(['diesel', 'gasoline']);
const money = z.number().positive().max(1e10);
const id = z.coerce.number().int().positive();
const gradeMap = z.record(z.string(), z.number().nonnegative()).default({});

export function buildApp(ctx: Ctx, opts: { staticDir?: string; logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? false });

  // Messages are written in English; they are translated per request (x-lang header, French by default).
  app.setErrorHandler((err: any, req, reply) => {
    const lang = requestLang(req.headers);
    if (err instanceof AppError) return reply.status(err.status).send({ error: err.code, message: localize(err.message, lang) });
    if (err instanceof ZodError) {
      const message = err.issues.map((i) => `${i.path.join('.')}: ${localizeValidation(i.message, lang)}`).join('; ');
      return reply.status(400).send({ error: 'invalid', message });
    }
    if (typeof err?.message === 'string' && err.message.includes('UNIQUE constraint failed')) {
      return reply.status(409).send({ error: 'duplicate', message: localize('A record with these details already exists', lang) });
    }
    app.log.error(err);
    return reply.status(500).send({ error: 'internal', message: localize('Unexpected error', lang) });
  });

  // Server-generated text returned as data (offline-sync rejection reasons, exception summaries).
  app.addHook('preSerialization', async (req, _reply, payload) => {
    const lang = requestLang(req.headers);
    return localizeLedgerPayload(localizePayload(payload, lang), lang);
  });

  const bearer = (req: FastifyRequest) => req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const auth = async (req: FastifyRequest) => {
    req.actor = authenticate(ctx.db, bearer(req));
  };
  const params = (req: FastifyRequest) => z.object({ id }).parse(req.params).id;
  const body = <T extends z.ZodTypeAny>(schema: T, req: FastifyRequest): z.infer<T> => schema.parse(req.body ?? {});

  // -------------------------------------------------------------------- public
  app.get('/api/health', async () => ({ ok: true }));

  app.post('/api/auth/login', async (req) => {
    const input = body(z.object({ login: z.string().min(1), password: z.string().min(1) }), req);
    return login(ctx.db, {
      ...input,
      deviceId: req.headers['x-device-id'] as string | undefined,
      terminalKey: req.headers['x-terminal-key'] as string | undefined,
    });
  });

  app.post('/api/terminals/activate', async (req) => admin.activateTerminal(ctx, body(z.object({ code: z.string().min(4) }), req).code));

  // ----------------------------------------------------------------- protected
  app.register(async (api) => {
    api.addHook('preHandler', auth);

    api.get('/api/me', async (req) => {
      const a = req.actor;
      const extra = {
        company: a.companyId ? ctx.db.get('SELECT id, name, status FROM companies WHERE id = ?', a.companyId) : null,
        station: a.stationId ? ctx.db.get('SELECT id, name, status FROM stations WHERE id = ?', a.stationId) : null,
      };
      return { ...a, ...extra };
    });
    api.post('/api/auth/logout', async (req) => {
      logout(ctx.db, bearer(req)!);
      return { ok: true };
    });

    // ---- reference data
    api.get('/api/companies', async (req) => {
      requireRole(req.actor, DISTRIBUTOR);
      return ctx.db.all('SELECT * FROM companies ORDER BY name');
    });
    api.post('/api/companies', async (req) =>
      admin.createCompany(ctx, req.actor, body(z.object({ name: z.string().min(2), approvalThreshold: money.optional() }), req)));
    api.post('/api/contracts', async (req) =>
      admin.setContractPrice(ctx, req.actor, body(z.object({ companyId: id, grade, priceMinor: z.number().int().positive(), currency: z.string().length(3).optional() }), req)));
    api.get('/api/stations', async (req) => {
      const rows = ctx.db.all(`SELECT s.*, t.id AS terminal_id, t.label AS terminal_label, t.status AS terminal_status,
                                      t.activation_code, t.device_key_hash IS NOT NULL AS terminal_activated
                                 FROM stations s LEFT JOIN terminals t ON t.station_id = s.id AND t.status != 'retired'
                                ORDER BY s.name`);
      // Activation codes are only shown to the distributor admin who hands them to the station.
      return req.actor.role === 'dist_admin' ? rows : rows.map(({ activation_code, ...s }) => s);
    });
    api.post('/api/stations', async (req) => admin.createStation(ctx, req.actor, body(z.object({ name: z.string().min(2), address: z.string().optional() }), req)));
    api.post('/api/terminals', async (req) => admin.createTerminal(ctx, req.actor, body(z.object({ stationId: id, label: z.string().min(2) }), req)));
    api.get('/api/users', async (req) => {
      requireRole(req.actor, ['dist_admin']);
      return ctx.db.all("SELECT id, name, login, role, company_id, station_id, status FROM users WHERE role != 'employee' ORDER BY role, name");
    });
    api.post('/api/users', async (req) =>
      admin.createUser(ctx, req.actor, body(z.object({
        name: z.string().min(2), login: z.string().min(3), password: z.string().min(8),
        role: z.enum(['dist_admin', 'dist_treasury', 'dist_approver', 'co_preparer', 'co_approver', 'st_manager', 'st_attendant']),
        companyId: id.optional(), stationId: id.optional(),
      }), req)));
    api.post('/api/freeze', async (req) => {
      const input = body(z.object({
        entity: z.enum(['company', 'employee', 'station', 'terminal', 'lot']), id, frozen: z.boolean(), reason: z.string().optional(),
      }), req);
      return admin.setFrozen(ctx, req.actor, input.entity, input.id, input.frozen, input.reason);
    });

    // ---- distributor
    api.get('/api/distributor/dashboard', async (req) => ({ ...reports.distributorDashboard(ctx, req.actor), open_fuel_alerts: alerts.openAlertCount(ctx) }));

    // ---- reporting dashboard (distributor): key figures for a period vs the previous one
    api.get('/api/reports/dashboard', async (req) => {
      const q = z.object({ from: z.string(), to: z.string(), companyId: id.optional(), stationId: id.optional() }).parse(req.query);
      return dashboardSvc.dashboard(ctx, req.actor, q);
    });

    // ---- reports assistant: questions in plain language, answered from read-only report tools within the user's scope
    api.post('/api/reports/ask', async (req) =>
      reportsAi.askReports(ctx, req.actor, body(z.object({ question: z.string(), history: z.array(z.object({ q: z.string(), a: z.string() })).optional() }), req), requestLang(req.headers)));

    // ---- suspicious fueling alerts (review only: nothing is blocked or frozen automatically)
    api.get('/api/alerts', async (req) => alerts.listFuelAlerts(ctx, req.actor, z.object({ status: z.enum(['open', 'all']).optional() }).parse(req.query)));
    api.post('/api/alerts/:id/review', async (req) => {
      const b = body(z.object({ outcome: z.enum(['cleared', 'confirmed']), note: z.string().min(2) }), req);
      return alerts.reviewFuelAlert(ctx, req.actor, params(req), b.outcome, b.note);
    });
    api.get('/api/ledger/journal', async (req) => {
      const q = z.object({ companyId: id.optional() }).parse(req.query);
      return reports.journal(ctx, req.actor, q.companyId);
    });
    api.get('/api/ledger/check', async (req) => {
      requireRole(req.actor, DISTRIBUTOR);
      return ctx.ledger.checkBalanceRule();
    });
    api.post('/api/lots/expire', async (req) => admin.runExpirations(ctx, req.actor));
    api.get('/api/lots', async (req) => {
      requireRole(req.actor, DISTRIBUTOR);
      return ctx.db.all('SELECT l.*, c.name AS company_name FROM lots l JOIN companies c ON c.id = l.company_id ORDER BY l.id DESC');
    });
    api.get('/api/audit', async (req) => {
      requireRole(req.actor, DISTRIBUTOR);
      return ctx.db.all('SELECT a.*, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT 200');
    });
    api.get('/api/shifts', async (req) => {
      const q = z.object({ stationId: id.optional() }).parse(req.query);
      if (!DISTRIBUTOR.includes(req.actor.role)) return red.listShifts(ctx, req.actor.stationId ?? -1);
      return red.listShifts(ctx, q.stationId);
    });

    // ---- funding
    api.get('/api/funding', async (req) => funding.listFunding(ctx, req.actor, z.object({ companyId: id.optional() }).parse(req.query).companyId));
    api.post('/api/funding', async (req) =>
      funding.createFunding(ctx, req.actor, body(z.object({ companyId: id, amountMinor: z.number().int().positive() }), req)));
    api.post('/api/funding/:id/match', async (req) =>
      funding.matchFunding(ctx, req.actor, params(req), body(z.object({ bankReference: z.string().min(3), bankAmountMinor: z.number().int().positive() }), req)));
    api.post('/api/funding/:id/approve', async (req) => funding.approveFunding(ctx, req.actor, params(req)));
    api.post('/api/funding/:id/reject', async (req) =>
      funding.rejectFunding(ctx, req.actor, params(req), body(z.object({ reason: z.string().min(2) }), req).reason));

    // ---- bank statements
    api.get('/api/bank/transactions', async (req) => bank.listBankTransactions(ctx, req.actor));
    // A CSV as text, or an Excel workbook (.xlsx) as base64.
    api.post('/api/bank/import', { bodyLimit: 4_000_000 }, async (req) => {
      const b = body(z.object({ csv: z.string().min(10).max(2_000_000).optional(), xlsx: z.string().min(10).max(3_900_000).optional() })
        .refine((v) => !!v.csv !== !!v.xlsx, 'Send either csv or xlsx'), req);
      return bank.importStatement(ctx, req.actor, b.xlsx ? readXlsx(Buffer.from(b.xlsx, 'base64')) : b.csv!);
    });
    // AI reading of a PDF statement or an unfamiliar Excel/CSV layout: returns a preview, imports nothing.
    api.post('/api/bank/ai-read', { bodyLimit: 4_000_000 }, async (req) => {
      const b = body(z.object({ pdf: z.string().min(10).max(3_900_000).optional(), xlsx: z.string().min(10).max(3_900_000).optional(), csv: z.string().min(10).max(2_000_000).optional() })
        .refine((v) => [v.pdf, v.xlsx, v.csv].filter(Boolean).length === 1, 'Send one of pdf, xlsx or csv'), req);
      return statementAi.readStatement(ctx, req.actor, b);
    });
    api.post('/api/bank/transactions/:id/match', async (req) =>
      bank.matchTransaction(ctx, req.actor, params(req), body(z.object({ fundingId: id }), req).fundingId));
    api.post('/api/bank/transactions/:id/suggest', async (req) =>
      bankAi.suggestMatches(ctx, req.actor, params(req), requestLang(req.headers)));
    api.post('/api/bank/transactions/:id/ignore', async (req) =>
      bank.ignoreTransaction(ctx, req.actor, params(req), body(z.object({ note: z.string().min(2) }), req).note));

    // ---- accounting export (Sage)
    const period = z.object({
      from: z.string(), to: z.string(), mode: z.enum(['summary', 'detail']).default('summary'), onlyNew: z.boolean().default(true),
    });
    api.get('/api/accounting/sage/settings', async (req) => sage.getSettings(ctx, req.actor));
    api.post('/api/accounting/sage/settings', async (req) => sage.saveSettings(ctx, req.actor, body(z.object({
      journal: z.string().optional(),
      accounts: z.record(z.string()).optional(),
      companies: z.array(z.object({ id, tiers: z.string() })).optional(),
      stations: z.array(z.object({ id, section: z.string() })).optional(),
    }), req)));
    api.post('/api/accounting/sage/preview', async (req) => sage.preview(ctx, req.actor, body(period, req)));
    api.post('/api/accounting/sage/export', async (req) =>
      sage.exportFile(ctx, req.actor, body(period.extend({ format: z.enum(['sage100', 'csv']).default('sage100') }), req)));
    api.get('/api/accounting/sage/exports', async (req) => sage.listExports(ctx, req.actor));
    api.post('/api/accounting/sage/exports/:id/download', async (req) => sage.downloadExport(ctx, req.actor, params(req)));

    // ---- refunds
    api.get('/api/refunds', async (req) => refunds.listRefunds(ctx, req.actor));
    api.post('/api/refunds', async (req) =>
      refunds.requestRefund(ctx, req.actor, body(z.object({ lotId: id, amount: money, reason: z.string().min(2) }), req)));
    api.post('/api/refunds/:id/approve', async (req) => refunds.approveRefund(ctx, req.actor, params(req)));
    api.post('/api/refunds/:id/reject', async (req) =>
      refunds.rejectRefund(ctx, req.actor, params(req), body(z.object({ reason: z.string().min(2) }), req).reason));
    api.post('/api/refunds/:id/pay', async (req) =>
      refunds.payRefund(ctx, req.actor, params(req), body(z.object({ payoutReference: z.string().min(3) }), req).payoutReference));

    // ---- corporate portal
    api.get('/api/companies/:id/dashboard', async (req) => reports.companyDashboard(ctx, req.actor, params(req)));
    api.get('/api/companies/:id/employees', async (req) => admin.listEmployees(ctx, req.actor, params(req)));
    api.post('/api/companies/:id/employees', async (req) =>
      admin.createEmployee(ctx, req.actor, {
        companyId: params(req),
        ...body(z.object({ name: z.string().min(2), dept: z.string().optional(), phone: z.string().min(8), password: z.string().min(8) }), req),
      }));
    api.post('/api/employees/:id/recover', async (req) =>
      admin.recoverEmployee(ctx, req.actor, params(req), body(z.object({
        resetPin: z.boolean().default(false), resetDevice: z.boolean().default(false), tempPassword: z.string().min(8).optional(),
      }), req)));
    api.post('/api/employees/:id/return', async (req) =>
      exc.requestReturnToCompany(ctx, req.actor, {
        employeeId: params(req), ...body(z.object({ amount: money, note: z.string().min(2) }), req),
      }));
    api.post('/api/batches', async (req) =>
      alloc.createBatch(ctx, req.actor, body(z.object({
        companyId: id, title: z.string().min(2),
        lines: z.array(z.object({ employeeId: id, amount: money })).min(1),
      }), req)));
    api.post('/api/batches/:id/submit', async (req) => alloc.submitBatch(ctx, req.actor, params(req)));
    api.post('/api/batches/:id/approve', async (req) => alloc.approveBatch(ctx, req.actor, params(req)));
    api.post('/api/batches/:id/reject', async (req) => alloc.rejectBatch(ctx, req.actor, params(req)));
    api.post('/api/batch-lines/:id/release', async (req) => alloc.releaseHeldLine(ctx, req.actor, params(req)));
    api.post('/api/batches/:id/recurring', async (req) =>
      alloc.makeRecurring(ctx, req.actor, params(req), body(z.object({ dayOfMonth: z.number().int().min(1).max(28) }), req).dayOfMonth));
    api.post('/api/recurring/:id/status', async (req) =>
      alloc.setRecurringStatus(ctx, req.actor, params(req), body(z.object({ status: z.enum(['active', 'paused', 'cancelled']) }), req).status));
    api.post('/api/recurring/run', async (req) => alloc.runRecurring(ctx, req.actor));

    // ---- station app
    api.get('/api/station/state', async (req) => {
      const shift = red.currentShift(ctx, req.actor);
      return {
        shift,
        redemptions: shift ? red.listRedemptions(ctx, { shiftId: shift.id }) : [],
        terminal: req.actor.terminalId ? ctx.db.get('SELECT * FROM terminals WHERE id = ?', req.actor.terminalId) : null,
      };
    });
    api.get('/api/stations/:id/overview', async (req) => reports.stationOverview(ctx, req.actor, params(req)));
    api.post('/api/shifts/open', async (req) => red.openShift(ctx, req.actor));
    api.post('/api/shifts/close', async (req) =>
      red.closeShift(ctx, req.actor, body(z.object({ pumpTotals: gradeMap, posTotals: gradeMap }), req)));
    api.post('/api/redemptions', async (req) =>
      red.createRequest(ctx, req.actor, body(z.object({ grade, pump: z.number().int().positive(), gallons: z.number().positive().optional(), amount: money.optional() }), req)));
    api.get('/api/redemptions/:id', async (req) => {
      const r = red.getRedemption(ctx, params(req));
      const a = req.actor;
      const ok = DISTRIBUTOR.includes(a.role) || r.terminal_id === a.terminalId || r.station_id === a.stationId || r.employee_id === a.employeeId;
      if (!ok) throw new AppError(404, 'not_found', 'Redemption not found');
      return r;
    });
    api.get('/api/station/offline-pack', async (req) => stationOffline.offlinePack(ctx, req.actor));
    api.post('/api/station/offline-sync', async (req) => {
      const sale = z.object({
        clientId: z.string().min(8).max(64), code: z.string().min(4).max(40), nonce: z.string().min(4).max(64),
        shiftId: id, grade: z.string(), pump: z.number().int().positive(),
        requestedMinor: z.number().int().positive().nullable(), requestedMgal: z.number().int().positive().nullable(),
        priceMinor: z.number().int().positive(), currency: z.string().length(3),
        approvedMinor: z.number().int().positive(), approvedMgal: z.number().int().nonnegative(),
        dispensedMgal: z.number().int().nonnegative(), chargedMinor: z.number().int().positive(),
        token: z.string().min(10).max(2000), approvedAt: z.string(), completedAt: z.string(),
      });
      return stationOffline.syncOfflineSales(ctx, req.actor, body(z.object({ sales: z.array(sale).max(500) }), req).sales);
    });
    api.post('/api/redemptions/:id/challenge', async (req) => red.refreshChallenge(ctx, req.actor, params(req)));
    api.post('/api/redemptions/:id/authorize', async (req) =>
      red.authorizeRequest(ctx, req.actor, params(req), body(z.object({ token: z.string().min(10).max(2000) }), req).token));
    api.post('/api/redemptions/:id/complete', async (req) =>
      red.completeRequest(ctx, req.actor, params(req), body(z.object({ gallons: z.number().positive().optional(), amount: money.optional() }), req)));
    api.post('/api/redemptions/:id/cancel', async (req) => red.cancelRequest(ctx, req.actor, params(req)));

    // ---- employee app
    api.get('/api/wallet', async (req) => reports.wallet(ctx, req.actor));
    api.post('/api/wallet/enroll', async (req) =>
      admin.enrollDevice(ctx, req.actor, body(z.object({
        password: z.string(), publicKeyJwk: z.record(z.string(), z.unknown()), pinKey: z.string().max(100),
      }), req)));
    api.post('/api/redemptions/:id/dispute', async (req) =>
      exc.raiseDispute(ctx, req.actor, params(req), body(z.object({ reason: z.string().min(3) }), req).reason));

    // ---- exceptions
    api.get('/api/exceptions', async (req) => exc.listExceptions(ctx, req.actor, z.object({ status: z.string().optional() }).parse(req.query).status));
    api.post('/api/exceptions/:id/propose', async (req) => {
      const proposal = body(z.discriminatedUnion('action', [
        z.object({ action: z.literal('accept_variance'), note: z.string().min(3) }),
        z.object({ action: z.literal('acknowledge'), note: z.string().min(3) }),
        z.object({ action: z.literal('reverse'), amount: money, note: z.string().min(3) }),
        z.object({ action: z.literal('reject_dispute'), note: z.string().min(3) }),
      ]), req);
      return exc.propose(ctx, req.actor, params(req), proposal);
    });
    // AI summary and reply drafts for a dispute (changes nothing), and replies sent to the employee.
    api.post('/api/exceptions/:id/ai-summary', async (req) => disputeAi.adviseOnDispute(ctx, req.actor, params(req), requestLang(req.headers)));
    api.post('/api/exceptions/:id/reply', async (req) =>
      disputeAi.replyToDispute(ctx, req.actor, params(req), body(z.object({ text: z.string().trim().min(3).max(2000) }), req).text));
    api.post('/api/exceptions/:id/decide', async (req) => {
      const input = body(z.object({ approve: z.boolean(), note: z.string().optional() }), req);
      return exc.decide(ctx, req.actor, params(req), input.approve, input.note);
    });
  });

  // ------------------------------------------------------------------- web app
  if (opts.staticDir && existsSync(opts.staticDir)) {
    app.register(fastifyStatic, { root: opts.staticDir, wildcard: false });
    app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'not_found', message: localize('No such endpoint', requestLang(req.headers)) });
      return reply.sendFile('index.html');
    });
  }

  return app;
}
