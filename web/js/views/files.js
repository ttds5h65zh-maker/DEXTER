// Files (upload, preview, organise, download) and Documents (drafts with approved wording).
import { h, clear, btn, fmtSize, fmtAgo, fmtDateTime, errorToast, toast, confirmDialog, empty, loading, debounce, dialog } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { on } from '../store.js';
import { renderMarkdown } from '../markdown.js';
import { loadProjects, projectSelect, projectLabel } from './common.js';

export function mount(container, ctx) {
  const page = h('div', { class: 'page' });
  container.append(page);
  const docs = ctx.params[0] === 'documents';
  page.append(h('div', { class: 'tabs', role: 'tablist' },
    h('a', { href: '#/files', class: docs ? '' : 'on', role: 'tab', 'aria-selected': String(!docs) }, 'Files'),
    h('a', { href: '#/files/documents', class: docs ? 'on' : '', role: 'tab', 'aria-selected': String(docs) }, 'Documents')));
  const body = h('div');
  page.append(body);
  if (docs) return ctx.params[1] ? mountEditor(body, ctx, ctx.params[1]) : mountDocList(body, ctx);
  return mountFiles(body, ctx, ctx.params[0] || null);
}

function fileIcon(mime) {
  if (mime.startsWith('image/')) return 'eye';
  if (mime.includes('word') || mime.includes('pdf') || mime.startsWith('text/')) return 'doc';
  return 'files';
}

