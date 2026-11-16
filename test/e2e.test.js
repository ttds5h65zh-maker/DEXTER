// End-to-end check against a real server process with a throwaway data folder (fictional demo data only).
// Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { SMTPServer } from 'smtp-server';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexter-test-'));
let port, smtpPort, child, smtp;
const mails = [];
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

async function start() {
  child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), DEXTER_DATA_DIR: dataDir, DEXTER_LOG: 'off', SMTP_URL: `smtp://127.0.0.1:${smtpPort}`, MAIL_FROM: 'Dexter <dexter@example.test>', NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('running at')) resolve(); });
    child.on('exit', (c) => reject(new Error(`server exited ${c}`)));
  });
}
const stop = () => new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); });

function client() {
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const isBuf = Buffer.isBuffer(body);
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method, headers: { 'X-Dexter': '1', ...(cookie ? { cookie } : {}), ...(body && !isBuf ? { 'content-type': 'application/json' } : {}), ...(isBuf ? { 'content-type': 'application/octet-stream' } : {}), ...headers },
      body: body ? (isBuf ? body : JSON.stringify(body)) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
  };
  return {
    get: (u) => call('GET', u), post: (u, b) => call('POST', u, b), patch: (u, b) => call('PATCH', u, b),
    upload: (u, file, buf) => call('POST', u, buf, { 'x-filename': encodeURIComponent(file) }),
  };
}
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const owner = client();
const accountant = client();
const sample = (name) => fs.readFileSync(path.join(dataDir, 'samples', name));
const byTitle = async (c, q) => ok(await c.get(`/api/items?q=${encodeURIComponent(q)}`)).items;
let boot, bankId;

