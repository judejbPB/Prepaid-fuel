import QRCode from 'qrcode';
import { useCallback, useEffect, useState } from 'react';
import { NavLink, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, cap, date, gal, money, when } from '../api';
import {
  approveChallenge, CHALLENGE_PREFIX, cryptoAvailable, decodeChallenge, localKeyId, maxAmount,
  pendingApprovals, prepareEnrollment, walletCache,
} from '../offline';
import { QrScanner } from '../scanner';
import { Authed, Empty, Status, useAction, useLoad, useLogout, useMe } from '../ui';
import { locale, t } from '../i18n';
import { LangToggle } from '../i18n/LangToggle';

const e = api('employee');
/** How long an approval code is shown; matches the station's challenge rotation plus grace. */
const CODE_SECONDS = 60;

export default function Employee() {
  return (
    <Authed surface="employee" offlineOk>
      <Wallet />
    </Authed>
  );
}

/** Wallet data with an offline fallback: the last synced copy is kept on the phone. */
function useWallet() {
  const me = useMe();
  const key = String(me.userId);
  const [w, setW] = useState<any>(() => walletCache.load(key));
  const [online, setOnline] = useState(true);
  const reload = useCallback(async () => {
    try {
      const fresh = await e.get('/api/wallet');
      walletCache.save(key, fresh);
      pendingApprovals.reconcile(fresh.employee.id, fresh.history);
      setW(fresh);
      setOnline(true);
    } catch (err) {
      if (err instanceof ApiError) return;
      setOnline(false); // network failure: keep showing the cached wallet
    }
  }, [key]);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, 15000);
    window.addEventListener('online', reload);
    return () => { clearInterval(timer); window.removeEventListener('online', reload); };
  }, [reload]);
  return { w, online, reload };
}

function Wallet() {
  const { w, online, reload } = useWallet();
  const [localKey, setLocalKey] = useState<number | null | undefined>(undefined);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => { if (w) localKeyId(w.employee.id).then(setLocalKey); }, [w?.employee.id, w?.device?.key_id]);

  if (!w) {
    return <Phone><div className="stack"><h2>{t('My fuel')}</h2>
      <div className="banner">{online ? t('Loading your wallet…') : t('Connect to the internet once to load your wallet. After that it works offline.')}</div></div></Phone>;
  }
  if (localKey === undefined) return <Phone />;
  if (!cryptoAvailable()) return <Phone><div className="banner bad">{t('This browser can’t secure a wallet. Use Chrome or Safari, over HTTPS.')}</div></Phone>;
  if (!w.device.enrolled) return <Phone><Enroll employeeId={w.employee.id} online={online} onDone={reload} /></Phone>;
  if (!w.device.on_this_phone || localKey !== w.device.key_id) {
    return <Phone><div className="stack"><h2>{t('Wallet on another phone')}</h2>
      <div className="banner bad">{t('Your fuel wallet is registered to a different phone, or this phone’s security key was erased.')}</div>
      <p className="small muted">{t('Ask your company admin for assisted recovery, then sign in again here to register this phone.')}</p></div></Phone>;
  }
  const pending = pendingApprovals.list(w.employee.id);
  const view = { ...w, pending, spendable_minor: w.available_minor - pending.reduce((s, p) => s + p.max, 0) };
  return (
    <Phone tabs>
      {!online && (
        <div className="banner" style={{ marginBottom: 12 }}>
          <span className="grow small"><b>{t('Offline.')}</b> {t('Balance as of {time}. You can still pay at the pump.', { time: when(w.synced_at) })}</span>
        </div>
      )}
      <Routes>
        <Route index element={<Balance w={view} />} />
        <Route path="pay" element={<Scan onScan={setChallenge} />} />
        <Route path="pay/confirm" element={<Confirm w={view} challenge={challenge} onCode={setCode} />} />
        <Route path="pay/code" element={<ShowCode code={code} />} />
        <Route path="receipt/:id" element={<Receipt />} />
        <Route path="history" element={<History w={view} reload={reload} online={online} />} />
      </Routes>
    </Phone>
  );
}

function Phone({ children, tabs }: { children?: React.ReactNode; tabs?: boolean }) {
  return (
    <div className="phone-bg">
      <div className="phone">
        {children}
        {tabs && (
          <nav className="tabbar">
            <NavLink to="/employee" end>{t('My fuel')}</NavLink>
            <NavLink to="/employee/pay">{t('Pay at pump')}</NavLink>
            <NavLink to="/employee/history">{t('History')}</NavLink>
          </nav>
        )}
      </div>
    </div>
  );
}

