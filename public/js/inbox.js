// Import Inbox: paper files (split-screen review), spreadsheets, statements + matching, needs review.
import { html, useState, useEffect, useRef, useLoad, app, GET, POST, PATCH, api, refresh, toast, Modal, F, Panel, Loading, Entry, useForm, useAction, money, num, toMinor, fromMinor, fmtDate, openItem, openNew, go, GROUP_LABEL, Original } from './lib.js';
import { CatEntityFields } from './item.js';

const TABS = [['paper', 'Paper files'], ['sheets', 'Excel & CSV'], ['statements', 'Bank & card statements'], ['review', 'Needs review']];

function Drop({ accept, multiple, onFiles, busy, children }) {
  const [over, setOver] = useState(false);
  const ref = useRef();
  return html`<div class="drop ${over ? 'over' : ''}" onDragOver=${(e) => { e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)} onDrop=${(e) => { e.preventDefault(); setOver(false); onFiles([...e.dataTransfer.files]); }}>
    <div>${children}</div><div class="row" style="justify-content:center;margin-top:10px">
      <button class="btn primary" disabled=${!!busy} onClick=${() => ref.current.click()}>${busy || 'Choose files'}</button>
      <input ref=${ref} type="file" hidden accept=${accept} multiple=${multiple} onChange=${(e) => { onFiles([...e.target.files]); e.target.value = ''; }} /></div></div>`;
}
function Samples() {
  const s = app.boot.samples;
  if (!s?.length) return '';
  return html`<div class="note"><b>Try it with fictional sample files</b> (download, then upload in the matching tab):<ul style="margin:6px 0 0;padding-left:18px">${s.map((x) => html`<li><a href=${`/api/demo/samples/${x.file}`}>${x.label}</a> <span class="muted">— ${x.hint}</span></li>`)}</ul></div>`;
}

