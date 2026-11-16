// Record drawer (the invoice, schedule or statement behind an entry), payment form, and the "new entry" dialog.
import { html, useState, useEffect, useLoad, app, GET, POST, PATCH, api, refresh, toast, Modal, F, Status, Loading, useForm, useAction, money, num, toMinor, fromMinor, fmtDate, rel, openItem, addMonths, GROUP_LABEL, cap, Original } from './lib.js';

export function DocViewer({ doc, onClose }) {
  const st = useLoad(doc.mime ? null : `/api/documents/${doc.id}/meta`);
  const d = doc.mime ? doc : st.data;
  return html`<${Modal} title=${doc.filename} onClose=${onClose} wide=${true} footer=${html`<a class="btn" href=${`/api/documents/${doc.id}/file?download=1`}>Download original</a>`}>
    <div class="viewer" style="height:70vh;position:static">${d ? html`<${Original} doc=${d} />` : html`<div class="empty">Loading…</div>`}</div><//>`;
}

function CatEntityFields({ v, bind, set }) {
  const { categories, entities, groups } = app.boot;
  const cat = categories.find((c) => c.id === Number(v.category_id));
  const kinds = cat && ['vehicle', 'property'].includes(cat.group_kind) ? [cat.group_kind] : ['vehicle', 'property'];
  const addCat = async () => {
    const name = prompt('New category name'); if (!name) return;
    const g = prompt(`Which group? ${groups.join(', ')}`, cat?.group_kind || 'household'); if (!g) return;
    try { const c = await POST('/api/categories', { name, group_kind: g.trim().toLowerCase() }); app.boot.categories.push(c); set((s) => ({ ...s, category_id: c.id })); } catch (e) { toast(e.message, true); }
  };
  return html`<div class="grid2">
    <${F} label="Category" hint=${html`<a href="#" onClick=${(e) => { e.preventDefault(); addCat(); }}>+ Add a category</a>`}><select ...${bind('category_id')}><option value="">—</option>
      ${groups.map((g) => html`<optgroup label=${GROUP_LABEL[g]}>${categories.filter((c) => c.group_kind === g).map((c) => html`<option value=${c.id}>${c.name}</option>`)}</optgroup>`)}</select><//>
    <${F} label="Vehicle or property"><select ...${bind('entity_id')}><option value="">— none —</option>${entities.filter((e) => kinds.includes(e.kind) && !e.archived).map((e) => html`<option value=${e.id}>${e.name}</option>`)}</select><//>
  </div>`;
}

