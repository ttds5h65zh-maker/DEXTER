// Tiny HTTP toolkit: router with :params, body readers and JSON responses.
export class HttpError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.status = status;
    this.code = code || (status === 404 ? 'not_found' : status === 400 ? 'bad_request' : 'error');
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, msg, 'bad_request', details);
export const notFound = (what = 'Resource') => new HttpError(404, `${what} not found`, 'not_found');
export const conflict = (msg, code = 'conflict') => new HttpError(409, msg, code);

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handler });
  }

  get(p, h) { this.add('GET', p, h); }
  post(p, h) { this.add('POST', p, h); }
  patch(p, h) { this.add('PATCH', p, h); }
  put(p, h) { this.add('PUT', p, h); }
  delete(p, h) { this.add('DELETE', p, h); }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = pathname.match(r.re);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { handler: r.handler, params };
      }
    }
    return null;
  }
}

export function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, `Request body too large (limit ${Math.round(limit / 1024 / 1024)} MB)`, 'too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    if (v === null || typeof v !== 'object') throw new Error('not an object');
    return v;
  } catch {
    throw badRequest('Request body must be a JSON object');
  }
}

export function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export function sendError(res, err) {
  const status = err.status || 500;
  sendJson(res, status, { error: { code: err.code || 'internal', message: status >= 500 && !err.expose ? 'Internal error — see server log' : err.message, details: err.details } });
}