function Balance({ w }: { w: any }) {
  const navigate = useNavigate();
  const logout = useLogout('employee');
  const frozen = w.employee.status !== 'active' || w.employee.company_status !== 'active';
  return (
    <div className="stack">
      <div className="row between"><div className="row" style={{ gap: 10 }}><img src="/alfa-logo.png" alt="ALFA" style={{ height: 18 }} /><h2>{t('My fuel')}</h2></div><div className="row" style={{ gap: 8 }}><LangToggle /><button className="ghost sm" onClick={logout}>{t('Sign out')}</button></div></div>
      <p className="muted" style={{ marginTop: -8 }}>{w.employee.name} · {w.employee.company_name}</p>
      {frozen && <div className="banner bad">{t('Your fuel wallet is frozen. Contact your company admin.')}</div>}
      <div className="balance-card">
        <div className="sub">{t('Available')}</div>
        <div className="big num">{money(w.spendable_minor, w.currency)}</div>
        <div className="sub">{t('Diesel or gasoline')}{w.next_expiry ? ' · ' + t('earliest expiry {date}', { date: date(w.next_expiry) }) : ''}</div>
      </div>
      <div>
        <div className="small muted" style={{ marginBottom: 4 }}>{t('About how much fuel that buys')}</div>
        {w.prices.map((p: any) => (
          <div className="kv" key={p.grade}>
            <span>{cap(p.grade)} <span className="small muted">{t('at {price}/gal', { price: money(p.price_minor, p.currency) })}</span></span>
            <b className="num">≈ {gal(Math.floor((Math.max(0, w.spendable_minor) * 1000) / p.price_minor), 1)} gal</b>
          </div>
        ))}
      </div>
      {w.pending.length > 0 && <div className="banner small">{t('{amount} approved at the pump and not yet synced.', { amount: money(w.pending.reduce((s: number, p: any) => s + p.max, 0), w.currency) })}</div>}
      {w.reserved_minor > 0 && <div className="banner">{t('{amount} reserved for a fueling in progress.', { amount: money(w.reserved_minor, w.currency) })}</div>}
      <button className="block" disabled={frozen} onClick={() => navigate('/employee/pay')}>{t('Pay at pump')}</button>
      {w.lots.length > 0 && (
        <details className="small">
          <summary className="muted">{t('Where my balance comes from')}</summary>
          {w.lots.map((l: any) => (
            <div className="kv" key={l.code}><span className="mono">{l.code}</span><span>{money(l.balance, l.currency)} · {t('exp. {date}', { date: date(l.expires_on) })}</span></div>
          ))}
        </details>
      )}
    </div>
  );
}

