import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { api, cap, gal, session, when } from '../api';
import { Authed, Empty, Kpi, PageHead, Shell, Status, useAction, useLoad, useLogout, useMe } from '../ui';
import { ExceptionsPanel } from './shared';

const s = api('station');
const GRADES = ['diesel', 'gasoline', 'premium'];

export default function Station() {
  const [terminal, setTerminal] = useState(session.terminalInfo());
  const [managerMode, setManagerMode] = useState(false);
  if (!terminal && !managerMode) return <Activate onActivated={setTerminal} onManager={() => setManagerMode(true)} />;
  const extra = terminal
    ? <div className="badge info">This device: {terminal.station_name} · {terminal.label}</div>
    : <div className="badge warn">Manager sign-in (no terminal on this device)</div>;
  return (
    <Authed surface="station" loginExtra={extra}>
      <StationHome />
    </Authed>
  );
}

function Activate({ onActivated, onManager }: { onActivated: (t: any) => void; onManager: () => void }) {
  const [code, setCode] = useState('');
  const { busy, run } = useAction();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const out = await run(() => s.post('/api/terminals/activate', { code }), 'Terminal activated');
    if (out) { session.setTerminal(out.terminalKey, out.terminal); onActivated(out.terminal); }
  };
  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="eyebrow">BOUSOL · Station app</div>
        <h1>Activate this terminal</h1>
        <p className="small muted">Each station runs one approved Android phone or tablet. Enter the one-time activation code from the distributor.</p>
        <label>Activation code<input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="STATION2" autoCapitalize="characters" /></label>
        <button disabled={busy || code.length < 4}>Activate</button>
        <button type="button" className="secondary" onClick={onManager}>I’m a station manager</button>
        <a href="/" className="small muted">← All apps</a>
      </form>
    </div>
  );
}

function StationHome() {
  const me = useMe();
  return me.role === 'st_attendant' ? <Terminal /> : <Manager />;
}

// ------------------------------------------------------------------ attendant terminal

function Terminal() {
  const me = useMe();
  const logout = useLogout('station');
  const { data, reload } = useLoad(() => s.get('/api/station/state'), [], 5000);
  const [active, setActive] = useState<any>(null);
  const [closing, setClosing] = useState(false);
  const { busy, run } = useAction();
  const info = session.terminalInfo();
  const shift = data?.shift;

  // Poll the in-flight request so the screen advances when the employee approves on their phone.
  useEffect(() => {
    if (!active || !['pending', 'approved'].includes(active.status)) return;
    const t = setInterval(async () => {
      try { setActive(await s.get(`/api/redemptions/${active.id}`)); } catch { /* keep last state */ }
    }, 2000);
    return () => clearInterval(t);
  }, [active?.id, active?.status]);

  // Resume an in-flight request after a reload so the attendant never loses track of it.
  useEffect(() => {
    const inflight = data?.redemptions.find((r: any) => r.status === 'pending' || r.status === 'approved');
    if (!active && inflight) s.get(`/api/redemptions/${inflight.id}`).then(setActive).catch(() => {});
  }, [data]);

  const openShift = async () => { if (await run(() => s.post('/api/shifts/open'), 'Shift opened')) reload(); };

  return (
    <div className="terminal-bg">
      <div className="terminal">
        <div className="row between">
          <h2 style={{ margin: 0 }}>{info?.station_name ?? me.station?.name} · Terminal {info?.label}</h2>
          <div className="row">
            {shift ? <span className="badge ok">Shift open · {me.name}</span> : <button className="sm" disabled={busy} onClick={openShift}>Open shift</button>}
            {shift && !active && <button className="sm secondary" onClick={() => setClosing(true)}>Close shift</button>}
            <button className="sm ghost" onClick={logout}>Sign out</button>
          </div>
        </div>
        {!shift && !closing && <div className="banner mt">Open your named shift to start taking redemption requests.</div>}
        {shift && !closing && <RequestFlow active={active} setActive={(r) => { setActive(r); reload(); }} />}
        {closing && <CloseShift onBack={() => setClosing(false)} onClosed={() => { reload(); }} />}
        {shift && !closing && (
          <div className="card white mt">
            <h3>This shift</h3>
            <table className="mt"><tbody>
              {data?.redemptions.map((r: any) => (
                <tr key={r.id}><td className="small">{when(r.created_at)}</td><td>Pump {r.pump}</td><td>{cap(r.grade)}</td>
                  <td className="r num">{gal(r.dispensed_mgal ?? r.requested_mgal, 1)} gal</td><td>{r.employee_name ?? '—'}</td><td className="r"><Status s={r.status} /></td></tr>
              ))}
            </tbody></table>
            {!data?.redemptions.length && <Empty>No requests yet this shift.</Empty>}
          </div>
        )}
      </div>
    </div>
  );
}

