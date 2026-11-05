// Tasks (grouped by when they're due) and Reminders & routines (the scheduler).
import { h, clear, btn, statusChip, fmtWhen, fmtDateTime, errorToast, toast, confirmDialog, empty, loading, debounce, toLocalInput, dialog } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { state, on } from '../store.js';
import { taskStatus, STATUS_LABELS, loadProjects, projectSelect, projectLabel, toolLabel } from './common.js';
import { assistantName } from '../app.js';

export function mount(container, ctx) {
  const tab = ctx.params[0] === 'schedules' ? 'schedules' : 'tasks';
  const page = h('div', { class: 'page' });
  container.append(page);
  page.append(h('div', { class: 'page-head' }, h('h1', {}, tab === 'tasks' ? 'Tasks' : 'Reminders & routines')),
    h('div', { class: 'tabs', role: 'tablist' },
      h('a', { href: '#/tasks', class: tab === 'tasks' ? 'on' : '', role: 'tab', 'aria-selected': String(tab === 'tasks') }, 'Tasks'),
      h('a', { href: '#/tasks/schedules', class: tab === 'schedules' ? 'on' : '', role: 'tab', 'aria-selected': String(tab === 'schedules') }, 'Reminders & routines')));
  const body = h('div');
  page.append(body);
  return tab === 'schedules' ? mountSchedules(body) : mountTasks(body, ctx);
}

function groupOf(t, now) {
  if (t.status === 'completed' || t.status === 'cancelled') return 'Done';
  if (!t.due_at) return 'No date';
  const d = new Date(t.due_at);
  if (d < now) return 'Overdue';
  const days = (d - now) / 86400000;
  if (fmtWhen(t.due_at).startsWith('today')) return 'Today';
  if (days < 7) return 'This week';
  return 'Later';
}
const GROUPS = ['Overdue', 'Today', 'This week', 'Later', 'No date', 'Done'];

