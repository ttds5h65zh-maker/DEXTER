import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockClaude, startMockGoogle, startDexter, connectGoogle, waitFor, text, toolUse } from './helpers.js';

let claude; let google;
before(async () => { claude = await startMockClaude(); google = await startMockGoogle(); });
after(async () => { await claude.close(); await google.close(); });

async function newConv(d) {
  return (await d.request('POST', '/api/conversations', {})).data.conversation.id;
}

async function runTo(d, convId, status) {
  return waitFor(async () => {
    const v = (await d.request('GET', `/api/conversations/${convId}`)).data;
    const r = v.runs[0];
    return r && (Array.isArray(status) ? status.includes(r.status) : r.status === status) ? v : null;
  }, { label: `run ${status}` });
}

test('conversation → task + reminder → scheduler delivers once → verified outcome', async () => {
  const d = await startDexter({ claude });
  try {
    const convId = await newConv(d);
    claude.reply(
      { content: [{ type: 'thinking', thinking: 'Creating the task and reminder now.' }, text('I will track this and remind you.'),
        toolUse('tu_task', 'create_task', { title: 'Submit MIS 320 report', due: '2026-11-06T23:59:00+04:00', priority: 'high' }),
        toolUse('tu_rem', 'schedule_reminder', { message: 'Submit the MIS 320 report', at: new Date(Date.now() + 3600e3).toISOString() })], stop_reason: 'tool_use' },
      { content: [text('Done: task created (planned) and a reminder is scheduled.')], stop_reason: 'end_turn' },
    );
    const sent = await d.request('POST', `/api/conversations/${convId}/messages`, { text: 'Remind me in an hour to submit my MIS 320 report, due tomorrow night.' });
    assert.equal(sent.status, 202);
    const view = await runTo(d, convId, 'completed');

    // Request shape sent to Claude
    const [first, second] = claude.requests.slice(-2);
    assert.equal(first.headers['x-api-key'], 'test-key');
    assert.equal(first.headers['anthropic-version'], '2026-10-21');
    assert.match(first.headers['anthropic-beta'], /thinking-display-updates-2026-08-18/);
    assert.equal(first.body.model, 'claude-opus-5-5');
    assert.equal(first.body.stream, true);
    assert.equal(first.body.thinking.type, 'adaptive');
    assert.equal(first.body.output_config.effort, 'medium');
    assert.equal(first.body.fallbacks, 'default');
    assert.ok(first.body.tools.find((t) => t.name === 'create_task').eager_input_streaming);
    assert.ok(first.body.tools.some((t) => t.type === 'web_search_20260209'));
    assert.deepEqual(first.body.messages.map((m) => m.role), ['user', 'system']);
    assert.match(first.body.messages[1].content[0].text, /Asia\/Dubai/);
    // The second request replays history verbatim and returns both tool results in ONE user message.
    assert.deepEqual(second.body.messages.map((m) => m.role), ['user', 'system', 'assistant', 'user']);
    assert.deepEqual(second.body.messages[2].content[0], { type: 'thinking', thinking: 'Creating the task and reminder now.', signature: 'sig-test' });
    const results = second.body.messages[3].content;
    assert.deepEqual(results.map((r) => r.tool_use_id), ['tu_task', 'tu_rem']);
    assert.ok(results.every((r) => r.type === 'tool_result' && !r.is_error));
    assert.deepEqual(first.body.tools.map((t) => t.name), second.body.tools.map((t) => t.name), 'tool list must be stable between turns');

    // Display: progress line, text, two completed tool calls
    const asst = view.messages.find((m) => m.kind === 'assistant');
    assert.deepEqual(asst.items.map((i) => i.type), ['progress', 'text', 'tool', 'tool']);
    assert.ok(view.tool_calls.every((t) => t.status === 'succeeded'));

    // Persistent task linked to the conversation
    const tasks = (await d.request('GET', '/api/tasks')).data.tasks;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, 'Submit MIS 320 report');
    assert.equal(tasks[0].conversation_id, convId);
    assert.equal(tasks[0].due_at, '2026-11-06T19:59:00.000Z');
    assert.equal(tasks[0].origin, 'dexter');

    // A real scheduler job backs the reminder
    const jobs = (await d.request('GET', '/api/jobs')).data.jobs;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].kind, 'reminder');
    assert.equal(jobs[0].status, 'active');

    // Make it due and run the scheduler: exactly one delivery
    d.app.db.run('UPDATE jobs SET next_run_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), jobs[0].id);
    await d.app.scheduler.tick();
    await d.app.scheduler.tick();
    const detail = (await d.request('GET', `/api/jobs/${jobs[0].id}`)).data;
    assert.equal(detail.job.status, 'completed');
    assert.equal(detail.runs.length, 1);
    assert.equal(detail.runs[0].status, 'succeeded');
    assert.ok(detail.runs[0].result.notification_id);
    const notes = (await d.request('GET', '/api/notifications')).data.notifications.filter((n) => n.level === 'reminder');
    assert.equal(notes.length, 1);
    assert.equal(notes[0].body, 'Submit the MIS 320 report');

    // Force a re-run of the same occurrence: dedupe prevents a second alert
    const run = detail.runs[0];
    d.app.db.run("UPDATE job_runs SET status = 'queued', next_attempt_at = NULL WHERE id = ?", run.id);
    await d.app.scheduler.tick();
    const again = (await d.request('GET', `/api/jobs/${jobs[0].id}`)).data.runs[0];
    assert.equal(again.result.duplicate_prevented, true);
    assert.equal((await d.request('GET', '/api/notifications')).data.notifications.filter((n) => n.level === 'reminder').length, 1);
  } finally { await d.close(); }
});

