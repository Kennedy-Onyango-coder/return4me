import { describe, it, expect } from 'vitest';
import {
  evaluatePayoutRepairEligibility,
  isPayoutRepairRequestExpired,
  payoutRepairExpiryFor,
  payoutRepairRequestFingerprint,
  payoutRowFingerprint,
  auditEntryNamesLedgerRow,
  parsePayoutRefusalEvidence,
  redactPayoutFailureReasonForAudit,
  PAYOUT_REPAIR_AUDIT_ACTIONS,
  PAYOUT_REPAIR_BLOCKING_CODES,
  PAYOUT_REPAIR_PROPOSAL_TTL_MS,
  PAYOUT_REFUSAL_EVIDENCE_ACTION,
  PAYOUT_REFUSAL_EVIDENCE_PREFIX,
  type PayoutRepairAuditSnapshot,
  type PayoutRepairClaimSnapshot,
  type PayoutRepairLedgerSnapshot,
} from '../config/payoutRepairPolicy';

// =============================================================================
// PHASE 1 — THE REPAIR ELIGIBILITY RULE
// =============================================================================
// These are the tests that matter: they encode exactly which rows may EVER be
// released, and they exist mainly to prove what is REFUSED. Every fixture below
// is synthetic; none of them is production data.

const ROW_ID = 'LED-RPR-TEST-1';

function leg(overrides: Partial<PayoutRepairLedgerSnapshot> = {}): PayoutRepairLedgerSnapshot {
  return {
    id: ROW_ID,
    claim_id: 'CLM-RPR-TEST',
    item_id: 'ITM-RPR-TEST',
    type: 'finder_payout',
    amount: '100.00',
    phone_or_till: '+254712345678',
    status: 'failed',
    // The ONE positively-recorded non-execution state.
    payout_outcome: 'rejected',
    provider_batch_id: 'BATCH-1',
    provider_transaction_id: null,
    failure_reason: 'IntaSend refused this transaction (provider rejection - the transfer was not executed).',
    ...overrides,
  };
}

const claim = (status: string | null = 'pending_settlement'): PayoutRepairClaimSnapshot => ({
  id: 'CLM-RPR-TEST',
  status,
});

function audit(action: string, details: string, id = 'AUD-1'): PayoutRepairAuditSnapshot {
  return { id, action, details };
}

/**
 * A syntactically valid, row-matching refusal-evidence record. This is the
 * EXTERNAL evidence the policy now requires; no production code writes it.
 * Tests vary individual fields to prove each check refuses.
 */
function refusalEvidence(
  row: PayoutRepairLedgerSnapshot,
  overrides: Record<string, unknown> = {},
  id = 'AUD-EVIDENCE-1',
): PayoutRepairAuditSnapshot {
  const role = row.type === 'finder_payout' ? 'FINDER' : row.type === 'agent_payout' ? 'AGENT' : 'FINDER';
  const payload = {
    version: 1,
    ledger_entry_id: row.id,
    provider: 'intasend',
    provider_batch_id: row.provider_batch_id ?? null,
    provider_transaction_id: null,
    idempotency_key: `PAYOUT_LEG_${role}:${row.claim_id}`,
    idempotency_key_disposition: 'released',
    non_execution_reference: 'INTASEND-REFUSAL-REFERENCE-0001',
    recorded_by: 'reconciliation-operator',
    recorded_at: '2026-05-01T08:00:00.000Z',
    ...overrides,
  };
  return audit(
    PAYOUT_REFUSAL_EVIDENCE_ACTION,
    `${PAYOUT_REFUSAL_EVIDENCE_PREFIX}${JSON.stringify(payload)}`,
    id,
  );
}

