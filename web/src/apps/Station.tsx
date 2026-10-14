import QRCode from 'qrcode';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, cap, gal, money, session, when } from '../api';
import { RESPONSE_PREFIX } from '../offline';
import { QrScanner } from '../scanner';
import {
  authorizeLocal, cancelLocal, completeLocal, createLocalRequest, isLocal, offlineStore, packUsable,
  refreshLocalRequest, syncAndRefresh, type OfflinePack,
} from '../station-offline';
import { Authed, Empty, Kpi, PageHead, Shell, Status, useAction, useLoad, useLogout, useMe } from '../ui';
import { ExceptionsPanel } from './shared';

const s = api('station');
const GRADES = ['diesel', 'gasoline'];

export default function Station() {
  const [terminal, setTerminal] = useState(session.terminalInfo());
  const [managerMode, setManagerMode] = useState(false);
  if (!terminal && !managerMode) return <Activate onActivated={setTerminal} onManager={() => setManagerMode(true)} />;
  const extra = terminal
    ? <div className="badge info">This device: {terminal.station_name} · {terminal.label}</div>
    : <div className="badge warn">Manager sign-in (no terminal on this device)</div>;
  return (
    <Authed surface="station" loginExtra={extra} offlineOk>
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

/** Connectivity as the terminal experiences it: a cheap health check, not just navigator.onLine. */
function useOnline() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    let stop = false;
    const check = async () => {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 4000);
        const res = await fetch('/api/health', { cache: 'no-store', signal: ctl.signal });
        clearTimeout(t);
        if (!stop) setOnline(res.ok);
      } catch { if (!stop) setOnline(false); }
    };
    check();
    const t = setInterval(check, 8000);
    window.addEventListener('online', check);
    window.addEventListener('offline', () => setOnline(false));
    return () => { stop = true; clearInterval(t); window.removeEventListener('online', check); };
  }, []);
  return online;
}

const STATE_CACHE = 'bousol.station.lastState';

