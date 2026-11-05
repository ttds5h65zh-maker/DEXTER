// Notifications: in-app (always) plus optional push via an ntfy-compatible URL.
// A dedupe key guarantees the same event never alerts twice.
import { newId } from '../lib/ids.js';
import { now, parseJson } from '../db.js';
import { zonedParts } from '../lib/time.js';
import { log } from '../lib/log.js';

function inQuietHours(qh, date, tz) {
  if (!qh?.enabled) return false;
  const p = zonedParts(date, tz);
  const mins = p.hour * 60 + p.minute;
  const [sh, sm] = qh.start.split(':').map(Number);
  const [eh, em] = qh.end.split(':').map(Number);
  const s = sh * 60 + sm; const e = eh * 60 + em;
  return s <= e ? mins >= s && mins < e : mins >= s || mins < e;
}

export function createNotificationService(app) {
  const { db, bus } = app;

  const hydrate = (r) => r && ({ ...r, delivery: parseJson(r.delivery, {}) });

  /**
   * Create a notification. Returns { notification, created } — created=false
   * when the dedupe key was already used (nothing is sent again).
   */
  async function notify({ title, body = '', level = 'info', source_type = null, source_id = null, link = null, dedupe_key = null, push = true }) {
    if (dedupe_key) {
      const existing = db.get('SELECT * FROM notifications WHERE dedupe_key = ?', dedupe_key);
      if (existing) return { notification: hydrate(existing), created: false };
    }
    const n = { id: newId('ntf'), title: String(title).slice(0, 200), body: String(body || ''), level, source_type, source_id, link, dedupe_key, created_at: now() };
    try {
      db.run('INSERT INTO notifications (id, title, body, level, source_type, source_id, link, dedupe_key, delivery, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        n.id, n.title, n.body, n.level, n.source_type, n.source_id, n.link, n.dedupe_key, JSON.stringify({ in_app: 'delivered' }), n.created_at);
    } catch (err) {
      if (/UNIQUE/i.test(err.message) && dedupe_key) {
        return { notification: hydrate(db.get('SELECT * FROM notifications WHERE dedupe_key = ?', dedupe_key)), created: false };
      }
      throw err;
    }
    const delivery = { in_app: 'delivered' };
    const prefs = app.settings.get('notifications');
    const tz = app.settings.timezone();
    if (push && prefs.ntfy_url) {
      if (inQuietHours(prefs.quiet_hours, new Date(), tz)) delivery.push = 'held (quiet hours)';
      else delivery.push = await sendPush(prefs.ntfy_url, n.title, n.body);
    }
    db.run('UPDATE notifications SET delivery = ? WHERE id = ?', JSON.stringify(delivery), n.id);
    const out = hydrate(db.get('SELECT * FROM notifications WHERE id = ?', n.id));
    bus.publish('notification.created', { notification: out, desktop: Boolean(prefs.desktop) && !inQuietHours(prefs.quiet_hours, new Date(), tz) });
    return { notification: out, created: true };
  }

  async function sendPush(url, title, body) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Title: title.replace(/[^\x20-\x7e]/g, ' ').slice(0, 120), 'Content-Type': 'text/plain; charset=utf-8' },
        body: body?.slice(0, 3500) || title,
        signal: AbortSignal.timeout(10000),
      });
      return res.ok ? `delivered (HTTP ${res.status})` : `failed (HTTP ${res.status})`;
    } catch (err) {
      log.warn('push notification failed', { error: err.message });
      return `failed (${err.message})`;
    }
  }

  function list({ unread_only = false, limit = 100 } = {}) {
    return db.all(`SELECT * FROM notifications ${unread_only ? 'WHERE read_at IS NULL' : ''} ORDER BY created_at DESC LIMIT ?`, limit).map(hydrate);
  }

  function markRead(id) {
    db.run('UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL', now(), id);
    bus.publish('notification.read', { id });
  }

  function markAllRead() {
    db.run('UPDATE notifications SET read_at = ? WHERE read_at IS NULL', now());
    bus.publish('notification.read', { all: true });
  }

  function unreadCount() {
    return db.get('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL').n;
  }

  return { notify, list, markRead, markAllRead, unreadCount, sendPush };
}
