// Browser test of the claude.ai page (public/artifact.html), served by the local
// server at /hosted. Part A runs it as it runs outside claude.ai (saving in the
// browser). Part B gives it stand-ins for claude.ai's capabilities (database,
// user, Claude, file saving), shaped like the platform's documented interfaces,
// to exercise saving to the account, Claude extraction and drafting, and export.
//   node tests/hosted.e2e.cjs

const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.dirname(__dirname);
const out = path.join(__dirname, 'output');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexter-hosted-'));
const PORT = 4900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${PORT}`;
let server;
let lastPage = null; // screenshot on failure

function startServer() {
  const env = { ...process.env, PORT: String(PORT), DEXTER_DATA_DIR: dataDir, DEXTER_DEMO: 'off' };
  delete env.ANTHROPIC_API_KEY;
  server = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('Dexter is running') && resolve());
    server.on('exit', (code) => reject(new Error('server exited ' + code)));
  });
}

// Stand-ins for claude.ai's capabilities. State survives reloads via sessionStorage.
const FAKE_CLAUDE = () => {
  const store = JSON.parse(sessionStorage.getItem('fake-db') || '{}');
  window.__db = store;
  window.__dbWrites = 0;
  const persist = () => sessionStorage.setItem('fake-db', JSON.stringify(store));
  const later = () => new Promise((r) => setTimeout(r, 15));
  const snap = (id, data) => ({ id, exists: data !== undefined, data: () => data, metadata: { fromCache: false, hasPendingWrites: false } });
  const db = Object.freeze({
    collection(colPath) {
      if (colPath.split('/').length % 2 !== 1) throw new TypeError('collection paths have an odd number of segments');
      return {
        path: colPath,
        async get() {
          await later();
          const docs = Object.keys(store).filter((p) => p.startsWith(colPath + '/') && !p.slice(colPath.length + 1).includes('/')).sort().map((p) => snap(p.slice(colPath.length + 1), store[p]));
          return { docs, size: docs.length, empty: !docs.length };
        },
        doc(id) {
          const p = `${colPath}/${id}`;
          if (!/^[A-Za-z0-9_\-.~:@+]+$/.test(id)) throw new TypeError('bad segment ' + id);
          return {
            id,
            path: p,
            async set(data) {
              await later();
              const json = JSON.stringify(data);
              if (new TextEncoder().encode(json).length > 256 * 1024) throw { code: 'invalid_argument', message: 'document over 256 KiB' };
              store[p] = JSON.parse(json);
              window.__dbWrites++;
              persist();
            },
            async delete() { await later(); delete store[p]; persist(); },
          };
        },
      };
    },
  });
  const sample = async () => ({ text: 'unused', truncated: false });
  window.__prompts = [];
  sample.json = async (prompt) => {
    window.__prompts.push(prompt);
    await new Promise((r) => setTimeout(r, 300));
    if (prompt.includes('{"subject"')) return { subject: 'Re: internship paperwork', body: 'Hi Mariam,\n\nThanks — I will send the signed agreement today.\n' };
    return {
      findings: [
        { type: 'deadline', title: 'Signed internship agreement to the placement office', quote: 'the signed internship agreement has to reach the placement office by 16 November', date_phrase: '16 November', date_reading: '2026-11-16' },
        { type: 'decision', title: 'Reference letter dropped for second-years', quote: 'They decided to drop the reference letter requirement for second-year students', date_phrase: '', date_reading: '' },
        { type: 'question', title: 'Made up', quote: 'This sentence is nowhere in the email.', date_phrase: '', date_reading: '' },
      ],
    };
  };
  window.__saved = [];
  const downloads = Object.freeze({ save: async ({ filename, data }) => { window.__saved.push({ filename, size: String(data).length }); return { status: 'saved' }; } });
  const user = Object.freeze({ id: async () => 'u_test_viewer', isOwner: async () => true, canEdit: async () => true, can: async () => true });
  window.claude = { use: async (name) => ({ db, user, sample, downloads })[name] || null };
};

const passed = [];
async function step(name, fn) {
  await fn();
  passed.push(name);
  console.log('  ✓ ' + name);
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  await startServer();
  const browser = await chromium.launch();
  const errors = [];
  const watch = (page, label) => {
    page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`${label}: ${m.text()}`));
  };

  // ---------------------------------------------------------------- Part A
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const a = await ctxA.newPage();
  lastPage = a;
  watch(a, 'A');
  await step('outside claude.ai: opens with the demo and says it saves in this browser', async () => {
    await a.goto(base + '/hosted');
    await a.waitForSelector('.board');
    assert.match(await a.locator('.banner.warn-banner').innerText(), /saving your work in this browser only/);
    assert.equal(await a.locator('#save-pill').innerText(), 'Saved');
    assert.match(await a.locator('#ai-pill').innerText(), /AI off/);
    assert.ok((await a.locator('.board-col.attention .task-row').count()) >= 2);
    assert.equal(a.url(), base + '/hosted', 'no #/ routes in the address');
  });
  await step('outside claude.ai: import a PDF (built-in decompression) and an email, navigate in memory', async () => {
    await a.getByRole('button', { name: 'Import source' }).first().click();
    await a.getByRole('tab', { name: 'Upload a PDF' }).click();
    await a.getByRole('button', { name: 'Use the sample PDF' }).click();
    await a.locator('#drop-label', { hasText: 'course-outline.pdf' }).waitFor();
    await a.getByRole('button', { name: 'Import and review' }).click();
    await a.waitForSelector('.review .finding');
    assert.match(await a.locator('.review-head h1').innerText(), /Course outline/);
    assert.ok((await a.locator('.finding').count()) >= 8);
    assert.match(await a.locator('.finding', { hasText: 'final team report' }).first().innerText(), /page 2/);
    await a.locator('a.crumb').click();
    await a.waitForSelector('.source-card');
    assert.equal(a.url(), base + '/hosted');
  });
  await step('outside claude.ai: correct a date, make a task, then reload and find it all again', async () => {
    await a.locator('.source-card', { hasText: 'Course outline' }).click();
    const c = a.locator('.finding', { hasText: 'final team report' }).first();
    await c.getByRole('button', { name: 'Another date…' }).click();
    await c.locator('input[name=date]').fill('2026-12-18');
    await c.locator('input[name=time]').fill('17:00');
    await c.getByRole('button', { name: 'Save date' }).click();
    await c.locator('.datebox', { hasText: 'corrected by you' }).waitFor();
    await c.getByRole('button', { name: 'Add to Today' }).click();
    await c.locator('text=on Today').waitFor();
    await a.reload();
    await a.waitForSelector('.board');
    assert.match(await a.locator('.board-col.attention').innerText(), /final team report/);
    await a.locator('#search').fill('final team report');
    await a.waitForSelector('.result');
    await a.locator('a.result', { hasText: 'final team report' }).first().click();
    await a.waitForSelector('.review .finding.sel');
    assert.match(await a.locator('.finding.sel .datebox').innerText(), /Friday, 18 December 2026, 5:00 PM · corrected by you/);
    await a.screenshot({ path: path.join(out, 'hosted-A-review.png') });
  });
  await ctxA.close();

  // ---------------------------------------------------------------- Part B
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  await ctxB.addInitScript(FAKE_CLAUDE);
  const b = await ctxB.newPage();
  lastPage = b;
  watch(b, 'B');
  await step('on claude.ai: work is saved to the private account space, with Claude available', async () => {
    await b.goto(base + '/hosted');
    await b.waitForSelector('.board');
    await b.locator('#save-pill', { hasText: 'Saved' }).waitFor();
    assert.equal(await b.locator('.banner.warn-banner').count(), 0);
    assert.match(await b.locator('#ai-pill').innerText(), /AI on/);
    const keys = await b.evaluate(() => Object.keys(window.__db));
    assert.ok(keys.length >= 10 && keys.every((k) => k.startsWith('data/users/u_test_viewer/')), 'demo saved under the viewer’s private path');
    assert.ok(keys.includes('data/users/u_test_viewer/meta'));
    assert.equal(keys.filter((k) => /\/src_[^/]+\.f0$/.test(k)).length, 2, 'each demo source keeps its findings in one grouped document');
    await b.screenshot({ path: path.join(out, 'hosted-B-home-dark.png') });
  });
  await step('on claude.ai: Claude reads an email; an invented quote is dropped', async () => {
    await b.getByRole('button', { name: 'Import source' }).first().click();
    await b.getByRole('button', { name: 'Fill in a sample email' }).click();
    await b.waitForFunction(() => /internship agreement/.test(document.querySelector('.modal textarea').value));
    assert.ok(await b.locator('.modal input[name=useAI]').isChecked());
    await b.getByRole('button', { name: 'Import and review' }).click();
    await b.locator('.modal', { hasText: 'Claude is reading the source' }).waitFor();
    await b.waitForSelector('.review .finding');
    const head = await b.locator('.review').innerText();
    assert.match(head, /AI extraction · Claude, through your account/);
    assert.match(head, /1 AI suggestion\(s\) were dropped/);
    assert.equal(await b.locator('.pane-findings .finding').count(), 2);
    assert.equal(await b.evaluate(() => window.__prompts.length), 1);
  });
  await step('on claude.ai: Claude drafts the follow-up; approval unlocks Gmail and Outlook', async () => {
    await b.locator('.finding', { hasText: 'Signed internship agreement' }).getByRole('button', { name: 'Draft follow-up' }).click();
    await b.waitForSelector('.composer');
    assert.match(await b.locator('.page-head').innerText(), /Written by AI/);
    assert.match(await b.locator('.composer textarea').inputValue(), /I will send the signed agreement today/);
    await b.getByRole('button', { name: 'Approve for sending' }).click();
    const gmail = await b.getByRole('link', { name: 'Gmail' }).getAttribute('href');
    assert.ok(gmail.startsWith('https://mail.google.com/mail/?view=cm&fs=1&to=m.qasim%40falconbay.example&su='), gmail);
    assert.equal(await b.getByRole('link', { name: 'Gmail' }).getAttribute('target'), '_blank');
    assert.ok((await b.getByRole('link', { name: 'Outlook' }).getAttribute('href')).startsWith('https://outlook.office.com/mail/deeplink/compose?to=m.qasim%40falconbay.example'));
    await b.locator('#save-pill', { hasText: 'Saved' }).waitFor();
    await b.screenshot({ path: path.join(out, 'hosted-B-draft-dark.png') });
  });
  await step('on claude.ai: a calendar event opens in Google Calendar at the right Dubai time', async () => {
    await b.locator('a.crumb').click();
    await b.locator('a[href^="#/source/"]').first().click().catch(() => {});
    await b.locator('#nav a', { hasText: 'Sources' }).click();
    await b.locator('.source-card', { hasText: 'internship paperwork' }).click();
    const card = b.locator('.finding', { hasText: 'Signed internship agreement' });
    await card.locator('summary').click();
    await card.getByRole('button', { name: 'Propose calendar event' }).click();
    await b.waitForSelector('.composer');
    await b.locator('#d-time').fill('09:30');
    await b.locator('#save-state', { hasText: 'Saved at' }).waitFor();
    await b.getByRole('button', { name: 'Approve calendar change' }).click();
    const g = await b.getByRole('link', { name: 'Google Calendar' }).getAttribute('href');
    assert.match(g, /dates=20261116T093000\/20261116T103000&ctz=Asia\/Dubai/);
    assert.equal(await b.getByRole('link', { name: 'Calendar file' }).count(), 0, 'no .ics download on claude.ai');
  });
  await step('on claude.ai: a copy of the data is offered as a file', async () => {
    await b.locator('#nav a', { hasText: 'Settings' }).click();
    assert.match(await b.locator('.settings').innerText(), /private space in your Claude account/);
    await b.getByRole('button', { name: 'Save a copy (.json)' }).click();
    await b.locator('.toast', { hasText: 'Saved.' }).waitFor();
    const saved = await b.evaluate(() => window.__saved);
    assert.equal(saved[0].filename, 'dexter-export.json');
    assert.ok(saved[0].size > 1000);
  });
  await step('on claude.ai: after a reload everything is there, and long text is stored in chunks', async () => {
    const before = await b.evaluate(() => Object.keys(window.__db).length);
    await b.reload();
    await b.waitForSelector('.board');
    await b.locator('#nav a', { hasText: 'Drafts' }).click();
    await b.waitForSelector('.link-row');
    assert.match(await b.locator('#main').innerText(), /Re: internship paperwork/);
    const writesAfterReload = await b.evaluate(() => window.__dbWrites);
    assert.equal(writesAfterReload, 0, 'opening the page writes nothing');
    // a long note is split across documents and comes back whole
    const long = Array.from({ length: 2600 }, (_, i) => `Line ${i}: the lab report is due on 2 December 2026, please confirm.`).join('\n');
    await b.locator('#nav a', { hasText: 'Home' }).click();
    await b.getByRole('button', { name: 'Import source' }).first().click();
    await b.getByRole('tab', { name: 'Write a note' }).click();
    await b.locator('.modal textarea').fill(long);
    await b.locator('.modal input[name=useAI]').uncheck();
    await b.getByRole('button', { name: 'Import and review' }).click();
    await b.waitForSelector('.review .finding');
    await b.locator('#save-pill', { hasText: 'Saved' }).waitFor({ timeout: 60000 });
    const chunks = await b.evaluate(() => Object.keys(window.__db).filter((k) => /\.t\d+$/.test(k)).length);
    assert.ok(chunks >= 5, `long text in ${chunks} chunk documents`);
    const biggest = await b.evaluate(() => Math.max(...Object.values(window.__db).map((d) => JSON.stringify(d).length)));
    assert.ok(biggest < 256 * 1024);
    await b.reload();
    await b.waitForSelector('.board');
    const length = await b.evaluate(async () => {
      const { start } = await import('/hosted.js');
      const be = await start();
      const st = (await be.api('GET', '/api/state')).state;
      return st.sources.find((s) => s.text.startsWith('Line 0:')).text.length;
    });
    assert.equal(length, long.length);
    assert.ok(before > 0);
  });
  await step('on claude.ai: deleting a source removes its documents', async () => {
    await b.locator('#nav a', { hasText: 'Sources' }).click();
    await b.locator('.source-card', { hasText: 'Line 0' }).click();
    // CSS selectors here: role lookups are slow on a page with 2,600 finding cards
    await b.locator('.review-head [data-action="source-delete"]').click();
    await b.locator('.modal [data-action="confirm-yes"]', { hasText: 'Delete source' }).click();
    await b.waitForSelector('.source-list');
    await b.locator('#save-pill', { hasText: 'Saved' }).waitFor({ timeout: 60000 });
    await b.waitForFunction(() => !Object.keys(window.__db).some((k) => /\.t\d+$/.test(k) && window.__db[k].text.startsWith('Line 0')));
  });
  await ctxB.close();

  await browser.close();
  server.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
  assert.deepEqual(errors, [], 'no browser errors');
  console.log(`\n${passed.length} steps passed. Screenshots: ${out}`);
})().catch(async (err) => {
  console.error('\nFAILED after: ' + (passed[passed.length - 1] || 'start') + '\n', err);
  if (lastPage) await lastPage.screenshot({ path: path.join(out, 'hosted-failure.png') }).catch(() => {});
  if (server && server.exitCode === null) server.kill();
  process.exit(1);
});
