import { useMemo, useState } from 'react';
import { Route, Routes, useNavigate } from 'react-router-dom';
import { api, cap, date, gal, money, when } from '../api';
import { Authed, Empty, Kpi, Modal, PageHead, Shell, Status, useAction, useLoad, useMe } from '../ui';
import { NewFundingModal } from './Distributor';
import { RefundsTable } from './finance';

const c = api('corporate');

export default function Corporate() {
  return (
    <Authed surface="corporate">
      <Shell surface="corporate" nav={[
        ['/corporate', 'Overview'], ['/corporate/allocations', 'Allocations'], ['/corporate/employees', 'Employees'], ['/corporate/statement', 'Statement'],
      ]}>
        <Routes>
          <Route index element={<Overview />} />
          <Route path="allocations" element={<Allocations />} />
          <Route path="employees" element={<Employees />} />
          <Route path="statement" element={<Statement />} />
        </Routes>
      </Shell>
    </Authed>
  );
}

const useDashboard = () => {
  const me = useMe();
  return useLoad(() => c.get(`/api/companies/${me.companyId}/dashboard`), [me.companyId], 20000);
};

function Overview() {
  const me = useMe();
  const { data, reload } = useDashboard();
  const [funding, setFunding] = useState(false);
  const [refunding, setRefunding] = useState<any>(null);
  const [refundKey, setRefundKey] = useState(0);
  if (!data) return null;
  const k = data.kpis;
  return (
    <>
      <PageHead eyebrow={`Corporate client portal · ${data.company.name}`} title="Fuel benefit overview">
        <button onClick={() => setFunding(true)}>Fund account</button>
      </PageHead>
      {data.company.status === 'frozen' && <div className="banner bad" style={{ marginBottom: 16 }}>Your program is frozen by the distributor. Allocations and fueling are paused.</div>}
      <div className="grid g4">
        <Kpi label="Unallocated" value={`${gal(k.unallocated_mgal)} gal`} sub={Object.entries(k.unallocated_by_grade).map(([g, m]) => `${cap(g)} ${gal(m as number)}`).join(' · ') || 'Fund to add gallons'} />
        <Kpi label="Batch ready" value={`${gal(k.batch_ready_mgal)} gal`} sub="Drafts and batches awaiting approval" />
        <Kpi label="Recurring" value={k.recurring ? 'Monthly' : 'Off'} sub={k.recurring ? `${k.recurring.status === 'paused' ? 'Paused — ' + (k.recurring.pause_reason ?? '') : `Day ${k.recurring.day_of_month} each month`}` : 'Make a posted batch recurring'} />
        <Kpi label="In employee wallets" value={`${gal(k.allocated_mgal)} gal`} sub={`${gal(k.redeemed_mgal, 1)} gal redeemed to date`} />
      </div>
      <div className="grid g2 mt">
        <div className="card white">
          <h2>Funding</h2>
          <table><thead><tr><th>Reference</th><th>Grade</th><th className="r">Amount</th><th>Status</th></tr></thead><tbody>
            {data.funding.map((f: any) => (
              <tr key={f.id}><td className="mono">{f.reference}</td><td>{cap(f.grade)}</td><td className="r num">{money(f.amount_minor, f.currency)}</td><td><Status s={f.status} /></td></tr>
            ))}
          </tbody></table>
          {!data.funding.length && <Empty>No funding yet.</Empty>}
        </div>
        <div className="card white">
          <h2>Fuel lots</h2>
          <table><thead><tr><th>Lot</th><th>Grade</th><th className="r">Funded</th><th className="r">Unallocated</th><th>Expires</th><th></th></tr></thead><tbody>
            {data.lots.map((l: any) => (
              <tr key={l.id}><td className="mono">{l.code}</td><td>{cap(l.grade)}</td><td className="r num">{gal(l.gallons_mgal)}</td>
                <td className="r num">{gal(l.unallocated_mgal)}</td><td>{date(l.expires_on)} {l.status !== 'active' && <Status s={l.status} />}</td>
                <td className="r">{me.role === 'co_approver' && l.status === 'active' && l.unallocated_mgal > 0 && <button className="sm ghost" onClick={() => setRefunding(l)}>Refund</button>}</td></tr>
            ))}
          </tbody></table>
          {!data.lots.length && <Empty>Lots appear once your deposit is verified and activated.</Empty>}
          <p className="small muted" style={{ marginTop: 8 }}>Contract prices: {data.contracts.map((p: any) => `${cap(p.grade)} ${money(p.price_minor, p.currency)}/gal`).join(' · ')}</p>
        </div>
      </div>
      <h2 className="mt2" style={{ marginBottom: 12 }}>Refunds</h2>
      <RefundsTable key={refundKey} surface="corporate" />
      {refunding && <RequestRefund lot={refunding} onClose={() => setRefunding(null)} onDone={() => { setRefunding(null); setRefundKey((n) => n + 1); reload(); }} />}
      {funding && <NewFundingModal surface="corporate" companyId={me.companyId!} onClose={() => setFunding(false)} onDone={() => { setFunding(false); reload(); }} />}
    </>
  );
}

