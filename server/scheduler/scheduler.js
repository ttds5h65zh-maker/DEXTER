// The scheduler loop. Each occurrence of a job becomes exactly one job_run row
// (UNIQUE(job_id, scheduled_for) prevents duplicates). Runs are claimed with a
// lease, retried with exponential backoff, and can be cancelled mid-flight.
import { newId } from '../lib/ids.js';
import { now, parseJson } from '../db.js';
import { computeNext } from './jobs.js';
import { log } from '../lib/log.js';

const MISSED_GRACE_MS = 6 * 60 * 60 * 1000;
const LEASE_MS = 20 * 60 * 1000;

export class PermanentJobError extends Error {
  constructor(message) { super(message); this.permanent = true; }
}

export function createScheduler(app) {
  const { db, bus, config } = app;
  const tz = () => app.settings.timezone();
  const running = new Map(); // job_run id -> { controller, jobId }
  let timer = null;
  let ticking = false;
  let kicked = false;

  function materialize(nowDate = new Date()) {
    const due = db.all("SELECT * FROM jobs WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?", nowDate.toISOString());
    for (const row of due) {
      const schedule = parseJson(row.schedule, {});
      const scheduledFor = row.next_run_at;
      const late = nowDate.getTime() - new Date(scheduledFor).getTime();
      db.tx(() => {
        if (schedule.type !== 'once' && late > MISSED_GRACE_MS) {
          db.run("INSERT OR IGNORE INTO job_runs (id, job_id, scheduled_for, status, error, created_at, finished_at) VALUES (?, ?, ?, 'skipped', ?, ?, ?)",
            newId('jrun'), row.id, scheduledFor, 'Missed while Dexter was not running', now(), now());
        } else {
          db.run("INSERT OR IGNORE INTO job_runs (id, job_id, scheduled_for, status, attempt, next_attempt_at, created_at) VALUES (?, ?, ?, 'queued', 0, ?, ?)",
            newId('jrun'), row.id, scheduledFor, nowDate.toISOString(), now());
        }
        const base = new Date(Math.max(nowDate.getTime(), new Date(scheduledFor).getTime()));
        const next = computeNext(schedule, base, tz());
        db.run('UPDATE jobs SET next_run_at = ?, updated_at = ? WHERE id = ? AND next_run_at = ?', next ? next.toISOString() : null, now(), row.id, scheduledFor);
      });
      bus.publish('job.updated', { job: app.jobs.get(row.id) });
    }
  }

  function claimable(nowDate) {
    return db.all(`SELECT r.*, j.max_attempts FROM job_runs r JOIN jobs j ON j.id = r.job_id
      WHERE r.status IN ('queued','retrying') AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= ?) ORDER BY r.scheduled_for LIMIT 10`, nowDate.toISOString());
  }

  async function tick() {
    if (ticking) { kicked = true; return; }
    ticking = true;
    try {
      do {
        kicked = false;
        const nowDate = new Date();
        materialize(nowDate);
        const work = [];
        for (const r of claimable(nowDate)) {
          if (running.size >= 4) break;
          const claimed = db.run(`UPDATE job_runs SET status = 'running', attempt = attempt + 1, lease_until = ?, started_at = ?, error = NULL
            WHERE id = ? AND status IN ('queued','retrying')`, new Date(Date.now() + LEASE_MS).toISOString(), now(), r.id);
          if (claimed.changes === 1) work.push(execute(r.id));
        }
        await Promise.all(work);
      } while (kicked);
    } catch (err) {
      log.error('scheduler tick failed', { error: err.message });
    } finally {
      ticking = false;
    }
  }

  async function execute(runId) {
    const run = db.get('SELECT * FROM job_runs WHERE id = ?', runId);
    const job = app.jobs.get(run.job_id);
    const controller = new AbortController();
    running.set(runId, { controller, jobId: job.id });
    bus.publish('job.run', { job_id: job.id, run_id: runId, status: 'running', attempt: run.attempt });
    try {
      if (!job || job.status === 'cancelled') throw Object.assign(new Error('Cancelled'), { cancelled: true });
      const runner = app.runners[job.kind];
      if (!runner) throw new PermanentJobError(`No runner for ${job.kind}`);
      const result = await runner(job, run, { signal: controller.signal });
      if (controller.signal.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
      db.tx(() => {
        db.run("UPDATE job_runs SET status = 'succeeded', result = ?, finished_at = ?, lease_until = NULL WHERE id = ? AND status = 'running'", JSON.stringify(result ?? {}), now(), runId);
        db.run('UPDATE jobs SET last_run_at = ?, last_status = ?, updated_at = ? WHERE id = ?', now(), 'succeeded', now(), job.id);
        if (job.schedule.type === 'once') db.run("UPDATE jobs SET status = 'completed', next_run_at = NULL WHERE id = ? AND status = 'active'", job.id);
      });
      bus.publish('job.run', { job_id: job.id, run_id: runId, status: 'succeeded' });
    } catch (err) {
      const cancelled = err.cancelled || controller.signal.aborted;
      const fresh = db.get('SELECT attempt FROM job_runs WHERE id = ?', runId);
      if (cancelled) {
        db.run("UPDATE job_runs SET status = 'cancelled', error = 'Cancelled', finished_at = ?, lease_until = NULL WHERE id = ?", now(), runId);
        bus.publish('job.run', { job_id: job?.id, run_id: runId, status: 'cancelled' });
      } else if (!err.permanent && fresh.attempt < (job.max_attempts || 3)) {
        const delay = config.retryBaseMs * 4 ** (fresh.attempt - 1);
        db.run("UPDATE job_runs SET status = 'retrying', error = ?, next_attempt_at = ?, lease_until = NULL WHERE id = ?", err.message, new Date(Date.now() + delay).toISOString(), runId);
        db.run('UPDATE jobs SET last_status = ?, updated_at = ? WHERE id = ?', 'retrying', now(), job.id);
        bus.publish('job.run', { job_id: job.id, run_id: runId, status: 'retrying', error: err.message });
        log.warn('job run failed; will retry', { job: job.id, attempt: fresh.attempt, error: err.message });
      } else {
        db.tx(() => {
          db.run("UPDATE job_runs SET status = 'failed', error = ?, finished_at = ?, lease_until = NULL WHERE id = ?", err.message, now(), runId);
          db.run('UPDATE jobs SET last_run_at = ?, last_status = ?, updated_at = ? WHERE id = ?', now(), 'failed', now(), job.id);
          if (job.schedule.type === 'once') db.run("UPDATE jobs SET status = 'failed', next_run_at = NULL WHERE id = ? AND status = 'active'", job.id);
        });
        bus.publish('job.run', { job_id: job.id, run_id: runId, status: 'failed', error: err.message });
        // One alert per job and failure reason, not one per run.
        const reasonKey = err.permanent ? err.message.slice(0, 60) : `run:${runId}`;
        await app.notifications.notify({
          title: `${job.name} could not run`, body: err.message, level: 'error', source_type: 'job', source_id: job.id,
          link: '#/tasks/schedules', dedupe_key: `job:${job.id}:failed:${reasonKey}`, push: false,
        }).catch(() => {});
        if (job.task_id) app.tasks.addEvent(job.task_id, 'schedule', `${job.name} failed: ${err.message}`, { job_id: job.id, job_run_id: runId });
      }
    } finally {
      running.delete(runId);
      bus.publish('job.updated', { job: app.jobs.get(job.id) });
    }
  }

  function abortJob(jobId) {
    for (const [runId, r] of running) if (r.jobId === jobId) { r.controller.abort(); log.info('aborted running job', { runId }); }
  }

  /** After a restart, runs that were "running" are retried (or failed if out of attempts). */
  function recover() {
    const stale = db.all("SELECT r.id, r.attempt, j.max_attempts FROM job_runs r JOIN jobs j ON j.id = r.job_id WHERE r.status = 'running'");
    for (const r of stale) {
      if (r.attempt < r.max_attempts) {
        db.run("UPDATE job_runs SET status = 'retrying', error = 'Interrupted by a restart', next_attempt_at = ?, lease_until = NULL WHERE id = ?", now(), r.id);
      } else {
        db.run("UPDATE job_runs SET status = 'failed', error = 'Interrupted by a restart (no attempts left)', finished_at = ?, lease_until = NULL WHERE id = ?", now(), r.id);
      }
    }
    return stale.length;
  }

  function start() {
    recover();
    if (!config.schedulerEnabled) return;
    timer = setInterval(() => { tick(); }, config.schedulerIntervalMs);
    timer.unref?.();
    setTimeout(() => tick(), 200).unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    for (const r of running.values()) r.controller.abort();
  }

  function health() {
    return { enabled: config.schedulerEnabled, interval_ms: config.schedulerIntervalMs, running: running.size };
  }

  return { start, stop, tick, kick: () => { setImmediate(() => tick()); }, abortJob, recover, materialize, health };
}
