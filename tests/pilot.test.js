// Regression tests from the pilot runs: realistic emails, notes and PDFs that
// each exposed a problem. Fixtures are fictional; see tests/fixtures/.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractWithRules, readEmailHeaders, analyzeLines } from '../lib/extract.js';
import { extractPdfText, visualToLogical } from '../lib/pdf.js';
import { cleanQuote, stripReplyPrefixes } from '../shared/text.js';

const fixture = (name, enc = 'utf8') => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), enc);
const REF = '2026-11-23'; // a Monday

function extract(name, kind, { sourceDate, dateBasis } = {}) {
  const text = fixture(name).replace(/\r\n?/g, '\n');
  const headers = kind === 'email' ? readEmailHeaders(text) : {};
  const source = { text, kind, sourceDate: sourceDate || headers.date || REF, dateBasis: dateBasis || (headers.date ? 'header' : kind === 'note' ? 'now' : 'assumed') };
  const findings = extractWithRules(source);
  for (const f of findings) assert.equal(text.slice(f.evidence.start, f.evidence.end), f.evidence.quote, 'evidence offsets are exact');
  const find = (needle) => findings.find((f) => cleanQuote(f.evidence.quote).includes(needle));
  return { text, headers, findings, find };
}

test('Outlook reply thread: headers, cue words, and the earlier message', () => {
  const { headers, findings, find } = extract('01-registrar-thread.txt', 'email');
  assert.deepEqual(headers.from, { name: 'Registrar Office', email: 'registrar@falconbay.example' });
  assert.equal(headers.subject, 'Graduation application – action needed');
  assert.equal(headers.date, '2026-11-23');
  const upload = find('Emirates ID');
  assert.deepEqual([upload.type, upload.date.date, upload.date.time, upload.date.status], ['deadline', '2026-11-26', '15:00', 'confirmed']);
  assert.equal(find('Gowns can be collected').date.date, '2026-12-10');
  assert.equal(find('has been waived').type, 'decision');
  const earlier = findings.filter((f) => f.context === 'earlier').map((f) => cleanQuote(f.evidence.quote));
  assert.deepEqual(earlier, ['Can you confirm it was received?', 'Do I need to pay the ceremony fee before December?']);
  assert.ok(!findings.some((f) => /^(From|Sent|To|Subject):/.test(f.evidence.quote)), 'header lines are never findings');
});

test('Gmail forward: the forwarded message is the main content', () => {
  const { headers, findings, find } = extract('02-landlord-gmail-fwd.txt', 'email');
  assert.equal(headers.from.email, 'leasing@hassanprops.example');
  assert.equal(headers.date, '2026-11-20');
  assert.ok(findings.every((f) => f.context === 'current'));
  assert.equal(find('expires on 31/12/2026').date.date, '2026-12-31');
  const ejari = find('within 14 days of signing');
  assert.equal(ejari.date.status, 'needs_confirmation', 'counted from an event, so it must be reviewed');
  assert.equal(find('decided to keep').type, 'decision');
});

test('chat recap pasted without headers (CRLF): list items stay separate', () => {
  const { findings, find } = extract('03-group-chat-no-headers.txt', 'email');
  assert.ok(!find("today's group call"), 'a lead-in line ending in ":" is not a deadline');
  const talk = find('presenting on Sunday 29th');
  assert.deepEqual([talk.type, talk.date.date, talk.date.time, talk.date.status], ['deadline', '2026-11-29', '10:00', 'needs_confirmation']);
  assert.equal(find('Reem still hasn').type, 'question');
  assert.equal(find('word limit is now').type, 'decision');
  assert.equal(cleanQuote(find('word limit is now').evidence.quote), 'Dr. Haddad said the word limit is now 3,000 words instead of 2,500');
  assert.equal(find('book a meeting room').type, 'question');
  assert.equal(findings.length, 6);
});

test('errands note: bullets, "the 5th", and a short "Decided:" line', () => {
  const { findings, find } = extract('04-errands-note.txt', 'note');
  assert.deepEqual([find('ICP centre').date.date, find('ICP centre').date.time], ['2026-12-02', '09:30']);
  assert.equal(find('before the 5th').date.status, 'needs_confirmation');
  assert.deepEqual([find('birthday dinner').date.date, find('birthday dinner').date.time], ['2026-11-27', '20:00']);
  assert.equal(find('Netflix').type, 'decision');
  assert.ok(!findings.some((f) => f.evidence.quote === 'Errands'));
});

