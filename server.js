// Dexter server: a small JSON API plus the static web app. No dependencies.
//   node server.js            → http://127.0.0.1:4173
// Settings (all optional):
//   PORT, HOST                where to listen (default 127.0.0.1:4173, this machine only)
//   DEXTER_DATA_DIR           where dexter.json is kept (default ./data)
//   DEXTER_DEMO=off           start empty instead of seeding the fictional demo
//   ANTHROPIC_API_KEY         switches on AI extraction and drafting (needs `npm install`)
//   DEXTER_MODEL              model for AI extraction (default claude-opus-5-5)
//   DEXTER_AI=off             keep AI off even if a key is present

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Dexter, AppError } from './lib/core.js';
import { loadAI } from './lib/ai.js';
import { extractPdfText, PdfError } from './lib/pdf.js';
import { seedDemo } from './lib/seed.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DEXTER_DATA_DIR || path.join(here, 'data'));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon',
};
const STATIC_ROOTS = { '/shared/': path.join(here, 'shared'), '/samples/': path.join(here, 'samples'), '/': path.join(here, 'public') };

// Reads a request body up to `limit` bytes. A larger body is read to the end and
// thrown away, so the browser receives the "too large" answer instead of a reset.
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = Number(req.headers['content-length'] || 0) > limit;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) tooLarge = true;
      if (!tooLarge) chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) reject(new AppError(413, 'too_large', `That upload is too large (the limit is ${Math.round(limit / 1048576)} MB).`));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req, 5 * 1048576);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new AppError(400, 'bad_json', 'The request could not be read.');
  }
}

