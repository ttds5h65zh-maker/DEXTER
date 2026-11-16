// Import Inbox: stored documents, paper-file review, spreadsheet import, statement import and matching.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, insert, tx, audit, getSettings, UPLOAD_DIR } from './db.js';
import { bad, HttpError, parseDate, parseNumber, toMinor, isDate, diffDays, nowIso, norm, compact, tokens, nameOverlap, fmtMoney } from './util.js';
import { sniffMime, extractText, parseFields, knownCounterparties, DOCUMENT_TYPES } from './extract.js';
import { getItem, listItems, addPayment, recordBill, findForecastMatches, findDuplicates, voidPayment, today } from './ledger.js';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const cleanName = (name) => path.basename(String(name || 'upload')).replace(/[\u0000-\u001f<>:"|?*\\/]/g, '_').slice(0, 150) || 'upload';
export const docPath = (doc) => path.join(UPLOAD_DIR, doc.sha256);
const docMeta = (d) => d && { id: d.id, filename: d.filename, mime: d.mime, size: d.size, extract_method: d.extract_method, ocr_confidence: d.ocr_confidence, pages: d.pages, created_at: d.created_at, has_text: !!d.text };

/** Store a file once (keyed by content hash) and extract its text so it is searchable. */
export async function storeDocument(buf, filename, user, { allow = DOCUMENT_TYPES, is_demo = 0 } = {}) {
  if (!buf?.length) throw bad('The file is empty.');
  filename = cleanName(filename);
  const mime = sniffMime(buf, filename);
  if (!allow.has(mime)) throw bad(`“${filename}” is not a supported file type here.`);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const existing = get('SELECT * FROM documents WHERE sha256 = ?', sha256);
  if (existing) return { doc: existing, existed: true };
  const ex = DOCUMENT_TYPES.has(mime) ? await extractText(buf, mime) : { text: '', method: 'none', confidence: null };
  fs.writeFileSync(path.join(UPLOAD_DIR, sha256), buf, { mode: 0o600 });
  const id = insert('documents', {
    sha256, filename, mime, size: buf.length, text: ex.text || '', extract_method: ex.method, ocr_confidence: ex.confidence, pages: ex.pages ?? null,
    uploaded_by: user?.id ?? null, created_at: nowIso(), is_demo,
  });
  audit(user, 'document', id, 'uploaded', { note: filename });
  return { doc: get('SELECT * FROM documents WHERE id = ?', id), existed: false, extractError: ex.error };
}
export const linkDocument = (documentId, itemId) => run('INSERT OR IGNORE INTO document_links (document_id, item_id) VALUES (?, ?)', documentId, itemId);
export const itemDocuments = (itemId) =>
  all('SELECT d.* FROM documents d JOIN document_links l ON l.document_id = d.id WHERE l.item_id = ? ORDER BY d.id', itemId).map(docMeta);
export const getDocument = (id) => get('SELECT * FROM documents WHERE id = ?', id);

// ---------------------------------------------------------------- paper files
export async function importDocument(buf, filename, user, opts = {}) {
  const { doc, existed, extractError } = await storeDocument(buf, filename, user, opts);
  if (existed) {
    const prior = get("SELECT id FROM imports WHERE document_id = ? AND type = 'document' ORDER BY id DESC", doc.id);
    if (prior) return { import: getImport(prior.id), already: true };
  }
  const fields = parseFields(doc.text, { baseCurrency: getSettings().base_currency, ocrConfidence: doc.extract_method === 'ocr' ? doc.ocr_confidence ?? 0.5 : 1, knownNames: knownCounterparties() });
  const id = insert('imports', { type: 'document', document_id: doc.id, meta: JSON.stringify({ filename: doc.filename, extract_error: extractError || null }), created_by: user?.id ?? null, created_at: nowIso(), is_demo: opts.is_demo || 0 });
  insert('import_rows', { import_id: id, row_index: 0, raw: '{}', parsed: JSON.stringify({ fields }), status: 'pending' });
  return { import: getImport(id), already: existed };
}

export function getImport(id) {
  const imp = get('SELECT * FROM imports WHERE id = ?', id);
  if (!imp) return null;
  imp.meta = JSON.parse(imp.meta);
  imp.document = docMeta(get('SELECT * FROM documents WHERE id = ?', imp.document_id));
  const rows = all('SELECT * FROM import_rows WHERE import_id = ? ORDER BY row_index', id).map((r) => ({ ...r, raw: JSON.parse(r.raw), parsed: r.parsed ? JSON.parse(r.parsed) : null }));
  if (imp.type === 'document') {
    const row = rows[0];
    imp.fields = row?.parsed?.fields || {};
    imp.row_status = row?.status;
    imp.item_id = row?.item_id || null;
    if (imp.status === 'review') {
      const f = imp.fields;
      const probe = { direction: 'out', counterparty: f.supplier?.value, title: f.supplier?.value, reference: f.reference?.value, amount: f.amount?.value, currency: f.currency?.value || getSettings().base_currency, due_date: f.due_date?.value, issue_date: f.issue_date?.value };
      imp.forecast_matches = findForecastMatches(probe);
      imp.duplicates = findDuplicates(probe);
    }
  } else {
    imp.rows = rows;
    imp.counts = rows.reduce((c, r) => ((c[r.status] = (c[r.status] || 0) + 1), c), {});
  }
  return imp;
}

export function confirmDocument(importId, d, user) {
  return tx(() => {
    const imp = get("SELECT * FROM imports WHERE id = ? AND type = 'document'", importId);
    if (!imp) throw new HttpError(404, 'Import not found.');
    if (imp.status !== 'review') throw bad('This document was already handled.');
    const fields = {
      direction: d.direction === 'in' ? 'in' : 'out', counterparty: d.counterparty, reference: d.reference, amount: d.amount, currency: d.currency,
      issue_date: d.issue_date || null, due_date: d.due_date || null, category_id: d.category_id || null, entity_id: d.entity_id || null,
      title: d.title || [d.counterparty, d.reference].filter(Boolean).join(' · '), notes: d.notes,
      amount_status: d.amount_status || 'confirmed', kind: d.direction === 'in' ? 'invoice' : 'bill',
    };
    if (!fields.title) throw bad('Enter a supplier or a title.');
    if (!d.match_item_id && !d.force) {
      const dups = findDuplicates(fields);
      if (dups.length) throw new HttpError(409, 'This looks like a bill that is already recorded.', { duplicates: dups });
    }
    const { item, matched_forecast } = recordBill(fields, user, { matchItemId: d.match_item_id || null, source: 'document', is_demo: imp.is_demo });
    linkDocument(imp.document_id, item.id);
    run("UPDATE import_rows SET status = 'imported', item_id = ? WHERE import_id = ?", item.id, importId);
    run("UPDATE imports SET status = 'done' WHERE id = ?", importId);
    return { item: getItem(item.id), matched_forecast };
  });
}

export function discardImport(importId, user) {
  const imp = get('SELECT * FROM imports WHERE id = ?', importId);
  if (!imp) throw new HttpError(404, 'Import not found.');
  if (get("SELECT 1 x FROM import_rows WHERE import_id = ? AND status = 'imported'", importId)) {
    run("UPDATE imports SET status = 'done' WHERE id = ?", importId); // keep what was imported, close the rest
  } else run("UPDATE imports SET status = 'discarded' WHERE id = ?", importId);
  audit(user, 'import', importId, 'discarded');
}

// ---------------------------------------------------------------- tables (CSV / Excel)
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const head = text.slice(0, 5000);
  const delim = [',', ';', '\t', '|'].map((d) => [d, head.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
async function parseTable(buf, mime) {
  let rows;
  if (mime === XLSX) {
    const { readSheet } = await import('read-excel-file/node');
    rows = (await readSheet(buf)).map((r) => r.map((c) => (c == null ? '' : c instanceof Date ? c.toISOString().slice(0, 10) : String(c))));
  } else rows = parseCsv(buf.toString('utf8'));
  rows = rows.map((r) => r.map((c) => String(c ?? '').trim())).filter((r) => r.some((c) => c !== ''));
  if (rows.length < 2) throw bad('The file needs a header row and at least one data row.');
  if (rows.length > 5001) throw bad('This file has more than 5,000 rows. Split it into smaller files.');
  const width = Math.max(...rows.map((r) => r.length));
  const headers = Array.from({ length: width }, (_, i) => rows[0][i] || `Column ${i + 1}`);
  return { headers, rows: rows.slice(1).map((r) => Array.from({ length: width }, (_, i) => r[i] ?? '')) };
}

export const SHEET_FIELDS = {
  title: ['description', 'details', 'item', 'title', 'particulars', 'narration', 'memo', 'subject'],
  counterparty: ['supplier', 'vendor', 'payee', 'customer', 'client', 'company', 'party', 'name', 'paid to', 'from', 'to', 'who'],
  reference: ['reference', 'ref', 'invoice no', 'invoice number', 'invoice', 'bill no', 'bill number', 'number', 'ref no', 'doc no'],
  amount: ['amount', 'total', 'amount due', 'value', 'invoice amount', 'gross', 'amount aed'],
  currency: ['currency', 'ccy', 'cur'],
  issue_date: ['issue date', 'invoice date', 'bill date', 'date', 'issued'],
  due_date: ['due date', 'due', 'payment due', 'pay by', 'due on'],
  direction: ['direction', 'type', 'in out', 'payable receivable'],
  category: ['category', 'cat', 'expense type'],
  entity: ['vehicle', 'property', 'car', 'asset', 'vehicle property'],
  paid_amount: ['paid', 'amount paid', 'paid amount', 'collected', 'received'],
  paid_date: ['paid date', 'payment date', 'date paid', 'paid on'],
};
export const STATEMENT_FIELDS = {
  date: ['date', 'transaction date', 'posting date', 'value date', 'txn date', 'trans date'],
  description: ['description', 'details', 'narration', 'particulars', 'transaction', 'transaction details', 'merchant', 'memo'],
  reference: ['reference', 'ref', 'ref no', 'cheque no', 'cheque', 'transaction id'],
  amount: ['amount', 'transaction amount', 'value'],
  debit: ['debit', 'withdrawal', 'withdrawals', 'paid out', 'money out', 'dr'],
  credit: ['credit', 'deposit', 'deposits', 'paid in', 'money in', 'cr'],
  currency: ['currency', 'ccy'],
};
function guessMapping(headers, fields) {
  const mapping = {};
  const used = new Set();
  const h = headers.map((x) => norm(x));
  for (const exact of [true, false]) {
    for (const [field, syns] of Object.entries(fields)) {
      if (mapping[field] != null) continue;
      for (const syn of [...syns].sort((a, b) => b.length - a.length)) {
        const idx = h.findIndex((x, i) => !used.has(i) && (exact ? x === syn : x.split(' ').includes(syn) || (syn.includes(' ') && x.includes(syn))));
        if (idx >= 0) { mapping[field] = idx; used.add(idx); break; }
      }
    }
  }
  return mapping;
}

export async function createTableImport(type, buf, filename, user, { account_id = null, is_demo = 0 } = {}) {
  const base = getSettings().base_currency;
  let account = null;
  if (type === 'statement') {
    account = get('SELECT * FROM accounts WHERE id = ?', account_id);
    if (!account) throw bad('Choose the bank account or card this statement belongs to.');
  }
  const { doc, existed } = await storeDocument(buf, filename, user, { allow: new Set(['text/csv', XLSX]), is_demo });
  if (existed) {
    const prior = get("SELECT id FROM imports WHERE document_id = ? AND type = ? AND status != 'discarded' ORDER BY id DESC", doc.id, type);
    if (prior) return { import: getImport(prior.id), already: true };
  }
  const table = await parseTable(buf, doc.mime);
  const fields = type === 'statement' ? STATEMENT_FIELDS : SHEET_FIELDS;
  const meta = {
    filename: doc.filename, headers: table.headers, mapping: guessMapping(table.headers, fields), date_order: 'DMY',
    defaults: { direction: 'out', currency: account?.currency || base, category_id: null, entity_id: null },
    account_id: account?.id ?? null, positive_is_out: account?.type === 'card',
  };
  const id = tx(() => {
    const impId = insert('imports', { type, document_id: doc.id, meta: JSON.stringify(meta), created_by: user?.id ?? null, created_at: nowIso(), is_demo });
    table.rows.forEach((r, i) => insert('import_rows', { import_id: impId, row_index: i + 1, raw: JSON.stringify(r) }));
    return impId;
  });
  validateImport(id);
  return { import: getImport(id), already: false };
}

export function updateImportMeta(id, d) {
  const imp = get('SELECT * FROM imports WHERE id = ?', id);
  if (!imp || imp.type === 'document') throw new HttpError(404, 'Import not found.');
  const meta = JSON.parse(imp.meta);
  if (d.mapping && typeof d.mapping === 'object') {
    const fields = imp.type === 'statement' ? STATEMENT_FIELDS : SHEET_FIELDS;
    meta.mapping = {};
    for (const k of Object.keys(fields)) {
      const v = d.mapping[k];
      if (v != null && v !== '' && Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) < meta.headers.length) meta.mapping[k] = Number(v);
    }
  }
  if (d.date_order) meta.date_order = d.date_order === 'MDY' ? 'MDY' : 'DMY';
  if (d.positive_is_out !== undefined) meta.positive_is_out = !!d.positive_is_out;
  if (d.defaults) {
    const c = String(d.defaults.currency || meta.defaults.currency).toUpperCase();
    meta.defaults = {
      direction: d.defaults.direction === 'in' ? 'in' : 'out', currency: /^[A-Z]{3}$/.test(c) ? c : meta.defaults.currency,
      category_id: d.defaults.category_id ? Number(d.defaults.category_id) : null, entity_id: d.defaults.entity_id ? Number(d.defaults.entity_id) : null,
    };
  }
  run('UPDATE imports SET meta = ? WHERE id = ?', JSON.stringify(meta), id);
  validateImport(id);
  return getImport(id);
}

export function updateImportRow(rowId, cells) {
  const row = get('SELECT * FROM import_rows WHERE id = ?', rowId);
  if (!row) throw new HttpError(404, 'Row not found.');
  if (row.status === 'imported') throw bad('This row was already imported. Edit the record itself instead.');
  if (!Array.isArray(cells)) throw bad('Row values are missing.');
  run('UPDATE import_rows SET raw = ? WHERE id = ?', JSON.stringify(cells.map((c) => String(c ?? '').slice(0, 500))), rowId);
  validateImport(row.import_id);
  return getImport(row.import_id);
}

const TRANSFER_RE = /\b(own account|internal transfer|transfer (to|from) (my |own )?(savings|account|current)|between (own )?accounts|trf (to|from) own|to savings)\b/i;
const CARD_REPAY_RE = /credit card (re)?payment|\bcard (re)?payment|\bcc (re)?payment|payment received|payment[ -]+thank you|card settlement/i;

/** Re-check every row that has not been imported yet and store its parsed values, status and message. */
export function validateImport(id) {
  const imp = get('SELECT * FROM imports WHERE id = ?', id);
  const meta = JSON.parse(imp.meta);
  const map = meta.mapping;
  const rows = all("SELECT * FROM import_rows WHERE import_id = ? AND status != 'imported' ORDER BY row_index", id);
  const cats = all('SELECT * FROM categories');
  const ents = all('SELECT * FROM entities');
  const seen = new Map();
  const usedForecasts = new Set();
  const occurrences = new Map();
  tx(() => {
    for (const row of rows) {
      const raw = JSON.parse(row.raw);
      const cell = (f) => (map[f] != null ? String(raw[map[f]] ?? '').trim() : '');
      const errors = [];
      const warnings = [];
      const date = (f, label, required) => {
        const v = cell(f);
        if (!v) { if (required) errors.push(`${label} is missing`); return null; }
        const d = parseDate(v, meta.date_order);
        if (!d) { errors.push(`${label} “${v}” is not a valid date`); return null; }
        if (d.ambiguous) warnings.push(`${label} “${v}” read as ${meta.date_order === 'MDY' ? 'month/day' : 'day/month'}`);
        return d.value;
      };
      let parsed;
      let status = 'ready';
      if (imp.type === 'sheet') {
        const currency = (cell('currency') || meta.defaults.currency).toUpperCase();
        if (!/^[A-Z]{3}$/.test(currency)) errors.push(`Currency “${cell('currency')}” is not a 3-letter code`);
        const amountRaw = cell('amount');
        let amount = null;
        if (map.amount == null) errors.push('No amount column is mapped');
        else if (!amountRaw) errors.push('Amount is missing');
        else { const n = parseNumber(amountRaw); if (n == null || n === 0) errors.push(`Amount “${amountRaw}” is not a number`); else amount = Math.abs(toMinor(n, currency)); }
        const dirCell = cell('direction').toLowerCase();
        const direction = dirCell ? (/\b(in|income|receiv|credit|owed to|collect)/.test(dirCell) ? 'in' : 'out') : meta.defaults.direction;
        const counterparty = cell('counterparty') || null;
        const reference = cell('reference') || null;
        const title = cell('title') || [counterparty, reference].filter(Boolean).join(' · ');
        if (!title) errors.push('Needs a description or a payee');
        const issue_date = date('issue_date', 'Issue date');
        const due_date = date('due_date', 'Due date');
        let category_id = meta.defaults.category_id;
        if (cell('category')) { const c = cats.find((x) => norm(x.name) === norm(cell('category'))); if (c) category_id = c.id; else warnings.push(`Category “${cell('category')}” not found — default used`); }
        let entity_id = meta.defaults.entity_id;
        if (cell('entity')) { const e = ents.find((x) => norm(x.name) === norm(cell('entity')) || nameOverlap(cell('entity'), x.name) === 1); if (e) entity_id = e.id; else warnings.push(`“${cell('entity')}” is not a known vehicle or property`); }
        let paid_amount = null;
        if (cell('paid_amount')) {
          const n = parseNumber(cell('paid_amount'));
          if (n == null || n < 0) errors.push(`Paid amount “${cell('paid_amount')}” is not a number`);
          else if (amount != null && toMinor(n, currency) > amount) errors.push('Paid amount is more than the bill amount');
          else paid_amount = toMinor(n, currency) || null;
        }
        const paid_date = date('paid_date', 'Paid date');
        parsed = { title, counterparty, reference, amount, currency, issue_date, due_date, direction, category_id, entity_id, paid_amount, paid_date, warnings };
        if (!errors.length) {
          const key = [norm(counterparty), compact(reference), amount, due_date, norm(title)].join('|');
          const dups = findDuplicates(parsed);
          if (seen.has(key)) { status = 'duplicate'; parsed.duplicate_of = `Same as row ${seen.get(key)} in this file`; }
          else if (dups.length) { status = 'duplicate'; parsed.duplicate_of = `${dups[0].why} — already recorded as “${dups[0].title}”`; parsed.duplicate_item_id = dups[0].id; }
          else {
            const fm = findForecastMatches(parsed).find((m) => !usedForecasts.has(m.id));
            if (fm) { status = 'forecast'; parsed.match_item_id = fm.id; parsed.match_title = fm.title; usedForecasts.add(fm.id); }
            else if (!due_date) status = 'review';
          }
          seen.set(key, row.row_index);
        }
      } else {
        const currency = (cell('currency') || meta.defaults.currency).toUpperCase();
        const d = date('date', 'Date', true);
        const description = cell('description');
        if (!description) errors.push('Description is missing');
        let amount = null;
        if (map.amount != null && cell('amount')) {
          const n = parseNumber(cell('amount'));
          if (n == null) errors.push(`Amount “${cell('amount')}” is not a number`);
          else amount = toMinor(n, currency) * (meta.positive_is_out ? -1 : 1);
        } else if (map.debit != null || map.credit != null) {
          const dr = parseNumber(cell('debit')) || 0;
          const cr = parseNumber(cell('credit')) || 0;
          amount = toMinor(Math.abs(cr), currency) - toMinor(Math.abs(dr), currency);
        } else errors.push('No amount column is mapped');
        if (amount === 0 && !errors.length) errors.push('Amount is zero');
        const reference = cell('reference') || null;
        const base = [meta.account_id, d, amount, norm(description), compact(reference)].join('|');
        const n = (occurrences.get(base) || 0) + 1;
        occurrences.set(base, n);
        const fingerprint = crypto.createHash('sha1').update(`${base}|${n}`).digest('hex');
        const kind = TRANSFER_RE.test(description) ? 'transfer' : CARD_REPAY_RE.test(description) ? 'card_repayment' : 'normal';
        parsed = { date: d, description, reference, amount, currency, fingerprint, kind, warnings };
        if (!errors.length && get('SELECT 1 x FROM bank_txns WHERE fingerprint = ?', fingerprint)) { status = 'duplicate'; parsed.duplicate_of = 'Already imported from an earlier statement'; }
      }
      if (errors.length) status = 'error';
      run('UPDATE import_rows SET parsed = ?, status = ?, message = ? WHERE id = ?', JSON.stringify(parsed), status,
        errors.length ? errors.join('; ') : parsed.duplicate_of || warnings.join('; ') || null, row.id);
    }
  });
}

export function commitImport(id, { include_duplicates = [] } = {}, user) {
  return tx(() => {
    const imp = get('SELECT * FROM imports WHERE id = ?', id);
    if (!imp || imp.type === 'document') throw new HttpError(404, 'Import not found.');
    if (imp.status === 'discarded') throw bad('This import was discarded.');
    validateImport(id);
    const meta = JSON.parse(imp.meta);
    const include = new Set(include_duplicates.map(Number));
    const rows = all("SELECT * FROM import_rows WHERE import_id = ? AND status != 'imported' ORDER BY row_index", id);
    const result = { imported: 0, matched_forecast: 0, needs_review: 0, skipped_duplicates: 0, errors: 0 };
    const account = meta.account_id ? get('SELECT * FROM accounts WHERE id = ?', meta.account_id) : null;
    for (const row of rows) {
      const p = JSON.parse(row.parsed);
      if (row.status === 'error') { result.errors++; continue; }
      if (imp.type === 'sheet') {
        if (row.status === 'duplicate' && !include.has(row.id)) { result.skipped_duplicates++; continue; }
        const { item, matched_forecast } = recordBill(
          { title: p.title, counterparty: p.counterparty, reference: p.reference, amount: p.amount, currency: p.currency, issue_date: p.issue_date, due_date: p.due_date,
            direction: p.direction, category_id: p.category_id, entity_id: p.entity_id, kind: p.direction === 'in' ? 'invoice' : 'bill' },
          user, { matchItemId: row.status === 'forecast' ? p.match_item_id : null, source: 'sheet', is_demo: imp.is_demo });
        linkDocument(imp.document_id, item.id);
        if (p.paid_amount) addPayment(item.id, { amount: p.paid_amount, date: p.paid_date || p.due_date || p.issue_date || today(), note: 'Imported from spreadsheet as already paid' }, user);
        run("UPDATE import_rows SET status = 'imported', item_id = ? WHERE id = ?", item.id, row.id);
        result.imported++;
        if (matched_forecast) result.matched_forecast++;
        if (!p.due_date) result.needs_review++;
      } else {
        if (row.status === 'duplicate') { result.skipped_duplicates++; continue; }
        // The mirror side of a card repayment on the card's own statement is not new spending.
        const auto = p.kind === 'transfer' || (p.kind === 'card_repayment' && account?.type === 'card' && p.amount > 0);
        insert('bank_txns', { import_id: id, account_id: meta.account_id, date: p.date, description: p.description, reference: p.reference, amount: p.amount,
          currency: p.currency, fingerprint: p.fingerprint, status: auto ? 'transfer' : 'unmatched', txn_kind: p.kind, is_demo: imp.is_demo });
        run("UPDATE import_rows SET status = 'imported' WHERE id = ?", row.id);
        result.imported++;
      }
    }
    const left = get("SELECT COUNT(*) n FROM import_rows WHERE import_id = ? AND status = 'error'", id).n;
    run('UPDATE imports SET status = ? WHERE id = ?', left ? 'review' : 'done', id);
    audit(user, 'import', id, 'committed', { note: `${result.imported} imported, ${result.skipped_duplicates} duplicates skipped, ${result.errors} need fixing` });
    return { result, import: getImport(id) };
  });
}

export function listImports() {
  return all("SELECT id FROM imports WHERE status != 'discarded' ORDER BY (status = 'review') DESC, id DESC LIMIT 300").map((r) => {
    const i = getImport(r.id);
    delete i.rows;
    return i;
  });
}

// ---------------------------------------------------------------- statement matching
const allocated = (txnId) => get('SELECT COALESCE(SUM(amount), 0) n FROM payments WHERE bank_txn_id = ? AND voided_at IS NULL', txnId).n;

/** Rank open records against a transaction and say why each one was suggested. */
export function suggestMatches(txn, account, openItems) {
  const direction = txn.amount < 0 ? 'out' : 'in';
  const abs = Math.abs(txn.amount);
  const hay = `${txn.description} ${txn.reference || ''}`;
  const hayCompact = compact(hay);
  const out = [];
  for (const it of openItems) {
    if (it.direction !== direction || it.currency !== txn.currency) continue;
    if (account.type === 'card' && it.kind === 'card_statement') continue;
    let score = 0;
    const reasons = [];
    if (abs === it.outstanding) { score += 50; reasons.push(`Amount equals the outstanding balance (${fmtMoney(it.outstanding, it.currency)})`); }
    else if (it.kind === 'card_statement' && it.min_due && abs === it.min_due) { score += 45; reasons.push(`Amount equals the minimum due (${fmtMoney(it.min_due, it.currency)})`); }
    else if (abs < it.outstanding) { score += 8; reasons.push(`Would be a part payment of ${fmtMoney(it.outstanding, it.currency)} outstanding`); }
    else { score -= 15; }
    const ref = compact(it.reference);
    if (ref.length >= 4 && hayCompact.includes(ref)) { score += 40; reasons.push(`Reference ${it.reference} appears in the transaction`); }
    const hit = tokens(it.counterparty || it.title).filter((tk) => norm(hay).includes(tk));
    if (hit.length && nameOverlap(it.counterparty || it.title, hay) >= 0.5) { score += 25; reasons.push(`Description mentions “${hit.join(' ')}”`); }
    if (txn.txn_kind === 'card_repayment' && it.kind === 'card_statement') { score += 30; reasons.push('Looks like a card repayment — matches the card statement, not new spending'); }
    if (it.due_date) {
      const gap = Math.abs(diffDays(txn.date, it.due_date));
      if (gap <= 3) { score += 15; reasons.push(gap === 0 ? 'Paid on the due date' : `Within ${gap} day${gap === 1 ? '' : 's'} of the due date`); }
      else if (gap <= 10) { score += 8; reasons.push(`${gap} days from the due date`); }
      else if (gap <= 35) score += 2;
      else score -= 10;
    }
    if (it.issue_date && txn.date < it.issue_date) score -= 20;
    if (score >= 40) out.push({ item_id: it.id, title: it.title, counterparty: it.counterparty, due_date: it.due_date, outstanding: it.outstanding, currency: it.currency, score, reasons, suggested_amount: Math.min(abs, it.outstanding) });
  }
  out.sort((a, b) => b.score - a.score);
  return out.filter((s) => s.score >= out[0].score - 20).slice(0, 3); // drop far weaker alternatives
}

export function listTxns(f = {}) {
  const where = ['1=1'];
  const p = [];
  if (f.status) { where.push('t.status = ?'); p.push(f.status); }
  if (f.account_id) { where.push('t.account_id = ?'); p.push(f.account_id); }
  const txns = all(`SELECT t.*, a.name AS account_name, a.type AS account_type FROM bank_txns t JOIN accounts a ON a.id = t.account_id
    WHERE ${where.join(' AND ')} ORDER BY t.date DESC, t.id DESC LIMIT 1000`, ...p);
  const open = txns.some((t) => t.status === 'unmatched') ? listItems({ state: 'open' }) : [];
  for (const t of txns) {
    t.allocated = allocated(t.id);
    if (t.status === 'unmatched') t.suggestions = suggestMatches(t, { type: t.account_type }, open);
    else if (t.status === 'matched') {
      t.matches = all('SELECT p.id AS payment_id, p.amount, i.id AS item_id, i.title FROM payments p JOIN items i ON i.id = p.item_id WHERE p.bank_txn_id = ? AND p.voided_at IS NULL', t.id);
    }
  }
  return txns;
}

/** Confirm a match. `allocations` may split one transaction across several records. */
export function matchTxn(txnId, allocations, user) {
  return tx(() => {
    const txn = get('SELECT t.*, a.type AS account_type FROM bank_txns t JOIN accounts a ON a.id = t.account_id WHERE t.id = ?', txnId);
    if (!txn) throw new HttpError(404, 'Transaction not found.');
    if (txn.status === 'transfer' || txn.status === 'ignored') throw bad('This transaction is set aside. Move it back to unmatched first.');
    if (!Array.isArray(allocations) || !allocations.length) throw bad('Choose at least one record to match.');
    const total = allocations.reduce((s, a) => s + (Number.isInteger(a.amount) ? a.amount : NaN), 0);
    if (!Number.isInteger(total) || allocations.some((a) => a.amount <= 0)) throw bad('Each split needs an amount.');
    const free = Math.abs(txn.amount) - allocated(txnId);
    if (total > free) throw bad(`The splits add up to more than the ${fmtMoney(free, txn.currency)} left on this transaction.`);
    const direction = txn.amount < 0 ? 'out' : 'in';
    for (const a of allocations) {
      const item = getItem(a.item_id);
      if (!item) throw bad('One of the records no longer exists.');
      if (item.direction !== direction) throw bad(`“${item.title}” is ${item.direction === 'in' ? 'money you receive' : 'money you pay'}; this transaction goes the other way.`);
      if (item.currency !== txn.currency) throw bad(`“${item.title}” is in ${item.currency} but the transaction is in ${txn.currency}.`);
      addPayment(item.id, {
        amount: a.amount, date: txn.date, method: txn.account_type === 'card' ? 'card' : 'bank', bank_txn_id: txnId,
        card_account_id: txn.account_type === 'card' ? txn.account_id : null,
        note: `Matched to statement line: ${txn.description}`.slice(0, 300),
      }, user);
    }
    run("UPDATE bank_txns SET status = 'matched' WHERE id = ?", txnId);
    audit(user, 'txn', txnId, 'matched', { note: `${allocations.length} record(s)` });
    return listTxns({}).find((t) => t.id === txnId);
  });
}

export function markTxn(txnId, status, user) {
  return tx(() => {
    if (!['unmatched', 'transfer', 'ignored'].includes(status)) throw bad('Unknown status.');
    const txn = get('SELECT * FROM bank_txns WHERE id = ?', txnId);
    if (!txn) throw new HttpError(404, 'Transaction not found.');
    for (const p of all('SELECT id FROM payments WHERE bank_txn_id = ? AND voided_at IS NULL', txnId)) voidPayment(p.id, user);
    run('UPDATE bank_txns SET status = ? WHERE id = ?', status, txnId);
    audit(user, 'txn', txnId, `marked ${status}`);
    return get('SELECT * FROM bank_txns WHERE id = ?', txnId);
  });
}
