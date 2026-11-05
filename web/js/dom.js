// DOM helpers: element builder, formatting, toasts, dialogs.
import { icon } from './icons.js';

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = Boolean(v);
    else if (k === 'html') throw new Error('Use renderMarkdown, never raw HTML');
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === true) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function btn(label, onClick, { kind = '', ic = null, title = null, type = 'button', disabled = false, size = '' } = {}) {
  const cls = ['btn', kind, size, !label && ic ? 'icon' : ''].filter(Boolean).join(' ');
  return h('button', { class: cls, type, title: title || (label ? null : ic), 'aria-label': label ? null : title || ic, onclick: onClick, disabled }, ic ? icon(ic, 16) : null, label);
}

export function statusChip(status, label) {
  const s = String(status || 'unknown');
  return h('span', { class: `status ${s}` }, label || s.replace(/_/g, ' '));
}

// ---------- time formatting (always in Sultan's timezone) ----------
let TZ = 'Asia/Dubai';
export function setTimeZone(tz) { TZ = tz || 'Asia/Dubai'; }
export function tz() { return TZ; }

const dayKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

export function fmtTime(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

export function fmtDate(iso, { year = false } = {}) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}) }).format(new Date(iso));
}

export function fmtDateTime(iso) {
  if (!iso) return '';
  return `${fmtDate(iso)}, ${fmtTime(iso)}`;
}

/** "today 17:00", "tomorrow 09:00", "Fri 7 Nov 17:00", "3 days ago". */
export function fmtWhen(iso, { allDay = false } = {}) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const days = Math.round((new Date(dayKey(d)) - new Date(dayKey(now))) / 86400000);
  const time = allDay ? '' : ` ${fmtTime(iso)}`;
  if (days === 0) return `today${time}`;
  if (days === 1) return `tomorrow${time}`;
  if (days === -1) return `yesterday${time}`;
  return `${fmtDate(iso)}${time}`;
}

export function fmtAgo(iso) {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} d ago`;
  return fmtDate(iso, { year: true });
}

export function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** ISO → value for <input type="datetime-local"> in Sultan's timezone. */
export function toLocalInput(iso) {
  if (!iso) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}

// ---------- toasts ----------
let toastRoot;
export function toast(message, { error = false, timeout = 4200, action = null } = {}) {
  if (!toastRoot) { toastRoot = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(toastRoot); }
  const t = h('div', { class: `toast${error ? ' error' : ''}`, title: 'Click to dismiss', onclick: (e) => { if (e.target.tagName !== 'A') t.remove(); } }, h('div', { class: 'grow' }, message), action);
  toastRoot.append(t);
  while (toastRoot.childElementCount > 3) toastRoot.firstElementChild.remove();
  setTimeout(() => t.remove(), timeout);
}

export function errorToast(err) {
  toast(err?.message || String(err), { error: true, timeout: 7000 });
}

// ---------- dialogs ----------
export function dialog({ title, body, actions = [], wide = false, onClose = null }) {
  const prev = document.activeElement;
  let overlay;
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); onClose?.(); prev?.focus?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const box = h('div', { class: `dialog${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'dialog-head' }, h('h2', {}, title), btn('', close, { kind: 'ghost', ic: 'x', title: 'Close', size: 'sm' })),
    h('div', { class: 'dialog-body' }, body),
    actions.length ? h('div', { class: 'dialog-foot' }, actions.map((a) => btn(a.label, async () => { const keep = await a.onClick?.(); if (keep !== true) close(); }, { kind: a.kind || '' }))) : null);
  overlay = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === overlay) close(); } }, box);
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
  setTimeout(() => (box.querySelector('input, textarea, select, button.primary') || box.querySelector('button'))?.focus(), 0);
  return { close, box };
}

export function confirmDialog(title, message, { confirmLabel = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let decided = false;
    dialog({
      title, body: h('p', {}, message),
      actions: [
        { label: 'Cancel', onClick: () => { decided = true; resolve(false); } },
        { label: confirmLabel, kind: danger ? 'danger solid' : 'primary', onClick: () => { decided = true; resolve(true); } },
      ],
      onClose: () => { if (!decided) resolve(false); },
    });
  });
}

export function loading(text = 'Loading…') {
  return h('div', { class: 'loading' }, h('div', { class: 'spinner' }), text);
}

export function empty(title, text, action = null) {
  return h('div', { class: 'empty' }, h('div', { class: 'big' }, title), text ? h('div', {}, text) : null, action ? h('div', { style: { marginTop: '12px' } }, action) : null);
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