function mountTasks(root, ctx) {
  let showDone = false;
  let selected = ctx.params[0] && ctx.params[0] !== 'schedules' ? ctx.params[0] : null;
  let projects = [];
  const listEl = h('div');
  const panel = h('div', { class: 'panel' });
  const title = h('input', { class: 'input', placeholder: 'Add a task…', 'aria-label': 'Task title' });
  const due = h('input', { class: 'input', placeholder: 'Due — e.g. fri 17:00', 'aria-label': 'Due date' });
  const form = h('form', { class: 'task-form', style: { marginBottom: '18px' }, onsubmit: async (e) => {
    e.preventDefault();
    if (!title.value.trim()) return;
    try {
      const { task } = await api.post('/api/tasks', { title: title.value, due: due.value || undefined });
      title.value = ''; due.value = '';
      toast(`Added “${task.title}”${task.due_at ? ` — due ${fmtWhen(task.due_at, { allDay: !task.due_has_time })}` : ''}`);
    } catch (err) { errorToast(err); }
  } }, title, due, btn('Add', null, { kind: 'primary', type: 'submit' }));
  root.append(h('div', { class: 'split' }, h('div', {}, form, listEl), panel));

  async function renderList() {
    let tasks = [];
    try { tasks = (await api.get('/api/tasks')).tasks; projects = await loadProjects().catch(() => []); } catch (err) { errorToast(err); }
    clear(listEl);
    const now = new Date();
    const projMap = new Map(projects.map((p) => [p.id, p]));
    const groups = new Map(GROUPS.map((g) => [g, []]));
    for (const t of tasks) groups.get(groupOf(t, now)).push(t);
    const openCount = tasks.filter((t) => !['completed', 'cancelled'].includes(t.status)).length;
    if (!openCount && !showDone) listEl.append(empty('Nothing on your list', `Add a task above, or tell ${assistantName()} about a deadline in chat.`));
    for (const g of GROUPS) {
      const items = groups.get(g);
      if (!items.length || (g === 'Done' && !showDone)) continue;
      listEl.append(h('div', { class: 'section-title' }, g, h('span', { class: 'tiny' }, String(items.length))));
      const box = h('div', {});
      for (const t of items) {
        const overdue = g === 'Overdue';
        box.append(h('div', { class: `task-row${t.id === selected ? ' sel' : ''}`, tabindex: '0', role: 'button', onclick: () => select(t.id), onkeydown: (e) => { if (e.key === 'Enter') select(t.id); } },
          h('button', { class: `check${t.status === 'completed' ? ' on' : ''}`, type: 'button', title: t.status === 'completed' ? 'Reopen' : 'Mark done', 'aria-label': t.status === 'completed' ? `Reopen ${t.title}` : `Mark ${t.title} done`,
            onclick: async (e) => { e.stopPropagation(); try { await api.patch(`/api/tasks/${t.id}`, { status: t.status === 'completed' ? 'planned' : 'completed' }); } catch (err) { errorToast(err); } } }, icon('check', 11)),
          h('div', { class: 'grow' }, h('div', { class: 't' }, t.title),
            h('div', { class: 'meta' }, t.due_at ? h('span', { class: overdue ? 'overdue' : '' }, fmtWhen(t.due_at, { allDay: !t.due_has_time })) : null,
              t.project_id && projMap.get(t.project_id) ? `${t.due_at ? ' · ' : ''}${projectLabel(projMap.get(t.project_id))}` : '')),
          t.status !== 'planned' && t.status !== 'completed' ? taskStatus(t.status) : null));
      }
      listEl.append(box);
    }
    const doneCount = groups.get('Done').length;
    if (doneCount) listEl.append(h('div', { style: { marginTop: '18px' } }, btn(showDone ? 'Hide completed' : `Show completed (${doneCount})`, () => { showDone = !showDone; renderList(); }, { kind: 'ghost', size: 'sm' })));
  }

  function select(id) {
    selected = id;
    history.replaceState(null, '', `#/tasks/${id}`);
    renderList();
    renderPanel();
  }

  async function renderPanel() {
    clear(panel);
    if (!selected) { panel.append(h('div', { class: 'quiet-empty', style: { paddingTop: '8px' } }, 'Select a task to see details.')); return; }
    panel.append(loading());
    let d;
    try { d = await api.get(`/api/tasks/${selected}`); } catch (err) { clear(panel); panel.append(h('div', { class: 'quiet-empty' }, err.status === 404 ? 'This task no longer exists.' : err.message)); return; }
    projects = await loadProjects().catch(() => projects);
    const t = d.task;
    clear(panel);
    const save = async (patch) => { try { await api.patch(`/api/tasks/${t.id}`, patch); } catch (err) { errorToast(err); renderPanel(); } };
    const titleIn = h('input', { class: 'input bare', value: t.title, 'aria-label': 'Title', style: { fontFamily: 'var(--serif)', fontSize: '20px', height: '42px', padding: '0 6px' }, onchange: (e) => save({ title: e.target.value }) });
    const status = h('select', { class: 'select', 'aria-label': 'Status', onchange: (e) => save({ status: e.target.value }) }, Object.entries(STATUS_LABELS).map(([k, v]) => h('option', { value: k }, v)));
    status.value = t.status;
    const dueIn = h('input', { class: 'input', type: 'datetime-local', value: toLocalInput(t.due_at), 'aria-label': 'Due', onchange: (e) => save({ due: e.target.value || '' }) });
    const proj = projectSelect(projects, t.project_id, { onChange: (v) => save({ project_id: v || null }) });
    const desc = h('textarea', { class: 'textarea', placeholder: 'Notes', value: t.description || '', onchange: (e) => save({ description: e.target.value }) });
    const modelOk = state.boot?.integrations.anthropic.configured;
    const canWork = !['completed', 'cancelled'].includes(t.status);
    const lastRun = d.runs[0];
    const activity = h('details', { style: { marginTop: '6px' } }, h('summary', { class: 'small muted', style: { cursor: 'pointer' } }, `Activity (${d.events.length + d.evidence.length})`),
      h('div', { style: { marginTop: '12px' } },
        d.evidence.length ? h('div', { style: { marginBottom: '12px' } }, d.evidence.map((e) => h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 't small' }, e.summary || toolLabel(e.name)), e.external_ref ? h('div', { class: 'mono tiny muted' }, e.external_ref) : null), statusChip(e.status === 'succeeded' ? 'completed' : e.status, e.status === 'succeeded' ? 'confirmed' : e.status)))) : null,
        d.jobs.length ? h('div', { style: { marginBottom: '12px' } }, d.jobs.map((j) => h('div', { class: 'row' }, icon('clock', 15), h('div', { class: 'grow small' }, j.name, h('div', { class: 'tiny muted' }, j.next_run_at ? `Next ${fmtWhen(j.next_run_at)}` : `Last ${j.last_status || '—'}`)), statusChip(j.status)))) : null,
        h('ul', { class: 'timeline' }, d.events.slice().reverse().map((e) => h('li', { class: e.type }, h('div', {}, e.message), h('div', { class: 'when' }, fmtDateTime(e.created_at)))))));
    panel.append(h('div', { class: 'card card-pad' },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } }, taskStatus(t.status), h('div', { class: 'grow' }),
        t.conversation_id ? btn('', () => ctx.navigate(`#/chat/${t.conversation_id}`), { kind: 'ghost', ic: 'chat', title: 'Open chat', size: 'sm' }) : null,
        btn('', async () => { if (await confirmDialog('Delete task?', `“${t.title}” will be deleted.`, { confirmLabel: 'Delete', danger: true })) { await api.del(`/api/tasks/${t.id}`).catch(errorToast); selected = null; history.replaceState(null, '', '#/tasks'); renderPanel(); } }, { kind: 'ghost', ic: 'trash', title: 'Delete task', size: 'sm' })),
      h('div', { class: 'field' }, titleIn),
      t.status === 'blocked' && t.blocked_reason ? h('div', { class: 'banner warn small', style: { marginBottom: '12px' } }, icon('alert', 16), t.blocked_reason) : null,
      t.outcome ? h('div', { class: 'banner info small', style: { marginBottom: '12px' } }, icon('check', 16), h('div', {}, h('b', {}, 'Outcome: '), t.outcome)) : null,
      canWork && modelOk ? h('div', { style: { marginBottom: '14px' } }, btn(lastRun && ['interrupted', 'failed'].includes(lastRun.status) ? `Resume with ${assistantName()}` : `Ask ${assistantName()} to do this`, async () => {
        try { const { run } = await api.post(`/api/tasks/${t.id}/resume`); ctx.navigate(`#/chat/${run.conversation_id}`); } catch (err) { errorToast(err); }
      }, { kind: 'primary', size: 'sm' })) : null,
      h('div', { class: 'grid-2' }, h('div', { class: 'field' }, h('label', {}, 'Due'), dueIn), h('div', { class: 'field' }, h('label', {}, 'Status'), status)),
      h('div', { class: 'field' }, h('label', {}, 'Course'), proj),
      h('div', { class: 'field' }, desc),
      activity));
  }

  const reloadAll = debounce(() => { renderList(); if (selected) renderPanel(); }, 300);
  const offs = [on('task.updated', reloadAll), on('task.event', (d) => { if (d.task_id === selected) reloadAll(); }), on('task.deleted', reloadAll)];
  renderList();
  renderPanel();
  return () => offs.forEach((f) => f());
}

