// Slash commands run locally, without the model: they perform real actions
// (create a task, schedule a reminder, save a memory, run a briefing) and
// report exactly what was stored.
import { parseDateTimeInput, formatHuman } from '../lib/time.js';
import { badRequest } from '../lib/http.js';

const COMMANDS = ['help', 'task', 'remind', 'remember', 'brief', 'jobs'];

export function isCommand(text) {
  const m = String(text || '').match(/^\/([a-z]+)\b/i);
  return Boolean(m && COMMANDS.includes(m[1].toLowerCase()));
}

/** "Submit report due fri 5pm" -> { title, due } */
export function splitDue(text) {
  const m = text.match(/^(.*?)\s+(?:due|by)\s+(.+)$/i);
  if (m) return { title: m[1].trim(), due: m[2].trim() };
  return { title: text.trim(), due: null };
}

/** "in 20 minutes to stretch" | "tomorrow 9am to call the registrar" | "call mom at 18:30" */
export function splitReminder(text, tz, now = new Date()) {
  let m = text.match(/^(.+?)\s+to\s+(.+)$/i);
  if (m) {
    const when = parseDateTimeInput(m[1], tz, { now });
    if (when) return { when, message: m[2].trim() };
  }
  m = text.match(/^(.+?)\s+(at|on|in|tomorrow|today|tonight)\s+(.+)$/i);
  if (m) {
    const phrase = m[2].toLowerCase() === 'at' || m[2].toLowerCase() === 'on' ? m[3] : `${m[2]} ${m[3]}`;
    const when = parseDateTimeInput(phrase, tz, { now });
    if (when) return { when, message: m[1].trim() };
  }
  return null;
}

const HELP = `**Commands** (these work even before Claude is connected):
- \`/task Submit MIS 320 report due fri 5pm\` — create a task
- \`/remind tomorrow 9am to email Dr. Khan\` — schedule a reminder (also: \`/remind in 20 minutes to stretch\`)
- \`/remember I prefer morning study blocks\` — save a memory
- \`/brief\` — run a briefing now
- \`/jobs\` — list scheduled reminders, briefings and monitors`;

export async function runCommand(app, conv, input) {
  const [, nameRaw, restRaw = ''] = input.match(/^\/([a-z]+)\s*([\s\S]*)$/i);
  const name = nameRaw.toLowerCase();
  const rest = restRaw.trim();
  const tz = app.settings.timezone();
  app.conversations.appendMessage(conv.id, { role: 'user', kind: 'user', excluded: 1, meta: { text: input, command: name } });
  if (conv.title === 'New conversation') app.conversations.update(conv.id, { title: input.slice(0, 60) });
  let text;
  let ok = true;
  try {
    if (name === 'help') text = HELP;
    else if (name === 'task') {
      if (!rest) throw badRequest('Usage: /task <title> [due <when>]');
      const { title, due } = splitDue(rest);
      const task = app.tasks.create({ title, due, conversation_id: conv.id, project_id: conv.project_id }, { actor: 'user' });
      text = `Created task **${task.title}** — planned${task.due_at ? `, due ${formatHuman(task.due_at, tz)}${task.due_has_time ? '' : ' (end of day)'}` : ''}. [Open task](#/tasks/${task.id})`;
    } else if (name === 'remind') {
      const parsed = splitReminder(rest, tz);
      if (!parsed) throw badRequest('I could not find a time. Try “/remind tomorrow 9am to submit the form” or “/remind in 30 minutes to stretch”.');
      if (parsed.when.date.getTime() <= Date.now()) throw badRequest('That time is in the past.');
      const job = app.jobs.create({ name: parsed.message.slice(0, 80), kind: 'reminder', schedule: { type: 'once', at: parsed.when.date.toISOString() }, payload: { message: parsed.message }, conversation_id: conv.id }, { actor: 'user' });
      text = `Reminder scheduled for **${formatHuman(job.next_run_at, tz)}** (${tz}): “${parsed.message}”. Job \`${job.id}\` is active on Dexter's scheduler.`;
    } else if (name === 'remember') {
      if (!rest) throw badRequest('Usage: /remember <something worth keeping>');
      const m = app.memory.create({ content: rest, kind: /\b(prefer|like|always|never|usually)\b/i.test(rest) ? 'preference' : 'fact', source_type: 'conversation', source_id: conv.id, source_label: conv.title });
      text = m.duplicate ? `Already saved: “${m.content}”.` : `Saved to memory: “${m.content}”. [View memory](#/memory)`;
    } else if (name === 'brief') {
      const result = await app.runners.compileBriefing({ useModel: false });
      text = result.markdown;
    } else if (name === 'jobs') {
      const jobs = app.jobs.list().filter((j) => j.status === 'active' || j.status === 'paused');
      text = jobs.length
        ? jobs.map((j) => `- **${j.name}** (${j.kind}, ${j.status}) — next: ${j.next_run_at ? formatHuman(j.next_run_at, tz) : '—'} · ${j.schedule_label}`).join('\n')
        : 'No active reminders, briefings or monitors.';
    }
  } catch (err) {
    ok = false;
    text = err.message;
  }
  const msg = app.conversations.appendMessage(conv.id, { role: 'assistant', kind: 'command', excluded: 1, meta: { text, command: name, ok } });
  app.bus.publish('conversation.message', { conversation_id: conv.id, message_id: msg.id });
  return { run: null, command: { name, ok, text }, message_id: msg.id };
}
