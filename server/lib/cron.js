// 5-field cron (minute hour day-of-month month day-of-week) evaluated on the
// wall clock of a given IANA timezone.
import { zonedParts, zonedToUtc, DEFAULT_TZ } from './time.js';

const NAMES = {
  month: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'],
  dow: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
};
const RANGES = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dom', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dow', min: 0, max: 7 },
];

function parseValue(token, field) {
  const t = token.toLowerCase();
  if (field.name === 'month' && NAMES.month.includes(t)) return NAMES.month.indexOf(t) + 1;
  if (field.name === 'dow' && NAMES.dow.includes(t)) return NAMES.dow.indexOf(t);
  if (!/^\d+$/.test(t)) throw new Error(`Invalid ${field.name} value "${token}"`);
  const n = Number(t);
  if (n < field.min || n > field.max) throw new Error(`${field.name} value ${n} out of range`);
  return n;
}

function parseField(expr, field) {
  const set = new Set();
  for (const part of expr.split(',')) {
    let [rangePart, stepPart] = part.split('/');
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid step in "${part}"`);
    let lo; let hi;
    if (rangePart === '*') { lo = field.min; hi = field.name === 'dow' ? 6 : field.max; }
    else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      lo = parseValue(a, field); hi = parseValue(b, field);
      if (hi < lo) throw new Error(`Invalid range "${rangePart}"`);
    } else {
      lo = parseValue(rangePart, field);
      hi = stepPart ? (field.name === 'dow' ? 6 : field.max) : lo;
    }
    for (let v = lo; v <= hi; v += step) set.add(field.name === 'dow' && v === 7 ? 0 : v);
  }
  return set;
}

export function parseCron(expr) {
  const fields = String(expr).trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Cron expression must have 5 fields: minute hour day month weekday');
  const [minute, hour, dom, month, dow] = fields.map((f, i) => parseField(f, RANGES[i]));
  return {
    minute, hour, dom, month, dow,
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*',
    source: fields.join(' '),
  };
}

function dayMatches(c, y, m, d) {
  if (!c.month.has(m)) return false;
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const domOk = c.dom.has(d);
  const dowOk = c.dow.has(weekday);
  if (c.domRestricted && c.dowRestricted) return domOk || dowOk;
  if (c.domRestricted) return domOk;
  if (c.dowRestricted) return dowOk;
  return true;
}

/** Next fire time strictly after `after`, as a Date (UTC instant). */
export function nextCronTime(expr, after = new Date(), tz = DEFAULT_TZ) {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  const start = new Date(Math.floor(after.getTime() / 60000) * 60000 + 60000);
  const p = zonedParts(start, tz);
  const minutes = [...c.minute].sort((a, b) => a - b);
  const hours = [...c.hour].sort((a, b) => a - b);
  for (let offset = 0; offset < 370; offset++) {
    const base = new Date(Date.UTC(p.year, p.month - 1, p.day + offset));
    const y = base.getUTCFullYear(); const m = base.getUTCMonth() + 1; const d = base.getUTCDate();
    if (!dayMatches(c, y, m, d)) continue;
    for (const h of hours) {
      if (offset === 0 && h < p.hour) continue;
      for (const mi of minutes) {
        if (offset === 0 && h === p.hour && mi < p.minute) continue;
        const candidate = zonedToUtc({ year: y, month: m, day: d, hour: h, minute: mi }, tz);
        if (candidate.getTime() > after.getTime()) return candidate;
      }
    }
  }
  return null;
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Build a cron expression from a friendlier daily/weekly spec. */
export function cronFromDaily(time, days) {
  const m = String(time || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error('time must be HH:MM (24h)');
  const hour = Number(m[1]); const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error('time out of range');
  let dow = '*';
  if (Array.isArray(days) && days.length && days.length < 7) {
    const idx = days.map((d) => DAY_KEYS.indexOf(String(d).toLowerCase().slice(0, 3)));
    if (idx.some((i) => i < 0)) throw new Error('days must be weekday names like mon, tue');
    dow = [...new Set(idx)].sort().join(',');
  }
  return `${minute} ${hour} * * ${dow}`;
}

export function describeCron(expr) {
  try {
    const c = parseCron(expr);
    const f = expr.trim().split(/\s+/);
    if (c.minute.size === 1 && c.hour.size === 1 && f[2] === '*' && f[3] === '*') {
      const hh = String([...c.hour][0]).padStart(2, '0');
      const mm = String([...c.minute][0]).padStart(2, '0');
      if (f[4] === '*') return `Every day at ${hh}:${mm}`;
      const days = [...c.dow].sort().map((d) => DAY_KEYS[d][0].toUpperCase() + DAY_KEYS[d].slice(1));
      if (f[4] === '1-5') return `Weekdays at ${hh}:${mm}`;
      return `${days.join(', ')} at ${hh}:${mm}`;
    }
    return `Cron: ${expr}`;
  } catch {
    return `Cron: ${expr}`;
  }
}
