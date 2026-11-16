// Shared helpers: money in integer minor units, calendar dates as YYYY-MM-DD strings.

const DECIMALS = { BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3, JPY: 0, KRW: 0 };
export const decimals = (currency) => DECIMALS[currency] ?? 2;

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
export const bad = (message, extra) => new HttpError(400, message, extra);

/** Parse a human amount ("AED 4,750.00", "(1,200)", 1200.5) into a decimal number, or null. */
export function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value == null) return null;
  let s = String(value).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  s = s.replace(/[^\d.,\-+]/g, '');
  if (s.startsWith('-')) { negative = !negative; }
  s = s.replace(/[-+]/g, '');
  if (!/\d/.test(s)) return null;
  if (/^\d{1,3}(\.\d{3})+(,\d{1,3})?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); // 4.750,00
  else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.'); // 12,50
  else s = s.replace(/,/g, '');
  if ((s.match(/\./g) || []).length > 1) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

export function toMinor(value, currency) {
  const n = parseNumber(value);
  if (n == null) return null;
  return Math.round(n * 10 ** decimals(currency));
}
export function fromMinor(minor, currency) {
  return (minor / 10 ** decimals(currency)).toFixed(decimals(currency));
}
export function fmtMoney(minor, currency) {
  const d = decimals(currency);
  return `${currency} ${(minor / 10 ** d).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

// ---- dates ----
export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const utc = (s) => new Date(s + 'T00:00:00Z');

export function todayIn(timeZone = 'Asia/Dubai') {
  if (process.env.DEXTER_TODAY && isDate(process.env.DEXTER_TODAY)) return process.env.DEXTER_TODAY; // test hook
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
export function addDays(date, n) {
  const d = utc(date);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}
/** Add months, clamping to the last day of the target month (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(date, n) {
  const d = utc(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return iso(d);
}
export const diffDays = (a, b) => Math.round((utc(a) - utc(b)) / 86400000);
export const weekStart = (date) => addDays(date, -((utc(date).getUTCDay() + 6) % 7)); // Monday
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthLabel = (date) => `${MONTH_NAMES[utc(date).getUTCMonth()]} ${utc(date).getUTCFullYear()}`;
export const nowIso = () => new Date().toISOString();

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const mk = (y, m, d) => {
  y = Number(y); m = Number(m); d = Number(d);
  if (y < 100) y += y < 70 ? 2000 : 1900;
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2200)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCDate() === d ? iso(dt) : null;
};

/**
 * Parse a date in common formats. Day-first by default (UAE convention).
 * Returns { value: 'YYYY-MM-DD', ambiguous } or null.
 */
export function parseDate(input, order = 'DMY') {
  if (input == null || input === '') return null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : { value: iso(input), ambiguous: false };
  if (typeof input === 'number') {
    if (input > 20000 && input < 80000) return { value: iso(new Date(Math.round((input - 25569) * 86400000))), ambiguous: false }; // Excel serial
    return null;
  }
  const s = String(input).trim();
  let m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/))) {
    const v = mk(m[1], m[2], m[3]);
    return v ? { value: v, ambiguous: false } : null;
  }
  if ((m = s.match(/^(\d{1,2})[-/.\s](\d{1,2})[-/.\s](\d{2,4})$/))) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    let v;
    let ambiguous = false;
    if (a > 12) v = mk(m[3], b, a);
    else if (b > 12) v = mk(m[3], a, b);
    else {
      ambiguous = a !== b;
      v = order === 'MDY' ? mk(m[3], a, b) : mk(m[3], b, a);
    }
    return v ? { value: v, ambiguous } : null;
  }
  if ((m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[-\s/.,]+([A-Za-z]{3,9})[-\s/.,]+(\d{2,4})$/))) {
    const mon = MONTHS[m[2].toLowerCase().slice(0, 4)] || MONTHS[m[2].toLowerCase().slice(0, 3)];
    const v = mon && mk(m[3], mon, m[1]);
    return v ? { value: v, ambiguous: false } : null;
  }
  if ((m = s.match(/^([A-Za-z]{3,9})[-\s/.]+(\d{1,2})(?:st|nd|rd|th)?[-\s/.,]+(\d{2,4})$/))) {
    const mon = MONTHS[m[1].toLowerCase().slice(0, 4)] || MONTHS[m[1].toLowerCase().slice(0, 3)];
    const v = mon && mk(m[3], mon, m[2]);
    return v ? { value: v, ambiguous: false } : null;
  }
  return null;
}
export const DATE_RE = /\b(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{1,2}(?:st|nd|rd|th)?[-\s.,]+[A-Za-z]{3,9}[-\s.,]+\d{2,4}|[A-Za-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})\b/g;

// ---- text ----
export const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, ' ').trim();
export const compact = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const STOP = new Set(['the', 'and', 'llc', 'ltd', 'fze', 'fzco', 'co', 'inc', 'company', 'trading', 'est', 'demo', 'for', 'of', 'bill', 'invoice', 'payment', 'services', 'service', 'general']);
export const tokens = (s) => norm(s).split(' ').filter((t) => t.length >= 3 && !STOP.has(t));
/** Share of the first name's significant words that appear in the second text. */
export function nameOverlap(name, text) {
  const a = tokens(name);
  if (!a.length) return 0;
  const hay = ` ${norm(text)} `;
  return a.filter((t) => hay.includes(` ${t} `) || hay.includes(t)).length / a.length;
}
export const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`; // neutralise spreadsheet formulas
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
