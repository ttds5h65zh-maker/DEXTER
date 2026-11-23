// Date handling shared by the server and the browser.
// Every calendar date in Dexter is a plain 'YYYY-MM-DD' string and every time a
// plain 'HH:MM' string, both meaning wall-clock time in Asia/Dubai (UTC+4, no DST).

export const TZ = 'Asia/Dubai';
export const TZ_LABEL = 'Dubai time';

const pad = (n) => String(n).padStart(2, '0');
const toUTC = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const fromUTC = (d) => d.toISOString().slice(0, 10);

export function todayInDubai(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function timeInDubai(now = new Date()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
}
/** The instant a Dubai wall-clock date/time refers to. */
export function dubaiInstant(date, time = '00:00') {
  return new Date(`${date}T${time}:00+04:00`);
}
export function addDays(iso, n) {
  const d = toUTC(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUTC(d);
}
export function diffDays(a, b) {
  return Math.round((toUTC(a) - toUTC(b)) / 86400000);
}
export const weekdayOf = (iso) => toUTC(iso).getUTCDay(); // 0 = Sunday
export function isValidDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return false;
  const d = toUTC(iso);
  return !Number.isNaN(d.getTime()) && fromUTC(d) === iso;
}
export const isValidTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t || '');

const WD_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WD_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MON_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function formatDate(iso, { long = false, year = true } = {}) {
  if (!isValidDate(iso)) return '';
  const d = toUTC(iso);
  const wd = (long ? WD_LONG : WD_SHORT)[d.getUTCDay()];
  const mon = (long ? MON_LONG : MON_SHORT)[d.getUTCMonth()];
  return `${wd}${long ? ',' : ''} ${d.getUTCDate()} ${mon}${year ? ' ' + d.getUTCFullYear() : ''}`;
}
export function formatTime(t) {
  if (!isValidTime(t)) return '';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
}
export function formatDue(due, opts) {
  if (!due || !due.date) return '';
  return formatDate(due.date, opts) + (due.time ? ', ' + formatTime(due.time) : '');
}
export function relativeDay(iso, today) {
  const n = diffDays(iso, today);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  if (n > 1) return `In ${n} days`;
  return `${-n} days ago`;
}
/** Format a stored ISO instant as Dubai wall-clock, e.g. "12 Nov, 2:05 PM". */
export function formatInstant(isoInstant) {
  const d = new Date(isoInstant);
  if (Number.isNaN(d.getTime())) return '';
  const date = todayInDubai(d);
  return `${formatDate(date, { year: false }).replace(/^\w+ /, '')}, ${formatTime(timeInDubai(d))}`;
}

// ---------------------------------------------------------------------------
// Interpreting date phrases found in text
// ---------------------------------------------------------------------------

const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WD_RE = '(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|wed|thurs?|thu|fri|sat)';
const monthIndex = (s) => MON_SHORT.findIndex((m) => m.toLowerCase() === s.slice(0, 3).toLowerCase());
const weekdayIndex = (s) => WD_SHORT.findIndex((w) => w.toLowerCase() === s.slice(0, 3).toLowerCase());
// Short weekday names ("Sat", "Sun", "Wed") are only trusted when capitalised.
const weekdayTokenOk = (tok) => tok.length > 5 || /^[A-Z]/.test(tok);
const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, couple: 2 };

const mk = (y, m, d) => {
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  return isValidDate(iso) ? iso : null;
};
const isoDow = (iso) => weekdayOf(iso) || 7; // Monday = 1 … Sunday = 7
const mondayOf = (iso) => addDays(iso, 1 - isoDow(iso));
const lastOfMonth = (iso, plusMonths = 0) => {
  const d = toUTC(iso);
  return fromUTC(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1 + plusMonths, 0)));
};