test('external action pauses for approval, executes once, and records the confirmation', async () => {
  const d = await startDexter({ claude, google });
  connectGoogle(d.app);
  try {
    const convId = await newConv(d);
    claude.reply(
      { content: [toolUse('tu_read', 'email_read', { message_id: 'm1' })], stop_reason: 'tool_use' },
      (body) => {
        const result = body.messages.at(-1).content[0];
        assert.match(result.content, /<untrusted_content source="email"/);
        assert.match(result.content, /IGNORE PREVIOUS INSTRUCTIONS/);
        return { content: [text('Here is a reply for your approval.'), toolUse('tu_send', 'email_send', { to: ['khan@aus.edu'], subject: 'Re: MIS 320 project deadline', body: 'Dear Dr. Khan,\nThank you — I will submit by Friday.\nSultan', reply_to_message_id: 'm1' })], stop_reason: 'tool_use' };
      },
      { content: [text('Sent — Gmail confirmed it.')], stop_reason: 'end_turn' },
    );
    await d.request('POST', `/api/conversations/${convId}/messages`, { text: 'Reply to Dr. Khan confirming I will submit on time.' });
    const view = await runTo(d, convId, 'awaiting_approval');
    assert.equal(google.sent.length, 0, 'nothing is sent before approval');
    const pending = (await d.request('GET', '/api/approvals?status=pending')).data.approvals;
    assert.equal(pending.length, 1);
    const a = pending[0];
    assert.equal(a.tool, 'email_send');
    assert.deepEqual(a.preview.fields.find((f) => f.label === 'To'), { label: 'To', value: 'khan@aus.edu' });
    assert.match(a.preview.body, /I will submit by Friday/);
    assert.ok(a.provenance.some((p) => p.source === 'email'), 'approval shows that untrusted email was read');
    assert.equal(view.tool_calls.find((t) => t.id === 'tu_send').status, 'awaiting_approval');

    const ok = await d.request('POST', `/api/approvals/${a.id}/approve`, {});
    assert.equal(ok.status, 200);
    await runTo(d, convId, 'completed');
    assert.equal(google.sent.length, 1, 'sent exactly once');
    assert.match(google.sent[0].mime, /To: khan@aus.edu/);
    assert.match(google.sent[0].mime, /In-Reply-To: <orig-1@aus.edu>/);
    assert.equal(google.sent[0].threadId, 't1');
    const done = (await d.request('GET', `/api/approvals/${a.id}`)).data.approval;
    assert.equal(done.status, 'executed');
    assert.equal(done.external_ref, 'gmail:sent-1');
    const lastReq = claude.requests.at(-1).body.messages.at(-1).content[0];
    assert.match(lastReq.content, /Gmail confirmed message id sent-1/);
    assert.notEqual(lastReq.is_error, true);
    // Deciding twice is refused
    assert.equal((await d.request('POST', `/api/approvals/${a.id}/approve`, {})).status, 409);
  } finally { await d.close(); }
});

