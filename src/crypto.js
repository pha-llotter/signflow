import crypto from 'node:crypto';
import fs from 'node:fs';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { config } from './config.js';

// OWASP-recommended Argon2id parameters (19 MiB, 2 iterations, 1 lane).
const ARGON_OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(plain) {
  return argonHash(plain, ARGON_OPTS);
}

export async function verifyPassword(stored, plain) {
  try {
    return await argonVerify(stored, plain);
  } catch {
    return false;
  }
}

export function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

export function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** URL-safe random token for signing links. 32 bytes = 256 bits of entropy. */
export function token(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function uuid() {
  return crypto.randomUUID();
}

const KEY = crypto.createHash('sha256').update(config.appKey).digest();

/** AES-256-GCM. Used for SMTP passwords, which must be recoverable to send mail. */
export function encryptSecret(plain) {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

export function decryptSecret(blob) {
  if (!blob) return null;
  try {
    const [iv, tag, data] = blob.split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Constant-time compare for tokens looked up from user input. */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
