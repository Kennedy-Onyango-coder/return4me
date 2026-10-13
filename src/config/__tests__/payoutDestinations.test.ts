import { describe, it, expect } from 'vitest';
import {
  PERSONAL_MPESA_PAYOUT_METHOD,
  resolvePayoutLegEligibility,
  resolvePayoutBatchEligibility,
  normalizePersonalMpesaPhoneDestination,
  maskPayoutDestinationForLog,
  describePayoutDestinationRefusal,
} from '../payoutDestinations';

// =============================================================================
// BATCH 1 — THE PHONE-ONLY PAYOUT DESTINATION POLICY.
//
// The launch policy pays Kenyan PERSONAL M-Pesa phone destinations only, on both
// the finder and the agent leg. The recipients' values are platform-external
// free text: an agent's `mpesa_till_or_paybill` may hold a Till number, a
// Paybill number, a Pochi la Biashara handle, a blank value or a malformed
// number, and a finder's recorded phone is whatever the report form accepted.
//
// These tests pin the decision itself, exhaustively and without a database:
// exactly one method string and exactly one destination shape are eligible, and
// everything else is refused. They also pin what this policy does NOT claim:
// nothing here asserts that a well-formed number is registered with M-Pesa or
// belongs to the intended person — a format decision is all it is.
//
// The caller-side consequences (no provider request for an ineligible leg, no
// partial batch, claim returned for operator correction) are asserted over real
// HTTP in src/__tests__/lifecycleHttpE2E.test.ts, stage 8.9.
// =============================================================================

const personal = (destination: unknown) => ({
  recipientType: 'finder' as const,
  destination,
  payoutMethodType: PERSONAL_MPESA_PAYOUT_METHOD,
});

const personalAgent = (destination: unknown, payoutMethodType: unknown = PERSONAL_MPESA_PAYOUT_METHOD) => ({
  recipientType: 'agent' as const,
  destination,
  payoutMethodType,
});

describe('normalisation: exactly 254 followed by nine digits, or null', () => {
  it('canonicalises the documented national and international forms', () => {
    const canonical = '254712345678';
    for (const accepted of [
      '0712345678',
      '712345678',
      '+254712345678',
      '254712345678',
      '+254 712 345 678',
      '0712-345-678',
      '(0712) 345678',
      '0110000000', // the 01x range is equally valid
    ]) {
      expect(normalizePersonalMpesaPhoneDestination(accepted), accepted).toBe(
        accepted.startsWith('01') ? '254110000000' : canonical,
      );
    }
  });

  it('refuses a missing destination', () => {
    for (const missing of [undefined, null, '', '   ', {}, [], true, false]) {
      expect(normalizePersonalMpesaPhoneDestination(missing), JSON.stringify(missing)).toBeNull();
    }
  });

  it('refuses a destination with no digits at all', () => {
    for (const value of ['E2E-TILL', 'not-a-number', 'POCHI', 'abc']) {
      expect(normalizePersonalMpesaPhoneDestination(value), value).toBeNull();
    }
  });

  it('refuses a number that is too short', () => {
    for (const value of ['07123456', '71234567', '25471234567', '0', '7']) {
      expect(normalizePersonalMpesaPhoneDestination(value), value).toBeNull();
    }
  });

  it('refuses a number that is too long', () => {
    for (const value of ['07123456789', '2547123456789', '+2547123456789']) {
      expect(normalizePersonalMpesaPhoneDestination(value), value).toBeNull();
    }
  });

  it('refuses a non-Kenyan destination', () => {
    // +255 (Tanzania), +256 (Uganda), +1 (US) and an international-shaped value
    // that is not Kenya's country code.
    for (const value of ['+255712345678', '255712345678', '+256712345678', '+14155552671', '0044712345678']) {
      expect(normalizePersonalMpesaPhoneDestination(value), value).toBeNull();
    }
  });

  it('never invents a mobile range that does not exist', () => {
    // 254 followed by nine digits whose subscriber part cannot be a Kenyan
    // mobile number (Kenyan mobiles are 07xx and 01x only).
    for (const value of ['254999999999', '254812345678', '0999999999', '812345678']) {
      expect(normalizePersonalMpesaPhoneDestination(value), value).toBeNull();
    }
  });
});

describe('masking never exposes a destination', () => {
  it('keeps only the leading digits and the last three', () => {
    expect(maskPayoutDestinationForLog('0712345678')).toBe('0712***678');
    expect(maskPayoutDestinationForLog('E2E-TILL')).toBe('E2***ILL');
  });

  it('fully masks a short or absent value', () => {
    expect(maskPayoutDestinationForLog('')).toBe('(none)');
    expect(maskPayoutDestinationForLog(null)).toBe('(none)');
    expect(maskPayoutDestinationForLog('12345')).toBe('***');
  });
});

