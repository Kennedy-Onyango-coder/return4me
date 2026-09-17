// PUBLIC REFERENCE GENERATION for a lost report (Phase 9A).
//
// The public reference IS the primary key, matching the existing convention
// that a user-facing record's key is its public code
// (items → 'R4M-xxx' drop-off code; claims → 'CLM-xxxxxx').
//
// WHY CRYPTO-RANDOM RATHER THAN SEQUENTIAL: a sequential or small-keyspace
// reference makes reports enumerable by simply counting. Claim IDs are 6
// NUMERIC digits (< 900,000 values) and therefore guessable, which is why every
// claim-guessing route carries a dedicated limiter. A lost-report reference is
// not gated the same way at discovery time in a future phase, so it is drawn
// from a crypto-random 31-character alphabet with a 6-character body:
// 31^6 = 887,503,681 values, none of them predictable from another.
//
// The alphabet omits 0/O/1/I/L so a reference can be read off a screen and
// re-typed without ambiguity.
import crypto from 'crypto';

export const LOST_REPORT_REFERENCE_PREFIX = 'LR-';
export const LOST_REPORT_REFERENCE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const LOST_REPORT_REFERENCE_LENGTH = 6;

/** A complete, human-facing lost-report reference, e.g. 'LR-7QF2KM'. */
export function generateLostReportReference(): string {
  let body = '';
  for (let i = 0; i < LOST_REPORT_REFERENCE_LENGTH; i++) {
    body += LOST_REPORT_REFERENCE_ALPHABET[crypto.randomInt(0, LOST_REPORT_REFERENCE_ALPHABET.length)];
  }
  return `${LOST_REPORT_REFERENCE_PREFIX}${body}`;
}

/**
 * Shape-only validator for an inbound reference (used to short-circuit obvious
 * junk before a database round-trip). This is NOT an authorization control —
 * lookup is by primary key and ownership is enforced separately.
 */
export function isLostReportReference(value: string): boolean {
  if (typeof value !== 'string') return false;
  const upper = value.trim().toUpperCase();
  if (!upper.startsWith(LOST_REPORT_REFERENCE_PREFIX)) return false;
  const body = upper.slice(LOST_REPORT_REFERENCE_PREFIX.length);
  if (body.length !== LOST_REPORT_REFERENCE_LENGTH) return false;
  return [...body].every((ch) => LOST_REPORT_REFERENCE_ALPHABET.includes(ch));
}
