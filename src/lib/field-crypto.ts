import crypto from 'crypto';
import { AppError } from '../middleware/error.middleware';

// Field-level encryption for sensitive identifiers (currently Franchise
// Aadhaar). AES-256-GCM with a random 12-byte IV per value; stored as
// "v1:<iv>:<authTag>:<ciphertext>" (base64 parts) so the format can evolve.
//
// The key comes from FIELD_ENCRYPTION_KEY (32 bytes, as 64 hex chars or
// base64). It is deliberately NOT derived from JWT_SECRET — rotating the JWT
// secret must never make stored identifiers undecryptable.
const VERSION = 'v1';

function getKey(): Buffer {
  const raw = process.env.FIELD_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new AppError('Sensitive field storage is not configured (FIELD_ENCRYPTION_KEY is missing). Contact the system administrator.', 500);
  }
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new AppError('FIELD_ENCRYPTION_KEY must be 32 bytes (64 hex characters or base64).', 500);
  }
  return key;
}

export function encryptField(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

export function decryptField(stored: string): string {
  const [version, iv, tag, data] = stored.split(':');
  if (version !== VERSION || !iv || !tag || !data) throw new Error('Unrecognised encrypted field format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
