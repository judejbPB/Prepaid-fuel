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
| Employees (phone number; choose a PIN on first sign-in) | `50937000001` (Jean P.), `50937000002` (Marie L.) |

Terminal activation codes: `STATION1` … `STATION4` (reusable in the demo so a device stays registered when the demo resets; single use on a real deployment). Each code registers the device for that station, so sign in with the matching attendant (`STATION2` → `attendant2@bousol`).

**Try the whole loop:** open `/station`, activate with `STATION2`, sign in as `attendant2@bousol`, open a
shift and create a 2,000 HTG diesel request. In another browser profile open `/employee`, sign in as
`50937000001` and set up the phone with a PIN (e.g. `1234`). You can now switch that profile offline.
Tap **Pay at pump**, scan the terminal QR, enter the PIN, and scan the phone's approval code with the
terminal (both screens also have "Enter code manually" for testing without cameras). Confirm the sale. Close the shift with pump totals that don't match to see the variance flow through
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

### Paying at the pump: works offline, screenshot-proof
The employee's phone does **not** need a connection at the station. The station terminal stays online.

```
Terminal (online)                                  Employee phone (offline OK)
1. Attendant enters fuel, pump, amount or gallons
2. Shows CHALLENGE QR ──────── phone scans ────►   3. Shows station, pump, amount (≈ gallons at the
   (nonce rotates every 30 s)                         synced contract price). Employee enters PIN.
                                                   4. Shows APPROVAL QR, valid 60 s
5. Scans approval QR ◄──────── terminal scans ───
6. Server verifies, locks the price, reserves the amount → attendant dispenses → confirms the sale
```

The approval code contains an **ECDSA P-256 signature** made with a private key generated on the phone at
enrollment and stored as **non-extractable** (WebCrypto + IndexedDB), plus a **PIN proof**
(`HMAC(PBKDF2(PIN), message)`). It is bound to the request, the current challenge nonce, the maximum amount
shown to the employee and a **counter that never repeats**.

| Fraud attempt | Why it fails |
|---|---|
| Screenshot of an approval code reused later or at another pump | Bound to one request and one challenge; counter already consumed → rejected |
| Photo of the station QR sent to someone elsewhere | Challenge rotates every 30 s (previous one accepted for 30 s more) and the request expires in 3 min |
| Approval code edited to a different amount | Signature no longer verifies |
| Copying the wallet to another phone | Private key can't be exported; only the enrolled phone's key is accepted |
| Stolen phone | No PIN → invalid PIN proof; 5 wrong PINs lock the wallet. The phone stores no PIN verifier, so PINs can't be guessed offline |
| Fake "station" QR showing a lower amount | Server checks the code against the real request; the employee's signed maximum must cover the real amount |
| Remote approval by a colluding employee | Employee must physically present the code to the terminal camera within 60 s; the terminal shows the employee's name; a moving bar on the phone exposes static photos |

Enrollment happens once, online, after the employee signs in (and again after assisted recovery, which
revokes the old key). The app shell is cached by a service worker and the last synced wallet is stored on
the phone, so the app opens and pays with no connection. Approvals made offline show as "not yet synced"
and are subtracted from the displayed balance until the phone reconnects. If a contract price rose after
the phone last synced, the terminal refuses the code and asks the employee to connect once.

### Station terminal offline mode
When the connection drops, the terminal keeps selling. While online it downloads an **offline pack** every
minute: each eligible employee's phone public key, a PIN *verifier* (derived from the PIN key, never the
PIN key itself), their balance at download time, company contract prices and limits. Offline, the terminal:

- shows the same rotating challenge QR and checks the phone's answer locally: ECDSA signature, PIN proof,
  single-use counter, request code and nonce, price, and the employee's signed maximum;
- applies offline limits: **5,000 HTG per employee per terminal** and **100,000 HTG per terminal**, never
  above the employee's balance in the pack; the pack expires after **24 hours**;
- locks an employee locally after 5 wrong PINs and queues each completed sale on the device.

On reconnect, queued sales sync automatically and idempotently (a resend never double-posts). The server
re-verifies everything. Each phone approval counter is accepted once across all terminals, so a code
reused at two stations is rejected. If an employee spent the same balance offline at two stations, the
gap is charged to the company's unallocated funds; anything still uncovered opens an `offline_shortfall`
exception. Sales that fail verification open an `offline_rejected` exception, which a manager acknowledges
with maker-checker. Shift close is blocked until the queue is synced, so reconciliation always includes
offline sales.

### Controls
- **Maker-checker** wherever money moves: the person who matches a deposit can't activate it;
  batches over the company threshold need a second approver; whoever proposes a reversal or adjustment
  can't approve it.
- **Single-use, rotating QR** requests with a 3-minute expiry; a conditional update guarantees only one approval wins.
- **The employee confirms the exact amount, fuel, station and pump** with a PIN before anything is reserved.
  The wallet is only charged when the attendant confirms what was dispensed; any unused remainder is released.
- **PIN lockout** after 5 wrong attempts; **device binding** of each employee wallet to one phone with a
  non-extractable signing key; **assisted recovery** (revoke key, unbind phone, temporary password) by the
  company approver.
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

## Hosted demo (Vercel)
`scripts/build-vercel.mjs` builds the web app plus one serverless function for the API, seeded with demo data.
Serverless instances start and stop on their own, so connect a **Vercel Blob** store to the project
(Storage → Create → Blob, private, connected to this project; it adds `BLOB_READ_WRITE_TOKEN`). The API then
keeps its database there (`server/src/demo-persist.ts`): sign-ins, enrolled phones and sales survive cold
starts, redeploys and requests that reach different instances. Without a store the demo lives in memory
and resets whenever an instance restarts. To start the demo over, delete `demo/bousol-demo.db` from the store.

## Android apps
`mobile/` wraps the web app in two Android apps (Capacitor), built from one project as product flavors:

| App | Package | Opens |
|---|---|---|
| BOUSOL Station | `ht.bousol.station` | `/station` (tablet or phone at the pump) |
| BOUSOL Wallet | `ht.bousol.wallet` | `/employee` |

Both block screenshots, screen recording and the recent-apps preview (`FLAG_SECURE`), ask for the camera
for QR scanning, and keep working offline after the first launch (the web app's service worker). The
GitHub Actions workflow `Android test build` builds both on every change under `mobile/` and publishes
them as the `android-test` pre-release; run it by hand to point the apps at another server (`app_url`).

Test builds are signed with `mobile/android/app/test-builds.keystore`, a public key that exists only so a
new test APK installs over the previous one. Store releases must be signed with a private key
(Play App Signing).

To build locally (Android Studio or the Android SDK required):
```bash
cd mobile && npm ci && npx cap sync android && node scripts/flavor-configs.mjs
cd android && ./gradlew assembleStationDebug assembleWalletDebug
```

## Not yet built (pilot follow-ups)
- Hardware-backed keys (Android Keystore) with biometric unlock alongside the PIN, and a Play Store release.
- Direct bank API feed (statement import is CSV upload today).
- SMS/WhatsApp notifications, CSV roster import, report exports.
- Production hardening: Postgres, rate limiting, secrets management, monitoring.