// ------------------------------------------------------- reminders & routines
function mountSchedules(root) {
  const listEl = h('div', { class: 'stack' });
  root.append(h('div', { class: 'btn-row', style: { justifyContent: 'space-between', marginBottom: '16px' } },
    h('p', { class: 'muted', style: { margin: 0 } }, 'Each one runs once per scheduled time, retries if something fails, and stops when you cancel it.'),
    btn('New', () => newScheduleDialog(), { kind: 'primary', ic: 'plus' })), listEl);

  async function render() {
    let jobs = [];
    try { jobs = (await api.get('/api/jobs')).jobs; } catch (err) { errorToast(err); }
    clear(listEl);
    if (!jobs.length) { listEl.append(empty('Nothing scheduled', 'Create a reminder, a daily briefing or a watch — or just ask in chat.')); return; }
    for (const j of jobs) listEl.append(jobCard(j));
  }

  function jobCard(j) {
    const runsEl = h('div', { hidden: true, class: 'card-body' });
    let open = false;
    const toggle = async () => {
      open = !open; runsEl.hidden = !open;
      if (!open) return;
      clear(runsEl); runsEl.append(loading());
      try {
        const d = await api.get(`/api/jobs/${j.id}`);
        clear(runsEl);
        if (j.kind === 'monitor') runsEl.append(h('div', { class: 'small muted', style: { marginBottom: '8px' } }, `Watching: ${describeCheck(j.payload.check)}. You’re notified only when it happens, once per item.`));
        if (j.kind === 'reminder') runsEl.append(h('div', { class: 'small', style: { marginBottom: '8px' } }, `“${j.payload.message}”`));
        if (!d.runs.length) runsEl.append(h('div', { class: 'small muted' }, 'Hasn’t run yet.'));
        for (const r of d.runs) runsEl.append(h('div', { class: 'row small' }, h('div', { class: 'grow' }, fmtDateTime(r.scheduled_for), h('div', { class: 'tiny muted' }, runResult(r))), r.attempt > 1 ? h('span', { class: 'tiny muted' }, `${r.attempt} attempts`) : null, statusChip(r.status)));
      } catch (err) { clear(runsEl); runsEl.append(h('div', { class: 'small' }, err.message)); }
    };
    const act = (path, msg) => async () => { try { await api.post(`/api/jobs/${j.id}/${path}`); toast(msg); render(); } catch (err) { errorToast(err); } };
    const kindIcon = { reminder: 'clock', briefing: 'today', monitor: 'eye', agent: 'bolt' }[j.kind];
    const kindLabel = { reminder: 'Reminder', briefing: 'Briefing', monitor: 'Watch', agent: 'Routine' }[j.kind];
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', minWidth: '0' } }, icon(kindIcon, 18),
          h('div', { style: { minWidth: '0' } }, h('h2', { class: 'ellipsis' }, j.name), h('div', { class: 'sub' }, `${kindLabel} · ${j.schedule_label}${j.next_run_at ? ` · next ${fmtWhen(j.next_run_at)}` : ''}`))),
        h('div', { class: 'btn-row' }, statusChip(j.status),
          ['active', 'paused'].includes(j.status) ? btn('Run now', act('run', 'Queued'), { size: 'sm' }) : null,
          j.status === 'active' ? btn('Pause', act('pause', 'Paused'), { size: 'sm', kind: 'ghost' }) : null,
          j.status === 'paused' ? btn('Resume', act('resume', 'Resumed'), { size: 'sm', kind: 'ghost' }) : null,
          ['active', 'paused'].includes(j.status) ? btn('Cancel', async () => { if (await confirmDialog('Cancel this?', `“${j.name}” won’t run again. Its history is kept.`, { confirmLabel: 'Cancel it', danger: true })) act('cancel', 'Cancelled')(); }, { size: 'sm', kind: 'ghost' }) : null,
          btn('', toggle, { kind: 'ghost', ic: 'down', title: 'History', size: 'sm' }))),
      runsEl);
  }

  function runResult(r) {
    if (r.error) return r.error;
    const res = r.result || {};
    if (res.duplicate_prevented) return 'Already delivered — not sent twice';
    if (res.condition_met !== undefined) return res.condition_met ? `Happened — ${res.new_alerts} new alert(s)` : 'Checked — nothing new';
    if (res.notification_id) return `Delivered${res.delivery?.push ? ` (phone: ${res.delivery.push})` : ''}`;
    if (res.run_id) return `${assistantName()} ${res.status}`;
    return '';
  }

  function describeCheck(c = {}) {
    return { email: `new email matching “${c.query}”`, url_contains: `${c.url} showing “${c.text}”`, url_changed: `changes to ${c.url}`, calendar_conflicts: `calendar clashes in the next ${c.days_ahead || 7} days`, tasks_due: `tasks due within ${c.within_hours || 24} h` }[c.type] || c.type;
  }

  function newScheduleDialog() {
    const kind = h('select', { class: 'select' }, h('option', { value: 'reminder' }, 'Reminder'), h('option', { value: 'briefing' }, 'Daily briefing'), h('option', { value: 'monitor' }, 'Watch — tell me when something happens'));
    const fields = h('div');
    const vals = {};
    const input = (key, label, attrs = {}, hint = null) => { const el = h('input', { class: 'input', ...attrs }); vals[key] = el; return h('div', { class: 'field' }, h('label', {}, label), el, hint ? h('div', { class: 'hint' }, hint) : null); };
    const draw = () => {
      clear(fields); for (const k of Object.keys(vals)) delete vals[k];
      fields.append(input('name', 'Name', { placeholder: kind.value === 'briefing' ? 'Morning briefing' : '' }));
      if (kind.value === 'reminder') {
        fields.append(input('message', 'Remind me to…', { placeholder: 'Check Banner registration' }), input('at', 'When', { type: 'datetime-local' }, `${state.boot.profile.timezone} time`));
      } else if (kind.value === 'briefing') {
        fields.append(input('time', 'Time', { type: 'time', value: '07:30' }), input('days', 'Days', { value: 'sun,mon,tue,wed,thu' }, 'Leave empty for every day'));
      } else {
        const type = h('select', { class: 'select', onchange: () => drawCheck() }, h('option', { value: 'email' }, 'A new email arrives'), h('option', { value: 'url_contains' }, 'A web page shows some text'), h('option', { value: 'url_changed' }, 'A web page changes'), h('option', { value: 'calendar_conflicts' }, 'My calendar has a clash'), h('option', { value: 'tasks_due' }, 'A task is due soon'));
        vals.type = type;
        const checkFields = h('div');
        const drawCheck = () => {
          clear(checkFields); delete vals.query; delete vals.url; delete vals.text; delete vals.hours;
          if (type.value === 'email') checkFields.append(input('query', 'From or about', { placeholder: 'from:registrar@aus.edu' }, 'Gmail search syntax'));
          if (type.value.startsWith('url_')) checkFields.append(input('url', 'Page address', { placeholder: 'https://…' }));
          if (type.value === 'url_contains') checkFields.append(input('text', 'Text to look for', { placeholder: 'Grades posted' }));
          if (type.value === 'tasks_due') checkFields.append(input('hours', 'Within hours', { type: 'number', value: '24' }));
        };
        fields.append(h('div', { class: 'field' }, h('label', {}, 'Tell me when'), type), checkFields, input('every', 'Check every (minutes)', { type: 'number', value: '30', min: '5' }));
        drawCheck();
      }
    };
    kind.addEventListener('change', draw);
    draw();
    dialog({ title: 'New reminder or routine', body: h('div', {}, h('div', { class: 'field' }, h('label', {}, 'Type'), kind), fields), actions: [
      { label: 'Cancel' },
      { label: 'Create', kind: 'primary', onClick: async () => {
        const k = kind.value;
        const v = (key) => vals[key]?.value?.trim();
        let body;
        if (k === 'reminder') body = { name: v('name') || v('message'), kind: k, schedule: { type: 'once', at: v('at') }, payload: { message: v('message') } };
        else if (k === 'briefing') body = { name: v('name') || 'Briefing', kind: k, schedule: { type: 'daily', time: v('time'), days: v('days') ? v('days').split(',').map((s) => s.trim()).filter(Boolean) : [] }, payload: { use_model: true } };
        else body = { name: v('name') || 'Watch', kind: k, schedule: { type: 'interval', minutes: Number(v('every') || 30) }, payload: { check: { type: v('type'), query: v('query'), url: v('url'), text: v('text'), within_hours: v('hours') ? Number(v('hours')) : undefined } } };
        try { await api.post('/api/jobs', body); toast('Scheduled'); render(); return false; } catch (err) { errorToast(err); return true; }
      } },
    ] });
  }

  const offs = [on('job.updated', debounce(render, 300)), on('job.run', debounce(render, 500))];
  render();
  return () => offs.forEach((f) => f());
}