// ---------------------------------------------------------------------------
// Who may talk to Dexter
// ---------------------------------------------------------------------------
const ALLOWED_HOSTS = (process.env.DEXTER_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

/**
 * Only answer requests addressed to localhost, an IP address, or a name listed
 * in DEXTER_ALLOWED_HOSTS. This stops a malicious website from pointing its own
 * domain at this computer ("DNS rebinding") and reading your data.
 */
function hostAllowed(hostHeader) {
  if (ALLOWED_HOSTS.includes('*')) return true;
  if (!hostHeader) return false;
  let name;
  try {
    name = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (name === 'localhost' || name.endsWith('.localhost') || ALLOWED_HOSTS.includes(name)) return true;
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(name) || name.startsWith('['); // IP addresses cannot be re-pointed
}

/** Did this request come from Dexter's own page (not from another website)? */
function fromOwnPage(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  const origin = req.headers.origin;
  if (!origin) return true; // not sent by a browser page (curl, tests)
  try {
    const host = new URL(origin).host;
    return host === req.headers.host || host === req.headers['x-forwarded-host'];
  } catch {
    return false;
  }
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'",
};

function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  const prefix = Object.keys(STATIC_ROOTS).find((p) => pathname.startsWith(p));
  const root = STATIC_ROOTS[prefix];
  let rel;
  try {
    rel = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    rel = '\0';
  }
  const file = path.normalize(path.join(root, rel));
  if (rel.includes('\0') || !file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

async function main() {
  const ai = await loadAI();
  const dexter = new Dexter({ dataDir: DATA_DIR, ai });
  if (dexter.isNew) {
    if (process.env.DEXTER_DEMO !== 'off') await seedDemo(dexter);
    dexter.save();
  }

  // method + path pattern → handler(params, req, url). Handlers return extra fields for the response.
  const routes = [
    ['GET', '/api/state', () => ({})],
    ['POST', '/api/sources', async (p, req) => ({ sourceId: (await dexter.importSource(await readJson(req))).id })],
    ['POST', '/api/sources/pdf', async (p, req, url) => {
      const buf = await readBody(req, 25 * 1048576);
      let parsed;
      try {
        parsed = extractPdfText(buf);
      } catch (err) {
        if (err instanceof PdfError) throw new AppError(422, 'pdf_' + err.code, err.message);
        throw new AppError(422, 'pdf_unreadable', 'Dexter could not read this PDF. Paste its text instead.');
      }
      const source = await dexter.importSource({
        kind: 'pdf',
        text: parsed.text,
        pages: parsed.pages,
        filename: (url.searchParams.get('filename') || 'document.pdf').slice(0, 200),
        title: url.searchParams.get('title') || parsed.title || '',
        sourceDate: url.searchParams.get('sourceDate') || '',
        useAI: url.searchParams.get('useAI') !== 'false',
      });
      return { sourceId: source.id };
    }],
    ['POST', '/api/sources/:id/reextract', async (p) => ({ added: await dexter.reextract(p.id) })],
    ['POST', '/api/sources/:id/findings', async (p, req) => ({ findingId: dexter.manualFinding(p.id, await readJson(req)).id })],
    ['DELETE', '/api/sources/:id', (p) => { dexter.deleteSource(p.id); return {}; }],
    ['PATCH', '/api/findings/:id', async (p, req) => { dexter.updateFinding(p.id, await readJson(req)); return {}; }],
    ['POST', '/api/findings/:id/task', async (p, req) => ({ taskId: dexter.taskFromFinding(p.id, await readJson(req)).id })],
    ['POST', '/api/drafts', async (p, req) => ({ draftId: (await dexter.createDraft(await readJson(req))).id })],
    ['PATCH', '/api/drafts/:id', async (p, req) => { dexter.updateDraft(p.id, await readJson(req)); return {}; }],
    ['POST', '/api/drafts/:id/approve', (p) => { dexter.approveDraft(p.id); return {}; }],
    ['POST', '/api/drafts/:id/complete', (p) => { dexter.completeDraft(p.id); return {}; }],
    ['DELETE', '/api/drafts/:id', (p) => { dexter.deleteDraft(p.id); return {}; }],
    ['POST', '/api/tasks', async (p, req) => ({ taskId: dexter.createTask(await readJson(req)).id })],
    ['PATCH', '/api/tasks/:id', async (p, req) => { dexter.updateTask(p.id, await readJson(req)); return {}; }],
    ['DELETE', '/api/tasks/:id', (p) => { dexter.deleteTask(p.id); return {}; }],
    ['POST', '/api/demo/remove', () => { dexter.removeDemo(); return {}; }],
    ['POST', '/api/demo/restore', async () => { dexter.removeDemo(); await seedDemo(dexter); return {}; }],
  ].map(([method, pattern, handler]) => ({
    method,
    handler,
    re: new RegExp('^' + pattern.replace(/:[a-z]+/g, '([^/]+)') + '$'),
    keys: (pattern.match(/:[a-z]+/g) || []).map((k) => k.slice(1)),
  }));

  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (!hostAllowed(req.headers.host)) {
      console.warn(`Refused a request addressed to "${req.headers.host}". Add it to DEXTER_ALLOWED_HOSTS to allow it.`);
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Dexter only answers on localhost or an IP address. To reach it by another name, start it with DEXTER_ALLOWED_HOSTS set to that name.');
    }
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new AppError(405, 'method', 'Method not allowed.');
        return serveStatic(req, res, url.pathname);
      }
      // Requests that change data must come from Dexter's own page.
      if (req.method !== 'GET' && !fromOwnPage(req)) throw new AppError(403, 'cross_site', 'Cross-site requests are not allowed.');
      const ics = /^\/api\/drafts\/([^/]+)\/event\.ics$/.exec(url.pathname);
      if (req.method === 'GET' && ics) {
        const body = dexter.ics(ics[1]);
        res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'attachment; filename="dexter-event.ics"' });
        return res.end(body);
      }
      if (req.method === 'GET' && url.pathname === '/api/export') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="dexter-export.json"' });
        return res.end(JSON.stringify(dexter.state, null, 2));
      }
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const m = route.re.exec(url.pathname);
        if (!m) continue;
        const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const extra = await route.handler(params, req, url);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ ...extra, state: dexter.snapshot() }));
      }
      throw new AppError(404, 'not_found', 'Not found.');
    } catch (err) {
      const status = err instanceof AppError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: err.code || 'server_error', message: err instanceof AppError ? err.message : 'Something went wrong inside Dexter. Check the server log.' } }));
    }
  });

  server.listen(PORT, HOST, () => {
    const aiLine = ai.available
      ? `AI extraction: on (${ai.model})`
      : ai.reason === 'no_sdk'
        ? 'AI extraction: off — a key is set but the SDK is missing. Run `npm install`.'
        : ai.reason === 'disabled'
          ? 'AI extraction: off (DEXTER_AI=off)'
          : 'AI extraction: off — set ANTHROPIC_API_KEY to switch it on. Manual review and built-in rules are active.';
    const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST.includes(':') ? `[${HOST}]` : HOST;
    console.log(`Dexter is running at http://${shown}:${PORT}\nData file: ${dexter.file}\n${aiLine}`);
    if (!['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
      console.log(`Note: HOST=${HOST} lets other devices on your network open Dexter (for example a tablet, using this computer's IP address). Dexter has no login, so only do this on a network you trust.`);
    }
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Dexter may already be running — open http://localhost:${PORT} — or start it on another port, for example: PORT=4180 npm start`);
    else console.error(err);
    process.exit(1);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
