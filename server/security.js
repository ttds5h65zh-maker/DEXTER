// Request guards: Host allow-list (blocks DNS rebinding), same-origin + custom
// header on state-changing requests (blocks cross-site requests), optional
// password login, and security headers.
import { newId } from './lib/ids.js';
import { now } from './db.js';
import { timingSafeEqualStr } from './lib/crypto.js';
import { HttpError } from './lib/http.js';

const SESSION_COOKIE = 'dexter_session';
const SESSION_DAYS = 30;

export function securityHeaders(res, { api = false } = {}) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'SAMEORIGIN');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  if (!api) {
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'");
  }
}

export function createGuards(app) {
  const { config, db } = app;
  const allowed = new Set(['localhost', '127.0.0.1', '[::1]', '::1', ...config.allowedHosts.map((h) => h.toLowerCase())]);
  try { allowed.add(new URL(config.publicUrl).hostname.toLowerCase()); } catch { /* ignore */ }

  function hostOk(req) {
    const host = String(req.headers.host || '').toLowerCase();
    const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
    return allowed.has(name);
  }

  function originOk(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const o = new URL(origin);
      return o.host.toLowerCase() === String(req.headers.host || '').toLowerCase();
    } catch { return false; }
  }

  function cookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }

  function authRequired() { return Boolean(config.password); }

  function authenticated(req) {
    if (!authRequired()) return true;
    const sid = cookies(req)[SESSION_COOKIE];
    if (!sid) return false;
    const s = db.get('SELECT * FROM sessions WHERE id = ?', sid);
    return Boolean(s && s.expires_at > now());
  }

  function login(res, password) {
    if (!authRequired()) return true;
    if (!timingSafeEqualStr(password || '', config.password)) return false;
    const id = newId('sess') + newId('k');
    const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
    db.run('INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)', id, now(), expires);
    const secure = config.publicUrl.startsWith('https://') ? '; Secure' : '';
    res.setHeader('set-cookie', `${SESSION_COOKIE}=${encodeURIComponent(id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
    return true;
  }

  function logout(req, res) {
    const sid = cookies(req)[SESSION_COOKIE];
    if (sid) db.run('DELETE FROM sessions WHERE id = ?', sid);
    res.setHeader('set-cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  }

  /** Throws HttpError if the request must be refused. */
  function check(req, pathname) {
    if (!hostOk(req)) throw new HttpError(421, 'Unrecognised Host header. Add it to DEXTER_ALLOWED_HOSTS if this is intended.', 'bad_host');
    if (!pathname.startsWith('/api/')) return;
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (mutating) {
      if (!originOk(req)) throw new HttpError(403, 'Cross-origin request refused', 'bad_origin');
      if (req.headers['x-dexter'] !== '1') throw new HttpError(403, 'Missing X-Dexter header', 'csrf');
    }
    const open = pathname === '/api/health' || pathname.startsWith('/api/auth/');
    if (!open && !authenticated(req)) throw new HttpError(401, 'Sign in to Dexter first', 'unauthenticated');
  }

  return { check, login, logout, authenticated, authRequired };
}
