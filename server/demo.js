// Fictional demo workspace. Every name, number and document here is invented.
// While the demo is active everything in the workspace is practice data; clearDemo() wipes it all.
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, insert, tx, db, setSetting, getSettings, DATA_DIR, UPLOAD_DIR } from './db.js';
import { addDays, addMonths, bad } from './util.js';
import { createItem, createPlan, addPayment, listItems, materialize, today } from './ledger.js';
import { storeDocument, linkDocument } from './imports.js';

export const SAMPLE_DIR = path.join(DATA_DIR, 'samples');
const AED = (n) => Math.round(n * 100);
const dmy = (d) => `${d.slice(8)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const long = (d) => `${Number(d.slice(8))} ${MON[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;

/** Minimal single-page PDF with a real text layer. lines: [text, size?] */
export function makePdf(lines) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, '-');
  let y = 790;
  const body = lines.map(([text, size = 11]) => { y -= size + 9; return `BT /F1 ${size} Tf 56 ${y} Td (${esc(text)}) Tj ET`; }).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A PNG that looks like a slightly skewed phone photo of a paper bill (no text layer, so it must be OCR'd). */
export async function makeScan(lines) {
  const { createCanvas } = await import('@napi-rs/canvas');
  const c = createCanvas(1100, 1400);
  const g = c.getContext('2d');
  g.fillStyle = '#d9d4c9'; g.fillRect(0, 0, 1100, 1400);
  g.translate(550, 700); g.rotate(-0.012); g.translate(-550, -700);
  g.fillStyle = '#fbfaf6'; g.fillRect(60, 70, 980, 1260);
  g.fillStyle = '#1d1d1b';
  let y = 170;
  for (const [text, size = 30, bold = false] of lines) {
    g.font = `${bold ? 'bold ' : ''}${size}px sans-serif`;
    g.fillText(text, 120, y);
    y += size + 30;
  }
  g.fillStyle = '#b9b3a6'; g.fillRect(120, y, 860, 2);
  return c.toBuffer('image/png');
}

export async function seedDemo(user) {
  if (get('SELECT COUNT(*) n FROM items').n > 0) throw bad('The workspace already has records. The demo can only be loaded into an empty workspace.');
  const t = today();
  const cat = (name) => get('SELECT id FROM categories WHERE name = ?', name).id;
  const d = (n) => addDays(t, n);
  const pay = (id, amount, date, extra = {}) => addPayment(id, { amount, date, ...extra }, user);
  const one = (o) => createItem({ currency: 'AED', ...o }, user, { source: o.source || 'demo', is_demo: 1 });
  const now = new Date().toISOString();

  const ids = tx(() => {
    const ent = (kind, name, details) => insert('entities', { kind, name, details: JSON.stringify(details), is_demo: 1, created_at: now });
    const patrol = ent('vehicle', 'Nissan Patrol (demo)', { make: 'Nissan', model: 'Patrol', year: '2023', plate: 'DXB Q 48213' });
    const tesla = ent('vehicle', 'Tesla Model 3 (demo)', { make: 'Tesla', model: 'Model 3', year: '2024', plate: 'DXB R 10556' });
    const marina = ent('property', 'Marina Apartment 1204 (demo)', { address: 'Tower B, Dubai Marina', role: 'Owned — rented out' });
    const villa = ent('property', 'Al Barsha Villa (demo)', { address: 'Street 14, Al Barsha 2', role: 'Family home — rented' });
    const bank = insert('accounts', { type: 'bank', name: 'Gulf First Current ••4471', institution: 'Gulf First Bank (demo)', last4: '4471', currency: 'AED', is_demo: 1 });
    const card = insert('accounts', { type: 'card', name: 'Gulf First Platinum ••9012', institution: 'Gulf First Bank (demo)', last4: '9012', currency: 'AED', is_demo: 1 });
    const P = (o) => createPlan({ currency: 'AED', direction: 'out', ...o }, user, { is_demo: 1 });

    // Recurring: estimated utility (the forecast for this month has not been billed yet).
    const util = P({ type: 'recurring', title: 'Electricity & water', counterparty: 'Desert Power & Water', category_id: cat('Utilities'), amount: AED(850), frequency: 'monthly', anchor_date: addMonths(d(6), -2), amount_status: 'estimated' });
    const net = P({ type: 'recurring', title: 'Home internet', counterparty: 'Falcon Telecom', category_id: cat('Internet & phone'), amount: AED(389), frequency: 'monthly', anchor_date: addMonths(d(-4), -1), amount_status: 'confirmed' });
    const staff = P({ type: 'recurring', title: 'Housekeeper salary', counterparty: 'M. Santos (household staff)', category_id: cat('Household staff salaries'), amount: AED(2500), frequency: 'monthly', anchor_date: addMonths(d(12), -1), amount_status: 'confirmed' });
    P({ type: 'recurring', title: 'StreamBox family plan', counterparty: 'StreamBox', category_id: cat('Subscriptions'), amount: 1499, currency: 'USD', frequency: 'monthly', anchor_date: d(3), amount_status: 'confirmed' });
    P({ type: 'recurring', title: 'Patrol registration renewal', counterparty: 'Roads Authority', entity_id: patrol, category_id: cat('Registration'), amount: AED(750), frequency: 'yearly', anchor_date: d(58), amount_status: 'estimated' });

    const school = P({ type: 'schedule', title: 'Bright Minds School fees 2026/27', counterparty: 'Bright Minds School', category_id: cat('School fees'), verified: true,
      rows: [{ due_date: d(-70), amount: AED(18000), label: 'Term 1' }, { due_date: d(21), amount: AED(18000), label: 'Term 2' }, { due_date: d(140), amount: AED(16500), label: 'Term 3' }] });

    // Car loan from the lender's schedule: 24 installments, then a balloon one month after the last one.
    const first = addMonths(d(9), -8);
    const loanRows = Array.from({ length: 24 }, (_, i) => ({ due_date: addMonths(first, i), amount: AED(3150) }));
    loanRows.push({ due_date: addMonths(first, 24), amount: AED(45000), kind: 'balloon', label: 'Final balloon payment' });
    const loan = P({ type: 'loan', title: 'Patrol car loan', counterparty: 'Oasis Auto Finance', entity_id: patrol, category_id: cat('Car loan'), verified: true, principal: AED(120600), rows: loanRows });

    // A projection (not the lender's schedule) — shown as "projected, not verified" until someone checks it.
    P({ type: 'loan', title: 'Marina Apartment mortgage', counterparty: 'Harbour Home Finance', entity_id: marina, category_id: cat('Mortgage'), verified: false,
      rows: Array.from({ length: 12 }, (_, i) => ({ due_date: addMonths(d(14), i), amount: AED(6200) })) });

    const rentIn = P({ type: 'schedule', direction: 'in', title: 'Marina Apartment rent', counterparty: 'R. Haddad (tenant)', entity_id: marina, category_id: cat('Rent receivable'), verified: true,
      rows: [{ due_date: d(-80), amount: AED(27500), label: 'Cheque 1 of 4' }, { due_date: d(11), amount: AED(27500), label: 'Cheque 2 of 4' }, { due_date: d(101), amount: AED(27500), label: 'Cheque 3 of 4' }, { due_date: d(192), amount: AED(30000), label: 'Cheque 4 of 4' }] });
    const rentOut = P({ type: 'schedule', title: 'Al Barsha Villa rent', counterparty: 'Al Barsha Estates', entity_id: villa, category_id: cat('Rent payable'), verified: true,
      rows: [{ due_date: d(-30), amount: AED(60000), label: 'Cheque 1 of 3' }, { due_date: d(62), amount: AED(55000), label: 'Cheque 2 of 3' }, { due_date: d(153), amount: AED(55000), label: 'Cheque 3 of 3' }] });

    // History: mark the past as paid.
    const past = (planId) => listItems({ plan_id: planId }).filter((i) => i.due_date < t);
    for (const p of [school, loan, rentIn, rentOut, staff]) for (const i of past(p.id)) pay(i.id, i.amount, i.due_date, { method: 'bank' });
    for (const i of past(util.id)) { run('UPDATE items SET billed = 1, amount_status = ?, amount = ? WHERE id = ?', 'confirmed', i.amount + 3760, i.id); pay(i.id, i.amount + 3760, i.due_date, { method: 'bank' }); }
    const netPast = past(net.id);
    if (netPast.length > 1) pay(netPast[0].id, netPast[0].amount, netPast[0].due_date, { method: 'bank' }); // the latest one stays unpaid → overdue

    const maint = one({ title: 'AC servicing & duct cleaning', counterparty: 'Al Noor Maintenance LLC', reference: 'ANM-2291', amount: AED(4750), issue_date: d(-5), due_date: d(9), entity_id: marina, category_id: cat('Maintenance') });
    const contractor = one({ title: 'Boundary wall repair', counterparty: 'Palm Contracting', reference: 'PC-0457', amount: AED(12000), issue_date: d(-12), due_date: d(16), entity_id: villa, category_id: cat('Contractor bills') });
    pay(contractor.id, AED(5000), d(-9), { method: 'bank', note: 'Deposit' });
    one({ title: 'Business cards & letterhead', counterparty: 'Sandstone Print House', reference: 'SPH-881', amount: AED(2310), issue_date: d(-9), due_date: d(5), category_id: cat('Supplier invoices') });
    const receivable = one({ direction: 'in', kind: 'invoice', title: 'Consulting retainer', counterparty: 'Crescent Trading', reference: 'INV-1042', amount: AED(18500), issue_date: d(-51), due_date: d(-21), category_id: cat('Client invoices') });
    pay(receivable.id, AED(6000), d(-14), { method: 'bank', note: 'Part payment received' });
    one({ direction: 'in', kind: 'reimbursement', title: 'Travel reimbursement', counterparty: 'Northwind Partners', reference: 'EXP-077', amount: AED(3240), issue_date: d(-6), due_date: d(10), category_id: cat('Reimbursements') });
    one({ title: 'Patrol comprehensive insurance', counterparty: 'Shield Insurance', reference: 'SH-77120', amount: AED(3900), due_date: d(40), entity_id: patrol, category_id: cat('Car insurance') });
    one({ title: 'Patrol 60,000 km service', counterparty: 'Desert Wheels', amount: AED(1400), due_date: d(75), entity_id: patrol, category_id: cat('Service & repairs'), amount_status: 'estimated', billed: false });
    one({ title: 'Tesla insurance renewal', counterparty: 'Shield Insurance', amount: AED(4200), due_date: d(120), entity_id: tesla, category_id: cat('Car insurance'), amount_status: 'estimated', billed: false });
    const service = one({ title: 'Patrol brake pads', counterparty: 'Desert Wheels', reference: 'DW-3301', amount: AED(1150), issue_date: d(-95), due_date: d(-90), entity_id: patrol, category_id: cat('Service & repairs') });
    pay(service.id, AED(1150), d(-90), { method: 'bank' });

    // Card statement, with two purchases that were paid by card. They are settled against the statement,
    // so only the statement itself shows up as cash to pay.
    const statement = one({ kind: 'card_statement', title: 'Gulf First Platinum statement', counterparty: 'Gulf First Bank', reference: 'ST-2611', account_id: card, amount: AED(6480.5), min_due: AED(324.03), issue_date: d(-3), due_date: d(12), category_id: cat('Credit card statement') });
    const groceries = one({ title: 'Monthly groceries', counterparty: 'Greenleaf Market', amount: AED(1284.5), issue_date: d(-11), due_date: d(-11), category_id: cat('Family expenses') });
    const tyres = one({ title: 'Patrol tyres (set of 4)', counterparty: 'Desert Wheels', reference: 'DW-3388', amount: AED(2600), issue_date: d(-16), due_date: d(-16), entity_id: patrol, category_id: cat('Service & repairs') });
    pay(groceries.id, AED(1284.5), d(-11), { method: 'card', card_account_id: card });
    pay(tyres.id, AED(2600), d(-16), { method: 'card', card_account_id: card });

    one({ title: 'Hardware store receipt', counterparty: 'FixIt Hardware', amount: AED(318.75), issue_date: d(-2), amount_status: 'needs_review', notes: 'Photo of a till receipt — due date and total still need checking.' });
    return { maint, contractor, statement, bank, card };
  });

  // Fictional source documents for two of the seeded bills.
  const attach = async (name, lines, itemId) => {
    const { doc } = await storeDocument(makePdf(lines), name, user, { is_demo: 1 });
    linkDocument(doc.id, itemId);
  };
  await attach('al-noor-maintenance-ANM-2291.pdf', [['Al Noor Maintenance LLC', 18], ['TAX INVOICE'], ['Invoice No: ANM-2291'], [`Invoice Date: ${long(d(-5))}`], [`Due Date: ${long(d(9))}`], ['Marina Apartment 1204 - AC servicing and duct cleaning'], ['Subtotal: AED 4,523.81'], ['VAT 5%: AED 226.19'], ['Total Due: AED 4,750.00'], ['FICTIONAL DEMO DOCUMENT', 9]], ids.maint.id);
  await attach('palm-contracting-PC-0457.pdf', [['Palm Contracting', 18], ['INVOICE'], ['Invoice No: PC-0457'], [`Invoice Date: ${long(d(-12))}`], [`Due Date: ${long(d(16))}`], ['Al Barsha Villa - boundary wall repair'], ['Total Due: AED 12,000.00'], ['Deposit received: AED 5,000.00'], ['FICTIONAL DEMO DOCUMENT', 9]], ids.contractor.id);

  // Sample files the user can drop into the Import Inbox to try each workflow.
  fs.mkdirSync(SAMPLE_DIR, { recursive: true });
  const w = (name, data) => fs.writeFileSync(path.join(SAMPLE_DIR, name), data);
  w('1-scanned-utility-bill.png', await makeScan([['Desert Power & Water', 46, true], ['Electricity & Water Bill', 30], ['Account No: 2047713'], ['Bill No: DPW-88214'], [`Bill Date: ${long(d(-8))}`], [`Due Date: ${dmy(d(6))}`], ['Electricity: AED 611.15'], ['Water & sewerage: AED 301.25'], ['Total Amount Due: AED 912.40', 36, true], ['FICTIONAL DEMO DOCUMENT', 20]]));
  w('2-contractor-invoice.pdf', makePdf([['Palm Contracting', 18], ['INVOICE'], ['Invoice No: PC-0463'], [`Invoice Date: ${long(d(-1))}`], [`Due Date: ${long(d(25))}`], ['Al Barsha Villa - gate motor replacement'], ['Total Due: AED 3,850.00'], ['FICTIONAL DEMO DOCUMENT', 9]]));
  w('3-backlog-spreadsheet.csv', [
    'Supplier,Description,Invoice No,Invoice Date,Due Date,Amount,Currency,Category,Paid',
    `Shield Insurance,Home contents insurance,SI-5521,${dmy(d(-20))},${dmy(d(28))},"2,150.00",AED,Annual renewals,`,
    `Sandstone Print House,Business cards & letterhead,SPH-881,${dmy(d(-9))},${dmy(d(5))},"2,310.00",AED,Supplier invoices,`,
    `Oasis Gardens,Garden maintenance,OG-114,${dmy(d(-3))},31/02/${d(60).slice(0, 4)},900.00,AED,Maintenance,`,
    `FixIt Hardware,Paint and fittings,FH-9920,${dmy(d(-15))},,640.00,AED,Household other,`,
    `Bright Spark Electric,Kitchen rewiring,BSE-301,${dmy(d(-60))},${dmy(d(-30))},"1,800.00",AED,Maintenance,"1,800.00"`,
  ].join('\n') + '\n');
  w('4-bank-statement.csv', [
    'Date,Description,Reference,Debit,Credit',
    `${dmy(d(-6))},TT PALM CONTRACTING PC-0457 PART PAYMENT,TT88121,"3,000.00",`,
    `${dmy(d(-4))},CHEQUE 001245 AL NOOR MAINT / SANDSTONE PRINT,CHQ001245,"7,060.00",`,
    `${dmy(d(-3))},FALCON TELECOM DIRECT DEBIT,DD4410,389.00,`,
    `${dmy(d(-2))},INWARD TRANSFER CRESCENT TRADING INV-1042,IN55310,,"5,000.00"`,
    `${dmy(d(-2))},POS CAFE ARABICA DUBAI,,46.00,`,
    `${dmy(d(-1))},CREDIT CARD PAYMENT GULF FIRST PLATINUM 9012,CC1201,324.03,`,
    `${dmy(d(-1))},TRANSFER TO SAVINGS OWN ACCOUNT,TR9001,"10,000.00",`,
  ].join('\n') + '\n');

  setSetting('demo_active', true);
  materialize(true);
  return { ok: true };
}

export const SAMPLES = [
  { file: '1-scanned-utility-bill.png', label: 'Scanned utility bill (photo)', hint: 'Paper files → OCR → confirms this month’s estimated electricity forecast instead of adding a second entry.' },
  { file: '2-contractor-invoice.pdf', label: 'Contractor invoice (PDF)', hint: 'Paper files → a new bill for Al Barsha Villa.' },
  { file: '3-backlog-spreadsheet.csv', label: 'Backlog spreadsheet (CSV)', hint: 'Excel & CSV → one duplicate, one bad date to fix, one row without a due date, one already paid.' },
  { file: '4-bank-statement.csv', label: 'Bank statement (CSV)', hint: 'Statements → choose “Gulf First Current”; includes a part payment, a split cheque, a card repayment and a transfer.' },
];

/** Remove every financial record and stored file. Users, settings and custom categories stay. */
export function clearDemo() {
  if (!getSettings().demo_active) throw bad('The demo is not active in this workspace.');
  tx(() => {
    db.exec(`
      DELETE FROM reminder_state; DELETE FROM payments; DELETE FROM document_links; DELETE FROM bank_txns;
      DELETE FROM import_rows; DELETE FROM imports; DELETE FROM items; DELETE FROM plans; DELETE FROM documents;
      DELETE FROM entities; DELETE FROM accounts; DELETE FROM fx_rates; DELETE FROM audit_log;`);
    setSetting('demo_active', false);
  });
  for (const f of fs.readdirSync(UPLOAD_DIR)) fs.rmSync(path.join(UPLOAD_DIR, f), { force: true });
  fs.rmSync(SAMPLE_DIR, { recursive: true, force: true });
  return { ok: true };
}
export const demoActive = () => !!getSettings().demo_active;

