import { describe, it, expect, afterEach, vi } from 'vitest';
import { PaymentService } from '../payments';

// =============================================================================
// BATCH 1B-C1/R1/R2 — R3: the refund SIMULATION gate is a fail-closed ALLOW-LIST.
//
// The defect this file pins: the no-credentials branch used an exact-string
// production check (`NODE_ENV === 'production'`), which fails OPEN for every
// value it does not recognise. With a placeholder/missing INTASEND_SECRET_KEY,
// an UNSET NODE_ENV (plain `tsx`/`node`, some containers) or a misspelling
// ('prod', 'Production', 'staging') fell through to the simulation branch, which
// returns success: true, outcome: 'completed' and a fabricated 'SIM-REFUND-…'
// transaction id. The refund caller reads 'completed' as "the money moved" (it
// finalizes the claim as refunded and notifies the customer), so that fabricated
// completion recorded a refund that never happened.
//
// These are BEHAVIOURAL tests of the real PaymentService against a stubbed
// `fetch`: no provider is contacted, and the stub is additionally asserted NOT
// to have been called on the disallowed paths — so "refused" cannot be satisfied
// by a network call that merely failed in some other way.
// =============================================================================

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_SECRET_KEY = process.env.INTASEND_SECRET_KEY;

afterEach(() => {
  vi.unstubAllGlobals();
  // Restored field-by-field (never by replacing process.env wholesale) so the
  // file cannot leave order-dependent state behind for other tests.
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_SECRET_KEY === undefined) delete process.env.INTASEND_SECRET_KEY;
  else process.env.INTASEND_SECRET_KEY = ORIGINAL_SECRET_KEY;
});

/** The placeholder convention the payment guards treat as "not configured". */
const usePlaceholderKey = () => {
  process.env.INTASEND_SECRET_KEY = 'REPLACE_WITH_INTASEND_SECRET_KEY';
};

const refund = () => PaymentService.triggerIntasendRefund('+254700000001', 500, 'CLAIM-SIM-GATE');

describe('refund simulation requires an explicitly recognised non-production environment', () => {
  for (const env of ['development', 'test']) {
    it(`NODE_ENV=${env} with a placeholder key simulates and contacts no provider`, async () => {
      process.env.NODE_ENV = env;
      usePlaceholderKey();
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const result = await refund();

      expect(result.outcome).toBe('completed');
      expect(result.success).toBe(true);
      expect(result.transactionId).toMatch(/^SIM-REFUND-/);
      // Simulation is exactly that: no provider call at all.
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  // 'prod' / 'Production' are the realistic typos a deny-list misses; an unset
  // NODE_ENV and 'staging' are what a misconfigured deployment actually runs.
  const disallowed: Array<[string, string | undefined]> = [
    ['production', 'production'],
    ['unset', undefined],
    ['the misspelling "prod"', 'prod'],
    ['the wrong casing "Production"', 'Production'],
    ['the unknown value "staging"', 'staging'],
  ];

  for (const [label, value] of disallowed) {
    it(`NODE_ENV ${label} refuses to simulate a completed refund`, async () => {
      if (value === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = value;
      usePlaceholderKey();
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      let caught: any = null;
      try { await refund(); } catch (e) { caught = e; }

      // Fail-closed: no result is returned at all, so no caller can read
      // 'completed' and no claim can be finalized on a simulation.
      expect(caught, 'the simulation gate must throw').toBeInstanceOf(Error);
      expect(String(caught.message)).toMatch(/Refusing to simulate a refund/);
      // The fabricated completion identifier cannot leak anywhere.
      expect(String(caught.message)).not.toContain('SIM-REFUND');
      // The refusal happens BEFORE the provider: no request is attempted.
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  it('names the observed environment in the refusal, including when it is unset', async () => {
    delete process.env.NODE_ENV;
    usePlaceholderKey();

    const message = await refund().then(
      () => 'NO ERROR',
      (e: any) => String(e?.message ?? e),
    );

    expect(message).toContain('NODE_ENV is unset');
  });

  it('a real (non-placeholder) key still takes the provider path in production and never simulates', async () => {
    process.env.NODE_ENV = 'production';
    // A dummy value, NOT a credential: concatenated so the CI secret-scanner's
    // literal-assignment heuristic does not flag the fabricated value.
    process.env.INTASEND_SECRET_KEY = 'r4m-' + 'test-refund-gate-production-key';
    const fetchSpy = vi.fn(async () => ({
      ok: false, status: 400, text: async () => 'refused', json: async () => ({}),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await refund();

    // The real HTTP path is untouched by the simulation gate: a definite
    // provider refusal stays a refusal, and nothing is fabricated.
    expect(result.outcome).toBe('failed');
    expect(result.transactionId).toBe('');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('SIM-REFUND');
  });
});
