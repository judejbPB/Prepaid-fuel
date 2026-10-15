import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createCtx } from '../src/context.js';
import { DEMO_PASSWORD, DEMO_PIN, seedDemo } from '../src/demo.js';
import { SimulatedPhone } from '../src/phone-sim.js';
import * as admin from '../src/services/admin.js';

const ctx = createCtx(':memory:');
const app = buildApp(ctx);

async function call(method: 'GET' | 'POST', url: string, opts: { token?: string; body?: any; headers?: Record<string, string> } = {}) {
  const res = await app.inject({
    method, url, payload: opts.body,
    headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers },
  });
  return { status: res.statusCode, json: res.json() };
}
const signIn = async (login: string, headers: Record<string, string> = {}) =>
  (await call('POST', '/api/auth/login', { body: { login, password: DEMO_PASSWORD }, headers })).json.token as string;

beforeAll(() => {
  seedDemo(ctx);
});

describe('api', () => {
  it('rejects bad credentials and anonymous calls', async () => {
    expect((await call('POST', '/api/auth/login', { body: { login: 'admin@bousol', password: 'nope' } })).status).toBe(401);
    expect((await call('GET', '/api/distributor/dashboard')).status).toBe(401);
  });

  it('distributor dashboard reflects seeded activity and a clean ledger', async () => {
    const token = await signIn('admin@bousol');
    const { json } = await call('GET', '/api/distributor/dashboard', { token });
    expect(json.kpis.deposits_verified).toBe(3);
    expect(json.balance_rule.ok).toBe(true);
    expect(json.funding_queue.map((f: any) => f.status)).toContain('awaiting_bank');
  });

  it('imports a bank statement uploaded as an Excel workbook, with French errors', async () => {
    const token = await signIn('treasury@bousol');
    const xlsx = readFileSync(new URL('./fixtures/releve-banque.xlsx', import.meta.url)).toString('base64');
    const ok = await call('POST', '/api/bank/import', { token, body: { xlsx } });
    expect(ok).toMatchObject({ status: 200, json: { imported: 2, skipped: 1, unmatched: 2 } });
    const xls = readFileSync(new URL('./fixtures/releve-banque.xls', import.meta.url)).toString('base64');
    const old = await call('POST', '/api/bank/import', { token, body: { xlsx: xls }, headers: { 'x-lang': 'fr' } });
    expect(old).toMatchObject({ status: 400, json: { error: 'old_xls' } });
    expect(old.json.message).toContain('enregistrez-le en .xlsx');
  });

  it('keeps company data separate', async () => {
    const tokenB = await signIn('prep@companyb');
    const companyA = ctx.db.get("SELECT id FROM companies WHERE name = 'Entreprise A'");
    expect((await call('GET', `/api/companies/${companyA.id}/employees`, { token: tokenB })).status).toBe(403);
    const funding = (await call('GET', '/api/funding', { token: tokenB })).json;
    expect(funding.every((f: any) => f.company_name === 'Entreprise B')).toBe(true);
  });

  it('attendants must sign in from an activated terminal at their station', async () => {
    const noTerminal = await call('POST', '/api/auth/login', { body: { login: 'attendant2@bousol', password: DEMO_PASSWORD } });
    expect(noTerminal).toMatchObject({ status: 403, json: { error: 'terminal_unknown' } });
    const { json } = await call('POST', '/api/terminals/activate', { body: { code: 'STATION2' } });
    const wrongStation = await call('POST', '/api/auth/login', {
      body: { login: 'attendant3@bousol', password: DEMO_PASSWORD }, headers: { 'x-terminal-key': json.terminalKey },
    });
    expect(wrongStation).toMatchObject({ status: 403, json: { error: 'terminal_wrong_station' } });
    expect(wrongStation.json.message).toContain('Station 2');
    const token = await signIn('attendant2@bousol', { 'x-terminal-key': json.terminalKey });
    expect(token).toBeTruthy();
  });

  it('demo terminals survive a re-seed (the hosted demo resets its in-memory database)', async () => {
    const { json } = await call('POST', '/api/terminals/activate', { body: { code: 'STATION4' } });
    const fresh = createCtx(':memory:');
    seedDemo(fresh);
    const reseeded = buildApp(fresh);
    const res = await reseeded.inject({
      method: 'POST', url: '/api/auth/login', payload: { login: 'attendant4@bousol', password: DEMO_PASSWORD },
      headers: { 'x-terminal-key': json.terminalKey },
    });
    expect(res.statusCode).toBe(200);
  });

  it('outside the demo, activation codes are single use and keys are random', async () => {
    const prod = createCtx(':memory:');
    const station = admin.createStation(prod, null, { name: 'Prod station' });
    const terminal = admin.createTerminal(prod, null, { stationId: station.id, label: 'T-1' });
    const code = prod.db.get('SELECT activation_code FROM terminals WHERE id = ?', terminal.id).activation_code;
    const out = admin.activateTerminal(prod, code);
    expect(out.terminalKey).not.toBe(admin.demoTerminalKey(terminal.id));
    expect(() => admin.activateTerminal(prod, code)).toThrow();
  });

  it('runs a full fueling over HTTP with device binding', async () => {
    const { json: act } = await call('POST', '/api/terminals/activate', { body: { code: 'STATION3' } });
    const att = await signIn('attendant3@bousol', { 'x-terminal-key': act.terminalKey });
    await call('POST', '/api/shifts/open', { token: att });
    const req = (await call('POST', '/api/redemptions', { token: att, body: { grade: 'diesel', pump: 3, gallons: 12 } })).json;

    const phone = { 'x-device-id': 'phone-1' };
    const emp = await signIn('50937000001', phone);
    expect((await call('POST', '/api/auth/login', { body: { login: '50937000001', password: DEMO_PASSWORD }, headers: { 'x-device-id': 'phone-2' } })).status).toBe(403);

    const before = (await call('GET', '/api/wallet', { token: emp })).json;
    expect(before.device).toMatchObject({ enrolled: false });

    // Enrollment happens once, online. Afterwards the phone can approve with no connection at all.
    const handset = new SimulatedPhone();
    expect((await call('POST', '/api/wallet/enroll', { token: emp, body: { password: 'wrong', ...handset.enrollment(DEMO_PIN) } })).status).toBe(403);
    const enrolled = await call('POST', '/api/wallet/enroll', { token: emp, body: { password: DEMO_PASSWORD, ...handset.enrollment(DEMO_PIN) } });
    handset.enrolled(enrolled.json);
    expect((await call('GET', '/api/wallet', { token: emp })).json.device).toMatchObject({ enrolled: true, on_this_phone: true });

    const priceOf = () => 66500;
    const code = handset.approve(req.challenge, DEMO_PIN, priceOf);
    // The employee's token cannot submit approvals; only the station terminal can.
    expect((await call('POST', `/api/redemptions/${req.id}/authorize`, { token: emp, body: { token: code } })).status).toBe(403);
    const approved = await call('POST', `/api/redemptions/${req.id}/authorize`, { token: att, body: { token: code } });
    expect(approved.json).toMatchObject({ status: 'approved', approved_minor: 798000, employee_name: 'Jean P.' });
    const done = await call('POST', `/api/redemptions/${req.id}/complete`, { token: att, body: { gallons: 12 } });
    expect(done.json.status).toBe('completed');
    const after = (await call('GET', '/api/wallet', { token: emp })).json;
    expect(before.available_minor - after.available_minor).toBe(798000); // 12 gal x 665.00 HTG

    const closed = await call('POST', '/api/shifts/close', { token: att, body: { pumpTotals: { diesel: 24 }, posTotals: { diesel: 7980 } } });
    expect(closed.json.status).toBe('held');
  });
});
