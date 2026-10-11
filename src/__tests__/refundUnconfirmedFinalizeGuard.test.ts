import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { db } from '../db/database';
import { generateToken } from '../services/auth';
import { registerAdminDisputeRoutes } from '../routes/adminDisputes';
import { ensureTestCategory, testRunId } from '../db/__tests__/ensureTestCategory';

// =============================================================================
// BATCH 1B-C1-R1 — THE REFUND SEAM.
// An unconfirmed provider outcome can never finalize a refund or notify anyone.
//
// BATCH 1B-C1-R2 STRENGTHENS THIS TO: NO initiation response can finalize a
// refund. R1 stopped "ANY 2xx completes" but still let a per-transaction TS100
// INSIDE the initiation body complete the refund and notify the customer. That
// is still a false completion: /send-money/initiate/ is an INITIATION endpoint
// whose documented 2xx responses include BP103 "Preview and approve" (pays
// nothing until a separate approval call) and TP101 "Pending", and no
// authoritative refund-status confirmation mechanism exists in this codebase
// yet. Every 2xx is now 'unknown', so the route's `outcome === 'completed'`
// branch is unreachable from this path, and the tests below prove the claim
// stays in 'refunding' with no refund ledger row and no notification.
// =============================================================================
// The defect this file pins was not in the state machine; it was in the seam
// between the provider call and the two state changes that follow it.
// PaymentService.triggerIntasendRefund() reported ANY HTTP 2xx from
// /send-money/initiate/ as `outcome: 'completed'`, so this route — its only
// production caller — took its `outcome === 'completed'` branch, which
//   * called db.finalizeClaimRefund()   (refunding -> refunded + ledger row),
//   * produced the customer's "refund complete" notification,
// for a batch IntaSend had merely ACCEPTED (or only previewed for approval),
// with a fabricated 'ISD-REFUND-...' transaction id when the provider returned
// none.
//
// Nothing here contacts IntaSend: the provider is a stubbed `fetch` whose canned
// responses are the shapes IntaSend documents. Everything else is REAL — the
// real Express route module, the real authenticateJWT, the real DB layer, the
// real transition guards and the real reconciliation surface. The notification
// producers are the ONE doubled seam, because the question "did the customer get
// told?" is a question about a call, and because a recording stand-in is the
// only way to assert a NOT-called. The P8 control below (claimNotSuccessful)
// asserts a producer WAS called, which is what proves the stand-in is genuinely
// wired to the route's
// import — otherwise "never called" assertions would be vacuous.
// =============================================================================

const RUN = testRunId;
let counter = 0;
const nextId = (prefix: string) => `${prefix}-${RUN}-${counter++}`;

const ADMIN_USER = `refund-seam-admin-${RUN}`;
const ADMIN_ID = `ADM-RFS-${RUN}`;

// --- the doubled provider seam ----------------------------------------------
const provider = {
  mode: 'accept' as 'accept' | 'network-error' | 'reject',
  // The HTTP status returned by the 'reject' mode. 400 is a definite refusal;
  // individual tests set 408/429/5xx to exercise the ambiguity rule.
  status: 400,
  body: {} as any,
  calls: [] as Array<{ url: string; body: any }>,
};

const realFetch = globalThis.fetch;

function installProviderSeam() {
  vi.stubGlobal('fetch', (input: any, init: any = {}) => {
    const url = String(input?.url ?? input);
    // Anything that is not the payment provider (i.e. this test's own local HTTP
    // server) passes through untouched.
    if (!/intasend\.com/i.test(url)) return realFetch(input, init);
    let body: any = null;
    try { body = JSON.parse(String(init?.body ?? '{}')); } catch { /* not json */ }
    provider.calls.push({ url, body });
    if (provider.mode === 'network-error') {
      // A genuine transport ambiguity: the request may never have arrived, or it
      // may have been received and executed before the connection failed.
      return Promise.reject(new Error('simulated provider network failure'));
    }
    if (provider.mode === 'reject') {
      return Promise.resolve({
        ok: false, status: provider.status,
        text: async () => 'simulated provider rejection',
        json: async () => ({}),
      } as any);
    }
    return Promise.resolve({
      ok: true, status: 200,
      text: async () => JSON.stringify(provider.body),
      json: async () => provider.body,
    } as any);
  });
}

