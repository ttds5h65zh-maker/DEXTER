// Memory: inspect, edit, pin and delete what Dexter Almana remembers, with source and last update.
import { h, clear, btn, fmtAgo, fmtDateTime, errorToast, toast, confirmDialog, empty, loading, debounce } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { on } from '../store.js';

const KINDS = ['preference', 'project', 'course', 'person', 'fact'];

export function mount(container, _ctx = {}, { embedded = false } = {}) {
  const page = embedded ? container : h('div', { class: 'page narrow' });
  if (!embedded) container.append(page);
  let kind = '';
  let q = '';
  let editing = null;
  const listEl = h('div', { class: 'card' });

  const content = h('textarea', { class: 'textarea', rows: '2', placeholder: 'Something Dexter Almana should remember, e.g. “I have Arabic 101 on Mon/Wed 10:00–11:15 in EB2”', 'aria-label': 'New memory' });
  const kindSel = h('select', { class: 'select', style: { width: '160px' }, 'aria-label': 'Kind' }, KINDS.map((k) => h('option', { value: k }, k)));
  kindSel.value = 'preference';
  const pin = h('input', { type: 'checkbox' });
  page.append(
    embedded ? h('p', { class: 'muted', style: { marginTop: 0 } }, 'What Dexter Almana remembers about you. Each memory shows where it came from and when it last changed.') : h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Memory'), h('p', {}, 'What Dexter Almana remembers about you. Each memory shows where it came from and when it last changed.'))),
    h('form', { class: 'card card-pad', style: { marginBottom: '16px' }, onsubmit: async (e) => {
      e.preventDefault();
      if (!content.value.trim()) return;
      try { const { memory } = await api.post('/api/memories', { content: content.value, kind: kindSel.value, pinned: pin.checked }); content.value = ''; pin.checked = false; toast(memory.duplicate ? 'Already saved' : 'Saved'); render(); } catch (err) { errorToast(err); }
    } }, content, h('div', { class: 'btn-row', style: { marginTop: '10px' } }, kindSel, h('label', { class: 'small', style: { display: 'flex', gap: '6px', alignItems: 'center' } }, pin, 'Always include'), h('div', { style: { flex: '1' } }), btn('Save memory', null, { kind: 'primary', type: 'submit', ic: 'plus' }))),
    listEl);

  async function render() {
    let memories = [];
    try {
      const qs = new URLSearchParams();
      if (q) qs.set('q', q);
      if (kind) qs.set('kind', kind);
      memories = (await api.get(`/api/memories?${qs}`)).memories;
    } catch (err) { errorToast(err); }
    clear(listEl);
    const seg = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Filter by kind' }, ['', ...KINDS].map((k) => h('button', { type: 'button', class: k === kind ? 'on' : '', 'aria-pressed': String(k === kind), onclick: () => { kind = k; render(); } }, k || 'All')));
    listEl.append(h('div', { class: 'card-head', style: { flexWrap: 'wrap' } }, seg,
      h('input', { class: 'input', type: 'search', placeholder: 'Search memories', value: q, style: { maxWidth: '220px' }, 'aria-label': 'Search memories', oninput: debounce((e) => { q = e.target.value; render(); }, 250) })));
    if (!memories.length) { listEl.append(empty(q || kind ? 'No matching memories' : 'Nothing remembered yet', q || kind ? null : 'Tell Dexter Almana about your schedule, preferences and courses — in chat or above.')); return; }
    for (const m of memories) listEl.append(item(m));
  }

  function item(m) {
    const source = m.source_type === 'conversation' && m.source_id
      ? h('a', { href: `#/chat/${m.source_id}` }, `From conversation: ${m.source_label || 'conversation'}`)
      : h('span', {}, m.source_label || (m.source_type === 'manual' ? 'Added by you' : m.source_type));
    if (editing === m.id) {
      const ta = h('textarea', { class: 'textarea', value: m.content, 'aria-label': 'Edit memory' });
      const ks = h('select', { class: 'select', style: { width: '160px' } }, KINDS.map((k) => h('option', { value: k }, k)));
      ks.value = m.kind;
      setTimeout(() => ta.focus(), 0);
      return h('div', { class: 'card-body', style: { borderBottom: '1px solid var(--border)' } }, ta,
        h('div', { class: 'btn-row', style: { marginTop: '8px' } }, ks, h('div', { style: { flex: '1' } }),
          btn('Cancel', () => { editing = null; render(); }, { size: 'sm' }),
          btn('Save', async () => { try { await api.patch(`/api/memories/${m.id}`, { content: ta.value, kind: ks.value }); editing = null; render(); } catch (e) { errorToast(e); } }, { size: 'sm', kind: 'primary' })));
    }
    return h('div', { class: 'task-row', style: { cursor: 'default', alignItems: 'flex-start' } },
      h('div', { class: 'grow' },
        h('div', { style: { whiteSpace: 'pre-wrap' } }, m.content),
        h('div', { class: 'meta small muted', style: { marginTop: '4px', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
          h('span', { class: 'tag' }, m.kind), m.pinned ? h('span', { class: 'tag accent' }, icon('pin', 11), 'always included') : null,
          source, h('span', { title: fmtDateTime(m.updated_at) }, `· updated ${fmtAgo(m.updated_at)}`))),
      h('div', { class: 'btn-row' },
        btn('', async () => { try { await api.patch(`/api/memories/${m.id}`, { pinned: !m.pinned }); render(); } catch (e) { errorToast(e); } }, { kind: 'ghost', ic: 'pin', title: m.pinned ? 'Unpin' : 'Always include', size: 'sm' }),
        btn('', () => { editing = m.id; render(); }, { kind: 'ghost', ic: 'edit', title: 'Edit', size: 'sm' }),
        btn('', async () => { if (await confirmDialog('Delete memory?', `“${m.content.slice(0, 140)}” will be forgotten.`, { confirmLabel: 'Delete', danger: true })) { await api.del(`/api/memories/${m.id}`).catch(errorToast); render(); } }, { kind: 'ghost', ic: 'trash', title: 'Delete', size: 'sm' })));
  }

  listEl.append(loading());
  render();
  const offs = [on('memory.updated', debounce(() => { if (!editing) render(); }, 300)), on('memory.deleted', debounce(render, 300))];
  return () => offs.forEach((f) => f());
}
