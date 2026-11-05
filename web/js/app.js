// App shell: one quiet sidebar (new chat, four places, recent chats, profile
// menu), a hash router, notifications, search and keyboard shortcuts.
import { h, clear, btn, toast, errorToast, dialog, fmtAgo, loading, debounce } from './dom.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { state, on, loadBoot, connectEvents, refreshCounts } from './store.js';
import { renderMarkdown } from './markdown.js';
import * as chat from './views/chat.js';
import * as today from './views/today.js';
import * as tasks from './views/tasks.js';
import * as projects from './views/projects.js';
import * as files from './views/files.js';
import * as approvals from './views/approvals.js';
import * as settings from './views/settings.js';

const NAV = [
  { key: 'today', label: 'Today', ic: 'today', view: today },
  { key: 'tasks', label: 'Tasks', ic: 'tasks', view: tasks },
  { key: 'projects', label: 'Courses', ic: 'projects', view: projects },
  { key: 'files', label: 'Files', ic: 'files', view: files },
];
const VIEWS = { chat, today, tasks, projects, files, approvals, settings };
const TITLES = { chat: 'Chat', today: 'Today', tasks: 'Tasks', projects: 'Courses', files: 'Files', approvals: 'Approvals', settings: 'Settings' };

export const assistantName = () => state.boot?.profile.assistant_name || 'Dexter Almana';

const root = document.getElementById('app');
let viewEl; let shell; let mobileTitle; let cleanup = null; let currentKey = null; let currentParams = [];
const navLinks = new Map();
let recentsEl; let attentionEl;

export function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [p, qs] = raw.split('?');
  const segs = p.split('/').filter(Boolean).map(decodeURIComponent);
  let key = segs[0] || 'chat';
  let params = segs.slice(1);
  if (key === 'memory') { key = 'settings'; params = ['memory']; }
  if (!VIEWS[key]) key = 'chat';
  return { key, params, query: new URLSearchParams(qs || '') };
}

function setTitle(t) {
  document.title = `${t} · ${assistantName()}`;
  if (mobileTitle) mobileTitle.textContent = t;
}

function route() {
  const { key, params, query } = parseRoute();
  for (const [k, a] of navLinks) {
    const on = k === key;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  shell?.classList.remove('nav-open');
  if (typeof cleanup === 'function') { try { cleanup(); } catch (e) { console.error(e); } }
  cleanup = null;
  currentKey = key; currentParams = params;
  setTitle(key === 'chat' ? assistantName() : TITLES[key]);
  clear(viewEl);
  highlightRecent();
  try {
    cleanup = VIEWS[key].mount(viewEl, { params, query, navigate, setTitle });
  } catch (err) {
    console.error(err);
    viewEl.append(h('div', { class: 'page' }, h('div', { class: 'banner danger' }, icon('alert'), h('div', {}, `This page failed to load: ${err.message}`))));
  }
}

// ------------------------------------------------------------------ menus
let openMenuEl = null;
function closeMenu() { openMenuEl?.remove(); openMenuEl = null; document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', escClose); }
function outside(e) { if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu(); }
function escClose(e) { if (e.key === 'Escape') closeMenu(); }

export function openMenu(anchor, items, { above = false, align = 'left' } = {}) {
  closeMenu();
  const menu = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (it === '-') { menu.append(h('div', { class: 'sep' })); continue; }
    if (it.info) { menu.append(h('div', { class: 'tiny muted', style: { padding: '4px 10px' } }, it.info)); continue; }
    menu.append(h('button', { type: 'button', role: 'menuitem', onclick: () => { closeMenu(); it.onClick(); } }, it.ic ? icon(it.ic, 16) : null, it.label, it.hint ? h('span', { class: 'hint' }, it.hint) : null));
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth; const mh = menu.offsetHeight;
  let left = align === 'right' ? r.right - mw : r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
  const top = above ? Math.max(8, r.top - mh - 6) : Math.min(r.bottom + 6, window.innerHeight - mh - 8);
  menu.style.left = `${left}px`; menu.style.top = `${top}px`;
  openMenuEl = menu;
  setTimeout(() => { document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', escClose); menu.querySelector('button')?.focus(); }, 0);
}

// ------------------------------------------------------------------ theme
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('dexter-theme', t); } catch { /* private mode */ }
}
try { applyTheme(localStorage.getItem('dexter-theme') || 'system'); } catch { /* ignore */ }

// ------------------------------------------------------------------ notifications
async function showNotifications(anchor) {
  closeMenu();
  const pop = h('div', { class: 'popover', role: 'dialog', 'aria-label': 'Notifications' }, loading());
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8))}px`;
  pop.style.top = `${r.bottom + 6}px`;
  openMenuEl = pop;
  setTimeout(() => { document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', escClose); }, 0);
  try {
    const { notifications } = await api.get('/api/notifications');
    if (openMenuEl !== pop) return;
    clear(pop);
    pop.append(h('div', { class: 'card-head' }, h('h2', {}, 'Notifications'), notifications.some((n) => !n.read_at) ? btn('Mark all read', async () => { await api.post('/api/notifications/read-all'); closeMenu(); }, { kind: 'ghost', size: 'sm' }) : null));
    if (!notifications.length) pop.append(h('div', { class: 'empty' }, 'Reminders, briefings and alerts will appear here.'));
    for (const n of notifications.slice(0, 40)) {
      pop.append(h('div', { class: `notif${n.read_at ? '' : ' unread'}`, tabindex: '0', role: 'button', onclick: async () => {
        await api.post(`/api/notifications/${n.id}/read`).catch(() => {});
        closeMenu();
        if (n.level === 'briefing') dialog({ title: n.title, body: h('div', { class: 'prose' }, renderMarkdown(n.body || '')), wide: true });
        else if (n.link) navigate(n.link);
      } },
      h('div', { class: 'grow' }, h('div', { class: 't' }, n.title), n.body ? h('div', { class: 'b' }, n.body.replace(/[#*_`]/g, '').slice(0, 200)) : null, h('div', { class: 'tiny muted' }, fmtAgo(n.created_at)))));
    }
  } catch (err) { errorToast(err); }
}

