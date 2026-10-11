# BOUSOL Prepaid Fuel Platform

A closed-loop fuel entitlement system that digitizes the corporate fuel voucher program.
Every gallon stays traceable to cleared funds and a contract price.

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

### Ledger (`server/src/ledger.ts`)
One append-only double-entry journal is the source of truth. Balances are computed from journal lines and
never stored or edited. SQLite triggers reject any update or delete on journal tables; corrections post as
reversing entries.

- Gallons are integers in **milligallons**; money is in **minor units** (HTG cents).
- Every gallon line carries its **fuel lot**, so each gallon traces back to a bank deposit and the
  contract price it was funded at. Allocation and redemption consume lots FIFO by expiry.
- Holding accounts (`unallocated`, `available`, `reserved`, `clearing`) can never go negative per lot.

| Event | Debit | Credit |
|---|---|---|
| Funding activated | Verified bank funds · Company issued gallons | Corporate prepaid liability · Company unallocated |
| Employee allocation | Company unallocated | Employee available |
| Redemption reserved | Employee available | Employee reserved |
| Fuel confirmed | Employee reserved · Prepaid liability | Station clearing · Fuel revenue |
| Reversal approved | Station clearing · Fuel revenue | Employee available · Prepaid liability |
| Expiration | Unallocated / employee available · Prepaid liability | Company expired · Breakage |

**Daily balance rule** (checked on the dashboard and at `GET /api/ledger/check`):
funded gallons = unallocated + employee available + reserved + redeemed + expired/refunded/adjusted.

### Controls
- **Maker-checker** wherever money or gallons move: the person who matches a deposit can't activate it;
  batches over the company threshold need a second approver; whoever proposes a reversal or adjustment
  can't approve it.
- **Single-use QR** requests with a 5-minute expiry; a conditional update guarantees only one approval wins.
- **The employee confirms exact quantity, station and pump** with a PIN before anything is reserved. Fuel
  only counts as redeemed when the attendant confirms the dispensed amount; any undispensed remainder is
  released.
- **PIN lockout** after 5 wrong attempts; **device binding** of each employee wallet to one phone;
  **assisted recovery** (reset PIN, unbind device, temporary password) by the company approver.
- **One terminal per station**, activated with a one-time code; attendants can only sign in on their own
  station's terminal, under a named shift.
- **Freeze** any company, employee, station, terminal or lot.
- **Duplicate phone numbers** in a batch are held for review until an approver releases them.
- **Recurring monthly benefits** pause themselves when the funded balance can't cover the run.
- **Shift close** compares digital redemptions with pump totals and POS; variance over tolerance holds the
  shift → manager explanation → distributor decision.
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

## Not yet built (pilot follow-ups)
- Biometric approval (WebAuthn) alongside PIN; native Android packaging for the station terminal.
- Bank statement import / API for automatic deposit matching (matching is manual today).
- Refund flow for unused prepaid funds (the ledger account exists; no workflow yet).
- SMS/WhatsApp notifications, CSV roster import, report exports.
- Production hardening: Postgres, rate limiting, HTTPS, secrets management, backups, monitoring.
