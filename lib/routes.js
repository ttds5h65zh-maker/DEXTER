// Dexter's API, as one route table shared by the local server (HTTP) and the
// hosted page (called in the browser). Each handler gets the path parameters
// and a request object { json(), bytes(), query } and returns extra fields for
// the response; the caller adds the current state.

import { AppError } from './core.js';
import { PdfError } from '../shared/pdf.js';
import { seedDemo } from './seed.js';

/**
 * @param dexter   the Dexter core
 * @param readPdf  (bytes) => Promise<{ text, pages, title }>
 */
export function createRoutes(dexter, { readPdf }) {
  const table = [
    ['GET', '/api/state', () => ({})],
    ['POST', '/api/sources', async (p, req) => ({ sourceId: (await dexter.importSource(await req.json())).id })],
    ['POST', '/api/sources/pdf', async (p, req) => {
      let parsed;
      try {
        parsed = await readPdf(await req.bytes());
      } catch (err) {
        if (err instanceof PdfError) throw new AppError(422, 'pdf_' + err.code, err.message);
        if (err instanceof AppError) throw err;
        throw new AppError(422, 'pdf_unreadable', 'Dexter could not read this PDF. Paste its text instead.');
      }
      const q = req.query;
      const source = await dexter.importSource({
        kind: 'pdf',
        text: parsed.text,
        pages: parsed.pages,
        filename: (q.get('filename') || 'document.pdf').slice(0, 200),
        title: q.get('title') || parsed.title || '',
        sourceDate: q.get('sourceDate') || '',
        useAI: q.get('useAI') !== 'false',
      });
      return { sourceId: source.id };
    }],
    ['POST', '/api/sources/:id/reextract', async (p) => ({ added: await dexter.reextract(p.id) })],
    ['POST', '/api/sources/:id/findings', async (p, req) => ({ findingId: dexter.manualFinding(p.id, await req.json()).id })],
    ['DELETE', '/api/sources/:id', (p) => { dexter.deleteSource(p.id); return {}; }],
    ['PATCH', '/api/findings/:id', async (p, req) => { dexter.updateFinding(p.id, await req.json()); return {}; }],
    ['POST', '/api/findings/:id/task', async (p, req) => ({ taskId: dexter.taskFromFinding(p.id, await req.json()).id })],
    ['POST', '/api/drafts', async (p, req) => ({ draftId: (await dexter.createDraft(await req.json())).id })],
    ['PATCH', '/api/drafts/:id', async (p, req) => { dexter.updateDraft(p.id, await req.json()); return {}; }],
    ['POST', '/api/drafts/:id/approve', (p) => { dexter.approveDraft(p.id); return {}; }],
    ['POST', '/api/drafts/:id/complete', (p) => { dexter.completeDraft(p.id); return {}; }],
    ['GET', '/api/drafts/:id/ics', (p) => ({ ics: dexter.ics(p.id) })],
    ['DELETE', '/api/drafts/:id', (p) => { dexter.deleteDraft(p.id); return {}; }],
    ['POST', '/api/tasks', async (p, req) => ({ taskId: dexter.createTask(await req.json()).id })],
    ['PATCH', '/api/tasks/:id', async (p, req) => { dexter.updateTask(p.id, await req.json()); return {}; }],
    ['DELETE', '/api/tasks/:id', (p) => { dexter.deleteTask(p.id); return {}; }],
    ['POST', '/api/demo/remove', () => { dexter.removeDemo(); return {}; }],
    ['POST', '/api/demo/restore', async () => { dexter.removeDemo(); await seedDemo(dexter); dexter.save(); return {}; }],
  ];
  return table.map(([method, pattern, handler]) => ({
    method,
    handler,
    re: new RegExp('^' + pattern.replace(/:[a-z]+/g, '([^/]+)') + '$'),
    keys: (pattern.match(/:[a-z]+/g) || []).map((k) => k.slice(1)),
  }));
}

/** Find the route for a request: { route, params } or null. */
export function matchRoute(routes, method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = route.re.exec(pathname);
    if (m) return { route, params: Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}
