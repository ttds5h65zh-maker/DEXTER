// Courses & projects: requirements, weighted grades, tasks, files, documents.
import { h, clear, btn, fmtWhen, fmtSize, fmtAgo, errorToast, toast, confirmDialog, empty, loading, debounce, dialog, toLocalInput } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { on } from '../store.js';
import { taskStatus, loadProjects } from './common.js';

export function mount(container, ctx) {
  const page = h('div', { class: 'page' });
  container.append(page);
  const id = ctx.params[0];
  return id ? mountDetail(page, ctx, id) : mountList(page, ctx);
}

function courseForm(p = {}) {
  const f = {};
  const field = (key, label, attrs = {}) => { f[key] = h(attrs.textarea ? 'textarea' : 'input', { class: attrs.textarea ? 'textarea' : 'input', value: p[key] ?? '', placeholder: attrs.placeholder || '', type: attrs.type || null }); return h('div', { class: 'field' }, h('label', {}, label), f[key]); };
  f.kind = h('select', { class: 'select' }, h('option', { value: 'course' }, 'Course'), h('option', { value: 'project' }, 'Project'));
  f.kind.value = p.kind || 'course';
  const el = h('div', {},
    h('div', { class: 'grid-2' }, field('code', 'Course code', { placeholder: 'MIS 320' }), h('div', { class: 'field' }, h('label', {}, 'Type'), f.kind)),
    field('name', 'Name', { placeholder: 'Business Analytics' }),
    h('div', { class: 'grid-3' }, field('term', 'Term', { placeholder: 'Fall 2026' }), field('instructor', 'Instructor'), field('credits', 'Credits', { type: 'number' })),
    field('description', 'Description', { textarea: true }), field('requirements', 'Requirements / syllabus notes', { textarea: true }));
  const values = () => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.value]));
  return { el, values };
}

function mountList(page, ctx) {
  const grid = h('div', { class: 'cards' });
  page.append(h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Courses & projects'), h('p', {}, 'AUS coursework, requirements, grades and assignment drafts in one place.')),
    btn('New course', () => {
      const form = courseForm();
      dialog({ title: 'New course or project', wide: true, body: form.el, actions: [{ label: 'Cancel' }, { label: 'Create', kind: 'primary', onClick: async () => {
        try { const { project } = await api.post('/api/projects', form.values()); await loadProjects(true); ctx.navigate(`#/projects/${project.id}`); } catch (err) { errorToast(err); return true; }
      } }] });
    }, { kind: 'primary', ic: 'plus' })), grid);

  async function render() {
    clear(grid); grid.append(loading());
    let projects = [];
    try { projects = await loadProjects(true); } catch (err) { errorToast(err); }
    clear(grid);
    if (!projects.length) { grid.append(h('div', { class: 'card', style: { gridColumn: '1 / -1' } }, empty('No courses yet', 'Add your AUS courses for this term — or paste a syllabus into chat and Dexter will set the course up with its grading breakdown.'))); return; }
    for (const p of projects) {
      const g = p.grade;
      grid.append(h('a', { class: 'card card-pad', href: `#/projects/${p.id}`, style: { color: 'inherit', textDecoration: 'none', display: 'block' } },
        h('div', { class: 'small muted' }, [p.code, p.term].filter(Boolean).join(' · ') || p.kind),
        h('h2', { style: { margin: '4px 0 12px' } }, p.name),
        h('div', { class: 'stats' },
          h('div', { class: 'stat' }, h('div', { class: 'v' }, g.current_percent != null ? `${g.current_percent}%` : '—'), h('div', { class: 'l' }, g.current_percent != null ? `on ${g.graded_weight}% graded` : 'no grades yet')),
          h('div', { class: 'stat' }, h('div', { class: 'v' }, String(p.open_tasks)), h('div', { class: 'l' }, 'open tasks')),
          h('div', { class: 'stat' }, h('div', { class: 'v' }, String(p.file_count)), h('div', { class: 'l' }, 'files')))));
    }
  }
  render();
  const off = on('project.updated', debounce(render, 300));
  return () => off();
}

