// Node side of the PDF reader: supplies zlib to the shared reader.

import zlib from 'node:zlib';
import { readPdf, PdfError, visualToLogical } from '../shared/pdf.js';

export { PdfError, visualToLogical };

/** Inflate a Flate stream, keeping whatever decodes from a damaged one. */
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

/** Extract text from a PDF. Resolves { text, pages: [{ number, start, end }], title }. */
export function extractPdfText(buf) {
  return readPdf(buf, { inflate });
}