export function PaymentForm({ item, onDone, onClose }) {
  const incoming = item.direction === 'in';
  const cards = app.boot.accounts.filter((a) => a.type === 'card');
  const [v, bind] = useForm({ type: 'payment', amount: fromMinor(item.outstanding, item.currency), date: app.boot.today, method: incoming ? 'bank' : 'bank', card_account_id: cards[0]?.id || '', note: '' });
  const [file, setFile] = useState(null);
  const act = useAction();
  const save = () => act.run(async () => {
    const amount = toMinor(v.amount, item.currency);
    if (!amount || amount <= 0) throw new Error('Enter an amount.');
    let proof;
    if (file) proof = (await api('POST', `/api/items/${item.id}/documents?purpose=proof`, file)).id;
    await POST(`/api/items/${item.id}/payments`, { type: v.type, amount, date: v.date, method: v.type === 'payment' ? v.method : null, card_account_id: v.method === 'card' ? Number(v.card_account_id) : null, note: v.note, proof_document_id: proof });
    toast(v.type === 'payment' ? (incoming ? 'Receipt recorded' : 'Payment recorded') : `${cap(v.type)} recorded`); refresh(); onDone?.(); onClose();
  });
  return html`<${Modal} title=${incoming ? 'Record money received' : 'Record a payment'} onClose=${onClose} footer=${html`<button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" disabled=${act.busy} onClick=${save}>Save</button>`}>
    <div class="stack">
      <div class="note">${item.title} · outstanding <b class="num">${money(item.outstanding, item.currency)}</b> of ${money(item.amount, item.currency)}. Dexter records payments you have made yourself; it does not move money.</div>
      ${act.error ? html`<div class="err">${act.error.message}</div>` : ''}
      <div class="grid2">
        <${F} label="Type"><select ...${bind('type')}><option value="payment">${incoming ? 'Payment received' : 'Payment made'} (full or part)</option><option value="credit">Credit note / discount</option><option value="refund">Refund of an earlier payment</option></select><//>
        <${F} label="Amount (${item.currency})" hint="Enter less than the outstanding balance for a part payment"><input type="text" inputmode="decimal" ...${bind('amount')} /><//>
        <${F} label="Date"><input type="date" ...${bind('date')} /><//>
        ${v.type === 'payment' ? html`<${F} label="How"><select ...${bind('method')}><option value="bank">Bank transfer</option><option value="cash">Cash</option><option value="cheque">Cheque</option>${!incoming && item.kind !== 'card_statement' && cards.length ? html`<option value="card">Credit card</option>` : ''}</select><//>` : ''}
      </div>
      ${v.method === 'card' && v.type === 'payment' ? html`<${F} label="Card" hint="The purchase is linked to that card’s statement, so it is not counted again as cash to pay."><select ...${bind('card_account_id')}>${cards.map((c) => html`<option value=${c.id}>${c.name}</option>`)}</select><//>` : ''}
      <${F} label="Note"><input type="text" ...${bind('note')} /><//>
      <${F} label="Proof of payment (optional)" hint="Receipt, transfer confirmation or cheque photo"><input type="file" accept="image/*,application/pdf" onChange=${(e) => setFile(e.target.files[0] || null)} /><//>
    </div><//>`;
}

function EditForm({ item, onClose }) {
  const [v, bind, set] = useForm({ title: item.title, counterparty: item.counterparty, reference: item.reference, amount: fromMinor(item.amount, item.currency), currency: item.currency, issue_date: item.issue_date, due_date: item.due_date, amount_status: item.amount_status, category_id: item.category_id, entity_id: item.entity_id, notes: item.notes, min_due: fromMinor(item.min_due, item.currency) });
  const act = useAction();
  const save = () => act.run(async () => {
    const cur = String(v.currency).toUpperCase();
    await PATCH(`/api/items/${item.id}`, { title: v.title, counterparty: v.counterparty, reference: v.reference, amount: toMinor(v.amount, cur), currency: cur, issue_date: v.issue_date || null, due_date: v.due_date || null, amount_status: v.amount_status,
      category_id: v.category_id || null, entity_id: v.entity_id || null, notes: v.notes, ...(item.kind === 'card_statement' ? { min_due: toMinor(v.min_due, cur) } : {}) });
    toast('Saved — the change is in the history'); refresh(); onClose();
  });
  return html`<${Modal} title="Correct this record" onClose=${onClose} footer=${html`<button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" disabled=${act.busy} onClick=${save}>Save changes</button>`}>
    <div class="stack">${act.error ? html`<div class="err">${act.error.message}</div>` : ''}
      <${F} label="Title"><input type="text" ...${bind('title')} /><//>
      <div class="grid2"><${F} label=${item.direction === 'in' ? 'Who owes it' : 'Payee'}><input type="text" ...${bind('counterparty')} /><//><${F} label="Reference"><input type="text" ...${bind('reference')} /><//>
        <${F} label=${item.kind === 'card_statement' ? 'Statement balance' : 'Amount'}><input type="text" inputmode="decimal" ...${bind('amount')} /><//><${F} label="Currency"><input type="text" maxlength="3" ...${bind('currency')} /><//>
        ${item.kind === 'card_statement' ? html`<${F} label="Minimum due"><input type="text" inputmode="decimal" ...${bind('min_due')} /><//>` : ''}
        <${F} label="Issue date"><input type="date" ...${bind('issue_date')} /><//><${F} label="Due date"><input type="date" ...${bind('due_date')} /><//>
        <${F} label="Amount is"><select ...${bind('amount_status')}><option value="confirmed">Confirmed</option><option value="estimated">Estimated</option><option value="needs_review">Needs review</option></select><//></div>
      <${CatEntityFields} v=${v} bind=${bind} set=${set} />
      <${F} label="Notes"><textarea rows="2" ...${bind('notes')}></textarea><//></div><//>`;
}

