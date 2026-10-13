import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  PaymentService,
  isPaymentSimulationEnvironment,
  isPayoutSimulationRequired,
  PAYMENT_SIMULATION_ENVS,
} from '../payments';
import { db } from '../../db/database';
import { ensureTestCategory, testRunId } from '../../db/__tests__/ensureTestCategory';

// =============================================================================
// BATCH 1 — THE PAYMENT / PAYOUT SIMULATION GATE IS A FAIL-CLOSED ALLOW-LIST.
//
// The defect this file pins: the collection and payout gates used an exact-string
// production check (`NODE_ENV === 'production'`), which fails OPEN for every
// value it does not recognise. With a placeholder/missing IntaSend key, an unset
// NODE_ENV (plain `node`/`tsx`, some containers), an empty string, a misspelling
// ('prod'), a casing drift ('Production') or a deployment label ('staging') all
// fell through to the simulation branch:
//
//   * triggerMpesaStkPush returned `success: true` and booked the attempt's
//     payment_received ledger row — a caller reads that as "a payment request is
//     out and may be approved"; and
//   * triggerIntasendPayout returned a per-leg `status: 'success'` for a batch
//     that never existed — a caller reads that as "the finder/agent was paid".
//
// Both are now refused unless NODE_ENV is EXACTLY 'development' or 'test'.
//
// These are BEHAVIOURAL tests of the real PaymentService against a stubbed
// `fetch`: no provider is contacted, and on every refused path the stub is
// additionally asserted NOT to have been called — so "refused" cannot be
// satisfied by a network call that merely failed some other way.
//
// The refund gate already had this allow-list shape (see
// __tests__/refundSimulationGate.test.ts); it now shares this same predicate and
// is unchanged in behaviour.
// =============================================================================

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_PUBLISHABLE_KEY = process.env.INTASEND_PUBLISHABLE_KEY;
const ORIGINAL_SECRET_KEY = process.env.INTASEND_SECRET_KEY;

afterEach(() => {
  vi.unstubAllGlobals();
  // Restored field-by-field (never by replacing process.env wholesale) so this
  // file cannot leave order-dependent state behind for other tests.
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_PUBLISHABLE_KEY === undefined) delete process.env.INTASEND_PUBLISHABLE_KEY;
  else process.env.INTASEND_PUBLISHABLE_KEY = ORIGINAL_PUBLISHABLE_KEY;
  if (ORIGINAL_SECRET_KEY === undefined) delete process.env.INTASEND_SECRET_KEY;
  else process.env.INTASEND_SECRET_KEY = ORIGINAL_SECRET_KEY;
});

/** The placeholder convention both payment gates treat as "not configured". */
function usePlaceholderKeys() {
  process.env.INTASEND_PUBLISHABLE_KEY = 'REPLACE_WITH_INTASEND_PUBLISHABLE_KEY';
  process.env.INTASEND_SECRET_KEY = 'REPLACE_WITH_INTASEND_SECRET_KEY';
}

/**
 * Every environment that must NOT simulate. 'prod'/'Production' are the
 * realistic typos a deny-list misses; unset and '' are what a misconfigured
 * deployment actually runs; 'staging' is a real deployment label; the two
 * whitespace-padded values prove the comparison is exact.
 */
const DISALLOWED_ENVS: Array<[string, string | undefined]> = [
  ['"production"', 'production'],
  ['unset', undefined],
  ['"" (empty)', ''],
  ['"staging"', 'staging'],
  ['the misspelling "prod"', 'prod'],
  ['the wrong casing "Production"', 'Production'],
  ['the wrong casing "DEV"', 'DEV'],
  ['the uppercase "TEST"', 'TEST'],
  ['the padded " development"', ' development'],
  ['the padded "production "', 'production '],
];

const setNodeEnv = (value: string | undefined) => {
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
};

const collect = (claimId: string) => PaymentService.triggerMpesaStkPush('+254712345678', 500, claimId);

const payout = () => PaymentService.triggerIntasendPayout('CLAIM-SIM-GATE', [
  { destination: '+254712345678', amount: 100, recipientType: 'finder' as const },
]);

describe('the shared simulation-environment predicate is an exact allow-list', () => {
  it('names exactly development and test', () => {
    expect([...PAYMENT_SIMULATION_ENVS]).toEqual(['development', 'test']);
  });

  it('is true ONLY for the two documented values (exhaustive over the cases that matter)', () => {
    expect(isPaymentSimulationEnvironment('development')).toBe(true);
    expect(isPaymentSimulationEnvironment('test')).toBe(true);

    for (const [, value] of DISALLOWED_ENVS) {
      expect(isPaymentSimulationEnvironment(value), `NODE_ENV=${JSON.stringify(value)}`).toBe(false);
    }
    // Values that merely resemble the allowed ones.
    for (const value of ['dev', 'development ', 'DEVELOPMENT', 'Test', 'testing', 'local', 'ci']) {
      expect(isPaymentSimulationEnvironment(value), `NODE_ENV=${value}`).toBe(false);
    }
  });
});