// --- the doubled notification seam ------------------------------------------
const produced = vi.hoisted(() => ({
  refundComplete: [] as string[],
  claimNotSuccessful: [] as string[],
}));

vi.mock('../services/claimNotificationProducers', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    produceClaimNotSuccessful: vi.fn(async (claimId: string) => {
      produced.claimNotSuccessful.push(claimId);
      return 'NOTIF-TEST';
    }),
    produceRefundComplete: vi.fn(async (claimId: string) => {
      produced.refundComplete.push(claimId);
      return 'NOTIF-TEST';
    }),
  };
});

// --- the real application surface -------------------------------------------
let server: any;
let baseUrl = '';
let adminToken = '';

async function api(method: string, path: string, token: string, body?: any) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await realFetch(baseUrl + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, text, json };
}

/**
 * A dispute whose LOSING claimant (claimant_2) has genuinely paid into escrow,
 * built the same way refundStateMachine.test.ts builds it: the payment truth
 * (`paid_at`, which locks the claim into 'refunding') can only be produced by the
 * real guarded CAS in attemptClaimEscrowHold, never by fixture stamping.
 */
async function makePaidLoserPair() {
  const itemId = nextId('RFS-ITEM');
  await ensureTestCategory('phone');
  const winningClaimId = nextId('RFS-CLAIM-WINNER');
  const loserClaimId = nextId('RFS-CLAIM-LOSER');

  await db.createItem({
    id: itemId, category_id: 'phone', photo_url: 'test-photo.jpg', ocr_extracted_number: null,
    ocr_extracted_name: null, document_number_hash: null, document_name_fuzzy: null,
    location_description: 'x', latitude: null, longitude: null, finder_phone: '+254700000005',
    assigned_agent_id: null, status: 'at_agent', flaggedForReview: false, isDescriptionOnly: true,
    description: 'x', is_sensitive_document: false, rejection_reason: null,
  } as any);

  await db.createClaim({
    id: loserClaimId, item_id: itemId, owner_phone: '+254700000007',
    security_answers: { lastDigits: '1111', color: 'red', lostDetails: 'loser fixture' },
    verification_tier: 1, status: 'pending_payment', owner_id_proof_url: null,
    payment_reference: null, owner_identifying_details: null,
  } as any);
  const held = await db.attemptClaimEscrowHold(loserClaimId, 'TEST-MPESA-REF-123');
  if (!held) throw new Error('fixture: expected the escrow CAS to confirm the loser payment');

  await db.createClaim({
    id: winningClaimId, item_id: itemId, owner_phone: '+254700000006',
    security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'winner fixture' },
    verification_tier: 1, status: 'disputed', owner_id_proof_url: null,
    payment_reference: null, owner_identifying_details: null,
  } as any);

  const disputeId = nextId('RFS-DISPUTE');
  await db.createDispute({
    id: disputeId, item_id: itemId,
    claimant_1_claim_id: winningClaimId, claimant_2_claim_id: loserClaimId,
    claimant_1_id_proof_url: 'test-proof-1', claimant_2_id_proof_url: 'test-proof-2',
    resolved_by: null, resolved_claim_id: null, resolved_at: null, admin_notes: null,
  } as any);

  return { itemId, disputeId, winningClaimId, loserClaimId };
}

const refundLedgerRows = async (claimId: string) =>
  (await db.getLedgerEntriesForClaim(claimId)).filter((l) => l.type === 'refund');

