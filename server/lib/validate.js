// A small JSON-Schema subset validator used to check tool inputs before any
// tool runs (inputs stream eagerly, so the server validates them itself).
export function validateSchema(schema, value, path = 'input') {
  const errors = [];
  check(schema, value, path, errors);
  return errors;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function check(schema, value, path, errors) {
  if (!schema) return;
  if (schema.anyOf) {
    const ok = schema.anyOf.some((s) => validateSchema(s, value, path).length === 0);
    if (!ok) errors.push(`${path} does not match any allowed shape`);
    return;
  }
  const t = typeOf(value);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = types.some((ty) => ty === t || (ty === 'number' && t === 'integer'));
    if (!ok) { errors.push(`${path} must be ${types.join(' or ')} (got ${t})`); return; }
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} must be one of: ${schema.enum.join(', ')}`);
  if (t === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path} must not be empty`);
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path} is longer than ${schema.maxLength} characters`);
  }
  if ((t === 'number' || t === 'integer')) {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path} must be >= ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path} must be <= ${schema.maximum}`);
  }
  if (t === 'array') {
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${path} has more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => check(schema.items, v, `${path}[${i}]`, errors));
  }
  if (t === 'object') {
    for (const req of schema.required || []) {
      if (value[req] === undefined) errors.push(`${path}.${req} is required`);
    }
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) check(props[k], v, `${path}.${k}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}.${k} is not an allowed field`);
    }
  }
}