function desktopNotify(n) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
  try {
    const notif = new Notification(n.title, { body: (n.body || '').replace(/[#*_`]/g, '').slice(0, 180), tag: n.id, icon: '/assets/icon.svg' });
    notif.onclick = () => { window.focus(); if (n.link) navigate(n.link); notif.close(); };
  } catch { /* unsupported */ }
}

// ------------------------------------------------------------------ search
function openSearch() {
  const input = h('input', { class: 'input', type: 'search', placeholder: 'Search chats, tasks, memories, files…', 'aria-label': 'Search' });
  const results = h('div', { class: 'search-results' });
  const run = debounce(async () => {
    const q = input.value.trim();
    clear(results);
    if (!q) return;
    try {
      const r = await api.get(`/api/search?q=${encodeURIComponent(q)}`);
      const group = (title, items, map) => { if (!items?.length) return; results.append(h('div', { class: 'group' }, title)); for (const it of items) results.append(map(it)); };
      const link = (href, ic, text) => h('a', { href, onclick: () => d.close() }, icon(ic, 16), h('span', { class: 'ellipsis' }, text));
      group('Chats', r.conversations, (c) => link(`#/chat/${c.id}`, 'chat', c.title));
      group('Tasks', r.tasks, (t) => link(`#/tasks/${t.id}`, 'tasks', t.title));
      group('Memories', r.memories, (m) => link('#/settings/memory', 'memory', m.content));
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
    h('dt', {}, h('kbd', {}, 'Alt'), ' ', h('kbd', {}, 'N')), h('dd', {}, 'New chat'),
    h('dt', {}, h('kbd', {}, 'Alt'), ' ', h('kbd', {}, '1–4')), h('dd', {}, 'Today, Tasks, Courses, Files'),
    h('dt', {}, h('kbd', {}, '/')), h('dd', {}, 'Focus the message box'),
    h('dt', {}, h('kbd', {}, 'Esc')), h('dd', {}, 'Close menus and dialogs')) });
}

function onKey(e) {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); return; }
  if (e.altKey && /^[1-4]$/.test(e.key)) { e.preventDefault(); navigate(`#/${NAV[Number(e.key) - 1].key}`); return; }
  if (e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); navigate('#/chat'); return; }
  if (typing) return;
  if (e.key === '/' && currentKey === 'chat') { e.preventDefault(); document.querySelector('.composer textarea')?.focus(); }
  if (e.key === '?') shortcutsHelp();
}

