import { auditAction, auditDetails, auditEntity } from '../auditLabels';
import { useState } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import { api, cap, date, gal, money, when } from '../api';
import { Authed, Empty, Kpi, Modal, PageHead, Shell, Status, useAction, useLoad, useMe } from '../ui';
import { SageExport } from './accounting';
import { FuelAlerts } from './alerts';
import { BankStatements, RefundsTable } from './finance';
import { ExceptionsPanel } from './shared';
import { t } from '../i18n';

const d = api('distributor');

export default function Distributor() {
  return (
    <Authed surface="distributor">
      <Shell surface="distributor" nav={[
        ['/distributor', t('Overview')], ['/distributor/funding', t('Funding queue')], ['/distributor/bank', t('Bank statements')],
        ['/distributor/refunds', t('Refunds')], ['/distributor/exceptions', t('Exceptions')], ['/distributor/alerts', t('Fuel alerts')],
        ['/distributor/shifts', t('Shift reconciliation')], ['/distributor/network', t('Clients & stations')],
        ['/distributor/ledger', t('Ledger')], ['/distributor/accounting', t('Sage export')], ['/distributor/audit', t('Audit log')],
      ]}>
        <Routes>
          <Route index element={<Overview />} />
          <Route path="funding" element={<Funding />} />
          <Route path="bank" element={<BankStatements />} />
          <Route path="refunds" element={<Refunds />} />
          <Route path="exceptions" element={<><PageHead eyebrow={t('Controls')} title={t('Exceptions')} /><ExceptionsPanel surface="distributor" /></>} />
          <Route path="alerts" element={<FuelAlerts />} />
          <Route path="shifts" element={<Shifts />} />
          <Route path="network" element={<Network />} />
          <Route path="ledger" element={<Ledger />} />
          <Route path="accounting" element={<SageExport />} />
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
  const max = Math.max(1, ...data.sales_today.map((r: any) => r.minor));
  const alert = data.alerts[0];
  return (
    <>
      <PageHead eyebrow={t('Distributor control center')} title={t('One view of funds, fuel sales and exceptions')} />
      <div className="grid g4">
        <Kpi label={t('Deposits verified')} value={k.deposits_verified} sub={money(k.bank_verified_minor)} />
        <Kpi label={t('Prepaid owed')} value={money(k.prepaid_owed_minor)} sub={t('Unallocated + employee balances')} />
        <Kpi label={t('In employee wallets')} value={money(k.allocated_minor)} sub={t('{amount} redeemed to date', { amount: money(k.redeemed_minor) })} />
        <Kpi label={t('Open exceptions')} value={k.open_exceptions} bad={k.open_exceptions > 0} />
      </div>
      <div className="grid g2 mt">
        <div className="card">
          <div className="row between"><h2>{t('Funding queue')}</h2><Link to="/distributor/funding" className="small">{t('All →')}</Link></div>
          <table><tbody>
            {data.funding_queue.slice(0, 6).map((f: any) => (
              <tr key={f.id}><td className="mono">{f.reference}</td><td>{f.company_name}</td><td className="r"><Status s={f.status} /></td></tr>
            ))}
          </tbody></table>
        </div>
        <div className="card">
          <h2>{t('Fuel sales today')}</h2>
          <table><tbody>
            {data.sales_today.map((s: any) => (
              <tr key={s.id}><td style={{ width: 90 }}>{s.name}</td>
                <td><div className="bar"><div style={{ width: `${(s.minor / max) * 100}%` }} /></div></td>
                <td className="r num" style={{ width: 150 }}><b>{money(s.minor)}</b><div className="small muted">{gal(s.mgal, 1)} gal</div></td></tr>
            ))}
          </tbody></table>
        </div>
      </div>
      {data.open_fuel_alerts > 0 && (
        <div className="banner mt"><span className="grow">{t('{n} fuel alert(s) to review.', { n: data.open_fuel_alerts })}</span>
          <Link to="/distributor/alerts"><button className="sm">{t('Review')}</button></Link></div>
      )}
      {k.unmatched_bank_lines > 0 && (
        <div className="banner mt"><span className="grow">{t('{n} imported bank line(s) could not be matched to a funding reference.', { n: k.unmatched_bank_lines })}</span>
          <Link to="/distributor/bank"><button className="sm">{t('Match')}</button></Link></div>
      )}
      {k.refunds_pending > 0 && (
        <div className="banner mt"><span className="grow">{t('{n} refund(s) awaiting approval or payout · {amount} payable.', { n: k.refunds_pending, amount: money(k.refunds_payable_minor) })}</span>
          <Link to="/distributor/refunds"><button className="sm">{t('Review')}</button></Link></div>
      )}
      {alert && (
        <div className="banner mt"><span>⚠</span><span className="grow">{alert.summary}</span>
          <Link to="/distributor/exceptions"><button className="sm">{t('Review')}</button></Link></div>
      )}
      <div className={`banner mt ${data.balance_rule.ok ? 'ok' : 'bad'}`}>
        <span className="grow">
          <b>{t('Daily balance rule')}</b> — {t('cleared funds = unallocated + employee available + reserved + redeemed + expired + refunded, per lot.')}
          {' '}{data.balance_rule.ok ? t('Holds across {n} lots.', { n: data.balance_rule.lotsChecked }) : t('{n} issue(s) found.', { n: data.balance_rule.issues.length })}
        </span>
      </div>
      <div className="card white mt">
        <h2>{t('Corporate clients')}</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>{t('Company')}</th><th>{t('Status')}</th><th className="r">{t('Unallocated')}</th><th className="r">{t('In wallets')}</th><th className="r">{t('Redeemed')}</th><th>{t('Contract prices')}</th></tr></thead>
          <tbody>
            {data.companies.map((c: any) => (
              <tr key={c.id}><td><b>{c.name}</b></td><td><Status s={c.status} /></td>
                <td className="r num">{money(c.unallocated_minor)}</td><td className="r num">{money(c.allocated_minor)}</td>
                <td className="r num">{money(c.redeemed_minor)}</td>
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
    if (await run(() => d.post(`/api/funding/${f.id}/approve`), t('{ref} activated', { ref: f.reference }))) reload();
  };
  const reject = async (f: any) => {
    const reason = prompt(t('Reject {ref}? Reason:', { ref: f.reference }));
    if (reason && (await run(() => d.post(`/api/funding/${f.id}/reject`, { reason }), t('Rejected')))) reload();
  };
  return (
    <>
      <PageHead eyebrow={t('Steps 01–02 · Fund and activate')} title={t('Funding queue')}>
        {me.role !== 'dist_approver' && <button onClick={() => setCreating(true)}>{t('New funding reference')}</button>}
      </PageHead>
      <div className="banner" style={{ marginBottom: 16 }}>
        <span className="grow small">{t('Treasury matches the cleared bank deposit to its reference. A different approver then activates the fuel lot, which posts the funding entry to the ledger.')}</span>
      </div>
      <div className="card white table-wrap">
        <table>
          <thead><tr><th>{t('Reference')}</th><th>{t('Company')}</th><th className="r">{t('Amount')}</th><th>{t('Bank ref')}</th><th>{t('Status')}</th><th>{t('Lot')}</th><th></th></tr></thead>
          <tbody>
            {data?.map((f: any) => (
              <tr key={f.id}>
                <td className="mono">{f.reference}</td><td>{f.company_name}</td>
                <td className="r num">{money(f.amount_minor, f.currency)}</td>
                <td className="small">{f.bank_reference ?? '—'}{f.matched_by_name && <div className="muted">{t('by {name}', { name: f.matched_by_name })}</div>}</td>
                <td><Status s={f.status} />{f.reject_reason && <div className="small muted">{f.reject_reason}</div>}</td>
                <td className="mono">{f.lot_code ?? '—'}</td>
                <td className="r">
                  <div className="row" style={{ justifyContent: 'flex-end' }}>
                    {f.status === 'awaiting_bank' && ['dist_treasury', 'dist_admin'].includes(me.role) && <button className="sm" onClick={() => setMatching(f)}>{t('Match deposit')}</button>}
                    {f.status === 'matched' && ['dist_approver', 'dist_admin'].includes(me.role) && (
                      <button className="sm dark" disabled={busy || f.matched_by === me.userId} title={f.matched_by === me.userId ? t('You matched this deposit; another approver must activate') : ''} onClick={() => approve(f)}>{t('Activate lot')}</button>
                    )}
                    {(f.status === 'awaiting_bank' || f.status === 'matched') && <button className="sm ghost" onClick={() => reject(f)}>{t('Reject')}</button>}
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
    if (await run(() => d.post(`/api/funding/${f.id}/match`, { bankReference, bankAmountMinor }), t('Deposit matched; awaiting second approver'))) onDone();
  };
  return (
    <Modal title={t('Match {ref}', { ref: f.reference })} onClose={onClose}>
      <div className="stack">
        <p className="small muted">{t('{company} announced a transfer of {amount}.', { company: f.company_name, amount: money(f.amount_minor, f.currency) })}</p>
        <label>{t('Bank transaction reference')}<input value={bankReference} onChange={(e) => setRef(e.target.value)} placeholder={t('e.g. UNIBANK-55120')} /></label>
        <label>{t('Cleared amount ({currency})', { currency: f.currency })}<input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <button disabled={busy || bankReference.length < 3} onClick={submit}>{t('Confirm match')}</button>
      </div>
    </Modal>
  );
}

export function NewFundingModal({ onClose, onDone, companyId, surface = 'distributor' }: { onClose: () => void; onDone: () => void; companyId?: number; surface?: 'distributor' | 'corporate' }) {
  const client = api(surface);
  const companies = useLoad(() => (companyId ? Promise.resolve([]) : client.get('/api/companies')), []);
  const [cid, setCid] = useState<number | ''>(companyId ?? '');
  const [amount, setAmount] = useState('');
  const [created, setCreated] = useState<any>(null);
  const { busy, run } = useAction();
  const submit = async () => {
    const out = await run(() => client.post('/api/funding', { companyId: Number(cid), amountMinor: Math.round(Number(amount) * 100) }));
    if (out) setCreated(out);
  };
  if (created) {
    return (
      <Modal title={t('Payment reference created')} onClose={onDone}>
        <div className="stack">
          <p>{t('Pay by bank transfer and put this reference in the transfer memo:')}</p>
          <div className="code" style={{ fontSize: 32 }}>{created.reference}</div>
          <div className="kv"><span>{t('Amount')}</span><b>{money(created.amount_minor, created.currency)}</b></div>
          <p className="small muted">{t('The money becomes available to allocate once treasury verifies the deposit and a second approver activates it.')}</p>
          <button onClick={onDone}>{t('Done')}</button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title={t('New funding reference')} onClose={onClose}>
      <div className="stack">
        {!companyId && (
          <label>{t('Company')}
            <select value={cid} onChange={(e) => setCid(Number(e.target.value))}>
              <option value="">{t('Select…')}</option>
              {companies.data?.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
        <label>{t('Transfer amount (HTG)')}<input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <button disabled={busy || !cid || !(Number(amount) > 0)} onClick={submit}>{t('Create reference')}</button>
      </div>
    </Modal>
  );
}

function Shifts() {
  const { data } = useLoad(() => d.get('/api/shifts'), [], 15000);
  return (
    <>
      <PageHead eyebrow={t('Step 05 · Reconcile')} title={t('Shift reconciliation')} />
      <div className="card white table-wrap">
        <table>
          <thead><tr><th>#</th><th>{t('Station')}</th><th>{t('Terminal')}</th><th>{t('Attendant')}</th><th>{t('Opened')}</th><th>{t('Closed')}</th><th className="r">{t('Charged')}</th><th className="r">{t('POS')}</th><th className="r">{t('Variance')}</th><th className="r">{t('Pump gal var.')}</th><th>{t('Status')}</th></tr></thead>
          <tbody>
            {data?.map((s: any) => {
              const total = (o: Record<string, number>) => Object.values(o ?? {}).reduce((a, b) => a + b, 0);
              return (
                <tr key={s.id}><td>{s.id}</td><td>{s.station_name}</td><td>{s.terminal_label}</td><td>{s.attendant_name}</td>
                  <td>{when(s.opened_at)}</td><td>{when(s.closed_at)}</td>
                  <td className="r num">{s.digital_json ? money(total(JSON.parse(s.digital_json).amounts)) : '—'}</td>
                  <td className="r num">{s.pos_json ? money(total(JSON.parse(s.pos_json))) : '—'}</td>
                  <td className="r num">{s.variance_minor != null ? money(s.variance_minor) : '—'}</td>
                  <td className="r num">{s.variance_mgal != null ? gal(s.variance_mgal, 1) : '—'}</td>
                  <td><Status s={s.status} />{s.manager_note && <div className="small muted">{s.manager_note}</div>}</td></tr>
              );
            })}
          </tbody>
        </table>
        {!data?.length && <Empty>{t('No shifts yet.')}</Empty>}
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
    const reason = frozen ? prompt(t('Reason for freezing this {entity}?', { entity: cap(entity).toLowerCase() })) : 'Unfrozen';
    if (reason === null) return;
    if (await run(() => d.post('/api/freeze', { entity, id, frozen, reason }), frozen ? t('{entity} frozen', { entity: cap(entity) }) : t('{entity} active', { entity: cap(entity) }))) reloadAll();
  };
  const FreezeBtn = ({ entity, row }: { entity: string; row: any }) =>
    canFreeze && row.status !== 'expired' && row.status !== 'retired' ? (
      <button className={`sm ${row.status === 'frozen' ? 'secondary' : 'danger'}`} disabled={busy} onClick={() => freeze(entity, row.id, row.status !== 'frozen')}>
        {row.status === 'frozen' ? t('Unfreeze') : t('Freeze')}
      </button>
    ) : null;

  return (
    <>
      <PageHead eyebrow={t('Network')} title={t('Clients, stations and lots')}>
        {isAdmin && <><button onClick={() => setModal({ kind: 'company' })}>{t('Add company')}</button>
          <button onClick={() => setModal({ kind: 'station' })}>{t('Add station')}</button>
          <button className="secondary" onClick={() => setModal({ kind: 'user' })}>{t('Add staff user')}</button></>}
      </PageHead>
      <div className="card white table-wrap">
        <h2>{t('Corporate clients')}</h2>
        <table>
          <thead><tr><th>{t('Company')}</th><th>{t('Status')}</th><th>{t('Contract prices')}</th><th className="r">{t('Approval threshold')}</th><th></th></tr></thead>
          <tbody>
            {companies.data?.companies.map((c: any) => (
              <tr key={c.id}><td><b>{c.name}</b></td><td><Status s={c.status} /></td>
                <td className="small">{c.contracts.map((p: any) => `${cap(p.grade)} ${money(p.price_minor, p.currency)}`).join(' · ') || '—'}</td>
                <td className="r num">{money(c.approval_threshold_minor)}</td>
                <td className="r"><div className="row" style={{ justifyContent: 'flex-end' }}>
                  {isAdmin && <button className="sm secondary" onClick={() => setModal({ kind: 'price', data: c })}>{t('Set price')}</button>}
                  <FreezeBtn entity="company" row={c} /></div></td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card white table-wrap mt">
        <h2>{t('Stations and terminals')}</h2>
        <table>
          <thead><tr><th>{t('Station')}</th><th>{t('Status')}</th><th>{t('Terminal')}</th><th>{t('Device')}</th><th></th></tr></thead>
          <tbody>
            {stations.data?.map((s: any) => (
              <tr key={s.id}><td><b>{s.name}</b><div className="small muted">{s.address}</div></td><td><Status s={s.status} /></td>
                <td>{s.terminal_label ?? '—'} {s.terminal_status && <Status s={s.terminal_status} />}</td>
                <td className="small">{s.terminal_activated ? t('Activated') : s.activation_code ? <>{t('Activation code')} <span className="mono"><b>{s.activation_code}</b></span></> : '—'}</td>
                <td className="r"><div className="row" style={{ justifyContent: 'flex-end' }}>
                  {isAdmin && <button className="sm secondary" onClick={() => setModal({ kind: 'terminal', data: s })}>{s.terminal_id ? t('Replace terminal') : t('Register terminal')}</button>}
                  <FreezeBtn entity="station" row={s} />
                  {s.terminal_id && <FreezeBtn entity="terminal" row={{ id: s.terminal_id, status: s.terminal_status }} />}
                </div></td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card white table-wrap mt">
        <h2>{t('Funded lots')}</h2>
        <table>
          <thead><tr><th>{t('Lot')}</th><th>{t('Company')}</th><th className="r">{t('Cleared amount')}</th><th>{t('Expires')}</th><th>{t('Status')}</th><th></th></tr></thead>
          <tbody>
            {lots.data?.map((l: any) => (
              <tr key={l.id}><td className="mono">{l.code}</td><td>{l.company_name}</td>
                <td className="r num">{money(l.amount_minor, l.currency)}</td>
                <td>{date(l.expires_on)}</td><td><Status s={l.status} /></td><td className="r"><FreezeBtn entity="lot" row={l} /></td></tr>
            ))}
          </tbody>
        </table>
        {!lots.data?.length && <Empty>{t('No lots activated yet.')}</Empty>}
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
    if (modal.kind === 'company') out = await run(() => d.post('/api/companies', { name: f.name, approvalThreshold: Number(f.threshold || 500000) }), t('Company added'));
    if (modal.kind === 'station') out = await run(() => d.post('/api/stations', { name: f.name, address: f.address }), t('Station added'));
    if (modal.kind === 'price') out = await run(() => d.post('/api/contracts', { companyId: modal.data.id, grade: f.grade, priceMinor: Math.round(Number(f.price) * 100) }), t('Contract price set'));
    if (modal.kind === 'terminal') {
      out = await run(() => d.post('/api/terminals', { stationId: modal.data.id, label: f.label }));
      if (out) return setResult(out);
    }
    if (modal.kind === 'user') {
      out = await run(() => d.post('/api/users', {
        name: f.name, login: f.login, password: f.password, role: f.role,
        companyId: f.companyId ? Number(f.companyId) : undefined, stationId: f.stationId ? Number(f.stationId) : undefined,
      }), t('User created'));
    }
    if (out) onDone();
  };
  if (result) {
    return (
      <Modal title={t('Terminal registered')} onClose={onDone}>
        <div className="stack">
          <p>{t('Enter this one-time activation code on the station’s Android phone or tablet:')}</p>
          <div className="code" style={{ fontSize: 32 }}>{result.activation_code}</div>
          <button onClick={onDone}>{t('Done')}</button>
        </div>
      </Modal>
    );
  }
  const titles: Record<string, string> = { company: t('Add company'), station: t('Add station'), price: t('Contract price · {name}', { name: modal.data?.name }), terminal: t('Terminal for {name}', { name: modal.data?.name }), user: t('Add staff user') };
  return (
    <Modal title={titles[modal.kind]} onClose={onClose}>
      <div className="stack">
        {(modal.kind === 'company' || modal.kind === 'station' || modal.kind === 'user') && <label>{t('Name')}<input onChange={set('name')} /></label>}
        {modal.kind === 'company' && <label>{t('Allocation batches above this amount (HTG) need a second approver')}<input type="number" placeholder="500000" onChange={set('threshold')} /></label>}
        {modal.kind === 'station' && <label>{t('Address')}<input onChange={set('address')} /></label>}
        {modal.kind === 'price' && <>
          <label>{t('Grade')}<select value={f.grade} onChange={set('grade')}><option value="diesel">{cap('diesel')}</option><option value="gasoline">{cap('gasoline')}</option></select></label>
          <label>{t('Price per gallon (HTG)')}<input type="number" step="0.01" onChange={set('price')} /></label>
          <p className="small muted">{t('Applies to fuelings approved from now on. Balances are in HTG and are not affected.')}</p>
        </>}
        {modal.kind === 'terminal' && <>
          <label>{t('Terminal label')}<input placeholder="T-05" onChange={set('label')} /></label>
          <p className="small muted">{t('One terminal per station. Registering a new one retires the current device.')}</p>
        </>}
        {modal.kind === 'user' && <>
          <label>{t('Login')}<input onChange={set('login')} /></label>
          <label>{t('Temporary password (8+ characters)')}<input type="password" onChange={set('password')} /></label>
          <label>{t('Role')}<select value={f.role} onChange={set('role')}>
            <option value="dist_admin">{t('Distributor admin')}</option><option value="dist_treasury">{t('Distributor treasury')}</option><option value="dist_approver">{t('Distributor approver')}</option>
            <option value="co_preparer">{t('Company preparer')}</option><option value="co_approver">{t('Company approver')}</option>
            <option value="st_manager">{t('Station manager')}</option><option value="st_attendant">{t('Station attendant')}</option>
          </select></label>
          {f.role.startsWith('co_') && <label>{t('Company')}<select onChange={set('companyId')}><option value="">{t('Select…')}</option>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
          {f.role.startsWith('st_') && <label>{t('Station')}<select onChange={set('stationId')}><option value="">{t('Select…')}</option>{stations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}
        </>}
        <button disabled={busy} onClick={submit}>{t('Save')}</button>
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
    if (out) { alert(out.length ? t('Expired {n} lot(s): {lots}', { n: out.length, lots: out.map((o: any) => o.lot).join(', ') }) : t('No lots past their expiry date.')); reload(); check.reload(); }
  };
  const label = (a: string) => a.replace(/^co:(\d+):/, t('Company $1 · ')).replace(/^emp:(\d+):/, t('Employee $1 · ')).replace(/^stn:(\d+):/, t('Station $1 · ')).replace(/^dist:/, t('Distributor · ')).replace(/_/g, ' ');
  return (
    <>
      <PageHead eyebrow={t('Ledger and controls')} title={t('One double-entry ledger is the source of truth')}>
        {['dist_approver', 'dist_admin'].includes(me.role) && <button className="secondary" disabled={busy} onClick={expire}>{t('Run lot expirations')}</button>}
      </PageHead>
      {check.data && (
        <div className={`banner ${check.data.ok ? 'ok' : 'bad'}`} style={{ marginBottom: 16 }}>
          <span className="grow">
            <b>{t('Daily balance rule:')}</b> {check.data.ok ? t('holds for all {n} lots; every entry balances.', { n: check.data.lotsChecked }) : check.data.issues.map((i: any) => `${i.lot ?? t('entry {n}', { n: i.entry })}: ${i.problem}`).join('; ')}
          </span>
        </div>
      )}
      <div className="card white table-wrap">
        <table>
          <thead><tr><th>#</th><th>{t('Event')}</th><th>{t('Debit')}</th><th>{t('Credit')}</th><th>{t('Memo')}</th><th>{t('By')}</th><th>{t('When')}</th></tr></thead>
          <tbody>
            {data?.map((e: any) => {
              const debits = e.lines.filter((l: any) => l.debit > 0);
              const credits = e.lines.filter((l: any) => l.credit > 0);
              const fmt = (l: any, v: number) => (
                <div key={l.id} className="small">{l.account_label ?? label(l.account)}{l.lot_code ? <span className="muted"> [{l.lot_code}]</span> : ''} <b className="num">{money(v, l.unit)}</b></div>
              );
              return (
                <tr key={e.id}><td>{e.id}</td><td><b>{cap(e.kind.replace(/_/g, ' '))}</b>{e.company_name && <div className="small muted">{e.company_name}</div>}</td>
                  <td>{debits.map((l: any) => fmt(l, l.debit))}</td><td>{credits.map((l: any) => fmt(l, l.credit))}</td>
                  <td className="small">{e.memo}</td><td className="small">{e.created_by_name ?? t('System')}</td><td className="small">{when(e.created_at)}</td></tr>
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
      <PageHead eyebrow={t('Controls')} title={t('Audit log')} />
      <div className="card white table-wrap">
        <table>
          <thead><tr><th>{t('When')}</th><th>{t('Who')}</th><th>{t('Action')}</th><th>{t('Entity')}</th><th>{t('Details')}</th></tr></thead>
          <tbody>
            {data?.map((a: any) => (
              <tr key={a.id}><td className="small">{when(a.at)}</td><td>{a.actor_name ?? t('System')}</td><td>{auditAction(a.action)}</td>
                <td className="small">{auditEntity(a.entity)}{a.entity_id != null ? ` #${a.entity_id}` : ''}</td>
                <td className="small" style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={auditDetails(a.data_json)}>{auditDetails(a.data_json)}</td></tr>
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
      <PageHead eyebrow={t('Treasury')} title={t('Refunds of unused prepaid funds')} />
      <div className="banner" style={{ marginBottom: 16 }}>
        <span className="grow small">{t('Approving a refund removes the amount from the company pool and books a refund payable. Treasury then records the outgoing transfer; the approver can’t record the payout.')}</span>
      </div>
      <RefundsTable surface="distributor" />
    </>
  );
}
