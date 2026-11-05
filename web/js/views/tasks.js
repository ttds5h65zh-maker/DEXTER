// Tasks and Schedules.
import { h, clear, btn, statusChip, fmtWhen, fmtDateTime, fmtAgo, errorToast, toast, confirmDialog, empty, loading, debounce, toLocalInput, dialog } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { state, on } from '../store.js';
import { taskStatus, STATUS_LABELS, loadProjects, projectSelect, projectLabel, toolLabel } from './common.js';

const FILTERS = [
  { key: 'open', label: 'Open', status: 'planned,running,blocked,awaiting_approval' },
  { key: 'attention', label: 'Needs attention', status: 'blocked,awaiting_approval' },
  { key: 'running', label: 'Running', status: 'running' },
  { key: 'completed', label: 'Completed', status: 'completed' },
  { key: 'all', label: 'All', status: '' },
];

export function mount(container, ctx) {
  const tab = ctx.params[0] === 'schedules' ? 'schedules' : 'tasks';
  const page = h('div', { class: 'page' });
  container.append(page);
  page.append(h('div', { class: 'tabs', role: 'tablist' },
    h('a', { href: '#/tasks', class: tab === 'tasks' ? 'on' : '', role: 'tab', 'aria-selected': String(tab === 'tasks') }, 'Tasks'),
    h('a', { href: '#/tasks/schedules', class: tab === 'schedules' ? 'on' : '', role: 'tab', 'aria-selected': String(tab === 'schedules') }, 'Schedules')));
  const body = h('div');
  page.append(body);
  return tab === 'schedules' ? mountSchedules(body, ctx) : mountTasks(body, ctx);
}