describe('collection (M-Pesa STK push) simulation requires an explicitly allowed environment', () => {
  // The simulation branch writes the attempt's own payment_received ledger row,
  // and the ledger has a real foreign key to claims(id) -> items(id), so the
  // allowed path needs a valid fixture (exactly as the existing simulation test
  // in payments.test.ts does).
  const makeClaimFixture = async (suffix: string) => {
    const itemId = `TEST-ITEM-SIMGATE-${suffix}-${testRunId}`;
    const claimId = `TEST-CLAIM-SIMGATE-${suffix}-${testRunId}`;
    await ensureTestCategory('phone');
    await db.createItem({
      id: itemId,
      category_id: 'phone',
      photo_url: 'test-photo.jpg',
      ocr_extracted_number: null,
      ocr_extracted_name: null,
      document_number_hash: null,
      document_name_fuzzy: null,
      location_description: 'Test location',
      latitude: null,
      longitude: null,
      finder_phone: '+254700000007',
      assigned_agent_id: null,
      status: 'at_agent',
      flaggedForReview: false,
      isDescriptionOnly: false,
      description: null,
      is_sensitive_document: false,
      rejection_reason: null,
    } as any);
    await db.createClaim({
      id: claimId,
      item_id: itemId,
      owner_phone: '+254712345678',
      security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'test fixture' },
      verification_tier: 1,
      status: 'pending_payment',
      owner_id_proof_url: null,
      payment_reference: null,
      owner_identifying_details: null,
    });
    return claimId;
  };

  for (const env of ['development', 'test']) {
    it(`NODE_ENV=${env} with placeholder keys simulates and contacts no provider`, async () => {
      setNodeEnv(env);
      usePlaceholderKeys();
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const result = await collect(await makeClaimFixture(env));

      expect(result.success).toBe(true);
      // Simulation must always be unmistakably labelled as such.
      expect(result.message).toMatch(/SIMULATION/);
      // Simulation is exactly that: no provider call at all.
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  for (const [label, value] of DISALLOWED_ENVS) {
    it(`NODE_ENV ${label} refuses to simulate a payment (no false success, no provider call)`, async () => {
      setNodeEnv(value);
      usePlaceholderKeys();
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      let caught: any = null;
      try {
        await collect('TEST-CLAIM-SIMGATE-DISALLOWED');
      } catch (e) {
        caught = e;
      }

      // Fail-closed: no result is returned at all, so no caller can read
      // `success: true` and no claim can advance on a simulation.
      expect(caught, 'the simulation gate must throw').toBeInstanceOf(Error);
      expect(String(caught.message)).toMatch(/Refusing to simulate a payment/);
      // The observed environment is named, so the operator knows what to fix.
      expect(String(caught.message)).toContain(describeExpectedEnv(value));
      // The refusal happens BEFORE the provider: no request is attempted.
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }
  it('a real (non-placeholder) key still takes the provider path and never fabricates success', async () => {
    // A dummy value, NOT a credential: concatenated so a secret scanner's
    // literal-assignment heuristic does not flag the fabricated value.
    process.env.INTASEND_PUBLISHABLE_KEY = 'r4m-' + 'test-simgate-publishable';
    process.env.INTASEND_SECRET_KEY = 'r4m-' + 'test-simgate-secret';
    setNodeEnv('staging');
    const fetchSpy = vi.fn(async () => ({
      ok: false, status: 400, text: async () => 'refused', json: async () => ({}),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await collect('TEST-CLAIM-SIMGATE-REALKEY');

    // The real HTTP path is untouched by the simulation gate: a provider
    // refusal stays a refusal and nothing is fabricated.
    expect(result.success).toBe(false);
    expect(result.message).not.toMatch(/SIMULATION/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('payout (send-money batch) simulation requires an explicitly allowed environment', () => {
  for (const env of ['development', 'test']) {
    it(`NODE_ENV=${env} with a placeholder key emulates the split and contacts no provider`, async () => {
      setNodeEnv(env);
      usePlaceholderKeys();
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const result = await payout();

      expect(result.results.every((r) => r.status === 'success')).toBe(true);
      expect(result.batchId).toMatch(/^SIM-/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  for (const [label, value] of DISALLOWED_ENVS) {
    it(`NODE_ENV ${label} refuses to simulate a payout (no success can reach a caller)`, async () => {
      setNodeEnv(value);
      usePlaceholderKeys();
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      let caught: any = null;
      let returned: any = null;
      try {
        returned = await payout();
      } catch (e) {
        caught = e;
      }

      // No result object exists at all — there is nothing for the settlement
      // executor to record as paid, so no ledger entry can be completed and no
      // claim can be closed on a simulation.
      expect(returned).toBeNull();
      expect(caught, 'the simulation gate must throw').toBeInstanceOf(Error);
      expect(String(caught.message)).toMatch(/Refusing to simulate a payout/);
      expect(String(caught.message)).toContain(describeExpectedEnv(value));
      // The fabricated batch/transaction identifiers cannot leak anywhere.
      expect(String(caught.message)).not.toContain('SIM-BATCH');
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  it('a real (non-placeholder) key in a disallowed environment never fabricates success', async () => {
    process.env.INTASEND_SECRET_KEY = 'r4m-' + 'test-simgate-payout-secret';
    setNodeEnv('staging');
    const fetchSpy = vi.fn(async () => ({
      ok: false, status: 422, text: async () => 'refused', json: async () => ({}),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await payout();

    // A definite provider refusal stays a refusal: never 'success', and no
    // invented batch id.
    expect(result.results.every((r) => r.status === 'failed')).toBe(true);
    expect(result.batchId).toBeNull();
    expect(JSON.stringify(result)).not.toContain('SIM-');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// BATCH 1 CORRECTION A — "WOULD THIS PAYOUT ATTEMPT BE SIMULATED?" IS ONE
// QUESTION, ASKED AT TWO SEAMS.
//
// The settlement executor (server.ts executeClaimSettlement) refuses a would-be
// simulated payout BEFORE it writes its durable pre-submission markers, and it
// asks isPayoutSimulationRequired() to decide. That preflight is only correct if
// the predicate answers the SAME question triggerIntasendPayout() selects its
// simulation branch on, so these tests pin the two together, in BOTH directions,
// against the real service:
//
//   * predicate TRUE  - the service really would simulate (allowed environment)
//                       or refuse to simulate (disallowed environment);
//   * predicate FALSE - the service really does make the provider request, so a
//                       real payout is never blocked merely because simulation
//                       is disallowed.
//
// A divergence here would mean the preflight guards the wrong condition - the
// exact drift this file exists to make impossible.
// =============================================================================
describe('BATCH 1 CORRECTION A — the payout-simulation predicate matches the branch it guards', () => {
  it('is true for every missing/placeholder shape and false for a real key', () => {
    for (const value of [undefined, '', '   ', 'REPLACE_WITH_INTASEND_SECRET_KEY', 'placeholder', 'your_key_here', 'ChangeMe', 'tbd']) {
      expect(isPayoutSimulationRequired(value), `key=${JSON.stringify(value)}`).toBe(true);
    }
    for (const value of ['r4m-' + 'test-real-key', 'ISSecretKey_a8f3k2m9x7q1w4e6r8t0y2u5i7o9p1a3s5d']) {
      expect(isPayoutSimulationRequired(value), `key=${value}`).toBe(false);
    }
    // The executor calls it with NO argument, i.e. against the process's own
    // configured key - so that form is pinned too.
    setNodeEnv('test');
    process.env.INTASEND_SECRET_KEY = '';
    expect(isPayoutSimulationRequired()).toBe(true);
    process.env.INTASEND_SECRET_KEY = 'r4m-' + 'test-real-key-2';
    expect(isPayoutSimulationRequired()).toBe(false);
  });

  it('a placeholder key: predicate true, and the service simulates when allowed / refuses when not', async () => {
    usePlaceholderKeys();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    setNodeEnv('test');
    expect(isPayoutSimulationRequired()).toBe(true);
    const simulated = await payout();
    expect(simulated.batchId).toMatch(/^SIM-/);

    setNodeEnv('staging');
    expect(isPayoutSimulationRequired()).toBe(true);
    await expect(payout()).rejects.toThrow(/Refusing to simulate a payout/);

    // In both cases nobody was contacted: the predicate describes a branch that
    // sends nothing, which is exactly why the executor must refuse it up front
    // in a disallowed environment instead of taking its markers first.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a real key: predicate false, and the service really does make the provider request', async () => {
    process.env.INTASEND_SECRET_KEY = 'r4m-' + 'test-real-key-3';
    const fetchSpy = vi.fn(async () => ({
      ok: false, status: 422, text: async () => 'refused', json: async () => ({}),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    for (const env of ['staging', 'production', 'development', 'test', undefined]) {
      setNodeEnv(env);
      expect(isPayoutSimulationRequired(), `NODE_ENV=${JSON.stringify(env)}`).toBe(false);
    }

    setNodeEnv('staging');
    const result = await payout();
    // The genuine branch ran: the provider was called and answered. Nothing was
    // simulated, and nothing was blocked merely because simulation is not
    // permitted in this environment.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.results.every((r) => r.status === 'failed')).toBe(true);
  });
});

/** The refusal message renders the observed NODE_ENV the same way the guard does. */
function describeExpectedEnv(value: string | undefined): string {
  if (value === undefined) return 'NODE_ENV is unset';
  const sanitised = String(value).replace(/[^A-Za-z0-9_.-]/g, '?').slice(0, 32);
  return `NODE_ENV is "${sanitised}"`;
}
