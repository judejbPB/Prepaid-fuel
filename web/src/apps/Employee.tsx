import jsQR from 'jsqr';
import { useEffect, useRef, useState } from 'react';
import { NavLink, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api, cap, date, gal, when } from '../api';
import { Authed, Empty, Status, useAction, useLoad, useLogout } from '../ui';

const e = api('employee');

export default function Employee() {
  return (
    <Authed surface="employee">
      <Wallet />
    </Authed>
  );
}

function Wallet() {
  const { data, reload } = useLoad(() => e.get('/api/wallet'), [], 15000);
  if (!data) return <div className="phone-bg"><div className="phone" /></div>;
  if (!data.employee.has_pin) return <Phone><SetPin onDone={reload} /></Phone>;
  return (
    <Phone tabs>
      <Routes>
        <Route index element={<Balance w={data} />} />
        <Route path="scan" element={<Scan />} />
        <Route path="approve/:code" element={<Approve onDone={reload} />} />
        <Route path="receipt/:id" element={<Receipt />} />
        <Route path="history" element={<History w={data} reload={reload} />} />
      </Routes>
    </Phone>
  );
}

function Phone({ children, tabs }: { children: React.ReactNode; tabs?: boolean }) {
  return (
    <div className="phone-bg">
      <div className="phone">
        {children}
        {tabs && (
          <nav className="tabbar">
            <NavLink to="/employee" end>My fuel</NavLink>
            <NavLink to="/employee/scan">Scan QR</NavLink>
            <NavLink to="/employee/history">History</NavLink>
          </nav>
        )}
      </div>
    </div>
  );
}

function Balance({ w }: { w: any }) {
  const navigate = useNavigate();
  const logout = useLogout('employee');
  const grades = Array.from(new Set(['diesel', 'gasoline', 'premium', ...Object.keys(w.by_grade)]));
  const frozen = w.employee.status !== 'active' || w.employee.company_status !== 'active';
  return (
    <div className="stack">
      <div className="row between"><h2>My fuel</h2><button className="ghost sm" onClick={logout}>Sign out</button></div>
      <p className="muted" style={{ marginTop: -8 }}>{w.employee.name} · {w.employee.company_name}</p>
      {frozen && <div className="banner bad">Your fuel wallet is frozen. Contact your company admin.</div>}
      <div className="balance-card">
        <div className="sub">Available</div>
        <div className="big num">{gal(w.available_mgal, 1)} gal</div>
        <div className="sub">All grades{w.next_expiry ? ` · earliest expiry ${date(w.next_expiry)}` : ''}</div>
      </div>
      <div>
        {grades.map((g) => {
          const inProgram = w.program_grades.includes(g) || w.by_grade[g];
          return inProgram ? (
            <div className="kv" key={g}><span>{cap(g)}</span><b className="num">{gal(w.by_grade[g] ?? 0, 1)} gal</b></div>
          ) : (
            <div className="kv" key={g} style={{ border: '1.5px dashed var(--line)', borderRadius: 8, padding: '8px 10px', marginTop: 6 }}>
              <span className="muted">{cap(g)}</span><span className="muted">Not in program</span>
            </div>
          );
        })}
      </div>
      {w.reserved_mgal > 0 && <div className="banner">{gal(w.reserved_mgal, 1)} gal reserved for a fueling in progress.</div>}
      <button className="block" disabled={frozen} onClick={() => navigate('/employee/scan')}>Scan station QR</button>
      {w.lots.length > 0 && (
        <details className="small">
          <summary className="muted">Where my gallons come from</summary>
          {w.lots.map((l: any) => (
            <div className="kv" key={l.code}><span className="mono">{l.code} · {cap(l.grade)}</span><span>{gal(l.balance, 1)} gal · exp. {date(l.expires_on)}</span></div>
          ))}
        </details>
      )}
    </div>
  );
}