function Allocations() {
  const me = useMe();
  const { data, reload } = useDashboard();
  const [building, setBuilding] = useState(false);
  const { busy, run } = useAction();
  const act = async (path: string, msg: string, body: unknown = {}) => { if (await run(() => c.post(path, body), msg)) reload(); };
  if (!data) return null;
  const approver = me.role === 'co_approver';
  return (
    <>
      <PageHead eyebrow="Step 03 · Allocate" title="Allocate gallons without touching funding">
        <button onClick={() => setBuilding(true)}>New allocation batch</button>
      </PageHead>
      <div className="banner" style={{ marginBottom: 16 }}>
        <span className="grow small">Batches over {gal(data.company.approval_threshold_mgal)} gal need a second person to approve. Records sharing a phone number are held for review. Unallocated: <b>{Object.entries(data.kpis.unallocated_by_grade).map(([g, m]) => `${cap(g)} ${gal(m as number)} gal`).join(' · ') || '0 gal'}</b></span>
      </div>
      <div className="stack">
        {data.batches.map((b: any) => (
          <div className="card" key={b.id}>
            <div className="row between">
              <h2 style={{ margin: 0 }}>Allocation batch #{b.id} · {b.title}</h2>
              <Status s={b.status} />
            </div>
            <div className="table-wrap mt">
              <table>
                <thead><tr><th>Employee</th><th>Dept</th><th>Fuel</th><th className="r">Gal</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {b.lines.map((l: any) => (
                    <tr key={l.id}><td><b>{l.employee_name}</b></td><td>{l.dept}</td><td>{cap(l.grade)}</td><td className="r num"><b>{gal(l.gallons_mgal, 1)}</b></td>
                      <td><Status s={l.status === 'posted' ? 'posted' : l.status} />{l.hold_reason && <span className="small muted"> {l.hold_reason}</span>}</td>
                      <td className="r">{l.status === 'held' && approver && b.status !== 'posted' && b.status !== 'rejected' && (
                        <button className="sm secondary" disabled={busy} onClick={() => act(`/api/batch-lines/${l.id}/release`, 'Record released into batch')}>Verified — release</button>
                      )}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small muted" style={{ marginTop: 8 }}>
              {gal(b.ready_mgal, 1)} gal ready{b.held_count ? ` · ${b.held_count} record(s) held for review` : ''}
              {b.recurring_id ? ' · from recurring schedule' : ''} · prepared by {b.prepared_by_name ?? 'schedule'}{b.approved_by_name ? ` · approved by ${b.approved_by_name}` : ''}
              {b.posted_at ? ` · posted ${when(b.posted_at)}` : ''}
            </p>
            {b.status === 'draft' && (
              <div className="callout mt"><span className="grow">Prepared by {b.prepared_by_name}{b.ready_mgal > data.company.approval_threshold_mgal ? ' · needs a second approver' : ''}</span>
                <button className="sm secondary" style={{ color: '#fff', borderColor: '#fff' }} disabled={busy} onClick={() => act(`/api/batches/${b.id}/reject`, 'Batch discarded')}>Discard</button>
                <button disabled={busy} onClick={() => act(`/api/batches/${b.id}/submit`, b.ready_mgal > data.company.approval_threshold_mgal ? 'Sent for approval' : 'Batch posted')}>
                  {b.ready_mgal > data.company.approval_threshold_mgal ? 'Send for approval' : 'Post allocation'}
                </button></div>
            )}
            {b.status === 'pending_approval' && (
              <div className="callout mt"><span className="grow">Prepared by {b.prepared_by_name} · needs a second approver</span>
                {approver && b.prepared_by !== me.userId ? <>
                  <button className="sm secondary" style={{ color: '#fff', borderColor: '#fff' }} disabled={busy} onClick={() => act(`/api/batches/${b.id}/reject`, 'Batch rejected')}>Reject</button>
                  <button disabled={busy} onClick={() => act(`/api/batches/${b.id}/approve`, 'Approved and posted')}>Approve & post</button>
                </> : <span className="small">Waiting for another approver</span>}</div>
            )}
            {b.status === 'posted' && approver && !b.recurring_id && !data.recurring.some((r: any) => r.source_batch_id === b.id && r.status !== 'cancelled') && (
              <div className="row mt"><button className="sm secondary" disabled={busy} onClick={() => {
                const day = Number(prompt('Repeat on which day of each month (1–28)?', '1'));
                if (day) act(`/api/batches/${b.id}/recurring`, 'Recurring monthly benefit created', { dayOfMonth: day });
              }}>Make recurring monthly</button></div>
            )}
          </div>
        ))}
        {!data.batches.length && <Empty>No allocation batches yet.</Empty>}
      </div>
      <div className="card white mt">
        <div className="row between"><h2 style={{ margin: 0 }}>Recurring benefits</h2>
          {approver && <button className="sm secondary" disabled={busy} onClick={() => act('/api/recurring/run', 'Due schedules processed')}>Run due now</button>}</div>
        <table className="mt"><thead><tr><th>Benefit</th><th>Day</th><th>Last run</th><th>Status</th><th></th></tr></thead><tbody>
          {data.recurring.map((r: any) => (
            <tr key={r.id}><td>{r.title}<div className="small muted">{JSON.parse(r.template_json).length} employees</div></td><td>{r.day_of_month}</td><td>{r.last_period ?? '—'}</td>
              <td><Status s={r.status} />{r.pause_reason && <div className="small muted">{r.pause_reason}</div>}</td>
              <td className="r">{approver && r.status !== 'cancelled' && <div className="row" style={{ justifyContent: 'flex-end' }}>
                {r.status === 'paused' ? <button className="sm" onClick={() => act(`/api/recurring/${r.id}/status`, 'Resumed', { status: 'active' })}>Resume</button>
                  : <button className="sm secondary" onClick={() => act(`/api/recurring/${r.id}/status`, 'Paused', { status: 'paused' })}>Pause</button>}
                <button className="sm ghost" onClick={() => act(`/api/recurring/${r.id}/status`, 'Cancelled', { status: 'cancelled' })}>Cancel</button></div>}</td></tr>
          ))}
        </tbody></table>
        {!data.recurring.length && <Empty>Recurring monthly benefits pause automatically when the funded balance is too low.</Empty>}
      </div>
      {building && <BatchBuilder onClose={() => setBuilding(false)} onDone={() => { setBuilding(false); reload(); }} />}
    </>
  );
}

function BatchBuilder({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const me = useMe();
  const employees = useLoad(() => c.get(`/api/companies/${me.companyId}/employees`), []);
  const [title, setTitle] = useState('Monthly fuel benefit');
  const [rows, setRows] = useState<Record<number, { on: boolean; grade: string; gallons: string }>>({});
  const [bulk, setBulk] = useState('30');
  const { busy, run } = useAction();
  const active = (employees.data ?? []).filter((e: any) => e.status === 'active');
  const row = (id: number) => rows[id] ?? { on: false, grade: 'diesel', gallons: bulk };
  const setRow = (id: number, patch: any) => setRows({ ...rows, [id]: { ...row(id), ...patch } });
  const lines = useMemo(() => active.filter((e: any) => row(e.id).on).map((e: any) => ({ employeeId: e.id, grade: row(e.id).grade, gallons: Number(row(e.id).gallons) })), [rows, active]);
  const total = lines.reduce((s: number, l: any) => s + (l.gallons || 0), 0);
  const submit = async () => {
    if (await run(() => c.post('/api/batches', { companyId: me.companyId, title, lines }), 'Draft batch created')) onDone();
  };
  return (
    <Modal title="New allocation batch" onClose={onClose}>
      <div className="stack">
        <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <div className="row"><label style={{ flex: 1 }}>Default gallons<input type="number" value={bulk} onChange={(e) => setBulk(e.target.value)} /></label>
          <button className="sm secondary" style={{ alignSelf: 'flex-end' }} onClick={() => setRows(Object.fromEntries(active.map((e: any) => [e.id, { ...row(e.id), on: true, gallons: bulk }])))}>Select all</button></div>
        <div style={{ maxHeight: 340, overflow: 'auto' }}>
          <table><tbody>
            {active.map((e: any) => (
              <tr key={e.id}>
                <td><input type="checkbox" style={{ width: 'auto' }} checked={row(e.id).on} onChange={(ev) => setRow(e.id, { on: ev.target.checked })} /></td>
                <td>{e.name}<div className="small muted">{e.dept}{e.duplicate_phone ? ' · shares phone (will be held)' : ''}</div></td>
                <td><select value={row(e.id).grade} onChange={(ev) => setRow(e.id, { grade: ev.target.value })}><option value="diesel">Diesel</option><option value="gasoline">Gasoline</option><option value="premium">Premium</option></select></td>
                <td style={{ width: 90 }}><input type="number" value={row(e.id).gallons} onChange={(ev) => setRow(e.id, { gallons: ev.target.value })} /></td>
              </tr>
            ))}
          </tbody></table>
        </div>
        <p className="small muted">{lines.length} employees · {total.toLocaleString()} gal. Nothing moves until the batch is posted.</p>
        <button disabled={busy || !lines.length || lines.some((l: any) => !(l.gallons > 0))} onClick={submit}>Save draft</button>
      </div>
    </Modal>
  );
}

function Employees() {
  const me = useMe();
  const { data, reload } = useLoad(() => c.get(`/api/companies/${me.companyId}/employees`), []);
  const [adding, setAdding] = useState(false);
  const [recovering, setRecovering] = useState<any>(null);
  const [returning, setReturning] = useState<any>(null);
  const { busy, run } = useAction();
  const approver = me.role === 'co_approver';
  const freeze = async (e: any) => {
    if (await run(() => c.post('/api/freeze', { entity: 'employee', id: e.id, frozen: e.status !== 'frozen', reason: 'Company request' }), e.status === 'frozen' ? 'Wallet reactivated' : 'Wallet frozen')) reload();
  };
  return (
    <>
      <PageHead eyebrow="Roster" title="Employees"><button onClick={() => setAdding(true)}>Add employee</button></PageHead>
      <div className="card white table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Dept</th><th>Phone</th><th className="r">Diesel</th><th className="r">Gasoline</th><th>Wallet</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {data?.map((e: any) => (
              <tr key={e.id}>
                <td><b>{e.name}</b></td><td>{e.dept}</td>
                <td className="mono">{e.phone} {!!e.duplicate_phone && <span className="badge warn">Duplicate</span>}</td>
                <td className="r num">{gal(e.balances.diesel)}</td><td className="r num">{gal(e.balances.gasoline)}</td>
                <td className="small">{e.has_pin ? 'PIN set' : 'No PIN'}{e.pin_locked ? ' · locked' : ''}{e.device_bound ? ' · phone bound' : ''}</td>
                <td><Status s={e.status} /></td>
                <td className="r">{approver && <div className="row" style={{ justifyContent: 'flex-end' }}>
                  <button className="sm secondary" onClick={() => setRecovering(e)}>Recovery</button>
                  <button className="sm ghost" onClick={() => setReturning(e)}>Return gallons</button>
                  <button className={`sm ${e.status === 'frozen' ? 'secondary' : 'ghost'}`} disabled={busy} onClick={() => freeze(e)}>{e.status === 'frozen' ? 'Unfreeze' : 'Freeze'}</button>
                </div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {adding && <AddEmployee onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
      {recovering && <Recovery emp={recovering} onClose={() => setRecovering(null)} onDone={() => { setRecovering(null); reload(); }} />}
      {returning && <ReturnGallons emp={returning} onClose={() => setReturning(null)} onDone={() => { setReturning(null); reload(); }} />}
    </>
  );
}

function AddEmployee({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const me = useMe();
  const [f, setF] = useState({ name: '', dept: '', phone: '', password: '' });
  const { busy, run } = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="Add employee" onClose={onClose}>
      <div className="stack">
        <label>Name<input onChange={set('name')} /></label>
        <label>Department<input onChange={set('dept')} /></label>
        <label>Mobile phone (sign-in)<input inputMode="tel" placeholder="509…" onChange={set('phone')} /></label>
        <label>Temporary password<input type="password" onChange={set('password')} /></label>
        <p className="small muted">The employee signs in on their own phone, sets a PIN and the wallet binds to that device.</p>
        <button disabled={busy} onClick={async () => { if (await run(() => c.post(`/api/companies/${me.companyId}/employees`, f), 'Employee added')) onDone(); }}>Add</button>
      </div>
    </Modal>
  );
}

function Recovery({ emp, onClose, onDone }: { emp: any; onClose: () => void; onDone: () => void }) {
  const [resetPin, setResetPin] = useState(true);
  const [resetDevice, setResetDevice] = useState(false);
  const [tempPassword, setTemp] = useState('');
  const { busy, run } = useAction();
  return (
    <Modal title={`Assisted recovery · ${emp.name}`} onClose={onClose}>
      <div className="stack">
        <p className="small muted">Verify the employee’s identity in person before resetting. All their sessions are signed out.</p>
        <label className="row" style={{ flexDirection: 'row' }}><input type="checkbox" style={{ width: 'auto' }} checked={resetPin} onChange={(e) => setResetPin(e.target.checked)} /> Forgotten or locked PIN — reset PIN</label>
        <label className="row" style={{ flexDirection: 'row' }}><input type="checkbox" style={{ width: 'auto' }} checked={resetDevice} onChange={(e) => setResetDevice(e.target.checked)} /> Lost or new phone — unbind device</label>
        <label>New temporary password (optional)<input type="password" value={tempPassword} onChange={(e) => setTemp(e.target.value)} /></label>
        <button disabled={busy || (!resetPin && !resetDevice && !tempPassword)} onClick={async () => {
          if (await run(() => c.post(`/api/employees/${emp.id}/recover`, { resetPin, resetDevice, tempPassword: tempPassword || undefined }), 'Recovery applied')) onDone();
        }}>Apply recovery</button>
      </div>
    </Modal>
  );
}

function ReturnGallons({ emp, onClose, onDone }: { emp: any; onClose: () => void; onDone: () => void }) {
  const [grade, setGrade] = useState(Object.keys(emp.balances)[0] ?? 'diesel');
  const [gallons, setGallons] = useState('');
  const [note, setNote] = useState('');
  const { busy, run } = useAction();
  return (
    <Modal title={`Return gallons · ${emp.name}`} onClose={onClose}>
      <div className="stack">
        <p className="small muted">Moves unused gallons back to the company pool (e.g. when someone leaves). The distributor approves the adjustment before it posts.</p>
        <label>Grade<select value={grade} onChange={(e) => setGrade(e.target.value)}>{Object.entries(emp.balances).map(([g, m]) => <option key={g} value={g}>{cap(g)} ({gal(m as number, 1)} gal)</option>)}</select></label>
        <label>Gallons<input type="number" value={gallons} onChange={(e) => setGallons(e.target.value)} /></label>
        <label>Reason<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <button disabled={busy || !(Number(gallons) > 0) || note.length < 2} onClick={async () => {
          if (await run(() => c.post(`/api/employees/${emp.id}/return`, { grade, gallons: Number(gallons), note }), 'Sent to distributor for approval')) onDone();
        }}>Request adjustment</button>
      </div>
    </Modal>
  );
}

function Statement() {
  const { data } = useLoad(() => c.get('/api/ledger/journal'), []);
  const navigate = useNavigate();
  return (
    <>
      <PageHead eyebrow="Ledger" title="Account statement"><button className="secondary" onClick={() => navigate('/corporate')}>Back</button></PageHead>
      <div className="card white table-wrap">
        <table>
          <thead><tr><th>When</th><th>Event</th><th>Memo</th><th className="r">Gallons moved</th><th className="r">Money</th></tr></thead>
          <tbody>
            {data?.map((e: any) => {
              const galLines = e.lines.filter((l: any) => l.unit === 'mgal');
              const moneyLines = e.lines.filter((l: any) => l.unit !== 'mgal');
              return (
                <tr key={e.id}><td className="small">{when(e.created_at)}</td><td><b>{cap(e.kind.replace(/_/g, ' '))}</b></td><td className="small">{e.memo}</td>
                  <td className="r num">{gal(galLines.reduce((s: number, l: any) => s + l.debit, 0), 1)}</td>
                  <td className="r num">{moneyLines.length ? money(moneyLines.reduce((s: number, l: any) => s + l.debit, 0), moneyLines[0].unit) : '—'}</td></tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function RequestRefund({ lot, onClose, onDone }: { lot: any; onClose: () => void; onDone: () => void }) {
  const [gallons, setGallons] = useState(String(lot.unallocated_mgal / 1000));
  const [reason, setReason] = useState('');
  const { busy, run } = useAction();
  const value = (Number(gallons) || 0) * lot.price_minor;
  return (
    <Modal title={`Refund from ${lot.code}`} onClose={onClose}>
      <div className="stack">
        <p className="small muted">Only unallocated gallons can be refunded, at the price they were funded at ({money(lot.price_minor, lot.currency)}/gal). The distributor approves, then pays out by bank transfer.</p>
        <label>Gallons (max {gal(lot.unallocated_mgal, 1)})<input type="number" step="0.1" value={gallons} onChange={(e) => setGallons(e.target.value)} /></label>
        <div className="kv"><span>Refund amount</span><b>{money(value, lot.currency)}</b></div>
        <label>Reason<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <button disabled={busy || !(Number(gallons) > 0) || reason.length < 2} onClick={async () => {
          if (await run(() => c.post('/api/refunds', { lotId: lot.id, gallons: Number(gallons), reason }), 'Refund requested')) onDone();
        }}>Request refund</button>
      </div>
    </Modal>
  );
}
