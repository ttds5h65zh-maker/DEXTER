// Template drafts (used when AI drafting is not configured) and calendar files.

import { formatDue, addDays } from '../shared/dates.js';
import { cleanQuote, stripReplyPrefixes } from '../shared/text.js';

const firstName = (name) => (name || '').replace(/^(dr|prof|mr|mrs|ms|eng)\.?\s+/i, '').trim().split(/\s+/)[0] || '';
const greeting = (name) => {
  if (!name) return 'Hello,';
  if (/\b(office|team|department|dept|support|admissions|registrar|desk|committee|group|services?)\b/i.test(name)) return 'Hello,';
  const titled = /^(dr|prof)\.?\s+(.+)$/i.exec(name.trim());
  if (titled) return `Dear ${name.trim().split(/\s+/)[0]} ${titled[2].split(/\s+/).pop()},`;
  return /\s/.test(name.trim()) || /^[A-Z][a-z]+$/.test(name.trim()) ? `Hi ${firstName(name)},` : 'Hello,';
};
const lowerFirst = (s) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

export function templateEmail({ type, title, quote, due, recipientName, sourceTitle }) {
  const subject = sourceTitle ? `Re: ${stripReplyPrefixes(sourceTitle)}` : `Following up: ${title}`;
  const lines = [greeting(recipientName), ''];
  const cite = quote ? `\n\n    “${cleanQuote(quote)}”\n` : '';
  if (type === 'deadline') {
    lines.push(`I'm following up on this from your message:${cite}`);
    lines.push(due ? `I have this down for ${formatDue(due, { long: true })} (Dubai time). Could you let me know if that is not what you meant?` : 'Could you confirm the exact date and time this is due?');
  } else if (type === 'decision') {
    lines.push(`I want to make sure I understood this correctly:${cite}`);
    lines.push('Could you confirm that this is final, and tell me if there is anything I need to do as a result?');
  } else if (type === 'question') {
    lines.push(`Following up on this point:${cite}`);
    lines.push('Here is where things stand on my side: ');
    lines.push('');
    lines.push('Please tell me if you need anything else from me.');
  } else {
    lines.push(`I'm following up on ${lowerFirst(title)}.`);
    lines.push('Is there any update, or anything you need from me to move this along?');
  }
  lines.push('', 'Thank you,', '');
  return { subject, body: lines.join('\n') };
}

export function templateSubmission({ title, quote, due }) {
  return {
    subject: title,
    body: [
      'Submission note',
      '',
      `What is being submitted: ${title}`,
      due ? `Due: ${formatDue(due, { long: true })} (Dubai time)` : 'Due: not confirmed',
      quote ? `Requirement as written: “${cleanQuote(quote)}”` : '',
      '',
      'Before submitting:',
      '- The file is the final version and opens correctly',
      '- The file name and format match what was asked for',
      '- Names and ID numbers are on the first page',
      '',
      'Message to include with the submission (optional):',
      '',
    ].filter((l) => l !== null).join('\n'),
  };
}

const icsEscape = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
const compact = (date, time) => date.replace(/-/g, '') + (time ? 'T' + time.replace(':', '') + '00' : '');

/** Build an .ics file for an approved calendar draft. Times are Asia/Dubai. */
export function buildIcs(draft) {
  const ev = draft.event;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Dexter//Command Center//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Dubai',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0400',
    'TZOFFSETTO:+0400',
    'TZNAME:GST',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    `UID:${draft.id}@dexter.local`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}`,
    `SUMMARY:${icsEscape(draft.subject)}`,
  ];
  if (ev.time) {
    const startMin = Number(ev.time.slice(0, 2)) * 60 + Number(ev.time.slice(3));
    const endMin = startMin + (Number(ev.durationMinutes) || 60);
    const endDate = addDays(ev.date, Math.floor(endMin / 1440));
    const endTime = `${String(Math.floor((endMin % 1440) / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
    lines.push(`DTSTART;TZID=Asia/Dubai:${compact(ev.date, ev.time)}`, `DTEND;TZID=Asia/Dubai:${compact(endDate, endTime)}`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${compact(ev.date)}`, `DTEND;VALUE=DATE:${compact(addDays(ev.date, 1))}`);
  }
  if (ev.location) lines.push(`LOCATION:${icsEscape(ev.location)}`);
  if (draft.body) lines.push(`DESCRIPTION:${icsEscape(draft.body)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
