// Browser walk-through of the core workflow, against a real server and a real restart.
//   node tests/e2e.cjs            (needs Playwright with Chromium available)
// Screenshots are written to tests/output/.

const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.dirname(__dirname);
const out = path.join(__dirname, 'output');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexter-e2e-'));
const PORT = 4800 + Math.floor(Math.random() * 100);
const base = `http://127.0.0.1:${PORT}`;
let server;

function startServer() {
  const env = { ...process.env, PORT: String(PORT), DEXTER_DATA_DIR: dataDir };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  server = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('Dexter is running') && resolve());
    server.on('exit', (code) => reject(new Error('server exited ' + code)));
  });
}
function stopServer() {
  const done = new Promise((r) => server.on('exit', r));
  server.kill('SIGTERM');
  return done;
}
const passed = [];
async function step(name, fn) {
  await fn();
  passed.push(name);
  console.log('  ✓ ' + name);
}

(async () => {
  const D = await import(require('node:url').pathToFileURL(path.join(root, 'shared', 'dates.js')).href);
  const target = D.addDays(D.todayInDubai(), 3); // the corrected date used below
  const targetLong = `${D.formatDate(target, { long: true })}, 11:59 PM`;
  const targetShort = `${D.formatDate(target, { year: false })}, 11:59 PM`;
  fs.mkdirSync(out, { recursive: true });
  await startServer();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, timezoneId: 'America/New_York' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const shot = (name) => page.screenshot({ path: path.join(out, name + '.png') });
  const state = async () => (await (await fetch(base + '/api/state')).json()).state;
  const card = (text) => page.locator('.finding', { hasText: text }).first();

  await step('home answers the three questions and labels the demo', async () => {
    await page.goto(base);
    await page.waitForSelector('.board');
    for (const h of ['Needs attention today', 'Waiting on', 'Ready for review']) assert.ok(await page.getByRole('heading', { name: h }).isVisible(), h);
    assert.ok(await page.locator('.banner', { hasText: 'demo data' }).isVisible());
    assert.ok((await page.locator('.board-col.attention .task-row').count()) >= 2);
    assert.ok((await page.locator('.board-col.waiting .wait-row').count()) >= 2);
    assert.ok((await page.locator('.board-col.review .link-row').count()) >= 2);
    // the browser is in New York, but the page must still show Dubai's date
    const s = await state();
    const [y, m, d] = s.meta.today.split('-').map(Number);
    assert.match(await page.locator('.page-head .eyebrow').innerText(), new RegExp(`\\b${d} \\w+ ${y}\\b.*DUBAI TIME`, 'i'));
    await shot('01-home');
  });

  let sourceUrl;
  await step('import a messy email (AI off: the manual path is explained)', async () => {
    await page.getByRole('button', { name: 'Import source' }).first().click();
    const note = page.locator('.modal .notice');
    assert.match(await note.innerText(), /AI extraction is off/);
    assert.match(await note.innerText(), /ANTHROPIC_API_KEY/);
    await page.getByRole('button', { name: 'Fill in a sample email' }).click();
    await page.waitForFunction(() => /internship agreement/.test(document.querySelector('.modal textarea').value));
    await shot('02-import');
    await page.getByRole('button', { name: 'Import and review' }).click();
    await page.waitForSelector('.review .finding');
    sourceUrl = page.url();
    assert.ok((await page.locator('.pane-findings .finding').count()) >= 5);
    assert.ok(await page.locator('.pane-source').isVisible() && await page.locator('.pane-findings').isVisible(), 'source and findings side by side on desktop');
  });

  await step('inspect the evidence behind a finding', async () => {
    const c = card('internship agreement');
    const quote = (await c.locator('.evidence q').innerText()).trim();
    await c.getByRole('button', { name: 'Show in source' }).click();
    const mark = page.locator('#source-text mark.sel');
    await mark.waitFor();
    assert.equal((await mark.innerText()).replace(/\s+/g, ' ').trim(), quote);
    assert.ok(await mark.isVisible());
    const s = await state();
    const src = s.sources.find((x) => sourceUrl.endsWith(x.id));
    assert.ok(src.text.replace(/\s+/g, ' ').includes(quote), 'the quoted passage is in the original text');
    await shot('03-evidence');
  });

  await step('an ambiguous date ("next Thursday at midnight") requires review before scheduling', async () => {
    const c = card('closes next Thursday');
    const box = c.locator('[data-needs-confirmation]');
    await box.waitFor();
    const text = await box.innerText();
    assert.match(text, /Confirm this date/i);
    assert.match(text, /next Thursday at midnight/);
    assert.match(text, /Dexter reads that as/);
    assert.ok((await box.getByRole('button').count()) >= 3, 'confirm, an alternative, and another date');
    const before = (await state()).tasks.length;
    await c.getByRole('button', { name: 'Create task' }).click();
    await c.locator('.prompt').waitFor();
    assert.match(await c.locator('.prompt').innerText(), /not confirmed yet/);
    assert.equal((await state()).tasks.length, before, 'no task was created');
    await c.getByRole('button', { name: 'Cancel' }).click();
    await c.scrollIntoViewIfNeeded();
    await shot('04-ambiguous-date');
  });

  await step('correct the date', async () => {
    const c = card('closes next Thursday');
    await c.getByRole('button', { name: 'Another date…' }).click();
    await c.locator('input[name=date]').fill(target);
    await c.locator('input[name=time]').fill('23:59');
    await c.getByRole('button', { name: 'Save date' }).click();
    await c.locator('.datebox', { hasText: 'corrected by you' }).waitFor();
    assert.ok((await c.locator('.datebox').innerText()).includes(targetLong));
    assert.equal(await c.locator('[data-needs-confirmation]').count(), 0);
  });

  await step('create a task from the finding and add another to Today', async () => {
    const c = card('closes next Thursday');
    await c.getByRole('button', { name: 'Create task' }).click();
    await c.locator('.badge', { hasText: 'Task' }).waitFor();
    assert.ok((await c.innerText()).includes(targetShort));
    const a = card('internship agreement');
    await a.getByRole('button', { name: 'Add to Today' }).click();
    await a.locator('text=on Today').waitFor();
    await shot('05-task-created');
  });

  await step('edit a finding, dismiss one, and add one by selecting text', async () => {
    const d = card('reference letter');
    await d.locator('summary').click();
    await d.getByRole('button', { name: 'Edit title or type' }).click();
    await d.locator('textarea[name=title]').fill('Reference letter no longer required (second-years)');
    await d.getByRole('button', { name: 'Save' }).click();
    await card('Reference letter no longer required').waitFor();
    await card('lab induction').getByRole('button', { name: 'Dismiss' }).click();
    await page.locator('details.dismissed-list').waitFor();
    // select "nobody has confirmed" in the source
    await page.evaluate(() => {
      const box = document.querySelector('#source-text');
      const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const i = node.data.indexOf('nobody has confirmed');
        if (i >= 0) {
          const r = document.createRange();
          r.setStart(node, i);
          r.setEnd(node, i + 'nobody has confirmed'.length);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
          return;
        }
      }
      throw new Error('text not found');
    });
    await page.locator('#sel-bar button', { hasText: 'Open question' }).click();
    const added = card('nobody has confirmed');
    await added.waitFor();
    assert.match(await added.innerText(), /Added by you/);
  });

  let draftUrl;
  await step('draft a follow-up, edit it, see its destination, and approve it', async () => {
    await card('internship agreement').getByRole('button', { name: 'Draft follow-up' }).click();
    await page.waitForSelector('.composer');
    draftUrl = page.url();
    assert.match(await page.locator('#draft-side').innerText(), /INTENDED DESTINATION\s+m\.qasim@falconbay\.example/i);
    assert.match(await page.locator('#draft-side').innerText(), /Dexter cannot send this/);
    assert.equal(await page.getByRole('link', { name: 'Mail app', exact: true }).count(), 0, 'no hand-off before approval');
    const body = page.locator('.composer textarea');
    await body.fill('Hi Mariam,\n\nThanks for this. I will scan the signed agreement and send it to the placement office on Sunday.\n\nYousef');
    await page.locator('#save-state', { hasText: 'Saved at' }).waitFor();
    await shot('06-draft-review');
    await page.getByRole('button', { name: 'Approve for sending' }).click();
    await page.getByRole('link', { name: 'Mail app', exact: true }).waitFor();
    const href = await page.getByRole('link', { name: 'Mail app', exact: true }).getAttribute('href');
    assert.ok(href.startsWith('mailto:m.qasim%40falconbay.example?subject=') && href.includes('placement%20office%20on%20Sunday'));
    await shot('07-draft-approved');
    // editing after approval withdraws it
    await page.locator('#d-subject').fill('Internship agreement: on its way');
    await page.getByRole('button', { name: 'Approve for sending' }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Mail app', exact: true }).count(), 0);
    await page.locator('#save-state', { hasText: 'Saved at' }).waitFor();
  });

  await step('search finds sources, findings, tasks and drafts', async () => {
    await page.locator('#search').fill('agreement');
    await page.waitForSelector('.result');
    const text = await page.locator('#main').innerText();
    for (const h of ['Tasks', 'Findings', 'Sources', 'Drafts']) assert.match(text, new RegExp(h));
    await shot('08-search');
    await page.locator('#search').fill('zzzqqq');
    await page.locator('h1', { hasText: 'No results' }).waitFor();
  });

  const before = await state();
  await step('restart the app and find the same saved state', async () => {
    await stopServer();
    await page.close();
    await startServer();
    const p2 = await context.newPage();
    p2.on('pageerror', (e) => errors.push(e.message));
    const after = await state();
    for (const kind of ['sources', 'findings', 'tasks', 'drafts']) assert.deepEqual(after[kind], before[kind], kind + ' unchanged after restart');
    await p2.goto(base);
    await p2.waitForSelector('.board');
    // pinned to Today → needs attention; due in three days → coming up this week
    assert.match(await p2.locator('.board-col.attention').innerText(), /internship agreement/);
    const coming = await p2.locator('.coming').innerText();
    assert.match(coming, /closes next Thursday/);
    assert.ok(coming.includes(targetShort.replace(/^\w+ /, '')) || coming.includes(targetShort), 'shows the corrected due date');
    await p2.screenshot({ path: path.join(out, '09-home-after-restart.png') });
    await p2.goto(sourceUrl);
    await p2.waitForSelector('.review .finding');
    const c = p2.locator('.finding', { hasText: 'closes next Thursday' }).first();
    assert.ok((await c.locator('.datebox').innerText()).includes(`${targetLong} · corrected by you`));
    assert.ok(await p2.locator('.finding', { hasText: 'Reference letter no longer required' }).first().isVisible());
    assert.ok(await p2.locator('.finding', { hasText: 'nobody has confirmed' }).first().isVisible());
    // task history
    await c.locator('.row .linkish').click();
    await p2.waitForSelector('.modal .history');
    const hist = await p2.locator('.modal .history').innerText();
    assert.match(hist, /Created from a deadline/);
    await p2.screenshot({ path: path.join(out, '10-task-history.png') });
    await p2.keyboard.press('Escape');
    await p2.goto(draftUrl);
    await p2.waitForSelector('.composer');
    assert.match(await p2.locator('.composer textarea').inputValue(), /placement office on Sunday/);
    assert.equal(await p2.locator('#d-subject').inputValue(), 'Internship agreement: on its way');
    assert.ok(await p2.getByRole('button', { name: 'Approve for sending' }).isVisible(), 'still waiting for approval');
    await p2.close();
  });

  await step('tablet: source and findings are one tap apart; a PDF imports with page references', async () => {
    const tablet = await browser.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true });
    const p = await tablet.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(base);
    await p.waitForSelector('.board');
    await p.screenshot({ path: path.join(out, '11-tablet-home.png') });
    await p.getByRole('button', { name: 'Import source' }).first().click();
    await p.getByRole('tab', { name: 'Upload a PDF' }).click();
    await p.getByRole('button', { name: 'Use the sample PDF' }).click();
    await p.locator('#drop-label', { hasText: 'course-outline.pdf' }).waitFor();
    await p.getByRole('button', { name: 'Import and review' }).click();
    await p.waitForSelector('.review .finding');
    assert.ok(await p.locator('.seg').isVisible());
    assert.ok(await p.locator('.pane-findings').isVisible() && !(await p.locator('.pane-source').isVisible()));
    const c = p.locator('.finding', { hasText: 'final team report' }).first();
    assert.match(await c.locator('.evidence .where').innerText(), /page 2/);
    assert.ok(await c.locator('[data-needs-confirmation]').isVisible());
    await p.screenshot({ path: path.join(out, '12-tablet-findings.png') });
    await c.getByRole('button', { name: 'Show in source' }).click();
    await p.locator('#source-text mark.sel').waitFor();
    assert.ok(await p.locator('.pane-source').isVisible() && !(await p.locator('.pane-findings').isVisible()));
    await p.waitForTimeout(500);
    await p.screenshot({ path: path.join(out, '13-tablet-source.png') });
    await p.locator('#source-text mark.sel').click();
    await p.locator('.finding.sel').waitFor();
    assert.ok(await p.locator('.pane-findings').isVisible());
    await tablet.close();
  });

  await browser.close();
  await stopServer();
  fs.rmSync(dataDir, { recursive: true, force: true });
  assert.deepEqual(errors, [], 'no browser errors');
  console.log(`\n${passed.length} steps passed. Screenshots: ${out}`);
})().catch(async (err) => {
  console.error('\nFAILED after: ' + (passed[passed.length - 1] || 'start') + '\n', err);
  if (server && server.exitCode === null) server.kill();
  process.exit(1);
});
