// "Going live" check: clear the demo, then run records that are not demo data through every path,
// checking the numbers to the fil. Fixtures in test/fixtures are fictional. "Today" is pinned to
// 15 Dec 2029 (Asia/Dubai) so the dates in the fixtures stay meaningful.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexter-real-'));
const fixture = (n) => fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url));
let port, child, logs = '';
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
async function start() {
  child = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(port), DEXTER_DATA_DIR: dataDir, DEXTER_TODAY: '2029-12-15', NODE_NO_WARNINGS: '1', SMTP_URL: '', MAIL_FROM: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => (logs += d));
  await new Promise((resolve, reject) => { child.stdout.on('data', (d) => { logs += d; if (String(d).includes('running at')) resolve(); }); child.on('exit', (c) => reject(new Error(`exit ${c}`))); });
}
const stop = () => new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); });
function client() {
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const buf = Buffer.isBuffer(body);
    const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, body: body ? (buf ? body : JSON.stringify(body)) : undefined,
      headers: { 'X-Dexter': '1', ...(cookie ? { cookie } : {}), 'content-type': buf ? 'application/octet-stream' : 'application/json', ...headers } });
    if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    return { status: res.status, body: (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text() };
  };
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b), patch: (u, b) => call('PATCH', u, b), put: (u, b) => call('PUT', u, b),
    upload: (u, name, buf) => call('POST', u, buf, { 'x-filename': encodeURIComponent(name) }) };
}
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const owner = client(), acct = client();
const find = async (q) => ok(await owner.get(`/api/items?q=${encodeURIComponent(q)}`)).items;
const cat = (b, name) => b.categories.find((c) => c.name === name).id;
let boot, car, bank, card;

before(async () => { port = await freePort(); await start(); });
after(async () => { await stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('clearing the demo leaves a truly empty workspace', async () => {
  ok(await owner.post('/api/setup', { name: 'Owner', email: 'owner@example.test', password: 'owner-password-1', demo: true }));
  ok(await owner.post('/api/users', { name: 'Accountant', email: 'acct@example.test', password: 'accountant-pass-1', role: 'accountant' }));
  ok(await acct.post('/api/login', { email: 'acct@example.test', password: 'accountant-pass-1' }));
  ok(await owner.post('/api/categories', { name: 'Pool maintenance', group_kind: 'property' }));
  assert.equal((await acct.post('/api/demo/clear')).status, 403, 'only the owner can wipe the workspace');
  ok(await owner.post('/api/demo/clear'));
  boot = ok(await owner.get('/api/bootstrap'));
  assert.equal(boot.settings.demo_active, false);
  assert.deepEqual([boot.entities.length, boot.accounts.length, boot.samples.length], [0, 0, 0]);
  assert.ok(boot.categories.some((c) => c.name === 'Pool maintenance'), 'custom categories survive');
  assert.equal(ok(await owner.get('/api/items?state=all')).items.length, 0);
  assert.equal(ok(await owner.get('/api/txns')).length, 0);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'uploads')), [], 'demo files deleted from disk');
  assert.equal(fs.existsSync(path.join(dataDir, 'samples')), false);
  const d = ok(await owner.get('/api/dashboard'));
  assert.deepEqual([d.next_payment, d.upcoming.length, d.kpi.owed_total.length], [null, 0, 0]);
  assert.equal(ok(await acct.get('/api/bootstrap')).user.role, 'accountant', 'accountant stays signed in');
  assert.equal((await owner.post('/api/demo/clear')).status, 400, 'cannot clear twice');
});

test('setting up real accounts, a car loan with balloon, and a month-end recurring bill', async () => {
  car = ok(await owner.post('/api/entities', { kind: 'vehicle', name: 'Land Cruiser', details: { plate: 'TEST 1' } }));
  bank = ok(await owner.post('/api/accounts', { type: 'bank', name: 'Current account', currency: 'AED' }));
  card = ok(await owner.post('/api/accounts', { type: 'card', name: 'Platinum card', last4: '5521', currency: 'AED' }));
  assert.equal(car.is_demo, 0);
  const rows = Array.from({ length: 36 }, (_, i) => ({ due_date: `${2030 + Math.floor((i) / 12)}-${String((i % 12) + 1).padStart(2, '0')}-05`, amount: 412575 }));
  rows.push({ due_date: '2033-01-05', amount: 6500000, kind: 'balloon' });
  const loan = ok(await owner.post('/api/plans', { type: 'loan', title: 'Land Cruiser loan', counterparty: 'Test Auto Finance', entity_id: car.id, category_id: cat(boot, 'Car loan'), verified: true, rows }));
  assert.equal(loan.stats.remaining, 36 * 412575 + 6500000, 'AED 213,527.00 outstanding');
  assert.deepEqual([loan.stats.balloon.due_date, loan.stats.final.due_date, loan.stats.next.due_date], ['2033-01-05', '2033-01-05', '2030-01-05']);
  ok(await owner.post('/api/plans', { type: 'recurring', title: 'Electricity & water', counterparty: 'Desert Power & Water', category_id: cat(boot, 'Utilities'), amount: 90000, frequency: 'monthly', anchor_date: '2029-12-31', amount_status: 'estimated' }));
  const dates = (await find('Electricity & water')).map((i) => i.due_date).slice(0, 4);
  assert.deepEqual(dates, ['2029-12-31', '2030-01-31', '2030-02-28', '2030-03-31'], 'month-end does not drift after February');
  assert.equal((await owner.post('/api/items', { title: 'Zero', amount: 0, currency: 'AED', due_date: '2030-01-01' })).status, 400, 'zero bills rejected');
});

