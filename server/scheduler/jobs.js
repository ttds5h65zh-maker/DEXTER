// Scheduled jobs (reminders, briefings, monitors, recurring Dexter work).
import { newId } from '../lib/ids.js';
import { now, parseJson } from '../db.js';
import { badRequest, notFound, conflict } from '../lib/http.js';
import { parseCron, nextCronTime, cronFromDaily, describeCron } from '../lib/cron.js';
import { parseDateTimeInput, formatHuman } from '../lib/time.js';

export const JOB_KINDS = ['reminder', 'briefing', 'monitor', 'agent'];
const CHECK_TYPES = ['email', 'url_contains', 'url_changed', 'calendar_conflicts', 'tasks_due'];

export function normalizeSchedule(s, tz, nowDate = new Date()) {
  if (!s || typeof s !== 'object') throw badRequest('schedule is required');
  if (s.type === 'once') {
    const p = parseDateTimeInput(s.at, tz, { now: nowDate });
    if (!p) throw badRequest(`Could not understand the time "${s.at}". Use ISO 8601, e.g. 2026-11-10T09:00:00+04:00.`);
    if (p.date.getTime() < nowDate.getTime() - 60000) throw badRequest(`That time (${formatHuman(p.date, tz)}) is in the past.`);
    return { type: 'once', at: p.date.toISOString() };
  }
  if (s.type === 'daily') {
    const expr = cronFromDaily(s.time, s.days);
    return { type: 'cron', expr };
  }
  if (s.type === 'cron') {
    try { parseCron(s.expr); } catch (err) { throw badRequest(err.message); }
    return { type: 'cron', expr: String(s.expr).trim().split(/\s+/).join(' ') };
  }
  if (s.type === 'interval') {
    const m = Number(s.minutes);
    if (!Number.isInteger(m) || m < 5 || m > 60 * 24 * 7) throw badRequest('Interval must be a whole number of minutes between 5 and 10080');
    return { type: 'interval', minutes: m };
  }
  throw badRequest('schedule.type must be once, daily, cron or interval');
}

export function computeNext(schedule, after, tz, { first = false } = {}) {
  if (schedule.type === 'once') return first ? new Date(schedule.at) : null;
  if (schedule.type === 'cron') return nextCronTime(schedule.expr, after, tz);
  if (schedule.type === 'interval') return new Date(after.getTime() + (first ? 60000 : schedule.minutes * 60000));
  return null;
}

export function scheduleLabel(schedule, tz) {
  if (schedule.type === 'once') return `Once at ${formatHuman(schedule.at, tz)}`;
  if (schedule.type === 'cron') return describeCron(schedule.expr);
  if (schedule.type === 'interval') return schedule.minutes % 60 === 0 ? `Every ${schedule.minutes / 60} hour${schedule.minutes === 60 ? '' : 's'}` : `Every ${schedule.minutes} minutes`;
  return 'Unknown schedule';
}

