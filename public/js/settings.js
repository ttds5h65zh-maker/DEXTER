import { html, useState, useLoad, app, GET, POST, PATCH, api, refresh, toast, Panel, F, Loading, useForm, useAction, GROUP_LABEL, emit } from './lib.js';

function Reminders() {
  const st = useLoad('/api/reminders');
  const [offsets, setOffsets] = useState(app.boot.user.prefs.reminder_offsets);
  const [extra, setExtra] = useState('');
  const [code, setCode] = useState('');
  const act = useAction();
  const save = async (list) => { const r = await PATCH('/api/me', { reminder_offsets: list }); app.boot.user = r.user; setOffsets(r.user.prefs.reminder_offsets); refresh(); toast('Reminder days saved'); };
  const e = st.data?.email;
  return html`<${Panel} title="Reminders">
    <div class="stack">
      <div><b>Remind me before the due date</b><div class="row wrap" style="margin-top:8px">
        ${offsets.map((o) => html`<span class="chip confirmed" style="font-size:12.5px;padding:3px 10px">${o === 0 ? 'On the day' : `${o} day${o === 1 ? '' : 's'} before`} <a href="#" style="margin-left:4px" title="Remove" onClick=${(ev) => { ev.preventDefault(); save(offsets.filter((x) => x !== o)); }}>×</a></span>`)}
        <input type="number" min="0" max="365" placeholder="days" style="width:90px" value=${extra} onInput=${(ev) => setExtra(ev.target.value)} /><button class="btn sm" onClick=${() => extra !== '' && save([...offsets, Number(extra)]).then(() => setExtra(''))}>Add</button>
        <button class="btn sm ghost" onClick=${() => save([30, 7, 1])}>Reset to 30 / 7 / 1</button></div></div>
      <div class="note ok"><b>In-app reminders: on.</b> They appear under the bell for every signed-in user, including overdue items. ${st.data ? `${st.data.reminders.length} active right now.` : ''}</div>
      ${!e ? html`<${Loading} state=${st} />` : !e.configured ? html`<div class="note"><b>Email reminders: not configured.</b> They need an outgoing mail (SMTP) account. Whoever runs the app sets two environment variables and restarts it:
          <pre style="margin:8px 0;white-space:pre-wrap;font-size:12px">${'SMTP_URL=smtps://USER:PASSWORD@smtp.your-provider.com:465\nMAIL_FROM="Dexter Payments <reminders@your-domain.com>"'}</pre>Then come back here and send yourself a confirmation code. Email is only reported as working after you type that code back in.</div>`
        : e.verified ? html`<div class="note ok"><b>Email reminders: delivery confirmed</b> to ${e.address}. You get one digest when a reminder day is reached.
            <label class="check" style="margin-top:8px"><input type="checkbox" checked=${e.enabled} onChange=${(ev) => PATCH('/api/me', { email_reminders: ev.target.checked }).then(() => { refresh(); toast('Saved'); })} />Send me reminder emails</label></div>`
        : html`<div class="note warn"><b>Email reminders: server is configured, delivery not confirmed yet.</b> Send a code to ${e.address} and enter it here. Until then nothing is emailed.
            ${act.error ? html`<div class="err" style="margin-top:8px">${act.error.message}</div>` : ''}
            <div class="row wrap" style="margin-top:8px"><button class="btn" disabled=${act.busy} onClick=${() => act.run(async () => { await POST('/api/reminders/email/send-code'); toast('Code sent — check your inbox'); refresh(); })}>${e.code_pending ? 'Send again' : 'Send confirmation code'}</button>
              ${e.code_pending ? html`<input type="text" inputmode="numeric" placeholder="6-digit code" style="width:130px" value=${code} onInput=${(ev) => setCode(ev.target.value)} /><button class="btn primary" onClick=${() => act.run(async () => { await POST('/api/reminders/email/confirm', { code }); toast('Email delivery confirmed'); refresh(); })}>Confirm</button>` : ''}</div></div>`}
      <div class="note"><b>Push notifications: not available in this version.</b> Phone push needs the app served over HTTPS plus a web-push key pair, which is not set up. In-app and email reminders cover the same due dates.</div>
    </div><//>`;
}

