// Google OAuth 2.0 (authorization code + PKCE) and REST clients for Gmail and
// Google Calendar. Tokens are stored encrypted; nothing is faked when Google
// is not connected — callers get a NotConnectedError with setup steps.
import crypto from 'node:crypto';
import { NotConnectedError } from '../tools/errors.js';
import { htmlToText } from '../lib/text.js';
import { log } from '../lib/log.js';

export const GOOGLE_SCOPES = [
  'openid', 'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/calendar.events',
];

const SECRET_KEY = 'google_oauth';

export function encodeHeader(value) {
  const v = String(value ?? '');
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(v)) return v.replace(/[\r\n]+/g, ' ');
  return `=?UTF-8?B?${Buffer.from(v.replace(/[\r\n]+/g, ' '), 'utf8').toString('base64')}?=`;
}

function cleanAddressList(list) {
  const arr = Array.isArray(list) ? list : String(list || '').split(',');
  return arr.map((s) => String(s).trim()).filter(Boolean);
}

export function buildMime({ to, cc = [], subject, body, inReplyTo = null, references = null }) {
  const lines = [
    `To: ${cleanAddressList(to).join(', ')}`,
    ...(cleanAddressList(cc).length ? [`Cc: ${cleanAddressList(cc).join(', ')}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`, `References: ${references ? `${references} ${inReplyTo}` : inReplyTo}`);
  const b64 = Buffer.from(String(body).replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return `${lines.join('\r\n')}\r\n\r\n${b64}`;
}

const header = (headers, name) => headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

function decodeB64Url(data) {
  return Buffer.from(String(data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

export function extractBody(payload) {
  let plain = null; let html = null; const attachments = [];
  const walk = (part) => {
    if (!part) return;
    const mime = part.mimeType || '';
    if (part.filename) attachments.push({ name: part.filename, mime, size: part.body?.size || 0 });
    else if (mime === 'text/plain' && part.body?.data && plain == null) plain = decodeB64Url(part.body.data);
    else if (mime === 'text/html' && part.body?.data && html == null) html = decodeB64Url(part.body.data);
    for (const p of part.parts || []) walk(p);
  };
  walk(payload);
  return { text: plain ?? (html ? htmlToText(html) : ''), attachments };
}

export function findConflicts(events) {
  const timed = events
    .filter((e) => e.start && e.end && !e.all_day && e.status !== 'cancelled' && e.transparency !== 'transparent' && e.self_response !== 'declined')
    .sort((a, b) => new Date(a.start) - new Date(b.start));
  const conflicts = [];
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      if (new Date(timed[j].start) >= new Date(timed[i].end)) break;
      conflicts.push({ a: timed[i], b: timed[j], overlap_start: timed[j].start, overlap_end: new Date(Math.min(new Date(timed[i].end), new Date(timed[j].end))).toISOString() });
    }
  }
  return conflicts;
}

export function normalizeEvent(e) {
  const allDay = Boolean(e.start?.date && !e.start?.dateTime);
  return {
    id: e.id, summary: e.summary || '(no title)', status: e.status, location: e.location || null, description: e.description || null,
    start: e.start?.dateTime || e.start?.date || null, end: e.end?.dateTime || e.end?.date || null, all_day: allDay,
    html_link: e.htmlLink || null, transparency: e.transparency || 'opaque',
    attendees: (e.attendees || []).map((a) => ({ email: a.email, response: a.responseStatus, self: Boolean(a.self) })),
    self_response: (e.attendees || []).find((a) => a.self)?.responseStatus || null,
    organizer: e.organizer?.email || null,
  };
}

export function createGoogle(app) {
  const { config } = app;
  const pending = new Map();
  let lastError = null;

  const configured = () => Boolean(config.google.clientId && config.google.clientSecret);
  const redirectUri = () => `${config.publicUrl}/api/integrations/google/callback`;
  const stored = () => app.settings.getSecret(SECRET_KEY);

  function notConnected() {
    if (!configured()) {
      return new NotConnectedError('google', 'Google is not set up. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the server .env (OAuth client of type "Web application" with redirect URI ' + redirectUri() + '), restart Dexter, then connect in Settings → Integrations.');
    }
    return new NotConnectedError('google', 'Google is not connected. Sultan can connect Gmail and Calendar in Settings → Integrations.');
  }

  function status() {
    const s = stored();
    return {
      configured: configured(),
      connected: Boolean(s?.refresh_token),
      email: s?.email || null,
      scopes: s?.scope ? s.scope.split(' ') : [],
      connected_at: s?.connected_at || null,
      redirect_uri: redirectUri(),
      error: lastError,
    };
  }

  function startAuth() {
    if (!configured()) throw notConnected();
    const state = crypto.randomBytes(24).toString('base64url');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    pending.set(state, { verifier, expires: Date.now() + 10 * 60 * 1000 });
    for (const [k, v] of pending) if (v.expires < Date.now()) pending.delete(k);
    const params = new URLSearchParams({
      client_id: config.google.clientId, redirect_uri: redirectUri(), response_type: 'code', scope: GOOGLE_SCOPES.join(' '),
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state, code_challenge: challenge, code_challenge_method: 'S256',
    });
    return `${config.google.authUrl}?${params}`;
  }

  async function tokenRequest(params) {
    const res = await fetch(config.google.tokenUrl, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.google.clientId, client_secret: config.google.clientSecret, ...params }),
      signal: AbortSignal.timeout(20000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Google token endpoint: ${json.error_description || json.error || res.status}`);
    return json;
  }

  async function handleCallback({ code, state, error }) {
    if (error) throw new Error(`Google sign-in was not completed: ${error}`);
    const p = pending.get(state);
    if (!p || p.expires < Date.now()) throw new Error('This sign-in link expired or was not started from Dexter. Start again from Settings.');
    pending.delete(state);
    const tok = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: p.verifier });
    if (!tok.refresh_token) throw new Error('Google did not return a refresh token. Remove Dexter from your Google account permissions and connect again.');
    let email = null;
    if (tok.id_token) {
      try { email = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString('utf8')).email || null; } catch { /* ignore */ }
    }
    app.settings.setSecret(SECRET_KEY, {
      refresh_token: tok.refresh_token, access_token: tok.access_token, expires_at: Date.now() + (tok.expires_in || 3600) * 1000,
      scope: tok.scope || GOOGLE_SCOPES.join(' '), email, connected_at: new Date().toISOString(),
    });
    lastError = null;
    app.bus.publish('integrations.updated', {});
    return status();
  }

  async function accessToken(force = false) {
    const s = stored();
    if (!s?.refresh_token) throw notConnected();
    if (!force && s.access_token && s.expires_at > Date.now() + 60000) return s.access_token;
    try {
      const tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: s.refresh_token });
      app.settings.setSecret(SECRET_KEY, { ...s, access_token: tok.access_token, expires_at: Date.now() + (tok.expires_in || 3600) * 1000, scope: tok.scope || s.scope });
      lastError = null;
      return tok.access_token;
    } catch (err) {
      lastError = err.message;
      if (/invalid_grant/i.test(err.message)) {
        throw new NotConnectedError('google', 'Google access was revoked or expired. Reconnect in Settings → Integrations.');
      }
      throw err;
    }
  }

  async function api(method, url, { query, body } = {}) {
    const full = new URL(url);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) full.searchParams.set(k, String(v));
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await accessToken(attempt > 0);
      const res = await fetch(full, {
        method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
      });
      if (res.status === 401 && attempt === 0) continue;
      if (res.status === 204) return {};
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = json?.error?.message || `HTTP ${res.status}`;
        if (res.status === 403 && /insufficient|scope/i.test(msg)) throw new NotConnectedError('google', `Google denied access (${msg}). Reconnect Google in Settings and allow the requested permissions.`);
        throw new Error(`Google API error: ${msg}`);
      }
      return json;
    }
    throw new NotConnectedError('google', 'Google rejected the stored credentials. Reconnect in Settings → Integrations.');
  }

  async function disconnect() {
    const s = stored();
    if (s?.refresh_token) {
      try {
        await fetch(`${config.google.revokeUrl}?token=${encodeURIComponent(s.refresh_token)}`, { method: 'POST', signal: AbortSignal.timeout(10000) });
      } catch (err) { log.warn('google revoke failed', { error: err.message }); }
    }
    app.settings.deleteSecret(SECRET_KEY);
    app.bus.publish('integrations.updated', {});
    return status();
  }

  const gmail = (path) => `${config.google.gmailBase}/gmail/v1/users/me${path}`;
  const calendar = (path) => `${config.google.apiBase}/calendar/v3${path}`;

  async function searchMessages(q, max = 10) {
    const list = await api('GET', gmail('/messages'), { query: { q, maxResults: Math.min(Math.max(max, 1), 25) } });
    const ids = (list.messages || []).map((m) => m.id);
    const out = [];
    for (const id of ids) {
      const full = await api('GET', gmail(`/messages/${id}`), { query: { format: 'metadata' } });
      const h = full.payload?.headers || [];
      out.push({ id, thread_id: full.threadId, from: header(h, 'From'), to: header(h, 'To'), subject: header(h, 'Subject'), date: header(h, 'Date'),
        snippet: full.snippet || '', internal_date: full.internalDate ? new Date(Number(full.internalDate)).toISOString() : null, unread: (full.labelIds || []).includes('UNREAD'), labels: full.labelIds || [] });
    }
    return out;
  }

  async function getMessage(id) {
    const m = await api('GET', gmail(`/messages/${encodeURIComponent(id)}`), { query: { format: 'full' } });
    const h = m.payload?.headers || [];
    const { text, attachments } = extractBody(m.payload);
    return { id: m.id, thread_id: m.threadId, from: header(h, 'From'), to: header(h, 'To'), cc: header(h, 'Cc'), subject: header(h, 'Subject'),
      date: header(h, 'Date'), message_id_header: header(h, 'Message-ID') || header(h, 'Message-Id'), references: header(h, 'References'), text, attachments, labels: m.labelIds || [] };
  }

  async function replyContext(replyToMessageId) {
    if (!replyToMessageId) return {};
    const orig = await getMessage(replyToMessageId);
    return { threadId: orig.thread_id, inReplyTo: orig.message_id_header || null, references: orig.references || null, original: orig };
  }

  async function createDraft({ to, cc, subject, body, reply_to_message_id }) {
    const rc = await replyContext(reply_to_message_id);
    const raw = Buffer.from(buildMime({ to, cc, subject, body, inReplyTo: rc.inReplyTo, references: rc.references })).toString('base64url');
    const d = await api('POST', gmail('/drafts'), { body: { message: { raw, ...(rc.threadId ? { threadId: rc.threadId } : {}) } } });
    return { draft_id: d.id, message_id: d.message?.id, thread_id: d.message?.threadId || rc.threadId || null };
  }

  async function sendMessage({ to, cc, subject, body, reply_to_message_id }) {
    const rc = await replyContext(reply_to_message_id);
    const raw = Buffer.from(buildMime({ to, cc, subject, body, inReplyTo: rc.inReplyTo, references: rc.references })).toString('base64url');
    const sent = await api('POST', gmail('/messages/send'), { body: { raw, ...(rc.threadId ? { threadId: rc.threadId } : {}) } });
    if (!sent.id) throw new Error('Gmail did not confirm the message was sent');
    return { message_id: sent.id, thread_id: sent.threadId, labels: sent.labelIds || [] };
  }

  async function listEvents({ time_min, time_max, calendar_id = 'primary', q } = {}) {
    const items = [];
    let pageToken;
    do {
      const r = await api('GET', calendar(`/calendars/${encodeURIComponent(calendar_id)}/events`), {
        query: { timeMin: time_min, timeMax: time_max, singleEvents: 'true', orderBy: 'startTime', maxResults: 250, q, pageToken },
      });
      items.push(...(r.items || []));
      pageToken = r.nextPageToken;
    } while (pageToken && items.length < 1000);
    return items.map(normalizeEvent);
  }

  async function getEvent(id, calendar_id = 'primary') {
    return normalizeEvent(await api('GET', calendar(`/calendars/${encodeURIComponent(calendar_id)}/events/${encodeURIComponent(id)}`)));
  }

  function eventBody({ summary, start, end, location, description, attendees, all_day }) {
    const body = {};
    if (summary !== undefined) body.summary = summary;
    if (location !== undefined) body.location = location;
    if (description !== undefined) body.description = description;
    const tz = app.settings.timezone();
    if (start !== undefined) body.start = all_day ? { date: String(start).slice(0, 10) } : { dateTime: start, timeZone: tz };
    if (end !== undefined) body.end = all_day ? { date: String(end).slice(0, 10) } : { dateTime: end, timeZone: tz };
    if (attendees !== undefined) body.attendees = cleanAddressList(attendees).map((email) => ({ email }));
    return body;
  }

  async function insertEvent(input, calendar_id = 'primary') {
    const e = await api('POST', calendar(`/calendars/${encodeURIComponent(calendar_id)}/events`), { body: eventBody(input), query: { sendUpdates: input.attendees?.length ? 'all' : 'none' } });
    return normalizeEvent(e);
  }

  async function patchEvent(id, changes, calendar_id = 'primary') {
    const e = await api('PATCH', calendar(`/calendars/${encodeURIComponent(calendar_id)}/events/${encodeURIComponent(id)}`), { body: eventBody(changes), query: { sendUpdates: 'all' } });
    return normalizeEvent(e);
  }

  async function deleteEvent(id, calendar_id = 'primary') {
    await api('DELETE', calendar(`/calendars/${encodeURIComponent(calendar_id)}/events/${encodeURIComponent(id)}`), { query: { sendUpdates: 'all' } });
    return { deleted: true, id };
  }

  return { configured, status, startAuth, handleCallback, disconnect, accessToken, notConnected, searchMessages, getMessage, createDraft, sendMessage, listEvents, getEvent, insertEvent, patchEvent, deleteEvent };
}
