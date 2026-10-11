import { useState } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import { api, cap, date, gal, money, when } from '../api';
import { Authed, Empty, Kpi, Modal, PageHead, Shell, Status, useAction, useLoad, useMe } from '../ui';
import { BankStatements, RefundsTable } from './finance';
import { ExceptionsPanel } from './shared';

const d = api('distributor');

export default function Distributor() {
  return (
    <Authed surface="distributor">
      <Shell surface="distributor" nav={[
        ['/distributor', 'Overview'], ['/distributor/funding', 'Funding queue'], ['/distributor/bank', 'Bank statements'],
        ['/distributor/refunds', 'Refunds'], ['/distributor/exceptions', 'Exceptions'],
        ['/distributor/shifts', 'Shift reconciliation'], ['/distributor/network', 'Clients & stations'],
        ['/distributor/ledger', 'Ledger'], ['/distributor/audit', 'Audit log'],
      ]}>
        <Routes>
          <Route index element={<Overview />} />
          <Route path="funding" element={<Funding />} />
          <Route path="bank" element={<BankStatements />} />
          <Route path="refunds" element={<Refunds />} />
          <Route path="exceptions" element={<><PageHead eyebrow="Controls" title="Exceptions" /><ExceptionsPanel surface="distributor" /></>} />
          <Route path="shifts" element={<Shifts />} />
          <Route path="network" element={<Network />} />
          <Route path="ledger" element={<Ledger />} />
          <Route path="audit" element={<Audit />} />
        </Routes>
      </Shell>
    </Authed>
  );
}

function Overview() {
  const { data } = useLoad(() => d.get('/api/distributor/dashboard'), [], 10000);
  if (!data) return null;
  const k = data.kpis;
  const max = Math.max(1, ...data.redemptions_today.map((r: any) => r.mgal));
  const alert = data.alerts[0];
  return (
    <>
      <PageHead eyebrow="Distributor control center" title="One view of funds, gallons and exceptions" />
      <div className="grid g4">
        <Kpi label="Deposits verified" value={k.deposits_verified} sub={money(k.bank_verified_minor)} />
        <Kpi label="Gallons owed" value={gal(k.gallons_owed_mgal)} sub="Unallocated + employee balances" />
        <Kpi label="Gallons allocated" value={gal(k.gallons_allocated_mgal)} sub="In employee wallets" />
        <Kpi label="Open exceptions" value={k.open_exceptions} bad={k.open_exceptions > 0} />
      </div>
      <div className="grid g2 mt">
        <div className="card">
          <div className="row between"><h2>Funding queue</h2><Link to="/distributor/funding" className="small">All →</Link></div>
          <table><tbody>
            {data.funding_queue.slice(0, 6).map((f: any) => (
              <tr key={f.id}><td className="mono">{f.reference}</td><td>{f.company_name}</td><td className="r"><Status s={f.status} /></td></tr>
            ))}
          </tbody></table>
        </div>
        <div className="card">
          <h2>Redemptions today (gal)</h2>
          <table><tbody>
            {data.redemptions_today.map((s: any) => (
              <tr key={s.id}><td style={{ width: 90 }}>{s.name}</td>
                <td><div className="bar"><div style={{ width: `${(s.mgal / max) * 100}%` }} /></div></td>
                <td className="r num" style={{ width: 70 }}><b>{gal(s.mgal)}</b></td></tr>
            ))}
          </tbody></table>
        </div>
      </div>
      {k.unmatched_bank_lines > 0 && (
        <div className="banner mt"><span className="grow">{k.unmatched_bank_lines} imported bank line(s) could not be matched to a funding reference.</span>
          <Link to="/distributor/bank"><button className="sm">Match</button></Link></div>
      )}
      {k.refunds_pending > 0 && (
        <div className="banner mt"><span className="grow">{k.refunds_pending} refund(s) awaiting approval or payout · {money(k.refunds_payable_minor)} payable.</span>
          <Link to="/distributor/refunds"><button className="sm">Review</button></Link></div>
      )}
      {alert && (
        <div className="banner mt"><span>⚠</span><span className="grow">{alert.summary}</span>
          <Link to="/distributor/exceptions"><button className="sm">Review</button></Link></div>
      )}
      <div className={`banner mt ${data.balance_rule.ok ? 'ok' : 'bad'}`}>
        <span className="grow">
          <b>Daily balance rule</b> — funded gallons = unallocated + employee available + reserved + redeemed + expired/refunded/adjusted.
          {' '}{data.balance_rule.ok ? `Holds across ${data.balance_rule.lotsChecked} lots.` : `${data.balance_rule.issues.length} issue(s) found.`}
        </span>
      </div>
      <div className="card white mt">
        <h2>Corporate clients</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Company</th><th>Status</th><th className="r">Unallocated</th><th className="r">In wallets</th><th className="r">Redeemed</th><th className="r">Prepaid liability</th><th>Contract prices</th></tr></thead>
          <tbody>
            {data.companies.map((c: any) => (
              <tr key={c.id}><td><b>{c.name}</b></td><td><Status s={c.status} /></td>
                <td className="r num">{gal(c.unallocated_mgal)}</td><td className="r num">{gal(c.allocated_mgal)}</td>
                <td className="r num">{gal(c.redeemed_mgal, 1)}</td><td className="r num">{money(c.liability_minor)}</td>
                <td className="small">{c.contracts.map((p: any) => `${cap(p.grade)} ${money(p.price_minor, p.currency)}/gal`).join(' · ')}</td></tr>
            ))}
          </tbody>
        </table></div>
      </div>
    </>
  );
}

