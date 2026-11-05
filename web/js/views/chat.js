// Chat: persistent conversations, streaming replies, attachments, visible tool
// activity with inline approvals and hand-offs.
import { h, append, clear, btn, statusChip, fmtAgo, fmtSize, errorToast, toast, confirmDialog, empty, loading, debounce } from '../dom.js';
import { icon, toolIcon } from '../icons.js';
import { api } from '../api.js';
import { state, on } from '../store.js';
import { renderMarkdown } from '../markdown.js';
import { toolLabel, approvalCard, handoffCard, loadProjects, projectSelect } from './common.js';

const SUGGESTIONS = [
  { t: 'Triage my inbox', d: 'Summarise unread email, flag deadlines and draft replies', p: 'Summarise my unread email from the last two days. Flag anything with a deadline and create tasks for those. Draft replies where one is needed (save them as drafts — do not send).' },
  { t: 'Plan this week', d: 'Deadlines, calendar conflicts and study blocks', p: "What's due this week? Check my calendar for conflicts and propose study blocks around my classes." },
  { t: 'Set up a course', d: 'Requirements, grading breakdown and deadlines', p: 'Help me set up a course: I will paste the syllabus. Create the course, its grade items with weights, and tasks for each deadline.' },
  { t: 'Morning briefing', d: 'Every weekday at 7:30 in Dubai time', p: 'Schedule a briefing every Sunday to Thursday at 07:30 with my deadlines, calendar and unread email.' },
];
const OFFLINE_SUGGESTIONS = [
  { t: '/task', d: 'Create a task', p: '/task Submit MIS report due fri 17:00' },
  { t: '/remind', d: 'Schedule a reminder', p: '/remind tomorrow 9am to check Banner registration' },
  { t: '/remember', d: 'Save a memory', p: '/remember I prefer study blocks in the morning' },
  { t: '/brief', d: 'Briefing from your data', p: '/brief' },
];