function Profile() {
  const [v, bind, set] = useForm({ name: app.boot.user.name, current_password: '', new_password: '' });
  const act = useAction();
  const save = () => act.run(async () => { const r = await PATCH('/api/me', { name: v.name, ...(v.new_password ? { current_password: v.current_password, new_password: v.new_password } : {}) }); app.boot.user = r.user; set((s) => ({ ...s, current_password: '', new_password: '' })); toast('Saved'); refresh(); });
  return html`<${Panel} title="My account"><div class="stack">${act.error ? html`<div class="err">${act.error.message}</div>` : ''}
    <div class="grid3"><${F} label="Name"><input type="text" ...${bind('name')} /><//><${F} label="Current password"><input type="password" autocomplete="current-password" ...${bind('current_password')} /><//><${F} label="New password" hint="At least 10 characters"><input type="password" autocomplete="new-password" ...${bind('new_password')} /><//></div>
    <div class="row"><button class="btn primary" disabled=${act.busy} onClick=${save}>Save</button><span class="muted small">Signed in as ${app.boot.user.email} · ${app.boot.user.role}</span></div></div><//>`;
}

function People() {
  const st = useLoad('/api/users');
  const [v, bind, set] = useForm({ name: '', email: '', password: '', role: 'accountant' });
  const act = useAction();
  const add = () => act.run(async () => { await POST('/api/users', v); set({ name: '', email: '', password: '', role: 'accountant' }); toast('Account created — share the password privately'); refresh(); });
  const upd = (u, body, msg) => PATCH(`/api/users/${u.id}`, body).then(() => { toast(msg); refresh(); }, (e) => toast(e.message, true));
  return html`<${Panel} title="People and access (owner only)"><div class="stack">
    ${!st.data ? html`<${Loading} state=${st} />` : html`<div class="scroll-x"><table class="t"><tr><th>Name</th><th>Email</th><th>Role</th><th>Access</th><th></th></tr>
      ${st.data.map((u) => html`<tr><td><b>${u.name}</b></td><td>${u.email}</td><td>${u.role === 'owner' ? 'Owner — everything, plus access and workspace settings' : 'Accountant — all financial records, documents, imports, matching, payments, exports'}</td>
        <td>${u.active ? html`<span class="chip confirmed">Active</span>` : html`<span class="chip paid">Removed</span>`}</td>
        <td class="right nowrap">${u.id !== app.boot.user.id ? html`<button class="btn sm" onClick=${() => { const p = prompt(`New password for ${u.name} (at least 10 characters)`); p && upd(u, { password: p }, 'Password reset — they are signed out everywhere'); }}>Reset password</button>
          <button class="btn sm ${u.active ? 'danger' : ''}" onClick=${() => upd(u, { active: !u.active }, u.active ? 'Access removed' : 'Access restored')}>${u.active ? 'Remove access' : 'Restore'}</button>` : html`<span class="muted small">you</span>`}</td></tr>`)}</table></div>`}
    ${act.error ? html`<div class="err">${act.error.message}</div>` : ''}
    <div class="grid2"><${F} label="Name"><input type="text" ...${bind('name')} /><//><${F} label="Email (their sign-in)"><input type="email" ...${bind('email')} /><//>
      <${F} label="Initial password" hint="At least 10 characters. They can change it after signing in."><input type="text" autocomplete="off" ...${bind('password')} /><//><${F} label="Role"><select ...${bind('role')}><option value="accountant">Accountant</option><option value="owner">Owner</option></select><//></div>
    <div><button class="btn primary" disabled=${act.busy} onClick=${add}>Add person</button></div></div><//>`;
}

