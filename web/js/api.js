// API client. Every state-changing request carries the X-Dexter header the
// server requires (a cross-site page cannot set it).
export class ApiError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request(method, path, body, { raw = false, headers = {} } = {}) {
  const opts = { method, headers: { 'x-dexter': '1', ...headers }, credentials: 'same-origin' };
  if (body !== undefined && !(body instanceof Blob)) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (body instanceof Blob) {
    opts.body = body;
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new ApiError('Dexter Almana’s server is not reachable. Is it still running?', 0, 'offline');
  }
  if (raw) return res;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const e = data?.error || {};
    const err = new ApiError(e.message || `Request failed (${res.status})`, res.status, e.code, e.details);
    if (res.status === 401 && e.code === 'unauthenticated') window.dispatchEvent(new CustomEvent('dexter:unauthenticated'));
    throw err;
  }
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  patch: (p, b = {}) => request('PATCH', p, b),
  put: (p, b = {}) => request('PUT', p, b),
  del: (p) => request('DELETE', p),
  upload(file, { folder = '', project_id = '', conversation_id = '' } = {}) {
    const q = new URLSearchParams({ name: file.name });
    if (folder) q.set('folder', folder);
    if (project_id) q.set('project_id', project_id);
    if (conversation_id) q.set('conversation_id', conversation_id);
    return request('POST', `/api/files?${q}`, file, { headers: { 'content-type': file.type || 'application/octet-stream' } });
  },
};
