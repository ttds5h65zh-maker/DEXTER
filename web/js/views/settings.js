// Settings: profile, model, integrations, notifications, permissions.
import { h, clear, btn, fmtAgo, errorToast, toast, loading, confirmDialog } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { state, loadBoot } from '../store.js';

const SECTIONS = [['profile', 'Profile'], ['model', 'Model'], ['integrations', 'Integrations'], ['notifications', 'Notifications'], ['permissions', 'Permissions'], ['about', 'About']];
const TIMEZONES = ['Asia/Dubai', 'Asia/Riyadh', 'Asia/Qatar', 'Europe/London', 'America/New_York', 'UTC'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function mount(container, ctx) {
  const section = SECTIONS.some(([k]) => k === ctx.params[0]) ? ctx.params[0] : 'profile';
  const page = h('div', { class: 'page narrow' });
  container.append(page);
  page.append(h('div', { class: 'tabs', role: 'tablist' }, SECTIONS.map(([k, l]) => h('a', { href: `#/settings/${k}`, class: k === section ? 'on' : '', role: 'tab', 'aria-selected': String(k === section) }, l))));
  const body = h('div', { class: 'stack' });
  page.append(body);
  body.append(loading());
  const msg = ctx.query.get('google_error');
  if (ctx.query.get('google') === 'connected') toast('Google connected');
  (async () => {
    let s; let integ;
    try { [s, integ] = await Promise.all([api.get('/api/settings'), api.get('/api/integrations')]); } catch (err) { clear(body); body.append(h('div', { class: 'banner danger' }, err.message)); return; }
    clear(body);
    if (msg) body.append(h('div', { class: 'banner danger' }, icon('alert'), h('div', {}, h('b', {}, 'Google connection failed: '), msg)));
    const render = { profile, model, integrations, notifications, permissions, about }[section];
    render(body, s.settings, integ, s.model_options, ctx);
  })();
}

async function save(patch, okMsg = 'Saved') {
  try { const r = await api.patch('/api/settings', patch); toast(okMsg); loadBoot().catch(() => {}); return r.settings; } catch (err) { errorToast(err); return null; }
}

function section(title, desc, ...children) {
  return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, title), desc ? h('div', { class: 'sub' }, desc) : null)), h('div', { class: 'card-body' }, children));
}

function field(label, control, hint) {
  return h('div', { class: 'field' }, h('label', {}, label), control, hint ? h('div', { class: 'hint' }, hint) : null);
}

function toggle(label, desc, checked, onChange) {
  const input = h('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) });
  return h('label', { class: 'switch' }, input, h('div', {}, h('div', { class: 't' }, label), desc ? h('div', { class: 'd' }, desc) : null));
}

function profile(body, s) {
  const p = s.profile;
  const f = {
    name: h('input', { class: 'input', value: p.name }), location: h('input', { class: 'input', value: p.location }),
    university: h('input', { class: 'input', value: p.university }), program: h('input', { class: 'input', value: p.program }),
    timezone: h('select', { class: 'select' }, [...new Set([p.timezone, ...TIMEZONES])].map((t) => h('option', { value: t }, t))),
    about: h('textarea', { class: 'textarea', value: p.about, placeholder: 'Anything Dexter should always know: year of study, goals, working style…' }),
  };
  f.timezone.value = p.timezone;
  body.append(section('Profile', 'Dexter uses this in every conversation.',
    h('div', { class: 'grid-2' }, field('Name', f.name), field('Location', f.location)),
    field('University', f.university), field('Program', f.program),
    field('Timezone', f.timezone, 'All schedules, reminders and deadlines are shown and interpreted in this timezone.'),
    field('About you', f.about),
    btn('Save profile', () => save({ profile: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.value])) }), { kind: 'primary' })));
}

