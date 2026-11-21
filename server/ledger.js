// The ledger: items (payables / receivables), payments against them, plans (recurring, schedules, loans).
import { all, get, run, insert, tx, audit, getSettings } from './db.js';
import { bad, HttpError, validMinor, isDate, addDays, addMonths, diffDays, todayIn, monthLabel, nowIso, decimals, nameOverlap, compact, norm } from './util.js';

export const today = () => todayIn(getSettings().timezone);

const ITEM_SQL = `
  SELECT i.*, b.paid, b.credited, MAX(i.amount - b.paid - b.credited, 0) AS outstanding,
    e.name AS entity_name, e.kind AS entity_kind, c.name AS category_name,
    COALESCE(e.kind, c.group_kind, 'household') AS grp,
    a.name AS account_name, p.type AS plan_type, p.verified AS plan_verified, p.title AS plan_title,
    (SELECT COUNT(*) FROM document_links dl WHERE dl.item_id = i.id) AS doc_count
  FROM items i
  JOIN item_balances b ON b.item_id = i.id
  LEFT JOIN entities e ON e.id = i.entity_id
  LEFT JOIN categories c ON c.id = i.category_id
  LEFT JOIN accounts a ON a.id = i.account_id
  LEFT JOIN plans p ON p.id = i.plan_id`;

export function decorate(item, t = today()) {
  if (!item) return item;
  const open = !item.voided_at && item.outstanding > 0;
  item.status = item.voided_at ? 'void' : item.outstanding === 0 ? 'paid' : item.paid + item.credited > 0 ? 'partial' : 'open';
  item.overdue = open && !!item.due_date && item.due_date < t;
  item.days_until = item.due_date ? diffDays(item.due_date, t) : null;
  item.needs_review = !item.voided_at && (item.amount_status === 'needs_review' || (!item.due_date && item.outstanding > 0));
  // A schedule that was generated rather than taken from the lender is a projection until someone verifies it.
  item.projected = !!item.plan_id && item.plan_type !== 'recurring' && !item.plan_verified;
  return item;
}

/**
 * filters: direction, group, entity_id, plan_id, account_id, category_id, state (open|paid|overdue|needs_review|unbilled|all),
 * from, to (due date range), q (text search incl. attached documents), include_void, kind, exclude_kind
 */
export function listItems(f = {}, t = today()) {
  const where = [];
  const p = [];
  if (!f.include_void) where.push('voided_at IS NULL');
  if (f.direction) { where.push('direction = ?'); p.push(f.direction); }
  if (f.group) { where.push('grp = ?'); p.push(f.group); }
  for (const k of ['entity_id', 'plan_id', 'account_id', 'category_id', 'kind']) {
    if (f[k]) { where.push(`${k} = ?`); p.push(f[k]); }
  }
  if (f.exclude_kind) { where.push('kind != ?'); p.push(f.exclude_kind); }
  if (f.from) { where.push('due_date >= ?'); p.push(f.from); }
  if (f.to) { where.push('due_date <= ?'); p.push(f.to); }
  if (f.state === 'open') where.push('outstanding > 0');
  if (f.state === 'paid') where.push('outstanding = 0');
  if (f.state === 'overdue') { where.push('outstanding > 0 AND due_date < ?'); p.push(t); }
  if (f.state === 'needs_review') where.push("(amount_status = 'needs_review' OR (due_date IS NULL AND outstanding > 0))");
  if (f.state === 'unbilled') where.push('billed = 0 AND outstanding > 0');
  if (f.q) {
    const like = `%${String(f.q).replace(/[%_]/g, ' ').trim()}%`;
    where.push(`(title LIKE ? OR counterparty LIKE ? OR reference LIKE ? OR notes LIKE ? OR category_name LIKE ? OR entity_name LIKE ?
      OR id IN (SELECT dl.item_id FROM document_links dl JOIN documents d ON d.id = dl.document_id WHERE d.text LIKE ? OR d.filename LIKE ?))`);
    p.push(like, like, like, like, like, like, like, like);
  }
  const sql = `SELECT * FROM (${ITEM_SQL}) ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY due_date IS NULL, due_date ${f.desc ? 'DESC' : 'ASC'}, id LIMIT ${Math.min(Number(f.limit) || 5000, 5000)}`;
  return all(sql, ...p).map((i) => decorate(i, t));
}
export const getItem = (id, t = today()) => decorate(get(`${ITEM_SQL} WHERE i.id = ?`, id), t);

