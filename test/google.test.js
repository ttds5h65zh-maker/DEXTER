import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockGoogle, startDexter, connectGoogle } from './helpers.js';

let google;
before(async () => { google = await startMockGoogle(); });
after(async () => { await google.close(); });

test('OAuth: PKCE redirect, state check, encrypted token storage', async () => {
  const d = await startDexter({ google });
  try {
    const res = await fetch(`${d.base}/api/integrations/google/connect`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get('location'));
    assert.equal(loc.origin + loc.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(loc.searchParams.get('client_id'), 'client-id');
    assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(loc.searchParams.get('access_type'), 'offline');
    assert.match(loc.searchParams.get('scope'), /gmail\.compose/);
    assert.match(loc.searchParams.get('redirect_uri'), /\/api\/integrations\/google\/callback$/);

    const bad = await fetch(`${d.base}/api/integrations/google/callback?code=x&state=forged`, { redirect: 'manual' });
    assert.match(bad.headers.get('location'), /google_error=/);
    assert.equal(d.app.google.status().connected, false);

    const cb = await fetch(`${d.base}/api/integrations/google/callback?code=abc&state=${loc.searchParams.get('state')}`, { redirect: 'manual' });
    assert.match(cb.headers.get('location'), /google=connected/);
    const st = (await d.request('GET', '/api/integrations')).data.google;
    assert.equal(st.connected, true);
    assert.equal(st.email, 'sultan@example.com');
    const tokenCall = google.calls.find((c) => c.path === '/token' && c.body.includes('authorization_code'));
    assert.match(tokenCall.body, /code_verifier=/);
    const raw = d.app.db.get("SELECT value FROM secrets WHERE key = 'google_oauth'").value;
    assert.ok(raw.startsWith('v1:') && !raw.includes('refresh-1'), 'token stored encrypted');
    // Reusing the state fails (one-time)
    const replay = await fetch(`${d.base}/api/integrations/google/callback?code=abc&state=${loc.searchParams.get('state')}`, { redirect: 'manual' });
    assert.match(replay.headers.get('location'), /google_error=/);
  } finally { await d.close(); }
});

test('Gmail/Calendar clients, today view, email monitor dedupe, revoked access', async () => {
  const d = await startDexter({ google });
  connectGoogle(d.app);
  try {
    const msgs = await d.app.google.searchMessages('is:unread', 5);
    assert.equal(msgs[0].subject, 'MIS 320 project deadline');
    assert.equal(msgs[0].unread, true);
    const ev = await d.app.google.insertEvent({ summary: 'MIS 320 lecture', start: new Date(Date.now() + 3600e3).toISOString(), end: new Date(Date.now() + 2 * 3600e3).toISOString() });
    assert.equal(google.events.get(ev.id).start.timeZone, 'Asia/Dubai');
    const today = (await d.request('GET', '/api/today')).data;
    assert.equal(today.calendar.status, 'connected');

    const job = d.app.jobs.create({ name: 'Dr. Khan emails', kind: 'monitor', schedule: { type: 'interval', minutes: 15 }, payload: { check: { type: 'email', query: 'from:khan@aus.edu' } } });
    d.app.db.run('UPDATE jobs SET created_at = ? WHERE id = ?', new Date(Date.now() - 3600e3).toISOString(), job.id);
    for (let i = 0; i < 2; i++) {
      d.app.db.run('UPDATE jobs SET next_run_at = ? WHERE id = ?', new Date(Date.now() - 1000 - i).toISOString(), job.id);
      await d.app.scheduler.tick();
    }
    const runs = d.app.jobs.runs(job.id);
    assert.equal(runs.length, 2);
    assert.deepEqual(runs.map((r) => r.result.new_alerts).sort(), [0, 1]);
    assert.equal(d.app.notifications.list().filter((n) => n.source_id === job.id).length, 1);

    // Revoked refresh token -> honest "reconnect" error, status reflects it
    d.app.settings.setSecret('google_oauth', { refresh_token: 'revoked', access_token: null, expires_at: 0, email: 'sultan@example.com' });
    await assert.rejects(() => d.app.google.searchMessages('x', 1), /revoked or expired/);
    assert.match(d.app.google.status().error, /invalid_grant/);

    // Disconnect clears the token
    await d.request('POST', '/api/integrations/google/disconnect');
    assert.equal(d.app.google.status().connected, false);
  } finally { await d.close(); }
});
