// A small, dependency-free PDF text reader.
// It handles the common case — text PDFs exported from a browser, a word
// processor or LaTeX — and says so plainly when it cannot read a file
// (scanned pages, encrypted files, unusual encodings).

import zlib from 'node:zlib';

export class PdfError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set('()<>[]{}/%'.split('').map((c) => c.charCodeAt(0)));
const isWs = (c) => WS.has(c);
const isDelim = (c) => DELIM.has(c);

class Ref {
  constructor(num) { this.num = num; }
}
class Name {
  constructor(name) { this.name = name; }
}
class Op {
  constructor(op) { this.op = op; }
}

/** Tokenising parser for PDF object syntax, working on a latin1 string. */
class Parser {
  constructor(s, pos = 0) {
    this.s = s;
    this.pos = pos;
  }
  skip() {
    const s = this.s;
    for (;;) {
      const c = s.charCodeAt(this.pos);
      if (isWs(c)) this.pos++;
      else if (c === 37) { // %
        while (this.pos < s.length && s[this.pos] !== '\n' && s[this.pos] !== '\r') this.pos++;
      } else break;
    }
  }
  /** Parse one object. Bare keywords come back as Op (used for content streams). */
  parse() {
    this.skip();
    const s = this.s;
    if (this.pos >= s.length) return undefined;
    const ch = s[this.pos];
    if (ch === '/') {
      let e = this.pos + 1;
      while (e < s.length && !isWs(s.charCodeAt(e)) && !isDelim(s.charCodeAt(e))) e++;
      const raw = s.slice(this.pos + 1, e).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      this.pos = e;
      return new Name(raw);
    }
    if (ch === '(') return this.literalString();
    if (ch === '<') {
      if (s[this.pos + 1] === '<') return this.dict();
      const e = s.indexOf('>', this.pos);
      let hex = s.slice(this.pos + 1, e).replace(/[^0-9a-fA-F]/g, '');
      if (hex.length % 2) hex += '0';
      this.pos = e + 1;
      let out = '';
      for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
      return { str: out };
    }
    if (ch === '[') {
      this.pos++;
      const arr = [];
      for (;;) {
        this.skip();
        if (this.pos >= s.length) break;
        if (s[this.pos] === ']') { this.pos++; break; }
        const v = this.parse();
        if (v === undefined) break;
        arr.push(v);
      }
      return arr;
    }
    if (ch === ']' || ch === '>' || ch === ')' || ch === '{' || ch === '}') {
      this.pos += s[this.pos + 1] === '>' && ch === '>' ? 2 : 1;
      return new Op(ch);
    }
    // number, reference or keyword
    let e = this.pos;
    while (e < s.length && !isWs(s.charCodeAt(e)) && !isDelim(s.charCodeAt(e))) e++;
    const tok = s.slice(this.pos, e);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) {
      // look ahead for "N G R"
      if (/^\d+$/.test(tok)) {
        const m = /^\s+(\d+)\s+R(?![A-Za-z0-9])/.exec(s.slice(e, e + 24));
        if (m) {
          this.pos = e + m[0].length;
          return new Ref(Number(tok));
        }
      }
      this.pos = e;
      return Number(tok);
    }
    this.pos = Math.max(e, this.pos + 1);
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    return new Op(tok);
  }
  dict() {
    this.pos += 2;
    const d = {};
    const s = this.s;
    for (;;) {
      this.skip();
      if (this.pos >= s.length) break;
      if (s[this.pos] === '>' && s[this.pos + 1] === '>') { this.pos += 2; break; }
      const k = this.parse();
      if (!(k instanceof Name)) continue;
      const v = this.parse();
      d[k.name] = v;
    }
    return d;
  }
  literalString() {
    const s = this.s;
    let depth = 1;
    let out = '';
    this.pos++;
    while (this.pos < s.length && depth > 0) {
      const c = s[this.pos++];
      if (c === '\\') {
        const n = s[this.pos++];
        if (n === 'n') out += '\n';
        else if (n === 'r') out += '\r';
        else if (n === 't') out += '\t';
        else if (n === 'b') out += '\b';
        else if (n === 'f') out += '\f';
        else if (n === '\r') { if (s[this.pos] === '\n') this.pos++; } else if (n === '\n') { /* line continuation */ } else if (/[0-7]/.test(n)) {
          let oct = n;
          while (oct.length < 3 && /[0-7]/.test(s[this.pos])) oct += s[this.pos++];
          out += String.fromCharCode(parseInt(oct, 8) & 255);
        } else out += n;
      } else if (c === '(') { depth++; out += c; } else if (c === ')') { depth--; if (depth > 0) out += c; } else out += c;
    }
    return { str: out };
  }
}

