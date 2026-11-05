// Components shared by several views.
import { h, btn, statusChip, fmtAgo, errorToast, toast } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';

export const TOOL_LABELS = {
  create_task: 'Create task', update_task: 'Update task', list_tasks: 'List tasks', get_task: 'Read task',
  save_memory: 'Save memory', update_memory: 'Update memory', search_memory: 'Search memory', delete_memory: 'Delete memory',
  schedule_reminder: 'Schedule reminder', schedule_briefing: 'Schedule briefing', create_monitor: 'Create monitor', schedule_agent_task: 'Schedule recurring work',
  list_jobs: 'List schedules', cancel_job: 'Cancel schedule', list_projects: 'List courses', create_project: 'Create course', update_project: 'Update course',
  add_grade_item: 'Add grade item', update_grade_item: 'Update grade', get_course_summary: 'Course summary',
  create_document: 'Draft document', get_document: 'Read document', update_document: 'Edit document', edit_document: 'Edit document', export_document: 'Export document',
  list_files: 'List files', read_file: 'Read file', fetch_url: 'Read web page',
  email_search: 'Search Gmail', email_read: 'Read email', email_create_draft: 'Save Gmail draft', email_send: 'Send email',
  calendar_list_events: 'Read calendar', calendar_find_conflicts: 'Check conflicts', calendar_create_event: 'Add calendar event', calendar_update_event: 'Change calendar event', calendar_delete_event: 'Delete calendar event',
  browser_open: 'Open site', browser_read_page: 'Read page', browser_follow_link: 'Follow link', browser_screenshot: 'Screenshot', browser_click: 'Click button', browser_fill_and_submit: 'Submit form',
  web_search: 'Web search', web_fetch: 'Fetch page',
};

export const toolLabel = (n) => TOOL_LABELS[n] || n.replace(/_/g, ' ');

