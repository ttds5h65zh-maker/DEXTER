// Text extraction (PDF text layer, OCR for scans/photos) and field parsing.
// Everything read from a document is treated as plain data: it is only ever parsed with the
// patterns below and shown for review. Nothing in a document can trigger an action.
import path from 'node:path';
import { createRequire } from 'node:module';
import { all, DATA_DIR } from './db.js';
import { parseDate, parseNumber, DATE_RE, nameOverlap, toMinor } from './util.js';

const require = createRequire(import.meta.url);

export function sniffMime(buf, filename = '') {
  const h = buf.subarray(0, 12);
  if (h.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (h[0] === 0x89 && h.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (h[0] === 0xff && h[1] === 0xd8) return 'image/jpeg';
  if (h.subarray(0, 4).toString('latin1') === 'RIFF' && h.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (h.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (h.subarray(4, 8).toString('latin1') === 'ftyp' && /heic|heif|mif1/.test(h.subarray(8, 12).toString('latin1'))) return 'image/heic';
  if (h[0] === 0x50 && h[1] === 0x4b) return /\.xlsx$/i.test(filename) ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/zip';
  if (/\.(csv|tsv|txt)$/i.test(filename) && !buf.subarray(0, 2000).includes(0)) return 'text/csv';
  return 'application/octet-stream';
}
export const VIEWABLE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const DOCUMENT_TYPES = new Set([...VIEWABLE, 'image/heic']);

// ---- OCR (tesseract.js, runs locally; language data ships with the npm package) ----
let workerPromise = null;
let queue = Promise.resolve();
async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      const langs = (process.env.OCR_LANGS || 'eng').split('+');
      const local = langs.length === 1 && langs[0] === 'eng';
      const opts = { cachePath: path.join(DATA_DIR, 'ocr-cache') };
      if (local) {
        opts.langPath = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
        opts.gzip = true;
      } else if (process.env.OCR_LANG_PATH) opts.langPath = process.env.OCR_LANG_PATH;
      return createWorker(langs, 1, opts);
    })();
    workerPromise.catch(() => { workerPromise = null; });
  }
  return workerPromise;
}
async function ocr(image) {
  const job = queue.then(async () => {
    const worker = await getWorker();
    const { data } = await worker.recognize(image);
    return { text: data.text || '', confidence: (data.confidence || 0) / 100 };
  });
  queue = job.catch(() => {});
  return job;
}
export async function shutdownOcr() {
  if (workerPromise) { const w = await workerPromise.catch(() => null); workerPromise = null; await w?.terminate(); }
}

async function pdfText(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  for (let n = 1; n <= Math.min(doc.numPages, 30); n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const lines = new Map(); // group text runs by baseline
    for (const it of content.items) {
      if (!it.str) continue;
      const y = Math.round(it.transform[5] / 3);
      if (!lines.has(y)) lines.set(y, []);
      lines.get(y).push({ x: it.transform[4], s: it.str });
    }
    pages.push([...lines.entries()].sort((a, b) => b[0] - a[0]).map(([, runs]) => runs.sort((a, b) => a.x - b.x).map((r) => r.s).join(' ').replace(/\s+/g, ' ').trim()).join('\n'));
  }
  let text = pages.join('\n').trim();
  let method = 'pdf-text';
  let confidence = 1;
  if (text.replace(/\s/g, '').length < 20) {
    // Scanned PDF: render the first pages and OCR them.
    const { createCanvas } = await import('@napi-rs/canvas');
    const parts = [];
    const confs = [];
    for (let n = 1; n <= Math.min(doc.numPages, 3); n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvasContext: canvas.getContext('2d'), viewport, canvas }).promise;
      const r = await ocr(canvas.toBuffer('image/png'));
      parts.push(r.text);
      confs.push(r.confidence);
    }
    text = parts.join('\n').trim();
    method = 'ocr';
    confidence = confs.length ? Math.min(...confs) : 0;
  }
  const pageCount = doc.numPages;
  await task.destroy();
  return { text, method, confidence, pages: pageCount };
}

/** Returns { text, method: 'pdf-text' | 'ocr' | 'none', confidence 0..1, error? } and never throws. */
export async function extractText(buf, mime) {
  try {
    if (process.env.DEXTER_OCR === 'off' && mime !== 'application/pdf') return { text: '', method: 'none', confidence: 0, error: 'OCR is switched off (DEXTER_OCR=off).' };
    if (mime === 'application/pdf') return await pdfText(buf);
    if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) return { ...(await ocr(buf)), method: 'ocr' };
    if (mime === 'image/heic') return { text: '', method: 'none', confidence: 0, error: 'HEIC photos cannot be read automatically. Enter the fields by hand, or set the phone camera to JPEG.' };
    return { text: '', method: 'none', confidence: 0 };
  } catch (e) {
    return { text: '', method: 'none', confidence: 0, error: `Could not read this file automatically (${e.message}).` };
  }
}