// ---------------- paper files ----------------
function DocReview({ imp, onDone, onSkip }) {
  const f = imp.fields;
  const base = app.boot.settings.base_currency;
  const cur = f.currency?.value || base;
  const [v, bind, set] = useForm({ direction: 'out', counterparty: f.supplier?.value || '', reference: f.reference?.value || '', amount: f.amount?.value != null ? fromMinor(f.amount.value, cur) : '', currency: cur, issue_date: f.issue_date?.value || '', due_date: f.due_date?.value || '', title: '', category_id: '', entity_id: '', match: imp.forecast_matches?.[0]?.id || '' });
  const [dups, setDups] = useState(null);
  const [showText, setShowText] = useState(false);
  const text = useLoad(showText ? `/api/documents/${imp.document.id}/text` : null);
  const act = useAction();
  const unsure = (k) => !f[k] || f[k].confidence < 0.7;
  const hint = (k) => (f[k]?.value == null ? f[k]?.note || 'Not found — enter it by hand' : unsure(k) ? `${f[k].note || 'Low confidence'} (${Math.round(f[k].confidence * 100)}% sure)` : f[k].note);
  const confirm = (force) => act.run(async () => {
    const c = String(v.currency).toUpperCase();
    const amount = toMinor(v.amount, c);
    if (amount == null) throw new Error('Enter the amount.');
    try {
      const r = await POST(`/api/imports/${imp.id}/confirm`, { direction: v.direction, counterparty: v.counterparty, reference: v.reference, amount, currency: c, issue_date: v.issue_date || null, due_date: v.due_date || null, title: v.title, category_id: v.category_id || null, entity_id: v.entity_id || null, match_item_id: v.match ? Number(v.match) : null, force });
      toast(r.matched_forecast ? 'Confirmed — the forecast became this bill (no duplicate)' : v.due_date ? 'Confirmed and added to the timeline' : 'Saved to Needs Review (no due date yet)'); refresh(); onDone();
    } catch (e) { if (e.status === 409) setDups(e.data.duplicates); else throw e; }
  });
  useEffect(() => { const k = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') confirm(false); }; addEventListener('keydown', k); return () => removeEventListener('keydown', k); });
  const src = `/api/documents/${imp.document.id}/file`;
  const d = imp.document;
  return html`<div class="viewer"><div class="bar"><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${d.filename}</span>
        <button onClick=${() => setShowText(!showText)}>${showText ? 'Show original' : 'Show extracted text'}</button><a href=${src} target="_blank" rel="noopener">Open</a></div>
      ${showText ? html`<pre>${text.data ? text.data.text || '(no text could be read)' : 'Loading…'}</pre>` : html`<${Original} doc=${d} />`}</div>
    <div class="panel"><div class="body stack">
      <div class="row"><h2 style="margin-right:auto">Extracted fields</h2><span class="chip plain">${d.extract_method === 'ocr' ? `OCR · ${Math.round((d.ocr_confidence || 0) * 100)}% legible` : d.extract_method === 'pdf-text' ? 'PDF text' : 'Manual entry'}</span></div>
      ${imp.meta.extract_error ? html`<div class="note warn">${imp.meta.extract_error}</div>` : ''}
      ${Object.keys(f).some(unsure) ? html`<div class="note warn">Fields outlined in amber are uncertain. Check them against the original before confirming.</div>` : html`<div class="note ok">All fields were read with good confidence. Still worth a glance.</div>`}
      ${act.error ? html`<div class="err">${act.error.message}</div>` : ''}
      <${F} label="Supplier" unsure=${unsure('supplier')} hint=${hint('supplier')}><input type="text" ...${bind('counterparty')} /><//>
      <div class="grid2"><${F} label="Reference" unsure=${unsure('reference')} hint=${hint('reference')}><input type="text" ...${bind('reference')} /><//>
        <${F} label="Amount" unsure=${unsure('amount')} hint=${hint('amount')}><input type="text" inputmode="decimal" ...${bind('amount')} /><//>
        <${F} label="Currency" unsure=${unsure('currency')} hint=${hint('currency')}><input type="text" maxlength="3" ...${bind('currency')} /><//>
        <${F} label="Direction"><select ...${bind('direction')}><option value="out">Bill — I pay</option><option value="in">Invoice — owed to me</option></select><//>
        <${F} label="Issue date" unsure=${unsure('issue_date')} hint=${hint('issue_date')}><input type="date" ...${bind('issue_date')} /><//>
        <${F} label="Due date" unsure=${unsure('due_date')} hint=${hint('due_date') || (v.due_date ? '' : 'Without a due date it goes to Needs Review')}><input type="date" ...${bind('due_date')} /><//></div>
      ${imp.forecast_matches?.length ? html`<${F} label="Matches a forecast" hint="Matching turns the estimate into this bill, so it appears once."><select ...${bind('match')}>
        ${imp.forecast_matches.map((m) => html`<option value=${m.id}>${m.title} · ${money(m.amount, m.currency)} est. · due ${fmtDate(m.due_date)} — ${m.reason}</option>`)}<option value="">No — add as a separate bill</option></select><//>` : ''}
      ${!v.match ? html`<${F} label="Title (optional)"><input type="text" placeholder="Defaults to supplier · reference" ...${bind('title')} /><//><${CatEntityFields} v=${v} bind=${bind} set=${set} />` : ''}
      ${imp.duplicates?.length && !dups ? html`<div class="note warn">Possible duplicate: ${imp.duplicates.map((x) => html`<a href="#" onClick=${(e) => { e.preventDefault(); openItem(x.id); }}>${x.title}</a> (${x.why}) `)}</div>` : ''}
      ${dups ? html`<div class="err">This looks like a bill already recorded: ${dups.map((x) => html`<a href="#" onClick=${(e) => { e.preventDefault(); openItem(x.id); }}>${x.title}</a> (${x.why}) `)}
        <div class="row" style="margin-top:8px"><button class="btn sm" onClick=${() => confirm(true)}>Add anyway</button><button class="btn sm" onClick=${() => POST(`/api/imports/${imp.id}/discard`).then(() => { refresh(); onDone(); })}>Discard this scan</button></div></div>` : ''}
      <div class="row wrap"><button class="btn primary" disabled=${act.busy} onClick=${() => confirm(false)}>Confirm & next</button><button class="btn" onClick=${onSkip}>Skip</button><span class="spacer"></span>
        <button class="btn danger" onClick=${() => window.confirm('Discard this upload? The file stays stored but no record is created.') && POST(`/api/imports/${imp.id}/discard`).then(() => { refresh(); onDone(); })}>Discard</button></div>
      <div class="small muted">Tip: Ctrl/⌘ + Enter confirms and moves to the next document.</div></div></div>`;
}

function Paper({ inbox }) {
  const queue = inbox.imports.filter((i) => i.type === 'document' && i.status === 'review');
  const [sel, setSel] = useState(null);
  const [busy, setBusy] = useState(null);
  const current = queue.find((i) => i.id === sel) || queue[0];
  const upload = async (files) => {
    let n = 0, last = null;
    for (const file of files) {
      setBusy(`Reading ${++n} of ${files.length}…`);
      try { const r = await api('POST', '/api/imports/document', file); last = r.import; if (r.already) toast(`“${file.name}” was already uploaded — nothing duplicated${r.import.status === 'done' ? ' (already confirmed)' : ''}`); } catch (e) { toast(`${file.name}: ${e.message}`, true); }
    }
    setBusy(null); refresh(); if (last?.status === 'review') setSel(last.id);
  };
  const next = () => { const i = queue.findIndex((x) => x.id === current?.id); setSel(queue[i + 1]?.id ?? null); };
  return html`<div class="stack">
    <${Drop} accept="image/*,application/pdf" multiple=${true} onFiles=${upload} busy=${busy}><b>Drop scans, photos or PDFs here</b><div class="muted small">Up to 25 MB each. Text is read on this computer (${inbox.ocr.engine}, language: ${inbox.ocr.languages}). Nothing is sent to an outside service.</div><//>
    <div class="row"><span class="muted">No scan to hand?</span><button class="btn sm" onClick=${() => openNew()}>Enter a bill by hand</button></div>
    ${current ? html`<div class="review"><div class="panel queue"><header style="padding-bottom:10px"><h2>To review (${queue.length})</h2></header>
        ${queue.map((q) => html`<button class=${q.id === current.id ? 'on' : ''} onClick=${() => setSel(q.id)}><b>${q.fields.supplier?.value || q.document.filename}</b><span class="muted small">${q.fields.amount?.value != null ? money(q.fields.amount.value, q.fields.currency?.value || 'AED') : 'amount not read'} · ${q.document.filename}</span></button>`)}</div>
      <${DocReview} key=${current.id} imp=${current} onDone=${next} onSkip=${next} /></div>` : html`<div class="panel"><div class="empty">The paper queue is clear. Upload more files above.</div></div>`}
  </div>`;
}

// ---------------- table import (spreadsheets + statements) ----------------
const SHEET_FIELDS = [['title', 'Description'], ['counterparty', 'Supplier / payer'], ['reference', 'Reference'], ['amount', 'Amount *'], ['currency', 'Currency'], ['issue_date', 'Issue date'], ['due_date', 'Due date'], ['direction', 'Direction (in/out)'], ['category', 'Category'], ['entity', 'Vehicle / property'], ['paid_amount', 'Already paid'], ['paid_date', 'Paid date']];
const STMT_FIELDS = [['date', 'Date *'], ['description', 'Description *'], ['reference', 'Reference'], ['amount', 'Amount (one column)'], ['debit', 'Money out'], ['credit', 'Money in'], ['currency', 'Currency']];
const ROW_LABEL = { ready: 'Ready', error: 'Fix needed', duplicate: 'Duplicate', forecast: 'Confirms forecast', review: 'No due date', imported: 'Imported', pending: 'Pending' };

function TableImport({ id, onClose }) {
  const st = useLoad(`/api/imports/${id}`);
  const [include, setInclude] = useState({});
  const [result, setResult] = useState(null);
  const act = useAction();
  const imp = st.data;
  if (!imp) return html`<${Modal} title="Import" onClose=${onClose} wide=${true}><${Loading} state=${st} /><//>`;
  const sheet = imp.type === 'sheet';
  const m = imp.meta;
  const patch = (body) => act.run(async () => { await PATCH(`/api/imports/${id}`, body); refresh(); });
  const setMap = (field, val) => patch({ mapping: { ...m.mapping, [field]: val === '' ? null : Number(val) } });
  const commit = () => act.run(async () => { const r = await POST(`/api/imports/${id}/commit`, { include_duplicates: Object.keys(include).filter((k) => include[k]).map(Number) }); setResult(r.result); refresh(); });
  const saveCell = async (row, col, val) => { if (val === row.raw[col]) return; const cells = [...row.raw]; cells[col] = val; try { await PATCH(`/api/import-rows/${row.id}`, { cells }); refresh(); } catch (e) { toast(e.message, true); } };
  const c = imp.counts;
  const pending = (c.ready || 0) + (c.forecast || 0) + (c.review || 0) + Object.values(include).filter(Boolean).length;
  const cols = (sheet ? SHEET_FIELDS : STMT_FIELDS).filter(([k]) => m.mapping[k] != null);
  return html`<${Modal} title=${`${sheet ? 'Spreadsheet' : 'Statement'}: ${m.filename}`} onClose=${onClose} wide=${true} footer=${html`
      <span class="muted small" style="margin-right:auto">${c.imported || 0} imported · ${c.error || 0} to fix · ${c.duplicate || 0} duplicate(s)</span>
      <button class="btn" onClick=${onClose}>Close</button><button class="btn primary" disabled=${act.busy || !pending} onClick=${commit}>Import ${pending} row(s)</button>`}>
    <div class="stack">
      ${act.error ? html`<div class="err">${act.error.message}</div>` : ''}
      ${result ? html`<div class="note ok"><b>${result.imported} row(s) imported.</b> ${result.matched_forecast ? `${result.matched_forecast} confirmed an existing forecast (no duplicate). ` : ''}${result.needs_review ? `${result.needs_review} went to Needs Review (no due date). ` : ''}${result.skipped_duplicates ? `${result.skipped_duplicates} duplicate(s) skipped. ` : ''}${result.errors ? html`<b>${result.errors} still need fixing below</b> — edit the highlighted cells and import again.` : ''}
        ${!sheet && result.imported ? html` <a href="#/inbox/statements" onClick=${onClose}>Go to matching →</a>` : ''}</div>` : ''}
      <details open=${!result && !c.imported}><summary><b>1 · Map the columns</b> <span class="muted small">(guessed from the header row; change anything that is wrong)</span></summary>
        <div class="grid3" style="margin-top:10px">${(sheet ? SHEET_FIELDS : STMT_FIELDS).map(([k, l]) => html`<${F} label=${l}><select value=${m.mapping[k] ?? ''} onChange=${(e) => setMap(k, e.target.value)}><option value="">— not in file —</option>${m.headers.map((h, i) => html`<option value=${i}>${h}</option>`)}</select><//>`)}
          <${F} label="Dates like 03/04/2026 are"><select value=${m.date_order} onChange=${(e) => patch({ date_order: e.target.value })}><option value="DMY">Day / month (3 April)</option><option value="MDY">Month / day (4 March)</option></select><//>
          <${F} label="Default currency"><input type="text" maxlength="3" value=${m.defaults.currency} onChange=${(e) => patch({ defaults: { ...m.defaults, currency: e.target.value } })} /><//>
          ${sheet ? html`<${F} label="Rows are (if no direction column)"><select value=${m.defaults.direction} onChange=${(e) => patch({ defaults: { ...m.defaults, direction: e.target.value } })}><option value="out">Bills I pay</option><option value="in">Money owed to me</option></select><//>
            <${F} label="Default category"><select value=${m.defaults.category_id ?? ''} onChange=${(e) => patch({ defaults: { ...m.defaults, category_id: e.target.value } })}><option value="">—</option>${app.boot.categories.map((x) => html`<option value=${x.id}>${GROUP_LABEL[x.group_kind]} · ${x.name}</option>`)}</select><//>`
            : html`<${F} label="A single amount column means" hint="Only used when there are no separate in/out columns"><select value=${m.positive_is_out ? '1' : '0'} onChange=${(e) => patch({ positive_is_out: e.target.value === '1' })}><option value="0">Negative = money out</option><option value="1">Positive = money out (card statements)</option></select><//>`}</div></details>
      <div><b>2 · Check the rows</b> <span class="muted small">Cells in rows that need fixing can be edited here.</span></div>
      <div class="scroll-x" style="max-height:46vh;overflow-y:auto"><table class="t"><tr><th>#</th><th>Status</th>${cols.map(([, l]) => html`<th>${l.replace(' *', '')}</th>`)}<th>Notes</th></tr>
        ${imp.rows.map((r) => html`<tr><td>${r.row_index}</td><td><span class="rowstat ${r.status}">${ROW_LABEL[r.status]}</span>${r.status === 'duplicate' && sheet ? html`<label class="check small" style="margin-top:4px"><input type="checkbox" checked=${!!include[r.id]} onChange=${(e) => setInclude((s) => ({ ...s, [r.id]: e.target.checked }))} />import anyway</label>` : ''}</td>
          ${cols.map(([k]) => r.status === 'error' ? html`<td class="cell-edit"><input type="text" value=${r.raw[m.mapping[k]]} onBlur=${(e) => saveCell(r, m.mapping[k], e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && e.target.blur()} /></td>` : html`<td>${r.raw[m.mapping[k]]}</td>`)}
          <td class="small ${r.status === 'error' ? 'red' : 'muted'}">${r.status === 'forecast' ? `Confirms “${r.parsed.match_title}” instead of adding a second entry` : r.status === 'review' ? 'Will be kept visible in Needs Review' : r.message || ''}${r.item_id ? html` <a href="#" onClick=${(e) => { e.preventDefault(); openItem(r.item_id); }}>open</a>` : ''}</td></tr>`)}</table></div>
    </div><//>`;
}

function Sheets({ inbox, type }) {
  const sheet = type === 'sheet';
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(null);
  const accounts = app.boot.accounts;
  const [account, setAccount] = useState(accounts[0]?.id || '');
  const upload = async (files) => {
    if (!sheet && !account) return toast('Add the bank account or card first (Loans & cards).', true);
    setBusy('Reading…');
    try { const r = await api('POST', sheet ? '/api/imports/sheet' : `/api/imports/statement?account_id=${account}`, files[0]); if (r.already) toast('This exact file was imported before — showing that import, nothing was added twice.'); refresh(); setOpen(r.import.id); } catch (e) { toast(e.message, true); }
    setBusy(null);
  };
  const list = inbox.imports.filter((i) => i.type === type);
  return html`<div class="stack">
    ${!sheet ? html`<div class="row wrap"><b>Statement for</b><select style="width:auto;min-width:240px" value=${account} onChange=${(e) => setAccount(e.target.value)}>${accounts.map((a) => html`<option value=${a.id}>${a.name} (${a.type === 'card' ? 'card' : 'bank'})</option>`)}</select><a href="#/finance">Add an account or card</a></div>` : ''}
    <${Drop} accept=".csv,.xlsx,text/csv" multiple=${false} onFiles=${upload} busy=${busy}><b>Drop ${sheet ? 'an Excel or CSV file' : 'a bank or card statement (CSV or Excel)'} here</b>
      <div class="muted small">${sheet ? 'You will see every row, map the columns and fix problems before anything is saved.' : 'PDF statements can be attached to a record as documents, but only CSV/Excel exports are read line by line.'}</div><//>
    ${list.length ? html`<${Panel} pad=${false} title="Imports"><table class="t"><tr><th>File</th><th>Uploaded</th><th>Rows</th><th></th></tr>
      ${list.map((i) => html`<tr class="click" onClick=${() => setOpen(i.id)}><td><b>${i.meta.filename}</b></td><td>${fmtDate(i.created_at.slice(0, 10))}</td>
        <td>${Object.entries(i.counts).map(([k, n]) => html`<span class="rowstat ${k}" style="margin-right:5px">${n} ${ROW_LABEL[k].toLowerCase()}</span>`)}</td><td class="right"><span class="chip ${i.status === 'done' ? 'paid' : 'needs_review'}">${i.status === 'done' ? 'Finished' : 'Needs attention'}</span></td></tr>`)}</table><//>` : ''}
    ${!sheet ? html`<${Matching} />` : ''}
    ${open ? html`<${TableImport} id=${open} onClose=${() => setOpen(null)} />` : ''}</div>`;
}

// ---------------- statement matching ----------------
function SplitModal({ txn, onClose }) {
  const dir = txn.amount < 0 ? 'out' : 'in';
  const [q, setQ] = useState('');
  const st = useLoad(`/api/items?state=open&direction=${dir}&q=${encodeURIComponent(q)}`);
  const [alloc, setAlloc] = useState(Object.fromEntries((txn.suggestions || []).slice(0, 1).map((s) => [s.item_id, fromMinor(s.suggested_amount, txn.currency)])));
  const act = useAction();
  const free = Math.abs(txn.amount) - txn.allocated;
  const total = Object.values(alloc).reduce((s, v) => s + (toMinor(v, txn.currency) || 0), 0);
  const items = (st.data?.items || []).filter((i) => i.currency === txn.currency);
  const save = () => act.run(async () => { await POST(`/api/txns/${txn.id}/match`, { allocations: Object.entries(alloc).filter(([, v]) => toMinor(v, txn.currency) > 0).map(([id, v]) => ({ item_id: Number(id), amount: toMinor(v, txn.currency) })) }); toast('Matched'); refresh(); onClose(); });
  return html`<${Modal} title="Match or split this transaction" onClose=${onClose} wide=${true} footer=${html`<span style="margin-right:auto" class=${total > free ? 'red' : 'muted'}>Allocated ${money(total, txn.currency)} of ${money(free, txn.currency)}${total < free ? ` · ${money(free - total, txn.currency)} left unmatched` : ''}</span><button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" disabled=${act.busy || !total || total > free} onClick=${save}>Confirm match</button>`}>
    <div class="stack"><div class="note"><b>${fmtDate(txn.date)} · ${txn.description}</b> · <span class="num">${money(Math.abs(txn.amount), txn.currency)}</span> ${dir === 'out' ? 'paid out' : 'received'}. Enter an amount next to each record this payment covers.</div>
      ${act.error ? html`<div class="err">${act.error.message}</div>` : ''}<input type="search" placeholder="Search open records…" value=${q} onInput=${(e) => setQ(e.target.value)} />
      <div class="scroll-x" style="max-height:44vh;overflow-y:auto"><table class="t"><tr><th>Due</th><th>Record</th><th class="right">Outstanding</th><th style="width:150px">Allocate</th></tr>
        ${items.map((i) => html`<tr><td class="nowrap">${fmtDate(i.due_date)}</td><td><b>${i.title}</b><div class="small muted">${i.counterparty || ''} ${i.reference || ''}</div></td><td class="right num">${num(i.outstanding, i.currency)}</td>
          <td class="cell-edit"><div class="row"><input type="text" inputmode="decimal" value=${alloc[i.id] || ''} onInput=${(e) => setAlloc((s) => ({ ...s, [i.id]: e.target.value }))} /><button class="btn sm" title="Fill" onClick=${() => setAlloc((s) => ({ ...s, [i.id]: fromMinor(Math.min(i.outstanding, Math.max(free - total + (toMinor(s[i.id], txn.currency) || 0), 0)), txn.currency) }))}>Fill</button></div></td></tr>`)}
        ${!items.length ? html`<tr><td colspan="4" class="muted">No open ${dir === 'out' ? 'bills' : 'receivables'} found.</td></tr>` : ''}</table></div></div><//>`;
}

function Matching() {
  const st = useLoad('/api/txns');
  const [split, setSplit] = useState(null);
  const [show, setShow] = useState('unmatched');
  if (!st.data) return html`<${Loading} state=${st} />`;
  if (!st.data.length) return '';
  const act = async (fn, msg) => { try { await fn(); toast(msg); refresh(); } catch (e) { toast(e.message, true); } };
  const count = (s) => st.data.filter((t) => t.status === s).length;
  const list = st.data.filter((t) => (show === 'aside' ? ['transfer', 'ignored'].includes(t.status) : t.status === show));
  return html`<div><div class="row wrap" style="margin:6px 0 12px"><h2 style="margin-right:auto">Match transactions</h2>
      <div class="seg">${[['unmatched', `To match (${count('unmatched')})`], ['matched', `Matched (${count('matched')})`], ['aside', `Transfers & ignored (${count('transfer') + count('ignored')})`]].map(([k, l]) => html`<button class=${show === k ? 'on' : ''} onClick=${() => setShow(k)}>${l}</button>`)}</div></div>
    ${list.map((t) => html`<div class="txn"><div class="h"><span class="muted nowrap">${fmtDate(t.date)}</span><b style="flex:1;min-width:200px">${t.description}</b><span class="muted small">${t.account_name}${t.reference ? ` · ${t.reference}` : ''}</span>
        <b class="num ${t.amount > 0 ? 'green' : ''}">${t.amount > 0 ? '+' : '−'}${money(Math.abs(t.amount), t.currency)}</b></div>
      ${t.status === 'unmatched' ? html`
        ${t.txn_kind === 'card_repayment' ? html`<div class="sugg note" style="border-radius:0;border-width:1px 0 0">This looks like a card repayment. Match it to the card statement so the purchases on that card are not counted a second time.</div>` : ''}
        ${t.suggestions.map((s, i) => html`<div class="sugg"><div class="grow"><b>${i === 0 ? 'Suggested: ' : 'Or: '}<a href="#" onClick=${(e) => { e.preventDefault(); openItem(s.item_id); }}>${s.title}</a></b> <span class="muted">${s.counterparty || ''} · due ${fmtDate(s.due_date)} · ${money(s.outstanding, s.currency)} outstanding</span>
            <ul>${s.reasons.map((r) => html`<li>${r}</li>`)}</ul></div>
          <button class="btn ${i === 0 ? 'primary' : ''}" onClick=${() => act(() => POST(`/api/txns/${t.id}/match`, { allocations: [{ item_id: s.item_id, amount: s.suggested_amount }] }), s.suggested_amount < s.outstanding ? 'Matched as a part payment' : 'Matched')}>Confirm${s.suggested_amount < Math.abs(t.amount) ? ` ${money(s.suggested_amount, s.currency)}` : ''}</button></div>`)}
        <div class="sugg">${!t.suggestions.length ? html`<span class="muted grow">No confident match found.</span>` : html`<span class="grow"></span>`}
          <button class="btn" onClick=${() => setSplit(t)}>Choose or split…</button><button class="btn" onClick=${() => act(() => POST(`/api/txns/${t.id}/mark`, { status: 'transfer' }), 'Set aside as a transfer')}>Transfer between own accounts</button>
          <button class="btn" onClick=${() => act(() => POST(`/api/txns/${t.id}/mark`, { status: 'ignored' }), 'Left unmatched')}>Leave unmatched</button></div>`
      : html`<div class="sugg"><span class="grow">${t.status === 'matched' ? html`Matched to ${t.matches.map((m) => html`<a href="#" onClick=${(e) => { e.preventDefault(); openItem(m.item_id); }}>${m.title}</a> (${money(m.amount, t.currency)}) `)}${t.allocated < Math.abs(t.amount) ? html`<span class="muted">· ${money(Math.abs(t.amount) - t.allocated, t.currency)} not allocated</span>` : ''}`
          : t.status === 'transfer' ? 'Transfer or card repayment mirror — not counted as spending or income.' : 'Left unmatched — not linked to any record.'}</span>
          ${t.status === 'matched' && t.allocated < Math.abs(t.amount) ? html`<button class="btn sm" onClick=${() => setSplit(t)}>Allocate the rest…</button>` : ''}
          <button class="btn sm" onClick=${() => (t.status !== 'matched' || confirm('Undo this match? The payments it recorded will be voided.')) && act(() => POST(`/api/txns/${t.id}/mark`, { status: 'unmatched' }), 'Moved back to unmatched')}>${t.status === 'matched' ? 'Undo match' : 'Move back'}</button></div>`}</div>`)}
    ${!list.length ? html`<div class="panel"><div class="empty">Nothing in this list.</div></div>` : ''}
    ${split ? html`<${SplitModal} txn=${split} onClose=${() => setSplit(null)} />` : ''}</div>`;
}

export function InboxPage({ tab = 'paper' }) {
  const st = useLoad('/api/inbox');
  const d = st.data;
  if (!d) return html`<${Loading} state=${st} />`;
  const n = { paper: d.imports.filter((i) => i.type === 'document' && i.status === 'review').length, sheets: d.imports.filter((i) => i.type === 'sheet' && i.status === 'review').length, statements: d.unmatched_txns, review: d.needs_review.length };
  return html`<div class="top"><h1>Import Inbox</h1><div class="sub">Bring in paper, spreadsheets and statements. Originals stay attached to the records they create, and re-uploading the same file never duplicates anything.</div></div>
    <div class="seg" style="margin-bottom:14px;flex-wrap:wrap">${TABS.map(([k, l]) => html`<button class=${tab === k ? 'on' : ''} onClick=${() => go(`#/inbox/${k}`)}>${l}${n[k] ? ` (${n[k]})` : ''}</button>`)}</div>
    <div class="stack"><${Samples} />
      ${tab === 'paper' ? html`<${Paper} inbox=${d} />` : tab === 'sheets' ? html`<${Sheets} inbox=${d} type="sheet" />` : tab === 'statements' ? html`<${Sheets} inbox=${d} type="statement" />`
        : html`<${Panel} pad=${false} title="Needs review">${d.needs_review.length ? d.needs_review.map((i) => html`<${Entry} item=${i} />`) : html`<div class="empty">Nothing needs review.</div>`}<//>
          <p class="muted small">Records land here when the due date is missing or the amount is marked as uncertain. Open one, correct it, and it joins the timeline.</p>`}</div>`;
}
