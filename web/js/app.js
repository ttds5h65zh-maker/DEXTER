// App shell: navigation, hash router, notifications, search, shortcuts.
import { h, clear, btn, toast, errorToast, dialog, fmtAgo, loading, debounce } from './dom.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { state, on, loadBoot, connectEvents, refreshCounts } from './store.js';
import { renderMarkdown } from './markdown.js';
import * as chat from './views/chat.js';
import * as today from './views/today.js';
import * as tasks from './views/tasks.js';
import * as projects from './views/projects.js';
import * as memory from './views/memory.js';
import * as files from './views/files.js';
import * as approvals from './views/approvals.js';
import * as settings from './views/settings.js';

const NAV = [
  { key: 'chat', label: 'Chat', ic: 'chat', view: chat },
  { key: 'today', label: 'Today', ic: 'today', view: today },
  { key: 'tasks', label: 'Tasks', ic: 'tasks', view: tasks },
  { key: 'projects', label: 'Courses', ic: 'projects', view: projects },
  { key: 'memory', label: 'Memory', ic: 'memory', view: memory },
  { key: 'files', label: 'Files', ic: 'files', view: files },
  { key: 'approvals', label: 'Approvals', ic: 'approvals', view: approvals },
  { key: 'settings', label: 'Settings', ic: 'settings', view: settings },
];

const root = document.getElementById('app');
let viewEl; let titleEl; let shell; let cleanup = null; let currentKey = null;
const navLinks = new Map();

export function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  const segs = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { key: segs[0] || 'today', params: segs.slice(1), query: new URLSearchParams(qs || '') };
}