function mountTasks(root, ctx) {
  let filter = 'open';
  let q = '';
  let selected = ctx.params[0] && ctx.params[0] !== 'schedules' ? ctx.params[0] : null;
  let projects = [];
  const listCard = h('div', { class: 'card' });
  const panel = h('div', { class: 'panel' });
  const split = h('div', { class: 'split' }, h('div', { class: 'stack' }, newTaskForm(), listCard), panel);
  root.append(split);

  function newTaskForm() {
    const title = h('input', { class: 'input', placeholder: 'New task…', 'aria-label': 'Task title' });
    const due = h('input', { class: 'input', placeholder: 'Due (e.g. fri 17:00)', 'aria-label': 'Due date' });
    const form = h('form', { class: 'card card-pad', onsubmit: async (e) => {
      e.preventDefault();
      if (!title.value.trim()) return;
      try {
        const { task } = await api.post('/api/tasks', { title: title.value, due: due.value || undefined });
        title.value = ''; due.value = '';
        toast(`Added “${task.title}”${task.due_at ? ` — due ${fmtWhen(task.due_at, { allDay: !task.due_has_time })}` : ''}`);
      } catch (err) { errorToast(err); }
    } }, h('div', { class: 'task-form' }, title, due, btn('Add', null, { kind: 'primary', type: 'submit', ic: 'plus' })));
    return form;
  }

  async function renderList() {
    const f = FILTERS.find((x) => x.key === filter);
    let tasks = [];
    try {
      const qs = new URLSearchParams();
      if (f.status) qs.set('status', f.status);
      if (q) qs.set('q', q);
      tasks = (await api.get(`/api/tasks?${qs}`)).tasks;
      projects = await loadProjects().catch(() => []);
    } catch (err) { errorToast(err); }
    clear(listCard);
    const seg = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Filter tasks' }, FILTERS.map((x) => h('button', { type: 'button', class: x.key === filter ? 'on' : '', 'aria-pressed': String(x.key === filter), onclick: () => { filter = x.key; renderList(); } }, x.label)));
    const search = h('input', { class: 'input', type: 'search', placeholder: 'Search', value: q, style: { maxWidth: '220px' }, 'aria-label': 'Search tasks', oninput: debounce((e) => { q = e.target.value; renderList(); }, 250) });
    listCard.append(h('div', { class: 'card-head', style: { flexWrap: 'wrap' } }, seg, search));
    if (!tasks.length) {
      listCard.append(empty(filter === 'open' ? 'No open tasks' : 'No tasks here', filter === 'open' ? 'Add one above, or ask Dexter in chat — tasks it creates appear here with their progress.' : null));
      return;
    }
    const projMap = new Map(projects.map((p) => [p.id, p]));
    for (const t of tasks) {
      const overdue = t.due_at && new Date(t.due_at) < new Date() && !['completed', 'cancelled'].includes(t.status);
      listCard.append(h('div', { class: `task-row${t.id === selected ? ' sel' : ''}`, tabindex: '0', role: 'button', onclick: () => select(t.id), onkeydown: (e) => { if (e.key === 'Enter') select(t.id); } },
        h('button', { class: `check${t.status === 'completed' ? ' on' : ''}`, type: 'button', title: t.status === 'completed' ? 'Reopen' : 'Mark completed', 'aria-label': t.status === 'completed' ? `Reopen ${t.title}` : `Complete ${t.title}`,
          onclick: async (e) => { e.stopPropagation(); try { await api.patch(`/api/tasks/${t.id}`, { status: t.status === 'completed' ? 'planned' : 'completed' }); } catch (err) { errorToast(err); } } }, icon('check', 12)),
        h('div', { class: 'grow' }, h('div', { class: 't' }, t.title),
          h('div', { class: 'meta small' }, t.due_at ? h('span', { class: overdue ? 'overdue' : '' }, `${overdue ? 'Overdue · ' : 'Due '}${fmtWhen(t.due_at, { allDay: !t.due_has_time })}`) : 'No due date',
            t.project_id && projMap.get(t.project_id) ? ` · ${projectLabel(projMap.get(t.project_id))}` : '', t.origin === 'dexter' ? ' · from Dexter' : '', t.priority === 'high' ? ' · high priority' : '')),
        taskStatus(t.status)));
    }
  }

  function select(id) {
    selected = id;
    history.replaceState(null, '', `#/tasks/${id}`);
    renderList();
    renderPanel();
  }

  async function renderPanel() {
    clear(panel);
    if (!selected) {
      panel.append(h('div', { class: 'card card-pad muted small' }, 'Select a task to see its timeline, outcome and evidence.'));
      return;
    }
    panel.append(h('div', { class: 'card' }, loading()));
    let d;
    try { d = await api.get(`/api/tasks/${selected}`); } catch (err) {
      clear(panel); panel.append(h('div', { class: 'card card-pad' }, err.status === 404 ? 'This task no longer exists.' : err.message)); return;
    }
    projects = await loadProjects().catch(() => projects);
    const t = d.task;
    clear(panel);
    const card = h('div', { class: 'card' });
    const save = async (patch) => { try { await api.patch(`/api/tasks/${t.id}`, patch); } catch (err) { errorToast(err); renderPanel(); } };
    const title = h('input', { class: 'input', value: t.title, 'aria-label': 'Title', style: { fontWeight: '620', fontSize: '15.5px' }, onchange: (e) => save({ title: e.target.value }) });
    const status = h('select', { class: 'select', 'aria-label': 'Status', onchange: (e) => save({ status: e.target.value }) }, Object.entries(STATUS_LABELS).map(([k, v]) => h('option', { value: k }, v)));
    status.value = t.status;
    const due = h('input', { class: 'input', type: 'datetime-local', value: toLocalInput(t.due_at), 'aria-label': 'Due',
      onchange: (e) => save({ due: e.target.value ? e.target.value : '' }) });
    const prio = h('select', { class: 'select', 'aria-label': 'Priority', onchange: (e) => save({ priority: e.target.value }) }, ['low', 'normal', 'high'].map((p) => h('option', { value: p }, p)));
    prio.value = t.priority;
    const proj = projectSelect(projects, t.project_id, { onChange: (v) => save({ project_id: v || null }) });
    const desc = h('textarea', { class: 'textarea', placeholder: 'Details, requirements, links…', value: t.description || '', onchange: (e) => save({ description: e.target.value }) });
    const outcome = h('textarea', { class: 'textarea', placeholder: 'What was actually done (with evidence)', value: t.outcome || '', onchange: (e) => save({ outcome: e.target.value }) });
    const modelOk = state.boot?.integrations.anthropic.configured;
    const canWork = !['completed', 'cancelled'].includes(t.status);
    const lastRun = d.runs[0];
    card.append(
      h('div', { class: 'card-head' }, taskStatus(t.status), h('div', { class: 'btn-row' },
        t.conversation_id ? btn('Conversation', () => ctx.navigate(`#/chat/${t.conversation_id}`), { size: 'sm', ic: 'chat' }) : null,
        btn('', async () => { if (await confirmDialog('Delete task?', `“${t.title}” and its timeline will be deleted. Schedules linked to it stay but lose the link.`, { confirmLabel: 'Delete', danger: true })) { await api.del(`/api/tasks/${t.id}`).catch(errorToast); selected = null; history.replaceState(null, '', '#/tasks'); renderPanel(); } }, { kind: 'ghost', ic: 'trash', title: 'Delete task', size: 'sm' }))),
      h('div', { class: 'card-body' },
        h('div', { class: 'field' }, title),
        t.status === 'blocked' && t.blocked_reason ? h('div', { class: 'banner warn small', style: { marginBottom: '12px' } }, icon('alert', 16), t.blocked_reason) : null,
        canWork ? h('div', { class: 'btn-row', style: { marginBottom: '14px' } },
          btn(lastRun && ['interrupted', 'failed'].includes(lastRun.status) ? 'Resume with Dexter' : 'Ask Dexter to work on this', async () => {
            try { const { run } = await api.post(`/api/tasks/${t.id}/resume`); toast('Dexter is on it'); ctx.navigate(`#/chat/${run.conversation_id}`); } catch (err) { errorToast(err); }
          }, { kind: 'primary', ic: 'play', size: 'sm', disabled: !modelOk, title: modelOk ? null : 'Claude is not connected' }),
          !modelOk ? h('span', { class: 'tiny muted' }, 'Needs Claude to be connected') : null) : null,
        h('div', { class: 'grid-2' }, h('div', { class: 'field' }, h('label', {}, 'Status'), status), h('div', { class: 'field' }, h('label', {}, 'Due'), due)),
        h('div', { class: 'grid-2' }, h('div', { class: 'field' }, h('label', {}, 'Priority'), prio), h('div', { class: 'field' }, h('label', {}, 'Course / project'), proj)),
        h('div', { class: 'field' }, h('label', {}, 'Details'), desc),
        h('div', { class: 'field' }, h('label', {}, 'Outcome'), outcome, h('div', { class: 'hint' }, 'Dexter fills this in when it completes work, with evidence such as confirmation ids.')),
        d.evidence.length ? h('div', { class: 'field' }, h('label', {}, 'Actions and results'), h('div', {}, d.evidence.map((e) => h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 't small' }, e.summary || toolLabel(e.name)), e.external_ref ? h('div', { class: 'mono tiny muted' }, e.external_ref) : null, h('div', { class: 'tiny muted' }, fmtDateTime(e.finished_at))), statusChip(e.status === 'succeeded' ? 'completed' : e.status, e.status === 'succeeded' ? 'confirmed' : e.status))))) : null,
        d.jobs.length ? h('div', { class: 'field' }, h('label', {}, 'Schedules'), h('div', {}, d.jobs.map((j) => h('div', { class: 'row' }, icon('clock', 15), h('div', { class: 'grow' }, h('div', { class: 't small' }, j.name), h('div', { class: 'tiny muted' }, j.next_run_at ? `Next ${fmtWhen(j.next_run_at)}` : `Last ${j.last_status || '—'}`)), statusChip(j.status))))) : null,
        h('div', { class: 'field' }, h('label', {}, 'Timeline'),
          h('ul', { class: 'timeline' }, d.events.slice().reverse().map((e) => h('li', { class: e.type }, h('div', {}, e.message), h('div', { class: 'when' }, fmtDateTime(e.created_at))))))));
    panel.append(card);
  }

  const reloadAll = debounce(() => { renderList(); if (selected) renderPanel(); }, 300);
  const offs = [on('task.updated', reloadAll), on('task.event', (d) => { if (d.task_id === selected) reloadAll(); }), on('task.deleted', reloadAll), on('job.updated', reloadAll)];
  renderList();
  renderPanel();
  return () => offs.forEach((f) => f());
}

