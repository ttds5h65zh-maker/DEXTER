// Dexter as a page on claude.ai. The same core and route table as the local
// server run here in the browser. Work is saved to the viewer's private space in
// the page's database; Claude reads sources through the viewer's own account.
// Outside claude.ai (or signed out) the page still works: it saves in this
// browser if it can, and says so.

import { Dexter, AppError, emptyState } from './lib/core.js';
import { createRoutes, matchRoute } from './lib/routes.js';
import { seedDemo } from './lib/seed.js';
import { EXTRACT_RULES, DRAFT_RULES, extractMaterial, draftMaterial } from './lib/prompts.js';
import { readPdf } from './shared/pdf.js';

/** A capability's namespace, or null when this view cannot use it. */
function use(name) {
  const claude = window.claude;
  if (!claude || typeof claude.use !== 'function') return Promise.resolve(null);
  return Promise.resolve(claude.use(name)).catch(() => null);
}
const timeout = (ms) => new Promise((resolve) => setTimeout(() => resolve('timeout'), ms));

// ---------------------------------------------------------------------------
// PDF decompression with the browser's own DecompressionStream
// ---------------------------------------------------------------------------
async function inflate(bytes) {
  for (const format of ['deflate', 'deflate-raw']) {
    const chunks = [];
    try {
      const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format)).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    } catch {
      if (!chunks.length) continue; // try the next format; keep what a damaged stream gave
    }
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------
const CHUNK = 50000; // characters of source text per document, well under the 256 KiB document limit
const GROUP_BYTES = 100000; // findings are stored together per source, in documents of about this size
const META = 'meta';

/** JSON with sorted keys, so a document reads the same however the store orders its fields. */
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : canonical(x))).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v) ?? 'null';
}

/**
 * The state as database documents: one per source (its text in chunks, its
 * findings grouped), one per task and one per draft. Importing a source is a
 * handful of writes however many findings it has.
 */
function toDocs(state, chunkCache) {
  const docs = new Map();
  docs.set(META, canonical({ version: state.version, createdAt: state.createdAt }));
  const findingsBySource = new Map();
  for (const f of state.findings) {
    if (!findingsBySource.has(f.sourceId)) findingsBySource.set(f.sourceId, []);
    findingsBySource.get(f.sourceId).push(f);
  }
  for (const s of state.sources) {
    const { text, ...rest } = s;
    let chunks = chunkCache.get(s.id);
    if (!chunks) {
      chunks = [];
      for (let i = 0, k = 0; i < Math.max(text.length, 1); i += CHUNK, k++) chunks.push([`${s.id}.t${k}`, canonical({ text: text.slice(i, i + CHUNK) })]);
      chunkCache.set(s.id, chunks);
    }
    for (const [id, json] of chunks) docs.set(id, json);
    // findings, packed in creation order into documents of about GROUP_BYTES
    const groups = [];
    let group = [];
    let size = 0;
    for (const f of findingsBySource.get(s.id) || []) {
      const json = canonical(f);
      if (group.length && size + json.length > GROUP_BYTES) { groups.push(group); group = []; size = 0; }
      group.push(json);
      size += json.length + 1;
    }
    if (group.length) groups.push(group);
    groups.forEach((g, k) => docs.set(`${s.id}.f${k}`, `{"findings":[${g.join(',')}]}`));
    docs.set(s.id, canonical({ ...rest, textChunks: chunks.length, findingGroups: groups.length }));
  }
  for (const kind of ['tasks', 'drafts']) for (const x of state[kind]) docs.set(x.id, canonical(x));
  return docs;
}

/** Rebuild the state from database documents; null when nothing was ever saved. */
function fromDocs(docs) {
  if (!docs.has(META)) return null;
  const meta = docs.get(META);
  const state = { ...emptyState(), version: meta.version || 1, createdAt: meta.createdAt || new Date().toISOString() };
  const byCreated = (dir) => (a, b) => (a.createdAt < b.createdAt ? -dir : a.createdAt > b.createdAt ? dir : 0);
  for (const [id, data] of docs) {
    if (/^src_[^.]+$/.test(id)) {
      const { textChunks = 0, findingGroups = 0, ...rest } = data;
      let text = '';
      for (let k = 0; k < textChunks; k++) text += (docs.get(`${id}.t${k}`) || {}).text || '';
      state.sources.push({ ...rest, text });
      for (let k = 0; k < findingGroups; k++) state.findings.push(...((docs.get(`${id}.f${k}`) || {}).findings || []));
    } else if (id.startsWith('tsk_')) state.tasks.push(data);
    else if (id.startsWith('dft_')) state.drafts.push(data);
  }
  state.sources.sort(byCreated(-1));
  state.findings.sort(byCreated(1));
  state.tasks.sort(byCreated(1));
  state.drafts.sort(byCreated(-1));
  return state;
}