function ascii85(buf) {
  const s = buf.toString('latin1');
  const out = [];
  let i = s.startsWith('<~') ? 2 : 0;
  let group = [];
  const emit = (g, n) => {
    let v = 0;
    for (const d of g) v = v * 85 + d;
    const bytes = [Math.floor(v / 16777216) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    for (let k = 0; k < n; k++) out.push(bytes[k]);
  };
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 126) break; // "~>" ends the data
    if (isWs(c)) continue;
    if (c === 122 && group.length === 0) { out.push(0, 0, 0, 0); continue; } // "z" is four zero bytes
    if (c < 33 || c > 117) return null;
    group.push(c - 33);
    if (group.length === 5) { emit(group, 4); group = []; }
  }
  if (group.length === 1) return null;
  if (group.length) {
    const n = group.length - 1;
    while (group.length < 5) group.push(84);
    emit(group, n);
  }
  return Buffer.from(out);
}

function inflate(buf) {
  try {
    return zlib.inflateSync(buf);
  } catch {
    try {
      return zlib.inflateSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    } catch {
      try { return zlib.inflateRawSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch { return null; }
    }
  }
}

class Doc {
  constructor(buf) {
    this.buf = buf;
    this.s = buf.toString('latin1');
    this.objs = new Map(); // num -> { value, streamStart, streamEnd }
    this.unsupported = new Set(); // stream filters Dexter cannot decode
    this.scan();
  }
  scan() {
    const s = this.s;
    const re = /(?:^|[\s>])(\d+)\s+(\d+)\s+obj(?![A-Za-z])/g;
    let m;
    while ((m = re.exec(s))) {
      const num = Number(m[1]);
      const p = new Parser(s, re.lastIndex);
      let value;
      try { value = p.parse(); } catch { continue; }
      const entry = { value };
      const after = /^\s*stream(\r\n|\n|\r)/.exec(s.slice(p.pos, p.pos + 20));
      if (after && value && typeof value === 'object' && !Array.isArray(value)) {
        const start = p.pos + after[0].length;
        let end = -1;
        if (typeof value.Length === 'number' && /^\s*endstream/.test(s.slice(start + value.Length, start + value.Length + 14))) end = start + value.Length;
        if (end < 0) {
          end = s.indexOf('endstream', start);
          if (end < 0) continue;
          if (s[end - 1] === '\n') end--;
          if (s[end - 1] === '\r') end--;
        }
        entry.streamStart = start;
        entry.streamEnd = end;
        re.lastIndex = end;
      }
      this.objs.set(num, entry);
    }
    // Trailer dictionaries, classic or as cross-reference streams.
    this.trailers = [];
    for (const t of s.matchAll(/trailer\s*(?=<<)/g)) {
      try { this.trailers.push(new Parser(s, t.index + t[0].length).parse()); } catch { /* ignore */ }
    }
    for (const o of this.objs.values()) {
      if (o.value && o.value.Type instanceof Name && o.value.Type.name === 'XRef') this.trailers.push(o.value);
    }
    this.trailers = this.trailers.filter((d) => d && typeof d === 'object' && !Array.isArray(d));
    // Encrypted files name an /Encrypt dictionary in a trailer.
    if (/\/Encrypt\b/.test(s)) {
      if (this.trailers.some((d) => d.Encrypt !== undefined)) {
        throw new PdfError('encrypted', 'This PDF is encrypted, so Dexter cannot read its text. If it opens without a password, print it to a new PDF (Print → Save as PDF) and upload that, or copy the text and paste it as a note.');
      }
    }
    // objects stored inside compressed object streams
    for (const entry of [...this.objs.values()]) {
      const v = entry.value;
      if (!v || !(v.Type instanceof Name) || v.Type.name !== 'ObjStm' || entry.streamStart === undefined) continue;
      const data = this.streamData(entry);
      if (!data) continue;
      const text = data.toString('latin1');
      const n = this.resolve(v.N) || 0;
      const first = this.resolve(v.First) || 0;
      const head = new Parser(text, 0);
      const pairs = [];
      for (let i = 0; i < n; i++) {
        const num = head.parse();
        const off = head.parse();
        if (typeof num !== 'number' || typeof off !== 'number') break;
        pairs.push([num, off]);
      }
      for (const [num, off] of pairs) {
        if (this.objs.has(num) && this.objs.get(num).streamStart !== undefined) continue;
        try { this.objs.set(num, { value: new Parser(text, first + off).parse() }); } catch { /* skip */ }
      }
    }
  }
  /** The document title from its metadata, when it is a real title rather than a file name. */
  title() {
    for (const t of [...this.trailers].reverse()) {
      const info = this.resolve(t.Info);
      const raw = info && this.resolve(info.Title);
      if (!raw || raw.str === undefined) continue;
      let title = raw.str.startsWith('þÿ') ? utf16be(raw.str.slice(2)) : raw.str;
      title = title.replace(/^microsoft (?:word|powerpoint|excel) - /i, '').replace(/\.(docx?|pptx?|xlsx?|odt|pdf|html?)$/i, '').replace(/\s+/g, ' ').trim();
      if (title && !/^(untitled|document\d*|slide \d+|\(?anonymous\)?)$/i.test(title) && /[A-Za-z؀-ۿ]/.test(title)) return title.slice(0, 200);
    }
    return '';
  }
  resolve(v, depth = 0) {
    while (v instanceof Ref && depth++ < 20) {
      const o = this.objs.get(v.num);
      v = o ? o.value : null;
    }
    return v;
  }
  entryOf(v) {
    return v instanceof Ref ? this.objs.get(v.num) : null;
  }
  streamData(entry) {
    if (!entry || entry.streamStart === undefined) return null;
    if (entry.data !== undefined) return entry.data;
    let data = this.buf.subarray(entry.streamStart, entry.streamEnd);
    let filters = this.resolve(entry.value.Filter);
    if (filters && !Array.isArray(filters)) filters = [filters];
    for (const f of filters || []) {
      const name = this.resolve(f)?.name;
      if (name === 'FlateDecode' || name === 'Fl') data = inflate(data);
      else if (name === 'ASCII85Decode' || name === 'A85') data = ascii85(data);
      else if (name === 'ASCIIHexDecode' || name === 'AHx') data = Buffer.from(data.toString('latin1').replace(/[^0-9a-fA-F]/g, ''), 'hex');
      else {
        this.unsupported.add(name || 'unknown');
        data = null;
      }
      if (!data) break;
    }
    entry.data = data;
    return data;
  }
  pages() {
    const out = [];
    const seen = new Set();
    const walk = (node, inherited) => {
      const d = this.resolve(node);
      if (!d || typeof d !== 'object' || seen.has(d)) return;
      seen.add(d);
      const res = d.Resources !== undefined ? d.Resources : inherited;
      const kids = this.resolve(d.Kids);
      if (Array.isArray(kids)) kids.forEach((k) => walk(k, res));
      else if (d.Contents !== undefined || (d.Type instanceof Name && d.Type.name === 'Page')) out.push({ dict: d, resources: res });
    };
    for (const o of this.objs.values()) {
      if (o.value && o.value.Type instanceof Name && o.value.Type.name === 'Catalog') walk(o.value.Pages, undefined);
    }
    if (!out.length) {
      for (const o of this.objs.values()) {
        if (o.value && o.value.Type instanceof Name && o.value.Type.name === 'Page') out.push({ dict: o.value, resources: o.value.Resources });
      }
    }
    return out;
  }
}

const CP1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
const GLYPHS = {
  space: ' ', quotesingle: "'", quoteleft: '‘', quoteright: '’', quotedblleft: '“', quotedblright: '”', bullet: '•', endash: '–', emdash: '—',
  hyphen: '-', period: '.', comma: ',', colon: ':', semicolon: ';', fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl', ellipsis: '…', minus: '−',
};

function utf16be(str) {
  let out = '';
  for (let i = 0; i + 1 < str.length; i += 2) out += String.fromCharCode((str.charCodeAt(i) << 8) | str.charCodeAt(i + 1));
  return out;
}

function parseCMap(text) {
  const map = new Map();
  let bytes = 0;
  const cs = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(text);
  if (cs) bytes = cs[1].length / 2;
  const hexToStr = (h) => utf16be(h.replace(/../g, (b) => String.fromCharCode(parseInt(b, 16))));
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      map.set(parseInt(m[1], 16), hexToStr(m[2]));
      if (!bytes) bytes = m[1].length / 2;
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]*)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (!bytes) bytes = m[1].length / 2;
      if (hi - lo > 70000) continue;
      if (m[3] !== undefined) {
        const base = hexToStr(m[3]);
        const head = base.slice(0, -1);
        const last = base.charCodeAt(base.length - 1) || 0;
        for (let c = lo; c <= hi; c++) map.set(c, head + String.fromCharCode(last + c - lo));
      } else {
        const items = [...m[4].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => hexToStr(x[1]));
        for (let c = lo; c <= hi && c - lo < items.length; c++) map.set(c, items[c - lo]);
      }
    }
  }
  return { map, bytes: bytes || 1 };
}

