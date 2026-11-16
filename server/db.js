import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DEXTER_DATA_DIR || 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'dexter.sqlite'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const cache = new Map();
const stmt = (sql) => {
  let s = cache.get(sql);
  if (!s) cache.set(sql, (s = db.prepare(sql)));
  return s;
};
export const all = (sql, ...p) => stmt(sql).all(...p);
export const get = (sql, ...p) => stmt(sql).get(...p);
export const run = (sql, ...p) => stmt(sql).run(...p);
export const insert = (table, row) => {
  const keys = Object.keys(row).filter((k) => row[k] !== undefined);
  const r = run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => row[k]));
  return Number(r.lastInsertRowid);
};

let depth = 0;
/** Run fn inside a transaction (nested calls join the outer one). */
export function tx(fn) {
  if (depth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    depth--;
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','accountant')),
  password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  prefs TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fx_rates (currency TEXT PRIMARY KEY, rate REAL NOT NULL, updated_by INTEGER, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('vehicle','property')),
  name TEXT NOT NULL, details TEXT NOT NULL DEFAULT '{}', archived INTEGER NOT NULL DEFAULT 0,
  is_demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, group_kind TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0, created_by INTEGER, UNIQUE (name, group_kind)
);
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY, type TEXT NOT NULL CHECK (type IN ('bank','card')), name TEXT NOT NULL,
  institution TEXT, last4 TEXT, currency TEXT NOT NULL, is_demo INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY, type TEXT NOT NULL CHECK (type IN ('recurring','schedule','loan')),
  title TEXT NOT NULL, counterparty TEXT, direction TEXT NOT NULL CHECK (direction IN ('out','in')),
  entity_id INTEGER REFERENCES entities(id), category_id INTEGER REFERENCES categories(id),
  currency TEXT NOT NULL, amount INTEGER, frequency TEXT, interval_n INTEGER NOT NULL DEFAULT 1,
  anchor_date TEXT, end_date TEXT, amount_status TEXT NOT NULL DEFAULT 'estimated',
  verified INTEGER NOT NULL DEFAULT 0, principal INTEGER, notes TEXT,
  active INTEGER NOT NULL DEFAULT 1, is_demo INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction IN ('out','in')),
  kind TEXT NOT NULL DEFAULT 'bill',
  title TEXT NOT NULL, counterparty TEXT, reference TEXT,
  entity_id INTEGER REFERENCES entities(id), category_id INTEGER REFERENCES categories(id),
  account_id INTEGER REFERENCES accounts(id),
  plan_id INTEGER REFERENCES plans(id), period_key TEXT,
  amount INTEGER NOT NULL CHECK (amount >= 0), currency TEXT NOT NULL, min_due INTEGER,
  issue_date TEXT, due_date TEXT,
  amount_status TEXT NOT NULL DEFAULT 'confirmed' CHECK (amount_status IN ('confirmed','estimated','needs_review')),
  billed INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL DEFAULT 'manual', notes TEXT,
  voided_at TEXT, is_demo INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (plan_id, period_key)
);
CREATE INDEX IF NOT EXISTS items_due ON items(due_date);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, filename TEXT NOT NULL, mime TEXT NOT NULL,
  size INTEGER NOT NULL, text TEXT NOT NULL DEFAULT '', extract_method TEXT, ocr_confidence REAL,
  uploaded_by INTEGER, created_at TEXT NOT NULL, is_demo INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS document_links (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  UNIQUE (document_id, item_id)
);
CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY, type TEXT NOT NULL CHECK (type IN ('document','sheet','statement')),
  document_id INTEGER REFERENCES documents(id), status TEXT NOT NULL DEFAULT 'review',
  meta TEXT NOT NULL DEFAULT '{}', created_by INTEGER, created_at TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS import_rows (
  id INTEGER PRIMARY KEY, import_id INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL, raw TEXT NOT NULL, parsed TEXT, status TEXT NOT NULL DEFAULT 'pending',
  message TEXT, item_id INTEGER
);
CREATE TABLE IF NOT EXISTS bank_txns (
  id INTEGER PRIMARY KEY, import_id INTEGER REFERENCES imports(id), account_id INTEGER NOT NULL REFERENCES accounts(id),
  date TEXT NOT NULL, description TEXT NOT NULL, reference TEXT, amount INTEGER NOT NULL, currency TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'unmatched', txn_kind TEXT NOT NULL DEFAULT 'normal',
  is_demo INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('payment','refund','credit')),
  amount INTEGER NOT NULL CHECK (amount > 0), date TEXT NOT NULL, method TEXT, note TEXT,
  proof_document_id INTEGER REFERENCES documents(id), bank_txn_id INTEGER REFERENCES bank_txns(id),
  card_account_id INTEGER REFERENCES accounts(id), statement_item_id INTEGER REFERENCES items(id),
  created_by INTEGER, created_at TEXT NOT NULL, voided_at TEXT, voided_by INTEGER
);
CREATE INDEX IF NOT EXISTS payments_item ON payments(item_id);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, user_id INTEGER, entity_type TEXT NOT NULL, entity_id INTEGER,
  action TEXT NOT NULL, field TEXT, old_value TEXT, new_value TEXT, note TEXT
);
CREATE INDEX IF NOT EXISTS audit_entity ON audit_log(entity_type, entity_id);
CREATE TABLE IF NOT EXISTS reminder_state (
  user_id INTEGER NOT NULL, item_id INTEGER NOT NULL, offset_days INTEGER NOT NULL, due_date TEXT NOT NULL,
  dismissed_at TEXT, emailed_at TEXT, PRIMARY KEY (user_id, item_id, offset_days, due_date)
);
CREATE VIEW IF NOT EXISTS item_balances AS
  SELECT i.id AS item_id,
    COALESCE(SUM(CASE WHEN p.type='payment' THEN p.amount WHEN p.type='refund' THEN -p.amount ELSE 0 END), 0) AS paid,
    COALESCE(SUM(CASE WHEN p.type='credit' THEN p.amount ELSE 0 END), 0) AS credited
  FROM items i LEFT JOIN payments p ON p.item_id = i.id AND p.voided_at IS NULL
  GROUP BY i.id;
