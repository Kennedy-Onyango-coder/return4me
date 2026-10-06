import crypto from 'crypto';
import bcrypt from 'bcryptjs';

// =============================================================================
// ADMIN 2FA — SINGLE-USE RECOVERY CODES.
//
// WHY THIS EXISTS
//   Before this, an administrator who lost the device holding their authenticator
//   had no way to complete 2FA verification: the account was permanently locked
//   out of the console. Recovery codes are the standard, proportionate escape
//   hatch: a fixed set of one-time codes issued at enrollment, each usable
//   exactly once, each individually revocable by consumption.
//
// DESIGN CONSTRAINTS (all deliberate)
//   * Cryptographically secure generation — crypto.randomBytes, never Math.random.
//   * Hashed at rest with the same password-hashing primitive this codebase
//     already uses for passwords (bcryptjs) — a recovery code is a bearer
//     credential, so it must not be recoverable from a database read.
//   * Shown to the administrator exactly once (server returns them on the
//     successful confirmation response only). There is no API that ever returns
//     a stored code or its hash.
//   * Single-use, enforced by an atomic compare-and-swap on the row's used_at
//     column in the database layer (see db.consumeAdminRecoveryCode), not by a
//     read-then-write in application code.
//
// ALPHABET / ENTROPY
//   A 32-symbol alphabet (A-Z minus I and O, plus 2-9) removes the visually
//   ambiguous characters that make hand-typed codes fail. Each of the 10 symbols
//   is drawn from a uniformly random byte via `byte & 31` — exactly uniform
//   because 256 is a clean multiple of 32, so no modulo bias and no rejection
//   sampling is required. 10 symbols = 50 bits of entropy, which is comparable
//   to a TOTP secret's effective guess-resistance once the heavily rate-limited
//   and single-use nature of redemption is accounted for.
// =============================================================================

export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_SYMBOLS = 10;
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols, no I/O/0/1
const BCRYPT_ROUNDS = 10;

/** Groups a raw code as XXXXX-XXXXX purely for readability; hashing ignores the dash. */
function formatRecoveryCode(raw: string): string {
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/**
 * Normalizes a recovery code for hashing/verification: upper-case and strip
 * everything that is not A-Z/0-9 (spaces, dashes, stray characters). Because the
 * SAME normalization is applied at generation-hash time and verification time,
 * an administrator may type the code with or without its dash and in any case.
 */
export function normalizeRecoveryCode(code: string): string {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Generates a fresh set of recovery codes (plaintext). The caller is responsible
 * for hashing and persisting them, and for returning the plaintext to the
 * administrator exactly once.
 */
export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = crypto.randomBytes(RECOVERY_CODE_SYMBOLS);
    let raw = '';
    for (let j = 0; j < RECOVERY_CODE_SYMBOLS; j++) {
      raw += RECOVERY_ALPHABET[bytes[j] & 31]; // uniform over 32 symbols
    }
    codes.push(formatRecoveryCode(raw));
  }
  return codes;
}

/** Hashes a recovery code for storage (bcrypt — salted, one-way). */
export async function hashRecoveryCode(code: string): Promise<string> {
  return bcrypt.hash(normalizeRecoveryCode(code), BCRYPT_ROUNDS);
}

/** Verifies a presented recovery code against a stored bcrypt hash. */
export async function verifyRecoveryCode(code: string, storedHash: string): Promise<boolean> {
  const normalized = normalizeRecoveryCode(code);
  if (!normalized || !storedHash) return false;
  try {
    return await bcrypt.compare(normalized, storedHash);
  } catch {
    return false;
  }
}
