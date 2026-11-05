// Dexter server entry point.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from './app.js';
import { Router, sendError, HttpError } from './lib/http.js';
import { registerRoutes } from './api/routes.js';
import { createGuards, securityHeaders } from './security.js';
import { log } from './lib/log.js';
import { ROOT_DIR } from './config.js';

const WEB_DIR = path.join(ROOT_DIR, 'web');
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(WEB_DIR, rel));
  if (!file.startsWith(WEB_DIR + path.sep)) throw new HttpError(404, 'Not found');
  let target = file;
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) target = path.join(WEB_DIR, 'index.html');
  const type = STATIC_TYPES[path.extname(target)] || 'application/octet-stream';
  securityHeaders(res);
  res.writeHead(200, { 'content-type': type, 'cache-control': target.endsWith('index.html') ? 'no-cache' : 'no-cache' });
  fs.createReadStream(target).pipe(res);
}

export function createServer(app) {
  const router = new Router();
  const guards = createGuards(app);
  registerRoutes(router, app, guards);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    try {
      guards.check(req, pathname);
      if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
        serveStatic(req, res, pathname);
        return;
      }
      securityHeaders(res, { api: true });
      const match = router.match(req.method, pathname);
      if (!match) throw new HttpError(404, `No API route for ${req.method} ${pathname}`);
      await match.handler(req, res, { params: match.params, query: url.searchParams });
    } catch (err) {
      if (!(err instanceof HttpError) || err.status >= 500) log.error('request failed', { method: req.method, path: pathname, error: err.message, stack: err.stack?.split('\n').slice(0, 4).join(' | ') });
      if (!res.headersSent) sendError(res, err);
      else res.end();
    }
  });
  server.keepAliveTimeout = 65000;
  return server;
}

export async function start(overrides = {}) {
  const app = createApp(overrides);
  const server = createServer(app);
  app.startBackground();
  await new Promise((resolve) => server.listen(app.config.port, app.config.host, resolve));
  const addr = server.address();
  app.config.port = addr.port;
  log.info(`Dexter is running at http://${app.config.host === '0.0.0.0' ? 'localhost' : app.config.host}:${addr.port}`, {
    model: app.config.anthropic.apiKey ? 'configured' : 'not configured (set ANTHROPIC_API_KEY)',
    google: app.google.configured() ? 'configured' : 'not configured',
    data: app.config.dataDir,
  });
  const shutdown = async (signal) => {
    log.info(`Shutting down (${signal})`);
    server.close();
    await app.shutdown();
    process.exit(0);
  };
  if (!overrides.noSignals) {
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  }
  return { app, server };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href || fileURLToPath(import.meta.url) === process.argv[1]) {
  start().catch((err) => {
    log.error('Dexter failed to start', { error: err.message });
    process.exit(1);
  });
}