function SetPin({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const { busy, run } = useAction();
  return (
    <div className="stack">
      <h2>Set your PIN</h2>
      <p className="small muted">You’ll confirm every fueling with this PIN. This phone becomes your wallet device.</p>
      <label>Account password<input type="password" value={password} onChange={(ev) => setPassword(ev.target.value)} /></label>
      <label>New PIN (4–6 digits)<input type="password" inputMode="numeric" maxLength={6} value={pin} onChange={(ev) => setPin(ev.target.value.replace(/\D/g, ''))} /></label>
      <label>Repeat PIN<input type="password" inputMode="numeric" maxLength={6} value={pin2} onChange={(ev) => setPin2(ev.target.value.replace(/\D/g, ''))} /></label>
      <button className="block" disabled={busy || pin.length < 4 || pin !== pin2 || !password}
        onClick={async () => { if (await run(() => e.post('/api/wallet/pin', { password, pin }), 'PIN set')) onDone(); }}>Save PIN</button>
    </div>
  );
}

function Scan() {
  const navigate = useNavigate();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [camError, setCamError] = useState<string | null>(null);
  const [manual, setManual] = useState('');

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const tick = () => {
      const v = videoRef.current;
      if (v && v.readyState === v.HAVE_ENOUGH_DATA && ctx) {
        canvas.width = v.videoWidth;
        canvas.height = v.videoHeight;
        ctx.drawImage(v, 0, 0);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const found = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (found?.data) {
          navigate(`/employee/approve/${encodeURIComponent(found.data)}`);
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'environment' } })
      .then((s) => {
        stream = s;
        if (videoRef.current) { videoRef.current.srcObject = s; videoRef.current.play(); }
        raf = requestAnimationFrame(tick);
      })
      .catch(() => setCamError('Camera unavailable. Type the code shown under the QR instead.'));
    if (!navigator.mediaDevices) setCamError('Camera unavailable. Type the code shown under the QR instead.');
    return () => { cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); };
  }, [navigate]);

  return (
    <div className="stack">
      <h2>Scan station QR</h2>
      <p className="small muted">The attendant creates a one-time request on the station terminal. Point your camera at its QR.</p>
      {!camError && <div className="scanner"><video ref={videoRef} playsInline muted /></div>}
      {camError && <div className="banner">{camError}</div>}
      <label>Or enter the code<input value={manual} onChange={(ev) => setManual(ev.target.value.toUpperCase())} placeholder="10-character code" autoCapitalize="characters" /></label>
      <button className="secondary" disabled={manual.length < 6} onClick={() => navigate(`/employee/approve/${encodeURIComponent(manual)}`)}>Continue</button>
    </div>
  );
}

