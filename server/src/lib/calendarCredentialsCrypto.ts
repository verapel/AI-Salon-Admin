/**
 * AES-256-GCM helpers for calendar connection credentials (APPLE-A3B).
 * Plaintext exists only in memory during encrypt/decrypt. Never log secrets.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm' as const;
const IV_BYTES = 12;
const KEY_BYTES = 32;
const ENV_KEY = 'CALENDAR_CREDENTIALS_ENCRYPTION_KEY';

export interface EncryptedCalendarCredential {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export interface DecryptCalendarCredentialInput {
  ciphertext: string;
  iv: string;
  authTag: string;
}

class CalendarCredentialCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarCredentialCryptoError';
  }
}

/** True when the thrown error is a closed crypto failure (safe to map to generic API errors). */
export function isCalendarCredentialCryptoError(err: unknown): boolean {
  return err instanceof CalendarCredentialCryptoError;
}

/**
 * Load and validate CALENDAR_CREDENTIALS_ENCRYPTION_KEY.
 * Must be base64 that decodes to exactly 32 bytes.
 * Fail closed — never returns a fallback key.
 */
export function loadCalendarCredentialsEncryptionKey(): Buffer {
  const raw = process.env[ENV_KEY];
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new CalendarCredentialCryptoError('Calendar credential encryption key is not configured');
  }

  let key: Buffer;
  try {
    key = Buffer.from(raw.trim(), 'base64');
  } catch {
    throw new CalendarCredentialCryptoError('Calendar credential encryption key is invalid');
  }

  if (key.length !== KEY_BYTES) {
    throw new CalendarCredentialCryptoError('Calendar credential encryption key is invalid');
  }

  return key;
}

export function encryptCalendarCredential(plaintext: string): EncryptedCalendarCredential {
  if (typeof plaintext !== 'string' || !plaintext.trim()) {
    throw new CalendarCredentialCryptoError('Credential plaintext is required');
  }

  const key = loadCalendarCredentialsEncryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

export function decryptCalendarCredential(input: DecryptCalendarCredentialInput): string {
  if (
    typeof input?.ciphertext !== 'string' ||
    !input.ciphertext.trim() ||
    typeof input?.iv !== 'string' ||
    !input.iv.trim() ||
    typeof input?.authTag !== 'string' ||
    !input.authTag.trim()
  ) {
    throw new CalendarCredentialCryptoError('Encrypted credential material is incomplete');
  }

  const key = loadCalendarCredentialsEncryptionKey();

  let ciphertext: Buffer;
  let iv: Buffer;
  let authTag: Buffer;
  try {
    ciphertext = Buffer.from(input.ciphertext.trim(), 'base64');
    iv = Buffer.from(input.iv.trim(), 'base64');
    authTag = Buffer.from(input.authTag.trim(), 'base64');
  } catch {
    throw new CalendarCredentialCryptoError('Encrypted credential material is invalid');
  }

  if (iv.length !== IV_BYTES || ciphertext.length === 0 || authTag.length === 0) {
    throw new CalendarCredentialCryptoError('Encrypted credential material is invalid');
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    // Auth tag / key mismatch — fail closed without distinguishing details.
    throw new CalendarCredentialCryptoError('Credential decryption failed');
  }
}
