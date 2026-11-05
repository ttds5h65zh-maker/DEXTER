// Tasks: persistent units of work with an event timeline and a recorded outcome.
import { newId } from '../lib/ids.js';
import { now, parseJson } from '../db.js';
import { badRequest, notFound } from '../lib/http.js';
import { parseDateTimeInput, formatHuman } from '../lib/time.js';

export const TASK_STATUSES = ['planned', 'running', 'blocked', 'awaiting_approval', 'completed', 'failed', 'cancelled'];
export const OPEN_STATUSES = ['planned', 'running', 'blocked', 'awaiting_approval'];
const PRIORITIES = ['low', 'normal', 'high'];

export function createTaskService(app) {
  const { db, bus } = app;
  const tz = () => app.settings.timezone();

  function hydrate(row) {
    if (!row) return null;
    return { ...row, due_has_time: Boolean(row.due_has_time), outcome_data: parseJson(row.outcome_data, {}) };
  }

  function parseDue(due) {
    if (due === undefined) return undefined;
    if (due === null || due === '') return { due_at: null, due_has_time: 1 };
    const parsed = parseDateTimeInput(due, tz(), { defaultTime: '23:59' });
    if (!parsed) throw badRequest(`Could not understand the due date "${due}". Use ISO 8601 like 2026-11-10T17:00:00+04:00 or "tomorrow 5pm".`);
    return { due_at: parsed.date.toISOString(), due_has_time: parsed.hasTime ? 1 : 0 };
  }

  function addEvent(taskId, type, message, data = {}) {
    const ev = { id: newId('tev'), task_id: taskId, type, message, data: JSON.stringify(data), created_at: now() };
    db.run('INSERT INTO task_events (id, task_id, type, message, data, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ev.id, ev.task_id, ev.type, ev.message, ev.data, ev.created_at);
    bus.publish('task.event', { task_id: taskId, event: { ...ev, data } });
    return ev;
  }

  function get(id) {
    return hydrate(db.get('SELECT * FROM tasks WHERE id = ?', id));
  }

  function mustGet(id) {
    const t = get(id);
    if (!t) throw notFound('Task');
    return t;
  }

  function create(input, { actor = 'user' } = {}) {
    const title = String(input.title || '').trim();
    if (!title) throw badRequest('Task title is required');
    if (input.priority && !PRIORITIES.includes(input.priority)) throw badRequest('priority must be low, normal or high');
    const due = parseDue(input.due ?? input.due_at) || { due_at: null, due_has_time: 1 };
    const status = input.status && TASK_STATUSES.includes(input.status) ? input.status : 'planned';
    const t = {
      id: newId('task'), title: title.slice(0, 300), description: input.description ? String(input.description) : null,
      status, priority: input.priority || 'normal', due_at: due.due_at, due_has_time: due.due_has_time,
      project_id: input.project_id || null, conversation_id: input.conversation_id || null,
      source_message_id: input.source_message_id || null, origin: input.origin || actor,
      created_at: now(), updated_at: now(),
    };
    if (t.project_id && !db.get('SELECT id FROM projects WHERE id = ?', t.project_id)) throw badRequest('Unknown project_id');
    db.run(`INSERT INTO tasks (id, title, description, status, priority, due_at, due_has_time, project_id, conversation_id, source_message_id, origin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    t.id, t.title, t.description, t.status, t.priority, t.due_at, t.due_has_time, t.project_id, t.conversation_id, t.source_message_id, t.origin, t.created_at, t.updated_at);
    addEvent(t.id, 'created', actor === 'dexter' ? 'Created by Dexter from the conversation' : 'Created', { actor, conversation_id: t.conversation_id });
    const task = get(t.id);
    bus.publish('task.updated', { task });
    return task;
  }

  function update(id, patch, { actor = 'user', note } = {}) {
    const before = mustGet(id);
    const fields = {};
    if (patch.title !== undefined) {
      const title = String(patch.title).trim();
      if (!title) throw badRequest('Task title cannot be empty');
      fields.title = title.slice(0, 300);
    }
    if (patch.description !== undefined) fields.description = patch.description;
    if (patch.priority !== undefined) {
      if (!PRIORITIES.includes(patch.priority)) throw badRequest('priority must be low, normal or high');
      fields.priority = patch.priority;
    }
    if (patch.project_id !== undefined) fields.project_id = patch.project_id || null;
    const due = parseDue(patch.due !== undefined ? patch.due : patch.due_at);
    if (due) Object.assign(fields, due);
    if (patch.outcome !== undefined) fields.outcome = patch.outcome ? String(patch.outcome) : null;
    if (patch.outcome_data !== undefined) fields.outcome_data = JSON.stringify({ ...before.outcome_data, ...patch.outcome_data });
    if (patch.status !== undefined && patch.status !== before.status) {
      if (!TASK_STATUSES.includes(patch.status)) throw badRequest(`status must be one of ${TASK_STATUSES.join(', ')}`);
      if (patch.status === 'completed' && actor === 'dexter' && !(patch.outcome || before.outcome)) {
        throw badRequest('Completing a task requires an outcome describing what was actually done (with evidence such as a confirmation id or file).');
      }
      fields.status = patch.status;
      fields.completed_at = patch.status === 'completed' ? now() : null;
      fields.blocked_reason = patch.status === 'blocked' ? (patch.blocked_reason || before.blocked_reason || null) : null;
    } else if (patch.blocked_reason !== undefined) {
      fields.blocked_reason = patch.blocked_reason;
    }
    if (!Object.keys(fields).length && !note) return before;
    fields.updated_at = now();
    const keys = Object.keys(fields);
    db.run(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => fields[k]), id);
    if (fields.status) {
      addEvent(id, 'status', `Status: ${before.status.replace('_', ' ')} → ${fields.status.replace('_', ' ')}${fields.blocked_reason ? ` (${fields.blocked_reason})` : ''}`, { actor, from: before.status, to: fields.status });
    }
    if (fields.due_at !== undefined && fields.due_at !== before.due_at) {
      addEvent(id, 'due', fields.due_at ? `Due ${formatHuman(fields.due_at, tz())}` : 'Due date removed', { actor });
    }
    if (fields.outcome && fields.outcome !== before.outcome) addEvent(id, 'outcome', 'Outcome recorded', { actor });
    if (note) addEvent(id, 'note', String(note), { actor });
    const task = get(id);
    bus.publish('task.updated', { task });
    return task;
  }

  function list({ status, project_id, q, include_done = true, limit = 200 } = {}) {
    const where = []; const params = [];
    if (status) {
      const statuses = String(status).split(',').filter((s) => TASK_STATUSES.includes(s));
      if (statuses.length) { where.push(`status IN (${statuses.map(() => '?').join(',')})`); params.push(...statuses); }
    } else if (!include_done) {
      where.push(`status IN (${OPEN_STATUSES.map(() => '?').join(',')})`); params.push(...OPEN_STATUSES);
    }
    if (project_id) { where.push('project_id = ?'); params.push(project_id); }
    if (q) { where.push('(title LIKE ? OR description LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY CASE status WHEN 'awaiting_approval' THEN 0 WHEN 'blocked' THEN 1 WHEN 'running' THEN 2 WHEN 'planned' THEN 3 ELSE 4 END,
      CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at, created_at DESC LIMIT ?`;
    return db.all(sql, ...params, limit).map(hydrate);
  }

  function detail(id) {
    const task = mustGet(id);
    const events = db.all('SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at, id', id).map((e) => ({ ...e, data: parseJson(e.data, {}) }));
    const jobs = db.all('SELECT id, name, kind, status, next_run_at, last_run_at, last_status FROM jobs WHERE task_id = ? ORDER BY created_at', id);
    const evidence = db.all(`SELECT tc.id, tc.name, tc.status, tc.summary, tc.external_ref, tc.finished_at, tc.risk FROM tool_calls tc
      JOIN runs r ON r.id = tc.run_id WHERE r.task_id = ? AND tc.status IN ('succeeded','failed','declined','unknown') ORDER BY tc.created_at`, id);
    const approvals = db.all('SELECT id, title, status, created_at, decided_at, external_ref FROM approvals WHERE task_id = ? ORDER BY created_at', id);
    const runs = db.all('SELECT id, status, trigger, error, started_at, finished_at FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 10', id);
    const project = task.project_id ? db.get('SELECT id, name, code FROM projects WHERE id = ?', task.project_id) : null;
    return { task, events, jobs, evidence, approvals, runs, project };
  }

  function remove(id) {
    mustGet(id);
    db.run('DELETE FROM tasks WHERE id = ?', id);
    bus.publish('task.deleted', { id });
  }

  function brief(t, zone = tz()) {
    const due = t.due_at ? ` · due ${formatHuman(t.due_at, zone)}${t.due_has_time ? '' : ' (end of day)'}` : '';
    return `[${t.id}] ${t.status.replace('_', ' ')}${due} · ${t.title}${t.blocked_reason ? ` (blocked: ${t.blocked_reason})` : ''}`;
  }

  return { create, update, get, mustGet, list, detail, remove, addEvent, brief, parseDue };
}