function loadFont(doc, fontRef) {
  const f = doc.resolve(fontRef) || {};
  const font = { bytes: 1, map: null, widths: null, defaultWidth: 0, diffs: null };
  const subtype = f.Subtype instanceof Name ? f.Subtype.name : '';
  const tu = doc.entryOf(f.ToUnicode);
  if (tu) {
    const data = doc.streamData(tu);
    if (data) {
      const cm = parseCMap(data.toString('latin1'));
      font.map = cm.map;
      font.bytes = cm.bytes;
    }
  }
  if (subtype === 'Type0') {
    font.bytes = 2;
    const desc = doc.resolve((doc.resolve(f.DescendantFonts) || [])[0]) || {};
    font.defaultWidth = typeof doc.resolve(desc.DW) === 'number' ? doc.resolve(desc.DW) : 1000;
    const w = doc.resolve(desc.W);
    if (Array.isArray(w)) {
      font.widths = new Map();
      for (let i = 0; i < w.length;) {
        const a = doc.resolve(w[i]);
        const b = doc.resolve(w[i + 1]);
        if (Array.isArray(b)) {
          b.forEach((x, k) => font.widths.set(a + k, doc.resolve(x)));
          i += 2;
        } else {
          const width = doc.resolve(w[i + 2]);
          for (let c = a; c <= b && c - a < 70000; c++) font.widths.set(c, width);
          i += 3;
        }
      }
    } else font.widths = new Map();
  } else {
    const widths = doc.resolve(f.Widths);
    const first = doc.resolve(f.FirstChar) || 0;
    if (Array.isArray(widths)) {
      font.widths = new Map();
      widths.forEach((x, k) => font.widths.set(first + k, doc.resolve(x)));
    }
    const enc = doc.resolve(f.Encoding);
    const diffs = enc && doc.resolve(enc.Differences);
    if (Array.isArray(diffs)) {
      font.diffs = new Map();
      let code = 0;
      for (const item of diffs) {
        if (typeof item === 'number') code = item;
        else if (item instanceof Name) {
          const g = item.name;
          const uni = /^uni([0-9A-Fa-f]{4})$/.exec(g);
          const ch = GLYPHS[g] || (uni ? String.fromCharCode(parseInt(uni[1], 16)) : g.length === 1 ? g : null);
          if (ch) font.diffs.set(code, ch);
          code++;
        }
      }
    }
  }
  return font;
}