function evaluate(
  row: PayoutRepairLedgerSnapshot | null,
  options: {
    claim?: PayoutRepairClaimSnapshot | null;
    claimLedger?: PayoutRepairLedgerSnapshot[];
    audit?: PayoutRepairAuditSnapshot[];
    /** `null` suppresses the default evidence; an array replaces it. */
    refusal?: PayoutRepairAuditSnapshot[] | null;
  } = {},
) {
  const evidenceAudit =
    options.refusal === null
      ? []
      : options.refusal ?? (row ? [refusalEvidence(row)] : []);
  return evaluatePayoutRepairEligibility({
    ledgerEntry: row,
    claim: options.claim === undefined ? claim() : options.claim,
    claimLedger: options.claimLedger ?? (row ? [row] : []),
    auditEntries: [...evidenceAudit, ...(options.audit ?? [])],
  });
}

describe('payout repair eligibility — the one eligible class', () => {
  it('accepts a failed + provider-rejected leg whose claim is stranded in pending_settlement', () => {
    const result = evaluate(leg());
    expect(result.eligible).toBe(true);
    expect(result.blockingCodes).toEqual([]);
    expect(result.operation).toBe('release_rejected_leg');
    expect(result.fromStatus).toBe('failed');
    expect(result.fromOutcome).toBe('rejected');
    expect(result.toStatus).toBe('pending');
    expect(result.toOutcome).toBe('not_submitted');
    // The digest is PII-safe: a masked destination, never the number.
    expect(result.evidence.destinationMasked).toBeTruthy();
    expect(result.evidence.destinationMasked).not.toContain('712345678');
  });

  it('accepts the same class with no provider batch reference at all', () => {
    const result = evaluate(leg({ provider_batch_id: null }));
    expect(result.eligible).toBe(true);
  });
});

describe('payout repair eligibility — submission history', () => {
  it('REFUSES a legacy failed row whose payout_outcome is NULL', () => {
    const result = evaluate(leg({ payout_outcome: null }));
    expect(result.eligible).toBe(false);
    expect(result.blockingCodes).toContain(PAYOUT_REPAIR_BLOCKING_CODES.SUBMISSION_HISTORY_MISSING);
    // The reason must say plainly that absence of a record is not proof.
    const text = result.blockingReasons.join(' ');
    expect(text).toMatch(/not proof|NOT evidence/i);
  });

  it('REFUSES a NULL-outcome row even when every other field looks perfect', () => {
    // This is the whole point of the phase: status/error text/dashboard labels
    // are not evidence. A perfect-looking row with no submission record is
    // blocked, and blocked for exactly that reason.
    const result = evaluate(
      leg({ payout_outcome: null, provider_transaction_id: null, failure_reason: 'failed' }),
    );
    expect(result.eligible).toBe(false);
    expect(result.blockingCodes).toEqual([PAYOUT_REPAIR_BLOCKING_CODES.SUBMISSION_HISTORY_MISSING]);
  });

  it.each(['submitting', 'accepted', 'unknown'])(
    'REFUSES outcome %s because the transfer may already have moved money',
    (outcome) => {
      const result = evaluate(leg({ payout_outcome: outcome }));
      expect(result.eligible).toBe(false);
      expect(result.blockingCodes).toContain(PAYOUT_REPAIR_BLOCKING_CODES.SUBMISSION_MAY_HAVE_OCCURRED);
    },
  );

  it('REFUSES a completed row', () => {
    const result = evaluate(leg({ payout_outcome: 'completed' }));
    expect(result.eligible).toBe(false);
    expect(result.blockingCodes).toContain(PAYOUT_REPAIR_BLOCKING_CODES.ALREADY_COMPLETED);
  });

  it('REFUSES a row that already records not_submitted (nothing to repair)', () => {
    const result = evaluate(leg({ payout_outcome: 'not_submitted', status: 'pending' }));
    expect(result.eligible).toBe(false);
    expect(result.blockingCodes).toContain(PAYOUT_REPAIR_BLOCKING_CODES.NOTHING_TO_REPAIR);
    expect(result.blockingCodes).toContain(PAYOUT_REPAIR_BLOCKING_CODES.STATUS_NOT_REPAIRABLE);
  });

  it('REFUSES an unrecognised payout outcome', () => {
    const result = evaluate(leg({ payout_outcome: 'probably_fine' }));
    expect(result.eligible).toBe(false);
    expect(result.blockingCodes).toContain(PAYOUT_REPAIR_BLOCKING_CODES.PAYOUT_OUTCOME_UNRECOGNIZED);
  });

  it('REFUSES a rejected row that also carries a provider transaction reference', () => {
    const result = evaluate(leg({ provider_transaction_id: 'TXN-123' }));
    expect(result.eligible).toBe(false);
    expect(result.blockingCodes).toContain(
      PAYOUT_REPAIR_BLOCKING_CODES.PROVIDER_TRANSACTION_REFERENCE_AMBIGUOUS,
    );
  });

  it('REFUSES a rejected row with no recorded failure evidence', () => {
    const result = evaluate(leg({ failure_reason: '   ' }));
    expect(result.eligible).toBe(false);
    expect(result.blockingCodes).toContain(PAYOUT_REPAIR_BLOCKING_CODES.FAILURE_EVIDENCE_MISSING);
  });
});

