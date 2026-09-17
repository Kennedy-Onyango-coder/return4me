import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { db } from '../db/database';
import { generateToken } from '../services/auth';
import { registerAdminClaimRoutes } from '../routes/adminClaims';
import { ensureTestCategory, testRunId } from '../db/__tests__/ensureTestCategory';

// =============================================================================
// PHASE 6E — CLAIMS ADMINISTRATION ENDPOINTS
// =============================================================================
// Real Express + REAL authenticateJWT + the REAL route handlers, over real HTTP.
// Two servers are mounted from the SAME module:
//   appAllow — the real permission guard (production shape)
//   appDeny  — a guard that always denies, so the genuine 403 branch of the real
//              routes is exercised without inventing a second auth mechanism.
// `requireCurrentAdminSession` is a pass-through stand-in (as in
// disputeWorkflow.test.ts) because it is defined inside server.ts, which boots
// the app on import. Its own behaviour is covered by
// adminSessionRevocation.test.ts.
const RUN = testRunId;
const ADMIN_USER = `test-claims-admin-${RUN}`;
const ADMIN_ID = `ADM-6E-${RUN}`;

let counter = 0;

let serverAllow: any;
let serverDeny: any;
let baseAllow = '';
let baseDeny = '';
let adminToken = '';
let ownerToken = '';
let pending2faToken = '';

async function makeItem(suffix: string) {
  const itemId = `TEST-ITEM-6E-${suffix}-${RUN}-${counter++}`;
  await ensureTestCategory('phone');
  await db.createItem({
    id: itemId, category_id: 'phone', photo_url: 'test-photo.jpg', ocr_extracted_number: null,
    ocr_extracted_name: null, document_number_hash: null, document_name_fuzzy: 'Fuzzy',
    location_description: 'Location', latitude: null, longitude: null,
    finder_phone: '+254700000041', assigned_agent_id: null, status: 'at_agent',
    flaggedForReview: false, isDescriptionOnly: false, description: 'desc',
    is_sensitive_document: false, rejection_reason: null, locked_total_fee: '500',
  } as any);
  return itemId;
}

async function makeClaim(itemId: string, suffix: string, status: string, opts: { phone?: string } = {}) {
  const claimId = `TEST-CLAIM-6E-${suffix}-${RUN}-${counter++}`;
  await db.createClaim({
    id: claimId, item_id: itemId,
    owner_phone: opts.phone ?? `+2547001${String(counter).padStart(5, '0')}`,
    security_answers: { lastDigits: '4321', color: 'black', lostDetails: 'SECRET-ANSWER-6E' },
    verification_tier: 2, status: status as any,
    owner_id_proof_url: 'SECRET-ID-PROOF-KEY-6E', payment_reference: null,
    owner_identifying_details: 'SECRET-IDENTIFYING-6E',
  } as any);
  return claimId;
}

async function makePaidClaim(itemId: string, suffix: string) {
  const claimId = await makeClaim(itemId, suffix, 'pending_payment');
  await db.attemptClaimEscrowHold(claimId, `MPESA-6E-${suffix}`);
  return claimId;
}

async function api(base: string, method: string, path: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { method, headers });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, text, json };
}


beforeAll(async () => {
  // server.ts's sendServerError, non-production branch.
  const sendServerError = (res: any, error: any, _context: string) =>
    res.status(500).json({ error: error?.message || String(error) });
  const passSession = (_req: any, _res: any, next: any) => next();

  const appAllow = express();
  appAllow.use(express.json());
  registerAdminClaimRoutes(appAllow, {
    requireCurrentAdminSession: passSession,
    sendServerError,
  });
  await new Promise<void>((resolve) => { serverAllow = appAllow.listen(0, '127.0.0.1', () => resolve()); });
  baseAllow = `http://127.0.0.1:${serverAllow.address().port}`;

  const appDeny = express();
  appDeny.use(express.json());
  registerAdminClaimRoutes(appDeny, {
    requireCurrentAdminSession: passSession,
    sendServerError,
    requireAdminPermission: () => (_req: any, res: any) =>
      res.status(403).json({ error: 'Ruhusa imekataliwa.' }),
  });
  await new Promise<void>((resolve) => { serverDeny = appDeny.listen(0, '127.0.0.1', () => resolve()); });
  baseDeny = `http://127.0.0.1:${serverDeny.address().port}`;

  adminToken = generateToken({ userId: ADMIN_ID, phone: '+254700000000', role: 'admin', username: ADMIN_USER } as any, '1h');
  ownerToken = generateToken({ userId: 'TEST-OWNER-6E', phone: '+254700000009', role: 'owner' } as any, '1h');
  pending2faToken = generateToken({ userId: ADMIN_ID, phone: '+254700000000', role: 'admin_pending_2fa', username: ADMIN_USER } as any, '5m');
});

