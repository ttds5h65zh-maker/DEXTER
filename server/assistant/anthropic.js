// Claude Messages API client over raw HTTP + SSE. (The official SDK cannot be
// installed in this zero-dependency build, so requests follow the documented
// wire format directly.) Handles streaming, retries, and graceful downgrade
// of optional beta features if an account rejects them.
import { log } from '../lib/log.js';

export const API_VERSION = '2026-10-21';

export class ModelError extends Error {
  constructor(message, { status = null, type = null, retryable = false } = {}) {
    super(message);
    this.status = status;
    this.type = type;
    this.retryable = retryable;
  }
}

const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-fable-5', 'claude-opus-5']);
const UPDATES_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-fable-5', 'claude-mythos-5-1']);
const MID_SYSTEM_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-fable-5', 'claude-fable-5-1', 'claude-mythos-5', 'claude-mythos-5-1', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
const DYNAMIC_SEARCH_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6']);

export function modelFeatures(model) {
  return {
    fallbacks: FALLBACK_MODELS.has(model),
    displayUpdates: UPDATES_MODELS.has(model),
    midSystem: MID_SYSTEM_MODELS.has(model),
    webSearchType: DYNAMIC_SEARCH_MODELS.has(model) ? 'web_search_20260209' : 'web_search_20250305',
  };
}

/**
 * Convert stored history into a valid request: drop internal fields, drop a
 * mid-conversation system message that is not followed by an assistant turn
 * (it can only happen after an interrupted reply), and for models without
 * mid-conversation system support, send context as a user text block.
 */
export function prepareMessages(history, model) {
  const { midSystem } = modelFeatures(model);
  const out = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.role === 'system') {
      const next = history[i + 1];
      const isLast = i === history.length - 1;
      if (!isLast && next.role !== 'assistant') continue;
      if (!midSystem) {
        out.push({ role: 'user', content: m.content.map((b) => (b.type === 'text' ? { type: 'text', text: `<dexter_context>\n${b.text}\n</dexter_context>` } : b)) });
        continue;
      }
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new ModelError('aborted', { type: 'aborted' })); }, { once: true });
});