describe('payout repair eligibility — association, state and ledger consistency', () => {
  it('REFUSES a missing row', () => {
    const result = evaluate(null);
    expect(result.eligible).toBe(false);
    expect(result.blockingCodes).toEqual([PAYOUT_REPAIR_BLOCKING_CODES.ROW_NOT_FOUND]);
  });

  it('REFUSES a non-payout ledger row', () => {
    const result = evaluate(leg({ type: 'platform_fee' }));
    expect(result.eligible).toBe(false);
    expect(result.blockingCodes).toContain(PAYOUT_REPAIR_BLOCKING_CODES.NOT_A_PAYOUT_LEG);
  });

  it('REFUSES a row with no claim association', () => {
    const result = evaluate(leg({ claim_id: null }), { claim: null });
    expect(result.eligible).toBe(false);
    expect(result.blockingCodes).toContain(PAYOUT_REPAIR_BLOCKING_CODES.CLAIM_ASSOCIATION_MISSING);
  });

  it('REFUSES a row whose claim cannot be read', () => {
    const result = evaluate(leg(), { claim: null });
    expect(result.eligible).toBe(false);
    expect(result.blockingCodes).toContain(PAYOUT_REPAIR_BLOCKING_CODES.CLAIM_NOT_FOUND);
  });

  it.each(['releasing', 'released', 'refunded', 'disputed'])(
    'REFUSES a claim in state %s',
    (status) => {
      const result = evaluate(leg(), { claim: claim(status) });
      expect(result.eligible).toBe(false);
      expect(result.blockingCodes).toContain(PAYOUT_REPAIR_BLOCKING_CODES.CLAIM_STATE_NOT_REPAIRABLE);
    },
  );

  it('REFUSES a leg whose sibling of the same role is already completed', () => {
    const sibling = leg({ id: 'LED-RPR-TEST-2', status: 'completed', payout_outcome: 'completed' });
    const result = evaluate(leg(), { claimLedger: [leg(), sibling] });
    expect(result.eligible).toBe(false);
    expect(result.blockingCodes).toContain(
      PAYOUT_REPAIR_BLOCKING_CODES.DUPLICATE_LEG_ALREADY_COMPLETED,
    );
  });

  it('REFUSES a leg whose sibling of the same role is already submittable', () => {
    const sibling = leg({ id: 'LED-RPR-TEST-2', status: 'pending', payout_outcome: 'not_submitted' });
    const result = evaluate(leg(), { claimLedger: [leg(), sibling] });
    expect(result.eligible).toBe(false);
    expect(result.blockingCodes).toContain(PAYOUT_REPAIR_BLOCKING_CODES.CONFLICTING_LEDGER_STATE);
  });

  it('ignores a sibling of the OTHER role (legs are independent)', () => {
    const otherRole = leg({ id: 'LED-RPR-TEST-2', type: 'agent_payout', status: 'pending', payout_outcome: 'not_submitted' });
    const result = evaluate(leg(), { claimLedger: [leg(), otherRole] });
    expect(result.eligible).toBe(true);
  });

  it('REFUSES a row with no destination, and one with a non-positive amount', () => {
    expect(evaluate(leg({ phone_or_till: '' })).blockingCodes).toContain(
      PAYOUT_REPAIR_BLOCKING_CODES.DESTINATION_MISSING,
    );
    expect(evaluate(leg({ amount: '0' })).blockingCodes).toContain(
      PAYOUT_REPAIR_BLOCKING_CODES.AMOUNT_INVALID,
    );
  });
});