test('Excel backlog: real dates, numbers, a second currency with 3 decimals, a part-paid row', async () => {
  const up = ok(await acct.upload('/api/imports/sheet', 'backlog.xlsx', fixture('backlog.xlsx')));
  assert.deepEqual(up.import.rows.map((r) => r.status), ['ready', 'ready', 'ready'], JSON.stringify(up.import.rows.map((r) => r.message)));
  const c = ok(await acct.post(`/api/imports/${up.import.id}/commit`, {}));
  assert.equal(c.result.imported, 3);
  const [gc] = await find('GC-100'); const [kos] = await find('KOS-7'); const [ea] = await find('EA-55');
  assert.deepEqual([gc.amount, gc.currency, gc.issue_date, gc.due_date], [420050, 'AED', '2029-12-01', '2030-01-10']);
  assert.deepEqual([kos.amount, kos.currency], [12345, 'KWD'], 'KWD keeps 3 decimals');
  assert.deepEqual([ea.amount, ea.paid, ea.outstanding, ea.overdue], [125050, 50000, 75050, true]);
  const again = ok(await acct.upload('/api/imports/sheet', 'backlog-copy.xlsx', fixture('backlog.xlsx')));
  assert.equal(again.already, true, 're-import is a no-op');
});

test('scanned PDF (image only) is OCR’d and confirms the estimate; stopping the plan keeps the real bill', async () => {
  const up = ok(await acct.upload('/api/imports/document', 'scan.pdf', fixture('scanned-utility-bill.pdf')));
  const f = up.import.fields;
  assert.equal(up.import.document.extract_method, 'ocr');
  assert.deepEqual([f.amount.value, f.reference.value, f.due_date.value, f.supplier.value], [103460, 'DPW-55120', '2030-01-31', 'Desert Power & Water']);
  const fc = up.import.forecast_matches[0];
  assert.equal(fc.due_date, '2030-01-31');
  ok(await acct.post(`/api/imports/${up.import.id}/confirm`, { counterparty: f.supplier.value, reference: f.reference.value, amount: f.amount.value, currency: 'AED', due_date: f.due_date.value, match_item_id: fc.id }));
  const plan = (await find('Electricity & water'))[0].plan_id;
  ok(await owner.patch(`/api/plans/${plan}`, { active: false }));
  const left = await find('Electricity & water');
  assert.deepEqual(left.map((i) => [i.due_date, i.amount, i.billed]), [['2030-01-31', 103460, 1]], 'real Jan bill kept; unbilled estimates (incl. 31 Dec) removed');
  assert.equal((await find('DPW-55120')).length, 1, 'searchable by OCR text');
});