export const STATUS_LABELS = { planned: 'Planned', running: 'Running', blocked: 'Blocked', awaiting_approval: 'Awaiting approval', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' };

export function taskStatus(s) { return statusChip(s, STATUS_LABELS[s] || s); }

/** Full approval card: exact action, content, provenance and decision controls. */
export function approvalCard(a, { onDecided = null, compact = false } = {}) {
  const p = a.preview || {};
  const card = h('div', { class: `card approval-card${compact ? '' : ''}`, id: `approval-${a.id}` });
  const head = h('div', { class: 'card-head' },
    h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', minWidth: '0' } }, icon('shield', 18), h('h2', { class: 'ellipsis' }, a.title)),
    statusChip(a.status === 'pending' ? 'pending' : a.status, a.status === 'pending' ? 'Awaiting approval' : a.status));
  const body = h('div', { class: 'card-body' });
  body.append(h('div', { class: 'small muted' }, `Requested ${fmtAgo(a.created_at)}`, a.conversation_id ? [' · ', h('a', { href: `#/chat/${a.conversation_id}` }, 'open conversation')] : null, a.task_id ? [' · ', h('a', { href: `#/tasks/${a.task_id}` }, 'task')] : null));
  if (a.provenance?.length && a.status === 'pending') {
    body.append(h('div', { class: 'banner warn', style: { marginTop: '10px' } }, icon('alert'),
      h('div', { class: 'grow' }, h('b', {}, 'Dexter read external content during this work. '),
        'Check that this action is what you want — instructions inside emails, pages or files are never treated as your permission. Sources: ',
        a.provenance.map((s) => `${s.source}: ${s.label}`).join('; '))));
  }
  if (p.fields?.length) {
    const dl = h('dl', { class: 'kv fields' });
    for (const f of p.fields) dl.append(h('dt', {}, f.label), h('dd', {}, f.value));
    body.append(dl);
  }
  if (p.body) body.append(h('div', { class: 'label', style: { marginBottom: '4px' } }, 'Content'), h('pre', { class: 'pre' }, p.body));
  if (p.screenshot_file_id) body.append(h('img', { class: 'shot', src: `/api/files/${p.screenshot_file_id}/preview`, alt: 'Screenshot of the page this action will affect' }));
  if (a.status === 'pending') {
    const note = h('input', { class: 'input', placeholder: 'Optional note (e.g. what to change if you reject)', 'aria-label': 'Note' });
    let allow = null;
    if (a.grantable && a.grant_scope?.description) {
      allow = h('input', { type: 'checkbox' });
      body.append(h('label', { class: 'small', style: { display: 'flex', gap: '8px', alignItems: 'center', margin: '12px 0 4px' } }, allow, `Don't ask again: ${a.grant_scope.description}`));
    }
    const decide = async (decision) => {
      try {
        const payload = { note: note.value || null };
        if (decision === 'approve' && allow?.checked) payload.always_allow = true;
        await api.post(`/api/approvals/${a.id}/${decision}`, payload);
        toast(decision === 'approve' ? 'Approved — Dexter is carrying it out. It shows as completed only when the service confirms.' : 'Rejected — nothing was done.');
        onDecided?.();
      } catch (err) { errorToast(err); }
    };
    body.append(h('div', { style: { marginTop: '12px' } }, note),
      h('div', { class: 'btn-row', style: { marginTop: '10px' } },
        btn('Approve', () => decide('approve'), { kind: 'primary', ic: 'check' }),
        btn('Reject', () => decide('reject'), { kind: 'danger', ic: 'x' })));
  } else {
    const outcome = [];
    if (a.decision_note) outcome.push(h('div', { class: 'small' }, `Note: ${a.decision_note}`));
    if (a.result_summary) outcome.push(h('div', { class: 'small' }, `Result: ${a.result_summary}`));
    if (a.external_ref) outcome.push(h('div', { class: 'small mono' }, `Confirmation: ${a.external_ref}`));
    if (a.status === 'approved') outcome.push(h('div', { class: 'small muted' }, 'Approved; waiting for the service to confirm.'));
    if (a.status === 'unknown') outcome.push(h('div', { class: 'banner warn small' }, icon('alert'), 'Dexter stopped while this was executing. Check the service before trying again.'));
    if (outcome.length) body.append(h('div', { style: { marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '4px' } }, outcome));
  }
  card.append(head, body);
  return card;
}

export function handoffCard(hd, { onDone = null } = {}) {
  return h('div', { class: 'banner warn' }, icon('user'),
    h('div', { class: 'grow' }, h('b', {}, hd.title), h('div', { class: 'small', style: { margin: '4px 0 8px' } }, hd.message),
      hd.url ? h('div', { class: 'tiny mono ellipsis' }, hd.url) : null,
      hd.screenshot_file_id ? h('img', { class: 'shot', src: `/api/files/${hd.screenshot_file_id}/preview`, alt: 'Screenshot', style: { maxWidth: '100%', marginTop: '8px', borderRadius: '6px' } }) : null,
      h('div', { class: 'btn-row', style: { marginTop: '8px' } },
        btn("I've done it — continue", async () => { try { await api.post(`/api/handoffs/${hd.id}/resolve`); toast('Continuing…'); onDone?.(); } catch (e) { errorToast(e); } }, { kind: 'primary', size: 'sm' }),
        btn('Cancel this step', async () => { try { await api.post(`/api/handoffs/${hd.id}/cancel`); onDone?.(); } catch (e) { errorToast(e); } }, { size: 'sm' }))));
}

export function projectLabel(p) {
  if (!p) return '';
  return p.code ? `${p.code} · ${p.name}` : p.name;
}

let projectCache = null;
export async function loadProjects(force = false) {
  if (!projectCache || force) projectCache = (await api.get('/api/projects')).projects;
  return projectCache;
}

export function projectSelect(projects, value, { includeNone = true, onChange = null } = {}) {
  const s = h('select', { class: 'select', onchange: (e) => onChange?.(e.target.value) },
    includeNone ? h('option', { value: '' }, 'No course/project') : null,
    projects.map((p) => h('option', { value: p.id }, projectLabel(p))));
  s.value = value || '';
  return s;
}