function mountFiles(root, ctx, selectedId) {
  let folder = ''; let project = ''; let q = '';
  let selected = selectedId;
  const listEl = h('div', { class: 'card' });
  const panel = h('div', { class: 'panel' });
  const input = h('input', { type: 'file', multiple: true, hidden: true, onchange: (e) => { upload([...e.target.files]); e.target.value = ''; } });
  const drop = h('div', { class: 'dropzone', tabindex: '0', role: 'button', onclick: () => input.click(), onkeydown: (e) => { if (e.key === 'Enter') input.click(); } },
    icon('download', 18), h('div', {}, h('b', {}, 'Drop files here'), ' or click to upload — PDFs, Word documents, slides, images, text.'));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); upload([...e.dataTransfer.files]); });
  root.append(h('div', { class: 'split' }, h('div', { class: 'stack' }, drop, input, listEl), panel));

  async function upload(files) {
    for (const f of files) {
      try { await api.upload(f, { folder, project_id: project }); toast(`Uploaded ${f.name}`); } catch (err) { errorToast(err); }
    }
    render();
  }

  async function render() {
    let data = { files: [], folders: [] }; let projects = [];
    try {
      const qs = new URLSearchParams();
      if (folder) qs.set('folder', folder);
      if (project) qs.set('project_id', project);
      if (q) qs.set('q', q);
      [data, projects] = await Promise.all([api.get(`/api/files?${qs}`), loadProjects().catch(() => [])]);
    } catch (err) { errorToast(err); }
    clear(listEl);
    const folderSel = h('select', { class: 'select', style: { width: 'auto' }, 'aria-label': 'Folder', onchange: (e) => { folder = e.target.value; render(); } }, h('option', { value: '' }, 'All folders'), data.folders.map((f) => h('option', { value: f.folder }, `${f.folder} (${f.n})`)));
    folderSel.value = folder;
    const projSel = projectSelect(projects, project, { onChange: (v) => { project = v; render(); } });
    projSel.style.width = 'auto'; projSel.firstChild.textContent = 'All courses';
    listEl.append(h('div', { class: 'card-head', style: { flexWrap: 'wrap', justifyContent: 'flex-start' } }, folderSel, projSel,
      h('input', { class: 'input', type: 'search', placeholder: 'Search by name', value: q, style: { maxWidth: '200px' }, 'aria-label': 'Search files', oninput: debounce((e) => { q = e.target.value; render(); }, 250) })));
    if (!data.files.length) { listEl.append(empty('No files', folder || project || q ? 'Nothing matches these filters.' : 'Upload course material, or attach files in chat. Exports of your documents land here too.')); return; }
    const projMap = new Map(projects.map((p) => [p.id, p]));
    for (const f of data.files) {
      listEl.append(h('div', { class: `task-row${f.id === selected ? ' sel' : ''}`, tabindex: '0', role: 'button', onclick: () => select(f.id), onkeydown: (e) => { if (e.key === 'Enter') select(f.id); } },
        icon(fileIcon(f.mime), 16),
        h('div', { class: 'grow' }, h('div', { class: 't' }, f.name), h('div', { class: 'meta small' }, [fmtSize(f.size), f.folder, projMap.get(f.project_id) ? projectLabel(projMap.get(f.project_id)) : null, f.origin !== 'upload' ? f.origin : null, fmtAgo(f.created_at)].filter(Boolean).join(' · '))),
        h('a', { class: 'btn ghost sm icon', href: `/api/files/${f.id}/download`, title: 'Download', 'aria-label': `Download ${f.name}`, onclick: (e) => e.stopPropagation() }, icon('download', 15))));
    }
  }

  function select(id) {
    selected = id;
    history.replaceState(null, '', `#/files/${id}`);
    render();
    renderPanel();
  }

  async function renderPanel() {
    clear(panel);
    if (!selected) { panel.append(h('div', { class: 'card card-pad small muted' }, 'Select a file to preview it.')); return; }
    panel.append(h('div', { class: 'card' }, loading()));
    let f; let projects;
    try { f = (await api.get(`/api/files/${selected}`)).file; projects = await loadProjects().catch(() => []); } catch (err) { clear(panel); panel.append(h('div', { class: 'card card-pad' }, err.message)); return; }
    clear(panel);
    const preview = h('div', { class: 'card-body' });
    const kind = f.mime.startsWith('image/') && f.mime !== 'image/svg+xml' ? 'image' : f.mime === 'application/pdf' ? 'pdf' : f.previewable ? 'text' : 'none';
    if (kind === 'image') preview.append(h('img', { class: 'preview-img', src: `/api/files/${f.id}/preview`, alt: f.name }));
    else if (kind === 'pdf') preview.append(h('iframe', { class: 'preview-frame', src: `/api/files/${f.id}/preview`, title: f.name }));
    else if (kind === 'text') {
      preview.append(loading('Reading…'));
      api.get(`/api/files/${f.id}/preview`).then((r) => { clear(preview); preview.append(f.mime === 'text/markdown' ? renderMarkdown(r.text) : h('pre', { class: 'pre' }, r.text || '(empty)')); }).catch((e) => { clear(preview); preview.append(h('div', { class: 'small muted' }, e.message)); });
    } else preview.append(h('div', { class: 'empty' }, 'No preview for this file type. Download it to open.'));
    const name = h('input', { class: 'input', value: f.name, 'aria-label': 'File name', onchange: async (e) => { try { await api.patch(`/api/files/${f.id}`, { name: e.target.value }); render(); } catch (err) { errorToast(err); } } });
    const folderIn = h('input', { class: 'input', value: f.folder, placeholder: 'e.g. Readings', 'aria-label': 'Folder', onchange: async (e) => { try { await api.patch(`/api/files/${f.id}`, { folder: e.target.value }); render(); } catch (err) { errorToast(err); } } });
    const proj = projectSelect(projects, f.project_id, { onChange: async (v) => { try { await api.patch(`/api/files/${f.id}`, { project_id: v || null }); render(); } catch (err) { errorToast(err); } } });
    panel.append(h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', { class: 'small muted' }, `${f.mime} · ${fmtSize(f.size)} · ${fmtDateTime(f.created_at)}`),
        h('div', { class: 'btn-row' },
          h('a', { class: 'btn sm', href: `/api/files/${f.id}/download` }, icon('download', 14), 'Download'),
          f.conversation_id ? btn('', () => ctx.navigate(`#/chat/${f.conversation_id}`), { kind: 'ghost', ic: 'chat', title: 'Open conversation', size: 'sm' }) : null,
          btn('', async () => { if (await confirmDialog('Delete file?', `“${f.name}” will be permanently deleted from Dexter Almana.`, { confirmLabel: 'Delete', danger: true })) { await api.del(`/api/files/${f.id}`).catch(errorToast); selected = null; history.replaceState(null, '', '#/files'); render(); renderPanel(); } }, { kind: 'ghost', ic: 'trash', title: 'Delete file', size: 'sm' }))),
      h('div', { class: 'card-body' }, h('div', { class: 'field' }, h('label', {}, 'Name'), name), h('div', { class: 'grid-2' }, h('div', { class: 'field' }, h('label', {}, 'Folder'), folderIn), h('div', { class: 'field' }, h('label', {}, 'Course / project'), proj))),
      preview));
  }

  render(); renderPanel();
  const offs = [on('file.updated', debounce(render, 300)), on('file.deleted', debounce(render, 300))];
  return () => offs.forEach((f) => f());
}