test('card purchase, card statement, bank repayment: spending counted once', async () => {
  const bag = ok(await owner.post('/api/items', { title: 'Laptop bag', counterparty: 'Noon', amount: 45000, currency: 'AED', issue_date: '2029-12-03', due_date: '2029-12-03', category_id: cat(boot, 'Family expenses') }));
  const cs = ok(await acct.upload(`/api/imports/statement?account_id=${card.id}`, 'card.csv', fixture('card-statement.csv')));
  assert.equal(cs.import.meta.positive_is_out, true, 'card statements: positive = spending');
  ok(await acct.post(`/api/imports/${cs.import.id}/commit`, {}));
  const ctx = ok(await acct.get(`/api/txns?account_id=${card.id}`));
  const pay = ctx.find((t) => /PAYMENT RECEIVED/.test(t.description));
  assert.deepEqual([pay.amount, pay.status], [200000, 'transfer'], 'card-side repayment is not income');
  const noon = ctx.find((t) => /NOON/.test(t.description));
  assert.equal(noon.amount, -45000);
  assert.equal(noon.suggestions[0].item_id, bag.id);
  ok(await acct.post(`/api/txns/${noon.id}/match`, { allocations: [{ item_id: bag.id, amount: 45000 }] }));
  assert.equal(ok(await acct.get(`/api/items/${bag.id}`)).item.status, 'paid');
  const cafe = ctx.find((t) => /CAFE/.test(t.description));
  ok(await acct.post(`/api/txns/${cafe.id}/mark`, { status: 'ignored' }));
  // Statement arrives later: the earlier card purchase attaches to it.
  const st = ok(await owner.post('/api/items', { kind: 'card_statement', title: 'Platinum statement Dec', counterparty: 'Card issuer', account_id: card.id, amount: 48800, min_due: 2440, currency: 'AED', issue_date: '2029-12-10', due_date: '2029-12-28', category_id: cat(boot, 'Credit card statement') }));
  const detail = ok(await owner.get(`/api/items/${st.id}`));
  assert.deepEqual(detail.purchases.map((p) => p.item_id), [bag.id]);
  // Bank side repays the statement in full.
  const bs = ok(await acct.upload(`/api/imports/statement?account_id=${bank.id}`, 'bank.csv', fixture('bank-statement.csv')));
  ok(await acct.post(`/api/imports/${bs.import.id}/commit`, {}));
  const btx = ok(await acct.get(`/api/txns?account_id=${bank.id}`));
  assert.equal(btx.find((t) => /SAVINGS/.test(t.description)).status, 'transfer');
  const ccp = btx.find((t) => /CARD PAYMENT/.test(t.description));
  assert.equal(ccp.suggestions[0].item_id, st.id);
  ok(await acct.post(`/api/txns/${ccp.id}/match`, { allocations: [{ item_id: st.id, amount: 48800 }] }));
  const tt = btx.find((t) => /EMIRATES AUTO/.test(t.description));
  ok(await acct.post(`/api/txns/${tt.id}/match`, { allocations: [{ item_id: tt.suggestions[0].item_id, amount: 75050 }] }));
  assert.equal((await find('EA-55'))[0].status, 'paid');
  const open = ok(await owner.get('/api/items?state=open')).items;
  assert.ok(!open.some((i) => [bag.id, st.id].includes(i.id)));
});

test('guard rails on real balances', async () => {
  const [gc] = await find('GC-100');
  ok(await owner.post(`/api/items/${gc.id}/payments`, { amount: 200000, date: '2029-12-14' }));
  assert.equal((await owner.post(`/api/items/${gc.id}/payments`, { amount: 220051 })).status, 400, 'overpayment by 1 fil rejected');
  assert.equal((await owner.post(`/api/items/${gc.id}/payments`, { type: 'refund', amount: 200001 })).status, 400, 'refund larger than paid rejected');
  assert.equal((await owner.patch(`/api/items/${gc.id}`, { currency: 'USD' })).status, 400, 'currency locked once paid');
  assert.equal((await owner.patch(`/api/items/${gc.id}`, { amount: 199999 })).status, 400, 'amount cannot drop below paid');
  ok(await owner.patch(`/api/items/${gc.id}`, { amount: 430050 }));
  assert.equal(ok(await owner.get(`/api/items/${gc.id}`)).item.outstanding, 230050);
});

test('dashboard totals add up exactly, currencies separate until a rate is set', async () => {
  const items = ok(await owner.get('/api/items?state=open&direction=out')).items;
  const sum = (c) => items.filter((i) => i.currency === c).reduce((s, i) => s + i.outstanding, 0);
  let d = ok(await owner.get('/api/dashboard?days=90'));
  assert.deepEqual(d.kpi.owed_total.map((t) => [t.currency, t.amount]), [['AED', sum('AED')], ['KWD', 12345]]);
  const up = d.upcoming.filter((i) => i.direction === 'out');
  assert.equal(d.kpi.outgoing.find((t) => t.currency === 'AED').amount, up.filter((i) => i.currency === 'AED').reduce((s, i) => s + i.outstanding, 0));
  assert.equal(d.kpi.overdue_out_count, 0, 'nothing overdue once Emirates Auto was paid');
  ok(await owner.put('/api/fx-rates/KWD', { rate: 11.95 }));
  d = ok(await owner.get('/api/dashboard?days=90'));
  assert.deepEqual(d.kpi.owed_total.map((t) => [t.currency, t.amount, t.converted_from]), [['AED', sum('AED') + Math.round(12.345 * 11.95 * 100), ['KWD']]]);
  assert.equal((await acct.put('/api/fx-rates/KWD', { rate: 1 })).status, 403, 'only the owner sets rates');
});

test('restart keeps everything; logs hold no financial details', async () => {
  const before = ok(await owner.get('/api/dashboard?days=90'));
  const exp = ok(await owner.get('/api/export/items.csv'));
  await stop(); await start();
  const after = ok(await owner.get('/api/dashboard?days=90'));
  assert.deepEqual(after.kpi, before.kpi);
  assert.equal(ok(await owner.get('/api/export/items.csv')), exp);
  for (const secret of ['Gulf Cooling', 'GC-100', 'Desert Power', 'Noon', '4,200', 'Land Cruiser', 'owner-password-1', 'acct@example.test']) assert.ok(!logs.includes(secret), `log leaked "${secret}"`);
  assert.ok(!/ERROR/.test(logs), logs);
});
