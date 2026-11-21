// Shared test helpers: start a real server process on a throwaway data folder, and a cookie-keeping API client.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';

export const fixture = (n) => fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

export async function startServer(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexter-t-'));
  const port = await freePort();
  const srv = { port, dataDir, logs: '', child: null };
  srv.start = async () => {
    srv.child = spawn(process.execPath, ['server/index.js'], {
      env: { ...process.env, PORT: String(port), DEXTER_DATA_DIR: dataDir, NODE_NO_WARNINGS: '1', SMTP_URL: '', MAIL_FROM: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    srv.child.stderr.on('data', (d) => (srv.logs += d));
    await new Promise((resolve, reject) => {
      srv.child.stdout.on('data', (d) => { srv.logs += d; if (String(d).includes('running at')) resolve(); });
      srv.child.on('exit', (c) => reject(new Error(`server exited ${c}\n${srv.logs}`)));
    });
  };
  srv.stop = () => new Promise((r) => { if (!srv.child || srv.child.exitCode !== null) return r(); srv.child.once('exit', r); srv.child.kill('SIGTERM'); });
  srv.cleanup = async () => { await srv.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); };
  await srv.start();
  return srv;
}

export function client(port) {
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const buf = Buffer.isBuffer(body);
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method, body: body === undefined ? undefined : buf ? body : JSON.stringify(body),
      headers: { 'X-Dexter': '1', ...(cookie ? { cookie } : {}), 'content-type': buf ? 'application/octet-stream' : 'application/json', ...headers },
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: ct.includes('json') ? await res.json() : await res.text() };
  };
  return {
    get: (u, h) => call('GET', u, undefined, h), post: (u, b, h) => call('POST', u, b ?? {}, h), patch: (u, b) => call('PATCH', u, b), put: (u, b) => call('PUT', u, b),
    upload: (u, name, buf) => call('POST', u, buf, { 'x-filename': encodeURIComponent(name) }),
    raw: call, get cookie() { return cookie; }, set cookie(v) { cookie = v; },
  };
}
export const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
