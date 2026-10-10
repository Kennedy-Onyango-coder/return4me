import { describe, it, expect } from 'vitest';
import {
  classifyPayoutTransactionStatus,
  readProviderTransactionStatus,
  matchPayoutTransactionToLegs,
  isPayoutConfirmable,
  CONFIRMABLE_PAYOUT_OUTCOMES,
} from '../payoutOutcomes';

// =============================================================================
// BATCH 1 — PROVIDER-VERIFIED PAYOUT CONFIRMATION: THE PURE HALF.
// =============================================================================
// Two pure functions decide whether provider evidence may complete a payout:
//
//   1. classifyPayoutTransactionStatus() — turns ONE provider status code into
//      a verdict. MUST be fail-closed: any code this build does not recognise is
//      'unknown', which no caller may read as success.
//   2. matchPayoutTransactionToLegs() — binds ONE provider transaction to
//      EXACTLY ONE local ledger leg. MUST refuse zero matches (an unmatched or
//      legacy row) and refuse two-or-more (ambiguous ids) — the two cases in
//      which "which leg did the provider mean?" has no provable answer.
//
// Both are pure, so every branch below is a real assertion about production
// logic rather than about a mock.
// =============================================================================

describe('BATCH 1 — provider transaction status classification', () => {
  it('maps the success code to completed', () => {
    expect(classifyPayoutTransactionStatus('TS100')).toBe('completed');
  });

  it('accepts the provider\'s human-readable suffix after the code token', () => {
    // IntaSend echoes e.g. "TS100 - Success". Matching the whole string would
    // make the ONLY success code fail to classify, which would leave every
    // completed payout unresolved forever.
    expect(classifyPayoutTransactionStatus('TS100 - Success')).toBe('completed');
    expect(classifyPayoutTransactionStatus('TS100: Transaction successful')).toBe('completed');
  });

  it('is case- and whitespace-insensitive for the code token', () => {
    expect(classifyPayoutTransactionStatus('  ts100 ')).toBe('completed');
    expect(classifyPayoutTransactionStatus('\tTF103\n')).toBe('failed');
  });

  it('maps the documented failure codes to failed', () => {
    for (const code of ['TF103', 'TF105', 'TF106']) {
      expect(classifyPayoutTransactionStatus(code), code).toBe('failed');
    }
    expect(classifyPayoutTransactionStatus('TF105 - Insufficient funds')).toBe('failed');
  });

  it('maps the cancellation code to cancelled', () => {
    expect(classifyPayoutTransactionStatus('TC108')).toBe('cancelled');
  });

  it('maps pending / on-hold / retrying codes to in_progress, never success', () => {
    for (const code of ['TP', 'TH', 'TR']) {
      expect(classifyPayoutTransactionStatus(code), code).toBe('in_progress');
    }
  });

  it('fails CLOSED on anything unrecognised', () => {
    // A future provider code, a typo, a partially-numeric code, or a code with
    // no separator must all be 'unknown' — never guessed at, never 'completed'.
    for (const raw of ['ZZ999', 'TS100X', 'SUCCESS', 'completed', 'TS10', 'TF104', 'TC1']) {
      expect(classifyPayoutTransactionStatus(raw), raw).toBe('unknown');
    }
  });

  it('fails CLOSED on a non-string or empty status', () => {
    for (const raw of [null, undefined, '', '   ', 42, 0, {}, [], true]) {
      expect(classifyPayoutTransactionStatus(raw), String(raw)).toBe('unknown');
    }
  });
});