const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const IDENT = [1, 0, 0, 1, 0, 0];

function pageText(doc, page) {
  let contents = doc.resolve(page.dict.Contents);
  const refs = Array.isArray(contents) ? contents : [page.dict.Contents];
  const chunks = [];
  for (const r of refs) {
    const data = doc.streamData(doc.entryOf(r));
    if (data) chunks.push(data.toString('latin1'));
  }
  const stream = chunks.join('\n');
  if (!stream) return '';
  const resources = doc.resolve(page.resources) || {};
  const fontDict = doc.resolve(resources.Font) || {};
  const fonts = new Map();
  const getFont = (name) => {
    if (!fonts.has(name)) fonts.set(name, loadFont(doc, fontDict[name]));
    return fonts.get(name);
  };

  let out = '';
  let ctm = IDENT;
  const stack = [];
  let tm = IDENT;
  let tlm = IDENT;
  let font = { bytes: 1, map: null, widths: null, defaultWidth: 0 };
  let size = 12;
  let leading = 0;
  let charSpace = 0;
  let wordSpace = 0;
  let hScale = 1;
  let last = null; // { x, y, size } where the previous run ended, in page space
  let moved = false;

  const show = (str) => {
    const trm = mul(tm, ctm);
    const fs = Math.abs(size * Math.hypot(trm[2], trm[3])) || Math.abs(size) || 1;
    const x = trm[4];
    const y = trm[5];
    let text = '';
    let advance = 0;
    const step = font.bytes === 2 ? 2 : 1;
    for (let i = 0; i + step <= str.length; i += step) {
      const code = step === 2 ? (str.charCodeAt(i) << 8) | str.charCodeAt(i + 1) : str.charCodeAt(i);
      let ch;
      if (font.map && font.map.has(code)) ch = font.map.get(code);
      else if (font.diffs && font.diffs.has(code)) ch = font.diffs.get(code);
      else if (step === 1) ch = code >= 0x80 && code <= 0x9f ? CP1252[code - 0x80] : code < 32 ? '' : String.fromCharCode(code);
      else ch = '';
      // A multi-letter right-to-left glyph (lam-alef) is kept in reverse here so that
      // reordering the line into reading order turns it the right way round.
      if (ch.length > 1 && RTL_CHAR.test(ch)) ch = [...ch].reverse().join('');
      text += ch;
      const w = font.widths ? font.widths.get(code) ?? (font.defaultWidth || 500) : 500;
      advance += ((w / 1000) * size + charSpace + (step === 1 && code === 32 ? wordSpace : 0)) * hScale;
    }
    if (text) {
      if (last) {
        const dy = Math.abs(y - last.y);
        const ref = Math.max(fs, last.size);
        if (dy > ref * 0.6) out += dy > ref * 1.9 ? '\n\n' : '\n';
        else if (!/\s$/.test(out) && !/^\s/.test(text)) {
          const gap = x - last.x;
          if (font.widths ? gap > ref * 0.18 || gap < -ref : moved) out += ' ';
        }
      }
      out += text;
    }
    tm = mul([1, 0, 0, 1, advance, 0], tm);
    const end = mul(tm, ctm);
    if (text) last = { x: end[4], y: end[5], size: fs };
    moved = false;
  };

  const p = new Parser(stream, 0);
  let args = [];
  for (;;) {
    let tok;
    try { tok = p.parse(); } catch { break; }
    if (tok === undefined) break;
    if (!(tok instanceof Op)) { args.push(tok); continue; }
    const a = args;
    args = [];
    switch (tok.op) {
      case 'q': stack.push(ctm); break;
      case 'Q': if (stack.length) ctm = stack.pop(); break;
      case 'cm': if (a.length >= 6) ctm = mul(a.slice(-6), ctm); break;
      case 'BT': tm = IDENT; tlm = IDENT; break;
      case 'Tf': if (a[0] instanceof Name) font = getFont(a[0].name); if (typeof a[1] === 'number') size = a[1]; break;
      case 'TL': leading = a[0] || 0; break;
      case 'Tc': charSpace = a[0] || 0; break;
      case 'Tw': wordSpace = a[0] || 0; break;
      case 'Tz': hScale = (a[0] || 100) / 100; break;
      case 'Td': tlm = mul([1, 0, 0, 1, a[0] || 0, a[1] || 0], tlm); tm = tlm; moved = true; break;
      case 'TD': leading = -(a[1] || 0); tlm = mul([1, 0, 0, 1, a[0] || 0, a[1] || 0], tlm); tm = tlm; moved = true; break;
      case 'Tm': if (a.length >= 6) { tlm = a.slice(-6); tm = tlm; moved = true; } break;
      case 'T*': tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm; moved = true; break;
      case 'Tj': if (a[0] && a[0].str !== undefined) show(a[0].str); break;
      case "'": tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm; if (a[0] && a[0].str !== undefined) show(a[0].str); break;
      case '"': tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm; if (a[2] && a[2].str !== undefined) show(a[2].str); break;
      case 'TJ':
        for (const item of Array.isArray(a[0]) ? a[0] : []) {
          if (typeof item === 'number') {
            tm = mul([1, 0, 0, 1, (-item / 1000) * size * hScale, 0], tm);
            if (!font.widths && item < -180 && out && !/\s$/.test(out)) out += ' ';
          } else if (item && item.str !== undefined) show(item.str);
        }
        break;
      case 'BI': { // skip inline image data
        const e = stream.indexOf('EI', p.pos);
        if (e > 0) p.pos = e + 2;
        break;
      }
      default: break;
    }
  }
  return out
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map(visualToLogical).join('\n')
    // ligatures (ﬁ, ﬃ) and Arabic presentation forms become ordinary letters
    .replace(/[ﬀ-ﬆﭐ-﷿ﹰ-ﻼ]/g, (c) => c.normalize('NFKC'))
    // re-join lines that were only broken by the page width
    .replace(/([^\n]{55,})\n(?!\n)/g, '$1 ')
    .trim();
}

