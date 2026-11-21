// Run 3 (part 1) — everyday use over days and weeks: restarts with the calendar moving forward, two people at once.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, ok } from './helpers.js';

let srv, owner, acct, boot, card;
const find = async (q, c = owner) => ok(await c.get(`/api/items?q=${encodeURIComponent(q)}&state=all`)).items;
const restartOn = async (day) => { await srv.stop(); srv.child = null; process.env.__unused = day; await srv.startWith({ DEXTER_TODAY: day }); };

before(async () => {
  srv = await startServer({ DEXTER_TODAY: '2029-12-15' });
  // allow restarting the same data folder on a different "today"
  const { spawn } = await import('node:child_process');
  srv.startWith = async (env) => {
    srv.child = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(srv.port), DEXTER_DATA_DIR: srv.dataDir, NODE_NO_WARNINGS: '1', SMTP_URL: '', MAIL_FROM: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.child.stderr.on('data', (d) => (srv.logs += d));
    await new Promise((resolve) => srv.child.stdout.on('data', (d) => { srv.logs += d; if (String(d).includes('running at')) resolve(); }));
  };
  owner = client(srv.port); acct = client(srv.port);
  boot = ok(await owner.post('/api/setup', { name: 'Owner', email: 'owner@example.test', password: 'owner-password-1' }));
  ok(await owner.post('/api/users', { name: 'Accountant', email: 'acct@example.test', password: 'accountant-pass-1', role: 'accountant' }));
  ok(await acct.post('/api/login', { email: 'acct@example.test', password: 'accountant-pass-1' }));
  card = ok(await owner.post('/api/accounts', { type: 'card', name: 'Platinum card', currency: 'AED' }));
});
after(async () => srv.cleanup());

test('weekly summary: an overdue bill is shown once, under overdue, not again in "this week"', async () => {
  ok(await owner.post('/api/items', { title: 'Late bill', counterparty: 'A', amount: 10000, currency: 'AED', due_date: '2029-12-12' }));
  ok(await owner.post('/api/items', { title: 'Sunday bill', counterparty: 'B', amount: 20000, currency: 'AED', due_date: '2029-12-16' }));
  const w = ok(await owner.get('/api/weekly?weeks=2'));
  assert.equal(w.weeks[0].from, '2029-12-10');
  assert.deepEqual(w.weeks[0].items.map((i) => i.title), ['Sunday bill']);
  assert.deepEqual(w.weeks[0].outgoing, [{ currency: 'AED', amount: 20000, converted_from: [] }]);
  assert.deepEqual(w.overdue_out.map((t) => t.amount), [10000]);
});

test('saving a record without changing anything adds nothing to its history', async () => {
  const [it] = await find('Sunday bill');
  const before = ok(await owner.get(`/api/items/${it.id}`)).history.length;
  ok(await owner.patch(`/api/items/${it.id}`, { title: it.title, counterparty: it.counterparty, reference: '', amount: it.amount, currency: 'AED', issue_date: null, due_date: it.due_date, amount_status: it.amount_status, category_id: '', entity_id: '', notes: '' }));
  assert.equal(ok(await owner.get(`/api/items/${it.id}`)).history.length, before);
});

test('two people correct the same bill: the last save wins and both changes are in the history with names', async () => {
  const [it] = await find('Sunday bill');
  ok(await owner.patch(`/api/items/${it.id}`, { amount: 21000 }));
  ok(await acct.patch(`/api/items/${it.id}`, { amount: 22000 }));
  const d = ok(await owner.get(`/api/items/${it.id}`));
  assert.equal(d.item.amount, 22000);
  const amountChanges = d.history.filter((h) => h.field === 'amount').map((h) => [h.by_name, h.old_value, h.new_value]);
  assert.deepEqual(amountChanges, [['Accountant', '21000', '22000'], ['Owner', '20000', '21000']]);
});

