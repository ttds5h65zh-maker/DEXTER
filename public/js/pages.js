import { html, useState, useLoad, app, POST, PATCH, refresh, toast, Totals, Entry, Panel, Loading, Status, Modal, F, useForm, useAction, money, num, fmtDate, rel, monthName, addMonths, openItem, openNew, go, GROUP_LABEL, cap, dayParts } from './lib.js';

const Top = ({ title, sub, children }) => html`<div class="top"><h1>${title}</h1>${children}${sub ? html`<div class="sub">${sub}</div>` : ''}</div>`;
const NextCell = ({ n, cur }) => (n ? html`<a href="#" onClick=${(e) => { e.preventDefault(); openItem(n.id); }}><b class="num ${n.overdue ? 'red' : ''}">${money(n.outstanding ?? n.amount, n.currency || cur)}</b><div class="small muted">${fmtDate(n.due_date)}</div></a>` : html`<span class="muted">—</span>`);

export function ItemTable({ items, cols = ['due', 'title', 'who', 'amount', 'paid', 'outstanding'], empty = 'Nothing here yet.' }) {
  if (!items.length) return html`<div class="empty">${empty}</div>`;
  const H = { due: 'Due', title: 'Entry', who: 'Payee / payer', amount: 'Amount', paid: 'Paid / collected', outstanding: 'Outstanding', category: 'Category' };
  return html`<div class="scroll-x"><table class="t"><tr>${cols.map((c) => html`<th class=${['amount', 'paid', 'outstanding'].includes(c) ? 'right' : ''}>${H[c]}</th>`)}</tr>
    ${items.map((i) => html`<tr class="click" onClick=${() => openItem(i.id)}>${cols.map((c) => c === 'due' ? html`<td class="nowrap ${i.overdue ? 'red' : ''}">${fmtDate(i.due_date)}${i.outstanding > 0 && i.due_date ? html`<div class="small ${i.overdue ? '' : 'muted'}">${rel(i.days_until)}</div>` : ''}</td>`
      : c === 'title' ? html`<td><b>${i.title}</b><div class="row wrap" style="gap:5px;margin-top:3px"><${Status} item=${i} />${i.doc_count ? html`<span class="muted small">📎 ${i.doc_count}</span>` : ''}</div></td>`
      : c === 'who' ? html`<td>${i.counterparty || '—'}${i.reference ? html`<div class="small muted">${i.reference}</div>` : ''}</td>` : c === 'category' ? html`<td>${i.category_name || '—'}${i.entity_name ? html`<div class="small muted">${i.entity_name}</div>` : ''}</td>`
      : html`<td class="right num ${c === 'outstanding' && i.overdue ? 'red' : ''}">${c === 'amount' ? money(i.amount, i.currency) : c === 'paid' ? num(i.paid + i.credited, i.currency) : i.outstanding ? num(i.outstanding, i.currency) : '✓'}</td>`)}</tr>`)}</table></div>`;
}