function Approve({ onDone }: { onDone: () => void }) {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const { data, error } = useLoad(() => e.post('/api/wallet/preview', { code }), [code]);
  const [pin, setPin] = useState('');
  const { busy, run } = useAction();
  const press = (k: string) => setPin((p) => (k === '⌫' ? p.slice(0, -1) : p.length < 6 ? p + k : p));
  const confirm = async () => {
    const r = await run(() => e.post('/api/wallet/approve', { code, pin }));
    setPin('');
    if (r) { onDone(); navigate(`/employee/receipt/${r.id}`, { replace: true }); }
  };
  if (error) return <div className="stack"><h2>Approve fueling</h2><div className="banner bad">{error}</div><button className="secondary" onClick={() => navigate('/employee/scan')}>Scan again</button></div>;
  if (!data) return null;
  const short = data.available_mgal < data.requested_mgal;
  return (
    <div className="stack">
      <h2>Approve fueling</h2>
      <div>
        <div className="kv"><span className="muted">Station</span><b>{data.station_name}</b></div>
        <div className="kv"><span className="muted">Pump</span><b>{data.pump}</b></div>
        <div className="kv"><span className="muted">Fuel</span><b>{cap(data.grade)}</b></div>
      </div>
      <div><div className="muted">Quantity</div><div style={{ fontSize: 40, fontWeight: 700 }} className="num">{gal(data.requested_mgal, 1)} gal</div>
        <div className="small muted">You have {gal(data.available_mgal, 1)} gal {data.grade} available</div></div>
      {short ? <div className="banner bad">Not enough {data.grade} gallons for this request.</div> : <>
        <div className="muted">Confirm with PIN</div>
        <div className="pin-dots">{[0, 1, 2, 3].map((i) => <span key={i} className={pin.length > i ? 'on' : ''} />)}</div>
        <div className="keypad">{['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((k) => k ? <button key={k} onClick={() => press(k)}>{k}</button> : <span key="blank" />)}</div>
        <button className="block" disabled={busy || pin.length < 4} onClick={confirm}>Confirm</button>
      </>}
      <button className="ghost" onClick={() => navigate('/employee')}>Not me / cancel</button>
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
      {done ? <div className="check">✓</div> : <div className="check" style={{ background: 'var(--amber)', color: 'var(--navy)' }}>…</div>}
      <h2>{done ? 'Redeemed' : r.status === 'approved' ? 'Approved — attendant is dispensing' : cap(r.status)}</h2>
      <div style={{ fontSize: 22, fontWeight: 600 }}>{gal(done ? r.dispensed_mgal : r.requested_mgal, 1)} gal {cap(r.grade)}</div>
      <div className="muted">{r.station_name} · Pump {r.pump}</div>
      <div className="kv" style={{ textAlign: 'left' }}><span>New balance</span><b>{gal(wallet.data?.available_mgal, 1)} gal</b></div>
      {done && r.dispensed_mgal < r.requested_mgal && <p className="small muted">{gal(r.requested_mgal - r.dispensed_mgal, 1)} gal not dispensed was returned to your balance.</p>}
      {done && <button className="secondary block" onClick={() => setDisputing(true)}>Raise a dispute</button>}
      {r.status === 'approved' && <button className="ghost" onClick={async () => { try { await e.post(`/api/redemptions/${r.id}/cancel`); red.reload(); } catch (err: any) { alert(err.message); } }}>Cancel before fueling</button>}
      <button className="ghost" onClick={() => navigate('/employee')}>Back to my fuel</button>
      {disputing && <DisputeForm id={r.id} onDone={() => { setDisputing(false); navigate('/employee/history'); }} onCancel={() => setDisputing(false)} />}
    </div>
  );
}

function DisputeForm({ id, onDone, onCancel }: { id: number; onDone: () => void; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  const { busy, run } = useAction();
  return (
    <div className="card" style={{ textAlign: 'left' }}>
      <h3>What went wrong?</h3>
      <textarea rows={3} style={{ marginTop: 8 }} value={reason} onChange={(ev) => setReason(ev.target.value)} placeholder="e.g. The pump showed 7 gallons, not 12" />
      <div className="row mt">
        <button disabled={busy || reason.length < 3} onClick={async () => { if (await run(() => e.post(`/api/redemptions/${id}/dispute`, { reason }), 'Dispute sent to the station and distributor')) onDone(); }}>Send dispute</button>
        <button className="ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function History({ w, reload }: { w: any; reload: () => void }) {
  const navigate = useNavigate();
  useEffect(() => { reload(); }, []);
  return (
    <div className="stack">
      <h2>History</h2>
      {w.history.length === 0 && <Empty>No fuelings yet.</Empty>}
      {w.history.map((r: any) => (
        <div key={r.id} className="card" style={{ padding: 12, cursor: 'pointer' }} onClick={() => navigate(`/employee/receipt/${r.id}`)}>
          <div className="row between"><b>{gal(r.dispensed_mgal ?? r.requested_mgal, 1)} gal {cap(r.grade)}</b><Status s={r.status} /></div>
          <div className="small muted">{r.station_name} · Pump {r.pump} · {when(r.completed_at ?? r.created_at)}</div>
        </div>
      ))}
      {w.disputes.length > 0 && <>
        <h3 className="mt">My disputes</h3>
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
