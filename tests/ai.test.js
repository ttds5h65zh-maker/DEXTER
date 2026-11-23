// The AI path, exercised with a stand-in client (no network, no key).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Dexter } from '../lib/core.js';
import { loadAI, createAnthropicAI } from '../lib/ai.js';

const fakeAI = (reply) => {
  const calls = [];
  const ai = createAnthropicAI({
    model: 'claude-opus-5-5',
    client: { messages: { create: async (req) => { calls.push(req); return typeof reply === 'function' ? reply(req) : reply; } } },
  });
  ai.calls = calls;
  return ai;
};
const toolReply = (name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name, input }] });
const TEXT = 'Hi,\n\nThe lab report is due next Monday at noon.\nWe agreed to drop question 4.\n';

test('without a key, AI is reported as off with the reason', async () => {
  const off = await loadAI({});
  assert.deepEqual([off.available, off.reason, off.model], [false, 'no_key', 'claude-opus-5-5']);
  assert.equal((await loadAI({ ANTHROPIC_API_KEY: 'x', DEXTER_AI: 'off' })).reason, 'disabled');
});

test('AI findings are kept only when their passage is in the source, and Dexter resolves the dates', async () => {
  const ai = fakeAI(toolReply('record_findings', {
    findings: [
      { type: 'deadline', title: 'Submit the lab report', quote: 'The lab report is due next   Monday at noon.', date_phrase: 'next Monday at noon', date_reading: '2026-11-16 12:00' },
      { type: 'decision', title: 'Question 4 dropped', quote: 'We agreed to drop question 4.', date_phrase: '', date_reading: '' },
      { type: 'question', title: 'Invented', quote: 'This sentence is not in the source.', date_phrase: '', date_reading: '' },
    ],
  }));
  const dexter = new Dexter({ ai });
  const source = await dexter.importSource({ kind: 'note', text: TEXT, sourceDate: '2026-11-10' });
  const findings = dexter.state.findings;
  assert.equal(findings.length, 2);
  assert.equal(source.extraction.mode, 'ai');
  assert.match(source.extraction.notice, /1 AI suggestion/);
  const report = findings.find((f) => f.type === 'deadline');
  assert.equal(report.origin, 'ai');
  assert.equal(TEXT.slice(report.evidence.start, report.evidence.end), 'The lab report is due next Monday at noon.');
  assert.deepEqual([report.date.date, report.date.time, report.date.status], ['2026-11-16', '12:00', 'needs_confirmation']);
  const req = ai.calls[0];
  assert.equal(req.model, 'claude-opus-5-5');
  assert.equal(req.tools[0].strict, true);
  assert.ok(req.messages[0].content.includes(TEXT));
});

test('if the AI call fails or is declined, Dexter falls back to its rules and says so', async () => {
  for (const reply of [() => { throw new Error('529 overloaded'); }, { stop_reason: 'refusal', content: [] }]) {
    const dexter = new Dexter({ ai: fakeAI(reply) });
    const source = await dexter.importSource({ kind: 'note', text: TEXT, sourceDate: '2026-11-10' });
    assert.equal(source.extraction.mode, 'rules');
    assert.match(source.extraction.notice, /built-in rules instead/);
    assert.equal(dexter.state.findings.length, 2);
  }
});

test('AI drafts still arrive as drafts that need review', async () => {
  const ai = fakeAI((req) => (req.tools[0].name === 'write_draft'
    ? toolReply('write_draft', { subject: 'Lab report', body: 'Hello,\n\nCould you confirm the deadline?\n' })
    : toolReply('record_findings', { findings: [{ type: 'deadline', title: 'Submit the lab report', quote: 'The lab report is due next Monday at noon.', date_phrase: 'next Monday at noon', date_reading: '2026-11-16 12:00' }] })));
  const dexter = new Dexter({ ai });
  await dexter.importSource({ kind: 'note', text: TEXT, sourceDate: '2026-11-10' });
  const draft = await dexter.createDraft({ findingId: dexter.state.findings[0].id, kind: 'email' });
  assert.deepEqual([draft.origin, draft.status, draft.subject], ['ai', 'needs_review', 'Lab report']);
  assert.throws(() => dexter.completeDraft(draft.id), /Approve this draft/);
});

test('an Arabic date Dexter cannot read uses the AI reading, always marked for confirmation', async () => {
  const text = 'تذكير: يجب تسليم التقرير يوم الخميس القادم قبل الساعة الخامسة مساءً.';
  const ai = fakeAI(toolReply('record_findings', {
    findings: [{ type: 'deadline', title: 'تسليم التقرير', quote: text, date_phrase: 'يوم الخميس القادم قبل الساعة الخامسة مساءً', date_reading: '2026-11-19 17:00' }],
  }));
  const dexter = new Dexter({ ai });
  await dexter.importSource({ kind: 'note', text, sourceDate: '2026-11-12' });
  const f = dexter.state.findings[0];
  assert.deepEqual([f.date.date, f.date.time, f.date.status], ['2026-11-19', '17:00', 'needs_confirmation']);
  assert.match(f.date.reasons[0], /AI’s reading/);
  assert.throws(() => dexter.taskFromFinding(f.id), /Confirm the date/);
});

test('server-side fallbacks are requested, and dropped if the account does not accept them', async () => {
  const seen = [];
  const reply = toolReply('record_findings', { findings: [] });
  const make = (rejectBeta) => createAnthropicAI({
    model: 'claude-opus-5-5',
    client: {
      beta: { messages: { create: async (req) => { seen.push(['beta', req.betas, req.fallbacks]); if (rejectBeta) { const e = new Error('400 fallbacks: unknown parameter'); e.status = 400; throw e; } return reply; } } },
      messages: { create: async (req) => { seen.push(['plain', req.betas, req.fallbacks]); return reply; } },
    },
  });
  await new Dexter({ ai: make(false) }).importSource({ kind: 'note', text: TEXT, sourceDate: '2026-11-10' });
  assert.deepEqual(seen.shift(), ['beta', ['server-side-fallback-2026-07-01'], 'default']);
  const ai = make(true);
  const dexter = new Dexter({ ai });
  const source = await dexter.importSource({ kind: 'note', text: TEXT, sourceDate: '2026-11-10' });
  assert.deepEqual(seen.splice(0), [['beta', ['server-side-fallback-2026-07-01'], 'default'], ['plain', undefined, undefined]]);
  assert.equal(source.extraction.mode, 'ai');
  await dexter.reextract(source.id);
  assert.deepEqual(seen.splice(0), [['plain', undefined, undefined]], 'not asked again once refused');
});
