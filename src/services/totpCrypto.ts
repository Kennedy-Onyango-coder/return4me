import crypto from 'crypto';

// =============================================================================
// ADMIN 2FA — TOTP SECRET ENCRYPTION AT REST (Administrative 2FA hardening).
//
// WHY THIS EXISTS
//   admin_users.totp_secret must be reproducible by the server on every admin
//   login (the server recomputes the current TOTP code to compare it), so it
//   CANNOT be one-way hashed the way a password or an OTP code is elsewhere in
//   this codebase. Stored as plaintext, it is a full standing credential: a
//   read of the database (backup, log, leaked replica, SQL-injection read) hands
//   an attacker the ability to mint valid admin 2FA codes forever.
//
//   The answer is AUTHENTICATED ENCRYPTION AT REST: AES-256-GCM, a fresh random
//   96-bit IV per encryption, the GCM authentication tag stored alongside the
//   ciphertext, and a key that lives only in the deployment environment — never
//   in source, never in the database.
//
// KEY MATERIAL
//   TOTP_ENCRYPTION_KEY, exactly 32 bytes, supplied as either a 64-character
//   hex string or a standard base64 string. Generate one with:
//     node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//   Production REQUIRES it (assertTotpEncryptionKeyConfigured() runs from the
//   boot guard); non-production falls back to a deterministic key derived from
//   JWT_SECRET so local development and the test suite work with no extra
//   configuration. No key or secret is ever logged or returned to a client.
//
// STORAGE FORMAT
//   "<prefix><base64(iv || authTag || ciphertext)>", prefix = TOTP_CIPHER_PREFIX.
//   The prefix is a version tag: it is what makes the one-time plaintext ->
//   encrypted migration (encryptExistingTotpSecrets, src/db/index.ts) both
//   idempotent and detectable. A base32 TOTP secret contains only A-Z and 2-7,
//   so it can never collide with the prefix (which contains a ':'), which means
//   a stored value's shape unambiguously says whether it is already encrypted.
// =============================================================================

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // GCM standard nonce length
const TAG_BYTES = 16; // GCM authentication tag

/** Version tag that marks a stored value as this module's ciphertext. */
export const TOTP_CIPHER_PREFIX = 'v1:';

/** True when a stored value is our AES-256-GCM ciphertext (not legacy plaintext). */
export function isEncryptedTOTPSecret(stored: string | null | undefined): boolean {
  return typeof stored === 'string' && stored.startsWith(TOTP_CIPHER_PREFIX);
}

function sanitize(value: string | undefined | null): string {
  return (value || '').trim().replace(/^["']+|["']+$/g, '').trim();
}

/**
 * Resolves the 32-byte AES-256-GCM key from the environment.
 *
 * Production: TOTP_ENCRYPTION_KEY is REQUIRED and must decode to exactly 32
 * bytes; anything else throws (fail closed) rather than silently generating or
 * guessing a key. Non-production: a deterministic key is derived from
 * JWT_SECRET so tests and `npm run dev` need no extra setup. The derived key is
 * never used when an explicit key is present, and never in production.
 */
export function resolveTotpEncryptionKey(): Buffer {
  const raw = sanitize(process.env.TOTP_ENCRYPTION_KEY);
  if (raw) {
    const looksLikeHex = /^[0-9a-fA-F]{64}$/.test(raw);
    const key = looksLikeHex ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (key.length !== KEY_BYTES) {
      // NEVER include the supplied value in the message.
      throw new Error(
        `TOTP_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes ` +
        `(64-character hex or standard base64 of 32 bytes). Refusing to operate with an unusable key.`
      );
    }
    return key;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'FATAL: TOTP_ENCRYPTION_KEY is not configured. Admin 2FA secrets are encrypted at rest and ' +
      'this key is required in production. Set it to a 32-byte value (64-char hex or base64).'
    );
  }

  // Non-production only: a deterministic, NON-secret derived key so local dev
  // and the test suite work with no configuration. Never used in production.
  const seed = sanitize(process.env.JWT_SECRET) || 'return4me-dev-only-totp-encryption-fallback';
  return crypto.createHash('sha256').update(seed).digest();
}

/**
 * Boot guard hook: validates the key is present and usable in production.
 * Throws (without revealing the key) so a misconfigured deployment fails to
 * start rather than booting into a state where admin 2FA cannot be enabled or
 * verified. In non-production this is a no-op because the derived fallback is
 * always available.
 */
export function assertTotpEncryptionKeyConfigured(): void {
  if (process.env.NODE_ENV !== 'production') return;
  // resolveTotpEncryptionKey() throws a descriptive (secret-free) error when
  // the key is missing or malformed.
  resolveTotpEncryptionKey();
}

/**
 * Encrypts a TOTP secret (base32) for storage. A fresh random IV is generated
 * per call, so encrypting the same secret twice yields different ciphertext.
 */
export function encryptTOTPSecret(plaintext: string): string {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('encryptTOTPSecret requires a non-empty plaintext secret.');
  }
  const key = resolveTotpEncryptionKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, authTag, ciphertext]);
  return TOTP_CIPHER_PREFIX + payload.toString('base64');
}

/**
 * Decrypts a stored TOTP secret back to its base32 plaintext.
 *
 * A value WITHOUT the version prefix is legacy plaintext that predates this
 * module. It is returned verbatim so that a database mid-migration (or an admin
 * row written by an older deployment during a rolling restart) can never lock an
 * administrator out of 2FA. This tolerant read is a transition safety net ONLY:
 * the one-time boot migration (encryptExistingTotpSecrets) is what actually
 * removes plaintext at rest, and it is idempotent, so every boot re-attempts it
 * until no plaintext remains.
 */
export function decryptTOTPSecret(stored: string): string {
  if (typeof stored !== 'string' || stored.length === 0) {
    throw new Error('decryptTOTPSecret requires a non-empty stored secret.');
  }
  if (!isEncryptedTOTPSecret(stored)) {
    return stored;
  }

  const key = resolveTotpEncryptionKey();
  const payload = Buffer.from(stored.slice(TOTP_CIPHER_PREFIX.length), 'base64');
  if (payload.length < IV_BYTES + TAG_BYTES) {
    throw new Error('Stored TOTP secret is malformed (too short to contain an IV and auth tag).');
  }
  const iv = payload.subarray(0, IV_BYTES);
  const authTag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = payload.subarray(IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  // GCM authentication failure (wrong key / tampered ciphertext) throws here;
  // the error carries no secret material.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
