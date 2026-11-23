// The AI path, exercised with a stand-in client (no network, no key).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Dexter } from '../lib/core.js';
import { loadAI } from '../lib/ai.js';

const fakeAI = (reply) => {
  const calls = [];
  return {
    calls,
    available: true,
    model: 'claude-opus-5-5',
    client: { messages: { create: async (req) => { calls.push(req); return typeof reply === 'function' ? reply(req) : reply; } } },
  };
};
const toolReply = (name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name, input }] });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dexter-ai-'));
const TEXT = 'Hi,\n\nThe lab report is due next Monday at noon.\nWe agreed to drop question 4.\n';

test('without a key, AI is reported as off with the reason', async () => {
  assert.deepEqual(await loadAI({}), { available: false, reason: 'no_key', model: 'claude-opus-5-5' });
  assert.equal((await loadAI({ ANTHROPIC_API_KEY: 'x', DEXTER_AI: 'off' })).reason, 'disabled');
});

test('AI findings are kept only when their passage is in the source, and Dexter resolves the dates', async () => {
  const ai = fakeAI(toolReply('record_findings', {
    findings: [
      { type: 'deadline', title: 'Submit the lab report', quote: 'The lab report is due next   Monday at noon.', date_phrase: 'next Monday at noon' },
      { type: 'decision', title: 'Question 4 dropped', quote: 'We agreed to drop question 4.', date_phrase: '' },
      { type: 'question', title: 'Invented', quote: 'This sentence is not in the source.', date_phrase: '' },
    ],
  }));
  const dexter = new Dexter({ dataDir: tmp(), ai });
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
    const dexter = new Dexter({ dataDir: tmp(), ai: fakeAI(reply) });
    const source = await dexter.importSource({ kind: 'note', text: TEXT, sourceDate: '2026-11-10' });
    assert.equal(source.extraction.mode, 'rules');
    assert.match(source.extraction.notice, /built-in rules instead/);
    assert.equal(dexter.state.findings.length, 2);
  }
});

test('AI drafts still arrive as drafts that need review', async () => {
  const ai = fakeAI((req) => (req.tools[0].name === 'write_draft'
    ? toolReply('write_draft', { subject: 'Lab report', body: 'Hello,\n\nCould you confirm the deadline?\n' })
    : toolReply('record_findings', { findings: [{ type: 'deadline', title: 'Submit the lab report', quote: 'The lab report is due next Monday at noon.', date_phrase: 'next Monday at noon' }] })));
  const dexter = new Dexter({ dataDir: tmp(), ai });
  await dexter.importSource({ kind: 'note', text: TEXT, sourceDate: '2026-11-10' });
  const draft = await dexter.createDraft({ findingId: dexter.state.findings[0].id, kind: 'email' });
  assert.deepEqual([draft.origin, draft.status, draft.subject], ['ai', 'needs_review', 'Lab report']);
  assert.throws(() => dexter.completeDraft(draft.id), /Approve this draft/);
});
