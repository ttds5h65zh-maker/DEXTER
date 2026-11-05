// Timezone-aware helpers. Everything is stored in UTC (ISO strings); these
// helpers convert to and from the user's wall clock (Asia/Dubai by default).
export const DEFAULT_TZ = 'Asia/Dubai';

const dtfCache = new Map();
function partsFormatter(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      weekday: 'short',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function zonedParts(date, tz = DEFAULT_TZ) {
  const out = {};
  for (const p of partsFormatter(tz).formatToParts(date)) {
    if (p.type === 'weekday') out.weekday = WEEKDAYS.indexOf(p.value.toLowerCase().slice(0, 3));
    else if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  if (out.hour === 24) out.hour = 0;
  return out;
}

export function tzOffsetMinutes(date, tz = DEFAULT_TZ) {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const actual = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((asUtc - actual) / 60000);
}

// Convert a wall-clock time in `tz` to the UTC instant.
export function zonedToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, tz = DEFAULT_TZ) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const off1 = tzOffsetMinutes(new Date(guess), tz);
  let ts = guess - off1 * 60000;
  const off2 = tzOffsetMinutes(new Date(ts), tz);
  if (off2 !== off1) ts = guess - off2 * 60000;
  return new Date(ts);
}

export function formatOffset(minutes) {
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

const pad = (n) => String(n).padStart(2, '0');

export function toZonedIso(date, tz = DEFAULT_TZ) {
  const d = date instanceof Date ? date : new Date(date);
  const p = zonedParts(d, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${formatOffset(tzOffsetMinutes(d, tz))}`;
}

export function formatHuman(date, tz = DEFAULT_TZ, { withYear = false, withWeekday = true } = {}) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  const opts = { timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  if (withWeekday) opts.weekday = 'short';
  if (withYear) opts.year = 'numeric';
  return new Intl.DateTimeFormat('en-GB', opts).format(d);
}

export function formatLongNow(date = new Date(), tz = DEFAULT_TZ) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
}

export function startOfZonedDay(date, tz = DEFAULT_TZ) {
  const p = zonedParts(date, tz);
  return zonedToUtc({ year: p.year, month: p.month, day: p.day }, tz);
}

export function addZonedDays(date, days, tz = DEFAULT_TZ) {
  const p = zonedParts(date, tz);
  const base = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return zonedToUtc({
    year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: base.getUTCDate(),
    hour: p.hour, minute: p.minute, second: p.second,
  }, tz);
}

function localDate(y, m, d) {
  const base = new Date(Date.UTC(y, m - 1, d));
  return { year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: base.getUTCDate() };
}

function parseClock(h, m, ampm) {
  let hour = Number(h);
  const minute = m ? Number(m) : 0;
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
  }
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Parse a date/time the user (or the model) typed. Returns { date, hasTime } or null.
 * Accepts ISO 8601 (with or without offset; offset-less values are read in `tz`)
 * and simple English: "in 20 minutes", "tomorrow 9am", "fri 17:00", "10 nov", "tonight".
 */
export function parseDateTimeInput(input, tz = DEFAULT_TZ, { now = new Date(), defaultTime = '09:00' } = {}) {
  if (input == null) return null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : { date: input, hasTime: true };
  let s = String(input).trim();
  if (!s) return null;

  // ISO with explicit offset or Z.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : { date: d, hasTime: true };
  }
  // ISO local date-time (no offset) -> interpret in tz.
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const [, y, mo, d, h, mi, se] = m;
    if (h === undefined) {
      const [dh, dm] = defaultTime.split(':').map(Number);
      return { date: zonedToUtc({ year: +y, month: +mo, day: +d, hour: dh, minute: dm }, tz), hasTime: false };
    }
    return { date: zonedToUtc({ year: +y, month: +mo, day: +d, hour: +h, minute: +mi, second: se ? +se : 0 }, tz), hasTime: true };
  }

  s = s.toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ').replace(/^(at|on|by) /, '');
  if (s === 'now') return { date: new Date(now), hasTime: true };

  m = s.match(/^in (\d+(?:\.\d+)?) ?(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2][0];
    const ms = unit === 'm' ? 60000 : unit === 'h' ? 3600000 : unit === 'd' ? 86400000 : 7 * 86400000;
    return { date: new Date(now.getTime() + n * ms), hasTime: true };
  }

  // Pull a clock time out of the string.
  let clock = null;
  const timeRes = [
    /(?:^|\s)(?:at )?(\d{1,2}):(\d{2}) ?(am|pm)?(?=\s|$)/,
    /(?:^|\s)(?:at )?(\d{1,2}) ?(am|pm)(?=\s|$)/,
    /(?:^|\s)at (\d{1,2})(?=\s|$)/,
  ];
  for (const re of timeRes) {
    const tm = s.match(re);
    if (tm) {
      clock = re === timeRes[1] ? parseClock(tm[1], null, tm[2]) : parseClock(tm[1], re === timeRes[2] ? null : tm[2], re === timeRes[2] ? null : tm[3]);
      if (!clock) return null;
      s = (s.slice(0, tm.index) + ' ' + s.slice(tm.index + tm[0].length)).trim();
      break;
    }
  }
  if (!clock && /\bnoon\b/.test(s)) { clock = { hour: 12, minute: 0 }; s = s.replace(/\bnoon\b/, '').trim(); }
  if (!clock && /\bmidnight\b/.test(s)) { clock = { hour: 23, minute: 59 }; s = s.replace(/\bmidnight\b/, '').trim(); }
  s = s.replace(/\s+/g, ' ').replace(/ ?at$/, '').trim();

  const today = zonedParts(now, tz);
  let day = null;
  let explicitDay = true;
  if (s === '' ) { day = { year: today.year, month: today.month, day: today.day }; explicitDay = false; }
  else if (s === 'today') day = { year: today.year, month: today.month, day: today.day };
  else if (s === 'tonight') { day = { year: today.year, month: today.month, day: today.day }; if (!clock) clock = { hour: 20, minute: 0 }; }
  else if (s === 'tomorrow' || s === 'tmrw' || s === 'tomorrow morning' || s === 'tomorrow evening') {
    day = localDate(today.year, today.month, today.day + 1);
    if (!clock && s.endsWith('morning')) clock = { hour: 9, minute: 0 };
    if (!clock && s.endsWith('evening')) clock = { hour: 19, minute: 0 };
  } else {
    let wm = s.match(/^(next |this )?(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)[a-z]*$/);
    if (wm) {
      const target = WEEKDAYS.indexOf(wm[2].slice(0, 3));
      let diff = (target - today.weekday + 7) % 7;
      if (diff === 0) diff = 7; // "monday" said on a Monday means next week; "next fri" == the coming Friday
      day = localDate(today.year, today.month, today.day + diff);
    } else {
      // "10 nov", "nov 10", optional year
      let dm = s.match(/^(\d{1,2}) ([a-z]{3})[a-z]*(?: (\d{4}))?$/) || null;
      let monthIdx; let dayNum; let year;
      if (dm) { dayNum = +dm[1]; monthIdx = MONTHS.indexOf(dm[2]); year = dm[3] ? +dm[3] : null; }
      else {
        dm = s.match(/^([a-z]{3})[a-z]* (\d{1,2})(?: (\d{4}))?$/);
        if (dm) { monthIdx = MONTHS.indexOf(dm[1]); dayNum = +dm[2]; year = dm[3] ? +dm[3] : null; }
      }
      if (dm && monthIdx >= 0 && dayNum >= 1 && dayNum <= 31) {
        let y = year ?? today.year;
        if (!year) {
          const cand = Date.UTC(y, monthIdx, dayNum);
          const todayUtc = Date.UTC(today.year, today.month - 1, today.day);
          if (cand < todayUtc) y += 1;
        }
        day = { year: y, month: monthIdx + 1, day: dayNum };
      }
    }
  }
  if (!day) return null;
  const hasTime = Boolean(clock);
  if (!clock) {
    const [dh, dm] = defaultTime.split(':').map(Number);
    clock = { hour: dh, minute: dm };
  }
  let date = zonedToUtc({ ...day, hour: clock.hour, minute: clock.minute }, tz);
  // A bare time that already passed today means tomorrow.
  if (!explicitDay && date.getTime() <= now.getTime()) {
    const next = localDate(day.year, day.month, day.day + 1);
    date = zonedToUtc({ ...next, hour: clock.hour, minute: clock.minute }, tz);
  }
  return { date, hasTime };
}

export function relativeLabel(date, now = new Date(), tz = DEFAULT_TZ) {
  const d = date instanceof Date ? date : new Date(date);
  const dayDiff = Math.round((startOfZonedDay(d, tz) - startOfZonedDay(now, tz)) / 86400000);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  if (dayDiff === 0) return `today ${time}`;
  if (dayDiff === 1) return `tomorrow ${time}`;
  if (dayDiff === -1) return `yesterday ${time}`;
  return formatHuman(d, tz);
}