// =============================================================================
// BATCH 1B — WHICH FIELD THE PROVIDER STATUS IS READ FROM.
// =============================================================================
// The provider returns BOTH a machine-readable code and a human-readable label:
//
//     { "status_code": "TS100", "status": "Successful" }
//
// The CODE is the contract; the label is presentation. Reading the label first
// (which this build did before Batch 1B) meant `TS100` was never seen at all, so
// a transfer the provider had genuinely completed classified as 'unknown' and its
// payout leg — and the settlement behind it — stayed unresolved forever.
//
// readProviderTransactionStatus() is the ONE place that precedence lives, and it
// is pure, so every assertion below is a real statement about production
// behaviour rather than about a mock.
// =============================================================================
describe('BATCH 1B — the machine-readable status code outranks the human-readable label', () => {
  it('{ status: "Successful", status_code: "TS100" } completes', () => {
    expect(readProviderTransactionStatus({ status: 'Successful', status_code: 'TS100' }))
      .toEqual({ providerStatus: 'TS100', verdict: 'completed' });
  });

  it('{ status: "Pending", status_code: "TP101" } is in_progress, not unknown', () => {
    // The regression this batch exists for: the provider\'s real in-flight code
    // is SUFFIXED, and the label ("Pending") is not a code at all. Reading the
    // label first classified this as 'unknown' and stalled reconciliation.
    expect(readProviderTransactionStatus({ status: 'Pending', status_code: 'TP101' }))
      .toEqual({ providerStatus: 'TP101', verdict: 'in_progress' });
  });

  it('classifies a code-only response correctly', () => {
    for (const [code, verdict] of [
      ['TS100', 'completed'],
      ['TP101', 'in_progress'],
      ['TP', 'in_progress'],
      ['TH', 'in_progress'],
      ['TF103', 'failed'],
      ['TF105', 'failed'],
      ['TC108', 'cancelled'],
    ] as const) {
      expect(readProviderTransactionStatus({ status_code: code }), code)
        .toEqual({ providerStatus: code, verdict });
    }
  });

  it('a human-readable-only response falls back to `status` and CANNOT complete a payout', () => {
    // THE DOCUMENTED SAFE FALLBACK. `status` is read only when the code is
    // absent/unusable, and a label is not a code — "Successful" is rewordable
    // presentation, so it resolves to 'unknown'. A provider revision that drops
    // `status_code` therefore degrades to "nothing can be confirmed", never to
    // "everything is completed".
    expect(readProviderTransactionStatus({ status: 'Successful' }))
      .toEqual({ providerStatus: 'Successful', verdict: 'unknown' });
    expect(readProviderTransactionStatus({ status: 'Pending' }))
      .toEqual({ providerStatus: 'Pending', verdict: 'unknown' });
    expect(readProviderTransactionStatus({ status: 'Transaction complete' }))
      .toEqual({ providerStatus: 'Transaction complete', verdict: 'unknown' });
    // ...and the fallback is still USEFUL when the CODE arrives in that field,
    // because classification matches the code SHAPE and not the field name.
    expect(readProviderTransactionStatus({ status: 'TS100' }))
      .toEqual({ providerStatus: 'TS100', verdict: 'completed' });
  });

  it('falls back to `status` when status_code is unusable (blank or not a string)', () => {
    for (const unusable of [null, undefined, '', '   ', 42, 0, true, {}, ['TS100']]) {
      expect(readProviderTransactionStatus({ status: 'TS100', status_code: unusable }), String(unusable))
        .toEqual({ providerStatus: 'TS100', verdict: 'completed' });
    }
  });

  it('an unknown or malformed status is unknown, never completed', () => {
    for (const malformed of [
      { status_code: 'ZZ999' },
      { status_code: 'TS10' },
      { status_code: 'TS100X' },
      { status_code: 'SUCCESS' },
      { status_code: 'TS101' },                          // unknown sibling of the one success code
      { status: 'Successful', status_code: 'TS101' },     // the label must not rescue it
      { status_code: 42 },
      { status_code: '' },
      {},
      null,
      undefined,
      'TS100',                                            // not an entry object at all
    ]) {
      const { verdict } = readProviderTransactionStatus(malformed);
      expect(verdict, JSON.stringify(malformed) ?? String(malformed)).toBe('unknown');
    }

    // When there is NO usable field at all, the status is reported as null —
    // never as '' and never as undefined — so a caller logging it sees an
    // explicit absence rather than an empty string it might treat as a code.
    for (const nothing of [{}, { status_code: '' }, { status_code: '   ' }, { status_code: 42 }, null, undefined, 'TS100']) {
      expect(readProviderTransactionStatus(nothing).providerStatus, String(nothing)).toBeNull();
    }
  });

  it('a padded or differently-cased code still beats the label', () => {
    // The precedence is about WHICH FIELD is read, not about how it is written:
    // the raw string is reported verbatim (useful for logging) while the verdict
    // comes from the classifier\'s own normalisation.
    expect(readProviderTransactionStatus({ status: 'Pending', status_code: '  tp101 ' }))
      .toEqual({ providerStatus: 'tp101', verdict: 'in_progress' });
  });
});

const LEG_A = { id: 'TXN-A', provider_batch_id: 'TRK-1', provider_transaction_id: 'TX-1' };
const LEG_B = { id: 'TXN-B', provider_batch_id: 'TRK-1', provider_transaction_id: 'TX-2' };