/** One-time, online: creates this phone's signing key and registers it with the PIN. */
function Enroll({ employeeId, online, onDone }: { employeeId: number; online: boolean; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const { busy, run } = useAction();
  const submit = async () => {
    const out = await run(async () => {
      const prep = await prepareEnrollment(pin);
      const res = await e.post('/api/wallet/enroll', { password, ...prep.body });
      await prep.save(employeeId, res.deviceKeyId);
      return res;
    }, t('This phone is now your fuel wallet'));
    if (out) onDone();
  };
  return (
    <div className="stack">
      <h2>{t('Set up this phone')}</h2>
      <p className="small muted">{t('Choose a PIN. You’ll enter it to approve every fueling, even with no internet. This phone becomes your only wallet device.')}</p>
      {!online && <div className="banner bad">{t('Setup needs an internet connection, just this once.')}</div>}
      <label>{t('Account password')}<input type="password" value={password} onChange={(ev) => setPassword(ev.target.value)} /></label>
      <label>{t('New PIN (4–6 digits)')}<input type="password" inputMode="numeric" maxLength={6} value={pin} onChange={(ev) => setPin(ev.target.value.replace(/\D/g, ''))} /></label>
      <label>{t('Repeat PIN')}<input type="password" inputMode="numeric" maxLength={6} value={pin2} onChange={(ev) => setPin2(ev.target.value.replace(/\D/g, ''))} /></label>
      <button className="block" disabled={busy || !online || pin.length < 4 || pin !== pin2 || !password} onClick={submit}>{t('Secure my wallet')}</button>
    </div>
  );
}

function Scan({ onScan }: { onScan: (c: string) => void }) {
  const navigate = useNavigate();
  return (
    <div className="stack">
      <h2>{t('Pay at pump')}</h2>
      <p className="small muted">{t('Scan the QR on the station terminal. No internet needed.')}</p>
      <QrScanner prefix={CHALLENGE_PREFIX} label={t('Scan station QR')} onResult={(c) => { onScan(c); navigate('/employee/pay/confirm'); }} />
    </div>
  );
}

function Confirm({ w, challenge, onCode }: { w: any; challenge: string | null; onCode: (c: string) => void }) {
  const navigate = useNavigate();
  const [pin, setPin] = useState('');
  const { busy, run } = useAction();
  if (!challenge) return <div className="stack"><h2>{t('Approve fueling')}</h2><button className="secondary" onClick={() => navigate('/employee/pay')}>{t('Scan the station QR')}</button></div>;
  let ch;
  try { ch = decodeChallenge(challenge); } catch { return <div className="banner bad">{t('Unreadable station code.')}</div>; }
  const max = maxAmount(ch, w.prices);
  const price = w.prices.find((p: any) => p.grade === ch.g)?.price_minor;
  const gallons = ch.q ?? (price ? Math.floor((ch.a! * 1000) / price) : null);
  const short = max !== null && max > w.spendable_minor;
  const press = (k: string) => setPin((p) => (k === '⌫' ? p.slice(0, -1) : p.length < 6 ? p + k : p));
  const confirm = async () => {
    const out = await run(() => approveChallenge(w.employee.id, ch, max!, pin));
    setPin('');
    if (!out) return;
    pendingApprovals.add(w.employee.id, { code: ch.c, max: max!, at: new Date().toISOString(), station: ch.s, grade: ch.g });
    onCode(out);
    navigate('/employee/pay/code', { replace: true });
  };
  return (
    <div className="stack">
      <h2>{t('Approve fueling')}</h2>
      <div>
        <div className="kv"><span className="muted">{t('Station')}</span><b>{ch.s}</b></div>
        <div className="kv"><span className="muted">{t('Pump')}</span><b>{ch.p}</b></div>
        <div className="kv"><span className="muted">{t('Fuel')}</span><b>{cap(ch.g)}</b></div>
      </div>
      {max === null ? <div className="banner bad">{t('No {grade} price on this phone yet. Connect once to sync.', { grade: cap(ch.g) })}</div> : <>
        <div><div className="muted">{t('Amount')}</div><div style={{ fontSize: 40, fontWeight: 700 }} className="num">{money(max, w.currency)}</div>
          <div className="small muted">{ch.a != null ? '≈ ' : ''}{gal(gallons, 2)} gal{price ? ' ' + t('at {price}/gal', { price: money(price, w.currency) }) : ''} · {t('you have {amount}', { amount: money(w.spendable_minor, w.currency) })}</div></div>
        {short ? <div className="banner bad">{t('Your balance is too low for this request.')}</div> : <>
          <div className="muted">{t('Confirm with PIN')}</div>
          <div className="pin-dots">{[0, 1, 2, 3].map((i) => <span key={i} className={pin.length > i ? 'on' : ''} />)}</div>
          <div className="keypad">{['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((k) => k ? <button key={k} onClick={() => press(k)}>{k}</button> : <span key="blank" />)}</div>
          <button className="block" disabled={busy || pin.length < 4} onClick={confirm}>{t('Confirm')}</button>
        </>}
      </>}
      <button className="ghost" onClick={() => navigate('/employee')}>{t('Not me / cancel')}</button>
    </div>
  );
}

/**
 * The approval code the attendant scans. It is bound to this request and the station's current
 * challenge, so a screenshot is useless elsewhere or later. The moving bar and running clock make a
 * static photo obvious to the attendant.
 */
function ShowCode({ code }: { code: string | null }) {
  const navigate = useNavigate();
  const [qr, setQr] = useState('');
  const [left, setLeft] = useState(CODE_SECONDS);
  const [now, setNow] = useState(new Date());
  useEffect(() => { if (code) QRCode.toDataURL(code, { margin: 1, width: 300, errorCorrectionLevel: 'L' }).then(setQr); }, [code]);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => { setNow(new Date()); setLeft(Math.max(0, CODE_SECONDS - Math.floor((Date.now() - started) / 1000))); }, 250);
    return () => clearInterval(timer);
  }, [code]);
  if (!code) return <button className="secondary" onClick={() => navigate('/employee/pay')}>{t('Scan the station QR')}</button>;
  return (
    <div className="stack" style={{ textAlign: 'center' }}>
      <h2>{t('Show this to the attendant')}</h2>
      {left > 0 ? <>
        <div className="qr-box" data-testid="approval-code" data-code={code}>
          {qr && <img src={qr} alt={t('Approval code')} width={300} height={300} />}
          <div className="live-bar" aria-hidden><div /></div>
          <div className="mono">{now.toLocaleTimeString(locale)} · {t('valid {s}s', { s: left })}</div>
        </div>
        <p className="small muted">{t('Works once, for this pump only. A screenshot of it is useless.')}</p>
      </> : <div className="banner bad">{t('This code expired. Scan the station QR again.')}</div>}
      <button className="secondary" onClick={() => navigate('/employee', { replace: true })}>{t('Done')}</button>
    </div>
  );
}

