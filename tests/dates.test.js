import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { interpretDates, todayInDubai, formatDue, addDays, dubaiInstant } from '../shared/dates.js';
import { extractWithRules, anchorQuote, readEmailHeaders, splitSegments } from '../lib/extract.js';
import { extractPdfText, PdfError } from '../lib/pdf.js';

const REF = '2026-11-10'; // a Tuesday
const one = (text, ref = REF) => interpretDates(text, ref)[0];

test('today is computed in Asia/Dubai, not UTC', () => {
  assert.equal(todayInDubai(new Date('2026-11-12T21:30:00Z')), '2026-11-13');
  assert.equal(todayInDubai(new Date('2026-11-12T19:59:00Z')), '2026-11-12');
  assert.equal(dubaiInstant('2026-11-19', '17:00').toISOString(), '2026-11-19T13:00:00.000Z');
});

test('explicit dates need no confirmation', () => {
  for (const [text, date, time] of [
    ['on 21 November 2026 in room B-204', '2026-11-21', null],
    ['due Nov 30, 11:59 PM', '2026-11-30', '23:59'],
    ['meet 2026-12-01 09:00', '2026-12-01', '09:00'],
    ['by Friday, 13 November', '2026-11-13', null],
  ]) {
    const r = one(text);
    assert.equal(r.certainty, 'explicit', text);
    assert.equal(r.date, date, text);
    assert.equal(r.time, time, text);
  }
});

test('"next Thursday" is ambiguous and offers the other reading', () => {
  const r = one('The draft report is due next Thursday at 5pm.');
  assert.equal(r.certainty, 'ambiguous');
  assert.equal(r.date, '2026-11-19');
  assert.equal(r.time, '17:00');
  assert.deepEqual(r.alternatives.map((a) => a.date), ['2026-11-12']);
  assert.match(r.reasons[0], /Next Thursday/);
  assert.equal(r.phrase, 'next Thursday at 5pm');
});

test('"next <weekday>" always asks, even when both readings agree', () => {
  const r = one('next Thursday', '2026-11-12'); // said on a Thursday
  assert.equal(r.certainty, 'ambiguous');
  assert.equal(r.date, '2026-11-19');
  assert.equal(r.alternatives.length, 0);
});

test('relative and vague phrases', () => {
  assert.deepEqual([one('call tomorrow').date, one('call tomorrow').certainty], ['2026-11-11', 'relative']);
  assert.equal(one('by Friday').date, '2026-11-13');
  assert.equal(one('end of next week').date, '2026-11-20');
  assert.equal(one('end of next week').certainty, 'ambiguous');
  assert.equal(one('within 5 days of your demonstration').certainty, 'ambiguous');
  assert.equal(one('before the 15th').date, '2026-11-15');
  const eod = one('send it by EOD');
  assert.deepEqual([eod.date, eod.time, eod.certainty], ['2026-11-10', '17:00', 'ambiguous']);
});

test('ambiguous numeric dates, weekdays that do not match, and time zones', () => {
  const num = one('meeting is 03/12 at 4:30');
  assert.deepEqual([num.date, num.time, num.certainty], ['2026-12-03', '16:30', 'ambiguous']);
  assert.ok(num.alternatives.some((a) => a.time === '04:30'));
  const wd = one('Thursday 14 Nov');
  assert.equal(wd.certainty, 'ambiguous');
  assert.equal(wd.alternatives[0].date, '2026-11-12');
  const tz = one('call at 3pm EST on Dec 2');
  assert.deepEqual([tz.date, tz.time], ['2026-12-03', '00:00']); // 3pm EST is midnight in Dubai
  assert.equal(tz.certainty, 'ambiguous');
});

test('ordinary words are not mistaken for dates', () => {
  assert.equal(interpretDates('Sat down, open 24/7, you may 5 times, every Saturday, Saturday mornings', REF).length, 0);
});

test('formatting', () => {
  assert.equal(formatDue({ date: '2026-11-19', time: '17:00' }), 'Thu 19 Nov 2026, 5:00 PM');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('rule extraction finds each kind and keeps exact evidence offsets', () => {
  const text = fs.readFileSync(new URL('../samples/messy-email.txt', import.meta.url), 'utf8');
  const headers = readEmailHeaders(text);
  assert.equal(headers.from.email, 'm.qasim@falconbay.example');
  assert.equal(headers.date, '2026-11-11');
  const findings = extractWithRules({ text, kind: 'email', sourceDate: headers.date, dateBasis: 'header' });
  for (const f of findings) assert.equal(text.slice(f.evidence.start, f.evidence.end), f.evidence.quote);
  const types = findings.map((f) => f.type);
  assert.ok(types.includes('deadline') && types.includes('decision') && types.includes('question'));
  const agreement = findings.find((f) => f.evidence.quote.includes('internship agreement'));
  assert.deepEqual([agreement.type, agreement.date.date, agreement.date.status], ['deadline', '2026-11-16', 'confirmed']);
  const deposit = findings.find((f) => f.evidence.quote.includes('next Thursday'));
  assert.deepEqual([deposit.type, deposit.date.status], ['deadline', 'needs_confirmation']);
  assert.ok(!findings.some((f) => /^(From|Sent|Subject):/.test(f.evidence.quote)));
});

test('relative dates need confirmation only when the source date is a guess', () => {
  const text = 'Please send the form by Friday.';
  const known = extractWithRules({ text, kind: 'note', sourceDate: REF, dateBasis: 'now' })[0];
  const guessed = extractWithRules({ text, kind: 'email', sourceDate: REF, dateBasis: 'assumed' })[0];
  assert.equal(known.date.status, 'confirmed');
  assert.equal(guessed.date.status, 'needs_confirmation');
});

test('sentence splitting respects abbreviations', () => {
  const segs = splitSegments('Dr. Haddad will meet at 5 p.m. on Friday. Bring the form.').map((s) => s.text);
  assert.deepEqual(segs, ['Dr. Haddad will meet at 5 p.m. on Friday.', 'Bring the form.']);
});

test('quotes are anchored even when whitespace differs', () => {
  const text = 'The report\n  is due   on Friday.';
  const a = anchorQuote(text, 'report is due on Friday');
  assert.equal(text.slice(a.start, a.end), a.quote);
  assert.equal(anchorQuote(text, 'not in the text'), null);
});

test('PDF text is read page by page', async () => {
  const { text, pages } = await extractPdfText(fs.readFileSync(new URL('../samples/course-outline.pdf', import.meta.url)));
  assert.equal(pages.length, 2);
  assert.match(text, /The individual design journal is due on 27 November 2026 at 11:59 PM through the course portal\./);
  assert.match(text.slice(pages[1].start), /^Open points/);
  await assert.rejects(extractPdfText(Buffer.from('hello, not a pdf')), PdfError);
});