/** Day + month, with or without a year, optionally with a stated weekday. */
function dayMonth(day, mon, yearStr, wdTok, ref, monTok = '') {
  if (monTok === 'may') return null; // lower-case "may" is almost always the verb
  const reasons = [];
  const alternatives = [];
  let certainty = 'explicit';
  let date;
  if (yearStr) {
    let y = Number(yearStr);
    if (y < 100) y += 2000;
    date = mk(y, mon + 1, day);
    if (!date) return null;
  } else {
    const y = Number(ref.slice(0, 4));
    const thisYear = mk(y, mon + 1, day);
    const nextYear = mk(y + 1, mon + 1, day);
    if (!thisYear && !nextYear) return null;
    if (thisYear && thisYear >= ref) {
      date = thisYear;
    } else {
      date = nextYear || thisYear;
      certainty = 'ambiguous';
      reasons.push('No year is given and this day has already passed this year, so Dexter assumed next year.');
      if (thisYear && nextYear) alternatives.push({ date: thisYear, label: `${formatDate(thisYear)} (already passed)` });
    }
  }
  if (wdTok && weekdayTokenOk(wdTok)) {
    const wd = weekdayIndex(wdTok);
    if (wd !== weekdayOf(date)) {
      certainty = 'ambiguous';
      reasons.push(`The source says ${WD_LONG[wd]}, but ${formatDate(date)} is a ${WD_LONG[weekdayOf(date)]}.`);
      const delta = (wd - weekdayOf(date) + 7) % 7;
      const nearest = addDays(date, delta <= 3 ? delta : delta - 7);
      alternatives.push({ date: nearest, label: `${formatDate(nearest)} (the nearest ${WD_LONG[wd]})` });
    }
  }
  return { date, certainty, reasons, alternatives };
}

