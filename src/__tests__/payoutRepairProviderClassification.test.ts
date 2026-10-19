import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  classifyPayoutSubmissionHttpFailure,
  AMBIGUOUS_PAYOUT_FAILURE_STATUSES,
} from '../config/payoutOutcomes';
import { buildPayoutLegIdempotencyKey, payoutLegIdempotencyKeyForEntryType } from '../config/payoutIdempotency';

// =============================================================================
// F1 / F7 — THE NON-2xx CLASSIFICATION MATRIX
// =============================================================================
// The repair policy no longer trusts `rejected` as proof of non-execution. This
// suite pins the OTHER half of that decision: which non-2xx statuses may even be
// recorded as a refusal-class failure. Everything ambiguous must become
// `unknown` (unresolved), never `rejected`.

describe('provider submission failure classification (F1)', () => {
  it.each([300, 301, 302, 304, 307, 308])('treats an unexpected %i redirect as ambiguous', (status) => {
    expect(classifyPayoutSubmissionHttpFailure(status)).toBe('ambiguous');
  });

  it.each([400, 401, 403, 404, 422])('records a %i response as a refusal-class failure', (status) => {
    expect(classifyPayoutSubmissionHttpFailure(status)).toBe('refusal_reported');
  });

  it.each([408, 409, 429, 499, 500, 502, 503, 504])(
    'treats %i as ambiguous (execution cannot be excluded)',
    (status) => {
      expect(classifyPayoutSubmissionHttpFailure(status)).toBe('ambiguous');
    },
  );

  it('covers the duplicate-idempotency status explicitly', () => {
    // 409 is the canonical counterexample: the provider may be rejecting a
    // repeat of a request it ALREADY executed.
    expect(AMBIGUOUS_PAYOUT_FAILURE_STATUSES).toContain(409);
    expect(classifyPayoutSubmissionHttpFailure(409)).toBe('ambiguous');
  });

  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY])(
    'treats a missing/unreadable status (%s) as ambiguous',
    (status) => {
      expect(classifyPayoutSubmissionHttpFailure(status as any)).toBe('ambiguous');
    },
  );

  it('is actually wired into the submission path, not just exported', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../services/payments.ts'),
      'utf8',
    );
    expect(source).toContain('classifyPayoutSubmissionHttpFailure(response.status)');
    // The old predicate — which treated 409/3xx/429/499 as a refusal — is gone.
    expect(source).not.toMatch(/response\.status === 408 \|\| response\.status >= 500/);
  });
});

describe('payout-leg idempotency key (F7)', () => {
  it('is deterministic, distinct per role and PII-free', () => {
    const finder = buildPayoutLegIdempotencyKey('CLM-1', 'finder');
    expect(finder).toBe('PAYOUT_LEG_FINDER:CLM-1');
    expect(buildPayoutLegIdempotencyKey('CLM-1', 'agent')).not.toBe(finder);
    expect(buildPayoutLegIdempotencyKey('CLM-2', 'finder')).not.toBe(finder);
    expect(buildPayoutLegIdempotencyKey('CLM-1', 'finder')).toBe(finder);
  });

  it('maps a ledger entry type to the key the retry would actually send', () => {
    expect(payoutLegIdempotencyKeyForEntryType('CLM-1', 'finder_payout')).toBe(
      'PAYOUT_LEG_FINDER:CLM-1',
    );
    expect(payoutLegIdempotencyKeyForEntryType('CLM-1', 'agent_payout')).toBe(
      'PAYOUT_LEG_AGENT:CLM-1',
    );
    expect(payoutLegIdempotencyKeyForEntryType(null, 'finder_payout')).toBeNull();
    expect(payoutLegIdempotencyKeyForEntryType('CLM-1', 'platform_fee')).toBeNull();
  });
});