// ---- validation ----
const CUR = /^[A-Z]{3}$/;
function cleanItemInput(d, { partial = false } = {}) {
  const o = {};
  const has = (k) => d[k] !== undefined;
  const str = (k, max = 300) => { if (has(k)) o[k] = d[k] == null || d[k] === '' ? null : String(d[k]).trim().slice(0, max); };
  if (has('direction')) { if (!['out', 'in'].includes(d.direction)) throw bad('Direction must be "out" or "in".'); o.direction = d.direction; }
  str('title'); str('counterparty'); str('reference', 120); str('notes', 4000); str('kind', 40);
  if (!partial && !o.title) throw bad('A title is required.');
  if (has('title') && !o.title) throw bad('A title is required.');
  if (has('amount')) { if (!validMinor(d.amount, { zero: true })) throw bad('Amount must be a positive number (and not unrealistically large).'); o.amount = d.amount; }
  else if (!partial) throw bad('Amount is required.');
  if (has('min_due')) { if (d.min_due != null && !validMinor(d.min_due, { zero: true })) throw bad('Minimum due must be a positive number.'); o.min_due = d.min_due; }
  if (has('currency')) { const c = String(d.currency || '').toUpperCase(); if (!CUR.test(c)) throw bad('Currency must be a 3-letter code such as AED.'); o.currency = c; }
  for (const k of ['issue_date', 'due_date']) {
    if (has(k)) { if (d[k] != null && d[k] !== '' && !isDate(d[k])) throw bad(`${k.replace('_', ' ')} is not a valid date.`); o[k] = d[k] || null; }
  }
  if (has('amount_status')) { if (!['confirmed', 'estimated', 'needs_review'].includes(d.amount_status)) throw bad('Unknown amount status.'); o.amount_status = d.amount_status; }
  for (const [k, table] of [['entity_id', 'entities'], ['category_id', 'categories'], ['account_id', 'accounts']]) {
    if (has(k)) {
      if (d[k] != null && d[k] !== '' && !get(`SELECT id FROM ${table} WHERE id = ?`, Number(d[k]))) throw bad(`Unknown ${k.replace('_id', '')}.`);
      o[k] = d[k] ? Number(d[k]) : null;
    }
  }
  if (has('billed')) o.billed = d.billed ? 1 : 0;
  return o;
}

export function createItem(data, user, extra = {}) {
  const o = cleanItemInput(data);
  if (o.amount === 0 && o.kind !== 'card_statement') throw bad('Amount must be greater than zero.');
  const now = nowIso();
  const id = insert('items', {
    direction: 'out', currency: getSettings().base_currency, ...o, ...extra,
    created_by: user?.id ?? null, created_at: now, updated_at: now,
  });
  audit(user, 'item', id, 'created', { note: extra.source || 'manual' });
  if (o.kind === 'card_statement' && o.account_id) attachCardPurchases(id);
  return getItem(id);
}

