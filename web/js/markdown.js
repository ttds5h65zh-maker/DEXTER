// Safe Markdown → DOM renderer. Builds nodes directly (never innerHTML), so
// model output and external text cannot inject markup. Links are limited to
// http(s), mailto and in-app (#/...) targets.
const INLINE_SRC = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\n]+\*|_[^_\n]+_)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|(~~[^~\n]+~~)/g;

function safeHref(url) {
  const u = url.trim();
  if (/^https?:\/\//i.test(u) || /^mailto:/i.test(u)) return u;
  if (u.startsWith('#/')) return u;
  return null;
}

export function renderInline(text, { highlights = [] } = {}) {
  const frag = document.createDocumentFragment();
  let last = 0; let m;
  // A fresh regex per call: recursion (bold inside links etc.) must not share lastIndex.
  const INLINE = new RegExp(INLINE_SRC.source, 'g');
  const pushText = (t) => { if (t) frag.append(highlightText(t, highlights)); };
  while ((m = INLINE.exec(text))) {
    pushText(text.slice(last, m.index));
    const [tok] = m;
    if (m[1]) { const c = document.createElement('code'); c.textContent = tok.slice(1, -1); frag.append(c); }
    else if (m[2]) { const b = document.createElement('strong'); b.append(renderInline(tok.slice(2, -2), { highlights })); frag.append(b); }
    else if (m[3]) { const i = document.createElement('em'); i.append(renderInline(tok.slice(1, -1), { highlights })); frag.append(i); }
    else if (m[4]) {
      const lm = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      const href = lm && safeHref(lm[2]);
      if (href) {
        const a = document.createElement('a');
        a.href = href; a.textContent = lm[1];
        if (!href.startsWith('#')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
        frag.append(a);
      } else pushText(tok);
    } else if (m[5]) {
      const a = document.createElement('a');
      a.href = tok; a.textContent = tok; a.target = '_blank'; a.rel = 'noopener noreferrer';
      frag.append(a);
    } else if (m[6]) { const s = document.createElement('del'); s.textContent = tok.slice(2, -2); frag.append(s); }
    last = m.index + tok.length;
  }
  pushText(text.slice(last));
  return frag;
}

function highlightText(t, highlights) {
  if (!highlights.length) return document.createTextNode(t);
  const frag = document.createDocumentFragment();
  let rest = t;
  outer: while (rest) {
    for (const hl of highlights) {
      const i = hl && rest.indexOf(hl);
      if (hl && i >= 0) {
        if (i) frag.append(document.createTextNode(rest.slice(0, i)));
        const mk = document.createElement('mark'); mk.className = 'locked'; mk.title = 'Approved wording (locked)'; mk.textContent = hl;
        frag.append(mk);
        rest = rest.slice(i + hl.length);
        continue outer;
      }
    }
    frag.append(document.createTextNode(rest));
    break;
  }
  return frag;
}

function isTableSep(line) { return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line); }
function cells(line) { return line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()); }

export function renderMarkdown(src, opts = {}) {
  const root = document.createElement('div');
  root.className = 'md';
  const lines = String(src ?? '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  const el = (tag, text) => { const e = document.createElement(tag); if (text !== undefined) e.append(renderInline(text, opts)); return e; };
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      const pre = document.createElement('pre'); const code = document.createElement('code');
      const buf = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      code.textContent = buf.join('\n'); pre.append(code); root.append(pre);
      continue;
    }
    const hm = line.match(/^(#{1,4})\s+(.*)$/);
    if (hm) { root.append(el(`h${Math.min(hm[1].length + 1, 4)}`, hm[2])); i++; continue; }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { root.append(document.createElement('hr')); i++; continue; }
    if (/^\s*>/.test(line)) {
      const bq = document.createElement('blockquote'); const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      bq.append(renderMarkdown(buf.join('\n'), opts)); root.append(bq);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const table = document.createElement('table'); const thead = document.createElement('thead'); const tr = document.createElement('tr');
      for (const c of cells(line)) tr.append(el('th', c));
      thead.append(tr); table.append(thead);
      const tbody = document.createElement('tbody'); i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const r = document.createElement('tr');
        for (const c of cells(lines[i])) r.append(el('td', c));
        tbody.append(r); i++;
      }
      table.append(tbody); root.append(table);
      continue;
    }
    const lm = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (lm) {
      const ordered = /\d/.test(lm[2]);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      while (i < lines.length) {
        const m2 = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!m2) {
          if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && list.lastChild) { list.lastChild.append(document.createTextNode(' '), renderInline(lines[i].trim(), opts)); i++; continue; }
          break;
        }
        if (m2[1].length >= 2 && list.lastChild) {
          let sub = list.lastChild.querySelector(':scope > ul, :scope > ol');
          if (!sub) { sub = document.createElement(/\d/.test(m2[2]) ? 'ol' : 'ul'); list.lastChild.append(sub); }
          const li = el('li', m2[3]); sub.append(li);
        } else {
          const t = m2[3];
          const li = document.createElement('li');
          const task = t.match(/^\[( |x)\]\s+(.*)$/i);
          if (task) { li.append(task[1].trim() ? '☑ ' : '☐ ', renderInline(task[2], opts)); } else li.append(renderInline(t, opts));
          list.append(li);
        }
        i++;
      }
      root.append(list);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*```|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) buf.push(lines[i++]);
    if (!buf.length) buf.push(lines[i++]); // always make progress
    const p = document.createElement('p');
    buf.forEach((b, idx) => { if (idx) p.append(document.createElement('br')); p.append(renderInline(b, opts)); });
    root.append(p);
  }
  return root;
}
