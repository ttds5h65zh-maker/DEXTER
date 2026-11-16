// HTTP API. Every /api route except bootstrap/setup/login requires a signed-in user; owner-only routes say so explicitly.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { all, get, run, insert, audit, getSettings, setSetting, GROUPS } from './db.js';
import { HttpError, bad, toCsv, fromMinor, nowIso, isDate } from './util.js';
import * as auth from './auth.js';
import * as ledger from './ledger.js';
import * as summary from './summary.js';
import * as imports from './imports.js';
import * as mail from './mail.js';
import * as demo from './demo.js';
import { VIEWABLE } from './extract.js';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const num = (v) => (v == null || v === '' ? undefined : Number(v));

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.DEXTER_TRUST_PROXY === '1') app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
    next();
  });
  // Access log: method, path and status only. Bodies, query strings and file names are never logged.
  if (process.env.DEXTER_LOG !== 'off') {
    app.use((req, res, next) => {
      res.on('finish', () => { if (req.path.startsWith('/api/')) console.log(`${new Date().toISOString()} ${req.method} ${req.path} ${res.statusCode}`); });
      next();
    });
  }

  app.get('/vendor/preact.js', (_req, res) => res.type('text/javascript').sendFile(require.resolve('htm/preact/standalone.module.js')));
  app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html', maxAge: 0 }));

  const api = express.Router();
  app.use('/api', api);
  api.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  api.use(auth.sessionMiddleware, auth.csrfGuard);
  const json = express.json({ limit: '2mb' });
  const upload = express.raw({ type: () => true, limit: '25mb' });
  const fileName = (req) => { try { return decodeURIComponent(String(req.headers['x-filename'] || 'upload')); } catch { return 'upload'; } };
  const A = auth.requireAuth;
  const O = auth.requireOwner;

  const bootstrap = (req) => {
    const s = getSettings();
    return {
      needs_setup: auth.userCount() === 0,
      user: auth.publicUser(req.user),
      settings: req.user ? { base_currency: s.base_currency, timezone: s.timezone, workspace_name: s.workspace_name, demo_active: !!s.demo_active } : null,
      today: req.user ? ledger.today() : null,
      groups: GROUPS,
      categories: req.user ? all('SELECT * FROM categories ORDER BY group_kind, builtin DESC, name') : [],
      entities: req.user ? all('SELECT id, kind, name, archived FROM entities ORDER BY kind, name') : [],
      accounts: req.user ? all('SELECT * FROM accounts ORDER BY type, name') : [],
      fx_rates: req.user ? all('SELECT currency, rate FROM fx_rates') : [],
      samples: req.user && s.demo_active ? demo.SAMPLES : [],
    };
  };

  // ---- session ----
  api.get('/bootstrap', (req, res) => res.json(bootstrap(req)));
  api.post('/setup', json, async (req, res) => {
    if (auth.userCount() > 0) throw new HttpError(403, 'This workspace is already set up.');
    const user = auth.createUser({ ...req.body, role: 'owner' });
    if (req.body.demo) await demo.seedDemo(user);
    auth.setSessionCookie(req, res, auth.startSession(user.id));
    req.user = user;
    res.json(bootstrap(req));
  });
  api.post('/login', json, (req, res) => {
    const { user, token } = auth.login(req.body.email, req.body.password, req.ip);
    auth.setSessionCookie(req, res, token);
    req.user = user;
    res.json(bootstrap(req));
  });
  api.post('/logout', (req, res) => { auth.endSession(req.sessionToken); auth.setSessionCookie(req, res, null); res.json({ ok: true }); });
  api.patch('/me', A, json, (req, res) => {
    const d = req.body;
    if (d.new_password) {
      if (!auth.verifyPassword(String(d.current_password || ''), req.user.password_hash)) throw bad('Current password is incorrect.');
      auth.checkPasswordStrength(d.new_password);
      run('UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(d.new_password), req.user.id);
      auth.endUserSessions(req.user.id, req.sessionToken);
    }
    if (d.name) run('UPDATE users SET name = ? WHERE id = ?', String(d.name).trim().slice(0, 100), req.user.id);
    if (d.reminder_offsets) {
      const offsets = [...new Set(d.reminder_offsets.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 365))].sort((a, b) => b - a).slice(0, 8);
      const prefs = JSON.parse(req.user.prefs || '{}');
      run('UPDATE users SET prefs = ? WHERE id = ?', JSON.stringify({ ...prefs, reminder_offsets: offsets }), req.user.id);
    }
    if (d.email_reminders !== undefined) {
      const prefs = JSON.parse(get('SELECT prefs FROM users WHERE id = ?', req.user.id).prefs || '{}');
      if (d.email_reminders && prefs.email_verified_for !== req.user.email) throw bad('Confirm your email address first.');
      run('UPDATE users SET prefs = ? WHERE id = ?', JSON.stringify({ ...prefs, email_reminders: !!d.email_reminders }), req.user.id);
    }
    res.json({ user: auth.publicUser(get('SELECT * FROM users WHERE id = ?', req.user.id)) });
  });

  // ---- owner: people and workspace ----
  api.get('/users', O, (_req, res) => res.json(auth.listUsers()));
  api.post('/users', O, json, (req, res) => {
    const u = auth.createUser({ ...req.body, role: req.body.role || 'accountant' });
    audit(req.user, 'user', u.id, 'created', { note: u.role });
    res.json(auth.publicUser(u));
  });
  api.patch('/users/:id', O, json, (req, res) => {
    const u = get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
    if (!u) throw new HttpError(404, 'User not found.');
    const d = req.body;
    const owners = get("SELECT COUNT(*) n FROM users WHERE role = 'owner' AND active = 1").n;
    const losingOwner = u.role === 'owner' && u.active && ((d.role && d.role !== 'owner') || d.active === false);
    if (losingOwner && owners <= 1) throw bad('The workspace needs at least one active owner.');
    if (d.role) { if (!['owner', 'accountant'].includes(d.role)) throw bad('Unknown role.'); run('UPDATE users SET role = ? WHERE id = ?', d.role, u.id); audit(req.user, 'user', u.id, 'role changed', { oldValue: u.role, newValue: d.role }); }
    if (d.active !== undefined) { run('UPDATE users SET active = ? WHERE id = ?', d.active ? 1 : 0, u.id); if (!d.active) auth.endUserSessions(u.id); audit(req.user, 'user', u.id, d.active ? 'access restored' : 'access removed'); }
    if (d.password) { auth.checkPasswordStrength(d.password); run('UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(d.password), u.id); auth.endUserSessions(u.id); audit(req.user, 'user', u.id, 'password reset'); }
    res.json(auth.publicUser(get('SELECT * FROM users WHERE id = ?', u.id)));
  });
  api.patch('/settings', O, json, (req, res) => {
    const d = req.body;
    if (d.base_currency) { const c = String(d.base_currency).toUpperCase(); if (!/^[A-Z]{3}$/.test(c)) throw bad('Currency must be a 3-letter code.'); setSetting('base_currency', c); run('DELETE FROM fx_rates WHERE currency = ?', c); }
    if (d.timezone) { try { new Intl.DateTimeFormat('en', { timeZone: d.timezone }); } catch { throw bad('Unknown time zone.'); } setSetting('timezone', d.timezone); }
    if (d.workspace_name) setSetting('workspace_name', String(d.workspace_name).slice(0, 80));
    audit(req.user, 'settings', null, 'updated');
    res.json(bootstrap(req));
  });
  api.put('/fx-rates/:currency', O, json, (req, res) => {
    const c = String(req.params.currency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(c) || c === getSettings().base_currency) throw bad('Enter a currency other than the base currency.');
    const rate = Number(req.body.rate);
    if (!req.body.rate) run('DELETE FROM fx_rates WHERE currency = ?', c);
    else {
      if (!(rate > 0) || !Number.isFinite(rate)) throw bad('Rate must be a positive number.');
      run('INSERT INTO fx_rates (currency, rate, updated_by, updated_at) VALUES (?,?,?,?) ON CONFLICT(currency) DO UPDATE SET rate = excluded.rate, updated_by = excluded.updated_by, updated_at = excluded.updated_at', c, rate, req.user.id, nowIso());
    }
    audit(req.user, 'fx_rate', null, 'updated', { field: c, newValue: req.body.rate || 'removed' });
    res.json(all('SELECT currency, rate FROM fx_rates'));
  });
  api.post('/demo/load', O, async (req, res) => res.json(await demo.seedDemo(req.user)));
  api.post('/demo/clear', O, (_req, res) => res.json(demo.clearDemo()));
  api.get('/demo/samples/:name', A, (req, res) => {
    const s = demo.SAMPLES.find((x) => x.file === req.params.name);
    const file = s && path.join(demo.SAMPLE_DIR, s.file);
    if (!file || !fs.existsSync(file)) throw new HttpError(404, 'Sample not found.');
    res.setHeader('Content-Disposition', `attachment; filename="${s.file}"`);
    res.sendFile(file);
  });

  // ---- reference data (both roles) ----
  api.post('/categories', A, json, (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 60);
    if (!name) throw bad('Category name is required.');
    if (!GROUPS.includes(req.body.group_kind)) throw bad('Choose a group for the category.');
    if (get('SELECT id FROM categories WHERE lower(name) = lower(?) AND group_kind = ?', name, req.body.group_kind)) throw bad('That category already exists.');
    const id = insert('categories', { name, group_kind: req.body.group_kind, created_by: req.user.id });
    audit(req.user, 'category', id, 'created', { note: name });
    res.json(get('SELECT * FROM categories WHERE id = ?', id));
  });
  api.post('/entities', A, json, (req, res) => {
    if (!['vehicle', 'property'].includes(req.body.kind)) throw bad('Choose vehicle or property.');
    const name = String(req.body.name || '').trim().slice(0, 100);
    if (!name) throw bad('Name is required.');
    const id = insert('entities', { kind: req.body.kind, name, details: JSON.stringify(req.body.details || {}), is_demo: demo.demoActive() ? 1 : 0, created_at: nowIso() });
    audit(req.user, 'entity', id, 'created', { note: name });
    res.json(get('SELECT * FROM entities WHERE id = ?', id));
  });
  api.patch('/entities/:id', A, json, (req, res) => {
    const e = get('SELECT * FROM entities WHERE id = ?', Number(req.params.id));
    if (!e) throw new HttpError(404, 'Not found.');
    const name = req.body.name ? String(req.body.name).trim().slice(0, 100) : e.name;
    run('UPDATE entities SET name = ?, details = ?, archived = ? WHERE id = ?', name, JSON.stringify(req.body.details ?? JSON.parse(e.details)), req.body.archived === undefined ? e.archived : req.body.archived ? 1 : 0, e.id);
    audit(req.user, 'entity', e.id, 'updated');
    res.json(get('SELECT * FROM entities WHERE id = ?', e.id));
  });
  api.post('/accounts', A, json, (req, res) => {
    if (!['bank', 'card'].includes(req.body.type)) throw bad('Choose bank account or card.');
    const name = String(req.body.name || '').trim().slice(0, 100);
    if (!name) throw bad('Name is required.');
    const currency = String(req.body.currency || getSettings().base_currency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw bad('Currency must be a 3-letter code.');
    const id = insert('accounts', { type: req.body.type, name, institution: req.body.institution || null, last4: req.body.last4 ? String(req.body.last4).slice(-4) : null, currency, is_demo: demo.demoActive() ? 1 : 0 });
    audit(req.user, 'account', id, 'created', { note: name });
    res.json(get('SELECT * FROM accounts WHERE id = ?', id));
  });

  // ---- read models ----
  api.get('/dashboard', A, (req, res) => res.json(summary.dashboard(req.query.days)));
  api.get('/calendar', A, (req, res) => res.json(summary.calendar(req.query.month)));
  api.get('/weekly', A, (req, res) => res.json(summary.weekly(req.query.weeks)));
  api.get('/entities', A, (_req, res) => res.json(summary.entitiesOverview()));
  api.get('/entities/:id', A, (req, res) => res.json(summary.entityPage(Number(req.params.id), req.query.year)));
  api.get('/finance', A, (_req, res) => res.json(summary.finance()));
  api.get('/reminders', A, (req, res) => res.json({ reminders: summary.remindersFor(req.user), email: mail.emailStatus(req.user) }));
  api.post('/reminders/dismiss', A, json, (req, res) => { summary.dismissReminder(req.user, req.body.key); res.json({ ok: true }); });
  api.post('/reminders/email/send-code', A, async (req, res) => res.json(await mail.sendVerification(req.user)));
  api.post('/reminders/email/confirm', A, json, (req, res) => res.json(mail.confirmVerification(req.user, req.body.code)));

  // ---- ledger ----
  const itemFilters = (q) => ({
    direction: q.direction, group: q.group, entity_id: num(q.entity_id), plan_id: num(q.plan_id), account_id: num(q.account_id), category_id: num(q.category_id),
    kind: q.kind, state: q.state, from: isDate(q.from) ? q.from : undefined, to: isDate(q.to) ? q.to : undefined, q: q.q, include_void: q.include_void === '1', desc: q.desc === '1',
  });
  api.get('/items', A, (req, res) => { ledger.materialize(); const items = ledger.listItems(itemFilters(req.query)); res.json({ items, totals: { outstanding: summary.totals(items), amount: summary.totals(items, 'amount'), paid: summary.totals(items, 'paid') } }); });
  api.post('/items', A, json, (req, res) => res.json(ledger.createItem(req.body, req.user, { is_demo: demo.demoActive() ? 1 : 0 })));
  api.get('/items/:id', A, (req, res) => {
    const item = ledger.getItem(Number(req.params.id));
    if (!item) throw new HttpError(404, 'Record not found.');
    res.json({
      item,
      payments: all(`SELECT p.*, u.name AS by_name, d.filename AS proof_filename, a.name AS card_name FROM payments p
        LEFT JOIN users u ON u.id = p.created_by LEFT JOIN documents d ON d.id = p.proof_document_id LEFT JOIN accounts a ON a.id = p.card_account_id
        WHERE p.item_id = ? ORDER BY p.date, p.id`, item.id),
      documents: imports.itemDocuments(item.id),
      history: all(`SELECT l.*, u.name AS by_name FROM audit_log l LEFT JOIN users u ON u.id = l.user_id WHERE l.entity_type = 'item' AND l.entity_id = ? ORDER BY l.id DESC`, item.id),
      plan: item.plan_id ? ledger.getPlan(item.plan_id) : null,
      schedule: item.plan_id && item.plan_type !== 'recurring' ? ledger.listItems({ plan_id: item.plan_id }) : [],
      purchases: item.kind === 'card_statement' ? ledger.statementPurchases(item.id) : [],
    });
  });
  api.patch('/items/:id', A, json, (req, res) => res.json(ledger.updateItem(Number(req.params.id), req.body, req.user)));
  api.post('/items/:id/void', A, json, (req, res) => res.json(ledger.voidItem(Number(req.params.id), req.user, req.body?.reason)));
  api.post('/items/:id/payments', A, json, (req, res) => res.json(ledger.addPayment(Number(req.params.id), req.body, req.user)));
  api.post('/payments/:id/void', A, (req, res) => res.json(ledger.voidPayment(Number(req.params.id), req.user)));
  api.get('/plans', A, (req, res) => res.json(ledger.listPlans({ type: req.query.type })));
  api.post('/plans', A, json, (req, res) => res.json(ledger.createPlan(req.body, req.user, { is_demo: demo.demoActive() ? 1 : 0 })));
  api.patch('/plans/:id', A, json, (req, res) => res.json(ledger.updatePlan(Number(req.params.id), req.body, req.user)));

  // ---- documents (always behind the session check; never served from a public folder) ----
  api.post('/items/:id/documents', A, upload, async (req, res) => {
    const item = ledger.getItem(Number(req.params.id));
    if (!item) throw new HttpError(404, 'Record not found.');
    const { doc } = await imports.storeDocument(req.body, fileName(req), req.user, { is_demo: demo.demoActive() ? 1 : 0 });
    if (req.query.purpose !== 'proof') { imports.linkDocument(doc.id, item.id); audit(req.user, 'item', item.id, 'document attached', { note: doc.filename }); }
    res.json({ id: doc.id, filename: doc.filename });
  });
  api.get('/documents/:id/file', A, (req, res) => {
    const doc = imports.getDocument(Number(req.params.id));
    if (!doc || !fs.existsSync(imports.docPath(doc))) throw new HttpError(404, 'Document not found.');
    const inline = VIEWABLE.has(doc.mime) && req.query.download !== '1';
    res.setHeader('Content-Type', inline ? doc.mime : 'application/octet-stream');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(doc.filename)}`);
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'" + (doc.mime === 'application/pdf' ? '' : '; sandbox'));
    fs.createReadStream(imports.docPath(doc)).pipe(res);
  });
  api.get('/documents/:id/text', A, (req, res) => {
    const doc = imports.getDocument(Number(req.params.id));
    if (!doc) throw new HttpError(404, 'Document not found.');
    res.json({ text: doc.text, extract_method: doc.extract_method, ocr_confidence: doc.ocr_confidence });
  });

  // ---- import inbox ----
  api.get('/inbox', A, (_req, res) => {
    const list = imports.listImports();
    res.json({
      imports: list,
      needs_review: ledger.listItems({ state: 'needs_review' }),
      unmatched_txns: get("SELECT COUNT(*) n FROM bank_txns WHERE status = 'unmatched'").n,
      ocr: { engine: 'tesseract.js (runs on this computer)', languages: process.env.OCR_LANGS || 'eng', enabled: process.env.DEXTER_OCR !== 'off' },
    });
  });
  api.post('/imports/document', A, upload, async (req, res) => res.json(await imports.importDocument(req.body, fileName(req), req.user, { is_demo: demo.demoActive() ? 1 : 0 })));
  api.post('/imports/manual', A, json, (req, res) => res.json(ledger.createItem(req.body, req.user, { is_demo: demo.demoActive() ? 1 : 0 })));
  api.post('/imports/sheet', A, upload, async (req, res) => res.json(await imports.createTableImport('sheet', req.body, fileName(req), req.user, { is_demo: demo.demoActive() ? 1 : 0 })));
  api.post('/imports/statement', A, upload, async (req, res) => res.json(await imports.createTableImport('statement', req.body, fileName(req), req.user, { account_id: num(req.query.account_id), is_demo: demo.demoActive() ? 1 : 0 })));
  api.get('/imports/:id', A, (req, res) => { const i = imports.getImport(Number(req.params.id)); if (!i) throw new HttpError(404, 'Import not found.'); res.json(i); });
  api.patch('/imports/:id', A, json, (req, res) => res.json(imports.updateImportMeta(Number(req.params.id), req.body)));
  api.patch('/import-rows/:id', A, json, (req, res) => res.json(imports.updateImportRow(Number(req.params.id), req.body.cells)));
  api.post('/imports/:id/confirm', A, json, (req, res) => res.json(imports.confirmDocument(Number(req.params.id), req.body, req.user)));
  api.post('/imports/:id/commit', A, json, (req, res) => res.json(imports.commitImport(Number(req.params.id), req.body || {}, req.user)));
  api.post('/imports/:id/discard', A, (req, res) => { imports.discardImport(Number(req.params.id), req.user); res.json({ ok: true }); });
  api.get('/txns', A, (req, res) => res.json(imports.listTxns({ status: req.query.status, account_id: num(req.query.account_id) })));
  api.post('/txns/:id/match', A, json, (req, res) => res.json(imports.matchTxn(Number(req.params.id), req.body.allocations, req.user)));
  api.post('/txns/:id/mark', A, json, (req, res) => res.json(imports.markTxn(Number(req.params.id), req.body.status, req.user)));

  // ---- exports ----
  const sendCsv = (res, name, rows) => { res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${name}"`); res.send('﻿' + toCsv(rows)); };
  api.get('/export/items.csv', A, (req, res) => {
    const items = ledger.listItems({ ...itemFilters(req.query), include_void: true });
    audit(req.user, 'export', null, 'items exported', { note: `${items.length} rows` });
    sendCsv(res, 'dexter-records.csv', [
      ['ID', 'Direction', 'Group', 'Category', 'Vehicle / property', 'Title', 'Payee / payer', 'Reference', 'Currency', 'Amount', 'Paid', 'Credited', 'Outstanding', 'Issue date', 'Due date', 'Amount status', 'Status', 'Source', 'Documents'],
      ...items.map((i) => [i.id, i.direction === 'in' ? 'Incoming' : 'Outgoing', i.grp, i.category_name, i.entity_name, i.title, i.counterparty, i.reference, i.currency,
        fromMinor(i.amount, i.currency), fromMinor(i.paid, i.currency), fromMinor(i.credited, i.currency), fromMinor(i.outstanding, i.currency), i.issue_date, i.due_date,
        i.projected ? 'projected (not verified)' : i.amount_status, i.overdue ? 'overdue' : i.status, i.source, i.doc_count]),
    ]);
  });
  api.get('/export/payments.csv', A, (req, res) => {
    const rows = all(`SELECT p.*, i.title, i.counterparty, i.currency, i.direction, u.name AS by_name FROM payments p JOIN items i ON i.id = p.item_id LEFT JOIN users u ON u.id = p.created_by ORDER BY p.date, p.id`);
    audit(req.user, 'export', null, 'payments exported', { note: `${rows.length} rows` });
    sendCsv(res, 'dexter-payments.csv', [
      ['Payment ID', 'Record ID', 'Record', 'Payee / payer', 'Direction', 'Type', 'Currency', 'Amount', 'Date', 'Method', 'Note', 'Recorded by', 'Recorded at', 'Voided at'],
      ...rows.map((p) => [p.id, p.item_id, p.title, p.counterparty, p.direction === 'in' ? 'Incoming' : 'Outgoing', p.type, p.currency, fromMinor(p.amount, p.currency), p.date, p.method, p.note, p.by_name, p.created_at, p.voided_at]),
    ]);
  });

  api.use((_req, _res, next) => next(new HttpError(404, 'Not found.')));
  // Errors: known ones return their message; anything else is logged by name only (no request data) and returns a generic message.
  app.use((err, req, res, _next) => {
    let status = err.status || err.statusCode || 500;
    let message = err.message;
    if (err.type === 'entity.too.large') { status = 413; message = 'That file is larger than 25 MB.'; }
    if (status >= 500) { console.error(`${new Date().toISOString()} ERROR ${req.method} ${req.path}: ${err.name}: ${err.message}`); message = 'Something went wrong on the server.'; }
    res.status(status).json({ error: message, ...(err.extra || {}) });
  });
  return app;
}