// `kind` (bill, card statement, installment…) is fixed when a record is created; it is not editable.
const TRACKED = ['title', 'counterparty', 'reference', 'direction', 'amount', 'currency', 'min_due', 'issue_date', 'due_date', 'amount_status', 'entity_id', 'category_id', 'account_id', 'notes', 'billed'];
/** Update an item and write one audit row per changed field (who, when, old → new). */
export function updateItem(id, patch, user, note = null) {
  return tx(() => {
    const cur = get('SELECT * FROM items WHERE id = ?', id);
    if (!cur) throw new HttpError(404, 'Record not found.');
    if (cur.voided_at) throw bad('This record was voided and can no longer be edited.');
    const o = cleanItemInput(patch, { partial: true });
    if (o.currency !== undefined && o.currency !== cur.currency && get('SELECT 1 x FROM payments WHERE item_id = ? AND voided_at IS NULL', id)) {
      throw bad('The currency cannot change after payments were recorded. Void the payments first, or void this record and enter it again.');
    }
    if (o.amount === 0 && cur.kind !== 'card_statement') throw bad('Amount must be greater than zero. Void the record instead.');
    if (o.amount !== undefined) {
      const b = get('SELECT paid, credited FROM item_balances WHERE item_id = ?', id);
      if (o.amount < b.paid + b.credited) throw bad('Amount cannot be lower than what has already been paid or credited.');
    }
    const changed = TRACKED.filter((k) => o[k] !== undefined && o[k] !== cur[k]);
    if (!changed.length) return getItem(id);
    run(`UPDATE items SET ${changed.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...changed.map((k) => o[k]), nowIso(), id);
    for (const k of changed) audit(user, 'item', id, 'updated', { field: k, oldValue: cur[k], newValue: o[k], note });
    return getItem(id);
  });
}

export function voidItem(id, user, reason) {
  const item = getItem(id);
  if (!item) throw new HttpError(404, 'Record not found.');
  if (item.paid + item.credited > 0) throw bad('Void the payments on this record first.');
  run('UPDATE items SET voided_at = ?, updated_at = ? WHERE id = ?', nowIso(), nowIso(), id);
  audit(user, 'item', id, 'voided', { note: reason || null });
  return getItem(id);
}

// ---- payments ----
export function addPayment(itemId, d, user) {
  return tx(() => {
    const item = getItem(itemId);
    if (!item) throw new HttpError(404, 'Record not found.');
    if (item.voided_at) throw bad('This record was voided.');
    const type = d.type || 'payment';
    if (!['payment', 'refund', 'credit'].includes(type)) throw bad('Unknown payment type.');
    if (!validMinor(d.amount)) throw bad('Enter an amount greater than zero.');
    const date = d.date || today();
    if (!isDate(date)) throw bad('Payment date is not valid.');
    const f = (n) => (n / 10 ** decimals(item.currency)).toFixed(decimals(item.currency));
    if (type !== 'refund' && d.amount > item.outstanding) {
      throw bad(`That is more than the ${item.currency} ${f(item.outstanding)} still outstanding. Correct the bill amount first if it changed.`);
    }
    if (type === 'refund' && d.amount > item.paid) throw bad(`A refund cannot exceed the ${item.currency} ${f(item.paid)} paid so far.`);
    let statementId = d.statement_item_id || null;
    let cardId = d.card_account_id || null;
    if (d.method === 'card' && type === 'payment') {
      if (item.direction !== 'out') throw bad('Only outgoing bills can be paid by card.');
      if (item.kind === 'card_statement') throw bad('A card statement cannot be paid with a card purchase.');
      if (!cardId || !get("SELECT id FROM accounts WHERE id = ? AND type = 'card'", cardId)) throw bad('Choose which card was used.');
      if (!statementId) statementId = openStatementFor(cardId, date)?.id ?? null;
    } else { cardId = null; statementId = null; }
    if (d.proof_document_id && !get('SELECT id FROM documents WHERE id = ?', d.proof_document_id)) throw bad('Proof document not found.');
    const id = insert('payments', {
      item_id: itemId, type, amount: d.amount, date, method: d.method || null, note: d.note ? String(d.note).slice(0, 1000) : null,
      proof_document_id: d.proof_document_id || null, bank_txn_id: d.bank_txn_id || null,
      card_account_id: cardId, statement_item_id: statementId, created_by: user?.id ?? null, created_at: nowIso(),
    });
    audit(user, 'item', itemId, type === 'payment' ? 'payment recorded' : `${type} recorded`, { field: 'payment', newValue: d.amount, note: d.note || null });
    return { payment: get('SELECT * FROM payments WHERE id = ?', id), item: getItem(itemId) };
  });
}

export function voidPayment(paymentId, user) {
  return tx(() => {
    const p = get('SELECT * FROM payments WHERE id = ?', paymentId);
    if (!p || p.voided_at) throw new HttpError(404, 'Payment not found.');
    run('UPDATE payments SET voided_at = ?, voided_by = ? WHERE id = ?', nowIso(), user?.id ?? null, paymentId);
    audit(user, 'item', p.item_id, `${p.type} voided`, { field: 'payment', oldValue: p.amount });
    if (p.bank_txn_id && !get('SELECT 1 x FROM payments WHERE bank_txn_id = ? AND voided_at IS NULL', p.bank_txn_id)) {
      run("UPDATE bank_txns SET status = 'unmatched' WHERE id = ?", p.bank_txn_id);
    }
    return getItem(p.item_id);
  });
}

// ---- credit cards ----
/** The statement a card purchase on `date` belongs to: the earliest unpaid statement issued on/after that date. */
function openStatementFor(cardId, date) {
  return get(
    `SELECT i.id FROM items i JOIN item_balances b ON b.item_id = i.id
     WHERE i.kind = 'card_statement' AND i.account_id = ? AND i.voided_at IS NULL AND COALESCE(i.issue_date, i.due_date) >= ?
     ORDER BY COALESCE(i.issue_date, i.due_date) LIMIT 1`, cardId, date);
}
/** When a statement arrives, pull in card purchases recorded before it that are not on a statement yet. */
function attachCardPurchases(statementId) {
  const s = get('SELECT * FROM items WHERE id = ?', statementId);
  run(
    `UPDATE payments SET statement_item_id = ? WHERE card_account_id = ? AND statement_item_id IS NULL AND voided_at IS NULL AND date <= ?`,
    statementId, s.account_id, s.issue_date || s.due_date || today(),
  );
}
export const statementPurchases = (statementId) =>
  all(
    `SELECT p.id AS payment_id, p.amount, p.date, i.id AS item_id, i.title, i.counterparty, i.currency
     FROM payments p JOIN items i ON i.id = p.item_id WHERE p.statement_item_id = ? AND p.voided_at IS NULL ORDER BY p.date`, statementId);

// ---- plans ----
const FREQ = { weekly: 1, monthly: 1, quarterly: 3, yearly: 12 };
function occurrence(plan, k) {
  const n = k * (plan.interval_n || 1);
  if (plan.frequency === 'weekly') return addDays(plan.anchor_date, 7 * n);
  return addMonths(plan.anchor_date, FREQ[plan.frequency] * n);
}
let materializedFor = null;
/** Create forecast entries for recurring plans up to ~12 months ahead. Idempotent: one row per (plan, period). */
export function materialize(force = false) {
  const t = today();
  if (!force && materializedFor === t) return;
  const horizon = addDays(t, 370);
  tx(() => {
    for (const plan of all("SELECT * FROM plans WHERE type = 'recurring' AND active = 1")) {
      for (let k = 0; k < 2000; k++) {
        const date = occurrence(plan, k);
        if (date > horizon || (plan.end_date && date > plan.end_date)) break;
        const now = nowIso();
        run(
          `INSERT OR IGNORE INTO items (direction, kind, title, counterparty, entity_id, category_id, plan_id, period_key, amount, currency,
             due_date, amount_status, billed, source, is_demo, created_by, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          plan.direction, 'bill', `${plan.title} — ${plan.frequency === 'weekly' ? date : monthLabel(date)}`, plan.counterparty, plan.entity_id,
          plan.category_id, plan.id, date, plan.amount, plan.currency, date, plan.amount_status,
          plan.amount_status === 'confirmed' ? 1 : 0, 'forecast', plan.is_demo, plan.created_by, now, now,
        );
      }
    }
  });
  materializedFor = t;
}