// --------------------------------------------------------------- schedules
function mountSchedules(root, ctx) {
  const listEl = h('div', { class: 'stack' });
  root.append(h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Schedules'), h('p', {}, 'Reminders, briefings and monitors run on Dexter’s scheduler — each occurrence runs once, failed runs retry, and you can cancel any time.')),
    btn('New schedule', () => newScheduleDialog(), { kind: 'primary', ic: 'plus' })), listEl);

  async function render() {
    let jobs = [];
    try { jobs = (await api.get('/api/jobs')).jobs; } catch (err) { errorToast(err); }
    clear(listEl);
    if (!jobs.length) { listEl.append(h('div', { class: 'card' }, empty('Nothing scheduled', 'Create a reminder, a daily briefing or a monitor — or ask Dexter in chat.'))); return; }
    for (const j of jobs) listEl.append(jobCard(j));
  }

  function jobCard(j) {
    const runsEl = h('div', { hidden: true, class: 'card-body' });
    let open = false;
    const toggle = async () => {
      open = !open; runsEl.hidden = !open;
      if (open) {
        clear(runsEl); runsEl.append(loading());
        try {
          const d = await api.get(`/api/jobs/${j.id}`);
          clear(runsEl);
          if (j.kind === 'monitor') runsEl.append(h('div', { class: 'small muted', style: { marginBottom: '8px' } }, `Check: ${describeCheck(j.payload.check)}. Notifies only when the condition is met; each matching item alerts once.`));
          if (j.kind === 'reminder') runsEl.append(h('div', { class: 'small', style: { marginBottom: '8px' } }, `Message: “${j.payload.message}”`));
          if (!d.runs.length) runsEl.append(h('div', { class: 'small muted' }, 'No runs yet.'));
          const table = h('table', { class: 'table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Scheduled for'), h('th', {}, 'Status'), h('th', {}, 'Attempts'), h('th', {}, 'Result'))));
          const tb = h('tbody');
          for (const r of d.runs) tb.append(h('tr', {}, h('td', {}, fmtDateTime(r.scheduled_for)), h('td', {}, statusChip(r.status)), h('td', {}, String(r.attempt)), h('td', { class: 'small' }, runResult(r))));
          table.append(tb);
          if (d.runs.length) runsEl.append(h('div', { class: 'table-wrap' }, table));
        } catch (err) { clear(runsEl); runsEl.append(h('div', { class: 'small' }, err.message)); }
      }
    };
    const act = (path, msg) => async () => { try { await api.post(`/api/jobs/${j.id}/${path}`); toast(msg); render(); } catch (err) { errorToast(err); } };
    const kindIcon = { reminder: 'clock', briefing: 'today', monitor: 'eye', agent: 'bolt' }[j.kind];
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', minWidth: '0' } }, icon(kindIcon, 18),
          h('div', { style: { minWidth: '0' } }, h('h2', { class: 'ellipsis' }, j.name), h('div', { class: 'sub' }, `${j.kind} · ${j.schedule_label}${j.next_run_at ? ` · next ${fmtWhen(j.next_run_at)}` : ''}${j.last_status ? ` · last ${j.last_status}` : ''}${j.created_by === 'dexter' ? ' · created by Dexter' : ''}`))),
        h('div', { class: 'btn-row' }, statusChip(j.status),
          ['active', 'paused'].includes(j.status) ? btn('Run now', act('run', 'Queued — it will run within a few seconds'), { size: 'sm', ic: 'play' }) : null,
          j.status === 'active' ? btn('Pause', act('pause', 'Paused'), { size: 'sm', ic: 'pause' }) : null,
          j.status === 'paused' ? btn('Resume', act('resume', 'Resumed'), { size: 'sm', ic: 'play' }) : null,
          ['active', 'paused'].includes(j.status) ? btn('Cancel', async () => { if (await confirmDialog('Cancel schedule?', `“${j.name}” will not run again. Its history is kept.`, { confirmLabel: 'Cancel schedule', danger: true })) act('cancel', 'Cancelled')(); }, { size: 'sm', kind: 'danger' }) : null,
          btn('', toggle, { kind: 'ghost', ic: 'down', title: 'Show runs', size: 'sm' }))),
      runsEl);
  }

  function runResult(r) {
    if (r.error) return r.error;
    const res = r.result || {};
    if (res.duplicate_prevented) return 'Duplicate prevented (already delivered)';
    if (res.notification_id && res.delivery) return `Notified (${Object.entries(res.delivery).map(([k, v]) => `${k.replace('_', '-')}: ${v}`).join(', ')})`;
    if (res.condition_met !== undefined) return res.condition_met ? `Condition met — ${res.new_alerts} new alert(s)` : 'Condition not met — no alert';
    if (res.run_id) return `Dexter run ${res.status}`;
    return '';
  }

  function describeCheck(c = {}) {
    return { email: `new Gmail matching “${c.query}”`, url_contains: `${c.url} contains “${c.text}”`, url_changed: `${c.url} changes`, calendar_conflicts: `calendar conflicts in the next ${c.days_ahead || 7} days`, tasks_due: `tasks due within ${c.within_hours || 24} h` }[c.type] || c.type;
  }

  function newScheduleDialog() {
    const kind = h('select', { class: 'select' }, h('option', { value: 'reminder' }, 'Reminder'), h('option', { value: 'briefing' }, 'Briefing'), h('option', { value: 'monitor' }, 'Monitor (notify only when a condition is met)'));
    const fields = h('div');
    const vals = {};
    const input = (key, label, attrs = {}, hint = null) => { const el = h('input', { class: 'input', ...attrs }); vals[key] = el; return h('div', { class: 'field' }, h('label', {}, label), el, hint ? h('div', { class: 'hint' }, hint) : null); };
    const draw = () => {
      clear(fields); for (const k of Object.keys(vals)) delete vals[k];
      fields.append(input('name', 'Name', { placeholder: kind.value === 'briefing' ? 'Morning briefing' : '' }));
      if (kind.value === 'reminder') {
        fields.append(input('message', 'Remind me to…', { placeholder: 'Check Banner registration' }), input('at', 'When', { type: 'datetime-local' }, `In ${state.boot.profile.timezone}`));
      } else if (kind.value === 'briefing') {
        fields.append(input('time', 'Time', { type: 'time', value: '07:30' }), input('days', 'Days', { value: 'sun,mon,tue,wed,thu' }, 'Comma-separated weekdays; leave empty for every day'));
      } else {
        const type = h('select', { class: 'select', onchange: () => drawCheck() }, h('option', { value: 'email' }, 'New email matching a Gmail search'), h('option', { value: 'url_contains' }, 'Web page contains text'), h('option', { value: 'url_changed' }, 'Web page changed'), h('option', { value: 'calendar_conflicts' }, 'Calendar conflicts'), h('option', { value: 'tasks_due' }, 'Tasks due soon'));
        vals.type = type;
        const checkFields = h('div');
        const drawCheck = () => {
          clear(checkFields); delete vals.query; delete vals.url; delete vals.text; delete vals.hours;
          if (type.value === 'email') checkFields.append(input('query', 'Gmail search', { placeholder: 'from:registrar@aus.edu' }));
          if (type.value.startsWith('url_')) checkFields.append(input('url', 'Page URL', { placeholder: 'https://…' }));
          if (type.value === 'url_contains') checkFields.append(input('text', 'Text to look for', { placeholder: 'Grades posted' }));
          if (type.value === 'tasks_due') checkFields.append(input('hours', 'Within hours', { type: 'number', value: '24' }));
        };
        fields.append(h('div', { class: 'field' }, h('label', {}, 'Condition'), type), checkFields, input('every', 'Check every (minutes)', { type: 'number', value: '30', min: '5' }));
        drawCheck();
      }
    };
    kind.addEventListener('change', draw);
    draw();
    dialog({ title: 'New schedule', body: h('div', {}, h('div', { class: 'field' }, h('label', {}, 'Type'), kind), fields), actions: [
      { label: 'Cancel' },
      { label: 'Create', kind: 'primary', onClick: async () => {
        const k = kind.value;
        const v = (key) => vals[key]?.value?.trim();
        let body;
        if (k === 'reminder') body = { name: v('name') || v('message'), kind: k, schedule: { type: 'once', at: v('at') }, payload: { message: v('message') } };
        else if (k === 'briefing') body = { name: v('name') || 'Briefing', kind: k, schedule: { type: 'daily', time: v('time'), days: v('days') ? v('days').split(',').map((s) => s.trim()).filter(Boolean) : [] }, payload: { use_model: true } };
        else body = { name: v('name') || 'Monitor', kind: k, schedule: { type: 'interval', minutes: Number(v('every') || 30) }, payload: { check: { type: v('type'), query: v('query'), url: v('url'), text: v('text'), within_hours: v('hours') ? Number(v('hours')) : undefined } } };
        try { await api.post('/api/jobs', body); toast('Scheduled'); render(); return false; } catch (err) { errorToast(err); return true; }
      } },
    ] });
  }

  const offs = [on('job.updated', debounce(render, 300)), on('job.run', debounce(render, 500))];
  render();
  return () => offs.forEach((f) => f());
}

