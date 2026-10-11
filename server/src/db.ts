import { DatabaseSync } from 'node:sqlite';

// Quantities are stored as integers: gallons in milligallons (mgal), money in minor units (cents).
export const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen')),
  approval_threshold_mgal INTEGER NOT NULL DEFAULT 500000,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  grade TEXT NOT NULL CHECK (grade IN ('diesel','gasoline','premium')),
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
  grade TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  price_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  gallons_mgal INTEGER NOT NULL,
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
  gallons_mgal INTEGER NOT NULL CHECK (gallons_mgal > 0),
  amount_minor INTEGER NOT NULL,
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
  grade TEXT NOT NULL,
  price_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  gallons_mgal INTEGER NOT NULL,
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
  lot_id INTEGER REFERENCES lots(id),
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
  grade TEXT NOT NULL,
  gallons_mgal INTEGER NOT NULL CHECK (gallons_mgal > 0),
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
  grade TEXT NOT NULL,
  requested_mgal INTEGER NOT NULL CHECK (requested_mgal > 0),
  dispensed_mgal INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','completed','cancelled','expired')),
  employee_id INTEGER REFERENCES employees(id),
  company_id INTEGER REFERENCES companies(id),
  reserve_entry_id INTEGER REFERENCES journal_entries(id),
  confirm_entry_id INTEGER REFERENCES journal_entries(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS exceptions (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('shift_variance','dispute','adjustment')),
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
    this.raw.exec('PRAGMA journal_mode = WAL;');
    this.raw.exec(SCHEMA);
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
