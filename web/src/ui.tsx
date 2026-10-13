import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { api, ApiError, session, type Surface } from './api';

// ---------------------------------------------------------------- data hooks

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = [], pollMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(async () => {
    try {
      setData(await fnRef.current());
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);
  useEffect(() => {
    reload();
    if (!pollMs) return;
    const t = setInterval(reload, pollMs);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, reload };
}

// ---------------------------------------------------------------- toast

const ToastCtx = createContext<{ ok: (m: string) => void; err: (e: unknown) => void }>({ ok: () => {}, err: () => {} });
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<{ text: string; err: boolean } | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 4000);
    return () => clearTimeout(t);
  }, [msg]);
  const value = {
    ok: (text: string) => setMsg({ text, err: false }),
    err: (e: unknown) => setMsg({ text: e instanceof Error ? e.message : String(e), err: true }),
  };
  return (
    <ToastCtx.Provider value={value}>
      {children}
      {msg && <div className={`toast ${msg.err ? 'err' : ''}`} role="status">{msg.text}</div>}
    </ToastCtx.Provider>
  );
}

/** Wraps an async action with toast feedback and a busy flag. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const out = await fn();
      if (success) toast.ok(success);
      return out;
    } catch (e) {
      toast.err(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

// ---------------------------------------------------------------- building blocks

export const Kpi = ({ label, value, sub, bad }: { label: string; value: ReactNode; sub?: ReactNode; bad?: boolean }) => (
  <div className="card kpi">
    <div className="label">{label}</div>
    <div className={`value num ${bad ? 'bad' : ''}`}>{value}</div>
    {sub && <div className="sub">{sub}</div>}
  </div>
);

const STATUS: Record<string, [string, string]> = {
  awaiting_bank: ['warn', 'Awaiting bank'],
  matched: ['ok', 'Matched'],
  approved: ['ok', 'Approved'],
  rejected: ['bad', 'Rejected'],
  draft: ['info', 'Draft'],
  pending_approval: ['warn', 'Needs approver'],
  posted: ['ok', 'Posted'],
  ready: ['ok', 'Ready'],
  held: ['warn', 'Held for review'],
  open: ['warn', 'Open'],
  proposed: ['info', 'Awaiting decision'],
  resolved: ['ok', 'Resolved'],
  closed: ['ok', 'Closed'],
  accepted: ['ok', 'Accepted'],
  pending: ['warn', 'Waiting for employee'],
  completed: ['ok', 'Redeemed'],
  cancelled: ['', 'Cancelled'],
  expired: ['', 'Expired'],
  active: ['ok', 'Active'],
  paused: ['warn', 'Paused'],
  frozen: ['bad', 'Frozen'],
  inactive: ['', 'Inactive'],
};
export const Status = ({ s }: { s: string }) => {
  const [cls, label] = STATUS[s] ?? ['', s];
  return <span className={`badge ${cls}`}>{label}</span>;
};

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="row between"><h2>{title}</h2><button className="ghost" onClick={onClose} aria-label="Close">✕</button></div>
        {children}
      </div>
    </div>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <p className="muted small" style={{ padding: '8px 0' }}>{children}</p>;

// ---------------------------------------------------------------- auth

export interface Me {
  userId: number;
  name: string;
  role: string;
  companyId: number | null;
  stationId: number | null;
  employeeId: number | null;
  terminalId: number | null;
  company: { id: number; name: string; status: string } | null;
  station: { id: number; name: string; status: string } | null;
}

const MeCtx = createContext<Me | null>(null);
export const useMe = () => useContext(MeCtx)!;

const SURFACE_ROLES: Record<Surface, string[]> = {
  distributor: ['dist_admin', 'dist_treasury', 'dist_approver'],
  corporate: ['co_preparer', 'co_approver'],
  station: ['st_attendant', 'st_manager'],
  employee: ['employee'],
};

const meKey = (s: Surface) => `bousol.me.${s}`;
const readMe = (s: Surface): Me | null => { try { return JSON.parse(localStorage.getItem(meKey(s)) ?? 'null'); } catch { return null; } };
const writeMe = (s: Surface, m: Me | null) => { try { m ? localStorage.setItem(meKey(s), JSON.stringify(m)) : localStorage.removeItem(meKey(s)); } catch { /* ignore */ } };

