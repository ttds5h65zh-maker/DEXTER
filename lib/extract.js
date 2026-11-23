// Built-in, rule-based extraction. This is what Dexter uses when AI extraction
// is not configured. It reads sentence by sentence and only reports what it can
// point to in the source text.

import { interpretDates, addDays, isValidDate, todayInDubai } from '../shared/dates.js';

const ABBREV = new Set(['dr', 'mr', 'mrs', 'ms', 'prof', 'eng', 'e.g', 'i.e', 'etc', 'vs', 'no', 'a.m', 'p.m', 'approx', 'dept', 'st', 'rm', 'ext', 'inc']);
const HEADER_RE = /^(from|to|cc|bcc|date|sent|subject|reply-to)\s*:/i;

/** Split text into sentence-like segments, keeping character offsets. */
export function splitSegments(text) {
  const segs = [];
  let start = 0;
  const flush = (end) => {
    let s = start;
    let e = end;
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    // drop list markers and quote prefixes from the evidence
    const lead = /^(?:[>\s]*)(?:[-*•▪◦‣·]+|\(?\d{1,2}[.)]|\[[ xX]?\])\s+/.exec(text.slice(s, e));
    if (lead) s += lead[0].length;
    if (e - s >= 8) segs.push({ start: s, end: e, text: text.slice(s, e) });
    start = end;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') {
      flush(i);
      start = i + 1;
    } else if ((ch === '.' || ch === '!' || ch === '?') && (i + 1 >= text.length || /\s/.test(text[i + 1]))) {
      if (ch === '.') {
        const word = /([A-Za-z.]+)$/.exec(text.slice(Math.max(start, i - 12), i));
        if (word && (ABBREV.has(word[1].toLowerCase()) || word[1].length === 1)) continue;
        const next = /^\s+(\S)/.exec(text.slice(i + 1, i + 6));
        if (next && /[a-z]/.test(next[1])) continue; // "approx. three" – not a sentence end
      }
      let j = i + 1;
      while (j < text.length && /[.!?"”’)]/.test(text[j])) j++;
      flush(j);
      i = j - 1;
    }
  }
  flush(text.length);
  return segs;
}

const DECISION_RE = /\b(decided|decision|agreed|we(?:'ll| will) go with|going with|go with|went with|settled on|approved|has been (?:moved|rescheduled|cancell?ed|postponed|extended|changed|confirmed)|have been (?:moved|rescheduled|cancell?ed|postponed|extended|changed)|is now|will now|instead of|no longer|from now on|have chosen|chose|opted)\b/i;
const DEADLINE_RE = /\b(due|deadline|by|before|no later than|until|submit\w*|submission|hand in|upload|closes?|closing|expires?|expiry|rsvp|register|registration|pay|payment|renew|renewal|send|reply|respond|confirm|book|exam|quiz|test|midterm|final|presentation|viva|defen[cs]e|meeting|meet|call|appointment|interview|viewing|starts?|ends?|takes? place|held|scheduled|cut-?off|last day|return|collect|pick ?up)\b/i;
const QUESTION_RE = /\b(let me know|please confirm|please advise|not sure (?:if|whether)|unclear|tbc|tbd|to be confirmed|need to (?:check|find out|ask)|waiting (?:on|for|to hear)|(?:have not|haven't|not) heard(?: back)?|any update|still pending|as pending|open question)\b/i;
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
  const found = interpretDates(passage, source.sourceDate);
  return found.length ? dateRecord(found[0], source) : null;
}

export function extractWithRules(source) {
  const text = source.text;
  const findings = [];
  let inHeaders = source.kind === 'email';
  for (const seg of splitSegments(text)) {
    if (inHeaders) {
      if (HEADER_RE.test(seg.text)) continue;
      inHeaders = false;
    }
    if (/^>/.test(seg.text) || seg.text.length > 600) continue;
    // short lines with no punctuation or numbers are headings, not statements
    if (seg.text.split(/\s+/).length <= 5 && !/[.!?,:;\d]/.test(seg.text)) continue;
    const dates = interpretDates(seg.text, source.sourceDate);
    const isQuestion = /\?["”’)]*$/.test(seg.text);
    let type = null;
    if (isQuestion) {
      // a question is still a deadline when it clearly sets one ("…closes next Thursday??")
      if (dates.length && /\b(by|before|until|no later than|due|deadline|closes?|closing|expires?|cut-?off|last day|submit\w*|hand in)\b/i.test(seg.text)) type = 'deadline';
      else {
        type = 'question';
        dates.length = 0;
      }
    } else if (DECISION_RE.test(seg.text)) type = 'decision';
    else if (dates.length && DEADLINE_RE.test(seg.text)) type = 'deadline';
    else if (QUESTION_RE.test(seg.text)) type = 'question';
    if (!type) continue;
    findings.push({
      type,
      title: titleFrom(seg.text),
      evidence: { quote: seg.text, start: seg.start, end: seg.end },
      date: dates.length ? dateRecord(dates[0], source) : null,
      origin: 'rules',
    });
  }
  return findings;
}

/** Locate a quoted passage in the source, tolerating whitespace differences. */
export function anchorQuote(text, quote) {
  if (!quote) return null;
  const q = quote.trim();
  let idx = text.indexOf(q);
  if (idx >= 0) return { quote: q, start: idx, end: idx + q.length };
  // whitespace-insensitive search
  const map = [];
  let norm = '';
  let prevSpace = true;
  for (let i = 0; i < text.length; i++) {
    const ws = /\s/.test(text[i]);
    if (ws) {
      if (!prevSpace) { norm += ' '; map.push(i); }
    } else { norm += text[i]; map.push(i); }
    prevSpace = ws;
  }
  const nq = q.replace(/\s+/g, ' ');
  idx = norm.toLowerCase().indexOf(nq.toLowerCase());
  if (idx < 0 || !nq) return null;
  const start = map[idx];
  const end = map[idx + nq.length - 1] + 1;
  return { quote: text.slice(start, end), start, end };
}

/** Read the sender and the written date out of pasted email headers, if present. */
export function readEmailHeaders(text) {
  const head = text.slice(0, 1500);
  const out = {};
  const from = /^\s*from\s*:\s*(.+)$/im.exec(head);
  if (from) {
    const m = /^\s*"?([^"<]*?)"?\s*<([^>\s]+@[^>\s]+)>/.exec(from[1]) || /()([^\s<>]+@[^\s<>]+)/.exec(from[1]);
    if (m) out.from = { name: (m[1] || '').trim(), email: m[2] };
    else out.from = { name: from[1].trim(), email: '' };
  }
  const subject = /^\s*subject\s*:\s*(.+)$/im.exec(head);
  if (subject) out.subject = subject[1].trim();
  const date = /^\s*(?:date|sent)\s*:\s*(.+)$/im.exec(head);
  if (date) {
    const found = interpretDates(date[1], todayInDubai()).find((d) => d.certainty === 'explicit');
    if (found && isValidDate(found.date)) out.date = found.date;
  }
  return out;
}

export { addDays };