// ---------------- calendar + weekly summary ----------------
export function CalendarPage() {
  const [month, setMonth] = useState(app.boot.today.slice(0, 7));
  const st = useLoad(`/api/calendar?month=${month}`);
  const wk = useLoad('/api/weekly?weeks=6');
  const d = st.data;
  const first = new Date(`${month}-01T00:00:00Z`);
  const lead = (first.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const by = {};
  for (const i of d?.items || []) (by[i.due_date] ||= []).push(i);
  const shift = (n) => setMonth(addMonths(`${month}-01`, n).slice(0, 7));
  return html`<${Top} title="Calendar" sub="Solid bar = confirmed, dashed = estimated or projected, struck through = settled.">
      <div class="row"><button class="btn" onClick=${() => shift(-1)} aria-label="Previous month">‹</button><b style="min-width:130px;text-align:center">${monthName(month)}</b><button class="btn" onClick=${() => shift(1)} aria-label="Next month">›</button><button class="btn" onClick=${() => setMonth(app.boot.today.slice(0, 7))}>Today</button></div><//>
    <div class="panel" style="overflow:hidden;margin-bottom:14px">${!d ? html`<div class="body"><${Loading} state=${st} /></div>` : html`<div class="cal">
      ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((x) => html`<div class="dow">${x}</div>`)}
      ${Array.from({ length: lead }, () => html`<div class="day off"></div>`)}
      ${Array.from({ length: days }, (_, n) => { const dt = `${month}-${String(n + 1).padStart(2, '0')}`; const list = by[dt] || [];
        return html`<div class="day ${dt === d.today ? 'today' : ''}"><span class="n">${n + 1}</span>
          ${list.slice(0, 4).map((i) => html`<button class="ev ${i.direction} ${i.overdue ? 'over' : ''} ${i.amount_status !== 'confirmed' || i.projected ? 'est' : ''} ${i.outstanding === 0 ? 'done' : ''}" title=${`${i.title} — ${money(i.outstanding || i.amount, i.currency)}`} onClick=${() => openItem(i.id)}>${i.kind === 'balloon' ? '◆ ' : ''}${i.title} · ${num(i.outstanding || i.amount, i.currency)}</button>`)}
          ${list.length > 4 ? html`<span class="small muted">+${list.length - 4} more</span>` : ''}</div>`; })}
      ${Array.from({ length: (7 - ((lead + days) % 7)) % 7 }, () => html`<div class="day off"></div>`)}</div>`}</div>
    <${Panel} pad=${false} title="Weekly summary">${!wk.data ? html`<div class="body"><${Loading} state=${wk} /></div>` : html`<div class="scroll-x"><table class="t">
      <tr><th>Week</th><th class="right">To pay</th><th class="right">To receive</th><th class="right">Difference</th><th>Notes</th></tr>
      ${wk.data.weeks.map((w) => html`<tr><td class="nowrap"><b>${fmtDate(w.from, false)} – ${fmtDate(w.to, false)}</b>${w.current ? html` <span class="chip confirmed">This week</span>` : ''}</td>
        <td class="right"><${Totals} list=${w.outgoing} /></td><td class="right green"><${Totals} list=${w.incoming} /></td><td class="right"><${Totals} list=${w.net} sign=${true} /></td>
        <td class="small muted">${w.out_count} to pay, ${w.in_count} to receive${w.estimated_count ? ` · ${w.estimated_count} not confirmed` : ''}<div>${w.items.slice(0, 3).map((i) => html`<a href="#" onClick=${(e) => { e.preventDefault(); openItem(i.id); }}>${i.title}</a>`).reduce((a, x) => (a.length ? [...a, ', ', x] : [x]), [])}${w.items.length > 3 ? ` +${w.items.length - 3}` : ''}</div></td></tr>`)}
      <tr><td><b class="red">Already overdue</b></td><td class="right red"><${Totals} list=${wk.data.overdue_out} /></td><td class="right red"><${Totals} list=${wk.data.overdue_in} /></td><td></td><td class="small muted">Not included in the weeks above</td></tr></table></div>`}<//>`;
}

