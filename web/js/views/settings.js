// Settings: General, Connections, Notifications, Privacy, Memory.
import { h, clear, btn, fmtAgo, errorToast, toast, loading, confirmDialog } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { loadBoot } from '../store.js';
import * as memoryView from './memory.js';

const SECTIONS = [['general', 'General'], ['connections', 'Connections'], ['notifications', 'Notifications'], ['privacy', 'Privacy'], ['memory', 'Memory']];
const ALIASES = { profile: 'general', model: 'connections', integrations: 'connections', permissions: 'privacy', about: 'general' };
const TIMEZONES = ['Asia/Dubai', 'Asia/Riyadh', 'Asia/Qatar', 'Europe/London', 'America/New_York', 'UTC'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function mount(container, ctx) {
  const wanted = ALIASES[ctx.params[0]] || ctx.params[0];
  const section = SECTIONS.some(([k]) => k === wanted) ? wanted : 'general';
  const page = h('div', { class: 'page narrow' });
  container.append(page);
  page.append(h('div', { class: 'page-head' }, h('h1', {}, 'Settings')),
    h('div', { class: 'tabs', role: 'tablist' }, SECTIONS.map(([k, l]) => h('a', { href: `#/settings/${k}`, class: k === section ? 'on' : '', role: 'tab', 'aria-selected': String(k === section) }, l))));
  const body = h('div', { class: 'stack' });
  page.append(body);
  if (section === 'memory') return memoryView.mount(body, ctx, { embedded: true });
  body.append(loading());
  if (ctx.query.get('google') === 'connected') toast('Google connected');
  const gErr = ctx.query.get('google_error');
  (async () => {
    let s; let integ;
    try { [s, integ] = await Promise.all([api.get('/api/settings'), api.get('/api/integrations')]); } catch (err) { clear(body); body.append(h('div', { class: 'banner danger' }, err.message)); return; }
    clear(body);
    if (gErr) body.append(h('div', { class: 'banner danger' }, icon('alert'), h('div', {}, h('b', {}, 'Google didn’t connect: '), gErr)));
    ({ general, connections, notifications, privacy })[section](body, s.settings, integ, s.model_options);
  })();
}

async function save(patch, okMsg = 'Saved') {
  try { const r = await api.patch('/api/settings', patch); toast(okMsg); loadBoot().catch(() => {}); return r.settings; } catch (err) { errorToast(err); return null; }
}

const group = (title, desc, ...children) => h('section', { class: 'card card-pad' }, h('h2', { style: { marginBottom: desc ? '2px' : '12px' } }, title), desc ? h('p', { class: 'small muted', style: { marginBottom: '14px' } }, desc) : null, children);
const field = (label, control, hint) => h('div', { class: 'field' }, h('label', {}, label), control, hint ? h('div', { class: 'hint' }, hint) : null);
function toggle(label, desc, checked, onChange) {
  return h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) }), h('div', {}, h('div', { class: 't' }, label), desc ? h('div', { class: 'd' }, desc) : null));
}
const status = (ok, text) => h('div', { class: 'small', style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' } }, h('span', { class: `dot ${ok ? 'ok' : 'warn'}` }), text);

function general(body, s) {
  const p = s.profile;
  const f = {
    assistant_name: h('input', { class: 'input', value: p.assistant_name }),
    name: h('input', { class: 'input', value: p.name }),
    location: h('input', { class: 'input', value: p.location }),
    university: h('input', { class: 'input', value: p.university }),
    program: h('input', { class: 'input', value: p.program }),
    timezone: h('select', { class: 'select' }, [...new Set([p.timezone, ...TIMEZONES])].map((t) => h('option', { value: t }, t))),
    about: h('textarea', { class: 'textarea', value: p.about, placeholder: 'Year of study, goals, how you like to work…' }),
  };
  f.timezone.value = p.timezone;
  body.append(group('You and your assistant', null,
    h('div', { class: 'grid-2' }, field('Assistant name', f.assistant_name), field('Your name', f.name)),
    field('University', f.university), field('Program', f.program),
    h('div', { class: 'grid-2' }, field('Location', f.location), field('Timezone', f.timezone, 'Used for every time and deadline.'))),
  group('Anything else to know', 'Always included in conversations.', f.about),
  h('div', {}, btn('Save', async () => { await save({ profile: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.value])) }); }, { kind: 'primary' })));
}

