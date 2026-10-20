import { describe, it, expect, afterEach, vi } from 'vitest';
import { isPlaceholderKey } from '../payments';
import { PaymentService } from '../payments';
import { db } from '../../db/database';
import { ensureTestCategory, testRunId } from '../../db/__tests__/ensureTestCategory';

// isPlaceholderKey is the single gate that decides whether a payment
// call actually hits IntaSend with real money, or safely no-ops into
// simulation mode. Its own comment documents the actual production
// incident this function exists to prevent: a key literally set to the
// word "placeholder" wasn't recognized as fake, so the app made a real
// network call with an invalid key instead of simulating. That makes this
// arguably the single highest-consequence pure function in the codebase
// to regress silently — worth pinning down explicitly.

describe('isPlaceholderKey', () => {
  it('treats undefined, null, and empty string as placeholders', () => {
    expect(isPlaceholderKey(undefined)).toBe(true);
    expect(isPlaceholderKey(null)).toBe(true);
    expect(isPlaceholderKey('')).toBe(true);
    expect(isPlaceholderKey('   ')).toBe(true);
  });

  it('recognizes every documented placeholder convention', () => {
    expect(isPlaceholderKey('REPLACE_WITH_INTASEND_SECRET_KEY')).toBe(true);
    expect(isPlaceholderKey('placeholder')).toBe(true);
    expect(isPlaceholderKey('your_key_here')).toBe(true);
    expect(isPlaceholderKey('your-key-here')).toBe(true);
    expect(isPlaceholderKey('changeme')).toBe(true);
    expect(isPlaceholderKey('change_me')).toBe(true);
    expect(isPlaceholderKey('xxx')).toBe(true);
    expect(isPlaceholderKey('todo')).toBe(true);
    expect(isPlaceholderKey('tbd')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isPlaceholderKey('PLACEHOLDER')).toBe(true);
    expect(isPlaceholderKey('Your_Key_Here')).toBe(true);
    expect(isPlaceholderKey('ChangeMe')).toBe(true);
  });

  it('does not flag a real-looking secret key as a placeholder', () => {
    expect(isPlaceholderKey('ISSecretKey_a8f3k2m9x7q1w4e6r8t0y2u5i7o9p1a3s5d')).toBe(false);
    expect(isPlaceholderKey('sk_live_51H8xJ2KzQm9L3nP7vR4tY6uI8oA0sD2fG5h')).toBe(false);
  });

  it('does not false-positive on a real key that happens to contain a substring like "x"', () => {
    // A key containing the letter sequence 'xxx' as a coincidental
    // substring (not the whole trimmed value) should NOT be flagged —
    // only an exact 'xxx' (after trim/lowercase) is a placeholder.
    expect(isPlaceholderKey('boxxxer_secret_9f8e7d6c5b4a3210')).toBe(false);
  });
});

// P0 REGRESSION TEST — the actual bug: payment/payout simulation had NO
// production gate at all. A misconfigured production deployment (missing
// or still-placeholder IntaSend keys — the exact same category of mistake
// the database fail-closed guard in db/index.ts already protects
// against) would silently fabricate a COMPLETED payment_received ledger
// entry, or a 'success' payout result, for money that never actually
// moved. In production that means anyone could "pay" for any claim for
// free, or a finder/agent payout could be marked paid with nothing sent.
//
// Unlike triggerIntasendPayout/createPool (which read env vars at module
// import time, requiring vi.resetModules() + dynamic import to test),
// triggerMpesaStkPush reads process.env at CALL time — so these tests can
// set NODE_ENV/keys directly before each call without any module-reload
// gymnastics.
describe('payment simulation production fail-closed guarantee', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('throws instead of simulating an STK push when NODE_ENV=production and keys are missing', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.INTASEND_PUBLISHABLE_KEY;
    delete process.env.INTASEND_SECRET_KEY;

    await expect(PaymentService.triggerMpesaStkPush('+254712345678', 500, 'TEST-CLAIM-SIM-1')).rejects.toThrow(/production/i);
  });

  it('throws instead of simulating an STK push when NODE_ENV=production and keys are still placeholders', async () => {
    process.env.NODE_ENV = 'production';
    process.env.INTASEND_PUBLISHABLE_KEY = 'REPLACE_WITH_YOUR_KEY';
    process.env.INTASEND_SECRET_KEY = 'REPLACE_WITH_YOUR_KEY';

    await expect(PaymentService.triggerMpesaStkPush('+254712345678', 500, 'TEST-CLAIM-SIM-2')).rejects.toThrow(/production/i);
  });

  it('does NOT throw in development even with missing keys (simulation is a dev-only convenience)', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.INTASEND_PUBLISHABLE_KEY;
    delete process.env.INTASEND_SECRET_KEY;

    // The simulation writes a real ledger row (payment_received) for the
    // given claim; the ledger has a real FK to claims(id) -> items(id).
    // Create the parent rows so the fixture is valid against real Postgres.
    await ensureTestCategory('phone');
    await db.createItem({
      id: `TEST-ITEM-SIM-3-${testRunId}`,
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
      id: `TEST-CLAIM-SIM-3-${testRunId}`,
      item_id: `TEST-ITEM-SIM-3-${testRunId}`,
      owner_phone: '+254712345678',
      security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'test fixture' },
      verification_tier: 1,
      status: 'pending_payment',
      owner_id_proof_url: null,
      payment_reference: null,
      owner_identifying_details: null,
    });

    const result = await PaymentService.triggerMpesaStkPush('+254712345678', 500, `TEST-CLAIM-SIM-3-${testRunId}`);
    expect(result.success).toBe(true);
    // Simulation must always be unmistakably labeled as such.
    expect(result.message).toMatch(/SIMULATION/);
  });

  it('throws instead of simulating a payout when NODE_ENV=production and the secret key is missing', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.INTASEND_SECRET_KEY;

    await expect(PaymentService.triggerIntasendPayout('TEST-CLAIM-SIM-4', [
      { destination: '+254712345678', amount: 100, recipientType: 'finder' },
    ])).rejects.toThrow(/production/i);
  });

  it('does NOT throw a payout simulation in development even with a missing secret key', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.INTASEND_SECRET_KEY;

    const result = await PaymentService.triggerIntasendPayout('TEST-CLAIM-SIM-5', [
      { destination: '+254712345678', amount: 100, recipientType: 'finder' },
    ]);
    expect(result.results.every(r => r.status === 'success')).toBe(true);
    expect(result.batchId).toMatch(/^SIM-/);
  });
});