export function createModelClient(config) {
  const downgraded = new Set();

  function headers(betas) {
    const h = {
      'content-type': 'application/json',
      'x-api-key': config.anthropic.apiKey,
      'anthropic-version': API_VERSION,
    };
    if (betas.length) h['anthropic-beta'] = betas.join(',');
    return h;
  }

  function buildBody({ model, system, messages, tools = [], effort = 'medium', maxTokens = 32000, webSearch = false }) {
    const f = modelFeatures(model);
    const betas = [];
    const thinking = { type: 'adaptive' };
    if (f.displayUpdates && !downgraded.has('display')) {
      thinking.display = 'updates';
      betas.push('thinking-display-updates-2026-08-18');
    }
    if (!downgraded.has('block_binding')) {
      thinking.block_binding = { prefix_mismatch_behavior: 'drop_block' };
      betas.push('thinking-binding-controls-2026-08-01');
    }
    const body = {
      model,
      max_tokens: maxTokens,
      stream: true,
      system: [{ type: 'text', text: system }],
      messages: prepareMessages(messages, model),
      thinking,
      output_config: { effort },
    };
    if (!downgraded.has('cache')) body.cache_control = { type: 'ephemeral' };
    if (f.fallbacks && !downgraded.has('fallbacks')) {
      body.fallbacks = 'default';
      betas.push('server-side-fallback-2026-07-01');
    }
    const apiTools = tools.map((t) => {
      const def = { name: t.name, description: t.description, input_schema: t.input_schema };
      if (!downgraded.has('eager')) def.eager_input_streaming = true;
      return def;
    });
    if (webSearch && !downgraded.has('web_search')) apiTools.push({ type: f.webSearchType, name: 'web_search', max_uses: 6 });
    if (apiTools.length) body.tools = apiTools;
    return { body, betas };
  }

  function maybeDowngrade(message) {
    const m = message.toLowerCase();
    const before = downgraded.size;
    if (m.includes('fallback')) downgraded.add('fallbacks');
    if (m.includes('display')) downgraded.add('display');
    if (m.includes('block_binding') || m.includes('prefix_mismatch')) downgraded.add('block_binding');
    if (m.includes('eager_input_streaming')) downgraded.add('eager');
    if (m.includes('cache_control')) downgraded.add('cache');
    if (m.includes('web_search')) downgraded.add('web_search');
    if (m.includes('anthropic-beta') || m.includes('beta header') || m.includes('unknown beta')) {
      downgraded.add('fallbacks'); downgraded.add('display'); downgraded.add('block_binding');
    }
    if (downgraded.size > before) log.warn('model request rejected an optional feature; retrying without it', { downgraded: [...downgraded] });
    return downgraded.size > before;
  }

  async function post(path, payload, betas, signal) {
    return fetch(`${config.anthropic.baseUrl}${path}`, { method: 'POST', headers: headers(betas), body: JSON.stringify(payload), signal });
  }

  async function errorFrom(res) {
    let msg = `HTTP ${res.status}`;
    let type = null;
    try {
      const j = await res.json();
      msg = j?.error?.message || msg;
      type = j?.error?.type || null;
    } catch { /* ignore */ }
    const retryable = [408, 409, 429, 500, 502, 503, 504, 529].includes(res.status);
    return new ModelError(msg, { status: res.status, type, retryable });
  }

  /**
   * Stream one model turn. Returns { id, model, content, stop_reason, stop_details, usage, invalidToolInputs }.
   */
  async function stream(params, { signal, onEvent = () => {} } = {}) {
    if (!config.anthropic.apiKey) throw new ModelError('ANTHROPIC_API_KEY is not set', { type: 'not_configured' });
    let attempt = 0;
    let downgradeTries = 0;
    let res;
    for (;;) {
      const { body, betas } = buildBody(params);
      try {
        res = await post('/v1/messages', body, betas, signal);
      } catch (err) {
        if (signal?.aborted) throw new ModelError('aborted', { type: 'aborted' });
        if (attempt < 3) { attempt++; await sleep(1000 * 2 ** attempt, signal); continue; }
        throw new ModelError(`Could not reach the Claude API: ${err.message}`, { type: 'network', retryable: true });
      }
      if (res.ok) break;
      const err = await errorFrom(res);
      if (res.status === 400 && downgradeTries < 3 && maybeDowngrade(err.message)) { downgradeTries++; continue; }
      if (err.retryable && attempt < 3) {
        attempt++;
        const ra = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 20000) : 1000 * 2 ** attempt, signal);
        continue;
      }
      if (res.status === 401) err.message = 'The Claude API rejected the API key (401). Check ANTHROPIC_API_KEY.';
      if (res.status === 403) err.message = `The Claude API refused the request (403): ${err.message}`;
      throw err;
    }
    return readStream(res, onEvent, signal);
  }

  async function readStream(res, onEvent, signal) {
    const msg = { id: null, model: null, content: [], stop_reason: null, stop_details: null, usage: {} };
    const rawJson = new Map();
    const invalidToolInputs = new Map();
    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;
    const reader = res.body.getReader();
    const handle = (ev) => {
      switch (ev.type) {
        case 'message_start':
          msg.id = ev.message?.id; msg.model = ev.message?.model; msg.usage = { ...(ev.message?.usage || {}) };
          break;
        case 'content_block_start': {
          const block = structuredClone(ev.content_block);
          if (block.type === 'tool_use' || block.type === 'server_tool_use') rawJson.set(ev.index, '');
          msg.content[ev.index] = block;
          onEvent({ type: 'block_start', index: ev.index, block });
          break;
        }
        case 'content_block_delta': {
          const block = msg.content[ev.index];
          const d = ev.delta || {};
          if (!block) break;
          if (d.type === 'text_delta') { block.text = (block.text || '') + d.text; onEvent({ type: 'text', index: ev.index, text: d.text }); }
          else if (d.type === 'thinking_delta') { block.thinking = (block.thinking || '') + d.thinking; onEvent({ type: 'thinking', index: ev.index, text: d.thinking }); }
          else if (d.type === 'signature_delta') { block.signature = (block.signature || '') + d.signature; }
          else if (d.type === 'input_json_delta') { rawJson.set(ev.index, (rawJson.get(ev.index) || '') + d.partial_json); onEvent({ type: 'tool_input', index: ev.index }); }
          else if (d.type === 'citations_delta') { block.citations = [...(block.citations || []), d.citation]; onEvent({ type: 'citation', index: ev.index, citation: d.citation }); }
          break;
        }
        case 'content_block_stop': {
          const block = msg.content[ev.index];
          if (block && rawJson.has(ev.index)) {
            const raw = rawJson.get(ev.index);
            if (!raw.trim()) block.input = block.input && Object.keys(block.input).length ? block.input : {};
            else {
              try { block.input = JSON.parse(raw); } catch { block.input = {}; if (block.type === 'tool_use') invalidToolInputs.set(block.id, raw); }
            }
          }
          onEvent({ type: 'block_stop', index: ev.index, block });
          break;
        }
        case 'message_delta':
          if (ev.delta?.stop_reason) msg.stop_reason = ev.delta.stop_reason;
          if (ev.delta?.stop_details !== undefined) msg.stop_details = ev.delta.stop_details;
          if (ev.usage) Object.assign(msg.usage, ev.usage);
          break;
        case 'message_stop':
          done = true;
          break;
        case 'error':
          throw new ModelError(ev.error?.message || 'Stream error', { type: ev.error?.type, retryable: ev.error?.type === 'overloaded_error' });
        default:
          break;
      }
    };
    try {
      while (!done) {
        const { value, done: eof } = await reader.read();
        if (eof) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, '');
          const data = frame.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
          if (!data) continue;
          let ev;
          try { ev = JSON.parse(data); } catch { continue; }
          handle(ev);
        }
      }
    } catch (err) {
      if (signal?.aborted) throw new ModelError('aborted', { type: 'aborted' });
      if (err instanceof ModelError) throw err;
      throw new ModelError(`Stream interrupted: ${err.message}`, { type: 'network', retryable: true });
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
    if (!done && !msg.stop_reason) throw new ModelError('The response stream ended unexpectedly', { type: 'network', retryable: true });
    msg.content = msg.content.filter(Boolean);
    return { ...msg, invalidToolInputs };
  }

  /** One-shot text completion (used for briefings). */
  async function complete({ model, system, prompt, effort = 'low', maxTokens = 8000, signal }) {
    const out = await stream({ model, system, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], effort, maxTokens }, { signal });
    if (out.stop_reason === 'refusal') throw new ModelError('The model declined to write this summary', { type: 'refusal' });
    return out.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  }

  async function testConnection(model) {
    if (!config.anthropic.apiKey) return { ok: false, message: 'ANTHROPIC_API_KEY is not set on the server.' };
    try {
      const res = await fetch(`${config.anthropic.baseUrl}/v1/models/${encodeURIComponent(model)}`, { headers: headers([]), signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const j = await res.json().catch(() => ({}));
        return { ok: true, message: `Connected. ${j.display_name || model} is available to this API key.` };
      }
      const err = await errorFrom(res);
      return { ok: false, message: res.status === 401 ? 'The API key was rejected (401).' : `Claude API returned ${res.status}: ${err.message}` };
    } catch (err) {
      return { ok: false, message: `Could not reach the Claude API: ${err.message}` };
    }
  }

  return { stream, complete, testConnection, buildBody, downgraded };
}