// ---------------- household / family / business ----------------
export function GroupPage({ groups, title, sub }) {
  const [state, setState] = useState('open');
  const lists = groups.map((g) => useLoad(`/api/items?group=${g}&state=${state}`));
  const plans = useLoad('/api/plans?type=recurring');
  if (lists.some((l) => !l.data)) return html`<${Loading} state=${lists.find((l) => !l.data)} />`;
  const all = lists.flatMap((l) => l.data.items);
  const out = all.filter((i) => i.direction === 'out');
  const inc = all.filter((i) => i.direction === 'in');
  const cats = [...new Set(out.map((i) => i.category_name || 'Uncategorised'))];
  const mine = (plans.data || []).filter((p) => groups.includes(app.boot.categories.find((c) => c.id === p.category_id)?.group_kind) && !p.entity_id);
  const biz = groups.includes('business');
  const sumBy = (items, f) => { const m = {}; for (const i of items) m[i.currency] = (m[i.currency] || 0) + i[f]; return Object.entries(m).map(([currency, amount]) => ({ currency, amount })); };
  return html`<${Top} title=${title} sub=${sub}>
      <div class="seg">${[['open', 'Open'], ['paid', 'Settled'], ['all', 'All']].map(([k, l]) => html`<button class=${state === k ? 'on' : ''} onClick=${() => setState(k)}>${l}</button>`)}</div>
      <button class="btn primary" onClick=${() => openNew({ direction: 'out' })}>+ New entry</button><//>
    <div class="tiles"><div class="tile"><div class="k">${biz ? 'Payables outstanding' : 'Outstanding to pay'}</div><div class="v"><${Totals} list=${sumBy(out, 'outstanding')} zero="0.00" /></div></div>
      <div class="tile ${out.some((i) => i.overdue) ? 'alert' : ''}"><div class="k">Overdue</div><div class="v"><${Totals} list=${sumBy(out.filter((i) => i.overdue), 'outstanding')} zero="None" /></div></div>
      ${biz ? html`<div class="tile"><div class="k">Owed to me</div><div class="v green"><${Totals} list=${sumBy(inc, 'outstanding')} zero="0.00" /></div></div><div class="tile"><div class="k">Collected so far</div><div class="v"><${Totals} list=${sumBy(inc, 'paid')} zero="0.00" /></div></div>`
        : html`<div class="tile"><div class="k">Recurring plans</div><div class="v">${mine.filter((p) => p.active).length}</div></div><div class="tile"><div class="k">Not billed yet</div><div class="v">${out.filter((i) => !i.billed && i.outstanding).length}</div></div>`}</div>
    <div class="stack">
    ${biz ? html`<${Panel} pad=${false} title="Owed to me — invoices and reimbursements"><${Receivables} items=${inc} /><//>` : ''}
    ${cats.map((c) => html`<${Panel} pad=${false} title=${c}><${ItemTable} items=${out.filter((i) => (i.category_name || 'Uncategorised') === c)} cols=${['due', 'title', 'who', 'amount', 'outstanding']} /><//>`)}
    ${!out.length ? html`<div class="panel"><div class="empty">No ${state === 'open' ? 'open ' : ''}payments in this group.</div></div>` : ''}
    <${RecurringPanel} plans=${mine} /></div>`;
}
function Receivables({ items }) {
  if (!items.length) return html`<div class="empty">Nobody owes you anything here.</div>`;
  return html`<div class="scroll-x"><table class="t"><tr><th>Who owes</th><th>For</th><th>Due</th><th class="right">Invoiced</th><th class="right">Collected</th><th class="right">Outstanding</th></tr>
    ${items.map((i) => html`<tr class="click" onClick=${() => openItem(i.id)}><td><b>${i.counterparty || '—'}</b><div class="small muted">${i.reference || ''}</div></td><td>${i.title}<div style="margin-top:3px"><${Status} item=${i} /></div></td>
      <td class="nowrap ${i.overdue ? 'red' : ''}">${fmtDate(i.due_date)}<div class="small">${i.outstanding ? rel(i.days_until) : ''}</div></td><td class="right num">${money(i.amount, i.currency)}</td><td class="right num">${num(i.paid + i.credited, i.currency)}</td><td class="right num ${i.overdue ? 'red' : ''}"><b>${num(i.outstanding, i.currency)}</b></td></tr>`)}</table></div>`;
}
function RecurringPanel({ plans }) {
  if (!plans.length) return '';
  const toggle = async (p) => { try { await PATCH(`/api/plans/${p.id}`, { active: !p.active }); toast(p.active ? 'Stopped — future forecasts removed' : 'Resumed'); refresh(); } catch (e) { toast(e.message, true); } };
  return html`<${Panel} pad=${false} title="Recurring plans"><div class="scroll-x"><table class="t"><tr><th>Plan</th><th>Repeats</th><th class="right">Amount</th><th>Next</th><th></th></tr>
    ${plans.map((p) => html`<tr><td><b>${p.title}</b><div class="small muted">${p.counterparty || ''}</div></td><td>${p.interval_n > 1 ? `Every ${p.interval_n} × ` : ''}${cap(p.frequency)}</td>
      <td class="right num">${money(p.amount, p.currency)} <span class="chip ${p.amount_status}">${p.amount_status === 'confirmed' ? 'Fixed' : '≈ Estimate'}</span></td><td><${NextCell} n=${p.stats.next} cur=${p.currency} /></td>
      <td class="right">${p.active ? html`<button class="btn sm" onClick=${() => toggle(p)}>Stop</button>` : html`<span class="chip paid">Stopped</span> <button class="btn sm" onClick=${() => toggle(p)}>Resume</button>`}</td></tr>`)}</table></div><//>`;
}