const FIELD_LABEL = { amount: 'Amount', due_date: 'Due date', issue_date: 'Issue date', amount_status: 'Amount status', min_due: 'Minimum due', category_id: 'Category', entity_id: 'Vehicle / property', billed: 'Billed' };
function History({ rows, item }) {
  const val = (h, v) => (v == null ? '—' : ['amount', 'min_due', 'payment'].includes(h.field) ? money(Number(v), item.currency) : /date/.test(h.field || '') ? fmtDate(v) : v);
  return html`<ul class="hist">${rows.map((h) => html`<li><b>${h.by_name || 'System'}</b> ${h.action}${h.field && h.action === 'updated' ? html` <b>${FIELD_LABEL[h.field] || cap(h.field)}</b>: <s>${val(h, h.old_value)}</s> → ${val(h, h.new_value)}` : h.field === 'payment' ? html` · ${val(h, h.new_value ?? h.old_value)}` : ''}${h.note ? html` <span class="muted">(${h.note})</span>` : ''}
    <div class="muted small">${new Date(h.at).toLocaleString('en-GB', { timeZone: app.boot.settings.timezone, dateStyle: 'medium', timeStyle: 'short' })}</div></li>`)}</ul>`;
}

export function ItemDrawer({ id, onClose }) {
  const st = useLoad(`/api/items/${id}`);
  const [modal, setModal] = useState(null);
  useEffect(() => { const k = (e) => e.key === 'Escape' && !modal && onClose(); addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [modal]);
  const d = st.data;
  const attach = async (e) => { const f = e.target.files[0]; if (!f) return; try { await api('POST', `/api/items/${id}/documents`, f); toast('Document attached'); refresh(); } catch (err) { toast(err.message, true); } };
  const act = async (fn, msg) => { try { await fn(); toast(msg); refresh(); } catch (e) { toast(e.message, true); } };
  const it = d?.item;
  return html`<div class="scrim" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}><aside class="drawer" role="dialog" aria-label="Record details">
    ${!d ? html`<header><h2>Loading…</h2><button class="x" onClick=${onClose}>×</button></header><section><${Loading} state=${st} /></section>` : html`
    <header><div style="flex:1;min-width:0"><h2>${it.title}</h2><div class="row wrap" style="margin-top:6px;gap:6px"><${Status} item=${it} /><span class="chip plain">${it.direction === 'in' ? 'Money in' : 'Money out'}</span></div></div><button class="x" onClick=${onClose} aria-label="Close">×</button></header>
    <section>
      <div class="bal"><div><span>${it.kind === 'card_statement' ? 'Statement balance' : 'Amount'}</span><b class="num">${money(it.amount, it.currency)}</b></div>
        <div><span>${it.direction === 'in' ? 'Collected' : 'Paid'}${it.credited ? ' + credits' : ''}</span><b class="num">${num(it.paid + it.credited, it.currency)}</b></div>
        <div><span>Outstanding</span><b class="num ${it.overdue ? 'red' : ''}">${money(it.outstanding, it.currency)}</b></div></div>
      ${it.kind === 'card_statement' && it.min_due != null ? html`<p class="note" style="margin:10px 0 0">Minimum due <b class="num">${money(it.min_due, it.currency)}</b> by ${fmtDate(it.due_date)}.</p>` : ''}
      ${it.projected ? html`<p class="note warn" style="margin:10px 0 0">Projected from a generated schedule. It has not been checked against the lender’s own schedule.</p>` : ''}
      ${it.status !== 'void' ? html`<div class="row wrap" style="margin-top:12px">
        ${it.outstanding > 0 ? html`<button class="btn primary" onClick=${() => setModal('pay')}>${it.direction === 'in' ? 'Record money received' : 'Record payment'}</button>` : html`<button class="btn" onClick=${() => setModal('pay')}>Refund…</button>`}
        <button class="btn" onClick=${() => setModal('edit')}>Correct</button>
        <label class="btn">Attach document<input type="file" hidden accept="image/*,application/pdf" onChange=${attach} /></label>
        ${it.paid + it.credited === 0 ? html`<button class="btn danger" onClick=${() => confirm('Void this record? It stays in the history but no longer counts.') && act(() => POST(`/api/items/${id}/void`), 'Record voided')}>Void</button>` : ''}</div>` : ''}
    </section>
    <section><h3>Details</h3><dl class="kv">
      <dt>${it.direction === 'in' ? 'Who owes it' : 'Payee'}</dt><dd>${it.counterparty || '—'}</dd><dt>Reference</dt><dd>${it.reference || '—'}</dd>
      <dt>Due</dt><dd>${it.due_date ? html`${fmtDate(it.due_date)} <span class="muted">· ${it.outstanding > 0 ? rel(it.days_until) : 'settled'}</span>` : html`<span class="red">Missing — add a due date</span>`}</dd>
      <dt>Issued</dt><dd>${fmtDate(it.issue_date)}</dd><dt>Group</dt><dd>${GROUP_LABEL[it.grp]}${it.category_name ? ` · ${it.category_name}` : ''}</dd>
      ${it.entity_name ? html`<dt>${cap(it.entity_kind)}</dt><dd><a href="#/${it.entity_kind === 'vehicle' ? 'vehicles' : 'properties'}/${it.entity_id}" onClick=${onClose}>${it.entity_name}</a></dd>` : ''}
      ${it.account_name ? html`<dt>Card</dt><dd>${it.account_name}</dd>` : ''}<dt>Source</dt><dd>${cap(it.source)}${d.plan ? ` · ${d.plan.title}` : ''}</dd>${it.notes ? html`<dt>Notes</dt><dd>${it.notes}</dd>` : ''}</dl></section>
    <section><h3>Documents (${d.documents.length})</h3>
      ${d.documents.length ? d.documents.map((doc) => html`<div class="row" style="margin-bottom:6px"><button class="btn sm" onClick=${() => setModal({ doc })}>View</button><span style="overflow:hidden;text-overflow:ellipsis">${doc.filename}</span><span class="muted small">${doc.extract_method === 'ocr' ? 'scan, text read by OCR' : doc.extract_method === 'pdf-text' ? 'searchable' : ''}</span></div>`) : html`<p class="muted" style="margin:0">No invoice or statement attached yet.</p>`}</section>
    ${d.purchases.length ? html`<section><h3>Card purchases on this statement</h3><table class="t">${d.purchases.map((p) => html`<tr class="click" onClick=${() => openItem(p.item_id)}><td>${fmtDate(p.date)}</td><td>${p.title}</td><td class="right num">${money(p.amount, p.currency)}</td></tr>`)}</table><p class="muted small" style="margin:8px 0 0">These were paid by card. They are settled here and are not listed again as cash to pay.</p></section>` : ''}
    ${d.schedule.length ? html`<section><h3>Schedule · ${d.plan.verified ? 'lender’s schedule (verified)' : 'projected, not verified'}</h3>
      <div class="scroll-x" style="max-height:260px;overflow-y:auto"><table class="t"><tr><th>Due</th><th>Installment</th><th class="right">Amount</th><th class="right">Outstanding</th></tr>
        ${d.schedule.map((s) => html`<tr class="click" style=${s.id === it.id ? 'background:var(--green-bg)' : ''} onClick=${() => openItem(s.id)}><td class="nowrap">${fmtDate(s.due_date)}</td><td>${s.kind === 'balloon' ? html`<b>Balloon payment</b>` : s.title.split(' — ').pop()}</td><td class="right num">${num(s.amount, s.currency)}</td><td class="right num ${s.overdue ? 'red' : ''}">${s.outstanding ? num(s.outstanding, s.currency) : '✓'}</td></tr>`)}</table></div>
      <p class="small muted" style="margin:8px 0 0">Remaining balance ${money(d.plan.stats.remaining, it.currency)} · final payment ${fmtDate(d.plan.stats.final?.due_date)}
        ${!d.plan.verified ? html` · <a href="#" onClick=${(e) => { e.preventDefault(); confirm('Mark this schedule as checked against the lender’s own schedule?') && act(() => PATCH(`/api/plans/${d.plan.id}`, { verified: true }), 'Schedule marked as verified'); }}>Mark as verified</a>` : ''}</p></section>` : ''}
    <section><h3>Payments, credits and refunds</h3>
      ${d.payments.length ? html`<table class="t">${d.payments.map((p) => html`<tr style=${p.voided_at ? 'opacity:.5;text-decoration:line-through' : ''}><td class="nowrap">${fmtDate(p.date)}</td>
        <td>${cap(p.type)}${p.method ? ` · ${p.method === 'card' ? p.card_name || 'card' : p.method}` : ''}${p.note ? html`<div class="muted small">${p.note}</div>` : ''}${p.proof_document_id ? html`<div><a href="#" onClick=${(e) => { e.preventDefault(); setModal({ doc: { id: p.proof_document_id, filename: p.proof_filename } }); }}>Proof: ${p.proof_filename}</a></div>` : ''}<div class="muted small">by ${p.by_name || '—'}</div></td>
        <td class="right num">${p.type === 'refund' ? '−' : ''}${money(p.amount, it.currency)}</td><td>${!p.voided_at ? html`<button class="btn sm ghost" title="Void this entry" onClick=${() => confirm('Void this entry? The balance will be recalculated.') && act(() => POST(`/api/payments/${p.id}/void`), 'Entry voided')}>Void</button>` : ''}</td></tr>`)}</table>` : html`<p class="muted" style="margin:0">Nothing recorded yet.</p>`}</section>
    <section><h3>History of changes</h3><${History} rows=${d.history} item=${it} /></section>`}
    ${modal === 'pay' ? html`<${PaymentForm} item=${it} onClose=${() => setModal(null)} />` : ''}${modal === 'edit' ? html`<${EditForm} item=${it} onClose=${() => setModal(null)} />` : ''}${modal?.doc ? html`<${DocViewer} doc=${modal.doc} onClose=${() => setModal(null)} />` : ''}
  </aside></div>`;
}

// ---- new entry ----
const TYPES = [['one', 'One-off bill or invoice'], ['recurring', 'Recurring'], ['schedule', 'Installments / loan'], ['statement', 'Card statement']];
export function NewEntry({ preset = {}, onClose }) {
  const base = app.boot.settings.base_currency;
  const cards = app.boot.accounts.filter((a) => a.type === 'card');
  const [type, setType] = useState(preset.type || 'one');
  const [v, bind, set] = useForm({ direction: 'out', title: '', counterparty: '', reference: '', amount: '', currency: base, issue_date: '', due_date: '', amount_status: 'confirmed', category_id: '', entity_id: '', frequency: 'monthly', interval_n: 1, count: 12, balloon: '', verified: false, is_loan: false, account_id: cards[0]?.id || '', min_due: '', ...preset });
  const [rows, setRows] = useState([]);
  const act = useAction();
  const cur = String(v.currency || base).toUpperCase();
  const generate = () => {
    const amt = v.amount, n = Math.max(1, Math.min(Number(v.count) || 1, 480));
    if (!v.due_date) return act.setError(new Error('Enter the first due date, then generate.'));
    const step = { weekly: 0, monthly: 1, quarterly: 3, yearly: 12 }[v.frequency];
    const out = Array.from({ length: n }, (_, i) => ({ due_date: addMonths(v.due_date, step * i), amount: amt, kind: 'installment' }));
    if (v.balloon) out.push({ due_date: addMonths(v.due_date, step * n), amount: v.balloon, kind: 'balloon' });
    setRows(out); act.setError(null);
  };
  const save = () => act.run(async () => {
    const common = { direction: v.direction, title: v.title, counterparty: v.counterparty, currency: cur, category_id: v.category_id || null, entity_id: v.entity_id || null };
    if (type === 'one') await POST('/api/items', { ...common, reference: v.reference, amount: toMinor(v.amount, cur), issue_date: v.issue_date || null, due_date: v.due_date || null, amount_status: v.amount_status, billed: v.amount_status === 'confirmed', kind: v.direction === 'in' ? 'invoice' : 'bill' });
    else if (type === 'recurring') await POST('/api/plans', { ...common, type: 'recurring', amount: toMinor(v.amount, cur), frequency: v.frequency, interval_n: Number(v.interval_n) || 1, anchor_date: v.due_date, end_date: v.end_date || null, amount_status: v.amount_status === 'confirmed' ? 'confirmed' : 'estimated' });
    else if (type === 'schedule') {
      if (!rows.length) throw new Error('Add the installments first (generate them or add rows).');
      await POST('/api/plans', { ...common, type: v.is_loan ? 'loan' : 'schedule', verified: !!v.verified, rows: rows.map((r) => ({ due_date: r.due_date, amount: toMinor(r.amount, cur), kind: r.kind })) });
    } else {
      if (!v.account_id) throw new Error('Add the card first under Loans & cards.');
      await POST('/api/items', { direction: 'out', kind: 'card_statement', title: v.title || `${cards.find((c) => c.id === Number(v.account_id))?.name} statement`, counterparty: v.counterparty, reference: v.reference, account_id: Number(v.account_id), amount: toMinor(v.amount, cur), min_due: toMinor(v.min_due, cur), currency: cur, issue_date: v.issue_date || null, due_date: v.due_date || null, category_id: app.boot.categories.find((c) => c.name === 'Credit card statement')?.id });
    }
    toast('Saved'); refresh(); onClose();
  });
  const setRow = (i, k, val) => setRows((r) => r.map((x, j) => (j === i ? { ...x, [k]: val } : x)));
  return html`<${Modal} title="New entry" onClose=${onClose} footer=${html`<button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" disabled=${act.busy} onClick=${save}>Save</button>`}>
    <div class="stack">
      <div class="seg" style="flex-wrap:wrap">${TYPES.map(([k, l]) => html`<button class=${type === k ? 'on' : ''} onClick=${() => setType(k)}>${l}</button>`)}</div>
      ${act.error ? html`<div class="err">${act.error.message}</div>` : ''}
      ${type !== 'statement' ? html`<div class="grid2"><${F} label="Direction"><select ...${bind('direction')}><option value="out">Money out — I pay</option><option value="in">Money in — owed to me</option></select><//>
        <${F} label="Title"><input type="text" placeholder=${type === 'recurring' ? 'e.g. School bus' : 'e.g. Annual AC contract'} ...${bind('title')} /><//>
        <${F} label=${v.direction === 'in' ? 'Who owes it' : 'Payee / supplier'}><input type="text" ...${bind('counterparty')} /><//>
        ${type === 'one' ? html`<${F} label="Reference / invoice no."><input type="text" ...${bind('reference')} /><//>` : html`<${F} label="Currency"><input type="text" maxlength="3" ...${bind('currency')} /><//>`}</div>` : html`<div class="grid2">
        <${F} label="Card"><select ...${bind('account_id')}>${cards.map((c) => html`<option value=${c.id}>${c.name}</option>`)}</select><//><${F} label="Statement reference"><input type="text" ...${bind('reference')} /><//>
        <${F} label="Statement balance (${cur})"><input type="text" inputmode="decimal" ...${bind('amount')} /><//><${F} label="Minimum due"><input type="text" inputmode="decimal" ...${bind('min_due')} /><//>
        <${F} label="Statement date"><input type="date" ...${bind('issue_date')} /><//><${F} label="Payment due date"><input type="date" ...${bind('due_date')} /><//></div>
        <div class="note">Card purchases you recorded before the statement date are linked to it automatically, so they are not counted twice.</div>`}
      ${type === 'one' ? html`<div class="grid3"><${F} label="Amount"><input type="text" inputmode="decimal" ...${bind('amount')} /><//><${F} label="Currency"><input type="text" maxlength="3" ...${bind('currency')} /><//>
          <${F} label="Amount is"><select ...${bind('amount_status')}><option value="confirmed">Confirmed</option><option value="estimated">Estimated (not billed yet)</option><option value="needs_review">Needs review</option></select><//>
          <${F} label="Issue date"><input type="date" ...${bind('issue_date')} /><//><${F} label="Due date" hint="Leave empty to park it in Needs Review"><input type="date" ...${bind('due_date')} /><//></div>` : ''}
      ${type === 'recurring' ? html`<div class="grid3"><${F} label="Amount each time"><input type="text" inputmode="decimal" ...${bind('amount')} /><//>
          <${F} label="Repeats"><select ...${bind('frequency')}><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="yearly">Yearly</option></select><//>
          <${F} label="Every" hint="e.g. 2 = every second month"><input type="number" min="1" ...${bind('interval_n')} /><//>
          <${F} label="First due date"><input type="date" ...${bind('due_date')} /><//><${F} label="Ends (optional)"><input type="date" ...${bind('end_date')} /><//>
          <${F} label="Amount is"><select ...${bind('amount_status')}><option value="estimated">Estimated until the bill arrives</option><option value="confirmed">Fixed (e.g. salary, subscription)</option></select><//></div>` : ''}
      ${type === 'schedule' ? html`
        <div class="note">Enter the lender’s or landlord’s actual dates and amounts if you have them. A generated schedule is labelled “projected, not verified” until you confirm it.</div>
        <div class="grid3"><${F} label="Installment amount"><input type="text" inputmode="decimal" ...${bind('amount')} /><//><${F} label="First due date"><input type="date" ...${bind('due_date')} /><//>
          <${F} label="How many"><input type="number" min="1" ...${bind('count')} /><//>
          <${F} label="Repeats"><select ...${bind('frequency')}><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="yearly">Yearly</option></select><//>
          <${F} label="Final balloon (optional)"><input type="text" inputmode="decimal" ...${bind('balloon')} /><//><div style="align-self:end"><button class="btn" onClick=${generate}>Generate rows</button></div></div>
        <div class="row wrap"><label class="check"><input type="checkbox" checked=${v.is_loan} onChange=${(e) => set((s) => ({ ...s, is_loan: e.target.checked }))} />This is a loan or mortgage</label>
          <label class="check"><input type="checkbox" checked=${v.verified} onChange=${(e) => set((s) => ({ ...s, verified: e.target.checked }))} />These rows match the lender’s / landlord’s own schedule (verified)</label></div>
        ${rows.length ? html`<div class="scroll-x" style="max-height:230px;overflow-y:auto"><table class="t"><tr><th>#</th><th>Due date</th><th>Amount (${cur})</th><th>Type</th><th></th></tr>
          ${rows.map((r, i) => html`<tr><td>${i + 1}</td><td class="cell-edit"><input type="date" value=${r.due_date} onInput=${(e) => setRow(i, 'due_date', e.target.value)} /></td><td class="cell-edit"><input type="text" value=${r.amount} onInput=${(e) => setRow(i, 'amount', e.target.value)} /></td>
            <td class="cell-edit"><select value=${r.kind} onChange=${(e) => setRow(i, 'kind', e.target.value)}><option value="installment">Installment</option><option value="balloon">Balloon</option></select></td><td><button class="btn sm ghost" onClick=${() => setRows((x) => x.filter((_, j) => j !== i))}>Remove</button></td></tr>`)}</table></div>` : ''}
        <button class="btn sm" onClick=${() => setRows((r) => [...r, { due_date: r.length ? addMonths(r[r.length - 1].due_date || app.boot.today, 1) : v.due_date || app.boot.today, amount: v.amount, kind: 'installment' }])}>+ Add a row</button>` : ''}
      ${type !== 'statement' ? html`<${CatEntityFields} v=${v} bind=${bind} set=${set} />` : ''}
    </div><//>`;
}
export { CatEntityFields };
