import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { db } from '../db/database';
import { generateToken } from '../services/auth';
import { registerAdminDisputeRoutes } from '../routes/adminDisputes';
import { toAdminSafeDisputeView } from '../services/adminSafeViews';
import { ensureTestCategory, testRunId } from '../db/__tests__/ensureTestCategory';

// Phase 5B coverage for the dispute workflow.
//
// The dispute routes now live in routes/adminDisputes.ts, so these tests mount
// a REAL Express app around the REAL handlers, the REAL authenticateJWT
// middleware and the REAL DB layer (in-memory mock when DATABASE_URL is not
// configured) and drive them over real HTTP. That is the layer where the
// original defect lived: the console sent `winningClaimId: undefined` because
// it read two field names the API never returned, and every attempt ended as a
// 500 with no way for the administrator to succeed.
//
// Delivery note: `requireCurrentAdminSession` is defined inside server.ts (a
// module that boots the application on import), so the test supplies a
// pass-through stand-in. That is faithful to the real middleware's behaviour
// for non-admin tokens (it calls next() and lets each route's own
// `role !== 'admin'` check reject), so the 401/403 assertions below are real
// HTTP assertions against the real `authenticateJWT` and the real route guard.
// The middleware's own `is_active` / `token_version` revalidation cannot be
// exercised without mutating a real admin account and is covered by the
// existing route-audit tests plus runtime smoke checks.

const RUN = testRunId;
let counter = 0;
const nextId = (prefix: string) => `${prefix}-${RUN}-${counter++}`;

const ADMIN_USER = `test-admin-${RUN}`;
const ADMIN_ID = `ADM-TEST-${RUN}`;

let server: any;
let baseUrl = '';
let adminToken = '';
let ownerToken = '';

async function makeItem() {
  const id = nextId('TEST-P5B-ITEM');
  await ensureTestCategory('national-id');
  await db.createItem({
    id,
    category_id: 'national-id',
    photo_url: 'test-photo.jpg',
    ocr_extracted_number: null,
    ocr_extracted_name: null,
    document_number_hash: null,
    document_name_fuzzy: null,
    location_description: 'Test location',
    latitude: null,
    longitude: null,
    finder_phone: '+254700000001',
    assigned_agent_id: null,
    status: 'at_agent',
    flaggedForReview: false,
    isDescriptionOnly: false,
    description: null,
    is_sensitive_document: true,
    rejection_reason: null,
  } as any);
  return id;
}

// Both fixture claims are UNPAID (payment_reference: null): resolveDispute
// then takes its "loser is simply rejected" branch, so these tests never
// reach a payment-provider call. The paid-loser / refund branch is covered by
// the existing refundStateMachine and refundOutcome suites.
async function makeClaim(itemId: string, suffix: string) {
  const claimId = nextId(`TEST-P5B-CLAIM-${suffix}`);
  await db.createClaim({
    id: claimId,
    item_id: itemId,
    owner_phone: `+2547000${String(counter).padStart(5, '0')}`,
    security_answers: { lastDigits: '0000', fullName: 'Test Claimant' },
    verification_tier: 1,
    status: 'disputed',
    owner_id_proof_url: null,
    payment_reference: null,
    owner_identifying_details: null,
  } as any);
  return claimId;
}

async function makeDispute(opts: { resolved?: boolean } = {}) {
  const itemId = await makeItem();
  const claimA = await makeClaim(itemId, 'A');
  const claimB = await makeClaim(itemId, 'B');
  const disputeId = nextId('TEST-P5B-DSP');
  await db.createDispute({
    id: disputeId,
    item_id: itemId,
    claimant_1_claim_id: claimA,
    claimant_2_claim_id: claimB,
    claimant_1_id_proof_url: 'secret-proof-a.png',
    claimant_2_id_proof_url: 'secret-proof-b.png',
    resolved_by: null,
    resolved_claim_id: null,
    resolved_at: null,
    admin_notes: null,
  } as any);
  return { disputeId, itemId, claimA, claimB };
}

async function api(method: string, path: string, token?: string, body?: any) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(baseUrl + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, text, json };
}