// ---------------- vehicles & properties ----------------
function EntityForm({ kind, entity, onClose }) {
  const veh = kind === 'vehicle';
  const [v, bind] = useForm({ name: entity?.name || '', ...(entity?.details || {}) });
  const act = useAction();
  const save = () => act.run(async () => {
    const details = veh ? { make: v.make, model: v.model, year: v.year, plate: v.plate } : { address: v.address, role: v.role };
    const e = entity ? await PATCH(`/api/entities/${entity.id}`, { name: v.name, details }) : await POST('/api/entities', { kind, name: v.name, details });
    if (!entity) app.boot.entities.push(e); else Object.assign(app.boot.entities.find((x) => x.id === e.id) || {}, { name: e.name });
    refresh(); onClose(); if (!entity) go(`#/${veh ? 'vehicles' : 'properties'}/${e.id}`);
  });
  return html`<${Modal} title=${entity ? `Edit ${entity.name}` : veh ? 'Add a vehicle' : 'Add a property'} onClose=${onClose} footer=${html`<button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" disabled=${act.busy} onClick=${save}>Save</button>`}>
    <div class="stack">${act.error ? html`<div class="err">${act.error.message}</div>` : ''}<${F} label="Name"><input type="text" placeholder=${veh ? 'e.g. Family SUV' : 'e.g. Marina apartment'} ...${bind('name')} /><//>
      ${veh ? html`<div class="grid2"><${F} label="Make"><input type="text" ...${bind('make')} /><//><${F} label="Model"><input type="text" ...${bind('model')} /><//><${F} label="Year"><input type="text" ...${bind('year')} /><//><${F} label="Plate"><input type="text" ...${bind('plate')} /><//></div>`
        : html`<${F} label="Address"><input type="text" ...${bind('address')} /><//><${F} label="Role" hint="e.g. Family home — rented, or Owned — rented out"><input type="text" ...${bind('role')} /><//>`}</div><//>`;
}

export function EntityList({ kind }) {
  const st = useLoad('/api/entities');
  const [add, setAdd] = useState(false);
  const veh = kind === 'vehicle';
  if (!st.data) return html`<${Loading} state=${st} />`;
  const list = st.data.filter((e) => e.kind === kind);
  return html`<${Top} title=${veh ? 'Vehicles' : 'Properties'} sub=${veh ? 'One page per car: loan, insurance, registration, service and what it costs across the year.' : 'One page per property: rent, mortgage, maintenance and contractor bills.'}><button class="btn primary" onClick=${() => setAdd(true)}>+ Add ${veh ? 'vehicle' : 'property'}</button><//>
    <div class="tiles" style="grid-template-columns:repeat(auto-fill,minmax(270px,1fr))">${list.map((e) => html`<a class="tile" href="#/${veh ? 'vehicles' : 'properties'}/${e.id}" style="color:inherit;text-decoration:none">
      <div class="k">${veh ? [e.details.make, e.details.model, e.details.year].filter(Boolean).join(' ') || 'Vehicle' : e.details.role || 'Property'}<span>${e.overdue_count ? html`<span class="chip overdue">${e.overdue_count} overdue</span>` : ''}</span></div>
      <div style="font-size:17px;font-weight:650;margin-top:4px">${e.name}</div><div class="d">${veh ? e.details.plate || '' : e.details.address || ''}</div>
      <dl class="kv" style="margin-top:10px"><dt>Still to pay</dt><dd><${Totals} list=${e.owed} zero="Nothing" /></dd>${e.receivable.length ? html`<dt>To receive</dt><dd class="green"><${Totals} list=${e.receivable} /></dd>` : ''}
        <dt>Next</dt><dd>${e.next ? html`${e.next.title}<div class="small ${e.next.overdue ? 'red' : 'muted'}">${fmtDate(e.next.due_date)} · ${money(e.next.outstanding, e.next.currency)}</div>` : '—'}</dd></dl></a>`)}
      ${!list.length ? html`<div class="panel"><div class="empty">No ${veh ? 'vehicles' : 'properties'} yet.</div></div>` : ''}</div>
    ${add ? html`<${EntityForm} kind=${kind} onClose=${() => setAdd(false)} />` : ''}`;
}

