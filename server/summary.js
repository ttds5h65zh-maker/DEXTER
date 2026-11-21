// Read models: dashboard timeline, calendar, weekly summary, vehicle/property pages, loans & cards, reminders.
import { all, get, run, getSettings } from './db.js';
import { addDays, addMonths, weekStart, decimals, HttpError } from './util.js';
import { listItems, materialize, planStats, listPlans, statementPurchases, today } from './ledger.js';

/**
 * Sum per currency. Currencies are never mixed unless the owner entered an exchange rate,
 * in which case they are folded into the base currency and listed in `converted_from`.
 */
export function totals(items, field = 'outstanding') {
  const base = getSettings().base_currency;
  const rates = Object.fromEntries(all('SELECT currency, rate FROM fx_rates').map((r) => [r.currency, r.rate]));
  const by = new Map();
  const converted = new Set();
  for (const it of items) {
    const v = typeof field === 'function' ? field(it) : it[field];
    if (!v) continue;
    if (it.currency !== base && rates[it.currency]) {
      by.set(base, (by.get(base) || 0) + Math.round((v / 10 ** decimals(it.currency)) * rates[it.currency] * 10 ** decimals(base)));
      converted.add(it.currency);
    } else by.set(it.currency, (by.get(it.currency) || 0) + v);
  }
  const out = [...by.entries()].map(([currency, amount]) => ({ currency, amount, converted_from: currency === base ? [...converted] : [] }));
  return out.sort((a, b) => (a.currency === base ? -1 : b.currency === base ? 1 : a.currency.localeCompare(b.currency)));
}
function net(inItems, outItems) {
  const a = totals(inItems);
  const b = totals(outItems);
  const cur = [...new Set([...a, ...b].map((x) => x.currency))];
  return cur.map((c) => ({
    currency: c, amount: (a.find((x) => x.currency === c)?.amount || 0) - (b.find((x) => x.currency === c)?.amount || 0),
    converted_from: [...new Set([...(a.find((x) => x.currency === c)?.converted_from || []), ...(b.find((x) => x.currency === c)?.converted_from || [])])],
  }));
}
const byStatus = (items) => ({
  confirmed: totals(items.filter((i) => i.amount_status === 'confirmed' && !i.projected)),
  estimated: totals(items.filter((i) => i.amount_status === 'estimated' || (i.projected && i.amount_status !== 'needs_review'))),
  needs_review: totals(items.filter((i) => i.amount_status === 'needs_review')),
});

export function dashboard(days = 30) {
  materialize();
  const t = today();
  days = [7, 30, 90].includes(Number(days)) ? Number(days) : 30;
  const end = addDays(t, days);
  const open = listItems({ state: 'open' }, t);
  const dated = open.filter((i) => i.due_date);
  const upcoming = dated.filter((i) => i.due_date >= t && i.due_date <= end);
  const overdue = dated.filter((i) => i.due_date < t);
  const out = upcoming.filter((i) => i.direction === 'out');
  const inc = upcoming.filter((i) => i.direction === 'in');
  const overdueOut = overdue.filter((i) => i.direction === 'out');
  const overdueIn = overdue.filter((i) => i.direction === 'in');
  const unbilled = out.filter((i) => !i.billed);
  return {
    today: t, days, end,
    next_payment: out[0] || null,
    upcoming, overdue,
    needs_review: open.filter((i) => i.needs_review),
    kpi: {
      outgoing: totals(out), outgoing_by_status: byStatus(out),
      incoming: totals(inc), incoming_by_status: byStatus(inc),
      net: net(inc, out),
      overdue_out: totals(overdueOut), overdue_out_count: overdueOut.length,
      overdue_in: totals(overdueIn), overdue_in_count: overdueIn.length,
      // "How much do I still owe?" — every open payable, whatever its date.
      owed_total: totals(open.filter((i) => i.direction === 'out')),
      receivable_total: totals(open.filter((i) => i.direction === 'in')),
      unbilled: totals(unbilled), unbilled_count: unbilled.length,
    },
  };
}

