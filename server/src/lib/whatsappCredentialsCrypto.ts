/**
 * AES-256-GCM helpers for per-salon WhatsApp Cloud credentials (WA-2).
 * Plaintext exists only in memory during encrypt/decrypt. Never log secrets.
 * Independent of calendarCredentialsCrypto — do not share keys or helpers.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm' as const;
const IV_BYTES = 12;
const KEY_BYTES = 32;
const ENV_KEY = 'WHATSAPP_CREDENTIALS_ENCRYPTION_KEY';

export interface EncryptedWhatsAppCredential {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export interface DecryptWhatsAppCredentialInput {
  ciphertext: string;
  iv: string;
  authTag: string;
}

class WhatsAppCredentialCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhatsAppCredentialCryptoError';
  }
}

/** True when the thrown error is a closed crypto failure (safe to map to generic API errors). */
export function isWhatsAppCredentialCryptoError(err: unknown): boolean {
  return err instanceof WhatsAppCredentialCryptoError;
}

/**
 * Load and validate WHATSAPP_CREDENTIALS_ENCRYPTION_KEY.
 * Must be base64 that decodes to exactly 32 bytes.
 * Fail closed — never returns a fallback key.
 * Not called at process boot; only when WhatsApp endpoints need encrypt/decrypt.
 */
export function loadWhatsAppCredentialsEncryptionKey(): Buffer {
  const raw = process.env[ENV_KEY];
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new WhatsAppCredentialCryptoError('WhatsApp credential encryption key is not configured');
  }

  let key: Buffer;
  try {
    key = Buffer.from(raw.trim(), 'base64');
  } catch {
    throw new WhatsAppCredentialCryptoError('WhatsApp credential encryption key is invalid');
  }

  if (key.length !== KEY_BYTES) {
    throw new WhatsAppCredentialCryptoError('WhatsApp credential encryption key is invalid');
  }

  return key;
}

/** Validates that the encryption key is present and well-formed without encrypting. */
export function assertWhatsAppCredentialsEncryptionKeyConfigured(): void {
  loadWhatsAppCredentialsEncryptionKey();
}

export function encryptWhatsAppCredential(plaintext: string): EncryptedWhatsAppCredential {
  if (typeof plaintext !== 'string' || !plaintext.trim()) {
    throw new WhatsAppCredentialCryptoError('Credential plaintext is required');
  }

  const key = loadWhatsAppCredentialsEncryptionKey();
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

export function decryptWhatsAppCredential(input: DecryptWhatsAppCredentialInput): string {
  if (
    typeof input?.ciphertext !== 'string' ||
    !input.ciphertext.trim() ||
    typeof input?.iv !== 'string' ||
    !input.iv.trim() ||
    typeof input?.authTag !== 'string' ||
    !input.authTag.trim()
  ) {
    throw new WhatsAppCredentialCryptoError('Encrypted credential material is incomplete');
  }

  const key = loadWhatsAppCredentialsEncryptionKey();

  let ciphertext: Buffer;
  let iv: Buffer;
  let authTag: Buffer;
  try {
    ciphertext = Buffer.from(input.ciphertext.trim(), 'base64');
    iv = Buffer.from(input.iv.trim(), 'base64');
    authTag = Buffer.from(input.authTag.trim(), 'base64');
  } catch {
    throw new WhatsAppCredentialCryptoError('Encrypted credential material is invalid');
  }

  if (iv.length !== IV_BYTES || ciphertext.length === 0 || authTag.length === 0) {
    throw new WhatsAppCredentialCryptoError('Encrypted credential material is invalid');
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    throw new WhatsAppCredentialCryptoError('Credential decryption failed');
  }
}
