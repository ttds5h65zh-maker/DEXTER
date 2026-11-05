// Approvals, standing grants and user handoffs.
// An approval shows the exact action (tool + full input + a readable preview)
// before anything leaves Dexter. A grant lets Sultan pre-authorise one exact,
// narrowly-scoped kind of action so Dexter does not ask again.
import { newId, hashObject } from '../lib/ids.js';
import { now, parseJson } from '../db.js';
import { badRequest, notFound, conflict } from '../lib/http.js';

export function createApprovalService(app) {
  const { db, bus } = app;

  const hydrate = (a) => a && ({ ...a, preview: parseJson(a.preview, {}), input: parseJson(a.input, {}), provenance: parseJson(a.provenance, []), grant_scope: parseJson(a.grant_scope, null), grantable: Boolean(a.grantable) });

  function get(id) { return hydrate(db.get('SELECT * FROM approvals WHERE id = ?', id)); }
  function mustGet(id) {
    const a = get(id);
    if (!a) throw notFound('Approval');
    return a;
  }

  async function create({ tool_call_id, run_id, conversation_id, task_id, tool, title, summary, preview, input, grant_scope, provenance = [] }) {
    const a = {
      id: newId('apr'), tool_call_id, run_id, conversation_id, task_id: task_id || null, tool, title, summary,
      preview: JSON.stringify(preview || {}), input: JSON.stringify(input), input_hash: hashObject({ tool, input }),
      grantable: grant_scope ? 1 : 0, grant_scope: grant_scope ? JSON.stringify(grant_scope) : null,
      provenance: JSON.stringify(provenance), created_at: now(),
    };
    db.run(`INSERT INTO approvals (id, tool_call_id, run_id, conversation_id, task_id, tool, title, summary, preview, input, input_hash, grantable, grant_scope, provenance, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`, a.id, a.tool_call_id, a.run_id, a.conversation_id, a.task_id, a.tool, a.title, a.summary,
    a.preview, a.input, a.input_hash, a.grantable, a.grant_scope, a.provenance, a.created_at);
    const approval = get(a.id);
    bus.publish('approval.updated', { approval });
    await app.notifications.notify({
      title: `Approval needed: ${title}`, body: summary, level: 'attention', source_type: 'approval', source_id: a.id,
      link: `#/approvals/${a.id}`, dedupe_key: `approval:${a.id}`,
    });
    return approval;
  }

  function list({ status } = {}) {
    const rows = status
      ? db.all(`SELECT * FROM approvals WHERE status IN (${String(status).split(',').map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 200`, ...String(status).split(','))
      : db.all('SELECT * FROM approvals ORDER BY created_at DESC LIMIT 200');
    return rows.map(hydrate);
  }

  function pendingCount() {
    return db.get("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'").n;
  }

  function decide(id, decision, { always_allow = false, note = null } = {}) {
    const a = mustGet(id);
    if (a.status !== 'pending') throw conflict(`This approval is already ${a.status}`, 'already_decided');
    if (!['approve', 'reject'].includes(decision)) throw badRequest('decision must be approve or reject');
    let grantId = null;
    if (decision === 'approve' && always_allow) {
      if (!a.grantable || !a.grant_scope) throw badRequest('This kind of action cannot be pre-authorised; it always needs a fresh approval.');
      grantId = createGrant(a.tool, a.grant_scope).id;
    }
    const status = decision === 'approve' ? 'approved' : 'rejected';
    db.run('UPDATE approvals SET status = ?, decision_note = ?, decided_at = ?, grant_id = ? WHERE id = ?', status, note, now(), grantId, id);
    const approval = get(id);
    bus.publish('approval.updated', { approval });
    if (a.task_id) app.tasks.addEvent(a.task_id, 'approval', `${status === 'approved' ? 'Approved' : 'Rejected'}: ${a.title}${note ? ` — ${note}` : ''}`, { approval_id: id });
    // Continue the paused run (executes the approved action, or reports the rejection to Dexter).
    if (a.run_id) app.agent.resume(a.run_id).catch(() => {});
    return approval;
  }

  function markOutcome(id, { status, result_summary = null, external_ref = null }) {
    db.run('UPDATE approvals SET status = ?, executed_at = ?, result_summary = ?, external_ref = ? WHERE id = ?', status, now(), result_summary, external_ref, id);
    bus.publish('approval.updated', { approval: get(id) });
  }

  function supersedeForRun(runId, reason = 'Superseded by a newer message') {
    const pending = db.all("SELECT id FROM approvals WHERE run_id = ? AND status = 'pending'", runId);
    for (const p of pending) {
      db.run("UPDATE approvals SET status = 'superseded', decision_note = ?, decided_at = ? WHERE id = ?", reason, now(), p.id);
      bus.publish('approval.updated', { approval: get(p.id) });
    }
    return pending.length;
  }

  // ---- grants ---------------------------------------------------------------
  function createGrant(tool, scope) {
    const scopeHash = hashObject({ tool, match: scope.match });
    const existing = db.get('SELECT * FROM grants WHERE tool = ? AND scope_hash = ? AND revoked_at IS NULL', tool, scopeHash);
    if (existing) return existing;
    const g = { id: newId('grant'), tool, scope_hash: scopeHash, scope: JSON.stringify(scope), description: scope.description, created_at: now() };
    db.run('INSERT INTO grants (id, tool, scope_hash, scope, description, created_at) VALUES (?, ?, ?, ?, ?, ?)', g.id, g.tool, g.scope_hash, g.scope, g.description, g.created_at);
    bus.publish('grant.updated', {});
    return g;
  }

  function findGrant(tool, scope) {
    if (!scope) return null;
    const scopeHash = hashObject({ tool, match: scope.match });
    return db.get('SELECT * FROM grants WHERE tool = ? AND scope_hash = ? AND revoked_at IS NULL', tool, scopeHash);
  }

  function useGrant(id) {
    db.run('UPDATE grants SET uses = uses + 1, last_used_at = ? WHERE id = ?', now(), id);
  }

  function listGrants() {
    return db.all('SELECT * FROM grants WHERE revoked_at IS NULL ORDER BY created_at DESC').map((g) => ({ ...g, scope: parseJson(g.scope, {}) }));
  }

  function revokeGrant(id) {
    const g = db.get('SELECT * FROM grants WHERE id = ?', id);
    if (!g) throw notFound('Authorization');
    db.run('UPDATE grants SET revoked_at = ? WHERE id = ?', now(), id);
    bus.publish('grant.updated', {});
  }

  // ---- handoffs (sign-in, MFA, unexpected prompts) -------------------------
  async function createHandoff({ kind, run_id, tool_call_id, title, message, url, screenshot_file_id }) {
    const h = { id: newId('hand'), kind, run_id, tool_call_id, title, message, url: url || null, screenshot_file_id: screenshot_file_id || null, created_at: now() };
    db.run('INSERT INTO handoffs (id, kind, run_id, tool_call_id, title, message, url, screenshot_file_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, \'waiting\', ?)',
      h.id, h.kind, h.run_id, h.tool_call_id, h.title, h.message, h.url, h.screenshot_file_id, h.created_at);
    const handoff = db.get('SELECT * FROM handoffs WHERE id = ?', h.id);
    bus.publish('handoff.updated', { handoff });
    await app.notifications.notify({ title: `Your turn: ${title}`, body: message, level: 'attention', source_type: 'handoff', source_id: h.id, link: '#/today', dedupe_key: `handoff:${h.id}` });
    return handoff;
  }

  function listHandoffs({ status = 'waiting' } = {}) {
    return db.all('SELECT * FROM handoffs WHERE status = ? ORDER BY created_at DESC', status);
  }

  function resolveHandoff(id, outcome = 'resolved') {
    const h = db.get('SELECT * FROM handoffs WHERE id = ?', id);
    if (!h) throw notFound('Handoff');
    if (h.status !== 'waiting') throw conflict(`Handoff already ${h.status}`);
    db.run('UPDATE handoffs SET status = ?, resolved_at = ? WHERE id = ?', outcome, now(), id);
    bus.publish('handoff.updated', { handoff: db.get('SELECT * FROM handoffs WHERE id = ?', id) });
    if (h.run_id) app.agent.resume(h.run_id).catch(() => {});
    return db.get('SELECT * FROM handoffs WHERE id = ?', id);
  }

  return { create, get, mustGet, list, pendingCount, decide, markOutcome, supersedeForRun, createGrant, findGrant, useGrant, listGrants, revokeGrant, createHandoff, listHandoffs, resolveHandoff };
}