// ---------------------------------------------------------------------------
// 1. The eligible cases.
// ---------------------------------------------------------------------------
describe('1. a valid finder leg and a valid personal M-Pesa agent leg are eligible', () => {
  it('accepts a finder phone in any documented form, canonicalised to 254 + nine digits', () => {
    for (const [input, canonical] of [
      ['0712345678', '254712345678'],
      ['+254712345678', '254712345678'],
      ['712345678', '254712345678'],
    ] as const) {
      const result = resolvePayoutLegEligibility(personal(input));
      expect(result.eligible, input).toBe(true);
      expect(result.reason, input).toBeNull();
      // The value the caller may submit is the canonical form, never the input.
      expect(result.canonicalDestination).toBe(canonical);
    }
  });

  it('accepts an agent whose stored method is exactly "Personal M-Pesa"', () => {
    const result = resolvePayoutLegEligibility(personalAgent('0712345678'));
    expect(result.eligible).toBe(true);
    expect(result.canonicalDestination).toBe('254712345678');
  });

  it('reports the masked destination even when the leg is eligible (for safe logging)', () => {
    expect(resolvePayoutLegEligibility(personal('0712345678')).maskedDestination).toBe('0712***678');
  });
});

// ---------------------------------------------------------------------------
// 2. Missing, malformed, too-short, too-long and non-Kenyan destinations.
// ---------------------------------------------------------------------------
describe('2. a destination that is not a Kenyan personal M-Pesa phone number is refused', () => {
  const notAPhone: Array<[string, unknown]> = [
    ['missing (undefined)', undefined],
    ['missing (null)', null],
    ['missing (empty string)', ''],
    ['missing (whitespace only)', '   '],
    ['malformed (no digits)', 'E2E-NOT-A-NUMBER'],
    ['too short', '07123456'],
    ['too long', '07123456789'],
    ['non-Kenyan (+255 Tanzania)', '+255712345678'],
    ['non-Kenyan (+1 US)', '+14155552671'],
    ['a non-mobile Kenyan range', '0812345678'],
  ];

  for (const [label, destination] of notAPhone) {
    it(`refuses ${label}`, () => {
      const result = resolvePayoutLegEligibility(personal(destination));
      expect(result.eligible, label).toBe(false);
      expect(result.canonicalDestination, label).toBeNull();
      expect(result.reason, label).toBe(
        label.startsWith('missing') ? 'destination_missing' : 'destination_not_a_personal_mpesa_phone',
      );
    });
  }

  it('applies to the agent leg exactly as it does to the finder leg', () => {
    expect(resolvePayoutLegEligibility(personalAgent('07123456')).reason).toBe('destination_not_a_personal_mpesa_phone');
    expect(resolvePayoutLegEligibility(personalAgent('')).reason).toBe('destination_missing');
  });
});