function Workspace() {
  const s = app.boot.settings;
  const [v, bind] = useForm({ workspace_name: s.workspace_name, base_currency: s.base_currency, timezone: s.timezone, cur: '', rate: '' });
  const [rates, setRates] = useState(app.boot.fx_rates);
  const act = useAction();
  const save = () => act.run(async () => { const b = await PATCH('/api/settings', { workspace_name: v.workspace_name, base_currency: v.base_currency, timezone: v.timezone }); Object.assign(app.boot, b); toast('Workspace saved'); refresh(); });
  const rate = (cur, r) => act.run(async () => { const list = await api('PUT', `/api/fx-rates/${cur}`, { rate: r }); app.boot.fx_rates = list; setRates(list); refresh(); toast(r ? 'Rate saved — totals now include this currency' : 'Rate removed — totals are separate again'); });
  return html`<${Panel} title="Workspace (owner only)"><div class="stack">${act.error ? html`<div class="err">${act.error.message}</div>` : ''}
    <div class="grid3"><${F} label="Workspace name"><input type="text" ...${bind('workspace_name')} /><//><${F} label="Main currency"><input type="text" maxlength="3" ...${bind('base_currency')} /><//><${F} label="Time zone" hint="Decides what counts as today and overdue"><input type="text" ...${bind('timezone')} /><//></div>
    <div><button class="btn primary" disabled=${act.busy} onClick=${save}>Save workspace</button></div>
    <div><b>Exchange rates</b><p class="muted small" style="margin:2px 0 8px">Totals stay separate per currency. Enter a rate only if you want a currency folded into ${s.base_currency} totals; converted totals are labelled.</p>
      ${rates.map((r) => html`<div class="row" style="margin-bottom:6px"><span class="chip plain">1 ${r.currency} = ${r.rate} ${s.base_currency}</span><button class="btn sm ghost" onClick=${() => rate(r.currency, null)}>Remove</button></div>`)}
      <div class="row wrap"><input type="text" maxlength="3" placeholder="USD" style="width:80px" ...${bind('cur')} /><span>=</span><input type="text" inputmode="decimal" placeholder="3.6725" style="width:110px" ...${bind('rate')} /><span>${s.base_currency}</span><button class="btn sm" onClick=${() => v.cur && v.rate && rate(v.cur.toUpperCase(), Number(v.rate))}>Save rate</button></div></div>
    <div style="border-top:1px solid var(--line);padding-top:12px"><b>Demo data</b>
      ${s.demo_active ? html`<p class="muted small" style="margin:2px 0 8px">The workspace currently holds fictional demo data, plus anything you added while trying it out. Clearing removes every record, document and import (users, settings and your categories stay) so you can start with real files.</p>
        <button class="btn danger" onClick=${() => prompt('This deletes every record and uploaded file in the workspace. Type CLEAR to continue.') === 'CLEAR' && POST('/api/demo/clear').then(() => location.reload(), (e) => toast(e.message, true))}>Clear demo and start for real</button>`
        : html`<p class="muted small" style="margin:2px 0 8px">The demo can only be loaded into an empty workspace.</p><button class="btn" onClick=${() => POST('/api/demo/load').then(() => location.reload(), (e) => toast(e.message, true))}>Load fictional demo</button>`}</div></div><//>`;
}

function Categories() {
  const [v, bind, set] = useForm({ name: '', group_kind: 'household' });
  const [, bump] = useState(0);
  const add = () => POST('/api/categories', v).then((c) => { app.boot.categories.push(c); set({ name: '', group_kind: v.group_kind }); bump((n) => n + 1); toast('Category added'); }, (e) => toast(e.message, true));
  return html`<${Panel} title="Categories"><div class="stack">
    <div class="grid3">${app.boot.groups.map((g) => html`<div><b>${GROUP_LABEL[g]}</b><div class="small muted" style="margin-top:3px">${app.boot.categories.filter((c) => c.group_kind === g).map((c) => c.name).join(' · ')}</div></div>`)}</div>
    <div class="row wrap"><input type="text" placeholder="New category, e.g. Pool maintenance" style="flex:2;min-width:200px" ...${bind('name')} /><select style="flex:1;min-width:140px" ...${bind('group_kind')}>${app.boot.groups.map((g) => html`<option value=${g}>${GROUP_LABEL[g]}</option>`)}</select><button class="btn primary" onClick=${add}>Add category</button></div></div><//>`;
}

export function SettingsPage() {
  const owner = app.boot.user.role === 'owner';
  return html`<div class="top"><h1>Settings</h1><button class="btn only-m" onClick=${() => emit('logout')}>Sign out</button></div>
    <div class="stack"><${Reminders} /><${Profile} /><${Categories} />${owner ? html`<${People} /><${Workspace} />` : html`<div class="note">Account access and workspace settings are managed by the owner.</div>`}
      <${Panel} title="Exports"><div class="row wrap"><a class="btn" href="/api/export/items.csv">All records (CSV)</a><a class="btn" href="/api/export/payments.csv">All payments (CSV)</a></div><//></div>`;
}