function Terminal() {
  const me = useMe();
  const logout = useLogout('station');
  const online = useOnline();
  const [data, setData] = useState<any>(() => { try { return JSON.parse(localStorage.getItem(STATE_CACHE) ?? 'null'); } catch { return null; } });
  const [active, setActive] = useState<any>(() => offlineStore.activeRequest());
  const [closing, setClosing] = useState(false);
  const [pack, setPack] = useState<OfflinePack | null>(() => offlineStore.pack());
  const [queued, setQueued] = useState(() => offlineStore.queue().length);
  const { busy, run } = useAction();
  const info = session.terminalInfo();
  const shift = data?.shift;

  const reload = useCallback(async () => {
    setQueued(offlineStore.queue().length);
    try {
      const fresh = await s.get('/api/station/state');
      setData(fresh);
      try { localStorage.setItem(STATE_CACHE, JSON.stringify(fresh)); } catch { /* ignore */ }
    } catch { /* offline: keep the last known shift */ }
  }, []);
  useEffect(() => { reload(); const t = setInterval(reload, 5000); return () => clearInterval(t); }, [reload]);

  // Online: push queued offline sales and keep the offline pack fresh (every minute).
  const [syncNote, setSyncNote] = useState<string | null>(null);
  useEffect(() => {
    if (!online) return;
    let stop = false;
    const sync = async () => {
      try {
        const out = await syncAndRefresh((p, b) => s.post(p, b), (p) => s.get(p));
        if (stop) return;
        setPack(offlineStore.pack());
        setQueued(out.remaining);
        if (out.posted || out.rejected) {
          setSyncNote(`Synced ${out.posted} offline sale(s)${out.rejected ? `, ${out.rejected} rejected and sent to the distributor` : ''}${out.shortfallMinor ? `, ${money(out.shortfallMinor)} not covered` : ''}.`);
          reload();
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) setPack(null); // terminal frozen: no offline pack
      }
    };
    sync();
    const t = setInterval(sync, 60_000);
    return () => { stop = true; clearInterval(t); };
  }, [online, reload]);

  // While the QR is on screen, keep its challenge fresh so a photo of the terminal stops working.
  useEffect(() => {
    if (!active || active.status !== 'pending') return;
    const t = setInterval(async () => {
      if (isLocal(active)) { if (pack) setActive(refreshLocalRequest(pack, active)); return; }
      try { setActive(await s.post(`/api/redemptions/${active.id}/challenge`)); } catch { /* keep last state */ }
    }, isLocal(active) ? 1000 : 3000);
    return () => clearInterval(t);
  }, [active, pack]);

  // Resume an in-flight online request after a reload so the attendant never loses track of it.
  useEffect(() => {
    const inflight = data?.redemptions?.find((r: any) => r.status === 'pending' || r.status === 'approved');
    if (online && !active && inflight) s.get(`/api/redemptions/${inflight.id}`).then(setActive).catch(() => {});
  }, [data, online]);

  const openShift = async () => { if (await run(() => s.post('/api/shifts/open'), 'Shift opened')) reload(); };
  const mode: 'online' | 'offline' = online ? 'online' : 'offline';
  const offlineReady = packUsable(pack);
  const pendingSales = offlineStore.queue().filter((q) => q.shiftId === shift?.id);

  return (
    <div className="terminal-bg">
      <div className="terminal">
        <div className="row between">
          <h2 style={{ margin: 0 }}>{info?.station_name ?? me.station?.name} · Terminal {info?.label}</h2>
          <div className="row">
            <span className={`badge ${online ? 'ok' : 'warn'}`} data-testid="connection">{online ? 'Online' : 'Offline mode'}</span>
            {shift ? <span className="badge ok">Shift open · {me.name}</span> : <button className="sm" disabled={busy || !online} onClick={openShift}>Open shift</button>}
            {shift && !active && <button className="sm secondary" disabled={!online || queued > 0} title={!online || queued ? 'Sync offline sales first' : ''} onClick={() => setClosing(true)}>Close shift</button>}
            <button className="sm ghost" onClick={logout}>Sign out</button>
          </div>
        </div>
        {!online && (offlineReady
          ? <div className="banner mt"><span className="grow small"><b>No connection: offline mode.</b> Approvals are checked on this terminal and synced when the connection returns.
              {' '}{queued} sale(s) waiting · limits {money(pack!.limits.per_employee_minor)} per employee, {money(pack!.limits.terminal_minor)} per terminal · offline data from {when(pack!.generated_at)}</span></div>
          : <div className="banner bad mt"><span className="grow small"><b>No connection.</b> This terminal has no valid offline data, so it can’t approve fuelings. Reconnect once to download it.</span></div>)}
        {online && queued > 0 && <div className="banner mt"><span className="grow small">Syncing {queued} offline sale(s)…</span></div>}
        {syncNote && <div className="banner ok mt"><span className="grow small">{syncNote}</span><button className="ghost sm" onClick={() => setSyncNote(null)}>✕</button></div>}
        {!shift && !closing && <div className="banner mt">Open your named shift to start taking redemption requests{online ? '' : ' (needs a connection)'}.</div>}
        {shift && !closing && (online || offlineReady || active) && (
          <RequestFlow active={active} mode={mode} pack={pack} shiftId={shift.id} setActive={(r) => { setActive(r); reload(); }} />
        )}
        {closing && <CloseShift onBack={() => setClosing(false)} onClosed={() => { reload(); }} />}
        {shift && !closing && (
          <div className="card white mt">
            <h3>This shift</h3>
            <table className="mt"><tbody>
              {pendingSales.map((q) => (
                <tr key={q.clientId}><td className="small">{when(q.completedAt)}</td><td>Pump {q.pump}</td><td>{cap(q.grade)}</td>
                  <td className="r num">{money(q.chargedMinor, q.currency)}</td><td className="r num small muted">{gal(q.dispensedMgal, 2)} gal</td>
                  <td>—</td><td className="r"><span className="badge warn">Offline · not synced</span></td></tr>
              ))}
              {data?.redemptions?.map((r: any) => (
                <tr key={r.id}><td className="small">{when(r.created_at)}</td><td>Pump {r.pump}</td><td>{cap(r.grade)}</td>
                  <td className="r num">{r.charged_minor != null ? money(r.charged_minor) : r.requested_minor != null ? money(r.requested_minor) : `${gal(r.requested_mgal, 1)} gal`}</td>
                  <td className="r num small muted">{r.dispensed_mgal != null ? `${gal(r.dispensed_mgal, 2)} gal` : ''}</td><td>{r.employee_name ?? '—'}</td>
                  <td className="r">{r.offline ? <span className="badge info" style={{ marginRight: 6 }}>Offline</span> : null}<Status s={r.status} /></td></tr>
              ))}
            </tbody></table>
            {!data?.redemptions?.length && !pendingSales.length && <Empty>No requests yet this shift.</Empty>}
          </div>
        )}
      </div>
    </div>
  );
}

