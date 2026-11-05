// Per-turn context snapshot appended as a mid-conversation system message.
import { formatLongNow, toZonedIso, formatOffset, tzOffsetMinutes } from '../lib/time.js';

export function buildContext(app, { text = '', conversationId = null, note = null } = {}) {
  const tz = app.settings.timezone();
  const nowDate = new Date();
  const lines = [];
  lines.push(`Current time: ${formatLongNow(nowDate, tz)} (${tz}, UTC${formatOffset(tzOffsetMinutes(nowDate, tz))}). ISO: ${toZonedIso(nowDate, tz)}`);

  const integ = app.integrations.statusSummary();
  lines.push(`Integrations: ${integ}`);

  const perms = app.settings.get('permissions');
  const off = Object.entries(perms).filter(([, v]) => !v).map(([k]) => k.replace(/_/g, ' '));
  if (off.length) lines.push(`Permissions turned off by ${app.settings.get('profile').name}: ${off.join(', ')}.`);

  if (conversationId) {
    const conv = app.conversations.get(conversationId);
    if (conv?.project_id) {
      const p = app.projects.get(conv.project_id);
      if (p) lines.push(`This conversation belongs to ${p.kind} ${p.code ? `${p.code} — ` : ''}${p.name} [${p.id}].`);
    }
  }

  const memories = app.memory.relevant(text, 25);
  if (memories.length) {
    lines.push('', 'Saved memories (most relevant first):');
    for (const m of memories) lines.push(`- ${app.memory.brief(m, tz)}`);
  } else {
    lines.push('', 'Saved memories: none yet.');
  }

  const open = app.tasks.list({ include_done: false, limit: 25 });
  if (open.length) {
    lines.push('', 'Open tasks:');
    for (const t of open) lines.push(`- ${app.tasks.brief(t, tz)}`);
  } else {
    lines.push('', 'Open tasks: none.');
  }

  const projects = app.projects.list();
  if (projects.length) {
    lines.push('', 'Courses and projects:');
    for (const p of projects) lines.push(`- [${p.id}] ${p.kind}: ${p.code ? `${p.code} ` : ''}${p.name}${p.term ? ` (${p.term})` : ''}`);
  }

  const pending = app.approvals.pendingCount();
  if (pending) lines.push('', `Approvals waiting for ${app.settings.get('profile').name}: ${pending}.`);
  if (note) lines.push('', note);
  return lines.join('\n');
}