describe('payout repair eligibility — corroborating audit evidence', () => {
  it('REFUSES a row that an inconclusive audit record names', () => {
    const result = evaluate(leg(), {
      audit: [audit('PAYOUT_NOT_CONFIRMED', `Claim CLM-RPR-TEST ledger row ${ROW_ID} outcome unknown`)],
    });
    expect(result.eligible).toBe(false);
    expect(result.blockingCodes).toContain(PAYOUT_REPAIR_BLOCKING_CODES.AUDIT_EVIDENCE_AMBIGUOUS);
  });

  it('REFUSES a row that has already been repaired once', () => {
    const result = evaluate(leg(), {
      audit: [audit(PAYOUT_REPAIR_AUDIT_ACTIONS.CONFIRMED, `Payout repair RPR-1 for ledger row ${ROW_ID}`)],
    });
    expect(result.eligible).toBe(false);
    expect(result.blockingCodes).toContain(PAYOUT_REPAIR_BLOCKING_CODES.ALREADY_REPAIRED);
  });

  it('does NOT block on a record naming a different row whose id is a prefix of this one', () => {
    const result = evaluate(leg({ id: 'LED-1234' }), {
      audit: [audit('PAYOUT_NOT_CONFIRMED', 'ledger row LED-12345 outcome unknown')],
    });
    expect(result.eligible).toBe(true);
  });

  it('the word-boundary matcher is exact about separators', () => {
    expect(auditEntryNamesLedgerRow('row LED-77 is unresolved', 'LED-77')).toBe(true);
    expect(auditEntryNamesLedgerRow('row LED-771 is unresolved', 'LED-77')).toBe(false);
    expect(auditEntryNamesLedgerRow('LED-77a', 'LED-77')).toBe(false);
    expect(auditEntryNamesLedgerRow('', 'LED-77')).toBe(false);
  });
});