// ------------------------------------------------------------------ sidebar
function highlightRecent() {
  if (!recentsEl) return;
  for (const a of recentsEl.querySelectorAll('a')) a.classList.toggle('active', currentKey === 'chat' && a.dataset.id === currentParams[0]);
}

async function loadRecents() {
  if (!recentsEl) return;
  let convs = [];
  try { convs = (await api.get('/api/conversations')).conversations; } catch { return; }
  clear(recentsEl);
  if (!convs.length) { recentsEl.append(h('div', { class: 'none' }, 'Your chats will appear here.')); return; }
  for (const c of convs.slice(0, 40)) {
    const live = ['running', 'awaiting_approval', 'blocked'].includes(c.last_run_status);
    recentsEl.append(h('a', { href: `#/chat/${c.id}`, dataset: { id: c.id }, title: c.title },
      live ? h('span', { class: `dot ${c.last_run_status === 'running' ? 'live' : 'warn'}`, title: c.last_run_status.replace('_', ' ') }) : null,
      h('span', {}, c.title)));
  }
  highlightRecent();
}
const loadRecentsSoon = debounce(loadRecents, 300);

function drawAttention() {
  if (!attentionEl) return;
  clear(attentionEl);
  const a = state.counts.approvals || 0;
  const hd = state.counts.handoffs || 0;
  if (!a && !hd) { attentionEl.hidden = true; return; }
  attentionEl.hidden = false;
  const parts = [];
  if (a) parts.push(`${a} approval${a > 1 ? 's' : ''} waiting`);
  if (hd) parts.push(`${hd} sign-in${hd > 1 ? 's' : ''} needed`);
  attentionEl.href = a ? '#/approvals' : '#/today';
  attentionEl.append(h('span', { class: 'pulse' }), parts.join(' · '));
}

function profileMenu(anchor) {
  const b = state.boot;
  const i = b.integrations;
  const items = [
    { info: `${i.anthropic.configured ? '● Claude connected' : '○ Claude not connected'} · ${i.google.connected ? '● Google connected' : '○ Google not connected'}` },
    '-',
    { label: 'Settings', ic: 'settings', onClick: () => navigate('#/settings') },
    { label: 'Memory', ic: 'memory', onClick: () => navigate('#/settings/memory') },
    { label: 'Reminders & routines', ic: 'clock', onClick: () => navigate('#/tasks/schedules') },
    { label: 'Approvals', ic: 'approvals', onClick: () => navigate('#/approvals') },
    '-',
    { label: 'Light', ic: 'sun', onClick: () => applyTheme('light') },
    { label: 'Dark', ic: 'moon', onClick: () => applyTheme('dark') },
    { label: 'Match system', ic: 'monitor', onClick: () => applyTheme('system') },
    '-',
    { label: 'Keyboard shortcuts', ic: 'bolt', hint: '?', onClick: shortcutsHelp },
  ];
  if (state.authRequired) items.push({ label: 'Sign out', ic: 'logout', onClick: async () => { await api.post('/api/auth/logout').catch(() => {}); location.reload(); } });
  openMenu(anchor, items, { above: true });
}

// ------------------------------------------------------------------ login
async function loginScreen() {
  clear(root);
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', 'aria-label': 'Password' });
  const err = h('div', { class: 'small', style: { color: 'var(--danger)', minHeight: '20px', marginTop: '6px' } });
  root.append(h('div', { class: 'login' }, h('form', { class: 'card card-pad', onsubmit: async (e) => {
    e.preventDefault();
    try { await api.post('/api/auth/login', { password: pw.value }); location.reload(); } catch (x) { err.textContent = x.message; }
  } }, h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '18px' } }, h('div', { class: 'mark lg' }, 'D'), h('h1', { style: { fontSize: '24px' } }, 'Dexter Almana')),
  h('div', { class: 'field' }, h('label', {}, 'Password'), pw), err, btn('Sign in', null, { kind: 'primary', type: 'submit' }))));
  pw.focus();
}