export function createPlan(d, user, extra = {}) {
  return tx(() => {
    if (!['recurring', 'schedule', 'loan'].includes(d.type)) throw bad('Unknown plan type.');
    const base = cleanItemInput({ ...d, amount: d.amount ?? 0 });
    const row = {
      type: d.type, title: base.title, counterparty: base.counterparty ?? null, direction: base.direction || 'out',
      entity_id: base.entity_id ?? null, category_id: base.category_id ?? null, currency: base.currency || getSettings().base_currency,
      notes: base.notes ?? null, created_by: user?.id ?? null, created_at: nowIso(), ...extra,
    };
    if (d.type === 'recurring') {
      if (!FREQ[d.frequency]) throw bad('Frequency must be weekly, monthly, quarterly or yearly.');
      if (!isDate(d.anchor_date)) throw bad('First due date is required.');
      if (d.end_date && !isDate(d.end_date)) throw bad('End date is not valid.');
      if (d.end_date && d.end_date < d.anchor_date) throw bad('The end date is before the first due date.');
      if (!validMinor(base.amount)) throw bad('Amount is required.');
      const interval = Math.max(1, Math.min(Number(d.interval_n) || 1, 60));
      const id = insert('plans', {
        ...row, amount: base.amount, frequency: d.frequency, interval_n: interval, anchor_date: d.anchor_date, end_date: d.end_date || null,
        amount_status: d.amount_status === 'confirmed' ? 'confirmed' : 'estimated',
      });
      audit(user, 'plan', id, 'created');
      materialize(true);
      return getPlan(id);
    }
    const rows = Array.isArray(d.rows) ? d.rows : [];
    if (!rows.length) throw bad('Add at least one installment.');
    if (rows.length > 600) throw bad('Too many installments.');
    const verified = d.verified ? 1 : 0;
    const id = insert('plans', {
      ...row, verified, amount_status: verified ? 'confirmed' : 'estimated',
      principal: Number.isInteger(d.principal) ? d.principal : null,
    });
    rows.forEach((r, i) => {
      if (!r || typeof r !== 'object') throw bad(`Installment ${i + 1} is empty.`);
      if (!validMinor(r.amount)) throw bad(`Installment ${i + 1}: amount is required.`);
      if (!isDate(r.due_date)) throw bad(`Installment ${i + 1}: due date is not valid.`);
      const now = nowIso();
      insert('items', {
        direction: row.direction, kind: r.kind === 'balloon' ? 'balloon' : 'installment',
        title: `${row.title} — ${r.label || (r.kind === 'balloon' ? 'Balloon payment' : `Installment ${i + 1} of ${rows.length}`)}`,
        counterparty: row.counterparty, entity_id: row.entity_id, category_id: row.category_id, plan_id: id, period_key: String(i + 1),
        amount: r.amount, currency: row.currency, due_date: r.due_date, amount_status: verified ? 'confirmed' : 'estimated', billed: verified,
        source: 'schedule', is_demo: extra.is_demo || 0, created_by: user?.id ?? null, created_at: now, updated_at: now,
      });
    });
    audit(user, 'plan', id, 'created', { note: verified ? 'lender schedule (verified)' : 'projected schedule (not verified)' });
    return getPlan(id);
  });
}

