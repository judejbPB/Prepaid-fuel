import { lang, setLang } from '../i18n';

/** FR | EN switch. `dark` for navy backgrounds. */
export function LangToggle({ dark }: { dark?: boolean }) {
  return (
    <div className={`lang-toggle${dark ? ' dark' : ''}`} role="group" aria-label="Langue / Language">
      <button type="button" className={lang === 'fr' ? 'on' : ''} aria-pressed={lang === 'fr'} onClick={() => lang !== 'fr' && setLang('fr')}>FR</button>
      <button type="button" className={lang === 'en' ? 'on' : ''} aria-pressed={lang === 'en'} onClick={() => lang !== 'en' && setLang('en')}>EN</button>
    </div>
  );
}
