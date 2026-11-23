// Dexter's state and every operation that changes it.
// State is one JSON file, rewritten atomically after each change.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { todayInDubai, timeInDubai, isValidDate, isValidTime, formatDue, formatDate, TZ } from '../shared/dates.js';
import { extractWithRules, anchorQuote, dateForPassage, readEmailHeaders, analyzeLines, contextAt } from './extract.js';
import { extractWithAI, draftWithAI } from './ai.js';
import { templateEmail, templateSubmission, buildIcs } from './drafts.js';
import { cleanQuote } from '../shared/text.js';

export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const id = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
const nowIso = () => new Date().toISOString();
const TYPES = ['deadline', 'decision', 'question'];
const TYPE_LABEL = { deadline: 'deadline', decision: 'decision', question: 'open question' };
const MAX_TEXT = 400000;

export class Dexter {
  constructor({ dataDir, ai }) {
    this.file = path.join(dataDir, 'dexter.json');
    this.ai = ai || { available: false, reason: 'no_key' };
    fs.mkdirSync(dataDir, { recursive: true });
    this.isNew = !fs.existsSync(this.file);
    this.state = this.isNew
      ? { version: 1, createdAt: nowIso(), sources: [], findings: [], tasks: [], drafts: [] }
      : JSON.parse(fs.readFileSync(this.file, 'utf8'));
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1));
    fs.renameSync(tmp, this.file);
  }

  snapshot() {
    const { sources, findings, tasks, drafts } = this.state;
    return {
      sources, findings, tasks, drafts,
      meta: {
        today: todayInDubai(),
        time: timeInDubai(),
        tz: TZ,
        ai: { available: this.ai.available, reason: this.ai.reason, model: this.ai.model },
        hasDemo: [sources, findings, tasks, drafts].some((list) => list.some((x) => x.demo)),
      },
    };
  }

  // ---- lookups -------------------------------------------------------------
  get(kind, itemId) {
    const item = this.state[kind].find((x) => x.id === itemId);
    if (!item) throw new AppError(404, 'not_found', 'That item no longer exists.');
    return item;
  }
  find(kind, itemId) {
    return itemId ? this.state[kind].find((x) => x.id === itemId) || null : null;
  }
  log(item, text) {
    item.history.push({ at: nowIso(), text });
    item.updatedAt = nowIso();
  }

  // ---- sources ---------------------------------------------------------------
  async importSource({ kind, title, text, sourceDate, filename, pages, useAI, demo }) {
    if (!['email', 'note', 'pdf'].includes(kind)) throw new AppError(400, 'bad_kind', 'Choose an email, a note or a PDF.');
    text = String(text || '').replace(/\r\n?/g, '\n');
    if (!text.trim()) throw new AppError(400, 'empty', 'There is no text to import. Paste or write something first.');
    if (text.length > MAX_TEXT) throw new AppError(413, 'too_long', `That source is too long for Dexter (over ${MAX_TEXT.toLocaleString('en')} characters). Import it in parts.`);
    const headers = kind === 'email' ? readEmailHeaders(text) : {};
    let dateBasis;
    if (sourceDate) {
      if (!isValidDate(sourceDate)) throw new AppError(400, 'bad_date', 'The source date is not a valid date.');
      dateBasis = 'user';
    } else if (headers.date) {
      sourceDate = headers.date;
      dateBasis = 'header';
    } else {
      sourceDate = todayInDubai();
      dateBasis = kind === 'note' ? 'now' : 'assumed';
    }
    const firstLine = (text.split('\n').find((l) => l.trim()) || '').trim().replace(/^#+\s*/, '');
    const autoTitle = headers.subject || (filename ? filename.replace(/\.pdf$/i, '') : '') || firstLine.slice(0, 80) || 'Untitled';
    const source = {
      id: id('src'),
      kind,
      title: (title || '').trim().slice(0, 200) || autoTitle.charAt(0).toUpperCase() + autoTitle.slice(1),
      text,
      filename: filename || null,
      pages: pages || null,
      from: headers.from || null,
      sourceDate,
      dateBasis,
      createdAt: nowIso(),
      demo: !!demo,
      extraction: null,
    };
    this.state.sources.unshift(source);
    await this.runExtraction(source, useAI);
    this.save();
    return source;
  }

  async runExtraction(source, useAI) {
    let items = null;
    let notice = null;
    let mode = 'rules';
    if (this.ai.available && useAI !== false) {
      try {
        const raw = await extractWithAI(this.ai, source);
        items = [];
        for (const r of raw) {
          if (!TYPES.includes(r.type) || !r.title) continue;
          const evidence = anchorQuote(source.text, r.quote);
          if (!evidence) continue; // never show a finding without a passage behind it
          const passage = r.date_phrase && anchorQuote(evidence.quote, r.date_phrase) ? r.date_phrase : evidence.quote;
          items.push({ type: r.type, title: String(r.title).slice(0, 200), evidence, date: r.type === 'deadline' || r.date_phrase ? dateForPassage(passage, source) : null, origin: 'ai' });
        }
        const lines = analyzeLines(source.text, source.kind);
        for (const item of items) item.context = contextAt(lines, item.evidence.start);
        mode = 'ai';
        if (raw.length > items.length) notice = `${raw.length - items.length} AI suggestion(s) were dropped because Dexter could not find their passage in the source.`;
      } catch (err) {
        notice = `AI extraction did not work (${err.message || 'unknown error'}), so Dexter used its built-in rules instead.`;
      }
    }
    if (!items) items = extractWithRules(source);
    const taken = this.state.findings.filter((f) => f.sourceId === source.id && f.evidence);
    let added = 0;
    for (const item of items) {
      if (taken.some((f) => item.evidence.start < f.evidence.end && f.evidence.start < item.evidence.end)) continue;
      this.addFinding(source, item);
      added++;
    }
    source.extraction = { mode, model: mode === 'ai' ? this.ai.model : null, at: nowIso(), notice, found: added };
    return added;
  }

  addFinding(source, { type, title, evidence, date, origin, context }) {
    const finding = {
      id: id('fnd'),
      sourceId: source.id,
      type,
      title,
      evidence,
      date: date || null,
      origin,
      context: context === 'earlier' ? 'earlier' : 'current',
      status: 'new',
      taskId: null,
      edited: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      demo: !!source.demo,
      history: [{ at: nowIso(), text: origin === 'ai' ? 'Found by AI extraction' : origin === 'rules' ? 'Found by Dexter’s built-in rules' : 'Added by you from a selected passage' }],
    };
    this.state.findings.push(finding);
    return finding;
  }

  async reextract(sourceId) {
    const source = this.get('sources', sourceId);
    const added = await this.runExtraction(source);
    this.save();
    return added;
  }

  manualFinding(sourceId, { type, start, end, title }) {
    const source = this.get('sources', sourceId);
    if (!TYPES.includes(type)) throw new AppError(400, 'bad_type', 'Choose deadline, decision or open question.');
    start = Number(start);
    end = Number(end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > source.text.length || end <= start) {
      throw new AppError(400, 'bad_range', 'Select a passage in the source first.');
    }
    while (start < end && /\s/.test(source.text[start])) start++;
    while (end > start && /\s/.test(source.text[end - 1])) end--;
    if (end - start < 2) throw new AppError(400, 'bad_range', 'Select a passage in the source first.');
    const quote = source.text.slice(start, end);
    const clean = cleanQuote(quote);
    const finding = this.addFinding(source, {
      type,
      title: (title || '').trim() || (clean.length > 110 ? clean.slice(0, 107) + '…' : clean),
      evidence: { quote, start, end },
      date: type === 'deadline' ? dateForPassage(quote, source) : null,
      origin: 'manual',
      context: contextAt(analyzeLines(source.text, source.kind), start),
    });
    finding.status = 'accepted';
    this.save();
    return finding;
  }

  deleteSource(sourceId) {
    const source = this.get('sources', sourceId);
    const findingIds = new Set(this.state.findings.filter((f) => f.sourceId === source.id).map((f) => f.id));
    this.state.findings = this.state.findings.filter((f) => f.sourceId !== source.id);
    this.state.drafts = this.state.drafts.filter((d) => d.sourceId !== source.id || d.status === 'completed');
    for (const t of this.state.tasks) {
      if (t.sourceId === source.id || findingIds.has(t.findingId)) {
        t.sourceId = null;
        t.findingId = null;
        this.log(t, `Its source “${source.title}” was deleted`);
      }
    }
    for (const d of this.state.drafts) if (d.sourceId === source.id) { d.sourceId = null; d.findingId = null; }
    this.state.sources = this.state.sources.filter((s) => s.id !== source.id);
    this.save();
  }

  // ---- findings ------------------------------------------------------------
  updateFinding(findingId, patch) {
    const f = this.get('findings', findingId);
    if (patch.title !== undefined) {
      const title = String(patch.title).trim();
      if (!title) throw new AppError(400, 'empty_title', 'A finding needs a title.');
      if (title !== f.title) {
        this.log(f, `Title changed from “${f.title}” to “${title}”`);
        f.title = title.slice(0, 300);
        f.edited = true;
      }
    }
    if (patch.type !== undefined && patch.type !== f.type) {
      if (!TYPES.includes(patch.type)) throw new AppError(400, 'bad_type', 'Choose deadline, decision or open question.');
      this.log(f, `Changed from ${TYPE_LABEL[f.type]} to ${TYPE_LABEL[patch.type]}`);
      f.type = patch.type;
      f.edited = true;
    }
    if (patch.status !== undefined && patch.status !== f.status) {
      if (!['new', 'accepted', 'dismissed'].includes(patch.status)) throw new AppError(400, 'bad_status', 'Unknown status.');
      this.log(f, patch.status === 'dismissed' ? 'Dismissed' : patch.status === 'accepted' ? 'Marked as reviewed' : 'Restored for review');
      f.status = patch.status;
    }
    let dateChanged = false;
    if (patch.confirmDate) {
      if (!f.date) throw new AppError(400, 'no_date', 'This finding has no date to confirm.');
      if (f.date.status !== 'confirmed') {
        f.date.status = 'confirmed';
        f.date.confirmedBy = 'you';
        this.log(f, `Date confirmed: ${formatDue(f.date)}`);
        dateChanged = true;
      }
    } else if (patch.useAlternative !== undefined) {
      const alt = f.date && f.date.alternatives[Number(patch.useAlternative)];
      if (!alt) throw new AppError(400, 'no_alternative', 'That option is no longer available.');
      const before = formatDue(f.date);
      Object.assign(f.date, { date: alt.date, time: alt.time || null, status: 'confirmed', confirmedBy: 'you', corrected: true });
      this.log(f, `Date changed from ${before} to ${formatDue(f.date)} and confirmed`);
      f.edited = true;
      dateChanged = true;
    } else if (patch.date !== undefined) {
      if (patch.date === null) {
        if (f.date) {
          this.log(f, `Date removed (was ${formatDue(f.date)})`);
          f.date = null;
          f.edited = true;
        }
      } else {
        const { date, time } = patch.date;
        if (!isValidDate(date)) throw new AppError(400, 'bad_date', 'Enter a valid date.');
        if (time && !isValidTime(time)) throw new AppError(400, 'bad_time', 'Enter a valid time, or leave it empty.');
        const before = f.date ? formatDue(f.date) : null;
        const same = f.date && f.date.date === date && (f.date.time || null) === (time || null);
        f.date = {
          ...(f.date || { phrase: null, certainty: 'explicit', reasons: [], alternatives: [], basisDate: null, basis: null }),
          date, time: time || null, status: 'confirmed', confirmedBy: 'you', corrected: !same || !!(f.date && f.date.corrected),
        };
        this.log(f, before ? (same ? `Date confirmed: ${before}` : `Date corrected from ${before} to ${formatDue(f.date)}`) : `Date set to ${formatDue(f.date)}`);
        if (!same) f.edited = true;
        dateChanged = true;
      }
    }
    if (dateChanged) {
      const task = this.find('tasks', f.taskId);
      if (task && task.status !== 'done' && f.date && f.date.status === 'confirmed') {
        const before = task.due ? formatDue(task.due) : 'no date';
        task.due = { date: f.date.date, time: f.date.time || null };
        this.log(task, `Due date set from its finding: ${before} → ${formatDue(task.due)}`);
      }
    }
    this.save();
    return f;
  }

  taskFromFinding(findingId, { today, withoutDate } = {}) {
    const f = this.get('findings', findingId);
    let task = this.find('tasks', f.taskId);
    if (!task) {
      const unconfirmed = f.date && f.date.status !== 'confirmed';
      if (unconfirmed && !withoutDate) {
        throw new AppError(409, 'date_unconfirmed', 'Confirm the date on this finding first, or create the task without a date.');
      }
      task = this.newTask({
        title: f.title,
        due: f.date && !unconfirmed ? { date: f.date.date, time: f.date.time || null } : null,
        findingId: f.id,
        sourceId: f.sourceId,
        demo: f.demo,
      });
      const source = this.find('sources', f.sourceId);
      task.history[0].text = `Created from a ${TYPE_LABEL[f.type]} in “${source ? source.title : 'a source'}”` + (task.due ? `, due ${formatDue(task.due)}` : unconfirmed ? ', with no due date because the date was not confirmed' : '');
      f.taskId = task.id;
      if (f.status !== 'accepted') f.status = 'accepted';
      this.log(f, 'Turned into a task');
    }
    if (today && !task.todayOn) {
      task.todayOn = todayInDubai();
      this.log(task, 'Added to Today');
    }
    this.save();
    return task;
  }

  // ---- tasks ---------------------------------------------------------------
  newTask({ title, notes, due, findingId, sourceId, demo }) {
    title = String(title || '').trim();
    if (!title) throw new AppError(400, 'empty_title', 'A task needs a title.');
    const task = {
      id: id('tsk'),
      title: title.slice(0, 300),
      notes: notes || '',
      due: due || null,
      todayOn: null,
      status: 'open',
      waitingOn: '',
      waitingSince: null,
      findingId: findingId || null,
      sourceId: sourceId || null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      completedAt: null,
      demo: !!demo,
      history: [{ at: nowIso(), text: 'Created by you' }],
    };
    this.state.tasks.push(task);
    return task;
  }

  createTask(body) {
    const due = this.parseDue(body.due);
    const task = this.newTask({ title: body.title, notes: body.notes, due, demo: body.demo });
    if (body.today) task.todayOn = todayInDubai();
    this.save();
    return task;
  }

  parseDue(due) {
    if (due === undefined) return undefined;
    if (due === null || !due.date) return null;
    if (!isValidDate(due.date)) throw new AppError(400, 'bad_date', 'Enter a valid date.');
    if (due.time && !isValidTime(due.time)) throw new AppError(400, 'bad_time', 'Enter a valid time, or leave it empty.');
    return { date: due.date, time: due.time || null };
  }

  updateTask(taskId, patch) {
    const t = this.get('tasks', taskId);
    if (patch.title !== undefined) {
      const title = String(patch.title).trim();
      if (!title) throw new AppError(400, 'empty_title', 'A task needs a title.');
      if (title !== t.title) {
        this.log(t, `Renamed from “${t.title}” to “${title}”`);
        t.title = title.slice(0, 300);
      }
    }
    if (patch.notes !== undefined && String(patch.notes) !== t.notes) {
      t.notes = String(patch.notes).slice(0, 20000);
      this.log(t, 'Notes edited');
    }
    const due = this.parseDue(patch.due);
    if (due !== undefined) {
      const before = t.due ? formatDue(t.due) : 'no date';
      const after = due ? formatDue(due) : 'no date';
      if (before !== after) {
        t.due = due;
        this.log(t, `Due date changed: ${before} → ${after}`);
      }
    }
    if (patch.today !== undefined && !!patch.today !== !!t.todayOn) {
      t.todayOn = patch.today ? todayInDubai() : null;
      this.log(t, patch.today ? 'Added to Today' : 'Removed from Today');
    }
    if (patch.waitingOn !== undefined && String(patch.waitingOn).trim() !== t.waitingOn && (patch.status || t.status) === 'waiting') {
      t.waitingOn = String(patch.waitingOn).trim().slice(0, 200);
      if (t.status === 'waiting') this.log(t, `Now waiting on ${t.waitingOn || 'someone'}`);
    }
    if (patch.status !== undefined && patch.status !== t.status) {
      if (!['open', 'waiting', 'done'].includes(patch.status)) throw new AppError(400, 'bad_status', 'Unknown status.');
      const was = t.status;
      t.status = patch.status;
      if (patch.status === 'waiting') {
        t.waitingOn = String(patch.waitingOn ?? t.waitingOn ?? '').trim();
        t.waitingSince = todayInDubai();
        t.completedAt = null;
        this.log(t, `Waiting on ${t.waitingOn || 'someone'}`);
      } else if (patch.status === 'done') {
        t.completedAt = nowIso();
        this.log(t, 'Completed');
      } else {
        t.completedAt = null;
        this.log(t, was === 'done' ? 'Reopened' : 'No longer waiting — back with you');
      }
    }
    this.save();
    return t;
  }

  deleteTask(taskId) {
    const t = this.get('tasks', taskId);
    this.state.tasks = this.state.tasks.filter((x) => x.id !== t.id);
    for (const f of this.state.findings) {
      if (f.taskId === t.id) {
        f.taskId = null;
        this.log(f, `Its task “${t.title}” was deleted`);
      }
    }
    for (const d of this.state.drafts) if (d.taskId === t.id) d.taskId = null;
    this.save();
  }

  // ---- drafts --------------------------------------------------------------
  async createDraft({ findingId, taskId, kind = 'email' }) {
    const finding = this.find('findings', findingId);
    const task = this.find('tasks', taskId) || (finding ? this.find('tasks', finding.taskId) : null);
    if (!finding && !task) throw new AppError(400, 'no_subject', 'Choose a finding or a task to draft from.');
    const source = this.find('sources', finding ? finding.sourceId : task.sourceId);
    const linkedFinding = finding || this.find('findings', task.findingId);
    const title = finding ? finding.title : task.title;
    const quote = linkedFinding && linkedFinding.evidence ? linkedFinding.evidence.quote : '';
    const confirmedDate = finding && finding.date && finding.date.status === 'confirmed' ? { date: finding.date.date, time: finding.date.time } : null;
    const due = confirmedDate || (task && task.due) || null;
    const draft = {
      id: id('dft'),
      kind,
      findingId: finding ? finding.id : task.findingId || null,
      taskId: task ? task.id : null,
      sourceId: source ? source.id : null,
      subject: '',
      body: '',
      destination: null,
      event: null,
      status: 'needs_review',
      origin: 'template',
      notice: null,
      approval: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      demo: !!((finding || task).demo),
      history: [],
    };
    if (kind === 'email') {
      // Follow up with whoever the task is waiting on; only reuse the source's
      // address when that person is the one who sent it.
      const sender = (source && source.from) || { name: '', email: '' };
      const waitingOn = task && task.status === 'waiting' ? (task.waitingOn || '').trim() : '';
      const waitEmail = (/[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/.exec(waitingOn) || [''])[0];
      const isSender = !waitingOn || (sender.name && waitingOn.toLowerCase() === sender.name.toLowerCase()) || (sender.email && waitEmail.toLowerCase() === sender.email.toLowerCase());
      const recipientName = waitingOn ? waitingOn.replace(/<?[^\s<>@]+@[^\s<>@]+>?/, '').trim() || sender.name : sender.name;
      draft.destination = { type: 'email', to: isSender ? sender.email || waitEmail : waitEmail, name: recipientName || '' };
      let content = null;
      if (this.ai.available) {
        try {
          content = await draftWithAI(this.ai, { source, item: title, quote, recipient: recipientName, dueText: due ? formatDue(due, { long: true }) : '' });
          draft.origin = 'ai';
        } catch (err) {
          draft.notice = `AI drafting did not work (${err.message || 'unknown error'}), so this is a template draft.`;
        }
      }
      if (!content) content = templateEmail({ type: finding ? finding.type : 'task', title, quote, due, recipientName, sourceTitle: source ? source.title : '' });
      Object.assign(draft, content);
    } else if (kind === 'calendar') {
      if (!finding || !finding.date) throw new AppError(400, 'no_date', 'This finding has no date, so there is nothing to put on a calendar. Add a date first.');
      if (finding.date.status !== 'confirmed') throw new AppError(409, 'date_unconfirmed', 'Confirm the date on this finding before proposing a calendar event.');
      draft.destination = { type: 'calendar', label: 'Your calendar' };
      draft.subject = title;
      draft.event = { date: finding.date.date, time: finding.date.time || null, durationMinutes: 60, location: '' };
      draft.body = quote ? `From “${source ? source.title : 'a saved source'}”:\n${cleanQuote(quote)}` : '';
    } else if (kind === 'submission') {
      draft.destination = { type: 'submission', label: 'University course portal' };
      Object.assign(draft, templateSubmission({ title, quote, due }));
    } else {
      throw new AppError(400, 'bad_kind', 'Unknown draft type.');
    }
    draft.history.push({ at: nowIso(), text: draft.origin === 'ai' ? 'Drafted by AI — waiting for your review' : 'Drafted from a template — waiting for your review' });
    this.state.drafts.unshift(draft);
    if (finding && finding.status === 'new') finding.status = 'accepted';
    if (finding) this.log(finding, kind === 'email' ? 'Follow-up drafted' : kind === 'calendar' ? 'Calendar event proposed' : 'Submission prepared');
    this.save();
    return draft;
  }

  updateDraft(draftId, patch) {
    const d = this.get('drafts', draftId);
    if (d.status === 'completed') throw new AppError(409, 'locked', 'This draft is already marked as done and can no longer be edited.');
    let changed = false;
    const set = (obj, key, value) => {
      if (value !== undefined && value !== obj[key]) { obj[key] = value; changed = true; }
    };
    if (patch.subject !== undefined) set(d, 'subject', String(patch.subject).slice(0, 500));
    if (patch.body !== undefined) set(d, 'body', String(patch.body).slice(0, 100000));
    if (patch.destination) {
      if (d.destination.type === 'email') {
        if (patch.destination.to !== undefined) set(d.destination, 'to', String(patch.destination.to).trim().slice(0, 320));
        if (patch.destination.name !== undefined) set(d.destination, 'name', String(patch.destination.name).trim().slice(0, 200));
      } else if (patch.destination.label !== undefined) set(d.destination, 'label', String(patch.destination.label).trim().slice(0, 200));
    }
    if (patch.event && d.event) {
      if (patch.event.date !== undefined) {
        if (!isValidDate(patch.event.date)) throw new AppError(400, 'bad_date', 'Enter a valid date.');
        set(d.event, 'date', patch.event.date);
      }
      if (patch.event.time !== undefined) {
        if (patch.event.time && !isValidTime(patch.event.time)) throw new AppError(400, 'bad_time', 'Enter a valid time, or leave it empty.');
        set(d.event, 'time', patch.event.time || null);
      }
      if (patch.event.durationMinutes !== undefined) set(d.event, 'durationMinutes', Math.min(1440, Math.max(5, Number(patch.event.durationMinutes) || 60)));
      if (patch.event.location !== undefined) set(d.event, 'location', String(patch.event.location).slice(0, 300));
    }
    if (changed) {
      if (d.status === 'approved') {
        d.status = 'needs_review';
        d.approval = null;
        this.log(d, 'Edited after approval — approval withdrawn until you approve again');
      } else {
        const last = d.history[d.history.length - 1];
        if (last && last.text === 'Edited by you') last.at = nowIso();
        else this.log(d, 'Edited by you');
      }
      d.updatedAt = nowIso();
      this.save();
    }
    return d;
  }

  approveDraft(draftId) {
    const d = this.get('drafts', draftId);
    if (d.status === 'completed') throw new AppError(409, 'locked', 'This draft is already marked as done.');
    if (d.kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.destination.to)) {
      throw new AppError(400, 'no_recipient', 'Add the recipient’s email address before approving.');
    }
    if (!d.body.trim() && d.kind !== 'calendar') throw new AppError(400, 'empty', 'The draft is empty.');
    if (d.status !== 'approved') {
      d.status = 'approved';
      d.approval = { at: nowIso() };
      const dest = d.kind === 'email' ? `sending to ${d.destination.to}` : d.kind === 'calendar' ? `adding to ${d.destination.label} on ${formatDue(d.event)}` : `submission to ${d.destination.label}`;
      this.log(d, `Approved by you for ${dest}`);
      this.save();
    }
    return d;
  }

  completeDraft(draftId) {
    const d = this.get('drafts', draftId);
    if (d.status !== 'approved') throw new AppError(409, 'not_approved', 'Approve this draft before marking it as done.');
    d.status = 'completed';
    this.log(d, d.kind === 'email' ? 'Marked as sent by you' : d.kind === 'calendar' ? 'Marked as added to your calendar by you' : 'Marked as submitted by you');
    if (d.kind === 'email') {
      const who = d.destination.name || d.destination.to;
      const finding = this.find('findings', d.findingId);
      let task = this.find('tasks', d.taskId) || (finding ? this.find('tasks', finding.taskId) : null);
      if (!task) {
        task = this.newTask({ title: `Reply from ${who}: ${d.subject.replace(/^re:\s*/i, '')}`, findingId: d.findingId, sourceId: d.sourceId, demo: d.demo });
        task.history[0].text = 'Created when you sent a follow-up';
        d.taskId = task.id;
        if (finding && !finding.taskId) finding.taskId = task.id;
      }
      if (task.status !== 'done') {
        task.status = 'waiting';
        task.waitingOn = who;
        task.waitingSince = todayInDubai();
        this.log(task, `Follow-up sent — waiting on ${who}`);
      }
    }
    this.save();
    return d;
  }

  deleteDraft(draftId) {
    const d = this.get('drafts', draftId);
    this.state.drafts = this.state.drafts.filter((x) => x.id !== d.id);
    const finding = this.find('findings', d.findingId);
    if (finding) this.log(finding, 'A draft was discarded');
    this.save();
  }

  ics(draftId) {
    const d = this.get('drafts', draftId);
    if (d.kind !== 'calendar') throw new AppError(400, 'bad_kind', 'Only calendar drafts have a calendar file.');
    if (d.status !== 'approved' && d.status !== 'completed') throw new AppError(403, 'not_approved', 'Approve this calendar change first.');
    return buildIcs(d);
  }

  // ---- demo data -----------------------------------------------------------
  removeDemo() {
    for (const kind of ['sources', 'findings', 'tasks', 'drafts']) this.state[kind] = this.state[kind].filter((x) => !x.demo);
    this.save();
  }
}

export { formatDate };