function model(body, s, integ, options) {
  const m = s.model;
  const a = integ.anthropic;
  const sel = h('select', { class: 'select' }, options.map((o) => h('option', { value: o.id }, `${o.label} — ${o.note}`)));
  if (!options.some((o) => o.id === m.id)) sel.append(h('option', { value: m.id }, m.id));
  sel.value = m.id;
  const effort = h('select', { class: 'select' }, ['low', 'medium', 'high', 'xhigh', 'max'].map((e) => h('option', { value: e }, e)));
  effort.value = m.effort;
  const maxTok = h('input', { class: 'input', type: 'number', value: m.max_tokens, min: '1024', max: '128000', step: '1024' });
  const result = h('div', { class: 'small', style: { marginTop: '8px' } });
  body.append(
    section('Claude connection', 'The API key stays on the server and is never sent to the browser.',
      a.configured
        ? h('div', { class: 'banner info' }, icon('check'), h('div', {}, h('b', {}, 'API key configured. '), 'Test the connection to confirm the key works for the selected model.'))
        : h('div', { class: 'banner warn' }, icon('alert'), h('div', {}, h('b', {}, 'Not connected. '), a.setup, h('div', { class: 'mono tiny', style: { marginTop: '6px' } }, 'ANTHROPIC_API_KEY=sk-ant-…'))),
      h('div', { style: { marginTop: '12px' } }, btn('Test connection', async () => { result.textContent = 'Testing…'; try { const r = await api.post('/api/integrations/anthropic/test'); result.textContent = r.message; result.style.color = r.ok ? 'var(--s-completed)' : 'var(--danger)'; } catch (err) { result.textContent = err.message; } }, { ic: 'refresh' }), result)),
    section('Model configuration', 'Applies to new turns. Thinking is adaptive; effort controls depth, latency and cost.',
      field('Model', sel),
      h('div', { class: 'grid-2' }, field('Effort', effort, 'medium is a good default; high for complex multi-step work.'), field('Max output tokens', maxTok)),
      toggle('Web search', 'Lets Dexter search the web (Claude’s server-side web search) and cite sources. Must be enabled for your Anthropic organisation.', m.web_search, (v) => save({ model: { web_search: v } })),
      h('div', { style: { marginTop: '12px' } }, btn('Save model settings', () => save({ model: { id: sel.value, effort: effort.value, max_tokens: Number(maxTok.value) } }), { kind: 'primary' }))));
}