afterAll(async () => {
  await new Promise<void>((resolve) => serverAllow.close(() => resolve()));
  await new Promise<void>((resolve) => serverDeny.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// AUTHENTICATION
// ---------------------------------------------------------------------------
describe('6E authentication', () => {
  it('1. no Authorization header -> 401', async () => {
    expect((await api(baseAllow, 'GET', '/api/admin/claims')).status).toBe(401);
    expect((await api(baseAllow, 'GET', '/api/admin/claims/SOME-CLAIM')).status).toBe(401);
  });

  it('2. a present-but-invalid token is rejected (repository convention: 403)', async () => {
    // authenticateJWT returns 401 only for a MISSING header; a token that exists
    // but fails verification (tampered/expired) is 403 in this repository. 6E
    // does not change that convention and does not add a second auth path.
    expect((await api(baseAllow, 'GET', '/api/admin/claims', `${adminToken}x`)).status).toBe(403);
    expect((await api(baseAllow, 'GET', '/api/admin/claims', 'not-a-jwt')).status).toBe(403);
  });

  it('3. an admin_pending_2fa token is rejected', async () => {
    expect((await api(baseAllow, 'GET', '/api/admin/claims', pending2faToken)).status).toBe(403);
    expect((await api(baseAllow, 'GET', '/api/admin/claims/SOME-CLAIM', pending2faToken)).status).toBe(403);
  });

  it('4. a valid admin token is allowed', async () => {
    expect((await api(baseAllow, 'GET', '/api/admin/claims?limit=1', adminToken)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// AUTHORIZATION
// ---------------------------------------------------------------------------
describe('6E authorization', () => {
  it('5. an authenticated non-admin (owner) is refused with 403', async () => {
    expect((await api(baseAllow, 'GET', '/api/admin/claims', ownerToken)).status).toBe(403);
    expect((await api(baseAllow, 'GET', '/api/admin/claims/SOME-CLAIM', ownerToken)).status).toBe(403);
  });

  it('5b. a denied claims permission yields the real 403 from the real route', async () => {
    const list = await api(baseDeny, 'GET', '/api/admin/claims', adminToken);
    expect(list.status).toBe(403);
    expect(list.json).toEqual({ error: 'Ruhusa imekataliwa.' });

    const detail = await api(baseDeny, 'GET', '/api/admin/claims/SOME-CLAIM', adminToken);
    expect(detail.status).toBe(403);
    // An authorization failure must not reveal whether the claim exists.
    expect(detail.json).toEqual({ error: 'Ruhusa imekataliwa.' });
  });

  it('6. an authorized admin is allowed on list and detail', async () => {
    const itemId = await makeItem('AUTHZ');
    const claimId = await makeClaim(itemId, 'AUTHZ', 'pending_verification');
    expect((await api(baseAllow, 'GET', '/api/admin/claims', adminToken)).status).toBe(200);
    expect((await api(baseAllow, 'GET', `/api/admin/claims/${claimId}`, adminToken)).status).toBe(200);
  });

  it('7. Phase 6E registered NO mutation route (read permission cannot mutate)', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await api(baseAllow, method, '/api/admin/claims', adminToken);
      expect(res.status, `${method} must not be routed`).toBe(404);
    }
    const detailMutation = await api(baseAllow, 'POST', '/api/admin/claims/SOME-CLAIM', adminToken);
    expect(detailMutation.status).toBe(404);
  });

// ---------------------------------------------------------------------------
// LIST ENDPOINT
// ---------------------------------------------------------------------------
describe('6E GET /api/admin/claims', () => {
  it('8. returns the safe DTO envelope with pagination metadata', async () => {
    const res = await api(baseAllow, 'GET', '/api/admin/claims?limit=5&offset=0', adminToken);
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(Array.isArray(res.json.data)).toBe(true);
    expect(res.json.pagination).toEqual({ limit: 5, offset: 0, hasMore: expect.any(Boolean) });
    if (res.json.data.length > 0) {
      expect(Object.keys(res.json.data[0])).toContain('has_paid');
      expect(res.json.data[0].owner_phone).toBeUndefined();
    }
  });

  it('9. pagination is enforced and echoed', async () => {
    const res = await api(baseAllow, 'GET', '/api/admin/claims?limit=1&offset=0', adminToken);
    expect(res.status).toBe(200);
    expect(res.json.data.length).toBeLessThanOrEqual(1);
    expect(res.json.pagination.limit).toBe(1);
  });

  it('10. limit above the cap is rejected with 400 (never silently clamped)', async () => {
    expect((await api(baseAllow, 'GET', '/api/admin/claims?limit=100000', adminToken)).status).toBe(400);
  });

  it('11. negative offset/limit is rejected', async () => {
    expect((await api(baseAllow, 'GET', '/api/admin/claims?offset=-1', adminToken)).status).toBe(400);
    expect((await api(baseAllow, 'GET', '/api/admin/claims?limit=-5', adminToken)).status).toBe(400);
  });

  it('12. malformed numeric input is rejected, never coerced to zero', async () => {
    for (const bad of ['abc', '1.5', '1e3', 'NaN', 'Infinity', '-0', '0x10', '+1', ' ']) {
      const res = await api(baseAllow, 'GET', `/api/admin/claims?limit=${encodeURIComponent(bad)}`, adminToken);
      expect(res.status, `limit=${JSON.stringify(bad)}`).toBe(400);
      const off = await api(baseAllow, 'GET', `/api/admin/claims?offset=${encodeURIComponent(bad)}`, adminToken);
      expect(off.status, `offset=${JSON.stringify(bad)}`).toBe(400);
    }
    // limit=0 is a valid integer but below the minimum.
    expect((await api(baseAllow, 'GET', '/api/admin/claims?limit=0', adminToken)).status).toBe(400);
  });

  it('13. status filter is validated and applied', async () => {
    expect((await api(baseAllow, 'GET', '/api/admin/claims?status=not_a_status', adminToken)).status).toBe(400);

    const itemId = await makeItem('FSTATUS');
    const claimId = await makeClaim(itemId, 'FSTATUS', 'rejected');
    const hit = await api(baseAllow, 'GET', `/api/admin/claims?itemId=${itemId}&status=rejected`, adminToken);
    expect(hit.status).toBe(200);
    expect(hit.json.data.map((c: any) => c.id)).toContain(claimId);

    const miss = await api(baseAllow, 'GET', `/api/admin/claims?itemId=${itemId}&status=released`, adminToken);
    expect(miss.json.data).toEqual([]);
  });
});


describe('6E list filters (continued)', () => {
  it('14. the payment filter uses paid_at only', async () => {
    const paidItem = await makeItem('FPAID');
    const paidClaim = await makePaidClaim(paidItem, 'FPAID');
    const refItem = await makeItem('FREFONLY');
    const refClaim = await makeClaim(refItem, 'FREFONLY', 'pending_payment');
    // Provider reference with NO payment — must never count as paid.
    await db.updateClaimStatus(refClaim, 'pending_payment', 'CHECKOUT-6E');

    const paid = await api(baseAllow, 'GET', `/api/admin/claims?itemId=${paidItem}&hasPaid=true`, adminToken);
    expect(paid.json.data.map((c: any) => c.id)).toEqual([paidClaim]);

    const unpaid = await api(baseAllow, 'GET', `/api/admin/claims?itemId=${refItem}&hasPaid=false`, adminToken);
    expect(unpaid.json.data.map((c: any) => c.id)).toEqual([refClaim]);
    expect(unpaid.json.data[0].has_paid).toBe(false);

    // ...and the reference-only claim is NOT returned as paid.
    const cross = await api(baseAllow, 'GET', `/api/admin/claims?itemId=${refItem}&hasPaid=true`, adminToken);
    expect(cross.json.data).toEqual([]);

    expect((await api(baseAllow, 'GET', '/api/admin/claims?hasPaid=yes', adminToken)).status).toBe(400);
  });

  it('15. dispute filter works (open / none / malformed)', async () => {
    const itemId = await makeItem('FDSP');
    const a = await makeClaim(itemId, 'FDSP-A', 'disputed');
    const b = await makeClaim(itemId, 'FDSP-B', 'disputed');
    await db.createDispute({
      id: `TEST-DSP-6E-${RUN}`, item_id: itemId,
      claimant_1_claim_id: a, claimant_2_claim_id: b,
      claimant_1_id_proof_url: 'p1', claimant_2_id_proof_url: 'p2',
      resolved_by: null, resolved_claim_id: null, resolved_at: null, admin_notes: null,
    } as any);

    const open = await api(baseAllow, 'GET', `/api/admin/claims?itemId=${itemId}&disputeState=open`, adminToken);
    expect(open.json.data.map((c: any) => c.id).sort()).toEqual([a, b].sort());
    expect(open.json.data[0].dispute.state).toBe('open');

    const none = await api(baseAllow, 'GET', `/api/admin/claims?itemId=${itemId}&disputeState=none`, adminToken);
    expect(none.json.data).toEqual([]);

    expect((await api(baseAllow, 'GET', '/api/admin/claims?disputeState=maybe', adminToken)).status).toBe(400);
  });

  it('16. date filters are validated', async () => {
    expect((await api(baseAllow, 'GET', '/api/admin/claims?createdFrom=not-a-date', adminToken)).status).toBe(400);
    expect((await api(baseAllow, 'GET', '/api/admin/claims?createdTo=2026-13-45', adminToken)).status).toBe(400);
    const ok = await api(baseAllow, 'GET', '/api/admin/claims?createdFrom=2020-01-01T00:00:00.000Z', adminToken);
    expect(ok.status).toBe(200);
  });

  it('17. pagination ordering is deterministic', async () => {
    const first = await api(baseAllow, 'GET', '/api/admin/claims?limit=10', adminToken);
    const second = await api(baseAllow, 'GET', '/api/admin/claims?limit=10', adminToken);
    expect(first.json.data.map((c: any) => c.id)).toEqual(second.json.data.map((c: any) => c.id));
  });

  it('unknown/extra query parameters are ignored (repository policy), not forwarded', async () => {
    expect((await api(baseAllow, 'GET', '/api/admin/claims?nonsense=1&limit=1', adminToken)).status).toBe(200);
  });

  it('a duplicated parameter is rejected rather than silently accepting one value', async () => {
    const res = await api(baseAllow, 'GET', '/api/admin/claims?limit=1&limit=2', adminToken);
    expect(res.status).toBe(400);
  });

  it('claimant phone filter is normalised and validated', async () => {
    const bad = await api(baseAllow, 'GET', '/api/admin/claims?claimantPhone=12345', adminToken);
    expect(bad.status).toBe(400);
    const ok = await api(baseAllow, 'GET', '/api/admin/claims?claimantPhone=0712345678', adminToken);
    expect(ok.status).toBe(200);
  });

  it('claimId / itemId filters are validated', async () => {
    expect((await api(baseAllow, 'GET', '/api/admin/claims?claimId=has%20space', adminToken)).status).toBe(400);
    expect((await api(baseAllow, 'GET', '/api/admin/claims?itemId=' + encodeURIComponent('a'.repeat(100)), adminToken)).status).toBe(400);
    const ok = await api(baseAllow, 'GET', '/api/admin/claims?claimId=CLM-123456', adminToken);
    expect(ok.status).toBe(200);
    expect(ok.json.data).toEqual([]);
  });
});


// ---------------------------------------------------------------------------
// DETAIL ENDPOINT
// ---------------------------------------------------------------------------
describe('6E GET /api/admin/claims/:claimId', () => {
  it('18. a valid claim returns 200 with the safe detail DTO', async () => {
    const itemId = await makeItem('DETAIL');
    const claimId = await makeClaim(itemId, 'DETAIL', 'pending_verification');
    const res = await api(baseAllow, 'GET', `/api/admin/claims/${claimId}`, adminToken);
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(res.json.claim.id).toBe(claimId);
    expect(res.json.claim.verification.tier).toBe(2);
    expect(Object.keys(res.json.claim)).toContain('has_paid');
  });

  it('19. an unknown claim returns 404', async () => {
    const res = await api(baseAllow, 'GET', `/api/admin/claims/NO-SUCH-CLAIM-${RUN}`, adminToken);
    expect(res.status).toBe(404);
  });

  it('20. a malformed claim id returns 400 (distinct from a genuine 404)', async () => {
    const malformed = await api(baseAllow, 'GET', `/api/admin/claims/${encodeURIComponent('bad id!')}`, adminToken);
    expect(malformed.status).toBe(400);
    const tooLong = await api(baseAllow, 'GET', `/api/admin/claims/${'a'.repeat(100)}`, adminToken);
    expect(tooLong.status).toBe(400);
  });

  it('21/22. the detail response contains no sensitive field and no raw claim row', async () => {
    const itemId = await makeItem('DETPRIV');
    const claimId = await makeClaim(itemId, 'DETPRIV', 'pending_verification');
    const res = await api(baseAllow, 'GET', `/api/admin/claims/${claimId}`, adminToken);
    const text = res.text;

    for (const forbidden of [
      'security_answers', 'SECRET-ANSWER-6E',
      'SECRET-ID-PROOF-KEY-6E', 'owner_id_proof_url', 'owner_identifying_details', 'SECRET-IDENTIFYING-6E',
      'payment_reference', 'code_hash', 'token_hash', 'pickup', 'otp', 'national_id',
      'session', 'password',
    ]) {
      expect(text, `detail leaked: ${forbidden}`).not.toContain(forbidden);
    }
    // No raw row shape: the domain row's raw phone is not present either.
    const rawPhone = (await db.getClaim(claimId))!.owner_phone;
    expect(text).not.toContain(rawPhone);
    expect(res.json.claim.claimant_phone).toContain('***');
    // Presence booleans only for the sensitive artifacts.
    expect(res.json.claim.verification.id_proof_present).toBe(true);
    expect(res.json.claim.verification.identifying_detail_present).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PAYMENT TRUTH OVER HTTP
// ---------------------------------------------------------------------------
describe('6E payment truth via the endpoint', () => {
  it('23. payment_reference only -> has_paid false', async () => {
    const itemId = await makeItem('PTREF');
    const claimId = await makeClaim(itemId, 'PTREF', 'pending_payment');
    await db.updateClaimStatus(claimId, 'pending_payment', 'REF-ONLY-6E');
    const res = await api(baseAllow, 'GET', `/api/admin/claims/${claimId}`, adminToken);
    expect(res.json.claim.paid_at).toBeNull();
    expect(res.json.claim.has_paid).toBe(false);
    expect(res.json.claim.payment_state).toBe('unpaid');
  });

  it('24. paid_at only -> has_paid true', async () => {
    const itemId = await makeItem('PTATONLY');
    const claimId = await makeClaim(itemId, 'PTATONLY', 'pending_payment');
    await db.attemptClaimEscrowHold(claimId, '');
    const res = await api(baseAllow, 'GET', `/api/admin/claims/${claimId}`, adminToken);
    expect(res.json.claim.paid_at).toBeTruthy();
    expect(res.json.claim.has_paid).toBe(true);
  });

  it('25. both set -> has_paid true and the invariant holds', async () => {
    const itemId = await makeItem('PTBOTH');
    const claimId = await makePaidClaim(itemId, 'PTBOTH');
    const res = await api(baseAllow, 'GET', `/api/admin/claims/${claimId}`, adminToken);
    expect(res.json.claim.has_paid).toBe(true);
    expect(res.json.claim.paid_at).not.toBeNull();
    expect(res.json.claim.has_paid).toBe(res.json.claim.paid_at !== null);
  });
});

// ---------------------------------------------------------------------------
// PRIVACY OVER HTTP
// ---------------------------------------------------------------------------
describe('6E privacy boundary', () => {
  it('26-31. list and detail do not leak answers, OTP, tokens, evidence URLs or raw identity keys', async () => {
    const itemId = await makeItem('PRIVALL');
    const claimId = await makeClaim(itemId, 'PRIVALL', 'pending_verification');
    // A live OTP challenge exists for this claim.
    await db.setClaimOtp(claimId, 'otp-hash-6e', new Date(Date.now() + 60000));

    const list = await api(baseAllow, 'GET', `/api/admin/claims?itemId=${itemId}`, adminToken);
    const detail = await api(baseAllow, 'GET', `/api/admin/claims/${claimId}`, adminToken);
    for (const body of [list.text, detail.text]) {
      expect(body).not.toContain('SECRET-ANSWER-6E');
      expect(body).not.toContain('SECRET-ID-PROOF-KEY-6E');
      expect(body).not.toContain('SECRET-IDENTIFYING-6E');
      expect(body).not.toContain('otp-hash-6e');
      expect(body).not.toContain('code_hash');
      expect(body).not.toContain('token_hash');
      expect(body).not.toContain('http'); // no signed/presigned evidence URL
    }
    // The claimant phone is masked in both.
    expect(list.json.data[0].claimant_phone).toContain('***');
    expect(detail.json.claim.claimant_phone).toContain('***');
  });
});


// ---------------------------------------------------------------------------
// READ AUDIT
// ---------------------------------------------------------------------------
describe('6E read audit', () => {
  it('32. the detail read is attributed to the authenticated admin', async () => {
    const itemId = await makeItem('AUDIT');
    const claimId = await makeClaim(itemId, 'AUDIT', 'pending_verification');
    await api(baseAllow, 'GET', `/api/admin/claims/${claimId}`, adminToken);

    const entries = (await db.getAuditLogs()).filter(
      (l) => l.action === 'CLAIM_DETAIL_VIEWED' && l.details.includes(claimId),
    );
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[entries.length - 1].admin_user).toBe(ADMIN_USER);
  });

  it('33. no SYSTEM/ADMIN literal is attributed for a human read', async () => {
    const itemId = await makeItem('AUDITSYS');
    const claimId = await makeClaim(itemId, 'AUDITSYS', 'pending_verification');
    await api(baseAllow, 'GET', `/api/admin/claims/${claimId}`, adminToken);
    const entry = (await db.getAuditLogs())
      .find((l) => l.action === 'CLAIM_DETAIL_VIEWED' && l.details.includes(claimId));
    expect(entry!.admin_user).not.toBe('SYSTEM');
    expect(entry!.admin_user).not.toBe('ADMIN');
    expect(entry!.admin_user).toBe(ADMIN_USER);
  });

  it('34. the audit payload carries no sensitive values', async () => {
    const itemId = await makeItem('AUDITSAFE');
    const claimId = await makeClaim(itemId, 'AUDITSAFE', 'pending_verification');
    await api(baseAllow, 'GET', `/api/admin/claims/${claimId}`, adminToken);
    const entry = (await db.getAuditLogs())
      .find((l) => l.action === 'CLAIM_DETAIL_VIEWED' && l.details.includes(claimId));
    for (const forbidden of ['SECRET-ANSWER-6E', 'SECRET-ID-PROOF-KEY-6E', 'SECRET-IDENTIFYING-6E', 'code_hash', 'token_hash', 'otp']) {
      expect(entry!.details, `audit leaked ${forbidden}`).not.toContain(forbidden);
    }
    // It DOES record the claim id and status — useful, non-sensitive context.
    expect(entry!.details).toContain(claimId);
    expect(entry!.details).toContain('pending_verification');
  });

  it('35. one detail read writes exactly one audit row; list reads write none', async () => {
    const itemId = await makeItem('AUDITCOUNT');
    const claimId = await makeClaim(itemId, 'AUDITCOUNT', 'pending_verification');

    // Several list reads (a paginating console) create no audit noise.
    await api(baseAllow, 'GET', `/api/admin/claims?limit=1`, adminToken);
    await api(baseAllow, 'GET', `/api/admin/claims?limit=2&offset=1`, adminToken);
    await api(baseAllow, 'GET', '/api/admin/claims', adminToken);
    expect((await db.getAuditLogs()).filter((l) => l.action === 'CLAIM_LIST_VIEWED')).toHaveLength(0);

    await api(baseAllow, 'GET', `/api/admin/claims/${claimId}`, adminToken);
    const afterOne = (await db.getAuditLogs()).filter(
      (l) => l.action === 'CLAIM_DETAIL_VIEWED' && l.details.includes(claimId),
    ).length;
    expect(afterOne).toBe(1);

    await api(baseAllow, 'GET', `/api/admin/claims/${claimId}`, adminToken);
    const afterTwo = (await db.getAuditLogs()).filter(
      (l) => l.action === 'CLAIM_DETAIL_VIEWED' && l.details.includes(claimId),
    ).length;
    expect(afterTwo).toBe(2); // one per read, never duplicated by a single read
  });
});

// ---------------------------------------------------------------------------
// ERRORS
// ---------------------------------------------------------------------------
describe('6E error handling', () => {
  it('36/37. an unexpected database failure becomes 500, never an empty 200', async () => {
    const itemId = await makeItem('DBFAIL');
    const claimId = await makeClaim(itemId, 'DBFAIL', 'pending_verification');
    const original = db.getAdminClaimDetail.bind(db);
    const originalList = db.listAdminClaims.bind(db);
    try {
      (db as any).getAdminClaimDetail = async () => { throw new Error('simulated database failure'); };
      const detail = await api(baseAllow, 'GET', `/api/admin/claims/${claimId}`, adminToken);
      expect(detail.status).toBe(500);
      expect(detail.status).not.toBe(200);

      (db as any).listAdminClaims = async () => { throw new Error('simulated database failure'); };
      const list = await api(baseAllow, 'GET', '/api/admin/claims', adminToken);
      expect(list.status).toBe(500);
      expect(list.json.data).toBeUndefined();
    } finally {
      (db as any).getAdminClaimDetail = original;
      (db as any).listAdminClaims = originalList;
    }
    // The failure did not damage anything: the endpoint works again.
    expect((await api(baseAllow, 'GET', `/api/admin/claims/${claimId}`, adminToken)).status).toBe(200);
  });

  it('38. error bodies expose only a message — no internals, no stack, no SQL', async () => {
    const bodies = [
      (await api(baseAllow, 'GET', '/api/admin/claims?limit=abc', adminToken)).json,
      (await api(baseAllow, 'GET', `/api/admin/claims/NO-SUCH-${RUN}`, adminToken)).json,
      (await api(baseAllow, 'GET', '/api/admin/claims', ownerToken)).json,
      (await api(baseDeny, 'GET', '/api/admin/claims', adminToken)).json,
    ];
    for (const body of bodies) {
      expect(Object.keys(body)).toEqual(['error']);
      // No stack frame, no module path, no SQL text, no credential-ish wording.
      const serialized = JSON.stringify(body);
      for (const forbidden of ['at Object', 'at handler', 'node_modules', 'FROM claims', 'SELECT ', 'stack', 'passwordHash', 'apiKey']) {
        expect(serialized, `error body leaked: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});


// ---------------------------------------------------------------------------
// INJECTION / OVERSIZED INPUT
// ---------------------------------------------------------------------------
describe('6E injection and oversized input', () => {
  it('39. SQL-injection-shaped filters are rejected and leave the table intact', async () => {
    const itemId = await makeItem('INJECT');
    const claimId = await makeClaim(itemId, 'INJECT', 'pending_verification');

    const payloads = [
      `' OR 1=1--`,
      `'; DROP TABLE claims;--`,
      `1; DELETE FROM claims WHERE 1=1`,
      `UNION SELECT * FROM claims`,
    ];
    for (const p of payloads) {
      const res = await api(baseAllow, 'GET', `/api/admin/claims?claimId=${encodeURIComponent(p)}`, adminToken);
      expect(res.status, `payload ${p}`).toBe(400);
      const detail = await api(baseAllow, 'GET', `/api/admin/claims/${encodeURIComponent(p)}`, adminToken);
      expect(detail.status, `payload ${p}`).toBe(400);
    }
    for (const p of payloads) {
      const res = await api(baseAllow, 'GET', `/api/admin/claims?status=${encodeURIComponent(p)}`, adminToken);
      expect(res.status).toBe(400);
    }

    // Nothing was dropped or mutated: the claim is still there and readable.
    expect((await db.getClaim(claimId))).toBeTruthy();
    expect((await api(baseAllow, 'GET', `/api/admin/claims/${claimId}`, adminToken)).status).toBe(200);
  });

  it('40. oversized numeric and identifier input is handled safely', async () => {
    const huge = '9'.repeat(40);
    expect((await api(baseAllow, 'GET', `/api/admin/claims?limit=${huge}`, adminToken)).status).toBe(400);
    expect((await api(baseAllow, 'GET', `/api/admin/claims?offset=${huge}`, adminToken)).status).toBe(400);
    const longId = 'a'.repeat(500);
    expect((await api(baseAllow, 'GET', `/api/admin/claims?claimId=${longId}`, adminToken)).status).toBe(400);
  });

  it('41. unexpected parameter types are rejected rather than misinterpreted', async () => {
    // Nested/object-shaped query syntax.
    const res = await api(baseAllow, 'GET', '/api/admin/claims?limit[foo]=1', adminToken);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// NON-MUTATION
// ---------------------------------------------------------------------------
describe('6E reads never mutate', () => {
  it('42-46. list and detail leave status, paid_at, payment_reference and the OTP untouched', async () => {
    const itemId = await makeItem('NOMUTATE');
    const claimId = await makePaidClaim(itemId, 'NOMUTATE');
    await db.setClaimOtp(claimId, 'otp-keep-6e', new Date(Date.now() + 60000));

    const before = await db.getClaim(claimId);
    const otpBefore = await db.getClaimOtp(claimId);

    await api(baseAllow, 'GET', '/api/admin/claims?limit=100', adminToken);
    await api(baseAllow, 'GET', `/api/admin/claims?itemId=${itemId}`, adminToken);
    await api(baseAllow, 'GET', `/api/admin/claims/${claimId}`, adminToken);
    await api(baseAllow, 'GET', '/api/admin/claims?hasPaid=true&disputeState=none', adminToken);

    const after = await db.getClaim(claimId);
    expect(after!.status).toBe(before!.status);
    expect(after!.paid_at).toBe(before!.paid_at);
    expect(after!.payment_reference).toBe(before!.payment_reference);
    expect(after!.updated_at).toBe(before!.updated_at);
    // The OTP challenge survives a read (no consumption side effect).
    expect(await db.getClaimOtp(claimId)).toEqual(otpBefore);
  });

  it('a claim in pending_payment is not expired by reading it', async () => {
    const itemId = await makeItem('NOEXPIRE');
    const claimId = await makeClaim(itemId, 'NOEXPIRE', 'pending_payment');
    await api(baseAllow, 'GET', `/api/admin/claims/${claimId}`, adminToken);
    await api(baseAllow, 'GET', `/api/admin/claims?status=pending_payment`, adminToken);
    expect((await db.getClaim(claimId))!.status).toBe('pending_payment');
  });
});


// ---------------------------------------------------------------------------
// WIRING GUARDS
// ---------------------------------------------------------------------------
// The two scanners (adminRouteAudit, adminSessionRevocation) discover routes
// with the regex /app\.(get|...)\(\'(\/api\/admin[^\']*)\',\s*authenticateJWT,/
// — i.e. the path and authenticateJWT must be on the SAME source line. A route
// written across multiple lines still works at runtime but silently drops out
// of BOTH audits, so the protections would look intact while covering nothing.
// These guards fail loudly if that ever happens again.
describe('6E scan coverage wiring guards', () => {
  it('both routes are declared in the single-line shape the admin scanners require', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../routes/adminClaims.ts'), 'utf8');
    const found = source.match(/app\.get\('\/api\/admin\/claims[^']*',\s*authenticateJWT,\s*requireCurrentAdminSession,/g) ?? [];
    expect(found).toHaveLength(2);
  });

  it('both routes carry an explicit inline admin role check', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../routes/adminClaims.ts'), 'utf8');
    const roleChecks = source.match(/role\s*!==\s*['"]admin['"]/g) ?? [];
    expect(roleChecks).toHaveLength(2);
  });

  it('the route module is registered from server.ts', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');
    expect(source).toMatch(/registerAdminClaimRoutes\(app,\s*\{\s*requireCurrentAdminSession,\s*sendServerError\s*\}\)/);
  });

  it('both admin scanners scan the new module', () => {
    for (const rel of ['adminRouteAudit.test.ts', '../services/__tests__/adminSessionRevocation.test.ts']) {
      const source = fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
      expect(source, `${rel} must scan routes/adminClaims.ts`).toContain('routes/adminClaims.ts');
    }
  });

  it('the route module never reads payment_reference and never writes claim state', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../routes/adminClaims.ts'), 'utf8');
    expect(source).not.toContain('payment_reference');
    expect(source).not.toContain('updateClaimStatus');
    expect(source).not.toContain('app.post');
    expect(source).not.toContain('app.put');
    expect(source).not.toContain('app.patch');
    expect(source).not.toContain('app.delete');
  });
});

});
