// Markdown → .docx export and .docx → text extraction, without dependencies.
import { writeZip, readZip } from './zip.js';
import { decodeEntities } from './text.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function runsFromInline(text) {
  // Supports **bold**, *italic* / _italic_, `code` and [label](url) (rendered as "label (url)").
  const out = [];
  const re = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|`([^`]+)`|\[([^\]]+)\]\((https?:[^)\s]+)\))/g;
  let last = 0; let m;
  const push = (t, props = '') => {
    if (!t) return;
    out.push(`<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>`);
  };
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index));
    if (m[2] || m[3]) push(m[2] || m[3], '<w:b/>');
    else if (m[4] || m[5]) push(m[4] || m[5], '<w:i/>');
    else if (m[6]) push(m[6], '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/>');
    else if (m[7]) { push(m[7], '<w:color w:val="0F5F59"/><w:u w:val="single"/>'); push(` (${m[8]})`); }
    last = m.index + m[0].length;
  }
  push(text.slice(last));
  return out.join('');
}

function para(text, style, extra = '') {
  const pPr = style || extra ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extra}</w:pPr>` : '';
  return `<w:p>${pPr}${runsFromInline(text)}</w:p>`;
}

export function markdownToDocxXml(markdown) {
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  const body = [];
  let buf = [];
  let inCode = false; let code = [];
  const flush = () => {
    if (buf.length) { body.push(para(buf.join(' '), null)); buf = []; }
  };
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inCode) {
        for (const c of code) body.push(`<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr><w:r><w:t xml:space="preserve">${esc(c)}</w:t></w:r></w:p>`);
        code = []; inCode = false;
      } else { flush(); inCode = true; }
      continue;
    }
    if (inCode) { code.push(line); continue; }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { flush(); body.push(para(h[2], h[1].length === 1 ? 'Heading1' : h[1].length === 2 ? 'Heading2' : 'Heading3')); continue; }
    const b = line.match(/^\s*[-*+]\s+(.*)$/);
    if (b) { flush(); body.push(para(b[1], 'ListParagraph', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>')); continue; }
    const n = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (n) { flush(); body.push(para(n[1], 'ListParagraph', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>')); continue; }
    const q = line.match(/^>\s?(.*)$/);
    if (q) { flush(); body.push(para(q[1], 'Quote')); continue; }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) { flush(); body.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BBBBBB"/></w:pBdr></w:pPr></w:p>'); continue; }
    if (!line.trim()) { flush(); continue; }
    buf.push(line.trim());
  }
  flush();
  if (inCode) for (const c of code) body.push(`<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr><w:r><w:t xml:space="preserve">${esc(c)}</w:t></w:r></w:p>`);
  return body.join('');
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="288" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/><w:color w:val="16181D"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="320" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:color w:val="16181D"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/><w:color w:val="16181D"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="23"/><w:color w:val="2B2F36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="567"/></w:pPr><w:rPr><w:i/><w:color w:val="555B66"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="19"/></w:rPr></w:style>
</w:styles>`;

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

export function markdownToDocx(title, markdown, { author = 'Dexter' } = {}) {
  const body = (title ? para(title, 'Title') : '') + markdownToDocxXml(markdown);
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title || '')}</dc:title><dc:creator>${esc(author)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created></cp:coreProperties>`;
  return writeZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/_rels/document.xml.rels', data: DOC_RELS },
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'word/numbering.xml', data: NUMBERING },
    { name: 'docProps/core.xml', data: core },
  ]);
}

export function docxToText(buf) {
  const zip = readZip(buf);
  const xml = zip.read('word/document.xml');
  if (!xml) throw new Error('Not a Word document (word/document.xml missing)');
  const s = xml.toString('utf8');
  const paras = [];
  const pRe = /<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g;
  let m;
  while ((m = pRe.exec(s))) {
    const p = m[0];
    let text = '';
    const tRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g;
    let t;
    while ((t = tRe.exec(p))) {
      if (t[0] === '<w:tab/>') text += '\t';
      else if (t[0] === '<w:br/>') text += '\n';
      else text += decodeEntities(t[1]);
    }
    const isList = /<w:numPr>/.test(p);
    const heading = p.match(/<w:pStyle w:val="(Heading(\d)|Title)"/);
    if (heading && text) text = `${'#'.repeat(heading[2] ? Number(heading[2]) : 1)} ${text}`;
    else if (isList && text) text = `- ${text}`;
    paras.push(text);
  }
  return paras.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