before(async () => {
  port = await freePort(); smtpPort = await freePort();
  smtp = new SMTPServer({ authOptional: true, disabledCommands: ['STARTTLS'], onData(stream, _s, cb) { let d = ''; stream.on('data', (c) => (d += c)); stream.on('end', () => { mails.push(d); cb(); }); } });
  await new Promise((r) => smtp.listen(smtpPort, '127.0.0.1', r));
  await start();
});
after(async () => { await stop(); smtp.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('first run: owner account + fictional demo', async () => {
  assert.equal(ok(await owner.get('/api/bootstrap')).needs_setup, true);
  assert.equal((await owner.get('/api/dashboard')).status, 401);
  boot = ok(await owner.post('/api/setup', { name: 'Owner', email: 'owner@example.test', password: 'owner-password-1', demo: true }));
  assert.equal(boot.user.role, 'owner');
  assert.equal(boot.settings.base_currency, 'AED');
  assert.equal(boot.settings.timezone, 'Asia/Dubai');
  bankId = boot.accounts.find((a) => a.type === 'bank').id;
  assert.equal((await client().post('/api/setup', { name: 'x', email: 'x@example.test', password: 'another-password' })).status, 403);
});

test('dashboard answers the four questions; currencies stay separate', async () => {
  const d = ok(await owner.get('/api/dashboard?days=30'));
  assert.ok(d.next_payment && d.next_payment.direction === 'out');
  assert.ok(d.kpi.overdue_out_count >= 1 && d.kpi.overdue_in_count >= 1);
  assert.ok(d.kpi.unbilled_count >= 1);
  const cur = d.kpi.outgoing.map((x) => x.currency);
  assert.deepEqual(cur, ['AED', 'USD'], 'USD subscription is not mixed into AED');
  const aedBefore = d.kpi.outgoing[0].amount;
  // Once the owner enters a rate, USD folds into AED and is labelled.
  ok(await owner.post('/api/logout')); ok(await owner.post('/api/login', { email: 'owner@example.test', password: 'owner-password-1' }));
  const r = await fetch(`http://127.0.0.1:${port}/api/bootstrap`); assert.equal((await r.json()).user, null);
  const put = await owner.patch('/api/settings', { workspace_name: 'Dexter Payments' }); assert.equal(put.status, 200);
  const d7 = ok(await owner.get('/api/dashboard?days=7'));
  assert.ok(d7.upcoming.length < d.upcoming.length);
  assert.ok(aedBefore > 0);
});

test('ledger: AED 5,000 bill with AED 2,000 paid shows AED 3,000 outstanding; refunds, credits, corrections are tracked', async () => {
  const item = ok(await owner.post('/api/items', { title: 'Test bill', counterparty: 'Test Supplier', amount: 500000, currency: 'AED', due_date: boot.today }));
  let r = ok(await owner.post(`/api/items/${item.id}/payments`, { amount: 200000 }));
  assert.equal(r.item.outstanding, 300000); assert.equal(r.item.status, 'partial');
  assert.equal((await owner.post(`/api/items/${item.id}/payments`, { amount: 300001 })).status, 400, 'overpayment rejected');
  r = ok(await owner.post(`/api/items/${item.id}/payments`, { type: 'credit', amount: 50000, note: 'Credit note' }));
  assert.equal(r.item.outstanding, 250000);
  r = ok(await owner.post(`/api/items/${item.id}/payments`, { type: 'refund', amount: 20000 }));
  assert.equal(r.item.outstanding, 270000);
  const proof = ok(await owner.upload(`/api/items/${item.id}/documents?purpose=proof`, 'proof.pdf', sample('2-contractor-invoice.pdf')));
  r = ok(await owner.post(`/api/items/${item.id}/payments`, { amount: 270000, proof_document_id: proof.id }));
  assert.equal(r.item.status, 'paid');
  const detail = ok(await owner.get(`/api/items/${item.id}`));
  assert.equal(detail.payments.at(-1).proof_filename, 'proof.pdf');
  ok(await owner.post(`/api/payments/${detail.payments.at(-1).id}/void`));
  ok(await owner.patch(`/api/items/${item.id}`, { amount: 520000 }));
  const h = ok(await owner.get(`/api/items/${item.id}`)).history.find((x) => x.field === 'amount');
  assert.deepEqual([h.old_value, h.new_value, h.by_name], ['500000', '520000', 'Owner']);
  ok(await owner.post(`/api/items/${item.id}/payments`, { amount: 290000 }));
});

test('paper file: scanned bill is OCR’d, reviewed, and confirms the recurring estimate without duplicating it', async () => {
  const before = (await byTitle(owner, 'Electricity & water')).filter((i) => i.outstanding > 0);
  const forecast = before[0];
  assert.equal(forecast.amount_status, 'estimated'); assert.equal(forecast.billed, 0);
  const up = ok(await owner.upload('/api/imports/document', 'utility.png', sample('1-scanned-utility-bill.png')));
  const imp = up.import;
  assert.equal(imp.document.extract_method, 'ocr');
  assert.equal(imp.fields.amount.value, 91240);
  assert.equal(imp.fields.currency.value, 'AED');
  assert.equal(imp.fields.reference.value, 'DPW-88214');
  assert.equal(imp.fields.due_date.value, forecast.due_date);
  assert.equal(imp.fields.supplier.value, 'Desert Power & Water');
  assert.equal(imp.forecast_matches[0].id, forecast.id);
  // Same file again → same import, nothing new.
  const again = ok(await owner.upload('/api/imports/document', 'utility-copy.png', sample('1-scanned-utility-bill.png')));
  assert.equal(again.already, true); assert.equal(again.import.id, imp.id);
  const f = imp.fields;
  const c = ok(await owner.post(`/api/imports/${imp.id}/confirm`, { counterparty: f.supplier.value, reference: f.reference.value, amount: f.amount.value, currency: 'AED', issue_date: f.issue_date.value, due_date: f.due_date.value, match_item_id: forecast.id }));
  assert.equal(c.matched_forecast, true); assert.equal(c.item.id, forecast.id);
  assert.equal(c.item.amount, 91240); assert.equal(c.item.amount_status, 'confirmed'); assert.equal(c.item.billed, 1);
  const after = (await byTitle(owner, 'Electricity & water')).filter((i) => i.due_date === forecast.due_date);
  assert.equal(after.length, 1, 'still exactly one entry for that period');
  const d = ok(await owner.get(`/api/items/${forecast.id}`));
  assert.equal(d.documents.length, 1);
  const found = await byTitle(owner, 'DPW-88214'); assert.ok(found.some((i) => i.id === forecast.id), 'searchable by text inside the scan');
  // The document is only served to a signed-in user.
  const anon = await fetch(`http://127.0.0.1:${port}/api/documents/${d.documents[0].id}/file`); assert.equal(anon.status, 401);
});

test('paper file: PDF with a text layer is read directly and previewed as page images', async () => {
  const up = ok(await owner.upload('/api/imports/document', 'contractor.pdf', sample('2-contractor-invoice.pdf')));
  const f = up.import.fields;
  assert.equal(up.import.document.extract_method, 'pdf-text');
  assert.deepEqual([f.supplier.value, f.reference.value, f.amount.value], ['Palm Contracting', 'PC-0463', 385000]);
  assert.ok(f.due_date.value && f.issue_date.value);
  const c = ok(await owner.post(`/api/imports/${up.import.id}/confirm`, { counterparty: f.supplier.value, reference: f.reference.value, amount: f.amount.value, currency: 'AED', due_date: f.due_date.value }));
  assert.equal(c.matched_forecast, false);
  assert.equal((await owner.post(`/api/imports/${up.import.id}/confirm`, {})).status, 400, 'cannot confirm twice');
  const page = await owner.get(`/api/documents/${up.import.document.id}/page/1`);
  assert.equal(page.status, 200); assert.ok(page.body.startsWith('\x89PNG') || page.body.includes('PNG'));
});

test('spreadsheet: preview, validation, duplicates, fix a row, safe re-import', async () => {
  const up = ok(await owner.upload('/api/imports/sheet', 'backlog.csv', sample('3-backlog-spreadsheet.csv')));
  const st = up.import.rows.map((r) => r.status);
  assert.deepEqual(st, ['ready', 'duplicate', 'error', 'review', 'ready']);
  assert.match(up.import.rows[2].message, /not a valid date/);
  let c = ok(await owner.post(`/api/imports/${up.import.id}/commit`, {}));
  assert.deepEqual([c.result.imported, c.result.skipped_duplicates, c.result.errors, c.result.needs_review], [3, 1, 1, 1]);
  const paid = (await byTitle(owner, 'Kitchen rewiring'))[0]; assert.equal(paid.status, 'paid');
  const review = ok(await owner.get('/api/items?state=needs_review')).items; assert.ok(review.some((i) => i.title === 'Paint and fittings'));
  const bad = c.import.rows[2]; const cells = [...bad.raw]; cells[4] = '28/02/2027';
  const fixed = ok(await owner.patch(`/api/import-rows/${bad.id}`, { cells }));
  assert.equal(fixed.rows[2].status, 'ready');
  c = ok(await owner.post(`/api/imports/${up.import.id}/commit`, {}));
  assert.equal(c.result.imported, 1); assert.equal(c.import.status, 'review' === c.import.status ? 'review' : 'done');
  const n = ok(await owner.get('/api/items?q=Shield')).items.length;
  const re = ok(await owner.upload('/api/imports/sheet', 'backlog-again.csv', sample('3-backlog-spreadsheet.csv')));
  assert.equal(re.already, true);
  assert.equal(ok(await owner.get('/api/items?q=Shield')).items.length, n);
});

test('accountant: own login, manages records, no owner controls', async () => {
  ok(await owner.post('/api/users', { name: 'Accountant', email: 'accountant@example.test', password: 'accountant-pass-1', role: 'accountant' }));
  assert.equal((await accountant.post('/api/login', { email: 'accountant@example.test', password: 'wrong-password' })).status, 401);
  assert.equal(ok(await accountant.post('/api/login', { email: 'accountant@example.test', password: 'accountant-pass-1' })).user.role, 'accountant');
  assert.equal((await accountant.get('/api/users')).status, 403);
  assert.equal((await accountant.patch('/api/settings', { base_currency: 'USD' })).status, 403);
  assert.equal((await accountant.post('/api/users', { name: 'x', email: 'y@example.test', password: 'long-password-1' })).status, 403);
  assert.equal((await accountant.post('/api/demo/clear')).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403, 'no CSRF header');
  assert.equal(ok(await accountant.get('/api/export/items.csv')).includes('Outstanding'), true);
  const cat = ok(await accountant.post('/api/categories', { name: 'Pool maintenance', group_kind: 'property' })); assert.ok(cat.id);
});

test('statement: suggestions explain themselves; partial, split, incoming, card repayment, transfer', async () => {
  const up = ok(await accountant.upload(`/api/imports/statement?account_id=${bankId}`, 'statement.csv', sample('4-bank-statement.csv')));
  assert.equal(up.import.rows.every((r) => r.status === 'ready'), true);
  ok(await accountant.post(`/api/imports/${up.import.id}/commit`, {}));
  const txns = ok(await accountant.get('/api/txns'));
  assert.equal(txns.length, 7);
  const t = (re) => txns.find((x) => re.test(x.description));
  assert.equal(t(/SAVINGS/).status, 'transfer', 'transfer set aside automatically');

  // part payment on the contractor bill: 12,000 − 5,000 deposit − 3,000 = 4,000
  const palm = t(/PALM/); const s = palm.suggestions[0];
  assert.equal(s.title, 'Boundary wall repair');
  assert.ok(s.reasons.some((r) => /Reference PC-0457/.test(r)) && s.reasons.some((r) => /part payment/.test(r)));
  ok(await accountant.post(`/api/txns/${palm.id}/match`, { allocations: [{ item_id: s.item_id, amount: 300000 }] }));
  assert.equal(ok(await accountant.get(`/api/items/${s.item_id}`)).item.outstanding, 400000);

  // incoming payment updates the receivable: 18,500 − 6,000 − 5,000 = 7,500
  const cres = t(/CRESCENT/); assert.equal(cres.suggestions[0].title, 'Consulting retainer');
  ok(await accountant.post(`/api/txns/${cres.id}/match`, { allocations: [{ item_id: cres.suggestions[0].item_id, amount: 500000 }] }));
  const rec = ok(await accountant.get(`/api/items/${cres.suggestions[0].item_id}`));
  assert.equal(rec.item.outstanding, 750000); assert.equal(rec.item.paid, 1100000); assert.equal(rec.item.overdue, true);

  // one cheque split across two bills
  const chq = t(/CHEQUE/);
  const alnoor = (await byTitle(accountant, 'ANM-2291'))[0]; const sand = (await byTitle(accountant, 'SPH-881'))[0];
  assert.equal((await accountant.post(`/api/txns/${chq.id}/match`, { allocations: [{ item_id: alnoor.id, amount: 475000 }, { item_id: sand.id, amount: 231001 }] })).status, 400);
  ok(await accountant.post(`/api/txns/${chq.id}/match`, { allocations: [{ item_id: alnoor.id, amount: 475000 }, { item_id: sand.id, amount: 231000 }] }));
  assert.equal(ok(await accountant.get(`/api/items/${sand.id}`)).item.status, 'paid');

  // card repayment goes against the statement, and card purchases never show as cash due
  const cc = t(/CREDIT CARD/); assert.equal(cc.txn_kind, 'card_repayment');
  assert.equal(cc.suggestions[0].title, 'Gulf First Platinum statement');
  assert.ok(cc.suggestions[0].reasons.some((r) => /minimum due/.test(r)));
  ok(await accountant.post(`/api/txns/${cc.id}/match`, { allocations: [{ item_id: cc.suggestions[0].item_id, amount: 32403 }] }));
  const fin = ok(await accountant.get('/api/finance'));
  assert.equal(fin.cards[0].current.purchases.length, 2);
  const open = ok(await accountant.get('/api/items?state=open')).items;
  assert.ok(!open.some((i) => /groceries|tyres/i.test(i.title)), 'card purchases are settled, only the statement is payable');

  // re-importing the same statement adds nothing
  const re = ok(await accountant.upload(`/api/imports/statement?account_id=${bankId}`, 'statement.csv', sample('4-bank-statement.csv')));
  assert.equal(re.already, true);
  const renamed = Buffer.concat([sample('4-bank-statement.csv'), Buffer.from('\n')]);
  const re2 = ok(await accountant.upload(`/api/imports/statement?account_id=${bankId}`, 'statement2.csv', renamed));
  assert.equal(re2.import.rows.every((r) => r.status === 'duplicate'), true);
  assert.equal(ok(await accountant.get('/api/txns')).length, 7);

  // corrections record who made them
  ok(await accountant.patch(`/api/items/${alnoor.id}`, { notes: 'Checked against cheque stub' }));
  assert.equal(ok(await accountant.get(`/api/items/${alnoor.id}`)).history[0].by_name, 'Accountant');
});

test('vehicle: loan schedule, balloon on its own date, yearly cost', async () => {
  const fin = ok(await owner.get('/api/finance'));
  const loan = fin.loans.find((l) => l.title === 'Patrol car loan');
  assert.equal(loan.verified, 1);
  assert.equal(loan.stats.balloon.amount, 4500000);
  assert.equal(loan.stats.final.id, loan.stats.balloon.id, 'the balloon is the final payment');
  assert.equal(loan.stats.remaining, 16 * 315000 + 4500000);
  const cal = ok(await owner.get(`/api/calendar?month=${loan.stats.balloon.due_date.slice(0, 7)}`));
  const b = cal.items.find((i) => i.id === loan.stats.balloon.id);
  assert.equal(b.due_date, loan.stats.balloon.due_date); assert.equal(b.kind, 'balloon');
  const mort = fin.loans.find((l) => /mortgage/i.test(l.title)); assert.equal(mort.verified, 0);
  const page = ok(await owner.get(`/api/entities/${loan.entity_id}`));
  assert.ok(page.key_dates.insurance && page.year_cost.by_category.length >= 2);
  const mitem = ok(await owner.get(`/api/items?plan_id=${mort.id}`)).items[0]; assert.equal(mitem.projected, true);
});

test('reminders: in-app from day one; email only counts after a delivered code is confirmed', async () => {
  let r = ok(await owner.get('/api/reminders'));
  assert.ok(r.reminders.length > 3);
  assert.deepEqual([r.email.configured, r.email.verified], [true, false]);
  ok(await owner.post('/api/reminders/dismiss', { key: r.reminders[0].key }));
  assert.equal(ok(await owner.get('/api/reminders')).reminders.length, r.reminders.length - 1);
  ok(await owner.post('/api/reminders/email/send-code'));
  const code = mails.at(-1).match(/code is (\d{6})/)[1];
  assert.equal((await owner.post('/api/reminders/email/confirm', { code: '000000' === code ? '111111' : '000000' })).status, 400);
  assert.equal(ok(await owner.post('/api/reminders/email/confirm', { code })).verified, true);
});

test('everything survives a restart', async () => {
  const beforeDash = ok(await owner.get('/api/dashboard?days=30'));
  await stop(); await start();
  const d = ok(await owner.get('/api/dashboard?days=30'));
  assert.deepEqual(d.kpi, beforeDash.kpi);
  assert.equal(d.upcoming.length, beforeDash.upcoming.length);
  assert.equal((await byTitle(owner, 'Boundary wall repair'))[0].outstanding, 400000);
  assert.equal((await byTitle(owner, 'Consulting retainer'))[0].outstanding, 750000);
  assert.equal((await byTitle(owner, 'Electricity & water')).filter((i) => i.amount === 91240).length, 1);
  // the reminder digest was emailed after start-up to the verified address
  await new Promise((r) => setTimeout(r, 7000));
  assert.ok(mails.some((m) => /reminder/.test(m) && /To pay:/.test(m)));
});