function mountDetail(page, ctx, id) {
  let tab = ctx.query.get('tab') || 'overview';
  page.append(loading());
  let d;

  async function load() {
    try { d = await api.get(`/api/projects/${id}`); } catch (err) { clear(page); page.append(empty(err.status === 404 ? 'Course not found' : 'Could not load', err.message, btn('All courses', () => ctx.navigate('#/projects')))); return; }
    render();
  }

  function render() {
    clear(page);
    const p = d.project;
    ctx.setTitle(p.code || p.name);
    page.append(h('div', { class: 'page-head' },
      h('div', {}, h('a', { href: '#/projects', class: 'small' }, '← Courses'), h('h1', { style: { marginTop: '4px' } }, `${p.code ? `${p.code} · ` : ''}${p.name}`), h('p', {}, [p.term, p.instructor, p.credits ? `${p.credits} credits` : null].filter(Boolean).join(' · ') || p.kind)),
      h('div', { class: 'btn-row' },
        btn('Chat about this', async () => { try { const { conversation } = await api.post('/api/conversations', { title: `${p.code || p.name}`, project_id: p.id }); ctx.navigate(`#/chat/${conversation.id}`); } catch (e) { errorToast(e); } }, { ic: 'chat' }),
        btn('Edit', () => {
          const form = courseForm(p);
          dialog({ title: 'Edit course', wide: true, body: form.el, actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: async () => { try { await api.patch(`/api/projects/${p.id}`, form.values()); await loadProjects(true); load(); } catch (e) { errorToast(e); return true; } } }] });
        }, { ic: 'edit' }),
        btn('', async () => { if (await confirmDialog('Delete course?', 'The course and its grade items are deleted. Tasks, files and documents are kept but unlinked.', { confirmLabel: 'Delete', danger: true })) { await api.del(`/api/projects/${p.id}`).catch(errorToast); await loadProjects(true); ctx.navigate('#/projects'); } }, { kind: 'ghost', ic: 'trash', title: 'Delete course' }))));
    const tabs = [['overview', 'Overview'], ['grades', `Grades`], ['tasks', `Tasks (${d.tasks.filter((t) => !['completed', 'cancelled'].includes(t.status)).length})`], ['files', `Files & documents (${d.files.length + d.documents.length})`]];
    page.append(h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([k, l]) => h('button', { type: 'button', role: 'tab', class: k === tab ? 'on' : '', 'aria-selected': String(k === tab), onclick: () => { tab = k; history.replaceState(null, '', `#/projects/${id}?tab=${k}`); render(); } }, l))));
    const body = h('div');
    page.append(body);
    if (tab === 'overview') renderOverview(body);
    if (tab === 'grades') renderGrades(body);
    if (tab === 'tasks') renderTasks(body);
    if (tab === 'files') renderFiles(body);
  }

  function renderOverview(body) {
    const p = d.project; const g = d.grade;
    body.append(h('div', { class: 'today-grid' },
      h('div', { class: 'stack' },
        h('div', { class: 'card card-pad' }, h('h3', {}, 'Description'), h('p', { class: 'small', style: { whiteSpace: 'pre-wrap', marginTop: '6px' } }, p.description || 'No description yet.')),
        h('div', { class: 'card card-pad' }, h('h3', {}, 'Requirements'), h('p', { class: 'small', style: { whiteSpace: 'pre-wrap', marginTop: '6px' } }, p.requirements || 'Paste syllabus requirements via Edit, or ask Dexter to extract them from the syllabus.'))),
      h('div', { class: 'stack' },
        h('div', { class: 'card card-pad' }, h('h3', {}, 'Grade so far'), h('div', { class: 'stats', style: { marginTop: '10px' } },
          h('div', { class: 'stat' }, h('div', { class: 'v' }, g.current_percent != null ? `${g.current_percent}%` : '—'), h('div', { class: 'l' }, 'weighted average of graded work')),
          h('div', { class: 'stat' }, h('div', { class: 'v' }, `${g.graded_weight}%`), h('div', { class: 'l' }, `of ${g.total_weight}% graded`))),
        !g.weights_sum_to_100 && d.grade_items.length ? h('div', { class: 'banner warn small', style: { marginTop: '10px' } }, icon('alert', 16), `Weights add up to ${g.total_weight}%, not 100%. Check the syllabus.`) : null),
        h('div', { class: 'card card-pad' }, h('h3', {}, 'Next up'), (() => {
          const next = d.tasks.filter((t) => t.due_at && !['completed', 'cancelled'].includes(t.status)).slice(0, 5);
          return next.length ? h('div', {}, next.map((t) => h('div', { class: 'row clickable', onclick: () => ctx.navigate(`#/tasks/${t.id}`) }, h('div', { class: 'grow' }, h('div', { class: 't small' }, t.title), h('div', { class: 'meta' }, fmtWhen(t.due_at))), taskStatus(t.status)))) : h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'No upcoming deadlines.');
        })()))));
  }

  function renderGrades(body) {
    const g = d.grade;
    const table = h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ['Assessment', 'Weight %', 'Score', 'Out of', 'Due', ''].map((x) => h('th', {}, x)))));
    const tb = h('tbody');
    const patch = async (gid, body2) => { try { await api.patch(`/api/grades/${gid}`, body2); load(); } catch (e) { errorToast(e); } };
    for (const it of d.grade_items) {
      tb.append(h('tr', {},
        h('td', {}, h('input', { class: 'input', value: it.name, 'aria-label': 'Name', onchange: (e) => patch(it.id, { name: e.target.value }) })),
        h('td', {}, h('input', { class: 'input', type: 'number', step: '0.5', value: it.weight, style: { width: '80px' }, 'aria-label': 'Weight', onchange: (e) => patch(it.id, { weight: Number(e.target.value) }) })),
        h('td', {}, h('input', { class: 'input', type: 'number', step: '0.5', value: it.score ?? '', placeholder: '—', style: { width: '80px' }, 'aria-label': 'Score', onchange: (e) => patch(it.id, { score: e.target.value === '' ? null : Number(e.target.value) }) })),
        h('td', {}, h('input', { class: 'input', type: 'number', value: it.max_score, style: { width: '80px' }, 'aria-label': 'Out of', onchange: (e) => patch(it.id, { max_score: Number(e.target.value) }) })),
        h('td', {}, h('input', { class: 'input', type: 'datetime-local', value: toLocalInput(it.due_at), 'aria-label': 'Due', onchange: (e) => patch(it.id, { due: e.target.value || '' }) })),
        h('td', {}, btn('', async () => { await api.del(`/api/grades/${it.id}`).catch(errorToast); load(); }, { kind: 'ghost', ic: 'trash', title: 'Remove', size: 'sm' }))));
    }
    const nm = h('input', { class: 'input', placeholder: 'e.g. Midterm exam', 'aria-label': 'New assessment name' });
    const wt = h('input', { class: 'input', type: 'number', placeholder: '%', style: { width: '80px' }, 'aria-label': 'New weight' });
    const sc = h('input', { class: 'input', type: 'number', placeholder: '—', style: { width: '80px' }, 'aria-label': 'New score' });
    const mx = h('input', { class: 'input', type: 'number', value: '100', style: { width: '80px' }, 'aria-label': 'New out of' });
    const du = h('input', { class: 'input', type: 'datetime-local', 'aria-label': 'New due' });
    tb.append(h('tr', {}, h('td', {}, nm), h('td', {}, wt), h('td', {}, sc), h('td', {}, mx), h('td', {}, du), h('td', {}, btn('Add', async () => {
      try { await api.post(`/api/projects/${id}/grades`, { name: nm.value, weight: Number(wt.value || 0), score: sc.value === '' ? null : Number(sc.value), max_score: Number(mx.value || 100), due: du.value || undefined }); load(); } catch (e) { errorToast(e); }
    }, { size: 'sm', kind: 'primary' }))));
    table.append(tb);
    body.append(h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Grade breakdown'), h('div', { class: 'sub' }, g.current_percent != null ? `Current: ${g.current_percent}% (${g.earned_points} of ${g.graded_weight} points earned so far)` : 'Enter scores as they come in')),
      h('div', { class: 'table-wrap' }, table),
      !g.weights_sum_to_100 && d.grade_items.length ? h('div', { class: 'card-body' }, h('div', { class: 'banner warn small' }, icon('alert', 16), `Weights total ${g.total_weight}%.`)) : null));
  }

  function renderTasks(body) {
    const title = h('input', { class: 'input', placeholder: `New task for ${d.project.code || d.project.name}`, 'aria-label': 'Task title' });
    const due = h('input', { class: 'input', placeholder: 'Due (e.g. 12 nov 23:59)', 'aria-label': 'Due' });
    body.append(h('form', { class: 'card card-pad', style: { marginBottom: '16px' }, onsubmit: async (e) => {
      e.preventDefault(); if (!title.value.trim()) return;
      try { await api.post('/api/tasks', { title: title.value, due: due.value || undefined, project_id: id }); load(); } catch (err) { errorToast(err); }
    } }, h('div', { class: 'task-form' }, title, due, btn('Add', null, { kind: 'primary', type: 'submit' }))));
    const card = h('div', { class: 'card' });
    if (!d.tasks.length) card.append(empty('No tasks for this course'));
    for (const t of d.tasks) card.append(h('div', { class: 'task-row', onclick: () => ctx.navigate(`#/tasks/${t.id}`) }, h('div', { class: 'grow' }, h('div', { class: 't' }, t.title), h('div', { class: 'meta small' }, t.due_at ? `Due ${fmtWhen(t.due_at, { allDay: !t.due_has_time })}` : 'No due date')), taskStatus(t.status)));
    body.append(card);
  }

  function renderFiles(body) {
    const input = h('input', { type: 'file', multiple: true, hidden: true, onchange: async (e) => {
      for (const f of e.target.files) { try { await api.upload(f, { project_id: id }); toast(`Uploaded ${f.name}`); } catch (err) { errorToast(err); } }
      load();
    } });
    const files = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Files'), btn('Upload', () => input.click(), { size: 'sm', ic: 'plus' })), input);
    if (!d.files.length) files.append(empty('No files', 'Upload syllabi, slides, readings or past assignments.'));
    for (const f of d.files) files.append(h('div', { class: 'task-row', onclick: () => ctx.navigate(`#/files/${f.id}`) }, icon('files', 16), h('div', { class: 'grow' }, h('div', { class: 't' }, f.name), h('div', { class: 'meta small' }, `${fmtSize(f.size)} · ${fmtAgo(f.created_at)}`))));
    const docs = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Documents & drafts'), btn('New document', async () => {
      try { const { document } = await api.post('/api/documents', { title: `${d.project.code || d.project.name} draft`, content: '', project_id: id }); ctx.navigate(`#/files/documents/${document.id}`); } catch (e) { errorToast(e); }
    }, { size: 'sm', ic: 'plus' })));
    if (!d.documents.length) docs.append(empty('No documents', 'Assignment drafts Dexter writes for this course appear here.'));
    for (const x of d.documents) docs.append(h('div', { class: 'task-row', onclick: () => ctx.navigate(`#/files/documents/${x.id}`) }, icon('doc', 16), h('div', { class: 'grow' }, h('div', { class: 't' }, x.title), h('div', { class: 'meta small' }, `v${x.version} · ${x.locked ? `${x.locked} approved passage(s) · ` : ''}${fmtAgo(x.updated_at)}`))));
    body.append(h('div', { class: 'stack' }, files, docs));
  }

  load();
  const off = on('project.updated', debounce(() => { if (tab !== 'grades') load(); }, 300));
  return () => off();
}
