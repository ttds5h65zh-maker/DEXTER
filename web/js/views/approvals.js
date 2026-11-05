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
  const grantsEl = h('div', { class: 'card' });
  page.append(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Approvals'), h('p', {}, 'Dexter shows the exact action and content before it sends, submits, changes or deletes anything. Nothing here runs until you approve it.'))),
    handoffEl, pendingEl,
    h('h2', { style: { margin: '28px 0 10px' } }, 'Standing authorizations'), grantsEl,
    h('h2', { style: { margin: '28px 0 10px' } }, 'History'), historyEl);

  async function render() {
    let all = []; let handoffs = []; let grants = [];
    try {
      [all, handoffs, grants] = await Promise.all([
        api.get('/api/approvals').then((r) => r.approvals),
        api.get('/api/handoffs').then((r) => r.handoffs),
        api.get('/api/grants').then((r) => r.grants),
      ]);
    } catch (err) { errorToast(err); }
    clear(pendingEl); clear(historyEl); clear(handoffEl); clear(grantsEl);
    for (const hd of handoffs) handoffEl.append(handoffCard(hd, { onDone: render }));
    const pending = all.filter((a) => a.status === 'pending');
    if (!pending.length) pendingEl.append(h('div', { class: 'card' }, empty('No approvals waiting', 'When Dexter prepares an email, calendar change, form submission or deletion, it waits here for you.')));
    for (const a of pending) {
      const card = approvalCard(a, { onDecided: render });
      if (a.id === focusId) setTimeout(() => card.scrollIntoView({ block: 'start', behavior: 'smooth' }), 50);
      pendingEl.append(card);
    }
    if (!grants.length) grantsEl.append(h('div', { class: 'card-body small muted' }, 'None. When you approve an action you can choose “don’t ask again” for that exact kind of action (for example, emails to one specific address). Deletions and form submissions always ask.'));
    for (const g of grants) {
      grantsEl.append(h('div', { class: 'task-row', style: { cursor: 'default' } }, icon('shield', 16),
        h('div', { class: 'grow' }, h('div', { class: 't' }, g.description), h('div', { class: 'meta small' }, `${g.tool} · used ${g.uses} time(s)${g.last_used_at ? `, last ${fmtAgo(g.last_used_at)}` : ''} · granted ${fmtAgo(g.created_at)}`)),
        btn('Revoke', async () => { if (await confirmDialog('Revoke authorization?', 'Dexter will ask again next time.', { confirmLabel: 'Revoke', danger: true })) { await api.del(`/api/grants/${g.id}`).catch(errorToast); toast('Revoked'); render(); } }, { size: 'sm', kind: 'danger' })));
    }
    const decided = all.filter((a) => a.status !== 'pending');
    if (!decided.length) historyEl.append(h('div', { class: 'card-body small muted' }, 'No decisions yet.'));
    for (const a of decided.slice(0, 60)) {
      historyEl.append(h('details', { class: 'task-row', style: { display: 'block', cursor: 'default' } },
        h('summary', { style: { display: 'flex', gap: '10px', alignItems: 'center', cursor: 'pointer' } },
          h('div', { class: 'grow', style: { minWidth: '0' } }, h('div', { class: 't' }, a.title), h('div', { class: 'meta small' }, `${a.summary} · ${fmtAgo(a.decided_at || a.created_at)}${a.external_ref ? ` · ${a.external_ref}` : ''}`)),
          statusChip(a.status, a.status === 'executed' ? 'done — confirmed' : a.status)),
        h('div', { style: { marginTop: '10px' } }, approvalCard(a))));
    }
  }

  pendingEl.append(loading());
  render();
  const reload = debounce(render, 250);
  const offs = [on('approval.updated', reload), on('handoff.updated', reload), on('grant.updated', reload)];
  return () => offs.forEach((f) => f());
}
