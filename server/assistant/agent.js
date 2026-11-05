// The agent loop: conversation turn → streamed model response → tool calls
// (executed, or paused for approval/handoff) → results → next model turn.
// Every step is persisted, so a restart leaves an honest "interrupted" state
// that can be resumed without repeating confirmed external actions.
import { newId, hashObject } from '../lib/ids.js';
import { now, parseJson } from '../db.js';
import { badRequest, conflict, HttpError } from '../lib/http.js';
import { validateSchema } from '../lib/validate.js';
import { log } from '../lib/log.js';
import { oneLine } from '../lib/text.js';
import { systemPrompt } from './prompt.js';
import { buildContext } from './context.js';
import { ModelError } from './anthropic.js';
import { displayItemsFromContent } from '../services/conversations.js';
import { NeedsUserError, NotConnectedError } from '../tools/errors.js';
import { runCommand, isCommand } from './commands.js';

const MAX_STEPS = 30;
const DONE_TOOL_STATES = new Set(['succeeded', 'failed', 'declined', 'unknown']);
const ACTIVE_RUN_STATES = ['running', 'awaiting_approval', 'blocked'];

export function createAgent(app) {
  const { db, bus } = app;
  const controllers = new Map();
  const driving = new Set();
  const waiters = new Map();

  const modelReady = () => Boolean(app.config.anthropic.apiKey);

  // ---------------------------------------------------------------- runs ----
  function getRun(id) {
    const r = db.get('SELECT * FROM runs WHERE id = ?', id);
    return r && { ...r, untrusted_sources: parseJson(r.untrusted_sources, []), usage: parseJson(r.usage, {}) };
  }

  function createRun(conversationId, { trigger = 'chat', task_id = null, job_run_id = null } = {}) {
    const r = { id: newId('run'), conversation_id: conversationId, task_id, job_run_id, status: 'running', trigger, model: app.settings.get('model').id, started_at: now(), updated_at: now() };
    db.run('INSERT INTO runs (id, conversation_id, task_id, job_run_id, status, trigger, model, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      r.id, r.conversation_id, r.task_id, r.job_run_id, r.status, r.trigger, r.model, r.started_at, r.updated_at);
    publishRun(r.id);
    return getRun(r.id);
  }

  function publishRun(id) {
    const r = getRun(id);
    if (r) bus.publish('run.updated', { run: { id: r.id, conversation_id: r.conversation_id, task_id: r.task_id, status: r.status, error: r.error, trigger: r.trigger, started_at: r.started_at, finished_at: r.finished_at } });
  }

  function setRun(id, fields) {
    const keys = Object.keys(fields);
    db.run(`UPDATE runs SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => fields[k]), now(), id);
    publishRun(id);
  }

  function settle(runId) {
    const run = getRun(runId);
    for (const fn of waiters.get(runId) || []) fn(run);
    waiters.delete(runId);
  }

  /** Resolve when the run finishes or pauses for Sultan. */
  function waitForRun(runId) {
    const run = getRun(runId);
    if (run && !['running'].includes(run.status)) return Promise.resolve(run);
    return new Promise((resolve) => {
      if (!waiters.has(runId)) waiters.set(runId, []);
      waiters.get(runId).push(resolve);
    });
  }

  function syncTask(run, runStatus, detail) {
    if (!run.task_id) return;
    const t = app.tasks.get(run.task_id);
    if (!t || ['completed', 'cancelled', 'failed'].includes(t.status)) return;
    const map = {
      running: { status: 'running' },
      awaiting_approval: { status: 'awaiting_approval' },
      blocked: { status: 'blocked', blocked_reason: detail || 'Waiting for you' },
      interrupted: { status: 'blocked', blocked_reason: detail || 'Interrupted — resume to continue' },
      failed: { status: 'blocked', blocked_reason: detail ? `Run failed: ${oneLine(detail, 120)}` : 'Run failed' },
    };
    if (map[runStatus]) {
      if (t.status !== map[runStatus].status || (map[runStatus].blocked_reason && t.blocked_reason !== map[runStatus].blocked_reason)) {
        app.tasks.update(t.id, map[runStatus], { actor: 'dexter' });
      }
    } else if ((runStatus === 'completed' || runStatus === 'cancelled') && ['running', 'awaiting_approval', 'blocked'].includes(t.status)) {
      app.tasks.update(t.id, { status: 'planned' }, { actor: 'dexter', note: runStatus === 'cancelled' ? 'Work stopped by you' : 'Dexter finished this run without recording a final outcome; the task stays open.' });
    }
  }

  function finishRun(runId, status, error = null) {
    setRun(runId, { status, error, finished_at: ['completed', 'failed', 'cancelled', 'interrupted'].includes(status) ? now() : null });
    const run = getRun(runId);
    syncTask(run, status, error);
    if (status === 'failed' || status === 'interrupted') {
      app.notifications.notify({
        title: status === 'failed' ? 'Dexter hit a problem' : 'Work was interrupted', body: error || '', level: 'error', source_type: 'run', source_id: runId,
        link: `#/chat/${run.conversation_id}`, dedupe_key: `run:${runId}:${status}`, push: false,
      }).catch(() => {});
    }
    settle(runId);
  }

  // ------------------------------------------------------------- tool calls -
  function getToolCall(id) {
    const t = db.get('SELECT * FROM tool_calls WHERE id = ?', id);
    return t && { ...t, input: parseJson(t.input, {}), result: parseJson(t.result, null), is_error: Boolean(t.is_error) };
  }

  function publishToolCall(id) {
    const t = getToolCall(id);
    if (t) {
      const { result, ...rest } = t;
      bus.publish('tool.updated', { tool_call: rest });
    }
  }

  function setToolCall(id, fields) {
    const keys = Object.keys(fields);
    const vals = keys.map((k) => (k === 'result' ? JSON.stringify(fields[k]) : k === 'is_error' ? (fields[k] ? 1 : 0) : fields[k]));
    db.run(`UPDATE tool_calls SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...vals, id);
    publishToolCall(id);
  }

  function setToolResult(id, status, content, { summary = null, external_ref = null, error = null } = {}) {
    setToolCall(id, { status, result: content, is_error: status !== 'succeeded', summary, external_ref, error, finished_at: now() });
  }

  function toolContext(run, tc) {
    return {
      app, run, toolCallId: tc.id, conversationId: run.conversation_id, tz: app.settings.timezone(),
      get taskId() { return getRun(run.id).task_id; },
      bindTask(taskId) {
        const current = getRun(run.id);
        if (!current.task_id) { setRun(run.id, { task_id: taskId }); run.task_id = taskId; }
      },
      markUntrusted(source, label) {
        const current = getRun(run.id);
        const list = current.untrusted_sources;
        if (!list.some((s) => s.source === source && s.label === label)) {
          list.push({ source, label: oneLine(label, 100) });
          setRun(run.id, { untrusted_sources: JSON.stringify(list.slice(-20)) });
        }
      },
    };
  }

  async function execute(run, tc, tool, { approval = null, grant = null } = {}) {
    setToolCall(tc.id, { status: 'running', started_at: now() });
    const ctx = toolContext(run, tc);
    try {
      const out = await tool.run(tc.input, ctx);
      const content = out?.content ?? 'Done.';
      setToolResult(tc.id, 'succeeded', content, { summary: out?.summary || null, external_ref: out?.external_ref || null });
      if (approval) app.approvals.markOutcome(approval.id, { status: 'executed', result_summary: out?.summary || null, external_ref: out?.external_ref || null });
      const taskId = getRun(run.id).task_id;
      if (taskId && out?.summary && tool.risk !== 'read') {
        app.tasks.addEvent(taskId, 'action', out.summary + (grant ? ' (covered by your standing authorization)' : ''), { tool: tool.name, external_ref: out.external_ref || null, tool_call_id: tc.id });
      }
      return 'done';
    } catch (err) {
      if (err instanceof NeedsUserError) {
        const h = await app.approvals.createHandoff({ kind: err.kind, run_id: run.id, tool_call_id: tc.id, title: err.title, message: err.message, url: err.url, screenshot_file_id: err.screenshot_file_id });
        setToolCall(tc.id, { status: 'waiting_user', handoff_id: h.id, summary: err.title });
        return 'waiting';
      }
      const message = err instanceof NotConnectedError ? `Not connected: ${err.message}` : `Error: ${err.message}`;
      if (!(err instanceof NotConnectedError)) log.warn('tool failed', { tool: tool.name, error: err.message });
      setToolResult(tc.id, 'failed', message, { error: err.message, summary: `${tool.label || tool.name} failed` });
      if (approval) app.approvals.markOutcome(approval.id, { status: 'failed', result_summary: err.message });
      return 'failed';
    }
  }

  function lastAssistantMessage(conversationId, runId) {
    const msgs = app.conversations.messages(conversationId).filter((m) => !m.excluded);
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.kind === 'assistant') {
        if (runId && m.run_id !== runId) return null;
        const answered = msgs.slice(i + 1).some((x) => x.kind === 'tool_results');
        return { message: m, answered };
      }
      if (m.kind === 'user') return null;
    }
    return null;
  }

  async function processToolUses(run, { message = null, invalid = new Map() } = {}) {
    let target = message;
    if (!target) {
      const last = lastAssistantMessage(run.conversation_id, run.id);
      if (!last || last.answered) return { paused: null };
      target = last.message;
    }
    const blocks = target.content.filter((b) => b.type === 'tool_use');
    if (!blocks.length) return { paused: null };
    const perms = app.settings.get('permissions');
    let paused = null;

    for (const [i, b] of blocks.entries()) {
      const tool = app.tools.get(b.name);
      let tc = getToolCall(b.id);
      if (!tc) {
        db.run(`INSERT INTO tool_calls (id, run_id, conversation_id, message_id, position, name, input, input_hash, risk, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`, b.id, run.id, run.conversation_id, target.id, i, b.name, JSON.stringify(b.input || {}),
        hashObject({ tool: b.name, input: b.input || {} }), tool?.risk || 'unknown', now());
        tc = getToolCall(b.id);
        publishToolCall(b.id);
      }
      if (DONE_TOOL_STATES.has(tc.status)) continue;

      if (tc.status === 'awaiting_approval') {
        const a = app.approvals.get(tc.approval_id);
        if (a?.status === 'pending') { paused = paused || 'awaiting_approval'; continue; }
        if (a?.status === 'approved') { await execute(run, tc, tool, { approval: a }); continue; }
        setToolResult(tc.id, 'declined', a?.status === 'rejected'
          ? `${app.settings.get('profile').name} declined this action${a.decision_note ? `: ${a.decision_note}` : ''}. It was not executed. Do not retry it unchanged.`
          : 'This action was not approved and was not executed.', { summary: 'Declined' });
        continue;
      }
      if (tc.status === 'waiting_user') {
        const h = db.get('SELECT * FROM handoffs WHERE id = ?', tc.handoff_id);
        if (h?.status === 'waiting') { paused = paused || 'blocked'; continue; }
        if (h?.status !== 'resolved') {
          setToolResult(tc.id, 'failed', 'Sultan cancelled the hand-off, so this step was not completed.', { summary: 'Hand-off cancelled' });
          continue;
        }
        setToolCall(tc.id, { status: 'pending' }); // resolved: try the step again
      }

      if (!tool) { setToolResult(tc.id, 'failed', `Error: unknown tool "${b.name}"`); continue; }
      if (invalid.has(b.id)) { setToolResult(tc.id, 'failed', JSON.stringify({ INVALID_JSON: invalid.get(b.id) }), { summary: 'Invalid tool input' }); continue; }
      const errors = validateSchema(tool.input_schema, tc.input);
      if (errors.length) { setToolResult(tc.id, 'failed', `Error: invalid input — ${errors.join('; ')}`, { summary: 'Invalid tool input' }); continue; }
      if (tool.permission && perms[tool.permission] === false) {
        setToolResult(tc.id, 'failed', `Not allowed: the "${tool.permission.replace(/_/g, ' ')}" permission is turned off in Settings → Permissions.`, { summary: 'Blocked by permissions' });
        continue;
      }

      const ctx = toolContext(run, tc);
      const needsApproval = typeof tool.approval === 'function' ? tool.approval(tc.input, ctx) : Boolean(tool.approval);
      if (needsApproval) {
        // Idempotency: the identical action already ran successfully in this run.
        const prior = db.get("SELECT id, result, summary, external_ref FROM tool_calls WHERE run_id = ? AND input_hash = ? AND status = 'succeeded' AND id != ?", run.id, tc.input_hash, tc.id);
        if (prior) {
          setToolResult(tc.id, 'succeeded', parseJson(prior.result, 'Done.'), { summary: `${prior.summary || 'Done'} (already done earlier in this run — not repeated)`, external_ref: prior.external_ref });
          continue;
        }
        const scope = tool.grantScope ? tool.grantScope(tc.input, ctx) : null;
        const grant = scope ? app.approvals.findGrant(tool.name, scope) : null;
        if (grant) {
          app.approvals.useGrant(grant.id);
          await execute(run, tc, tool, { grant });
          continue;
        }
        let preview;
        try { preview = await tool.preview(tc.input, ctx); } catch (err) {
          setToolResult(tc.id, 'failed', `Error: ${err.message}`, { summary: 'Could not prepare this action' });
          continue;
        }
        const current = getRun(run.id);
        const approval = await app.approvals.create({
          tool_call_id: tc.id, run_id: run.id, conversation_id: run.conversation_id, task_id: current.task_id, tool: tool.name,
          title: preview.title, summary: preview.summary, preview, input: tc.input, grant_scope: scope, provenance: current.untrusted_sources,
        });
        setToolCall(tc.id, { status: 'awaiting_approval', approval_id: approval.id, summary: `Awaiting approval: ${preview.title}` });
        if (current.task_id) app.tasks.addEvent(current.task_id, 'approval', `Approval requested: ${preview.title}`, { approval_id: approval.id });
        paused = paused || 'awaiting_approval';
        continue;
      }
      const outcome = await execute(run, tc, tool);
      if (outcome === 'waiting') paused = paused || 'blocked';
    }

    if (paused) return { paused };
    const results = blocks.map((b) => {
      const tc = getToolCall(b.id);
      const block = { type: 'tool_result', tool_use_id: b.id, content: tc.result ?? 'No result' };
      if (tc.is_error) block.is_error = true;
      return block;
    });
    app.conversations.appendMessage(run.conversation_id, { role: 'user', kind: 'tool_results', content: results, run_id: run.id });
    return { paused: null };
  }

  /** Answer any unanswered tool calls so the history stays valid before a new user turn. */
  function closeOpenToolUses(conversationId, reason) {
    const last = lastAssistantMessage(conversationId);
    if (!last || last.answered) return;
    const blocks = last.message.content.filter((b) => b.type === 'tool_use');
    if (!blocks.length) return;
    const results = blocks.map((b) => {
      const tc = getToolCall(b.id);
      if (tc && DONE_TOOL_STATES.has(tc.status) && tc.result != null) {
        return { type: 'tool_result', tool_use_id: b.id, content: tc.result, ...(tc.is_error ? { is_error: true } : {}) };
      }
      if (tc) setToolResult(tc.id, 'declined', reason, { summary: 'Not executed' });
      return { type: 'tool_result', tool_use_id: b.id, content: reason, is_error: true };
    });
    app.conversations.appendMessage(conversationId, { role: 'user', kind: 'tool_results', content: results, run_id: last.message.run_id });
  }

  function supersedePaused(conversationId) {
    const paused = db.all(`SELECT id FROM runs WHERE conversation_id = ? AND status IN ('awaiting_approval','blocked','interrupted','failed')`, conversationId);
    const reason = 'Not executed: Sultan sent a new message before this step was approved or completed.';
    for (const r of paused) {
      app.approvals.supersedeForRun(r.id);
      db.run("UPDATE handoffs SET status = 'cancelled', resolved_at = ? WHERE run_id = ? AND status = 'waiting'", now(), r.id);
      const run = getRun(r.id);
      if (['awaiting_approval', 'blocked'].includes(run.status)) {
        db.run("UPDATE tool_calls SET status = 'declined', result = ?, is_error = 1, summary = 'Not executed (superseded)', finished_at = ? WHERE run_id = ? AND status IN ('awaiting_approval','waiting_user','pending')",
          JSON.stringify(reason), now(), r.id);
        finishRun(r.id, 'cancelled', 'Superseded by a newer message');
      }
    }
    closeOpenToolUses(conversationId, reason);
  }

  function appendContext(conversationId, text, note) {
    app.conversations.appendMessage(conversationId, { role: 'system', kind: 'context', content: [{ type: 'text', text: buildContext(app, { text, conversationId, note }) }] });
  }

  // --------------------------------------------------------- streaming ------
  function makeTracker(message, run) {
    const items = new Map();
    let dirty = false; let timer = null;
    const serialize = () => [...items.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v).filter((v) => !(v.type === 'progress' && !v.text.trim()) && !(v.type === 'text' && !v.text));
    const persist = () => {
      if (!dirty) return;
      dirty = false;
      app.conversations.updateMessage(message.id, { partial: serialize() });
    };
    const schedule = () => { dirty = true; if (!timer) timer = setTimeout(() => { timer = null; persist(); }, 400); };
    const base = { run_id: run.id, conversation_id: run.conversation_id, message_id: message.id };
    return {
      items: serialize,
      flush() { if (timer) { clearTimeout(timer); timer = null; } dirty = true; persist(); },
      onEvent(ev) {
        if (ev.type === 'block_start') {
          const b = ev.block;
          let item = null;
          if (b.type === 'text') item = { type: 'text', text: b.text || '', citations: [] };
          else if (b.type === 'thinking') item = { type: 'progress', text: b.thinking || '' };
          else if (b.type === 'tool_use') item = { type: 'tool', id: b.id, name: b.name, preparing: true };
          else if (b.type === 'server_tool_use') item = { type: 'server_tool', id: b.id, name: b.name, input: {} };
          else {
            const d = displayItemsFromContent([b]);
            if (d.length) item = d[0];
          }
          if (item) { items.set(ev.index, item); bus.publish('run.block', { ...base, index: ev.index, item }); schedule(); }
        } else if (ev.type === 'text' || ev.type === 'thinking') {
          const item = items.get(ev.index);
          if (item) { item.text += ev.text; bus.publish('run.delta', { ...base, index: ev.index, text: ev.text }); schedule(); }
        } else if (ev.type === 'citation') {
          const item = items.get(ev.index);
          const c = ev.citation;
          if (item?.citations && c?.url && !item.citations.some((x) => x.url === c.url)) {
            item.citations.push({ url: c.url, title: c.title || c.url });
            bus.publish('run.block', { ...base, index: ev.index, item });
          }
        } else if (ev.type === 'block_stop') {
          const item = items.get(ev.index);
          if (item?.type === 'server_tool') { item.input = ev.block.input || {}; bus.publish('run.block', { ...base, index: ev.index, item }); }
          if (item?.type === 'tool') { item.preparing = false; bus.publish('run.block', { ...base, index: ev.index, item }); }
        }
      },
    };
  }

  function friendlyError(err) {
    if (err instanceof ModelError) {
      if (err.type === 'not_configured') return 'Claude is not connected: set ANTHROPIC_API_KEY on the server and restart Dexter.';
      if (err.status === 429) return 'The Claude API is rate-limiting requests right now. Try again in a minute.';
      if (err.status === 529 || err.type === 'overloaded_error') return 'The Claude API is overloaded right now. Try again shortly.';
      return `Claude API error: ${err.message}`;
    }
    return err.message || String(err);
  }

  async function drive(runId, { processPending = false } = {}) {
    let run = getRun(runId);
    if (!run) return;
    if (driving.has(run.conversation_id)) return;
    driving.add(run.conversation_id);
    const controller = new AbortController();
    controllers.set(runId, controller);
    setRun(runId, { status: 'running', error: null, finished_at: null });
    run = getRun(runId);
    syncTask(run, 'running');
    try {
      if (processPending) {
        const r = await processToolUses(run);
        if (controller.signal.aborted) throw new ModelError('aborted', { type: 'aborted' });
        if (r.paused) { pause(runId, r.paused); return; }
      }
      for (;;) {
        run = getRun(runId);
        if (run.steps >= MAX_STEPS) throw new Error(`Stopped after ${MAX_STEPS} model calls in one run to avoid a runaway loop. Ask Dexter to continue if more work is needed.`);
        const modelCfg = app.settings.get('model');
        const perms = app.settings.get('permissions');
        const history = app.conversations.apiMessages(run.conversation_id);
        const msg = app.conversations.appendMessage(run.conversation_id, { role: 'assistant', kind: 'assistant', status: 'streaming', run_id: runId, partial: [] });
        bus.publish('run.message', { run_id: runId, conversation_id: run.conversation_id, message: { id: msg.id, seq: msg.seq, role: 'assistant', kind: 'assistant', status: 'streaming', run_id: runId, items: [], created_at: msg.created_at } });
        const tracker = makeTracker(msg, run);
        let result;
        try {
          result = await app.model.stream({
            model: modelCfg.id, system: systemPrompt(app.settings.get('profile')), messages: history, tools: app.tools.definitions(),
            effort: modelCfg.effort, maxTokens: modelCfg.max_tokens, webSearch: modelCfg.web_search && perms.web_research !== false,
          }, { signal: controller.signal, onEvent: tracker.onEvent });
        } catch (err) {
          tracker.flush();
          app.conversations.updateMessage(msg.id, { status: controller.signal.aborted ? 'cancelled' : 'interrupted', excluded: 1 });
          bus.publish('run.message.complete', { run_id: runId, conversation_id: run.conversation_id, message: app.conversations.view(run.conversation_id).messages.find((m) => m.id === msg.id) });
          throw err;
        }
        tracker.flush();
        const usage = getRun(runId).usage;
        for (const [k, v] of Object.entries(result.usage || {})) if (typeof v === 'number') usage[k] = (usage[k] || 0) + v;
        setRun(runId, { steps: run.steps + 1, usage: JSON.stringify(usage), model: result.model || modelCfg.id });

        const hasToolUse = result.content.some((b) => b.type === 'tool_use');
        if (result.stop_reason === 'refusal') {
          app.conversations.updateMessage(msg.id, { status: 'declined', excluded: 1, partial: [...tracker.items(), { type: 'notice', text: 'The model declined to continue with this request.' }] });
          publishFinal(run, msg.id);
          finishRun(runId, 'failed', `The model declined this request${result.stop_details?.category ? ` (${result.stop_details.category})` : ''}.`);
          return;
        }
        if (result.stop_reason === 'max_tokens' && hasToolUse) {
          app.conversations.updateMessage(msg.id, { status: 'interrupted', excluded: 1 });
          publishFinal(run, msg.id);
          finishRun(runId, 'failed', 'The response hit the output limit in the middle of a tool call, so nothing was executed. Raise "Max output tokens" in Settings → Model, or ask for a smaller step.');
          return;
        }
        app.conversations.updateMessage(msg.id, { content: result.content, status: 'complete', partial: null, meta: { model: result.model, stop_reason: result.stop_reason } });
        publishFinal(run, msg.id);

        if (result.stop_reason === 'tool_use' && hasToolUse) {
          const r = await processToolUses(getRun(runId), { message: app.conversations.getMessage(msg.id), invalid: result.invalidToolInputs });
          if (controller.signal.aborted) throw new ModelError('aborted', { type: 'aborted' });
          if (r.paused) { pause(runId, r.paused); return; }
          continue;
        }
        if (result.stop_reason === 'pause_turn') continue;
        finishRun(runId, 'completed', result.stop_reason === 'max_tokens' ? 'The reply was cut off at the output limit.' : null);
        return;
      }
    } catch (err) {
      if (controller.signal.aborted || err?.type === 'aborted') {
        closeOpenToolUses(run.conversation_id, 'Not executed: Sultan stopped this run.');
        finishRun(runId, 'cancelled', 'Stopped by you');
      } else {
        log.warn('run failed', { run: runId, error: err.message });
        finishRun(runId, 'failed', friendlyError(err));
      }
    } finally {
      controllers.delete(runId);
      driving.delete(run.conversation_id);
    }
  }

  function publishFinal(run, messageId) {
    const view = app.conversations.view(run.conversation_id);
    bus.publish('run.message.complete', { run_id: run.id, conversation_id: run.conversation_id, message: view.messages.find((m) => m.id === messageId) || null });
  }

  function pause(runId, reason) {
    const run = getRun(runId);
    const waitingHandoff = reason === 'blocked' ? db.get("SELECT title FROM handoffs WHERE run_id = ? AND status = 'waiting' ORDER BY created_at DESC", runId) : null;
    setRun(runId, { status: reason, error: null });
    syncTask(getRun(runId), reason, waitingHandoff ? `Waiting for you: ${waitingHandoff.title}` : null);
    settle(runId);
  }

  // ------------------------------------------------------------ public ------
  async function sendMessage(conversationId, { text = '', file_ids = [] } = {}) {
    const conv = app.conversations.mustGet(conversationId);
    const clean = String(text || '').trim();
    if (!clean && !file_ids.length) throw badRequest('Write a message or attach a file');
    const active = db.get("SELECT id FROM runs WHERE conversation_id = ? AND status = 'running'", conversationId);
    if (active) throw conflict('Dexter is still working on the previous message. Wait for it to finish or press Stop.', 'run_active');
    if (isCommand(clean)) return runCommand(app, conv, clean);
    if (!modelReady()) {
      throw new HttpError(409, 'Claude is not connected yet. Add ANTHROPIC_API_KEY to the server .env and restart Dexter. Until then you can use commands like /task, /remind, /remember and /brief.', 'model_not_configured');
    }
    const files = file_ids.map((id) => app.files.mustGet(id));
    for (const f of files) if (!f.conversation_id) db.run('UPDATE files SET conversation_id = ? WHERE id = ?', conversationId, f.id);
    supersedePaused(conversationId);
    const content = [...files.flatMap((f) => app.files.toModelBlocks(f)), ...(clean ? [{ type: 'text', text: clean }] : [{ type: 'text', text: '(See the attached files.)' }])];
    const userMsg = app.conversations.appendMessage(conversationId, { role: 'user', kind: 'user', content, attachments: files.map((f) => f.id), meta: { text: clean } });
    if (conv.title === 'New conversation') app.conversations.update(conversationId, { title: oneLine(clean || files[0]?.name || 'Conversation', 60) });
    appendContext(conversationId, clean);
    const run = createRun(conversationId, { trigger: 'chat' });
    bus.publish('conversation.message', { conversation_id: conversationId, message_id: userMsg.id });
    drive(run.id).catch((err) => log.error('drive crashed', { error: err.message }));
    return { run: getRun(run.id), message_id: userMsg.id };
  }

  /** Start a run from a prompt that did not come from the chat box (jobs, task resume). */
  async function runPrompt(conversationId, prompt, { trigger = 'job', task_id = null, job_run_id = null, label = null, note = null } = {}) {
    if (!modelReady()) throw new HttpError(409, 'Claude is not connected (ANTHROPIC_API_KEY is not set).', 'model_not_configured');
    const active = db.get("SELECT id FROM runs WHERE conversation_id = ? AND status = 'running'", conversationId);
    if (active) throw conflict('Dexter is already working in this conversation.', 'run_active');
    supersedePaused(conversationId);
    app.conversations.appendMessage(conversationId, { role: 'user', kind: 'user', content: [{ type: 'text', text: prompt }], meta: { text: label || prompt, synthetic: trigger } });
    appendContext(conversationId, prompt, note);
    const run = createRun(conversationId, { trigger, task_id, job_run_id });
    drive(run.id).catch((err) => log.error('drive crashed', { error: err.message }));
    return getRun(run.id);
  }

  /** Continue a paused run after an approval decision or a resolved handoff. */
  async function resume(runId) {
    const run = getRun(runId);
    if (!run) return null;
    if (['awaiting_approval', 'blocked'].includes(run.status)) {
      await drive(runId, { processPending: true });
      return getRun(runId);
    }
    return run;
  }

  /** Resume interrupted or failed work. */
  async function retry(runId) {
    const run = getRun(runId);
    if (!run) throw badRequest('Unknown run');
    if (!['interrupted', 'failed'].includes(run.status)) throw conflict(`This run is ${run.status}; only interrupted or failed runs can be resumed.`);
    if (!modelReady()) throw new HttpError(409, 'Claude is not connected (ANTHROPIC_API_KEY is not set).', 'model_not_configured');
    const last = lastAssistantMessage(run.conversation_id, run.id);
    if (last && !last.answered && last.message.content.some((b) => b.type === 'tool_use')) {
      drive(runId, { processPending: true }).catch(() => {});
      return getRun(runId);
    }
    const task = run.task_id ? app.tasks.get(run.task_id) : null;
    const prompt = `Resume the work that was interrupted${task ? ` on task [${task.id}] "${task.title}"` : ''}. First check what was already completed (look at the tool results above and the task timeline) and do not repeat confirmed actions. Then continue and report the outcome.`;
    return runPrompt(run.conversation_id, prompt, { trigger: 'resume', task_id: run.task_id, label: 'Resume interrupted work' });
  }

  async function resumeTask(taskId) {
    const task = app.tasks.mustGet(taskId);
    if (['completed', 'cancelled'].includes(task.status)) throw conflict(`Task is ${task.status}`);
    if (!modelReady()) throw new HttpError(409, 'Claude is not connected (ANTHROPIC_API_KEY is not set), so Dexter cannot work on tasks yet.', 'model_not_configured');
    const latest = db.get('SELECT id, status FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1', taskId);
    if (latest && ACTIVE_RUN_STATES.includes(latest.status)) throw conflict(`Dexter's run for this task is ${latest.status.replace('_', ' ')}.`);
    if (latest && ['interrupted', 'failed'].includes(latest.status)) return retry(latest.id);
    let conversationId = task.conversation_id;
    if (!conversationId || !app.conversations.get(conversationId)) {
      conversationId = app.conversations.create({ title: `Task: ${oneLine(task.title, 50)}`, project_id: task.project_id }).id;
      db.run('UPDATE tasks SET conversation_id = ? WHERE id = ?', conversationId, taskId);
    }
    const prompt = `Work on task [${task.id}] "${task.title}".${task.description ? `\nDetails: ${task.description}` : ''}${task.due_at ? `\nDue: ${task.due_at}` : ''}\nSet it to running, do the work with your tools, then record the outcome. If you need something from me, say exactly what.`;
    return runPrompt(conversationId, prompt, { trigger: 'task', task_id: taskId, label: `Work on task: ${task.title}` });
  }

  function cancel(runId) {
    const run = getRun(runId);
    if (!run) throw badRequest('Unknown run');
    const c = controllers.get(runId);
    if (c) { c.abort(); return getRun(runId); }
    if (['awaiting_approval', 'blocked'].includes(run.status)) {
      app.approvals.supersedeForRun(runId, 'Run stopped by you');
      db.run("UPDATE handoffs SET status = 'cancelled', resolved_at = ? WHERE run_id = ? AND status = 'waiting'", now(), runId);
      closeOpenToolUses(run.conversation_id, 'Not executed: Sultan stopped this run.');
      finishRun(runId, 'cancelled', 'Stopped by you');
    }
    return getRun(runId);
  }

  /** On startup: mark work that was running when the server stopped. */
  function recover() {
    const stale = db.all("SELECT id FROM runs WHERE status = 'running'");
    db.run("UPDATE messages SET status = 'interrupted', excluded = 1 WHERE status = 'streaming'");
    const unknownText = 'Outcome unknown: Dexter stopped while this action was in progress. It was NOT retried automatically, because it may already have happened. Ask Sultan to check before trying again.';
    for (const tc of db.all("SELECT id, risk FROM tool_calls WHERE status = 'running'")) {
      if (tc.risk === 'act') {
        db.run("UPDATE tool_calls SET status = 'unknown', result = ?, is_error = 1, summary = 'Outcome unknown (interrupted)', finished_at = ? WHERE id = ?", JSON.stringify(unknownText), now(), tc.id);
        db.run("UPDATE approvals SET status = 'unknown', result_summary = ? WHERE tool_call_id = ? AND status = 'approved'", 'Interrupted while executing — outcome unknown', tc.id);
      } else {
        db.run("UPDATE tool_calls SET status = 'pending', started_at = NULL WHERE id = ?", tc.id);
      }
    }
    for (const r of stale) finishRun(r.id, 'interrupted', 'Dexter stopped while this was running (server restart). Resume to continue.');
    if (stale.length) log.info('marked interrupted runs', { count: stale.length });
    return stale.length;
  }

  return { sendMessage, runPrompt, resume, retry, resumeTask, cancel, recover, waitForRun, getRun, modelReady, processToolUses };
}
