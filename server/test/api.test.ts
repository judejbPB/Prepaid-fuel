import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createCtx } from '../src/context.js';
import { DEMO_PASSWORD, DEMO_PIN, seedDemo } from '../src/demo.js';

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

  it('keeps company data separate', async () => {
    const tokenB = await signIn('prep@companyb');
    const companyA = ctx.db.get("SELECT id FROM companies WHERE name = 'Company A'");
    expect((await call('GET', `/api/companies/${companyA.id}/employees`, { token: tokenB })).status).toBe(403);
    const funding = (await call('GET', '/api/funding', { token: tokenB })).json;
    expect(funding.every((f: any) => f.company_name === 'Company B')).toBe(true);
  });

  it('attendants must sign in from an activated terminal at their station', async () => {
    expect((await call('POST', '/api/auth/login', { body: { login: 'attendant2@bousol', password: DEMO_PASSWORD } })).status).toBe(403);
    const { json } = await call('POST', '/api/terminals/activate', { body: { code: 'STATION2' } });
    expect((await call('POST', '/api/terminals/activate', { body: { code: 'STATION2' } })).status).toBe(404); // single use
    const wrongStation = await call('POST', '/api/auth/login', {
      body: { login: 'attendant3@bousol', password: DEMO_PASSWORD }, headers: { 'x-terminal-key': json.terminalKey },
    });
    expect(wrongStation.status).toBe(403);
    const token = await signIn('attendant2@bousol', { 'x-terminal-key': json.terminalKey });
    expect(token).toBeTruthy();
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
    const preview = await call('POST', '/api/wallet/preview', { token: emp, body: { code: req.qr } });
    expect(preview.json).toMatchObject({ pump: 3, grade: 'diesel', requested_mgal: 12000 });
    const approved = await call('POST', '/api/wallet/approve', { token: emp, body: { code: req.qr, pin: DEMO_PIN } });
    expect(approved.json.status).toBe('approved');
    const done = await call('POST', `/api/redemptions/${req.id}/complete`, { token: att, body: { gallons: 12 } });
    expect(done.json.status).toBe('completed');
    const after = (await call('GET', '/api/wallet', { token: emp })).json;
    expect(before.by_grade.diesel - after.by_grade.diesel).toBe(12000);

    const closed = await call('POST', '/api/shifts/close', { token: att, body: { pumpTotals: { diesel: 24 }, posTotals: { diesel: 12 } } });
    expect(closed.json.status).toBe('held');
  });
});
