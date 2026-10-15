import QRCode from 'qrcode';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, cap, gal, money, session, when } from '../api';
import { locale, t } from '../i18n';
import { LangToggle } from '../i18n/LangToggle';
import { RESPONSE_PREFIX } from '../offline';
import { Keypad, NumField } from '../keypad';
import { QrScanner } from '../scanner';
import {
  authorizeLocal, cancelLocal, completeLocal, createLocalRequest, isLocal, offlineStore, packUsable,
  refreshLocalRequest, syncAndRefresh, type OfflinePack,
} from '../station-offline';
import { Authed, BrandLogo, Empty, Kpi, PageHead, Shell, Status, useAction, useLoad, useLogout, useMe } from '../ui';
import { ExceptionsPanel } from './shared';

const s = api('station');
const GRADES = ['diesel', 'gasoline'];

export default function Station() {
  const [terminal, setTerminal] = useState(session.terminalInfo());
  const [managerMode, setManagerMode] = useState(false);
  if (!terminal && !managerMode) return <Activate onActivated={setTerminal} onManager={() => setManagerMode(true)} />;
  const resetTerminal = () => { session.clearTerminal(); setTerminal(null); setManagerMode(false); };
  const extra = terminal
    ? (
      <div className="row">
        <div className="badge info">{t('This device: {station} · {label}', { station: terminal.station_name, label: terminal.label })}</div>
        <button type="button" className="ghost sm" onClick={resetTerminal}>{t('Change terminal')}</button>
      </div>
    )
    : <div className="badge warn">{t('Manager sign-in (no terminal on this device)')}</div>;
  // The server no longer knows this device's terminal key: send the user back to activation.
  const onLoginError = (e: ApiError) => { if (e.code === 'terminal_unknown' && terminal) resetTerminal(); };
  return (
    <Authed surface="station" loginExtra={extra} offlineOk onLoginError={onLoginError}>
      <StationHome />
    </Authed>
  );
}