export function planStats(planId, t = today()) {
  const items = listItems({ plan_id: planId }, t);
  const open = items.filter((i) => i.outstanding > 0);
  const last = items.length ? items.reduce((a, b) => (b.due_date > a.due_date ? b : a)) : null;
  const pick = (i) => i && { id: i.id, title: i.title, due_date: i.due_date, amount: i.amount, outstanding: i.outstanding, kind: i.kind };
  return {
    count: items.length,
    total: items.reduce((s, i) => s + i.amount, 0),
    paid: items.reduce((s, i) => s + i.paid, 0),
    remaining: open.reduce((s, i) => s + i.outstanding, 0),
    next: pick(open[0]),
    final: pick(last),
    balloon: pick(items.find((i) => i.kind === 'balloon')),
    overdue: open.filter((i) => i.overdue).length,
  };
}
export function getPlan(id) {
  const plan = get(
    `SELECT p.*, e.name AS entity_name, e.kind AS entity_kind, c.name AS category_name
     FROM plans p LEFT JOIN entities e ON e.id = p.entity_id LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?`, id);
  if (!plan) return null;
  plan.stats = planStats(id);
  return plan;
}
export const listPlans = (f = {}) =>
  all(`SELECT id FROM plans WHERE 1=1 ${f.type ? 'AND type = ?' : ''} ${f.entity_id ? 'AND entity_id = ?' : ''} ORDER BY active DESC, title`,
    ...[f.type, f.entity_id].filter(Boolean)).map((r) => getPlan(r.id));

