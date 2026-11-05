// Safe page fetching for research and monitors: http(s) only, size and time
// limits, manual redirects, and a block on private/loopback addresses so that
// instructions hidden in untrusted content cannot point Dexter at local services.
import dns from 'node:dns/promises';
import net from 'node:net';
import { htmlToText, extractTitle } from '../lib/text.js';

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  return false;
}

async function assertPublic(url, allowPrivate) {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https URLs can be fetched');
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('Local network addresses are blocked');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new Error('Private network addresses are blocked');
}

export async function fetchPage(rawUrl, { allowPrivate = false, maxBytes = 3 * 1024 * 1024, timeoutMs = 15000, signal: outer = null } = {}) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error(`Invalid URL: ${rawUrl}`); }
  const signal = outer ? AbortSignal.any([outer, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  let res;
  for (let hop = 0; hop < 6; hop++) {
    await assertPublic(url, allowPrivate);
    res = await fetch(url, { redirect: 'manual', signal, headers: { 'user-agent': 'Dexter/0.1 (personal assistant)', accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url);
      continue;
    }
    break;
  }
  if (!res.ok) throw new Error(`The page returned HTTP ${res.status}`);
  const type = (res.headers.get('content-type') || '').toLowerCase();
  const reader = res.body.getReader();
  const chunks = []; let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) { reader.cancel().catch(() => {}); break; }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  if (type.includes('pdf')) return { url: url.href, title: '', text: '[This URL is a PDF; Dexter cannot extract PDF text on the server.]', contentType: type, status: res.status };
  const body = buf.toString('utf8');
  const isHtml = type.includes('html') || /^\s*<(!doctype|html)/i.test(body);
  return { url: url.href, title: isHtml ? extractTitle(body) : '', text: isHtml ? htmlToText(body) : body, contentType: type, status: res.status, truncated: size > maxBytes };
}
