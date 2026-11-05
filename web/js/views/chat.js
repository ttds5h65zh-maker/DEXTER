// Chat: one centred column. New chats open on a greeting with the composer in
// the middle; replies stream in a serif voice; tool use collapses to quiet steps;
// approvals and sign-in hand-offs appear inline.
import { h, clear, btn, fmtSize, errorToast, toast, confirmDialog, empty, loading, debounce, dialog } from '../dom.js';
import { icon, toolIcon } from '../icons.js';
import { api } from '../api.js';
import { state, on } from '../store.js';
import { renderMarkdown } from '../markdown.js';
import { toolLabel, approvalCard, handoffCard, loadProjects, projectSelect, projectLabel } from './common.js';
import { openMenu, assistantName } from '../app.js';

const CHIPS = [
  { ic: 'mail', t: 'Triage my inbox', p: 'Summarise my unread email from the last two days. Flag anything with a deadline and create tasks for those. Draft replies where one is needed (save them as drafts — do not send).' },
  { ic: 'calendar', t: 'Plan my week', p: "What's due this week? Check my calendar for conflicts and suggest study blocks around my classes." },
  { ic: 'projects', t: 'Set up a course', p: 'Help me set up a course. I will paste the syllabus — create the course, its graded items with weights, and tasks for each deadline.' },
  { ic: 'today', t: 'Morning briefing', p: 'Schedule a briefing every Sunday to Thursday at 07:30 with my deadlines, calendar and unread email.' },
];
const OFFLINE_CHIPS = [
  { ic: 'tasks', t: '/task', p: '/task Submit MIS report due fri 17:00' },
  { ic: 'clock', t: '/remind', p: '/remind tomorrow 9am to check Banner registration' },
  { ic: 'memory', t: '/remember', p: '/remember I prefer study blocks in the morning' },
  { ic: 'today', t: '/brief', p: '/brief' },
];