/**
 * Requires a signed-in user of the surface. With `offlineOk`, a network failure falls back to the
 * last signed-in profile so the app keeps working without a connection (the session is re-checked
 * when the network returns).
 */
export function Authed({ surface, children, loginExtra, offlineOk }: { surface: Surface; children: ReactNode; loginExtra?: ReactNode; offlineOk?: boolean }) {
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);
  const load = useCallback(async () => {
    if (!session.token(surface)) { setMe(null); setChecked(true); return; }
    try {
      const m = await api(surface).get<Me>('/api/me');
      if (!SURFACE_ROLES[surface].includes(m.role)) { session.clear(surface); setMe(null); }
      else { setMe(m); if (offlineOk) writeMe(surface, m); }
    } catch (err) {
      const offline = !(err instanceof ApiError);
      if (offlineOk && offline && readMe(surface)) setMe(readMe(surface));
      else { setMe(null); if (offlineOk) writeMe(surface, null); }
    }
    setChecked(true);
  }, [surface, offlineOk]);
  useEffect(() => { load(); }, [load]);
  if (!checked) return null;
  if (!me) return <Login surface={surface} onDone={load} extra={loginExtra} />;
  return <MeCtx.Provider value={me}>{children}</MeCtx.Provider>;
}

const SURFACE_TITLE: Record<Surface, string> = {
  distributor: 'Distributor control center',
  corporate: 'Corporate client portal',
  station: 'Station app',
  employee: 'Employee fuel wallet',
};

function Login({ surface, onDone, extra }: { surface: Surface; onDone: () => void; extra?: ReactNode }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const { busy, run } = useAction();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await run(() => api(surface).post('/api/auth/login', { login, password }));
    if (!res) return;
    if (!SURFACE_ROLES[surface].includes(res.actor.role)) {
      alert(`That account can’t use the ${SURFACE_TITLE[surface]}.`);
      return;
    }
    session.setToken(surface, res.token);
    onDone();
  };
  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="eyebrow">BOUSOL · Prepaid fuel</div>
        <h1>{SURFACE_TITLE[surface]}</h1>
        {extra}
        <label>{surface === 'employee' ? 'Phone number' : 'Login'}
          <input value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" required
            inputMode={surface === 'employee' ? 'tel' : undefined} />
        </label>
        <label>Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        <button disabled={busy}>Sign in</button>
        <a href="/" className="small muted">← All apps</a>
      </form>
    </div>
  );
}

export function useLogout(surface: Surface) {
  const navigate = useNavigate();
  return async () => {
    try { await api(surface).post('/api/auth/logout'); } catch { /* already signed out */ }
    session.clear(surface);
    navigate('/');
  };
}

const ROLE_LABEL: Record<string, string> = {
  dist_admin: 'Administrator', dist_treasury: 'Treasury', dist_approver: 'Approver',
  co_preparer: 'Preparer', co_approver: 'Approver', st_manager: 'Station manager', st_attendant: 'Attendant', employee: 'Employee',
};
export const roleLabel = (r: string) => ROLE_LABEL[r] ?? r;

export function Shell({ surface, nav, children }: { surface: Surface; nav: [string, string][]; children: ReactNode }) {
  const me = useMe();
  const logout = useLogout(surface);
  return (
    <div className="shell">
      <nav className="side">
        <div className="brand">BOUSOL</div>
        <div className="surface">{SURFACE_TITLE[surface]}</div>
        {nav.map(([to, label]) => <NavLink key={to} to={to} end>{label}</NavLink>)}
        <div className="spacer" />
        <div className="who">
          <b>{me.name}</b>
          {roleLabel(me.role)}{me.company ? ` · ${me.company.name}` : ''}{me.station ? ` · ${me.station.name}` : ''}
          <div><button className="ghost sm" style={{ color: '#f0a332', paddingLeft: 0 }} onClick={logout}>Sign out</button></div>
        </div>
      </nav>
      <main className="main">{children}</main>
    </div>
  );
}

export const PageHead = ({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) => (
  <div className="page-head">
    <div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1></div>
    {children && <div className="row">{children}</div>}
  </div>
);