function Activate({ onActivated, onManager }: { onActivated: (terminal: any) => void; onManager: () => void }) {
  const [code, setCode] = useState('');
  const { busy, run } = useAction();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const out = await run(() => s.post('/api/terminals/activate', { code }), t('Terminal activated'));
    if (out) { session.setTerminal(out.terminalKey, out.terminal); onActivated(out.terminal); }
  };
  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <BrandLogo large />
        <div className="row between"><div className="eyebrow">{t('Station app · powered by BOUSOL')}</div><LangToggle /></div>
        <h1>{t('Activate this terminal')}</h1>
        <p className="small muted">{t('Each station runs one approved Android phone or tablet. Enter the one-time activation code from the distributor.')}</p>
        <label>{t('Activation code')}<input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="STATION2" autoCapitalize="characters" /></label>
        <button disabled={busy || code.length < 4}>{t('Activate')}</button>
        <button type="button" className="secondary" onClick={onManager}>{t('I’m a station manager')}</button>
        <a href="/" className="small muted">← {t('All apps')}</a>
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
        const timer = setTimeout(() => ctl.abort(), 4000);
        const res = await fetch('/api/health', { cache: 'no-store', signal: ctl.signal });
        clearTimeout(timer);
        if (!stop) setOnline(res.ok);
      } catch { if (!stop) setOnline(false); }
    };
    check();
    const timer = setInterval(check, 8000);
    window.addEventListener('online', check);
    window.addEventListener('offline', () => setOnline(false));
    return () => { stop = true; clearInterval(timer); window.removeEventListener('online', check); };
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
  useEffect(() => { reload(); const timer = setInterval(reload, 5000); return () => clearInterval(timer); }, [reload]);

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
          const parts = [t('Synced {n} offline sale(s)', { n: out.posted })];
          if (out.rejected) parts.push(t('{n} rejected and sent to the distributor', { n: out.rejected }));
          if (out.shortfallMinor) parts.push(t('{amount} not covered', { amount: money(out.shortfallMinor) }));
          setSyncNote(parts.join(', ') + '.');
          reload();
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) setPack(null); // terminal frozen: no offline pack
      }
    };
    sync();
    const timer = setInterval(sync, 60_000);
    return () => { stop = true; clearInterval(timer); };
  }, [online, reload]);

  // While the QR is on screen, keep its challenge fresh so a photo of the terminal stops working.
  useEffect(() => {
    if (!active || active.status !== 'pending') return;
    const timer = setInterval(async () => {
      if (isLocal(active)) { if (pack) setActive(refreshLocalRequest(pack, active)); return; }
      try { setActive(await s.post(`/api/redemptions/${active.id}/challenge`)); } catch { /* keep last state */ }
    }, isLocal(active) ? 1000 : 3000);
    return () => clearInterval(timer);
  }, [active, pack]);

  // Resume an in-flight online request after a reload so the attendant never loses track of it.
  useEffect(() => {
    const inflight = data?.redemptions?.find((r: any) => r.status === 'pending' || r.status === 'approved');
    if (online && !active && inflight) s.get(`/api/redemptions/${inflight.id}`).then(setActive).catch(() => {});
  }, [data, online]);

  const openShift = async () => { if (await run(() => s.post('/api/shifts/open'), t('Shift opened'))) reload(); };
  const mode: 'online' | 'offline' = online ? 'online' : 'offline';
  const offlineReady = packUsable(pack);
  const pendingSales = offlineStore.queue().filter((q) => q.shiftId === shift?.id);

  return (
    <div className="terminal-bg">
      <div className="terminal">
        <div className="row between">
          <h2 style={{ margin: 0 }}>{info?.station_name ?? me.station?.name} · {t('Terminal {label}', { label: info?.label ?? '' })}</h2>
          <div className="row">
            <span className={`badge ${online ? 'ok' : 'warn'}`} data-testid="connection">{online ? t('Online') : t('Offline mode')}</span>
            {shift ? <span className="badge ok">{t('Shift open · {name}', { name: me.name })}</span> : <button className="sm" disabled={busy || !online} onClick={openShift}>{t('Open shift')}</button>}
            {shift && !active && <button className="sm secondary" disabled={!online || queued > 0} title={!online || queued ? t('Sync offline sales first') : ''} onClick={() => setClosing(true)}>{t('Close shift')}</button>}
            <button className="sm ghost" onClick={logout}>{t('Sign out')}</button>
            <LangToggle />
          </div>
        </div>
        {!online && (offlineReady
          ? <div className="banner mt"><span className="grow small"><b>{t('No connection: offline mode.')}</b> {t('Approvals are checked on this terminal and synced when the connection returns.')}
              {' '}{t('{n} sale(s) waiting · limits {perEmployee} per employee, {perTerminal} per terminal · offline data from {date}', { n: queued, perEmployee: money(pack!.limits.per_employee_minor), perTerminal: money(pack!.limits.terminal_minor), date: when(pack!.generated_at) })}</span></div>
          : <div className="banner bad mt"><span className="grow small"><b>{t('No connection.')}</b> {t('This terminal has no valid offline data, so it can’t approve fuelings. Reconnect once to download it.')}</span></div>)}
        {online && queued > 0 && <div className="banner mt"><span className="grow small">{t('Syncing {n} offline sale(s)…', { n: queued })}</span></div>}
        {syncNote && <div className="banner ok mt"><span className="grow small">{syncNote}</span><button className="ghost sm" onClick={() => setSyncNote(null)} aria-label={t('Dismiss')}>✕</button></div>}
        {!shift && !closing && <div className="banner mt">{online ? t('Open your named shift to start taking redemption requests.') : t('Open your named shift to start taking redemption requests (needs a connection).')}</div>}
        {shift && !closing && (online || offlineReady || active) && (
          <RequestFlow active={active} mode={mode} pack={pack} shiftId={shift.id} setActive={(r) => { setActive(r); reload(); }} />
        )}
        {closing && <CloseShift onBack={() => setClosing(false)} onClosed={() => { reload(); }} />}
        {shift && !closing && (
          <div className="card white mt">
            <h3>{t('This shift')}</h3>
            <table className="mt"><tbody>
              {pendingSales.map((q) => (
                <tr key={q.clientId}><td className="small">{when(q.completedAt)}</td><td>{t('Pump {n}', { n: q.pump })}</td><td>{cap(q.grade)}</td>
                  <td className="r num">{money(q.chargedMinor, q.currency)}</td><td className="r num small muted">{gal(q.dispensedMgal, 2)} gal</td>
                  <td>—</td><td className="r"><span className="badge warn">{t('Offline · not synced')}</span></td></tr>
              ))}
              {data?.redemptions?.map((r: any) => (
                <tr key={r.id}><td className="small">{when(r.created_at)}</td><td>{t('Pump {n}', { n: r.pump })}</td><td>{cap(r.grade)}</td>
                  <td className="r num">{r.charged_minor != null ? money(r.charged_minor) : r.requested_minor != null ? money(r.requested_minor) : `${gal(r.requested_mgal, 1)} gal`}</td>
                  <td className="r num small muted">{r.dispensed_mgal != null ? `${gal(r.dispensed_mgal, 2)} gal` : ''}</td><td>{r.employee_name ?? '—'}</td>
                  <td className="r">{r.offline ? <span className="badge info" style={{ marginRight: 6 }}>{t('Offline')}</span> : null}<Status s={r.status} /></td></tr>
              ))}
            </tbody></table>
            {!data?.redemptions?.length && !pendingSales.length && <Empty>{t('No requests yet this shift.')}</Empty>}
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
  const [field, setField] = useState<'pump' | 'qty'>('qty');
  const { busy, run } = useAction();

  useEffect(() => {
    if (active?.challenge) QRCode.toDataURL(active.challenge, { margin: 1, width: 260, errorCorrectionLevel: 'L' }).then(setQr);
  }, [active?.challenge]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(timer); }, []);
  const nonceAt = active?.nonce_at ? Date.parse(active.nonce_at.includes('T') ? active.nonce_at : active.nonce_at.replace(' ', 'T') + 'Z') : 0;
  const rotateLeft = nonceAt ? Math.max(0, 30 - (now - nonceAt) / 1000) : 0;
  const local = isLocal(active);

  // Offline requests are handled entirely on this terminal; online ones by the server.
  const authorize = async (token: string) => {
    const r = await run(() => (local ? authorizeLocal(pack!, active, token) : s.post(`/api/redemptions/${active.id}/authorize`, { token })), t('Approved by employee'));
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
    const r = await run(async () => (local ? cancelLocal(active) : s.post(`/api/redemptions/${active.id}/cancel`)), t('Request cancelled'));
    if (r) setActive(null);
  };
  const complete = async () => {
    const q = { [dispMode]: Number(dispensed) };
    const r = await run(async () => (local ? completeLocal(active, q) : s.post(`/api/redemptions/${active.id}/complete`, q)), local ? t('Sale saved; it syncs when the connection returns') : t('Sale confirmed'));
    if (r) setActive(r);
  };
  const requested = (r: any) => (r.requested_minor != null ? money(r.requested_minor) : `${gal(r.requested_mgal, 1)} gal`);

  const step = !active ? 1 : active.status === 'pending' ? 2 : active.status === 'approved' ? 3 : 4;
  return (
    <>
      <div className="grid mt terminal-cols">
        <div className="card">
          {step === 1 && <>
            <h3>{t('New redemption request')}</h3>
            <div className="small muted mt">{t('Fuel')}</div>
            <div className="seg" style={{ marginTop: 6 }}>
              {GRADES.map((g) => <button key={g} className={grade === g ? 'on' : ''} onClick={() => setGrade(g)}>{cap(g)}</button>)}
            </div>
            <div className="small muted mt">{t('Customer asks for')}</div>
            <div className="seg" style={{ marginTop: 6 }}>
              <button className={qtyMode === 'amount' ? 'on' : ''} onClick={() => { setQtyMode('amount'); setQty(''); setField('qty'); }}>{t('An amount (HTG)')}</button>
              <button className={qtyMode === 'gallons' ? 'on' : ''} onClick={() => { setQtyMode('gallons'); setQty(''); setField('qty'); }}>{t('Gallons')}</button>
            </div>
            <div className="grid mt" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr)' }}>
              <NumField label={t('Pump')} value={pump} active={field === 'pump'} onSelect={() => setField('pump')} testId="field-pump" />
              <NumField label={qtyMode === 'amount' ? t('Amount') : t('Quantity')} value={qty} placeholder={qtyMode === 'amount' ? '2000' : '12.0'}
                suffix={qtyMode === 'amount' ? 'HTG' : 'gal'} big active={field === 'qty'} onSelect={() => setField('qty')} testId="field-qty" />
            </div>
            <p className="small muted mt">{t('Tap a box, then type on the keypad. The employee’s company contract price is applied when they approve.')}</p>
          </>}
          {step === 2 && <>
            <h3>{t('Waiting for employee approval')}</h3>
            <div className="row" style={{ gap: 18, marginTop: 6 }}>
              <span>{cap(active.grade)}</span><span>{t('Pump {n}', { n: active.pump })}</span><b style={{ fontSize: 20 }}>{requested(active)}</b>
            </div>
            <ol className="small muted" style={{ paddingLeft: 18, margin: '10px 0' }}>
              <li>{t('The employee scans this QR with the fuel wallet app (no internet needed) and enters their PIN.')}</li>
              <li>{t('Scan the approval code on their phone here. Check the code’s bar is moving: a frozen bar means a photo.')}</li>
            </ol>
            <QrScanner prefix={RESPONSE_PREFIX} facing="environment" label={t('Scan employee phone')} onResult={authorize} />
            <p className="small muted">{t('Do not dispense yet. Request expires {when}.', { when: when(active.expires_at) })}</p>
            <button className="secondary mt" disabled={busy} onClick={cancel}>{t('Cancel request')}</button>
          </>}
          {step === 3 && <>
            <h3>{t('Approved — dispense now')}</h3>
            <div className="banner ok mt"><span className="grow">{active.employee_name} · {active.company_name} {t('approved')} <b>{money(active.approved_minor, active.currency)}</b>
              {' '}{t('= {gallons} gal {grade} at {price}/gal, pump {pump}.', { gallons: gal(active.approved_mgal, 2), grade: cap(active.grade), price: money(active.price_minor, active.currency), pump: active.pump })}</span></div>
            <div className="small muted mt">{t('Pump display shows')}</div>
            <div className="seg" style={{ marginTop: 6 }}>
              <button className={dispMode === 'amount' ? 'on' : ''} onClick={() => { setDispMode('amount'); setDispensed(String(active.approved_minor / 100)); }}>{t('Amount (HTG)')}</button>
              <button className={dispMode === 'gallons' ? 'on' : ''} onClick={() => { setDispMode('gallons'); setDispensed(String(active.approved_mgal / 1000)); }}>{t('Gallons')}</button>
            </div>
            <div className="mt">
              <NumField label={dispMode === 'amount' ? t('Amount actually dispensed') : t('Gallons actually dispensed')} value={dispensed}
                suffix={dispMode === 'amount' ? 'HTG' : 'gal'} big active onSelect={() => {}} testId="field-dispensed" />
            </div>
            <p className="small muted">{t('If the pump stopped early, type the display reading on the keypad. Anything not used goes back to the employee.')}</p>
            <div className="row mt">
              <button className="secondary" disabled={busy} onClick={cancel}>{t('Nothing dispensed — cancel')}</button>
            </div>
          </>}
          {step === 4 && <>
            <h3>{active.status === 'completed' ? t('Redeemed') : cap(active.status)}</h3>
            {active.status === 'completed'
              ? <p className="mt"><b style={{ fontSize: 22 }}>{money(active.charged_minor, active.currency)}</b> · {gal(active.dispensed_mgal, 2)} gal {cap(active.grade)} · {t('pump {n}', { n: active.pump })} · {active.employee_name}</p>
              : <p className="mt muted">{t('The request was {status}. Create a new one.', { status: cap(active.status).toLowerCase() })}</p>}
            <button className="mt" onClick={() => { setActive(null); setQty(''); setField('qty'); }}>{t('New request')}</button>
          </>}
        </div>
        {step === 1 ? (
          <div className="qr-box pad">
            <Keypad
              value={field === 'pump' ? pump : qty}
              onChange={field === 'pump' ? setPump : setQty}
              decimals={field === 'pump' ? 0 : qtyMode === 'amount' ? 0 : 1}
              maxDigits={field === 'pump' ? 2 : 6}
              quick={field === 'pump' ? [1, 2, 3, 4] : qtyMode === 'amount' ? [500, 1000, 2500, 5000] : [5, 10, 15, 20]}
              quickLabel={field === 'pump' ? (n) => t('Pump {n}', { n }) : qtyMode === 'amount' ? (n) => n.toLocaleString(locale) : (n) => `${n} gal`}
            />
            <button className="block" disabled={busy || !(Number(qty) > 0) || !(Number(pump) > 0)} onClick={create}>{t('Create request')}</button>
          </div>
        ) : step === 3 ? (
          <div className="qr-box pad">
            <Keypad value={dispensed} onChange={setDispensed} decimals={dispMode === 'amount' ? 2 : 3} maxDigits={6} />
            <button className="block" disabled={busy || !(Number(dispensed) > 0)} onClick={complete}>{t('Confirm sale')}</button>
          </div>
        ) : (
        <div className="qr-box">
          {step === 2 && qr ? <>
            <img src={qr} alt={t('Station QR for the employee to scan')} width={260} height={260} data-testid="station-challenge" data-challenge={active.challenge} />
            <div className="live-bar" aria-hidden><div /></div>
            <div className="rotate-bar" title={t('QR refreshes every 30 seconds')}><div style={{ width: `${(rotateLeft / 30) * 100}%` }} /></div>
            <div className="muted small">{t('New code in {n}s · photos of this QR stop working', { n: Math.ceil(rotateLeft) })}</div>
          </> : <div className="muted small" style={{ padding: 40 }}>{step === 4 ? '✓' : t('Preparing the QR…')}</div>}
        </div>
        )}
      </div>
      <div className="progress">
        {[t('1 Request'), t('2 Approval'), t('3 Dispense'), t('4 Confirm')].map((label, i) => (
          <div key={label} className={i + 1 < step || (step === 4 && active?.status === 'completed') ? 'done' : i + 1 === step ? 'now' : ''}>{label}</div>
        ))}
      </div>
    </>
  );
}

