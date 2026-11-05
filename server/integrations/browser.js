// Visible browser workflow for sites without a usable API (iLearn, Banner).
// Uses Playwright when it is installed; the profile persists in data/ so
// Sultan signs in once. Sign-in, MFA and unexpected prompts are handed to him.
import path from 'node:path';
import { createRequire } from 'node:module';
import { log } from '../lib/log.js';

const require = createRequire(import.meta.url);

const SIGNIN_HOSTS = /(login\.microsoftonline\.com|login\.live\.com|adfs|sso\.|\.okta\.com|duosecurity|accounts\.google\.com|\/cas\/|shibboleth|idp\.)/i;
const SIGNIN_TEXT = /(verify your identity|enter (the )?code|approve sign[- ]in|multi-?factor|two-?step verification|authenticator app|sign in to your account|session (has )?expired)/i;

function loadPlaywright() {
  try { return require('playwright'); } catch { /* not installed */ }
  try { return require('playwright-core'); } catch { return null; }
}

export function createBrowser(app) {
  let pw;
  let context = null;
  let page = null;
  let launching = null;

  function status() {
    if (pw === undefined) pw = loadPlaywright();
    return {
      installed: Boolean(pw),
      headless: app.config.browser.headless,
      open: Boolean(context),
      url: page && !page.isClosed() ? page.url() : null,
      setup: pw ? null : 'Install Playwright in the Dexter folder: npm install playwright && npx playwright install chromium — then restart Dexter.',
    };
  }

  async function ensure() {
    const s = status();
    if (!s.installed) throw new Error(`The browser workflow needs Playwright. ${s.setup}`);
    if (context && page && !page.isClosed()) return page;
    if (launching) return launching;
    launching = (async () => {
      const opts = { headless: app.config.browser.headless, viewport: { width: 1280, height: 860 } };
      if (process.env.DEXTER_CHROMIUM_PATH) opts.executablePath = process.env.DEXTER_CHROMIUM_PATH;
      context = await pw.chromium.launchPersistentContext(path.join(app.config.dataDir, 'browser-profile'), opts);
      context.on('close', () => { context = null; page = null; });
      page = context.pages()[0] || await context.newPage();
      return page;
    })();
    try { return await launching; } finally { launching = null; }
  }

  async function settle(p) {
    try { await p.waitForLoadState('domcontentloaded', { timeout: 15000 }); } catch { /* keep going */ }
    try { await p.waitForLoadState('networkidle', { timeout: 4000 }); } catch { /* busy pages never idle */ }
  }

  async function snapshot() {
    const p = await ensure();
    const data = await p.evaluate(() => {
      const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n');
      const links = [...document.querySelectorAll('a[href]')].filter(visible).map((a) => ({ text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 120), href: a.href })).filter((l) => l.text && /^https?:/.test(l.href)).slice(0, 80);
      const buttons = [...document.querySelectorAll('button, input[type=submit], input[type=button], [role=button]')].filter(visible).map((b) => (b.innerText || b.value || b.getAttribute('aria-label') || '').trim().slice(0, 80)).filter(Boolean).slice(0, 40);
      const inputs = [...document.querySelectorAll('input, select, textarea')].filter(visible).filter((i) => !['hidden', 'submit', 'button'].includes(i.type)).map((i) => {
        const label = (i.labels && i.labels[0]?.innerText) || i.getAttribute('aria-label') || i.placeholder || i.name || '';
        return { label: label.trim().slice(0, 80), type: i.type || i.tagName.toLowerCase(), name: i.name || null };
      }).slice(0, 40);
      const hasPassword = [...document.querySelectorAll('input[type=password]')].some(visible);
      return { text, links, buttons, inputs, hasPassword, title: document.title };
    });
    const url = p.url();
    const signin = data.hasPassword || SIGNIN_HOSTS.test(url) || SIGNIN_TEXT.test(data.text.slice(0, 4000));
    return { url, title: data.title, text: data.text, links: data.links, buttons: data.buttons, inputs: data.inputs, signin };
  }

  async function screenshot(label = 'page') {
    const p = await ensure();
    const buffer = await p.screenshot({ type: 'png', fullPage: false });
    const host = (() => { try { return new URL(p.url()).hostname; } catch { return 'browser'; } })();
    return app.files.save({ name: `${host}-${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`, mime: 'image/png', buffer, folder: 'Browser', origin: 'browser' });
  }

  async function open(url) {
    const p = await ensure();
    try { await p.bringToFront(); } catch { /* headless */ }
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await settle(p);
    return snapshot();
  }

  async function followLink(linkText) {
    const p = await ensure();
    const href = await p.evaluate((t) => {
      const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
      const want = norm(t);
      const anchors = [...document.querySelectorAll('a[href]')];
      const exact = anchors.find((a) => norm(a.innerText || '') === want);
      const partial = exact || anchors.find((a) => norm(a.innerText || '').includes(want));
      return partial ? partial.href : null;
    }, linkText);
    if (!href) throw new Error(`No link with the text “${linkText}” on this page.`);
    if (!/^https?:/i.test(href)) throw new Error('That link is not a normal web link.');
    await p.goto(href, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await settle(p);
    return snapshot();
  }

  async function click(buttonText) {
    const p = await ensure();
    const loc = p.getByRole('button', { name: buttonText, exact: false }).first();
    if (await loc.count() === 0) throw new Error(`No button labelled “${buttonText}” on this page.`);
    await loc.click({ timeout: 15000 });
    await settle(p);
    return snapshot();
  }

  async function fillAndSubmit(fields, submitText) {
    const p = await ensure();
    for (const f of fields) {
      let loc = p.getByLabel(f.label, { exact: false }).first();
      if (await loc.count() === 0) loc = p.getByPlaceholder(f.label, { exact: false }).first();
      if (await loc.count() === 0) loc = p.locator(`[name="${String(f.label).replace(/"/g, '')}"]`).first();
      if (await loc.count() === 0) throw new Error(`Could not find the field “${f.label}”. Nothing was submitted.`);
      const tag = await loc.evaluate((el) => el.tagName.toLowerCase());
      if (tag === 'select') await loc.selectOption({ label: f.value });
      else await loc.fill(String(f.value));
    }
    return click(submitText);
  }

  async function close() {
    if (context) {
      try { await context.close(); } catch (err) { log.warn('browser close failed', { error: err.message }); }
    }
    context = null; page = null;
  }

  return { status, ensure, open, snapshot, screenshot, followLink, click, fillAndSubmit, close };
}