// ---------------------------------------------------------------------------
// Right-to-left text. PDFs draw Arabic and Hebrew glyphs left to right in the
// order they appear on the page, which is the reverse of reading order.
// ---------------------------------------------------------------------------
const RTL_CHAR = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/;
const LTR_CHAR = /[A-Za-zÀ-ɏ0-9]/;
const dirOf = (c) => (RTL_CHAR.test(c) ? 'R' : LTR_CHAR.test(c) ? 'L' : 'N');

/** Reverse each run of `dir` characters; neutrals between two such characters belong to the run. */
function reverseRuns(chars, dir) {
  const out = [];
  let i = 0;
  while (i < chars.length) {
    if (dirOf(chars[i]) !== dir) { out.push(chars[i]); i++; continue; }
    let last = i;
    let j = i + 1;
    for (; j < chars.length; j++) {
      const d = dirOf(chars[j]);
      if (d === dir) last = j;
      else if (d !== 'N') break;
    }
    out.push(...chars.slice(i, last + 1).reverse());
    i = last + 1;
  }
  return out;
}

/** Turn one line from drawing order into reading order. */
export function visualToLogical(line) {
  if (!RTL_CHAR.test(line)) return line;
  const chars = [...line];
  const rtl = chars.filter((c) => RTL_CHAR.test(c)).length;
  const latin = chars.filter((c) => /[A-Za-zÀ-ɏ]/.test(c)).length;
  // Mostly right-to-left: read the whole line backwards, keeping numbers and Latin words as written.
  if (rtl >= latin) return reverseRuns(chars.reverse(), 'L').join('').trim();
  // Mostly left-to-right with a few Arabic words: turn just those words around.
  return reverseRuns(chars, 'R').join('');
}

