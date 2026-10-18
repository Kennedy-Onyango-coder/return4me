import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { db } from '../db/database';
import { createApp } from '../server';
import { generateToken } from '../services/auth';

// =============================================================================
// BATCH 1 (C) — REAL HTTP BEHAVIOUR FOR THE PASSWORD-CONFIRMED PAYOUT ROUTES.
// =============================================================================
// WHY THIS FILE EXISTS
//   Before it, the only assertions about "Approve & pay" were SOURCE-TEXT pins
//   (adminSettlementLifecycleUx.test.ts): they prove the console calls the route
//   with the right strings, and nothing at all about what the route does. A route
//   that ignored the password, or approved without paying, or wrote an approval on
//   a wrong password, would have passed every one of them.
//
//   This suite drives the REAL application — `createApp()` from src/server.ts, an
//   ephemeral socket, the real Express chain, the real JWT/bcrypt checks, the real
//   compare-and-swap writes and the real settlement executor — and asserts the
//   OUTCOME in the database and at the provider boundary. The only doubled thing
//   is the provider itself (see `payout` below); nothing about the money path's
//   own logic is stubbed.
// =============================================================================

const RUN = `b1-${Date.now().toString(36)}`;
const CATEGORY = `B1-CAT-${RUN}`;
const TOTAL_FEE = 250;
const ADMIN_USERNAME = `b1-admin-${RUN}`;
// A SECOND real administrator, used so the per-account failed-confirmation budget
// (10 / 15 minutes) can be exercised without one test file exhausting it. That is
// the limiter working as designed, not a test inconvenience: the ceiling is per
// ACCOUNT precisely so one operator's failures cannot lock out another's.
const ADMIN2_USERNAME = `b1-admin2-${RUN}`;
// Committed test fixtures. Not credentials: valid against no real account, and the
// MY_TEST_ONLY_ prefix keeps the CI secret scanner from ever treating them as one.
const ADMIN_PASSWORD = 'MY_TEST_ONLY_B1_ADMIN_PASSWORD';
const FAKE_INTASEND_KEY = 'MY_TEST_ONLY_INTASEND_KEY_b1_settlement';

const APPROVE_AND_PAY = (id: string) => `/api/admin/claims/${id}/settlement/approve-and-pay`;
const INITIATE = (id: string) => `/api/admin/claims/${id}/settlement/initiate`;
const RELEASE = (id: string) => `/api/admin/claims/${id}/release-settlement`;

let app: any;
let server: any;
let base = '';
let adminToken = '';
const agentPhone = '+254700000123';

// --- PROVIDER SEAM ----------------------------------------------------------
// `mode` is swapped per test; `calls` records what the application actually SENT.
// Every non-IntaSend URL passes through to the real fetch, so the suite's own HTTP
// calls are unaffected.
const payout = {
  mode: 'accept' as 'accept' | 'network-error' | 'reject',
  calls: [] as Array<{ url: string; payload: any }>,
  narratives: [] as string[],
  reset() {
    this.mode = 'accept';
    this.calls = [];
    this.narratives = [];
  },
};
const realFetch = globalThis.fetch;

beforeAll(async () => {
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    app = await createApp();
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
  server = await new Promise<any>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  if (!(await db.getCategories()).some((c: any) => c.id === CATEGORY)) {
    await db.createCategory({
      id: CATEGORY,
      name_en: `B1 Settlement Category ${RUN}`,
      name_sw: 'Jamii',
      total_fee: TOTAL_FEE,
      finder_share: 100,
      agent_share: 150,
      platform_share: 0,
      is_sensitive_document: false,
    } as any);
  }
}, 180000);

afterAll(async () => {
  vi.unstubAllGlobals();
  if (server) await new Promise<void>((r) => server.close(() => r()));
});

// No test may leave the platform paused for the next one. `payouts_paused` is a
// real platform setting, so a failed assertion between "pause" and "resume" would
// otherwise silently disable every later payout test in this file.
afterEach(async () => {
  await db.setSetting('payouts_paused', 'false', 'B1 test');
});

// --- HTTP HELPER ------------------------------------------------------------
let ipCounter = 0;
beforeEach(() => {
  // A distinct client address per test: the payout limiter is keyed by
  // administrator, but other limiters in the chain are still IP-keyed, and a
  // shared loopback address would let one test consume another's budget.
  ipCounter += 1;
  payout.reset();
  // Default to simulation (a confirmable outcome). Tests that must prove what is
  // SENT to the provider call useProviderSeam() explicitly.
  useSimulatedPayout();
  vi.stubGlobal('fetch', (input: any, init: any = {}) => {
    const url = String(input?.url ?? input);
    if (!/intasend\.com/i.test(url)) return realFetch(input, init);
    let body: any = null;
    try { body = JSON.parse(String(init?.body ?? '{}')); } catch { /* not json */ }
    payout.calls.push({ url, payload: body });
    for (const t of (body?.transactions ?? [])) payout.narratives.push(String(t?.narrative));
    if (payout.mode === 'network-error') {
      // A genuine timeout: the application cannot know whether the provider acted.
      return Promise.reject(new Error('simulated provider network failure'));
    }
    if (payout.mode === 'reject') {
      return Promise.resolve({ ok: false, status: 500, text: async () => 'simulated rejection', json: async () => ({}) } as any);
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      text: async () => '{}',
      // The provider's accepted-batch shape: a tracking id plus one
      // transaction_id per leg and NO per-transaction status. A per-transaction
      // `status: 'Success'` would instead classify as 'accepted' (the batch was
      // accepted; the transfer is not confirmed), which is the AMBIGUOUS case this
      // suite exercises deliberately, not the confirmed one it needs here.
      json: async () => ({
        tracking_id: `B1-BATCH-${ipCounter}-${RUN}`,
        transactions: (body?.transactions ?? []).map((t: any, i: number) => ({
          account: t?.account,
          transaction_id: `B1-TXN-${ipCounter}-${i}-${RUN}`,
        })),
      }),
    } as any);
  });
});

