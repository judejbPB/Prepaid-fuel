import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { z, ZodError } from 'zod';
import { authenticate, DISTRIBUTOR, login, logout, requireRole, type Actor } from './auth.js';
import type { Ctx } from './context.js';
import { AppError } from './errors.js';
import * as admin from './services/admin.js';
import * as alloc from './services/allocation.js';
import * as bank from './services/bank.js';
import * as refunds from './services/refunds.js';
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

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: err.code, message: err.message });
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'invalid', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    }
    if (typeof err?.message === 'string' && err.message.includes('UNIQUE constraint failed')) {
      return reply.status(409).send({ error: 'duplicate', message: 'A record with these details already exists' });
    }
    app.log.error(err);
    return reply.status(500).send({ error: 'internal', message: 'Unexpected error' });
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
    api.get('/api/distributor/dashboard', async (req) => reports.distributorDashboard(ctx, req.actor));
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
    api.post('/api/bank/import', async (req) =>
      bank.importStatement(ctx, req.actor, body(z.object({ csv: z.string().min(10).max(2_000_000) }), req).csv));
    api.post('/api/bank/transactions/:id/match', async (req) =>
      bank.matchTransaction(ctx, req.actor, params(req), body(z.object({ fundingId: id }), req).fundingId));
    api.post('/api/bank/transactions/:id/ignore', async (req) =>
      bank.ignoreTransaction(ctx, req.actor, params(req), body(z.object({ note: z.string().min(2) }), req).note));

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
        z.object({ action: z.literal('reverse'), amount: money, note: z.string().min(3) }),
        z.object({ action: z.literal('reject_dispute'), note: z.string().min(3) }),
      ]), req);
      return exc.propose(ctx, req.actor, params(req), proposal);
    });
    api.post('/api/exceptions/:id/decide', async (req) => {
      const input = body(z.object({ approve: z.boolean(), note: z.string().optional() }), req);
      return exc.decide(ctx, req.actor, params(req), input.approve, input.note);
    });
  });

  // ------------------------------------------------------------------- web app
  if (opts.staticDir && existsSync(opts.staticDir)) {
    app.register(fastifyStatic, { root: opts.staticDir, wildcard: false });
    app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'not_found', message: 'No such endpoint' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}
