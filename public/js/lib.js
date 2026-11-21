// Shared front-end helpers: API client, formatting, a tiny store, common components.
import { html, render, useState, useEffect, useRef, useMemo, useCallback } from '/vendor/preact.js';
export { html, render, useState, useEffect, useRef, useMemo, useCallback };

// ---- store ----
export const app = { boot: null, version: 0, listeners: new Set() };
export const refresh = () => { app.version++; app.listeners.forEach((l) => l()); };
export function useVersion() {
  const [, set] = useState(0);
  useEffect(() => { const l = () => set((n) => n + 1); app.listeners.add(l); return () => app.listeners.delete(l); }, []);
  return app.version;
}
export const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
export const openItem = (id) => emit('item', id);
export const openNew = (preset = {}) => emit('new', preset);
export const toast = (message, bad = false) => emit('toast', { message, bad });
export const go = (hash) => { location.hash = hash; };

// ---- api ----
export async function api(method, url, body) {
  const opts = { method, headers: { 'X-Dexter': '1' }, credentials: 'same-origin' };
  if (body instanceof Blob) { opts.body = body; opts.headers['Content-Type'] = 'application/octet-stream'; opts.headers['X-Filename'] = encodeURIComponent(body.name || 'upload'); }
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(url, opts);
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && app.boot?.user) emit('signed-out');
    const e = new Error(data?.error || `Request failed (${res.status})`);
    e.status = res.status; e.data = data;
    throw e;
  }
  return data;
}
export const GET = (u) => api('GET', u);
export const POST = (u, b) => api('POST', u, b ?? {});
export const PATCH = (u, b) => api('PATCH', u, b);

export function useLoad(url, deps = []) {
  const version = useVersion();
  const [state, set] = useState({ data: null, error: null, loading: true });
  useEffect(() => {
    if (!url) return;
    let live = true;
    GET(url).then((data) => live && set({ data, error: null, loading: false }), (error) => live && set((s) => ({ ...s, error, loading: false })));
    return () => { live = false; };
  }, [url, version, ...deps]);
  return state;
}

