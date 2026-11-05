// Conversations and messages. Messages keep the exact API content blocks so
// history can be replayed byte-for-byte; display items are derived from them.
import { newId } from '../lib/ids.js';
import { now, parseJson } from '../db.js';
import { badRequest, notFound } from '../lib/http.js';
import { oneLine } from '../lib/text.js';

export function displayItemsFromContent(content) {
  const items = [];
  for (const b of content || []) {
    if (b.type === 'text') {
      if (!b.text) continue;
      const citations = [];
      for (const c of b.citations || []) {
        if (c.url && !citations.some((x) => x.url === c.url)) citations.push({ url: c.url, title: c.title || c.url });
      }
      items.push({ type: 'text', text: b.text, citations });
    } else if (b.type === 'thinking') {
      if (b.thinking && b.thinking.trim()) items.push({ type: 'progress', text: b.thinking.trim() });
    } else if (b.type === 'tool_use') {
      items.push({ type: 'tool', id: b.id, name: b.name });
    } else if (b.type === 'server_tool_use') {
      items.push({ type: 'server_tool', id: b.id, name: b.name, input: b.input || {} });
    } else if (b.type === 'web_search_tool_result') {
      const results = Array.isArray(b.content)
        ? b.content.filter((r) => r.type === 'web_search_result').map((r) => ({ title: r.title, url: r.url, page_age: r.page_age || null }))
        : null;
      items.push({ type: 'search_results', tool_use_id: b.tool_use_id, results, error: results ? null : (b.content?.error_code || 'search_error') });
    } else if (b.type === 'web_fetch_tool_result') {
      const doc = b.content?.content;
      items.push({ type: 'fetch_result', tool_use_id: b.tool_use_id, url: b.content?.url || null, title: doc?.title || null, error: b.content?.error_code || null });
    } else if (b.type === 'fallback') {
      items.push({ type: 'notice', text: `${b.from?.model || 'The model'} declined this request; ${b.to?.model || 'a fallback model'} continued.` });
    }
  }
  return items;
}