function RequestFlow({ active, setActive }: { active: any; setActive: (r: any) => void }) {
  const [grade, setGrade] = useState('diesel');
  const [pump, setPump] = useState('1');
  const [qty, setQty] = useState('');
  const [dispensed, setDispensed] = useState('');
  const [qr, setQr] = useState('');
  const { busy, run } = useAction();

  useEffect(() => {
    if (active?.qr) QRCode.toDataURL(active.qr, { margin: 1, width: 240 }).then(setQr);
  }, [active?.qr]);
  useEffect(() => {
    if (active?.status === 'approved') setDispensed(String(active.requested_mgal / 1000));
  }, [active?.status]);

  const create = async () => {
    const r = await run(() => s.post('/api/redemptions', { grade, pump: Number(pump), gallons: Number(qty) }));
    if (r) setActive(r);
  };
  const cancel = async () => { const r = await run(() => s.post(`/api/redemptions/${active.id}/cancel`), 'Request cancelled'); if (r) setActive(null); };
  const complete = async () => {
    const r = await run(() => s.post(`/api/redemptions/${active.id}/complete`, { gallons: Number(dispensed) }), 'Fuel confirmed');
    if (r) setActive(r);
  };

  const step = !active ? 1 : active.status === 'pending' ? 2 : active.status === 'approved' ? 3 : 4;
  return (
    <>
      <div className="grid mt" style={{ gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)' }}>
        <div className="card">
          {step === 1 && <>
            <h3>New redemption request</h3>
            <div className="small muted mt">Fuel</div>
            <div className="seg" style={{ marginTop: 6 }}>
              {GRADES.map((g) => <button key={g} className={`${grade === g ? 'on' : ''} ${g === 'premium' ? 'dashed' : ''}`} onClick={() => setGrade(g)}>{cap(g)}</button>)}
            </div>
            <div className="grid g2 mt">
              <label>Pump<input type="number" min="1" value={pump} onChange={(e) => setPump(e.target.value)} /></label>
              <label>Quantity (gal)<input type="number" step="0.1" min="0" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="12.0" style={{ fontSize: 22, fontWeight: 700 }} /></label>
            </div>
            <button className="block mt" disabled={busy || !(Number(qty) > 0) || !(Number(pump) > 0)} onClick={create}>Create request</button>
          </>}
          {step === 2 && <>
            <h3>Waiting for employee approval</h3>
            <div className="kv mt"><span>Fuel</span><b>{cap(active.grade)}</b></div>
            <div className="kv"><span>Pump</span><b>{active.pump}</b></div>
            <div className="kv"><span>Quantity</span><b style={{ fontSize: 22 }}>{gal(active.requested_mgal, 1)} gal</b></div>
            <p className="small muted mt">Ask the employee to scan the QR with their BOUSOL app and confirm with their PIN. Do not dispense yet. Request expires {when(active.expires_at)}.</p>
            <button className="secondary mt" disabled={busy} onClick={cancel}>Cancel request</button>
          </>}
          {step === 3 && <>
            <h3>Approved — dispense now</h3>
            <div className="banner ok mt"><span className="grow">{active.employee_name} · {active.company_name} approved <b>{gal(active.requested_mgal, 1)} gal {active.grade}</b> at pump {active.pump}.</span></div>
            <label className="mt">Gallons actually dispensed<input type="number" step="0.001" value={dispensed} onChange={(e) => setDispensed(e.target.value)} style={{ fontSize: 22, fontWeight: 700 }} /></label>
            <p className="small muted">If the pump stopped early, enter the meter reading. Any remainder goes back to the employee.</p>
            <div className="row mt">
              <button disabled={busy || !(Number(dispensed) > 0)} onClick={complete}>Confirm dispensed</button>
              <button className="secondary" disabled={busy} onClick={cancel}>Nothing dispensed — cancel</button>
            </div>
          </>}
          {step === 4 && <>
            <h3>{active.status === 'completed' ? 'Redeemed' : cap(active.status)}</h3>
            {active.status === 'completed'
              ? <p className="mt"><b style={{ fontSize: 22 }}>{gal(active.dispensed_mgal, 1)} gal {active.grade}</b> · pump {active.pump} · {active.employee_name}</p>
              : <p className="mt muted">The request was {active.status}. Create a new one.</p>}
            <button className="mt" onClick={() => { setActive(null); setQty(''); }}>New request</button>
          </>}
        </div>
        <div className="qr-box">
          {step === 2 && qr ? <>
            <img src={qr} alt="Redemption QR code" width={240} height={240} />
            <div className="code">{active.code}</div>
            <div className="muted">Waiting for employee approval</div>
          </> : <div className="muted small" style={{ padding: 40 }}>{step === 1 ? 'The QR appears here after you create a request.' : step === 3 ? 'QR used. Single use only.' : '✓'}</div>}
        </div>
      </div>
      <div className="progress">
        {['1 Request', '2 Approval', '3 Dispense', '4 Confirm'].map((label, i) => (
          <div key={label} className={i + 1 < step || (step === 4 && active?.status === 'completed') ? 'done' : i + 1 === step ? 'now' : ''}>{label}</div>
        ))}
      </div>
    </>
  );
}

function CloseShift({ onBack, onClosed }: { onBack: () => void; onClosed: () => void }) {
  const [pump, setPump] = useState<Record<string, string>>({});
  const [pos, setPos] = useState<Record<string, string>>({});
  const [result, setResult] = useState<any>(null);
  const { busy, run } = useAction();
  const toNum = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).filter(([, v]) => v !== '').map(([k, v]) => [k, Number(v)]));
  const submit = async () => {
    const out = await run(() => s.post('/api/shifts/close', { pumpTotals: toNum(pump), posTotals: toNum(pos) }));
    if (out) { setResult(out); onClosed(); }
  };
  if (result) {
    const sum = (j: string) => Object.values(JSON.parse(j) as Record<string, number>).reduce((a, b) => a + b, 0);
    return (
      <div className="card white mt">
        <div className="row between"><h2 style={{ margin: 0 }}>Shift close</h2><Status s={result.status} /></div>
        <div className="grid g3 mt">
          <Kpi label="Digital redemptions" value={`${gal(sum(result.digital_json), 1)} gal`} />
          <Kpi label="Pump totals" value={`${gal(sum(result.pump_json), 1)} gal`} />
          <Kpi label="Variance" value={`${gal(result.variance_mgal, 1)} gal`} bad={result.status === 'held'} />
        </div>
        <p className="small muted mt">{result.status === 'held' ? 'Next: manager explanation, then distributor decision.' : 'Shift reconciled. You can sign out.'}</p>
      </div>
    );
  }
  return (
    <div className="card white mt">
      <div className="row between"><h2 style={{ margin: 0 }}>Close shift</h2><button className="ghost" onClick={onBack}>Back</button></div>
      <p className="small muted">Enter the program totals from the pump meters and the POS for this shift. They are compared to digital redemptions.</p>
      <table className="mt"><thead><tr><th>Grade</th><th>Pump totals (gal)</th><th>POS program sales (gal)</th></tr></thead><tbody>
        {GRADES.map((g) => (
          <tr key={g}><td>{cap(g)}</td>
            <td><input type="number" step="0.1" value={pump[g] ?? ''} onChange={(e) => setPump({ ...pump, [g]: e.target.value })} /></td>
            <td><input type="number" step="0.1" value={pos[g] ?? ''} onChange={(e) => setPos({ ...pos, [g]: e.target.value })} /></td></tr>
        ))}
      </tbody></table>
      <button className="mt" disabled={busy} onClick={submit}>Close shift</button>
    </div>
  );
}

