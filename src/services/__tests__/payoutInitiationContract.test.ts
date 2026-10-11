import { describe, it, expect, afterEach, vi } from 'vitest';
import { PaymentService, buildPayoutLegIdempotencyKey } from '../payments';

// =============================================================================
// BATCH 1B-C1 — THE PAYOUT INITIATION CONTRACT.
// =============================================================================
// Three defects, one seam. `triggerIntasendPayout()` reaches IntaSend through
// `fetchWithTimeout()` -> the global `fetch`, so every test below drives the REAL
// payload builder, URL builder, response parser and result mapping against a
// stubbed `fetch`: no network, no wallet, no provider, and a key that is valid
// nowhere.
//
//   1. ENDPOINT — the documented initiation path is
//      POST /api/v1/send-money/initiate/. The bare `/send-money/` path was used
//      instead, for the batch AND for the refund.
//   2. IDEMPOTENCY — IntaSend takes `idempotency_key` per TRANSACTION ("Unique
//      key per transaction. A repeat request with the same key is rejected, so
//      you can retry safely"). It was not sent at all.
//   3. BINDING — the provider's per-transaction ids were matched back to local
//      legs by the last nine digits of the destination account, which silently
//      bound the SAME id to two legs whenever the accounts shared a suffix.
//
// What must NOT change is pinned here too: acceptance is never reported as
// success, a missing id is never invented, and a leg that cannot be bound stays
// unresolved with its provider batch id recorded for reconciliation.
// =============================================================================

const FINDER_PHONE = '0712345678'; // normalized to 254712345678 before it is sent
const AGENT_TILL = '712345678';    // deliberately shares the finder's last nine digits

type ProviderCall = { url: string; method: string; body: any };

function useRealKey() {
  process.env.NODE_ENV = 'development';
  process.env.INTASEND_SECRET_KEY = 'MY_TEST_ONLY_1BC1_KEY';
}

function stubProvider(response: any) {
  const calls: ProviderCall[] = [];
  vi.stubGlobal('fetch', async (input: any, init: any = {}) => {
    calls.push({
      url: String(input?.url ?? input),
      method: String(init?.method ?? ''),
      body: JSON.parse(String(init?.body ?? '{}')),
    });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(response),
      json: async () => response,
    };
  });
  return calls;
}

const twoLegs = () => [
  { destination: FINDER_PHONE, amount: 500, recipientType: 'finder' as const },
  { destination: AGENT_TILL, amount: 300, payoutMethodType: 'Till Number', recipientType: 'agent' as const },
];

const resultFor = (results: any[], recipientType: string) =>
  results.find(r => r.recipientType === recipientType);

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
});

describe('BATCH 1B-C1 — payout initiation uses the documented endpoint', () => {
  it('POSTs the batch to /api/v1/send-money/initiate/', async () => {
    useRealKey();
    const calls = stubProvider({ tracking_id: 'TRK-1', transactions: [] });

    await PaymentService.triggerIntasendPayout('CLAIM-1', twoLegs());

    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://sandbox.intasend.com/api/v1/send-money/initiate/');
  });

  it('never posts to the bare /send-money/ path (the defect this replaces)', async () => {
    useRealKey();
    const calls = stubProvider({ tracking_id: 'TRK-1', transactions: [] });

    await PaymentService.triggerIntasendPayout('CLAIM-1', twoLegs());
    await PaymentService.triggerIntasendRefund(FINDER_PHONE, 500, 'CLAIM-1');

    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(call.url.endsWith('/send-money/')).toBe(false);
      expect(call.url.endsWith('/send-money/initiate/')).toBe(true);
    }
  });

  it('leaves the payout STATUS endpoint exactly as it was', async () => {
    useRealKey();
    const calls = stubProvider({ tracking_id: 'TRK-1', transactions: [] });

    await PaymentService.fetchIntasendPayoutBatchStatus('TRK-1');

    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://sandbox.intasend.com/api/v1/send-money/status/');
  });

  it('keeps the documented batch-level fields exactly as they were', async () => {
    useRealKey();
    const calls = stubProvider({ tracking_id: 'TRK-1', transactions: [] });

    await PaymentService.triggerIntasendPayout('CLAIM-1', twoLegs());

    expect(calls[0].body.provider).toBe('MPESA-B2C');
    expect(calls[0].body.currency).toBe('KES');
    expect(Object.keys(calls[0].body).sort()).toEqual(['currency', 'provider', 'transactions']);
  });
});

