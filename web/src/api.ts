export type Surface = 'distributor' | 'corporate' | 'station' | 'employee';

const tokenKey = (s: Surface) => `bousol.token.${s}`;
const TERMINAL_KEY = 'bousol.terminalKey';
const TERMINAL_INFO = 'bousol.terminalInfo';
const DEVICE_KEY = 'bousol.deviceId';

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  del: (k: string) => { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};

export const session = {
  token: (s: Surface) => store.get(tokenKey(s)),
  setToken: (s: Surface, t: string) => store.set(tokenKey(s), t),
  clear: (s: Surface) => store.del(tokenKey(s)),
  terminalKey: () => store.get(TERMINAL_KEY),
  terminalInfo: () => { const v = store.get(TERMINAL_INFO); return v ? JSON.parse(v) : null; },
  setTerminal: (key: string, info: unknown) => { store.set(TERMINAL_KEY, key); store.set(TERMINAL_INFO, JSON.stringify(info)); },
  clearTerminal: () => { store.del(TERMINAL_KEY); store.del(TERMINAL_INFO); },
  deviceId: () => {
    let id = store.get(DEVICE_KEY);
    if (!id) { id = crypto.randomUUID(); store.set(DEVICE_KEY, id); }
    return id;
  },
};

export const SIGNED_OUT_EVENT = 'bousol:signed-out';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export function api(surface: Surface) {
  async function request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'x-device-id': session.deviceId() };
    const token = session.token(surface);
    if (token) headers.authorization = `Bearer ${token}`;
    const tk = session.terminalKey();
    if (surface === 'station' && tk) headers['x-terminal-key'] = tk;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && data.error === 'unauthenticated') {
        session.clear(surface);
        // Let the app show the sign-in screen instead of leaving a screen whose buttons all fail.
        window.dispatchEvent(new CustomEvent(SIGNED_OUT_EVENT, { detail: surface }));
      }
      throw new ApiError(res.status, data.error ?? 'error', data.message ?? res.statusText);
    }
    return data as T;
  }
  return {
    get: <T = any>(path: string) => request<T>('GET', path),
    post: <T = any>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  };
}

// ---- formatting
export const gal = (mgal: number | null | undefined, digits = 0) =>
  `${((mgal ?? 0) / 1000).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: Math.max(digits, 1) })}`;
export const money = (minor: number | null | undefined, currency = 'HTG') =>
  `${((minor ?? 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
export const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
export const when = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const d = new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z'));
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
export const date = (iso: string | null | undefined) =>
  iso ? new Date(iso.slice(0, 10) + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