// ---- field parsing ----
const CURRENCIES = ['AED', 'USD', 'EUR', 'GBP', 'SAR', 'QAR', 'KWD', 'BHD', 'OMR', 'INR', 'PKR', 'EGP', 'CHF', 'JPY', 'CAD', 'AUD'];
const MONEY = /(?:(AED|USD|EUR|GBP|SAR|QAR|KWD|BHD|OMR|INR|Dhs?\.?|Dirhams?|\$|€|£)\s*)?(\(?\d{1,3}(?:[,\s]\d{3})*(?:\.\d{1,3})?\)?|\d+(?:\.\d{1,3})?)(?:\s*(AED|USD|EUR|GBP|SAR|QAR|KWD|BHD|OMR|INR|Dhs?\.?|Dirhams?))?/gi;
const curCode = (s) => {
  if (!s) return null;
  const u = s.toUpperCase().replace(/\./g, '');
  if (CURRENCIES.includes(u)) return u;
  if (/^DH|^DIRHAM/.test(u)) return 'AED';
  return { $: 'USD', '€': 'EUR', '£': 'GBP' }[s] || null;
};
const AMOUNT_KEYS = [
  [/amount\s+due|total\s+due|balance\s+due|total\s+payable|net\s+payable|amount\s+payable|total\s+amount\s+due|statement\s+balance|pay\s+this\s+amount/i, 0.92],
  [/grand\s+total|invoice\s+total|total\s+amount|total\s+incl|total\s*\(/i, 0.86],
  [/(?<!sub)(?<!sub\s)(?<!sub-)\btotal\b/i, 0.74],
  [/\bamount\b|\bbalance\b/i, 0.6],
];

function moneyOnLine(line) {
  const found = [];
  for (const m of line.matchAll(MONEY)) {
    const n = parseNumber(m[2]);
    if (n == null || n <= 0) continue;
    const cur = curCode(m[1]) || curCode(m[3]);
    const hasDecimals = /\.\d{2,3}\)?$/.test(m[2]);
    if (!cur && !hasDecimals && !/,/.test(m[2])) continue; // bare integers are usually ids, quantities or years
    found.push({ n, cur, raw: m[0].trim() });
  }
  return found;
}

function findDateNear(lines, idx) {
  for (const j of [idx, idx + 1]) {
    const line = lines[j];
    if (!line) continue;
    for (const m of line.matchAll(DATE_RE)) {
      const d = parseDate(m[1].replace(/,/g, ' ').replace(/\s+/g, ' '));
      if (d) return { ...d, raw: m[1] };
    }
  }
  return null;
}

/**
 * Pull invoice fields out of raw text. Each field is { value, confidence (0..1), note }.
 * Anything under 0.7 is shown as "uncertain" in the review screen.
 */