const SAVE_ERRORS = {
  quota_exceeded: 'Your saved space is full. Delete some sources you no longer need.',
  invalid_argument: 'One item was too large to save.',
  resource_exhausted: 'Saving is busy. Your last change will be saved with the next one.',
  revoked: 'This page can no longer save your work. Reload it to try again.',
};

/** Saves to the viewer's private space in the page's database, writing only what changed. */
class AccountStore {
  constructor(collection, onStatus) {
    this.kind = 'account';
    this.col = collection;
    this.onStatus = onStatus;
    this.saved = new Map(); // doc id -> JSON last written
    this.pending = new Map(); // doc id -> JSON to write, or null to delete
    this.inflight = new Set();
    this.retried = new Set();
    this.chunkCache = new Map();
    this.error = null;
  }
  async load() {
    const snap = await this.col.get();
    const docs = new Map();
    for (const d of snap.docs) {
      if (!d.exists) continue;
      const data = d.data();
      docs.set(d.id, data);
      this.saved.set(d.id, canonical(data));
    }
    return fromDocs(docs);
  }
  save(state) {
    const docs = toDocs(state, this.chunkCache);
    for (const [id, json] of docs) {
      if (this.saved.get(id) !== json) this.pending.set(id, json);
      else this.pending.delete(id);
    }
    for (const id of this.saved.keys()) if (!docs.has(id)) this.pending.set(id, null);
    for (const sid of [...this.chunkCache.keys()]) if (!state.sources.some((s) => s.id === sid)) this.chunkCache.delete(sid);
    this.pump();
  }
  pump() {
    while (this.inflight.size < 3) {
      let id;
      for (const k of this.pending.keys()) if (!this.inflight.has(k)) { id = k; break; }
      if (id === undefined) break;
      const json = this.pending.get(id);
      this.pending.delete(id);
      this.inflight.add(id);
      const ref = this.col.doc(id);
      (json === null ? ref.delete() : ref.set(JSON.parse(json)))
        .then(() => {
          if (json === null) this.saved.delete(id);
          else this.saved.set(id, json);
          this.retried.delete(id);
          if (!this.pending.size && this.inflight.size === 1) this.error = null;
        }, (e) => this.fail(id, json, e))
        .finally(() => {
          this.inflight.delete(id);
          this.pump();
          this.report();
        });
    }
    this.report();
  }
  fail(id, json, e) {
    const code = (e && e.code) || 'unavailable';
    if ((code === 'unavailable' || code === 'resource_exhausted') && !this.retried.has(id)) {
      this.retried.add(id);
      setTimeout(() => {
        if (!this.pending.has(id)) this.pending.set(id, json);
        this.pump();
      }, 800 + Math.random() * 1600);
      return;
    }
    this.error = SAVE_ERRORS[code] || 'Dexter could not reach your saved work. Your last change may not be saved.';
  }
  report() {
    const busy = this.inflight.size > 0 || this.pending.size > 0;
    this.onStatus(busy ? { state: 'saving' } : this.error ? { state: 'error', message: this.error } : { state: 'saved' });
  }
}