describe('F1/F7 — refusal provenance is required and must match the retry', () => {
  it('REFUSES rejected with NO imported evidence (the production default)', () => {
    const result = evaluate(leg(), { refusal: null });
    expect(result.eligible).toBe(false);
    expect(result.blockingCodes).toContain(
      PAYOUT_REPAIR_BLOCKING_CODES.REFUSAL_PROVENANCE_UNVERIFIED,
    );
    expect(result.blockingReasons.join(' ')).toMatch(/not proof/i);
    expect(result.evidence.refusalEvidenceValid).toBe(false);
  });

  it('REFUSES a malformed evidence record that names the row', () => {
    const result = evaluate(leg(), {
      refusal: [
        audit(
          PAYOUT_REFUSAL_EVIDENCE_ACTION,
          `${PAYOUT_REFUSAL_EVIDENCE_PREFIX}{not json ${ROW_ID}`,
          'AUD-BAD',
        ),
      ],
    });
    expect(result.eligible).toBe(false);
    expect(result.blockingCodes).toContain(
      PAYOUT_REPAIR_BLOCKING_CODES.REFUSAL_PROVENANCE_UNVERIFIED,
    );
  });

  it('REFUSES evidence about a DIFFERENT ledger row', () => {
    const other = leg({ id: 'LED-OTHER' });
    const result = evaluate(leg(), { refusal: [refusalEvidence(other)] });
    expect(result.eligible).toBe(false);
    expect(result.blockingCodes).toContain(
      PAYOUT_REPAIR_BLOCKING_CODES.REFUSAL_PROVENANCE_UNVERIFIED,
    );
  });

  it.each([
    ['a different idempotency key', { idempotency_key: 'PAYOUT_LEG_FINDER:CLM-OTHER' }],
    ['a different provider batch', { provider_batch_id: 'BATCH-OTHER' }],
    ['a provider transaction reference', { provider_transaction_id: 'TXN-1' }],
    ['the wrong provider', { provider: 'other-provider' }],
  ])('REFUSES evidence with %s', (_label, overrides) => {
    const result = evaluate(leg(), { refusal: [refusalEvidence(leg(), overrides)] });
    expect(result.eligible).toBe(false);
    expect(result.blockingCodes).toContain(
      PAYOUT_REPAIR_BLOCKING_CODES.REFUSAL_EVIDENCE_CONFLICTING,
    );
  });

  it('REFUSES two evidence records for the same row (conflict, never a pick-one)', () => {
    const result = evaluate(leg(), {
      refusal: [refusalEvidence(leg(), {}, 'AUD-E1'), refusalEvidence(leg(), {}, 'AUD-E2')],
    });
    expect(result.eligible).toBe(false);
    expect(result.blockingCodes).toContain(
      PAYOUT_REPAIR_BLOCKING_CODES.REFUSAL_EVIDENCE_CONFLICTING,
    );
  });

  it('REFUSES an unrecognised idempotency-key disposition (F7 unresolved)', () => {
    const result = evaluate(leg(), {
      refusal: [refusalEvidence(leg(), { idempotency_key_disposition: 'probably_reusable' })],
    });
    expect(result.eligible).toBe(false);
    expect(result.blockingCodes).toContain(
      PAYOUT_REPAIR_BLOCKING_CODES.IDEMPOTENCY_KEY_STATE_UNVERIFIED,
    );
  });

  it.each(['released', 'never_consumed'])(
    'ACCEPTS evidence that states the key disposition %s, and reports it',
    (disposition) => {
      const result = evaluate(leg(), {
        refusal: [refusalEvidence(leg(), { idempotency_key_disposition: disposition })],
      });
      expect(result.eligible).toBe(true);
      expect(result.evidence.refusalEvidenceValid).toBe(true);
      expect(result.evidence.refusalEvidenceCount).toBe(1);
      expect(result.evidence.idempotencyKeyDisposition).toBe(disposition);
    },
  );

  it('parses only the strict versioned envelope, never a lookalike audit row', () => {
    expect(parsePayoutRefusalEvidence('PAYOUT_REFUSAL_EVIDENCE_V1 {"version":2}')).toBeNull();
    expect(parsePayoutRefusalEvidence('PAYOUT_REFUSAL_EVIDENCE_V1 nope')).toBeNull();
    expect(parsePayoutRefusalEvidence('some other audit text')).toBeNull();
    expect(parsePayoutRefusalEvidence(refusalEvidence(leg()).details)).toMatchObject({
      ledger_entry_id: ROW_ID,
      idempotency_key_disposition: 'released',
    });
  });
});