function connections(body, s, integ, options) {
  const a = integ.anthropic; const g = integ.google; const b = integ.browser; const m = s.model;
  const sel = h('select', { class: 'select' }, options.map((o) => h('option', { value: o.id }, o.id === 'claude-opus-5-5' ? `${o.label} (recommended)` : o.label)));
  if (!options.some((o) => o.id === m.id)) sel.append(h('option', { value: m.id }, m.id));
  sel.value = m.id;
  const effort = h('select', { class: 'select' }, [['low', 'Quick'], ['medium', 'Balanced'], ['high', 'Thorough'], ['xhigh', 'Very thorough'], ['max', 'Maximum']].map(([v, l]) => h('option', { value: v }, l)));
  effort.value = m.effort;
  const maxTok = h('input', { class: 'input', type: 'number', value: m.max_tokens, min: '1024', max: '128000', step: '1024' });
  const result = h('div', { class: 'small', style: { marginTop: '8px' } });
  body.append(group('Claude', 'Powers the conversation. The key stays on the server.',
    status(a.configured, a.configured ? 'API key configured' : 'Not connected'),
    a.configured ? null : h('div', { class: 'banner warn small', style: { marginBottom: '12px' } }, h('div', {}, a.setup, h('div', { class: 'mono', style: { marginTop: '6px' } }, 'ANTHROPIC_API_KEY=sk-ant-…'))),
    h('div', { class: 'grid-2' }, field('Model', sel), field('Depth', effort)),
    toggle('Web search', 'Search the web and cite sources (must be enabled for your Anthropic organisation).', m.web_search, (v) => save({ model: { web_search: v } })),
    h('details', { style: { margin: '10px 0' } }, h('summary', { class: 'small muted', style: { cursor: 'pointer' } }, 'Advanced'), h('div', { style: { marginTop: '10px' } }, field('Max output tokens', maxTok))),
    h('div', { class: 'btn-row' }, btn('Save', () => save({ model: { id: sel.value, effort: effort.value, max_tokens: Number(maxTok.value) } }), { kind: 'primary' }),
      btn('Test connection', async () => { result.textContent = 'Testing…'; try { const r = await api.post('/api/integrations/anthropic/test'); result.textContent = r.message; result.style.color = r.ok ? 'var(--s-completed)' : 'var(--danger)'; } catch (err) { result.textContent = err.message; } })),
    result));

  const gBody = [];
  if (!g.configured) {
    gBody.push(status(false, 'Not set up'), h('ol', { class: 'small', style: { margin: '0', paddingLeft: '20px', color: 'var(--text-2)' } },
      h('li', {}, 'In Google Cloud Console, enable the Gmail API and Google Calendar API.'),
      h('li', {}, 'Create an OAuth client (Web application) with this redirect URI: ', h('code', {}, g.redirect_uri)),
      h('li', {}, 'Put GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env and restart.')));
  } else if (!g.connected) {
    gBody.push(status(false, 'Not connected'), h('a', { class: 'btn primary', href: '/api/integrations/google/connect' }, 'Connect Google'));
    if (g.error) gBody.push(h('div', { class: 'banner danger small', style: { marginTop: '10px' } }, g.error));
  } else {
    gBody.push(status(true, `Connected as ${g.email || 'your account'} · since ${fmtAgo(g.connected_at)}`), g.error ? h('div', { class: 'banner danger small', style: { marginBottom: '10px' } }, g.error) : null,
      btn('Disconnect', async () => { if (await confirmDialog('Disconnect Google?', 'Gmail and Calendar access will be revoked.', { confirmLabel: 'Disconnect', danger: true })) { try { await api.post('/api/integrations/google/disconnect'); location.reload(); } catch (e) { errorToast(e); } } }));
  }
  body.append(group('Gmail & Calendar', 'Read and summarise email, prepare replies, check your calendar. Sending and changes always ask first.', gBody));

  const ilearn = h('input', { class: 'input', value: s.integrations.ilearn_url, placeholder: 'https://ilearn.aus.edu' });
  const banner = h('input', { class: 'input', value: s.integrations.banner_url, placeholder: 'Banner Self-Service address' });
  body.append(group('iLearn & Banner', 'Opened in a browser window you can see. You always sign in yourself.',
    status(b.installed && !b.headless, b.installed ? (b.headless ? 'Browser available, but without a window on this machine — sign-in can’t be handed to you' : 'Ready') : 'Needs Playwright: npm install playwright && npx playwright install chromium'),
    h('div', { class: 'grid-2' }, field('iLearn', ilearn), field('Banner', banner)),
    btn('Save', () => save({ integrations: { ilearn_url: ilearn.value.trim(), banner_url: banner.value.trim() } }), { kind: 'primary' })));
}

