// Projects and AUS courses, including weighted grade tracking.
import { newId } from '../lib/ids.js';
import { now } from '../db.js';
import { badRequest, notFound } from '../lib/http.js';
import { parseDateTimeInput } from '../lib/time.js';

const KINDS = ['course', 'project'];

export function computeGrade(items) {
  const graded = items.filter((i) => i.score != null && i.max_score > 0);
  const totalWeight = items.reduce((s, i) => s + (Number(i.weight) || 0), 0);
  const gradedWeight = graded.reduce((s, i) => s + (Number(i.weight) || 0), 0);
  const earned = graded.reduce((s, i) => s + (Number(i.weight) || 0) * (i.score / i.max_score), 0);
  return {
    total_weight: round(totalWeight),
    graded_weight: round(gradedWeight),
    earned_points: round(earned),
    current_percent: gradedWeight > 0 ? round((earned / gradedWeight) * 100) : null,
    remaining_weight: round(Math.max(0, totalWeight - gradedWeight)),
    weights_sum_to_100: Math.abs(totalWeight - 100) < 0.01,
  };
}

function round(n) { return Math.round(n * 100) / 100; }

export function createProjectService(app) {
  const { db, bus } = app;
  const tz = () => app.settings.timezone();

  function get(id) { return db.get('SELECT * FROM projects WHERE id = ?', id); }
  function mustGet(id) {
    const p = get(id);
    if (!p) throw notFound('Project');
    return p;
  }

  const FIELDS = ['name', 'kind', 'code', 'term', 'instructor', 'credits', 'description', 'requirements', 'archived'];

  function create(input) {
    const name = String(input.name || '').trim();
    if (!name) throw badRequest('Name is required');
    const kind = input.kind || 'course';
    if (!KINDS.includes(kind)) throw badRequest('kind must be course or project');
    const p = { id: newId('proj'), name: name.slice(0, 160), kind, code: input.code || null, term: input.term || null, instructor: input.instructor || null,
      credits: input.credits != null && input.credits !== '' ? Number(input.credits) : null, description: input.description || null, requirements: input.requirements || null,
      archived: 0, created_at: now(), updated_at: now() };
    db.run(`INSERT INTO projects (id, name, kind, code, term, instructor, credits, description, requirements, archived, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, p.id, p.name, p.kind, p.code, p.term, p.instructor, p.credits, p.description, p.requirements, 0, p.created_at, p.updated_at);
    bus.publish('project.updated', { project: get(p.id) });
    return get(p.id);
  }

  function update(id, patch) {
    mustGet(id);
    const fields = {};
    for (const k of FIELDS) {
      if (patch[k] === undefined) continue;
      if (k === 'kind' && !KINDS.includes(patch.kind)) throw badRequest('kind must be course or project');
      if (k === 'name' && !String(patch.name).trim()) throw badRequest('Name cannot be empty');
      fields[k] = k === 'archived' ? (patch[k] ? 1 : 0) : k === 'credits' ? (patch[k] === '' || patch[k] == null ? null : Number(patch[k])) : patch[k];
    }
    if (!Object.keys(fields).length) return get(id);
    fields.updated_at = now();
    const keys = Object.keys(fields);
    db.run(`UPDATE projects SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => fields[k]), id);
    bus.publish('project.updated', { project: get(id) });
    return get(id);
  }

  function remove(id) {
    mustGet(id);
    db.run('DELETE FROM projects WHERE id = ?', id);
    bus.publish('project.deleted', { id });
  }

  function list({ include_archived = false } = {}) {
    const rows = db.all(`SELECT p.*, (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status NOT IN ('completed','cancelled','failed')) AS open_tasks,
      (SELECT COUNT(*) FROM files f WHERE f.project_id = p.id) AS file_count
      FROM projects p ${include_archived ? '' : 'WHERE archived = 0'} ORDER BY kind, code, name`);
    return rows.map((p) => ({ ...p, grade: computeGrade(gradeItems(p.id)) }));
  }

  function gradeItems(projectId) {
    return db.all('SELECT * FROM grade_items WHERE project_id = ? ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at, created_at', projectId);
  }

  function parseDue(due) {
    if (due === undefined) return undefined;
    if (!due) return null;
    const p = parseDateTimeInput(due, tz(), { defaultTime: '23:59' });
    if (!p) throw badRequest(`Could not understand due date "${due}"`);
    return p.date.toISOString();
  }

  function addGradeItem(projectId, input) {
    mustGet(projectId);
    const name = String(input.name || '').trim();
    if (!name) throw badRequest('Grade item name is required');
    const weight = Number(input.weight ?? 0);
    const max = Number(input.max_score ?? 100);
    if (!(weight >= 0 && weight <= 100)) throw badRequest('weight must be between 0 and 100 (percent of final grade)');
    if (!(max > 0)) throw badRequest('max_score must be positive');
    const score = input.score === undefined || input.score === null || input.score === '' ? null : Number(input.score);
    if (score != null && !(score >= 0)) throw badRequest('score must be 0 or more');
    const g = { id: newId('grade'), project_id: projectId, name, weight, score, max_score: max, due_at: parseDue(input.due ?? input.due_at) ?? null, notes: input.notes || null, created_at: now(), updated_at: now() };
    db.run('INSERT INTO grade_items (id, project_id, name, weight, score, max_score, due_at, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      g.id, g.project_id, g.name, g.weight, g.score, g.max_score, g.due_at, g.notes, g.created_at, g.updated_at);
    bus.publish('project.updated', { project: get(projectId) });
    return db.get('SELECT * FROM grade_items WHERE id = ?', g.id);
  }

  function updateGradeItem(id, patch) {
    const before = db.get('SELECT * FROM grade_items WHERE id = ?', id);
    if (!before) throw notFound('Grade item');
    const fields = {};
    if (patch.name !== undefined) fields.name = String(patch.name).trim() || before.name;
    if (patch.weight !== undefined) {
      const w = Number(patch.weight);
      if (!(w >= 0 && w <= 100)) throw badRequest('weight must be between 0 and 100');
      fields.weight = w;
    }
    if (patch.max_score !== undefined) {
      const m = Number(patch.max_score);
      if (!(m > 0)) throw badRequest('max_score must be positive');
      fields.max_score = m;
    }
    if (patch.score !== undefined) fields.score = patch.score === null || patch.score === '' ? null : Number(patch.score);
    if (patch.due !== undefined || patch.due_at !== undefined) fields.due_at = parseDue(patch.due ?? patch.due_at);
    if (patch.notes !== undefined) fields.notes = patch.notes;
    if (!Object.keys(fields).length) return before;
    fields.updated_at = now();
    const keys = Object.keys(fields);
    db.run(`UPDATE grade_items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => fields[k]), id);
    bus.publish('project.updated', { project: get(before.project_id) });
    return db.get('SELECT * FROM grade_items WHERE id = ?', id);
  }

  function removeGradeItem(id) {
    const g = db.get('SELECT * FROM grade_items WHERE id = ?', id);
    if (!g) throw notFound('Grade item');
    db.run('DELETE FROM grade_items WHERE id = ?', id);
    bus.publish('project.updated', { project: get(g.project_id) });
  }

  function detail(id) {
    const project = mustGet(id);
    const items = gradeItems(id);
    return {
      project,
      grade_items: items,
      grade: computeGrade(items),
      tasks: app.tasks.list({ project_id: id }),
      files: app.files.list({ project_id: id }),
      documents: app.documents.list({ project_id: id }),
      conversations: db.all('SELECT id, title, updated_at FROM conversations WHERE project_id = ? ORDER BY updated_at DESC LIMIT 20', id),
    };
  }

  return { create, update, remove, list, get, mustGet, detail, gradeItems, addGradeItem, updateGradeItem, removeGradeItem };
}