describe('F6 — batch-scoped and unrecognised audit evidence', () => {
  it("REFUSES when a provider-verification event names this row's batch", () => {
    const result = evaluate(leg(), {
      audit: [
        audit(
          'PAYOUT_VERIFICATION_UNMATCHED',
          'Payout batch BATCH-1: provider reported transaction TXN-9 completed, but it does not match exactly ONE local payout leg.',
        ),
      ],
    });
    expect(result.eligible).toBe(false);
    expect(result.blockingCodes).toContain(PAYOUT_REPAIR_BLOCKING_CODES.AUDIT_EVIDENCE_AMBIGUOUS);
    expect(result.evidence.batchScopedAuditEvidenceCount).toBe(1);
  });

  it('ignores a provider-verification event for a DIFFERENT batch (excludable)', () => {
    const result = evaluate(leg(), {
      audit: [
        audit(
          'PAYOUT_VERIFIED_COMPLETED',
          'Payout batch BATCH-OTHER: ledger leg LED-X confirmed completed from the authoritative provider status.',
        ),
      ],
    });
    expect(result.eligible).toBe(true);
  });

  it('FAILS CLOSED when the claim carries no batch id and a batch event cannot be linked', () => {
    const result = evaluate(leg({ provider_batch_id: null }), {
      audit: [
        audit(
          'PAYOUT_VERIFICATION_UNMATCHED',
          'Payout batch BATCH-UNKNOWN: provider reported transaction TXN-9 completed, but it does not match exactly ONE local payout leg.',
        ),
      ],
    });
    expect(result.eligible).toBe(false);
    expect(result.blockingCodes).toContain(PAYOUT_REPAIR_BLOCKING_CODES.AUDIT_EVIDENCE_AMBIGUOUS);
    expect(result.evidence.unlinkableBatchAuditEvidenceCount).toBe(1);
  });

  it('REFUSES ANY unrecognised action that names the row (inverted allowlist)', () => {
    const result = evaluate(leg(), {
      audit: [audit('SOME_FUTURE_PROVIDER_EVENT', `ledger row ${ROW_ID} executed`)],
    });
    expect(result.eligible).toBe(false);
    expect(result.blockingCodes).toContain(PAYOUT_REPAIR_BLOCKING_CODES.AUDIT_EVIDENCE_AMBIGUOUS);
  });

  it('does not block on the known-safe actions that mention the row', () => {
    const result = evaluate(leg(), {
      audit: [
        audit(
          'CLAIM_SETTLEMENT_PAYOUT_ATTEMPTED',
          `Settlement payout submission starting for claim CLM-RPR-TEST. ledger row ${ROW_ID}`,
        ),
        audit(PAYOUT_REPAIR_AUDIT_ACTIONS.PROPOSED, `Payout repair RPR-1 for ledger row ${ROW_ID}`),
      ],
    });
    expect(result.eligible).toBe(true);
  });
});

