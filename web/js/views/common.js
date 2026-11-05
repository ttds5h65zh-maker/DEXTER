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

/** Approval card: the exact action and content, where it came from, and the decision. */
export function approvalCard(a, { onDecided = null } = {}) {
  const p = a.preview || {};
  const pendingNow = a.status === 'pending';
  const card = h('div', { class: `approval approval-card${pendingNow ? '' : ' done'}`, id: `approval-${a.id}` });
  card.append(h('div', { class: 'a-title' }, icon('shield', 17), h('span', { class: 'grow' }, a.title), pendingNow ? null : statusChip(a.status, a.status === 'executed' ? 'done' : a.status)));
  card.append(h('div', { class: 'a-sub' }, pendingNow ? 'Nothing happens until you approve.' : `Requested ${fmtAgo(a.created_at)}`,
    a.conversation_id ? [' · ', h('a', { href: `#/chat/${a.conversation_id}` }, 'chat')] : null, a.task_id ? [' · ', h('a', { href: `#/tasks/${a.task_id}` }, 'task')] : null));
  if (a.provenance?.length && pendingNow) {
    card.append(h('div', { class: 'banner warn small', style: { marginBottom: '10px' } }, icon('alert', 16),
      h('div', { class: 'grow' }, 'This was prepared after reading outside content (', a.provenance.map((s) => s.label).join('; '), '). Instructions inside emails, pages or files never count as your permission — check it is what you want.')));
  }
  if (p.fields?.length) {
    const dl = h('dl', { class: 'kv fields' });
    for (const f of p.fields) dl.append(h('dt', {}, f.label), h('dd', {}, f.value));
    card.append(dl);
  }
  if (p.body) card.append(h('pre', { class: 'pre' }, p.body));
  if (p.screenshot_file_id) card.append(h('img', { class: 'shot', src: `/api/files/${p.screenshot_file_id}/preview`, alt: 'The page this action will affect' }));
  if (pendingNow) {
    const note = h('input', { class: 'input', placeholder: 'Add a note (optional)', 'aria-label': 'Note', style: { marginTop: '12px' } });
    let allow = null;
    if (a.grantable && a.grant_scope?.description) {
      allow = h('input', { type: 'checkbox' });
      card.append(h('label', { class: 'small muted', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '12px' } }, allow, `Don't ask again: ${a.grant_scope.description}`));
    }
    const decide = async (decision) => {
      try {
        const payload = { note: note.value || null };
        if (decision === 'approve' && allow?.checked) payload.always_allow = true;
        await api.post(`/api/approvals/${a.id}/${decision}`, payload);
        toast(decision === 'approve' ? 'Approved — it shows as done once the service confirms.' : 'Declined — nothing was done.');
        onDecided?.();
      } catch (err) { errorToast(err); }
    };
    card.append(note, h('div', { class: 'btn-row', style: { marginTop: '12px' } },
      btn('Approve', () => decide('approve'), { kind: 'primary' }),
      btn('Decline', () => decide('reject'))));
  } else {
    const outcome = [];
    if (a.decision_note) outcome.push(h('div', { class: 'small' }, `Note: ${a.decision_note}`));
    if (a.result_summary) outcome.push(h('div', { class: 'small' }, a.result_summary));
    if (a.external_ref) outcome.push(h('div', { class: 'small mono muted' }, `Confirmation ${a.external_ref}`));
    if (a.status === 'approved') outcome.push(h('div', { class: 'small muted' }, 'Approved — waiting for the service to confirm.'));
    if (a.status === 'unknown') outcome.push(h('div', { class: 'banner warn small' }, icon('alert'), 'Stopped while this was running. Check the service before trying again.'));
    if (outcome.length) card.append(h('div', { style: { marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' } }, outcome));
  }
  return card;
}

export function handoffCard(hd, { onDone = null } = {}) {
  return h('div', { class: 'approval' }, h('div', { class: 'a-title' }, icon('user', 17), hd.title), h('div', { class: 'a-sub' }, 'Your turn'),
    h('div', {}, h('div', { class: 'small', style: { margin: '0 0 8px' } }, hd.message),
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
