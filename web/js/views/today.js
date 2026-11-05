// Today: what needs Sultan, what is due, what is scheduled and running.
import { h, clear, btn, statusChip, fmtWhen, fmtTime, fmtAgo, errorToast, toast, loading, debounce, dialog } from '../dom.js';
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

  function card(title, sub, body, action = null) {
    return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, title), sub ? h('div', { class: 'sub' }, sub) : null), action), h('div', { class: 'card-body' }, body));
  }

  async function complete(t) {
    try { await api.patch(`/api/tasks/${t.id}`, { status: 'completed', note: 'Marked done from Today' }); toast(`Completed “${t.title}”`); } catch (e) { errorToast(e); }
  }

  function taskRow(t, { overdue = false } = {}) {
    return h('div', { class: 'row' },
      h('button', { class: 'check', type: 'button', title: 'Mark completed', 'aria-label': `Mark ${t.title} completed`, onclick: () => complete(t) }, icon('check', 12)),
      h('div', { class: 'grow clickable', onclick: () => ctx.navigate(`#/tasks/${t.id}`) },
        h('div', { class: 't ellipsis' }, t.title),
        h('div', { class: `meta${overdue ? ' overdue' : ''}` }, overdue ? 'Overdue · ' : '', fmtWhen(t.due_at, { allDay: !t.due_has_time }))),
      t.status !== 'planned' ? taskStatus(t.status) : null);
  }

  function render(d) {
    clear(page);
    const attentionCount = d.attention.approvals.length + d.attention.handoffs.length + d.attention.blocked_tasks.length + d.attention.failed_jobs.length + d.attention.interrupted_runs.length;
    const quick = h('input', { class: 'input', placeholder: 'Quick add: “Read chapter 4 due tomorrow 18:00”', 'aria-label': 'Quick add task',
      onkeydown: async (e) => {
        if (e.key !== 'Enter' || !e.target.value.trim()) return;
        const m = e.target.value.match(/^(.*?)\s+(?:due|by)\s+(.+)$/i);
        try { await api.post('/api/tasks', m ? { title: m[1], due: m[2] } : { title: e.target.value.trim() }); e.target.value = ''; toast('Task added'); } catch (err) { errorToast(err); }
      } });
    page.append(h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, `${d.greeting}, ${d.name}`), h('p', {}, d.date_label, ` · ${d.timezone}`)),
      h('div', { style: { width: 'min(420px, 100%)' } }, quick)));

    // Needs attention
    const att = h('div', { class: 'stack' });
    for (const a of d.attention.approvals) {
      att.append(h('div', { class: 'row' }, icon('shield', 16), h('div', { class: 'grow' }, h('div', { class: 't' }, a.title), h('div', { class: 'meta' }, a.summary)),
        btn('Review', () => ctx.navigate(`#/approvals/${a.id}`), { kind: 'primary', size: 'sm' })));
    }
    for (const hd of d.attention.handoffs) att.append(handoffCard(hd, { onDone: reload }));
    for (const r of d.attention.interrupted_runs) {
      att.append(h('div', { class: 'row' }, icon('alert', 16), h('div', { class: 'grow' }, h('div', { class: 't' }, `${r.status === 'interrupted' ? 'Interrupted' : 'Failed'}: ${r.title}`), h('div', { class: 'meta' }, r.error || '')),
        btn('Open', () => ctx.navigate(`#/chat/${r.conversation_id}`), { size: 'sm' }),
        btn('Resume', async () => { try { await api.post(`/api/runs/${r.id}/retry`); ctx.navigate(`#/chat/${r.conversation_id}`); } catch (e) { errorToast(e); } }, { size: 'sm', kind: 'primary' })));
    }
    for (const t of d.attention.blocked_tasks) {
      att.append(h('div', { class: 'row clickable', onclick: () => ctx.navigate(`#/tasks/${t.id}`) }, icon('tasks', 16), h('div', { class: 'grow' }, h('div', { class: 't' }, t.title), h('div', { class: 'meta' }, t.blocked_reason || 'Blocked')), taskStatus('blocked')));
    }
    for (const j of d.attention.failed_jobs) {
      att.append(h('div', { class: 'row clickable', onclick: () => ctx.navigate('#/tasks/schedules') }, icon('clock', 16), h('div', { class: 'grow' }, h('div', { class: 't' }, `${j.name} failed`), h('div', { class: 'meta' }, `Last run ${fmtAgo(j.last_run_at)}`)), statusChip('failed')));
    }
    if (!attentionCount) att.append(h('div', { class: 'empty' }, h('div', { class: 'big' }, 'Nothing needs you right now'), 'Approvals, sign-in hand-offs and blocked work show up here.'));

    // Due
    const due = h('div', {});
    if (d.due.overdue.length) { due.append(h('div', { class: 'label', style: { marginTop: '4px' } }, 'Overdue')); d.due.overdue.forEach((t) => due.append(taskRow(t, { overdue: true }))); }
    due.append(h('div', { class: 'label', style: { marginTop: '8px' } }, 'Today'));
    if (d.due.today.length) d.due.today.forEach((t) => due.append(taskRow(t)));
    else due.append(h('div', { class: 'meta muted small', style: { padding: '6px 0' } }, 'Nothing else due today.'));
    if (d.due.upcoming.length) { due.append(h('div', { class: 'label', style: { marginTop: '12px' } }, 'Next 7 days')); d.due.upcoming.forEach((t) => due.append(taskRow(t))); }
    if (d.grade_due.length) {
      due.append(h('div', { class: 'label', style: { marginTop: '12px' } }, 'Assessments'));
      d.grade_due.forEach((g) => due.append(h('div', { class: 'row clickable', onclick: () => ctx.navigate(`#/projects/${g.project_id}`) }, icon('projects', 16),
        h('div', { class: 'grow' }, h('div', { class: 't' }, `${g.code || g.course}: ${g.name}`), h('div', { class: 'meta' }, `${fmtWhen(g.due_at)} · ${g.weight}% of grade`)))));
    }

    // Calendar
    const cal = h('div', {});
    const c = d.calendar;
    if (c.status === 'connected') {
      if (c.conflicts) cal.append(h('div', { class: 'banner warn small', style: { marginBottom: '8px' } }, icon('alert', 16), `${c.conflicts} overlapping event(s) today`));
      if (!c.events.length) cal.append(h('div', { class: 'empty' }, 'No events today.'));
      for (const e of c.events) cal.append(h('div', { class: 'row' }, h('div', { class: 'mono', style: { width: '92px', flex: 'none' } }, e.all_day ? 'All day' : `${fmtTime(e.start)}–${fmtTime(e.end)}`),
        h('div', { class: 'grow' }, h('div', { class: 't ellipsis' }, e.summary), e.location ? h('div', { class: 'meta' }, e.location) : null),
        e.html_link ? h('a', { href: e.html_link, target: '_blank', rel: 'noopener noreferrer', class: 'btn ghost sm icon', title: 'Open in Google Calendar' }, icon('external', 14)) : null));
    } else if (c.status === 'error') {
      cal.append(h('div', { class: 'banner danger small' }, icon('alert', 16), `Google Calendar error: ${c.error}`));
    } else {
      cal.append(h('div', { class: 'empty' }, h('div', { class: 'big' }, c.status === 'permission_off' ? 'Calendar reading is turned off' : 'Google Calendar is not connected'),
        c.status === 'not_configured' ? 'Add Google OAuth credentials on the server, then connect.' : c.status === 'permission_off' ? 'Turn it on in Settings → Permissions.' : 'Connect it to see today’s events and conflicts.',
        h('div', { style: { marginTop: '10px' } }, btn('Open settings', () => ctx.navigate(c.status === 'permission_off' ? '#/settings/permissions' : '#/settings/integrations'), { size: 'sm' }))));
    }

    // Schedule
    const sched = h('div', {});
    if (!d.schedule.upcoming.length && !d.schedule.recent_runs.length) sched.append(h('div', { class: 'empty' }, 'No reminders, briefings or monitors scheduled for today.'));
    for (const j of d.schedule.upcoming) sched.append(h('div', { class: 'row' }, icon(j.kind === 'reminder' ? 'clock' : j.kind === 'monitor' ? 'eye' : j.kind === 'briefing' ? 'today' : 'bolt', 16),
      h('div', { class: 'grow' }, h('div', { class: 't ellipsis' }, j.name), h('div', { class: 'meta' }, `${fmtWhen(j.next_run_at)} · ${j.schedule_label}`)), statusChip('planned', 'scheduled')));
    for (const r of d.schedule.recent_runs.slice(0, 8)) sched.append(h('div', { class: 'row' }, icon('check', 16),
      h('div', { class: 'grow' }, h('div', { class: 't ellipsis' }, r.name), h('div', { class: 'meta' }, `${fmtTime(r.scheduled_for)}${r.error ? ` · ${r.error}` : ''}`)), statusChip(r.status)));

    // In progress
    const prog = h('div', {});
    for (const r of d.in_progress.active_runs) prog.append(h('div', { class: 'row clickable', onclick: () => ctx.navigate(`#/chat/${r.conversation_id}`) }, h('div', { class: 'grow' }, h('div', { class: 't ellipsis' }, r.title), h('div', { class: 'meta' }, `Started ${fmtAgo(r.started_at)}`)), statusChip(r.status, r.status.replace('_', ' '))));
    for (const t of d.in_progress.running_tasks) prog.append(h('div', { class: 'row clickable', onclick: () => ctx.navigate(`#/tasks/${t.id}`) }, h('div', { class: 'grow' }, h('div', { class: 't ellipsis' }, t.title)), taskStatus('running')));
    if (!prog.childElementCount) prog.append(h('div', { class: 'empty' }, 'Nothing running.'));

    // Briefing
    const brief = h('div', {});
    if (d.latest_briefing) brief.append(h('div', { class: 'meta small muted', style: { marginBottom: '6px' } }, `${d.latest_briefing.title} · ${fmtAgo(d.latest_briefing.created_at)}`), renderMarkdown(d.latest_briefing.body));
    else brief.append(h('div', { class: 'empty' }, 'No briefing yet. Turn on the daily briefing in Settings → Notifications, or preview one now.'));

    page.append(h('div', { class: 'today-grid' },
      h('div', { class: 'stack' },
        card('Needs your attention', attentionCount ? `${attentionCount} item(s)` : null, att),
        card('Due', `${d.due.overdue.length ? `${d.due.overdue.length} overdue · ` : ''}${d.due.today.length} today · ${d.due.upcoming.length} this week`, due, btn('All tasks', () => ctx.navigate('#/tasks'), { size: 'sm', kind: 'ghost' })),
        card('Latest briefing', null, brief, btn('Preview now', async () => {
          try { const b = await api.post('/api/briefing/preview'); dialog({ title: 'Briefing (from your data, no Claude summary)', body: renderMarkdown(b.markdown), wide: true }); } catch (e) { errorToast(e); }
        }, { size: 'sm', kind: 'ghost' }))),
      h('div', { class: 'stack' },
        card('Calendar today', null, cal),
        card('Scheduled today', null, sched, btn('Schedules', () => ctx.navigate('#/tasks/schedules'), { size: 'sm', kind: 'ghost' })),
        card('In progress', null, prog))));
  }

  const offs = ['task.updated', 'task.deleted', 'approval.updated', 'handoff.updated', 'job.updated', 'job.run', 'run.updated', 'notification.created'].map((t) => on(t, reload));
  load();
  return () => { disposed = true; offs.forEach((f) => f()); };
}