function integrations(body, s, integ) {
  const g = integ.google;
  const b = integ.browser;
  const googleBody = [];
  if (!g.configured) {
    googleBody.push(h('div', { class: 'banner warn' }, icon('alert'), h('div', {}, h('b', {}, 'Not set up. '), g.setup)),
      h('ol', { class: 'small', style: { margin: '12px 0 0', paddingLeft: '20px' } },
        h('li', {}, 'Google Cloud Console → create a project → enable “Gmail API” and “Google Calendar API”.'),
        h('li', {}, 'OAuth consent screen → External/testing → add your Google account as a test user.'),
        h('li', {}, 'Credentials → Create OAuth client ID → Web application → Authorised redirect URI:'),
        h('li', { style: { listStyle: 'none' } }, h('code', {}, g.redirect_uri)),
        h('li', {}, 'Put GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env and restart Dexter.')));
  } else if (!g.connected) {
    googleBody.push(h('p', { class: 'small' }, 'Dexter will ask Google for: read Gmail, create drafts and send (only after your approval), and read/change calendar events (changes only after approval).'),
      h('a', { class: 'btn primary', href: '/api/integrations/google/connect' }, icon('link', 16), 'Connect Google'));
    if (g.error) googleBody.push(h('div', { class: 'banner danger small', style: { marginTop: '10px' } }, g.error));
  } else {
    googleBody.push(h('div', { class: 'banner info' }, icon('check'), h('div', {}, h('b', {}, `Connected as ${g.email || 'your account'}`), ` · since ${fmtAgo(g.connected_at)}`)),
      h('div', { class: 'tiny muted', style: { margin: '8px 0' } }, `Scopes: ${g.scopes.join(', ')}`),
      g.error ? h('div', { class: 'banner danger small' }, g.error) : null,
      btn('Disconnect', async () => { if (await confirmDialog('Disconnect Google?', 'Dexter will revoke its access token and stop reading Gmail and Calendar.', { confirmLabel: 'Disconnect', danger: true })) { try { await api.post('/api/integrations/google/disconnect'); toast('Disconnected'); location.reload(); } catch (e) { errorToast(e); } } }, { kind: 'danger' }));
  }
  const ilearn = h('input', { class: 'input', value: s.integrations.ilearn_url, placeholder: 'https://ilearn.aus.edu' });
  const banner = h('input', { class: 'input', value: s.integrations.banner_url, placeholder: 'Your Banner Self-Service URL' });
  body.append(
    section('Gmail & Google Calendar', 'Read and summarise email, prepare replies, check conflicts and propose changes.', googleBody),
    section('iLearn & Banner (visible browser)', 'AUS does not offer student APIs for these, so Dexter uses a browser window you can see. Sign-in and MFA are always handed to you.',
      b.installed
        ? h('div', { class: `banner ${b.headless ? 'warn' : 'info'}` }, icon(b.headless ? 'alert' : 'check'), h('div', {}, b.headless ? h('span', {}, h('b', {}, 'Browser available, but running without a window here. '), 'Sign-in hand-off needs Dexter running on your computer with a display (or DEXTER_BROWSER_HEADLESS=0).') : h('span', {}, h('b', {}, 'Browser workflow available. '), b.open ? `Open at ${b.url}` : 'A window opens when Dexter needs a site.')))
        : h('div', { class: 'banner warn' }, icon('alert'), h('div', {}, h('b', {}, 'Not installed. '), b.setup)),
      h('div', { style: { marginTop: '12px' } }, field('iLearn URL', ilearn), field('Banner Self-Service URL', banner, 'Use the address you normally open for registration, schedule and grades.')),
      h('div', { class: 'btn-row' }, btn('Save addresses', () => save({ integrations: { ilearn_url: ilearn.value.trim(), banner_url: banner.value.trim() } }), { kind: 'primary' }),
        b.open ? btn('Close browser', async () => { await api.post('/api/integrations/browser/close').catch(errorToast); toast('Browser closed'); }) : null)),
    section('Web research', null, h('div', { class: 'small' }, integ.web_search.enabled ? `On — ${integ.web_search.provider}. ${integ.web_search.requires}` : 'Off — turn it on under Model.')));
}