// ------------------------------------------------------------------ manager

function Manager() {
  const me = useMe();
  const { data } = useLoad(() => s.get(`/api/stations/${me.stationId}/overview`), [], 15000);
  const shifts = useLoad(() => s.get('/api/shifts'), [], 15000);
  return (
    <Shell surface="station" nav={[['/station', 'Station overview']]}>
      <PageHead eyebrow={`Station manager · ${me.station?.name}`} title="Fuel counts only after the employee confirms" />
      <div className="grid g2">
        <div className="card white">
          <h2>Terminal</h2>
          {data?.terminal ? <p>{data.terminal.label} <Status s={data.terminal.status} /> {data.terminal.activated ? <span className="small muted">· device activated</span> : <span className="small muted">· awaiting activation</span>}</p> : <Empty>No terminal registered.</Empty>}
          <h2 className="mt">Recent shifts</h2>
          <table><tbody>
            {shifts.data?.slice(0, 8).map((sh: any) => (
              <tr key={sh.id}><td>#{sh.id}</td><td>{sh.attendant_name}</td><td className="small">{when(sh.opened_at)}</td>
                <td className="r num">{sh.variance_mgal != null ? `${gal(sh.variance_mgal, 1)} gal var.` : ''}</td><td className="r"><Status s={sh.status} /></td></tr>
            ))}
          </tbody></table>
        </div>
        <ExceptionsPanel surface="station" />
      </div>
      <div className="card white mt table-wrap">
        <h2>Recent redemptions</h2>
        <table>
          <thead><tr><th>When</th><th>Pump</th><th>Fuel</th><th className="r">Gallons</th><th>Employee</th><th>Company</th><th>Status</th></tr></thead>
          <tbody>
            {data?.redemptions.map((r: any) => (
              <tr key={r.id}><td className="small">{when(r.created_at)}</td><td>{r.pump}</td><td>{cap(r.grade)}</td>
                <td className="r num">{gal(r.dispensed_mgal ?? r.requested_mgal, 1)}</td><td>{r.employee_name ?? '—'}</td><td>{r.company_name ?? '—'}</td><td><Status s={r.status} /></td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
