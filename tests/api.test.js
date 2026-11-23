// End-to-end over HTTP against a real server process, including a restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexter-test-'));
const PORT = 4300 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${PORT}`;
let server;

async function startServer(extraEnv = {}) {
  const env = { ...process.env, PORT: String(PORT), DEXTER_DATA_DIR: dataDir, ...extraEnv };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  server = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('Dexter is running') && resolve());
    server.on('exit', (code) => reject(new Error('server exited ' + code)));
  });
}
async function stopServer() {
  const done = new Promise((r) => server.on('exit', r));
  server.kill('SIGTERM');
  await done;
}
async function call(method, url, body, raw) {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: raw || (body ? JSON.stringify(body) : undefined),
  });
  return { status: res.status, json: await res.json() };
}

test.after(async () => {
  if (server && server.exitCode === null) await stopServer();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('the whole workflow survives a restart', async (t) => {
  await startServer();
  let state;
  let sourceId;
  let deposit;
  let agreement;
  let question;
  let taskId;
  let draftId;

  await t.test('first run seeds a labelled demo and reports AI as off', async () => {
    const { json } = await call('GET', '/api/state');
    state = json.state;
    assert.equal(state.meta.tz, 'Asia/Dubai');
    assert.deepEqual(state.meta.ai.available, false);
    assert.equal(state.meta.ai.reason, 'no_key');
    assert.ok(state.sources.length >= 2 && state.sources.every((s) => s.demo));
    assert.ok(state.tasks.some((t) => t.status === 'waiting') && state.tasks.some((t) => t.due && t.due.date === state.meta.today));
    assert.ok(state.findings.some((f) => f.date && f.date.status === 'needs_confirmation'));
    assert.ok(state.drafts.some((d) => d.status === 'needs_review'));
  });

  await t.test('importing an email produces findings with evidence', async () => {
    const text = fs.readFileSync(path.join(root, 'samples/messy-email.txt'), 'utf8');
    const { status, json } = await call('POST', '/api/sources', { kind: 'email', text });
    assert.equal(status, 200);
    sourceId = json.sourceId;
    const source = json.state.sources.find((s) => s.id === sourceId);
    assert.equal(source.demo, false);
    assert.equal(source.dateBasis, 'header');
    assert.equal(source.extraction.mode, 'rules');
    const mine = json.state.findings.filter((f) => f.sourceId === sourceId);
    assert.ok(mine.length >= 5);
    for (const f of mine) assert.equal(source.text.slice(f.evidence.start, f.evidence.end), f.evidence.quote);
    deposit = mine.find((f) => f.evidence.quote.includes('next Thursday'));
    agreement = mine.find((f) => f.evidence.quote.includes('internship agreement'));
    question = mine.find((f) => f.type === 'question');
    assert.ok(deposit && agreement && question);
  });

  await t.test('an ambiguous date blocks scheduling until it is reviewed', async () => {
    assert.equal(deposit.date.status, 'needs_confirmation');
    assert.ok(deposit.date.reasons.length > 0);
    const blocked = await call('POST', `/api/findings/${deposit.id}/task`, {});
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.error.code, 'date_unconfirmed');
    const cal = await call('POST', '/api/drafts', { findingId: deposit.id, kind: 'calendar' });
    assert.equal(cal.status, 409);
    const after = (await call('GET', '/api/state')).json.state;
    assert.ok(!after.tasks.some((t) => t.findingId === deposit.id));
  });

  await t.test('correcting the date confirms it and a task can then be created', async () => {
    const bad = await call('PATCH', `/api/findings/${deposit.id}`, { date: { date: '2026-02-31' } });
    assert.equal(bad.status, 400);
    const fixed = await call('PATCH', `/api/findings/${deposit.id}`, { date: { date: '2026-11-18', time: '23:59' } });
    const f = fixed.json.state.findings.find((x) => x.id === deposit.id);
    assert.deepEqual([f.date.date, f.date.time, f.date.status, f.date.corrected], ['2026-11-18', '23:59', 'confirmed', true]);
    assert.ok(f.history.some((h) => /corrected/i.test(h.text)));
    const made = await call('POST', `/api/findings/${deposit.id}/task`, { today: true });
    assert.equal(made.status, 200);
    taskId = made.json.taskId;
    const task = made.json.state.tasks.find((x) => x.id === taskId);
    assert.deepEqual(task.due, { date: '2026-11-18', time: '23:59' });
    assert.equal(task.todayOn, made.json.state.meta.today);
  });

  await t.test('findings can be edited, dismissed and added by hand', async () => {
    await call('PATCH', `/api/findings/${agreement.id}`, { title: 'Send signed internship agreement' });
    const dis = await call('PATCH', `/api/findings/${question.id}`, { status: 'dismissed' });
    assert.equal(dis.json.state.findings.find((x) => x.id === question.id).status, 'dismissed');
    const text = dis.json.state.sources.find((s) => s.id === sourceId).text;
    const start = text.indexOf('nobody has confirmed');
    const manual = await call('POST', `/api/sources/${sourceId}/findings`, { type: 'question', start, end: start + 'nobody has confirmed'.length });
    const added = manual.json.state.findings.find((x) => x.id === manual.json.findingId);
    assert.deepEqual([added.origin, added.evidence.quote], ['manual', 'nobody has confirmed']);
  });

  await t.test('a draft can be edited, must be approved, and editing withdraws approval', async () => {
    const made = await call('POST', '/api/drafts', { findingId: agreement.id, kind: 'email' });
    draftId = made.json.draftId;
    let d = made.json.state.drafts.find((x) => x.id === draftId);
    assert.deepEqual([d.status, d.origin, d.destination.to], ['needs_review', 'template', 'm.qasim@falconbay.example']);
    const early = await call('POST', `/api/drafts/${draftId}/complete`);
    assert.equal(early.status, 409);
    await call('PATCH', `/api/drafts/${draftId}`, { body: 'Hi Mariam,\n\nI will send the signed agreement on Sunday.\n' });
    d = (await call('POST', `/api/drafts/${draftId}/approve`)).json.state.drafts.find((x) => x.id === draftId);
    assert.equal(d.status, 'approved');
    d = (await call('PATCH', `/api/drafts/${draftId}`, { subject: 'Internship agreement' })).json.state.drafts.find((x) => x.id === draftId);
    assert.equal(d.status, 'needs_review');
    assert.equal(d.approval, null);
    const noRecipient = await call('PATCH', `/api/drafts/${draftId}`, { destination: { to: '' } });
    assert.equal((await call('POST', `/api/drafts/${draftId}/approve`)).status, 400);
    assert.equal(noRecipient.status, 200);
    await call('PATCH', `/api/drafts/${draftId}`, { destination: { to: 'm.qasim@falconbay.example' } });
  });

  await t.test('calendar changes need a confirmed date and an approval', async () => {
    const made = await call('POST', '/api/drafts', { findingId: deposit.id, kind: 'calendar' });
    assert.equal(made.status, 200);
    const id = made.json.draftId;
    assert.equal((await fetch(`${base}/api/drafts/${id}/event.ics`)).status, 403);
    await call('POST', `/api/drafts/${id}/approve`);
    const ics = await (await fetch(`${base}/api/drafts/${id}/event.ics`)).text();
    assert.match(ics, /DTSTART;TZID=Asia\/Dubai:20261118T235900/);
  });

  await t.test('a PDF upload is read and cross-site writes are refused', async () => {
    const pdf = fs.readFileSync(path.join(root, 'samples/course-outline.pdf'));
    const up = await call('POST', '/api/sources/pdf?filename=course-outline.pdf', null, pdf);
    assert.equal(up.status, 200);
    const src = up.json.state.sources.find((s) => s.id === up.json.sourceId);
    assert.deepEqual([src.kind, src.pages.length, src.dateBasis], ['pdf', 2, 'assumed']);
    assert.ok(up.json.state.findings.filter((f) => f.sourceId === src.id).length >= 5);
    const notPdf = await call('POST', '/api/sources/pdf?filename=x.pdf', null, Buffer.from('plain text'));
    assert.equal(notPdf.status, 422);
    const cross = await fetch(`${base}/api/demo/remove`, { method: 'POST', headers: { origin: 'https://evil.example' } });
    assert.equal(cross.status, 403);
  });

  await t.test('after a restart everything is exactly as it was', async () => {
    const before = (await call('GET', '/api/state')).json.state;
    await stopServer();
    await startServer();
    const after = (await call('GET', '/api/state')).json.state;
    for (const kind of ['sources', 'findings', 'tasks', 'drafts']) assert.deepEqual(after[kind], before[kind], kind);
    const task = after.tasks.find((x) => x.id === taskId);
    assert.deepEqual(task.due, { date: '2026-11-18', time: '23:59' });
    assert.ok(task.history.length >= 2);
    assert.equal(after.findings.find((x) => x.id === agreement.id).title, 'Send signed internship agreement');
    assert.match(after.drafts.find((x) => x.id === draftId).body, /signed agreement on Sunday/);
  });

  await t.test('task history records changes, and demo data can be removed without touching real data', async () => {
    await call('PATCH', `/api/tasks/${taskId}`, { status: 'waiting', waitingOn: 'Housing office' });
    const done = await call('PATCH', `/api/tasks/${taskId}`, { status: 'done' });
    const task = done.json.state.tasks.find((x) => x.id === taskId);
    assert.ok(task.history.some((h) => /Waiting on Housing office/.test(h.text)) && task.history.some((h) => h.text === 'Completed'));
    const removed = (await call('POST', '/api/demo/remove')).json.state;
    assert.equal(removed.meta.hasDemo, false);
    assert.ok(removed.sources.some((s) => s.id === sourceId) && removed.tasks.some((x) => x.id === taskId));
  });
});
