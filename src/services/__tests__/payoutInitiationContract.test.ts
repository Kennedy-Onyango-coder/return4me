import { describe, it, expect, afterEach, vi } from 'vitest';
import { PaymentService, buildPayoutLegIdempotencyKey, isDisbursementWalletConfigured, isPlaceholderKey } from '../payments';
import { isConfiguredWalletId } from '../../config/walletRouting';

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
    // BATCH P2 — requires_approval is now an explicit, documented batch field
    // (see the approval-mode block in triggerIntasendPayout). It is pinned here
    // so an accidental removal or a drift to another provider field is caught.
    expect(Object.keys(calls[0].body).sort()).toEqual(['currency', 'provider', 'requires_approval', 'transactions']);
  });
});

describe('BATCH P2 — automated approval mode is requested explicitly', () => {
  it('sends requires_approval:"NO" so the batch is not parked in BP103', async () => {
    useRealKey();
    const calls = stubProvider({ tracking_id: 'TRK-1', transactions: [] });

    await PaymentService.triggerIntasendPayout('CLAIM-1', twoLegs());

    // The documented automated-payout mode. Without it IntaSend can create the
    // batch in the "Preview and approve" (BP103) state, which pays nothing.
    expect(calls[0].body.requires_approval).toBe('NO');
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

// =============================================================================
// BATCH P2 — BP103 ("Preview and approve") IS HANDLED EXPLICITLY, NOT AS ACCEPTED.
// =============================================================================
// Even after the documented `requires_approval:"NO"` request, an account can be
// configured so IntaSend answers the initiation with the batch-level approval
// state BP103. The initiation path must:
//   * never report a BP103 batch as a completed payout (no 'success');
//   * never present it as an ordinary accepted/processing result ('pending') —
//     that state is for a batch the provider took and will disburse;
//   * report every leg as the UNRESOLVED 'unknown' outcome, which the settlement
//     executor turns into "return to pending_settlement, needs provider
//     reconciliation" rather than a finalized claim, and never auto-resubmits;
//   * preserve the provider batch reference so an operator can find the exact
//     batch in IntaSend.
// An ordinary 2xx with no approval code keeps its existing 'pending' behaviour.
// =============================================================================
describe('BATCH P2 — a BP103 "Preview and approve" batch is unresolved, never completed', () => {
  it('reports every leg unknown and keeps the batch reference when the provider answers BP103', async () => {
    useRealKey();
    // The batch-level status_code is the machine-readable BP103 token; the
    // human label is present too, as the provider actually returns it.
    const calls = stubProvider({
      tracking_id: 'TRK-BP103',
      status_code: 'BP103',
      status: 'Preview and approve',
      transactions: [
        { account: '254712345678', transaction_id: 'KQ9PLXR' },
        { account: '712345678', transaction_id: 'AB7CDE1' },
      ],
    });

    const result = await PaymentService.triggerIntasendPayout('CLAIM-1', twoLegs());

    // Exactly one provider call was made — BP103 is NOT auto-retried here.
    expect(calls.length).toBe(1);
    // The batch reference is preserved for operator reconciliation.
    expect(result.batchId).toBe('TRK-BP103');
    for (const r of result.results) {
      // Never a completion, and never a misleading "accepted/processing" either.
      expect(r.status).toBe('unknown');
      expect(r.status).not.toBe('success');
      expect(r.status).not.toBe('pending');
      // No per-leg provider transaction id is bound out of a parked batch.
      expect(r.providerTransactionId).toBeNull();
    }
  });

  it('recognises BP103 from the documented response shape (status_code + status label)', async () => {
    useRealKey();
    // The provider actually returns the machine code in `status_code` and the
    // human label in `status`. The classifier must recognise BP103 from the
    // machine code and treat the batch as approval-required, not as accepted.
    stubProvider({
      tracking_id: 'TRK-BP103',
      status_code: 'BP103',
      status: 'Preview and approve',
      transactions: [],
    });

    const result = await PaymentService.triggerIntasendPayout('CLAIM-1', twoLegs());

    expect(result.batchId).toBe('TRK-BP103');
    expect(result.results.every(r => r.status === 'unknown')).toBe(true);
  });

  it('does NOT treat an already-approved BP104 batch as awaiting approval (P2 correction)', async () => {
    useRealKey();
    // BP104 is the documented "Confirming balance / Approved; checking the wallet
    // balance" batch state — the OPPOSITE of awaiting approval. It must keep the
    // normal accepted/in-progress path ('pending'), never be converted to
    // 'unknown'. This pins the exact-BP103 classifier against the earlier broad
    // /^BP\d{3}$/ family match that wrongly swallowed BP104.
    stubProvider({
      tracking_id: 'TRK-BP104',
      status_code: 'BP104',
      status: 'Confirming balance',
      transactions: [{ account: '254712345678', transaction_id: 'KQ9PLXR' }],
    });

    const result = await PaymentService.triggerIntasendPayout('CLAIM-1', twoLegs());

    expect(result.batchId).toBe('TRK-BP104');
    for (const r of result.results) {
      expect(r.status).toBe('pending');
      expect(r.status).not.toBe('unknown');
      expect(r.status).not.toBe('success');
    }
  });

  it('an ordinary accepted batch (no approval code) keeps its existing pending behaviour', async () => {
    useRealKey();
    // Guards the fail-closed default: without a BP code the response is parsed
    // normally, and an accepted batch is 'pending', never 'success'.
    stubProvider({
      tracking_id: 'TRK-OK',
      status_code: 'OK',
      transactions: [{ account: '254712345678', transaction_id: 'KQ9PLXR' }],
    });

    const result = await PaymentService.triggerIntasendPayout('CLAIM-1', twoLegs());

    expect(result.batchId).toBe('TRK-OK');
    expect(result.results.every(r => r.status === 'pending')).toBe(true);
    expect(result.results.every(r => r.status !== 'success')).toBe(true);
  });
});

// =============================================================================
// PRODUCTION WALLET SELECTION — THE GATE IS ON THE NORMAL REQUEST PATH.
// =============================================================================
// `wallet_id` is the documented way to name the IntaSend working wallet a
// disbursement batch pays FROM. Two invariants must hold at this seam:
//
//   1. REACHABILITY — a production request carrying a valid secret key must
//      STILL be refused when INTASEND_DISBURSEMENT_WALLET_ID is missing, empty
//      or whitespace-only. The guard used to live INSIDE the placeholder-key
//      branch, written after that branch's production secret-key throw, so it
//      could only ever be reached with a PLACEHOLDER key: on the real production
//      path it was dead code, and a deployment with a real key and no wallet
//      silently fell back to the provider's default settlement wallet.
//   2. NON-PRODUCTION SAFETY — a configured production wallet ID must never be
//      sent to the sandbox/test provider.
//   3. PLACEHOLDER REJECTION — a present-but-placeholder value is NOT a
//      configured wallet: the documented .env.example value
//      ("REPLACE_WITH_KES_WORKING_WALLET_ID") and every other shape the
//      project-wide isPlaceholderKey() convention rejects must fail the gate
//      exactly like a missing value does. The gate reuses that one convention
//      (both the settlement-executor gate and the request-seam gate call
//      isDisbursementWalletConfigured()), so a deployment that copied
//      .env.example can never send a placeholder wallet ID to the provider.
//
// Every test below drives the REAL function against a stubbed `fetch`. That is
// deliberate: source-text assertions would NOT have caught the original defect
// (the guard existed and read correctly — it was simply unreachable), so the
// gate is pinned through the same code path production uses.
// =============================================================================

const WALLET_ENV_KEY = 'INTASEND_DISBURSEMENT_WALLET_ID';

const WALLET_UNCONFIGURED_CASES: Array<[string, string | undefined]> = [
  ['unset', undefined],
  ['empty', ''],
  ['whitespace-only', '   '],
  ['tab/newline-only', '\t\n'],
];

// Present, but not a wallet: every shape the shared placeholder convention
// rejects. The first entry is the exact value .env.example ships, so a
// deployment that copied the example verbatim is covered by a real case rather
// than by a hypothetical one.
const WALLET_PLACEHOLDER_CASES: Array<[string, string]> = [
  ['.env.example documented placeholder', 'REPLACE_WITH_KES_WORKING_WALLET_ID'],
  ['padded .env.example placeholder', '  REPLACE_WITH_KES_WORKING_WALLET_ID  '],
  ['lowercase "replace_with"', 'replace_with_a_real_wallet_id'],
  ['"placeholder"', 'placeholder'],
  ['"your_key" convention', 'PASTE_YOUR_KEY_HERE'],
  ['"changeme" convention', 'CHANGEME'],
  ['"change_me" convention', 'change_me_wallet'],
  ['"todo"', 'todo'],
];

// A realistic IntaSend-shaped fixture: the placeholder rule must NOT match it.
const REALISTIC_WALLET_FIXTURE = 'b1f4c0de-9a72-4f5c-8e11-2a3d5c7e9f01';

function useProductionKey(walletId: string | undefined) {
  process.env.NODE_ENV = 'production';
  process.env.INTASEND_SECRET_KEY = 'MY_TEST_ONLY_WALLET_PROD_KEY';
  if (walletId === undefined) {
    // `delete`, never an undefined assignment: assigning undefined stringifies
    // to the literal 'undefined', which would read as a CONFIGURED wallet.
    delete process.env[WALLET_ENV_KEY];
  } else {
    process.env[WALLET_ENV_KEY] = walletId;
  }
}

describe('PRODUCTION WALLET SELECTION — reachable fail-closed gate, exact injection', () => {
  it('sends the configured production wallet ID verbatim and changes nothing else in the batch', async () => {
    useProductionKey('KES-PROD-WALLET-1');
    const calls = stubProvider({
      tracking_id: 'TRK-W1',
      status_code: 'OK',
      transactions: [{ account: '254712345678', transaction_id: 'KQ9PLXR' }],
    });

    await PaymentService.triggerIntasendPayout('CLAIM-1', twoLegs());

    expect(calls.length).toBe(1);
    // The EXACT configured value — not a default, not a sandbox fallback.
    expect(calls[0].body.wallet_id).toBe('KES-PROD-WALLET-1');
    // The injection is additive: every documented batch field is unchanged...
    expect(calls[0].body.provider).toBe('MPESA-B2C');
    expect(calls[0].body.currency).toBe('KES');
    expect(calls[0].body.requires_approval).toBe('NO');
    expect(Object.keys(calls[0].body).sort()).toEqual(
      ['currency', 'provider', 'requires_approval', 'transactions', 'wallet_id']
    );
    // ...and so are the transaction payloads, including their idempotency keys.
    expect(calls[0].body.transactions.map((t: any) => t.narrative).sort()).toEqual(
      ['R4M-AGENT-CLAIM-1', 'R4M-FINDER-CLAIM-1']
    );
    expect(calls[0].body.transactions.map((t: any) => t.amount).sort()).toEqual(['300', '500']);
    expect(calls[0].body.transactions.map((t: any) => t.idempotency_key).sort()).toEqual(
      [buildPayoutLegIdempotencyKey('CLAIM-1', 'finder'), buildPayoutLegIdempotencyKey('CLAIM-1', 'agent')].sort()
    );
  });

  it.each(WALLET_UNCONFIGURED_CASES)(
    'fails closed BEFORE the provider request when the production wallet ID is %s',
    async (_label, walletValue) => {
      useProductionKey(walletValue);
      const calls = stubProvider({ tracking_id: 'TRK-MUST-NOT-BE-USED', transactions: [] });

      await expect(PaymentService.triggerIntasendPayout('CLAIM-1', twoLegs()))
        .rejects.toThrow(/INTASEND_DISBURSEMENT_WALLET_ID is not configured in production/);

      // Fail-closed means the provider was never contacted at all.
      expect(calls.length).toBe(0);
    }
  );

  // A present-but-placeholder value is not a configured wallet. These cases pin
  // the shared isPlaceholderKey() convention at the SAME seam as the missing
  // cases above: refusal happens before the request is built or sent.
  it.each(WALLET_PLACEHOLDER_CASES)(
    'fails closed BEFORE the provider request when the production wallet ID is %s',
    async (_label, walletValue) => {
      useProductionKey(walletValue);
      const calls = stubProvider({ tracking_id: 'TRK-MUST-NOT-BE-USED', transactions: [] });

      await expect(PaymentService.triggerIntasendPayout('CLAIM-1', twoLegs()))
        .rejects.toThrow(/INTASEND_DISBURSEMENT_WALLET_ID is not configured in production/);

      // Fail-closed means the provider was never contacted at all.
      expect(calls.length).toBe(0);
    }
  );

  it('accepts a realistic, explicitly configured fixture wallet ID verbatim (the placeholder rule is not over-broad)', async () => {
    useProductionKey(REALISTIC_WALLET_FIXTURE);
    const calls = stubProvider({ tracking_id: 'TRK-W2', transactions: [] });

    await PaymentService.triggerIntasendPayout('CLAIM-1', twoLegs());

    expect(calls.length).toBe(1);
    expect(calls[0].body.wallet_id).toBe(REALISTIC_WALLET_FIXTURE);
  });

  it('the ONE helper both production gates call rejects every placeholder shape and accepts a real fixture', () => {
    // executeClaimSettlement() in server.ts and triggerIntasendPayout() above
    // both delegate to this helper, so this assertion covers the
    // settlement-executor gate as well as the request-seam gate.
    for (const [label, walletValue] of WALLET_PLACEHOLDER_CASES) {
      useProductionKey(walletValue);
      expect(
        isDisbursementWalletConfigured(),
        `placeholder shape "${label}" must not count as a configured wallet`
      ).toBe(false);
    }
    useProductionKey(REALISTIC_WALLET_FIXTURE);
    expect(isDisbursementWalletConfigured()).toBe(true);
  });

  // BATCH 2 — the wallet-routing module carries its own copy of the placeholder
  // rule (see the cycle note there). The copy is only safe if it agrees with the
  // payment gate in every case, so the two are compared directly here.
  it('the wallet-routing placeholder rule agrees with the payment gate', () => {
    const cases: Array<string | null | undefined> = [
      undefined,
      null,
      '',
      '   ',
      '\t\n',
      'REPLACE_WITH_KES_WORKING_WALLET_ID',
      '  REPLACE_WITH_KES_WORKING_WALLET_ID  ',
      'replace_with_a_wallet',
      'placeholder',
      'PASTE_YOUR_KEY_HERE',
      'CHANGEME',
      'change_me_wallet',
      'xxx',
      'TODO',
      'tbd',
      REALISTIC_WALLET_FIXTURE,
      'KES-PROD-WALLET-1',
    ];
    for (const value of cases) {
      expect(
        isConfiguredWalletId(value),
        `wallet-routing and payment rules disagree for ${String(value)}`
      ).toBe(!isPlaceholderKey(value));
    }
  });

  it('keeps the production secret-key refusal intact and independent of the wallet gate', async () => {
    process.env.NODE_ENV = 'production';
    process.env.INTASEND_SECRET_KEY = 'REPLACE_WITH_REAL_INTASEND_KEY';
    // A configured wallet must NOT rescue a placeholder key.
    process.env[WALLET_ENV_KEY] = 'KES-PROD-WALLET-1';
    const calls = stubProvider({ tracking_id: 'TRK-MUST-NOT-BE-USED', transactions: [] });

    await expect(PaymentService.triggerIntasendPayout('CLAIM-1', twoLegs()))
      .rejects.toThrow(/IntaSend secret key is missing or still a placeholder/);
    expect(calls.length).toBe(0);
  });

  it('never sends the configured production wallet ID to the sandbox/test provider', async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTASEND_SECRET_KEY = 'MY_TEST_ONLY_1BC1_KEY';
    process.env[WALLET_ENV_KEY] = 'KES-PROD-WALLET-1';
    const calls = stubProvider({ tracking_id: 'TRK-NP', transactions: [] });

    await PaymentService.triggerIntasendPayout('CLAIM-1', twoLegs());

    expect(calls.length).toBe(1);
    expect(calls[0].body.wallet_id).toBeUndefined();
    expect(Object.keys(calls[0].body).sort()).toEqual(
      ['currency', 'provider', 'requires_approval', 'transactions']
    );
  });

  it('keeps the exact BP103 handling on the production wallet path', async () => {
    useProductionKey('KES-PROD-WALLET-1');
    const calls = stubProvider({
      tracking_id: 'TRK-W-BP103',
      status_code: 'BP103',
      status: 'Preview and approve',
      transactions: [
        { account: '254712345678', transaction_id: 'KQ9PLXR' },
        { account: '712345678', transaction_id: 'AB7CDE1' },
      ],
    });

    const result = await PaymentService.triggerIntasendPayout('CLAIM-1', twoLegs());

    // The wallet is sent AND the parked-batch handling is unchanged: unresolved,
    // never completed, batch reference preserved, nothing auto-retried.
    expect(calls.length).toBe(1);
    expect(calls[0].body.wallet_id).toBe('KES-PROD-WALLET-1');
    expect(result.batchId).toBe('TRK-W-BP103');
    expect(result.results.every(r => r.status === 'unknown')).toBe(true);
    expect(result.results.every(r => r.status !== 'success')).toBe(true);
    expect(result.results.every(r => r.providerTransactionId === null)).toBe(true);
  });

  // BATCH 2 — THE ROUTING COLLISION, AT THE REAL SEAM.
  //
  // A working wallet that IS the declared collection wallet is not a usable
  // payout configuration: it re-creates the provider's default settlement-wallet
  // debit and mixes customer funds with payout float. The refusal must be
  // reachable on the normal production path (a REAL key, a CONFIGURED wallet) and
  // must happen before the request is built or sent.
  it('refuses a production payout when the working wallet IS the declared settlement wallet', async () => {
    useProductionKey('KES-PROD-WALLET-1');
    process.env.INTASEND_SETTLEMENT_WALLET_ID = 'KES-PROD-WALLET-1';
    const calls = stubProvider({ tracking_id: 'TRK-MUST-NOT-BE-USED', transactions: [] });

    await expect(PaymentService.triggerIntasendPayout('CLAIM-1', twoLegs()))
      .rejects.toThrow(/names the same wallet as INTASEND_SETTLEMENT_WALLET_ID/);

    // Fail-closed means the provider was never contacted at all.
    expect(calls.length).toBe(0);
    delete process.env.INTASEND_SETTLEMENT_WALLET_ID;
  });

  it('still sends the batch when the settlement wallet is declared and DIFFERENT (identity-only, never in the request)', async () => {
    useProductionKey('KES-PROD-WALLET-1');
    process.env.INTASEND_SETTLEMENT_WALLET_ID = 'KES-PROD-SETTLEMENT-9';
    const calls = stubProvider({ tracking_id: 'TRK-W3', transactions: [] });

    await PaymentService.triggerIntasendPayout('CLAIM-1', twoLegs());

    expect(calls.length).toBe(1);
    expect(calls[0].body.wallet_id).toBe('KES-PROD-WALLET-1');
    // The settlement wallet is an identity check, NOT a routing input: it must
    // never appear anywhere in the provider request body.
    expect(JSON.stringify(calls[0].body)).not.toContain('KES-PROD-SETTLEMENT-9');
    delete process.env.INTASEND_SETTLEMENT_WALLET_ID;
  });
});
