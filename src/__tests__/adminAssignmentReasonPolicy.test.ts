import { describe, it, expect } from 'vitest';
import {
  ADMIN_REASON_MAX_LENGTH,
  ADMIN_REASON_MIN_LENGTH,
  ADMIN_REASON_PERSONAL_DATA_MESSAGE,
  ADMIN_REASON_REQUIRED_MESSAGE,
  ADMIN_REASON_TOO_LONG_MESSAGE,
  ADMIN_REASON_TOO_SHORT_MESSAGE,
  detectPersonalDataInReason,
  validateAdminAssignmentReason,
} from '../config/adminAssignmentReasonPolicy';

// =============================================================================
// STAGE 3B-3 — THE ADMINISTRATOR REASON POLICY, TESTED AS THE PURE FUNCTION THE
// SERVER AND THE ADMIN CONSOLE BOTH CALL.
//
// WHY A SEPARATE FILE: this is the one rule that decides whether a manual
// assignment change may be recorded at all, and it is deliberately narrow. The
// false-positive cases below matter as much as the true positives — a validator
// that rejects an honest operational reason is a bug that pushes administrators
// towards writing nothing useful.
//
// IT DOES NOT DETECT NAMES, AND THESE TESTS SAY SO. There is no reliable way to
// distinguish a person's name from ordinary prose, and the product decision for
// this stage explicitly declines to claim it.
// =============================================================================

describe('3B-3 — a reason is required and must be meaningful', () => {
  it('refuses a missing, blank or whitespace-only reason with the historical message', () => {
    for (const value of [undefined, null, '', '   ', '\n\t ', 42, {}, []]) {
      const result = validateAdminAssignmentReason(value);
      expect(result.ok, String(value)).toBe(false);
      expect(result.kind).toBe('missing');
      // The admin API has used this exact sentence since manual assignment existed.
      expect(result.error).toBe(ADMIN_REASON_REQUIRED_MESSAGE);
      expect(result.reason).toBe('');
    }
  });

  it('refuses a placeholder that says nothing', () => {
    for (const value of ['.', 'x', 'n/a', 'ok', 'closed', '12345']) {
      const result = validateAdminAssignmentReason(value);
      expect(result.ok, value).toBe(false);
      expect(result.kind).toBe('too_short');
      expect(result.error).toBe(ADMIN_REASON_TOO_SHORT_MESSAGE);
    }
  });

  it('refuses an essay', () => {
    const result = validateAdminAssignmentReason('a'.repeat(ADMIN_REASON_MAX_LENGTH + 1));
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('too_long');
    expect(result.error).toBe(ADMIN_REASON_TOO_LONG_MESSAGE);
  });

  it('accepts an ordinary operational reason and returns it TRIMMED', () => {
    const result = validateAdminAssignmentReason(
      '   Nearest hub is closed for the week; routing to the next hub in the same sub-county.   ',
    );
    expect(result.ok).toBe(true);
    expect(result.error).toBe('');
    expect(result.kind).toBeNull();
    expect(result.reason).toBe(
      'Nearest hub is closed for the week; routing to the next hub in the same sub-county.',
    );
    expect(result.reason.length).toBeGreaterThanOrEqual(ADMIN_REASON_MIN_LENGTH);
  });
});

describe('3B-3 — clearly identifiable personal data is refused', () => {
  const personalDataReasons = [
    ['email', 'Claimant email is jane.doe@example.com, moving the item to the CBD hub.'],
    ['email', 'Contact was jdoe+claims@mail.co.ke about the handover.'],
    ['phone', 'Call the claimant on 0712 345 678 before releasing the item.'],
    ['phone', 'Owner phone 0712345678 confirmed the pickup slot.'],
    ['phone', 'Reached at +254 712 345 678 this morning.'],
    ['phone', 'Reached at 254-712-345-678 this morning.'],
    ['phone', 'Reached at +44 20 7946 0958 from abroad.'],
    ['identification', 'Verified against ID 12345678 at the counter.'],
    ['identification', 'National ID: 12345678 did not match the name on the item.'],
    ['identification', 'Passport no. A1234567 was presented at the hub.'],
  ] as const;

  for (const [kind, reason] of personalDataReasons) {
    it(`refuses a ${kind} reference: ${reason.slice(0, 42)}...`, () => {
      expect(detectPersonalDataInReason(reason)).toBe(kind);
      const result = validateAdminAssignmentReason(reason);
      expect(result.ok).toBe(false);
      expect(result.kind).toBe('personal_data');
      expect(result.error).toBe(ADMIN_REASON_PERSONAL_DATA_MESSAGE);
    });
  }

  it('does NOT reject ordinary numbers that merely look numeric', () => {
    // A date, a count, an item-code fragment and a fee are not personal data, and
    // rejecting them would make the field unusable for the reasons operators
    // actually need to write.
    for (const reason of [
      'Re-submitted on 20260312 after the first review was rejected.',
      'The queue held 12 items that morning, so the hub was overloaded.',
      'Moved to the next hub after item R4M-4821 was reported twice.',
      'Fee quoted was 500 to the finder and 250 to the hub.',
      'Second attempt at 14:30 on the same day, same sub-county.',
    ]) {
      expect(detectPersonalDataInReason(reason), reason).toBeNull();
      expect(validateAdminAssignmentReason(reason).ok, reason).toBe(true);
    }
  });

  it('does not claim to detect a person NAME, and must not pretend to', () => {
    // Documented limitation, asserted so nobody later believes the field is
    // name-scrubbed: the operational reason below contains a person's name and is
    // accepted, because there is no reliable way to tell it from prose.
    const withName = 'Previous holder was the agent on duty, Jane Wanjiku, who handed over at noon.';
    expect(detectPersonalDataInReason(withName)).toBeNull();
    expect(validateAdminAssignmentReason(withName).ok).toBe(true);
  });
});
