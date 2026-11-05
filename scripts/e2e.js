// End-to-end UI test: drives the real web app in Chromium against a local
// Dexter instance and a scripted fake of the Claude API.
//   npm run test:e2e            (needs Playwright: npm i -D playwright && npx playwright install chromium)
//   E2E_SHOTS=dir npm run test:e2e   to save screenshots
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startMockClaude, startDexter, text, toolUse, waitFor } from '../test/helpers.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.error('Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

const shots = process.env.E2E_SHOTS || null;
if (shots) fs.mkdirSync(shots, { recursive: true });
const step = (msg) => console.log(`• ${msg}`);

const claude = await startMockClaude();
const d = await startDexter({ claude });
const browser = await chromium.launch(process.env.DEXTER_CHROMIUM_PATH ? { executablePath: process.env.DEXTER_CHROMIUM_PATH } : {});
const errors = [];
let failed = false;
let page;
try {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 880 }, deviceScaleFactor: shots ? 2 : 1 });
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const shot = async (name) => {
    const visible = await page.evaluate(() => document.body.innerText);
    assert.doesNotMatch(visible, /\bnull\b|\bundefined\b|\[object Object\]|NaN/, `stray placeholder text on ${name}`);
    if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) });
  };

  const oldMem = d.app.memory.create({ content: 'I prefer evening study sessions', kind: 'preference' });
  claude.reply(
    { content: [{ type: 'thinking', thinking: 'Saving the preference and creating the task.' }, text('Got it — I will **track the report** and update your study preference.'),
      toolUse('t1', 'save_memory', { content: 'Prefers morning study blocks (before 11:00)', kind: 'preference' }),
      toolUse('t2', 'create_task', { title: 'Submit MIS 320 analytics report', due: new Date(Date.now() + 26 * 3600e3).toISOString(), priority: 'high' })], stop_reason: 'tool_use' },
    { content: [text('Your old evening preference conflicts with this. I will remove it once you approve.'), toolUse('t3', 'delete_memory', { memory_id: oldMem.id, reason: 'Replaced by the morning preference' })], stop_reason: 'tool_use' },
    { content: [text('Done. The task is **planned** and due tomorrow; the outdated memory was deleted after your approval.\n\n- Task: Submit MIS 320 analytics report\n- Memory: morning study blocks')], stop_reason: 'end_turn' },
  );

  step('chat: send a message and watch tool activity');
  await page.goto(`${d.base}/#/chat/new`);
  await page.locator('.composer textarea').fill('I now prefer studying in the morning. Also track my MIS 320 report, due tomorrow.');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.tool.attention', { timeout: 15000 });
  await page.waitForSelector('text=Awaiting approval');
  await page.waitForSelector('text=Delete a memory');
  await shot('01-chat-approval');
  assert.equal(d.app.memory.get(oldMem.id) !== null, true, 'memory not deleted before approval');

  step('chat: approve inline');
  await page.locator('.tool.attention button:has-text("Approve")').click();
  await page.waitForSelector('text=the outdated memory was deleted after your approval', { timeout: 15000 });
  await waitFor(() => d.app.memory.get(oldMem.id) === null, { label: 'memory deleted' });
  await page.waitForFunction(() => !document.querySelector('.runbar .spinner'));
  await shot('02-chat-done');
  const toolStates = await page.locator('.tool .status').allInnerTexts();
  assert.ok(toolStates.filter((s) => s.trim() === 'done').length >= 3, `tool states: ${toolStates}`);

  step('tasks: the task is persisted with its timeline');
  await page.goto(`${d.base}/#/tasks`);
  await page.waitForSelector('text=Submit MIS 320 analytics report');
  await page.locator('.task-row:has-text("Submit MIS 320 analytics report")').click();
  await page.waitForSelector('.timeline li');
  await page.waitForSelector('text=Created by Dexter from the conversation');
  await shot('03-tasks');

  step('memory: shows source and allows editing');
  await page.goto(`${d.base}/#/memory`);
  await page.waitForSelector('text=Prefers morning study blocks');
  await page.waitForSelector('text=From conversation:');
  await page.locator('button[title="Edit"]').first().click();
  await page.locator('textarea[aria-label="Edit memory"]').fill('Prefers morning study blocks (before 11:00), Sun–Thu');
  await page.locator('button:has-text("Save")').last().click();
  await page.waitForSelector('text=Sun–Thu');
  await page.waitForSelector('text=Edited by you');
  await shot('04-memory');

  step('approvals: history shows the executed action');
  await page.goto(`${d.base}/#/approvals`);
  await page.waitForSelector('text=done — confirmed');
  await shot('05-approvals');

  step('schedules: create a reminder from the UI and run it now');
  await page.goto(`${d.base}/#/tasks/schedules`);
  await page.locator('button:has-text("New schedule")').click();
  await page.locator('.dialog input').first().fill('Check Banner');
  await page.locator('.dialog input').nth(1).fill('Check Banner registration window');
  const inHour = new Date(Date.now() + 3600e3);
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(inHour).reduce((a, p) => ({ ...a, [p.type]: p.value }), {});
  await page.locator('.dialog input[type="datetime-local"]').fill(`${local.year}-${local.month}-${local.day}T${local.hour}:${local.minute}`);
  await page.locator('.dialog button:has-text("Create")').click();
  await page.waitForSelector('.card h2:has-text("Check Banner")');
  await page.locator('.card:has(h2:has-text("Check Banner")) button:has-text("Run now")').click();
  await d.app.scheduler.tick();
  await page.waitForSelector('.toast:has-text("Reminder")', { timeout: 10000 });
  await shot('06-schedules');

  step('files: upload and preview');
  await page.goto(`${d.base}/#/files`);
  await page.setInputFiles('input[type="file"]', { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Week 9 notes\n\n- Regression assumptions\n- Residual plots') });
  await page.waitForSelector('.task-row:has-text("notes.md")');
  await page.locator('.task-row:has-text("notes.md")').click();
  await page.waitForSelector('text=Regression assumptions');
  await shot('07-files');

  step('documents: write, approve wording, export');
  await page.goto(`${d.base}/#/files/documents`);
  await page.locator('button:has-text("New document")').click();
  await page.waitForSelector('.doc-editor textarea');
  const ta = page.locator('.doc-editor textarea');
  await ta.fill('# Reflection\n\nThis course changed how I think about data.\n\nI will apply regression to my capstone.');
  await page.locator('button:has-text("Save")').click();
  await page.waitForSelector('text=v2');
  await ta.evaluate((el) => { const s = el.value.indexOf('This course'); el.setSelectionRange(s, s + 'This course changed how I think about data.'.length); });
  await page.locator('button:has-text("Approve selected wording")').click();
  await page.waitForSelector('mark.locked');
  await page.locator('button[title="Export .docx"]').click();
  await page.waitForSelector('.toast:has-text("Exported")');
  await shot('08-document');

  step('today: shows due work and the delivered reminder');
  await page.goto(`${d.base}/#/today`);
  await page.waitForSelector('text=Submit MIS 320 analytics report');
  await shot('09-today');

  step('settings: disconnected integrations explain setup');
  await page.goto(`${d.base}/#/settings/integrations`);
  await page.waitForSelector('text=GOOGLE_CLIENT_ID');
  await shot('10-settings');

  step('keyboard: Ctrl+K search');
  await page.keyboard.press('Control+k');
  await page.locator('.dialog input[type="search"]').fill('MIS');
  await page.waitForSelector('.search-results a:has-text("Submit MIS 320")');
  await page.keyboard.press('Escape');

  step('mobile layout');
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: shots ? 2 : 1, isMobile: true, hasTouch: true });
  const mp = await m.newPage();
  mp.on('pageerror', (e) => errors.push(e.message));
  await mp.goto(`${d.base}/#/today`);
  await mp.waitForSelector('text=Needs your attention');
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(overflow, false, 'no horizontal scroll on mobile');
  if (shots) await mp.screenshot({ path: path.join(shots, '11-mobile-today.png') });
  await mp.locator('button[title="Menu"]').click();
  await mp.waitForSelector('.shell.nav-open');
  if (shots) await mp.screenshot({ path: path.join(shots, '12-mobile-nav.png') });
  await mp.locator('.nav a:has-text("Chat")').click();
  await mp.waitForSelector('.conv-item');
  if (shots) await mp.screenshot({ path: path.join(shots, '13-mobile-chat-list.png') });

  assert.deepEqual(errors, [], `browser errors: ${errors.join('\n')}`);
  console.log('\nE2E passed.');
} catch (err) {
  failed = true;
  console.error('\nE2E FAILED:', err.message);
  try {
    console.error('Visible text:', (await page.evaluate(() => document.querySelector('#view')?.innerText || '')).slice(0, 1500));
    if (shots) await page.screenshot({ path: path.join(shots, 'failure.png') });
  } catch { /* ignore */ }
  if (errors.length) console.error('Browser errors:', errors);
} finally {
  await browser.close();
  await d.close();
  await claude.close();
}
process.exit(failed ? 1 : 0);
