# BOUSOL Prepaid Fuel Platform

A closed-loop fuel entitlement system that digitizes the corporate fuel voucher program.
Balances are held in **currency (HTG)**; gallons are shown for reference at each company's contract price.
The distributor sells **diesel and gasoline** only. Every gourde stays traceable to the bank deposit that funded it.

```
01 Fund → 02 Activate → 03 Allocate → 04 Redeem → 05 Reconcile
```

| Surface | Path | Who |
|---|---|---|
| Distributor control center | `/distributor` | Treasury, approvers, admin |
| Corporate client portal | `/corporate` | Company preparer and approver |
| Station app (terminal + manager) | `/station` | Attendants on the station's registered device, station managers |
| Employee wallet (mobile web) | `/employee` | Employees, on their own phone |

## Quick start

Requires Node 22+.

```bash
npm install
npm run seed        # resets server/data/bousol.db with sample data
npm run dev         # API on :8787, web on :5173 (proxied)
```

Production-style: `npm run build && npm start` serves the API and the built web app on port 8787.

### Demo logins (password `demo1234`)

| Role | Login |
|---|---|
| Distributor admin / treasury / approver | `admin@bousol`, `treasury@bousol`, `approver@bousol` |
| Company A preparer / approver | `prep@companya`, `approve@companya` |
| Station attendants (need the terminal activated first) | `attendant1@bousol` … `attendant4@bousol` |
| Station managers | `manager1@bousol` … `manager4@bousol` |
| Employees (phone number, PIN `1234`) | `50937000001` (Jean P.), `50937000002` (Marie L.) |

Terminal activation codes: `STATION1` … `STATION4` (single use).

**Try the whole loop:** open `/station`, activate with `STATION2`, sign in as `attendant2@bousol`, open a
shift and create a 12 gal diesel request. In another browser profile open `/employee`, sign in as
`50937000001`, scan the QR (or type the code under it), enter PIN `1234`. Back on the terminal, confirm the
dispensed quantity. Close the shift with pump totals that don't match to see the variance flow through
the station manager to the distributor.

## How it works

### Money model
- Company funding, company pool, employee allocations, refunds, reversals and expirations are all in
  **HTG** (integer minor units).
- Each company has a **contract price per gallon** for diesel and gasoline. At the pump the attendant asks
  for either an **amount** ("2,000 gourdes") or a **quantity** (pump preset in gallons). When the employee
  approves, the price is **locked** and the other figure is derived. The wallet is charged in HTG; gallons
  are recorded on the redemption and receipt for reference and for pump-meter reconciliation.
- A contract price change applies to fuelings approved afterwards. Balances are unaffected.

### Ledger (`server/src/ledger.ts`)
One append-only double-entry journal is the source of truth. Balances are computed from journal lines and
never stored or edited. SQLite triggers reject any update or delete on journal tables; corrections post as
reversing entries.

- Every line carries its **lot** (one cleared bank deposit), and each entry must balance **per lot**, so
  every gourde traces back to the deposit that funded it. Allocation and redemption consume lots FIFO by
  expiry.
- Holding accounts (`unallocated`, `available`, `reserved`, station sales) can never go negative per lot.

| Event | Debit | Credit |
|---|---|---|
| Funding activated | Verified bank funds | Company unallocated |
| Employee allocation | Company unallocated | Employee available |
| Redemption reserved (price locked) | Employee available | Employee reserved |
| Fuel confirmed | Employee reserved | Station fuel sales (+ unused remainder back to available) |
| Reversal approved | Station fuel sales | Employee available |
| Return to company | Employee available | Company unallocated |
| Expiration | Unallocated / employee available | Company expired (breakage) |
| Refund approved | Company unallocated | Refunds payable |
| Refund paid | Refunds payable | Verified bank funds |

**Daily balance rule** (checked on the dashboard and at `GET /api/ledger/check`), per lot:
cleared funds = unallocated + employee available + reserved + redeemed + expired + refunded.

### Controls
- **Maker-checker** wherever money moves: the person who matches a deposit can't activate it;
  batches over the company threshold need a second approver; whoever proposes a reversal or adjustment
  can't approve it.
- **Single-use QR** requests with a 5-minute expiry; a conditional update guarantees only one approval wins.
- **The employee confirms the exact amount, fuel, station and pump** with a PIN before anything is reserved.
  The wallet is only charged when the attendant confirms what was dispensed; any unused remainder is released.
- **PIN lockout** after 5 wrong attempts; **device binding** of each employee wallet to one phone;
  **assisted recovery** (reset PIN, unbind device, temporary password) by the company approver.
- **One terminal per station**, activated with a one-time code; attendants can only sign in on their own
  station's terminal, under a named shift.
- **Freeze** any company, employee, station, terminal or lot.
- **Duplicate phone numbers** in a batch are held for review until an approver releases them.
- **Recurring monthly benefits** pause themselves when the funded balance can't cover the run.
- **Shift close** compares what was charged (HTG) with POS program sales, and recorded gallons with pump
  meters; variance over either tolerance holds the shift → manager explanation → distributor decision.
- **Bank statement import** (CSV): credits whose description carries the funding reference (`TR-xxxx`) and
  the exact amount are matched automatically; others wait in a queue for manual matching or "ignore".
  Bank references can never fund two requests. The importer counts as the matcher, so a different person
  still activates the lot.
- **Refunds** of unallocated funds: company approver requests →
  distributor approver approves (the amount leaves the pool and becomes a payable) → treasury records the
  outgoing transfer (must be a different person from the approver).
- Full **audit log** of every action.

## Project layout

```
server/            Fastify API + SQLite (node:sqlite)
  src/ledger.ts    double-entry journal, FIFO lot picking, balance rule
  src/services/    funding, allocation, redemption (shifts), exceptions, admin, reports
  src/app.ts       HTTP routes and validation
  test/            service-level and HTTP tests (vitest)
web/               React + Vite single-page app for all four surfaces
```

`npm test` runs the server test suite. Configuration (lot validity, QR expiry, variance tolerance, PIN
attempts) lives in `server/src/context.ts`.

## Deploying

```bash
docker build -t bousol-fuel .
docker run -d -p 8787:8787 -v bousol-data:/data \
  -e ADMIN_LOGIN=you@yourco -e ADMIN_PASSWORD='a-long-passphrase' bousol-fuel
```

On first boot with an empty database the server creates the distributor admin from `ADMIN_LOGIN` /
`ADMIN_PASSWORD` (12+ characters). Everything else (companies, prices, stations, terminals, staff) is set up
from the control center. Put it behind HTTPS (e.g. a reverse proxy or your host's TLS) and back up the
`/data` volume. Do **not** run `npm run seed` in production: it wipes the database and loads demo data.

## Not yet built (pilot follow-ups)
- Biometric approval (WebAuthn) alongside PIN; native Android packaging for the station terminal.
- Direct bank API feed (statement import is CSV upload today).
- SMS/WhatsApp notifications, CSV roster import, report exports.
- Production hardening: Postgres, rate limiting, secrets management, monitoring.