function notifications(body, s) {
  const n = s.notifications;
  const ntfy = h('input', { class: 'input', value: n.ntfy_url, placeholder: 'https://ntfy.sh/your-private-topic' });
  const qsStart = h('input', { class: 'input', type: 'time', value: n.quiet_hours.start });
  const qsEnd = h('input', { class: 'input', type: 'time', value: n.quiet_hours.end });
  const bTime = h('input', { class: 'input', type: 'time', value: n.daily_briefing.time });
  const dayBoxes = DAYS.map((d) => { const c = h('input', { type: 'checkbox', checked: n.daily_briefing.days.includes(d) }); c.dataset.day = d; return c; });
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  body.append(
    section('In-app & desktop', 'In-app notifications are always on. Desktop notifications appear when Dexter is open in a background tab.',
      toggle('Desktop notifications', null, n.desktop, (v) => save({ notifications: { desktop: v } })),
      perm !== 'granted' && perm !== 'unsupported' ? btn('Allow notifications in this browser', async () => { const r = await Notification.requestPermission(); toast(r === 'granted' ? 'Desktop notifications allowed' : 'Permission not granted'); }, { size: 'sm' }) : h('div', { class: 'tiny muted' }, `Browser permission: ${perm}`)),
    section('Phone push (optional)', 'Dexter can POST notifications to an ntfy-compatible URL so they reach your phone. Use a long, private topic name.',
      field('Push URL', ntfy),
      h('div', { class: 'btn-row' }, btn('Save', () => save({ notifications: { ntfy_url: ntfy.value.trim() } }), { kind: 'primary' }),
        btn('Send test', async () => { try { const r = await api.post('/api/integrations/push/test'); toast(`Push ${r.result}`); } catch (e) { errorToast(e); } }))),
    section('Quiet hours', 'Push notifications are held during quiet hours (in-app ones still appear).',
      toggle('Enable quiet hours', null, n.quiet_hours.enabled, (v) => save({ notifications: { quiet_hours: { enabled: v } } })),
      h('div', { class: 'grid-2', style: { marginTop: '10px' } }, field('From', qsStart), field('Until', qsEnd)),
      btn('Save quiet hours', () => save({ notifications: { quiet_hours: { start: qsStart.value, end: qsEnd.value } } }))),
    section('Daily briefing', `Deadlines, schedule, approvals and — when connected — calendar and unread email, delivered at this time (${s.profile.timezone}).`,
      toggle('Send a daily briefing', null, n.daily_briefing.enabled, (v) => save({ notifications: { daily_briefing: { enabled: v } } }, v ? 'Daily briefing scheduled' : 'Daily briefing paused')),
      h('div', { class: 'grid-2', style: { marginTop: '10px' } }, field('Time', bTime), h('div', { class: 'field' }, h('label', {}, 'Days'), h('div', { class: 'btn-row' }, dayBoxes.map((c) => h('label', { class: 'small', style: { display: 'flex', gap: '4px', alignItems: 'center' } }, c, c.dataset.day))))),
      btn('Save briefing schedule', () => save({ notifications: { daily_briefing: { time: bTime.value, days: dayBoxes.filter((c) => c.checked).map((c) => c.dataset.day) } } }))));
}

function permissions(body, s) {
  const p = s.permissions;
  const set = (k) => (v) => save({ permissions: { [k]: v } });
  body.append(
    section('What Dexter may do without asking', 'Reading, organising and preparing drafts. Turn any of these off to block the related tools.',
      toggle('Read email', 'Search and read Gmail messages to summarise them and find deadlines.', p.read_email, set('read_email')),
      toggle('Read calendar', 'List events and check conflicts. Changes still need approval.', p.read_calendar, set('read_calendar')),
      toggle('Create Gmail drafts', 'Save draft replies in Gmail without sending them.', p.create_drafts, set('create_drafts')),
      toggle('Save memories', 'Remember preferences and context from conversations.', p.save_memories, set('save_memories')),
      toggle('Web research', 'Search the web and read public pages.', p.web_research, set('web_research')),
      toggle('Read sites in the browser', 'Open iLearn, Banner and other sites in the visible browser and read pages.', p.browser_read, set('browser_read'))),
    section('Always requires your approval', null,
      h('ul', { class: 'small', style: { margin: '0', paddingLeft: '18px' } },
        h('li', {}, 'Sending email'), h('li', {}, 'Creating, changing or deleting calendar events'), h('li', {}, 'Submitting forms or clicking buttons on sites (iLearn, Banner…)'),
        h('li', {}, 'Deleting memories'), h('li', {}, 'Anything that publishes or purchases')),
      h('p', { class: 'small muted', style: { marginTop: '10px' } }, 'Standing authorizations you grant from an approval are listed on the ', h('a', { href: '#/approvals' }, 'Approvals'), ' page, where you can revoke them.')));
}

function about(body) {
  body.append(section('About Dexter', null,
    h('p', { class: 'small' }, 'Dexter runs on your machine. Data lives in the server’s data folder (SQLite database and uploaded files); secrets stay in .env and encrypted tokens never reach the browser.'),
    h('p', { class: 'small' }, 'Keyboard: Ctrl+K search · Alt+1–8 sections · Alt+N new chat · / focus composer · ? shortcuts.'),
    h('p', { class: 'small muted' }, `Signed in for ${state.boot?.profile.name}. Times in ${state.boot?.profile.timezone}.`)));
}
