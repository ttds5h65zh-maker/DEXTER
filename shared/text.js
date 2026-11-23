// Small text helpers shared by the server and the browser.

/** A passage as it should read on screen: no line breaks, no "> " quote markers. */
export function cleanQuote(q) {
  return String(q || '')
    .replace(/\n[ \t]*(?:>[ \t]?)+/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Fwd: RE: RE: Lab 5" → "Lab 5" */
export function stripReplyPrefixes(subject) {
  return String(subject || '')
    .replace(/^\s*(?:(?:re|fwd?|fw|aw|tr|wg)\s*(?:\[\d+\])?\s*:\s*)+/i, '')
    .trim();
}