function Receipt() {
  const { id } = useParams();
  const navigate = useNavigate();
  const red = useLoad(() => e.get(`/api/redemptions/${id}`), [id], 2500);
  const wallet = useLoad(() => e.get('/api/wallet'), [red.data?.status]);
  const [disputing, setDisputing] = useState(false);
  const r = red.data;
  if (!r) return null;
  const done = r.status === 'completed';
  return (
    <div className="stack" style={{ textAlign: 'center' }}>
      {done ? <div className="check">✓</div> : <div className="check" style={{ background: 'var(--amber)', color: 'var(--on-accent)' }}>…</div>}
      <h2>{done ? t('Redeemed') : r.status === 'approved' ? t('Approved — attendant is dispensing') : cap(r.status)}</h2>
      <div style={{ fontSize: 26, fontWeight: 700 }} className="num">{money(done ? r.charged_minor : r.approved_minor, r.currency)}</div>
      <div>{gal(done ? r.dispensed_mgal : r.approved_mgal, 2)} gal {cap(r.grade)} · {money(r.price_minor, r.currency)}/gal</div>
      <div className="muted">{r.station_name} · {t('Pump {n}', { n: r.pump })}</div>
      <div className="kv" style={{ textAlign: 'left' }}><span>{t('New balance')}</span><b>{money(wallet.data?.available_minor, wallet.data?.currency)}</b></div>
      {done && r.charged_minor < r.approved_minor && <p className="small muted">{t('{amount} not used was returned to your balance.', { amount: money(r.approved_minor - r.charged_minor, r.currency) })}</p>}
      {done && <button className="secondary block" onClick={() => setDisputing(true)}>{t('Raise a dispute')}</button>}
      {r.status === 'approved' && <button className="ghost" onClick={async () => { try { await e.post(`/api/redemptions/${r.id}/cancel`); red.reload(); } catch (err: any) { alert(err.message); } }}>{t('Cancel before fueling')}</button>}
      <button className="ghost" onClick={() => navigate('/employee')}>{t('Back to my fuel')}</button>
      {disputing && <DisputeForm id={r.id} onDone={() => { setDisputing(false); navigate('/employee/history'); }} onCancel={() => setDisputing(false)} />}
    </div>
  );
}

function DisputeForm({ id, onDone, onCancel }: { id: number; onDone: () => void; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  const { busy, run } = useAction();
  return (
    <div className="card" style={{ textAlign: 'left' }}>
      <h3>{t('What went wrong?')}</h3>
      <textarea rows={3} style={{ marginTop: 8 }} value={reason} onChange={(ev) => setReason(ev.target.value)} placeholder={t('e.g. The pump showed 7 gallons, not 12')} />
      <div className="row mt">
        <button disabled={busy || reason.length < 3} onClick={async () => { if (await run(() => e.post(`/api/redemptions/${id}/dispute`, { reason }), t('Dispute sent to the station and distributor'))) onDone(); }}>{t('Send dispute')}</button>
        <button className="ghost" onClick={onCancel}>{t('Cancel')}</button>
      </div>
    </div>
  );
}

function History({ w, reload, online }: { w: any; reload: () => void; online: boolean }) {
  const navigate = useNavigate();
  useEffect(() => { reload(); }, []);
  return (
    <div className="stack">
      <h2>{t('History')}</h2>
      {w.pending.map((p: any) => (
        <div key={p.code} className="card" style={{ padding: 12 }}>
          <div className="row between"><b>{money(p.max, w.currency)} · {cap(p.grade)}</b><span className="badge warn">{t('Not yet synced')}</span></div>
          <div className="small muted">{p.station} · {t('approved {time}', { time: when(p.at) })}</div>
        </div>
      ))}
      {w.history.length === 0 && !w.pending.length && <Empty>{t('No fuelings yet.')}</Empty>}
      {!online && <p className="small muted">{t('Receipts open when you’re back online.')}</p>}
      {w.history.map((r: any) => (
        <div key={r.id} className="card" style={{ padding: 12, cursor: 'pointer' }} onClick={() => navigate(`/employee/receipt/${r.id}`)}>
          <div className="row between"><b>{r.charged_minor != null ? money(r.charged_minor, r.currency) : r.approved_minor != null ? money(r.approved_minor, r.currency) : '—'} · {cap(r.grade)}{r.dispensed_mgal ? ` ${gal(r.dispensed_mgal, 1)} gal` : ''}</b><Status s={r.status} /></div>
          <div className="small muted">{r.station_name} · {t('Pump {n}', { n: r.pump })} · {when(r.completed_at ?? r.created_at)}</div>
        </div>
      ))}
      {w.disputes.length > 0 && <>
        <h3 className="mt">{t('My disputes')}</h3>
        {w.disputes.map((d: any) => (
          <div key={d.id} className="card" style={{ padding: 12 }}>
            <div className="row between"><span className="small">{d.summary}</span><Status s={d.status} /></div>
            {d.resolution && <div className="small muted">{d.resolution}</div>}
          </div>
        ))}
      </>}
    </div>
  );
}