/**
 * Extract text from a PDF. Returns { text, pages: [{ number, start, end }] }
 * where start/end are character offsets of each page inside `text`.
 */
export function extractPdfText(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || buf.subarray(0, 1024).indexOf('%PDF-') < 0) {
    throw new PdfError('not_pdf', 'That file does not look like a PDF.');
  }
  const doc = new Doc(buf);
  const pages = doc.pages();
  if (!pages.length) throw new PdfError('unreadable', 'Dexter could not find any pages in this PDF.');
  let text = '';
  const index = [];
  pages.forEach((page, i) => {
    let t = '';
    try { t = pageText(doc, page); } catch { t = ''; }
    if (text) text += '\n\n';
    const start = text.length;
    text += t;
    index.push({ number: i + 1, start, end: text.length });
  });
  const letters = (text.match(/[A-Za-z؀-ۿ]/g) || []).length;
  if (letters < 20 && doc.unsupported.size) {
    throw new PdfError('unsupported', `This PDF stores its text in a format Dexter cannot read (${[...doc.unsupported].join(', ')}). Copy the text from your PDF viewer and paste it as a note instead.`);
  }
  if (letters < 20) {
    throw new PdfError('no_text', 'Dexter found no selectable text in this PDF. It may be a scan. Paste the text instead, or export the file with a text layer.');
  }
  return { text, pages: index, title: doc.title() };
}
