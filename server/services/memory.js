// Memory: durable preferences and project context, each with a source and
// timestamps so Sultan can see where it came from and when it last changed.
import { newId } from '../lib/ids.js';
import { now } from '../db.js';
import { badRequest, notFound } from '../lib/http.js';
import { formatHuman } from '../lib/time.js';

export const MEMORY_KINDS = ['preference', 'project', 'fact', 'person', 'course'];

const SECRET_PATTERNS = [/sk-ant-/i, /password\s*[:=]/i, /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/, /api[_ -]?key\s*[:=]/i];

export function createMemoryService(app) {
  const { db, bus } = app;

  function get(id) {
    const row = db.get('SELECT * FROM memories WHERE id = ?', id);
    return row ? { ...row, pinned: Boolean(row.pinned) } : null;
  }

  function mustGet(id) {
    const m = get(id);
    if (!m) throw notFound('Memory');
    return m;
  }

  function checkContent(content) {
    const c = String(content || '').trim();
    if (!c) throw badRequest('Memory content is required');
    if (c.length > 2000) throw badRequest('Keep a memory under 2000 characters');
    if (SECRET_PATTERNS.some((re) => re.test(c))) throw badRequest('That looks like a secret (password, key or card number). Dexter does not store secrets in memory.');
    return c;
  }

  function create({ content, kind = 'fact', pinned = false, source_type = 'manual', source_id = null, source_label = null }) {
    const c = checkContent(content);
    if (!MEMORY_KINDS.includes(kind)) throw badRequest(`kind must be one of ${MEMORY_KINDS.join(', ')}`);
    const dup = db.get('SELECT id FROM memories WHERE lower(content) = lower(?)', c);
    if (dup) return { ...get(dup.id), duplicate: true };
    const m = { id: newId('mem'), kind, content: c, source_type, source_id, source_label, pinned: pinned ? 1 : 0, created_at: now(), updated_at: now() };
    db.run('INSERT INTO memories (id, kind, content, source_type, source_id, source_label, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      m.id, m.kind, m.content, m.source_type, m.source_id, m.source_label, m.pinned, m.created_at, m.updated_at);
    const out = get(m.id);
    bus.publish('memory.updated', { memory: out });
    return out;
  }

  function update(id, patch, { source_type, source_id, source_label } = {}) {
    const before = mustGet(id);
    const fields = {};
    if (patch.content !== undefined) fields.content = checkContent(patch.content);
    if (patch.kind !== undefined) {
      if (!MEMORY_KINDS.includes(patch.kind)) throw badRequest(`kind must be one of ${MEMORY_KINDS.join(', ')}`);
      fields.kind = patch.kind;
    }
    if (patch.pinned !== undefined) fields.pinned = patch.pinned ? 1 : 0;
    if (source_type) { fields.source_type = source_type; fields.source_id = source_id || null; fields.source_label = source_label || null; }
    if (!Object.keys(fields).length) return before;
    fields.updated_at = now();
    const keys = Object.keys(fields);
    db.run(`UPDATE memories SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => fields[k]), id);
    const out = get(id);
    bus.publish('memory.updated', { memory: out });
    return out;
  }

  function remove(id) {
    mustGet(id);
    db.run('DELETE FROM memories WHERE id = ?', id);
    bus.publish('memory.deleted', { id });
  }

  function list({ q, kind, limit = 500 } = {}) {
    if (q && q.trim()) return search(q, { kind, limit });
    const params = [];
    let where = '';
    if (kind) { where = 'WHERE kind = ?'; params.push(kind); }
    return db.all(`SELECT * FROM memories ${where} ORDER BY pinned DESC, updated_at DESC LIMIT ?`, ...params, limit)
      .map((r) => ({ ...r, pinned: Boolean(r.pinned) }));
  }

  function search(q, { kind, limit = 20 } = {}) {
    const terms = String(q).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [];
    if (!terms.length) return [];
    const match = terms.slice(0, 12).map((t) => `"${t.replace(/"/g, '')}"*`).join(' OR ');
    const rows = db.all(`SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.id WHERE memories_fts MATCH ? ${kind ? 'AND m.kind = ?' : ''}
      ORDER BY bm25(memories_fts) LIMIT ?`, ...(kind ? [match, kind, limit] : [match, limit]));
    return rows.map((r) => ({ ...r, pinned: Boolean(r.pinned) }));
  }

  /** Memories to put in front of the model for a given user message. */
  function relevant(text, max = 25) {
    const total = db.get('SELECT COUNT(*) AS n FROM memories').n;
    if (total <= max) return list({ limit: max });
    const pinned = db.all('SELECT * FROM memories WHERE pinned = 1 ORDER BY updated_at DESC LIMIT ?', max);
    const seen = new Set(pinned.map((m) => m.id));
    const out = [...pinned];
    for (const m of search(text || '', { limit: max })) {
      if (out.length >= max) break;
      if (!seen.has(m.id)) { out.push(m); seen.add(m.id); }
    }
    if (out.length < max) {
      for (const m of db.all('SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?', max)) {
        if (out.length >= max) break;
        if (!seen.has(m.id)) { out.push(m); seen.add(m.id); }
      }
    }
    return out.map((r) => ({ ...r, pinned: Boolean(r.pinned) }));
  }

  function brief(m, tz) {
    return `[${m.id}] (${m.kind}${m.pinned ? ', pinned' : ''}, updated ${formatHuman(m.updated_at, tz, { withWeekday: false })}) ${m.content}`;
  }

  return { create, update, remove, get, mustGet, list, search, relevant, brief };
}
