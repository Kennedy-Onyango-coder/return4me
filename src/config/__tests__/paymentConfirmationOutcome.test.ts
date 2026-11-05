import { describe, it, expect } from 'vitest';
import {
  alreadyReconciledPaymentConfirmation,
  describePaymentConfirmationOutcome,
  describePaymentConfirmationRefusal,
  isReconciledPaymentConfirmation,
  isRetryablePaymentConfirmationRefusal,
  isSettledPaymentConfirmation,
  paymentConfirmationHttpResult,
  pickupCodeFromOutcome,
  reconciledPaymentConfirmation,
  refusePaymentConfirmation,
  type PaymentConfirmationRefusalCode,
} from '../paymentConfirmationOutcome';

// =============================================================================
// GATE C / STAGE C1 - THE PAYMENT-CONFIRMATION OUTCOME CONTRACT.
//
// The defect: the IntaSend collection route answered `200 {"status":"ok"}` for
// every callback that did not throw, because the canonical confirmation path
// reported ELEVEN different refusals as `null`. This file pins the vocabulary
// that replaced that `null`: what each decision is called, whether it is
// retryable, and the provider-facing status/body it produces.
//
// Pure unit tests - no database, no provider, no HTTP.
// =============================================================================

/** Every code the union declares. Kept explicit so a new code must be added here. */
const ALL_CODES: PaymentConfirmationRefusalCode[] = [
  'claim_not_found',
  'item_not_found',
  'cross_claim_invoice',
  'session_amount_mismatch',
  'session_not_confirmable',
  'claim_amount_mismatch',
  'provider_amount_mismatch',
  'provider_verification_unavailable',
  'claim_not_payable',
];

const RECONCILED = reconciledPaymentConfirmation({
  claimId: 'CLAIM-1',
  invoiceId: 'INV-1',
  pickupCode: '123456',
  recoveredExpiredClaim: false,
});

const RECOVERED = reconciledPaymentConfirmation({
  claimId: 'CLAIM-1',
  invoiceId: 'INV-1',
  pickupCode: '654321',
  recoveredExpiredClaim: true,
});

const DUPLICATE = alreadyReconciledPaymentConfirmation('CLAIM-1', 'INV-1');

describe('the refusal catalogue', () => {
  it('has an operator message for every declared code', () => {
    for (const code of ALL_CODES) {
      const entry = describePaymentConfirmationRefusal(code);
      expect(entry, code).toBeTruthy();
      expect(entry.operator_message.length, code).toBeGreaterThan(10);
    }
  });

  it('treats ONLY a provider-verification failure as retryable', () => {
    // Every other refusal is a disagreement between verified facts and local
    // state: redelivering the same event cannot change a fact.
    for (const code of ALL_CODES) {
      expect(isRetryablePaymentConfirmationRefusal(code), code).toBe(
        code === 'provider_verification_unavailable',
      );
    }
  });

  it('describes the provider-verification refusal as withholding escrow', () => {
    const entry = describePaymentConfirmationRefusal('provider_verification_unavailable');
    expect(entry.operator_message).toMatch(/escrow is withheld/i);
    expect(entry.operator_message).toMatch(/could not verify/i);
  });

  it('never claims success in a refusal message', () => {
    for (const code of ALL_CODES) {
      expect(describePaymentConfirmationRefusal(code).operator_message, code).not.toMatch(
        /confirmed successfully|payment received/i,
      );
    }
  });
});

describe('outcome constructors', () => {
  it('builds a reconciled outcome carrying the pickup code and the recovery flag', () => {
    expect(RECONCILED).toEqual({
      kind: 'reconciled',
      claimId: 'CLAIM-1',
      invoiceId: 'INV-1',
      pickupCode: '123456',
      recoveredExpiredClaim: false,
    });
    expect(RECOVERED.kind === 'reconciled' && RECOVERED.recoveredExpiredClaim).toBe(true);
  });

  it('builds an already-reconciled outcome with no retryability at all', () => {
    expect(DUPLICATE).toEqual({ kind: 'already_reconciled', claimId: 'CLAIM-1', invoiceId: 'INV-1' });
    expect(DUPLICATE).not.toHaveProperty('retryable');
    expect(DUPLICATE).not.toHaveProperty('pickupCode');
  });

  it('marks a refusal retryable exactly when the catalogue says so', () => {
    for (const code of ALL_CODES) {
      const outcome = refusePaymentConfirmation('CLAIM-1', 'INV-1', code);
      expect(outcome.kind).toBe('refused');
      expect(outcome.kind === 'refused' && outcome.retryable, code).toBe(
        isRetryablePaymentConfirmationRefusal(code),
      );
      expect(outcome.kind === 'refused' && outcome.code).toBe(code);
    }
  });

  it('carries an optional non-sensitive detail without changing the retryability', () => {
    const outcome = refusePaymentConfirmation(
      'CLAIM-1',
      'INV-1',
      'claim_amount_mismatch',
      'amount 100 != expected fee 500',
    );
    expect(outcome).toMatchObject({
      kind: 'refused',
      code: 'claim_amount_mismatch',
      retryable: false,
      detail: 'amount 100 != expected fee 500',
    });
  });
});

