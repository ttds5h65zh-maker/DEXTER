import { html, render, useState, useEffect, app, bus, GET, POST, api, refresh, useVersion, useLoad, toast, go, F, useForm, useAction, icon, ICONS, money, fmtDate, rel, openItem } from './lib.js';
import { Dashboard } from './dashboard.js';
import { CalendarPage, GroupPage, EntityList, EntityPage, FinancePage, RecordsPage } from './pages.js';
import { ItemDrawer, NewEntry } from './item.js';
import { InboxPage } from './inbox.js';
import { SettingsPage } from './settings.js';

function Auth({ setup, onDone }) {
  const [v, bind, set] = useForm({ name: '', email: '', password: '', demo: true });
  const act = useAction();
  const submit = (e) => { e.preventDefault(); act.run(async () => onDone(await POST(setup ? '/api/setup' : '/api/login', v))); };
  return html`<div class="auth"><form class="card stack" onSubmit=${submit}>
    <div><div class="brand" style="padding:0 0 14px;color:var(--ink)"><i>D</i>Dexter Payments</div>
      <h1>${setup ? 'Set up your workspace' : 'Sign in'}</h1><p>${setup ? 'Create the owner account. You can add your accountant afterwards under Settings.' : 'Private workspace for the owner and their accountant.'}</p></div>
    ${act.error ? html`<div class="err">${act.error.message}</div>` : ''}
    ${setup ? html`<${F} label="Your name"><input type="text" required autocomplete="name" ...${bind('name')} /><//>` : ''}
    <${F} label="Email"><input type="email" required autocomplete="username" ...${bind('email')} /><//>
    <${F} label="Password" hint=${setup ? 'At least 10 characters' : ''}><input type="password" required autocomplete=${setup ? 'new-password' : 'current-password'} ...${bind('password')} /><//>
    ${setup ? html`<label class="check"><input type="checkbox" checked=${v.demo} onChange=${(e) => set((s) => ({ ...s, demo: e.target.checked }))} /><span>Start with a fictional demo (a utility bill, car loan with balloon payment, property invoices, card statement, overdue receivable) so you can try everything before uploading real records. You can clear it in one click.</span></label>` : ''}
    <button class="btn primary" disabled=${act.busy} style="padding:10px">${act.busy ? 'Please wait…' : setup ? 'Create workspace' : 'Sign in'}</button></form></div>`;
}

function Bell() {
  const st = useLoad('/api/reminders');
  const [open, setOpen] = useState(false);
  const list = st.data?.reminders || [];
  const dismiss = async (r) => { await POST('/api/reminders/dismiss', { key: r.key }); refresh(); };
  return html`<div style="position:relative"><button class="btn" aria-label="Reminders" onClick=${() => setOpen(!open)}>${icon(ICONS.bell)}<span style="margin-left:6px">${list.length}</span></button>
    ${open ? html`<div class="panel" style="position:absolute;right:0;top:42px;width:min(380px,92vw);z-index:30;max-height:70vh;overflow:auto"><header style="padding-bottom:10px"><h2>Reminders</h2><a href="#/settings" onClick=${() => setOpen(false)}>Change days</a></header>
      ${list.map((r) => html`<div class="row" style="padding:9px 14px;border-top:1px solid var(--line);align-items:flex-start"><div style="flex:1;min-width:0;cursor:pointer" onClick=${() => { setOpen(false); openItem(r.item_id); }}>
          <b class=${r.overdue ? 'red' : ''}>${r.direction === 'in' ? 'To receive' : 'To pay'}: ${r.title}</b><div class="small muted">${money(r.outstanding, r.currency)} · ${rel(r.days_until)} · ${fmtDate(r.due_date)}${r.amount_status !== 'confirmed' ? ' · not confirmed' : ''}</div></div>
        <button class="btn sm ghost" title="Hide until the next reminder day" onClick=${() => dismiss(r)}>Dismiss</button></div>`)}
      ${!list.length ? html`<div class="empty">No reminders right now.</div>` : ''}</div>` : ''}</div>`;
}

const NAV = [
  ['#/', 'Dashboard', 'home'], ['#/calendar', 'Calendar', 'cal'], ['h', 'Groups'],
  ['#/household', 'Household & family', 'house'], ['#/vehicles', 'Vehicles', 'car'], ['#/properties', 'Properties', 'building'], ['#/finance', 'Loans & cards', 'card'], ['#/business', 'Business', 'brief'],
  ['h', 'Records'], ['#/inbox', 'Import Inbox', 'inbox'], ['#/records', 'All records', 'list'], ['#/settings', 'Settings', 'gear'],
];

function Shell({ onSignOut }) {
  useVersion();
  const [hash, setHash] = useState(location.hash || '#/');
  const [item, setItem] = useState(null);
  const [neu, setNeu] = useState(null);
  const [toastMsg, setToast] = useState(null);
  const inbox = useLoad('/api/inbox');
  useEffect(() => {
    const h = () => { setHash(location.hash || '#/'); scrollTo(0, 0); };
    const i = (e) => setItem(e.detail), n = (e) => setNeu(e.detail || {});
    let timer; const t = (e) => { setToast(e.detail); clearTimeout(timer); timer = setTimeout(() => setToast(null), e.detail.bad ? 6000 : 3500); };
    const lo = () => logout();
    addEventListener('hashchange', h); bus.addEventListener('item', i); bus.addEventListener('new', n); bus.addEventListener('toast', t); bus.addEventListener('logout', lo); bus.addEventListener('signed-out', onSignOut);
    return () => { removeEventListener('hashchange', h); bus.removeEventListener('item', i); bus.removeEventListener('new', n); bus.removeEventListener('toast', t); bus.removeEventListener('logout', lo); bus.removeEventListener('signed-out', onSignOut); };
  }, []);
  const logout = async () => { await POST('/api/logout'); onSignOut(); };
  const [path, qs] = hash.slice(1).split('?');
  const seg = path.split('/').filter(Boolean);
  const u = app.boot.user;
  const pending = inbox.data ? inbox.data.imports.filter((x) => x.status === 'review').length + inbox.data.unmatched_txns + inbox.data.needs_review.length : 0;
  const snap = async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    toast('Reading the receipt…');
    try { await api('POST', '/api/imports/document', f); refresh(); go('#/inbox/paper'); toast('Receipt uploaded — check the fields'); } catch (err) { toast(err.message, true); }
  };
  let page;
  switch (seg[0]) {
    case undefined: page = html`<${Dashboard} />`; break;
    case 'calendar': page = html`<${CalendarPage} />`; break;
    case 'household': page = html`<${GroupPage} key="hh" groups=${['household', 'family']} title="Household & family" sub="Utilities, internet, staff salaries, school fees, family expenses, subscriptions and annual renewals." />`; break;
    case 'business': page = html`<${GroupPage} key="biz" groups=${['business']} title="Business" sub="Supplier invoices, contractor payments, recurring expenses, and the invoices and reimbursements owed to you." />`; break;
    case 'vehicles': page = seg[1] ? html`<${EntityPage} key=${seg[1]} id=${seg[1]} />` : html`<${EntityList} key="v" kind="vehicle" />`; break;
    case 'properties': page = seg[1] ? html`<${EntityPage} key=${seg[1]} id=${seg[1]} />` : html`<${EntityList} key="p" kind="property" />`; break;
    case 'finance': page = html`<${FinancePage} />`; break;
    case 'inbox': page = html`<${InboxPage} tab=${seg[1] || 'paper'} />`; break;
    case 'records': page = html`<${RecordsPage} key=${qs || ''} query=${new URLSearchParams(qs || '')} />`; break;
    case 'settings': page = html`<${SettingsPage} />`; break;
    default: page = html`<p>Page not found. <a href="#/">Back to the dashboard</a></p>`;
  }
  const on = (href) => (href === '#/' ? !seg[0] : `#/${seg[0]}` === href);
  return html`<div class="shell">
    <aside class="side"><div class="brand"><i>D</i>${app.boot.settings.workspace_name}</div>
      <div class="who"><div class="avatar">${u.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()}</div><b>${u.name}</b><span>${u.email}</span><br /><em>${u.role}</em></div>
      <nav class="nav">${NAV.map(([href, label, ic]) => href === 'h' ? html`<h4>${label}</h4>` : html`<a href=${href} class=${on(href) ? 'on' : ''}>${icon(ICONS[ic])}${label}${href === '#/inbox' && pending ? html`<span class="count alert">${pending}</span>` : ''}</a>`)}</nav>
      <div class="foot"><button onClick=${logout}>Sign out</button></div></aside>
    <main class="main">
      ${app.boot.settings.demo_active ? html`<div class="demo-banner"><b>Demo workspace.</b> Everything here is fictional practice data, including anything you add. ${u.role === 'owner' ? html`Clear it under <a href="#/settings">Settings → Workspace</a> before uploading real records.` : 'The owner clears it before real records go in.'}</div>` : ''}
      <div style="display:flex;justify-content:flex-end;height:0;position:relative;z-index:5" class="hide-m"><${Bell} /></div>
      <div class="only-m" style="display:flex;justify-content:flex-end;margin-bottom:8px"><${Bell} /></div>
      <div style="padding-right:0">${page}</div></main>
    <nav class="mobile-bar"><a href="#/" class=${on('#/') ? 'on' : ''}>${icon(ICONS.home)}Due</a><a href="#/calendar" class=${on('#/calendar') ? 'on' : ''}>${icon(ICONS.cal)}Calendar</a>
      <label class="snap">${icon(ICONS.camera)}Snap receipt<input type="file" accept="image/*" capture="environment" hidden onChange=${snap} /></label>
      <a href="#/inbox" class=${on('#/inbox') ? 'on' : ''}>${icon(ICONS.inbox)}Inbox${pending ? ` (${pending})` : ''}</a><a href="#/more" class=${seg[0] === 'more' ? 'on' : ''} onClick=${(e) => { e.preventDefault(); setNeu({ menu: true }); }}>${icon(ICONS.more)}More</a></nav>
    ${item ? html`<${ItemDrawer} key=${item} id=${item} onClose=${() => setItem(null)} />` : ''}
    ${neu?.menu ? html`<div class="scrim center" onClick=${() => setNeu(null)}><div class="modal"><div class="body nav" style="background:var(--side);border-radius:12px">${NAV.filter(([h]) => h !== 'h').map(([href, label, ic]) => html`<a href=${href}>${icon(ICONS[ic])}${label}</a>`)}<a href="#" onClick=${(e) => { e.preventDefault(); logout(); }}>${icon(ICONS.more)}Sign out</a></div></div></div>` : neu ? html`<${NewEntry} preset=${neu} onClose=${() => setNeu(null)} />` : ''}
    ${toastMsg ? html`<div class="toast ${toastMsg.bad ? 'bad' : ''}" role="status">${toastMsg.message}</div>` : ''}
  </div>`;
}

function App() {
  const [boot, setBoot] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { GET('/api/bootstrap').then(setBoot, setError); }, []);
  if (error) return html`<p class="boot">Could not reach the server: ${error.message}</p>`;
  if (!boot) return html`<p class="boot">Loading Dexter Payments…</p>`;
  app.boot = boot;
  if (boot.needs_setup || !boot.user) return html`<${Auth} setup=${boot.needs_setup} onDone=${(b) => { if (!location.hash) location.hash = '#/'; setBoot(b); }} />`;
  return html`<${Shell} onSignOut=${() => GET('/api/bootstrap').then(setBoot)} />`;
}
render(html`<${App} />`, document.getElementById('app'));
