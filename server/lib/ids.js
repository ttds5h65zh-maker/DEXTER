import crypto from 'node:crypto';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

// Roughly time-ordered, URL-safe identifiers: <prefix>_<time><random>.
export function newId(prefix) {
  const time = Date.now().toString(36).padStart(9, '0');
  const bytes = crypto.randomBytes(8);
  let rand = '';
  for (const b of bytes) rand += ALPHABET[b % 32];
  return `${prefix}_${time}${rand}`;
}

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Stable JSON (sorted keys) so equal objects hash identically.
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function hashObject(value) {
  return sha256(stableStringify(value));
}
