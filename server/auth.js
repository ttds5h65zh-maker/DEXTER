import crypto from 'node:crypto';
import { all, get, run, insert } from './db.js';
import { HttpError, bad, nowIso } from './util.js';

const SESSION_DAYS = 14;
const COOKIE = 'dexter_sid';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
export function verifyPassword(password, stored) {
  const [, saltHex, keyHex] = String(stored).split('$');
  if (!saltHex || !keyHex) return false;
  const key = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
}
export function checkPasswordStrength(password) {
  if (typeof password !== 'string' || password.length < 10) throw bad('Password must be at least 10 characters.');
}
const validEmail = (e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

export const publicUser = (u) =>
  !u ? null : { id: u.id, email: u.email, name: u.name, role: u.role, active: !!u.active, prefs: { reminder_offsets: [30, 7, 1], ...JSON.parse(u.prefs || '{}') } };

export function createUser({ email, name, role, password }) {
  email = String(email || '').trim().toLowerCase();
  if (!validEmail(email)) throw bad('Enter a valid email address.');
  if (!name || !String(name).trim()) throw bad('Name is required.');
  if (!['owner', 'accountant'].includes(role)) throw bad('Role must be owner or accountant.');
  checkPasswordStrength(password);
  if (get('SELECT id FROM users WHERE email = ?', email)) throw bad('A user with this email already exists.');
  const id = insert('users', { email, name: String(name).trim(), role, password_hash: hashPassword(password), created_at: nowIso() });
  return get('SELECT * FROM users WHERE id = ?', id);
}

// ---- login throttling (in memory) ----
const failures = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 8;
function throttled(key) {
  const f = failures.get(key);
  if (!f) return false;
  if (Date.now() - f.first > WINDOW_MS) { failures.delete(key); return false; }
  return f.count >= MAX_FAILURES;
}
function noteFailure(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > WINDOW_MS) failures.set(key, { first: Date.now(), count: 1 });
  else f.count++;
}

export function login(email, password, ip) {
  email = String(email || '').trim().toLowerCase();
  const key = `${email}|${ip}`;
  if (throttled(key)) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
  const user = get('SELECT * FROM users WHERE email = ?', email);
  // Always run a hash comparison so timing does not reveal whether the account exists.
  const ok = verifyPassword(String(password || ''), user?.password_hash || hashPasswordDummy) && user && user.active;
  if (!ok) { noteFailure(key); throw new HttpError(401, 'Email or password is incorrect.'); }
  failures.delete(key);
  return { user, token: startSession(user.id) };
}
const hashPasswordDummy = hashPassword(crypto.randomBytes(8).toString('hex'));

export function startSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)', sha(token), userId, nowIso(), expires);
  return token;
}
export const endSession = (token) => token && run('DELETE FROM sessions WHERE token_hash = ?', sha(token));
export const endUserSessions = (userId, exceptToken) =>
  run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', userId, exceptToken ? sha(exceptToken) : '');

function readCookie(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return null;
}
export function setSessionCookie(req, res, token) {
  const secure = process.env.DEXTER_SECURE_COOKIES === '1' || req.secure || req.headers['x-forwarded-proto'] === 'https';
  const attrs = [`${COOKIE}=${token || ''}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', token ? `Max-Age=${SESSION_DAYS * 86400}` : 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

/** Attaches req.user when a valid session cookie is present. */
export function sessionMiddleware(req, _res, next) {
  const token = readCookie(req);
  req.sessionToken = token;
  if (token) {
    const row = get(
      'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1',
      sha(token), nowIso(),
    );
    if (row) req.user = row;
  }
  next();
}
export function requireAuth(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Sign in to continue.'));
  next();
}
export function requireOwner(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Sign in to continue.'));
  if (req.user.role !== 'owner') return next(new HttpError(403, 'Only the workspace owner can do this.'));
  next();
}
/** Blocks cross-site form posts: state-changing requests must carry a custom header only same-origin script can set. */
export function csrfGuard(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers['x-dexter'] !== '1') return next(new HttpError(403, 'Missing request header.'));
  next();
}
export const listUsers = () => all('SELECT * FROM users ORDER BY id').map(publicUser);
export const userCount = () => get('SELECT COUNT(*) n FROM users').n;
