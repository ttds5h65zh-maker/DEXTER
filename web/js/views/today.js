// Today: a calm overview — what needs you, what is due, and today's calendar and reminders.
import { h, clear, btn, fmtWhen, fmtTime, errorToast, toast, loading, debounce, dialog } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { on } from '../store.js';
import { renderMarkdown } from '../markdown.js';
import { taskStatus, handoffCard } from './common.js';

export function mount(container, ctx) {
  const page = h('div', { class: 'page' });
  container.append(page);
  page.append(loading());
  let disposed = false;

  async function load() {
    try {
      const d = await api.get('/api/today');
      if (!disposed) render(d);
    } catch (err) {
      clear(page);
      page.append(h('div', { class: 'banner danger' }, icon('alert'), h('div', {}, `Could not load Today: ${err.message}`)));
    }
  }
  const reload = debounce(load, 250);

  const complete = async (t) => {
    try { await api.patch(`/api/tasks/${t.id}`, { status: 'completed', note: 'Marked done from Today' }); toast(`Done: ${t.title}`); } catch (e) { errorToast(e); }
  };

  const taskRow = (t, overdue = false) => h('div', { class: 'row' },
    h('button', { class: 'check', type: 'button', title: 'Mark done', 'aria-label': `Mark ${t.title} done`, onclick: () => complete(t) }, icon('check', 11)),
    h('div', { class: 'grow clickable', onclick: () => ctx.navigate(`#/tasks/${t.id}`) },
      h('div', { class: 't ellipsis' }, t.title),
      h('div', { class: `meta${overdue ? ' overdue' : ''}` }, overdue ? 'Overdue · ' : '', fmtWhen(t.due_at, { allDay: !t.due_has_time }))),
    t.status !== 'planned' ? taskStatus(t.status) : null);

  function render(d) {
    clear(page);
    const quick = h('input', { class: 'input', placeholder: 'Add a task — e.g. “Read chapter 4 due tomorrow 18:00”', 'aria-label': 'Add a task',
      onkeydown: async (e) => {
        if (e.key !== 'Enter' || !e.target.value.trim()) return;
        const m = e.target.value.match(/^(.*?)\s+(?:due|by)\s+(.+)$/i);
        try { await api.post('/api/tasks', m ? { title: m[1], due: m[2] } : { title: e.target.value.trim() }); e.target.value = ''; toast('Task added'); } catch (err) { errorToast(err); }
      } });
    page.append(
      h('div', { class: 'page-head' },
        h('div', {}, h('h1', {}, `${d.greeting}, ${d.name}`), h('p', {}, d.date_label)),
        btn('Brief me', async () => {
          try { const b = await api.post('/api/briefing/preview'); dialog({ title: 'Your briefing', body: h('div', { class: 'prose' }, renderMarkdown(b.markdown.replace(/^### .*\n+/, ''))), wide: true }); } catch (e) { errorToast(e); }
        }, { ic: 'today' })),
      h('div', { class: 'quick-add' }, quick));

    // Needs you — only shown when there is something.
    const att = [];
    for (const a of d.attention.approvals) att.push(h('div', { class: 'row' }, icon('shield', 16), h('div', { class: 'grow' }, h('div', { class: 't' }, a.title), h('div', { class: 'meta' }, a.summary)), btn('Review', () => ctx.navigate(`#/approvals/${a.id}`), { kind: 'primary', size: 'sm' })));
    for (const hd of d.attention.handoffs) att.push(handoffCard(hd, { onDone: reload }));
    for (const r of d.attention.interrupted_runs) att.push(h('div', { class: 'row' }, icon('alert', 16), h('div', { class: 'grow' }, h('div', { class: 't' }, `${r.status === 'interrupted' ? 'Interrupted' : 'Didn’t finish'}: ${r.title}`), h('div', { class: 'meta ellipsis' }, r.error || '')),
      btn('Resume', async () => { try { await api.post(`/api/runs/${r.id}/retry`); ctx.navigate(`#/chat/${r.conversation_id}`); } catch (e) { errorToast(e); } }, { size: 'sm' })));
    for (const t of d.attention.blocked_tasks) att.push(h('div', { class: 'row clickable', onclick: () => ctx.navigate(`#/tasks/${t.id}`) }, icon('tasks', 16), h('div', { class: 'grow' }, h('div', { class: 't' }, t.title), h('div', { class: 'meta' }, t.blocked_reason || 'Blocked')), taskStatus('blocked')));
    for (const j of d.attention.failed_jobs) att.push(h('div', { class: 'row clickable', onclick: () => ctx.navigate('#/tasks/schedules') }, icon('clock', 16), h('div', { class: 'grow' }, h('div', { class: 't' }, `${j.name} couldn’t run`), h('div', { class: 'meta' }, 'Open to see why'))));
    if (att.length) page.append(h('div', { class: 'section-title' }, 'Needs you'), h('div', { class: 'card card-pad', style: { padding: '4px 18px' } }, att));

    // Due
    const due = h('div', {});
    d.due.overdue.forEach((t) => due.append(taskRow(t, true)));
    d.due.today.forEach((t) => due.append(taskRow(t)));
    d.due.upcoming.forEach((t) => due.append(taskRow(t)));
    d.grade_due.forEach((g) => due.append(h('div', { class: 'row clickable', onclick: () => ctx.navigate(`#/projects/${g.project_id}`) }, icon('projects', 16),
      h('div', { class: 'grow' }, h('div', { class: 't' }, `${g.code || g.course}: ${g.name}`), h('div', { class: 'meta' }, `${fmtWhen(g.due_at)} · ${g.weight}% of the grade`)))));
    if (!due.childElementCount) due.append(h('div', { class: 'quiet-empty' }, 'Nothing due in the next week.'));

    // Calendar
    const cal = h('div', {});
    const c = d.calendar;
    if (c.status === 'connected') {
      if (c.conflicts) cal.append(h('div', { class: 'banner warn small', style: { margin: '6px 0' } }, icon('alert', 16), `${c.conflicts} overlapping event(s) today`));
      if (!c.events.length) cal.append(h('div', { class: 'quiet-empty' }, 'No events today.'));
      for (const e of c.events) cal.append(h('div', { class: 'row' }, h('div', { class: 'mono muted', style: { width: '88px', flex: 'none' } }, e.all_day ? 'All day' : `${fmtTime(e.start)}–${fmtTime(e.end)}`),
        h('div', { class: 'grow' }, h('div', { class: 't ellipsis' }, e.summary), e.location ? h('div', { class: 'meta' }, e.location) : null)));
    } else if (c.status === 'error') {
      cal.append(h('div', { class: 'quiet-empty' }, `Couldn’t read Google Calendar: ${c.error}`));
    } else {
      cal.append(h('div', { class: 'quiet-empty' }, c.status === 'permission_off' ? 'Calendar reading is turned off. ' : 'Google Calendar isn’t connected. ',
        h('a', { href: c.status === 'permission_off' ? '#/settings/privacy' : '#/settings/connections' }, c.status === 'permission_off' ? 'Change' : 'Connect')));
    }

    // Reminders today
    const sched = h('div', {});
    for (const j of d.schedule.upcoming) sched.append(h('div', { class: 'row' }, h('div', { class: 'mono muted', style: { width: '88px', flex: 'none' } }, fmtTime(j.next_run_at)), h('div', { class: 'grow' }, h('div', { class: 't ellipsis' }, j.name), h('div', { class: 'meta' }, j.kind))));
    for (const r of d.schedule.recent_runs.filter((x) => ['succeeded', 'failed'].includes(x.status)).slice(0, 4)) sched.append(h('div', { class: 'row' }, h('div', { class: 'mono muted', style: { width: '88px', flex: 'none' } }, fmtTime(r.scheduled_for)), h('div', { class: 'grow' }, h('div', { class: 't ellipsis muted' }, r.name), h('div', { class: 'meta' }, r.status === 'succeeded' ? 'delivered' : 'failed'))));
    if (!sched.childElementCount) sched.append(h('div', { class: 'quiet-empty' }, 'No reminders today. ', h('a', { href: '#/tasks/schedules' }, 'Add one')));

    page.append(h('div', { class: 'two-col' },
      h('div', {}, h('div', { class: 'section-title' }, 'Due soon', h('a', { href: '#/tasks', class: 'small' }, 'All tasks')), due),
      h('div', {}, h('div', { class: 'section-title' }, 'Calendar'), cal, h('div', { class: 'section-title' }, 'Reminders today'), sched)));
  }

  const offs = ['task.updated', 'task.deleted', 'approval.updated', 'handoff.updated', 'job.updated', 'job.run', 'run.updated'].map((t) => on(t, reload));
  load();
  return () => { disposed = true; offs.forEach((f) => f()); };
}
