import { Link } from 'react-router-dom';

const STEPS = [
  ['Fund', 'Company pays the distributor by bank transfer with a unique reference.'],
  ['Activate', 'Treasury matches cleared funds; a second approver activates the fuel lot.'],
  ['Allocate', 'Company assigns gallons to employees. Value moves, it is never created.'],
  ['Redeem', 'Employee confirms quantity and station by QR with PIN.'],
  ['Reconcile', 'Station closes its shift; redemptions are checked against pumps, POS and ledger.'],
];

const SURFACES = [
  ['/distributor', 'Distributor control center', 'Verify deposits, activate lots, freeze, approve reversals, read the ledger.', 'admin@bousol · treasury@bousol · approver@bousol'],
  ['/corporate', 'Corporate client portal', 'Fund the account, manage the roster, allocate gallons with maker-checker.', 'prep@companya · approve@companya'],
  ['/station', 'Station app', 'One registered terminal per station: shifts, QR requests, dispense, shift close.', 'Activate with STATION1–4 · attendant1–4@bousol · manager1–4@bousol'],
  ['/employee', 'Employee app', 'See your gallons, scan the station QR, approve with your PIN, get a receipt.', '50937000001 (PIN 1234) · 50937000002'],
];

export default function Home() {
  return (
    <div className="landing dark">
      <div className="inner">
        <div className="eyebrow">BOUSOL · Prepaid fuel platform</div>
        <h1>Prepaid Fuel Platform</h1>
        <p className="lede">
          A closed-loop fuel entitlement system that digitizes the voucher program. Every gallon stays traceable to
          cleared funds and a contract price.
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
              <div className="logins">Demo: {logins}<br />Password: demo1234</div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