// ---- formatting ----
const DEC = { BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3, JPY: 0, KRW: 0 };
export const dec = (c) => DEC[c] ?? 2;
export const num = (minor, c) => (minor / 10 ** dec(c)).toLocaleString('en-US', { minimumFractionDigits: dec(c), maximumFractionDigits: dec(c) });
export const money = (minor, c) => `${c} ${num(minor, c)}`;
export const compactMoney = (minor, c) => { const v = minor / 10 ** dec(c); return Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(v >= 100000 ? 0 : 1)}k` : String(Math.round(v)); };
/** Read a typed amount: accepts "1,500.50", "AED 1,500", Arabic-Indic digits (١٬٥٠٠٫٥٠) and the Arabic decimal mark. */
export const parseTyped = (str) => {
  const t = String(str ?? '').replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replace(/\u066b/g, '.').replace(/[\u066c,\s]/g, '').replace(/^[A-Za-z]{3}|[A-Za-z]{3}$/g, '');
  if (!t || !/^-?\d*\.?\d+$/.test(t)) return null;
  return Number(t);
};
export const toMinor = (str, c) => { const n = parseTyped(str); return n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dec(c)); };
export const fromMinor = (minor, c) => (minor == null ? '' : (minor / 10 ** dec(c)).toFixed(dec(c)));
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const utc = (d) => new Date(d + 'T00:00:00Z');
export const fmtDate = (d, withYear = true) => (!d ? '—' : `${utc(d).getUTCDate()} ${MON[utc(d).getUTCMonth()]}${withYear ? ' ' + utc(d).getUTCFullYear() : ''}`);
export const dayParts = (d) => ({ day: utc(d).getUTCDate(), mon: MON[utc(d).getUTCMonth()], dow: DOW[utc(d).getUTCDay()] });
export const monthName = (ym) => `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
export const addDays = (d, n) => { const x = utc(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export const addMonths = (d, n) => { const x = utc(d); const day = x.getUTCDate(); x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + n); const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate(); x.setUTCDate(Math.min(day, last)); return x.toISOString().slice(0, 10); };
export const rel = (days) => (days == null ? 'no due date' : days === 0 ? 'due today' : days === 1 ? 'due tomorrow' : days > 0 ? `due in ${days} days` : days === -1 ? '1 day overdue' : `${-days} days overdue`);
export const GROUP_LABEL = { household: 'Household', family: 'Family', vehicle: 'Vehicles', property: 'Properties', finance: 'Loans & cards', business: 'Business' };
export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ---- components ----
/** One line per currency; currencies are only merged when the owner has entered a rate. */
export function Totals({ list, zero = '—', sign = false }) {
  if (!list || !list.length) return html`<span class="muted">${zero}</span>`;
  return list.map((t) => html`<div class="num" title=${t.converted_from?.length ? `Includes ${t.converted_from.join(', ')} converted at your entered rate` : ''}>
    <small>${t.currency}</small>${sign && t.amount > 0 ? '+' : ''}${num(t.amount, t.currency)}${t.converted_from?.length ? html`<span class="muted small"> incl. ${t.converted_from.join(', ')}</span>` : ''}</div>`);
}
const STATUS_TEXT = { confirmed: '✓ Confirmed', estimated: '≈ Estimated', needs_review: '! Needs review' };
export function Status({ item }) {
  const out = [];
  if (item.overdue) out.push(html`<span class="chip overdue">Overdue</span>`);
  if (item.status === 'paid') out.push(html`<span class="chip paid">${item.direction === 'in' ? 'Received' : 'Paid'}</span>`);
  else if (item.status === 'partial') out.push(html`<span class="chip partial">Part ${item.direction === 'in' ? 'received' : 'paid'}</span>`);
  if (item.status === 'void') out.push(html`<span class="chip paid">Void</span>`);
  if (item.needs_review) out.push(html`<span class="chip needs_review">${STATUS_TEXT.needs_review}${item.due_date ? '' : ' · no due date'}</span>`);
  else if (item.projected) out.push(html`<span class="chip estimated" title="Generated schedule that has not been checked against the lender's own schedule">≈ Projected · not verified</span>`);
  else if (item.status !== 'paid' || item.amount_status !== 'confirmed') out.push(html`<span class="chip ${item.amount_status}">${STATUS_TEXT[item.amount_status]}</span>`);
  if (!item.billed && item.outstanding > 0 && !item.projected) out.push(html`<span class="chip plain">Not billed yet</span>`);
  return out;
}
export function Entry({ item, showGroup = true }) {
  const p = item.due_date ? dayParts(item.due_date) : null;
  return html`<button class="entry ${item.direction} ${item.overdue ? 'over' : ''}" onClick=${() => openItem(item.id)}>
    <div class="date">${p ? html`<b>${p.day}</b><span>${p.mon}</span>` : html`<b>?</b><span>no date</span>`}</div>
    <div style="min-width:0"><div class="t">${item.title}</div>
      <div class="m"><${Status} item=${item} />${showGroup ? html`<span>${GROUP_LABEL[item.grp]}${item.entity_name ? ' · ' + item.entity_name : ''}</span>` : ''}${item.counterparty ? html`<span>· ${item.counterparty}</span>` : ''}${item.doc_count ? html`<span title="Has documents">📎</span>` : ''}</div></div>
    <div class="a num">${item.direction === 'in' ? '+' : ''}${money(item.outstanding || item.amount, item.currency)}
      <small>${item.status === 'partial' ? `of ${num(item.amount, item.currency)} · ` : ''}${item.outstanding > 0 ? rel(item.days_until) : fmtDate(item.due_date)}</small></div>
  </button>`;
}
export function Modal({ title, onClose, children, footer, wide }) {
  useEffect(() => { const k = (e) => e.key === 'Escape' && onClose(); addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, []);
  return html`<div class="scrim center" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-label=${title}>
      <header><h2>${title}</h2><button class="x" onClick=${onClose} aria-label="Close">×</button></header>
      <div class="body">${children}</div>${footer ? html`<footer>${footer}</footer>` : ''}
    </div></div>`;
}
export function F({ label, hint, unsure, children }) {
  return html`<label class="f ${unsure ? 'unsure' : ''}"><span>${label}${unsure ? ' · check' : ''}</span>${children}${hint ? html`<small>${hint}</small>` : ''}</label>`;
}
export function Panel({ title, actions, children, pad = true }) {
  return html`<section class="panel"><header><h2>${title}</h2>${actions}</header>${pad ? html`<div class="body">${children}</div>` : html`<div style="margin-top:12px">${children}</div>`}</section>`;
}
export const Loading = ({ state }) => (state.error ? html`<div class="err">${state.error.message}</div>` : html`<p class="muted">Loading…</p>`);
export function useForm(initial) {
  const [v, set] = useState(initial);
  const bind = (k) => ({ value: v[k] ?? '', onInput: (e) => set((s) => ({ ...s, [k]: e.target.value })) });
  return [v, bind, set];
}
/** Wraps an async action with busy + error state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (fn) => { setBusy(true); setError(null); try { return await fn(); } catch (e) { setError(e); return undefined; } finally { setBusy(false); } };
  return { busy, error, run, setError };
}
export const icon = (d) => html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${d} /></svg>`;
export const ICONS = {
  home: 'M3 11l9-8 9 8M5 10v10h14V10', cal: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4', house: 'M4 20V9l8-6 8 6v11zM9 20v-6h6v6', car: 'M5 16l1.5-6h11L19 16M4 16h16v3H4zM7 19v2M17 19v2',
  building: 'M5 21V4h9v17M14 9h5v12M8 8h3M8 12h3M8 16h3', card: 'M3 6h18v12H3zM3 10h18M7 15h4', brief: 'M3 8h18v12H3zM9 8V5h6v3M3 13h18', inbox: 'M4 13l2-8h12l2 8v6H4zM4 13h5l1 3h4l1-3h5',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01', gear: 'M12 9a3 3 0 100 6 3 3 0 000-6zM19 12l2-1-2-4-2 1-2-1V5h-4v2l-2 1-2-1-2 4 2 1v2l-2 1 2 4 2-1 2 1v2h4v-2l2-1 2 1 2-4-2-1z',
  camera: 'M4 8h4l1.5-2h5L16 8h4v11H4zM12 11a3 3 0 100 6 3 3 0 000-6z', bell: 'M6 16V11a6 6 0 1112 0v5l2 2H4zM10 20h4', more: 'M5 12h.01M12 12h.01M19 12h.01',
};

/** The original file: images as-is, PDFs as page images rendered by the server (works on phones too). */
export function Original({ doc }) {
  const src = `/api/documents/${doc.id}/file`;
  if (doc.mime === 'application/pdf') {
    const n = Math.min(doc.pages || 1, 20);
    return html`${Array.from({ length: n }, (_, i) => html`<img src=${`/api/documents/${doc.id}/page/${i + 1}`} alt=${`Page ${i + 1} of ${doc.filename}`} loading="lazy" style="margin-bottom:6px" />`)}${(doc.pages || 1) > n ? html`<div class="empty">Showing the first ${n} pages. Open the file for the rest.</div>` : ''}`;
  }
  if (/^image\/(png|jpeg|webp|gif)$/.test(doc.mime)) return html`<img src=${src} alt=${doc.filename} />`;
  return html`<div class="empty">This file type cannot be previewed here. Use “Open” to download it.</div>`;
}