function LoanCard({ p }) {
  const s = p.stats;
  return html`<${Panel} title=${p.title} actions=${html`<span class="chip ${p.verified ? 'confirmed' : 'estimated'}">${p.verified ? (p.type === 'loan' ? '✓ Lender’s schedule' : '✓ Agreed schedule') : '≈ Projected · not verified'}</span>`}>
    <div class="bal" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">
      <div><span>Next installment</span><${NextCell} n=${s.next} cur=${p.currency} /></div>
      <div><span>Remaining balance${p.verified ? '' : ' (projected)'}</span><b class="num">${money(s.remaining, p.currency)}</b><div class="small muted">${s.count ? Math.round((s.paid / s.total) * 100) : 0}% paid</div></div>
      <div><span>Final installment</span>${s.final ? html`<b>${fmtDate(s.final.due_date)}</b><div class="small muted num">${money(s.final.amount, p.currency)}</div>` : '—'}</div>
      <div><span>Balloon payment</span>${s.balloon ? html`<a href="#" onClick=${(e) => { e.preventDefault(); openItem(s.balloon.id); }}><b class="num">${money(s.balloon.amount, p.currency)}</b><div class="small muted">${fmtDate(s.balloon.due_date)}</div></a>` : html`<b class="muted">None</b>`}</div></div>
    <div class="meter" style="margin-top:12px" title="Share already paid"><i class="c" style=${`width:${s.total ? (s.paid / s.total) * 100 : 0}%`}></i></div>
    <p class="small muted" style="margin:8px 0 0">${p.counterparty || ''} · ${s.count} payments in the schedule${s.overdue ? html` · <span class="red">${s.overdue} overdue</span>` : ''} · <a href="#" onClick=${(e) => { e.preventDefault(); const id = (s.next || s.final)?.id; id && openItem(id); }}>Open schedule</a></p><//>`;
}

export function EntityPage({ id }) {
  const [year, setYear] = useState(app.boot.today.slice(0, 4));
  const st = useLoad(`/api/entities/${id}?year=${year}`);
  const [edit, setEdit] = useState(false);
  const d = st.data;
  if (!d) return html`<${Loading} state=${st} />`;
  const e = d.entity, veh = e.kind === 'vehicle', yc = d.year_cost, base = app.boot.settings.base_currency;
  const KD = veh ? [['insurance', 'Insurance'], ['registration', 'Registration'], ['service', 'Next service']] : [['rent_payable', 'Rent payable'], ['rent_receivable', 'Rent receivable'], ['maintenance', 'Maintenance'], ['contractor', 'Contractor bills']];
  const mv = yc.months.map((m) => m.cost.find((t) => t.currency === base)?.amount || 0);
  const mmax = Math.max(1, ...mv);
  const cmax = Math.max(1, ...yc.by_category.map((c) => c.total.find((t) => t.currency === base)?.amount || 0));
  return html`<${Top} title=${e.name} sub=${veh ? [e.details.make, e.details.model, e.details.year, e.details.plate].filter(Boolean).join(' · ') : [e.details.role, e.details.address].filter(Boolean).join(' · ')}>
      <a class="btn" href="#/${veh ? 'vehicles' : 'properties'}">‹ All ${veh ? 'vehicles' : 'properties'}</a><button class="btn" onClick=${() => setEdit(true)}>Edit</button>
      <button class="btn primary" onClick=${() => openNew({ entity_id: e.id })}>+ New entry</button><//>
    <div class="tiles">${KD.map(([k, l]) => html`<div class="tile ${d.key_dates[k]?.overdue ? 'alert' : ''}"><div class="k">${l}</div>${d.key_dates[k] ? html`<button class="link" onClick=${() => openItem(d.key_dates[k].id)}><div class="v"><small>${d.key_dates[k].currency}</small>${num(d.key_dates[k].outstanding, d.key_dates[k].currency)}</div><div class="d">${fmtDate(d.key_dates[k].due_date)}${d.key_dates[k].amount_status !== 'confirmed' ? ' · estimated' : ''}</div></button>` : html`<div class="v muted" style="font-size:15px">Nothing scheduled</div>`}</div>`)}
      ${veh ? html`<div class="tile hero"><div class="k">Cost in ${year}</div><div class="v"><${Totals} list=${yc.total} zero="0.00" /></div><div class="d">${yc.has_estimates ? 'Includes estimates' : 'All confirmed'}</div></div>` : ''}</div>
    <div class="stack">
      ${d.plans.filter((p) => p.type !== 'recurring').map((p) => html`<${LoanCard} p=${p} />`)}
      <div class="cols even" style="margin:0">
        <${Panel} title=${`${veh ? 'What this car costs' : 'Costs'} in ${year}`} actions=${html`<div class="row"><button class="btn sm" onClick=${() => setYear(String(Number(year) - 1))}>‹</button><b>${year}</b><button class="btn sm" onClick=${() => setYear(String(Number(year) + 1))}>›</button></div>`}>
          ${yc.by_category.length ? html`${yc.by_category.map((c) => html`<div class="hbar"><span>${c.category}${c.estimated ? ' ≈' : ''}</span><div class="track"><i style=${`width:${((c.total.find((t) => t.currency === base)?.amount || 0) / cmax) * 100}%`}></i></div><span class="num"><${Totals} list=${c.total} /></span></div>`)}
            <div class="hbar" style="border-top:1px solid var(--line);margin-top:6px;padding-top:9px;font-weight:650"><span>Total</span><span></span><span class="num"><${Totals} list=${yc.total} /></span></div>
            <p class="small muted" style="margin:6px 0 0">Paid so far: <${Totals} list=${yc.paid} zero="0.00" />${yc.income.length ? html` Income this year: <${Totals} list=${yc.income} />` : ''} ≈ marks categories that include estimates or projections. Counted by due date; card repayments and transfers are never counted as costs.</p>` : html`<p class="muted">No costs dated in ${year}.</p>`}<//>
        <${Panel} title=${`By month (${base})`}><div class="chart"><svg viewBox="0 0 360 150" role="img" aria-label="Cost per month">
          ${mv.map((v, i) => { const h = (v / mmax) * 110; return html`<g><title>${monthName(yc.months[i].month)}: ${money(v, base)}</title><rect x=${8 + i * 29} y=${125 - h} width="20" height=${Math.max(h, v ? 2 : 0)} rx="3" fill="var(--s-out)" /><text x=${18 + i * 29} y="142" text-anchor="middle">${'JFMAMJJASOND'[i]}</text></g>`; })}
          <line x1="4" x2="356" y1="125" y2="125" stroke="#d3cdbf" /></svg></div><//>
      </div>
      <${Panel} pad=${false} title="Upcoming and unpaid"><${ItemTable} items=${d.upcoming} cols=${['due', 'title', 'category', 'amount', 'outstanding']} empty="Nothing outstanding." /><//>
      <${Panel} pad=${false} title="Everything for this ${veh ? 'vehicle' : 'property'}"><${ItemTable} items=${d.items.filter((i) => i.outstanding === 0)} cols=${['due', 'title', 'category', 'amount', 'paid']} empty="No settled entries yet." /><//>
    </div>${edit ? html`<${EntityForm} kind=${e.kind} entity=${e} onClose=${() => setEdit(false)} />` : ''}`;
}