function route() {
  const { key, params, query } = parseRoute();
  const item = NAV.find((n) => n.key === key) || NAV[1];
  for (const [k, a] of navLinks) {
    a.classList.toggle('active', k === item.key);
    if (k === item.key) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  shell?.classList.remove('nav-open');
  if (typeof cleanup === 'function') { try { cleanup(); } catch (e) { console.error(e); } }
  cleanup = null;
  currentKey = item.key;
  titleEl.textContent = item.label;
  document.title = `${item.label} · Dexter`;
  clear(viewEl);
  try {
    cleanup = item.view.mount(viewEl, { params, query, navigate, setTitle: (t) => { titleEl.textContent = t; document.title = `${t} · Dexter`; } });
  } catch (err) {
    console.error(err);
    viewEl.append(h('div', { class: 'page' }, h('div', { class: 'banner danger' }, icon('alert'), h('div', {}, `This page failed to load: ${err.message}`))));
  }
}

function countBadge(n, muted = false) {
  return n ? h('span', { class: `count${muted ? ' muted' : ''}` }, String(n)) : null;
}

function renderNav(nav) {
  clear(nav);
  for (const item of NAV) {
    const a = h('a', { href: `#/${item.key}`, title: item.label }, icon(item.ic, 18), h('span', {}, item.label));
    if (item.key === 'approvals') { const b = countBadge(state.counts.approvals); if (b) a.append(b); }
    if (item.key === 'today') { const n = (state.counts.handoffs || 0) + (state.counts.attention_tasks || 0); const b = countBadge(n, true); if (b) a.append(b); }
    navLinks.set(item.key, a);
    nav.append(a);
  }
  const { key } = parseRoute();
  navLinks.get(key)?.classList.add('active');
}

function connectionFoot() {
  const foot = h('div', { class: 'sidebar-foot' });
  const draw = () => {
    clear(foot);
    const b = state.boot;
    const i = b?.integrations;
    foot.append(
      h('div', { class: 'conn' }, h('span', { class: `dot ${state.connected ? 'ok' : 'bad'}` }), state.connected ? 'Live updates on' : 'Reconnecting…'),
      h('div', { class: 'conn' }, h('span', { class: `dot ${i?.anthropic.configured ? 'ok' : 'warn'}` }), i?.anthropic.configured ? 'Claude connected' : 'Claude not connected'),
      h('div', { class: 'conn' }, h('span', { class: `dot ${i?.google.connected ? 'ok' : 'warn'}` }), i?.google.connected ? 'Google connected' : 'Google not connected'),
      h('div', { class: 'tiny' }, b ? `Times in ${b.profile.timezone}` : ''),
    );
  };
  on('connection', draw); on('boot', draw); draw();
  return foot;
}

// ---------------------------------------------------------------- notifications
let popover = null;
async function toggleNotifications(anchor) {
  if (popover) { popover.remove(); popover = null; return; }
  popover = h('div', { class: 'card popover', role: 'dialog', 'aria-label': 'Notifications' }, loading());
  anchor.parentElement.append(popover);
  const close = (e) => { if (popover && !popover.contains(e.target) && !anchor.contains(e.target)) { popover.remove(); popover = null; document.removeEventListener('mousedown', close); } };
  document.addEventListener('mousedown', close);
  try {
    const { notifications } = await api.get('/api/notifications');
    if (!popover) return;
    clear(popover);
    popover.append(h('div', { class: 'card-head' }, h('h2', {}, 'Notifications'), btn('Mark all read', async () => { await api.post('/api/notifications/read-all'); popover?.remove(); popover = null; }, { kind: 'ghost', size: 'sm' })));
    if (!notifications.length) popover.append(h('div', { class: 'empty' }, 'No notifications yet. Reminders, briefings, monitor alerts and approval requests appear here.'));
    for (const n of notifications.slice(0, 40)) {
      popover.append(h('div', { class: `notif${n.read_at ? '' : ' unread'}`, tabindex: '0', role: 'button', onclick: async () => {
        await api.post(`/api/notifications/${n.id}/read`).catch(() => {});
        popover?.remove(); popover = null;
        if (n.level === 'briefing') showBriefing(n);
        else if (n.link) navigate(n.link);
      } },
      icon(n.level === 'reminder' ? 'clock' : n.level === 'briefing' ? 'today' : n.level === 'error' ? 'alert' : n.level === 'attention' ? 'bell' : 'sparkle', 16),
      h('div', { class: 'grow' }, h('div', { class: 't' }, n.title), n.body ? h('div', { class: 'b' }, n.body.replace(/[#*_`]/g, '').slice(0, 220)) : null,
        h('div', { class: 'tiny muted' }, fmtAgo(n.created_at), n.delivery?.push ? ` · push ${n.delivery.push}` : ''))));
    }
  } catch (err) { errorToast(err); }
}

function showBriefing(n) {
  dialog({ title: n.title, body: renderMarkdown(n.body || ''), wide: true });
}

function desktopNotify(n) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
  try {
    const notif = new Notification(n.title, { body: (n.body || '').replace(/[#*_`]/g, '').slice(0, 180), tag: n.id, icon: '/assets/icon.svg' });
    notif.onclick = () => { window.focus(); if (n.link) navigate(n.link); notif.close(); };
  } catch { /* unsupported */ }
}

// ---------------------------------------------------------------- search
function openSearch() {
  const input = h('input', { class: 'input', type: 'search', placeholder: 'Search tasks, chats, memories, files…', 'aria-label': 'Search' });
  const results = h('div', { class: 'search-results' });
  const run = debounce(async () => {
    const q = input.value.trim();
    clear(results);
    if (!q) return;
    try {
      const r = await api.get(`/api/search?q=${encodeURIComponent(q)}`);
      const group = (title, items, map) => { if (!items?.length) return; results.append(h('div', { class: 'group' }, title)); for (const it of items) results.append(map(it)); };
      const link = (href, ic, text, sub) => h('a', { href, onclick: () => d.close() }, icon(ic, 16), h('span', { class: 'ellipsis' }, text), sub ? h('span', { class: 'muted tiny' }, sub) : null);
      group('Tasks', r.tasks, (t) => link(`#/tasks/${t.id}`, 'tasks', t.title, t.status.replace('_', ' ')));
      group('Conversations', r.conversations, (c) => link(`#/chat/${c.id}`, 'chat', c.title));
      group('Memories', r.memories, (m) => link('#/memory', 'memory', m.content));
      group('Files', r.files, (f) => link(`#/files/${f.id}`, 'files', f.name));
      group('Documents', r.documents, (x) => link(`#/files/documents/${x.id}`, 'doc', x.title));
      if (!results.childElementCount) results.append(h('div', { class: 'empty' }, 'No matches.'));
    } catch (err) { errorToast(err); }
  }, 180);
  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') results.querySelector('a')?.click(); if (e.key === 'ArrowDown') { e.preventDefault(); results.querySelector('a')?.focus(); } });
  const d = dialog({ title: 'Search', body: h('div', {}, input, results) });
}

function shortcutsHelp() {
  dialog({ title: 'Keyboard shortcuts', body: h('dl', { class: 'kv' },
    h('dt', {}, h('kbd', {}, 'Ctrl'), ' ', h('kbd', {}, 'K')), h('dd', {}, 'Search'),
    h('dt', {}, h('kbd', {}, 'Alt'), ' + ', h('kbd', {}, '1–8')), h('dd', {}, 'Go to Chat, Today, Tasks, Courses, Memory, Files, Approvals, Settings'),
    h('dt', {}, h('kbd', {}, 'Alt'), ' ', h('kbd', {}, 'N')), h('dd', {}, 'New conversation'),
    h('dt', {}, h('kbd', {}, '/')), h('dd', {}, 'Focus the message box'),
    h('dt', {}, h('kbd', {}, 'Enter')), h('dd', {}, 'Send (Shift+Enter for a new line)'),
    h('dt', {}, h('kbd', {}, 'Esc')), h('dd', {}, 'Close dialogs and panels'),
    h('dt', {}, h('kbd', {}, '?')), h('dd', {}, 'This help')) });
}

function onKey(e) {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); return; }
  if (e.altKey && /^[1-8]$/.test(e.key)) { e.preventDefault(); navigate(`#/${NAV[Number(e.key) - 1].key}`); return; }
  if (e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); navigate('#/chat/new'); return; }
  if (typing) return;
  if (e.key === '/' && currentKey === 'chat') { e.preventDefault(); document.querySelector('.composer textarea')?.focus(); }
  if (e.key === '?') shortcutsHelp();
}

// ---------------------------------------------------------------- login
async function loginScreen() {
  clear(root);
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', 'aria-label': 'Password' });
  const err = h('div', { class: 'small', style: { color: 'var(--danger)', minHeight: '20px', marginTop: '6px' } });
  const form = h('form', { class: 'card card-pad', onsubmit: async (e) => {
    e.preventDefault();
    try { await api.post('/api/auth/login', { password: pw.value }); location.reload(); } catch (x) { err.textContent = x.message; }
  } }, h('div', { class: 'brand', style: { padding: '0 0 14px' } }, h('div', { class: 'brand-mark' }, 'D'), h('div', {}, h('div', { class: 'brand-name' }, 'Dexter'), h('div', { class: 'brand-sub' }, 'Sign in to continue'))),
  h('div', { class: 'field' }, h('label', {}, 'Password'), pw), err, btn('Sign in', null, { kind: 'primary', type: 'submit' }));
  root.append(h('div', { class: 'login' }, form));
  pw.focus();
}

// ---------------------------------------------------------------- boot
async function boot() {
  try {
    const auth = await api.get('/api/auth/status');
    if (auth.required && !auth.authenticated) return loginScreen();
    await loadBoot();
  } catch (err) {
    clear(root);
    root.append(h('div', { class: 'page narrow' }, h('div', { class: 'banner danger' }, icon('alert'), h('div', {}, h('b', {}, 'Dexter could not start. '), err.message, h('div', { style: { marginTop: '8px' } }, btn('Try again', () => location.reload()))))));
    return;
  }
  window.addEventListener('dexter:unauthenticated', () => loginScreen());
  clear(root);
  const nav = h('nav', { class: 'nav', 'aria-label': 'Main' });
  const bell = btn('', (e) => toggleNotifications(e.currentTarget), { kind: 'ghost', ic: 'bell', title: 'Notifications' });
  const bellCount = h('span', { class: 'tiny', style: { fontWeight: '650', color: 'var(--accent)' } });
  titleEl = h('div', { class: 'title' });
  viewEl = h('main', { class: 'view', id: 'view', tabindex: '-1' });
  shell = h('div', { class: 'shell' },
    h('aside', { class: 'sidebar' },
      h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }, 'D'), h('div', {}, h('div', { class: 'brand-name' }, 'Dexter'), h('div', { class: 'brand-sub' }, `for ${state.boot.profile.name}`))),
      nav, connectionFoot()),
    h('div', { class: 'main' },
      h('header', { class: 'topbar' },
        btn('', () => shell.classList.toggle('nav-open'), { kind: 'ghost', ic: 'menu', title: 'Menu' }),
        titleEl, h('div', { class: 'spacer' }),
        btn('', openSearch, { kind: 'ghost', ic: 'search', title: 'Search (Ctrl+K)' }),
        h('div', { style: { position: 'relative', display: 'flex', alignItems: 'center' } }, bell, bellCount)),
      viewEl));
  shell.querySelector('.topbar .btn')?.classList.add('menu-btn');
  root.append(shell);
  renderNav(nav);
  const drawCounts = () => {
    renderNav(nav);
    bellCount.textContent = state.counts.notifications_unread ? String(state.counts.notifications_unread) : '';
  };
  on('counts', drawCounts);
  drawCounts();
  on('notification.created', (d) => {
    const n = d.notification;
    if (n.level !== 'info') toast(h('span', {}, h('b', {}, n.title), n.body && n.level !== 'briefing' ? ` — ${n.body.slice(0, 120)}` : ''), { timeout: 6000 });
    if (d.desktop) desktopNotify(n);
  });
  window.addEventListener('hashchange', route);
  document.addEventListener('keydown', onKey);
  connectEvents();
  if (!location.hash) location.replace('#/chat');
  route();
  refreshCounts();
}

boot();
