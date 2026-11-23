import { formatDate, formatTime, formatDue, relativeDay, diffDays, formatInstant, addDays, TZ_LABEL } from './shared/dates.js';
import { cleanQuote } from './shared/text.js';

// Dexter runs in two places: as a local server (npm start), or as a page on
// claude.ai where the same core runs in the browser ("hosted").
const HOSTED = document.querySelector('meta[name="dexter-mode"]')?.getAttribute('content') === 'hosted';
let backend = null; // the in-page backend when hosted
let saveState = { state: 'saved' };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let S = null; // server state: { sources, findings, tasks, drafts, meta }
const ui = {
  modal: null,
  pane: 'source', // which pane shows on narrow screens
  selected: null, // selected finding id
  edit: null, // { id, field: 'title' | 'date' }
  askDate: null, // finding id whose "create task" needs a date decision
  filter: 'all',
  selection: null, // { start, end, text } selected in the source pane
  busy: false,
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const by = (kind, id) => (id ? S[kind].find((x) => x.id === id) : null);
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

const ICON = {
  home: '<path d="M4 11.5 12 4l8 7.5V20h-5.5v-5.5h-5V20H4z"/>',
  sources: '<path d="M4 13.5 5.8 6h12.4L20 13.5V19H4z"/><path d="M4 13.5h4.5l1 2.5h5l1-2.5H20"/>',
  tasks: '<path d="m4 6.5 1.6 1.6L8.5 5M4 12.5l1.6 1.6 2.9-3.1M4 18.5l1.6 1.6 2.9-3.1M12 7h8M12 13h8M12 19h8"/>',
  drafts: '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17z"/><path d="m14.5 7.5 3 3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>',
  email: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m4 7 8 6 8-6"/>',
  note: '<path d="M6 3.5h9l4 4V20.5H6z"/><path d="M9 11h7M9 15h5"/>',
  pdf: '<path d="M6 3.5h8l4.5 4.5v12.5H6z"/><path d="M14 3.5V8h4.5M9 13h6M9 16.5h6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  sun: '<circle cx="12" cy="12" r="3.6"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  back: '<path d="m15 6-6 6 6 6"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  cal: '<rect x="4" y="5.5" width="16" height="14.5" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  dots: '<circle cx="6" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="18" cy="12" r="1"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;
const TYPE = { deadline: 'Deadline', decision: 'Decision', question: 'Open question' };
const KIND = { email: 'Email', note: 'Note', pdf: 'PDF' };
const DRAFT_KIND = { email: 'Follow-up email', calendar: 'Calendar event', submission: 'University submission' };

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
async function api(method, path, body, raw) {
  if (HOSTED) {
    try {
      const json = await backend.api(method, path, body, raw);
      if (json.state) S = json.state;
      return json;
    } catch (e) {
      if (!e || !e.status) console.error(e);
      const err = new Error(e && e.status ? e.message : 'Something went wrong inside Dexter. Reload the page; your saved work is kept.');
      err.code = e && e.code;
      throw err;
    }
  }
  const init = { method, headers: {} };
  if (raw) init.body = raw;
  else if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error('Dexter’s server is not reachable. Start it again with “npm start”; your saved work is safe.');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((json.error && json.error.message) || 'Something went wrong.');
    err.code = json.error && json.error.code;
    throw err;
  }
  if (json.state) S = json.state;
  return json;
}

/** Run an action, show a message if it fails, then redraw. */
async function run(fn, okMessage) {
  if (ui.busy) return;
  ui.busy = true;
  try {
    await flushDraft();
    await fn();
    if (okMessage) toast(okMessage);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    ui.busy = false;
    render();
  }
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toast-root').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3200);
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
// A hosted page keeps its place in memory: claude.ai passes only plain #names.
let memHash = '#/home';
const currentHash = () => (HOSTED ? memHash : location.hash);
function route() {
  const [p, q] = (currentHash().slice(1) || '/home').split('?');
  const parts = p.split('/').filter(Boolean);
  return { name: parts[0] || 'home', id: parts[1] || null, params: new URLSearchParams(q || '') };
}
const go = (hash) => {
  if (HOSTED) {
    memHash = hash;
    onRoute();
  } else if (location.hash === hash) render();
  else location.hash = hash;
};

// ---------------------------------------------------------------------------
// Derived data
// ---------------------------------------------------------------------------
const today = () => S.meta.today;
const needsAttention = (t) => t.status === 'open' && (!!t.todayOn || (t.due && t.due.date <= today()));
const toReview = (sourceId) => S.findings.filter((f) => f.sourceId === sourceId && f.status === 'new');
const toConfirm = (sourceId) => S.findings.filter((f) => f.sourceId === sourceId && f.status !== 'dismissed' && f.date && f.date.status === 'needs_confirmation');
const sortByDue = (a, b) => ((a.due ? a.due.date + (a.due.time || '99') : '9999') < (b.due ? b.due.date + (b.due.time || '99') : '9999') ? -1 : 1);

function dueChip(task) {
  if (!task.due) return '';
  const n = diffDays(task.due.date, today());
  const time = task.due.time ? ', ' + formatTime(task.due.time) : '';
  if (task.status === 'done') return `<span class="due">${esc(formatDate(task.due.date, { year: false }))}</span>`;
  if (n < 0) return `<span class="due overdue">Overdue · ${esc(formatDate(task.due.date, { year: false }))}${time}</span>`;
  if (n === 0) return `<span class="due today">Today${time}</span>`;
  return `<span class="due">${n === 1 ? 'Tomorrow' : esc(formatDate(task.due.date, { year: false }))}${time}</span>`;
}
const demoBadge = (item) => (item && item.demo ? '<span class="badge demo">Demo</span>' : '');

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------
function renderNav() {
  const r = route();
  const reviewCount = S.findings.filter((f) => f.status === 'new').length;
  const draftCount = S.drafts.filter((d) => d.status !== 'completed').length;
  const todayCount = S.tasks.filter(needsAttention).length;
  const link = (name, label, ic, count, active, what) =>
    `<a class="nav-link" href="#/${name}" ${active ? 'aria-current="page"' : ''}>${icon(ic)}<span>${label}</span>${count ? `<span class="count num" title="${count} ${what}" aria-label="${count} ${what}">${count}</span>` : ''}</a>`;
  $('#nav').innerHTML = `
    <a class="brand" href="#/home"><span class="brand-mark"><svg viewBox="0 0 24 24"><path d="M8 5h4.5a7 7 0 0 1 0 14H8z"/></svg></span><span>Dexter</span></a>
    ${link('home', 'Home', 'home', 0, r.name === 'home')}
    ${link('sources', 'Sources', 'sources', reviewCount, r.name === 'sources' || r.name === 'source', reviewCount === 1 ? 'finding to review' : 'findings to review')}
    ${link('tasks', 'Tasks', 'tasks', todayCount, r.name === 'tasks', 'need attention today')}
    ${link('drafts', 'Drafts', 'drafts', draftCount, r.name === 'drafts' || r.name === 'draft', draftCount === 1 ? 'draft not done yet' : 'drafts not done yet')}
    ${link('settings', 'Settings', 'settings', 0, r.name === 'settings')}
    <p class="nav-foot">Dates and times are in ${TZ_LABEL}.<br>Nothing is sent, submitted or put on a calendar without your approval.</p>`;
  const pill = $('#ai-pill');
  pill.className = `pill ${S.meta.ai.available ? 'on' : ''}`;
  pill.innerHTML = S.meta.ai.available ? 'AI on' : 'AI off<span class="long">&nbsp;· manual review</span>';
  pill.title = S.meta.ai.available ? (HOSTED ? 'Claude reads sources when you ask, through your Claude account' : `AI extraction is on (${S.meta.ai.model})`) : 'AI extraction is off. Open Settings to see why.';
  renderSaveState();
}

/** "Saving…" / "Saved" / "Not saved" beside the search box on the hosted page. */
function renderSaveState() {
  const el = $('#save-pill');
  if (!el) return;
  el.hidden = !HOSTED;
  if (!HOSTED || !S) return;
  const storage = S.meta.env.storage;
  const st = storage === 'memory' ? { state: 'unsaved' } : saveState;
  el.className = `pill save ${st.state}`;
  el.textContent = st.state === 'saving' ? 'Saving…' : st.state === 'saved' ? 'Saved' : 'Not saved';
  el.title = st.message || (st.state === 'saved' ? (storage === 'account' ? 'Saved to your Claude account, private to you' : 'Saved in this browser only') : st.state === 'unsaved' ? 'Changes in this view are not saved' : '');
}
let lastSaveError = '';
function onSaveStatus(st) {
  saveState = st;
  renderSaveState();
  if (st.state === 'error' && st.message !== lastSaveError) toast(st.message, 'error');
  lastSaveError = st.state === 'error' ? st.message : '';
}

/** Where the work is kept, when that is worth a banner (hosted page only). */
function storageBanner() {
  if (!HOSTED) return '';
  const env = S.meta.env;
  const text = env.notice
    || (env.storage === 'browser' ? 'Dexter can’t reach your Claude account here, so it is saving your work in this browser only.'
      : env.storage === 'memory' ? 'Dexter can’t save in this view, so changes will be lost when you close it.' : '');
  return text ? `<div class="banner warn-banner"><span class="badge warn">Saving</span><p>${esc(text)}</p></div>` : '';
}

let lastRouteKey = '';
function render() {
  if (!S) return;
  renderNav();
  const r = route();
  const main = $('#main');
  const key = r.name + '/' + (r.id || '');
  const keep = {};
  if (key === lastRouteKey) {
    keep.main = main.scrollTop;
    main.querySelectorAll('[data-scroll]').forEach((el) => (keep[el.dataset.scroll] = el.scrollTop));
  }
  const views = { home: viewHome, sources: viewSources, source: viewSource, tasks: viewTasks, drafts: viewDrafts, draft: viewDraft, search: viewSearch, settings: viewSettings };
  const view = views[r.name] || viewHome;
  main.classList.toggle('fixed', r.name === 'source' && !!by('sources', r.id));
  main.innerHTML = view(r);
  if (key === lastRouteKey) {
    main.scrollTop = keep.main || 0;
    main.querySelectorAll('[data-scroll]').forEach((el) => (el.scrollTop = keep[el.dataset.scroll] || 0));
  } else {
    main.scrollTop = 0;
    ui.selection = null;
  }
  lastRouteKey = key;
  renderModal();
  if (r.name !== 'search' && document.activeElement !== $('#search')) $('#search').value = '';
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------
function taskRow(t, { showToday = true } = {}) {
  const source = by('sources', t.sourceId);
  const done = t.status === 'done';
  return `<div class="task-row">
    <button class="check ${done ? 'done' : ''}" data-action="task-toggle-done" data-id="${t.id}" aria-label="${done ? 'Reopen' : 'Mark done'}: ${esc(t.title)}">${icon('check')}</button>
    <button class="row-main" data-action="task-open" data-id="${t.id}">
      <span class="row-title ${done ? 'struck' : ''}" dir="auto">${esc(t.title)}</span>
      <span class="row-meta">${dueChip(t)}${t.status === 'waiting' ? `<span>Waiting on ${esc(t.waitingOn || 'someone')}</span>` : ''}${t.todayOn && !done && (!t.due || t.due.date !== today()) ? '<span>Pinned to Today</span>' : ''}${source ? `<span>${esc(source.title)}</span>` : ''}${demoBadge(t)}</span>
    </button>
    ${showToday && t.status === 'open' ? `<button class="icon-btn ${t.todayOn ? 'on' : ''}" data-action="task-today" data-id="${t.id}" title="${t.todayOn ? 'Remove from Today' : 'Add to Today'}" aria-label="${t.todayOn ? 'Remove from Today' : 'Add to Today'}" aria-pressed="${!!t.todayOn}">${icon('sun')}</button>` : ''}
  </div>`;
}

function viewHome() {
  const attention = S.tasks.filter(needsAttention).sort(sortByDue);
  const waiting = S.tasks.filter((t) => t.status === 'waiting').sort((a, b) => (a.waitingSince < b.waitingSince ? -1 : 1));
  const reviewSources = S.sources.filter((s) => toReview(s.id).length || toConfirm(s.id).length);
  const reviewDrafts = S.drafts.filter((d) => d.status !== 'completed');
  const upcoming = S.tasks.filter((t) => t.status === 'open' && !needsAttention(t) && t.due && diffDays(t.due.date, today()) <= 7).sort(sortByDue);
  const hour = Number(S.meta.time.slice(0, 2));
  const hello = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const reviewCount = reviewSources.reduce((n, s) => n + toReview(s.id).length, 0) + reviewDrafts.length;

  return `<div class="page">
    <div class="page-head">
      <div>
        <p class="eyebrow">${esc(formatDate(today(), { long: true }))} · ${esc(formatTime(S.meta.time))} ${TZ_LABEL}</p>
        <h1>${hello}. Here is where things stand.</h1>
      </div>
    </div>
    ${storageBanner()}
    ${S.meta.hasDemo ? `<div class="banner"><span class="badge demo">Demo</span><p><b>You are looking at demo data.</b> The university and personal items marked Demo are fictional, so you can try Dexter without connecting anything. Your own imports sit alongside them.</p><button class="btn small" data-action="demo-remove">Remove demo data</button></div>` : ''}
    <div class="board">
      <section class="card board-col attention" aria-labelledby="h-att">
        <header><h2 id="h-att">Needs attention today<span class="q">Due today, overdue, or pinned by you</span></h2><span class="big num">${attention.length}</span></header>
        <div class="list">${attention.map((t) => taskRow(t)).join('') || `<p class="empty"><b>Nothing needs you today.</b>Tasks due today, overdue tasks and anything you pin to Today appear here.</p>`}</div>
      </section>
      <section class="card board-col waiting" aria-labelledby="h-wait">
        <header><h2 id="h-wait">Waiting on<span class="q">Other people owe you these</span></h2><span class="big num">${waiting.length}</span></header>
        <div class="list">${waiting.map((t) => {
          const days = t.waitingSince ? diffDays(today(), t.waitingSince) : 0;
          return `<div class="wait-row">
            <button class="row-main" data-action="task-open" data-id="${t.id}" style="padding:0">
              <span class="wait-who">${esc(t.waitingOn || 'Someone')}</span>
              <span class="row-title">${esc(t.title)}</span>
              <span class="row-meta"><span>${days <= 0 ? 'Since today' : `For ${plural(days, 'day')}`}</span>${dueChip(t)}${demoBadge(t)}</span>
            </button>
            <div class="row"><button class="btn small" data-action="task-nudge" data-id="${t.id}">Draft a nudge</button><button class="btn small quiet" data-action="task-resume" data-id="${t.id}">They replied</button></div>
          </div>`;
        }).join('') || `<p class="empty"><b>You are not waiting on anyone.</b>Mark a task as waiting, or send a follow-up, and it shows up here.</p>`}</div>
      </section>
      <section class="card board-col review" aria-labelledby="h-rev">
        <header><h2 id="h-rev">Ready for review<span class="q">Dexter prepared these; you decide</span></h2><span class="big num">${reviewCount}</span></header>
        <div class="list">
          ${reviewSources.map((s) => {
            const n = toReview(s.id).length;
            const c = toConfirm(s.id).length;
            return `<a class="link-row" href="#/source/${s.id}">
              <span class="kind-icon">${icon(s.kind)}</span>
              <span class="row-main" style="padding:0"><span class="row-title">${esc(s.title)}</span>
              <span class="row-meta">${n ? `<span>${plural(n, 'finding')} to review</span>` : ''}${c ? `<span class="badge warn">${plural(c, 'date')} to confirm</span>` : ''}${demoBadge(s)}</span></span>
              <span class="chev">${icon('chev')}</span></a>`;
          }).join('')}
          ${reviewDrafts.map((d) => `<a class="link-row" href="#/draft/${d.id}">
              <span class="kind-icon">${icon(d.kind === 'calendar' ? 'cal' : 'drafts')}</span>
              <span class="row-main" style="padding:0"><span class="row-title">${esc(d.subject || DRAFT_KIND[d.kind])}</span>
              <span class="row-meta"><span>${DRAFT_KIND[d.kind]} · ${esc(destinationText(d))}</span>${d.status === 'approved' ? `<span class="badge ok">Approved, not ${d.kind === 'email' ? 'sent' : 'done'} yet</span>` : '<span class="badge warn">Needs your review</span>'}${demoBadge(d)}</span></span>
              <span class="chev">${icon('chev')}</span></a>`).join('')}
          ${!reviewSources.length && !reviewDrafts.length ? `<p class="empty"><b>Nothing is waiting for review.</b>Import an email, a note or a PDF and Dexter lists what it found here.</p>` : ''}
        </div>
      </section>
    </div>
    ${upcoming.length ? `<section class="coming"><h2>Coming up this week</h2><div class="card list">${upcoming.map((t) => taskRow(t)).join('')}</div></section>` : ''}
  </div>`;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------
function viewSources() {
  return `<div class="page">
    <div class="page-head"><div><h1>Sources</h1><p class="lede">Everything you have given Dexter to read. Open one to see the original beside what Dexter found in it.</p></div>
      <button class="btn primary" data-action="open-import">${icon('sources')}Import source</button></div>
    <div class="source-list">${S.sources.map((s) => {
      const all = S.findings.filter((f) => f.sourceId === s.id);
      const n = toReview(s.id).length;
      const c = toConfirm(s.id).length;
      return `<a class="card source-card" href="#/source/${s.id}">
        <span class="kind-icon">${icon(s.kind)}</span>
        <span style="flex:1;min-width:0;display:grid;gap:3px">
          <span class="row"><h3>${esc(s.title)}</h3>${demoBadge(s)}</span>
          <span class="snippet">${esc(s.text.slice(0, 260))}</span>
          <span class="row-meta" style="margin-top:4px"><span>${KIND[s.kind]} · imported ${esc(formatInstant(s.createdAt))}</span><span>${plural(all.length, 'finding')}</span>${n ? `<span class="badge question">${n} to review</span>` : all.length ? '<span class="badge ok">Reviewed</span>' : ''}${c ? `<span class="badge warn">${plural(c, 'date')} to confirm</span>` : ''}</span>
        </span><span class="chev muted">${icon('chev')}</span></a>`;
    }).join('') || `<div class="card empty"><b>No sources yet.</b>Paste an email, write a note or upload a PDF to get started.</div>`}</div>
  </div>`;
}

function sourceHtml(source, findings) {
  const text = source.text;
  const marks = findings.filter((f) => f.evidence && f.status !== 'dismissed').sort((a, b) => a.evidence.start - b.evidence.start);
  const cuts = (source.pages || []).filter((p) => source.pages.length > 1).map((p) => ({ at: p.start, page: p.number }));
  let html = '';
  let pos = 0;
  const plain = (to) => {
    while (cuts.length && cuts[0].at <= to) {
      const c = cuts.shift();
      html += esc(text.slice(pos, Math.max(pos, c.at))) + `<span class="page-mark" data-page="${c.page}"></span>`;
      pos = Math.max(pos, c.at);
    }
    html += esc(text.slice(pos, to));
    pos = to;
  };
  for (const f of marks) {
    if (f.evidence.start < pos) continue;
    plain(f.evidence.start);
    html += `<mark class="${f.type} ${ui.selected === f.id ? 'sel' : ''}" data-action="mark-click" data-id="${f.id}" title="${TYPE[f.type]}: ${esc(f.title)}">${esc(text.slice(f.evidence.start, f.evidence.end))}</mark>`;
    pos = f.evidence.end;
  }
  plain(text.length);
  return html;
}

function basisText(s) {
  const d = formatDate(s.sourceDate);
  if (s.dateBasis === 'header') return `Written ${d} (from the email’s Date line)`;
  if (s.dateBasis === 'user') return `Written ${d} (set by you)`;
  if (s.dateBasis === 'now') return `Written ${d}`;
  return `Written date unknown. Dexter counts “tomorrow”, “Friday” and similar from ${d}, the day you imported it, and asks you to confirm.`;
}

/** "in 3 days", or "4 days ago · already passed" for dates behind us. */
function whenHint(date) {
  const n = diffDays(date, today());
  if (n < 0) return `<span class="when past">${esc(relativeDay(date, today()))} · already passed</span>`;
  return `<span class="when">${esc(relativeDay(date, today()).replace(/^In /, 'in ').replace(/^Today$/, 'today').replace(/^Tomorrow$/, 'tomorrow'))}</span>`;
}

function dateBox(f) {
  const d = f.date;
  if (ui.edit && ui.edit.id === f.id && ui.edit.field === 'date') {
    return `<form class="datebox" data-form="finding-date" data-id="${f.id}">
      <div class="line"><label class="field"><span>Date</span><input class="input" type="date" name="date" value="${esc(d ? d.date : '')}" required></label>
      <label class="field"><span>Time (optional)</span><input class="input" type="time" name="time" value="${esc(d && d.time ? d.time : '')}"></label></div>
      <p class="small muted">${TZ_LABEL}. Saving also confirms the date.</p>
      <div class="line"><button class="btn small primary" type="submit">Save date</button><button class="btn small quiet" type="button" data-action="edit-cancel">Cancel</button>${d ? `<span class="spacer"></span><button class="btn small quiet danger" type="button" data-action="finding-date-remove" data-id="${f.id}">Remove date</button>` : ''}</div>
    </form>`;
  }
  if (!d) return f.type === 'deadline' ? `<div class="datebox"><div class="line"><span class="muted">No date found in this passage.</span><button class="linkish" data-action="finding-edit" data-field="date" data-id="${f.id}">Add a date</button></div></div>` : '';
  const reading = `${esc(formatDue(d, { long: true }))}`;
  if (d.status === 'needs_confirmation') {
    return `<div class="datebox needs" data-needs-confirmation>
      <div class="line"><span class="badge warn">Confirm this date</span><span class="small muted">Nothing is scheduled until you do.</span></div>
      <p class="reading">${d.phrase ? `The source says <q dir="auto">${esc(d.phrase)}</q>. ` : ''}Dexter reads that as <b>${reading}</b>, ${TZ_LABEL} (${whenHint(d.date)}).</p>
      ${d.reasons.length ? `<ul>${d.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      ${d.basisDate && d.certainty !== 'explicit' ? `<p class="small muted">Counted from the source date, ${esc(formatDate(d.basisDate))}.</p>` : ''}
      <div class="line">
        <button class="btn small primary" data-action="finding-confirm-date" data-id="${f.id}">Confirm ${esc(formatDue(d, { year: false }))}</button>
        ${d.alternatives.map((a, i) => `<button class="btn small" data-action="finding-use-alt" data-id="${f.id}" data-i="${i}" title="${esc(a.label)}">Use ${esc(formatDue(a, { year: false }))}</button>`).join('')}
        <button class="btn small quiet" data-action="finding-edit" data-field="date" data-id="${f.id}">Another date…</button>
      </div>
    </div>`;
  }
  const how = d.confirmedBy === 'you' ? (d.corrected ? 'corrected by you' : 'confirmed by you') : 'stated in the source';
  return `<div class="datebox"><div class="line date-line">${icon('cal')}<span class="grow"><b>${reading}</b> <span class="muted">· ${how}</span> · ${whenHint(d.date)}</span><button class="linkish" data-action="finding-edit" data-field="date" data-id="${f.id}">Change</button></div></div>`;
}

function findingCard(f, source) {
  const task = by('tasks', f.taskId);
  const drafts = S.drafts.filter((d) => d.findingId === f.id);
  const editingTitle = ui.edit && ui.edit.id === f.id && ui.edit.field === 'title';
  const page = source.pages && source.pages.length > 1 && f.evidence ? source.pages.find((p) => f.evidence.start >= p.start && f.evidence.start <= p.end) : null;
  const originLabel = { ai: 'Found by AI', rules: 'Found by built-in rules', manual: 'Added by you' }[f.origin];
  if (f.status === 'dismissed') {
    return `<article class="card finding dismissed" id="f-${f.id}">
      <div class="finding-top"><span class="badge">${TYPE[f.type]}</span><span class="small muted">Dismissed</span><span class="spacer"></span><button class="btn small" data-action="finding-status" data-status="new" data-id="${f.id}">Restore</button></div>
      <p class="finding-title" dir="auto">${esc(f.title)}</p></article>`;
  }
  return `<article class="card finding ${f.type} ${ui.selected === f.id ? 'sel' : ''}" id="f-${f.id}" data-finding="${f.id}">
    <div class="finding-top">
      ${editingTitle
        ? `<select class="input" style="width:auto;min-height:32px;padding:2px 8px" form="ft-${f.id}" name="type">${Object.entries(TYPE).map(([k, v]) => `<option value="${k}" ${k === f.type ? 'selected' : ''}>${v}</option>`).join('')}</select>`
        : `<span class="badge ${f.type}">${TYPE[f.type]}</span>`}
      <span class="small muted">${originLabel}${f.edited ? ' · edited by you' : ''}</span>
      ${f.context === 'earlier' ? '<span class="badge" title="This passage is in an earlier message quoted further down the email">Earlier in the thread</span>' : ''}
      <span class="spacer"></span>
      ${f.status === 'new' ? '<span class="badge question">To review</span>' : '<span class="badge ok">Reviewed</span>'}
    </div>
    ${editingTitle
      ? `<form id="ft-${f.id}" data-form="finding-title" data-id="${f.id}" style="display:grid;gap:8px"><textarea class="input" name="title" rows="2" required>${esc(f.title)}</textarea><div class="row"><button class="btn small primary" type="submit">Save</button><button class="btn small quiet" type="button" data-action="edit-cancel">Cancel</button></div></form>`
      : `<p class="finding-title" dir="auto">${esc(f.title)}</p>`}
    ${f.evidence ? `<blockquote class="evidence"><q dir="auto">${esc(cleanQuote(f.evidence.quote))}</q>
      <span class="where"><span>Original passage${page ? ` · page ${page.number}` : ''}</span><button class="linkish" data-action="show-in-source" data-id="${f.id}">Show in source</button></span></blockquote>` : ''}
    ${dateBox(f)}
    ${ui.askDate === f.id ? `<div class="prompt"><p><b>This date is not confirmed yet.</b> Confirm it above so the task gets the right due date, or create the task without one.</p><div class="row"><button class="btn small" data-action="finding-task-nodate" data-id="${f.id}">Create task without a date</button><button class="btn small quiet" data-action="ask-cancel">Cancel</button></div></div>` : ''}
    ${task ? `<div class="row small"><span class="badge ok">Task</span><button class="linkish" data-action="task-open" data-id="${task.id}">${esc(task.title)}</button><span class="muted">${task.status === 'done' ? 'Done' : task.status === 'waiting' ? `Waiting on ${esc(task.waitingOn || 'someone')}` : task.due ? esc(formatDue(task.due, { year: false })) : 'No due date'}${task.todayOn && task.status === 'open' ? ' · on Today' : ''}</span></div>` : ''}
    ${drafts.map((d) => `<div class="row small"><span class="badge ${d.status === 'needs_review' ? 'warn' : 'ok'}">${d.status === 'needs_review' ? 'Draft to review' : d.status === 'approved' ? 'Draft approved' : 'Draft done'}</span><a href="#/draft/${d.id}">${esc(DRAFT_KIND[d.kind])}</a></div>`).join('')}
    <div class="actions">
      ${!task ? `<button class="btn small" data-action="finding-task" data-id="${f.id}">Create task</button>` : ''}
      ${!task || (!task.todayOn && task.status === 'open') ? `<button class="btn small" data-action="finding-today" data-id="${f.id}">Add to Today</button>` : ''}
      <button class="btn small" data-action="finding-draft" data-kind="email" data-id="${f.id}">Draft follow-up</button>
      <span class="spacer"></span>
      <details class="more"><summary class="icon-btn" aria-label="More actions" title="More actions">${icon('dots')}</summary><div class="menu">
        <button data-action="finding-edit" data-field="title" data-id="${f.id}">Edit title or type</button>
        ${f.date ? `<button data-action="finding-draft" data-kind="calendar" data-id="${f.id}">Propose calendar event</button>` : ''}
        ${f.type === 'deadline' ? `<button data-action="finding-draft" data-kind="submission" data-id="${f.id}">Prepare university submission</button>` : ''}
        ${f.status === 'new' ? `<button data-action="finding-status" data-status="accepted" data-id="${f.id}">Mark as reviewed</button>` : ''}
      </div></details>
      <button class="btn small quiet" data-action="finding-status" data-status="dismissed" data-id="${f.id}">Dismiss</button>
    </div>
  </article>`;
}

function viewSource(r) {
  const s = by('sources', r.id);
  if (!s) return `<div class="page"><div class="card empty"><b>That source is gone.</b><a href="#/sources">Back to sources</a></div></div>`;
  const all = S.findings.filter((f) => f.sourceId === s.id).sort((a, b) => (a.evidence ? a.evidence.start : 0) - (b.evidence ? b.evidence.start : 0));
  const active = all.filter((f) => f.status !== 'dismissed');
  const dismissed = all.filter((f) => f.status === 'dismissed');
  const shown = active.filter((f) => ui.filter === 'all' || f.type === ui.filter);
  const ex = s.extraction || {};
  const count = (type) => active.filter((f) => f.type === type).length;
  const chip = (key, label, n) => `<button class="chip" data-action="filter" data-filter="${key}" aria-pressed="${ui.filter === key}">${label} <span class="num">${n}</span></button>`;
  return `<div class="review">
    <div class="review-head">
      <a class="crumb" href="#/sources">${icon('back')}Sources</a>
      <div class="row"><h1 style="flex:1;min-width:200px">${esc(s.title)}</h1>${demoBadge(s)}
        ${S.meta.ai.available && ex.mode !== 'ai' ? `<button class="btn small" data-action="source-reextract" data-id="${s.id}">Run AI extraction</button>` : ''}
        <button class="btn small quiet danger" data-action="source-delete" data-id="${s.id}">Delete</button></div>
      <p class="small muted">${KIND[s.kind]}${s.filename ? ` · ${esc(s.filename)}` : ''}${s.from ? ` · from ${esc(s.from.name || s.from.email)}` : ''} · ${esc(basisText(s))}</p>
      ${ex.notice ? `<p class="notice warn">${esc(ex.notice)}</p>` : ''}
      <div class="seg" role="group" aria-label="Show">
        <button data-action="pane" data-pane="source" aria-pressed="${ui.pane === 'source'}">Source</button>
        <button data-action="pane" data-pane="findings" aria-pressed="${ui.pane === 'findings'}">Findings (${active.length})</button>
      </div>
    </div>
    <div class="split" data-pane="${ui.pane}">
      <section class="pane pane-source" aria-label="Original source">
        <div class="scroll" data-scroll="source">
          <div class="source-text" id="source-text">${sourceHtml(s, all)}</div>
        </div>
        <div class="sel-bar" id="sel-bar">${selBarHtml()}</div>
      </section>
      <section class="pane pane-findings" data-scroll="findings" aria-label="Findings">
        <div class="pane-label">
          <div class="chips">${chip('all', 'All', active.length)}${chip('deadline', 'Deadlines', count('deadline'))}${chip('decision', 'Decisions', count('decision'))}${chip('question', 'Open questions', count('question'))}</div>
          <span class="spacer"></span>
          <span>${ex.mode === 'ai' ? `AI extraction · ${esc(ex.model || '')}` : S.meta.ai.available ? 'Built-in rules' : `Built-in rules · <a href="#/settings">AI is off</a>`}</span>
        </div>
        <div class="findings">
          ${shown.map((f) => findingCard(f, s)).join('') || `<div class="card empty"><b>${active.length ? 'Nothing of this kind.' : 'Dexter did not find anything here.'}</b>${active.length ? 'Choose another filter above.' : 'That can happen with short or unusual text. Select any passage in the source and add it yourself as a deadline, a decision or an open question.'}</div>`}
        </div>
        ${dismissed.length ? `<details class="dismissed-list"><summary>Dismissed (${dismissed.length})</summary><div class="findings">${dismissed.map((f) => findingCard(f, s)).join('')}</div></details>` : ''}
      </section>
    </div>
  </div>`;
}

function selBarHtml() {
  if (!ui.selection) return `<span class="muted">Missing something? Select any passage in the source to add it as a finding.</span>`;
  return `<span class="quote">Add “${esc(cleanQuote(ui.selection.text))}” as</span>
    <button class="btn small" data-action="manual-add" data-type="deadline">Deadline</button>
    <button class="btn small" data-action="manual-add" data-type="decision">Decision</button>
    <button class="btn small" data-action="manual-add" data-type="question">Open question</button>`;
}

function showInSource(id) {
  ui.selected = id;
  ui.pane = 'source';
  render();
  const mark = $(`#source-text mark[data-id="${id}"]`);
  if (mark) {
    mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
    mark.classList.add('flash');
  }
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------
function viewTasks() {
  const open = S.tasks.filter((t) => t.status === 'open');
  const att = open.filter(needsAttention).sort(sortByDue);
  const upcoming = open.filter((t) => !needsAttention(t) && t.due).sort(sortByDue);
  const someday = open.filter((t) => !needsAttention(t) && !t.due);
  const waiting = S.tasks.filter((t) => t.status === 'waiting');
  const done = S.tasks.filter((t) => t.status === 'done').sort((a, b) => (a.completedAt > b.completedAt ? -1 : 1)).slice(0, 30);
  const section = (title, list, empty) => (list.length || empty ? `<section class="section"><h2>${title}<span class="n num">${list.length}</span></h2><div class="card list">${list.map((t) => taskRow(t)).join('') || `<p class="empty">${empty}</p>`}</div></section>` : '');
  return `<div class="page" style="max-width:860px">
    <div class="page-head"><div><h1>Tasks</h1><p class="lede">Open a task to edit it and see its history.</p></div></div>
    <form class="card add-task" data-form="task-add">
      <input class="input title" name="title" placeholder="Add a task" aria-label="Task title" required>
      <input class="input date" type="date" name="date" aria-label="Due date (optional)">
      <button class="btn primary" type="submit">Add task</button>
    </form>
    ${section('Today', att, 'Nothing is due today.')}
    ${section('Upcoming', upcoming)}
    ${section('No date', someday)}
    ${section('Waiting on others', waiting)}
    ${section('Done', done)}
  </div>`;
}

function taskModal(t) {
  const source = by('sources', t.sourceId);
  const finding = by('findings', t.findingId);
  return `<div class="scrim" data-action="modal-close-scrim"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="mt">
    <header><h2 id="mt">Task</h2>${demoBadge(t)}<button class="icon-btn" data-action="modal-close" aria-label="Close">${icon('x')}</button></header>
    <form class="body" data-form="task-edit" data-id="${t.id}" id="task-form">
      <label class="field"><span>Title</span><input class="input" name="title" value="${esc(t.title)}" required></label>
      <div class="grid-2">
        <label class="field"><span>Due date</span><input class="input" type="date" name="date" value="${esc(t.due ? t.due.date : '')}"></label>
        <label class="field"><span>Time (${TZ_LABEL})</span><input class="input" type="time" name="time" value="${esc(t.due && t.due.time ? t.due.time : '')}"></label>
      </div>
      <div class="grid-2">
        <label class="field"><span>Status</span><select class="input" name="status">
          <option value="open" ${t.status === 'open' ? 'selected' : ''}>With me</option>
          <option value="waiting" ${t.status === 'waiting' ? 'selected' : ''}>Waiting on someone</option>
          <option value="done" ${t.status === 'done' ? 'selected' : ''}>Done</option></select></label>
        <label class="field"><span>Waiting on</span><input class="input" name="waitingOn" value="${esc(t.waitingOn)}" placeholder="Who owes you a reply?"></label>
      </div>
      <label class="row" style="min-height:40px"><input type="checkbox" name="today" ${t.todayOn ? 'checked' : ''} style="width:22px;height:22px"> <span>Show on Today</span></label>
      <label class="field"><span>Notes</span><textarea class="input" name="notes" rows="3">${esc(t.notes)}</textarea></label>
      ${source ? `<p class="small">From ${finding ? `<a href="#/source/${source.id}?f=${finding.id}" data-action="modal-close">${esc(source.title)}</a>` : esc(source.title)}${finding && finding.evidence ? `: <span class="muted">“${esc(cleanQuote(finding.evidence.quote).slice(0, 160))}”</span>` : ''}</p>` : ''}
      <div><h3 style="margin-bottom:8px">History</h3><ol class="history">${[...t.history].reverse().map((h) => `<li><time>${esc(formatInstant(h.at))}</time><span>${esc(h.text)}</span></li>`).join('')}</ol></div>
    </form>
    <footer><button class="btn quiet danger" data-action="task-delete" data-id="${t.id}">Delete</button><button class="btn" data-action="task-nudge" data-id="${t.id}">Draft follow-up</button><span class="spacer"></span><button class="btn quiet" data-action="modal-close">Cancel</button><button class="btn primary" type="submit" form="task-form">Save changes</button></footer>
  </div></div>`;
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------
function destinationText(d) {
  if (d.kind === 'email') return d.destination.to ? `to ${d.destination.name ? d.destination.name + ' ' : ''}<${d.destination.to}>` : 'no recipient yet';
  if (d.kind === 'calendar') return `${d.destination.label}, ${formatDue(d.event, { year: false })}`;
  return d.destination.label;
}
const draftStatus = (d) => (d.status === 'needs_review' ? '<span class="badge warn">Needs your review</span>' : d.status === 'approved' ? '<span class="badge ok">Approved by you</span>' : '<span class="badge">Done</span>');

function viewDrafts() {
  const row = (d) => `<a class="link-row" href="#/draft/${d.id}"><span class="kind-icon">${icon(d.kind === 'calendar' ? 'cal' : 'drafts')}</span>
    <span class="row-main" style="padding:0"><span class="row-title">${esc(d.subject || DRAFT_KIND[d.kind])}</span>
    <span class="row-meta"><span>${DRAFT_KIND[d.kind]} · ${esc(destinationText(d))}</span>${draftStatus(d)}${demoBadge(d)}</span></span><span class="chev">${icon('chev')}</span></a>`;
  const group = (title, list) => (list.length ? `<section class="section"><h2>${title}<span class="n num">${list.length}</span></h2><div class="card list">${list.map(row).join('')}</div></section>` : '');
  return `<div class="page" style="max-width:860px">
    <div class="page-head"><div><h1>Drafts</h1><p class="lede">Follow-ups, calendar events and submissions Dexter prepared. Nothing leaves Dexter until you approve it, and you do the sending yourself.</p></div></div>
    ${group('Needs your review', S.drafts.filter((d) => d.status === 'needs_review'))}
    ${group('Approved, waiting for you to act', S.drafts.filter((d) => d.status === 'approved'))}
    ${group('Done', S.drafts.filter((d) => d.status === 'completed'))}
    ${S.drafts.length ? '' : `<div class="card empty"><b>No drafts yet.</b>Open a source and choose “Draft follow-up” on a finding.</div>`}
  </div>`;
}

const enc = encodeURIComponent;

/** Links that open an approved email ready to send. Nothing is sent by Dexter. */
function emailHandoff(d) {
  const { to } = d.destination;
  const gmail = `https://mail.google.com/mail/?view=cm&fs=1&to=${enc(to)}&su=${enc(d.subject)}&body=${enc(d.body)}`;
  const outlook = `https://outlook.office.com/mail/deeplink/compose?to=${enc(to)}&subject=${enc(d.subject)}&body=${enc(d.body)}`;
  const mailto = `mailto:${enc(to)}?subject=${enc(d.subject)}&body=${enc(d.body)}`;
  return `<p class="small muted">Open it ready to send in</p>
    <div class="row"><a class="btn primary" href="${gmail}" target="_blank" rel="noopener">Gmail</a><a class="btn" href="${outlook}" target="_blank" rel="noopener">Outlook</a><a class="btn" href="${mailto}">Mail app</a></div>
    <div class="row"><button class="btn small" data-action="draft-copy" data-id="${d.id}">Copy text</button><button class="btn small" data-action="copy-address" data-id="${d.id}">Copy address</button></div>`;
}

/** Links that open an approved event in a calendar, where you save it yourself. */
function calendarHandoff(d) {
  const ev = d.event;
  const compact = (date, time) => date.replace(/-/g, '') + (time ? 'T' + time.replace(':', '') + '00' : '');
  let endDate = addDays(ev.date, 1);
  let endTime = null;
  if (ev.time) {
    const mins = Number(ev.time.slice(0, 2)) * 60 + Number(ev.time.slice(3)) + (Number(ev.durationMinutes) || 60);
    endDate = addDays(ev.date, Math.floor(mins / 1440));
    endTime = `${String(Math.floor((mins % 1440) / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  }
  const google = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${enc(d.subject)}&dates=${compact(ev.date, ev.time)}/${compact(endDate, endTime)}&ctz=Asia/Dubai&details=${enc(d.body)}&location=${enc(ev.location || '')}`;
  const iso = (date, time) => (time ? `${date}T${time}:00+04:00` : date);
  const outlook = `https://outlook.office.com/calendar/0/deeplink/compose?subject=${enc(d.subject)}&startdt=${enc(iso(ev.date, ev.time))}&enddt=${enc(iso(endDate, endTime))}${ev.time ? '' : '&allday=true'}&body=${enc(d.body)}&location=${enc(ev.location || '')}`;
  return `<p class="small muted">Add it to your calendar in</p>
    <div class="row"><a class="btn primary" href="${google}" target="_blank" rel="noopener">Google Calendar</a><a class="btn" href="${outlook}" target="_blank" rel="noopener">Outlook</a>${HOSTED ? '' : `<a class="btn" href="/api/drafts/${d.id}/event.ics" download>Calendar file</a>`}</div>
    <div class="row"><button class="btn small" data-action="draft-copy" data-id="${d.id}">Copy details</button></div>`;
}

function draftSide(d) {
  const finding = by('findings', d.findingId);
  const source = by('sources', d.sourceId);
  const approved = d.status === 'approved';
  const done = d.status === 'completed';
  const verb = d.kind === 'email' ? 'send' : d.kind === 'calendar' ? 'add it to your calendar' : 'submit';
  const how = d.kind === 'email'
    ? 'No email account is connected, so Dexter cannot send this. After you approve, open it ready to send in Gmail, Outlook or your mail app, or copy the text.'
    : d.kind === 'calendar'
      ? `No calendar is connected, so Dexter cannot change it. After you approve, add the event in Google Calendar or Outlook${HOSTED ? '' : ', or with the calendar file'}.`
      : 'Dexter cannot submit to university systems. After you approve, copy the text and submit it yourself.';
  return `
    <div class="card">
      <p class="eyebrow">Intended destination</p>
      <div class="dest">
        ${d.kind === 'email' ? `<span class="to">${d.destination.to ? esc(d.destination.to) : '<span class="muted">No recipient yet</span>'}</span>${d.destination.name ? `<span class="muted">${esc(d.destination.name)}</span>` : ''}<span class="small muted">Email, sent by you from your own account</span>`
          : d.kind === 'calendar' ? `<span class="to">${esc(d.destination.label)}</span><span>${esc(formatDue(d.event, { long: true }))}${d.event.time ? ` · ${d.event.durationMinutes} min` : ' · all day'}</span><span class="small muted">${TZ_LABEL}</span>`
            : `<span class="to">${esc(d.destination.label)}</span><span class="small muted">Submitted by you</span>`}
      </div>
      <p class="notice">${how}</p>
    </div>
    <div class="card">
      <div class="row"><p class="eyebrow">Approval</p><span class="spacer"></span>${draftStatus(d)}</div>
      <ol class="steps">
        <li class="${approved || done ? 'done' : 'now'}">Review and edit the draft</li>
        <li class="${approved || done ? 'done' : ''}">Approve it${d.approval ? ` · ${esc(formatInstant(d.approval.at))}` : ''}</li>
        <li class="${done ? 'done' : approved ? 'now' : ''}">You ${verb}</li>
      </ol>
      ${d.status === 'needs_review' ? `<button class="btn primary" data-action="draft-approve" data-id="${d.id}">${d.kind === 'email' ? 'Approve for sending' : d.kind === 'calendar' ? 'Approve calendar change' : 'Approve for submission'}</button>
        <p class="small muted">Approving sends nothing. It unlocks the hand-off below and records that you checked this.</p>` : ''}
      ${approved ? `<div class="handoff">
          ${d.kind === 'email' ? emailHandoff(d) : ''}
          ${d.kind === 'calendar' ? calendarHandoff(d) : ''}
          ${d.kind === 'submission' ? `<div class="row"><button class="btn primary" data-action="draft-copy" data-id="${d.id}">Copy text</button></div>` : ''}
        </div>
        <button class="btn" data-action="draft-complete" data-id="${d.id}">${d.kind === 'email' ? 'I sent it — track the reply' : d.kind === 'calendar' ? 'I added it to my calendar' : 'I submitted it'}</button>
        <p class="small muted">Editing the draft withdraws this approval.</p>` : ''}
      ${done ? `<p class="small muted">${d.kind === 'email' ? 'You marked this as sent. The reply is tracked under “Waiting on”.' : 'You marked this as done.'}</p>` : ''}
    </div>
    ${finding || source ? `<div class="card"><p class="eyebrow">Where this came from</p>
      ${finding ? `<p><span class="badge ${finding.type}">${TYPE[finding.type]}</span> ${esc(finding.title)}</p>${finding.evidence ? `<blockquote class="evidence"><q dir="auto">${esc(cleanQuote(finding.evidence.quote))}</q></blockquote>` : ''}` : ''}
      ${source ? `<a href="#/source/${source.id}${finding ? `?f=${finding.id}` : ''}">Open “${esc(source.title)}”</a>` : ''}</div>` : ''}
    <div class="card"><p class="eyebrow">History</p><ol class="history">${[...d.history].reverse().map((h) => `<li><time>${esc(formatInstant(h.at))}</time><span>${esc(h.text)}</span></li>`).join('')}</ol></div>`;
}

function viewDraft(r) {
  const d = by('drafts', r.id);
  if (!d) return `<div class="page"><div class="card empty"><b>That draft is gone.</b><a href="#/drafts">Back to drafts</a></div></div>`;
  const locked = d.status === 'completed';
  const ro = locked ? 'readonly' : '';
  return `<div class="page">
    <a class="crumb" href="#/drafts">${icon('back')}Drafts</a>
    <div class="page-head" style="margin-top:6px"><div><h1>${DRAFT_KIND[d.kind]}</h1>
      <p class="lede">${d.origin === 'ai' ? 'Written by AI from your source.' : 'Started from a template'}${d.origin !== 'ai' && !S.meta.ai.available ? ' because AI drafting is off.' : d.origin !== 'ai' ? '.' : ''} Edit anything; changes save as you type.</p></div>
      <div class="row">${demoBadge(d)}${locked ? '' : `<button class="btn quiet danger" data-action="draft-delete" data-id="${d.id}">Discard draft</button>`}</div></div>
    ${d.notice ? `<p class="notice warn" style="margin-bottom:14px">${esc(d.notice)}</p>` : ''}
    <div class="draft-layout">
      <form class="card composer" data-draft="${d.id}" data-form="noop">
        ${d.kind === 'email' ? `
          <div class="line"><label for="d-to">To</label><input id="d-to" name="to" type="email" value="${esc(d.destination.to)}" placeholder="name@example.com" ${ro}></div>
          <div class="line"><label for="d-name">Name</label><input id="d-name" name="name" value="${esc(d.destination.name)}" placeholder="Recipient’s name (optional)" ${ro}></div>` : ''}
        ${d.kind === 'submission' ? `<div class="line"><label for="d-label">Submit to</label><input id="d-label" name="label" value="${esc(d.destination.label)}" ${ro}></div>` : ''}
        <div class="line"><label for="d-subject">${d.kind === 'calendar' ? 'Event' : d.kind === 'email' ? 'Subject' : 'Title'}</label><input id="d-subject" name="subject" value="${esc(d.subject)}" ${ro}></div>
        ${d.kind === 'calendar' ? `
          <div class="line"><label for="d-date">Date</label><input id="d-date" name="eventDate" type="date" value="${esc(d.event.date)}" ${ro}></div>
          <div class="line"><label for="d-time">Time</label><input id="d-time" name="eventTime" type="time" value="${esc(d.event.time || '')}" ${ro}><span class="small muted">${TZ_LABEL}; empty means all day</span></div>
          <div class="line"><label for="d-dur">Minutes</label><input id="d-dur" name="eventDuration" type="number" min="5" max="1440" step="5" value="${esc(d.event.durationMinutes)}" ${ro}></div>
          <div class="line"><label for="d-loc">Location</label><input id="d-loc" name="eventLocation" value="${esc(d.event.location)}" ${ro}></div>` : ''}
        <textarea name="body" aria-label="${d.kind === 'calendar' ? 'Event notes' : 'Draft text'}" placeholder="${d.kind === 'calendar' ? 'Notes for the event' : 'Write here'}" ${ro} ${d.kind === 'calendar' ? 'style="min-height:160px"' : ''}>${esc(d.body)}</textarea>
        <div class="foot"><span id="save-state">${locked ? 'Locked: marked as done' : 'All changes saved'}</span></div>
      </form>
      <aside class="side" id="draft-side">${draftSide(d)}</aside>
    </div>
  </div>`;
}

// Draft autosave: edits are sent shortly after typing stops, and always before any other action.
let draftTimer = null;
let draftDirty = null;
function draftPatch(form) {
  const v = (name) => (form.elements[name] ? form.elements[name].value : undefined);
  const patch = { subject: v('subject'), body: v('body') };
  if (form.elements.to) patch.destination = { to: v('to'), name: v('name') };
  if (form.elements.label) patch.destination = { label: v('label') };
  if (form.elements.eventDate) patch.event = { date: v('eventDate'), time: v('eventTime'), durationMinutes: v('eventDuration'), location: v('eventLocation') };
  return patch;
}
async function flushDraft() {
  clearTimeout(draftTimer);
  if (!draftDirty) return;
  const { id, patch } = draftDirty;
  draftDirty = null;
  const label = $('#save-state');
  try {
    await api('PATCH', `/api/drafts/${id}`, patch);
    if (label) label.textContent = `Saved at ${formatTime(S.meta.time)}`;
  } catch (err) {
    if (label) label.textContent = `Not saved: ${err.message}`;
    throw err;
  }
  const side = $('#draft-side');
  const d = by('drafts', id);
  if (side && d && route().id === id) side.innerHTML = draftSide(d);
  renderNav();
}
function onDraftInput(form) {
  draftDirty = { id: form.dataset.draft, patch: draftPatch(form) };
  const label = $('#save-state');
  if (label) label.textContent = 'Saving…';
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => flushDraft().catch(() => {}), 600);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
function highlight(text, terms, around = 90) {
  const lower = text.toLowerCase();
  let first = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (first < 0 || i < first)) first = i;
  }
  const from = first < 0 ? 0 : Math.max(0, first - around);
  const to = Math.min(text.length, (first < 0 ? 0 : first) + around * 2);
  let snip = (from > 0 ? '…' : '') + text.slice(from, to).replace(/\s+/g, ' ') + (to < text.length ? '…' : '');
  snip = esc(snip);
  for (const t of terms) {
    const safe = esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    snip = snip.replace(new RegExp(`(${safe})(?![^<]*>)`, 'gi'), '<mark>$1</mark>');
  }
  return snip;
}

function searchResults(q) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return null;
  const hit = (...fields) => {
    const hay = fields.filter(Boolean).join(' \n ').toLowerCase();
    return terms.every((t) => hay.includes(t));
  };
  return {
    terms,
    sources: S.sources.filter((s) => hit(s.title, s.text, s.filename)),
    findings: S.findings.filter((f) => hit(f.title, f.evidence && f.evidence.quote, TYPE[f.type])),
    tasks: S.tasks.filter((t) => hit(t.title, t.notes, t.waitingOn)),
    drafts: S.drafts.filter((d) => hit(d.subject, d.body, d.destination.to, d.destination.name)),
  };
}

function viewSearch(r) {
  const q = r.params.get('q') || '';
  const res = searchResults(q);
  if (!res) return `<div class="page" style="max-width:860px"><h1>Search</h1><p class="lede muted" style="margin-top:8px">Type in the box above to search your saved sources, findings, tasks and drafts.</p></div>`;
  const total = res.sources.length + res.findings.length + res.tasks.length + res.drafts.length;
  const hl = (text) => highlight(text || '', res.terms);
  const group = (title, items) => (items.length ? `<section class="section"><h2>${title}<span class="n num">${items.length}</span></h2><div class="card list">${items.join('')}</div></section>` : '');
  return `<div class="page" style="max-width:860px">
    <div class="page-head"><div><h1>${total ? plural(total, 'result') : 'No results'} for “${esc(q)}”</h1>${total ? '' : '<p class="lede">Nothing saved in Dexter matches all of those words. Try fewer or different words.</p>'}</div></div>
    ${group('Tasks', res.tasks.map((t) => `<button class="result row-main" style="width:100%" data-action="task-open" data-id="${t.id}"><span class="row-title">${hl(t.title)}</span><span class="snip">${t.status === 'done' ? 'Done' : t.status === 'waiting' ? `Waiting on ${esc(t.waitingOn)}` : t.due ? esc(formatDue(t.due)) : 'No due date'}${t.notes ? ' · ' + hl(t.notes) : ''}</span></button>`))}
    ${group('Findings', res.findings.map((f) => `<a class="result" href="#/source/${f.sourceId}?f=${f.id}"><span class="row"><span class="badge ${f.type}">${TYPE[f.type]}</span><span class="row-title">${hl(f.title)}</span></span>${f.evidence ? `<span class="snip">“${hl(cleanQuote(f.evidence.quote))}”</span>` : ''}</a>`))}
    ${group('Sources', res.sources.map((s) => `<a class="result" href="#/source/${s.id}"><span class="row"><span class="badge">${KIND[s.kind]}</span><span class="row-title">${hl(s.title)}</span></span><span class="snip">${hl(s.text)}</span></a>`))}
    ${group('Drafts', res.drafts.map((d) => `<a class="result" href="#/draft/${d.id}"><span class="row"><span class="badge">${DRAFT_KIND[d.kind]}</span><span class="row-title">${hl(d.subject)}</span></span><span class="snip">${hl(d.body)}</span></a>`))}
  </div>`;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function aiExplain() {
  const ai = S.meta.ai;
  if (HOSTED) {
    if (ai.available) return `<p><span class="badge ok">On</span> When you import a source with “Ask Claude to read it” ticked, Claude reads it through your own Claude account and finds deadlines, decisions and open questions; it also writes follow-up drafts. The first time, you are asked to allow this page to use Claude.</p><p class="small muted">Every finding still has to quote a passage that is in your source, and dates are worked out by Dexter. Untick the box to use only the built-in rules.</p>`;
    const why = ai.reason === 'not_granted'
      ? 'Claude isn’t allowed for this page in this visit. Reload the page to be asked again.'
      : 'Claude can’t be reached from this view, for example when the page is opened outside claude.ai or while signed out.';
    return `<p><span class="badge">Off</span> ${why}</p><p>Dexter still works: built-in rules pick out explicit dates, decisions and questions, you can select any passage in a source to add a finding yourself, and drafts start from templates.</p>`;
  }
  if (ai.available) return `<p><span class="badge ok">On</span> Dexter uses <code>${esc(ai.model)}</code> to find deadlines, decisions and open questions, and to write follow-up drafts. Every AI finding still has to match a passage in your source, and dates are worked out by Dexter, not by the model.</p><p class="small muted">When AI is on, the text of a source you import is sent to Anthropic’s API. You can switch it off for a single import in the import window, or entirely by starting Dexter with <code>DEXTER_AI=off</code>.</p>`;
  const why = ai.reason === 'no_sdk'
    ? 'An API key is set, but the Anthropic SDK is not installed. Stop Dexter, run <code>npm install</code> in the Dexter folder, and start it again.'
    : ai.reason === 'disabled'
      ? 'AI is switched off by <code>DEXTER_AI=off</code>. Remove that setting and restart Dexter to use it.'
      : 'No API key is set. AI extraction is enabled by the <code>ANTHROPIC_API_KEY</code> environment variable.';
  return `<p><span class="badge">Off</span> ${why}</p>
    <p>Dexter is fully usable without it: built-in rules pick out explicit dates, decisions and questions, and you can select any passage in a source to add a finding yourself. Drafts start from templates.</p>
    <p class="small muted">To switch AI on, stop Dexter and start it like this (with your own key from the Anthropic Console):</p>
    <pre>npm install
ANTHROPIC_API_KEY=sk-ant-… npm start</pre>
    <p class="small muted">When AI is on, the text of each source you import is sent to Anthropic’s API. Nothing is sent while it is off.</p>`;
}

function dataExplain() {
  if (!HOSTED) {
    return `<p>Sources, findings, tasks, drafts and their history are saved in one file on this computer, <code>data/dexter.json</code>, after every change. Close Dexter and start it again and everything is as you left it.</p>
      <div class="row"><a class="btn" href="/api/export" download>Download a copy</a></div>`;
  }
  const env = S.meta.env;
  const where = env.storage === 'account'
    ? 'Your sources, findings, tasks, drafts and their history are saved as you go, in a private space in your Claude account that only you can open. If you share this page, other people start with their own empty Dexter and never see yours.'
    : env.storage === 'browser'
      ? 'Dexter can’t reach your Claude account here, so your work is saved in this browser only. Open Dexter on claude.ai while signed in to keep it in your account.'
      : 'Dexter can’t save in this view, so changes will be lost when you close it.';
  return `<p>${esc(env.notice || where)}</p>${env.downloads ? '<div class="row"><button class="btn" data-action="export-data">Save a copy (.json)</button></div>' : ''}`;
}

function viewSettings() {
  return `<div class="page"><div class="page-head"><div><h1>Settings</h1></div></div>
    <div class="settings">
      <section class="card"><h2>AI extraction</h2>${aiExplain()}</section>
      <section class="card"><h2>Connected accounts</h2>
        <p>No accounts are connected, and Dexter does not need any. It never sends email, submits coursework or changes a calendar by itself.</p>
        <dl class="kv">
          <dt>Email</dt><dd>Not connected. Approved follow-ups open ready to send in Gmail, Outlook or your mail app, or you copy the text.</dd>
          <dt>Calendar</dt><dd>Not connected. Approved events open in Google Calendar or Outlook${HOSTED ? '' : ', or as a calendar file'}, where you save them yourself.</dd>
          <dt>University portal</dt><dd>Not connected. Approved submissions are yours to upload.</dd>
        </dl>
        <p class="small muted">Account connections are not part of this version. Only data you import yourself is stored.</p></section>
      <section class="card"><h2>Dates and times</h2><p>Everything is shown and scheduled in <b>Asia/Dubai</b> (UTC+4). It is now ${esc(formatTime(S.meta.time))} on ${esc(formatDate(today(), { long: true }))}.</p>
        <p class="small muted">Unclear dates such as “next Thursday” or “end of the week” are shown with Dexter’s reading and wait for your confirmation before anything is scheduled.</p></section>
      <section class="card"><h2>Your data</h2>
        ${dataExplain()}</section>
      <section class="card"><h2>Demo data</h2>
        <p>${S.meta.hasDemo ? 'The demo is loaded: one fictional university email, one personal note, and the tasks and draft made from them. Everything from the demo carries a Demo label.' : 'The demo data has been removed.'}</p>
        <div class="row">${S.meta.hasDemo ? '<button class="btn" data-action="demo-remove">Remove demo data</button>' : ''}<button class="btn ${S.meta.hasDemo ? 'quiet' : ''}" data-action="demo-restore">${S.meta.hasDemo ? 'Reset demo data' : 'Load demo data'}</button></div></section>
    </div></div>`;
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------
function importModal(m) {
  const tab = (key, label) => `<button type="button" role="tab" aria-selected="${m.tab === key}" data-action="import-tab" data-tab="${key}">${label}</button>`;
  const ai = S.meta.ai.available;
  return `<div class="scrim" data-action="modal-close-scrim"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="mi">
    <header><h2 id="mi">Import a source</h2><button class="icon-btn" data-action="modal-close" aria-label="Close">${icon('x')}</button></header>
    <form class="body" data-form="import" id="import-form">
      <div class="tabs" role="tablist">${tab('email', 'Paste an email')}${tab('note', 'Write a note')}${tab('pdf', 'Upload a PDF')}</div>
      ${m.tab === 'pdf' ? `
        <div class="drop" id="drop">
          <span class="kind-icon">${icon('pdf')}</span>
          <p id="drop-label">${m.file ? `<b>${esc(m.file.name)}</b> · ${Math.max(1, Math.round(m.file.size / 1024))} KB` : 'Drop a PDF here, or choose one.'}</p>
          <div class="row" style="justify-content:center"><label class="btn small">Choose a PDF<input type="file" name="file" accept="application/pdf,.pdf" hidden></label>
          <button class="btn small quiet" type="button" data-action="import-sample-pdf">Use the sample PDF</button></div>
          <p class="small">PDFs need selectable text. Scans are not read; paste their text instead.</p>
        </div>` : `
        <label class="field"><span>${m.tab === 'email' ? 'Email text' : 'Note'}</span>
          <textarea class="input" name="text" rows="10" placeholder="${m.tab === 'email' ? 'Paste the whole email, headers and all. Messy is fine.' : 'Write or paste anything: a reminder, meeting notes, a to-do dump.'}" required>${esc(m.text || '')}</textarea>
          ${m.tab === 'email' ? '<small>If the email includes a From or Date line, Dexter uses them for the reply address and for working out dates.</small>' : ''}</label>
        ${m.tab === 'email' ? '<div><button class="btn small quiet" type="button" data-action="import-sample-email">Fill in a sample email</button></div>' : ''}`}
      <div class="grid-2">
        <label class="field"><span>Title (optional)</span><input class="input" name="title" value="${esc(m.title || '')}" placeholder="${m.tab === 'email' ? 'Defaults to the subject line' : 'Defaults to the first line'}"></label>
        <label class="field"><span>Written on (optional)</span><input class="input" type="date" name="sourceDate" value="${esc(m.sourceDate || '')}" max="${today()}">
          <small>Used to work out “tomorrow” or “next Thursday”.</small></label>
      </div>
      ${ai ? `<label class="row"><input type="checkbox" name="useAI" ${m.useAI === false ? '' : 'checked'} style="width:22px;height:22px"><span>${HOSTED ? 'Ask Claude to read it <span class="muted small">(uses your Claude account; can take up to a minute)</span>' : 'Use AI extraction <span class="muted small">(sends this text to Anthropic’s API)</span>'}</span></label>`
        : HOSTED ? `<p class="notice"><b>Claude isn’t available here.</b> Dexter will use its built-in rules, and you can add anything it misses by selecting text in the source (see <a href="#/settings" data-action="modal-close">Settings</a>).</p>`
          : `<p class="notice"><b>AI extraction is off.</b> Dexter will use its built-in rules, and you can add anything it misses by selecting text in the source. To switch AI on, set <code>ANTHROPIC_API_KEY</code> before starting Dexter (see <a href="#/settings" data-action="modal-close">Settings</a>).</p>`}
    </form>
    <footer>${m.working && m.usingAI ? `<span class="small muted" style="flex:1">${HOSTED ? 'Claude is reading the source…' : 'AI is reading the source…'}</span>${HOSTED ? '<button class="btn quiet" data-action="import-skip-ai">Use built-in rules instead</button>' : ''}` : '<button class="btn quiet" data-action="modal-close">Cancel</button>'}<button class="btn primary" type="submit" form="import-form" ${m.working ? 'disabled' : ''}>${m.working ? 'Reading…' : 'Import and review'}</button></footer>
  </div></div>`;
}

function confirmModal(m) {
  return `<div class="scrim" data-action="modal-close-scrim"><div class="modal narrow" role="alertdialog" aria-modal="true" aria-labelledby="mc">
    <header><h2 id="mc">${esc(m.title)}</h2></header><div class="body"><p>${esc(m.body)}</p></div>
    <footer><button class="btn quiet" data-action="modal-close">${esc(m.cancel || 'Cancel')}</button><button class="btn ${m.danger ? 'danger' : 'primary'}" data-action="confirm-yes">${esc(m.confirm)}</button></footer></div></div>`;
}

function renderModal() {
  const root = $('#modal-root');
  const m = ui.modal;
  if (!m) {
    root.innerHTML = '';
    return;
  }
  if (m.type === 'task') {
    const t = by('tasks', m.id);
    if (!t) { ui.modal = null; root.innerHTML = ''; return; }
    root.innerHTML = taskModal(t);
  } else if (m.type === 'import') root.innerHTML = importModal(m);
  else root.innerHTML = confirmModal(m);
  if (m.fresh) {
    m.fresh = false;
    const first = root.querySelector('textarea, input:not([type=hidden]):not([type=file]), .btn.primary, .btn');
    if (first) first.focus();
  }
}
function openModal(m) {
  ui.modal = { ...m, fresh: true };
  renderModal();
}
function closeModal() {
  ui.modal = null;
  renderModal();
}
const ask = (opts, onYes) => openModal({ type: 'confirm', ...opts, onYes });

function keepImportFields() {
  const form = $('#import-form');
  const m = ui.modal;
  if (!form || !m || m.type !== 'import') return;
  if (form.elements.text) m.text = form.elements.text.value;
  m.title = form.elements.title.value;
  m.sourceDate = form.elements.sourceDate.value;
}

async function submitImport(form) {
  const m = ui.modal;
  keepImportFields();
  const useAI = form.elements.useAI ? form.elements.useAI.checked : false;
  if (m.tab === 'pdf' && !m.file) return toast('Choose a PDF first.', 'error');
  if (m.tab === 'pdf' && m.file.size > 25 * 1048576) return toast('That PDF is larger than 25 MB. Split it, or copy the text you need and paste it as a note.', 'error');
  m.working = true;
  m.useAI = useAI;
  m.usingAI = useAI && S.meta.ai.available;
  renderModal();
  try {
    let res;
    if (m.tab === 'pdf') {
      const q = new URLSearchParams({ filename: m.file.name, title: m.title || '', sourceDate: m.sourceDate || '', useAI: String(useAI) });
      res = await api('POST', `/api/sources/pdf?${q}`, undefined, await m.file.arrayBuffer());
    } else {
      res = await api('POST', '/api/sources', { kind: m.tab, text: m.text, title: m.title, sourceDate: m.sourceDate, useAI });
    }
    const n = S.findings.filter((f) => f.sourceId === res.sourceId).length;
    ui.modal = null;
    ui.selected = null;
    ui.filter = 'all';
    ui.pane = n ? 'findings' : 'source';
    toast(n ? `Imported. Dexter found ${plural(n, 'thing')} to review.` : 'Imported. Nothing was found automatically; select text to add findings.');
    go(`#/source/${res.sourceId}`);
  } catch (err) {
    m.working = false;
    renderModal();
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied.');
  } catch {
    toast('Copying is blocked here. Select the text and copy it by hand.', 'error');
  }
}

const actions = {
  'noop': () => {},
  'open-import': () => openModal({ type: 'import', tab: 'email' }),
  'import-tab': (el) => { keepImportFields(); ui.modal.tab = el.dataset.tab; renderModal(); },
  'import-sample-email': async () => {
    keepImportFields();
    ui.modal.text = await (await fetch('samples/messy-email.txt')).text();
    renderModal();
  },
  'import-sample-pdf': async () => {
    keepImportFields();
    const blob = await (await fetch('samples/course-outline.pdf')).blob();
    ui.modal.file = new File([blob], 'course-outline.pdf', { type: 'application/pdf' });
    renderModal();
  },
  'modal-close': () => closeModal(),
  'modal-close-scrim': (el, ev) => { if (ev.target === el) closeModal(); },
  'confirm-yes': () => {
    const fn = ui.modal.onYes;
    ui.modal = null;
    fn();
  },
  'pane': (el) => { ui.pane = el.dataset.pane; render(); },
  'filter': (el) => { ui.filter = el.dataset.filter; render(); },
  'mark-click': (el) => {
    if (!window.getSelection().isCollapsed) return; // the user is selecting text, not opening the finding
    ui.selected = el.dataset.id;
    ui.pane = 'findings';
    ui.filter = 'all';
    render();
    const card = $(`#f-${el.dataset.id}`);
    if (card) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  },
  'show-in-source': (el) => showInSource(el.dataset.id),
  'edit-cancel': () => { ui.edit = null; render(); },
  'ask-cancel': () => { ui.askDate = null; render(); },
  'finding-edit': (el) => {
    ui.edit = { id: el.dataset.id, field: el.dataset.field };
    render();
    const input = $(`#f-${el.dataset.id} form .input`);
    if (input) input.focus();
  },
  'finding-status': (el) => run(() => api('PATCH', `/api/findings/${el.dataset.id}`, { status: el.dataset.status }), el.dataset.status === 'dismissed' ? 'Dismissed. You can restore it from the Dismissed list.' : ''),
  'finding-confirm-date': (el) => run(async () => { await api('PATCH', `/api/findings/${el.dataset.id}`, { confirmDate: true }); ui.askDate = null; }, 'Date confirmed.'),
  'finding-use-alt': (el) => run(async () => { await api('PATCH', `/api/findings/${el.dataset.id}`, { useAlternative: Number(el.dataset.i) }); ui.askDate = null; }, 'Date changed and confirmed.'),
  'finding-date-remove': (el) => run(async () => { await api('PATCH', `/api/findings/${el.dataset.id}`, { date: null }); ui.edit = null; }),
  'finding-task': (el) => createTaskFrom(el.dataset.id, false),
  'finding-today': (el) => createTaskFrom(el.dataset.id, true),
  'finding-task-nodate': (el) => run(async () => { await api('POST', `/api/findings/${el.dataset.id}/task`, { withoutDate: true, today: ui.askToday }); ui.askDate = null; }, 'Task created without a due date.'),
  'finding-draft': (el) => run(async () => {
    const res = await api('POST', '/api/drafts', { findingId: el.dataset.id, kind: el.dataset.kind });
    go(`#/draft/${res.draftId}`);
  }),
  'manual-add': (el) => {
    const sel = ui.selection;
    if (!sel) return;
    run(async () => {
      const res = await api('POST', `/api/sources/${route().id}/findings`, { type: el.dataset.type, start: sel.start, end: sel.end });
      ui.selection = null;
      ui.selected = res.findingId;
      ui.filter = 'all';
      window.getSelection().removeAllRanges();
      setTimeout(() => { const card = $(`#f-${res.findingId}`); if (card) card.scrollIntoView({ block: 'center' }); }, 0);
    }, 'Added. It is in the findings list.');
  },
  'source-reextract': (el) => run(async () => { const r = await api('POST', `/api/sources/${el.dataset.id}/reextract`); toast(`AI extraction added ${plural(r.added, 'new finding')}.`); }),
  'source-delete': (el) => {
    const s = by('sources', el.dataset.id);
    ask({ title: 'Delete this source?', body: `“${s.title}” and its findings and unsent drafts will be deleted. Tasks you created from it are kept.`, confirm: 'Delete source', danger: true },
      () => run(async () => { await api('DELETE', `/api/sources/${s.id}`); go('#/sources'); }, 'Source deleted.'));
  },
  'task-open': (el) => openModal({ type: 'task', id: el.dataset.id }),
  'task-toggle-done': (el) => {
    const t = by('tasks', el.dataset.id);
    run(() => api('PATCH', `/api/tasks/${t.id}`, { status: t.status === 'done' ? 'open' : 'done' }), t.status === 'done' ? 'Task reopened.' : 'Done.');
  },
  'task-today': (el) => {
    const t = by('tasks', el.dataset.id);
    run(() => api('PATCH', `/api/tasks/${t.id}`, { today: !t.todayOn }));
  },
  'task-resume': (el) => run(() => api('PATCH', `/api/tasks/${el.dataset.id}`, { status: 'open', today: true }), 'Back with you, and on Today.'),
  'task-nudge': (el) => run(async () => {
    const res = await api('POST', '/api/drafts', { taskId: el.dataset.id, kind: 'email' });
    ui.modal = null;
    go(`#/draft/${res.draftId}`);
  }),
  'task-delete': (el) => {
    const t = by('tasks', el.dataset.id);
    ask({ title: 'Delete this task?', body: `“${t.title}” and its history will be deleted.`, confirm: 'Delete task', danger: true },
      () => run(() => api('DELETE', `/api/tasks/${t.id}`), 'Task deleted.'));
  },
  'draft-approve': (el) => run(() => api('POST', `/api/drafts/${el.dataset.id}/approve`), 'Approved. Nothing has been sent; the next step is yours.'),
  'draft-complete': (el) => run(() => api('POST', `/api/drafts/${el.dataset.id}/complete`), 'Recorded.'),
  'draft-copy': (el) => {
    const d = by('drafts', el.dataset.id);
    const text = d.kind === 'email' ? `Subject: ${d.subject}\n\n${d.body}`
      : d.kind === 'calendar' ? [d.subject, `${formatDue(d.event, { long: true })} (${TZ_LABEL})`, d.event.location, '', d.body].filter((x) => x !== undefined && x !== null).join('\n')
        : d.body;
    return copyText(text);
  },
  'copy-address': (el) => copyText(by('drafts', el.dataset.id).destination.to),
  'export-data': async () => {
    try {
      if (await backend.saveFile('dexter-export.json', backend.exportData())) toast('Saved.');
      else toast('Saving files isn’t available in this view.', 'error');
    } catch (e) {
      if (!e || e.code !== 'declined') toast('The file wasn’t saved.', 'error');
    }
  },
  'import-skip-ai': () => { if (backend) backend.abortAI(); },
  'draft-delete': (el) => ask({ title: 'Discard this draft?', body: 'The draft will be deleted. The finding it came from is kept.', confirm: 'Discard draft', danger: true },
    () => run(async () => { draftDirty = null; await api('DELETE', `/api/drafts/${el.dataset.id}`); go('#/drafts'); }, 'Draft discarded.')),
  'demo-remove': () => ask({ title: 'Remove the demo data?', body: 'The fictional sources, tasks and drafts marked Demo will be removed. Anything you imported yourself stays. You can load the demo again from Settings.', confirm: 'Remove demo data' },
    () => run(() => api('POST', '/api/demo/remove'), 'Demo data removed.')),
  'demo-restore': () => run(() => api('POST', '/api/demo/restore'), 'Demo data loaded.'),
};

function createTaskFrom(id, pinToday) {
  const f = by('findings', id);
  if (!f.taskId && f.date && f.date.status === 'needs_confirmation') {
    ui.askDate = id;
    ui.askToday = pinToday;
    render();
    const card = $(`#f-${id} .prompt`);
    if (card) card.scrollIntoView({ block: 'nearest' });
    return;
  }
  run(() => api('POST', `/api/findings/${id}/task`, { today: pinToday }), pinToday ? 'On Today.' : 'Task created.');
}

const forms = {
  'noop': () => {},
  'import': (form) => submitImport(form),
  'finding-title': (form) => run(async () => {
    await api('PATCH', `/api/findings/${form.dataset.id}`, { title: form.elements.title.value, type: document.querySelector(`select[form="${form.id}"]`).value });
    ui.edit = null;
  }, 'Saved.'),
  'finding-date': (form) => run(async () => {
    await api('PATCH', `/api/findings/${form.dataset.id}`, { date: { date: form.elements.date.value, time: form.elements.time.value } });
    ui.edit = null;
    ui.askDate = null;
  }, 'Date saved and confirmed.'),
  'task-add': (form) => run(async () => {
    await api('POST', '/api/tasks', { title: form.elements.title.value, due: form.elements.date.value ? { date: form.elements.date.value } : null });
  }, 'Task added.'),
  'task-edit': (form) => run(async () => {
    const e = form.elements;
    await api('PATCH', `/api/tasks/${form.dataset.id}`, {
      title: e.title.value, notes: e.notes.value, status: e.status.value, waitingOn: e.waitingOn.value, today: e.today.checked,
      due: e.date.value ? { date: e.date.value, time: e.time.value } : null,
    });
    ui.modal = null;
  }, 'Task saved.'),
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
document.addEventListener('click', (ev) => {
  let el = ev.target.closest('[data-action]');
  // The backdrop only reacts to clicks on itself, never to clicks inside the dialog.
  if (el && el.dataset.action === 'modal-close-scrim' && ev.target !== el) el = null;
  // close any open "more" menu when clicking elsewhere
  document.querySelectorAll('details.more[open]').forEach((d) => { if (!d.contains(ev.target) || (el && el.closest('.menu'))) d.removeAttribute('open'); });
  // On the hosted page, links to other views change the view in memory.
  const link = HOSTED ? ev.target.closest('a[href^="#/"]') : null;
  if (link) ev.preventDefault();
  const fn = el && actions[el.dataset.action];
  if (fn) {
    if (el.tagName === 'BUTTON') ev.preventDefault();
    Promise.resolve(fn(el, ev)).catch((err) => toast(err.message, 'error'));
  }
  if (link) go(link.getAttribute('href'));
});
document.addEventListener('submit', (ev) => {
  const form = ev.target.closest('[data-form]');
  if (!form) return;
  ev.preventDefault();
  forms[form.dataset.form](form);
});
document.addEventListener('input', (ev) => {
  const form = ev.target.closest('form[data-draft]');
  if (form) onDraftInput(form);
  if (ev.target.id === 'search') {
    const q = ev.target.value.trim();
    const hash = q ? `#/search?q=${encodeURIComponent(q)}` : '#/search';
    if (route().name !== 'search') go(hash);
    else if (HOSTED) memHash = hash;
    else history.replaceState(null, '', hash);
    if (route().name === 'search') { renderNav(); $('#main').innerHTML = viewSearch(route()); }
  }
});
document.addEventListener('change', (ev) => {
  if (ev.target.type === 'file' && ui.modal && ui.modal.type === 'import') {
    keepImportFields();
    ui.modal.file = ev.target.files[0] || null;
    renderModal();
  }
});
document.addEventListener('dragover', (ev) => { if ($('#drop')) { ev.preventDefault(); $('#drop').classList.add('over'); } });
document.addEventListener('dragleave', () => { if ($('#drop')) $('#drop').classList.remove('over'); });
document.addEventListener('drop', (ev) => {
  if (!$('#drop')) return;
  ev.preventDefault();
  const file = [...ev.dataTransfer.files].find((f) => /pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!file) return toast('That is not a PDF.', 'error');
  keepImportFields();
  ui.modal.file = file;
  renderModal();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && ui.modal) return closeModal();
  if (ev.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && !ui.modal) {
    ev.preventDefault();
    $('#search').focus();
  }
});

// Selecting text in the source offers to add it as a finding.
let selTimer = null;
document.addEventListener('selectionchange', () => {
  clearTimeout(selTimer);
  selTimer = setTimeout(() => {
    const box = $('#source-text');
    const bar = $('#sel-bar');
    if (!box || !bar) return;
    const sel = window.getSelection();
    let next = null;
    if (sel.rangeCount && !sel.isCollapsed && box.contains(sel.anchorNode) && box.contains(sel.focusNode)) {
      const range = sel.getRangeAt(0);
      const pre = document.createRange();
      pre.selectNodeContents(box);
      pre.setEnd(range.startContainer, range.startOffset);
      const start = pre.toString().length;
      const text = range.toString();
      if (text.trim().length >= 2) next = { start, end: start + text.length, text };
    } else if (bar.contains(document.activeElement) || (sel.anchorNode && bar.contains(sel.anchorNode))) {
      return; // keep the selection while the user is pressing a button in the bar
    }
    ui.selection = next;
    bar.innerHTML = selBarHtml();
  }, 120);
});
document.addEventListener('mousedown', (ev) => { if (ev.target.closest('#sel-bar button')) ev.preventDefault(); });

async function onRoute() {
  await flushDraft().catch(() => {});
  const r = route();
  if (r.name === 'source' && r.params.get('f')) {
    ui.filter = 'all';
    ui.selected = r.params.get('f');
    ui.pane = 'findings';
  }
  else if (r.name === 'source' && r.name + '/' + r.id !== lastRouteKey) {
    ui.selected = null;
    ui.filter = 'all';
    ui.pane = S && toReview(r.id).length ? 'findings' : 'source';
  }
  ui.edit = null;
  ui.askDate = null;
  if (r.name === 'search' && document.activeElement !== $('#search')) $('#search').value = r.params.get('q') || '';
  render();
  if (r.name === 'source' && r.params.get('f')) {
    const card = $(`#f-${r.params.get('f')}`);
    if (card) card.scrollIntoView({ block: 'center' });
    const mark = $(`#source-text mark[data-id="${r.params.get('f')}"]`);
    if (mark) mark.scrollIntoView({ block: 'center' });
  }
}
if (!HOSTED) window.addEventListener('hashchange', onRoute);
window.addEventListener('beforeunload', () => {
  // save an edit typed in the last moment before closing the tab
  if (!draftDirty) return;
  if (HOSTED) flushDraft().catch(() => {});
  else fetch(`/api/drafts/${draftDirty.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draftDirty.patch), keepalive: true });
});
// Keep "today" honest if the app stays open past midnight or the server restarts.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || ui.busy || draftDirty || ui.modal || ui.edit) return;
  try { await api('GET', '/api/state'); render(); } catch { /* shown on next action */ }
});

(async function start() {
  try {
    if (HOSTED) {
      $('#main').innerHTML = `<div class="page"><div class="card empty"><b>Opening your command center…</b>Loading your sources, tasks and drafts.</div></div>`;
      const { start: startHosted } = await import('./hosted.js');
      backend = await startHosted({ onSaveStatus });
    }
    await api('GET', '/api/state');
  } catch (err) {
    $('#main').innerHTML = `<div class="page"><div class="card empty"><b>Dexter could not load.</b>${esc(err.message)}</div></div>`;
    return;
  }
  const r = route();
  if (r.name === 'search') $('#search').value = r.params.get('q') || '';
  if (r.name === 'source' && r.params.get('f')) { ui.selected = r.params.get('f'); ui.pane = 'findings'; }
  else if (r.name === 'source') ui.pane = toReview(r.id).length ? 'findings' : 'source';
  render();
})();