test('rejected action is not executed and the model is told', async () => {
  const d = await startDexter({ claude, google });
  connectGoogle(d.app);
  const before = google.sent.length;
  try {
    const convId = await newConv(d);
    claude.reply(
      { content: [toolUse('tu_cal', 'calendar_create_event', { summary: 'Study block', start: '2026-11-07T10:00:00+04:00', end: '2026-11-07T12:00:00+04:00' })], stop_reason: 'tool_use' },
      (body) => {
        const r = body.messages.at(-1).content[0];
        assert.equal(r.is_error, true);
        assert.match(r.content, /declined this action: not Saturday/);
        return { content: [text('Understood, I did not add it.')], stop_reason: 'end_turn' };
      },
    );
    await d.request('POST', `/api/conversations/${convId}/messages`, { text: 'Block Saturday morning for study.' });
    await runTo(d, convId, 'awaiting_approval');
    const a = (await d.request('GET', '/api/approvals?status=pending')).data.approvals[0];
    assert.equal(a.grantable, true);
    await d.request('POST', `/api/approvals/${a.id}/reject`, { note: 'not Saturday' });
    await runTo(d, convId, 'completed');
    assert.equal(google.events.size, 0);
    assert.equal(google.sent.length, before);
  } finally { await d.close(); }
});

test('standing authorization covers the exact same kind of action without asking again', async () => {
  const d = await startDexter({ claude, google });
  connectGoogle(d.app);
  try {
    const convId = await newConv(d);
    const ev = (id, s) => toolUse(id, 'calendar_create_event', { summary: `Study ${id}`, start: `2026-11-0${s}T10:00:00+04:00`, end: `2026-11-0${s}T11:00:00+04:00` });
    claude.reply({ content: [ev('c1', 8)], stop_reason: 'tool_use' }, { content: [text('Added.')], stop_reason: 'end_turn' });
    await d.request('POST', `/api/conversations/${convId}/messages`, { text: 'Add a study block Sunday 10:00.' });
    await runTo(d, convId, 'awaiting_approval');
    const a = (await d.request('GET', '/api/approvals?status=pending')).data.approvals[0];
    await d.request('POST', `/api/approvals/${a.id}/approve`, { always_allow: true });
    await runTo(d, convId, 'completed');
    assert.equal((await d.request('GET', '/api/grants')).data.grants.length, 1);

    claude.reply({ content: [ev('c2', 9)], stop_reason: 'tool_use' }, { content: [text('Added again.')], stop_reason: 'end_turn' });
    await d.request('POST', `/api/conversations/${convId}/messages`, { text: 'And Monday 10:00.' });
    await runTo(d, convId, 'completed');
    assert.equal((await d.request('GET', '/api/approvals?status=pending')).data.approvals.length, 0, 'no new approval needed');
    assert.equal(google.events.size, 2);

    // Inviting guests is outside the grant's scope -> asks again
    claude.reply({ content: [toolUse('c3', 'calendar_create_event', { summary: 'Group meeting', start: '2026-11-10T10:00:00+04:00', end: '2026-11-10T11:00:00+04:00', attendees: ['friend@aus.edu'] })], stop_reason: 'tool_use' });
    await d.request('POST', `/api/conversations/${convId}/messages`, { text: 'Invite my teammate.' });
    await runTo(d, convId, 'awaiting_approval');
    // Revoking the grant works
    const g = (await d.request('GET', '/api/grants')).data.grants[0];
    assert.equal((await d.request('DELETE', `/api/grants/${g.id}`)).status, 200);
    assert.equal((await d.request('GET', '/api/grants')).data.grants.length, 0);
  } finally { await d.close(); }
});

test('new message while an approval is pending supersedes it and keeps history valid', async () => {
  const d = await startDexter({ claude });
  try {
    const m = d.app.memory.create({ content: 'Old preference to delete', kind: 'preference' });
    const convId = await newConv(d);
    claude.reply({ content: [toolUse('del1', 'delete_memory', { memory_id: m.id, reason: 'outdated' })], stop_reason: 'tool_use' });
    await d.request('POST', `/api/conversations/${convId}/messages`, { text: 'Forget my old preference.' });
    await runTo(d, convId, 'awaiting_approval');
    claude.reply((body) => {
      const roles = body.messages.map((x) => x.role);
      assert.deepEqual(roles, ['user', 'system', 'assistant', 'user', 'user', 'system']);
      const closing = body.messages[3].content[0];
      assert.equal(closing.tool_use_id, 'del1');
      assert.equal(closing.is_error, true);
      return { content: [text('Okay, never mind.')], stop_reason: 'end_turn' };
    });
    await d.request('POST', `/api/conversations/${convId}/messages`, { text: 'Actually, keep it.' });
    await runTo(d, convId, 'completed');
    assert.ok(d.app.memory.get(m.id), 'memory was not deleted');
    const appr = (await d.request('GET', '/api/approvals')).data.approvals[0];
    assert.equal(appr.status, 'superseded');
  } finally { await d.close(); }
});