export function parseFields(text, { baseCurrency = 'AED', ocrConfidence = 1, knownNames = [] } = {}) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const scale = (c) => Math.round(Math.max(0, Math.min(1, c * (0.5 + 0.5 * ocrConfidence))) * 100) / 100;
  const field = (value, confidence, note) => ({ value: value ?? null, confidence: value == null ? 0 : scale(confidence), note: note || null });
  const out = {};

  // amount + currency
  let best = null;
  lines.forEach((line, i) => {
    for (const [re, conf] of AMOUNT_KEYS) {
      if (!re.test(line)) continue;
      const monies = [...moneyOnLine(line), ...(moneyOnLine(line).length ? [] : moneyOnLine(lines[i + 1] || ''))];
      if (!monies.length) continue;
      const pick = monies[monies.length - 1];
      if (!best || conf > best.conf || (conf === best.conf && pick.n > best.n)) best = { ...pick, conf, line };
      break;
    }
  });
  if (!best) {
    const every = lines.flatMap((l) => moneyOnLine(l).map((m) => ({ ...m, line: l })));
    if (every.length) best = { ...every.reduce((a, b) => (b.n > a.n ? b : a)), conf: 0.4 };
  }
  const anyCur = best?.cur || lines.map((l) => moneyOnLine(l).find((m) => m.cur)?.cur).find(Boolean) || (text.match(new RegExp(`\\b(${CURRENCIES.join('|')})\\b`)) || [])[1];
  const currency = anyCur || baseCurrency;
  out.currency = field(currency, anyCur ? (best?.cur ? 0.92 : 0.8) : 0.5, anyCur ? null : `No currency found, assumed ${baseCurrency}`);
  out.amount = best ? field(toMinor(best.n, currency), best.conf, best.conf <= 0.4 ? 'Largest amount on the page; no "total" label found' : `From “${best.line.slice(0, 80)}”`) : field(null, 0, 'No amount found');

  // reference
  let ref = null;
  for (const line of lines) {
    const m = line.match(/\b(?:tax\s+)?(invoice|inv|bill|receipt|statement|reference|ref|document|doc|account|a\/c)\.?\s*(?:no|number|num|nr|#|id)?\.?\s*[:#-]?\s*([A-Z0-9][A-Z0-9\-\/]{2,24})\b/i);
    if (!m || !/\d/.test(m[2]) || parseDate(m[2])) continue;
    const conf = /^(invoice|inv|bill|receipt)$/i.test(m[1]) ? 0.88 : /^(account|a\/c)$/i.test(m[1]) ? 0.55 : 0.72;
    if (!ref || conf > ref.conf) ref = { v: m[2], conf, line };
  }
  out.reference = ref ? field(ref.v, ref.conf, `From “${ref.line.slice(0, 80)}”`) : field(null, 0, 'No reference found');

  // dates
  const dated = (re) => {
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) { const d = findDateNear(lines, i); if (d) return d; }
    return null;
  };
  const due = dated(/due\s*date|payment\s+due|pay\s+by|due\s+on|due\s+by|\bdue\b/i);
  const issue = dated(/invoice\s+date|issue\s+date|bill\s+date|date\s+of\s+issue|statement\s+date|issued|^date\b|\bdated\b/i);
  const dateField = (d, conf, label) => (d ? field(d.value, d.ambiguous ? Math.min(conf, 0.65) : conf, d.ambiguous ? `“${d.raw}” read as day/month — check the order` : null) : field(null, 0, `No ${label} found`));
  out.due_date = dateField(due, 0.9, 'due date');
  let issueD = issue;
  let issueConf = 0.88;
  if (!issueD) {
    for (let i = 0; i < lines.length && !issueD; i++) { const d = findDateNear(lines, i); if (d && d.value !== due?.value) issueD = d; }
    issueConf = 0.55;
  }
  out.issue_date = dateField(issueD, issueConf, 'issue date');
  if (out.issue_date.value && out.due_date.value && out.due_date.value < out.issue_date.value) {
    out.due_date.confidence = Math.min(out.due_date.confidence, 0.4);
    out.due_date.note = 'Due date is before the issue date — check both';
  }

  // supplier: a name we already know beats the first line of the page
  const known = knownNames.map((n) => ({ n, o: nameOverlap(n, text) })).filter((k) => k.o >= 0.99).sort((a, b) => b.n.length - a.n.length)[0];
  if (known) out.supplier = field(known.n, 0.93, 'Matches a payee already in your records');
  else {
    const skip = /^(tax\s+)?(invoice|receipt|statement|bill|quotation|page\b|date\b|tel\b|phone|email|www\.|http|trn\b|p\.?o\.?\s*box)/i;
    const cand = lines.slice(0, 8).find((l) => /[A-Za-z]{3}/.test(l) && !skip.test(l) && l.length <= 60 && !/\d{4,}/.test(l));
    out.supplier = cand ? field(cand, 0.6, 'First line of the document — confirm the name') : field(null, 0, 'No supplier found');
  }
  return out;
}

export function knownCounterparties() {
  return [...new Set(all(
    `SELECT counterparty AS n FROM items WHERE counterparty IS NOT NULL AND voided_at IS NULL
     UNION SELECT counterparty FROM plans WHERE counterparty IS NOT NULL`).map((r) => r.n.trim()).filter((n) => n.length >= 3))];
}

/** Render one PDF page to PNG so the original can be shown beside the fields on any device. */
export async function renderPdfPage(buf, pageNo) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = await import('@napi-rs/canvas');
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false, verbosity: 0 });
  try {
    const doc = await task.promise;
    if (pageNo < 1 || pageNo > doc.numPages) return null;
    const page = await doc.getPage(pageNo);
    const viewport = page.getViewport({ scale: 1.6 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    return canvas.toBuffer('image/png');
  } finally { await task.destroy(); }
}
