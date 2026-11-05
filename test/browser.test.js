import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startMockClaude, startDexter, waitFor, text, toolUse } from './helpers.js';

let claude; let site; let base;
const submissions = [];
before(async () => {
  claude = await startMockClaude();
  site = http.createServer(async (req, res) => {
    const html = (b) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><html><head><title>Fake Banner</title></head><body>${b}</body></html>`); };
    if (req.url === '/login') return html('<h1>Sign in to your account</h1><label>Username <input name="u"></label><label>Password <input type="password" name="p"></label>');
    if (req.url === '/home') return html('<h1>Student Home</h1><p>Term: Fall 2026</p><a href="/schedule">My Schedule</a> <a href="/register">Add or Drop Classes</a>');
    if (req.url === '/schedule') return html('<h1>My Schedule</h1><ul><li>MIS 320 — Mon/Wed 10:00</li><li>ACC 201 — Tue/Thu 11:30</li></ul>');
    if (req.url === '/register' && req.method === 'GET') return html('<h1>Add Classes</h1><form method="post" action="/register"><label>CRN <input name="crn"></label><button type="submit">Submit Changes</button></form>');
    if (req.url === '/register' && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c;
      submissions.push(new URLSearchParams(body).get('crn'));
      return html(`<h1>Registration confirmed</h1><p>CRN ${new URLSearchParams(body).get('crn')} added.</p>`);
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${site.address().port}`;
});
after(async () => { await claude.close(); site.closeAllConnections?.(); await new Promise((r) => site.close(r)); });

const runStatus = async (d, convId) => (await d.request('GET', `/api/conversations/${convId}`)).data.runs[0]?.status;

test('real browser: read pages and follow links; form submission needs approval and is confirmed by the site', async (t) => {
  const d = await startDexter({ claude });
  if (!d.app.browser.status().installed) { t.skip('Playwright not installed'); await d.close(); return; }
  try {
    await d.request('PATCH', '/api/settings', { integrations: { banner_url: `${base}/home` } });
    const convId = (await d.request('POST', '/api/conversations', {})).data.conversation.id;
    claude.reply(
      { content: [toolUse('b1', 'browser_open', { site: 'banner' })], stop_reason: 'tool_use' },
      (body) => {
        const r = body.messages.at(-1).content[0];
        assert.match(r.content, /<untrusted_content source="browser"/);
        assert.match(r.content, /Student Home/);
        assert.match(r.content, /My Schedule/);
        return { content: [toolUse('b2', 'browser_follow_link', { link_text: 'Add or Drop Classes' })], stop_reason: 'tool_use' };
      },
      (body) => {
        assert.match(body.messages.at(-1).content[0].content, /Form fields: CRN/);
        return { content: [toolUse('b3', 'browser_fill_and_submit', { fields: [{ label: 'CRN', value: '20451' }], submit_text: 'Submit Changes', reason: 'Add MIS 320 section CRN 20451' })], stop_reason: 'tool_use' };
      },
      (body) => {
        const r = body.messages.at(-1).content[0];
        assert.match(r.content, /Registration confirmed/);
        return { content: [text('Registered — Banner shows “Registration confirmed” for CRN 20451.')], stop_reason: 'end_turn' };
      },
    );
    await d.request('POST', `/api/conversations/${convId}/messages`, { text: 'Add CRN 20451 in Banner' });
    await waitFor(async () => (await runStatus(d, convId)) === 'awaiting_approval', { timeout: 30000, label: 'approval' });
    assert.equal(submissions.length, 0, 'nothing submitted before approval');
    const a = (await d.request('GET', '/api/approvals?status=pending')).data.approvals[0];
    assert.equal(a.tool, 'browser_fill_and_submit');
    assert.equal(a.grantable, false, 'form submissions cannot be pre-authorised');
    assert.ok(a.preview.fields.some((f) => f.label === 'CRN' && f.value === '20451'));
    assert.ok(a.preview.screenshot_file_id, 'approval includes a screenshot of the page');
    assert.ok(a.provenance.some((p) => p.source === 'browser'));
    await d.request('POST', `/api/approvals/${a.id}/approve`, {});
    await waitFor(async () => (await runStatus(d, convId)) === 'completed', { timeout: 30000, label: 'completed' });
    assert.deepEqual(submissions, ['20451']);
  } finally { await d.close(); }
});

test('real browser in headless mode reports that sign-in cannot be handed off (no fake success)', async (t) => {
  const d = await startDexter({ claude });
  if (!d.app.browser.status().installed) { t.skip('Playwright not installed'); await d.close(); return; }
  try {
    d.app.config.browser.headless = true;
    const convId = (await d.request('POST', '/api/conversations', {})).data.conversation.id;
    claude.reply(
      { content: [toolUse('l1', 'browser_open', { site: 'url', url: `${base}/login` })], stop_reason: 'tool_use' },
      (body) => {
        const r = body.messages.at(-1).content[0];
        assert.equal(r.is_error, true);
        assert.match(r.content, /without a window/);
        return { content: [text('I need you to run Dexter on your computer to sign in.')], stop_reason: 'end_turn' };
      },
    );
    await d.request('POST', `/api/conversations/${convId}/messages`, { text: 'Open the login page' });
    await waitFor(async () => (await runStatus(d, convId)) === 'completed', { timeout: 30000, label: 'completed' });
  } finally { await d.close(); }
});

test('sign-in hand-off: run blocks for Sultan, then resumes the same step', async () => {
  const d = await startDexter({ claude });
  try {
    d.app.config.browser.headless = false;
    let signedIn = false;
    const page = (signin) => ({ url: signin ? 'https://login.microsoftonline.com/x' : 'https://ilearn.aus.edu/home', title: signin ? 'Sign in' : 'iLearn', text: signin ? 'Sign in to your account' : 'Courses: MIS 320, ACC 201', links: [], buttons: [], inputs: [], signin });
    d.app.browser = {
      status: () => ({ installed: true, headless: false, open: true, url: 'https://ilearn.aus.edu' }),
      open: async () => page(!signedIn), snapshot: async () => page(!signedIn), close: async () => {},
      screenshot: async () => d.app.files.save({ name: 'signin.png', mime: 'image/png', buffer: Buffer.from('89504e47', 'hex'), folder: 'Browser', origin: 'browser' }),
    };
    const task = d.app.tasks.create({ title: 'Check iLearn announcements' });
    claude.reply(
      { content: [toolUse('u', 'update_task', { task_id: task.id, status: 'running' }), toolUse('o1', 'browser_open', { site: 'ilearn' })], stop_reason: 'tool_use' },
      (body) => {
        const results = body.messages.at(-1).content;
        assert.match(results[1].content, /Courses: MIS 320/);
        return { content: [text('You are enrolled in MIS 320 and ACC 201 on iLearn.')], stop_reason: 'end_turn' };
      },
    );
    const convId = (await d.request('POST', '/api/conversations', {})).data.conversation.id;
    await d.request('POST', `/api/conversations/${convId}/messages`, { text: 'What courses do I have on iLearn?' });
    await waitFor(async () => (await runStatus(d, convId)) === 'blocked', { label: 'blocked' });
    const hd = (await d.request('GET', '/api/handoffs')).data.handoffs;
    assert.equal(hd.length, 1);
    assert.equal(hd[0].title, 'Sign in to iLearn');
    assert.ok(hd[0].screenshot_file_id);
    assert.equal(d.app.tasks.get(task.id).status, 'blocked');
    assert.match(d.app.tasks.get(task.id).blocked_reason, /Sign in to iLearn/);
    const today = (await d.request('GET', '/api/today')).data;
    assert.equal(today.attention.handoffs.length, 1);

    signedIn = true; // Sultan signs in in the visible window
    await d.request('POST', `/api/handoffs/${hd[0].id}/resolve`);
    await waitFor(async () => (await runStatus(d, convId)) === 'completed', { label: 'completed' });
    assert.equal((await d.request('GET', '/api/handoffs')).data.handoffs.length, 0);
    assert.equal(d.app.tasks.get(task.id).status, 'planned');
  } finally { await d.close(); }
});
