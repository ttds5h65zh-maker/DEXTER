// SQLite persistence via Node's built-in node:sqlite. Migrations are ordered
// and recorded in schema_migrations so upgrades never lose data.
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = [
  {
    id: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);

CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'course',
  code TEXT, term TEXT, instructor TEXT, credits REAL, description TEXT, requirements TEXT,
  archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE grade_items (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, weight REAL NOT NULL DEFAULT 0, score REAL, max_score REAL NOT NULL DEFAULT 100,
  due_at TEXT, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'New conversation', project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'chat', archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '[]',        -- exact API content blocks (replayed verbatim)
  partial TEXT,                               -- display-only text while streaming / if interrupted
  excluded INTEGER NOT NULL DEFAULT 0,        -- 1 = not sent to the model (interrupted, declined, local command)
  status TEXT NOT NULL DEFAULT 'complete',    -- streaming | complete | interrupted | declined | cancelled
  run_id TEXT, attachments TEXT NOT NULL DEFAULT '[]', meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, UNIQUE (conversation_id, seq));
CREATE INDEX idx_messages_conv ON messages(conversation_id, seq);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
  status TEXT NOT NULL DEFAULT 'planned',     -- planned | running | blocked | awaiting_approval | completed | failed | cancelled
  priority TEXT NOT NULL DEFAULT 'normal', due_at TEXT, due_has_time INTEGER NOT NULL DEFAULT 1,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  source_message_id TEXT, origin TEXT NOT NULL DEFAULT 'user',
  blocked_reason TEXT, outcome TEXT, outcome_data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT);
CREATE INDEX idx_tasks_status ON tasks(status, due_at);

CREATE TABLE task_events (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL, message TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
CREATE INDEX idx_task_events_task ON task_events(task_id, created_at);

CREATE TABLE runs (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL, job_run_id TEXT,
  status TEXT NOT NULL,                       -- running | awaiting_approval | blocked | completed | failed | interrupted | cancelled
  trigger TEXT NOT NULL DEFAULT 'chat', model TEXT, error TEXT, untrusted_sources TEXT NOT NULL DEFAULT '[]',
  usage TEXT NOT NULL DEFAULT '{}', steps INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT);
CREATE INDEX idx_runs_conv ON runs(conversation_id, started_at);

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,                        -- tool_use id from the model
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL, input TEXT NOT NULL,
  input_hash TEXT NOT NULL, risk TEXT NOT NULL,
  status TEXT NOT NULL,                       -- pending | awaiting_approval | waiting_user | running | succeeded | failed | declined | unknown
  approval_id TEXT, handoff_id TEXT, result TEXT, is_error INTEGER NOT NULL DEFAULT 0, summary TEXT,
  external_ref TEXT, error TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
CREATE INDEX idx_tool_calls_run ON tool_calls(run_id, position);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY, tool_call_id TEXT, run_id TEXT, conversation_id TEXT, task_id TEXT,
  tool TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, preview TEXT NOT NULL, input TEXT NOT NULL,
  input_hash TEXT NOT NULL, grantable INTEGER NOT NULL DEFAULT 0, grant_scope TEXT,
  provenance TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',     -- pending | approved | rejected | superseded | executed | failed | unknown
  decision_note TEXT, decided_at TEXT, executed_at TEXT, result_summary TEXT, external_ref TEXT, grant_id TEXT,
  created_at TEXT NOT NULL);
CREATE INDEX idx_approvals_status ON approvals(status, created_at);

CREATE TABLE grants (
  id TEXT PRIMARY KEY, tool TEXT NOT NULL, scope_hash TEXT NOT NULL, scope TEXT NOT NULL, description TEXT NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0, last_used_at TEXT, created_at TEXT NOT NULL, revoked_at TEXT);
CREATE INDEX idx_grants_tool ON grants(tool, scope_hash);

CREATE TABLE handoffs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, run_id TEXT, tool_call_id TEXT, title TEXT NOT NULL, message TEXT NOT NULL,
  url TEXT, screenshot_file_id TEXT, status TEXT NOT NULL DEFAULT 'waiting', created_at TEXT NOT NULL, resolved_at TEXT);

CREATE TABLE memories (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'fact', content TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'manual', source_id TEXT, source_label TEXT,
  pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE VIRTUAL TABLE memories_fts USING fts5(content, id UNINDEXED);
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN INSERT INTO memories_fts(content, id) VALUES (new.content, new.id); END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN DELETE FROM memories_fts WHERE id = old.id; END;
CREATE TRIGGER memories_au AFTER UPDATE OF content ON memories BEGIN DELETE FROM memories_fts WHERE id = old.id; INSERT INTO memories_fts(content, id) VALUES (new.content, new.id); END;

CREATE TABLE files (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
  storage_name TEXT NOT NULL, folder TEXT NOT NULL DEFAULT '', origin TEXT NOT NULL DEFAULT 'upload',
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  document_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE documents (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', locked TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE document_versions (
  id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, version INTEGER NOT NULL,
  content TEXT NOT NULL, locked TEXT NOT NULL, author TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL,
  UNIQUE(document_id, version));

CREATE TABLE jobs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,   -- reminder | briefing | monitor | agent
  schedule TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',      -- active | paused | cancelled | completed
  system_key TEXT UNIQUE, next_run_at TEXT, last_run_at TEXT, last_status TEXT, max_attempts INTEGER NOT NULL DEFAULT 3,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL, conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL DEFAULT 'user', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX idx_jobs_due ON jobs(status, next_run_at);

CREATE TABLE job_runs (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL,                       -- queued | running | retrying | succeeded | failed | cancelled | skipped
  attempt INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, lease_until TEXT, error TEXT, result TEXT,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
  UNIQUE (job_id, scheduled_for));
CREATE INDEX idx_job_runs_status ON job_runs(status, next_attempt_at);

CREATE TABLE monitor_seen (job_id TEXT NOT NULL, key TEXT NOT NULL, first_seen_at TEXT NOT NULL, PRIMARY KEY (job_id, key));

CREATE TABLE notifications (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT, level TEXT NOT NULL DEFAULT 'info',
  source_type TEXT, source_id TEXT, link TEXT, dedupe_key TEXT UNIQUE, delivery TEXT NOT NULL DEFAULT '{}',
  read_at TEXT, created_at TEXT NOT NULL);
CREATE INDEX idx_notifications_created ON notifications(created_at);
`,
  },
];

export function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return wrap(db);
}

// Small convenience layer: JSON columns, transactions and common queries.
function wrap(db) {
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = db.prepare(sql); cache.set(sql, s); }
    return s;
  };
  let depth = 0;
  return {
    raw: db,
    all: (sql, ...p) => stmt(sql).all(...p).map(plain),
    get: (sql, ...p) => { const r = stmt(sql).get(...p); return r ? plain(r) : null; },
    run: (sql, ...p) => stmt(sql).run(...p),
    exec: (sql) => db.exec(sql),
    tx(fn) {
      if (depth > 0) return fn();
      depth++;
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        depth--;
      }
    },
    close: () => db.close(),
  };
}

function plain(row) {
  return { ...row };
}

export const now = () => new Date().toISOString();

export function parseJson(text, fallback) {
  if (text == null || text === '') return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}
