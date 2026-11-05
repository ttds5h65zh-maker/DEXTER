// HTTP API. Handlers are thin: they validate input and call services.
import { readJson, readBody, sendJson, badRequest, notFound, conflict, HttpError } from '../lib/http.js';
import { parseJson } from '../db.js';
import { MODEL_OPTIONS } from '../services/settings.js';
import { startOfZonedDay, addZonedDays, formatLongNow, zonedParts } from '../lib/time.js';
import { findConflicts } from '../integrations/google.js';
import { sanitizeName } from '../services/files.js';

const json = (res, body, status = 200) => sendJson(res, status, body);

function contentDisposition(type, name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function registerRoutes(router, app, guards) {
  const { db } = app;
  const tz = () => app.settings.timezone();

  // ---------------------------------------------------------------- core --
  router.get('/api/health', (req, res) => json(res, { ok: true, scheduler: app.scheduler.health(), time: new Date().toISOString() }));

  router.get('/api/auth/status', (req, res) => json(res, { required: guards.authRequired(), authenticated: guards.authenticated(req) }));
  router.post('/api/auth/login', async (req, res) => {
    const { password } = await readJson(req);
    if (!guards.login(res, password)) throw new HttpError(401, 'Wrong password', 'bad_password');
    json(res, { ok: true });
  });
  router.post('/api/auth/logout', (req, res) => { guards.logout(req, res); json(res, { ok: true }); });

  router.get('/api/events', (req, res) => app.bus.attach(req, res));

  router.get('/api/bootstrap', (req, res) => {
    json(res, {
      profile: app.settings.get('profile'),
      settings: app.settings.getAll(),
      model_options: MODEL_OPTIONS,
      integrations: app.integrations.status(),
      counts: counts(),
      event_seq: app.bus.seq,
    });
  });

  function counts() {
    return {
      approvals: app.approvals.pendingCount(),
      handoffs: db.get("SELECT COUNT(*) AS n FROM handoffs WHERE status = 'waiting'").n,
      notifications_unread: app.notifications.unreadCount(),
      attention_tasks: db.get("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('blocked','awaiting_approval')").n,
      running: db.get("SELECT COUNT(*) AS n FROM runs WHERE status = 'running'").n,
    };
  }
  router.get('/api/counts', (req, res) => json(res, counts()));

  // ------------------------------------------------------- conversations --
  router.get('/api/conversations', (req, res, { query }) => json(res, { conversations: app.conversations.list({ q: query.get('q'), project_id: query.get('project_id'), include_archived: query.get('archived') === '1' }) }));
  router.post('/api/conversations', async (req, res) => {
    const body = await readJson(req);
    json(res, { conversation: app.conversations.create({ title: body.title, project_id: body.project_id || null }) }, 201);
  });
  router.get('/api/conversations/:id', (req, res, { params }) => json(res, app.conversations.view(params.id)));
  router.patch('/api/conversations/:id', async (req, res, { params }) => json(res, { conversation: app.conversations.update(params.id, await readJson(req)) }));
  router.delete('/api/conversations/:id', (req, res, { params }) => {
    if (db.get("SELECT id FROM runs WHERE conversation_id = ? AND status = 'running'", params.id)) throw conflict('Stop the running work before deleting this conversation');
    app.conversations.remove(params.id);
    json(res, { ok: true });
  });
  router.post('/api/conversations/:id/messages', async (req, res, { params }) => {
    const body = await readJson(req, 2 * 1024 * 1024);
    const fileIds = Array.isArray(body.file_ids) ? body.file_ids.filter((x) => typeof x === 'string') : [];
    json(res, await app.agent.sendMessage(params.id, { text: body.text, file_ids: fileIds }), 202);
  });

  router.post('/api/runs/:id/cancel', (req, res, { params }) => json(res, { run: app.agent.cancel(params.id) }));
  router.post('/api/runs/:id/retry', async (req, res, { params }) => json(res, { run: await app.agent.retry(params.id) }, 202));

  // ---------------------------------------------------------------- tasks --
  router.get('/api/tasks', (req, res, { query }) => json(res, { tasks: app.tasks.list({ status: query.get('status'), project_id: query.get('project_id'), q: query.get('q'), include_done: query.get('open') !== '1' }) }));
  router.post('/api/tasks', async (req, res) => json(res, { task: app.tasks.create(await readJson(req), { actor: 'user' }) }, 201));
  router.get('/api/tasks/:id', (req, res, { params }) => json(res, app.tasks.detail(params.id)));
  router.patch('/api/tasks/:id', async (req, res, { params }) => {
    const body = await readJson(req);
    const { note, ...patch } = body;
    json(res, { task: app.tasks.update(params.id, patch, { actor: 'user', note }) });
  });
  router.delete('/api/tasks/:id', (req, res, { params }) => { app.tasks.remove(params.id); json(res, { ok: true }); });
  router.post('/api/tasks/:id/resume', async (req, res, { params }) => json(res, { run: await app.agent.resumeTask(params.id) }, 202));

  // --------------------------------------------------------------- memory --
  router.get('/api/memories', (req, res, { query }) => json(res, { memories: app.memory.list({ q: query.get('q'), kind: query.get('kind') }) }));
  router.post('/api/memories', async (req, res) => {
    const b = await readJson(req);
    json(res, { memory: app.memory.create({ content: b.content, kind: b.kind || 'fact', pinned: b.pinned, source_type: 'manual', source_label: 'Added by you' }) }, 201);
  });
  router.patch('/api/memories/:id', async (req, res, { params }) => json(res, { memory: app.memory.update(params.id, await readJson(req), { source_type: 'manual', source_label: 'Edited by you' }) }));
  router.delete('/api/memories/:id', (req, res, { params }) => { app.memory.remove(params.id); json(res, { ok: true }); });

  // ---------------------------------------------------------------- files --
  router.get('/api/files', (req, res, { query }) => json(res, { files: app.files.list({ project_id: query.get('project_id'), conversation_id: query.get('conversation_id'), folder: query.get('folder'), q: query.get('q') }), folders: app.files.folders() }));
  router.post('/api/files', async (req, res, { query }) => {
    const name = sanitizeName(query.get('name') || req.headers['x-filename'] || 'upload');
    const buffer = await readBody(req, app.config.maxUploadBytes + 1024);
    const file = app.files.save({ name, mime: req.headers['content-type'], buffer, folder: query.get('folder') || '', project_id: query.get('project_id') || null, conversation_id: query.get('conversation_id') || null });
    json(res, { file }, 201);
  });
  router.get('/api/files/:id', (req, res, { params }) => json(res, { file: app.files.mustGet(params.id) }));
  router.patch('/api/files/:id', async (req, res, { params }) => json(res, { file: app.files.update(params.id, await readJson(req)) }));
  router.delete('/api/files/:id', (req, res, { params }) => { app.files.remove(params.id); json(res, { ok: true }); });
  router.get('/api/files/:id/download', (req, res, { params }) => {
    const f = app.files.mustGet(params.id);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': contentDisposition('attachment', f.name), 'content-length': f.size, 'cache-control': 'no-store' });
    res.end(app.files.readBuffer(f));
  });
  router.get('/api/files/:id/preview', (req, res, { params }) => {
    const f = app.files.mustGet(params.id);
    const kind = app.files.previewKind(f.mime);
    if (kind === 'image' || kind === 'pdf') {
      res.writeHead(200, { 'content-type': f.mime, 'content-disposition': contentDisposition('inline', f.name), 'cache-control': 'private, max-age=60', 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" });
      res.end(app.files.readBuffer(f));
      return;
    }
    if (kind === 'text' || kind === 'docx') {
      let text;
      try { text = app.files.extractText(f); } catch (err) { throw badRequest(`Could not read this file: ${err.message}`); }
      json(res, { kind, text: text.length > 400000 ? `${text.slice(0, 400000)}\n…[truncated]` : text, mime: f.mime });
      return;
    }
    throw badRequest('No preview for this file type — download it instead');
  });

  // ------------------------------------------------------------ documents --
  router.get('/api/documents', (req, res, { query }) => json(res, { documents: app.documents.list({ project_id: query.get('project_id') }) }));
  router.post('/api/documents', async (req, res) => json(res, { document: app.documents.create(await readJson(req), { author: 'user' }) }, 201));
  router.get('/api/documents/:id', (req, res, { params }) => json(res, { document: app.documents.mustGet(params.id), versions: app.documents.versions(params.id) }));
  router.put('/api/documents/:id', async (req, res, { params }) => {
    const b = await readJson(req, 4 * 1024 * 1024);
    json(res, { document: app.documents.update(params.id, { content: b.content, title: b.title, expected_version: b.expected_version }, { author: 'user', note: b.note || 'Edited by you' }) });
  });
  router.delete('/api/documents/:id', (req, res, { params }) => { app.documents.remove(params.id); json(res, { ok: true }); });
  router.post('/api/documents/:id/lock', async (req, res, { params }) => json(res, { document: app.documents.lock(params.id, (await readJson(req)).text) }));
  router.post('/api/documents/:id/unlock', async (req, res, { params }) => json(res, { document: app.documents.unlock(params.id, (await readJson(req)).lock_id) }));
  router.post('/api/documents/:id/export', async (req, res, { params }) => json(res, { file: app.documents.export(params.id, (await readJson(req)).format || 'docx') }, 201));
  router.get('/api/documents/:id/versions/:version', (req, res, { params }) => json(res, { version: app.documents.version(params.id, Number(params.version)) }));

  // ------------------------------------------------------------- projects --
  router.get('/api/projects', (req, res, { query }) => json(res, { projects: app.projects.list({ include_archived: query.get('archived') === '1' }) }));
  router.post('/api/projects', async (req, res) => json(res, { project: app.projects.create(await readJson(req)) }, 201));
  router.get('/api/projects/:id', (req, res, { params }) => json(res, app.projects.detail(params.id)));
  router.patch('/api/projects/:id', async (req, res, { params }) => json(res, { project: app.projects.update(params.id, await readJson(req)) }));
  router.delete('/api/projects/:id', (req, res, { params }) => { app.projects.remove(params.id); json(res, { ok: true }); });
  router.post('/api/projects/:id/grades', async (req, res, { params }) => json(res, { grade_item: app.projects.addGradeItem(params.id, await readJson(req)) }, 201));
  router.patch('/api/grades/:id', async (req, res, { params }) => json(res, { grade_item: app.projects.updateGradeItem(params.id, await readJson(req)) }));
  router.delete('/api/grades/:id', (req, res, { params }) => { app.projects.removeGradeItem(params.id); json(res, { ok: true }); });

  // ------------------------------------------------------------ approvals --
  router.get('/api/approvals', (req, res, { query }) => json(res, { approvals: app.approvals.list({ status: query.get('status') }) }));
  router.get('/api/approvals/:id', (req, res, { params }) => json(res, { approval: app.approvals.mustGet(params.id) }));
  router.post('/api/approvals/:id/approve', async (req, res, { params }) => {
    const b = await readJson(req);
    json(res, { approval: app.approvals.decide(params.id, 'approve', { always_allow: Boolean(b.always_allow), note: b.note || null }) });
  });
  router.post('/api/approvals/:id/reject', async (req, res, { params }) => {
    const b = await readJson(req);
    json(res, { approval: app.approvals.decide(params.id, 'reject', { note: b.note || null }) });
  });
  router.get('/api/grants', (req, res) => json(res, { grants: app.approvals.listGrants() }));
  router.delete('/api/grants/:id', (req, res, { params }) => { app.approvals.revokeGrant(params.id); json(res, { ok: true }); });
  router.get('/api/handoffs', (req, res) => json(res, { handoffs: app.approvals.listHandoffs() }));
  router.post('/api/handoffs/:id/resolve', (req, res, { params }) => json(res, { handoff: app.approvals.resolveHandoff(params.id, 'resolved') }));
  router.post('/api/handoffs/:id/cancel', (req, res, { params }) => json(res, { handoff: app.approvals.resolveHandoff(params.id, 'cancelled') }));

  // ----------------------------------------------------------------- jobs --
  router.get('/api/jobs', (req, res, { query }) => json(res, { jobs: app.jobs.list({ kind: query.get('kind'), status: query.get('status') }) }));
  router.post('/api/jobs', async (req, res) => {
    const b = await readJson(req);
    json(res, { job: app.jobs.create({ name: b.name, kind: b.kind, schedule: b.schedule, payload: b.payload || {}, task_id: b.task_id || null }, { actor: 'user' }) }, 201);
  });
  router.get('/api/jobs/:id', (req, res, { params }) => json(res, app.jobs.detail(params.id)));
  router.patch('/api/jobs/:id', async (req, res, { params }) => json(res, { job: app.jobs.update(params.id, await readJson(req)) }));
  router.post('/api/jobs/:id/cancel', (req, res, { params }) => json(res, { job: app.jobs.cancel(params.id) }));
  router.post('/api/jobs/:id/pause', (req, res, { params }) => json(res, { job: app.jobs.pause(params.id) }));
  router.post('/api/jobs/:id/resume', (req, res, { params }) => json(res, { job: app.jobs.resume(params.id) }));
  router.post('/api/jobs/:id/run', (req, res, { params }) => json(res, { run: app.jobs.runNow(params.id) }, 202));
  router.post('/api/briefing/preview', async (req, res) => json(res, await app.runners.compileBriefing({ useModel: false })));

  // -------------------------------------------------------- notifications --
  router.get('/api/notifications', (req, res, { query }) => json(res, { notifications: app.notifications.list({ unread_only: query.get('unread') === '1' }), unread: app.notifications.unreadCount() }));
  router.post('/api/notifications/read-all', (req, res) => { app.notifications.markAllRead(); json(res, { ok: true }); });
  router.post('/api/notifications/:id/read', (req, res, { params }) => { app.notifications.markRead(params.id); json(res, { ok: true }); });

  // ------------------------------------------------------------- settings --
  router.get('/api/settings', (req, res) => json(res, { settings: app.settings.getAll(), model_options: MODEL_OPTIONS }));
  router.patch('/api/settings', async (req, res) => json(res, { settings: app.settings.update(await readJson(req)) }));

  // --------------------------------------------------------- integrations --
  router.get('/api/integrations', (req, res) => json(res, app.integrations.status()));
  router.post('/api/integrations/anthropic/test', async (req, res) => json(res, await app.model.testConnection(app.settings.get('model').id)));
  router.get('/api/integrations/google/connect', (req, res) => {
    const url = app.google.startAuth();
    res.writeHead(302, { location: url, 'cache-control': 'no-store' });
    res.end();
  });
  router.get('/api/integrations/google/callback', async (req, res, { query }) => {
    try {
      await app.google.handleCallback({ code: query.get('code'), state: query.get('state'), error: query.get('error') });
      res.writeHead(302, { location: '/#/settings/integrations?google=connected' });
    } catch (err) {
      res.writeHead(302, { location: `/#/settings/integrations?google_error=${encodeURIComponent(err.message)}` });
    }
    res.end();
  });
  router.post('/api/integrations/google/disconnect', async (req, res) => json(res, await app.google.disconnect()));
  router.post('/api/integrations/push/test', async (req, res) => {
    const url = app.settings.get('notifications').ntfy_url;
    if (!url) throw badRequest('Set a push URL first');
    json(res, { result: await app.notifications.sendPush(url, 'Dexter test', 'Push notifications from Dexter are working.') });
  });
  router.post('/api/integrations/browser/close', async (req, res) => { await app.browser.close(); json(res, app.browser.status()); });

  // ---------------------------------------------------------------- today --
  router.get('/api/today', async (req, res) => {
    const zone = tz();
    const nowDate = new Date();
    const dayStart = startOfZonedDay(nowDate, zone);
    const tomorrow = addZonedDays(dayStart, 1, zone);
    const weekEnd = addZonedDays(dayStart, 8, zone);
    const open = app.tasks.list({ include_done: false, limit: 300 });
    const hour = zonedParts(nowDate, zone).hour;
    const out = {
      now: nowDate.toISOString(), timezone: zone, date_label: formatLongNow(nowDate, zone),
      greeting: hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening',
      name: app.settings.get('profile').name,
      attention: {
        approvals: app.approvals.list({ status: 'pending' }),
        handoffs: app.approvals.listHandoffs(),
        blocked_tasks: open.filter((t) => t.status === 'blocked'),
        failed_jobs: app.jobs.list().filter((j) => j.last_status === 'failed' && j.status !== 'cancelled').slice(0, 10),
        interrupted_runs: db.all(`SELECT r.id, r.conversation_id, r.status, r.error, r.finished_at, c.title FROM runs r JOIN conversations c ON c.id = r.conversation_id
          WHERE r.status IN ('interrupted','failed') AND r.finished_at >= ? AND NOT EXISTS (SELECT 1 FROM runs r2 WHERE r2.conversation_id = r.conversation_id AND r2.started_at > r.started_at)
          ORDER BY r.finished_at DESC LIMIT 5`, addZonedDays(dayStart, -7, zone).toISOString()),
      },
      due: {
        overdue: open.filter((t) => t.due_at && new Date(t.due_at) < nowDate),
        today: open.filter((t) => t.due_at && new Date(t.due_at) >= nowDate && new Date(t.due_at) < tomorrow),
        upcoming: open.filter((t) => t.due_at && new Date(t.due_at) >= tomorrow && new Date(t.due_at) < weekEnd),
      },
      grade_due: db.all(`SELECT g.id, g.name, g.due_at, g.weight, p.id AS project_id, p.code, p.name AS course FROM grade_items g JOIN projects p ON p.id = g.project_id
        WHERE g.due_at >= ? AND g.due_at < ? AND g.score IS NULL ORDER BY g.due_at`, dayStart.toISOString(), weekEnd.toISOString()),
      in_progress: {
        running_tasks: open.filter((t) => t.status === 'running'),
        active_runs: db.all(`SELECT r.id, r.conversation_id, r.status, r.trigger, r.started_at, c.title FROM runs r JOIN conversations c ON c.id = r.conversation_id WHERE r.status IN ('running','awaiting_approval','blocked') ORDER BY r.started_at DESC`),
      },
      schedule: {
        upcoming: app.jobs.list({ status: 'active' }).filter((j) => j.next_run_at && new Date(j.next_run_at) < tomorrow).slice(0, 20),
        recent_runs: db.all(`SELECT jr.id, jr.job_id, jr.status, jr.scheduled_for, jr.finished_at, jr.error, j.name, j.kind FROM job_runs jr JOIN jobs j ON j.id = jr.job_id
          WHERE jr.scheduled_for >= ? ORDER BY jr.scheduled_for DESC LIMIT 15`, dayStart.toISOString()),
      },
      latest_briefing: db.get("SELECT id, title, body, created_at FROM notifications WHERE level = 'briefing' ORDER BY created_at DESC LIMIT 1"),
      calendar: { status: 'not_connected', events: [], conflicts: 0 },
    };
    const g = app.google.status();
    if (!g.configured) out.calendar.status = 'not_configured';
    else if (g.connected && app.settings.get('permissions').read_calendar) {
      try {
        const events = await app.google.listEvents({ time_min: dayStart.toISOString(), time_max: tomorrow.toISOString() });
        out.calendar = { status: 'connected', events, conflicts: findConflicts(events).length };
      } catch (err) {
        out.calendar = { status: 'error', events: [], conflicts: 0, error: err.message };
      }
    } else if (g.connected) out.calendar.status = 'permission_off';
    json(res, out);
  });

  router.get('/api/search', (req, res, { query }) => {
    const q = String(query.get('q') || '').trim();
    if (!q) return json(res, { results: [] });
    const like = `%${q}%`;
    json(res, {
      tasks: db.all('SELECT id, title, status FROM tasks WHERE title LIKE ? OR description LIKE ? ORDER BY updated_at DESC LIMIT 8', like, like),
      conversations: db.all('SELECT id, title FROM conversations WHERE title LIKE ? ORDER BY updated_at DESC LIMIT 8', like),
      memories: app.memory.search(q, { limit: 8 }),
      files: db.all('SELECT id, name, mime FROM files WHERE name LIKE ? ORDER BY created_at DESC LIMIT 8', like),
      documents: db.all('SELECT id, title FROM documents WHERE title LIKE ? OR content LIKE ? ORDER BY updated_at DESC LIMIT 8', like, like),
    });
  });

  router.get('/api/runs/:id', (req, res, { params }) => {
    const r = app.agent.getRun(params.id);
    if (!r) throw notFound('Run');
    json(res, { run: r });
  });

  return { parseJson };
}