export function createConversationService(app) {
  const { db, bus } = app;

  function get(id) { return db.get('SELECT * FROM conversations WHERE id = ?', id); }
  function mustGet(id) {
    const c = get(id);
    if (!c) throw notFound('Conversation');
    return c;
  }

  function create({ title, project_id = null, kind = 'chat' } = {}) {
    if (project_id && !db.get('SELECT id FROM projects WHERE id = ?', project_id)) throw badRequest('Unknown project');
    const c = { id: newId('conv'), title: (title && String(title).trim().slice(0, 120)) || 'New conversation', project_id, kind, created_at: now(), updated_at: now() };
    db.run('INSERT INTO conversations (id, title, project_id, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', c.id, c.title, c.project_id, c.kind, c.created_at, c.updated_at);
    bus.publish('conversation.updated', { conversation: get(c.id) });
    return get(c.id);
  }

  function list({ q, project_id, include_archived = false, kind } = {}) {
    const where = []; const p = [];
    if (!include_archived) where.push('c.archived = 0');
    if (project_id) { where.push('c.project_id = ?'); p.push(project_id); }
    if (kind) { where.push('c.kind = ?'); p.push(kind); }
    if (q) { where.push('c.title LIKE ?'); p.push(`%${q}%`); }
    return db.all(`SELECT c.*,
      (SELECT status FROM runs r WHERE r.conversation_id = c.id ORDER BY r.started_at DESC LIMIT 1) AS last_run_status,
      (SELECT meta FROM messages m WHERE m.conversation_id = c.id AND m.kind = 'user' ORDER BY m.seq DESC LIMIT 1) AS last_user_meta
      FROM conversations c ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.updated_at DESC LIMIT 200`, ...p)
      .map(({ last_user_meta, ...c }) => ({ ...c, preview: oneLine(parseJson(last_user_meta, {}).text || '', 90) }));
  }

  function update(id, patch) {
    mustGet(id);
    const fields = {};
    if (patch.title !== undefined) fields.title = String(patch.title).trim().slice(0, 120) || 'Untitled';
    if (patch.archived !== undefined) fields.archived = patch.archived ? 1 : 0;
    if (patch.project_id !== undefined) fields.project_id = patch.project_id || null;
    if (!Object.keys(fields).length) return get(id);
    fields.updated_at = now();
    const keys = Object.keys(fields);
    db.run(`UPDATE conversations SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => fields[k]), id);
    bus.publish('conversation.updated', { conversation: get(id) });
    return get(id);
  }

  function touch(id) {
    db.run('UPDATE conversations SET updated_at = ? WHERE id = ?', now(), id);
  }

  function remove(id) {
    mustGet(id);
    db.run('DELETE FROM conversations WHERE id = ?', id);
    bus.publish('conversation.deleted', { id });
  }

  function appendMessage(conversationId, { role, kind, content = [], partial = null, excluded = 0, status = 'complete', run_id = null, attachments = [], meta = {} }) {
    return db.tx(() => {
      const seq = (db.get('SELECT MAX(seq) AS s FROM messages WHERE conversation_id = ?', conversationId).s ?? 0) + 1;
      const m = { id: newId('msg'), conversation_id: conversationId, seq, role, kind, content: JSON.stringify(content), partial: partial ? JSON.stringify(partial) : null,
        excluded: excluded ? 1 : 0, status, run_id, attachments: JSON.stringify(attachments), meta: JSON.stringify(meta), created_at: now() };
      db.run(`INSERT INTO messages (id, conversation_id, seq, role, kind, content, partial, excluded, status, run_id, attachments, meta, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, m.id, m.conversation_id, m.seq, m.role, m.kind, m.content, m.partial, m.excluded, m.status, m.run_id, m.attachments, m.meta, m.created_at);
      touch(conversationId);
      return getMessage(m.id);
    });
  }

  function getMessage(id) {
    const m = db.get('SELECT * FROM messages WHERE id = ?', id);
    if (!m) return null;
    return { ...m, content: parseJson(m.content, []), partial: parseJson(m.partial, null), attachments: parseJson(m.attachments, []), meta: parseJson(m.meta, {}), excluded: Boolean(m.excluded) };
  }

  function updateMessage(id, fields) {
    const sets = []; const p = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      p.push(['content', 'partial', 'attachments', 'meta'].includes(k) ? (v == null ? null : JSON.stringify(v)) : k === 'excluded' ? (v ? 1 : 0) : v);
    }
    db.run(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`, ...p, id);
    return getMessage(id);
  }

  function messages(conversationId) {
    return db.all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq', conversationId).map((m) => ({
      ...m, content: parseJson(m.content, []), partial: parseJson(m.partial, null), attachments: parseJson(m.attachments, []), meta: parseJson(m.meta, {}), excluded: Boolean(m.excluded),
    }));
  }

  /** History exactly as it will be sent to the model. */
  function apiMessages(conversationId) {
    return messages(conversationId)
      .filter((m) => !m.excluded && Array.isArray(m.content) && m.content.length)
      .map((m) => ({ role: m.role, content: m.content, _kind: m.kind, _id: m.id }));
  }

  function toDisplay(m, fileMap) {
    const base = { id: m.id, seq: m.seq, role: m.role, kind: m.kind, status: m.status, run_id: m.run_id, created_at: m.created_at };
    if (m.kind === 'user') {
      return { ...base, text: m.meta.text || '', synthetic: m.meta.synthetic || null, command: m.meta.command || null, attachments: m.attachments.map((fid) => fileMap.get(fid) || { id: fid, name: 'Deleted file', missing: true }) };
    }
    if (m.kind === 'assistant') {
      const items = m.status === 'streaming' || m.status === 'interrupted' || m.status === 'cancelled' || (!m.content.length && m.partial)
        ? (m.partial || []) : displayItemsFromContent(m.content);
      return { ...base, items, meta: m.meta };
    }
    if (m.kind === 'command' || m.kind === 'notice') return { ...base, text: m.meta.text || '', meta: m.meta };
    return null; // tool_results and context messages are internal
  }

  function view(id) {
    const conversation = mustGet(id);
    const msgs = messages(id);
    const fileIds = [...new Set(msgs.flatMap((m) => m.attachments))];
    const fileMap = new Map();
    for (const fid of fileIds) {
      const f = db.get('SELECT id, name, mime, size FROM files WHERE id = ?', fid);
      if (f) fileMap.set(fid, f);
    }
    const display = msgs.map((m) => toDisplay(m, fileMap)).filter(Boolean);
    const toolCalls = db.all('SELECT id, run_id, message_id, name, input, risk, status, approval_id, handoff_id, summary, external_ref, error, is_error, started_at, finished_at FROM tool_calls WHERE conversation_id = ? ORDER BY created_at', id)
      .map((t) => ({ ...t, input: parseJson(t.input, {}), is_error: Boolean(t.is_error) }));
    const runs = db.all('SELECT id, status, trigger, error, task_id, model, started_at, finished_at FROM runs WHERE conversation_id = ? ORDER BY started_at DESC LIMIT 20', id);
    const approvals = db.all("SELECT id, tool_call_id, title, summary, status, created_at FROM approvals WHERE conversation_id = ? ORDER BY created_at", id);
    const handoffs = db.all("SELECT h.id, h.tool_call_id, h.title, h.message, h.status, h.url FROM handoffs h JOIN runs r ON r.id = h.run_id WHERE r.conversation_id = ? ORDER BY h.created_at", id);
    const project = conversation.project_id ? db.get('SELECT id, name, code FROM projects WHERE id = ?', conversation.project_id) : null;
    return { conversation, project, messages: display, tool_calls: toolCalls, runs, approvals, handoffs, active_run: runs.find((r) => ['running', 'awaiting_approval', 'blocked'].includes(r.status)) || null };
  }

  return { create, list, get, mustGet, update, remove, touch, appendMessage, getMessage, updateMessage, messages, apiMessages, view };
}
