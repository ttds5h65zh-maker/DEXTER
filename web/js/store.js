// Shared client state and the live event stream from the server.
import { api } from './api.js';
import { debounce, setTimeZone } from './dom.js';

const listeners = new Map();
export const state = { boot: null, counts: {}, connected: false, lastSeq: 0 };

export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type)?.delete(fn);
}

export function emit(type, data) {
  for (const fn of listeners.get(type) || []) { try { fn(data); } catch (e) { console.error(e); } }
  for (const fn of listeners.get('*') || []) { try { fn({ type, data }); } catch (e) { console.error(e); } }
}

export async function loadBoot() {
  state.boot = await api.get('/api/bootstrap');
  state.counts = state.boot.counts;
  setTimeZone(state.boot.profile.timezone);
  emit('boot', state.boot);
  emit('counts', state.counts);
  return state.boot;
}

export const refreshCounts = debounce(async () => {
  try {
    state.counts = await api.get('/api/counts');
    emit('counts', state.counts);
  } catch { /* offline; next event retries */ }
}, 250);

const COUNT_EVENTS = new Set(['approval.updated', 'handoff.updated', 'notification.created', 'notification.read', 'task.updated', 'run.updated']);

let es = null;
export function connectEvents() {
  if (es) es.close();
  es = new EventSource(`/api/events${state.lastSeq ? `?last=${state.lastSeq}` : ''}`);
  es.addEventListener('hello', () => { state.connected = true; emit('connection', true); });
  es.addEventListener('message', (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    state.lastSeq = ev.id;
    emit(ev.type, ev.data);
    if (COUNT_EVENTS.has(ev.type)) refreshCounts();
    if (ev.type === 'settings.updated' || ev.type === 'integrations.updated') loadBoot().catch(() => {});
  });
  es.onerror = () => {
    if (state.connected) { state.connected = false; emit('connection', false); }
  };
}