const DATE_RULES = [
  { // 2026-11-19
    re: /\b(\d{4})-(\d{2})-(\d{2})\b/g,
    fn: (m) => {
      const date = mk(+m[1], +m[2], +m[3]);
      return date && { date, certainty: 'explicit', reasons: [], alternatives: [] };
    },
  },
  { // Thursday, 19th of November 2026
    re: new RegExp(`\\b(?:${WD_RE},?\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${MONTH_RE}\\b\\.?(?:,?\\s+(\\d{4})\\b)?`, 'gi'),
    fn: (m, ref) => dayMonth(+m[2], monthIndex(m[3]), m[4], m[1], ref, m[3]),
  },
  { // Nov 19, 2026
    re: new RegExp(`\\b(?:${WD_RE},?\\s+)?${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?![\\d:])(?:,?\\s+(\\d{4})\\b)?`, 'gi'),
    fn: (m, ref) => dayMonth(+m[3], monthIndex(m[2]), m[4], m[1], ref, m[2]),
  },
  { // 19/11/2026, 03/04
    re: /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b(?!\/)/g,
    fn: (m, ref) => {
      const a = +m[1];
      const b = +m[2];
      if (!m[3] && a === 24 && b === 7) return null; // "24/7"
      if (a < 1 || b < 1 || (a > 12 && b > 12)) return null;
      const dayFirst = b <= 12;
      const r = dayMonth(dayFirst ? a : b, (dayFirst ? b : a) - 1, m[3], null, ref);
      if (!r) return null;
      if (a <= 12 && b <= 12 && a !== b) {
        const other = dayMonth(b, a - 1, m[3], null, ref);
        r.certainty = 'ambiguous';
        r.reasons.unshift(`“${m[0]}” could be day/month or month/day. Dexter read it as day/month.`);
        if (other) r.alternatives.unshift({ date: other.date, label: `${formatDate(other.date)} (month/day reading)` });
      }
      return r;
    },
  },
  {
    re: /\bday after tomorrow\b/gi,
    fn: (m, ref) => ({ date: addDays(ref, 2), certainty: 'relative', reasons: [], alternatives: [] }),
  },
  {
    re: /\b(today|tonight|tomorrow|tmrw|tmr)\b/gi,
    fn: (m, ref) => ({ date: addDays(ref, /^to(day|night)$/i.test(m[1]) ? 0 : 1), certainty: 'relative', reasons: [], alternatives: [] }),
  },
  { // in 3 days, within two weeks, in a couple of days, within 48 hours
    re: /\b(?:in|within)\s+(?:the\s+next\s+)?(\d{1,3}|an?|one|two|three|four|five|six|seven|eight|nine|ten|a\s+couple\s+of|couple\s+of)\s+(working\s+|business\s+)?(hours?|days?|weeks?|months?)\b/gi,
    fn: (m, ref) => {
      const tok = m[1].toLowerCase().replace(/^a\s+/, '').replace(/\s+of$/, '');
      const n = /^\d+$/.test(tok) ? +tok : NUM_WORDS[tok];
      if (!n) return null;
      const unit = m[3].toLowerCase();
      const reasons = [];
      let certainty = 'relative';
      let date;
      if (unit.startsWith('hour')) {
        date = addDays(ref, Math.ceil(n / 24));
        certainty = 'ambiguous';
        reasons.push('Counted in hours from the source date; the exact start time is unknown.');
      } else if (unit.startsWith('day')) {
        date = addDays(ref, n);
        if (m[2]) {
          certainty = 'ambiguous';
          reasons.push('The source says working days; Dexter counted calendar days.');
        }
      } else if (unit.startsWith('week')) date = addDays(ref, n * 7);
      else {
        const d = toUTC(ref);
        d.setUTCMonth(d.getUTCMonth() + n);
        date = fromUTC(d);
      }
      if (/^\s+(?:of|after|from|following)\b/i.test(m.input.slice(m.index + m[0].length, m.index + m[0].length + 12))) {
        certainty = 'ambiguous';
        reasons.push('This is counted from an event, not from a fixed day. Dexter counted from the source date, which is probably not what is meant.');
      }
      return { date, certainty, reasons, alternatives: [] };
    },
  },
  { // end of the week, end of next week, end of the month
    re: /\b(?:by\s+|at\s+)?(?:the\s+)?end\s+of\s+(?:(the|this|next)\s+)?(week|month)\b/gi,
    fn: (m, ref) => {
      const next = (m[1] || '').toLowerCase() === 'next';
      if (m[2].toLowerCase() === 'week') {
        const mon = addDays(mondayOf(ref), next ? 7 : 0);
        const fri = addDays(mon, 4);
        const sun = addDays(mon, 6);
        return {
          date: fri,
          certainty: 'ambiguous',
          reasons: ['“End of the week” has no exact day. Dexter used Friday, the last working day.'],
          alternatives: [{ date: sun, label: `${formatDate(sun)} (Sunday)` }],
        };
      }
      const last = lastOfMonth(ref, next ? 1 : 0);
      const dow = weekdayOf(last);
      const lastWorking = addDays(last, dow === 6 ? -1 : dow === 0 ? -2 : 0);
      const r = { date: last, certainty: 'relative', reasons: [], alternatives: [] };
      if (lastWorking !== last) {
        r.certainty = 'ambiguous';
        r.reasons.push('The last day of the month falls on a weekend.');
        r.alternatives.push({ date: lastWorking, label: `${formatDate(lastWorking)} (last working day)` });
      }
      return r;
    },
  },
  { // next week, this week, next month, this weekend
    re: /\b(this|next)\s+(week|month|weekend)\b/gi,
    fn: (m, ref) => {
      const next = m[1].toLowerCase() === 'next';
      const unit = m[2].toLowerCase();
      if (unit === 'weekend') {
        const sat = addDays(mondayOf(ref), 5 + (next ? 7 : 0));
        return {
          date: sat,
          certainty: 'ambiguous',
          reasons: ['A weekend is two days. Dexter used Saturday.'],
          alternatives: [{ date: addDays(sat, 1), label: `${formatDate(addDays(sat, 1))} (Sunday)` }],
        };
      }
      if (unit === 'week') {
        const mon = addDays(mondayOf(ref), next ? 7 : 0);
        const fri = addDays(mon, 4);
        return {
          date: next ? mon : fri,
          certainty: 'ambiguous',
          reasons: [`“${m[0]}” names a week, not a day. Dexter used ${next ? 'Monday' : 'Friday'} of that week.`],
          alternatives: [next ? { date: fri, label: `${formatDate(fri)} (Friday of that week)` } : { date: ref, label: `${formatDate(ref)} (the source date)` }],
        };
      }
      const first = addDays(lastOfMonth(ref, next ? 0 : -1), 1);
      const last = lastOfMonth(ref, next ? 1 : 0);
      return {
        date: next ? first : last,
        certainty: 'ambiguous',
        reasons: [`“${m[0]}” names a month, not a day.`],
        alternatives: [next ? { date: last, label: `${formatDate(last)} (end of that month)` } : { date: ref, label: `${formatDate(ref)} (the source date)` }],
      };
    },
  },
  { // next Thursday, this Friday, Monday
    re: new RegExp(`\\b(?:(this\\s+coming|this|next|coming)\\s+)?${WD_RE}\\b`, 'gi'),
    fn: (m, ref) => {
      if (!weekdayTokenOk(m[2])) return null;
      const before = m.input.slice(Math.max(0, m.index - 10), m.index);
      const after = m.input.slice(m.index + m[0].length, m.index + m[0].length + 12);
      // recurring days ("every Saturday", "Saturday mornings") are not deadlines
      if (/\b(?:every|each)\s+$/i.test(before) || /^\s+(?:mornings|afternoons|evenings|nights)\b/i.test(after)) return null;
      // bare short forms ("Sat", "Sun") need a preposition to count as a day
      if (!m[1] && m[2].length <= 5 && !/(?:\b(?:on|by|before|until|till|due|from|to)|[–—(,-])\s*$/i.test(before)) return null;
      const wd = weekdayIndex(m[2]);
      const delta = (wd - weekdayOf(ref) + 7) % 7;
      const name = WD_LONG[wd];
      if ((m[1] || '').toLowerCase() === 'next') {
        const nearest = addDays(ref, delta || 7);
        const followingWeek = addDays(mondayOf(ref), 7 + ((wd + 6) % 7));
        const r = { date: followingWeek, certainty: 'ambiguous', reasons: [], alternatives: [] };
        if (nearest !== followingWeek) {
          r.reasons.push(`“Next ${name}” can mean the ${name} of next week or simply the first ${name} coming up. Dexter chose the ${name} of next week.`);
          r.alternatives.push({ date: nearest, label: `${formatDate(nearest)} (the first ${name} coming up)` });
        } else {
          r.reasons.push(`“Next ${name}” is counted from the source date, so check that the date is the one meant.`);
        }
        return r;
      }
      if (delta === 0) {
        return {
          date: ref,
          certainty: 'ambiguous',
          reasons: [`The source date is itself a ${name}, so this could mean that day or a week later.`],
          alternatives: [{ date: addDays(ref, 7), label: `${formatDate(addDays(ref, 7))} (a week later)` }],
        };
      }
      return { date: addDays(ref, delta), certainty: 'relative', reasons: [], alternatives: [] };
    },
  },
  { // Sunday 29th, Fri the 4th: a weekday and a day of the month, without the month
    re: new RegExp(`\\b${WD_RE},?\\s+(?:the\\s+)?(\\d{1,2})(st|nd|rd|th)?\\b`, 'gi'),
    fn: (m, ref) => {
      if (!weekdayTokenOk(m[1])) return null;
      const day = +m[2];
      const after = m.input.slice(m.index + m[0].length, m.index + m[0].length + 12);
      // without "th" the number must stand on its own: "Sunday 29, 10am" yes, "Monday 2 people" no
      if (!m[3] && !/^\s*(?:[,.;)]|$|(?:at|@|by|from|before|until)\b)/i.test(after)) return null;
      if (/^\s*(?:a\.?m|p\.?m|h\b|[:.]\d)/i.test(after) || day < 1 || day > 31) return null;
      const y = +ref.slice(0, 4);
      const mo = +ref.slice(5, 7);
      let date = null;
      for (let k = 0; k <= 3 && (!date || date < ref); k++) {
        const mm = mo - 1 + k;
        date = mk(y + Math.floor(mm / 12), (mm % 12) + 1, day);
      }
      if (!date || date < ref) return null;
      const wd = weekdayIndex(m[1]);
      if (weekdayOf(date) === wd) return { date, certainty: 'relative', reasons: [], alternatives: [] };
      const nextWd = addDays(ref, (wd - weekdayOf(ref) + 7) % 7);
      return {
        date,
        certainty: 'ambiguous',
        reasons: [`The source says ${WD_LONG[wd]} the ${day}${m[3] || ''}, but ${formatDate(date)} is a ${WD_LONG[weekdayOf(date)]}.`],
        alternatives: [{ date: nextWd, label: `${formatDate(nextWd)} (the next ${WD_LONG[wd]})` }],
      };
    },
  },
  { // by the 15th
    re: /\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b(?!\s+(?:of|floor|time|year|edition|chapter|week|day|century|grade|place))/gi,
    fn: (m, ref) => {
      const day = +m[1];
      if (day < 1 || day > 31) return null;
      const y = +ref.slice(0, 4);
      const mo = +ref.slice(5, 7);
      let date = mk(y, mo, day);
      if (!date || date < ref) date = mo === 12 ? mk(y + 1, 1, day) : mk(y, mo + 1, day);
      if (!date) return null;
      return { date, certainty: 'ambiguous', reasons: ['No month is given. Dexter used the next time that day of the month comes up.'], alternatives: [] };
    },
  },
];