export function calendar(month) {
  materialize();
  const t = today();
  if (!/^\d{4}-\d{2}$/.test(month || '')) month = t.slice(0, 7);
  const from = `${month}-01`;
  const to = addDays(addMonths(from, 1), -1);
  const items = listItems({ from, to }, t);
  return { month, from, to, today: t, items };
}

export function weekly(weeks = 8) {
  materialize();
  const t = today();
  const start = weekStart(t);
  weeks = Math.max(1, Math.min(Number(weeks) || 8, 26));
  const open = listItems({ state: 'open', from: start, to: addDays(start, weeks * 7 - 1) }, t);
  const out = [];
  for (let w = 0; w < weeks; w++) {
    const from = addDays(start, w * 7);
    const to = addDays(from, 6);
    const items = open.filter((i) => i.due_date >= from && i.due_date <= to);
    const o = items.filter((i) => i.direction === 'out');
    const n = items.filter((i) => i.direction === 'in');
    out.push({ from, to, current: w === 0, outgoing: totals(o), incoming: totals(n), net: net(n, o), out_count: o.length, in_count: n.length, estimated_count: items.filter((i) => i.amount_status !== 'confirmed' || i.projected).length, items });
  }
  const overdue = listItems({ state: 'overdue' }, t);
  return { today: t, weeks: out, overdue_out: totals(overdue.filter((i) => i.direction === 'out')), overdue_in: totals(overdue.filter((i) => i.direction === 'in')) };
}

export function entityPage(id, year) {
  materialize();
  const t = today();
  const entity = get('SELECT * FROM entities WHERE id = ?', id);
  if (!entity) throw new HttpError(404, 'Not found.');
  entity.details = JSON.parse(entity.details);
  year = /^\d{4}$/.test(String(year)) ? String(year) : t.slice(0, 4);
  const items = listItems({ entity_id: id }, t);
  const inYear = items.filter((i) => i.due_date && i.due_date.startsWith(year));
  const cost = inYear.filter((i) => i.direction === 'out' && i.kind !== 'card_statement');
  const income = inYear.filter((i) => i.direction === 'in');
  const cats = new Map();
  for (const i of cost) {
    const k = i.category_name || 'Uncategorised';
    if (!cats.has(k)) cats.set(k, []);
    cats.get(k).push(i);
  }
  const months = Array.from({ length: 12 }, (_, m) => {
    const key = `${year}-${String(m + 1).padStart(2, '0')}`;
    return { month: key, cost: totals(cost.filter((i) => i.due_date.startsWith(key)), 'amount'), income: totals(income.filter((i) => i.due_date.startsWith(key)), 'amount') };
  });
  const nextIn = (name) => {
    const i = items.find((x) => x.category_name === name && x.outstanding > 0 && x.due_date);
    return i ? { id: i.id, title: i.title, due_date: i.due_date, amount: i.amount, outstanding: i.outstanding, currency: i.currency, amount_status: i.amount_status, overdue: i.overdue } : null;
  };
  return {
    entity, year, today: t,
    plans: listPlans({ entity_id: id }),
    key_dates: entity.kind === 'vehicle'
      ? { insurance: nextIn('Car insurance'), registration: nextIn('Registration'), service: nextIn('Service & repairs') }
      : { rent_payable: nextIn('Rent payable'), rent_receivable: nextIn('Rent receivable'), maintenance: nextIn('Maintenance'), contractor: nextIn('Contractor bills') },
    year_cost: {
      total: totals(cost, 'amount'), paid: totals(cost, 'paid'), income: totals(income, 'amount'),
      by_category: [...cats.entries()].map(([category, list]) => ({ category, total: totals(list, 'amount'), paid: totals(list, 'paid'), count: list.length, estimated: list.some((i) => i.amount_status !== 'confirmed' || i.projected) })),
      months,
      has_estimates: cost.some((i) => i.amount_status !== 'confirmed' || i.projected),
    },
    upcoming: items.filter((i) => i.outstanding > 0),
    items,
  };
}

