// Documents: Markdown drafts with version history and "approved wording" locks.
// A lock is a passage Sultan approved; Dexter's edits are rejected if they
// would change or drop any locked passage.
import { newId } from '../lib/ids.js';
import { now, parseJson } from '../db.js';
import { badRequest, notFound, HttpError } from '../lib/http.js';
import { markdownToDocx } from '../lib/docx.js';
import { DOCX_MIME } from './files.js';

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function markdownToSimpleHtml(title, md) {
  const lines = md.split('\n');
  const out = [];
  let list = null;
  const inline = (t) => escapeHtml(t)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of lines) {
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) { closeList(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); }
    else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (!line.trim()) closeList();
    else { closeList(); out.push(`<p>${inline(line)}</p>`); }
  }
  closeList();
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.6 Georgia,serif;max-width:720px;margin:48px auto;padding:0 24px;color:#16181d}h1,h2,h3{font-family:system-ui,sans-serif;line-height:1.25}</style>
</head><body><h1>${escapeHtml(title)}</h1>${out.join('\n')}</body></html>`;
}

export function createDocumentService(app) {
  const { db, bus } = app;

  const hydrate = (r) => r && ({ ...r, locked: parseJson(r.locked, []) });

  function get(id) {
    return hydrate(db.get('SELECT * FROM documents WHERE id = ?', id));
  }

  function mustGet(id) {
    const d = get(id);
    if (!d) throw notFound('Document');
    return d;
  }

  function saveVersion(doc, author, note) {
    db.run('INSERT INTO document_versions (id, document_id, version, content, locked, author, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      newId('dver'), doc.id, doc.version, doc.content, JSON.stringify(doc.locked), author, note || null, now());
  }

  function create({ title, content = '', project_id = null, conversation_id = null }, { author = 'user' } = {}) {
    const t = String(title || '').trim();
    if (!t) throw badRequest('Document title is required');
    const doc = { id: newId('doc'), title: t.slice(0, 200), content: String(content), locked: [], version: 1, project_id, conversation_id, created_at: now(), updated_at: now() };
    if (doc.project_id && !db.get('SELECT id FROM projects WHERE id = ?', doc.project_id)) doc.project_id = null;
    if (doc.conversation_id && !db.get('SELECT id FROM conversations WHERE id = ?', doc.conversation_id)) doc.conversation_id = null;
    db.run('INSERT INTO documents (id, title, content, locked, version, project_id, conversation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      doc.id, doc.title, doc.content, '[]', 1, doc.project_id, doc.conversation_id, doc.created_at, doc.updated_at);
    saveVersion(doc, author, 'Created');
    bus.publish('document.updated', { document: get(doc.id) });
    return get(doc.id);
  }

  function missingLocks(doc, content) {
    return doc.locked.filter((l) => !content.includes(l.text));
  }

  function update(id, patch, { author = 'user', note } = {}) {
    const doc = mustGet(id);
    if (patch.expected_version != null && Number(patch.expected_version) !== doc.version) {
      throw new HttpError(409, `Document changed since version ${patch.expected_version} (now v${doc.version}). Reload and try again.`, 'version_conflict');
    }
    let content = patch.content !== undefined ? String(patch.content) : doc.content;
    let locked = doc.locked;
    const missing = missingLocks(doc, content);
    if (missing.length) {
      if (author === 'dexter') {
        throw new HttpError(422, `Edit rejected: it changes approved wording. These locked passages must appear verbatim: ${missing.map((l) => `"${l.text.slice(0, 120)}"`).join('; ')}`, 'locked_text_changed', { missing });
      }
      // Sultan edited approved text himself: release those locks and say so in history.
      locked = locked.filter((l) => !missing.includes(l));
      note = [note, `Released ${missing.length} approved passage(s) edited by you`].filter(Boolean).join(' · ');
    }
    const title = patch.title !== undefined ? String(patch.title).trim().slice(0, 200) : doc.title;
    if (!title) throw badRequest('Document title cannot be empty');
    if (content === doc.content && title === doc.title && locked === doc.locked) return doc;
    const next = { ...doc, title, content, locked, version: doc.version + 1, updated_at: now() };
    db.run('UPDATE documents SET title = ?, content = ?, locked = ?, version = ?, updated_at = ? WHERE id = ?',
      next.title, next.content, JSON.stringify(next.locked), next.version, next.updated_at, id);
    saveVersion(next, author, note);
    const out = get(id);
    bus.publish('document.updated', { document: out });
    return out;
  }

  function lock(id, text) {
    const doc = mustGet(id);
    const t = String(text || '');
    if (t.trim().length < 3) throw badRequest('Select at least a few words to approve');
    if (!doc.content.includes(t)) throw badRequest('That passage is not in the current document');
    if (doc.locked.some((l) => l.text === t)) return doc;
    const locked = [...doc.locked, { id: newId('lock'), text: t, approved_at: now() }];
    db.run('UPDATE documents SET locked = ?, updated_at = ? WHERE id = ?', JSON.stringify(locked), now(), id);
    const out = get(id);
    bus.publish('document.updated', { document: out });
    return out;
  }

  function unlock(id, lockId) {
    const doc = mustGet(id);
    const locked = doc.locked.filter((l) => l.id !== lockId);
    db.run('UPDATE documents SET locked = ?, updated_at = ? WHERE id = ?', JSON.stringify(locked), now(), id);
    const out = get(id);
    bus.publish('document.updated', { document: out });
    return out;
  }

  function list({ project_id } = {}) {
    const rows = project_id
      ? db.all('SELECT id, title, version, project_id, conversation_id, locked, created_at, updated_at, length(content) AS length FROM documents WHERE project_id = ? ORDER BY updated_at DESC', project_id)
      : db.all('SELECT id, title, version, project_id, conversation_id, locked, created_at, updated_at, length(content) AS length FROM documents ORDER BY updated_at DESC');
    return rows.map((r) => ({ ...r, locked: parseJson(r.locked, []).length }));
  }

  function versions(id) {
    mustGet(id);
    return db.all('SELECT id, version, author, note, created_at, length(content) AS length FROM document_versions WHERE document_id = ? ORDER BY version DESC', id);
  }

  function version(id, versionNo) {
    const v = db.get('SELECT * FROM document_versions WHERE document_id = ? AND version = ?', id, versionNo);
    if (!v) throw notFound('Version');
    return { ...v, locked: parseJson(v.locked, []) };
  }

  function remove(id) {
    mustGet(id);
    db.run('DELETE FROM documents WHERE id = ?', id);
    bus.publish('document.deleted', { id });
  }

  function exportDoc(id, format = 'docx') {
    const doc = mustGet(id);
    const base = doc.title.replace(/[^\p{L}\p{N} _.-]+/gu, '').trim() || 'document';
    let buffer; let name; let mime;
    if (format === 'docx') { buffer = markdownToDocx(doc.title, doc.content); name = `${base}.docx`; mime = DOCX_MIME; }
    else if (format === 'md') { buffer = Buffer.from(`# ${doc.title}\n\n${doc.content}\n`, 'utf8'); name = `${base}.md`; mime = 'text/markdown'; }
    else if (format === 'html') { buffer = Buffer.from(markdownToSimpleHtml(doc.title, doc.content), 'utf8'); name = `${base}.html`; mime = 'text/html'; }
    else throw badRequest('format must be docx, md or html');
    return app.files.save({ name, mime, buffer, origin: 'export', project_id: doc.project_id, conversation_id: doc.conversation_id, document_id: doc.id, folder: 'Exports' });
  }

  return { create, update, lock, unlock, get, mustGet, list, versions, version, remove, export: exportDoc };
}