export function updatePlan(id, d, user) {
  return tx(() => {
    const plan = get('SELECT * FROM plans WHERE id = ?', id);
    if (!plan) throw new HttpError(404, 'Plan not found.');
    const t = today();
    const untouched = `plan_id = ? AND voided_at IS NULL AND id NOT IN (SELECT item_id FROM payments WHERE voided_at IS NULL)`;
    if (d.verified !== undefined && plan.type !== 'recurring' && !!d.verified !== !!plan.verified) {
      const v = d.verified ? 1 : 0;
      run('UPDATE plans SET verified = ?, amount_status = ? WHERE id = ?', v, v ? 'confirmed' : 'estimated', id);
      run(`UPDATE items SET amount_status = ?, billed = ?, updated_at = ? WHERE plan_id = ? AND voided_at IS NULL AND amount_status != 'needs_review'`,
        v ? 'confirmed' : 'estimated', v, nowIso(), id);
      audit(user, 'plan', id, v ? 'schedule verified against lender' : 'schedule marked unverified');
    }
    if (plan.type === 'recurring') {
      if (d.amount !== undefined && d.amount !== plan.amount) {
        if (!validMinor(d.amount)) throw bad('Amount must be greater than zero.');
        run('UPDATE plans SET amount = ? WHERE id = ?', d.amount, id);
        run(`UPDATE items SET amount = ?, updated_at = ? WHERE ${untouched} AND billed = 0 AND due_date >= ?`, d.amount, nowIso(), id, t);
        audit(user, 'plan', id, 'updated', { field: 'amount', oldValue: plan.amount, newValue: d.amount });
      }
      if (d.active !== undefined && !!d.active !== !!plan.active) {
        run('UPDATE plans SET active = ? WHERE id = ?', d.active ? 1 : 0, id);
        // Stopping a recurring plan removes its untouched future forecasts; anything billed or paid stays.
        if (!d.active) run(`DELETE FROM items WHERE ${untouched} AND source = 'forecast' AND billed = 0 AND due_date >= ? AND id NOT IN (SELECT item_id FROM document_links)`, id, t);
        audit(user, 'plan', id, d.active ? 'resumed' : 'stopped');
        if (d.active) materialize(true);
      }
    }
    return getPlan(id);
  });
}

