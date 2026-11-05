// Approvals: every action that sends, submits, changes or deletes something.
import { h, clear, btn, statusChip, fmtAgo, errorToast, empty, loading, debounce, confirmDialog, toast } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { on } from '../store.js';
import { approvalCard, handoffCard } from './common.js';

export function mount(container, ctx) {
  const page = h('div', { class: 'page narrow' });
  container.append(page);
  const focusId = ctx.params[0] || null;
  const pendingEl = h('div', { class: 'stack' });
  const handoffEl = h('div', { class: 'stack' });
  const historyEl = h('div', { class: 'card' });
  page.append(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Approvals'), h('p', {}, 'Nothing is sent, submitted, changed or deleted until you approve it here or in the chat.'))),
    handoffEl, pendingEl,
    h('div', { class: 'section-title', style: { marginTop: '32px' } }, 'History'), historyEl);

  async function render() {
    let all = []; let handoffs = [];
    try {
      [all, handoffs] = await Promise.all([
        api.get('/api/approvals').then((r) => r.approvals),
        api.get('/api/handoffs').then((r) => r.handoffs),
      ]);
    } catch (err) { errorToast(err); }
    clear(pendingEl); clear(historyEl); clear(handoffEl);
    for (const hd of handoffs) handoffEl.append(handoffCard(hd, { onDone: render }));
    const pending = all.filter((a) => a.status === 'pending');
    if (!pending.length) pendingEl.append(empty('Nothing waiting for you', 'Emails, calendar changes, form submissions and deletions wait here until you decide.'));
    for (const a of pending) {
      const card = approvalCard(a, { onDecided: render });
      if (a.id === focusId) setTimeout(() => card.scrollIntoView({ block: 'start', behavior: 'smooth' }), 50);
      pendingEl.append(card);
    }
    const decided = all.filter((a) => a.status !== 'pending');
    if (!decided.length) historyEl.append(h('div', { class: 'card-body quiet-empty' }, 'No decisions yet.'));
    for (const a of decided.slice(0, 60)) {
      historyEl.append(h('details', { class: 'task-row', style: { display: 'block', cursor: 'default' } },
        h('summary', { style: { display: 'flex', gap: '10px', alignItems: 'center', cursor: 'pointer' } },
          h('div', { class: 'grow', style: { minWidth: '0' } }, h('div', { class: 't' }, a.title), h('div', { class: 'meta small' }, `${a.summary} · ${fmtAgo(a.decided_at || a.created_at)}${a.external_ref ? ` · ${a.external_ref}` : ''}`)),
          statusChip(a.status, a.status === 'executed' ? 'done' : a.status)),
        h('div', { style: { marginTop: '10px' } }, approvalCard(a))));
    }
  }

  pendingEl.append(loading());
  render();
  const reload = debounce(render, 250);
  const offs = [on('approval.updated', reload), on('handoff.updated', reload)];
  return () => offs.forEach((f) => f());
}
