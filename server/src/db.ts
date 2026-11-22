import { DatabaseSync } from 'node:sqlite';

// Balances are money in minor units (HTG cents). Gallons are reference only, stored in milligallons (mgal).
export const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen')),
  approval_threshold_minor INTEGER NOT NULL DEFAULT 50000000,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  grade TEXT NOT NULL CHECK (grade IN ('diesel','gasoline')),
  price_minor INTEGER NOT NULL CHECK (price_minor > 0),
  currency TEXT NOT NULL DEFAULT 'HTG',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS contracts_active ON contracts(company_id, grade) WHERE active = 1;

CREATE TABLE IF NOT EXISTS stations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen'))
);

CREATE TABLE IF NOT EXISTS terminals (
  id INTEGER PRIMARY KEY,
  station_id INTEGER NOT NULL REFERENCES stations(id),
  label TEXT NOT NULL UNIQUE,
  activation_code TEXT,
  device_key_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','retired'))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_terminal_per_station ON terminals(station_id) WHERE status != 'retired';

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  login TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN (
    'dist_admin','dist_treasury','dist_approver',
    'co_preparer','co_approver',
    'st_manager','st_attendant',
    'employee')),
  company_id INTEGER REFERENCES companies(id),
  station_id INTEGER REFERENCES stations(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled'))
);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY,
  user_id INTEGER UNIQUE REFERENCES users(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  dept TEXT,
  phone TEXT NOT NULL,
  pin_hash TEXT,
  pin_failures INTEGER NOT NULL DEFAULT 0,
  pin_locked_until TEXT,
  bound_device_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','inactive'))
);