function CloseShift({ onBack, onClosed }: { onBack: () => void; onClosed: () => void }) {
  const [pump, setPump] = useState<Record<string, string>>({});
  const [pos, setPos] = useState<Record<string, string>>({});
  const [cell, setCell] = useState<{ kind: 'pos' | 'pump'; grade: string }>({ kind: 'pos', grade: GRADES[0] });
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
        <div className="row between"><h2 style={{ margin: 0 }}>{t('Shift close')}</h2><Status s={result.status} /></div>
        <div className="grid g4 mt">
          <Kpi label={t('Charged to wallets')} value={money(sum(digital.amounts))} />
          <Kpi label={t('POS program sales')} value={money(sum(JSON.parse(result.pos_json)))} />
          <Kpi label={t('Amount variance')} value={money(result.variance_minor)} bad={result.variance_minor > 0 && result.status === 'held'} />
          <Kpi label={t('Pump meter variance')} value={`${gal(result.variance_mgal, 1)} gal`} sub={t('{n} gal recorded', { n: gal(sum(digital.gallons), 1) })} />
        </div>
        <p className="small muted mt">{result.status === 'held' ? t('Next: manager explanation, then distributor decision.') : t('Shift reconciled. You can sign out.')}</p>
      </div>
    );
  }
  return (
    <div className="card white mt">
      <div className="row between"><h2 style={{ margin: 0 }}>{t('Close shift')}</h2><button className="ghost" onClick={onBack}>{t('Back')}</button></div>
      <p className="small muted">{t('Enter this shift’s program totals: POS sales in HTG, and the pump meter gallons. They are compared with what was charged to employee wallets.')}</p>
      <div className="grid mt terminal-cols">
        <div className="grid" style={{ alignContent: 'start' }}>
          {GRADES.map((g) => (
            <div key={g} className="grid g2">
              <NumField label={t('{grade} · POS sales', { grade: cap(g) })} suffix="HTG" value={pos[g] ?? ''} active={cell.kind === 'pos' && cell.grade === g}
                onSelect={() => setCell({ kind: 'pos', grade: g })} testId={`close-pos-${g}`} />
              <NumField label={t('{grade} · pump meter', { grade: cap(g) })} suffix="gal" value={pump[g] ?? ''} active={cell.kind === 'pump' && cell.grade === g}
                onSelect={() => setCell({ kind: 'pump', grade: g })} testId={`close-pump-${g}`} />
            </div>
          ))}
        </div>
        <div className="qr-box pad">
          <Keypad
            value={(cell.kind === 'pos' ? pos : pump)[cell.grade] ?? ''}
            onChange={(v) => (cell.kind === 'pos' ? setPos({ ...pos, [cell.grade]: v }) : setPump({ ...pump, [cell.grade]: v }))}
            decimals={cell.kind === 'pos' ? 2 : 1} maxDigits={8} />
          <button className="block" disabled={busy} onClick={submit}>{t('Close shift')}</button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ manager

function Manager() {
  const me = useMe();
  const { data } = useLoad(() => s.get(`/api/stations/${me.stationId}/overview`), [], 15000);
  const shifts = useLoad(() => s.get('/api/shifts'), [], 15000);
  return (
    <Shell surface="station" nav={[['/station', t('Station overview')]]}>
      <PageHead eyebrow={t('Station manager · {station}', { station: me.station?.name ?? '' })} title={t('Fuel counts only after the employee confirms')} />
      <div className="grid g2">
        <div className="card white">
          <h2>{t('Terminal')}</h2>
          {data?.terminal ? <p>{data.terminal.label} <Status s={data.terminal.status} /> {data.terminal.activated ? <span className="small muted">· {t('device activated')}</span> : <span className="small muted">· {t('awaiting activation')}</span>}</p> : <Empty>{t('No terminal registered.')}</Empty>}
          <h2 className="mt">{t('Recent shifts')}</h2>
          <table><tbody>
            {shifts.data?.slice(0, 8).map((sh: any) => (
              <tr key={sh.id}><td>#{sh.id}</td><td>{sh.attendant_name}</td><td className="small">{when(sh.opened_at)}</td>
                <td className="r num small">{sh.variance_minor != null ? t('{amount} · {gallons} gal var.', { amount: money(sh.variance_minor), gallons: gal(sh.variance_mgal, 1) }) : ''}</td><td className="r"><Status s={sh.status} /></td></tr>
            ))}
          </tbody></table>
        </div>
        <ExceptionsPanel surface="station" />
      </div>
      <div className="card white mt table-wrap">
        <h2>{t('Recent redemptions')}</h2>
        <table>
          <thead><tr><th>{t('When')}</th><th>{t('Pump')}</th><th>{t('Fuel')}</th><th className="r">{t('Amount')}</th><th className="r">{t('Gallons')}</th><th>{t('Employee')}</th><th>{t('Company')}</th><th>{t('Status')}</th></tr></thead>
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
