// Run 1 — messy real-world files. Spreadsheets and bank exports the way accountants and banks really produce them.
// "Today" is pinned to 15 Dec 2029 (Asia/Dubai). All names and numbers are fictional.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, ok, fixture } from './helpers.js';

let srv, owner, boot, bank, card;
const csv = (s) => Buffer.from(s, 'utf8');
const rowsOf = (imp) => imp.rows.map((r) => [r.status, r.message]);
const find = async (q) => ok(await owner.get(`/api/items?q=${encodeURIComponent(q)}&include_void=0`)).items;
const statement = async (name, text, account = bank) => {
  const up = ok(await owner.upload(`/api/imports/statement?account_id=${account.id}`, name, csv(text)));
  return up;
};
const txnsBy = async (account) => ok(await owner.get(`/api/txns?account_id=${account.id}`));

before(async () => {
  srv = await startServer({ DEXTER_TODAY: '2029-12-15' });
  owner = client(srv.port);
  boot = ok(await owner.post('/api/setup', { name: 'Owner', email: 'owner@example.test', password: 'owner-password-1', demo: false }));
  bank = ok(await owner.post('/api/accounts', { type: 'bank', name: 'Current account', currency: 'AED' }));
  card = ok(await owner.post('/api/accounts', { type: 'card', name: 'Platinum card', currency: 'AED' }));
});
after(async () => srv.cleanup());

test('Excel: title rows above the header, second sheet, Yes/No paid column, totals row, Arabic text and digits', async () => {
  const up = ok(await owner.upload('/api/imports/sheet', 'messy-bills.xlsx', fixture('messy-bills.xlsx')));
  const imp = up.import;
  assert.deepEqual(imp.meta.headers.slice(0, 7), ['Supplier', 'Description', 'Invoice No', 'Invoice Date', 'Due Date', 'Amount', 'Paid?'], 'finds the real header row on the sheet that has data');
  const st = Object.fromEntries(imp.rows.map((r) => [r.raw[0] === 'US Vendor Inc' ? 'US' : r.raw[2] || r.raw[0], r]));
  assert.equal(st['GC-200'].status, 'ready', st['GC-200'].message);
  assert.equal(st['NP-55'].status, 'ready', st['NP-55'].message);
  assert.equal(st['W-881'].status, 'ready', st['W-881'].message);
  assert.equal(st['W-881'].parsed.amount, 250000, 'Arabic-Indic digits ٢٬٥٠٠٫٠٠ = 2,500.00');
  assert.equal(st['GC-CN-1'].status, 'error', 'a negative amount is not silently turned into a bill');
  assert.match(st['GC-CN-1'].message, /credit note|negative/i);
  assert.deepEqual([st.US.status, st.US.parsed.currency, st.US.parsed.amount], ['ready', 'USD', 120000], 'currency written inside the amount cell is used');
  const paper = imp.rows.find((r) => r.raw[0] === 'Desert Supplies');
  assert.equal(paper.status, 'ready', 'same invoice number from a different supplier is not a duplicate');
  assert.equal(paper.parsed.due_date, '2029-12-29', 'Excel serial number date');
  const total = imp.rows.find((r) => r.raw[0] === 'TOTAL');
  assert.equal(total.status, 'skipped', 'the TOTAL row is never imported as a bill');

  const c = ok(await owner.post(`/api/imports/${imp.id}/commit`, {}));
  assert.equal(c.result.imported, 5);
  assert.equal(c.result.skipped, 1);
  assert.equal(c.result.errors, 1);
  const [np] = await find('NP-55');
  assert.equal(np.status, 'paid', '"Yes" in the Paid column means fully paid');
  const [gc] = await find('GC-200');
  assert.equal(gc.status, 'open', '"No" means unpaid');
  const [water] = await find('W-881');
  assert.equal(water.counterparty, 'شركة المياه');
  const owed = ok(await owner.get('/api/dashboard?days=90')).kpi.owed_total;
  assert.deepEqual(owed.map((t) => [t.currency, t.amount]), [['AED', 420050 + 250000 + 9900], ['USD', 120000]], 'the totals row did not inflate what is owed');
});

test('signed register: negative = money out, positive = money in, when the accountant says so', async () => {
  const up = ok(await owner.upload('/api/imports/sheet', 'register.csv', csv('Date,Payee,Description,Amount\n01/12/2029,Landlord,Rent cheque,-5000\n02/12/2029,Client A,Invoice 17,3000\n')));
  assert.deepEqual(up.import.rows.map((r) => r.status), ['error', 'review']);
  const fixed = ok(await owner.patch(`/api/imports/${up.import.id}`, { negative_means: 'signed' }));
  assert.deepEqual(fixed.rows.map((r) => [r.status, r.parsed.direction, r.parsed.amount]), [['review', 'out', 500000], ['review', 'in', 300000]]);
});

test('bank export with Debit Amount / Credit Amount columns and opening/closing balance lines', async () => {
  const up = await statement('bank-dc.csv', [
    'Transaction Date,Value Date,Narration,Debit Amount,Credit Amount,Balance',
    '01/12/2029,01/12/2029,Opening Balance,,,"25,000.00"',
    '02/12/2029,02/12/2029,DEWA BILL PAYMENT,912.40,,"24,087.60"',
    '03/12/2029,03/12/2029,SALARY CREDIT,,"30,000.00","54,087.60"',
    '31/12/2029,31/12/2029,Closing Balance,,,"54,087.60"',
  ].join('\n'));
  const m = up.import.meta.mapping;
  assert.equal(up.import.meta.headers[m.debit], 'Debit Amount');
  assert.equal(up.import.meta.headers[m.credit], 'Credit Amount');
  assert.deepEqual(up.import.rows.map((r) => r.status), ['skipped', 'ready', 'ready', 'skipped'], JSON.stringify(rowsOf(up.import)));
  assert.deepEqual(up.import.rows.filter((r) => r.status === 'ready').map((r) => r.parsed.amount), [-91240, 3000000], 'a debit is money out');
  ok(await owner.post(`/api/imports/${up.import.id}/commit`, {}));
});