// ---- matching bills to forecasts, duplicate detection ----
/** Unbilled forecast entries that a newly received bill most likely replaces. */
export function findForecastMatches({ direction = 'out', counterparty, title, currency, due_date, issue_date }) {
  const ref = due_date || issue_date;
  const name = [counterparty, title].filter(Boolean).join(' ');
  if (!name) return [];
  const rows = all(
    `SELECT i.id, i.title, i.counterparty, i.amount, i.currency, i.due_date, i.amount_status, i.plan_id, p.title AS plan_title
     FROM items i JOIN item_balances b ON b.item_id = i.id LEFT JOIN plans p ON p.id = i.plan_id
     WHERE i.billed = 0 AND i.voided_at IS NULL AND i.direction = ? AND i.currency = ? AND b.paid + b.credited = 0 AND i.due_date IS NOT NULL`,
    direction, currency);
  return rows
    .map((r) => {
      const overlap = Math.max(nameOverlap(r.counterparty || '', name), nameOverlap(name, `${r.counterparty || ''} ${r.plan_title || r.title}`));
      const gap = ref ? Math.abs(diffDays(r.due_date, ref)) : 999;
      return { ...r, overlap, gap };
    })
    .filter((r) => r.overlap >= 0.6 && (ref ? r.gap <= 20 : true))
    .sort((a, b) => a.gap - b.gap || b.overlap - a.overlap || (a.due_date < b.due_date ? -1 : 1))
    .slice(0, 3)
    .map((r) => ({
      id: r.id, title: r.title, amount: r.amount, currency: r.currency, due_date: r.due_date,
      reason: ref ? `Same payee, forecast due ${r.gap === 0 ? 'the same day' : `${r.gap} day${r.gap === 1 ? '' : 's'} apart`}` : 'Same payee (bill has no date yet)',
    }));
}

export function findDuplicates({ counterparty, reference, amount, currency, due_date, direction = 'out' }, excludeId = null) {
  const out = [];
  const seen = new Set();
  const push = (r, why) => { if (r.id !== excludeId && !seen.has(r.id)) { seen.add(r.id); out.push({ id: r.id, title: r.title, due_date: r.due_date, amount: r.amount, currency: r.currency, why }); } };
  if (reference && compact(reference).length >= 3) {
    for (const r of all('SELECT * FROM items WHERE voided_at IS NULL AND direction = ? AND reference IS NOT NULL', direction)) {
      if (compact(r.reference) === compact(reference) && (!counterparty || !r.counterparty || nameOverlap(counterparty, r.counterparty) >= 0.5 || norm(counterparty) === norm(r.counterparty))) {
        push(r, `Same reference ${r.reference}`);
      }
    }
  }
  if (counterparty && amount != null && due_date) {
    for (const r of all('SELECT * FROM items WHERE voided_at IS NULL AND direction = ? AND amount = ? AND currency = ? AND due_date = ? AND billed = 1', direction, amount, currency, due_date)) {
      if (norm(r.counterparty) === norm(counterparty)) push(r, 'Same payee, amount and due date');
    }
  }
  return out;
}

/**
 * Turn a received bill into a ledger entry. If it answers a forecast, the forecast row itself becomes
 * the confirmed bill (so it shows once); otherwise a new item is created.
 */
export function recordBill(fields, user, { matchItemId = null, source = 'manual', is_demo = 0 } = {}) {
  return tx(() => {
    if (matchItemId) {
      const f = get('SELECT * FROM items WHERE id = ? AND voided_at IS NULL', matchItemId);
      if (!f) throw bad('The forecast entry to match no longer exists.');
      if (f.billed) throw bad('That entry already has a bill matched to it.');
      const cur = String(fields.currency || f.currency).toUpperCase();
      if (cur !== f.currency) throw bad(`The forecast is in ${f.currency} but this bill is in ${cur}. Add it as a separate bill, or correct the currency.`);
      if ((fields.direction || f.direction) !== f.direction) throw bad(f.direction === 'out' ? 'The forecast is a payment you make; this document is money owed to you. Add it as a separate entry.' : 'The forecast is money owed to you; this document is a bill. Add it as a separate entry.');
      const patch = { billed: 1, amount_status: fields.amount_status || 'confirmed' };
      for (const k of ['amount', 'reference', 'issue_date', 'due_date', 'counterparty', 'notes']) if (fields[k] != null && fields[k] !== '') patch[k] = fields[k];
      const item = updateItem(matchItemId, patch, user, 'bill matched to forecast');
      return { item, matched_forecast: true };
    }
    const item = createItem(fields, user, { source, is_demo });
    return { item, matched_forecast: false };
  });
}