-- The phone that holds an employee's wallet. The private key never leaves the phone; pin_key is
-- PBKDF2(PIN) and lets the server check the PIN proof inside offline approval codes.
CREATE TABLE IF NOT EXISTS employee_devices (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  device_id TEXT NOT NULL,
  public_key_jwk TEXT NOT NULL,
  pin_key TEXT NOT NULL,
  last_counter INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_device ON employee_devices(employee_id) WHERE status = 'active';

-- Every approval-code counter ever accepted, per device key. Offline terminals can sync out of order,
-- so replay protection is "each counter once" rather than "counters only go up".
CREATE TABLE IF NOT EXISTS used_counters (
  device_key_id INTEGER NOT NULL REFERENCES employee_devices(id),
  counter INTEGER NOT NULL,
  redemption_code TEXT NOT NULL,
  used_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (device_key_id, counter)
);

-- One row per sale an offline terminal submits, so re-sending a batch never double-posts.
CREATE TABLE IF NOT EXISTS offline_sync_log (
  client_id TEXT PRIMARY KEY,
  terminal_id INTEGER NOT NULL REFERENCES terminals(id),
  result TEXT NOT NULL,
  redemption_id INTEGER REFERENCES redemptions(id),
  exception_id INTEGER REFERENCES exceptions(id),
  detail TEXT,
  synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  device_id TEXT,
  terminal_id INTEGER REFERENCES terminals(id),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS funding_requests (
  id INTEGER PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'HTG',
  status TEXT NOT NULL DEFAULT 'awaiting_bank'
    CHECK (status IN ('awaiting_bank','matched','approved','rejected')),
  bank_reference TEXT,
  bank_amount_minor INTEGER,
  created_by INTEGER NOT NULL REFERENCES users(id),
  matched_by INTEGER REFERENCES users(id),
  matched_at TEXT,
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  reject_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS funding_bank_ref ON funding_requests(bank_reference) WHERE bank_reference IS NOT NULL;

-- Lines imported from bank statements. Each one can fund at most one request.
CREATE TABLE IF NOT EXISTS bank_transactions (
  id INTEGER PRIMARY KEY,
  bank_reference TEXT NOT NULL UNIQUE,
  value_date TEXT,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'HTG',
  memo TEXT,
  status TEXT NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched','matched','ignored')),
  note TEXT,
  funding_id INTEGER UNIQUE REFERENCES funding_requests(id),
  imported_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Refund of unused prepaid gallons: requested by the company, approved by the distributor,
-- then paid out by treasury (a different person from the approver).
CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  lot_id INTEGER NOT NULL REFERENCES lots(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','paid','rejected')),
  requested_by INTEGER NOT NULL REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  paid_by INTEGER REFERENCES users(id),
  payout_reference TEXT UNIQUE,
  approve_entry_id INTEGER REFERENCES journal_entries(id),
  paid_entry_id INTEGER REFERENCES journal_entries(id),
  reject_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS lots (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  funding_id INTEGER NOT NULL UNIQUE REFERENCES funding_requests(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL,
  expires_on TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','expired')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  ref_type TEXT,
  ref_id INTEGER,
  company_id INTEGER REFERENCES companies(id),
  memo TEXT,
  reverses_entry_id INTEGER REFERENCES journal_entries(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS journal_lines (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
  account TEXT NOT NULL,
  unit TEXT NOT NULL,
  lot_id INTEGER NOT NULL REFERENCES lots(id),
  debit INTEGER NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit INTEGER NOT NULL DEFAULT 0 CHECK (credit >= 0),
  CHECK ((debit = 0) != (credit = 0))
);
CREATE INDEX IF NOT EXISTS journal_lines_account ON journal_lines(account, lot_id);
CREATE INDEX IF NOT EXISTS journal_lines_entry ON journal_lines(entry_id);

-- Journal is append-only: corrections are reversing entries, never edits.
CREATE TRIGGER IF NOT EXISTS journal_lines_no_update BEFORE UPDATE ON journal_lines
BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;
CREATE TRIGGER IF NOT EXISTS journal_lines_no_delete BEFORE DELETE ON journal_lines
BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;
CREATE TRIGGER IF NOT EXISTS journal_entries_no_update BEFORE UPDATE ON journal_entries
BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;
CREATE TRIGGER IF NOT EXISTS journal_entries_no_delete BEFORE DELETE ON journal_entries
BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;

-- Messages from the station or distributor to the employee who raised a dispute.
CREATE TABLE IF NOT EXISTS dispute_messages (
  id INTEGER PRIMARY KEY,
  exception_id INTEGER NOT NULL REFERENCES exceptions(id),
  author_id INTEGER REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A station's own monthly sales (all customers, not only ALFA), entered or imported by the station or the
-- distributor, including history from before ALFA (services/station-performance.ts).
CREATE TABLE IF NOT EXISTS station_actuals (
  id INTEGER PRIMARY KEY,
  station_id INTEGER NOT NULL REFERENCES stations(id),
  month TEXT NOT NULL,
  grade TEXT NOT NULL CHECK (grade IN ('diesel','gasoline')),
  gallons_mgal INTEGER NOT NULL CHECK (gallons_mgal >= 0),
  amount_minor INTEGER CHECK (amount_minor >= 0),
  source TEXT NOT NULL DEFAULT 'entry' CHECK (source IN ('entry','import')),
  entered_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (station_id, month, grade)
);

-- Suspicious fueling alerts for a person to review (services/fuel-alerts.ts). One row per pattern (dedupe_key).
CREATE TABLE IF NOT EXISTS fuel_alerts (
  id INTEGER PRIMARY KEY,
  rule TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('high','medium','low')),
  dedupe_key TEXT NOT NULL UNIQUE,
  company_id INTEGER REFERENCES companies(id),
  station_id INTEGER REFERENCES stations(id),
  employee_id INTEGER REFERENCES employees(id),
  attendant_id INTEGER REFERENCES users(id),
  terminal_id INTEGER REFERENCES terminals(id),
  redemption_ids TEXT NOT NULL DEFAULT '[]',
  facts_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','cleared','confirmed')),
  review_note TEXT,
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sage accounting export: account codes set by finance, and which ledger entries went in which export.
CREATE TABLE IF NOT EXISTS sage_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sage_exports (
  id INTEGER PRIMARY KEY,
  date_from TEXT NOT NULL,
  date_to TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('summary','detail')),
  format TEXT NOT NULL CHECK (format IN ('sage100','csv')),
  entries INTEGER NOT NULL,
  lines INTEGER NOT NULL,
  debit_minor INTEGER NOT NULL,
  filename TEXT NOT NULL,
  file BLOB NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sage_exported_entries (
  entry_id INTEGER PRIMARY KEY REFERENCES journal_entries(id),
  export_id INTEGER NOT NULL REFERENCES sage_exports(id)
);

CREATE TABLE IF NOT EXISTS allocation_batches (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','pending_approval','posted','rejected')),
  recurring_id INTEGER REFERENCES recurring_allocations(id),
  prepared_by INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  entry_id INTEGER REFERENCES journal_entries(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  posted_at TEXT
);

CREATE TABLE IF NOT EXISTS allocation_lines (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES allocation_batches(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','held','posted')),
  hold_reason TEXT
);

CREATE TABLE IF NOT EXISTS recurring_allocations (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL,
  template_json TEXT NOT NULL,
  day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 28),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','cancelled')),
  pause_reason TEXT,
  last_period TEXT,
  source_batch_id INTEGER REFERENCES allocation_batches(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY,
  station_id INTEGER NOT NULL REFERENCES stations(id),
  terminal_id INTEGER NOT NULL REFERENCES terminals(id),
  attendant_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','closed','held','accepted')),
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  digital_json TEXT,
  pump_json TEXT,
  pos_json TEXT,
  variance_mgal INTEGER,
  variance_minor INTEGER,
  manager_note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_shift ON shifts(terminal_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS redemptions (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  station_id INTEGER NOT NULL REFERENCES stations(id),
  terminal_id INTEGER NOT NULL REFERENCES terminals(id),
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  attendant_id INTEGER NOT NULL REFERENCES users(id),
  pump INTEGER NOT NULL,
  grade TEXT NOT NULL CHECK (grade IN ('diesel','gasoline')),
  -- The attendant asks for either a quantity (gallons) or an amount (HTG); the other is derived
  -- at approval from the employee's company contract price, which is then locked.
  requested_mgal INTEGER CHECK (requested_mgal > 0),
  requested_minor INTEGER CHECK (requested_minor > 0),
  price_minor INTEGER,
  currency TEXT,
  approved_minor INTEGER,
  approved_mgal INTEGER,
  dispensed_mgal INTEGER,
  charged_minor INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','completed','cancelled','expired')),
  employee_id INTEGER REFERENCES employees(id),
  company_id INTEGER REFERENCES companies(id),
  -- Rotating challenge shown in the terminal QR; the previous nonce stays valid for a short grace period.
  challenge_nonce TEXT NOT NULL,
  prev_nonce TEXT,
  nonce_at TEXT NOT NULL DEFAULT (datetime('now')),
  device_key_id INTEGER REFERENCES employee_devices(id),
  -- Set for sales a terminal approved while offline and synced later.
  offline INTEGER NOT NULL DEFAULT 0,
  client_id TEXT UNIQUE,
  reserve_entry_id INTEGER REFERENCES journal_entries(id),
  confirm_entry_id INTEGER REFERENCES journal_entries(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS exceptions (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('shift_variance','dispute','adjustment','offline_shortfall','offline_rejected')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','proposed','resolved','rejected')),
  ref_type TEXT NOT NULL,
  ref_id INTEGER NOT NULL,
  company_id INTEGER REFERENCES companies(id),
  station_id INTEGER REFERENCES stations(id),
  summary TEXT NOT NULL,
  detail TEXT,
  proposal_json TEXT,
  proposed_by INTEGER REFERENCES users(id),
  resolved_by INTEGER REFERENCES users(id),
  resolution TEXT,
  entry_id INTEGER REFERENCES journal_entries(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  actor_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  data_json TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

type Param = string | number | bigint | null | Uint8Array;

export class Db {
  readonly raw: DatabaseSync;
  private depth = 0;

  constructor(path = ':memory:') {
    this.raw = new DatabaseSync(path);
    // WAL lets reads continue during a write. synchronous = FULL syncs every commit to disk, so a power cut
    // cannot lose a fueling or a deposit that was already confirmed. busy_timeout waits for a backup or the
    // replication process instead of failing straight away.
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
    this.raw.exec(SCHEMA);
  }

  /** Writes the WAL back into the main file and closes the database (on shutdown). */
  close() {
    try { this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* in-memory or already closed */ }
    this.raw.close();
  }

  all<T = any>(sql: string, ...params: Param[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  get<T = any>(sql: string, ...params: Param[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: Param[]): { id: number; changes: number } {
    const r = this.raw.prepare(sql).run(...params);
    return { id: Number(r.lastInsertRowid), changes: Number(r.changes) };
  }

  /** Runs fn atomically. Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    } finally {
      this.depth--;
    }
  }

  audit(actorId: number | null, action: string, entity: string, entityId: number | null, data?: unknown) {
    this.run(
      'INSERT INTO audit_log (actor_id, action, entity, entity_id, data_json) VALUES (?,?,?,?,?)',
      actorId, action, entity, entityId, data === undefined ? null : JSON.stringify(data),
    );
  }
}
