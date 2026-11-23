// Built-in, rule-based extraction. This is what Dexter uses when AI extraction
// is not configured. It reads the source line by line and sentence by sentence,
// and only reports what it can point to in the source text.

import { interpretDates, addDays, isValidDate, todayInDubai } from '../shared/dates.js';
import { cleanQuote, stripReplyPrefixes } from '../shared/text.js';

const ABBREV = new Set([
  'dr', 'mr', 'mrs', 'ms', 'prof', 'eng', 'e.g', 'i.e', 'etc', 'vs', 'no', 'a.m', 'p.m', 'approx', 'dept', 'st', 'rm', 'ext', 'inc', 'tel', 'bldg', 'univ', 'ave',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
]);

const QUOTE_PREFIX = /^[ \t]*((?:>[ \t]?)+)/;
const LIST_MARK = /^(?:[-*•▪◦‣·–]|\(?\d{1,2}[.)]|\(?[a-z]\)|\[[ xX]?\])[ \t]+/;
const HEADER_LINE = /^(from|to|cc|bcc|date|sent|subject|reply-to|importance)\s*:/i;
const FORWARD_SEP = /^(?:-+\s*forwarded message\s*-*|begin forwarded message\s*:?)$/i;
const HISTORY_SEP = /^(?:-+\s*original message\s*-*|_{8,}|-{8,})$/i;
const SIG_SEP = /^-- ?$/;

/**
 * Classify every line of the source. Each line gets:
 *   kind:    'blank' | 'content' | 'header' | 'attribution' | 'separator' | 'signature'
 *   qd:      quote depth (number of leading ">")
 *   cstart:  offset where the line's own content starts (after quote and list markers)
 *   list:    whether the line starts a list item
 *   context: 'current', or 'earlier' for quoted replies and reply history in emails
 */
export function analyzeLines(text, kind = 'note') {
  const lines = [];
  let pos = 0;
  for (const raw of text.split('\n')) {
    const start = pos;
    const end = pos + raw.length;
    pos = end + 1;
    const q = QUOTE_PREFIX.exec(raw);
    const qd = q ? (q[1].match(/>/g) || []).length : 0;
    let off = q ? q[0].length : 0;
    while (off < raw.length && /[ \t]/.test(raw[off])) off++;
    const lm = LIST_MARK.exec(raw.slice(off));
    const list = !!lm;
    if (lm) off += lm[0].length;
    const body = raw.slice(off).trimEnd();
    lines.push({ start, end, cstart: start + off, qd, list, body, kind: body ? 'content' : 'blank', context: 'current' });
  }

  // headers: a "From:"/"Subject:" line next to another header line, or before any content
  let seenContent = false;
  lines.forEach((l, i) => {
    if (l.kind === 'blank') return;
    const cand = (x) => x && x.kind !== 'blank' && HEADER_LINE.test(x.body);
    if (cand(l) && (cand(lines[i - 1]) || cand(lines[i + 1]) || !seenContent)) l.kind = 'header';
    else if (/\bwrote:\s*$/i.test(l.body) || /^(?:le|am|el)\s.+:\s*$/i.test(l.body) && /@/.test(l.body)) {
      l.kind = 'attribution';
      const prev = lines[i - 1];
      if (prev && prev.kind === 'content' && /^on\s/i.test(prev.body) && !/[.!?]$/.test(prev.body)) prev.kind = 'attribution';
    } else if (FORWARD_SEP.test(l.body) || HISTORY_SEP.test(l.body)) l.kind = 'separator';
    if (l.kind === 'content') seenContent = true;
  });

  // signatures: lines after a "-- " delimiter, up to the next header, attribution or separator
  let inSig = false;
  for (const l of lines) {
    if (SIG_SEP.test(l.body)) { l.kind = 'signature'; inSig = true; continue; }
    if (l.kind === 'header' || l.kind === 'attribution' || l.kind === 'separator') inSig = false;
    if (inSig && l.kind === 'content') l.kind = 'signature';
  }

  // reply history: in an email, everything after a reply header block, an
  // "On … wrote:" line or an "Original Message" line is an earlier message.
  // A forwarded message is the main content, so it does not count.
  if (kind === 'email') {
    let earlier = false;
    let body = false;
    let prevNonBlank = null;
    for (const l of lines) {
      if (l.kind === 'blank') { l.context = earlier ? 'earlier' : 'current'; continue; }
      if (body && !earlier) {
        const startsHeaderBlock = l.kind === 'header' && (!prevNonBlank || prevNonBlank.kind !== 'header');
        const afterForward = prevNonBlank && prevNonBlank.kind === 'separator' && FORWARD_SEP.test(prevNonBlank.body);
        if (l.kind === 'attribution' || (l.kind === 'separator' && HISTORY_SEP.test(l.body)) || (startsHeaderBlock && !afterForward)) earlier = true;
      }
      l.context = earlier || l.qd > 0 ? 'earlier' : 'current';
      if (l.kind === 'content' && l.qd === 0) body = true;
      prevNonBlank = l;
    }
  } else {
    for (const l of lines) if (l.qd > 0) l.context = 'earlier';
  }
  return lines;
}