const TZ_OFFSETS = { GST: 4, UTC: 0, GMT: 0, EST: -5, EDT: -4, CST: -6, CDT: -5, PST: -8, PDT: -7, CET: 1, CEST: 2, BST: 1 };

function findTimes(text) {
  const out = [];
  const push = (start, end, h, min, extra = {}) => {
    if (h > 23 || min > 59) return;
    const t = { start, end, time: `${pad(h)}:${pad(min)}`, reasons: [], altTimes: [], dayShift: 0, ...extra };
    const tz = /^\s*\(?(GST|UTC|GMT|EST|EDT|CST|CDT|PST|PDT|CET|CEST|BST)\b\)?/.exec(text.slice(end, end + 8));
    if (tz) {
      t.end = end + tz[0].length;
      if (TZ_OFFSETS[tz[1]] !== 4) {
        const asWritten = t.time;
        let mins = h * 60 + min + (4 - TZ_OFFSETS[tz[1]]) * 60;
        t.dayShift = Math.floor(mins / 1440);
        mins = ((mins % 1440) + 1440) % 1440;
        t.time = `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
        t.ambiguous = true;
        t.reasons.push(`The time is given in ${tz[1]}. Dexter converted it to Dubai time.`);
        t.altTimes.push({ time: asWritten, label: `${formatTime(asWritten)} (as written, without converting)` });
      }
    }
    out.push(t);
  };
  let m;
  const re12 = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(a\.m\.?|p\.m\.?|am|pm)(?![a-z])/gi;
  while ((m = re12.exec(text))) {
    let h = +m[1];
    if (h < 1 || h > 12) continue;
    const pm = /^p/i.test(m[3]);
    h = (h % 12) + (pm ? 12 : 0);
    push(m.index, m.index + m[0].length, h, +(m[2] || 0));
  }
  const re24 = /(?<![\d:.\/-])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/g;
  while ((m = re24.exec(text))) {
    const start = m.index;
    const end = m.index + m[0].length;
    if (out.some((t) => start < t.end && t.start < end)) continue;
    const h = +m[1];
    const extra = {};
    let hour = h;
    if (m[1].length === 1 && h >= 1 && h <= 7) {
      hour = h + 12;
      extra.ambiguous = true;
      extra.reasons = [`“${m[0]}” has no am/pm. Dexter assumed the afternoon.`];
      extra.altTimes = [{ time: `${pad(h)}:${m[2]}`, label: `${formatTime(`${pad(h)}:${m[2]}`)} (morning)` }];
    }
    push(start, end, hour, +m[2], extra);
  }
  const reWord = /\b(noon|midday|midnight|EOD|COB|end of (?:the )?(?:business |working )?day|close of business)\b/gi;
  while ((m = reWord.exec(text))) {
    const w = m[1];
    if (/^(eod|cob)$/i.test(w) && w !== w.toUpperCase()) continue;
    const lw = w.toLowerCase();
    if (lw === 'noon' || lw === 'midday') push(m.index, m.index + w.length, 12, 0);
    else if (lw === 'midnight') {
      push(m.index, m.index + w.length, 23, 59, {
        ambiguous: true,
        reasons: ['“Midnight” could be the start or the end of the day. Dexter used the end of the day.'],
        altTimes: [{ time: '00:00', label: '12:00 AM (the start of that day)' }],
      });
    } else {
      push(m.index, m.index + w.length, 17, 0, {
        ambiguous: true,
        endOfDay: true,
        reasons: ['“End of day” has no exact time. Dexter used 5:00 PM.'],
        altTimes: [{ time: '23:59', label: '11:59 PM (midnight)' }],
      });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Find and interpret every date expression in `text`, counted from `refDate`
 * (the day the source was written). Returns, for each expression:
 *   { phrase, start, end, date, time, certainty, reasons, alternatives }
 * certainty: 'explicit'  – day and month are spelled out
 *            'relative'  – clear once you know the source date ("tomorrow")
 *            'ambiguous' – more than one reasonable reading ("next Thursday")
 */
export function interpretDates(text, refDate) {
  const cands = [];
  DATE_RULES.forEach((rule, prio) => {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text))) {
      const r = rule.fn(m, refDate);
      if (r) cands.push({ start: m.index, end: m.index + m[0].length, prio, ...r });
    }
  });
  cands.sort((a, b) => b.end - b.start - (a.end - a.start) || a.prio - b.prio);
  const dates = [];
  for (const c of cands) if (!dates.some((p) => c.start < p.end && p.start < c.end)) dates.push(c);
  dates.sort((a, b) => a.start - b.start);

  const times = findTimes(text).filter((t) => !dates.some((d) => t.start < d.end && d.start < t.end));
  const used = new Set();
  const results = dates.map((d) => ({ ...d, timeMatch: null }));
  const sameSentence = (a, b) => !/[.!?]\s|\n/.test(text.slice(Math.min(a, b), Math.max(a, b)));

  // 1. times directly next to a date ("Friday at 5pm", "17:00 on Friday")
  for (const d of results) {
    for (const t of times) {
      if (used.has(t)) continue;
      const after = t.start >= d.end && /^[\s,–—-]*(?:at|by|@|before|until)?\s*$/i.test(text.slice(d.end, t.start)) && t.start - d.end <= 14;
      const before = t.end <= d.start && /^\s*,?\s*(?:on|,)?\s*(?:the\s+)?$/i.test(text.slice(t.end, d.start)) && d.start - t.end <= 10;
      if (after || before) {
        d.timeMatch = t;
        used.add(t);
        d.start = Math.min(d.start, t.start);
        d.end = Math.max(d.end, t.end);
        break;
      }
    }
  }
  // 2. times elsewhere in the same sentence, attached to the nearest date
  for (const t of times) {
    if (used.has(t)) continue;
    const near = results
      .filter((d) => !d.timeMatch && sameSentence(d.end, t.start))
      .sort((a, b) => Math.abs(a.start - t.start) - Math.abs(b.start - t.start))[0];
    if (near) {
      near.timeMatch = t;
      near.detachedTime = true;
      used.add(t);
    }
  }
  // 3. a deadline time with no day at all ("by 5pm", "by EOD")
  for (const t of times) {
    if (used.has(t)) continue;
    if (t.endOfDay || /\b(?:by|before|until|at)\s*$/i.test(text.slice(Math.max(0, t.start - 8), t.start))) {
      results.push({
        start: t.start, end: t.end, date: refDate, certainty: 'ambiguous',
        reasons: ['No day is given. Dexter assumed the source date.'], alternatives: [], timeMatch: t,
      });
    }
  }
  results.sort((a, b) => a.start - b.start);

  return results.map((d) => {
    const t = d.timeMatch;
    let date = d.date;
    let certainty = d.certainty;
    const reasons = [...d.reasons];
    const alternatives = d.alternatives.map((a) => ({ date: a.date, time: t ? t.time : null, label: a.label }));
    let phrase = text.slice(d.start, d.end);
    if (t) {
      if (d.detachedTime) phrase += ' … ' + text.slice(t.start, t.end);
      if (t.dayShift) date = addDays(date, t.dayShift);
      if (t.ambiguous) certainty = 'ambiguous';
      reasons.push(...t.reasons);
      for (const a of t.altTimes) alternatives.push({ date: d.date, time: a.time, label: `${formatDate(d.date)}, ${a.label}` });
    }
    return {
      phrase: phrase.replace(/\s+/g, ' ').trim().replace(/(\w{4,})\.$/, '$1'),
      start: d.start,
      end: d.end,
      date,
      time: t ? t.time : null,
      certainty,
      reasons,
      alternatives,
    };
  });
}