const unknownOutcomeAudits = async (claimId: string) =>
  (await db.getAuditLogs()).filter(
    (l) => l.action === 'REFUND_UNKNOWN_OUTCOME' && l.details.includes(claimId),
  );

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerAdminDisputeRoutes(app, {
    // A pass-through stand-in for server.ts's requireCurrentAdminSession, exactly
    // as disputeWorkflow.test.ts uses it: the real authenticateJWT and the real
    // role check inside the route are what authorize this request.
    requireCurrentAdminSession: (_req: any, _res: any, next: any) => next(),
    sendServerError: (res: any, error: any, _context: string) =>
      res.status(500).json({ error: error?.message || String(error) }),
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  adminToken = generateToken(
    { userId: ADMIN_ID, phone: '+254700000000', role: 'admin', username: ADMIN_USER } as any,
    '1h',
  );
  // A key that is valid nowhere, but is NOT recognised as a placeholder, so the
  // real provider path runs against the stubbed fetch (no simulation). NOTE: the
  // key must not contain any placeholder substring isPlaceholderKey() matches
  // (e.g. "placeholder") or the simulation branch silently satisfies these tests.
  process.env.INTASEND_SECRET_KEY = 'r4m-test-sandbox-key-4a1f';
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  provider.mode = 'accept';
  provider.status = 400;
  provider.body = {};
  provider.calls = [];
  produced.refundComplete.length = 0;
  produced.claimNotSuccessful.length = 0;
  installProviderSeam();
});

