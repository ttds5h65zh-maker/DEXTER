// In-process event bus with a Server-Sent Events endpoint. The UI keeps one
// EventSource open and receives run deltas, task/approval/job changes and
// notifications. A short replay buffer covers brief reconnects.
export class EventBus {
  constructor() {
    this.clients = new Set();
    this.listeners = new Set();
    this.seq = 0;
    this.buffer = [];
    this.heartbeat = null;
  }

  publish(type, data = {}) {
    const ev = { id: ++this.seq, type, data, at: new Date().toISOString() };
    this.buffer.push(ev);
    if (this.buffer.length > 2000) this.buffer.splice(0, this.buffer.length - 2000);
    const frame = `id: ${ev.id}\nevent: message\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const res of this.clients) {
      try { res.write(frame); } catch { this.clients.delete(res); }
    }
    for (const fn of this.listeners) {
      try { fn(ev); } catch { /* listener errors never break publishing */ }
    }
    return ev;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  attach(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const last = Number(req.headers['last-event-id'] || new URL(req.url, 'http://x').searchParams.get('last') || 0);
    if (last && last <= this.seq) {
      for (const ev of this.buffer) {
        if (ev.id > last) res.write(`id: ${ev.id}\nevent: message\ndata: ${JSON.stringify(ev)}\n\n`);
      }
    }
    res.write(`event: hello\ndata: ${JSON.stringify({ seq: this.seq })}\n\n`);
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        for (const c of this.clients) { try { c.write(': ping\n\n'); } catch { this.clients.delete(c); } }
      }, 20000);
      this.heartbeat.unref();
    }
  }

  close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.clients) { try { c.end(); } catch { /* ignore */ } }
    this.clients.clear();
  }
}