async function auditEntries(action: string, needle: string) {
  const logs = await db.getAuditLogs();
  return logs.filter((l) => l.action === action && l.details.includes(needle));
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerAdminDisputeRoutes(app, {
    requireCurrentAdminSession: (_req: any, _res: any, next: any) => next(),
    // server.ts's sendServerError, non-production branch.
    sendServerError: (res: any, error: any, _context: string) =>
      res.status(500).json({ error: error?.message || String(error) }),
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  adminToken = generateToken({ userId: ADMIN_ID, phone: '+254700000000', role: 'admin', username: ADMIN_USER } as any, '1h');
  ownerToken = generateToken({ userId: 'TEST-OWNER', phone: '+254700000009', role: 'owner' } as any, '1h');
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// DTO: claimant semantics + sensitive-evidence absence
// ---------------------------------------------------------------------------
describe('dispute DTO contract (N1) and privacy (D9)', () => {
  it('returns both claimants with explicit roles: claimant 1 = original, claimant 2 = contesting', async () => {
    const { disputeId, claimA, claimB } = await makeDispute();
    const raw = await db.getDispute(disputeId);
    const claims = await db.getClaims();
    const view = toAdminSafeDisputeView(raw, new Map(claims.map((c: any) => [c.id, c])));

    expect(view.claimants.map((c: any) => c.role)).toEqual(['original', 'contesting']);
    expect(view.claimants[0].claim_id).toBe(claimA);
    expect(view.claimants[1].claim_id).toBe(claimB);
    // Real claimant identity, taken from the claim rows — never fabricated.
    expect(view.claimants[0].owner_phone).toMatch(/^\+254\d+$/);
    expect(view.claimants[1].owner_phone).toMatch(/^\+254\d+$/);
    expect(view.claimants[0].owner_phone).not.toBe(view.claimants[1].owner_phone);
    expect(view.claimants[0].claim_status).toBe('disputed');
    expect(view.claimants[0].has_paid_escrow).toBe(false);
  });

  it('strips the sensitive dispute fields the raw row actually carries', async () => {
    const { disputeId } = await makeDispute();
    const raw = await db.getDispute(disputeId);

    // The source row genuinely carries the claimant ID-proof URLs...
    const rawJson = JSON.stringify(raw);
    expect(rawJson).toContain('claimant_1_id_proof_url');
    expect(rawJson).toContain('claimant_2_id_proof_url');

    // ...and, when internal notes are present on the dispute, they must be
    // stripped too (the fixture's notes are null, so add an explicit sentinel
    // here rather than asserting on an absent key).
    const withNotes = { ...raw, admin_notes: 'INTERNAL-NOTE-SENTINEL' } as any;
    const view = toAdminSafeDisputeView(withNotes, new Map());

    const json = JSON.stringify(view);
    for (const forbidden of ['claimant_1_id_proof_url', 'claimant_2_id_proof_url', 'admin_notes']) {
      expect(json).not.toContain(forbidden);
      expect(Object.keys(view)).not.toContain(forbidden);
    }
    expect(json).not.toContain('INTERNAL-NOTE-SENTINEL');
    expect(json).not.toContain('secret-proof');
    // The old flat claim-id fields were replaced by the explicit claimants array.
    expect('claimant_1_claim_id' in view).toBe(false);
    expect('claimant_2_claim_id' in view).toBe(false);
    // No claim-internal secrecy leaks in via the claimant summary either.
    for (const forbidden of ['security_answers', 'owner_id_proof_url', 'owner_identifying_details', 'owner_email', 'payment_reference']) {
      expect(json).not.toContain(forbidden);
    }
  });

  it('degrades honestly to empty claimant ids when the dispute row has no claim ids', () => {
    const view = toAdminSafeDisputeView(
      { id: 'DSP-X', item_id: 'ITM-X', claimant_1_claim_id: null, claimant_2_claim_id: undefined, created_at: null },
      new Map()
    );
    expect(view.claimants).toHaveLength(2);
    expect(view.claimants[0].claim_id).toBe('');
    expect(view.claimants[1].claim_id).toBe('');
    expect(view.claimants[0].owner_phone).toBeNull();
    expect(view.claimants[0].claim_status).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Evidence endpoint over real HTTP
// ---------------------------------------------------------------------------
describe('GET /api/admin/disputes/:disputeId/evidence (HTTP)', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const { disputeId } = await makeDispute();
    const res = await api('GET', `/api/admin/disputes/${disputeId}/evidence`);
    expect(res.status).toBe(401);
  });

  it('rejects a legitimate non-admin (owner) token with 403', async () => {
    const { disputeId } = await makeDispute();
    const res = await api('GET', `/api/admin/disputes/${disputeId}/evidence`, ownerToken);
    expect(res.status).toBe(403);
  });

  it('returns 404 for a dispute that does not exist (not an empty evidence list)', async () => {
    const res = await api('GET', '/api/admin/disputes/NOPE-DISPUTE/evidence', adminToken);
    expect(res.status).toBe(404);
    expect(res.json?.error).toBeTruthy();
  });

  it('returns an empty evidence list for a real dispute with no submissions', async () => {
    const { disputeId } = await makeDispute();
    const res = await api('GET', `/api/admin/disputes/${disputeId}/evidence`, adminToken);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ success: true, evidence: [] });
  });

  it("returns each claimant's evidence with the real claim_id, and only through this endpoint", async () => {
    const { disputeId, claimA, claimB } = await makeDispute();
    await db.createDisputeEvidence({
      id: nextId('TEST-P5B-EV-A'), dispute_id: disputeId, claim_id: claimA,
      submitted_by_phone: '+254700000021', evidence_text: 'Evidence text from claimant A',
      evidence_photo_url: null,
    } as any);
    await db.createDisputeEvidence({
      id: nextId('TEST-P5B-EV-B'), dispute_id: disputeId, claim_id: claimB,
      submitted_by_phone: '+254700000022', evidence_text: 'Evidence text from claimant B',
      evidence_photo_url: null,
    } as any);

    const res = await api('GET', `/api/admin/disputes/${disputeId}/evidence`, adminToken);
    expect(res.status).toBe(200);
    expect(res.json.evidence).toHaveLength(2);
    const byClaim = new Map<string, any>(res.json.evidence.map((e: any) => [e.claim_id, e]));
    expect(byClaim.get(claimA)?.evidence_text).toBe('Evidence text from claimant A');
    expect(byClaim.get(claimB)?.evidence_text).toBe('Evidence text from claimant B');

    // ...and none of that evidence text rides along in the bulk dispute DTO.
    const raw = await db.getDispute(disputeId);
    const bulk = JSON.stringify(toAdminSafeDisputeView(raw, new Map()));
    expect(bulk).not.toContain('Evidence text from claimant A');
    expect(bulk).not.toContain('Evidence text from claimant B');
  });
});

// ---------------------------------------------------------------------------
// Resolution endpoint over real HTTP
// ---------------------------------------------------------------------------
describe('POST /api/admin/disputes/resolve (HTTP)', () => {
  it('rejects unauthenticated and non-admin callers before any state is touched', async () => {
    const { disputeId, claimA } = await makeDispute();
    const anon = await api('POST', '/api/admin/disputes/resolve', undefined, { disputeId, winningClaimId: claimA });
    expect(anon.status).toBe(401);
    const owner = await api('POST', '/api/admin/disputes/resolve', ownerToken, { disputeId, winningClaimId: claimA });
    expect(owner.status).toBe(403);

    const raw = await db.getDispute(disputeId);
    expect(raw!.resolved_at).toBeNull();
    expect(await auditEntries('RESOLVE_DISPUTE', disputeId)).toHaveLength(0);
  });

  it('resolves in favour of claimant A (the original claim) and records the acting administrator', async () => {
    const { disputeId, claimA, claimB } = await makeDispute();
    const res = await api('POST', '/api/admin/disputes/resolve', adminToken, {
      disputeId,
      winningClaimId: claimA,
      adminNotes: 'Test resolution — claimant A',
    });
    expect(res.status).toBe(200);
    expect(res.json?.success).toBe(true);

    const dispute = await db.getDispute(disputeId);
    expect(dispute!.resolved_claim_id).toBe(claimA);
    expect(dispute!.resolved_at).toBeTruthy();
    expect(dispute!.admin_notes).toBe('Test resolution — claimant A');
    // Winner returns to the normal verification path (neither claim had paid);
    // loser is rejected rather than left active.
    expect((await db.getClaim(claimA))!.status).toBe('pending_verification');
    expect((await db.getClaim(claimB))!.status).toBe('rejected');

    const audits = await auditEntries('RESOLVE_DISPUTE', disputeId);
    expect(audits).toHaveLength(1);
    expect(audits[0].admin_user).toBe(ADMIN_USER);
    expect(audits[0].details).toContain(claimA);
  });

  it('resolves in favour of claimant B (the contesting claim) — symmetric lifecycle', async () => {
    const { disputeId, claimA, claimB } = await makeDispute();
    const res = await api('POST', '/api/admin/disputes/resolve', adminToken, {
      disputeId,
      winningClaimId: claimB,
      adminNotes: 'Test resolution — claimant B',
    });
    expect(res.status).toBe(200);

    const dispute = await db.getDispute(disputeId);
    expect(dispute!.resolved_claim_id).toBe(claimB);
    expect((await db.getClaim(claimA))!.status).toBe('rejected');
    expect((await db.getClaim(claimB))!.status).toBe('pending_verification');

    const audits = await auditEntries('RESOLVE_DISPUTE', disputeId);
    expect(audits).toHaveLength(1);
    expect(audits[0].admin_user).toBe(ADMIN_USER);
    expect(audits[0].details).toContain(claimB);
  });

  it('rejects a missing / empty / non-string winningClaimId with 400 and mutates nothing', async () => {
    const { disputeId, claimA, claimB } = await makeDispute();

    for (const bad of [undefined, null, '', '   ', 12345, { id: claimA }, [claimA]]) {
      const res = await api('POST', '/api/admin/disputes/resolve', adminToken, {
        disputeId,
        winningClaimId: bad,
        adminNotes: 'should never be applied',
      });
      expect(res.status, `body=${JSON.stringify(bad)}`).toBe(400);
    }

    const dispute = await db.getDispute(disputeId);
    // `?? null` normalises the in-memory mock's absent-vs-null difference; real
    // Postgres stores an explicit NULL here.
    expect(dispute!.resolved_at ?? null).toBeNull();
    expect(dispute!.resolved_claim_id ?? null).toBeNull();
    expect(dispute!.admin_notes ?? null).toBeNull();
    expect((await db.getClaim(claimA))!.status).toBe('disputed');
    expect((await db.getClaim(claimB))!.status).toBe('disputed');
    expect(await auditEntries('RESOLVE_DISPUTE', disputeId)).toHaveLength(0);
    expect(await auditEntries('RESOLVE_DISPUTE', 'should never be applied')).toHaveLength(0);
  });

  it('rejects a claim that does not belong to this dispute with 400 and mutates nothing', async () => {
    const { disputeId, claimA, claimB } = await makeDispute();
    const other = await makeDispute();

    const res = await api('POST', '/api/admin/disputes/resolve', adminToken, {
      disputeId,
      winningClaimId: other.claimA,
      adminNotes: 'cross-dispute attempt',
    });
    expect(res.status).toBe(400);

    // Neither dispute was touched.
    expect((await db.getDispute(disputeId))!.resolved_at).toBeNull();
    expect((await db.getDispute(other.disputeId))!.resolved_at).toBeNull();
    expect((await db.getClaim(claimA))!.status).toBe('disputed');
    expect((await db.getClaim(claimB))!.status).toBe('disputed');
    expect((await db.getClaim(other.claimA))!.status).toBe('disputed');
    expect(await auditEntries('RESOLVE_DISPUTE', disputeId)).toHaveLength(0);
  });

  it('returns 404 for a dispute that does not exist, with no audit entry', async () => {
    const res = await api('POST', '/api/admin/disputes/resolve', adminToken, {
      disputeId: 'NOPE-DISPUTE',
      winningClaimId: 'NOPE-CLAIM',
    });
    expect(res.status).toBe(404);
    expect(await auditEntries('RESOLVE_DISPUTE', 'NOPE-DISPUTE')).toHaveLength(0);
  });

  it('returns 400 when disputeId itself is missing', async () => {
    const res = await api('POST', '/api/admin/disputes/resolve', adminToken, { winningClaimId: 'CLM-1' });
    expect(res.status).toBe(400);
  });

  it('refuses to resolve an already-resolved dispute (409) and writes no second audit entry', async () => {
    const { disputeId, claimA, claimB } = await makeDispute();
    const first = await api('POST', '/api/admin/disputes/resolve', adminToken, {
      disputeId, winningClaimId: claimA, adminNotes: 'first',
    });
    expect(first.status).toBe(200);

    const second = await api('POST', '/api/admin/disputes/resolve', adminToken, {
      disputeId, winningClaimId: claimB, adminNotes: 'second',
    });
    expect(second.status).toBe(409);

    const dispute = await db.getDispute(disputeId);
    expect(dispute!.resolved_claim_id).toBe(claimA);
    expect(dispute!.admin_notes).toBe('first');
    expect(await auditEntries('RESOLVE_DISPUTE', disputeId)).toHaveLength(1);
  });
});
