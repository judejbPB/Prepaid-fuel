# Security

What protects ALFA today, what is still open, and the scope for the external penetration test. Keep this
file up to date with every security change.

## In place

**Money controls** (by design, see README): maker-checker on deposits, large allocations, exceptions and
refunds; append-only double-entry ledger with daily balance checks; audit trail; freezes at every level.

**Sign-in**
- Passwords stored with scrypt (random salt per password).
- An account is locked for 15 minutes after 5 wrong passwords in 15 minutes. A network address is locked
  after 30 failures (many accounts guessed from one place). Locks survive restarts (`auth_throttle`).
- An unknown login answers exactly like a wrong password, in about the same time (no account discovery).
- Failed sign-ins and locks are written to the audit log (`login.failed`, `login.locked`) with the address.
- Staff passwords: at least 10 characters, not a common password, not containing the login.
  Employees keep 8 characters (they also have a PIN and a phone bound to their wallet).
- Everyone can change their password (current one required); every other session is then signed out.

**Sessions**
- Random 192-bit tokens, stored only as SHA-256 hashes. 12-hour maximum.
- Back-office sessions (distributor, company, station manager) end after 60 minutes without activity.
  Station terminals and wallets are exempt: a shift runs all day, and the wallet asks for the PIN at every payment.
- Expired sessions are deleted hourly.

**Devices**
- Station terminals: one per station, activated with a one-time code that expires after 7 days; guessing
  codes is throttled per address (10 tries, then 30 minutes). The device key is stored hashed.
- Wallets: bound to one phone; payments signed by a non-extractable key on the phone plus PIN proof;
  5 wrong PINs lock the wallet; replayed approval codes are refused. Android builds block screenshots and backups.

**Web**
- Content Security Policy: only this site's scripts (no inline scripts, no `eval`), no framing, no plugins;
  images only from this site and the OpenStreetMap tiles; fonts from Google Fonts.
- `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` (camera and
  location for this site only), `Cross-Origin-Opener-Policy`. HSTS from Caddy in production and on Vercel.
  The list lives in `server/src/security-headers.json`, shared by the server and the Vercel build.
- API responses are `Cache-Control: no-store`.
- Every request body is validated (zod) with size limits on every list; bodies are capped at 1 MB (4 MB for
  statement uploads).
- A test (`server/test/security.test.ts`) calls every API route without signing in and fails if any answers
  anything but 401, so a new route cannot ship unprotected by mistake.

**AI**: never moves money or decides anything; no employee names or phone numbers are sent; read-only reports
within each user's scope.

**Hosting** (deploy/): HTTPS only, app not exposed directly, continuous off-site database copy, monthly
restore drill, refuses to start with demo accounts.

## Still open (in order)

1. **Two-step sign-in for distributor staff** (admin, treasury, approver): a code from an authenticator app
   at sign-in. They can activate lots and approve refunds, so a stolen password matters most there.
2. **Staff account management**: an admin screen to disable a staff account and reset a forgotten password
   (today it needs database access). Disabling must sign the account out everywhere.
3. **Zod 4 upgrade**: `npm audit` reports a memory-exhaustion issue in zod 3 for oversized collections
   (GHSA-mrhx-c7xc-m3w5). Mitigated by the 1 MB body limit and the size limits on every list; the upgrade
   changes validation messages, which the French translations depend on, so it is its own change.
4. **Alerts on attacks**: notify the distributor admin when an account is locked or many sign-ins fail.
5. **Backups encrypted with our own key** (Litestream `age` encryption) in addition to the storage provider's.
6. **External penetration test** (below), then fix what it finds before real money.

## Penetration test scope (for the tester)

- Target: the production setup (`deploy/`) on a staging server with demo data, plus the two Android apps.
- Accounts: one of each role (distributor admin, treasury, approver; company preparer, approver; station
  manager, attendant on an activated terminal; employee wallet on a phone).
- Focus:
  - moving or creating money without the second approver;
  - reading or changing another company's or station's data;
  - paying at the pump without a valid wallet approval, or replaying one;
  - offline sync tampering;
  - bypassing the sign-in lock or the idle sign-out;
  - statement upload parsing (Excel, CSV, PDF);
  - the AI features (prompt injection through uploaded statements or dispute text);
  - Android app storage and screenshots.
- Out of scope: denial of service against the provider, social engineering of Bandari staff.
- Report security issues privately to the BOUSOL team, not in public issues.