/** Saves in this browser only (outside claude.ai, or signed out). */
class BrowserStore {
  constructor(onStatus) {
    this.kind = 'browser';
    this.onStatus = onStatus;
    this.key = 'dexter-state-v1';
  }
  load() {
    try {
      const raw = window.localStorage.getItem(this.key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  save(state) {
    try {
      window.localStorage.setItem(this.key, JSON.stringify(state));
      this.onStatus({ state: 'saved' });
    } catch {
      this.onStatus({ state: 'error', message: 'This browser would not store more. Delete some sources you no longer need.' });
    }
  }
  static works() {
    try {
      window.localStorage.setItem('dexter-probe', '1');
      window.localStorage.removeItem('dexter-probe');
      return true;
    } catch {
      return false;
    }
  }
}

class MemoryStore {
  constructor(onStatus) {
    this.kind = 'memory';
    this.onStatus = onStatus;
  }
  load() { return null; }
  save() { this.onStatus({ state: 'unsaved' }); }
}

// ---------------------------------------------------------------------------
// Claude, through the viewer's own account
// ---------------------------------------------------------------------------
function claudeAI(sample) {
  let ctl = null;
  const ai = {
    available: !!sample,
    reason: sample ? null : 'no_claude',
    model: 'Claude, through your account',
    abort() { if (ctl) ctl.abort(); },
  };
  const explain = (e) => {
    switch (e && e.code) {
      case 'cancelled': return 'you skipped it';
      case 'not_granted': case 'sampling_disabled': case 'not_declared': case 'capability_disabled': case 'capability_removed':
        ai.available = false;
        ai.reason = 'not_granted';
        return 'Claude access is not allowed for this page';
      case 'rate_limited': return e.reason === 'usage_limit' ? 'you have reached your Claude usage limit for now' : 'Claude is busy; try again in a moment';
      case 'prompt_too_large': return 'the source is too long for Claude to read in one go';
      case 'session_expired': return 'your Claude session expired; sign in again';
      case 'refused': return 'Claude declined to read this source';
      case 'invalid_json': return 'Claude replied in an unexpected format';
      default: return e && e.code ? 'Claude could not be reached' : (e && e.message) || 'Claude could not be reached';
    }
  };
  async function ask(prompt) {
    if (new TextEncoder().encode(prompt).length > 240000) throw new Error('the source is too long for Claude to read in one go');
    ctl = new AbortController();
    try {
      return await sample.json(prompt, { signal: ctl.signal });
    } catch (e) {
      throw new Error(explain(e));
    } finally {
      ctl = null;
    }
  }
  ai.extract = async (source) => {
    const out = await ask([
      ...EXTRACT_RULES,
      'Reply with only a JSON object in this shape:',
      '{"findings": [{"type": "deadline" or "decision" or "question", "title": "...", "quote": "the passage, copied exactly", "date_phrase": "the date wording as written, or an empty string", "date_reading": "YYYY-MM-DD or YYYY-MM-DD HH:MM, or an empty string"}]}',
      'If the source contains nothing of these kinds, reply {"findings": []}.',
      extractMaterial(source),
    ].join('\n\n'));
    const list = Array.isArray(out) ? out : out && Array.isArray(out.findings) ? out.findings : null;
    if (!list) throw new Error('Claude replied in an unexpected format');
    return list.filter((x) => x && typeof x === 'object').map((x) => ({
      type: String(x.type || ''),
      title: String(x.title || ''),
      quote: String(x.quote || ''),
      date_phrase: String(x.date_phrase || ''),
      date_reading: String(x.date_reading || ''),
    }));
  };
  ai.draft = async (args) => {
    const out = await ask([
      ...DRAFT_RULES,
      'Reply with only a JSON object: {"subject": "...", "body": "plain text, ready to send"}',
      draftMaterial(args),
    ].join('\n\n'));
    if (!out || typeof out.body !== 'string' || !out.body.trim()) throw new Error('Claude returned an empty draft');
    return { subject: String(out.subject || ''), body: out.body };
  };
  return ai;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
export async function start({ onSaveStatus = () => {} } = {}) {
  const [db, user, sample, downloads] = await Promise.all([use('db'), use('user'), use('sample'), use('downloads')]);
  const uid = user ? await Promise.resolve(user.id()).catch(() => null) : null;

  let store = null;
  let state = null;
  let notice = null;
  if (db && uid) {
    store = new AccountStore(db.collection(`data/users/${uid}`), onSaveStatus);
    const loaded = await Promise.race([store.load().then((s) => ({ s }), (e) => ({ e })), timeout(12000)]);
    if (loaded === 'timeout' || loaded.e) {
      store = new MemoryStore(onSaveStatus);
      notice = 'Dexter could not reach your saved work, so nothing you do in this visit will be kept. Reload the page to try again.';
    } else {
      state = loaded.s;
    }
  } else if (BrowserStore.works()) {
    store = new BrowserStore(onSaveStatus);
    state = store.load();
  } else {
    store = new MemoryStore(onSaveStatus);
  }

  const firstRun = !state;
  const dexter = new Dexter({
    state: state || emptyState(),
    persist: (s) => store.save(s),
    ai: claudeAI(sample),
    env: { mode: 'hosted', storage: store.kind, notice, downloads: !!downloads },
  });
  if (firstRun) {
    await seedDemo(dexter); // the fictional demo, labelled as such; removable from the home screen
    dexter.save();
  }
  const routes = createRoutes(dexter, { readPdf: (bytes) => readPdf(bytes, { inflate }) });
  if (store.kind === 'account') onSaveStatus({ state: 'saved' });

  return {
    /** Answer an API call exactly as the local server would. */
    async api(method, path, body, raw) {
      const url = new URL(path, 'https://dexter.invalid');
      const hit = matchRoute(routes, method, url.pathname);
      if (!hit) throw new AppError(404, 'not_found', 'Not found.');
      const extra = await hit.route.handler(hit.params, {
        query: url.searchParams,
        json: async () => (body === undefined ? {} : JSON.parse(JSON.stringify(body))),
        bytes: async () => {
          const bytes = new Uint8Array(raw || new ArrayBuffer(0));
          if (bytes.length > 25 * 1048576) throw new AppError(413, 'too_large', 'That upload is too large (the limit is 25 MB).');
          return bytes;
        },
      });
      return structuredClone({ ...extra, state: dexter.snapshot() });
    },
    abortAI: () => dexter.ai.abort(),
    /** Offer a file to the viewer. Resolves true when saved. */
    async saveFile(filename, data) {
      if (!downloads) return false;
      await downloads.save({ filename, data });
      return true;
    },
    exportData: () => JSON.stringify(dexter.state, null, 2),
  };
}
