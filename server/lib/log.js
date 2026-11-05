// Minimal structured logger with secret redaction. Anything that looks like a
// credential is masked before it reaches stdout, so logs are safe to share.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
let threshold = LEVELS.info;

const SECRET_KEY_RE = /(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passphrase|authorization|cookie|client_secret|x-api-key)/i;
const SECRET_VALUE_RES = [
  /sk-ant-[A-Za-z0-9_\-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._\-~+/=]{8,}/gi,
  /ya29\.[A-Za-z0-9._\-]{10,}/g,
  /1\/\/[A-Za-z0-9._\-]{20,}/g,
  /GOCSPX-[A-Za-z0-9_\-]{10,}/g,
];

export function redactString(s) {
  let out = String(s);
  for (const re of SECRET_VALUE_RES) out = out.replace(re, '[redacted]');
  return out;
}

export function redact(value, depth = 0) {
  if (value == null) return value;
  if (depth > 6) return '[…]';
  if (typeof value === 'string') return redactString(value);
  if (value instanceof Error) return { name: value.name, message: redactString(value.message), code: value.code };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) && v ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function setLogLevel(level) {
  threshold = LEVELS[level] ?? LEVELS.info;
}

function emit(level, msg, data) {
  if (LEVELS[level] < threshold) return;
  const line = { t: new Date().toISOString(), level, msg: redactString(msg) };
  if (data !== undefined) line.data = redact(data);
  const text = JSON.stringify(line);
  if (level === 'error' || level === 'warn') process.stderr.write(text + '\n');
  else process.stdout.write(text + '\n');
}

export const log = {
  debug: (m, d) => emit('debug', m, d),
  info: (m, d) => emit('info', m, d),
  warn: (m, d) => emit('warn', m, d),
  error: (m, d) => emit('error', m, d),
};
