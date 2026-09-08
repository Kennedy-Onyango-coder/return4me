import { describe, it, expect } from 'vitest';
import {
  validateVerificationAnswers,
  toAgentVerificationEvidence,
  LEGACY_EVIDENCE_KEYS,
} from '../verificationValidation';

// Pure unit tests for the server-authoritative verification-answer validator.
// The module only depends on the category profiles config, so it can be tested
// in isolation without any DB/server bootstrap (same hermetic style the suite
// uses — it never imports the Express app).

const VALID_ID: Record<string, string> = { lastDigits: '1234', fullName: 'Ali Hassan' };

describe('validateVerificationAnswers', () => {
  it('accepts a valid submission for a configured category', () => {
    const result = validateVerificationAnswers('national-id', {
      lastDigits: '1234',
      fullName: 'Ali Hassan',
      lostLocation: 'CBD Nairobi',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sanitized).toEqual({
        lastDigits: '1234',
        fullName: 'Ali Hassan',
        lostLocation: 'CBD Nairobi',
      });
    }
  });

  it('rejects a non-object payload', () => {
    for (const bad of [null, undefined, 'text', 42, ['lastDigits', '1234']]) {
      const result = validateVerificationAnswers('national-id', bad);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects an unknown field that is not in the category profile', () => {
    const result = validateVerificationAnswers('national-id', {
      ...VALID_ID,
      homeAddress: 'not a profile key',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Unknown verification field/);
  });

  it('rejects fields whose key suggests a credential/secret even if they reach the payload', () => {
    for (const forbiddenKey of ['cvv', 'cardNumber', 'pin', 'otp', 'password', 'secretNote']) {
      const result = validateVerificationAnswers('national-id', {
        ...VALID_ID,
        [forbiddenKey]: 'x',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/disallowed field/);
    }
  });

  it('rejects non-string values', () => {
    const result = validateVerificationAnswers('national-id', {
      lastDigits: 1234,
      fullName: 'Ali Hassan',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/must be a single text value/);
  });

  it('rejects a submission missing a required field', () => {
    const result = validateVerificationAnswers('national-id', { fullName: 'Ali Hassan' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/lastDigits/);
  });

  it('rejects a required field that is blank after trimming', () => {
    const result = validateVerificationAnswers('national-id', { lastDigits: '   ', fullName: 'x' });
    expect(result.ok).toBe(false);
  });

  it('trims values but does not otherwise rewrite them', () => {
    const result = validateVerificationAnswers('national-id', {
      lastDigits: ' 1234 ',
      fullName: '  Ali Hassan  ',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sanitized.fullName).toBe('Ali Hassan');
  });

  it('drops empty optional fields instead of storing them', () => {
    const result = validateVerificationAnswers('national-id', {
      lastDigits: '1234',
      fullName: 'Ali Hassan',
      lostLocation: '   ',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sanitized).not.toHaveProperty('lostLocation');
  });

  it('enforces the lastDigits length window after stripping non-alphanumerics', () => {
    // '12-3 ' → trimmed '12-3' (len 4 ≤ maxLength 4) → cleaned '123' (len 3) → valid.
    expect(validateVerificationAnswers('national-id', { lastDigits: '12-3 ', fullName: 'x' }).ok).toBe(true);
    // Over 4 raw characters is rejected by the profile's maxLength.
    const tooLong = validateVerificationAnswers('national-id', { lastDigits: '12345', fullName: 'x' });
    expect(tooLong.ok).toBe(false);
    // Non-alphanumeric-only input leaves nothing usable after stripping.
    const emptyAfterClean = validateVerificationAnswers('national-id', { lastDigits: '!!!', fullName: 'x' });
    expect(emptyAfterClean.ok).toBe(false);
  });

  it('falls back to the other-item profile for an unconfigured category', () => {
    const result = validateVerificationAnswers('made-up-category', { description: 'a brown wallet' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sanitized.description).toBe('a brown wallet');
  });
});

describe('toAgentVerificationEvidence', () => {
  it('returns only keys belonging to the item category profile', () => {
    const evidence = toAgentVerificationEvidence('national-id', {
      lastDigits: '1234',
      fullName: 'Ali Hassan',
      lostLocation: 'CBD',
      owner_phone: '+254700000000',
      owner_email: 'ali@example.com',
      cvv: '123',
      secretNote: 'x',
      internalNote: 'y',
    });
    expect(evidence).toEqual({ lastDigits: '1234', fullName: 'Ali Hassan', lostLocation: 'CBD' });
  });

  it('retains legacy evidence keys that predate the profile system', () => {
    expect(LEGACY_EVIDENCE_KEYS).toContain('lostDetails');
    const evidence = toAgentVerificationEvidence('other-item', {
      description: 'a bag',
      lostDetails: 'lost at the bus stop',
      owner_phone: '+254700000000',
    });
    expect(evidence.description).toBe('a bag');
    expect(evidence.lostDetails).toBe('lost at the bus stop');
    expect(evidence).not.toHaveProperty('owner_phone');
  });

  it('drops non-string and empty values', () => {
    const evidence = toAgentVerificationEvidence('national-id', {
      lastDigits: '1234',
      fullName: 1234,
      lostLocation: '   ',
    });
    expect(evidence).toEqual({ lastDigits: '1234' });
  });

  it('returns an empty object for null, arrays, or non-object inputs', () => {
    expect(toAgentVerificationEvidence('national-id', null)).toEqual({});
    expect(toAgentVerificationEvidence('national-id', ['lastDigits', '1234'])).toEqual({});
    expect(toAgentVerificationEvidence('national-id', 'nope')).toEqual({});
  });
});
