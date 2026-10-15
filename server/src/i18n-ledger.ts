// French for the ledger text the server generates in English: journal memos ("Station 1 pump 3 · 20.00 gal
// diesel @ 665.00") and account labels ("Paul D. · available"). Only these exact templates change; anything
// else (a batch title, an exception note typed by someone) is returned as it is.
import { frenchNumbers, type Lang } from './i18n.js';

const GRADE: Record<string, string> = { diesel: 'diesel', gasoline: 'gazoline' };
const grade = (g: string) => GRADE[g] ?? g;

const MEMO: [RegExp, (...m: string[]) => string][] = [
  [/^(.+) pump (\d+) · (\w+) ≈ ([\d.]+) gal$/, (st, p, g, n) => `${st}, pompe ${p} · ${grade(g)} ≈ ${n} gal`],
  [/^(.+) pump (\d+) · ([\d.]+) gal (\w+) @ ([\d.]+)$/, (st, p, n, g, price) => `${st}, pompe ${p} · ${n} gal de ${grade(g)} à ${price} HTG/gal`],
  [/^(.+) pump (\d+) · offline (\S+) · ([\d.]+) gal (\w+)$/, (st, p, code, n, g) => `${st}, pompe ${p} · vente hors ligne ${code} · ${n} gal de ${grade(g)}`],
  [/^Refund #(\d+): ([\d.]+) (\w+) of (\S+)$/, (id, amt, cur, lot) => `Remboursement n° ${id} : ${amt} ${cur} du lot ${lot}`],
  [/^Refund #(\d+) paid · (.+)$/, (id, ref) => `Remboursement n° ${id} payé · ${ref}`],
  [/^(\S+) expired (\d{4}-\d{2}-\d{2})$/, (lot, d) => `Expiration du lot ${lot} (${d})`],
  [/^Exception #(\d+)$/, (id) => `Exception n° ${id}`],
  [/^Exception #(\d+): (.*)$/, (id, note) => `Exception n° ${id} : ${note}`],
  [/^(\S+) activated as (\S+)$/, (ref, lot) => `Dépôt ${ref} activé : lot ${lot}`],
  [/^Cancelled request (\S+)$/, (code) => `Demande ${code} annulée`],
];

const ACCOUNT: Record<string, string> = {
  unallocated: 'non alloué', available: 'disponible', reserved: 'réservé', 'fuel sales': 'ventes de carburant',
  expired: 'expiré', 'verified bank funds': 'fonds bancaires vérifiés', 'refunds payable': 'remboursements à payer',
};

/** "20.00" → "20,00", "1,330.00" → "1 330,00" inside a translated memo (amounts, gallons, prices). */
const decimals = (s: string) => frenchNumbers(s).replace(/\b(\d+)\.(\d{2})\b/g, '$1,$2');

export function localizeMemo(text: string, lang: Lang): string {
  if (lang === 'en' || typeof text !== 'string') return text;
  for (const [re, fr] of MEMO) {
    const m = text.match(re);
    if (m) return decimals(fr(...m.slice(1)));
  }
  return text;
}

export function localizeAccountLabel(text: string, lang: Lang): string {
  if (lang === 'en' || typeof text !== 'string') return text;
  const m = text.match(/^(.+) · ([a-z ]+)$/);
  if (!m || !(m[2] in ACCOUNT)) return text;
  return `${m[1] === 'Distributor' ? 'Distributeur' : m[1]} · ${ACCOUNT[m[2]]}`;
}

/** Copy of a response payload with `memo` and `account_label` strings translated. */
export function localizeLedgerPayload<T>(payload: T, lang: Lang): T {
  if (lang === 'en') return payload;
  const walk = (v: any, depth: number): any => {
    if (depth > 8 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return v;
    const out: Record<string, any> = {};
    for (const [k, x] of Object.entries(v)) {
      out[k] = typeof x !== 'string' ? walk(x, depth + 1)
        : k === 'memo' ? localizeMemo(x, lang)
        : k === 'account_label' ? localizeAccountLabel(x, lang)
        : x;
    }
    return out;
  };
  return walk(payload, 0);
}