function mountDocList(root, ctx) {
  const listEl = h('div', { class: 'card' });
  root.append(h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Documents'), h('p', {}, 'Drafts you and Dexter Almana write together. Approve wording to lock it — Dexter Almana cannot change locked passages.')),
    btn('New document', async () => {
      try { const { document } = await api.post('/api/documents', { title: 'Untitled document', content: '' }); ctx.navigate(`#/files/documents/${document.id}`); } catch (e) { errorToast(e); }
    }, { kind: 'primary', ic: 'plus' })), listEl);
  (async () => {
    listEl.append(loading());
    let docs = [];
    try { docs = (await api.get('/api/documents')).documents; } catch (e) { errorToast(e); }
    clear(listEl);
    if (!docs.length) { listEl.append(empty('No documents yet', 'Ask Dexter Almana to draft an essay, report or email — or start one here.')); return; }
    for (const d of docs) listEl.append(h('div', { class: 'task-row', tabindex: '0', role: 'button', onclick: () => ctx.navigate(`#/files/documents/${d.id}`), onkeydown: (e) => { if (e.key === 'Enter') ctx.navigate(`#/files/documents/${d.id}`); } },
      icon('doc', 16), h('div', { class: 'grow' }, h('div', { class: 't' }, d.title), h('div', { class: 'meta small' }, `v${d.version} · ${d.locked ? `${d.locked} approved passage(s) · ` : ''}updated ${fmtAgo(d.updated_at)}`))));
  })();
}

