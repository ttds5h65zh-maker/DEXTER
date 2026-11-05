// AES-256-GCM encryption for secrets stored in the database (OAuth refresh
// tokens). The key comes from DEXTER_SECRET_KEY or a generated data/secret.key.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

let KEY = null;

export function initSecretKey(config) {
  if (config.secretKey) {
    KEY = crypto.scryptSync(config.secretKey, 'dexter-secret-v1', 32);
    return;
  }
  const file = path.join(config.dataDir, 'secret.key');
  if (fs.existsSync(file)) {
    KEY = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  } else {
    KEY = crypto.randomBytes(32);
    fs.writeFileSync(file, KEY.toString('base64'), { mode: 0o600 });
  }
  if (KEY.length !== 32) throw new Error('data/secret.key is invalid (expected 32 bytes, base64)');
}

export function encryptSecret(plaintext) {
  if (!KEY) throw new Error('Secret key not initialised');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptSecret(payload) {
  if (!KEY) throw new Error('Secret key not initialised');
  const [v, iv, tag, ct] = String(payload).split(':');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