async function http(
  pathname: string,
  opts: { method?: string; body?: any; token?: string } = {},
) {
  const headers: Record<string, string> = {
    'X-Forwarded-For': `10.60.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`,
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await realFetch(base + pathname, {
    method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, body: json };
}

const agentToken = () =>
  generateToken({ id: `b1-agent-${RUN}`, role: 'agent', agentId: `B1-AGENT-${RUN}` } as any);

/**
 * SIMULATION vs. THE PROVIDER SEAM — a distinction this suite must not blur.
 *
 * A real IntaSend batch that answers 2xx is ALWAYS reported 'pending' per leg
 * (see PaymentService.triggerIntasendPayout): the provider accepting a batch is
 * not the transfer having completed, and only reconciliation can confirm it. So a
 * CONFIRMED settlement is reachable in this suite only through the simulation
 * branch, which NODE_ENV=test explicitly permits and which is never used in
 * production.
 *
 *   useSimulatedPayout() -> a confirmable outcome (claim released)
 *   useProviderSeam()    -> a real (stubbed) request, which is 'submitted but
 *                           not confirmed' by design
 *
 * Both are exercised; neither is presented as the other.
 */
const useSimulatedPayout = () => {
  delete process.env.INTASEND_SECRET_KEY;
};
const useProviderSeam = () => {
  process.env.INTASEND_SECRET_KEY = FAKE_INTASEND_KEY;
};

const auditsFor = async (claimId: string, action: string) =>
  (await db.getAuditLogs()).filter(
    (l: any) => l.action === action && String(l.details).includes(claimId),
  );

// --- REAL ADMIN ACCOUNT + REAL LOGIN ---------------------------------------
// The bcrypt comparison, the 4h admin token and its embedded token_version all
// come from production code; requireCurrentAdminSession is never stubbed.
let secondAdminToken = '';
let revokedAdminToken = '';

beforeAll(async () => {
  const bcrypt = (await import('bcryptjs')).default;
  for (const username of [ADMIN_USERNAME, ADMIN2_USERNAME]) {
    if (!(await db.getAdminByUsername(username))) {
      await db.createAdminUser(
        `B1-ADM-${username}`,
        username,
        await bcrypt.hash(ADMIN_PASSWORD, 4),
        'B1 Settlement Admin',
      );
    }
  }
  const login = await http('/api/auth/admin-login', {
    body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
  });
  expect(login.status).toBe(200);
  expect(login.body?.token).toBeTruthy();
  adminToken = String(login.body.token);

  const login2 = await http('/api/auth/admin-login', {
    body: { username: ADMIN2_USERNAME, password: ADMIN_PASSWORD },
  });
  expect(login2.status).toBe(200);
  secondAdminToken = String(login2.body.token);
}, 180000);

/** A claim in a genuinely releasable shape: real category, real agent, real item,
 *  a real `enterPendingSettlement` booking (which books the three ledger rows), and
 *  — unless asked otherwise — a real durable approval. */
const makeClaim = async (
  suffix: string,
  opts: {
    windowMs?: number;
    approve?: boolean;
    /** A claim-specific agent, so one test can move its payout destination
     *  without touching the shared fixture the other tests rely on. */
    agentId?: string;
    agentDestination?: string;
    /** An item reported BEFORE shares were locked (every locked_* NULL). The
     *  executor then falls back to the category's CURRENT shares, which is the
     *  legacy case where the booked amount can stop matching the payable one. */
    legacyUnlockedShares?: boolean;
    categoryId?: string;
  } = {},
) => {
  const claimId = `B1-CLAIM-${RUN}-${suffix}`;
  const itemId = `B1-ITEM-${RUN}-${suffix}`;
  const agentId = opts.agentId ?? `B1-AGENT-${RUN}`;
  if (!(await db.getAgent(agentId))) {
    await db.createAgent({
      id: agentId,
      full_name: 'B1 Settlement Agent',
      contact_phone: '+254700000999',
      status: 'active',
      business_name: 'B1 Agency',
      location_address: 'Kenyatta Avenue, Nairobi',
      // The launch policy pays personal M-Pesa phone destinations only, so the
      // fixture holds exactly what the executor is permitted to send.
      mpesa_till_or_paybill: opts.agentDestination ?? agentPhone,
      payout_method_type: 'Personal M-Pesa',
      refundable_deposit: 0,
      national_id_hash: `B1-HASH-${RUN}`,
    } as any);
  }
  await db.createItem({
    id: itemId,
    category_id: opts.categoryId ?? CATEGORY,
    photo_url: 'b1-photo.jpg',
    ocr_extracted_number: null,
    ocr_extracted_name: null,
    document_number_hash: null,
    document_name_fuzzy: null,
    location_description: 'B1 settlement fixture',
    latitude: null,
    longitude: null,
    finder_phone: '+254700000456',
    assigned_agent_id: agentId,
    status: 'at_agent',
    flaggedForReview: false,
    isDescriptionOnly: false,
    description: null,
    is_sensitive_document: false,
    rejection_reason: null,
    locked_total_fee: opts.legacyUnlockedShares ? null : TOTAL_FEE,
    locked_finder_share: opts.legacyUnlockedShares ? null : 100,
    locked_agent_share: opts.legacyUnlockedShares ? null : 150,
    locked_platform_share: opts.legacyUnlockedShares ? null : 0,
  } as any);
  await db.createClaim({
    id: claimId,
    item_id: itemId,
    owner_phone: '+254700000789',
    security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'B1 fixture' },
    verification_tier: 1,
    status: 'escrow_held',
    owner_id_proof_url: null,
    payment_reference: `B1-PAYREF-${RUN}-${suffix}`,
    owner_identifying_details: null,
  } as any);
  // A negative window lands settle_at in the past (due now); a positive one is
  // still inside the review window.
  const booked = await db.enterPendingSettlement(claimId, opts.windowMs ?? -60000);
  expect(booked.success, booked.message).toBe(true);
  if (opts.approve !== false) {
    const approved = await db.approveSettlement(claimId, 'B1 fixture admin', `fixture approval ${suffix}`);
    expect(approved.ok, approved.code).toBe(true);
  }
  return { claimId, itemId };
};

const claimState = async (claimId: string) => {
  const claim = await db.getClaim(claimId);
  const ledger = await db.getLedgerEntriesForClaim(claimId);
  return {
    status: claim?.status ?? null,
    approvedAt: claim?.settlement_approved_at ?? null,
    approvedBy: claim?.settlement_approved_by ?? null,
    ledger: ledger
      .filter((l: any) => l.type === 'finder_payout' || l.type === 'agent_payout')
      .map((l: any) => ({ type: l.type, status: l.status, outcome: l.payout_outcome ?? null }))
      .sort((a, b) => a.type.localeCompare(b.type)),
  };
};

/** The two REQUIRED payout legs of a claim, exactly as the executor reads them
 *  (the ledger row, not the recipient, is the unit of submission idempotency). */
const payoutLegs = async (claimId: string) =>
  (await db.getLedgerEntriesForClaim(claimId)).filter(
    (l: any) => l.type === 'finder_payout' || l.type === 'agent_payout',
  );

/**
 * Move an agent's stored payout destination through the SUPPORTED activation
 * flow: a change request, a real phone-verification attestation, an
 * administrator decision, then activation. Nothing here writes `agents`
 * directly — this is the flow an agent and an administrator actually use, and it
 * is what creates genuine destination drift after a claim has been booked.
 */
const activateAgentPayoutDestination = async (
  agentId: string,
  destination: string,
  suffix: string,
) => {
  const id = `B1-APDC-${RUN}-${suffix}`;
  const created = await db.createAgentPayoutDestinationChange({
    id,
    agentId,
    proposedDestination: destination,
    proposedPayoutMethod: 'Personal M-Pesa',
    destinationFormatEligible: true,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  });
  expect(created, 'the payout destination change request was not recorded').toBeTruthy();

  const verified = await db.recordAgentPayoutDestinationPhoneVerification({
    id,
    providerRef: `B1-attestation-${RUN}-${suffix}`,
  });
  expect(verified.ok, verified.code).toBe(true);

  const approved = await db.recordAgentPayoutDestinationAdminDecision({
    id,
    decision: 'approve',
    actor: 'B1 fixture admin',
  });
  expect(approved.ok, approved.code).toBe(true);

  const activated = await db.activateAgentPayoutDestinationChange({
    id,
    actor: 'B1 fixture admin',
  });
  expect(activated.activated, activated.code).toBe(true);
};


// ===========================================================================
// A. WHO IS CALLING: authentication, live session, permissions.
// ===========================================================================
describe('BATCH 1 — only a live, authorized administrator can reach a payout', () => {
  it('refuses an UNAUTHENTICATED request (401) and writes nothing', async () => {
    const { claimId } = await makeClaim('auth-none', { approve: false });
    const before = await claimState(claimId);
    const r = await http(APPROVE_AND_PAY(claimId), { body: { reason: 'x', password: ADMIN_PASSWORD } });
    expect(r.status).toBe(401);
    expect(payout.calls.length).toBe(0);
    expect(await claimState(claimId)).toEqual(before);
  });

  it('refuses an UNVERIFIABLE token (403)', async () => {
    const { claimId } = await makeClaim('auth-bad', { approve: false });
    const r = await http(APPROVE_AND_PAY(claimId), { token: 'not-a-real-jwt', body: { reason: 'x', password: ADMIN_PASSWORD } });
    expect(r.status).toBe(403);
    expect(payout.calls.length).toBe(0);
    expect((await claimState(claimId)).approvedAt).toBeNull();
  });

  it('refuses a valid AGENT session (403) — the permission boundary, not the password', async () => {
    const { claimId } = await makeClaim('auth-agent', { approve: false });
    const r = await http(APPROVE_AND_PAY(claimId), { token: agentToken(), body: { reason: 'x', password: ADMIN_PASSWORD } });
    expect(r.status).toBe(403);
    expect(payout.calls.length).toBe(0);
    expect((await claimState(claimId)).approvedAt).toBeNull();
  });

  it('refuses a REVOKED admin session (401) — token_version is checked live', async () => {
    const { claimId } = await makeClaim('auth-revoked', { approve: false });
    const login = await http('/api/auth/admin-login', {
      body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    });
    revokedAdminToken = String(login.body?.token || '');
    expect(revokedAdminToken).toBeTruthy();
    // The application's OWN revocation mechanism.
    await db.bumpAdminTokenVersion(ADMIN_USERNAME);
    const before = await claimState(claimId);
    const r = await http(APPROVE_AND_PAY(claimId), { token: revokedAdminToken, body: { reason: 'x', password: ADMIN_PASSWORD } });
    expect(r.status).toBe(401);
    expect(payout.calls.length).toBe(0);
    expect(await claimState(claimId)).toEqual(before);

    // Re-establish the primary session against the new token_version so the rest
    // of this suite drives a genuinely current admin session.
    const fresh = await http('/api/auth/admin-login', {
      body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    });
    adminToken = String(fresh.body?.token || '');
    expect(adminToken).toBeTruthy();
  });

  it('refuses a token whose admin account no longer exists (401, before the route is reached)', async () => {
    const { claimId } = await makeClaim('auth-ghost', { approve: false });
    const ghost = generateToken({ id: 'ghost-id', role: 'admin', username: `b1-ghost-${RUN}` } as any);
    const r = await http(APPROVE_AND_PAY(claimId), { token: ghost, body: { reason: 'x', password: ADMIN_PASSWORD } });
    // requireCurrentAdminSession resolves the token's admin account and refuses
    // first, so the route's own `admin_not_found` (404) is unreachable over HTTP
    // and is retained only as defence in depth. What matters is that the request
    // cannot reach the payout path at all.
    expect(r.status).toBe(401);
    expect(payout.calls.length).toBe(0);
    expect((await claimState(claimId)).approvedAt).toBeNull();
  });
});


// ===========================================================================
// B. THE CREDENTIAL: missing, over-long, wrong — and the writes they must not do.
// ===========================================================================
describe('BATCH 1 — a rejected password writes NOTHING', () => {
  it('refuses a missing password (400 password_required)', async () => {
    const { claimId } = await makeClaim('pw-none', { approve: false });
    const r = await http(APPROVE_AND_PAY(claimId), { token: adminToken, body: { reason: 'valid reason' } });
    expect(r.status).toBe(400);
    expect(r.body?.code).toBe('password_required');
    expect((await claimState(claimId)).approvedAt).toBeNull();
    expect(payout.calls.length).toBe(0);
  });

  it('refuses an OVER-LONG password (400 password_too_long) without a bcrypt attempt', async () => {
    const { claimId } = await makeClaim('pw-long', { approve: false });
    const r = await http(APPROVE_AND_PAY(claimId), {
      token: adminToken,
      body: { reason: 'valid reason', password: 'x'.repeat(201) },
    });
    expect(r.status).toBe(400);
    expect(r.body?.code).toBe('password_too_long');
    expect((await claimState(claimId)).approvedAt).toBeNull();
    expect(payout.calls.length).toBe(0);
  });

  it('refuses the WRONG password (401 password_incorrect) and records no approval at all', async () => {
    const { claimId } = await makeClaim('pw-wrong', { approve: false });
    const before = await claimState(claimId);
    const r = await http(APPROVE_AND_PAY(claimId), {
      token: adminToken,
      body: { reason: 'valid reason', password: 'definitely-not-the-password' },
    });
    expect(r.status).toBe(401);
    expect(r.body?.code).toBe('password_incorrect');
    // The approval is reached only AFTER the check, so none of this moved.
    expect(await claimState(claimId)).toEqual(before);
    expect(payout.calls.length).toBe(0);
    expect((await auditsFor(claimId, 'CLAIM_SETTLEMENT_APPROVE_AND_PAY')).length).toBe(0);
    expect((await auditsFor(claimId, 'CLAIM_SETTLEMENT_APPROVED')).length).toBe(0);
  });

  it('refuses a blank reason BEFORE the credential is even read (400 reason_required)', async () => {
    const { claimId } = await makeClaim('reason-blank', { approve: false });
    const r = await http(APPROVE_AND_PAY(claimId), { token: adminToken, body: { reason: '   ', password: ADMIN_PASSWORD } });
    expect(r.status).toBe(400);
    expect(r.body?.code).toBe('reason_required');
    expect((await claimState(claimId)).approvedAt).toBeNull();
    expect(payout.calls.length).toBe(0);
  });
});

// ===========================================================================
// C. ELIGIBILITY: the settle_at window is decided by the database.
// ===========================================================================
describe('BATCH 1 — settlement eligibility is enforced on the combined action', () => {
  it('refuses a claim still inside its settle_at window (409) and writes no approval', async () => {
    const { claimId } = await makeClaim('window-open', { windowMs: 60 * 60 * 1000, approve: false });
    const before = await claimState(claimId);
    const r = await http(APPROVE_AND_PAY(claimId), { token: adminToken, body: { reason: 'too early', password: ADMIN_PASSWORD } });
    expect(r.status).toBe(409);
    expect(r.body?.code).toBe('outside_review_window');
    expect(await claimState(claimId)).toEqual(before);
    expect(payout.calls.length).toBe(0);
  });

  it('refuses a claim that is no longer pending_settlement (409) instead of paying it twice', async () => {
    const { claimId } = await makeClaim('already-released', { approve: false });
    const first = await http(APPROVE_AND_PAY(claimId), { token: adminToken, body: { reason: 'pay it', password: ADMIN_PASSWORD } });
    expect(first.status).toBe(200);
    expect((await claimState(claimId)).status).toBe('released');
    const callsAfterFirst = payout.calls.length;

    const second = await http(APPROVE_AND_PAY(claimId), { token: adminToken, body: { reason: 'pay it again', password: ADMIN_PASSWORD } });
    expect(second.status).toBe(409);
    expect(second.body?.code).toBe('not_pending_settlement');
    // A released claim is never re-approved and never re-submitted.
    expect(payout.calls.length).toBe(callsAfterFirst);
    expect((await claimState(claimId)).approvedBy).toBe(ADMIN_USERNAME);
  });
});


// ===========================================================================
// D. THE HAPPY PATH, ASSERTED END TO END.
// ===========================================================================
describe('BATCH 1 — a combined approval + payout actually does both, exactly once', () => {
  it('records the approval, completes the ledger and releases the claim', async () => {
    const { claimId } = await makeClaim('happy', { approve: false });
    const r = await http(APPROVE_AND_PAY(claimId), {
      token: adminToken,
      body: { reason: 'Customer collected the item and the window elapsed.', password: ADMIN_PASSWORD },
    });

    expect(r.status, `body=${JSON.stringify(r.body)}`).toBe(200);
    expect(r.body?.success).toBe(true);
    expect(r.body?.approval).toBe('recorded');
    expect(r.body?.approved_by).toBe(ADMIN_USERNAME);
    expect(r.body?.approved_at).toBeTruthy();
    // SUBMITTED, never "paid".
    expect(r.body?.payout).toBe('submitted');
    expect(r.body?.destination_changed).toBe(false);

    const state = await claimState(claimId);
    expect(state.status).toBe('released');
    expect(state.approvedAt).toBeTruthy();
    expect(state.approvedBy).toBe(ADMIN_USERNAME);
    expect(state.ledger).toEqual([
      { type: 'agent_payout', status: 'completed', outcome: 'completed' },
      { type: 'finder_payout', status: 'completed', outcome: 'completed' },
    ]);

    // THE AUDIT TRAIL: the approval (written inside the approval transaction), the
    // combined decision, the attempt immediately before the provider call, and the
    // confirmation afterwards.
    expect((await auditsFor(claimId, 'CLAIM_SETTLEMENT_APPROVED')).length).toBe(1);
    const decision = await auditsFor(claimId, 'CLAIM_SETTLEMENT_APPROVE_AND_PAY');
    expect(decision.length).toBe(1);
    // The decision row must NOT claim a submission: it is written before the
    // provider is reached and says so.
    expect(String(decision[0].details)).toContain('No provider request has been made at this point');
    const attempted = await auditsFor(claimId, 'CLAIM_SETTLEMENT_PAYOUT_ATTEMPTED');
    expect(attempted.length).toBe(1);
    // The snapshot is MASKED: it names the ledger rows, the amounts and the claim,
    // never a full phone number.
    expect(String(attempted[0].details)).toContain('claim=' + claimId);
    expect(String(attempted[0].details)).toContain('KES 250');
    expect(String(attempted[0].details)).toContain('***');
    expect(String(attempted[0].details)).not.toContain('+254700000456');
    expect(String(attempted[0].details)).not.toContain(agentPhone);
    expect((await auditsFor(claimId, 'CLAIM_SETTLEMENT_PAYOUT_CONFIRMED')).length).toBe(1);
    expect((await auditsFor(claimId, 'CLAIM_SETTLEMENT_PAYOUT_UNRESOLVED')).length).toBe(0);
    // A simulated payout makes no outbound request at all.
    expect(payout.calls.length).toBe(0);
  });

  it('sends exactly the booked legs to the provider, and never reports an accepted batch as confirmed', async () => {
    useProviderSeam();
    const { claimId } = await makeClaim('happy-provider', { approve: false });
    const r = await http(APPROVE_AND_PAY(claimId), {
      token: adminToken,
      body: { reason: 'Pay through the real provider seam.', password: ADMIN_PASSWORD },
    });

    // ONE request for both legs, carrying the amounts the ledger booked.
    expect(payout.calls.length).toBe(1);
    const sent = payout.calls[0].payload?.transactions ?? [];
    expect(sent.map((t: any) => Number(t.amount)).sort((a: number, b: number) => a - b)).toEqual([100, 150]);
    // BATCH 1.1 — and those amounts are the BOOKED ones, leg for leg, not merely
    // "some" amounts that look plausible. This is the shape the pre-submission
    // integrity check verifies on every attempt.
    const bookedAmounts = (await payoutLegs(claimId))
      .map((r: any) => Number(r.amount))
      .sort((a: number, b: number) => a - b);
    expect(sent.map((t: any) => Number(t.amount)).sort((a: number, b: number) => a - b)).toEqual(bookedAmounts);
    // `account` is the provider's normalised MSISDN (formatMpesaPhone drops the
    // '+'), which is the SAME string the response binding correlates against.
    expect(sent.map((t: any) => String(t.account)).sort()).toEqual(['254700000123', '254700000456']);

    // The provider ACCEPTED the batch, which is not the transfer having completed,
    // so the route must not report success and the claim must not be released.
    expect(r.status).toBe(500);
    expect(r.body?.code).toBe('payout_not_confirmed');
    expect(r.body?.recoverable).toBe(true);
    const state = await claimState(claimId);
    expect(state.status).toBe('pending_settlement');
    expect(state.ledger.map((l: any) => l.outcome)).toEqual(['accepted', 'accepted']);
    expect((await auditsFor(claimId, 'CLAIM_SETTLEMENT_PAYOUT_ATTEMPTED')).length).toBe(1);
    expect((await auditsFor(claimId, 'CLAIM_SETTLEMENT_PAYOUT_UNRESOLVED')).length).toBeGreaterThanOrEqual(1);
    expect((await auditsFor(claimId, 'CLAIM_SETTLEMENT_PAYOUT_CONFIRMED')).length).toBe(0);
  });

  // BATCH 3 — THE PAYOUT MUST BE THE ONE THAT WAS APPROVED.
  //
  // A payout row that did not exist when the approval was recorded changes the
  // set of rows the approval covers. The executor must refuse BEFORE the
  // provider, return the release lock, and record the refusal — never pay the
  // original two legs and leave the third unexplained.
  it('refuses a payout whose ledger rows changed after the approval (approval snapshot)', async () => {
    useProviderSeam();
    const { claimId } = await makeClaim('approval-drift', { approve: false });
    const approval = await db.approveSettlement(claimId, 'B3 drift admin', 'approve before the extra row');
    expect(approval.ok, approval.code).toBe(true);

    // `logTransaction` is the real booker the payment services use; this fixture
    // adds a payout-looking row through it rather than writing the table directly.
    await db.logTransaction({
      claim_id: claimId,
      item_id: null,
      type: 'finder_payout',
      amount: 1,
      phone_or_till: '254700000999',
      status: 'pending',
    });

    const r = await http(INITIATE(claimId), {
      token: adminToken,
      body: { password: ADMIN_PASSWORD },
    });

    expect(r.status).toBe(500);
    expect(r.body?.code).toBe('payout_not_confirmed');
    // Fail-closed BEFORE the provider: nothing was sent and nothing was attempted.
    expect(payout.calls.length).toBe(0);
    expect((await claimState(claimId)).status).toBe('pending_settlement');
    expect((await auditsFor(claimId, 'SETTLEMENT_AUTHORIZATION_MISMATCH')).length).toBe(1);
    expect((await auditsFor(claimId, 'CLAIM_SETTLEMENT_PAYOUT_ATTEMPTED')).length).toBe(0);
  });
});

// ===========================================================================
// E. APPROVAL COMMITTED, PAYOUT REFUSED: a recoverable state, never a success.
// ===========================================================================
describe('BATCH 1 — an approval that commits while the payout is refused is recoverable', () => {
  it('keeps the durable approval, submits nothing, and points at the initiate route', async () => {
    useProviderSeam();
    const { claimId } = await makeClaim('paused', { approve: false });
    // The executor's own gate, flipped through the application's supported setting.
    await db.setSetting('payouts_paused', 'true', 'B1 test');

    const refused = await http(APPROVE_AND_PAY(claimId), { token: adminToken, body: { reason: 'pay it now', password: ADMIN_PASSWORD } });
    // An executor refusal AFTER the release lock was won is reported as
    // `payout_not_confirmed` (500) — this repository's established status for
    // "authorized, but the payout did not complete" on all three money routes.
    // 409 `payout_not_eligible` is reserved for losing the release CAS itself.
    expect(refused.status).toBe(500);
    expect(refused.body?.code).toBe('payout_not_confirmed');
    expect(refused.body?.approval).toBe('recorded');
    expect(refused.body?.recoverable).toBe(true);
    expect(refused.body?.next?.initiate).toContain('/settlement/initiate');

    // The approval IS durable; no money moved and no provider request was made.
    const state = await claimState(claimId);
    expect(state.status).toBe('pending_settlement');
    expect(state.approvedAt).toBeTruthy();
    expect(payout.calls.length).toBe(0);
    // Nothing claims an attempt happened.
    expect((await auditsFor(claimId, 'CLAIM_SETTLEMENT_PAYOUT_ATTEMPTED')).length).toBe(0);

    // RECOVERY: once payouts resume, the retained initiate route pays it — with
    // the operator's password, on the approval that is already on file. Switching
    // to simulation here is deliberate: it is the only way this suite can obtain a
    // CONFIRMED outcome, and the recovery claim is about the route, not the
    // provider's batch semantics (which the previous test covers).
    await db.setSetting('payouts_paused', 'false', 'B1 test');
    useSimulatedPayout();
    const recovered = await http(INITIATE(claimId), { token: adminToken, body: { password: ADMIN_PASSWORD } });
    expect(recovered.status, `body=${JSON.stringify(recovered.body)}`).toBe(200);
    expect(recovered.body?.payout).toBe('submitted');
    expect(payout.calls.length).toBe(0);
    expect((await claimState(claimId)).status).toBe('released');
  });
});


// ===========================================================================
// F. RECOVERY WITHOUT A DUPLICATE SUBMISSION.
// ===========================================================================
describe('BATCH 1 — an approval already on file is reused, not rewritten or re-submitted', () => {
  it('reports already_on_file, preserves the original approver, and pays once', async () => {
    const { claimId } = await makeClaim('pre-approved');
    const r = await http(APPROVE_AND_PAY(claimId), { token: adminToken, body: { reason: 'recover the payout', password: ADMIN_PASSWORD } });
    expect(r.status).toBe(200);
    expect(r.body?.approval).toBe('already_on_file');
    // The approval on file is preserved untouched — this route must never rewrite
    // who approved a claim, or when.
    expect(r.body?.approved_by).toBe('B1 fixture admin');
    const state = await claimState(claimId);
    expect(state.approvedBy).toBe('B1 fixture admin');
    expect(state.status).toBe('released');
    // Exactly one submission attempt for the claim, carrying both legs: the
    // approval on file created no second attempt.
    const attempted = await auditsFor(claimId, 'CLAIM_SETTLEMENT_PAYOUT_ATTEMPTED');
    expect(attempted.length).toBe(1);
    const details = String(attempted[0].details);
    expect(details.match(/row=/g)?.length).toBe(2);
    // The combined decision row still records this operator's own action.
    expect((await auditsFor(claimId, 'CLAIM_SETTLEMENT_APPROVE_AND_PAY')).length).toBe(1);
  });
});

// ===========================================================================
// G. CONCURRENCY: two confirmations, one payout.
// ===========================================================================
describe('BATCH 1 — concurrent combined actions cannot submit the same payout twice', () => {
  it('lets exactly one call win, and never sends a leg twice', async () => {
    const { claimId } = await makeClaim('concurrent', { approve: false });
    const [a, b] = await Promise.all([
      http(APPROVE_AND_PAY(claimId), { token: secondAdminToken, body: { reason: 'concurrent A', password: ADMIN_PASSWORD } }),
      http(APPROVE_AND_PAY(claimId), { token: secondAdminToken, body: { reason: 'concurrent B', password: ADMIN_PASSWORD } }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(200);
    // The loser is refused by one of the two compare-and-swaps (the approval CAS
    // reports already_approved, which this route treats as met, so the release CAS
    // is normally where it loses). Either way it must not be a second success.
    expect(statuses[1]).not.toBe(200);

    const state = await claimState(claimId);
    expect(state.status).toBe('released');
    expect(state.ledger.every((l: any) => l.status === 'completed')).toBe(true);
    // Exactly ONE submission attempt reached the executor, whatever the
    // interleaving: the per-row pre-submission CAS and the release CAS are what
    // guarantee it, and the attempt audit row is its observable proof.
    const attempted = await auditsFor(claimId, 'CLAIM_SETTLEMENT_PAYOUT_ATTEMPTED');
    expect(attempted.length).toBe(1);
    expect(String(attempted[0].details).match(/row=/g)?.length).toBe(2);
    expect(payout.calls.length).toBe(0);
  });
});

// ===========================================================================
// H. AN UNCERTAIN PROVIDER OUTCOME IS NEVER A SUCCESS AND NEVER RESENT.
// ===========================================================================
describe('BATCH 1 — an ambiguous provider result is reported as unresolved', () => {
  it('returns a recoverable failure, records the attempt, and does not resubmit on retry', async () => {
    useProviderSeam();
    const { claimId } = await makeClaim('ambiguous', { approve: false });
    payout.mode = 'network-error';

    const r = await http(APPROVE_AND_PAY(claimId), { token: secondAdminToken, body: { reason: 'pay it', password: ADMIN_PASSWORD } });
    expect(r.status).toBe(500);
    expect(r.body?.code).toBe('payout_not_confirmed');
    expect(r.body?.recoverable).toBe(true);
    expect(r.body?.next?.initiate).toContain('/settlement/initiate');

    // The attempt WAS made (that is why the state is unknown), and it is recorded.
    expect(payout.calls.length).toBe(1);
    expect((await auditsFor(claimId, 'CLAIM_SETTLEMENT_PAYOUT_ATTEMPTED')).length).toBe(1);
    expect((await auditsFor(claimId, 'CLAIM_SETTLEMENT_PAYOUT_UNRESOLVED')).length).toBeGreaterThanOrEqual(1);
    expect((await auditsFor(claimId, 'CLAIM_SETTLEMENT_PAYOUT_CONFIRMED')).length).toBe(0);
    // The claim is returned to pending_settlement, never left in 'releasing'.
    expect((await claimState(claimId)).status).toBe('pending_settlement');

    // A retry must NOT resend a leg whose outcome is unknown.
    payout.mode = 'accept';
    const retry = await http(INITIATE(claimId), { token: secondAdminToken, body: { password: ADMIN_PASSWORD } });
    expect([409, 500]).toContain(retry.status);
    expect(payout.calls.length).toBe(1);
  });
});


// ===========================================================================
// I. THE OTHER TWO MONEY ROUTES RE-AUTHENTICATE AS WELL.
// ===========================================================================
describe('BATCH 1 — the separate initiate endpoint and the legacy release endpoint require the password', () => {
  it('refuses initiate without a password (400) and writes nothing', async () => {
    const { claimId } = await makeClaim('init-no-pw');
    const before = await claimState(claimId);
    const r = await http(INITIATE(claimId), { token: secondAdminToken, body: {} });
    expect(r.status).toBe(400);
    expect(r.body?.code).toBe('password_required');
    expect(await claimState(claimId)).toEqual(before);
    expect(payout.calls.length).toBe(0);
  });

  it('refuses initiate with the WRONG password (401) — the release lock is never taken', async () => {
    const { claimId } = await makeClaim('init-bad-pw');
    const before = await claimState(claimId);
    const r = await http(INITIATE(claimId), { token: secondAdminToken, body: { password: 'wrong-password' } });
    expect(r.status).toBe(401);
    expect(r.body?.code).toBe('password_incorrect');
    expect(await claimState(claimId)).toEqual(before);
    expect(payout.calls.length).toBe(0);
  });

  it('pays through initiate with the CORRECT password, exactly once', async () => {
    const { claimId } = await makeClaim('init-good-pw');
    const r = await http(INITIATE(claimId), { token: adminToken, body: { password: ADMIN_PASSWORD } });
    expect(r.status, `body=${JSON.stringify(r.body)}`).toBe(200);
    expect(r.body?.payout).toBe('submitted');
    // Simulation: a confirmable outcome with no outbound request.
    expect(payout.calls.length).toBe(0);
    expect((await claimState(claimId)).status).toBe('released');
    expect((await auditsFor(claimId, 'CLAIM_SETTLEMENT_PAYOUT_ATTEMPTED')).length).toBe(1);
  });

  it('refuses the LEGACY release route without a password, and pays with it', async () => {
    const { claimId } = await makeClaim('legacy-pw');
    const refused = await http(RELEASE(claimId), { token: secondAdminToken, body: {} });
    expect(refused.status).toBe(400);
    expect(refused.body?.code).toBe('password_required');
    expect(payout.calls.length).toBe(0);
    expect((await claimState(claimId)).status).toBe('pending_settlement');

    const paid = await http(RELEASE(claimId), { token: secondAdminToken, body: { password: ADMIN_PASSWORD } });
    expect(paid.status, `body=${JSON.stringify(paid.body)}`).toBe(200);
    expect(paid.body?.payout).toBe('submitted');
    // Simulation: a confirmable outcome with no outbound request.
    expect(payout.calls.length).toBe(0);
    expect((await claimState(claimId)).status).toBe('released');
    expect((await auditsFor(claimId, 'CLAIM_SETTLEMENT_PAYOUT_ATTEMPTED')).length).toBe(1);
  });

  it('ignores a supplied `approval` field — the approval is persisted state, never request input', async () => {
    const { claimId } = await makeClaim('no-approval-injection', { approve: false, windowMs: 60 * 60 * 1000 });
    const r = await http(INITIATE(claimId), {
      token: secondAdminToken,
      body: { password: ADMIN_PASSWORD, approval: true, approved: true, force: true },
    });
    expect(r.status).toBe(409);
    expect((await claimState(claimId)).approvedAt).toBeNull();
    expect(payout.calls.length).toBe(0);
  });
});

// ===========================================================================
// J. BATCH 1.1 — THE PAYOUT MUST MATCH THE LEDGER BOOKING.
// ===========================================================================
// The executor recomputes amounts from locked shares/category and reads the
// recipients' CURRENTLY stored destinations, while the ledger holds the amounts
// and the destination snapshot taken at handover. These tests prove the
// fail-closed rule that closes that gap: on ANY difference the whole claim
// payout is refused, no provider request is made, no leg is marked submitted,
// the claim returns to pending_settlement, and a later initiation pays once the
// data agrees with the ledger again. Both money paths are covered, because the
// rule lives in the executor they share.
// ===========================================================================
describe('BATCH 1.1 — a payout that does not match its booked ledger row is refused whole', () => {
  it('refuses a legacy item whose category moved after booking, and pays only the booked amounts', async () => {
    useProviderSeam();
    // A category of this test's own: it is edited mid-test, and the shared
    // fixture category must not move under the other tests.
    const legacyCategory = `B1-CAT-LEGACY-${RUN}`;
    const legacyCategoryBody = {
      name_en: `B1 Legacy Category ${RUN}`,
      name_sw: 'Jamii',
      total_fee: TOTAL_FEE,
      finder_share: 100,
      agent_share: 150,
      platform_share: 0,
      is_sensitive_document: false,
    };
    await db.createCategory({ id: legacyCategory, ...legacyCategoryBody } as any);

    // An item reported before shares were locked: the executor has no locked
    // split to honour and falls back to the category's CURRENT shares.
    const { claimId } = await makeClaim('legacy-amount', {
      approve: false,
      categoryId: legacyCategory,
      legacyUnlockedShares: true,
    });

    // Booking captured the split as it stood then: finder 100, agent 150.
    const bookedRows = await payoutLegs(claimId);
    expect(bookedRows.map((r: any) => `${r.type}:${Number(r.amount)}`).sort()).toEqual([
      'agent_payout:150',
      'finder_payout:100',
    ]);

    // The category is edited AFTER the booking — the legacy failure mode.
    await db.updateCategory(legacyCategory, {
      ...legacyCategoryBody,
      finder_share: 120,
      agent_share: 180,
    });

    const refused = await http(APPROVE_AND_PAY(claimId), {
      token: adminToken,
      body: { reason: 'pay the claim', password: ADMIN_PASSWORD },
    });
    // The established executor-refusal contract: 500 payout_not_confirmed,
    // recoverable, pointed at the retained initiate route.
    expect(refused.status).toBe(500);
    expect(refused.body?.code).toBe('payout_not_confirmed');
    expect(refused.body?.recoverable).toBe(true);
    expect(refused.body?.next?.initiate).toContain('/settlement/initiate');

    // NOTHING reached the provider and no leg was marked as submitted.
    expect(payout.calls.length).toBe(0);
    expect(await claimState(claimId)).toEqual({
      status: 'pending_settlement',
      approvedAt: expect.any(String),
      approvedBy: ADMIN_USERNAME,
      ledger: [
        { type: 'agent_payout', status: 'pending', outcome: 'not_submitted' },
        { type: 'finder_payout', status: 'pending', outcome: 'not_submitted' },
      ],
    });
    expect((await auditsFor(claimId, 'CLAIM_SETTLEMENT_PAYOUT_ATTEMPTED')).length).toBe(0);
    expect((await auditsFor(claimId, 'CLAIM_SETTLEMENT_PAYOUT_CONFIRMED')).length).toBe(0);

    // The refusal names each row and BOTH amounts, and says plainly that
    // nothing was submitted.
    const mismatches = await auditsFor(claimId, 'PAYOUT_AMOUNT_MISMATCH');
    expect(mismatches.length).toBe(1);
    const details = String(mismatches[0].details);
    expect(details).toContain('booked for KES 100.00');
    expect(details).toContain('submit KES 120.00');
    expect(details).toContain('booked for KES 150.00');
    expect(details).toContain('submit KES 180.00');
    expect(details).toContain('NOT submitted');
    for (const row of bookedRows) expect(details).toContain(String(row.id));

    // RECOVERY: the refusal is not a dead end. Once the payable split agrees with
    // the booked one again, the SAME claim pays — the ledger rows were never
    // rewritten and never marked completed.
    await db.updateCategory(legacyCategory, { ...legacyCategoryBody });
    useSimulatedPayout();
    const recovered = await http(INITIATE(claimId), { token: adminToken, body: { password: ADMIN_PASSWORD } });
    expect(recovered.status, `body=${JSON.stringify(recovered.body)}`).toBe(200);
    const settled = await claimState(claimId);
    expect(settled.status).toBe('released');
    expect(settled.ledger.every((l: any) => l.status === 'completed')).toBe(true);
    expect((await payoutLegs(claimId)).map((r: any) => Number(r.amount)).sort((a: number, b: number) => a - b))
      .toEqual([100, 150]);
  });

  it('refuses a destination that changed after booking, and pays once it matches the booked row again', async () => {
    useProviderSeam();
    const agentId = `B1-AGENT-DRIFT-${RUN}`;
    const bookedDestination = '254733000111';
    const { claimId } = await makeClaim('dest-drift', {
      approve: false,
      agentId,
      agentDestination: bookedDestination,
    });
    const agentRow: any = (await payoutLegs(claimId)).find((r: any) => r.type === 'agent_payout')!;
    expect(String(agentRow.phone_or_till)).toBe(bookedDestination);

    // The agent activates a NEW destination after the claim was booked. This is
    // the supported flow (verification + admin approval + activation) — no test
    // writes `agents` directly, so this is exactly how real drift happens.
    await activateAgentPayoutDestination(agentId, '254733000222', 'drift');
    expect((await db.getAgent(agentId))!.mpesa_till_or_paybill).toBe('254733000222');

    const refused = await http(APPROVE_AND_PAY(claimId), {
      token: adminToken,
      body: { reason: 'pay the claim', password: ADMIN_PASSWORD },
    });
    expect(refused.status).toBe(500);
    expect(refused.body?.code).toBe('payout_not_confirmed');
    expect(refused.body?.recoverable).toBe(true);
    expect(payout.calls.length).toBe(0);

    const state = await claimState(claimId);
    expect(state.status).toBe('pending_settlement');
    expect(state.ledger).toEqual([
      { type: 'agent_payout', status: 'pending', outcome: 'not_submitted' },
      { type: 'finder_payout', status: 'pending', outcome: 'not_submitted' },
    ]);
    expect((await auditsFor(claimId, 'CLAIM_SETTLEMENT_PAYOUT_ATTEMPTED')).length).toBe(0);

    const drift = await auditsFor(claimId, 'PAYOUT_DESTINATION_MISMATCH');
    expect(drift.length).toBe(1);
    const details = String(drift[0].details);
    expect(details).toContain('agent payout row');
    expect(details).toContain(String(agentRow.id));
    expect(details).toContain('NOT submitted');
    // MASKED only: neither the booked nor the live number is written in full.
    expect(details).not.toContain(bookedDestination);
    expect(details).not.toContain('254733000222');
    expect(details).toContain('***');

    // RECOVERY: moving the recipient back through the same supported flow lets
    // the claim pay. The refusal paused the payout for review; it did not strand
    // it, and no ledger row was rewritten.
    await activateAgentPayoutDestination(agentId, bookedDestination, 'restore');
    useSimulatedPayout();
    const paid = await http(INITIATE(claimId), { token: adminToken, body: { password: ADMIN_PASSWORD } });
    expect(paid.status, `body=${JSON.stringify(paid.body)}`).toBe(200);
    const settled = await claimState(claimId);
    expect(settled.status).toBe('released');
    expect(settled.ledger.every((l: any) => l.status === 'completed')).toBe(true);
  });

  it('applies the same check on the later initiate route, preserving the approval on file', async () => {
    useProviderSeam();
    const agentId = `B1-AGENT-DRIFT2-${RUN}`;
    const { claimId } = await makeClaim('dest-drift-initiate', {
      approve: true,
      agentId,
      agentDestination: '254733000333',
    });
    const before = await claimState(claimId);
    expect(before.approvedAt).toBeTruthy();

    await activateAgentPayoutDestination(agentId, '254733000444', 'drift2');

    const refused = await http(INITIATE(claimId), { token: adminToken, body: { password: ADMIN_PASSWORD } });
    expect(refused.status).toBe(500);
    expect(refused.body?.code).toBe('payout_not_confirmed');
    expect(payout.calls.length).toBe(0);

    const after = await claimState(claimId);
    expect(after.status).toBe('pending_settlement');
    // The durable approval is untouched: only the payout step was refused.
    expect(after.approvedAt).toBe(before.approvedAt);
    expect(after.ledger).toEqual(before.ledger);
    expect((await auditsFor(claimId, 'PAYOUT_DESTINATION_MISMATCH')).length).toBe(1);
    expect((await auditsFor(claimId, 'CLAIM_SETTLEMENT_PAYOUT_ATTEMPTED')).length).toBe(0);
  });
});

// ===========================================================================
// K. GATE 2 — THE DASHBOARD PUBLISHES WHAT THE APPROVAL AUTHORIZED.
// ===========================================================================
// The console can only show an approved total if GET /api/admin/dashboard
// carries it, from the PERSISTED snapshot and from nowhere else. These tests
// drive the real route and compare its payload with the real claim row and the
// real ledger rows, so a view fed by a computed or client-supplied amount would
// fail here even if its rendering looked right.
// ===========================================================================
describe('GATE 2 — the dashboard describes the approval on file', () => {
  const pendingEntryFor = async (claimId: string) => {
    const dashboard = await http('/api/admin/dashboard', { token: adminToken });
    expect(dashboard.status).toBe(200);
    const entry = (dashboard.body?.pendingSettlements ?? []).find(
      (candidate: any) => candidate.claimId === claimId,
    );
    expect(entry, `claim ${claimId} was not in pendingSettlements`).toBeTruthy();
    return entry;
  };

  it('publishes the PERSISTED approved total and the covered ledger rows', async () => {
    const { claimId } = await makeClaim('approval-visible');
    const claim = await db.getClaim(claimId);
    const payoutRows = await payoutLegs(claimId);

    const entry = await pendingEntryFor(claimId);

    expect(entry.hasSettlementApproval).toBe(true);
    expect(entry.settlementApproval.state).toBe('authorized');
    // The stored snapshot, formatted — not a figure the payload recalculated.
    expect(claim!.settlement_authorized_total).toBe('250.00');
    expect(entry.settlementApproval.authorizedTotal).toBe(claim!.settlement_authorized_total);
    expect(entry.settlementApproval.ledgerRows.map((row: any) => row.ledgerEntryId).sort()).toEqual(
      payoutRows.map((row: any) => row.id).sort(),
    );
    for (const row of entry.settlementApproval.ledgerRows) {
      const booked = payoutRows.find((ledgerRow: any) => ledgerRow.id === row.ledgerEntryId);
      expect(booked, `covered row ${row.ledgerEntryId} is not a payout leg`).toBeTruthy();
      expect(row.bookedAmount).toBe(Number(booked!.amount).toFixed(2));
      expect(row.ledgerRowFound).toBe(true);
      expect(row.ledgerRowRoleMatches).toBe(true);
    }
    expect(entry.settlementApproval.bookedRowsAgreeWithApproval).toBe(true);
    // The claim fee and the platform share are separate persisted figures.
    expect(entry.lockedTotalFee).toBe(250);
    expect(entry.platformFee).toBe('0.00');
    // The approval rows carry no recipient destination.
    expect(JSON.stringify(entry.settlementApproval)).not.toContain('+2547');
  });

  it('reports an unapproved claim explicitly, with no total and no rows', async () => {
    const { claimId } = await makeClaim('approval-not-yet', { approve: false });

    const entry = await pendingEntryFor(claimId);

    expect(entry.hasSettlementApproval).toBe(false);
    expect(entry.settlementApproval.state).toBe('not_approved');
    expect(entry.settlementApproval.authorizedTotal).toBeNull();
    expect(entry.settlementApproval.ledgerRows).toEqual([]);
    // The claim fee is still published as the claim fee — never as an approval.
    expect(entry.lockedTotalFee).toBe(250);
  });
});