// ---------------- loans & cards ----------------
export function FinancePage() {
  const st = useLoad('/api/finance');
  const [add, setAdd] = useState(null);
  const [v, bind] = useForm({ name: '', institution: '', last4: '', currency: app.boot.settings.base_currency });
  const d = st.data;
  if (!d) return html`<${Loading} state=${st} />`;
  const saveAcc = async () => { try { const a = await POST('/api/accounts', { ...v, type: add }); app.boot.accounts.push(a); setAdd(null); refresh(); } catch (e) { toast(e.message, true); } };
  return html`<${Top} title="Loans & credit cards" sub="Agreed repayment schedules, part payments and balances. Card purchases are linked to their statement so they are counted once.">
      <button class="btn" onClick=${() => setAdd('card')}>+ Card</button><button class="btn" onClick=${() => setAdd('bank')}>+ Bank account</button>
      <button class="btn" onClick=${() => openNew({ type: 'statement' })}>+ Card statement</button><button class="btn primary" onClick=${() => openNew({ type: 'schedule', is_loan: true })}>+ Loan / schedule</button><//>
    <div class="stack"><h2>Credit cards</h2>
      ${d.cards.map((c) => { const s = c.current; return html`<${Panel} title=${c.name} actions=${s ? html`<${Status} item=${s} />` : ''}>
        ${s ? html`<div class="bal" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))"><div><span>Statement balance</span><b class="num">${money(s.amount, s.currency)}</b></div><div><span>Minimum due</span><b class="num">${s.min_due != null ? money(s.min_due, s.currency) : '—'}</b></div>
            <div><span>Due date</span><b class=${s.overdue ? 'red' : ''}>${fmtDate(s.due_date)}</b><div class="small muted">${s.outstanding ? rel(s.days_until) : 'settled'}</div></div><div><span>Still to pay</span><b class="num">${money(s.outstanding, s.currency)}</b></div></div>
          <div class="row" style="margin-top:10px"><button class="btn" onClick=${() => openItem(s.id)}>Open statement</button><span class="muted small">${s.purchases.length} linked purchase(s) · ${c.statements.length} statement(s) on file</span></div>
          ${s.purchases.length ? html`<table class="t" style="margin-top:8px">${s.purchases.map((p) => html`<tr class="click" onClick=${() => openItem(p.item_id)}><td class="nowrap">${fmtDate(p.date)}</td><td>${p.title}<span class="muted"> · ${p.counterparty || ''}</span></td><td class="right num">${money(p.amount, p.currency)}</td></tr>`)}</table>` : ''}`
          : html`<p class="muted" style="margin:0">No statement recorded yet for this card.</p>`}
        ${c.unassigned.length ? html`<p class="note" style="margin:10px 0 0">${c.unassigned.length} card purchase(s) are waiting for the next statement. They will be linked when you add it.</p>` : ''}<//>`; })}
      ${!d.cards.length ? html`<div class="panel"><div class="empty">No cards yet.</div></div>` : ''}
      <h2>Loans and installment schedules</h2>${d.loans.map((p) => html`<${LoanCard} p=${p} />`)}${!d.loans.length ? html`<div class="panel"><div class="empty">No loans or schedules yet.</div></div>` : ''}
      <${RecurringPanel} plans=${d.recurring} /></div>
    ${add ? html`<${Modal} title=${add === 'card' ? 'Add a credit card' : 'Add a bank account'} onClose=${() => setAdd(null)} footer=${html`<button class="btn" onClick=${() => setAdd(null)}>Cancel</button><button class="btn primary" onClick=${saveAcc}>Save</button>`}>
      <div class="grid2"><${F} label="Name"><input type="text" ...${bind('name')} /><//><${F} label="Bank"><input type="text" ...${bind('institution')} /><//><${F} label="Last 4 digits"><input type="text" maxlength="4" ...${bind('last4')} /><//><${F} label="Currency"><input type="text" maxlength="3" ...${bind('currency')} /><//></div><//>` : ''}`;
}

// ---------------- all records ----------------
export function RecordsPage({ query }) {
  const [f, setF] = useState({ q: '', direction: query.get('direction') || '', state: query.get('state') || 'all', group: '' });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v && v !== 'all')).toString();
  const st = useLoad(`/api/items?${qs}`);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  return html`<${Top} title="All records" sub="Search covers titles, payees, references, notes and the text inside attached documents and scans.">
      <a class="btn" href=${`/api/export/items.csv?${qs}`}>Export records (CSV)</a><a class="btn" href="/api/export/payments.csv">Export payments (CSV)</a><button class="btn primary" onClick=${() => openNew()}>+ New entry</button><//>
    <div class="panel" style="margin-bottom:14px"><div class="body row wrap">
      <input type="search" placeholder="Search…" style="flex:2;min-width:180px" value=${f.q} onInput=${set('q')} />
      <select style="flex:1;min-width:130px" value=${f.direction} onChange=${set('direction')}><option value="">Money in and out</option><option value="out">Money out</option><option value="in">Money in</option></select>
      <select style="flex:1;min-width:130px" value=${f.state} onChange=${set('state')}><option value="all">Any status</option><option value="open">Open</option><option value="overdue">Overdue</option><option value="paid">Settled</option><option value="unbilled">Not billed yet</option><option value="needs_review">Needs review</option></select>
      <select style="flex:1;min-width:130px" value=${f.group} onChange=${set('group')}><option value="">All groups</option>${Object.entries(GROUP_LABEL).map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select></div></div>
    ${!st.data ? html`<${Loading} state=${st} />` : html`<${Panel} pad=${false} title=${`${st.data.items.length} record(s)`} actions=${html`<span class="small muted row">Outstanding: <b><${Totals} list=${st.data.totals.outstanding} zero="0.00" /></b></span>`}>
      <${ItemTable} items=${st.data.items} cols=${['due', 'title', 'who', 'category', 'amount', 'paid', 'outstanding']} empty="No records match." /><//>`}`;
}