// ------------------------------------------------------------------ boot
async function boot() {
  try {
    const auth = await api.get('/api/auth/status');
    state.authRequired = auth.required;
    if (auth.required && !auth.authenticated) return loginScreen();
    await loadBoot();
  } catch (err) {
    clear(root);
    root.append(h('div', { class: 'page narrow' }, h('div', { class: 'banner danger' }, icon('alert'), h('div', {}, h('b', {}, 'Dexter Almana could not start. '), err.message, h('div', { style: { marginTop: '8px' } }, btn('Try again', () => location.reload()))))));
    return;
  }
  window.addEventListener('dexter:unauthenticated', () => loginScreen());
  clear(root);
  const b = state.boot;
  const bellBadge = h('span', { class: 'badge', hidden: true });
  const bell = h('button', { class: 'icon-btn', type: 'button', title: 'Notifications', 'aria-label': 'Notifications', onclick: (e) => showNotifications(e.currentTarget) }, icon('bell', 17), bellBadge);
  const nav = h('nav', { class: 'side-nav', 'aria-label': 'Main' });
  for (const item of NAV) {
    const a = h('a', { href: `#/${item.key}` }, icon(item.ic, 17), item.label);
    navLinks.set(item.key, a);
    nav.append(a);
  }
  attentionEl = h('a', { class: 'attention', hidden: true });
  recentsEl = h('nav', { class: 'recents', 'aria-label': 'Recent chats' });
  const initials = (b.profile.name || 'S').trim().slice(0, 1).toUpperCase();
  const me = h('button', { class: 'me', type: 'button', 'aria-label': 'Profile and settings', onclick: (e) => profileMenu(e.currentTarget) },
    h('span', { class: 'avatar' }, initials), h('span', { class: 'who' }, h('b', {}, b.profile.name), h('span', {}, b.profile.university.replace(/\s*\(.*\)/, ''))), icon('more', 16));
  mobileTitle = h('div', { class: 't' });
  viewEl = h('main', { class: 'view', id: 'view', tabindex: '-1' });
  shell = h('div', { class: 'shell' },
    h('aside', { class: 'sidebar' },
      h('div', { class: 'side-head' },
        h('a', { class: 'side-brand', href: '#/chat', title: 'New chat' }, h('span', { class: 'mark' }, 'D'), h('span', { class: 'name' }, assistantName())),
        h('button', { class: 'icon-btn', type: 'button', title: 'Search (Ctrl+K)', 'aria-label': 'Search', onclick: openSearch }, icon('search', 17)),
        bell),
      h('a', { class: 'new-chat', href: '#/chat' }, h('span', { class: 'plus' }, icon('plus', 15)), 'New chat'),
      nav, attentionEl,
      h('div', { class: 'side-label' }, 'Recents'), recentsEl,
      me),
    h('div', { class: 'main' },
      h('header', { class: 'mobile-bar' },
        h('button', { class: 'icon-btn', type: 'button', title: 'Menu', 'aria-label': 'Menu', onclick: () => shell.classList.toggle('nav-open') }, icon('menu', 19)),
        mobileTitle,
        h('a', { class: 'icon-btn', href: '#/chat', title: 'New chat', 'aria-label': 'New chat' }, icon('compose', 18))),
      viewEl));
  root.append(shell);

  on('counts', () => { drawAttention(); bellBadge.hidden = !state.counts.notifications_unread; });
  on('boot', () => { const n = shell.querySelector('.side-brand .name'); if (n) n.textContent = assistantName(); });
  on('notification.created', (d) => {
    const n = d.notification;
    if (n.level !== 'info' && n.source_type !== 'approval') toast(h('span', {}, h('b', {}, n.title), n.body && n.level !== 'briefing' ? ` — ${n.body.slice(0, 120)}` : ''), { timeout: 6000 });
    if (d.desktop) desktopNotify(n);
  });
  for (const t of ['conversation.updated', 'conversation.deleted', 'conversation.message', 'run.updated']) on(t, loadRecentsSoon);
  window.addEventListener('hashchange', route);
  document.addEventListener('keydown', onKey);
  connectEvents();
  drawAttention();
  bellBadge.hidden = !state.counts.notifications_unread;
  loadRecents();
  route();
  refreshCounts();
}

boot();