describe('BATCH 1 — a provider transaction binds to exactly ONE leg', () => {
  it('matches on the exact (batch id, transaction id) pair', () => {
    expect(matchPayoutTransactionToLegs({ batchId: 'TRK-1', transactionId: 'TX-1' }, [LEG_A, LEG_B]))
      .toBe('TXN-A');
    expect(matchPayoutTransactionToLegs({ batchId: 'TRK-1', transactionId: 'TX-2' }, [LEG_A, LEG_B]))
      .toBe('TXN-B');
  });

  it('ignores a batch id that matches but a transaction id that does not', () => {
    // A batch id alone covers EVERY leg in the batch, so it must never be enough.
    expect(matchPayoutTransactionToLegs({ batchId: 'TRK-1', transactionId: 'TX-9' }, [LEG_A, LEG_B]))
      .toBeNull();
  });

  it('ignores a transaction id that matches but a batch id that does not', () => {
    // A transaction id alone could belong to another batch entirely.
    expect(matchPayoutTransactionToLegs({ batchId: 'TRK-OTHER', transactionId: 'TX-1' }, [LEG_A, LEG_B]))
      .toBeNull();
  });

  it('refuses when TWO legs carry the same pair (ambiguous provider answer)', () => {
    // This is the shape the submission path can produce when it binds responses
    // by recipient account instead of by position. Choosing one would be a coin
    // flip, so both are left alone.
    const duplicate = [
      { id: 'TXN-A', provider_batch_id: 'TRK-1', provider_transaction_id: 'TX-1' },
      { id: 'TXN-B', provider_batch_id: 'TRK-1', provider_transaction_id: 'TX-1' },
    ];
    expect(matchPayoutTransactionToLegs({ batchId: 'TRK-1', transactionId: 'TX-1' }, duplicate))
      .toBeNull();
  });

  it('refuses a leg with no recorded provider identity (an unmatched legacy row)', () => {
    expect(matchPayoutTransactionToLegs({ batchId: 'TRK-1', transactionId: 'TX-1' }, [
      { id: 'TXN-LEGACY', provider_batch_id: null, provider_transaction_id: null },
    ])).toBeNull();
    expect(matchPayoutTransactionToLegs({ batchId: 'TRK-1', transactionId: 'TX-1' }, [
      { id: 'TXN-PARTIAL', provider_batch_id: 'TRK-1', provider_transaction_id: null },
    ])).toBeNull();
  });

  it('refuses an incomplete provider transaction', () => {
    expect(matchPayoutTransactionToLegs({ batchId: 'TRK-1', transactionId: null }, [LEG_A])).toBeNull();
    expect(matchPayoutTransactionToLegs({ batchId: null, transactionId: 'TX-1' }, [LEG_A])).toBeNull();
    expect(matchPayoutTransactionToLegs({ batchId: 'TRK-1', transactionId: '   ' }, [LEG_A])).toBeNull();
    expect(matchPayoutTransactionToLegs({}, [LEG_A])).toBeNull();
    expect(matchPayoutTransactionToLegs(null, [LEG_A])).toBeNull();
    expect(matchPayoutTransactionToLegs(undefined, [LEG_A])).toBeNull();
  });

  it('refuses when there are no candidate legs', () => {
    expect(matchPayoutTransactionToLegs({ batchId: 'TRK-1', transactionId: 'TX-1' }, [])).toBeNull();
    expect(matchPayoutTransactionToLegs({ batchId: 'TRK-1', transactionId: 'TX-1' }, null)).toBeNull();
    expect(matchPayoutTransactionToLegs({ batchId: 'TRK-1', transactionId: 'TX-1' }, undefined)).toBeNull();
  });

  it('is an EXACT match, so a differently-cased id does not bind', () => {
    expect(matchPayoutTransactionToLegs({ batchId: 'trk-1', transactionId: 'TX-1' }, [LEG_A]))
      .toBeNull();
  });

  it('tolerates surrounding whitespace on either side', () => {
    expect(matchPayoutTransactionToLegs({ batchId: ' TRK-1 ', transactionId: ' TX-1 ' }, [LEG_A]))
      .toBe('TXN-A');
  });
});

describe('BATCH 1 — only an unresolved, positively-recorded submission is confirmable', () => {
  it('is exactly the unresolved outcome list', () => {
    expect([...CONFIRMABLE_PAYOUT_OUTCOMES]).toEqual(['submitting', 'accepted', 'unknown']);
  });

  it('accepts a pending row with a recorded in-flight submission', () => {
    for (const outcome of CONFIRMABLE_PAYOUT_OUTCOMES) {
      expect(isPayoutConfirmable({ status: 'pending', payout_outcome: outcome }), outcome).toBe(true);
    }
  });

  it('refuses a row that never recorded a submission', () => {
    expect(isPayoutConfirmable({ status: 'pending', payout_outcome: 'not_submitted' })).toBe(false);
  });

  it('refuses a refused, already-paid, or unknown-history row', () => {
    expect(isPayoutConfirmable({ status: 'pending', payout_outcome: 'rejected' })).toBe(false);
    expect(isPayoutConfirmable({ status: 'pending', payout_outcome: 'completed' })).toBe(false);
    // NULL is a legacy row: we cannot prove it was ever submitted.
    expect(isPayoutConfirmable({ status: 'pending', payout_outcome: null })).toBe(false);
    expect(isPayoutConfirmable({ status: 'pending' })).toBe(false);
  });

  it('refuses any row that is no longer bookable', () => {
    expect(isPayoutConfirmable({ status: 'completed', payout_outcome: 'accepted' })).toBe(false);
    expect(isPayoutConfirmable({ status: 'failed', payout_outcome: 'accepted' })).toBe(false);
  });

  it('refuses a missing row', () => {
    expect(isPayoutConfirmable(null)).toBe(false);
    expect(isPayoutConfirmable(undefined)).toBe(false);
  });
});