test('paying an estimate before the bill arrives, then scanning the bill: still one entry, already paid', async () => {
  ok(await owner.post('/api/plans', { type: 'recurring', title: 'Electricity & water', counterparty: 'Desert Power & Water', amount: 85000, currency: 'AED', frequency: 'monthly', anchor_date: '2029-12-22', amount_status: 'estimated' }));
  const [dec] = (await find('Electricity & water')).filter((i) => i.due_date === '2029-12-22');
  ok(await owner.patch(`/api/items/${dec.id}`, { amount: 91240 }));
  ok(await owner.post(`/api/items/${dec.id}/payments`, { amount: 91240, date: '2029-12-15', method: 'bank' }));
  const { makePdf } = await import('../server/demo.js');
  const up = ok(await acct.upload('/api/imports/document', 'dewa.pdf', makePdf([['Desert Power & Water', 18], ['Bill No: DPW-77001'], ['Due Date: 22/12/2029'], ['Total Amount Due: AED 912.40']])));
  assert.equal(up.import.forecast_matches[0]?.id, dec.id, 'the paid estimate is still offered as the match');
  const f = up.import.fields;
  ok(await acct.post(`/api/imports/${up.import.id}/confirm`, { counterparty: f.supplier.value, reference: f.reference.value, amount: f.amount.value, currency: 'AED', due_date: f.due_date.value, match_item_id: dec.id }));
  const decs = (await find('Electricity & water')).filter((i) => i.due_date === '2029-12-22');
  assert.equal(decs.length, 1);
  assert.deepEqual([decs[0].status, decs[0].billed, decs[0].reference], ['paid', 1, 'DPW-77001']);
});

test('card purchase after a statement was issued goes to the next statement, not the old one', async () => {
  const st = ok(await owner.post('/api/items', { kind: 'card_statement', title: 'Dec statement', account_id: card.id, amount: 50000, min_due: 2500, currency: 'AED', issue_date: '2029-12-10', due_date: '2029-12-28' }));
  const shoes = ok(await owner.post('/api/items', { title: 'Shoes', counterparty: 'Mall', amount: 30000, currency: 'AED', issue_date: '2029-12-12', due_date: '2029-12-12' }));
  ok(await owner.post(`/api/items/${shoes.id}/payments`, { amount: 30000, date: '2029-12-12', method: 'card', card_account_id: card.id }));
  assert.equal(ok(await owner.get(`/api/items/${st.id}`)).purchases.length, 0);
  const jan = ok(await owner.post('/api/items', { kind: 'card_statement', title: 'Jan statement', account_id: card.id, amount: 30000, min_due: 1500, currency: 'AED', issue_date: '2030-01-10', due_date: '2030-01-28' }));
  assert.deepEqual(ok(await owner.get(`/api/items/${jan.id}`)).purchases.map((p) => p.item_id), [shoes.id]);
});

test('Arabic names are searchable; the CSV export opens in Excel with Arabic intact', async () => {
  ok(await owner.post('/api/items', { title: 'توصيل المياه', counterparty: 'شركة المياه', amount: 25000, currency: 'AED', due_date: '2029-12-20' }));
  assert.equal((await find('المياه')).length, 1);
  const res = await fetch(`http://127.0.0.1:${srv.port}/api/export/items.csv`, { headers: { cookie: owner.cookie } });
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 marker so Excel shows Arabic correctly');
  assert.ok(bytes.toString('utf8').includes('شركة المياه'));
});

test('days pass: a dismissed reminder comes back once the bill is overdue; forecasts roll forward; a skipped month stays skipped', async () => {
  const [sun] = await find('Sunday bill');
  let r = ok(await owner.get('/api/reminders')).reminders.find((x) => x.item_id === sun.id);
  assert.equal(r.offset_days, 1);
  ok(await owner.post('/api/reminders/dismiss', { key: r.key }));
  assert.equal(ok(await owner.get('/api/reminders')).reminders.find((x) => x.item_id === sun.id), undefined);
  const elec = await find('Electricity & water');
  const feb = elec.find((i) => i.due_date === '2030-02-22');
  ok(await owner.post(`/api/items/${feb.id}/void`, { reason: 'Away in February — no bill' }));

  await restartOn('2029-12-18');
  r = ok(await owner.get('/api/reminders')).reminders.find((x) => x.item_id === sun.id);
  assert.ok(r && r.overdue, 'overdue reminder shows even though the 1-day one was dismissed');
  assert.equal(ok(await owner.get('/api/dashboard')).kpi.overdue_out_count, 2);

  await restartOn('2030-06-15');
  const later = (await find('Electricity & water')).map((i) => i.due_date);
  assert.ok(later.includes('2031-05-22'), 'forecasts extend a year ahead of the new today');
  assert.equal(later.filter((d) => d === '2030-03-22').length, 1, 'no duplicate months after restarts');
  assert.ok(!later.includes('2030-02-22'), 'the voided month did not come back');
});