/** Which part of the source an offset falls in ('current' or 'earlier'). */
export function contextAt(lines, offset) {
  const l = lines.find((x) => offset >= x.start && offset <= x.end);
  return l ? l.context : 'current';
}

/**
 * Split text into sentence-like segments, keeping character offsets.
 * Wrapped lines are joined back into their sentence; list items, quoted
 * passages and headers start new segments.
 */
export function splitSegments(text, kind = 'note') {
  const lines = analyzeLines(text, kind);
  const segs = [];
  const blocks = [];
  let block = null;
  const close = () => {
    if (block) blocks.push(block);
    block = null;
  };
  lines.forEach((l, i) => {
    if (l.kind !== 'content') { close(); return; }
    const indented = /^[ \t]/.test(text.slice(l.start + (QUOTE_PREFIX.exec(text.slice(l.start, l.end)) || [''])[0].length, l.end));
    const lowerStart = /^[a-z(]/.test(l.body);
    const openEnd = block && !/[.!?:;]$/.test(block.lastBody);
    // a line ending in "until", "the", "to"… cannot end a sentence
    const dangling = block && /\b(?:the|a|an|to|for|of|in|on|at|by|and|or|but|with|from|until|till|before|after|than|is|are|was|were|be|will|would|can|could|should|must|has|have|had|your|my|our|their|this|that|as|if|not|no later)$/i.test(block.lastBody);
    const continues = block && !l.list && l.qd === block.qd && l.context === block.context &&
      (block.list ? openEnd && (indented || lowerStart || dangling) : block.lastLen >= 45 || (openEnd && (lowerStart || dangling)));
    if (!continues) {
      close();
      block = { start: l.cstart, end: l.end, qd: l.qd, context: l.context, lines: 0, list: l.list };
    }
    block.end = l.end;
    block.last = i;
    block.lines++;
    block.lastLen = l.body.length;
    block.lastBody = l.body;
  });
  close();
  // A short line is a heading only when something follows it after a break
  // ("Decisions" then a list); a short last line is a statement.
  for (const b of blocks) {
    const next = lines[b.last + 1];
    const more = lines.slice(b.last + 1).some((x) => x.kind === 'content');
    b.nextBreak = more && !!next && (next.kind === 'blank' || next.list || next.kind === 'header');
  }

  for (const b of blocks) {
    let start = b.start;
    const flush = (end) => {
      let s = start;
      let e = end;
      for (;;) { // skip whitespace and quote markers at the start of a wrapped line
        while (s < e && /\s/.test(text[s])) s++;
        if (s < e && text[s] === '>' && /[\n>\s]/.test(text[s - 1] || '\n')) { s++; continue; }
        break;
      }
      while (e > s && /\s/.test(text[e - 1])) e--;
      if (e > s) {
        const raw = text.slice(s, e);
        const clean = cleanQuote(raw);
        segs.push({
          start: s, end: e, text: raw, clean, context: b.context,
          leadIn: /:$/.test(clean),
          heading: !b.list && b.lines === 1 && s === b.start && e === b.end && b.nextBreak && clean.split(/\s+/).length <= 6 && !/[.!?;:,\d]/.test(clean),
        });
      }
      start = end;
    };
    for (let i = b.start; i < b.end; i++) {
      const ch = text[i];
      if ((ch === '.' || ch === '!' || ch === '?') && (i + 1 >= b.end || /\s/.test(text[i + 1]))) {
        if (ch === '.') {
          const word = /([A-Za-z.]+)$/.exec(text.slice(Math.max(start, i - 12), i));
          if (word && (ABBREV.has(word[1].toLowerCase()) || word[1].length === 1)) continue;
          const next = /^\s+(\S)/.exec(text.slice(i + 1, i + 6));
          if (next && /[a-z]/.test(next[1])) continue; // "approx. three" – not a sentence end
        }
        let j = i + 1;
        while (j < b.end && /[.!?"”’)]/.test(text[j])) j++;
        flush(j);
        i = j - 1;
      }
    }
    flush(b.end);
  }
  return segs;
}

const DECISION_RE = new RegExp('\\b(' + [
  'decided', 'decision', 'agreed', "we(?:'ll| will) go with", 'going with', 'go with', 'went with', 'settled on', 'approved',
  '(?:has|have|had) been (?:moved|rescheduled|cancell?ed|postponed|extended|changed|confirmed|waived|approved|granted|accepted|rejected|declined|removed|dropped|replaced|updated|reduced|increased|finali[sz]ed|scrapped|shortened|delayed|brought forward)',
  '(?:moved|postponed|pushed|rescheduled|changed|switched|brought forward|delayed)(?: back)? to',
  'is now', 'are now', 'will now', 'instead of', 'no longer', 'from now on', 'have chosen', 'chose', 'opted', 'cancell?ed', 'waived',
  'postponed', 'rescheduled', 'called off',
].join('|') + ')\\b', 'i');

const DEADLINE_RE = new RegExp('\\b(' + [
  'due', 'deadline', 'by', 'before', 'no later than', 'until', 'till',
  'submi(?:t|ts|tted|tting|ssions?)', 'hand(?:ed)? in', 'upload\\w*', 'clos(?:e|es|ed|ing)', 'expir\\w*', 'rsvp',
  'regist(?:er|ers|ered|ering|ration)', 'pay', 'pays', 'paid', 'paying', 'payable', 'payments?', 'renew\\w*',
  'send', 'sent', 'reply', 'respond', 'confirm\\w*', 'book(?:ed|ing|s)?',
  'exams?', 'quiz(?:zes)?', 'tests?', 'midterms?', 'finals?', 'present(?:s|ed|ing|ation|ations)?', 'viva', 'defen[cs]e',
  'meetings?', 'meet', 'calls?', 'appointments?', 'interviews?', 'viewing', 'start(?:s|ed|ing)?', 'begin(?:s|ning)?', 'ends?',
  'takes? place', 'held', 'scheduled', 'cut-?off', 'last day', 'return\\w*', 'collect\\w*', 'pick(?:ed)? ?up',
  'launch\\w*', 'ceremony', 'lecture', 'seminar', 'workshop', 'webinar', 'dinner', 'lunch', 'party', 'flight', 'visit',
].join('|') + ')\\b', 'i');

const QUESTION_RE = new RegExp('\\b(' + [
  'let me know', 'please confirm', 'please advise', 'not sure (?:if|whether)', 'unclear', 'tbc', 'tbd', 'to be confirmed',
  'need to (?:check|find out|ask|decide)', 'waiting (?:on|for|to hear)', '(?:have not|haven\'t|not) heard(?: back)?', 'any update',
  'still pending', 'as pending', 'pending (?:approval|confirmation|review)', 'open question', 'chasing', 'awaiting',
  "(?:still )?(?:hasn't|has not|haven't|have not|didn't|did not)(?: yet)? (?:sent|replied|responded|confirmed|answered|got back|gotten back|signed|paid|approved)",
  'no (?:reply|response|answer) (?:yet|from)',
].join('|') + ')\\b', 'i');

// Plain uncertainty wins over a date: "unclear whether the 2 December lecture will be recorded"
const STRONG_QUESTION_RE = /\b(unclear (?:whether|if)|not sure (?:if|whether)|(?:don't|do not) know (?:if|whether)|need to (?:check|find out|decide)|open question|still waiting)\b/i;
const STRONG_DEADLINE_RE = /\b(by|before|until|no later than|due|deadline|clos(?:e|es|ing)|expir\w*|cut-?off|last day|submi\w*|hand in)\b/i;
const FILLER_RE = /^(?:also|and|but|so|ps|p\.s\.|note|reminder|fyi|update|just a reminder|quick reminder|please note(?: that)?|just to confirm|one more thing|oh and)\s*[,:–—-]*\s*/i;

function titleFrom(text) {
  let t = text.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 2; i++) t = t.replace(FILLER_RE, '');
  t = t.replace(/^[\s\-–—:,]+/, '');
  if (t.length > 110) t = t.slice(0, 107).replace(/\s+\S*$/, '') + '…';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Turn an interpreted date expression into the `date` record stored on a finding. */
export function dateRecord(interp, source) {
  if (!interp) return null;
  const basis = source.dateBasis || 'assumed';
  const reasons = [...interp.reasons];
  let needs = interp.certainty === 'ambiguous';
  if (interp.certainty === 'relative' && basis === 'assumed') {
    needs = true;
    reasons.push('Dexter does not know when this source was written, so it counted from the day you imported it.');
  }
  return {
    phrase: interp.phrase,
    date: interp.date,
    time: interp.time,
    certainty: interp.certainty,
    status: needs ? 'needs_confirmation' : 'confirmed',
    confirmedBy: needs ? null : 'source',
    reasons,
    alternatives: interp.alternatives,
    basisDate: source.sourceDate,
    basis,
  };
}

/** Interpret the dates in a passage; returns the first usable one (or null). */
export function dateForPassage(passage, source) {
  const found = interpretDates(cleanQuote(passage), source.sourceDate);
  return found.length ? dateRecord(found[0], source) : null;
}

export function extractWithRules(source) {
  const findings = [];
  for (const seg of splitSegments(source.text, source.kind)) {
    const text = seg.clean;
    if (text.length < 8 || text.length > 600 || seg.leadIn) continue;
    const dates = interpretDates(text, source.sourceDate);
    if (seg.heading && !dates.length) continue; // "Decisions", "Open points"
    const isQuestion = /[?؟]["”’)]*$/.test(text);
    let type = null;
    if (isQuestion) {
      // a question is still a deadline when it clearly sets one ("…closes next Thursday??")
      if (dates.length && STRONG_DEADLINE_RE.test(text)) type = 'deadline';
      else {
        type = 'question';
        dates.length = 0;
      }
    } else if (DECISION_RE.test(text)) type = 'decision';
    else if (STRONG_QUESTION_RE.test(text)) type = 'question';
    else if (dates.length && DEADLINE_RE.test(text)) type = 'deadline';
    else if (QUESTION_RE.test(text)) type = 'question';
    if (!type) continue;
    findings.push({
      type,
      title: titleFrom(text),
      evidence: { quote: seg.text, start: seg.start, end: seg.end },
      date: dates.length ? dateRecord(dates[0], source) : null,
      context: seg.context,
      origin: 'rules',
    });
  }
  return findings;
}

/** Locate a quoted passage in the source, tolerating whitespace and "> " differences. */
export function anchorQuote(text, quote) {
  if (!quote) return null;
  const q = quote.trim();
  let idx = text.indexOf(q);
  if (idx >= 0) return { quote: q, start: idx, end: idx + q.length };
  // search a normalised copy: whitespace collapsed, quote markers at line starts dropped
  const map = [];
  let norm = '';
  let prevSpace = true;
  let lineStart = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') lineStart = true;
    if (lineStart && ch === '>') continue;
    const ws = /\s/.test(ch);
    if (!ws && ch !== '>') lineStart = false;
    if (ws) {
      if (!prevSpace) { norm += ' '; map.push(i); }
    } else { norm += ch; map.push(i); }
    prevSpace = ws;
  }
  const nq = cleanQuote(q);
  idx = norm.toLowerCase().indexOf(nq.toLowerCase());
  if (idx < 0 || !nq) return null;
  const start = map[idx];
  const end = map[idx + nq.length - 1] + 1;
  return { quote: text.slice(start, end), start, end };
}

const parseAddress = (s) => {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>\s]+@[^>\s]+)>/.exec(s) || /()([^\s<>]+@[^\s<>]+)/.exec(s);
  return m ? { name: (m[1] || '').trim(), email: m[2] } : { name: s.trim(), email: '' };
};

/**
 * Read the sender, subject and written date from a pasted email.
 * The date is only trusted from headers at the top of the paste; a header
 * block further down belongs to an earlier message in the thread.
 */
export function readEmailHeaders(text) {
  const lines = analyzeLines(text, 'email');
  const out = {};
  const value = (l) => l.body.replace(HEADER_LINE, '').trim();
  const firstReal = lines.findIndex((l) => l.kind !== 'blank' && l.kind !== 'separator');
  const top = [];
  for (let i = Math.max(firstReal, 0); i < lines.length && lines[i] && lines[i].kind === 'header'; i++) top.push(lines[i]);
  const field = (list, name) => list.find((l) => l.body.toLowerCase().startsWith(name));
  const fromTop = field(top, 'from');
  const fromAny = fromTop || lines.find((l) => l.kind === 'header' && /^from\s*:/i.test(l.body) && /@/.test(l.body));
  if (fromAny) out.from = parseAddress(value(fromAny));
  else {
    // "On Tue, 17 Nov 2026 at 4:12 PM Prof. Omar Saeed <o.saeed@…> wrote:"
    const attrib = lines.filter((l) => l.kind === 'attribution').map((l) => l.body).join(' ');
    const m = /.*(?:[AP]M|\d{1,2}:\d{2}|\d{4})\s*,?\s+([^<>,]*?)\s*<([^>\s]+@[^>\s]+)>/i.exec(attrib) || /()<([^>\s]+@[^>\s]+)>/.exec(attrib);
    if (m) out.from = { name: m[1].trim(), email: m[2] };
  }
  const subject = field(top, 'subject') || lines.find((l) => l.kind === 'header' && /^subject\s*:/i.test(l.body));
  if (subject) out.subject = stripReplyPrefixes(value(subject));
  const date = field(top, 'date') || field(top, 'sent');
  if (date) {
    const found = interpretDates(value(date), todayInDubai()).find((d) => d.certainty === 'explicit');
    if (found && isValidDate(found.date)) out.date = found.date;
  }
  return out;
}

export { addDays };
