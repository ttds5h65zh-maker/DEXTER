// Run 2 — security and access. Tries to get around sign-in and roles, sends hostile files and garbage input.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, client, ok } from './helpers.js';

let srv, owner, acct, anon, boot;
const ROUTES = fs.readFileSync(new URL('../server/app.js', import.meta.url), 'utf8')
  .match(/api\.(get|post|patch|put|delete)\('[^']+', [A-Za-z]+/g)
  .map((m) => { const [, method, p, guard] = m.match(/api\.(\w+)\('([^']+)', (\w+)/); return { method, path: p, guard }; });
const fill = (p, id = 1) => p.replace(/:currency/, 'USD').replace(/:name/, '1-scanned-utility-bill.png').replace(/:n\b/, '1').replace(/:[a-z_]+/g, String(id));
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

before(async () => {
  srv = await startServer();
  owner = client(srv.port); acct = client(srv.port); anon = client(srv.port);
  boot = ok(await owner.post('/api/setup', { name: 'Owner', email: 'owner@example.test', password: 'owner-password-1', demo: true }));
  ok(await owner.post('/api/users', { name: 'Accountant', email: 'acct@example.test', password: 'accountant-pass-1', role: 'accountant' }));
  ok(await acct.post('/api/login', { email: 'acct@example.test', password: 'accountant-pass-1' }));
});
after(async () => srv.cleanup());

test('every protected route refuses a visitor who is not signed in', async () => {
  const leaks = [];
  for (const r of ROUTES.filter((x) => x.guard === 'A' || x.guard === 'O')) {
    const res = await anon.raw(r.method.toUpperCase(), `/api${fill(r.path)}`, r.method === 'get' ? undefined : {});
    if (res.status !== 401) leaks.push(`${r.method} ${r.path} → ${res.status}`);
  }
  assert.deepEqual(leaks, []);
  const b = ok(await anon.get('/api/bootstrap'));
  assert.deepEqual([b.user, b.settings, b.categories.length, b.entities.length], [null, null, 0, 0], 'bootstrap reveals nothing before sign-in');
});

test('the accountant is refused every owner-only route; the owner is not', async () => {
  for (const r of ROUTES.filter((x) => x.guard === 'O')) {
    const res = await acct.raw(r.method.toUpperCase(), `/api${fill(r.path)}`, r.method === 'get' ? undefined : {});
    assert.equal(res.status, 403, `${r.method} ${r.path} → ${res.status}`);
  }
  assert.equal((await owner.get('/api/users')).status, 200);
});

test('forged cross-site requests are refused (no custom header)', async () => {
  for (const [method, url] of [['POST', '/api/items'], ['PATCH', '/api/settings'], ['POST', '/api/demo/clear'], ['POST', '/api/users']]) {
    const res = await fetch(`http://127.0.0.1:${srv.port}${url}`, { method, headers: { cookie: owner.cookie, 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(res.status, 403, `${method} ${url}`);
  }
  assert.ok(ok(await owner.get('/api/bootstrap')).settings.demo_active, 'demo still there — forged clear did nothing');
});

test('session cookie and security headers', async () => {
  const res = await fetch(`http://127.0.0.1:${srv.port}/api/login`, { method: 'POST', headers: { 'X-Dexter': '1', 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.test', password: 'owner-password-1' }) });
  const c = res.headers.get('set-cookie');
  assert.match(c, /HttpOnly/); assert.match(c, /SameSite=Strict/); assert.match(c, /Path=\//);
  for (const url of ['/', '/api/bootstrap']) {
    const h = (await fetch(`http://127.0.0.1:${srv.port}${url}`)).headers;
    assert.match(h.get('content-security-policy'), /default-src 'self'/);
    assert.match(h.get('content-security-policy'), /frame-ancestors 'self'/);
    assert.equal(h.get('x-content-type-options'), 'nosniff');
    assert.equal(h.get('x-powered-by'), null);
  }
  assert.equal((await fetch(`http://127.0.0.1:${srv.port}/api/bootstrap`)).headers.get('cache-control'), 'no-store');
});

test('server files, the database and node_modules are not reachable over HTTP', async () => {
  for (const url of ['/../server/app.js', '/%2e%2e/server/app.js', '/..%2fserver%2fapp.js', '/package.json', '/data/dexter.sqlite', '/dexter.sqlite', '/server/db.js', '/node_modules/express/package.json', '/.git/config', '/api/demo/samples/..%2F..%2Fdexter.sqlite']) {
    const res = await fetch(`http://127.0.0.1:${srv.port}${url}`, { headers: { cookie: owner.cookie, 'X-Dexter': '1' } });
    const body = await res.text();
    assert.ok(res.status === 404 || (res.status === 200 && body.includes('<div id="app">')), `${url} → ${res.status}`);
    assert.ok(!body.includes('DatabaseSync') && !body.includes('SQLite format') && !body.includes('[core]'), `${url} leaked a file`);
  }
});

test('signing out, removing access and resetting a password end the old sessions at once', async () => {
  const s = client(srv.port);
  ok(await s.post('/api/login', { email: 'owner@example.test', password: 'owner-password-1' }));
  const stolen = s.cookie;
  ok(await s.post('/api/logout'));
  const replay = client(srv.port); replay.cookie = stolen;
  assert.equal((await replay.get('/api/dashboard')).status, 401, 'a signed-out cookie is dead');

  const users = ok(await owner.get('/api/users'));
  const a = users.find((u) => u.role === 'accountant');
  ok(await owner.patch(`/api/users/${a.id}`, { active: false }));
  assert.equal((await acct.get('/api/dashboard')).status, 401, 'removed accountant is locked out immediately');
  const relog = await client(srv.port).post('/api/login', { email: 'acct@example.test', password: 'accountant-pass-1' });
  assert.equal(relog.status, 401);
  ok(await owner.patch(`/api/users/${a.id}`, { active: true }));
  ok(await acct.post('/api/login', { email: 'acct@example.test', password: 'accountant-pass-1' }));
  ok(await owner.patch(`/api/users/${a.id}`, { password: 'brand-new-pass-2' }));
  assert.equal((await acct.get('/api/dashboard')).status, 401, 'password reset signs them out everywhere');
  assert.equal((await client(srv.port).post('/api/login', { email: 'acct@example.test', password: 'accountant-pass-1' })).status, 401);
  ok(await acct.post('/api/login', { email: 'acct@example.test', password: 'brand-new-pass-2' }));
  assert.equal((await acct.patch('/api/me', { new_password: 'another-pass-3' })).status, 400, 'own password change needs the current password');
});

test('the workspace always keeps an active owner', async () => {
  const me = ok(await owner.get('/api/bootstrap')).user;
  assert.equal((await owner.patch(`/api/users/${me.id}`, { role: 'accountant' })).status, 400);
  assert.equal((await owner.patch(`/api/users/${me.id}`, { active: false })).status, 400);
  assert.equal((await owner.post('/api/setup', { name: 'X', email: 'x@example.test', password: 'xxxxxxxxxxxx' })).status, 403);
});

test('password guessing is slowed down, and a fake X-Forwarded-For does not get around it', async () => {
  ok(await owner.post('/api/users', { name: 'Guess target', email: 'target@example.test', password: 'target-pass-123', role: 'accountant' }));
  const g = client(srv.port);
  const unknown = await g.post('/api/login', { email: 'nobody@example.test', password: 'whatever-123' });
  const wrong = await g.post('/api/login', { email: 'target@example.test', password: 'wrong-pass-0' });
  assert.deepEqual([unknown.status, unknown.body.error], [wrong.status, wrong.body.error], 'same answer for unknown email and wrong password');
  for (let i = 1; i < 8; i++) await g.post('/api/login', { email: 'target@example.test', password: `wrong-pass-${i}` }, { 'x-forwarded-for': `10.0.0.${i}` });
  const locked = await g.post('/api/login', { email: 'target@example.test', password: 'target-pass-123' }, { 'x-forwarded-for': '10.9.9.9' });
  assert.equal(locked.status, 429);
});

test('hostile files: HTML or SVG pretending to be a scan is refused; a CSV is only ever downloaded, never shown', async () => {
  const html = Buffer.from('<html><script>alert(document.cookie)</script></html>');
  assert.equal((await owner.upload('/api/imports/document', 'invoice.png', html)).status, 400);
  assert.equal((await owner.upload('/api/imports/document', 'invoice.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'))).status, 400);
  assert.equal((await owner.upload('/api/imports/document', 'invoice.pdf', Buffer.from('%PDF-1.4 <script>'))).status, 200, 'a broken PDF is stored as a document, not executed');
  const sheet = ok(await owner.upload('/api/imports/sheet', 'bills.csv', Buffer.from('Supplier,Amount,Due Date\n<script>alert(1)</script>,100,01/01/2030\n')));
  const res = await fetch(`http://127.0.0.1:${srv.port}/api/documents/${sheet.import.document.id}/file`, { headers: { cookie: owner.cookie } });
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.match(res.headers.get('content-disposition'), /^attachment/);
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
  const trav = ok(await owner.upload('/api/imports/document', '../../../etc/cron.d/evil.png', Buffer.concat([PNG, Buffer.from('x')])));
  assert.equal(trav.import.document.filename, 'evil.png');
  const files = fs.readdirSync(path.join(srv.dataDir, 'uploads'));
  assert.ok(files.every((f) => /^[0-9a-f]{64}(\.p\d+\.png)?$/.test(f)), files.join(','));
  assert.ok(!fs.existsSync(path.join(srv.dataDir, 'etc')));
  for (const u of ['/api/documents/99999/file', '/api/documents/abc/file', `/api/documents/${sheet.import.document.id}/page/1`, '/api/documents/1/page/0', '/api/documents/1/page/999', '/api/items/1%20OR%201=1']) {
    assert.equal((await owner.get(u)).status, 404, u);
  }
});

test('text that looks like code stays text: search, names, and the CSV export', async () => {
  for (const q of ["' OR 1=1 --", '"; DROP TABLE items; --', '%', '\\', '<script>']) assert.equal((await owner.get(`/api/items?q=${encodeURIComponent(q)}`)).status, 200, q);
  assert.ok(ok(await owner.get('/api/items?state=all')).items.length > 10, 'items table intact');
  const item = ok(await owner.post('/api/items', { title: '=HYPERLINK("http://evil.example","Click")', counterparty: '<img src=x onerror=alert(1)>', reference: '@SUM(A1)', notes: '+1+2', amount: 100, currency: 'AED', due_date: '2030-01-01' }));
  assert.equal(item.counterparty, '<img src=x onerror=alert(1)>');
  const csv = ok(await owner.get('/api/export/items.csv'));
  const line = csv.split('\r\n').find((l) => l.includes('HYPERLINK'));
  assert.ok(line.includes(`"'=HYPERLINK(""http://evil.example"",""Click"")"`), line);
  assert.ok(line.includes("'@SUM(A1)"), line);
});

test('fields the server owns cannot be set from outside', async () => {
  const card = boot.accounts.find((a) => a.type === 'card');
  const item = ok(await owner.post('/api/items', { title: 'Mass assignment', amount: 1000, currency: 'AED', due_date: '2030-01-01', plan_id: 1, period_key: 'x', voided_at: '2020-01-01', is_demo: 0, created_by: 999, source: 'forecast', paid: 1000, outstanding: 0 }));
  assert.deepEqual([item.plan_id, item.period_key, item.voided_at, item.created_by === 999, item.source, item.outstanding], [null, null, null, false, 'manual', 1000]);
  const after = ok(await owner.patch(`/api/items/${item.id}`, { voided_at: '2020-01-01', plan_id: 1, kind: 'card_statement', account_id: card.id, created_at: '1999-01-01', id: 1 }));
  assert.equal(after.voided_at, null);
  assert.equal(after.plan_id, null);
  assert.equal(after.kind, 'bill', 'a bill cannot be turned into a card statement by editing it');
  assert.equal(after.id, item.id);
});

test('oversized requests get a clear answer', async () => {
  const big = await owner.raw('POST', '/api/items', JSON.stringify({ title: 'x'.repeat(3 * 1024 * 1024) }), { 'content-type': 'application/json' });
  assert.equal(big.status, 413);
  assert.doesNotMatch(big.body.error, /25 MB/, 'the message fits the request (this was not a file)');
  const huge = await owner.upload('/api/imports/document', 'huge.pdf', Buffer.alloc(26 * 1024 * 1024, 1));
  assert.equal(huge.status, 413);
});

test('garbage input never crashes the server (every route, every field, wrong types)', async () => {
  const st = ok(await owner.upload(`/api/imports/statement?account_id=${boot.accounts.find((a) => a.type === 'bank').id}`, 's.csv', Buffer.from('Date,Description,Amount\n01/12/2029,TEST,-10\n')));
  ok(await owner.post(`/api/imports/${st.import.id}/commit`, {}));
  const VALUES = [null, '', 'abc', -1, 0, 1.5, 1e300, -1e300, true, [], {}, [null], [{}], '<script>', '2029-02-30', 'x'.repeat(5000)];
  const FIELDS = ['title', 'counterparty', 'reference', 'amount', 'currency', 'min_due', 'issue_date', 'due_date', 'amount_status', 'entity_id', 'category_id', 'account_id', 'notes', 'billed', 'kind', 'direction',
    'type', 'date', 'method', 'note', 'proof_document_id', 'card_account_id', 'statement_item_id', 'frequency', 'interval_n', 'anchor_date', 'end_date', 'rows', 'verified', 'principal', 'active', 'name', 'email', 'role',
    'details', 'last4', 'institution', 'group_kind', 'key', 'code', 'allocations', 'status', 'mapping', 'date_order', 'defaults', 'positive_is_out', 'negative_means', 'cells', 'include_duplicates', 'match_item_id',
    'force', 'reminder_offsets', 'email_reminders', 'current_password', 'timezone', 'workspace_name', 'rate', 'archived', 'reason', 'base_currency'];
  const SKIP = new Set(['/demo/clear', '/demo/load', '/users/:id', '/reminders/email/send-code']);
  const crashes = [];
  const items = ok(await owner.get('/api/items?state=all')).items;
  const ids = { '/items/:id': items[0].id, '/payments/:id': 1, '/imports/:id': st.import.id, '/import-rows/:id': st.import.rows[0].id, '/txns/:id': ok(await owner.get('/api/txns'))[0].id };
  for (const r of ROUTES.filter((x) => x.method !== 'get' && (x.guard === 'A' || x.guard === 'O') && !SKIP.has(x.path))) {
    const id = Object.entries(ids).find(([k]) => r.path.startsWith(k.replace('/:id', '')))?.[1] ?? 1;
    const url = `/api${fill(r.path, id)}`;
    if (/documents|imports\/(document|sheet|statement)$/.test(r.path)) {
      for (const body of [Buffer.alloc(0), Buffer.from([0, 1, 2]), Buffer.from('a,b\n1,2')]) {
        const res = await owner.raw('POST', url, body, { 'content-type': 'application/octet-stream', 'x-filename': '%E0%A4%A' });
        if (res.status >= 500) crashes.push(`${r.method} ${r.path} <${body.length} bytes> → ${res.status}`);
      }
      continue;
    }
    for (const v of VALUES) {
      const body = Object.fromEntries(FIELDS.map((f) => [f, v]));
      const res = await owner.raw(r.method.toUpperCase(), url, body);
      if (res.status >= 500) crashes.push(`${r.method} ${r.path} all fields = ${JSON.stringify(v)?.slice(0, 20)} → ${res.status}`);
    }
    for (const raw of ['[]', '"text"', '123', 'not json']) {
      const res = await owner.raw(r.method.toUpperCase(), url, raw, { 'content-type': 'application/json' });
      if (res.status >= 500) crashes.push(`${r.method} ${r.path} body ${raw} → ${res.status}`);
    }
  }
  for (const r of ROUTES.filter((x) => x.method === 'get' && x.guard !== 'json')) {
    for (const q of ['?days=abc&weeks=-5&month=2029-13&year=abc&state=bogus&from=x&to=y&q=%00&account_id=abc&status=%27', '?month=0000-00&year=99999']) {
      const res = await owner.get(`/api${fill(r.path, 1)}${q}`);
      if (res.status >= 500) crashes.push(`GET ${r.path}${q} → ${res.status}`);
    }
  }
  assert.deepEqual(crashes, []);
  ok(await owner.patch('/api/settings', { base_currency: 'AED', timezone: 'Asia/Dubai', workspace_name: 'Dexter Payments' }));
  assert.ok(!/ERROR/.test(srv.logs), srv.logs.split('\n').filter((l) => /ERROR/.test(l)).slice(0, 10).join('\n'));
});

test('valid-looking requests with broken parts inside are refused cleanly', async () => {
  const items = ok(await owner.get('/api/items?state=open')).items;
  const it = items.find((i) => i.direction === 'out' && i.currency === 'AED');
  const txn = ok(await owner.get('/api/txns'))[0];
  const imp = ok(await owner.get('/api/inbox')).imports.find((i) => i.type !== 'document');
  const full = ok(await owner.get(`/api/imports/${imp.id}`));
  const cases = [
    ['POST', '/api/items', { title: 'Huge', amount: 1e300, currency: 'AED' }, 400],
    ['POST', '/api/items', { title: 'Beyond safe', amount: 2 ** 53 + 1, currency: 'AED' }, 400],
    ['POST', '/api/items', { title: 'Typo', amount: 1e15, currency: 'AED' }, 400],
    ['POST', '/api/plans', { type: 'loan', title: 'L', rows: [null] }, 400],
    ['POST', '/api/plans', { type: 'loan', title: 'L', rows: [{}] }, 400],
    ['POST', '/api/plans', { type: 'loan', title: 'L', rows: 'x' }, 400],
    ['POST', '/api/plans', { type: 'schedule', title: 'S', rows: [{ amount: 100, due_date: '2030-02-30' }] }, 400],
    ['POST', '/api/plans', { type: 'recurring', title: 'R', amount: 1e300, frequency: 'monthly', anchor_date: '2030-01-01' }, 400],
    ['POST', `/api/txns/${txn.id}/match`, { allocations: [{ item_id: null, amount: 1 }] }, 400],
    ['POST', `/api/txns/${txn.id}/match`, { allocations: [{ item_id: it.id, amount: 1e300 }] }, 400],
    ['POST', `/api/txns/${txn.id}/match`, { allocations: [{ item_id: it.id, amount: -5 }] }, 400],
    ['POST', `/api/items/${it.id}/payments`, { amount: 100, date: '2030-02-30' }, 400],
    ['POST', `/api/items/${it.id}/payments`, { amount: 1e300 }, 400],
    ['POST', `/api/items/${it.id}/payments`, { amount: 100, type: 'gift' }, 400],
    ['PATCH', `/api/imports/${imp.id}`, { mapping: null, defaults: null, date_order: 5 }, 200],
    ['PATCH', `/api/imports/${imp.id}`, { mapping: { amount: 'abc', date: -1 } }, 200],
    ['PATCH', `/api/import-rows/${full.rows[0].id}`, { cells: [null, {}, 5] }, null],
    ['PATCH', '/api/me', { reminder_offsets: '30' }, 400],
    ['PATCH', '/api/me', { name: '' }, 400],
    ['POST', '/api/reminders/dismiss', { key: '1|7|2030-01-01; DROP TABLE x' }, 400],
    ['POST', `/api/imports/${imp.id}/commit`, { include_duplicates: 'all' }, null],
    ['PATCH', `/api/items/${it.id}`, { amount: 1e300 }, 400],
    ['PATCH', `/api/items/${it.id}`, { due_date: '2030-13-01' }, 400],
    ['PUT', '/api/fx-rates/USD', { rate: 1e300 }, 400],
    ['PUT', '/api/fx-rates/USD', { rate: -3 }, 400],
    ['POST', '/api/entities', { kind: 'vehicle', name: 'V', details: 'not an object' }, 400],
    ['POST', '/api/accounts', { type: 'card', name: 'C', currency: 'DOLLARS' }, 400],
  ];
  const wrong = [];
  for (const [m, u, b, expect] of cases) {
    const r = await owner.raw(m, u, b);
    if (r.status >= 500 || (expect && r.status !== expect)) wrong.push(`${m} ${u} ${JSON.stringify(b).slice(0, 70)} → ${r.status} ${JSON.stringify(r.body).slice(0, 90)}`);
  }
  assert.deepEqual(wrong, []);
  assert.ok(!/ERROR/.test(srv.logs), srv.logs.split('\n').filter((l) => /ERROR/.test(l)).slice(0, 10).join('\n'));
});