describe('payout repair — fingerprints and expiry (stale-proposal detection)', () => {
  it('the row fingerprint is stable for identical rows and changes with any reviewed field', () => {
    const base = payoutRowFingerprint(leg());
    expect(base).toMatch(/^[a-f0-9]{64}$/);
    expect(payoutRowFingerprint(leg())).toBe(base);

    // Every field the repair reads or writes is covered.
    expect(payoutRowFingerprint(leg({ status: 'pending' }))).not.toBe(base);
    expect(payoutRowFingerprint(leg({ payout_outcome: 'unknown' }))).not.toBe(base);
    expect(payoutRowFingerprint(leg({ amount: '101.00' }))).not.toBe(base);
    // F5 — the destination is now covered, as a hash. A changed destination
    // invalidates the proposal; the raw value never appears in the digest.
    const destinationChanged = payoutRowFingerprint(leg({ phone_or_till: '+254799999999' }));
    expect(destinationChanged).not.toBe(base);
    expect(destinationChanged).not.toContain('254799999999');
    expect(base).not.toContain('254712345678');
    expect(payoutRowFingerprint(leg({ created_at: new Date('2026-01-01T00:00:00.000Z') }))).not.toBe(base);
    expect(payoutRowFingerprint(leg({ claim_id: 'CLM-OTHER' }))).not.toBe(base);
    expect(payoutRowFingerprint(leg({ item_id: 'ITM-OTHER' }))).not.toBe(base);
    expect(payoutRowFingerprint(leg({ type: 'agent_payout' }))).not.toBe(base);
    expect(payoutRowFingerprint(leg({ provider_transaction_id: 'TXN-1' }))).not.toBe(base);
    expect(payoutRowFingerprint(leg({ failure_reason: 'something new' }))).not.toBe(base);
    expect(payoutRowFingerprint(leg({ provider_batch_id: 'BATCH-2' }))).not.toBe(base);
    expect(payoutRowFingerprint(null)).not.toBe(base);
  });

  it('distinguishes NULL from the string "null" (the legacy ambiguity)', () => {
    expect(payoutRowFingerprint(leg({ payout_outcome: null }))).not.toBe(
      payoutRowFingerprint(leg({ payout_outcome: 'null' as any })),
    );
  });

  it('the request fingerprint covers the reviewed operation and expiry', () => {
    const request = {
      id: 'RPR-1',
      ledger_entry_id: ROW_ID,
      claim_id: 'CLM-RPR-TEST',
      entry_type: 'finder_payout',
      repair_operation: 'release_rejected_leg',
      from_status: 'failed',
      from_payout_outcome: 'rejected',
      to_status: 'pending',
      to_payout_outcome: 'not_submitted',
      reason: 'Provider statement confirms the transfer was refused before execution.',
      row_fingerprint: payoutRowFingerprint(leg()),
      proposed_by: 'admin-a',
      expires_at: new Date('2026-01-01T00:00:00.000Z'),
    };
    const base = payoutRepairRequestFingerprint(request);
    expect(base).toMatch(/^[a-f0-9]{64}$/);
    expect(payoutRepairRequestFingerprint({ ...request })).toBe(base);
    expect(payoutRepairRequestFingerprint({ ...request, proposed_by: 'admin-b' })).not.toBe(base);
    // F5 — the reviewed REASON and the denormalised claim/type are covered too.
    expect(payoutRepairRequestFingerprint({ ...request, reason: 'different reason text' })).not.toBe(base);
    expect(payoutRepairRequestFingerprint({ ...request, claim_id: 'CLM-OTHER' })).not.toBe(base);
    expect(payoutRepairRequestFingerprint({ ...request, entry_type: 'agent_payout' })).not.toBe(base);
    expect(
      payoutRepairRequestFingerprint({ ...request, expires_at: new Date('2026-01-02T00:00:00.000Z') }),
    ).not.toBe(base);
  });

  it('expires a proposal after exactly 24 hours, at the boundary', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const expiresAt = payoutRepairExpiryFor(now);
    expect(expiresAt.getTime() - now.getTime()).toBe(PAYOUT_REPAIR_PROPOSAL_TTL_MS);
    expect(PAYOUT_REPAIR_PROPOSAL_TTL_MS).toBe(24 * 60 * 60 * 1000);

    expect(isPayoutRepairRequestExpired({ expires_at: expiresAt }, new Date(now.getTime() + 1000))).toBe(false);
    // `<=` on purpose: at the boundary the proposal is already invalid.
    expect(isPayoutRepairRequestExpired({ expires_at: expiresAt }, expiresAt)).toBe(true);
    expect(isPayoutRepairRequestExpired({ expires_at: expiresAt }, new Date(expiresAt.getTime() + 1))).toBe(true);
  });

  it('treats a missing or unparseable expiry as expired (fail closed)', () => {
    const now = new Date();
    expect(isPayoutRepairRequestExpired({}, now)).toBe(true);
    expect(isPayoutRepairRequestExpired({ expires_at: null }, now)).toBe(true);
    expect(isPayoutRepairRequestExpired({ expires_at: 'not-a-date' }, now)).toBe(true);
    expect(isPayoutRepairRequestExpired(null, now)).toBe(true);
  });
});

describe('F4 — the previous failure reason is preserved, redacted and bounded', () => {
  it('keeps ordinary text and masks a phone-like run', () => {
    const original = 'IntaSend refused this transaction for +254712345678 before execution.';
    const redacted = redactPayoutFailureReasonForAudit(original);
    expect(redacted).toContain('IntaSend refused');
    expect(redacted).not.toContain('712345678');
    expect(redacted).toContain('***678');
  });

  it('bounds what can be copied into the audit trail, and treats blank as absent', () => {
    const long = redactPayoutFailureReasonForAudit('x'.repeat(1000));
    expect(long!.length).toBe(240);
    expect(long!.endsWith('...')).toBe(true);
    expect(redactPayoutFailureReasonForAudit('   ')).toBeNull();
    expect(redactPayoutFailureReasonForAudit(null)).toBeNull();
  });
});
