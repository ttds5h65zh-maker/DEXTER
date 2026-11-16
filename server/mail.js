// Email reminders over SMTP. Configuration comes from environment variables only, so credentials never sit in the database:
//   SMTP_URL   e.g. smtps://user:password@smtp.example.com:465  (or smtp://… with STARTTLS on 587)
//   MAIL_FROM  e.g. "Dexter Payments <reminders@example.com>"
// A user's address counts as working only after they type back a code that was actually delivered to it.
import crypto from 'node:crypto';
import { all, get, run } from './db.js';
import { bad, fmtMoney } from './util.js';
import { remindersFor, markEmailed } from './summary.js';

export const mailConfigured = () => !!(process.env.SMTP_URL && process.env.MAIL_FROM);
let transport = null;
async function getTransport() {
  if (!mailConfigured()) throw bad('Email is not configured. Set SMTP_URL and MAIL_FROM, then restart the app.');
  if (!transport) {
    const nodemailer = (await import('nodemailer')).default;
    const u = new URL(process.env.SMTP_URL);
    const secure = u.protocol === 'smtps:';
    transport = nodemailer.createTransport({
      host: u.hostname, port: Number(u.port) || (secure ? 465 : 587), secure,
      auth: u.username ? { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) } : undefined,
      tls: process.env.SMTP_ALLOW_SELF_SIGNED === '1' ? { rejectUnauthorized: false } : undefined,
    });
  }
  return transport;
}
const prefsOf = (user) => JSON.parse(get('SELECT prefs FROM users WHERE id = ?', user.id).prefs || '{}');
const savePrefs = (user, prefs) => run('UPDATE users SET prefs = ? WHERE id = ?', JSON.stringify(prefs), user.id);
const hash = (code) => crypto.createHash('sha256').update(code).digest('hex');

export function emailStatus(user) {
  const p = prefsOf(user);
  return {
    configured: mailConfigured(),
    address: user.email,
    verified: mailConfigured() && p.email_verified_for === user.email,
    enabled: !!p.email_reminders,
    code_pending: !!p.email_code && p.email_code_expires > Date.now(),
  };
}

export async function sendVerification(user) {
  const t = await getTransport();
  const code = String(crypto.randomInt(100000, 1000000));
  await t.sendMail({
    from: process.env.MAIL_FROM, to: user.email, subject: 'Dexter Payments — confirm reminder emails',
    text: `Your confirmation code is ${code}\n\nEnter it in Dexter Payments → Settings → Reminders to switch on email reminders. It expires in 30 minutes.`,
  });
  const p = prefsOf(user);
  savePrefs(user, { ...p, email_code: hash(code), email_code_expires: Date.now() + 30 * 60000, email_code_tries: 0 });
  return emailStatus(user);
}

export function confirmVerification(user, code) {
  const p = prefsOf(user);
  if (!p.email_code || p.email_code_expires < Date.now()) throw bad('That code has expired. Send a new one.');
  if ((p.email_code_tries || 0) >= 5) throw bad('Too many wrong attempts. Send a new code.');
  if (hash(String(code || '').trim()) !== p.email_code) {
    savePrefs(user, { ...p, email_code_tries: (p.email_code_tries || 0) + 1 });
    throw bad('That code does not match.');
  }
  const { email_code, email_code_expires, email_code_tries, ...rest } = p;
  savePrefs(user, { ...rest, email_verified_for: user.email, email_reminders: true });
  return emailStatus(user);
}

/** Send each verified, opted-in user one digest of reminders they have not been emailed yet. */
export async function sendDueReminders() {
  if (!mailConfigured()) return { sent: 0 };
  let sent = 0;
  for (const user of all('SELECT * FROM users WHERE active = 1')) {
    const p = JSON.parse(user.prefs || '{}');
    if (!p.email_reminders || p.email_verified_for !== user.email) continue;
    const due = remindersFor(user).filter((r) => !r.emailed_at);
    if (!due.length) continue;
    const lines = due.map((r) => {
      const when = r.overdue ? `OVERDUE by ${-r.days_until} day(s)` : r.days_until === 0 ? 'due today' : `due in ${r.days_until} day(s)`;
      return `- ${r.direction === 'in' ? 'To receive' : 'To pay'}: ${r.title} — ${fmtMoney(r.outstanding, r.currency)}${r.amount_status === 'confirmed' ? '' : ' (not confirmed)'} — ${when} (${r.due_date})`;
    });
    const t = await getTransport();
    await t.sendMail({ from: process.env.MAIL_FROM, to: user.email, subject: `Dexter Payments — ${due.length} reminder${due.length === 1 ? '' : 's'}`, text: `${lines.join('\n')}\n\nOpen Dexter Payments to see the details.` });
    markEmailed(user, due);
    sent++;
  }
  return { sent };
}