describe('BATCH 1B-C1 — one deterministic idempotency key per payout leg', () => {
  it('sends the documented idempotency_key field on every transaction', async () => {
    useRealKey();
    const calls = stubProvider({ tracking_id: 'TRK-1', transactions: [] });

    await PaymentService.triggerIntasendPayout('CLAIM-1', twoLegs());

    for (const t of calls[0].body.transactions) {
      expect(typeof t.idempotency_key).toBe('string');
      expect(t.idempotency_key.length).toBeGreaterThan(0);
    }
  });

  it('reuses exactly the same key when the same logical leg is submitted again', async () => {
    useRealKey();
    const calls = stubProvider({ tracking_id: 'TRK-1', transactions: [] });

    await PaymentService.triggerIntasendPayout('CLAIM-1', twoLegs());
    await PaymentService.triggerIntasendPayout('CLAIM-1', twoLegs());

    const first = calls[0].body.transactions;
    const second = calls[1].body.transactions;
    expect(second.map((t: any) => t.idempotency_key)).toEqual(first.map((t: any) => t.idempotency_key));
    // And the two legs never share one key.
    expect(new Set(first.map((t: any) => t.idempotency_key)).size).toBe(first.length);
  });

  it('gives the finder and the agent DIFFERENT keys, and different claims different keys', () => {
    const finder = buildPayoutLegIdempotencyKey('CLAIM-1', 'finder');
    const agent = buildPayoutLegIdempotencyKey('CLAIM-1', 'agent');

    expect(finder).not.toBe(agent);
    expect(finder).not.toBe(buildPayoutLegIdempotencyKey('CLAIM-2', 'finder'));
    expect(agent).not.toBe(buildPayoutLegIdempotencyKey('CLAIM-2', 'agent'));
    // Deterministic: the same inputs always produce the same key.
    expect(buildPayoutLegIdempotencyKey('CLAIM-1', 'finder')).toBe(finder);
  });

  it('keeps every personal and account detail out of the key', async () => {
    useRealKey();
    const calls = stubProvider({ tracking_id: 'TRK-1', transactions: [] });

    await PaymentService.triggerIntasendPayout('CLAIM-1', twoLegs());

    for (const t of calls[0].body.transactions) {
      const key = String(t.idempotency_key);
      for (const secretish of [FINDER_PHONE, '254712345678', AGENT_TILL, String(t.account), String(t.narrative)]) {
        expect(key.includes(secretish), `key must not embed ${secretish}`).toBe(false);
      }
      // Nothing but the claim id and the recipient role appears in it.
      const role = String(t.narrative).includes('FINDER') ? 'finder' : 'agent';
      expect(key).toBe(buildPayoutLegIdempotencyKey('CLAIM-1', role));
    }
  });
});

describe('BATCH 1B-C1 — response binding is exact, unique and fail-closed', () => {
  const respondWith = async (transactions: any) => {
    useRealKey();
    const calls = stubProvider({ tracking_id: 'TRK-1', batch_reference: 'R4M-1', transactions });
    const result = await PaymentService.triggerIntasendPayout('CLAIM-1', twoLegs());
    return { calls, result };
  };

  it('records each leg OWN transaction id from a valid, unambiguous response', async () => {
    const { result } = await respondWith([
      { account: '254712345678', transaction_id: 'KQ9PLXR' },
      { account: '712345678', transaction_id: 'AB7CDE1' },
    ]);

    expect(result.batchId).toBe('TRK-1');
    expect(resultFor(result.results, 'finder').providerTransactionId).toBe('KQ9PLXR');
    expect(resultFor(result.results, 'agent').providerTransactionId).toBe('AB7CDE1');
  });

  it('never lets a shared account SUFFIX bind the wrong leg (the defect this replaces)', async () => {
    // The provider answered about the AGENT only. The finder account ends with
    // the agent account's digits, so the old matcher copied the agent's id onto
    // the finder row as well.
    const { result } = await respondWith([
      { account: '712345678', transaction_id: 'AB7CDE1' },
    ]);

    expect(resultFor(result.results, 'finder')).toEqual({
      recipientType: 'finder', destination: FINDER_PHONE,
      providerTransactionId: null, status: 'pending',
    });
    expect(resultFor(result.results, 'agent').providerTransactionId).toBe('AB7CDE1');
  });

  it('binds nothing when the response carries no per-transaction array at all', async () => {
    const { result } = await respondWith(undefined);

    expect(result.batchId).toBe('TRK-1');
    expect(result.results.every(r => r.providerTransactionId === null)).toBe(true);
    expect(result.results.every(r => r.status === 'pending')).toBe(true);
  });

  it('binds nothing when a matching entry carries no usable transaction id', async () => {
    const { result } = await respondWith([
      { account: '254712345678' },
      { account: '712345678', transaction_id: '   ' },
    ]);

    expect(result.results.every(r => r.providerTransactionId === null)).toBe(true);
  });

  it('binds nothing when the provider duplicates a correlation entry', async () => {
    const { result } = await respondWith([
      { account: '254712345678', transaction_id: 'TX-1' },
      { account: '254712345678', transaction_id: 'TX-2' },
      { account: '712345678', transaction_id: 'AB7CDE1' },
    ]);

    expect(resultFor(result.results, 'finder').providerTransactionId).toBeNull();
    // An ambiguous leg must not stop an unambiguous one from binding.
    expect(resultFor(result.results, 'agent').providerTransactionId).toBe('AB7CDE1');
  });

  it('binds nothing for a correlation identifier that names no submitted leg', async () => {
    const { result } = await respondWith([
      { account: '254700000000', transaction_id: 'TX-UNKNOWN' },
    ]);

    expect(result.results.every(r => r.providerTransactionId === null)).toBe(true);
    expect(result.results.some(r => r.providerTransactionId === 'TX-UNKNOWN')).toBe(false);
  });

  it('leaves unbound legs unresolved: never success, never a fabricated id', async () => {
    // A 2xx response with ids we cannot tie to a leg. Acceptance is still only
    // acceptance — the leg is NOT completed, and the provider batch id is kept
    // so the authoritative status lookup / operator reconciliation can resolve it.
    const { result } = await respondWith([{ account: '254799999999', transaction_id: 'TX-X' }]);

    expect(result.batchId).toBe('TRK-1');
    for (const r of result.results) {
      expect(r.status).toBe('pending');
      expect(r.status).not.toBe('success');
      expect(r.providerTransactionId).toBeNull();
    }
  });
});
