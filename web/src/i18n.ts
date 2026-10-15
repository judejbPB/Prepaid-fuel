// French first, English as an option. UI strings are written in English in the code and wrapped in t();
// the French text lives in i18n/fr/*.ts, keyed by the English string. A missing translation shows English.
import { FR } from './i18n/fr';

export type Lang = 'fr' | 'en';
const LANG_KEY = 'bousol.lang';

function readLang(): Lang {
  try { return localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'fr'; } catch { return 'fr'; }
}

/** Fixed for the life of the page: switching language reloads, so every screen re-renders in the new one. */
export const lang: Lang = readLang();
/** Number and date formatting locale for the current language. */
export const locale = lang === 'fr' ? 'fr-FR' : 'en-US';
if (typeof document !== 'undefined') document.documentElement.lang = lang;

/**
 * Translate an English UI string. Use only string literals as the first argument (a test checks every
 * literal has a French entry). Placeholders like {name} are filled from `vars` in both languages.
 */
export function t(en: string, vars?: Record<string, string | number>): string {
  const text = lang === 'fr' ? (FR[en] ?? en) : en;
  return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text;
}

export function setLang(next: Lang) {
  try { localStorage.setItem(LANG_KEY, next); } catch { /* storage unavailable */ }
  location.reload();
}