function greeting() {
  const hr = Number(new Intl.DateTimeFormat('en-GB', { timeZone: state.boot?.profile.timezone || 'Asia/Dubai', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  return hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
}

export function mount(container, ctx) {
  const paramId = ctx.params[0];
  const convId = paramId && paramId !== 'new' ? paramId : null;
  const configured = Boolean(state.boot?.integrations.anthropic.configured);
  const NAME = assistantName();
  let data = null;
  const streaming = new Map();
  const offs = [];
  let attachments = [];
  let disposed = false;

  const root = h('div', { class: 'chat' });
  container.append(root);

  // ------------------------------------------------------------ composer -
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: (e) => { addFiles([...e.target.files]); e.target.value = ''; } });
  const textarea = h('textarea', { rows: '1', placeholder: convId ? 'Reply…' : `How can I help you today?`, 'aria-label': 'Message',
    oninput: () => { autosize(); updateSend(); }, onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); primary(); } } });
  const attachRow = h('div', { class: 'attachments' });
  const sendBtn = h('button', { class: 'send', type: 'button', title: 'Send', 'aria-label': 'Send', onclick: () => primary() }, icon('up', 18));
  const composer = h('div', { class: 'composer' }, attachRow, textarea,
    h('div', { class: 'bar' }, h('button', { class: 'icon-btn', type: 'button', title: 'Attach files', 'aria-label': 'Attach files', onclick: () => fileInput.click() }, icon('plus', 18)), h('div', { class: 'grow' }), sendBtn), fileInput);
  const note = h('div', { class: 'composer-note' }, configured
    ? `${NAME} asks before sending, submitting, changing or deleting anything.`
    : h('span', {}, 'Claude isn’t connected yet — /task, /remind, /remember and /brief still work. ', h('a', { href: '#/settings/connections' }, 'Connect')));

  function autosize() { textarea.style.height = 'auto'; textarea.style.height = `${Math.min(textarea.scrollHeight, 260)}px`; }
  const running = () => data?.active_run?.status === 'running';
  function updateSend() {
    if (running()) { sendBtn.className = 'send stop'; sendBtn.title = 'Stop'; sendBtn.setAttribute('aria-label', 'Stop'); clear(sendBtn).append(icon('stop', 14)); sendBtn.disabled = false; return; }
    sendBtn.className = 'send'; sendBtn.title = 'Send'; sendBtn.setAttribute('aria-label', 'Send'); clear(sendBtn).append(icon('up', 18));
    sendBtn.disabled = !textarea.value.trim() && !attachments.some((a) => a.status === 'ready');
  }
  function primary() {
    if (running()) { api.post(`/api/runs/${data.active_run.id}/cancel`).catch(errorToast); return; }
    send();
  }

  function drawAttachments() {
    clear(attachRow);
    for (const a of attachments) {
      attachRow.append(h('span', { class: `chip${a.status === 'error' ? ' err' : ''}`, title: a.error || a.name },
        a.status === 'uploading' ? h('span', { class: 'spinner', style: { width: '12px', height: '12px' } }) : icon(a.status === 'error' ? 'alert' : 'clip', 13),
        h('span', {}, `${a.name}${a.size ? ` · ${fmtSize(a.size)}` : ''}`),
        h('button', { type: 'button', 'aria-label': `Remove ${a.name}`, onclick: () => { attachments = attachments.filter((x) => x !== a); drawAttachments(); updateSend(); } }, icon('x', 12))));
    }
  }

  function addFiles(list) {
    for (const file of list) {
      const a = { name: file.name, size: file.size, status: 'uploading' };
      attachments.push(a);
      api.upload(file, { conversation_id: convId || '' }).then(({ file: f }) => { a.id = f.id; a.status = 'ready'; drawAttachments(); updateSend(); })
        .catch((err) => { a.status = 'error'; a.error = err.message; drawAttachments(); errorToast(err); });
    }
    drawAttachments();
  }

  let sending = false;
  async function send() {
    const text = textarea.value.trim();
    if (sending) return;
    if (attachments.some((a) => a.status === 'uploading')) { toast('Wait for the attachments to finish uploading'); return; }
    const fileIds = attachments.filter((a) => a.status === 'ready').map((a) => a.id);
    if (!text && !fileIds.length) return;
    sending = true; sendBtn.disabled = true;
    try {
      const id = convId || (await api.post('/api/conversations', {})).conversation.id;
      await api.post(`/api/conversations/${id}/messages`, { text, file_ids: fileIds });
      textarea.value = ''; attachments = []; drawAttachments(); autosize();
      if (!convId) { ctx.navigate(`#/chat/${id}`); return; }
      await reload();
    } catch (err) {
      errorToast(err);
    } finally {
      sending = false; updateSend();
    }
  }

  let dragDepth = 0; let overlay = null;
  root.addEventListener('dragenter', (e) => { if (![...e.dataTransfer.types].includes('Files')) return; dragDepth++; if (!overlay) { overlay = h('div', { class: 'drop-overlay' }, 'Drop files to attach'); root.append(overlay); } });
  root.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth && overlay) { overlay.remove(); overlay = null; } });
  root.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  root.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; overlay?.remove(); overlay = null; if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]); });

  // ---------------------------------------------------------------- hero -
  if (!convId) {
    const chips = configured ? CHIPS : OFFLINE_CHIPS;
    root.append(h('div', { class: 'hero' },
      h('div', { class: 'greet' }, h('span', { class: 'mark lg' }, 'D'), h('h1', {}, `${greeting()}, ${state.boot?.profile.name || 'Sultan'}`)),
      composer, note,
      h('div', { class: 'chips' }, chips.map((c) => h('button', { type: 'button', onclick: () => { textarea.value = c.p; autosize(); updateSend(); textarea.focus(); } }, icon(c.ic, 15), c.t)))));
    updateSend();
    setTimeout(() => textarea.focus(), 0);
    return () => { disposed = true; };
  }

  // -------------------------------------------------------------- thread -
  const head = h('div', { class: 'chat-head' });
  const messagesEl = h('div', { class: 'messages', role: 'log', 'aria-live': 'polite' });
  const inner = h('div', { class: 'thread-inner' });
  messagesEl.append(h('div', { class: 'col' }, inner));
  root.append(head, messagesEl, h('div', { class: 'dock' }, composer, note));

  const nearBottom = () => messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 140;
  const toBottom = () => { messagesEl.scrollTop = messagesEl.scrollHeight; };
  const toolMap = () => new Map((data?.tool_calls || []).map((t) => [t.id, t]));

  async function renderHead() {
    clear(head);
    if (!data) return;
    const projects = await loadProjects().catch(() => []);
    const proj = projects.find((p) => p.id === data.conversation.project_id);
    const titleBtn = h('button', { type: 'button', title: 'Chat options', onclick: (e) => openMenu(e.currentTarget, [
      { label: 'Rename', ic: 'edit', onClick: rename },
      { label: proj ? 'Change course' : 'Link to a course', ic: 'projects', onClick: () => linkCourse(projects) },
      '-',
      { label: 'Delete chat', ic: 'trash', onClick: remove },
    ]) }, h('span', {}, data.conversation.title), icon('down', 14));
    head.append(h('div', { class: 'title' }, titleBtn, proj ? h('a', { class: 'course', href: `#/projects/${proj.id}` }, projectLabel(proj)) : null));
  }

  function rename() {
    const input = h('input', { class: 'input', value: data.conversation.title, 'aria-label': 'Title' });
    dialog({ title: 'Rename chat', body: input, actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: async () => {
      try { await api.patch(`/api/conversations/${convId}`, { title: input.value }); await reload(); renderHead(); } catch (e) { errorToast(e); return true; }
    } }] });
  }

  function linkCourse(projects) {
    if (!projects.length) { toast('Add a course first in Courses'); return; }
    const sel = projectSelect(projects, data.conversation.project_id);
    dialog({ title: 'Link to a course', body: h('div', {}, h('p', { class: 'small muted' }, `${NAME} will keep this chat’s work under the course.`), sel), actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: async () => {
      try { await api.patch(`/api/conversations/${convId}`, { project_id: sel.value || null }); await reload(); renderHead(); } catch (e) { errorToast(e); return true; }
    } }] });
  }

  async function remove() {
    if (!(await confirmDialog('Delete chat?', 'The messages in this chat are deleted. Tasks, files and memories created from it are kept.', { confirmLabel: 'Delete', danger: true }))) return;
    try { await api.del(`/api/conversations/${convId}`); ctx.navigate('#/chat'); } catch (err) { errorToast(err); }
  }

  function stepStatus(status, preparing) {
    if (preparing || status === 'running' || status === 'pending') return h('span', { class: 'st' }, h('span', { class: 'spinner', style: { width: '12px', height: '12px' } }));
    if (status === 'succeeded') return h('span', { class: 'st ok', title: 'Done' }, icon('check', 14));
    if (status === 'awaiting_approval' || status === 'waiting_user') return h('span', { class: 'st wait', title: 'Waiting for you' }, icon('clock', 14));
    return h('span', { class: 'st bad', title: status }, icon(status === 'declined' ? 'x' : 'alert', 14));
  }

  function summarize(input) {
    if (!input) return '';
    return input.title || input.subject || input.query || input.message || input.summary || input.url || input.name || (input.content ? String(input.content).slice(0, 80) : '');
  }

  function step(label, sum, status, details, { preparing = false, ic = null } = {}) {
    const wrap = h('div', { class: 'step' });
    const parts = [stepStatus(status, preparing), ic, h('span', { class: 'label' }, label), h('span', { class: 'sum' }, sum)];
    if (!details) { wrap.append(h('div', { class: 'step-head', style: { cursor: 'default' } }, parts)); return wrap; }
    const body = h('div', { class: 'step-body', hidden: true }, details);
    const headEl = h('div', { class: 'step-head', role: 'button', tabindex: '0', 'aria-expanded': 'false',
      onclick: () => { const open = body.hidden; body.hidden = !open; wrap.classList.toggle('open', open); headEl.setAttribute('aria-expanded', String(open)); },
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); headEl.click(); } } },
    parts, h('span', { class: 'chev' }, icon('chevron', 14)));
    wrap.append(headEl, body);
    return wrap;
  }

  function toolStep(item, tc) {
    const status = tc?.status || (item.preparing ? 'running' : 'pending');
    const details = [];
    if (tc?.input && Object.keys(tc.input).length) details.push(h('pre', { class: 'pre code' }, JSON.stringify(tc.input, null, 2)));
    if (tc?.external_ref) details.push(h('div', {}, 'Confirmation: ', h('span', { class: 'mono' }, tc.external_ref)));
    if (tc?.error) details.push(h('div', { style: { color: 'var(--danger)' } }, tc.error));
    if (status === 'unknown') details.push(h('div', { class: 'banner warn small' }, icon('alert'), 'Stopped while this was running. It was not retried — check before asking again.'));
    const label = { awaiting_approval: `${toolLabel(item.name)} — needs your approval`, waiting_user: `${toolLabel(item.name)} — waiting for you`, declined: `${toolLabel(item.name)} — not done`, unknown: `${toolLabel(item.name)} — outcome unknown` }[status] || toolLabel(item.name);
    return step(label, tc?.summary && status === 'succeeded' ? tc.summary : summarize(tc?.input), status, details.length ? details : null, { preparing: item.preparing, ic: toolIcon(item.name) });
  }

  function sources(list) {
    return h('div', { class: 'sources' }, list.map((s) => h('a', { class: 'source', href: s.url, target: '_blank', rel: 'noopener noreferrer', title: s.url }, icon('external', 12), h('span', {}, s.title || s.url))));
  }

  function renderAssistant(m, tcs, isLastAssistant) {
    const local = streaming.get(m.id);
    const items = m.status === 'streaming' && local ? [...local.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v).filter((v) => !(v.type === 'progress' && !v.text.trim())) : (m.items || []);
    const body = h('div', { class: 'body prose' });
    let steps = null;
    const after = [];
    const flushSteps = () => { if (steps) { body.append(steps); steps = null; } for (const a of after.splice(0)) body.append(a); };
    for (const [i, item] of items.entries()) {
      if (item.type === 'tool' || item.type === 'server_tool' || item.type === 'search_results' || item.type === 'fetch_result') {
        if (!steps) steps = h('div', { class: 'steps' });
        if (item.type === 'tool') {
          const tc = tcs.get(item.id);
          steps.append(toolStep(item, tc));
          if (tc?.status === 'awaiting_approval' && tc.approval_id) {
            const slot = h('div', {}, h('div', { class: 'working' }, h('span', { class: 'spinner' }), 'Loading approval…'));
            api.get(`/api/approvals/${tc.approval_id}`).then(({ approval }) => { clear(slot).append(approvalCard(approval, { onDecided: reload })); }).catch(errorToast);
            after.push(slot);
          }
          if (tc?.status === 'waiting_user' && tc.handoff_id) {
            const hd = data.handoffs.find((x) => x.id === tc.handoff_id);
            if (hd?.status === 'waiting') after.push(handoffCard(hd, { onDone: reload }));
          }
        } else if (item.type === 'server_tool') {
          steps.append(step('Searched the web', item.input?.query ? `“${item.input.query}”` : '', 'succeeded', null, { ic: icon('globe', 14) }));
        } else if (item.type === 'search_results') {
          if (item.results?.length) steps.append(h('div', { style: { padding: '2px 0 6px' } }, sources(item.results.slice(0, 6))));
          else steps.append(step('Web search failed', item.error || '', 'failed', null));
        } else if (item.type === 'fetch_result') {
          steps.append(step('Read a page', item.title || item.url || '', item.error ? 'failed' : 'succeeded', null, { ic: icon('globe', 14) }));
        }
        continue;
      }
      flushSteps();
      if (item.type === 'text') {
        const md = renderMarkdown(item.text);
        if (m.status === 'streaming' && i === items.length - 1) md.classList.add('caret');
        body.append(md);
        if (item.citations?.length) body.append(sources(item.citations));
      } else if (item.type === 'progress') {
        body.append(h('div', { class: 'thought' }, item.text));
      } else if (item.type === 'notice') {
        body.append(h('div', { class: 'inline-notice' }, icon('alert', 15), item.text));
      }
    }
    flushSteps();
    if (m.status === 'streaming' && !items.length) body.append(h('div', { class: 'working' }, h('span', { class: 'shimmer' }, `${NAME} is thinking…`)));
    if (m.status === 'interrupted') body.append(h('div', { class: 'thought' }, 'This reply was interrupted before it finished.'));
    if (m.status === 'cancelled') body.append(h('div', { class: 'thought' }, 'Stopped.'));
    const el = h('div', { class: 'msg assistant', dataset: { id: m.id } }, body);
    if (isLastAssistant && m.status === 'complete' && !data?.active_run) el.append(h('div', { class: 'signature' }, h('span', { class: 'mark' }, 'D'), NAME));
    return el;
  }

  function renderMessage(m, tcs, isLastAssistant = false) {
    if (m.kind === 'user') {
      const label = m.synthetic ? (m.synthetic === 'job' ? 'Scheduled run' : m.synthetic === 'resume' ? 'Resume' : 'Task') : null;
      return h('div', { class: 'msg user', dataset: { id: m.id } },
        label ? h('div', { class: 'sys-label' }, label) : null,
        m.attachments?.length ? h('div', { class: 'attachments' }, m.attachments.map((f) => h('a', { class: 'chip', href: f.missing ? null : `#/files/${f.id}` }, icon('clip', 13), h('span', {}, f.name)))) : null,
        m.text ? h('div', { class: 'bubble' }, m.text) : null);
    }
    if (m.kind === 'command' || m.kind === 'notice') {
      return h('div', { class: 'msg assistant', dataset: { id: m.id } },
        h('div', { class: `command-card${m.meta?.ok === false ? ' err' : ''}` }, renderMarkdown(m.text)),
        h('div', { class: 'signature' }, m.kind === 'command' ? `Ran /${m.meta?.command || ''} on this device` : 'Notice'));
    }
    return renderAssistant(m, tcs, isLastAssistant);
  }

  function tail() {
    const run = data.active_run || data.runs[0];
    if (!run) return null;
    if (run.status === 'running') {
      const last = data.messages.at(-1);
      if (last?.kind === 'assistant' && last.status === 'streaming') return null;
      return h('div', { class: 'working' }, h('span', { class: 'spinner' }), h('span', { class: 'shimmer' }, `${NAME} is working…`));
    }
    if (run.status === 'failed' || run.status === 'interrupted') {
      return h('div', { class: 'inline-notice' }, icon('alert', 15), h('div', { class: 'grow' }, run.error || 'The last run did not finish.'),
        btn(run.status === 'interrupted' ? 'Resume' : 'Try again', async () => { try { await api.post(`/api/runs/${run.id}/retry`); reload(); } catch (e) { errorToast(e); } }, { size: 'sm', kind: 'primary' }));
    }
    return null;
  }

  function renderMessages({ keepScroll = false } = {}) {
    const stick = !keepScroll || nearBottom();
    const prevTop = messagesEl.scrollTop;
    clear(inner);
    const tcs = toolMap();
    const lastAssistant = [...data.messages].reverse().find((m) => m.kind === 'assistant')?.id;
    for (const m of data.messages) inner.append(renderMessage(m, tcs, m.id === lastAssistant));
    const t = tail();
    if (t) inner.append(t);
    if (stick) toBottom(); else messagesEl.scrollTop = prevTop;
    updateSend();
  }

  function rerenderMessage(id) {
    const m = data?.messages.find((x) => x.id === id);
    const el = inner.querySelector(`[data-id="${id}"]`);
    if (!m || !el) return;
    const stick = nearBottom();
    el.replaceWith(renderMessage(m, toolMap()));
    if (stick) toBottom();
  }

  const pending = new Set();
  function scheduleRerender(id) {
    if (pending.has(id)) return;
    pending.add(id);
    requestAnimationFrame(() => { pending.delete(id); rerenderMessage(id); });
  }

  async function reload() {
    try {
      const next = await api.get(`/api/conversations/${convId}`);
      if (disposed) return;
      for (const m of next.messages) if (m.status === 'streaming' && !streaming.has(m.id)) streaming.set(m.id, new Map((m.items || []).map((it, i) => [i, it])));
      const firstLoad = !data;
      data = next;
      ctx.setTitle(data.conversation.title);
      renderMessages({ keepScroll: !firstLoad });
      if (firstLoad) renderHead();
    } catch (err) {
      if (err.status === 404) { clear(inner); inner.append(empty('Chat not found', 'It may have been deleted.', btn('New chat', () => ctx.navigate('#/chat'), { kind: 'primary' }))); return; }
      errorToast(err);
    }
  }
  const reloadSoon = debounce(reload, 150);

  const mine = (d) => d && d.conversation_id === convId;
  offs.push(on('run.message', (d) => {
    if (!mine(d) || !data) return;
    if (!data.messages.some((m) => m.id === d.message.id)) {
      data.messages.push(d.message);
      streaming.set(d.message.id, new Map());
      renderMessages({ keepScroll: true });
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
  offs.push(on('run.updated', (d) => { if (d.run?.conversation_id === convId) reloadSoon(); }));
  offs.push(on('approval.updated', (d) => { if (d.approval?.conversation_id === convId) reloadSoon(); }));
  offs.push(on('handoff.updated', () => { if (data?.active_run) reloadSoon(); }));
  offs.push(on('conversation.message', (d) => { if (d.conversation_id === convId) reloadSoon(); }));

  inner.append(loading('Loading…'));
  reload().then(() => { if (ctx.query.get('focus') !== '0') textarea.focus(); });
  updateSend();
  return () => { disposed = true; offs.forEach((f) => f()); };
}