`);

export const GROUPS = ['household', 'family', 'vehicle', 'property', 'finance', 'business'];
const BUILTIN = {
  household: ['Utilities', 'Internet & phone', 'Household staff salaries', 'Subscriptions', 'Annual renewals', 'Household other'],
  family: ['School fees', 'Family expenses'],
  vehicle: ['Car loan', 'Car insurance', 'Registration', 'Service & repairs', 'Vehicle other'],
  property: ['Rent payable', 'Rent receivable', 'Mortgage', 'Maintenance', 'Contractor bills'],
  finance: ['Loan repayment', 'Credit card statement'],
  business: ['Supplier invoices', 'Contractor payments', 'Recurring business expenses', 'Client invoices', 'Reimbursements'],
};
for (const [group, names] of Object.entries(BUILTIN)) {
  for (const name of names) run('INSERT OR IGNORE INTO categories (name, group_kind, builtin) VALUES (?,?,1)', name, group);
}

const DEFAULTS = { base_currency: 'AED', timezone: 'Asia/Dubai', workspace_name: 'Dexter Payments' };
export function getSettings() {
  const out = { ...DEFAULTS };
  for (const r of all('SELECT key, value FROM settings')) out[r.key] = JSON.parse(r.value);
  return out;
}
export const setSetting = (key, value) =>
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));

export function audit(user, entityType, entityId, action, { field = null, oldValue = null, newValue = null, note = null } = {}) {
  run(
    'INSERT INTO audit_log (at, user_id, entity_type, entity_id, action, field, old_value, new_value, note) VALUES (?,?,?,?,?,?,?,?,?)',
    new Date().toISOString(), user?.id ?? null, entityType, entityId, action, field,
    oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue), note,
  );
}