describe('outcome predicates and the legacy adapter', () => {
  it('separates reconciled from already-reconciled from refused', () => {
    expect(isReconciledPaymentConfirmation(RECONCILED)).toBe(true);
    expect(isReconciledPaymentConfirmation(DUPLICATE)).toBe(false);
    expect(
      isReconciledPaymentConfirmation(refusePaymentConfirmation('C', 'I', 'claim_not_found')),
    ).toBe(false);

    // A duplicate IS settled - that is why it may be acknowledged as success.
    expect(isSettledPaymentConfirmation(RECONCILED)).toBe(true);
    expect(isSettledPaymentConfirmation(DUPLICATE)).toBe(true);
    expect(isSettledPaymentConfirmation(refusePaymentConfirmation('C', 'I', 'claim_not_found'))).toBe(
      false,
    );
  });

  it('the compatibility adapter yields a code only for a real reconciliation', () => {
    expect(pickupCodeFromOutcome(RECONCILED)).toBe('123456');
    expect(pickupCodeFromOutcome(DUPLICATE)).toBeNull();
    for (const code of ALL_CODES) {
      expect(pickupCodeFromOutcome(refusePaymentConfirmation('C', 'I', code)), code).toBeNull();
    }
  });
});

describe('the provider-facing encoding', () => {
  it('keeps the unchanged success body for a real reconciliation', () => {
    // Backwards compatibility is deliberate: nothing that already reads the
    // success body has to change in this stage.
    expect(paymentConfirmationHttpResult(RECONCILED)).toEqual({ status: 200, body: { status: 'ok' } });
  });

  it('answers 200 for a duplicate, marked as such and not as a new confirmation', () => {
    const result = paymentConfirmationHttpResult(DUPLICATE);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'ok', outcome: 'already_reconciled' });
  });

  it('NEVER answers 2xx for a refusal', () => {
    for (const code of ALL_CODES) {
      const result = paymentConfirmationHttpResult(refusePaymentConfirmation('C', 'I', code));
      expect(result.status, code).toBeGreaterThanOrEqual(400);
      // 5xx is reserved for an unexpected internal error (sendServerError); a
      // financial refusal is a business answer, not a server fault.
      expect(result.status, code).toBeLessThan(500);
      expect(result.body, code).toMatchObject({ status: 'refused', outcome: 'refused', code });
    }
  });

  it('uses 424 for a transient refusal and 409 for a permanent one', () => {
    expect(
      paymentConfirmationHttpResult(
        refusePaymentConfirmation('C', 'I', 'provider_verification_unavailable'),
      ),
    ).toEqual({
      status: 424,
      body: {
        status: 'refused',
        outcome: 'refused',
        code: 'provider_verification_unavailable',
        retryable: true,
      },
    });
    expect(
      paymentConfirmationHttpResult(refusePaymentConfirmation('C', 'I', 'cross_claim_invoice')),
    ).toEqual({
      status: 409,
      body: { status: 'refused', outcome: 'refused', code: 'cross_claim_invoice', retryable: false },
    });
  });

  it('leaks no amount, no claim status, no pickup code and no payload echo', () => {
    const bodies = [
      paymentConfirmationHttpResult(RECONCILED).body,
      paymentConfirmationHttpResult(DUPLICATE).body,
      ...ALL_CODES.map(
        (code) => paymentConfirmationHttpResult(refusePaymentConfirmation('C', 'I', code)).body,
      ),
    ];
    for (const body of bodies) {
      const serialised = JSON.stringify(body);
      expect(serialised).not.toMatch(/123456|654321/); // never the pickup code
      // No amount, phone or payload FIELD is echoed back - the machine code may
      // legitimately contain the word "amount" (it names the disagreement), but
      // a VALUE never does.
      expect(serialised).not.toMatch(/"(amount|value|phone|phone_number|payer|payer_phone)":/i);
      expect(serialised).not.toMatch(/\d{2,}/); // no money amount, no phone digits
      expect(Object.keys(body).sort()).toEqual(
        'code' in body
          ? ['code', 'outcome', 'retryable', 'status']
          : 'outcome' in body
            ? ['outcome', 'status']
            : ['status'],
      );
    }
  });
});

describe('operator log descriptions', () => {
  it('names the decision without ever exposing the pickup code', () => {
    expect(describePaymentConfirmationOutcome(RECONCILED)).toBe('reconciled');
    expect(describePaymentConfirmationOutcome(RECOVERED)).toMatch(/payment_window_expired/);
    expect(describePaymentConfirmationOutcome(DUPLICATE)).toMatch(/duplicate; nothing written/);
    expect(
      describePaymentConfirmationOutcome(refusePaymentConfirmation('C', 'I', 'claim_amount_mismatch')),
    ).toBe('refused: claim_amount_mismatch (permanent)');
    expect(
      describePaymentConfirmationOutcome(
        refusePaymentConfirmation('C', 'I', 'provider_verification_unavailable'),
      ),
    ).toBe('refused: provider_verification_unavailable (transient)');
    for (const outcome of [RECONCILED, RECOVERED]) {
      expect(describePaymentConfirmationOutcome(outcome)).not.toMatch(/123456|654321/);
    }
  });
});