test('refusal, invalid tool JSON, and optional-feature downgrade are handled honestly', async () => {
  const d = await startDexter({ claude });
  try {
    const convId = await newConv(d);
    // 1) 400 naming an optional field -> retried without it
    claude.reply({ httpError: { status: 400, message: 'fallbacks: unknown parameter' } }, { content: [text('Hello!')], stop_reason: 'end_turn' });
    await d.request('POST', `/api/conversations/${convId}/messages`, { text: 'hi' });
    await runTo(d, convId, 'completed');
    assert.equal(claude.requests.at(-1).body.fallbacks, undefined);

    // 2) invalid JSON in a tool call -> INVALID_JSON result, tool not run
    claude.reply({ content: [{ type: 'tool_use', id: 'bad1', name: 'create_task', input: {}, rawJson: '{"title": "unterminated' }], stop_reason: 'tool_use' },
      (body) => {
        const r = body.messages.at(-1).content[0];
        assert.equal(r.is_error, true);
        assert.match(r.content, /INVALID_JSON/);
        return { content: [text('Retrying differently.')], stop_reason: 'end_turn' };
      });
    await d.request('POST', `/api/conversations/${convId}/messages`, { text: 'make a task' });
    await runTo(d, convId, 'completed');
    assert.equal((await d.request('GET', '/api/tasks')).data.tasks.length, 0);

    // 3) refusal -> run failed, message excluded from later context
    claude.reply({ content: [text('partial')], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } });
    await d.request('POST', `/api/conversations/${convId}/messages`, { text: 'something declined' });
    const v = await runTo(d, convId, 'failed');
    assert.match(v.runs[0].error, /declined/);
    claude.reply((body) => {
      assert.ok(!body.messages.some((m) => m.role === 'assistant' && m.content.some((b) => b.text === 'partial')), 'declined output is not replayed');
      return { content: [text('ok')], stop_reason: 'end_turn' };
    });
    await d.request('POST', `/api/conversations/${convId}/messages`, { text: 'next' });
    await runTo(d, convId, 'completed');

    // 4) Claude API outage -> failed run with a clear error, not a fake answer
    claude.reply({ httpError: { status: 401, type: 'authentication_error', message: 'invalid x-api-key' } });
    await d.request('POST', `/api/conversations/${convId}/messages`, { text: 'are you there?' });
    const v2 = await runTo(d, convId, 'failed');
    assert.match(v2.runs[0].error, /rejected the API key/);
  } finally { await d.close(); }
});

test('Dexter cannot finish a task without an outcome, and running work syncs task status', async () => {
  const d = await startDexter({ claude });
  try {
    const task = (await d.request('POST', '/api/tasks', { title: 'Summarise reading' })).data.task;
    claude.reply(
      { content: [toolUse('u1', 'update_task', { task_id: task.id, status: 'running' }), toolUse('u2', 'update_task', { task_id: task.id, status: 'completed' })], stop_reason: 'tool_use' },
      (body) => {
        const [r1, r2] = body.messages.at(-1).content;
        assert.notEqual(r1.is_error, true);
        assert.equal(r2.is_error, true);
        assert.match(r2.content, /requires an outcome/);
        return { content: [toolUse('u3', 'update_task', { task_id: task.id, status: 'completed', outcome: 'Wrote a 5-point summary (document doc_x).' })], stop_reason: 'tool_use' };
      },
      { content: [text('Completed.')], stop_reason: 'end_turn' },
    );
    const r = await d.request('POST', `/api/tasks/${task.id}/resume`);
    assert.equal(r.status, 202);
    const convId = r.data.run.conversation_id;
    await runTo(d, convId, 'completed');
    const detail = (await d.request('GET', `/api/tasks/${task.id}`)).data;
    assert.equal(detail.task.status, 'completed');
    assert.equal(detail.task.outcome, 'Wrote a 5-point summary (document doc_x).');
    assert.ok(detail.events.some((e) => e.type === 'status' && e.data.to === 'running'));
    assert.equal(detail.runs[0].status, 'completed');
  } finally { await d.close(); }
});
