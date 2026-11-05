// Configuration loading. Values come from the process environment, optionally
// seeded from a local .env file (never committed). Secrets are read here and
// only exposed to the rest of the server through this module.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseDotEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadEnvFile(file = path.join(ROOT_DIR, '.env')) {
  if (!fs.existsSync(file)) return {};
  const parsed = parseDotEnv(fs.readFileSync(file, 'utf8'));
  // Real environment variables win over the file.
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return parsed;
}

function bool(v, fallback = false) {
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v));
}

export function buildConfig(env = process.env, overrides = {}) {
  const port = Number(overrides.port ?? env.PORT ?? 3210);
  const host = overrides.host ?? env.HOST ?? '127.0.0.1';
  const dataDir = path.resolve(ROOT_DIR, overrides.dataDir ?? env.DEXTER_DATA_DIR ?? './data');
  const publicUrl = (overrides.publicUrl ?? env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, '');
  const cfg = {
    port,
    host,
    publicUrl,
    dataDir,
    filesDir: path.join(dataDir, 'files'),
    dbPath: overrides.dbPath ?? path.join(dataDir, 'dexter.db'),
    password: overrides.password ?? env.DEXTER_PASSWORD ?? '',
    allowedHosts: (env.DEXTER_ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean),
    secretKey: env.DEXTER_SECRET_KEY || '',
    anthropic: {
      apiKey: overrides.anthropicApiKey ?? env.ANTHROPIC_API_KEY ?? '',
      baseUrl: (overrides.anthropicBaseUrl ?? env.DEXTER_ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, ''),
    },
    google: {
      clientId: overrides.googleClientId ?? env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: overrides.googleClientSecret ?? env.GOOGLE_CLIENT_SECRET ?? '',
      // Endpoint overrides exist only so the test-suite can point at a local fake.
      authUrl: env.DEXTER_GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: overrides.googleTokenUrl ?? env.DEXTER_GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
      revokeUrl: overrides.googleRevokeUrl ?? env.DEXTER_GOOGLE_REVOKE_URL ?? 'https://oauth2.googleapis.com/revoke',
      apiBase: overrides.googleApiBase ?? env.DEXTER_GOOGLE_API_BASE ?? 'https://www.googleapis.com',
      gmailBase: overrides.gmailBase ?? env.DEXTER_GMAIL_API_BASE ?? 'https://gmail.googleapis.com',
    },
    browser: {
      headless: env.DEXTER_BROWSER_HEADLESS === undefined || env.DEXTER_BROWSER_HEADLESS === ''
        ? (process.platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY)
        : bool(env.DEXTER_BROWSER_HEADLESS),
    },
    // Allows fetch_url / monitors to reach private network addresses. Off by default
    // so untrusted content cannot steer Dexter into probing local services.
    allowPrivateFetch: overrides.allowPrivateFetch ?? bool(env.DEXTER_ALLOW_PRIVATE_FETCH),
    schedulerIntervalMs: Number(overrides.schedulerIntervalMs ?? env.DEXTER_SCHEDULER_INTERVAL_MS ?? 5000),
    schedulerEnabled: overrides.schedulerEnabled ?? !bool(env.DEXTER_DISABLE_SCHEDULER),
    retryBaseMs: Number(overrides.retryBaseMs ?? env.DEXTER_RETRY_BASE_MS ?? 30000),
    logLevel: overrides.logLevel ?? env.DEXTER_LOG_LEVEL ?? 'info',
    maxUploadBytes: Number(env.DEXTER_MAX_UPLOAD_MB || 25) * 1024 * 1024,
  };
  return cfg;
}