describe('BATCH 1B-C1-R1 / R2 — an unconfirmed refund initiation can never finalize a refund', () => {
  it('a 200 preview / approval-pending batch (BP103) leaves the claim in refunding and notifies nobody', async () => {
    const { disputeId, winningClaimId, loserClaimId } = await makePaidLoserPair();
    provider.body = {
      tracking_id: 'TRK-APPROVAL-1',
      status_code: 'BP103',
      status: 'Preview and approve',
      transactions: [{
        transaction_id: 'TX-APPROVAL-1',
        status: 'Preview and approve',
        status_code: 'BP103',
        account: '254700000007',
        amount: '100',
      }],
    };

    const res = await api('POST', '/api/admin/disputes/resolve', adminToken, {
      disputeId, winningClaimId, adminNotes: 'approval-pending provider batch',
    });

    // The dispute WAS resolved; the refund was not.
    expect(res.status).toBe(207);
    expect(res.json.refundUnknown).toBe(true);
    expect(res.json.refundFailed).toBeUndefined();

    // The provider was called exactly once, and answered with a preview batch.
    expect(provider.calls).toHaveLength(1);

    // NOT finalized: no refunding -> refunded transition happened...
    expect((await db.getClaim(loserClaimId))!.status).toBe('refunding');
    // ...no money is recorded as returned...
    expect(await refundLedgerRows(loserClaimId)).toHaveLength(0);
    // ...and the customer was never told their refund is complete.
    expect(produced.refundComplete).toHaveLength(0);
    // Control: the route really did run its post-resolve steps (P8 fired for the
    // losing claimant), so the empty refundComplete list is a real "not called".
    expect(produced.claimNotSuccessful).toEqual([loserClaimId]);
    // The unresolved outcome is recorded so an admin can reconcile it.
    expect(await unknownOutcomeAudits(loserClaimId)).toHaveLength(1);
  });

  it('a 200 with missing/malformed transaction details leaves the claim in refunding and notifies nobody', async () => {
    const { disputeId, winningClaimId, loserClaimId } = await makePaidLoserPair();
    // 2xx, and an entry that carries no transaction_id and no status at all: the
    // provider said "accepted" and described nothing we can verify.
    provider.body = {
      tracking_id: 'TRK-MALFORMED-1',
      transactions: [{ account: '254700000007' }],
    };

    const res = await api('POST', '/api/admin/disputes/resolve', adminToken, {
      disputeId, winningClaimId, adminNotes: 'malformed transaction details',
    });

    expect(res.status).toBe(207);
    expect(res.json.refundUnknown).toBe(true);
    expect(provider.calls).toHaveLength(1);
    expect((await db.getClaim(loserClaimId))!.status).toBe('refunding');
    expect(await refundLedgerRows(loserClaimId)).toHaveLength(0);
    expect(produced.refundComplete).toHaveLength(0);
    expect(await unknownOutcomeAudits(loserClaimId)).toHaveLength(1);
  });

  it('even a transaction-level TS100 in the initiation response does NOT finalize the refund or notify the customer', async () => {
    const { disputeId, winningClaimId, loserClaimId } = await makePaidLoserPair();
    provider.body = {
      tracking_id: 'TRK-CONFIRMED-1',
      transactions: [{
        transaction_id: 'TX-CONFIRMED-1',
        status: 'Successful',
        status_code: 'TS100',
        account: '254700000007',
        amount: '100',
      }],
    };

    const res = await api('POST', '/api/admin/disputes/resolve', adminToken, {
      disputeId, winningClaimId, adminNotes: 'initiation response carrying TS100',
    });

    // BATCH 1B-C1-R2: the dispute WAS resolved, but the refund was NOT. An
    // initiation response is a submission receipt, so a TS100 inside it proves
    // nothing about settlement.
    expect(res.status).toBe(207);
    expect(res.json.refundUnknown).toBe(true);
    expect(res.json.refundFailed).toBeUndefined();
    // The provider was really contacted (this is NOT the no-credentials
    // simulation branch, which would bypass the assertions below), and it
    // answered with a transaction-level success code.
    expect(provider.calls).toHaveLength(1);
    // NOT finalized: no refunding -> refunded transition...
    expect((await db.getClaim(loserClaimId))!.status).toBe('refunding');
    // ...no money is recorded as returned...
    expect(await refundLedgerRows(loserClaimId)).toHaveLength(0);
    // ...and the customer was never told their refund is complete.
    expect(produced.refundComplete).toHaveLength(0);
    // Control: the route really did run its post-resolve steps (P8 fired for the
    // losing claimant), so the empty refundComplete list above is a real "not
    // called" and the producer stand-in is genuinely wired to the route's import
    // — see the file header.
    expect(produced.claimNotSuccessful).toEqual([loserClaimId]);
    // The unresolved outcome is recorded so an admin can reconcile it.
    expect(await unknownOutcomeAudits(loserClaimId)).toHaveLength(1);
  });

  it('a transport failure stays unresolved, is never auto-retried, and a repeated resolve cannot re-initiate the refund', async () => {
    const { disputeId, winningClaimId, loserClaimId } = await makePaidLoserPair();
    provider.mode = 'network-error';

    const first = await api('POST', '/api/admin/disputes/resolve', adminToken, {
      disputeId, winningClaimId, adminNotes: 'ambiguous transport failure',
    });

    expect(first.status).toBe(207);
    expect(first.json.refundUnknown).toBe(true);
    expect(provider.calls).toHaveLength(1);
    expect((await db.getClaim(loserClaimId))!.status).toBe('refunding');
    expect(await refundLedgerRows(loserClaimId)).toHaveLength(0);
    expect(produced.refundComplete).toHaveLength(0);

    // A second attempt at the same admin action must NOT re-send the refund:
    // resolveDispute's resolved_at CAS refuses it (409) before any provider call,
    // so an ambiguous initiation can never be blindly duplicated.
    const second = await api('POST', '/api/admin/disputes/resolve', adminToken, {
      disputeId, winningClaimId, adminNotes: 'retry attempt on an already-resolved dispute',
    });

    expect(second.status).toBe(409);
    expect(provider.calls).toHaveLength(1);
    expect(produced.refundComplete).toHaveLength(0);
    expect((await db.getClaim(loserClaimId))!.status).toBe('refunding');
  });

  // ---------------------------------------------------------------------------
  // BATCH 1B-C1/R1/R2-R3 — HTTP 429 is AMBIGUOUS, and the simulation gate is a
  // fail-closed allow-list.
  // ---------------------------------------------------------------------------
  it('HTTP 429 (provider rate limit) is UNKNOWN: the refund lock is NOT released and nobody is notified', async () => {
    const { disputeId, winningClaimId, loserClaimId } = await makePaidLoserPair();
    provider.mode = 'reject';
    provider.status = 429;

    const res = await api('POST', '/api/admin/disputes/resolve', adminToken, {
      disputeId, winningClaimId, adminNotes: 'provider rate-limited the refund initiation',
    });

    // R3: a 429 must NOT take the definite-refusal branch (which reverts the
    // lock to 'rejected' and invites a re-send) — execution cannot be ruled out.
    expect(res.status).toBe(207);
    expect(res.json.refundUnknown).toBe(true);
    expect(res.json.refundFailed).toBeUndefined();
    expect(provider.calls).toHaveLength(1);
    expect((await db.getClaim(loserClaimId))!.status).toBe('refunding');
    expect(await refundLedgerRows(loserClaimId)).toHaveLength(0);
    expect(produced.refundComplete).toHaveLength(0);
    expect(await unknownOutcomeAudits(loserClaimId)).toHaveLength(1);

    // No automatic retry: the same admin action cannot re-initiate the refund,
    // and nothing else resends it.
    const retry = await api('POST', '/api/admin/disputes/resolve', adminToken, {
      disputeId, winningClaimId, adminNotes: 'retry after a rate limit',
    });
    expect(retry.status).toBe(409);
    expect(provider.calls).toHaveLength(1);
    expect((await db.getClaim(loserClaimId))!.status).toBe('refunding');
    expect(produced.refundComplete).toHaveLength(0);
  });

  it('keeps the refusal/ambiguity boundary intact: 400 still releases the lock, 408 stays unresolved', async () => {
    // A definite refusal: IntaSend received the request and refused it, so the
    // refund lock may be released and an admin is asked to follow up.
    const refused = await makePaidLoserPair();
    provider.mode = 'reject';
    provider.status = 400;
    const refusedRes = await api('POST', '/api/admin/disputes/resolve', adminToken, {
      disputeId: refused.disputeId, winningClaimId: refused.winningClaimId, adminNotes: 'definite provider refusal',
    });
    expect(refusedRes.status).toBe(207);
    expect(refusedRes.json.refundFailed).toBe(true);
    expect(refusedRes.json.refundUnknown).toBeUndefined();
    expect((await db.getClaim(refused.loserClaimId))!.status).toBe('rejected');
    expect(await refundLedgerRows(refused.loserClaimId)).toHaveLength(0);
    expect(produced.refundComplete).toHaveLength(0);

    // 408 keeps its pre-existing ambiguity, unchanged by R3.
    const timedOut = await makePaidLoserPair();
    provider.status = 408;
    const timeoutRes = await api('POST', '/api/admin/disputes/resolve', adminToken, {
      disputeId: timedOut.disputeId, winningClaimId: timedOut.winningClaimId, adminNotes: 'timeout',
    });
    expect(timeoutRes.status).toBe(207);
    expect(timeoutRes.json.refundUnknown).toBe(true);
    expect(timeoutRes.json.refundFailed).toBeUndefined();
    expect((await db.getClaim(timedOut.loserClaimId))!.status).toBe('refunding');
    expect(produced.refundComplete).toHaveLength(0);
  });

  it('a placeholder key in production cannot simulate a completed refund and cannot finalize anything', async () => {
    const { disputeId, winningClaimId, loserClaimId } = await makePaidLoserPair();
    const prevEnv = process.env.NODE_ENV;
    const prevKey = process.env.INTASEND_SECRET_KEY;
    // The fail-closed simulation gate: an unrecognised environment plus a
    // placeholder key must throw BEFORE any simulated 'completed' exists.
    process.env.NODE_ENV = 'production';
    process.env.INTASEND_SECRET_KEY = 'REPLACE_WITH_INTASEND_SECRET_KEY';
    let res: any;
    try {
      res = await api('POST', '/api/admin/disputes/resolve', adminToken, {
        disputeId, winningClaimId, adminNotes: 'misconfigured production simulation attempt',
      });
    } finally {
      if (prevKey === undefined) delete process.env.INTASEND_SECRET_KEY;
      else process.env.INTASEND_SECRET_KEY = prevKey;
      if (prevEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevEnv;
    }

    // The route surfaces the refusal as an error...
    expect(res.status).toBe(500);
    // ...no provider was contacted, so no request — simulated or real — exists...
    expect(provider.calls).toHaveLength(0);
    // ...nothing fabricated reached the response...
    expect(res.text).not.toContain('SIM-REFUND');
    // ...and the real refund-finalization path was NOT triggered.
    expect((await db.getClaim(loserClaimId))!.status).toBe('refunding');
    expect(await refundLedgerRows(loserClaimId)).toHaveLength(0);
    expect(produced.refundComplete).toHaveLength(0);
  });
});

