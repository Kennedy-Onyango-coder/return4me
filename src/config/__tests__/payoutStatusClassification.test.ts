import { describe, it, expect } from 'vitest';
import {
  classifyPayoutTransactionStatus,
  readProviderTransactionStatus,
  matchPayoutTransactionToLegs,
  resolvePayoutTransactionBindings,
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

// =============================================================================
// BATCH 1B-C1 — BINDING THE INITIATION RESPONSE TO THE SUBMITTED LEGS.
// =============================================================================
// The other half of the same question. `matchPayoutTransactionToLegs` above binds
// a provider transaction that was ALREADY recorded on a leg; this function
// decides which provider transaction id may be recorded on a leg in the first
// place, from the initiation response.
//
// It replaces a suffix match on the destination account
// (`acct.endsWith(destination.slice(-9))`), which is not an identity: the finder
// and agent accounts below genuinely collide on their last nine digits, and
// `find()` handed the first matching entry to BOTH legs.
//
// The rules pinned here are exact equality on the account WE submitted, plus a
// refusal for every ambiguity. A refusal is `providerTransactionId: null`, which
// leaves the leg unresolved — never a wrong id, never a fabricated one.
// =============================================================================
const SUBMITTED_FINDER = { id: 'finder', account: '254712345678' };
// Deliberately the SAME last nine digits as the finder account: this is the
// collision the old suffix matcher could not tell apart.
const SUBMITTED_AGENT = { id: 'agent', account: '712345678' };
const SUBMITTED = [SUBMITTED_FINDER, SUBMITTED_AGENT];

const transaction = (account: unknown, transactionId: unknown) => ({
  account,
  transaction_id: transactionId,
});

describe('BATCH 1B-C1 — an initiation transaction binds only on an exact, unique account', () => {
  it('binds each submitted leg to its OWN provider transaction', () => {
    const report = resolvePayoutTransactionBindings(SUBMITTED, [
      transaction('254712345678', 'KQ9PLXR'),
      transaction('712345678', 'AB7CDE1'),
    ]);

    expect(report.bindings).toEqual([
      { id: 'finder', providerTransactionId: 'KQ9PLXR', outcome: 'bound' },
      { id: 'agent', providerTransactionId: 'AB7CDE1', outcome: 'bound' },
    ]);
    expect(report.unmatchedProviderTransactions).toBe(0);
  });

  it('never binds across the shared account SUFFIX (the defect this replaces)', () => {
    // The provider answered about the AGENT only. The finder account ends with
    // the agent account's digits, so the old suffix matcher bound the agent's
    // transaction to the finder leg as well. It must not any more.
    const report = resolvePayoutTransactionBindings(SUBMITTED, [
      transaction('712345678', 'AB7CDE1'),
    ]);

    expect(report.bindings[0]).toEqual({
      id: 'finder', providerTransactionId: null, outcome: 'provider_transaction_not_found',
    });
    expect(report.bindings[1]).toEqual({
      id: 'agent', providerTransactionId: 'AB7CDE1', outcome: 'bound',
    });
  });

  it('refuses a match that carries no usable provider transaction id', () => {
    for (const id of [null, undefined, '', '   ', 12345, { id: 'X' }]) {
      const report = resolvePayoutTransactionBindings([SUBMITTED_FINDER], [
        transaction('254712345678', id),
      ]);
      expect(report.bindings[0]).toEqual({
        id: 'finder', providerTransactionId: null, outcome: 'provider_transaction_id_missing',
      });
    }
  });

  it('refuses a DUPLICATED provider transaction for one account', () => {
    const report = resolvePayoutTransactionBindings([SUBMITTED_FINDER], [
      transaction('254712345678', 'TX-1'),
      transaction('254712345678', 'TX-2'),
    ]);

    expect(report.bindings[0].providerTransactionId).toBeNull();
    expect(report.bindings[0].outcome).toBe('provider_transaction_ambiguous');
  });

  it('refuses BOTH legs when two of them were submitted with the same account', () => {
    const report = resolvePayoutTransactionBindings(
      [{ id: 'finder', account: '254712345678' }, { id: 'agent', account: '254 712 345 678' }],
      [transaction('254712345678', 'TX-1')],
    );

    // Whitespace is not an identity difference, so this is ONE account sent
    // twice: a transaction for it is evidence about neither leg.
    expect(report.bindings).toEqual([
      { id: 'finder', providerTransactionId: null, outcome: 'duplicate_local_leg_account' },
      { id: 'agent', providerTransactionId: null, outcome: 'duplicate_local_leg_account' },
    ]);
  });

  it('refuses a leg whose submitted account is blank', () => {
    for (const account of ['', '   ', null, undefined, {}, true]) {
      const report = resolvePayoutTransactionBindings(
        [{ id: 'finder', account: account as any }],
        [transaction(account, 'TX-1')],
      );
      expect(report.bindings[0]).toEqual({
        id: 'finder', providerTransactionId: null, outcome: 'leg_account_missing',
      });
    }
  });

  it('counts a provider transaction for an account we never submitted, and binds nothing', () => {
    const report = resolvePayoutTransactionBindings([SUBMITTED_FINDER], [
      transaction('254700000000', 'TX-OTHER'),
    ]);

    expect(report.bindings[0]).toEqual({
      id: 'finder', providerTransactionId: null, outcome: 'provider_transaction_not_found',
    });
    expect(report.unmatchedProviderTransactions).toBe(1);
  });

  it('reads ONLY the documented field names (no shape guessing)', () => {
    // `id` / `invoice` / `phone_number` / `destination` were probed by the old
    // implementation. A body that uses them is unrecognised, not bound.
    const report = resolvePayoutTransactionBindings([SUBMITTED_FINDER], [
      { phone_number: '254712345678', id: 'TX-1', invoice: 'TX-2' },
      { destination: '254712345678', transaction_id: 'TX-3' },
    ]);

    expect(report.bindings[0].providerTransactionId).toBeNull();
    expect(report.bindings[0].outcome).toBe('provider_transaction_not_found');
    expect(report.unmatchedProviderTransactions).toBe(2);
  });

  it('tolerates whitespace in the echoed account, but nothing else', () => {
    const spaced = resolvePayoutTransactionBindings([SUBMITTED_FINDER], [
      transaction(' 254 712 345 678 ', 'TX-1'),
    ]);
    expect(spaced.bindings[0]).toEqual({
      id: 'finder', providerTransactionId: 'TX-1', outcome: 'bound',
    });

    // A reformatted account is not the account we sent: refuse rather than guess.
    const reformatted = resolvePayoutTransactionBindings([SUBMITTED_FINDER], [
      transaction('0712345678', 'TX-1'),
    ]);
    expect(reformatted.bindings[0].providerTransactionId).toBeNull();
    expect(reformatted.bindings[0].outcome).toBe('provider_transaction_not_found');
  });

  it('refuses everything when the response carries no usable per-transaction array', () => {
    for (const body of [[], null, undefined, 'transactions', 42, {}]) {
      const report = resolvePayoutTransactionBindings(SUBMITTED, body as any);
      expect(report.bindings.map(binding => binding.providerTransactionId)).toEqual([null, null]);
      expect(report.bindings.map(binding => binding.outcome))
        .toEqual(['provider_transaction_not_found', 'provider_transaction_not_found']);
    }
  });

  it('returns one entry per submitted leg, in submission order, for no legs at all', () => {
    expect(resolvePayoutTransactionBindings([], [transaction('254712345678', 'TX-1')]))
      .toEqual({ bindings: [], unmatchedProviderTransactions: 1 });
    expect(resolvePayoutTransactionBindings(null, null))
      .toEqual({ bindings: [], unmatchedProviderTransactions: 0 });
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