function RequestFlow({ active, setActive, mode: connection, pack, shiftId }: { active: any; setActive: (r: any) => void; mode: 'online' | 'offline'; pack: OfflinePack | null; shiftId: number }) {
  const [grade, setGrade] = useState('diesel');
  const [pump, setPump] = useState('1');
  const [qtyMode, setQtyMode] = useState<'amount' | 'gallons'>('amount');
  const [qty, setQty] = useState('');
  const [dispMode, setDispMode] = useState<'amount' | 'gallons'>('amount');
  const [dispensed, setDispensed] = useState('');
  const [qr, setQr] = useState('');
  const { busy, run } = useAction();

  useEffect(() => {
    if (active?.challenge) QRCode.toDataURL(active.challenge, { margin: 1, width: 260, errorCorrectionLevel: 'L' }).then(setQr);
  }, [active?.challenge]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(t); }, []);
  const nonceAt = active?.nonce_at ? Date.parse(active.nonce_at.includes('T') ? active.nonce_at : active.nonce_at.replace(' ', 'T') + 'Z') : 0;
  const rotateLeft = nonceAt ? Math.max(0, 30 - (now - nonceAt) / 1000) : 0;
  const local = isLocal(active);

  // Offline requests are handled entirely on this terminal; online ones by the server.
  const authorize = async (token: string) => {
    const r = await run(() => (local ? authorizeLocal(pack!, active, token) : s.post(`/api/redemptions/${active.id}/authorize`, { token })), 'Approved by employee');
    if (r) setActive(r);
  };
  useEffect(() => {
    if (active?.status !== 'approved') return;
    // Pre-fill with what was approved, in the unit the attendant asked in.
    const byGallons = active.requested_mgal != null;
    setDispMode(byGallons ? 'gallons' : 'amount');
    setDispensed(byGallons ? String(active.approved_mgal / 1000) : String(active.approved_minor / 100));
  }, [active?.status]);

  const create = async () => {
    const input = { grade, pump: Number(pump), [qtyMode]: Number(qty) };
    const r = await run(async () => (connection === 'offline' ? createLocalRequest(pack!, shiftId, input) : s.post('/api/redemptions', input)));
    if (r) setActive(r);
  };
  const cancel = async () => {
    const r = await run(async () => (local ? cancelLocal(active) : s.post(`/api/redemptions/${active.id}/cancel`)), 'Request cancelled');
    if (r) setActive(null);
  };
  const complete = async () => {
    const q = { [dispMode]: Number(dispensed) };
    const r = await run(async () => (local ? completeLocal(active, q) : s.post(`/api/redemptions/${active.id}/complete`, q)), local ? 'Sale saved; it syncs when the connection returns' : 'Sale confirmed');
    if (r) setActive(r);
  };
  const requested = (r: any) => (r.requested_minor != null ? money(r.requested_minor) : `${gal(r.requested_mgal, 1)} gal`);

  const step = !active ? 1 : active.status === 'pending' ? 2 : active.status === 'approved' ? 3 : 4;
  return (
    <>
      <div className="grid mt" style={{ gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)' }}>
        <div className="card">
          {step === 1 && <>
            <h3>New redemption request</h3>
            <div className="small muted mt">Fuel</div>
            <div className="seg" style={{ marginTop: 6 }}>
              {GRADES.map((g) => <button key={g} className={grade === g ? 'on' : ''} onClick={() => setGrade(g)}>{cap(g)}</button>)}
            </div>
            <div className="small muted mt">Customer asks for</div>
            <div className="seg" style={{ marginTop: 6 }}>
              <button className={qtyMode === 'amount' ? 'on' : ''} onClick={() => setQtyMode('amount')}>An amount (HTG)</button>
              <button className={qtyMode === 'gallons' ? 'on' : ''} onClick={() => setQtyMode('gallons')}>Gallons</button>
            </div>
            <div className="grid g2 mt">
              <label>Pump<input type="number" min="1" value={pump} onChange={(e) => setPump(e.target.value)} /></label>
              <label>{qtyMode === 'amount' ? 'Amount (HTG)' : 'Quantity (gal)'}
                <input type="number" step={qtyMode === 'amount' ? '1' : '0.1'} min="0" value={qty} onChange={(e) => setQty(e.target.value)}
                  placeholder={qtyMode === 'amount' ? '2000' : '12.0'} style={{ fontSize: 22, fontWeight: 700 }} /></label>
            </div>
            <p className="small muted mt">The employee’s company contract price is applied when they approve.</p>
            <button className="block mt" disabled={busy || !(Number(qty) > 0) || !(Number(pump) > 0)} onClick={create}>Create request</button>
          </>}
          {step === 2 && <>
            <h3>Waiting for employee approval</h3>
            <div className="row" style={{ gap: 18, marginTop: 6 }}>
              <span>{cap(active.grade)}</span><span>Pump {active.pump}</span><b style={{ fontSize: 20 }}>{requested(active)}</b>
            </div>
            <ol className="small muted" style={{ paddingLeft: 18, margin: '10px 0' }}>
              <li>The employee scans the QR on the right with the BOUSOL app (no internet needed) and enters their PIN.</li>
              <li>Scan the approval code on their phone here. Check the code’s bar is moving: a frozen bar means a photo.</li>
            </ol>
            <QrScanner prefix={RESPONSE_PREFIX} facing="environment" label="Scan employee phone" onResult={authorize} />
            <p className="small muted">Do not dispense yet. Request expires {when(active.expires_at)}.</p>
            <button className="secondary mt" disabled={busy} onClick={cancel}>Cancel request</button>
          </>}
          {step === 3 && <>
            <h3>Approved — dispense now</h3>
            <div className="banner ok mt"><span className="grow">{active.employee_name} · {active.company_name} approved <b>{money(active.approved_minor, active.currency)}</b>
              {' '}= {gal(active.approved_mgal, 2)} gal {active.grade} at {money(active.price_minor, active.currency)}/gal, pump {active.pump}.</span></div>
            <div className="small muted mt">Pump display shows</div>
            <div className="seg" style={{ marginTop: 6 }}>
              <button className={dispMode === 'amount' ? 'on' : ''} onClick={() => { setDispMode('amount'); setDispensed(String(active.approved_minor / 100)); }}>Amount (HTG)</button>
              <button className={dispMode === 'gallons' ? 'on' : ''} onClick={() => { setDispMode('gallons'); setDispensed(String(active.approved_mgal / 1000)); }}>Gallons</button>
            </div>
            <label className="mt">{dispMode === 'amount' ? 'Amount actually dispensed (HTG)' : 'Gallons actually dispensed'}
              <input type="number" step={dispMode === 'amount' ? '0.01' : '0.001'} value={dispensed} onChange={(e) => setDispensed(e.target.value)} style={{ fontSize: 22, fontWeight: 700 }} /></label>
            <p className="small muted">If the pump stopped early, enter the display reading. Anything not used goes back to the employee.</p>
            <div className="row mt">
              <button disabled={busy || !(Number(dispensed) > 0)} onClick={complete}>Confirm sale</button>
              <button className="secondary" disabled={busy} onClick={cancel}>Nothing dispensed — cancel</button>
            </div>
          </>}
          {step === 4 && <>
            <h3>{active.status === 'completed' ? 'Redeemed' : cap(active.status)}</h3>
            {active.status === 'completed'
              ? <p className="mt"><b style={{ fontSize: 22 }}>{money(active.charged_minor, active.currency)}</b> · {gal(active.dispensed_mgal, 2)} gal {active.grade} · pump {active.pump} · {active.employee_name}</p>
              : <p className="mt muted">The request was {active.status}. Create a new one.</p>}
            <button className="mt" onClick={() => { setActive(null); setQty(''); }}>New request</button>
          </>}
        </div>
        <div className="qr-box">
          {step === 2 && qr ? <>
            <img src={qr} alt="Station QR for the employee to scan" width={260} height={260} data-testid="station-challenge" data-challenge={active.challenge} />
            <div className="live-bar" aria-hidden><div /></div>
            <div className="rotate-bar" title="QR refreshes every 30 seconds"><div style={{ width: `${(rotateLeft / 30) * 100}%` }} /></div>
            <div className="muted small">New code in {Math.ceil(rotateLeft)}s · photos of this QR stop working</div>
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
    const sum = (o: Record<string, number>) => Object.values(o ?? {}).reduce((a, b) => a + b, 0);
    const digital = JSON.parse(result.digital_json);
    return (
      <div className="card white mt">
        <div className="row between"><h2 style={{ margin: 0 }}>Shift close</h2><Status s={result.status} /></div>
        <div className="grid g4 mt">
          <Kpi label="Charged to wallets" value={money(sum(digital.amounts))} />
          <Kpi label="POS program sales" value={money(sum(JSON.parse(result.pos_json)))} />
          <Kpi label="Amount variance" value={money(result.variance_minor)} bad={result.variance_minor > 0 && result.status === 'held'} />
          <Kpi label="Pump meter variance" value={`${gal(result.variance_mgal, 1)} gal`} sub={`${gal(sum(digital.gallons), 1)} gal recorded`} />
        </div>
        <p className="small muted mt">{result.status === 'held' ? 'Next: manager explanation, then distributor decision.' : 'Shift reconciled. You can sign out.'}</p>
      </div>
    );
  }
  return (
    <div className="card white mt">
      <div className="row between"><h2 style={{ margin: 0 }}>Close shift</h2><button className="ghost" onClick={onBack}>Back</button></div>
      <p className="small muted">Enter this shift’s program totals: POS sales in HTG, and the pump meter gallons. They are compared with what was charged to employee wallets.</p>
      <table className="mt"><thead><tr><th>Fuel</th><th>POS program sales (HTG)</th><th>Pump meter (gal)</th></tr></thead><tbody>
        {GRADES.map((g) => (
          <tr key={g}><td>{cap(g)}</td>
            <td><input type="number" step="0.01" value={pos[g] ?? ''} onChange={(e) => setPos({ ...pos, [g]: e.target.value })} /></td>
            <td><input type="number" step="0.1" value={pump[g] ?? ''} onChange={(e) => setPump({ ...pump, [g]: e.target.value })} /></td></tr>
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
                <td className="r num small">{sh.variance_minor != null ? `${money(sh.variance_minor)} · ${gal(sh.variance_mgal, 1)} gal var.` : ''}</td><td className="r"><Status s={sh.status} /></td></tr>
            ))}
          </tbody></table>
        </div>
        <ExceptionsPanel surface="station" />
      </div>
      <div className="card white mt table-wrap">
        <h2>Recent redemptions</h2>
        <table>
          <thead><tr><th>When</th><th>Pump</th><th>Fuel</th><th className="r">Amount</th><th className="r">Gallons</th><th>Employee</th><th>Company</th><th>Status</th></tr></thead>
          <tbody>
            {data?.redemptions.map((r: any) => (
              <tr key={r.id}><td className="small">{when(r.created_at)}</td><td>{r.pump}</td><td>{cap(r.grade)}</td>
                <td className="r num">{r.charged_minor != null ? money(r.charged_minor) : '—'}</td><td className="r num">{r.dispensed_mgal != null ? gal(r.dispensed_mgal, 2) : '—'}</td>
                <td>{r.employee_name ?? '—'}</td><td>{r.company_name ?? '—'}</td><td><Status s={r.status} /></td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