test('meeting notes: headings are skipped, "moved to" is a decision with its date', () => {
  const { findings, find } = extract('05-meeting-notes.txt', 'note');
  const launch = find('Launch moved');
  assert.deepEqual([launch.type, launch.date.date], ['decision', '2027-01-15']);
  for (const h of ['Decisions', 'Action items', 'Open questions']) assert.ok(!findings.some((f) => f.evidence.quote === h), h);
  assert.equal(find('revised budget').date.date, '2026-11-25');
});

test('Gmail reply: the deadline inside "> " quoted text is found and the sender comes from "wrote:"', () => {
  const { headers, find } = extract('08-reply-chain-gmail.txt', 'email');
  assert.equal(headers.subject, 'Lab 5 extension');
  assert.deepEqual(headers.from, { name: 'Prof. Omar Saeed', email: 'o.saeed@falconbay.example' });
  const lab = find('until Monday 30 November');
  assert.deepEqual([lab.type, lab.date.date, lab.date.time, lab.context], ['deadline', '2026-11-30', '12:00', 'earlier']);
  assert.equal(find('decided the extension').type, 'decision');
});

test('wrapped and quoted lines are joined back into one sentence', () => {
  const text = 'Hi,\n\nThe signed agreement has to reach the placement office no later\nthan 26 November, please.\n\n> We can give you until\n> Friday 4 December for the report.\n';
  const findings = extractWithRules({ text, kind: 'email', sourceDate: REF, dateBasis: 'assumed' });
  const a = findings.find((f) => f.evidence.quote.includes('signed agreement'));
  assert.equal(a.date.date, '2026-11-26');
  assert.equal(cleanQuote(a.evidence.quote), 'The signed agreement has to reach the placement office no later than 26 November, please.');
  const b = findings.find((f) => f.evidence.quote.includes('We can give you'));
  assert.deepEqual([b.date.date, b.context, cleanQuote(b.evidence.quote)], ['2026-12-04', 'earlier', 'We can give you until Friday 4 December for the report.']);
});

test('a short last line is a statement, not a heading', () => {
  assert.equal(extractWithRules({ text: 'pay rent friday', kind: 'note', sourceDate: REF, dateBasis: 'now' })[0].date.date, '2026-11-27');
  assert.equal(extractWithRules({ text: 'Exam postponed\n', kind: 'note', sourceDate: REF, dateBasis: 'now' })[0].type, 'decision');
});

test('signatures and separators are skipped', () => {
  const lines = analyzeLines('Thanks!\n-- \nDr. A. Person\nOffice hours by appointment on Monday\n', 'email');
  assert.deepEqual(lines.map((l) => l.kind), ['content', 'signature', 'signature', 'signature', 'blank']);
});

test('reply prefixes are removed from subjects', () => {
  assert.equal(stripReplyPrefixes('Fwd: RE: RE: internship paperwork'), 'internship paperwork');
  assert.equal(stripReplyPrefixes('AW: WG: Termin'), 'Termin');
  assert.equal(stripReplyPrefixes('Rental agreement'), 'Rental agreement');
});

test('PDFs from other generators: ASCII85 streams, encryption, scans', async () => {
  const notice = await extractPdfText(fixture('10-reportlab-notice.pdf', null));
  assert.equal(notice.pages.length, 2);
  assert.equal(notice.title, 'Parking permit notice');
  assert.match(notice.text, /Permits for the 2026\/27 academic year must be renewed by 4 December 2026\./);
  await assert.rejects(extractPdfText(fixture('13-encrypted.pdf', null)), { code: 'encrypted' });
  await assert.rejects(extractPdfText(fixture('12-image-only.pdf', null)), { code: 'no_text' });
});

test('Arabic in PDFs comes out in reading order, ligatures become letters', async () => {
  const { text } = await extractPdfText(fixture('16-chromium-arabic.pdf', null));
  assert.match(text, /Notice from the fictional Falcon Bay housing office\./);
  assert.ok(text.includes('الامتحان في 5 ديسمبر 2026 الساعة 10:00 في القاعة B'), text);
  assert.ok(text.includes('يرجى دفع الرسوم قبل يوم الخميس.'));
  assert.ok(text.includes('The Arabic word مرحبا sits inside an English sentence.'));
  assert.equal(visualToLogical('plain English'), 'plain English');
});