export function mount(container, ctx) {
  const paramId = ctx.params[0];
  let convId = paramId && paramId !== 'new' ? paramId : null;
  let data = null;
  const streaming = new Map(); // message id -> Map(index -> item)
  const offs = [];
  let attachments = [];
  let disposed = false;

  const layout = h('div', { class: `chat${!paramId ? ' show-list' : ''}` });
  const listEl = h('div', { class: 'conv-list' });
  const threadEl = h('section', { class: 'thread', 'aria-label': 'Conversation' });
  layout.append(listEl, threadEl);
  container.append(layout);

  // ------------------------------------------------------------ list -----
  let listQuery = '';
  async function renderList() {
    let convs = [];
    try { convs = (await api.get(`/api/conversations${listQuery ? `?q=${encodeURIComponent(listQuery)}` : ''}`)).conversations; } catch (err) { errorToast(err); }
    if (disposed) return;
    clear(listEl);
    const search = h('input', { class: 'input', type: 'search', placeholder: 'Search conversations', value: listQuery, 'aria-label': 'Search conversations',
      oninput: debounce((e) => { listQuery = e.target.value; renderList().then(() => listEl.querySelector('input')?.focus()); }, 250) });
    listEl.append(h('div', { class: 'conv-list-head' },
      btn('New conversation', () => ctx.navigate('#/chat/new'), { kind: 'primary', ic: 'plus' }), search));
    const items = h('nav', { class: 'conv-items', 'aria-label': 'Conversations' });
    if (!convs.length) items.append(h('div', { class: 'empty' }, listQuery ? 'No matches.' : 'No conversations yet.'));
    for (const c of convs) {
      const live = ['running', 'awaiting_approval', 'blocked'].includes(c.last_run_status);
      items.append(h('a', { class: `conv-item${c.id === convId ? ' active' : ''}`, href: `#/chat/${c.id}` },
        h('div', { class: 't' }, live ? h('span', { class: `dot ${c.last_run_status === 'running' ? 'live' : 'warn'}`, title: c.last_run_status.replace('_', ' ') }) : null, h('span', {}, c.title)),
        h('div', { class: 'p' }, c.kind === 'scheduled' ? 'Scheduled work · ' : '', c.preview || fmtAgo(c.updated_at))));
    }
    listEl.append(items);
  }

  // ---------------------------------------------------------- thread -----
  const messagesEl = h('div', { class: 'messages', role: 'log', 'aria-live': 'polite' });
  const inner = h('div', { class: 'messages-inner' });
  messagesEl.append(inner);
  const runbarSlot = h('div');
  const headEl = h('div', { class: 'thread-head' });

  const nearBottom = () => messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
  const toBottom = () => { messagesEl.scrollTop = messagesEl.scrollHeight; };

  function toolCallMap() { return new Map((data?.tool_calls || []).map((t) => [t.id, t])); }

  function renderToolItem(item, tc) {
    const status = tc?.status || (item.preparing ? 'running' : 'pending');
    const approval = tc?.approval_id ? data.approvals.find((a) => a.id === tc.approval_id) : null;
    const handoff = tc?.handoff_id ? data.handoffs.find((x) => x.id === tc.handoff_id) : null;
    const needsYou = status === 'awaiting_approval' || status === 'waiting_user';
    const wrap = h('div', { class: `tool${status === 'awaiting_approval' ? ' attention' : ''}${status === 'waiting_user' ? ' blocked' : ''}` });
    const label = {
      pending: 'queued', running: item.preparing ? 'preparing' : 'running', succeeded: 'done', failed: 'failed', declined: 'not done',
      awaiting_approval: 'awaiting approval', waiting_user: 'waiting for you', unknown: 'outcome unknown',
    }[status] || status;
    const chip = statusChip({ succeeded: 'completed', declined: 'declined', waiting_user: 'blocked', pending: 'queued' }[status] || status, label);
    const body = h('div', { class: 'tool-body' });
    let open = needsYou;
    const head = h('div', { class: 'tool-head', role: 'button', tabindex: '0', 'aria-expanded': String(open),
      onclick: () => { open = !open; body.hidden = !open; head.setAttribute('aria-expanded', String(open)); },
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); head.click(); } } },
    toolIcon(item.name), h('span', { class: 'name' }, toolLabel(item.name)), h('span', { class: 'sum' }, tc?.summary || summarizeInput(item.name, tc?.input)), chip);
    body.hidden = !open;
    if (status === 'awaiting_approval' && approval) {
      body.append(h('div', { class: 'small' }, 'Dexter paused here. Review the exact action:'));
      api.get(`/api/approvals/${approval.id}`).then(({ approval: full }) => {
        body.append(approvalCard(full, { onDecided: () => reload() }));
      }).catch(errorToast);
    } else if (status === 'waiting_user' && handoff) {
      body.append(handoffCard(handoff, { onDone: () => reload() }));
    } else {
      if (tc?.input && Object.keys(tc.input).length) body.append(h('div', { class: 'label' }, 'Input'), h('pre', { class: 'pre code' }, JSON.stringify(tc.input, null, 2)));
      if (tc?.external_ref) body.append(h('div', { class: 'small' }, 'Confirmation / reference: ', h('span', { class: 'mono' }, tc.external_ref)));
      if (tc?.error) body.append(h('div', { class: 'small', style: { color: 'var(--danger)' } }, tc.error));
      if (status === 'unknown') body.append(h('div', { class: 'banner warn small' }, icon('alert'), 'Dexter stopped while this action was running. It was not retried; check the service before asking again.'));
      if (!tc) body.append(h('div', { class: 'small muted' }, 'Waiting for the tool call to finish streaming…'));
    }
    wrap.append(head, body);
    return wrap;
  }

  function summarizeInput(name, input) {
    if (!input) return '';
    if (input.title) return input.title;
    if (input.subject) return `${input.subject}${input.to ? ` → ${[].concat(input.to).join(', ')}` : ''}`;
    if (input.query) return input.query;
    if (input.message) return input.message;
    if (input.content) return String(input.content).slice(0, 80);
    if (input.url) return input.url;
    if (input.name) return input.name;
    return '';
  }

  function renderItems(items, msg, tcs) {
    const out = [];
    for (const [i, item] of items.entries()) {
      const isLastText = msg.status === 'streaming' && i === items.length - 1 && item.type === 'text';
      if (item.type === 'text') {
        const md = renderMarkdown(item.text);
        if (isLastText) md.classList.add('caret');
        out.push(md);
        if (item.citations?.length) out.push(sources(item.citations));
      } else if (item.type === 'progress') {
        out.push(h('div', { class: 'progress-line' }, item.text));
      } else if (item.type === 'tool') {
        out.push(renderToolItem(item, tcs.get(item.id)));
      } else if (item.type === 'server_tool') {
        const q = item.input?.query || item.input?.url || '';
        out.push(h('div', { class: 'tool' }, h('div', { class: 'tool-head' }, icon('globe', 15), h('span', { class: 'name' }, toolLabel(item.name)), h('span', { class: 'sum' }, q ? `“${q}”` : '…'))));
      } else if (item.type === 'search_results') {
        if (item.results?.length) out.push(sources(item.results.slice(0, 8)));
        else out.push(h('div', { class: 'small muted' }, `Web search failed: ${item.error || 'no results'}`));
      } else if (item.type === 'fetch_result') {
        out.push(h('div', { class: 'small muted' }, item.error ? `Could not fetch page (${item.error})` : `Read: ${item.title || item.url}`));
      } else if (item.type === 'notice') {
        out.push(h('div', { class: 'banner small' }, icon('alert', 16), item.text));
      }
    }
    return out;
  }

  function sources(list) {
    return h('div', { class: 'sources' }, list.map((s) => h('a', { class: 'source', href: s.url, target: '_blank', rel: 'noopener noreferrer', title: s.url }, icon('external', 12), h('span', {}, s.title || s.url))));
  }

  function renderMessage(m, tcs) {
    if (m.kind === 'user') {
      const label = m.synthetic ? (m.synthetic === 'job' ? 'Scheduled run' : m.synthetic === 'resume' ? 'Resume' : 'Task') : 'You';
      return h('div', { class: 'msg user', dataset: { id: m.id } },
        h('div', { class: 'who' }, label),
        m.attachments?.length ? h('div', { class: 'attachments' }, m.attachments.map((f) => h('a', { class: 'chip', href: f.missing ? null : `#/files/${f.id}` }, icon('clip', 13), h('span', {}, f.name)))) : null,
        m.text ? h('div', { class: 'bubble' }, m.text) : null);
    }
    if (m.kind === 'command' || m.kind === 'notice') {
      return h('div', { class: 'msg assistant', dataset: { id: m.id } },
        h('div', { class: 'who' }, h('span', { class: 'avatar' }, 'D'), m.kind === 'command' ? `Command /${m.meta?.command || ''} · ran locally` : 'Notice'),
        h('div', { class: `command-card${m.meta?.ok === false ? ' err' : ''}` }, renderMarkdown(m.text)));
    }
    const local = streaming.get(m.id);
    const items = m.status === 'streaming' && local ? [...local.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v).filter((v) => !(v.type === 'progress' && !v.text.trim())) : (m.items || []);
    const body = h('div', { class: 'body' }, renderItems(items, m, tcs));
    if (m.status === 'streaming' && !items.length) body.append(h('div', { class: 'progress-line' }, h('span', { class: 'spinner' }), ' Thinking…'));
    if (m.status === 'interrupted') body.append(h('div', { class: 'small muted' }, 'This reply was interrupted before it finished.'));
    if (m.status === 'cancelled') body.append(h('div', { class: 'small muted' }, 'Stopped.'));
    if (m.status === 'declined') body.append(h('div', { class: 'small muted' }, 'Not shown to the model in later turns.'));
    return h('div', { class: 'msg assistant', dataset: { id: m.id } }, h('div', { class: 'who' }, h('span', { class: 'avatar' }, 'D'), 'Dexter', m.meta?.model ? h('span', { class: 'tiny muted', style: { fontWeight: '400' } }, m.meta.model) : null), body);
  }

  function renderMessages({ keepScroll = false } = {}) {
    const stick = !keepScroll || nearBottom();
    const prevTop = messagesEl.scrollTop;
    clear(inner);
    const tcs = toolCallMap();
    for (const m of data.messages) inner.append(renderMessage(m, tcs));
    if (stick) toBottom(); else messagesEl.scrollTop = prevTop;
  }

  function rerenderMessage(id) {
    const m = data?.messages.find((x) => x.id === id);
    const el = inner.querySelector(`[data-id="${id}"]`);
    if (!m || !el) return;
    const stick = nearBottom();
    el.replaceWith(renderMessage(m, toolCallMap()));
    if (stick) toBottom();
  }

  let rafPending = new Set();
  function scheduleRerender(id) {
    if (rafPending.has(id)) return;
    rafPending.add(id);
    requestAnimationFrame(() => { rafPending.delete(id); rerenderMessage(id); });
  }

  function renderRunbar() {
    clear(runbarSlot);
    if (!data) return;
    const run = data.active_run || data.runs[0];
    if (!run) return;
    let bar = null;
    if (run.status === 'running') {
      bar = h('div', { class: 'runbar' }, h('div', { class: 'spinner' }), h('div', { class: 'grow' }, h('b', {}, 'Running'), ' — Dexter is working on this.'),
        btn('Stop', async () => { try { await api.post(`/api/runs/${run.id}/cancel`); } catch (e) { errorToast(e); } }, { ic: 'stop', size: 'sm' }));
    } else if (run.status === 'awaiting_approval') {
      bar = h('div', { class: 'runbar' }, statusChip('awaiting_approval', 'Awaiting approval'), h('div', { class: 'grow' }, 'Dexter paused until you approve or reject the action below.'),
        btn('Review', () => inner.querySelector('.tool.attention')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), { size: 'sm', kind: 'primary' }),
        btn('Stop', async () => { try { await api.post(`/api/runs/${run.id}/cancel`); } catch (e) { errorToast(e); } }, { size: 'sm' }));
    } else if (run.status === 'blocked') {
      const hd = data.handoffs.find((x) => x.status === 'waiting');
      bar = h('div', { class: 'runbar' }, statusChip('blocked', 'Blocked'), h('div', { class: 'grow' }, hd ? `Waiting for you: ${hd.title}` : 'Waiting for you.'),
        btn('Show', () => inner.querySelector('.tool.blocked')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), { size: 'sm' }));
    } else if (run.status === 'failed' || run.status === 'interrupted') {
      bar = h('div', { class: 'runbar' }, statusChip(run.status), h('div', { class: 'grow small' }, run.error || 'The last run did not finish.'),
        btn(run.status === 'interrupted' ? 'Resume' : 'Retry', async () => { try { await api.post(`/api/runs/${run.id}/retry`); toast('Resuming…'); reload(); } catch (e) { errorToast(e); } }, { size: 'sm', kind: 'primary', ic: 'refresh' }));
    }
    if (bar) runbarSlot.append(bar);
  }

  // ---------------------------------------------------------- composer ---
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: (e) => { addFiles([...e.target.files]); e.target.value = ''; } });
  const textarea = h('textarea', { rows: '1', placeholder: 'Message Dexter…  (Enter to send, Shift+Enter for a new line)', 'aria-label': 'Message',
    oninput: () => autosize(), onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } } });
  const attachRow = h('div', { class: 'attachments' });
  const sendBtn = btn('', () => send(), { kind: 'primary', ic: 'send', title: 'Send' });
  const composer = h('div', { class: 'composer' }, attachRow, textarea,
    h('div', { class: 'bar' }, btn('', () => fileInput.click(), { kind: 'ghost', ic: 'clip', title: 'Attach files' }),
      h('div', { class: 'hint' }, state.boot?.integrations.anthropic.configured ? 'Actions that send, submit, change or delete always ask for your approval first.' : 'Claude is not connected — commands like /task, /remind, /remember and /brief still work.'),
      sendBtn), fileInput);
  const modelBanner = state.boot?.integrations.anthropic.configured ? null : h('div', { class: 'runbar', style: { borderColor: 'var(--warn)' } }, icon('alert', 16),
    h('div', { class: 'grow small' }, h('b', {}, 'Claude is not connected. '), 'Add ANTHROPIC_API_KEY to the .env file and restart Dexter. ', h('a', { href: '#/settings/model' }, 'Details')));

  function autosize() { textarea.style.height = 'auto'; textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`; }

  function drawAttachments() {
    clear(attachRow);
    for (const a of attachments) {
      attachRow.append(h('span', { class: `chip${a.status === 'error' ? ' err' : ''}`, title: a.error || a.name },
        a.status === 'uploading' ? h('span', { class: 'spinner', style: { width: '12px', height: '12px' } }) : icon(a.status === 'error' ? 'alert' : 'clip', 13),
        h('span', {}, `${a.name}${a.size ? ` · ${fmtSize(a.size)}` : ''}`),
        h('button', { type: 'button', 'aria-label': `Remove ${a.name}`, onclick: () => { attachments = attachments.filter((x) => x !== a); drawAttachments(); } }, icon('x', 12))));
    }
  }

  function addFiles(list) {
    for (const file of list) {
      const a = { name: file.name, size: file.size, status: 'uploading' };
      attachments.push(a);
      api.upload(file, { conversation_id: convId || '' }).then(({ file: f }) => { a.id = f.id; a.status = 'ready'; drawAttachments(); })
        .catch((err) => { a.status = 'error'; a.error = err.message; drawAttachments(); errorToast(err); });
    }
    drawAttachments();
  }

  let sending = false;
  async function send(textOverride) {
    const text = (textOverride ?? textarea.value).trim();
    if (sending) return;
    if (attachments.some((a) => a.status === 'uploading')) { toast('Wait for the attachments to finish uploading'); return; }
    const fileIds = attachments.filter((a) => a.status === 'ready').map((a) => a.id);
    if (!text && !fileIds.length) return;
    sending = true; sendBtn.disabled = true;
    try {
      let id = convId;
      if (!id) id = (await api.post('/api/conversations', {})).conversation.id;
      await api.post(`/api/conversations/${id}/messages`, { text, file_ids: fileIds });
      textarea.value = ''; attachments = []; drawAttachments(); autosize();
      if (!convId) { ctx.navigate(`#/chat/${id}`); return; }
      await reload();
    } catch (err) {
      errorToast(err);
    } finally {
      sending = false; sendBtn.disabled = false;
    }
  }

  // drag & drop
  let dragDepth = 0; let overlay = null;
  threadEl.addEventListener('dragenter', (e) => { if (![...e.dataTransfer.types].includes('Files')) return; dragDepth++; if (!overlay) { overlay = h('div', { class: 'drop-overlay' }, 'Drop files to attach'); threadEl.append(overlay); } });
  threadEl.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth && overlay) { overlay.remove(); overlay = null; } });
  threadEl.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  threadEl.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; overlay?.remove(); overlay = null; if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]); });

  // ------------------------------------------------------------ header ---
  async function renderHead() {
    clear(headEl);
    const back = btn('', () => ctx.navigate('#/chat'), { kind: 'ghost', ic: 'back', title: 'All conversations', size: 'sm' });
    back.classList.add('menu-btn');
    if (!data) { headEl.append(back, h('div', { class: 'title' }, 'New conversation')); return; }
    const title = h('input', { class: 'title-input', value: data.conversation.title, 'aria-label': 'Conversation title',
      onchange: async (e) => { try { await api.patch(`/api/conversations/${convId}`, { title: e.target.value }); renderList(); } catch (err) { errorToast(err); } },
      onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); } });
    const projects = await loadProjects().catch(() => []);
    const proj = projects.length ? projectSelect(projects, data.conversation.project_id, { onChange: async (v) => { try { await api.patch(`/api/conversations/${convId}`, { project_id: v || null }); toast('Linked to course/project'); } catch (err) { errorToast(err); } } }) : null;
    if (proj) { proj.style.width = 'auto'; proj.style.maxWidth = '220px'; proj.setAttribute('aria-label', 'Course or project'); }
    append(headEl, [back, title, proj,
      btn('', async () => {
        if (!(await confirmDialog('Delete conversation?', 'This deletes the messages in this conversation. Tasks, files and memories created from it are kept.', { confirmLabel: 'Delete', danger: true }))) return;
        try { await api.del(`/api/conversations/${convId}`); ctx.navigate('#/chat'); } catch (err) { errorToast(err); }
      }, { kind: 'ghost', ic: 'trash', title: 'Delete conversation', size: 'sm' })]);
  }

  function renderWelcome() {
    clear(inner);
    const sugg = state.boot?.integrations.anthropic.configured ? SUGGESTIONS : OFFLINE_SUGGESTIONS;
    inner.append(h('div', { class: 'welcome' },
      h('h1', {}, `What should we work on, ${state.boot?.profile.name || 'Sultan'}?`),
      h('p', {}, 'Ask in plain language. Dexter creates tasks, remembers context, uses your connected tools and asks before anything is sent or changed.'),
      h('div', { class: 'suggestions' }, sugg.map((s) => h('button', { class: 'suggestion', type: 'button', onclick: () => { textarea.value = s.p; autosize(); textarea.focus(); } }, h('b', {}, s.t), s.d)))));
  }

  async function reload() {
    if (!convId) return;
    try {
      const next = await api.get(`/api/conversations/${convId}`);
      if (disposed) return;
      // Keep locally streamed text if it is ahead of what the server persisted.
      for (const m of next.messages) if (m.status === 'streaming' && !streaming.has(m.id)) streaming.set(m.id, new Map((m.items || []).map((it, i) => [i, it])));
      data = next;
      document.title = `${data.conversation.title} · Dexter`;
      renderMessages({ keepScroll: true });
      renderRunbar();
    } catch (err) {
      if (err.status === 404) { clear(inner); inner.append(empty('Conversation not found', 'It may have been deleted.', btn('New conversation', () => ctx.navigate('#/chat/new'), { kind: 'primary' }))); return; }
      errorToast(err);
    }
  }
  const reloadSoon = debounce(reload, 150);

  append(threadEl, [headEl, messagesEl, runbarSlot, modelBanner ? h('div', {}, modelBanner) : null, h('div', { class: 'composer-wrap' }, composer)]);

  // ------------------------------------------------------------ events ---
  const mine = (d) => d && d.conversation_id === convId;
  offs.push(on('run.message', (d) => {
    if (!mine(d) || !data) return;
    if (!data.messages.some((m) => m.id === d.message.id)) {
      data.messages.push(d.message);
      streaming.set(d.message.id, new Map());
      const stick = nearBottom();
      inner.append(renderMessage(d.message, toolCallMap()));
      if (stick) toBottom();
    }
  }));
  offs.push(on('run.block', (d) => {
    if (!mine(d)) return;
    if (!streaming.has(d.message_id)) streaming.set(d.message_id, new Map());
    streaming.get(d.message_id).set(d.index, d.item);
    scheduleRerender(d.message_id);
  }));
  offs.push(on('run.delta', (d) => {
    if (!mine(d)) return;
    const item = streaming.get(d.message_id)?.get(d.index);
    if (item) { item.text += d.text; scheduleRerender(d.message_id); }
  }));
  offs.push(on('run.message.complete', (d) => {
    if (!mine(d) || !data || !d.message) return;
    streaming.delete(d.message.id);
    const i = data.messages.findIndex((m) => m.id === d.message.id);
    if (i >= 0) data.messages[i] = d.message; else data.messages.push(d.message);
    rerenderMessage(d.message.id);
    reloadSoon();
  }));
  offs.push(on('tool.updated', (d) => { if (d.tool_call?.conversation_id === convId) reloadSoon(); }));
  offs.push(on('run.updated', (d) => { if (d.run?.conversation_id === convId) reloadSoon(); renderListSoon(); }));
  offs.push(on('approval.updated', (d) => { if (d.approval?.conversation_id === convId) reloadSoon(); }));
  offs.push(on('handoff.updated', () => { if (data?.active_run) reloadSoon(); }));
  offs.push(on('conversation.message', (d) => { if (d.conversation_id === convId) reloadSoon(); }));
  offs.push(on('conversation.updated', () => renderListSoon()));
  offs.push(on('conversation.deleted', () => renderListSoon()));
  const renderListSoon = debounce(renderList, 300);

  // ------------------------------------------------------------- init ----
  renderList();
  if (convId) {
    inner.append(loading('Loading conversation…'));
    reload().then(() => { renderHead(); if (ctx.query.get('focus') !== '0') textarea.focus(); });
  } else {
    renderHead();
    renderWelcome();
    if (paramId === 'new') textarea.focus();
  }

  return () => { disposed = true; offs.forEach((f) => f()); };
}