test('semicolon export with commas in descriptions, decimal commas, BOM and a line break inside a description', async () => {
  const up = await statement('bank-eu.csv', '﻿Date;Description;Amount\n04/12/2029;"Coffee, cake, water";-38,50\n05/12/2029;"Transfer to\nSavings own account";-1.000,00\n06/12/2029;"Dinner, drinks, tip, parking, valet";-420,00\n');
  assert.deepEqual(up.import.meta.headers, ['Date', 'Description', 'Amount']);
  assert.deepEqual(up.import.rows.map((r) => [r.status, r.parsed?.amount, r.parsed?.kind]), [['ready', -3850, 'normal'], ['ready', -100000, 'transfer'], ['ready', -42000, 'normal']]);
  ok(await owner.post(`/api/imports/${up.import.id}/commit`, {}));
});

test('CR / DR suffixes, trailing minus, unicode minus and brackets all keep the right sign', async () => {
  const up = await statement('bank-signs.csv', 'Date,Description,Amount\n07/12/2029,ATM WITHDRAWAL,500.00 DR\n08/12/2029,REFUND FROM SUPPLIER,120.00 CR\n09/12/2029,BANK CHARGES,25.00-\n10/12/2029,FX FEE,−4.75\n11/12/2029,CHEQUE RETURN FEE,(50.00)\n');
  assert.deepEqual(up.import.rows.map((r) => r.parsed.amount), [-50000, 12000, -2500, -475, -5000]);
});

test('identical same-day transactions, then an overlapping export: nothing lost, nothing doubled', async () => {
  const a = await statement('week1.csv', 'Date,Description,Amount\n12/12/2029,CAFE NERO JLT,-18.00\n12/12/2029,CAFE NERO JLT,-18.00\n', card);
  ok(await owner.post(`/api/imports/${a.import.id}/commit`, {}));
  const b = await statement('week1-2.csv', 'Date,Description,Amount\n12/12/2029,CAFE NERO JLT,-18.00\n12/12/2029,CAFE NERO JLT,-18.00\n12/12/2029,CAFE NERO JLT,-18.00\n13/12/2029,TAXI,-35.00\n', card);
  assert.deepEqual(b.import.rows.map((r) => r.status), ['duplicate', 'duplicate', 'ready', 'ready']);
  ok(await owner.post(`/api/imports/${b.import.id}/commit`, {}));
  const t = await txnsBy(card);
  assert.equal(t.filter((x) => /CAFE/.test(x.description)).length, 3);
  assert.equal(t.length, 4);
});

test('the same scan uploaded twice at the same moment (double tap) creates one document and one review', async () => {
  const png = Buffer.from(await (await import('../server/demo.js')).makeScan([['Sandstone Print House', 40, true], ['Invoice No: SPH-990'], ['Due Date: 30/12/2029'], ['Total Due: AED 640.00', 34, true]]));
  const [r1, r2] = await Promise.all([owner.upload('/api/imports/document', 'IMG_0001.png', png), owner.upload('/api/imports/document', 'IMG_0001 copy.png', png)]);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal(r1.body.import.id, r2.body.import.id);
  const inbox = ok(await owner.get('/api/inbox'));
  assert.equal(inbox.imports.filter((i) => i.type === 'document').length, 1);
});

test('a bill cannot be matched to a forecast in another currency or direction', async () => {
  const plan = ok(await owner.post('/api/plans', { type: 'recurring', title: 'Office cleaning', counterparty: 'Sparkle Cleaning', amount: 120000, currency: 'AED', frequency: 'monthly', anchor_date: '2029-12-28' }));
  const fc = (await find('Office cleaning'))[0];
  const up = ok(await owner.upload('/api/imports/document', 'sparkle.pdf', (await import('../server/demo.js')).makePdf([['Sparkle Cleaning', 18], ['Invoice No: SC-31'], ['Due Date: 28/12/2029'], ['Total Due: USD 330.00']])));
  const bad = await owner.post(`/api/imports/${up.import.id}/confirm`, { counterparty: 'Sparkle Cleaning', reference: 'SC-31', amount: 33000, currency: 'USD', due_date: '2029-12-28', match_item_id: fc.id });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /AED|currency/i);
  const badDir = await owner.post(`/api/imports/${up.import.id}/confirm`, { direction: 'in', counterparty: 'Sparkle Cleaning', amount: 120000, currency: 'AED', due_date: '2029-12-28', match_item_id: fc.id });
  assert.equal(badDir.status, 400);
  assert.equal((await find('Office cleaning'))[0].amount, 120000, 'forecast untouched');
  assert.equal((await owner.post('/api/plans', { type: 'recurring', title: 'Bad plan', amount: 100, frequency: 'monthly', anchor_date: '2030-01-10', end_date: '2029-12-01' })).status, 400, 'end date before first date is rejected');
  assert.ok(plan.id);
});