function validatePayload(kind, payload) {
  const p = payload || {};
  if (kind === 'reminder' && !String(p.message || '').trim()) throw badRequest('A reminder needs a message');
  if (kind === 'agent' && !String(p.prompt || '').trim()) throw badRequest('Recurring work needs a prompt');
  if (kind === 'monitor') {
    const c = p.check || {};
    if (!CHECK_TYPES.includes(c.type)) throw badRequest(`check.type must be one of ${CHECK_TYPES.join(', ')}`);
    if (c.type === 'email' && !String(c.query || '').trim()) throw badRequest('An email monitor needs a Gmail query');
    if (c.type.startsWith('url_')) {
      if (!/^https?:\/\//i.test(c.url || '')) throw badRequest('A page monitor needs an http(s) URL');
      if (c.type === 'url_contains' && !String(c.text || '').trim()) throw badRequest('url_contains needs the text to look for');
    }
  }
  return p;
}

export function createJobService(app) {
  const { db, bus } = app;
  const tz = () => app.settings.timezone();

  function hydrate(j) {
    if (!j) return null;
    const schedule = parseJson(j.schedule, {});
    return { ...j, schedule, payload: parseJson(j.payload, {}), schedule_label: scheduleLabel(schedule, tz()) };
  }

  function get(id) { return hydrate(db.get('SELECT * FROM jobs WHERE id = ?', id)); }
  function mustGet(id) {
    const j = get(id);
    if (!j) throw notFound('Schedule');
    return j;
  }

  function publish(id) { bus.publish('job.updated', { job: get(id) }); }

  function create({ name, kind, schedule, payload = {}, task_id = null, conversation_id = null, system_key = null, max_attempts = 3 }, { actor = 'user' } = {}) {
    if (!JOB_KINDS.includes(kind)) throw badRequest(`kind must be one of ${JOB_KINDS.join(', ')}`);
    const sched = normalizeSchedule(schedule, tz());
    validatePayload(kind, payload);
    if (task_id && !app.tasks.get(task_id)) throw badRequest('Unknown task_id');
    if (conversation_id && !app.conversations.get(conversation_id)) conversation_id = null;
    const next = computeNext(sched, new Date(), tz(), { first: true });
    const j = { id: newId('job'), name: String(name || kind).slice(0, 120), kind, schedule: JSON.stringify(sched), payload: JSON.stringify(payload),
      status: 'active', system_key, next_run_at: next ? next.toISOString() : null, max_attempts, task_id, conversation_id, created_by: actor, created_at: now(), updated_at: now() };
    db.run(`INSERT INTO jobs (id, name, kind, schedule, payload, status, system_key, next_run_at, max_attempts, task_id, conversation_id, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, j.id, j.name, j.kind, j.schedule, j.payload, j.status, j.system_key, j.next_run_at, j.max_attempts, j.task_id, j.conversation_id, j.created_by, j.created_at, j.updated_at);
    if (task_id) app.tasks.addEvent(task_id, 'schedule', `${kind === 'reminder' ? 'Reminder' : 'Schedule'} set: ${scheduleLabel(sched, tz())}`, { job_id: j.id });
    publish(j.id);
    return get(j.id);
  }

  function update(id, { name, schedule, payload }) {
    const j = mustGet(id);
    if (['cancelled', 'completed'].includes(j.status)) throw conflict(`This schedule is ${j.status}`);
    const fields = {};
    if (name !== undefined) fields.name = String(name).slice(0, 120);
    if (payload !== undefined) fields.payload = JSON.stringify(validatePayload(j.kind, { ...j.payload, ...payload }));
    if (schedule !== undefined) {
      const s = normalizeSchedule(schedule, tz());
      fields.schedule = JSON.stringify(s);
      const next = computeNext(s, new Date(), tz(), { first: true });
      fields.next_run_at = next ? next.toISOString() : null;
    }
    if (!Object.keys(fields).length) return j;
    fields.updated_at = now();
    const keys = Object.keys(fields);
    db.run(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => fields[k]), id);
    publish(id);
    return get(id);
  }

  function list({ kind, status } = {}) {
    const where = []; const p = [];
    if (kind) { where.push('kind = ?'); p.push(kind); }
    if (status) { where.push('status = ?'); p.push(status); }
    return db.all(`SELECT * FROM jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, next_run_at, created_at DESC`, ...p).map(hydrate);
  }

  function runs(jobId, limit = 50) {
    return db.all('SELECT * FROM job_runs WHERE job_id = ? ORDER BY scheduled_for DESC, created_at DESC LIMIT ?', jobId, limit).map((r) => ({ ...r, result: parseJson(r.result, null) }));
  }

  function detail(id) {
    return { job: mustGet(id), runs: runs(id) };
  }

  function cancel(id) {
    const j = mustGet(id);
    if (j.status === 'cancelled') return j;
    db.tx(() => {
      db.run("UPDATE jobs SET status = 'cancelled', next_run_at = NULL, updated_at = ? WHERE id = ?", now(), id);
      db.run("UPDATE job_runs SET status = 'cancelled', finished_at = ?, error = 'Cancelled' WHERE job_id = ? AND status IN ('queued','retrying')", now(), id);
    });
    app.scheduler?.abortJob(id);
    if (j.task_id) app.tasks.addEvent(j.task_id, 'schedule', `Schedule cancelled: ${j.name}`, { job_id: id });
    publish(id);
    return get(id);
  }

  function pause(id) {
    const j = mustGet(id);
    if (j.status !== 'active') throw conflict(`Only active schedules can be paused (this one is ${j.status})`);
    db.run("UPDATE jobs SET status = 'paused', updated_at = ? WHERE id = ?", now(), id);
    publish(id);
    return get(id);
  }

  function resume(id) {
    const j = mustGet(id);
    if (j.status !== 'paused') throw conflict(`Only paused schedules can be resumed (this one is ${j.status})`);
    let next;
    if (j.schedule.type === 'once') next = new Date(Math.max(Date.now(), new Date(j.schedule.at).getTime()));
    else next = computeNext(j.schedule, new Date(), tz());
    db.run("UPDATE jobs SET status = 'active', next_run_at = ?, updated_at = ? WHERE id = ?", next ? next.toISOString() : null, now(), id);
    publish(id);
    return get(id);
  }

  function runNow(id) {
    const j = mustGet(id);
    if (j.status === 'cancelled') throw conflict('This schedule is cancelled');
    const run = { id: newId('jrun'), scheduled_for: new Date().toISOString() };
    db.run("INSERT INTO job_runs (id, job_id, scheduled_for, status, attempt, next_attempt_at, created_at) VALUES (?, ?, ?, 'queued', 0, ?, ?)", run.id, id, run.scheduled_for, run.scheduled_for, now());
    bus.publish('job.run', { job_id: id, run_id: run.id, status: 'queued' });
    app.scheduler?.kick();
    return run;
  }

  /** Keep the "daily briefing" setting and its system job in sync. */
  function syncDailyBriefing() {
    const cfg = app.settings.get('notifications').daily_briefing;
    const existing = db.get("SELECT id, status FROM jobs WHERE system_key = 'daily-briefing'");
    if (cfg.enabled) {
      const schedule = { type: 'daily', time: cfg.time, days: cfg.days };
      if (existing && existing.status !== 'cancelled') {
        update(existing.id, { schedule });
        if (existing.status === 'paused') resume(existing.id);
        return get(existing.id);
      }
      if (existing) db.run('DELETE FROM jobs WHERE id = ?', existing.id);
      return create({ name: 'Daily briefing', kind: 'briefing', schedule, payload: { use_model: true }, system_key: 'daily-briefing' }, { actor: 'system' });
    }
    if (existing && existing.status === 'active') return pause(existing.id);
    return existing ? get(existing.id) : null;
  }

  return { create, update, get, mustGet, list, runs, detail, cancel, pause, resume, runNow, syncDailyBriefing };
}
