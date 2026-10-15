import { actorFor, type Actor } from './auth.js';
import type { Ctx } from './context.js';
import * as admin from './services/admin.js';
import * as alloc from './services/allocation.js';
import * as funding from './services/funding.js';
import * as red from './services/redemption.js';
import { SimulatedPhone } from './phone-sim.js';
import { sha256 } from './auth.js';

export const DEMO_PASSWORD = 'demo1234';
export const DEMO_PIN = '1234';

/** Sample data matching the solution overview mockups. All names are illustrative. */
export function seedDemo(ctx: Ctx) {
  const { db } = ctx;
  ctx.config.demoTerminals = true;
  const as = (userId: number, extra: Partial<Actor> = {}): Actor => ({ ...actorFor(db, userId, null, null), ...extra });

  const user = (name: string, login: string, role: any, extra: { companyId?: number; stationId?: number } = {}) =>
    admin.createUser(ctx, null, { name, login, password: DEMO_PASSWORD, role, ...extra });

  // Distributor
  const distAdmin = user('Nadia Admin', 'admin@bousol', 'dist_admin');
  const treasury = user('Treasury Desk', 'treasury@bousol', 'dist_treasury');
  const approver = user('Finance Approver', 'approver@bousol', 'dist_approver');

  // Stations and terminals (activation codes are fixed so the demo is repeatable)
  const stations = [1, 2, 3, 4].map((n) => {
    const s = admin.createStation(ctx, null, { name: `Station ${n}`, address: `Route ${n}, Port-au-Prince` });
    const t = admin.createTerminal(ctx, null, { stationId: s.id, label: `T-0${n}` });
    db.run('UPDATE terminals SET activation_code = ? WHERE id = ?', `STATION${n}`, t.id);
    // Pre-register the demo key so a device activated before a re-seed is still recognised.
    db.run('UPDATE terminals SET device_key_hash = ? WHERE id = ?', sha256(admin.demoTerminalKey(t.id)), t.id);
    return { ...s, terminalId: t.id };
  });
  const attendants = stations.map((s, i) =>
    user(['M. Pierre', 'A. Louis', 'R. Joseph', 'K. Charles'][i], `attendant${i + 1}@bousol`, 'st_attendant', { stationId: s.id }));
  const managers = stations.map((s, i) => user(`Manager Station ${i + 1}`, `manager${i + 1}@bousol`, 'st_manager', { stationId: s.id }));

  // Corporate clients. Balances are in HTG; contract prices per gallon convert to reference gallons.
  const companies = ['Entreprise A', 'Entreprise B', 'Entreprise C'].map((name) => {
    const c = admin.createCompany(ctx, null, { name, approvalThreshold: 200_000 });
    admin.setContractPrice(ctx, null, { companyId: c.id, grade: 'diesel', priceMinor: 66500 });
    admin.setContractPrice(ctx, null, { companyId: c.id, grade: 'gasoline', priceMinor: 57000 });
    return c;
  });
  const [coA, coB, coC] = companies;
  const prepA = user('Admin A', 'prep@companya', 'co_preparer', { companyId: coA.id });
  const apprA = user('Finance A', 'approve@companya', 'co_approver', { companyId: coA.id });
  user('Admin B', 'prep@companyb', 'co_preparer', { companyId: coB.id });
  user('Finance B', 'approve@companyb', 'co_approver', { companyId: coB.id });

  // Employees of Entreprise A
  const roster: [string, string, string][] = [
    ['Jean P.', 'Opérations', '50937000001'], ['Marie L.', 'Ventes', '50937000002'], ['Paul D.', 'Opérations', '50937000003'],
    ['Sophie R.', 'Finance', '50937000004'], ['Claude M.', 'Opérations', '50937000005'], ['Esther B.', 'Logistique', '50937000006'],
    ['Wilson T.', 'Logistique', '50937000007'], ['Rose-Marie F.', 'Ventes', '50937000008'],
  ];
  const employees = roster.map(([name, dept, phone]) =>
    admin.createEmployee(ctx, null, { companyId: coA.id, name, dept, phone, password: DEMO_PASSWORD }));
  // A second roster record reusing Sophie's phone: allocation batches hold it for review.
  const dup = admin.createEmployee(ctx, null, { companyId: coA.id, name: 'S. Rousseau', dept: 'Finance', phone: '50937000004', password: DEMO_PASSWORD });

  // Funding (HTG): Entreprise A has two activated lots; B awaits the bank; C is matched and needs the second approver.
  const fund = (companyId: number, htg: number) =>
    funding.createFunding(ctx, as(distAdmin.id), { companyId, amountMinor: htg * 100 });
  const a1 = fund(coA.id, 2_500_000);
  const a2 = fund(coA.id, 1_500_000);
  for (const [i, f] of [a1, a2].entries()) {
    funding.matchFunding(ctx, as(treasury.id), f.id, { bankReference: `UNIBANK-55${i}10`, bankAmountMinor: f.amount_minor });
    funding.approveFunding(ctx, as(approver.id), f.id);
  }
  fund(coB.id, 2_000_000);
  const c1 = fund(coC.id, 1_000_000);
  funding.matchFunding(ctx, as(treasury.id), c1.id, { bankReference: 'SOGEBANK-77812', bankAmountMinor: c1.amount_minor });

  // A posted allocation (approved by a second person) that also became the recurring monthly benefit.
  const posted = alloc.createBatch(ctx, as(prepA.id), {
    companyId: coA.id, title: 'Allocation carburant mensuelle',
    lines: employees.map((e, i) => ({ employeeId: e.id, amount: i === 0 ? 80_000 : 40_000 })),
  });
  alloc.submitBatch(ctx, as(prepA.id), posted.id);
  alloc.approveBatch(ctx, as(apprA.id), posted.id);
  alloc.makeRecurring(ctx, as(apprA.id), posted.id, 1);

  // Draft batch waiting to be sent for approval, with the duplicate-phone record held.
  alloc.createBatch(ctx, as(prepA.id), {
    companyId: coA.id, title: 'Complément mission terrain',
    lines: [
      { employeeId: employees[0].id, amount: 20_000 },
      { employeeId: employees[1].id, amount: 20_000 },
      { employeeId: employees[2].id, amount: 20_000 },
      { employeeId: dup.id, amount: 20_000 },
    ],
  });

  // Some completed fuelings at Station 1 so dashboards have history.
  const st1 = stations[0];
  const att1 = as(attendants[0].id, { terminalId: st1.terminalId });
  red.openShift(ctx, att1);
  // Attendants can ask by quantity (pump preset in gallons) or by amount ("5,000 gourdes").
  const fuelings: [number, string, red.Quantity][] = [
    [0, 'diesel', { gallons: 12 }], [1, 'gasoline', { amount: 5_000 }], [0, 'diesel', { gallons: 20 }],
  ];
  // History is approved with simulated phones; those keys are then revoked so each demo employee
  // enrolls their real browser on first sign-in (choosing PIN 1234 keeps the README instructions valid).
  const phones = employees.slice(0, 2).map((e) => {
    const phone = new SimulatedPhone();
    phone.enroll(ctx, as(e.user_id, { deviceId: `seed-phone-${e.id}` }), DEMO_PASSWORD, DEMO_PIN);
    return phone;
  });
  const price = (grade: string) => db.get('SELECT price_minor FROM contracts WHERE company_id = ? AND grade = ? AND active = 1', coA.id, grade).price_minor;
  for (const [i, [empIdx, grade, qty]] of fuelings.entries()) {
    const r = red.createRequest(ctx, att1, { grade, pump: i + 1, ...qty });
    red.authorizeRequest(ctx, att1, r.id, phones[empIdx].approve(r.challenge!, DEMO_PIN, price));
    red.completeRequest(ctx, att1, r.id, qty);
  }
  db.run("UPDATE employee_devices SET status = 'revoked', revoked_at = datetime('now')");

  return {
    password: DEMO_PASSWORD,
    pin: DEMO_PIN,
    logins: {
      distributor: ['admin@bousol', 'treasury@bousol', 'approver@bousol'],
      company: ['prep@companya', 'approve@companya', 'prep@companyb', 'approve@companyb'],
      station: attendants.map((a) => a.login).concat(managers.map((m) => m.login)),
      employee: employees.map((e) => e.phone),
    },
    terminalActivationCodes: stations.map((s, i) => ({ station: s.name, code: `STATION${i + 1}` })),
  };
}
