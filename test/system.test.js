import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startMockClaude, startDexter, waitFor, text, toolUse, tmpDir } from './helpers.js';
import { markdownToDocx } from '../server/lib/docx.js';

let claude;
let site; let siteUrl;
const siteState = { failNext: 0, body: '<html><title>Grades</title><body>Nothing yet</body></html>', delayMs: 0 };
before(async () => {
  claude = await startMockClaude();
  site = http.createServer(async (req, res) => {
    if (siteState.delayMs) await new Promise((r) => setTimeout(r, siteState.delayMs));
    if (siteState.failNext > 0) { siteState.failNext--; res.writeHead(500); res.end('boom'); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(siteState.body);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${site.address().port}/grades`;
});
after(async () => { await claude.close(); site.closeAllConnections?.(); await new Promise((r) => site.close(r)); });

test('monitor: retries with backoff, notifies only when the condition is met, deduplicates', async () => {
  const d = await startDexter({ claude });
  try {
    siteState.body = '<html><title>Grades</title><body>Nothing yet</body></html>';
    const job = (await d.request('POST', '/api/jobs', { name: 'Grades posted', kind: 'monitor', schedule: { type: 'interval', minutes: 30 }, payload: { check: { type: 'url_contains', url: siteUrl, text: 'Final grades posted' } } })).data.job;
    assert.equal(job.status, 'active');

    // First check: site errors -> retrying (not failed, no alert)
    siteState.failNext = 1;
    d.app.db.run('UPDATE jobs SET next_run_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), job.id);
    await d.app.scheduler.tick();
    let runs = (await d.request('GET', `/api/jobs/${job.id}`)).data.runs;
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'retrying');
    assert.match(runs[0].error, /HTTP 500/);
    assert.equal(runs[0].attempt, 1);

    // Retry after backoff: condition not met -> success, no notification
    await new Promise((r) => setTimeout(r, 80));
    await d.app.scheduler.tick();
    runs = (await d.request('GET', `/api/jobs/${job.id}`)).data.runs;
    assert.equal(runs[0].status, 'succeeded');
    assert.equal(runs[0].attempt, 2);
    assert.equal(runs[0].result.condition_met, false);
    assert.equal((await d.request('GET', '/api/notifications')).data.notifications.length, 0);

    // Condition becomes true -> exactly one alert, even across later checks
    siteState.body = '<html><body>Final grades posted for Fall 2026</body></html>';
    for (let i = 0; i < 3; i++) {
      await d.request('POST', `/api/jobs/${job.id}/run`);
      await new Promise((r) => setTimeout(r, 5));
      await d.app.scheduler.tick();
    }
    runs = (await d.request('GET', `/api/jobs/${job.id}`)).data.runs;
    const met = runs.filter((r) => r.result?.condition_met);
    assert.equal(met.length, 3);
    assert.equal(met.reduce((s, r) => s + r.result.new_alerts, 0), 1);
    const alerts = (await d.request('GET', '/api/notifications')).data.notifications;
    assert.equal(alerts.length, 1);
    assert.match(alerts[0].title, /Grades posted/);
  } finally { await d.close(); }
});

test('scheduler: one run per occurrence, missed recurring runs are skipped, failures stop after max attempts', async () => {
  const d = await startDexter({ claude });
  try {
    const job = d.app.jobs.create({ name: 'Brief', kind: 'briefing', schedule: { type: 'daily', time: '07:30' }, payload: { use_model: false } });
    const due = new Date(Date.now() - 60000).toISOString();
    d.app.db.run('UPDATE jobs SET next_run_at = ? WHERE id = ?', due, job.id);
    // Two materialisations of the same occurrence create one run.
    d.app.db.run("INSERT INTO job_runs (id, job_id, scheduled_for, status, attempt, created_at) VALUES ('dup', ?, ?, 'queued', 0, ?)", job.id, due, new Date().toISOString());
    d.app.scheduler.materialize();
    assert.equal(d.app.db.get('SELECT COUNT(*) AS n FROM job_runs WHERE job_id = ?', job.id).n, 1);
    assert.ok(new Date(d.app.jobs.get(job.id).next_run_at) > new Date(), 'next occurrence moved to the future');
    await d.app.scheduler.tick();
    const r = d.app.jobs.runs(job.id)[0];
    assert.equal(r.status, 'succeeded');
    assert.match(r.result.markdown, /Briefing —/);
    assert.match(r.result.markdown, /Gmail and Calendar are not connected/);

    // Occurrence missed by 7h while Dexter was off -> recorded as skipped, not run late
    const old = new Date(Date.now() - 7 * 3600e3).toISOString();
    d.app.db.run('UPDATE jobs SET next_run_at = ? WHERE id = ?', old, job.id);
    d.app.scheduler.materialize();
    const skipped = d.app.db.get('SELECT * FROM job_runs WHERE job_id = ? AND scheduled_for = ?', job.id, old);
    assert.equal(skipped.status, 'skipped');

    // Permanent failure (Google not connected) fails without retrying and alerts once
    const mon = d.app.jobs.create({ name: 'Prof email', kind: 'monitor', schedule: { type: 'interval', minutes: 15 }, payload: { check: { type: 'email', query: 'from:khan@aus.edu' } } });
    for (let i = 0; i < 2; i++) {
      d.app.db.run('UPDATE jobs SET next_run_at = ? WHERE id = ?', new Date(Date.now() - 1000 - i).toISOString(), mon.id);
      await d.app.scheduler.tick();
    }
    const monRuns = d.app.jobs.runs(mon.id);
    assert.ok(monRuns.every((x) => x.status === 'failed' && x.attempt === 1));
    assert.match(monRuns[0].error, /Google is not connected/);
    const errs = d.app.notifications.list().filter((n) => n.source_id === mon.id);
    assert.equal(errs.length, 1, 'same failure reason alerts once');
  } finally { await d.close(); }
});

test('scheduler: cancelling a job aborts a running check and cancels queued runs', async () => {
  const d = await startDexter({ claude });
  try {
    siteState.delayMs = 1500;
    siteState.body = '<html>slow</html>';
    const job = d.app.jobs.create({ name: 'Slow page', kind: 'monitor', schedule: { type: 'interval', minutes: 30 }, payload: { check: { type: 'url_changed', url: siteUrl } } });
    d.app.db.run('UPDATE jobs SET next_run_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), job.id);
    const ticking = d.app.scheduler.tick();
    await waitFor(() => d.app.jobs.runs(job.id)[0]?.status === 'running', { label: 'running' });
    const cancelled = (await d.request('POST', `/api/jobs/${job.id}/cancel`)).data.job;
    assert.equal(cancelled.status, 'cancelled');
    await ticking;
    assert.equal(d.app.jobs.runs(job.id)[0].status, 'cancelled');
    assert.equal(d.app.jobs.get(job.id).next_run_at, null);
    assert.equal((await d.request('POST', `/api/jobs/${job.id}/run`)).status, 409);
  } finally { siteState.delayMs = 0; await d.close(); }
});

test('restart recovery: interrupted run is marked, uncertain actions are not retried, work resumes', async () => {
  const dataDir = tmpDir();
  let d = await startDexter({ claude, dataDir });
  const convId = (await d.request('POST', '/api/conversations', {})).data.conversation.id;
  const task = d.app.tasks.create({ title: 'Email the registrar', conversation_id: convId });
  // Simulate a crash mid-run: a running run with an in-flight external action and a streaming message.
  const db = d.app.db;
  const now = new Date().toISOString();
  db.run("INSERT INTO runs (id, conversation_id, task_id, status, trigger, started_at, updated_at) VALUES ('run_crash', ?, ?, 'running', 'chat', ?, ?)", convId, task.id, now, now);
  d.app.conversations.appendMessage(convId, { role: 'user', kind: 'user', content: [{ type: 'text', text: 'Email the registrar' }], meta: { text: 'Email the registrar' } });
  const asst = d.app.conversations.appendMessage(convId, { role: 'assistant', kind: 'assistant', run_id: 'run_crash', content: [{ type: 'tool_use', id: 'send1', name: 'email_send', input: { to: ['reg@aus.edu'], subject: 'Hi', body: 'x' } }] });
  db.run("INSERT INTO tool_calls (id, run_id, conversation_id, message_id, position, name, input, input_hash, risk, status, created_at) VALUES ('send1', 'run_crash', ?, ?, 0, 'email_send', '{}', 'h', 'act', 'running', ?)", convId, asst.id, now);
  d.app.conversations.appendMessage(convId, { role: 'assistant', kind: 'assistant', status: 'streaming', run_id: 'run_crash', partial: [{ type: 'text', text: 'Half a sent' }] });
  db.run("UPDATE tasks SET status = 'running' WHERE id = ?", task.id);
  await d.close();

  d = await startDexter({ claude, dataDir });
  try {
    const run = d.app.agent.getRun('run_crash');
    assert.equal(run.status, 'interrupted');
    const tc = d.app.db.get("SELECT * FROM tool_calls WHERE id = 'send1'");
    assert.equal(tc.status, 'unknown');
    assert.equal(d.app.tasks.get(task.id).status, 'blocked');
    assert.match(d.app.tasks.get(task.id).blocked_reason, /restart/);
    const view = (await d.request('GET', `/api/conversations/${convId}`)).data;
    assert.equal(view.messages.at(-1).status, 'interrupted');
    assert.equal(view.messages.at(-1).items[0].text, 'Half a sent');

    claude.reply((body) => {
      const last = body.messages.at(-1);
      assert.equal(last.role, 'user');
      assert.equal(last.content[0].tool_use_id, 'send1');
      assert.equal(last.content[0].is_error, true);
      assert.match(last.content[0].content, /NOT retried/);
      assert.ok(!body.messages.some((m) => m.content.some?.((b) => b.text === 'Half a sent')), 'interrupted partial text is not replayed');
      return { content: [text('I could not confirm whether the email went out — please check your Sent folder.')], stop_reason: 'end_turn' };
    });
    const r = await d.request('POST', '/api/runs/run_crash/retry');
    assert.equal(r.status, 202);
    await waitFor(() => d.app.agent.getRun('run_crash').status === 'completed', { label: 'resumed run' });
    assert.equal(d.app.tasks.get(task.id).status, 'planned');
  } finally { await d.close(); }
});

test('documents: approved wording is protected from Dexter edits; exports work', async () => {
  const d = await startDexter({ claude });
  try {
    const doc = (await d.request('POST', '/api/documents', { title: 'Cover letter', content: 'Dear Hiring Manager,\n\nI am applying for the analyst internship.\n\nRegards,\nSultan' })).data.document;
    const locked = (await d.request('POST', `/api/documents/${doc.id}/lock`, { text: 'I am applying for the analyst internship.' })).data.document;
    assert.equal(locked.locked.length, 1);
    const convId = (await d.request('POST', '/api/conversations', {})).data.conversation.id;
    claude.reply(
      { content: [toolUse('e1', 'update_document', { document_id: doc.id, content: 'Dear Hiring Manager,\n\nI want the internship.\n\nRegards' })], stop_reason: 'tool_use' },
      (body) => {
        const r = body.messages.at(-1).content[0];
        assert.equal(r.is_error, true);
        assert.match(r.content, /changes approved wording/);
        return { content: [toolUse('e2', 'edit_document', { document_id: doc.id, find: 'Regards,', replace: 'Kind regards,' })], stop_reason: 'tool_use' };
      },
      { content: [text('Updated the sign-off; your approved sentence is unchanged.')], stop_reason: 'end_turn' },
    );
    await d.request('POST', `/api/conversations/${convId}/messages`, { text: 'Polish my cover letter' });
    await waitFor(async () => (await d.request('GET', `/api/conversations/${convId}`)).data.runs[0]?.status === 'completed', { label: 'doc run' });
    const after1 = (await d.request('GET', `/api/documents/${doc.id}`)).data;
    assert.match(after1.document.content, /I am applying for the analyst internship\./);
    assert.match(after1.document.content, /Kind regards,/);
    assert.equal(after1.versions[0].author, 'dexter');

    // Sultan edits the approved sentence himself -> lock is released and noted
    const mine = (await d.request('PUT', `/api/documents/${doc.id}`, { content: 'Dear Hiring Manager,\n\nI am applying for the data analyst internship.', expected_version: after1.document.version })).data.document;
    assert.equal(mine.locked.length, 0);
    // Stale version is rejected
    assert.equal((await d.request('PUT', `/api/documents/${doc.id}`, { content: 'x', expected_version: 1 })).status, 409);

    const exp = (await d.request('POST', `/api/documents/${doc.id}/export`, { format: 'docx' })).data.file;
    assert.match(exp.name, /\.docx$/);
    const dl = await fetch(`${d.base}/api/files/${exp.id}/download`);
    assert.equal(dl.headers.get('content-disposition').startsWith('attachment'), true);
    const buf = Buffer.from(await dl.arrayBuffer());
    assert.equal(buf.subarray(0, 2).toString(), 'PK');
  } finally { await d.close(); }
});

test('without an API key: honest disconnected state, slash commands still do real work', async () => {
  const d = await startDexter({ apiKey: '' });
  try {
    const integ = (await d.request('GET', '/api/integrations')).data;
    assert.equal(integ.anthropic.configured, false);
    assert.match(integ.anthropic.setup, /ANTHROPIC_API_KEY/);
    assert.equal(integ.google.configured, false);
    const convId = (await d.request('POST', '/api/conversations', {})).data.conversation.id;
    const free = await d.request('POST', `/api/conversations/${convId}/messages`, { text: 'Summarise my email' });
    assert.equal(free.status, 409);
    assert.equal(free.data.error.code, 'model_not_configured');

    const t = await d.request('POST', `/api/conversations/${convId}/messages`, { text: '/task Read chapter 4 due tomorrow 18:00' });
    assert.equal(t.data.command.ok, true);
    const task = (await d.request('GET', '/api/tasks')).data.tasks[0];
    assert.equal(task.title, 'Read chapter 4');
    assert.ok(task.due_at);
    const rem = await d.request('POST', `/api/conversations/${convId}/messages`, { text: '/remind in 30 minutes to stretch' });
    assert.equal(rem.data.command.ok, true);
    assert.equal((await d.request('GET', '/api/jobs')).data.jobs[0].payload.message, 'stretch');
    const mem = await d.request('POST', `/api/conversations/${convId}/messages`, { text: '/remember I prefer morning study blocks' });
    assert.equal(mem.data.command.ok, true);
    const m = (await d.request('GET', '/api/memories')).data.memories[0];
    assert.equal(m.kind, 'preference');
    assert.equal(m.source_id, convId);
    const bad = await d.request('POST', `/api/conversations/${convId}/messages`, { text: '/remind whenever to relax' });
    assert.equal(bad.data.command.ok, false);
    const brief = await d.request('POST', `/api/conversations/${convId}/messages`, { text: '/brief' });
    assert.match(brief.data.command.text, /Read chapter 4/);
    const view = (await d.request('GET', `/api/conversations/${convId}`)).data;
    assert.ok(view.messages.filter((x) => x.kind === 'command').length >= 4);
    const secret = await d.request('POST', '/api/memories', { content: 'my password: hunter2' });
    assert.equal(secret.status, 400);
  } finally { await d.close(); }
});

test('security: CSRF header, host check, optional password, safe previews', async () => {
  const d = await startDexter({ claude, password: 'correct horse' });
  try {
    assert.equal((await fetch(`${d.base}/api/tasks`)).status, 401);
    const noHeader = await fetch(`${d.base}/api/auth/login`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(noHeader.status, 403);
    const cross = await fetch(`${d.base}/api/auth/login`, { method: 'POST', body: '{"password":"correct horse"}', headers: { 'content-type': 'application/json', 'x-dexter': '1', origin: 'https://evil.example' } });
    assert.equal(cross.status, 403);
    const wrong = await d.request('POST', '/api/auth/login', { password: 'nope' });
    assert.equal(wrong.status, 401);
    const ok = await d.request('POST', '/api/auth/login', { password: 'correct horse' });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    assert.match(ok.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    const authed = await d.request('GET', '/api/tasks', undefined, { cookie });
    assert.equal(authed.status, 200);
    // fetch() cannot override Host, so use a raw request (simulates DNS rebinding).
    const rebindStatus = await new Promise((resolve, reject) => {
      const u = new URL(d.base);
      const req = http.request({ host: u.hostname, port: u.port, path: '/api/health', headers: { host: 'attacker.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(rebindStatus, 421);
    // HTML uploads are previewed as text, never rendered
    const up = await d.request('POST', '/api/files?name=page.html', '<script>alert(1)</script>', { cookie, 'content-type': 'text/html' });
    assert.equal(up.status, 201);
    const prev = await d.request('GET', `/api/files/${up.data.file.id}/preview`, undefined, { cookie });
    assert.equal(prev.data.kind, 'text');
    assert.equal(prev.headers.get('content-type').startsWith('application/json'), true);
    const page = await fetch(`${d.base}/`, { headers: { cookie } });
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    // Secrets never reach the browser
    const boot = await d.request('GET', '/api/bootstrap', undefined, { cookie });
    assert.ok(!JSON.stringify(boot.data).includes('test-key'));
  } finally { await d.close(); }
});

test('files: upload, docx text preview, attach to chat as model input', async () => {
  const d = await startDexter({ claude });
  try {
    const docx = markdownToDocx('Syllabus', '# Grading\n\n- Midterm 30%\n- Final 40%\n- Project 30%');
    const up = await d.request('POST', '/api/files?name=syllabus.docx&folder=MIS%20320', docx, { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    assert.equal(up.status, 201);
    const f = up.data.file;
    assert.equal(f.folder, 'MIS 320');
    const prev = (await d.request('GET', `/api/files/${f.id}/preview`)).data;
    assert.match(prev.text, /Midterm 30%/);
    const convId = (await d.request('POST', '/api/conversations', {})).data.conversation.id;
    claude.reply((body) => {
      const user = body.messages[0].content;
      assert.match(user[0].text, /<untrusted_content source="file" label="syllabus.docx">/);
      assert.match(user[0].text, /Final 40%/);
      assert.equal(user.at(-1).text, 'Set up this course');
      return { content: [text('Got it.')], stop_reason: 'end_turn' };
    });
    await d.request('POST', `/api/conversations/${convId}/messages`, { text: 'Set up this course', file_ids: [f.id] });
    await waitFor(async () => (await d.request('GET', `/api/conversations/${convId}`)).data.runs[0]?.status === 'completed', { label: 'file run' });
    const view = (await d.request('GET', `/api/conversations/${convId}`)).data;
    assert.equal(view.messages[0].attachments[0].name, 'syllabus.docx');
    assert.equal((await d.request('GET', `/api/files/${f.id}`)).data.file.conversation_id, convId);
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const img = (await d.request('POST', '/api/files?name=shot.png', png, { 'content-type': 'image/png' })).data.file;
    const pr = await fetch(`${d.base}/api/files/${img.id}/preview`);
    assert.equal(pr.headers.get('content-type'), 'image/png');
    assert.match(pr.headers.get('content-security-policy'), /sandbox/);
    assert.equal((await d.request('DELETE', `/api/files/${img.id}`)).status, 200);
    assert.equal((await d.request('GET', `/api/files/${img.id}`)).status, 404);
  } finally { await d.close(); }
});

test('courses: grade items and weighted current grade', async () => {
  const d = await startDexter({ claude });
  try {
    const p = (await d.request('POST', '/api/projects', { name: 'Business Analytics', code: 'MIS 320', term: 'Fall 2026' })).data.project;
    await d.request('POST', `/api/projects/${p.id}/grades`, { name: 'Quiz 1', weight: 10, score: 9, max_score: 10 });
    await d.request('POST', `/api/projects/${p.id}/grades`, { name: 'Midterm', weight: 30, score: 24, max_score: 30, due: '2026-10-20' });
    await d.request('POST', `/api/projects/${p.id}/grades`, { name: 'Final', weight: 60 });
    const det = (await d.request('GET', `/api/projects/${p.id}`)).data;
    assert.equal(det.grade.current_percent, 82.5);
    assert.equal(det.grade.graded_weight, 40);
    assert.equal(det.grade.weights_sum_to_100, true);
    assert.equal((await d.request('POST', `/api/projects/${p.id}/grades`, { name: 'Bad', weight: 150 })).status, 400);
  } finally { await d.close(); }
});

test('settings validation and daily briefing sync with the scheduler', async () => {
  const d = await startDexter({ claude });
  try {
    assert.equal((await d.request('PATCH', '/api/settings', { profile: { timezone: 'Mars/Olympus' } })).status, 400);
    assert.equal((await d.request('PATCH', '/api/settings', { model: { effort: 'turbo' } })).status, 400);
    await d.request('PATCH', '/api/settings', { notifications: { daily_briefing: { enabled: true, time: '07:30', days: ['sun', 'mon', 'tue', 'wed', 'thu'] } } });
    let jobs = (await d.request('GET', '/api/jobs')).data.jobs;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].system_key, 'daily-briefing');
    assert.equal(jobs[0].schedule.expr, '30 7 * * 0,1,2,3,4');
    await d.request('PATCH', '/api/settings', { notifications: { daily_briefing: { time: '08:15' } } });
    jobs = (await d.request('GET', '/api/jobs')).data.jobs;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].schedule.expr, '15 8 * * 0,1,2,3,4');
    await d.request('PATCH', '/api/settings', { notifications: { daily_briefing: { enabled: false } } });
    assert.equal((await d.request('GET', '/api/jobs')).data.jobs[0].status, 'paused');
  } finally { await d.close(); }
});
