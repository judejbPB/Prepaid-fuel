import { BrandLogo } from '../ui';
import { Link } from 'react-router-dom';
import { t } from '../i18n';
import { LangToggle } from '../i18n/LangToggle';

const STEPS = [
  [t('Fund'), t('Company pays the distributor by bank transfer with a unique reference.')],
  [t('Activate'), t('Treasury matches cleared funds; a second approver activates the fuel lot.')],
  [t('Allocate'), t('Company assigns HTG balances to employees. Value moves, it is never created.')],
  [t('Redeem'), t('Employee confirms amount, fuel and station by QR with PIN. Diesel or gasoline.')],
  [t('Reconcile'), t('Station closes its shift; redemptions are checked against pumps, POS and ledger.')],
];

const SURFACES = [
  ['/distributor', t('Distributor control center'), t('Verify deposits, activate lots, freeze, approve reversals, read the ledger.'), 'admin@bousol · treasury@bousol · approver@bousol'],
  ['/corporate', t('Corporate client portal'), t('Fund the account, manage the roster, allocate HTG with maker-checker.'), 'prep@companya · approve@companya'],
  ['/station', t('Station app'), t('One registered terminal per station: shifts, QR requests, dispense, shift close.'), t('Activate with {code} · {logins}', { code: 'STATION1–4', logins: 'attendant1–4@bousol · manager1–4@bousol' })],
  ['/employee', t('Employee app'), t('See your HTG balance, scan the station QR, approve with your PIN, get a receipt.'), '50937000001 (PIN 1234) · 50937000002'],
];

export default function Home() {
  return (
    <div className="landing dark">
      <div className="inner">
        <div className="row between"><BrandLogo large /><LangToggle dark /></div>
        <div className="eyebrow" style={{ marginTop: 20 }}>{t('ALFA · Prepaid fuel platform · powered by BOUSOL')}</div>
        <h1>{t('Prepaid Fuel Platform')}</h1>
        <p className="lede">
          {t('A closed-loop fuel entitlement system that digitizes the voucher program. Every gourde stays traceable to cleared funds; gallons are shown at the contract price for reference.')}
        </p>
        <div className="steps">
          {STEPS.map(([title, text], i) => (
            <div className="step" key={title}>
              <div className="n">0{i + 1}</div>
              <h3>{title}</h3>
              <p>{text}</p>
            </div>
          ))}
        </div>
        <div className="surfaces">
          {SURFACES.map(([to, title, text, logins]) => (
            <Link to={to} className="surface-card" key={to}>
              <h2>{title}</h2>
              <p className="muted small">{text}</p>
              <div className="logins">{t('Demo: {logins}', { logins })}<br />{t('Password: {pw}', { pw: 'demo1234' })}</div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