function Funding() {
  const me = useMe();
  const { data, reload } = useLoad(() => d.get('/api/funding'), [], 15000);
  const [matching, setMatching] = useState<any>(null);
  const [creating, setCreating] = useState(false);
  const { busy, run } = useAction();
  const approve = async (f: any) => {
    if (await run(() => d.post(`/api/funding/${f.id}/approve`), `${f.reference} activated`)) reload();
  };
  const reject = async (f: any) => {
    const reason = prompt(`Reject ${f.reference}? Reason:`);
    if (reason && (await run(() => d.post(`/api/funding/${f.id}/reject`, { reason }), 'Rejected'))) reload();
  };
  return (
    <>
      <PageHead eyebrow="Steps 01–02 · Fund and activate" title="Funding queue">
        {me.role !== 'dist_approver' && <button onClick={() => setCreating(true)}>New funding reference</button>}
      </PageHead>
      <div className="banner" style={{ marginBottom: 16 }}>
        <span className="grow small">Treasury matches the cleared bank deposit to its reference. A <b>different</b> approver then activates the fuel lot, which posts the funding entry to the ledger.</span>
      </div>
      <div className="card white table-wrap">
        <table>
          <thead><tr><th>Reference</th><th>Company</th><th>Grade</th><th className="r">Amount</th><th className="r">Gallons</th><th>Bank ref</th><th>Status</th><th>Lot</th><th></th></tr></thead>
          <tbody>
            {data?.map((f: any) => (
              <tr key={f.id}>
                <td className="mono">{f.reference}</td><td>{f.company_name}</td><td>{cap(f.grade)}</td>
                <td className="r num">{money(f.amount_minor, f.currency)}</td><td className="r num">{gal(f.gallons_mgal)}</td>
                <td className="small">{f.bank_reference ?? '—'}{f.matched_by_name && <div className="muted">by {f.matched_by_name}</div>}</td>
                <td><Status s={f.status} />{f.reject_reason && <div className="small muted">{f.reject_reason}</div>}</td>
                <td className="mono">{f.lot_code ?? '—'}</td>
                <td className="r">
                  <div className="row" style={{ justifyContent: 'flex-end' }}>
                    {f.status === 'awaiting_bank' && ['dist_treasury', 'dist_admin'].includes(me.role) && <button className="sm" onClick={() => setMatching(f)}>Match deposit</button>}
                    {f.status === 'matched' && ['dist_approver', 'dist_admin'].includes(me.role) && (
                      <button className="sm dark" disabled={busy || f.matched_by === me.userId} title={f.matched_by === me.userId ? 'You matched this deposit; another approver must activate' : ''} onClick={() => approve(f)}>Activate lot</button>
                    )}
                    {(f.status === 'awaiting_bank' || f.status === 'matched') && <button className="sm ghost" onClick={() => reject(f)}>Reject</button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {matching && <MatchModal f={matching} onClose={() => setMatching(null)} onDone={() => { setMatching(null); reload(); }} />}
      {creating && <NewFundingModal onClose={() => setCreating(false)} onDone={() => { setCreating(false); reload(); }} />}
    </>
  );
}

function MatchModal({ f, onClose, onDone }: { f: any; onClose: () => void; onDone: () => void }) {
  const [bankReference, setRef] = useState('');
  const [amount, setAmount] = useState((f.amount_minor / 100).toFixed(2));
  const { busy, run } = useAction();
  const submit = async () => {
    const bankAmountMinor = Math.round(Number(amount) * 100);
    if (await run(() => d.post(`/api/funding/${f.id}/match`, { bankReference, bankAmountMinor }), 'Deposit matched; awaiting second approver')) onDone();
  };
  return (
    <Modal title={`Match ${f.reference}`} onClose={onClose}>
      <div className="stack">
        <p className="small muted">{f.company_name} expects {money(f.amount_minor, f.currency)} for {gal(f.gallons_mgal)} gal {f.grade}.</p>
        <label>Bank transaction reference<input value={bankReference} onChange={(e) => setRef(e.target.value)} placeholder="e.g. UNIBANK-55120" /></label>
        <label>Cleared amount ({f.currency})<input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <button disabled={busy || bankReference.length < 3} onClick={submit}>Confirm match</button>
      </div>
    </Modal>
  );
}

export function NewFundingModal({ onClose, onDone, companyId, surface = 'distributor' }: { onClose: () => void; onDone: () => void; companyId?: number; surface?: 'distributor' | 'corporate' }) {
  const client = api(surface);
  const companies = useLoad(() => (companyId ? Promise.resolve([]) : client.get('/api/companies')), []);
  const [cid, setCid] = useState<number | ''>(companyId ?? '');
  const [grade, setGrade] = useState('diesel');
  const [amount, setAmount] = useState('');
  const [created, setCreated] = useState<any>(null);
  const { busy, run } = useAction();
  const submit = async () => {
    const out = await run(() => client.post('/api/funding', { companyId: Number(cid), grade, amountMinor: Math.round(Number(amount) * 100) }));
    if (out) setCreated(out);
  };
  if (created) {
    return (
      <Modal title="Payment reference created" onClose={onDone}>
        <div className="stack">
          <p>Pay by bank transfer and put this reference in the transfer memo:</p>
          <div className="code" style={{ fontSize: 32 }}>{created.reference}</div>
          <div className="kv"><span>Amount</span><b>{money(created.amount_minor, created.currency)}</b></div>
          <div className="kv"><span>Buys</span><b>{gal(created.gallons_mgal, 1)} gal {created.grade} at {money(created.price_minor, created.currency)}/gal</b></div>
          <p className="small muted">Gallons become available once treasury verifies the deposit and a second approver activates the lot.</p>
          <button onClick={onDone}>Done</button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title="New funding reference" onClose={onClose}>
      <div className="stack">
        {!companyId && (
          <label>Company
            <select value={cid} onChange={(e) => setCid(Number(e.target.value))}>
              <option value="">Select…</option>
              {companies.data?.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
        <label>Grade
          <select value={grade} onChange={(e) => setGrade(e.target.value)}>
            <option value="diesel">Diesel</option><option value="gasoline">Gasoline</option><option value="premium">Premium</option>
          </select>
        </label>
        <label>Transfer amount (HTG)<input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <button disabled={busy || !cid || !(Number(amount) > 0)} onClick={submit}>Create reference</button>
      </div>
    </Modal>
  );
}

function Shifts() {
  const { data } = useLoad(() => d.get('/api/shifts'), [], 15000);
  return (
    <>
      <PageHead eyebrow="Step 05 · Reconcile" title="Shift reconciliation" />
      <div className="card white table-wrap">
        <table>
          <thead><tr><th>#</th><th>Station</th><th>Terminal</th><th>Attendant</th><th>Opened</th><th>Closed</th><th className="r">Digital</th><th className="r">Pump</th><th className="r">Variance</th><th>Status</th></tr></thead>
          <tbody>
            {data?.map((s: any) => {
              const sum = (j: string | null) => (j ? Object.values(JSON.parse(j) as Record<string, number>).reduce((a, b) => a + b, 0) : null);
              return (
                <tr key={s.id}><td>{s.id}</td><td>{s.station_name}</td><td>{s.terminal_label}</td><td>{s.attendant_name}</td>
                  <td>{when(s.opened_at)}</td><td>{when(s.closed_at)}</td>
                  <td className="r num">{s.digital_json ? gal(sum(s.digital_json), 1) : '—'}</td>
                  <td className="r num">{s.pump_json ? gal(sum(s.pump_json), 1) : '—'}</td>
                  <td className="r num">{s.variance_mgal != null ? gal(s.variance_mgal, 1) : '—'}</td>
                  <td><Status s={s.status} />{s.manager_note && <div className="small muted">{s.manager_note}</div>}</td></tr>
              );
            })}
          </tbody>
        </table>
        {!data?.length && <Empty>No shifts yet.</Empty>}
      </div>
    </>
  );
}

function Network() {
  const me = useMe();
  const isAdmin = me.role === 'dist_admin';
  const canFreeze = isAdmin || me.role === 'dist_approver';
  const companies = useLoad(() => d.get('/api/distributor/dashboard'), []);
  const stations = useLoad(() => d.get('/api/stations'), []);
  const lots = useLoad(() => d.get('/api/lots'), []);
  const { busy, run } = useAction();
  const [modal, setModal] = useState<null | { kind: string; data?: any }>(null);
  const reloadAll = () => { companies.reload(); stations.reload(); lots.reload(); };
  const freeze = async (entity: string, id: number, frozen: boolean) => {
    const reason = frozen ? prompt(`Reason for freezing this ${entity}?`) : 'Unfrozen';
    if (reason === null) return;
    if (await run(() => d.post('/api/freeze', { entity, id, frozen, reason }), frozen ? `${cap(entity)} frozen` : `${cap(entity)} active`)) reloadAll();
  };
  const FreezeBtn = ({ entity, row }: { entity: string; row: any }) =>
    canFreeze && row.status !== 'expired' && row.status !== 'retired' ? (
      <button className={`sm ${row.status === 'frozen' ? 'secondary' : 'danger'}`} disabled={busy} onClick={() => freeze(entity, row.id, row.status !== 'frozen')}>
        {row.status === 'frozen' ? 'Unfreeze' : 'Freeze'}
      </button>
    ) : null;

  return (
    <>
      <PageHead eyebrow="Network" title="Clients, stations and lots">
        {isAdmin && <><button onClick={() => setModal({ kind: 'company' })}>Add company</button>
          <button onClick={() => setModal({ kind: 'station' })}>Add station</button>
          <button className="secondary" onClick={() => setModal({ kind: 'user' })}>Add staff user</button></>}
      </PageHead>
      <div className="card white table-wrap">
        <h2>Corporate clients</h2>
        <table>
          <thead><tr><th>Company</th><th>Status</th><th>Contract prices</th><th className="r">Approval threshold</th><th></th></tr></thead>
          <tbody>
            {companies.data?.companies.map((c: any) => (
              <tr key={c.id}><td><b>{c.name}</b></td><td><Status s={c.status} /></td>
                <td className="small">{c.contracts.map((p: any) => `${cap(p.grade)} ${money(p.price_minor, p.currency)}`).join(' · ') || '—'}</td>
                <td className="r num">{gal(c.approval_threshold_mgal)} gal</td>
                <td className="r"><div className="row" style={{ justifyContent: 'flex-end' }}>
                  {isAdmin && <button className="sm secondary" onClick={() => setModal({ kind: 'price', data: c })}>Set price</button>}
                  <FreezeBtn entity="company" row={c} /></div></td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card white table-wrap mt">
        <h2>Stations and terminals</h2>
        <table>
          <thead><tr><th>Station</th><th>Status</th><th>Terminal</th><th>Device</th><th></th></tr></thead>
          <tbody>
            {stations.data?.map((s: any) => (
              <tr key={s.id}><td><b>{s.name}</b><div className="small muted">{s.address}</div></td><td><Status s={s.status} /></td>
                <td>{s.terminal_label ?? '—'} {s.terminal_status && <Status s={s.terminal_status} />}</td>
                <td className="small">{s.terminal_activated ? 'Activated' : s.activation_code ? <>Activation code <span className="mono"><b>{s.activation_code}</b></span></> : '—'}</td>
                <td className="r"><div className="row" style={{ justifyContent: 'flex-end' }}>
                  {isAdmin && <button className="sm secondary" onClick={() => setModal({ kind: 'terminal', data: s })}>{s.terminal_id ? 'Replace terminal' : 'Register terminal'}</button>}
                  <FreezeBtn entity="station" row={s} />
                  {s.terminal_id && <FreezeBtn entity="terminal" row={{ id: s.terminal_id, status: s.terminal_status }} />}
                </div></td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card white table-wrap mt">
        <h2>Fuel lots</h2>
        <table>
          <thead><tr><th>Lot</th><th>Company</th><th>Grade</th><th className="r">Gallons</th><th className="r">Price/gal</th><th>Expires</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {lots.data?.map((l: any) => (
              <tr key={l.id}><td className="mono">{l.code}</td><td>{l.company_name}</td><td>{cap(l.grade)}</td>
                <td className="r num">{gal(l.gallons_mgal)}</td><td className="r num">{money(l.price_minor, l.currency)}</td>
                <td>{date(l.expires_on)}</td><td><Status s={l.status} /></td><td className="r"><FreezeBtn entity="lot" row={l} /></td></tr>
            ))}
          </tbody>
        </table>
        {!lots.data?.length && <Empty>No lots activated yet.</Empty>}
      </div>
      {modal && <NetworkModal modal={modal} stations={stations.data ?? []} companies={companies.data?.companies ?? []} onClose={() => setModal(null)} onDone={() => { setModal(null); reloadAll(); }} />}
    </>
  );
}

function NetworkModal({ modal, stations, companies, onClose, onDone }: { modal: { kind: string; data?: any }; stations: any[]; companies: any[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState<Record<string, string>>({ grade: 'diesel', role: 'st_attendant' });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const { busy, run } = useAction();
  const [result, setResult] = useState<any>(null);
  const submit = async () => {
    let out;
    if (modal.kind === 'company') out = await run(() => d.post('/api/companies', { name: f.name, approvalThresholdGallons: Number(f.threshold || 500) }), 'Company added');
    if (modal.kind === 'station') out = await run(() => d.post('/api/stations', { name: f.name, address: f.address }), 'Station added');
    if (modal.kind === 'price') out = await run(() => d.post('/api/contracts', { companyId: modal.data.id, grade: f.grade, priceMinor: Math.round(Number(f.price) * 100) }), 'Contract price set');
    if (modal.kind === 'terminal') {
      out = await run(() => d.post('/api/terminals', { stationId: modal.data.id, label: f.label }));
      if (out) return setResult(out);
    }
    if (modal.kind === 'user') {
      out = await run(() => d.post('/api/users', {
        name: f.name, login: f.login, password: f.password, role: f.role,
        companyId: f.companyId ? Number(f.companyId) : undefined, stationId: f.stationId ? Number(f.stationId) : undefined,
      }), 'User created');
    }
    if (out) onDone();
  };
  if (result) {
    return (
      <Modal title="Terminal registered" onClose={onDone}>
        <div className="stack">
          <p>Enter this one-time activation code on the station’s Android phone or tablet:</p>
          <div className="code" style={{ fontSize: 32 }}>{result.activation_code}</div>
          <button onClick={onDone}>Done</button>
        </div>
      </Modal>
    );
  }
  const titles: Record<string, string> = { company: 'Add company', station: 'Add station', price: `Contract price · ${modal.data?.name}`, terminal: `Terminal for ${modal.data?.name}`, user: 'Add staff user' };
  return (
    <Modal title={titles[modal.kind]} onClose={onClose}>
      <div className="stack">
        {(modal.kind === 'company' || modal.kind === 'station' || modal.kind === 'user') && <label>Name<input onChange={set('name')} /></label>}
        {modal.kind === 'company' && <label>Batches above this many gallons need a second approver<input type="number" placeholder="500" onChange={set('threshold')} /></label>}
        {modal.kind === 'station' && <label>Address<input onChange={set('address')} /></label>}
        {modal.kind === 'price' && <>
          <label>Grade<select value={f.grade} onChange={set('grade')}><option value="diesel">Diesel</option><option value="gasoline">Gasoline</option><option value="premium">Premium</option></select></label>
          <label>Price per gallon (HTG)<input type="number" step="0.01" onChange={set('price')} /></label>
          <p className="small muted">Existing lots keep the price they were funded at.</p>
        </>}
        {modal.kind === 'terminal' && <>
          <label>Terminal label<input placeholder="T-05" onChange={set('label')} /></label>
          <p className="small muted">One terminal per station. Registering a new one retires the current device.</p>
        </>}
        {modal.kind === 'user' && <>
          <label>Login<input onChange={set('login')} /></label>
          <label>Temporary password (8+ characters)<input type="password" onChange={set('password')} /></label>
          <label>Role<select value={f.role} onChange={set('role')}>
            <option value="dist_admin">Distributor admin</option><option value="dist_treasury">Distributor treasury</option><option value="dist_approver">Distributor approver</option>
            <option value="co_preparer">Company preparer</option><option value="co_approver">Company approver</option>
            <option value="st_manager">Station manager</option><option value="st_attendant">Station attendant</option>
          </select></label>
          {f.role.startsWith('co_') && <label>Company<select onChange={set('companyId')}><option value="">Select…</option>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
          {f.role.startsWith('st_') && <label>Station<select onChange={set('stationId')}><option value="">Select…</option>{stations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}
        </>}
        <button disabled={busy} onClick={submit}>Save</button>
      </div>
    </Modal>
  );
}

function Ledger() {
  const me = useMe();
  const { data, reload } = useLoad(() => d.get('/api/ledger/journal'), []);
  const check = useLoad(() => d.get('/api/ledger/check'), []);
  const { busy, run } = useAction();
  const expire = async () => {
    const out = await run(() => d.post('/api/lots/expire'));
    if (out) { alert(out.length ? `Expired ${out.length} lot(s): ${out.map((o: any) => o.lot).join(', ')}` : 'No lots past their expiry date.'); reload(); check.reload(); }
  };
  const label = (a: string) => a.replace(/^co:(\d+):/, 'Company $1 · ').replace(/^emp:(\d+):/, 'Employee $1 · ').replace(/^stn:(\d+):/, 'Station $1 · ').replace(/^dist:/, 'Distributor · ').replace(/_/g, ' ');
  return (
    <>
      <PageHead eyebrow="Ledger and controls" title="One double-entry ledger is the source of truth">
        {['dist_approver', 'dist_admin'].includes(me.role) && <button className="secondary" disabled={busy} onClick={expire}>Run lot expirations</button>}
      </PageHead>
      {check.data && (
        <div className={`banner ${check.data.ok ? 'ok' : 'bad'}`} style={{ marginBottom: 16 }}>
          <span className="grow">
            <b>Daily balance rule:</b> {check.data.ok ? `holds for all ${check.data.lotsChecked} lots; every entry balances.` : check.data.issues.map((i: any) => `${i.lot ?? 'entry ' + i.entry}: ${i.problem}`).join('; ')}
          </span>
        </div>
      )}
      <div className="card white table-wrap">
        <table>
          <thead><tr><th>#</th><th>Event</th><th>Debit</th><th>Credit</th><th>Memo</th><th>By</th><th>When</th></tr></thead>
          <tbody>
            {data?.map((e: any) => {
              const debits = e.lines.filter((l: any) => l.debit > 0);
              const credits = e.lines.filter((l: any) => l.credit > 0);
              const fmt = (l: any, v: number) => (
                <div key={l.id} className="small">{l.account_label ?? label(l.account)}{l.lot_code ? <span className="muted"> [{l.lot_code}]</span> : ''} <b className="num">{l.unit === 'mgal' ? `${gal(v, 1)} gal` : money(v, l.unit)}</b></div>
              );
              return (
                <tr key={e.id}><td>{e.id}</td><td><b>{cap(e.kind.replace(/_/g, ' '))}</b>{e.company_name && <div className="small muted">{e.company_name}</div>}</td>
                  <td>{debits.map((l: any) => fmt(l, l.debit))}</td><td>{credits.map((l: any) => fmt(l, l.credit))}</td>
                  <td className="small">{e.memo}</td><td className="small">{e.created_by_name ?? 'System'}</td><td className="small">{when(e.created_at)}</td></tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Audit() {
  const { data } = useLoad(() => d.get('/api/audit'), []);
  return (
    <>
      <PageHead eyebrow="Controls" title="Audit log" />
      <div className="card white table-wrap">
        <table>
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead>
          <tbody>
            {data?.map((a: any) => (
              <tr key={a.id}><td className="small">{when(a.at)}</td><td>{a.actor_name ?? 'System'}</td><td className="mono">{a.action}</td>
                <td className="small">{a.entity} #{a.entity_id}</td><td className="small mono" style={{ maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.data_json}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Refunds() {
  return (
    <>
      <PageHead eyebrow="Treasury" title="Refunds of unused prepaid gallons" />
      <div className="banner" style={{ marginBottom: 16 }}>
        <span className="grow small">Approving a refund removes the gallons from the company pool and books a refund payable. Treasury then records the outgoing transfer; the approver can’t record the payout.</span>
      </div>
      <RefundsTable surface="distributor" />
    </>
  );
}
