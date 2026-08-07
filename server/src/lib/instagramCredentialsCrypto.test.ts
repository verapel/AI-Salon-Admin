/**
 * IG-1: Instagram AES-256-GCM credential crypto tests.
 * No Meta. No SQL. No real credentials.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { randomBytes } from 'node:crypto';
import {
  decryptInstagramCredential,
  encryptInstagramCredential,
  isInstagramCredentialCryptoError,
  loadInstagramCredentialsEncryptionKey,
} from './instagramCredentialsCrypto.js';

const ENV_KEY = 'INSTAGRAM_CREDENTIALS_ENCRYPTION_KEY';
const previousKey = process.env[ENV_KEY];

afterEach(() => {
  if (previousKey === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = previousKey;
  }
});

describe('instagramCredentialsCrypto (executed)', () => {
  it('1. encryption roundtrip restores plaintext', () => {
    process.env[ENV_KEY] = randomBytes(32).toString('base64');
    const plaintext = 'ig-test-access-token-value';
    const encrypted = encryptInstagramCredential(plaintext);
    assert.ok(encrypted.ciphertext.length > 0);
    assert.ok(encrypted.iv.length > 0);
    assert.ok(encrypted.authTag.length > 0);
    assert.notEqual(encrypted.ciphertext, plaintext);
    const decrypted = decryptInstagramCredential(encrypted);
    assert.equal(decrypted, plaintext);
  });

  it('2. corrupted ciphertext fails safely (closed crypto error)', () => {
    process.env[ENV_KEY] = randomBytes(32).toString('base64');
    const encrypted = encryptInstagramCredential('ig-token');
    encrypted.ciphertext = Buffer.from('not-valid-ciphertext').toString('base64');
    assert.throws(
      () => decryptInstagramCredential(encrypted),
      (err: unknown) => {
        assert.equal(isInstagramCredentialCryptoError(err), true);
        const message = err instanceof Error ? err.message : '';
        assert.ok(!message.includes('ig-token'));
        return true;
      },
    );
  });

  it('3. missing encryption key fails closed', () => {
    delete process.env[ENV_KEY];
    assert.throws(
      () => loadInstagramCredentialsEncryptionKey(),
      (err: unknown) => isInstagramCredentialCryptoError(err),
    );
  });

  it('4. encrypt never returns plaintext fields', () => {
    process.env[ENV_KEY] = randomBytes(32).toString('base64');
    const plaintext = 'super-secret-ig-token';
    const encrypted = encryptInstagramCredential(plaintext);
    const json = JSON.stringify(encrypted);
    assert.ok(!json.includes(plaintext));
    assert.ok(!('plaintext' in encrypted));
  });
});
