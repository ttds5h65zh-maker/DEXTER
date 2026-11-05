// User settings (non-secret) with defaults, plus encrypted secret storage.
import { now, parseJson } from '../db.js';
import { encryptSecret, decryptSecret } from '../lib/crypto.js';
import { isValidTimeZone, DEFAULT_TZ } from '../lib/time.js';
import { badRequest } from '../lib/http.js';

export const MODEL_OPTIONS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'Default — most capable for multi-step work' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'Faster, lower cost' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'Fastest, lowest cost' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', note: 'Highest capability, highest cost' },
];

export const DEFAULTS = {
  profile: {
    assistant_name: 'Dexter Almana',
    name: 'Sultan',
    location: 'United Arab Emirates',
    university: 'American University of Sharjah (AUS)',
    program: 'Information Systems and Business Analytics',
    timezone: DEFAULT_TZ,
    about: '',
  },
  model: {
    id: 'claude-opus-5-5',
    effort: 'medium',
    max_tokens: 32000,
    web_search: true,
  },
  notifications: {
    desktop: true,
    ntfy_url: '',
    quiet_hours: { enabled: false, start: '23:00', end: '07:00' },
    daily_briefing: { enabled: false, time: '07:30', days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
  },
  permissions: {
    read_email: true,
    read_calendar: true,
    create_drafts: true,
    save_memories: true,
    web_research: true,
    browser_read: true,
  },
  integrations: {
    ilearn_url: 'https://ilearn.aus.edu',
    banner_url: '',
  },
};

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function deepMerge(base, patch) {
  if (patch === undefined) return base;
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function createSettingsService(app) {
  const { db } = app;

  function getSection(key) {
    const row = db.get('SELECT value FROM settings WHERE key = ?', key);
    return deepMerge(DEFAULTS[key], parseJson(row?.value, {}));
  }

  function getAll() {
    const out = {};
    for (const k of Object.keys(DEFAULTS)) out[k] = getSection(k);
    return out;
  }

  function validate(section, value) {
    if (section === 'profile') {
      if (!String(value.assistant_name || '').trim() || String(value.assistant_name).length > 40) throw badRequest('The assistant name must be 1–40 characters');
      if (value.timezone && !isValidTimeZone(value.timezone)) throw badRequest(`Unknown timezone "${value.timezone}"`);
    }
    if (section === 'model') {
      if (value.effort && !EFFORTS.includes(value.effort)) throw badRequest('effort must be low, medium, high, xhigh or max');
      if (value.id && !/^claude-[a-z0-9.\-]+$/.test(value.id)) throw badRequest('Model id must look like claude-…');
      if (value.max_tokens != null && (!Number.isInteger(value.max_tokens) || value.max_tokens < 1024 || value.max_tokens > 128000)) {
        throw badRequest('max_tokens must be an integer between 1024 and 128000');
      }
    }
    if (section === 'notifications') {
      if (value.ntfy_url && !/^https:\/\/[^\s]+$/.test(value.ntfy_url)) throw badRequest('Push URL must be an https:// URL');
      const t = value.daily_briefing?.time;
      if (t && !/^\d{2}:\d{2}$/.test(t)) throw badRequest('Briefing time must be HH:MM');
    }
    if (section === 'integrations') {
      for (const k of ['ilearn_url', 'banner_url']) {
        if (value[k] && !/^https?:\/\/[^\s]+$/.test(value[k])) throw badRequest(`${k} must be a URL`);
      }
    }
  }

  function update(patch) {
    const changed = [];
    db.tx(() => {
      for (const [section, value] of Object.entries(patch || {})) {
        if (!(section in DEFAULTS)) throw badRequest(`Unknown settings section "${section}"`);
        const next = deepMerge(getSection(section), value);
        validate(section, next);
        db.run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
          section, JSON.stringify(next), now());
        changed.push(section);
      }
    });
    app.bus.publish('settings.updated', { sections: changed });
    for (const fn of listeners) fn(changed);
    return getAll();
  }

  const listeners = new Set();

  return {
    getAll,
    get: getSection,
    update,
    onChange: (fn) => listeners.add(fn),
    timezone: () => getSection('profile').timezone || DEFAULT_TZ,
    getSecret(key) {
      const row = db.get('SELECT value FROM secrets WHERE key = ?', key);
      if (!row) return null;
      try { return JSON.parse(decryptSecret(row.value)); } catch { return null; }
    },
    setSecret(key, value) {
      db.run('INSERT INTO secrets (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        key, encryptSecret(JSON.stringify(value)), now());
    },
    deleteSecret(key) {
      db.run('DELETE FROM secrets WHERE key = ?', key);
    },
  };
}