function mountEditor(root, ctx, id) {
  let doc; let versions = []; let dirty = false;
  root.append(loading());

  async function load() {
    try { ({ document: doc, versions } = await api.get(`/api/documents/${id}`)); } catch (err) { clear(root); root.append(empty('Document not found', err.message, btn('All documents', () => ctx.navigate('#/files/documents')))); return; }
    render();
  }

  function render() {
    clear(root);
    ctx.setTitle(doc.title);
    const title = h('input', { class: 'input', value: doc.title, style: { fontWeight: '620', fontSize: '16px', maxWidth: '520px' }, 'aria-label': 'Title', oninput: () => { dirty = true; status.textContent = 'Unsaved changes'; } });
    const ta = h('textarea', { class: 'textarea', value: doc.content, spellcheck: 'true', 'aria-label': 'Document text (Markdown)', placeholder: 'Write in Markdown: # Heading, **bold**, - lists…',
      oninput: () => { dirty = true; status.textContent = 'Unsaved changes'; drawPreview(); } });
    const previewEl = h('div', { class: 'card doc-preview' });
    const status = h('span', { class: 'small muted' }, `v${doc.version} · saved ${fmtAgo(doc.updated_at)}`);
    const drawPreview = debounce(() => { clear(previewEl); previewEl.append(renderMarkdown(ta.value, { highlights: doc.locked.map((l) => l.text) })); }, 120);
    const save = async () => {
      try {
        const r = await api.put(`/api/documents/${id}`, { title: title.value, content: ta.value, expected_version: doc.version });
        const released = doc.locked.length - r.document.locked.length;
        doc = r.document; dirty = false;
        status.textContent = `v${doc.version} · saved just now`;
        if (released > 0) toast(`Saved. ${released} approved passage(s) were edited by you, so they are no longer locked.`);
        versions = (await api.get(`/api/documents/${id}`)).versions;
        render();
      } catch (err) { errorToast(err); }
    };
    ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); } });
    const lockSel = async () => {
      const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      if (!sel.trim()) { toast('Select the passage in the editor first'); return; }
      if (dirty) await save();
      try { doc = (await api.post(`/api/documents/${id}/lock`, { text: sel })).document; toast('Wording approved and locked'); render(); } catch (err) { errorToast(err); }
    };
    const exp = (format) => async () => {
      if (dirty) await save();
      try { const { file } = await api.post(`/api/documents/${id}/export`, { format }); toast(h('span', {}, `Exported ${file.name}. `, h('a', { href: `/api/files/${file.id}/download` }, 'Download'))); } catch (err) { errorToast(err); }
    };
    root.append(
      h('div', { class: 'page-head' }, h('div', { style: { flex: '1', minWidth: '260px' } }, h('a', { href: '#/files/documents', class: 'small' }, '← Documents'), h('div', { style: { marginTop: '6px' } }, title)),
        h('div', { class: 'btn-row' }, status, btn('Save', save, { kind: 'primary', ic: 'check' }), btn('Approve selected wording', lockSel, { ic: 'lock' }),
          btn('Word', exp('docx'), { ic: 'download', title: 'Export .docx' }), btn('Markdown', exp('md'), { title: 'Export .md' }), btn('HTML', exp('html'), { title: 'Export .html' }),
          btn('', async () => { if (await confirmDialog('Delete document?', 'All versions will be deleted. Exported files stay in Files.', { confirmLabel: 'Delete', danger: true })) { await api.del(`/api/documents/${id}`).catch(errorToast); ctx.navigate('#/files/documents'); } }, { kind: 'ghost', ic: 'trash', title: 'Delete document' }))),
      h('div', { class: 'doc-editor' }, ta, previewEl),
      h('div', { class: 'grid-2', style: { marginTop: '16px' } },
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Approved wording'), h('div', { class: 'sub' }, 'Locked passages Dexter Almana must keep verbatim')),
          h('div', { class: 'card-body' }, doc.locked.length ? doc.locked.map((l) => h('div', { class: 'row', style: { alignItems: 'flex-start' } }, icon('lock', 15),
            h('div', { class: 'grow small' }, `“${l.text.length > 220 ? `${l.text.slice(0, 220)}…` : l.text}”`, h('div', { class: 'tiny muted' }, `Approved ${fmtAgo(l.approved_at)}`)),
            btn('Unlock', async () => { try { doc = (await api.post(`/api/documents/${id}/unlock`, { lock_id: l.id })).document; render(); } catch (e) { errorToast(e); } }, { size: 'sm' })))
            : h('div', { class: 'small muted' }, 'Select text in the editor and press “Approve selected wording” to lock it.'))),
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Version history')),
          h('div', { class: 'card-body' }, versions.map((v) => h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 't small' }, `v${v.version} · ${v.author === 'dexter' ? 'Dexter Almana' : 'You'}`), h('div', { class: 'tiny muted' }, `${v.note || ''} · ${fmtDateTime(v.created_at)}`)),
            v.version !== doc.version ? btn('View', async () => { try { const { version } = await api.get(`/api/documents/${id}/versions/${v.version}`); dialog({ title: `Version ${v.version}`, wide: true, body: renderMarkdown(version.content), actions: [{ label: 'Close' }, { label: 'Restore this version', kind: 'primary', onClick: async () => { ta.value = version.content; dirty = true; await save(); } }] }); } catch (e) { errorToast(e); } }, { size: 'sm' }) : h('span', { class: 'tag accent' }, 'current')))))));
    drawPreview();
  }

  load();
  const off = on('document.updated', (d) => { if (d.document?.id === id && !dirty && d.document.version !== doc?.version) load(); });
  const warn = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', warn);
  return () => { off(); window.removeEventListener('beforeunload', warn); };
}