// ===========================================================================
// E3A — A NON-2xx PROVIDER RESPONSE IS NOT ONE FACT.
// ===========================================================================
// The payout path used to report 'failed' for EVERY non-ok status, and the
// caller recorded that as a definitive provider rejection. That is only
// supportable for a status that proves the request was refused BEFORE
// execution:
//
//   4xx (except 408/409/429/499) — the provider rejected the request itself.
//   5xx / 408 / 409 / 429 / 499   — the provider failed (or refused a duplicate)
//                                   while handling a request it may already have
//                                   executed, so the outcome is UNKNOWN. See
//                                   config/payoutOutcomes.ts for the single matrix.
//
// Reporting the second as the first is precisely how a possibly-executed
// transfer becomes eligible for a resubmission that moves the same money twice.
//
// These tests drive the REAL HTTP branch of triggerIntasendPayout against a
// stubbed global fetch: no network, no wallet, and a key that works nowhere.
// ===========================================================================
describe('E3A — payout provider failure classification (stubbed fetch, no network)', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
  });

  const withProviderStatus = (status: number) => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status,
      text: async () => 'simulated provider error',
      json: async () => ({}),
    }));
  };

  const oneFinderPayout = () => PaymentService.triggerIntasendPayout('TEST-CLAIM-E3A-CLASSIFY', [
    { destination: '+254712345678', amount: 100, recipientType: 'finder' },
  ]);

  it('reports a 4xx refusal as a definitive failure (no transfer executed)', async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTASEND_SECRET_KEY = 'MY_TEST_ONLY_E3A_KEY_4xx';
    for (const status of [400, 401, 403, 404, 422]) {
      withProviderStatus(status);
      const result = await oneFinderPayout();
      expect(result.results.every(r => r.status === 'failed'), `HTTP ${status}`).toBe(true);
      expect(result.batchId, `HTTP ${status} must not invent a batch id`).toBeNull();
    }
  });

  it('reports 5xx/408/409/429/499 as UNKNOWN — the request may already have executed', async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTASEND_SECRET_KEY = 'MY_TEST_ONLY_E3A_KEY_5xx';
    // 409 is the canonical ambiguous case: the provider may be rejecting a
    // repeat of a request it already executed.
    for (const status of [500, 502, 503, 504, 408, 409, 429, 499]) {
      withProviderStatus(status);
      const result = await oneFinderPayout();
      expect(result.results.every(r => r.status === 'unknown'), `HTTP ${status}`).toBe(true);
      expect(result.batchId).toBeNull();
    }

    // A transport-level failure is equally ambiguous.
    vi.stubGlobal('fetch', async () => { throw new Error('simulated timeout'); });
    const timedOut = await oneFinderPayout();
    expect(timedOut.results.every(r => r.status === 'unknown')).toBe(true);
  });

  it('keeps the non-production simulation path intact and makes no HTTP call at all', async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTASEND_SECRET_KEY = '';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await oneFinderPayout();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.results.every(r => r.status === 'success')).toBe(true);
  });
});