export function entitiesOverview() {
  materialize();
  const t = today();
  return all('SELECT * FROM entities WHERE archived = 0 ORDER BY kind, name').map((e) => {
    const open = listItems({ entity_id: e.id, state: 'open' }, t);
    const next = open.find((i) => i.due_date);
    return {
      ...e, details: JSON.parse(e.details),
      owed: totals(open.filter((i) => i.direction === 'out')), receivable: totals(open.filter((i) => i.direction === 'in')),
      next: next && { id: next.id, title: next.title, due_date: next.due_date, outstanding: next.outstanding, currency: next.currency, overdue: next.overdue, direction: next.direction },
      overdue_count: open.filter((i) => i.overdue).length,
    };
  });
}

export function finance() {
  materialize();
  const t = today();
  const loans = listPlans({}).filter((p) => p.type !== 'recurring');
  const cards = all("SELECT * FROM accounts WHERE type = 'card' ORDER BY name").map((card) => {
    const statements = listItems({ account_id: card.id, kind: 'card_statement', desc: true }, t).map((s) => ({ ...s, purchases: statementPurchases(s.id) }));
    const unassigned = all(
      `SELECT p.id AS payment_id, p.amount, p.date, i.id AS item_id, i.title, i.currency FROM payments p JOIN items i ON i.id = p.item_id
       WHERE p.card_account_id = ? AND p.statement_item_id IS NULL AND p.voided_at IS NULL ORDER BY p.date`, card.id);
    return { ...card, current: statements.find((s) => s.outstanding > 0) || statements[0] || null, statements, unassigned };
  });
  return { today: t, loans, cards, recurring: listPlans({ type: 'recurring' }) };
}

// ---- reminders ----
/** The reminder currently in force for each open record: overdue, or the tightest offset reached (e.g. 30 → 7 → 1 days). */
export function remindersFor(user, { includeDismissed = false } = {}) {
  materialize();
  const t = today();
  const prefs = JSON.parse(user.prefs || '{}');
  const offsets = (Array.isArray(prefs.reminder_offsets) ? prefs.reminder_offsets : [30, 7, 1]).map(Number).filter((n) => n >= 0).sort((a, b) => a - b);
  const max = offsets.length ? offsets[offsets.length - 1] : -1;
  const state = new Map(all('SELECT * FROM reminder_state WHERE user_id = ?', user.id).map((r) => [`${r.item_id}|${r.offset_days}|${r.due_date}`, r]));
  const out = [];
  for (const it of listItems({ state: 'open', to: addDays(t, Math.max(max, 0)) }, t)) {
    if (!it.due_date) continue;
    const offset = it.overdue ? -1 : offsets.find((o) => it.days_until <= o);
    if (offset === undefined) continue;
    const st = state.get(`${it.id}|${offset}|${it.due_date}`);
    if (st?.dismissed_at && !includeDismissed) continue;
    out.push({
      key: `${it.id}|${offset}|${it.due_date}`, item_id: it.id, offset_days: offset, due_date: it.due_date, overdue: it.overdue, days_until: it.days_until,
      title: it.title, direction: it.direction, outstanding: it.outstanding, currency: it.currency, amount_status: it.amount_status, emailed_at: st?.emailed_at || null,
    });
  }
  return out;
}
export function dismissReminder(user, key) {
  if (typeof key !== 'string' || !/^\d+\|-?\d+\|\d{4}-\d{2}-\d{2}$/.test(key)) throw new HttpError(400, 'Unknown reminder.');
  const [itemId, offset, due] = key.split('|');
  run(
    `INSERT INTO reminder_state (user_id, item_id, offset_days, due_date, dismissed_at) VALUES (?,?,?,?,?)
     ON CONFLICT(user_id, item_id, offset_days, due_date) DO UPDATE SET dismissed_at = excluded.dismissed_at`,
    user.id, Number(itemId), Number(offset), due, new Date().toISOString());
}
export function markEmailed(user, reminders) {
  for (const r of reminders) {
    run(
      `INSERT INTO reminder_state (user_id, item_id, offset_days, due_date, emailed_at) VALUES (?,?,?,?,?)
       ON CONFLICT(user_id, item_id, offset_days, due_date) DO UPDATE SET emailed_at = excluded.emailed_at`,
      user.id, r.item_id, r.offset_days, r.due_date, new Date().toISOString());
  }
}
export { planStats };
