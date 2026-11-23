// Optional AI extraction and drafting through the Anthropic API.
// Dexter works without this. It is switched on by setting ANTHROPIC_API_KEY
// (and having the optional @anthropic-ai/sdk package installed).

import { EXTRACT_RULES, DRAFT_RULES, extractMaterial, draftMaterial } from './prompts.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';

const unavailable = (reason, model) => ({
  available: false,
  reason,
  model,
  extract: async () => { throw new Error('AI is not available'); },
  draft: async () => { throw new Error('AI is not available'); },
});

/** The AI adapter Dexter's core calls: extract(source) and draft(args). */
export function createAnthropicAI({ client, model = DEFAULT_MODEL }) {
  const ai = { available: true, reason: null, model, client };
  ai.extract = (source) => extractWithAI(ai, source);
  ai.draft = (args) => draftWithAI(ai, args);
  return ai;
}

/** Work out whether AI is usable, and why not if it isn't. */
export async function loadAI(env = process.env) {
  const model = env.DEXTER_MODEL || DEFAULT_MODEL;
  if (env.DEXTER_AI === 'off') return unavailable('disabled', model);
  if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) return unavailable('no_key', model);
  let Anthropic;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch {
    return unavailable('no_sdk', model);
  }
  return createAnthropicAI({ client: new Anthropic(), model });
}

const FINDINGS_TOOL = {
  name: 'record_findings',
  description: 'Record every deadline, decision and open question found in the source.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['deadline', 'decision', 'question'] },
            title: { type: 'string', description: 'One short line saying what the reader has to do or know.' },
            quote: { type: 'string', description: 'The passage this comes from, copied character for character from the source.' },
            date_phrase: { type: 'string', description: 'The date or time wording exactly as written in the source, or an empty string if there is none.' },
            date_reading: { type: 'string', description: 'Your reading of that date as YYYY-MM-DD, or YYYY-MM-DD HH:MM when a time is given, in Asia/Dubai time. Empty string if there is no date.' },
          },
          required: ['type', 'title', 'quote', 'date_phrase', 'date_reading'],
          additionalProperties: false,
        },
      },
    },
    required: ['findings'],
    additionalProperties: false,
  },
};

const DRAFT_TOOL = {
  name: 'write_draft',
  description: 'Return the follow-up message for the user to review.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      subject: { type: 'string' },
      body: { type: 'string', description: 'Plain text, ready to send, with no placeholders.' },
    },
    required: ['subject', 'body'],
    additionalProperties: false,
  },
};

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * One Messages API call. If the model declines, Anthropic re-runs the request
 * on its recommended fallback model (server-side fallbacks). Should this account
 * or SDK version not accept that option, the call is made once more without it.
 */
async function createMessage(ai, params) {
  if (ai.fallbacks !== false && ai.client.beta && ai.client.beta.messages) {
    try {
      return await ai.client.beta.messages.create({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' });
    } catch (err) {
      if (!(err && err.status === 400 && /fallback|beta/i.test(String(err.message)))) throw err;
      ai.fallbacks = false; // not available here; stop asking for it
    }
  }
  return ai.client.messages.create(params);
}

function toolInput(response, name) {
  if (response.stop_reason === 'refusal') throw new Error('the model declined this request');
  const block = response.content.find((b) => b.type === 'tool_use' && b.name === name);
  if (!block) throw new Error('the model did not return a structured result');
  return block.input;
}

/**
 * Ask the model for findings. Returns raw items; Dexter then checks every quote
 * against the source and interprets dates itself, so nothing is scheduled on
 * the model's word alone.
 */
export async function extractWithAI(ai, source) {
  const response = await createMessage(ai, {
    model: ai.model,
    max_tokens: 16000,
    output_config: { effort: 'medium' },
    system: [...EXTRACT_RULES, 'Reply by calling record_findings once. If the source contains nothing of these kinds, call it with an empty list.'].join('\n\n'),
    tools: [FINDINGS_TOOL],
    messages: [{ role: 'user', content: extractMaterial(source) }],
  });
  const input = toolInput(response, 'record_findings');
  return Array.isArray(input.findings) ? input.findings : [];
}

/** Ask the model to write a follow-up. Returns { subject, body }. */
export async function draftWithAI(ai, { source, item, quote, recipient, dueText }) {
  const response = await createMessage(ai, {
    model: ai.model,
    max_tokens: 16000,
    output_config: { effort: 'medium' },
    system: [...DRAFT_RULES, 'Reply by calling write_draft once.'].join('\n\n'),
    tools: [DRAFT_TOOL],
    messages: [{ role: 'user', content: draftMaterial({ source, item, quote, recipient, dueText }) }],
  });
  const input = toolInput(response, 'write_draft');
  if (!input.body) throw new Error('the model returned an empty draft');
  return { subject: String(input.subject || ''), body: String(input.body) };
}
