// CANONICAL DOCUMENT-NUMBER HASHER.
//
// This function is the ONE privacy-preserving exact-match primitive on this
// platform: a document number (national ID, passport, licence, serial, …) is
// normalized (trim + upper-case) and HMAC-SHA256'd with the deployment's
// DOC_HASH_SALT. The plaintext is never persisted.
//
// WHY THIS MODULE EXISTS (Phase 9A): the identical function used to live
// privately inside server.ts, where it hashed found-item document numbers
// (items.document_number_hash). Customer lost-item reports need to hash a
// document number the SAME way, or a future matcher (Phase 9B) could never
// compare the two by exact hash. Copying the body into a second file would be
// exactly the "second security pattern" this phase forbids, so the function
// was moved VERBATIM here and server.ts now imports it. Behaviour is
// unchanged — same normalization, same salt-fallback chain, same digest.
import crypto from 'crypto';

export function hashDocument(value: string): string {
  const normalizedValue = value.trim().toUpperCase();
  const salt = process.env.DOC_HASH_SALT || process.env.JWT_SECRET || 'RETURN4ME_DEFAULT_SALT_VALUE_FOR_DOCUMENT_HASHING';
  return crypto
    .createHmac('sha256', salt)
    .update(normalizedValue)
    .digest('hex');
}