function notifications(body, s) {
  const n = s.notifications;
  const bTime = h('input', { class: 'input', type: 'time', value: n.daily_briefing.time });
  const dayBoxes = DAYS.map((d) => { const c = h('input', { type: 'checkbox', checked: n.daily_briefing.days.includes(d) }); c.dataset.day = d; return c; });
  const ntfy = h('input', { class: 'input', value: n.ntfy_url, placeholder: 'https://ntfy.sh/a-long-private-topic' });
  const qsStart = h('input', { class: 'input', type: 'time', value: n.quiet_hours.start });
  const qsEnd = h('input', { class: 'input', type: 'time', value: n.quiet_hours.end });
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  body.append(
    group('Daily briefing', `Your deadlines, calendar and unread email in one message (${s.profile.timezone}).`,
      toggle('Send me a daily briefing', null, n.daily_briefing.enabled, (v) => save({ notifications: { daily_briefing: { enabled: v } } }, v ? 'Briefing scheduled' : 'Briefing paused')),
      h('div', { class: 'grid-2', style: { marginTop: '12px' } }, field('Time', bTime), h('div', { class: 'field' }, h('label', {}, 'Days'), h('div', { class: 'btn-row' }, dayBoxes.map((c) => h('label', { class: 'small', style: { display: 'flex', gap: '4px', alignItems: 'center' } }, c, c.dataset.day))))),
      btn('Save', () => save({ notifications: { daily_briefing: { time: bTime.value, days: dayBoxes.filter((c) => c.checked).map((c) => c.dataset.day) } } }))),
    group('On this computer', null,
      toggle('Desktop notifications', 'When the tab is in the background.', n.desktop, (v) => save({ notifications: { desktop: v } })),
      perm !== 'granted' && perm !== 'unsupported' ? btn('Allow in this browser', async () => { const r = await Notification.requestPermission(); toast(r === 'granted' ? 'Allowed' : 'Not allowed'); }, { size: 'sm' }) : null),
    group('On your phone', 'Optional: send alerts to an ntfy-compatible address.',
      field('Push address', ntfy),
      h('div', { class: 'btn-row' }, btn('Save', () => save({ notifications: { ntfy_url: ntfy.value.trim() } }), { kind: 'primary' }), btn('Send a test', async () => { try { const r = await api.post('/api/integrations/push/test'); toast(`Push ${r.result}`); } catch (e) { errorToast(e); } })),
      h('div', { class: 'divider', style: { height: '1px', background: 'var(--border)', margin: '16px 0' } }),
      toggle('Quiet hours', 'Hold phone alerts overnight.', n.quiet_hours.enabled, (v) => save({ notifications: { quiet_hours: { enabled: v } } })),
      h('div', { class: 'grid-2', style: { marginTop: '10px' } }, field('From', qsStart), field('Until', qsEnd)),
      btn('Save quiet hours', () => save({ notifications: { quiet_hours: { start: qsStart.value, end: qsEnd.value } } }))));
}

async function privacy(body, s) {
  const p = s.permissions;
  const set = (k) => (v) => save({ permissions: { [k]: v } });
  const grantsEl = h('div');
  body.append(
    group('Without asking', 'Reading, organising and preparing drafts.',
      toggle('Read my email', null, p.read_email, set('read_email')),
      toggle('Read my calendar', null, p.read_calendar, set('read_calendar')),
      toggle('Save Gmail drafts', 'Drafts are never sent without approval.', p.create_drafts, set('create_drafts')),
      toggle('Remember things from our chats', null, p.save_memories, set('save_memories')),
      toggle('Search and read the web', null, p.web_research, set('web_research')),
      toggle('Read iLearn, Banner and other sites', null, p.browser_read, set('browser_read'))),
    group('Always asks first', 'Sending email · changing or deleting calendar events · submitting forms or clicking buttons on sites · deleting memories. Anything found inside emails or web pages never counts as your permission.'),
    group('Things you said not to ask about again', null, grantsEl));
  try {
    const { grants } = await api.get('/api/grants');
    if (!grants.length) grantsEl.append(h('div', { class: 'quiet-empty' }, 'None.'));
    for (const g of grants) grantsEl.append(h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 't small' }, g.description), h('div', { class: 'tiny muted' }, `Used ${g.uses} time(s)`)),
      btn('Revoke', async () => { await api.del(`/api/grants/${g.id}`).catch(errorToast); toast('Revoked'); location.reload(); }, { size: 'sm' })));
  } catch (err) { errorToast(err); }
}
