import { actorFor, hashSecret, type Actor } from './auth.js';
import type { Ctx } from './context.js';
import * as admin from './services/admin.js';
import * as alloc from './services/allocation.js';
import * as funding from './services/funding.js';
import * as red from './services/redemption.js';

export const DEMO_PASSWORD = 'demo1234';
export const DEMO_PIN = '1234';

/** Sample data matching the solution overview mockups. All names are illustrative. */
export function seedDemo(ctx: Ctx) {
  const { db } = ctx;
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
    return { ...s, terminalId: t.id };
  });
  const attendants = stations.map((s, i) =>
    user(['M. Pierre', 'A. Louis', 'R. Joseph', 'K. Charles'][i], `attendant${i + 1}@bousol`, 'st_attendant', { stationId: s.id }));
  const managers = stations.map((s, i) => user(`Manager Station ${i + 1}`, `manager${i + 1}@bousol`, 'st_manager', { stationId: s.id }));

  // Corporate clients and contract prices (HTG per gallon, in minor units)
  const companies = ['Company A', 'Company B', 'Company C'].map((name) => {
    const c = admin.createCompany(ctx, null, { name, approvalThresholdGallons: 300 });
    admin.setContractPrice(ctx, null, { companyId: c.id, grade: 'diesel', priceMinor: 66500 });
    admin.setContractPrice(ctx, null, { companyId: c.id, grade: 'gasoline', priceMinor: 57000 });
    return c;
  });
  const [coA, coB, coC] = companies;
  const prepA = user('Admin A', 'prep@companya', 'co_preparer', { companyId: coA.id });
  const apprA = user('Finance A', 'approve@companya', 'co_approver', { companyId: coA.id });
  user('Admin B', 'prep@companyb', 'co_preparer', { companyId: coB.id });
  user('Finance B', 'approve@companyb', 'co_approver', { companyId: coB.id });

  // Employees of Company A
  const roster: [string, string, string][] = [
    ['Jean P.', 'Ops', '50937000001'], ['Marie L.', 'Sales', '50937000002'], ['Paul D.', 'Ops', '50937000003'],
    ['Sophie R.', 'Finance', '50937000004'], ['Claude M.', 'Ops', '50937000005'], ['Esther B.', 'Logistics', '50937000006'],
    ['Wilson T.', 'Logistics', '50937000007'], ['Rose-Marie F.', 'Sales', '50937000008'],
  ];
  const employees = roster.map(([name, dept, phone]) =>
    admin.createEmployee(ctx, null, { companyId: coA.id, name, dept, phone, password: DEMO_PASSWORD }));
  // A second roster record reusing Sophie's phone: allocation batches hold it for review.
  const dup = admin.createEmployee(ctx, null, { companyId: coA.id, name: 'S. Rousseau', dept: 'Finance', phone: '50937000004', password: DEMO_PASSWORD });
  // Jean P. and Marie L. already have a PIN; everyone else sets theirs on first sign-in.
  for (const e of employees.slice(0, 2)) db.run('UPDATE employees SET pin_hash = ? WHERE id = ?', hashSecret(DEMO_PIN), e.id);

  // Funding: Company A has two activated lots; B awaits the bank; C is matched and needs the second approver.
  const fund = (companyId: number, grade: string, gallons: number, price: number) =>
    funding.createFunding(ctx, as(distAdmin.id), { companyId, grade, amountMinor: gallons * price });
  const a1 = fund(coA.id, 'diesel', 4000, 66500);
  const a2 = fund(coA.id, 'gasoline', 2500, 57000);
  for (const [i, f] of [a1, a2].entries()) {
    funding.matchFunding(ctx, as(treasury.id), f.id, { bankReference: `UNIBANK-55${i}10`, bankAmountMinor: f.amount_minor });
    funding.approveFunding(ctx, as(approver.id), f.id);
  }
  fund(coB.id, 'diesel', 3000, 66500);
  const c1 = fund(coC.id, 'gasoline', 1500, 57000);
  funding.matchFunding(ctx, as(treasury.id), c1.id, { bankReference: 'SOGEBANK-77812', bankAmountMinor: c1.amount_minor });

  // A posted allocation (approved by a second person) that also became the recurring monthly benefit.
  const fuelOf = (i: number) => (employees[i].dept === 'Ops' || employees[i].dept === 'Logistics' ? 'diesel' : 'gasoline');
  const posted = alloc.createBatch(ctx, as(prepA.id), {
    companyId: coA.id, title: 'Monthly fuel benefit',
    lines: employees.map((e, i) => ({ employeeId: e.id, grade: fuelOf(i), gallons: i === 0 ? 120 : 60 })),
  });
  alloc.submitBatch(ctx, as(prepA.id), posted.id);
  alloc.approveBatch(ctx, as(apprA.id), posted.id);
  alloc.makeRecurring(ctx, as(apprA.id), posted.id, 1);

  // Draft batch waiting to be sent for approval, with the duplicate-phone record held.
  alloc.createBatch(ctx, as(prepA.id), {
    companyId: coA.id, title: 'Field trip top-up',
    lines: [
      { employeeId: employees[0].id, grade: 'diesel', gallons: 30 },
      { employeeId: employees[1].id, grade: 'gasoline', gallons: 30 },
      { employeeId: employees[2].id, grade: 'diesel', gallons: 30 },
      { employeeId: dup.id, grade: 'gasoline', gallons: 30 },
    ],
  });

  // Some completed fuelings at Station 1 so dashboards have history.
  const st1 = stations[0];
  const att1 = as(attendants[0].id, { terminalId: st1.terminalId });
  red.openShift(ctx, att1);
  const fuelings: [number, string, number][] = [[0, 'diesel', 12], [1, 'gasoline', 8.5], [0, 'diesel', 20]];
  for (const [i, [empIdx, grade, gal]] of fuelings.entries()) {
    const r = red.createRequest(ctx, att1, { grade, pump: i + 1, gallons: gal });
    red.approveRequest(ctx, as(employees[empIdx].user_id), { code: r.code, pin: DEMO_PIN });
    red.completeRequest(ctx, att1, r.id, gal);
  }

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