// ===========================================================================
// PHASE 5 — OPTIONAL COLLECTION-WALLET SELECTOR (REAL STK BODY).
// ===========================================================================
// These tests drive the real HTTP branch of triggerMpesaStkPush with a stubbed
// global fetch, then inspect the exact JSON body that would be sent. The default
// body must remain the documented four fields; wallet_id is appended only for
// production + a real, non-placeholder selector. A production placeholder must
// refuse BEFORE any provider call.
// ===========================================================================
describe('PHASE 5 — STK body: wallet_id only in production and only when valid', () => {
  const ORIGINAL_ENV = { ...process.env };
  const COLLECTION_WALLET = 'cf5b1a22-7e48-4c19-9d3a-6b2f8e0c4a11';
  const CLAIM_ID = 'TEST-CLAIM-PHASE5-STK';

  const realCredentials = () => {
    process.env.INTASEND_PUBLISHABLE_KEY = 'ISPubKey_test_phase5_1234567890';
    process.env.INTASEND_SECRET_KEY = 'ISSecretKey_test_phase5_1234567890';
  };

  const successFetch = () => {
    const fetchSpy = vi.fn(async (_url: any, _init: any) => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ invoice: { invoice_id: 'INV-PHASE5' } }),
    }));
    vi.stubGlobal('fetch', fetchSpy);
    return fetchSpy;
  };

  const sentBody = (fetchSpy: ReturnType<typeof successFetch>) => {
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = (fetchSpy.mock.calls[0] as any)[1];
    expect(init.method).toBe('POST');
    return JSON.parse(init.body);
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  it.each([
    ['production + unset', 'production', undefined],
    ['production + blank', 'production', '   '],
    ['development + a real selector', 'development', COLLECTION_WALLET],
    ['test + a real selector', 'test', COLLECTION_WALLET],
  ])('%s leaves the documented four-field body untouched', async (_label, nodeEnv, selector) => {
    process.env.NODE_ENV = nodeEnv;
    realCredentials();
    if (selector === undefined) delete process.env.INTASEND_COLLECTION_WALLET_ID;
    else process.env.INTASEND_COLLECTION_WALLET_ID = selector;
    const fetchSpy = successFetch();
    vi.spyOn(db, 'logTransaction').mockResolvedValue(undefined as any);

    const result = await PaymentService.triggerMpesaStkPush('+254712345678', 500, CLAIM_ID);
    expect(result.success).toBe(true);

    const body = sentBody(fetchSpy);
    expect(Object.keys(body)).toEqual(['public_key', 'phone_number', 'amount', 'api_ref']);
    expect(body).not.toHaveProperty('wallet_id');
    expect(body.api_ref).toBe(CLAIM_ID);
  });

  it('production + a real selector appends exactly one wallet_id field', async () => {
    process.env.NODE_ENV = 'production';
    process.env.INTASEND_COLLECTION_WALLET_ID = COLLECTION_WALLET;
    realCredentials();
    const fetchSpy = successFetch();
    vi.spyOn(db, 'logTransaction').mockResolvedValue(undefined as any);

    const result = await PaymentService.triggerMpesaStkPush('+254712345678', 500, CLAIM_ID);
    expect(result.success).toBe(true);

    const body = sentBody(fetchSpy);
    expect(Object.keys(body)).toEqual(['public_key', 'phone_number', 'amount', 'api_ref', 'wallet_id']);
    expect(body.wallet_id).toBe(COLLECTION_WALLET);
  });

  it('production + a placeholder REFUSES before any provider request', async () => {
    process.env.NODE_ENV = 'production';
    process.env.INTASEND_COLLECTION_WALLET_ID = 'REPLACE_WITH_KES_COLLECTION_WALLET_ID';
    realCredentials();
    const fetchSpy = successFetch();

    await expect(
      PaymentService.triggerMpesaStkPush('+254712345678', 500, CLAIM_ID),
    ).rejects.toThrow(/INTASEND_COLLECTION_WALLET_ID is placeholder-shaped in production/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never writes the collection wallet ID to the STK log line', async () => {
    process.env.NODE_ENV = 'production';
    process.env.INTASEND_COLLECTION_WALLET_ID = COLLECTION_WALLET;
    realCredentials();
    successFetch();
    vi.spyOn(db, 'logTransaction').mockResolvedValue(undefined as any);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await PaymentService.triggerMpesaStkPush('+254712345678', 500, CLAIM_ID);

    const logged = logSpy.mock.calls
      .map((call) => call.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '))
      .join('\n');
    expect(logged).toContain('"collection_wallet_routing":"ready"');
    expect(logged).not.toContain(COLLECTION_WALLET);
    expect(logged).not.toContain(COLLECTION_WALLET.slice(4, -4));
  });
});
