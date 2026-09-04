import { describe, it, expect, afterEach, vi } from 'vitest';
import { PaymentService } from '../payments';

// FIX #4 (audit finding A1): triggerIntasendRefund must distinguish a
// DEFINITE provider rejection (HTTP error response — IntaSend received the
// request and refused it, refund NOT executed) from an UNKNOWN outcome
// (network/timeout exception — request may or may not have been executed).
// The payout path already follows this principle (triggerIntasendPayout
// returns status 'unknown' on exceptions); these tests pin the same
// guarantee on the refund path so it cannot silently regress to the old
// "treat everything as failed" behavior that could double-refund.

function stubFetch(impl: () => Promise<any>) {
  return vi.stubGlobal('fetch', vi.fn(impl));
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.INTASEND_SECRET_KEY;
});

describe('triggerIntasendRefund outcome classification', () => {
  it('provider success response → outcome completed with the provider tracking id', async () => {
    process.env.INTASEND_SECRET_KEY = 'r4m-test-live-secret-key-7f3a9c';
    stubFetch(async () => ({
      ok: true,
      json: async () => ({ tracking_id: 'TRK-ABC123' }),
    }));

    const result = await PaymentService.triggerIntasendRefund('+254700000001', 500, 'CLAIM-1');

    expect(result.outcome).toBe('completed');
    expect(result.success).toBe(true);
    expect(result.transactionId).toBe('TRK-ABC123');
  });

  it('HTTP error response (definite provider rejection) → outcome failed, NOT completed', async () => {
    process.env.INTASEND_SECRET_KEY = 'r4m-test-live-secret-key-7f3a9c';
    stubFetch(async () => ({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid account"}',
    }));

    const result = await PaymentService.triggerIntasendRefund('+254700000001', 500, 'CLAIM-1');

    // IntaSend explicitly rejected the request — refund definitely not
    // executed, so 'failed' is the safe classification.
    expect(result.outcome).toBe('failed');
    expect(result.success).toBe(false);
  });

  it('network timeout/exception → outcome unknown, NOT failed — no automatic duplicate refund is possible', async () => {
    process.env.INTASEND_SECRET_KEY = 'r4m-test-live-secret-key-7f3a9c';
    stubFetch(async () => {
      throw new Error('The operation was aborted due to timeout');
    });

    const result = await PaymentService.triggerIntasendRefund('+254700000001', 500, 'CLAIM-1');

    // THE central A1 invariant: a timeout does NOT mean "IntaSend definitely
    // rejected the refund". The caller must never auto-retry based on this
    // outcome — it must leave the claim in 'refunding' for reconciliation.
    expect(result.outcome).toBe('unknown');
    expect(result.success).toBe(false);
    expect(result.transactionId).toBe('');
  });
});
