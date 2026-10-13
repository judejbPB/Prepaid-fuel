import { useMemo, useState } from 'react';
import { Route, Routes, useNavigate } from 'react-router-dom';
import { api, cap, date, gal, money, when } from '../api';
import { Authed, Empty, Kpi, Modal, PageHead, Shell, Status, useAction, useLoad, useMe } from '../ui';
import { NewFundingModal } from './Distributor';
import { RefundsTable } from './finance';

const c = api('corporate');

/** "≈ 3,759 gal diesel · 4,385 gal gasoline" — reference only. */
const gallonsRef = (ref: Record<string, number>) =>
  Object.entries(ref ?? {}).map(([g, m]) => `≈ ${gal(m)} gal ${g}`).join(' · ');

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
        <Kpi label="Unallocated" value={money(k.unallocated_minor)} sub={gallonsRef(k.unallocated_gallons_ref) || 'Fund your account to start'} />
        <Kpi label="Batch ready" value={money(k.batch_ready_minor)} sub="Drafts and batches awaiting approval" />
        <Kpi label="Recurring" value={k.recurring ? 'Monthly' : 'Off'} sub={k.recurring ? `${k.recurring.status === 'paused' ? 'Paused — ' + (k.recurring.pause_reason ?? '') : `Day ${k.recurring.day_of_month} each month`}` : 'Make a posted batch recurring'} />
        <Kpi label="In employee wallets" value={money(k.allocated_minor)} sub={`${money(k.redeemed_minor)} spent · ${gal(k.redeemed_mgal, 1)} gal to date`} />
      </div>
      <div className="grid g2 mt">
        <div className="card white">
          <h2>Funding</h2>
          <table><thead><tr><th>Reference</th><th className="r">Amount</th><th>Status</th></tr></thead><tbody>
            {data.funding.map((f: any) => (
              <tr key={f.id}><td className="mono">{f.reference}</td><td className="r num">{money(f.amount_minor, f.currency)}</td><td><Status s={f.status} /></td></tr>
            ))}
          </tbody></table>
          {!data.funding.length && <Empty>No funding yet.</Empty>}
        </div>
        <div className="card white">
          <h2>Funded lots</h2>
          <table><thead><tr><th>Lot</th><th className="r">Cleared</th><th className="r">Unallocated</th><th>Expires</th><th></th></tr></thead><tbody>
            {data.lots.map((l: any) => (
              <tr key={l.id}><td className="mono">{l.code}</td><td className="r num">{money(l.amount_minor, l.currency)}</td>
                <td className="r num">{money(l.unallocated_minor, l.currency)}</td><td>{date(l.expires_on)} {l.status !== 'active' && <Status s={l.status} />}</td>
                <td className="r">{me.role === 'co_approver' && l.status === 'active' && l.unallocated_minor > 0 && <button className="sm ghost" onClick={() => setRefunding(l)}>Refund</button>}</td></tr>
            ))}
          </tbody></table>
          {!data.lots.length && <Empty>Lots appear once your deposit is verified and activated.</Empty>}
          <p className="small muted" style={{ marginTop: 8 }}>Contract prices, applied at the pump: {data.contracts.map((p: any) => `${cap(p.grade)} ${money(p.price_minor, p.currency)}/gal`).join(' · ')}</p>
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
      <PageHead eyebrow="Step 03 · Allocate" title="Allocate fuel money without touching funding">
        <button onClick={() => setBuilding(true)}>New allocation batch</button>
      </PageHead>
      <div className="banner" style={{ marginBottom: 16 }}>
        <span className="grow small">Batches over {money(data.company.approval_threshold_minor)} need a second person to approve. Records sharing a phone number are held for review. Unallocated: <b>{money(data.kpis.spendable_unallocated_minor)}</b></span>
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
                <thead><tr><th>Employee</th><th>Dept</th><th className="r">Amount</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {b.lines.map((l: any) => (
                    <tr key={l.id}><td><b>{l.employee_name}</b></td><td>{l.dept}</td><td className="r num"><b>{money(l.amount_minor)}</b></td>
                      <td><Status s={l.status === 'posted' ? 'posted' : l.status} />{l.hold_reason && <span className="small muted"> {l.hold_reason}</span>}</td>
                      <td className="r">{l.status === 'held' && approver && b.status !== 'posted' && b.status !== 'rejected' && (
                        <button className="sm secondary" disabled={busy} onClick={() => act(`/api/batch-lines/${l.id}/release`, 'Record released into batch')}>Verified — release</button>
                      )}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small muted" style={{ marginTop: 8 }}>
              {money(b.ready_minor)} ready{b.held_count ? ` · ${b.held_count} record(s) held for review` : ''}
              {b.recurring_id ? ' · from recurring schedule' : ''} · prepared by {b.prepared_by_name ?? 'schedule'}{b.approved_by_name ? ` · approved by ${b.approved_by_name}` : ''}
              {b.posted_at ? ` · posted ${when(b.posted_at)}` : ''}
            </p>
            {b.status === 'draft' && (
              <div className="callout mt"><span className="grow">Prepared by {b.prepared_by_name}{b.ready_minor > data.company.approval_threshold_minor ? ' · needs a second approver' : ''}</span>
                <button className="sm secondary" style={{ color: '#fff', borderColor: '#fff' }} disabled={busy} onClick={() => act(`/api/batches/${b.id}/reject`, 'Batch discarded')}>Discard</button>
                <button disabled={busy} onClick={() => act(`/api/batches/${b.id}/submit`, b.ready_minor > data.company.approval_threshold_minor ? 'Sent for approval' : 'Batch posted')}>
                  {b.ready_minor > data.company.approval_threshold_minor ? 'Send for approval' : 'Post allocation'}
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
  const [rows, setRows] = useState<Record<number, { on: boolean; amount: string }>>({});
  const [bulk, setBulk] = useState('5000');
  const { busy, run } = useAction();
  const active = (employees.data ?? []).filter((e: any) => e.status === 'active');
  const row = (id: number) => rows[id] ?? { on: false, amount: bulk };
  const setRow = (id: number, patch: any) => setRows({ ...rows, [id]: { ...row(id), ...patch } });
  const lines = useMemo(() => active.filter((e: any) => row(e.id).on).map((e: any) => ({ employeeId: e.id, amount: Number(row(e.id).amount) })), [rows, active]);
  const total = lines.reduce((s: number, l: any) => s + (l.amount || 0), 0);
  const submit = async () => {
    if (await run(() => c.post('/api/batches', { companyId: me.companyId, title, lines }), 'Draft batch created')) onDone();
  };
  return (
    <Modal title="New allocation batch" onClose={onClose}>
      <div className="stack">
        <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <div className="row"><label style={{ flex: 1 }}>Default amount (HTG)<input type="number" value={bulk} onChange={(e) => setBulk(e.target.value)} /></label>
          <button className="sm secondary" style={{ alignSelf: 'flex-end' }} onClick={() => setRows(Object.fromEntries(active.map((e: any) => [e.id, { on: true, amount: bulk }])))}>Select all</button></div>
        <div style={{ maxHeight: 340, overflow: 'auto' }}>
          <table><tbody>
            {active.map((e: any) => (
              <tr key={e.id}>
                <td><input type="checkbox" style={{ width: 'auto' }} checked={row(e.id).on} onChange={(ev) => setRow(e.id, { on: ev.target.checked })} /></td>
                <td>{e.name}<div className="small muted">{e.dept}{e.duplicate_phone ? ' · shares phone (will be held)' : ''}</div></td>
                <td style={{ width: 130 }}><input type="number" step="0.01" value={row(e.id).amount} onChange={(ev) => setRow(e.id, { amount: ev.target.value })} /></td>
              </tr>
            ))}
          </tbody></table>
        </div>
        <p className="small muted">{lines.length} employees · {money(Math.round(total * 100))}. Employees can spend it on diesel or gasoline. Nothing moves until the batch is posted.</p>
        <button disabled={busy || !lines.length || lines.some((l: any) => !(l.amount > 0))} onClick={submit}>Save draft</button>
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
          <thead><tr><th>Name</th><th>Dept</th><th>Phone</th><th className="r">Available</th><th>Wallet</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {data?.map((e: any) => (
              <tr key={e.id}>
                <td><b>{e.name}</b></td><td>{e.dept}</td>
                <td className="mono">{e.phone} {!!e.duplicate_phone && <span className="badge warn">Duplicate</span>}</td>
                <td className="r num">{money(e.available_minor)}{e.reserved_minor > 0 && <div className="small muted">{money(e.reserved_minor)} reserved</div>}</td>
                <td className="small">{e.has_pin ? 'Phone secured' : 'Not set up'}{e.pin_locked ? ' · locked' : ''}{e.device_bound ? ' · phone bound' : ''}</td>
                <td><Status s={e.status} /></td>
                <td className="r">{approver && <div className="row" style={{ justifyContent: 'flex-end' }}>
                  <button className="sm secondary" onClick={() => setRecovering(e)}>Recovery</button>
                  <button className="sm ghost" onClick={() => setReturning(e)}>Return balance</button>
                  <button className={`sm ${e.status === 'frozen' ? 'secondary' : 'ghost'}`} disabled={busy} onClick={() => freeze(e)}>{e.status === 'frozen' ? 'Unfreeze' : 'Freeze'}</button>
                </div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {adding && <AddEmployee onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
      {recovering && <Recovery emp={recovering} onClose={() => setRecovering(null)} onDone={() => { setRecovering(null); reload(); }} />}
      {returning && <ReturnBalance emp={returning} onClose={() => setReturning(null)} onDone={() => { setReturning(null); reload(); }} />}
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

function ReturnBalance({ emp, onClose, onDone }: { emp: any; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState(String(emp.available_minor / 100));
  const [note, setNote] = useState('');
  const { busy, run } = useAction();
  return (
    <Modal title={`Return balance · ${emp.name}`} onClose={onClose}>
      <div className="stack">
        <p className="small muted">Moves unused money back to the company pool (e.g. when someone leaves). The distributor approves the adjustment before it posts.</p>
        <label>Amount (HTG, max {money(emp.available_minor)})<input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label>Reason<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <button disabled={busy || !(Number(amount) > 0) || note.length < 2} onClick={async () => {
          if (await run(() => c.post(`/api/employees/${emp.id}/return`, { amount: Number(amount), note }), 'Sent to distributor for approval')) onDone();
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
          <thead><tr><th>When</th><th>Event</th><th>Memo</th><th className="r">Amount</th></tr></thead>
          <tbody>
            {data?.map((e: any) => (
              <tr key={e.id}><td className="small">{when(e.created_at)}</td><td><b>{cap(e.kind.replace(/_/g, ' '))}</b></td><td className="small">{e.memo}</td>
                <td className="r num">{money(e.lines.reduce((s: number, l: any) => s + l.debit, 0), e.lines[0]?.unit)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function RequestRefund({ lot, onClose, onDone }: { lot: any; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState(String(lot.unallocated_minor / 100));
  const [reason, setReason] = useState('');
  const { busy, run } = useAction();
  return (
    <Modal title={`Refund from ${lot.code}`} onClose={onClose}>
      <div className="stack">
        <p className="small muted">Only money not yet allocated to employees can be refunded. The distributor approves, then pays out by bank transfer.</p>
        <label>Amount (HTG, max {money(lot.unallocated_minor, lot.currency)})<input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label>Reason<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <button disabled={busy || !(Number(amount) > 0) || reason.length < 2} onClick={async () => {
          if (await run(() => c.post('/api/refunds', { lotId: lot.id, amount: Number(amount), reason }), 'Refund requested')) onDone();
        }}>Request refund</button>
      </div>
    </Modal>
  );
}