// ---------------------------------------------------------------------------
// 3. The method and the value are independent facts.
// ---------------------------------------------------------------------------
describe('3. an agent whose stored method is Till Number is refused even when the value looks like a phone', () => {
  it('refuses a phone-shaped value under an unsupported method', () => {
    for (const method of ['Till Number', 'Paybill Number', 'Pochi la Biashara']) {
      const result = resolvePayoutLegEligibility(personalAgent('0712345678', method));
      expect(result.eligible, method).toBe(false);
      // The destination itself is well-formed; it is the METHOD that is wrong.
      expect(result.reason, method).toBe('unsupported_payout_method');
      expect(result.canonicalDestination, method).toBeNull();
    }
  });

  it('refuses an agent whose method was never recorded (the stored default is "Till Number")', () => {
    expect(resolvePayoutLegEligibility(personalAgent('0712345678', 'Till Number')).eligible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Till, Paybill and Pochi la Biashara destinations.
// ---------------------------------------------------------------------------
describe('4. Till, Paybill and Pochi destinations are refused', () => {
  const unsupported: Array<[string, string, string]> = [
    ['a Till number value', '123456', 'Till Number'],
    ['a Paybill number value', '400200', 'Paybill Number'],
    ['a Pochi la Biashara value', '+254712345678', 'Pochi la Biashara'],
    ['a Pochi la Biashara handle', 'POCHI-777', 'Pochi la Biashara'],
  ];

  for (const [label, destination, method] of unsupported) {
    it(`refuses ${label}`, () => {
      // The refusal reason must be the method OR the shape, never an
      // acceptance: a value that happens to look like a phone is refused for its
      // method, and a value that is not a phone is refused for its shape.
      const result = resolvePayoutLegEligibility({
        recipientType: 'agent',
        destination,
        payoutMethodType: method,
      });
      expect(result.eligible, label).toBe(false);
      expect(['destination_not_a_personal_mpesa_phone', 'unsupported_payout_method'], label).toContain(result.reason);
      expect(result.canonicalDestination, label).toBeNull();
    });
  }

  it('refuses a Till value even when the stored method claims Personal M-Pesa', () => {
    // The stored method is not evidence about the value: a Till number sent as a
    // personal M-Pesa destination is still not a phone number.
    const result = resolvePayoutLegEligibility(personalAgent('123456', PERSONAL_MPESA_PAYOUT_METHOD));
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('destination_not_a_personal_mpesa_phone');
  });
});

// ---------------------------------------------------------------------------
// 5. Unknown or incorrectly cased method strings.
// ---------------------------------------------------------------------------
describe('5. unknown or incorrectly cased payout methods are refused', () => {
  const methods: unknown[] = [
    'personal m-pesa',
    'Personal m-pesa',
    'PERSONAL M-PESA',
    'Personal  M-Pesa',
    ' Personal M-Pesa',
    'Personal M-Pesa ',
    'M-Pesa',
    'Send Money',
    'till',
    'till number',
    '',
    undefined,
    null,
  ];

  for (const method of methods) {
    it(`refuses the method ${JSON.stringify(method)}`, () => {
      // The property is set EXPLICITLY (rather than through the helper's
      // default parameter, which would substitute the supported literal for an
      // undefined argument) so a method that is missing from the stored row is
      // genuinely under test.
      const result = resolvePayoutLegEligibility({
        recipientType: 'agent',
        destination: '0712345678',
        payoutMethodType: method,
      });
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('unsupported_payout_method');
    });
  }

  it('accepts the one exact literal', () => {
    expect(PERSONAL_MPESA_PAYOUT_METHOD).toBe('Personal M-Pesa');
    expect(resolvePayoutLegEligibility(personalAgent('0712345678', 'Personal M-Pesa')).eligible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6 and 7. Batch level: one bad leg poisons the batch; two bad legs cannot pay.
// ---------------------------------------------------------------------------
describe('6. one valid leg plus one ineligible leg makes the WHOLE batch ineligible', () => {
  it('refuses the batch when the agent leg is a Till destination', () => {
    const batch = resolvePayoutBatchEligibility([
      personal('0712345678'),
      personalAgent('123456', 'Till Number'),
    ]);

    // The finder leg is individually fine...
    expect(batch.legs[0].eligible).toBe(true);
    expect(batch.legs[0].canonicalDestination).toBe('254712345678');
    // ...but the batch is NOT, so no partial or mixed batch can be submitted.
    expect(batch.eligible).toBe(false);
    expect(batch.ineligible).toHaveLength(1);
    expect(batch.ineligible[0].recipientType).toBe('agent');
  });

  it('refuses the batch when the FINDER leg is the bad one', () => {
    const batch = resolvePayoutBatchEligibility([
      personal('not-a-phone'),
      personalAgent('0712345678'),
    ]);
    expect(batch.legs[1].eligible).toBe(true);
    expect(batch.eligible).toBe(false);
    expect(batch.ineligible.map((leg) => leg.recipientType)).toEqual(['finder']);
  });
});

describe('7. two ineligible legs cannot pay', () => {
  it('refuses a batch in which neither leg is eligible', () => {
    const batch = resolvePayoutBatchEligibility([
      personal('E2E-NOT-A-NUMBER'),
      personalAgent('', 'Paybill Number'),
    ]);
    expect(batch.eligible).toBe(false);
    expect(batch.ineligible).toHaveLength(2);
    expect(batch.ineligible.map((leg) => leg.reason)).toEqual([
      'destination_not_a_personal_mpesa_phone',
      'destination_missing',
    ]);
  });

  it('treats an EMPTY batch as ineligible (no legs is not "no objections")', () => {
    for (const empty of [[], null, undefined]) {
      expect(resolvePayoutBatchEligibility(empty as any).eligible).toBe(false);
    }
  });

  it('accepts a batch only when every leg is eligible', () => {
    const batch = resolvePayoutBatchEligibility([personal('0712345678'), personalAgent('0722000111')]);
    expect(batch.eligible).toBe(true);
    expect(batch.ineligible).toEqual([]);
    expect(batch.legs.map((leg) => leg.canonicalDestination)).toEqual(['254712345678', '254722000111']);
  });
});

// ---------------------------------------------------------------------------
// The operator-facing refusal text must be safe to log and to return.
// ---------------------------------------------------------------------------
describe('the refusal description is actionable and PII-free', () => {
  it('never contains the raw destination and never claims verification', () => {
    const raw = '0712345678';
    const refusal = describePayoutDestinationRefusal(
      resolvePayoutLegEligibility(personalAgent(raw, 'Pochi la Biashara')),
    );
    expect(refusal).not.toContain(raw);
    expect(refusal).not.toContain('254712345678');
    expect(refusal.toLowerCase()).not.toMatch(/verified|validated|confirmed/);
    // It does say which recipient, and why.
    expect(refusal).toContain('agent');
    expect(refusal).toContain(PERSONAL_MPESA_PAYOUT_METHOD);
  });

  it('names the observed destination MASKED, for a malformed value', () => {
    const refusal = describePayoutDestinationRefusal(resolvePayoutLegEligibility(personal('E2E-NOT-A-NUMBER')));
    expect(refusal).toContain('finder');
    expect(refusal).toContain('254 followed by nine digits');
    expect(refusal).not.toContain('E2E-NOT-A-NUMBER');
    expect(refusal).toContain('***');
  });
});
