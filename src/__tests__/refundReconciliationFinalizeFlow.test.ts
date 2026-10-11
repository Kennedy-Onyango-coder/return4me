import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { db } from '../db/database';
import { generateToken } from '../services/auth';
import { ensureTestCategory, testRunId } from '../db/__tests__/ensureTestCategory';

// =============================================================================
// BATCH 1B-C1/R1/R2 — R3: the refund-reconciliation FINALIZE route's
// notification control flow, tested BEHAVIOURALLY against the REAL application.
//
// The defect this file pins: `produceRefundComplete(claimId)` sat inside
// `if (!finalized) { ...; return res.status(409)...; await
// produceRefundComplete(claimId); }` — textually AFTER an unconditional return,
// i.e. unreachable dead code. A reconciled refund therefore finalized the claim
// (refunding -> refunded, plus the refund ledger row) while the customer was
// never told.
//
// WHY A REAL HTTP TEST: "is the customer told, and only when the database
// finalization actually succeeded?" is a question about the ROUTE's control
// flow, so createApp(), authenticateJWT, requireCurrentAdminSession, the DB
// layer, the refunding -> refunded CAS and the ledger write are all real. The
// notification producers are the ONE doubled seam, because a recording stand-in
// is the only way to assert a NOT-called. Those NOT-called assertions are
// non-vacuous: the successful-finalize test below proves the stand-in IS wired
// to the route and IS called when the CAS succeeds.
// =============================================================================

const RUN = testRunId;
let counter = 0;
const nextId = (prefix: string) => `${prefix}-${RUN}-${counter++}`;

const produced = vi.hoisted(() => ({ refundComplete: [] as string[] }));

vi.mock('../services/claimNotificationProducers', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    produceRefundComplete: vi.fn(async (claimId: string) => {
      produced.refundComplete.push(claimId);
      return 'NOTIF-TEST';
    }),
  };
});

let server: any;
let baseUrl = '';
let adminToken = '';
const realFetch = globalThis.fetch;

async function api(method: string, path: string, token?: string) {
  const res = await realFetch(baseUrl + path, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, text, json };
}

const finalize = (claimId: string) =>
  api('POST', `/api/admin/refund-reconciliation/${encodeURIComponent(claimId)}/finalize`, adminToken);

const refundLedgerRows = async (claimId: string) =>
  (await db.getLedgerEntriesForClaim(claimId)).filter((l) => l.type === 'refund');

/**
 * A claim genuinely sitting in 'refunding' with a resolvable refund amount,
 * built the way refundReconciliation.test.ts builds its fixtures: the claim's
 * status + owner phone + an item carrying a locked fee is exactly what
 * getRefundReconciliationClaims() derives a reconciliation item from.
 */
async function makeRefundingClaim(label: string) {
  const itemId = nextId(`RFN-ITEM-${label}`);
  const claimId = nextId(`RFN-CLAIM-${label}`);
  await ensureTestCategory('phone');
  await db.createItem({
    id: itemId, category_id: 'phone', photo_url: 'test-photo.jpg', ocr_extracted_number: null,
    ocr_extracted_name: null, document_number_hash: null, document_name_fuzzy: null,
    location_description: 'x', latitude: null, longitude: null, finder_phone: '+254700000005',
    assigned_agent_id: null, status: 'at_agent', flaggedForReview: false, isDescriptionOnly: false,
    description: null, is_sensitive_document: false, rejection_reason: null, locked_total_fee: '500',
  } as any);
  await db.createClaim({
    id: claimId, item_id: itemId, owner_phone: '+254700000099',
    security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'refund finalize flow fixture' },
    verification_tier: 1, owner_id_proof_url: null, payment_reference: 'MPX-RFN-FLOW',
    owner_identifying_details: null, status: 'refunding',
  } as any);
  return { claimId, itemId };
}

beforeAll(async () => {
  const mod: any = await import('../server.ts');
  const prevEnv = process.env.NODE_ENV;
  // 'production' selects createApp()'s deterministic static-dist branch instead
  // of booting a Vite dev server. Restored immediately; nothing production-
  // specific is exercised afterwards.
  process.env.NODE_ENV = 'production';
  try {
    const app = await mod.createApp();
    server = await new Promise<any>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // A REAL admin account: the route is guarded by the real
  // requireCurrentAdminSession (is_active + token_version re-check against the
  // live row), not a stand-in. The token is minted with that account's live
  // token_version, exactly as login does.
  const username = `rfn-flow-admin-${RUN}`;
  const admin = await db.createAdminUser(
    `RFN-ADM-${RUN}`, username, await bcrypt.hash(`pw-${RUN}`, 4), 'Refund Flow Admin',
  );
  adminToken = generateToken(
    {
      userId: admin.id, phone: '+254700000000', role: 'admin', username,
      tokenVersion: admin.token_version,
    } as any,
    '1h',
  );
}, 120000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  produced.refundComplete.length = 0;
});

describe('refund reconciliation finalize — the completion notice is gated on the DB CAS', () => {
  it('a successful finalize moves the claim to refunded and notifies exactly once', async () => {
    const { claimId } = await makeRefundingClaim('OK');

    const res = await finalize(claimId);

    expect(res.status).toBe(200);
    expect(res.json?.success).toBe(true);
    // THE fix: the notification is reachable on the success path...
    expect(produced.refundComplete).toEqual([claimId]);
    // ...and it runs AFTER the database finalization really committed.
    expect((await db.getClaim(claimId))!.status).toBe('refunded');
    expect(await refundLedgerRows(claimId)).toHaveLength(1);
  });

  it('a repeated finalize is refused with 409 and cannot notify a second time', async () => {
    const { claimId } = await makeRefundingClaim('REPEAT');

    const first = await finalize(claimId);
    expect(first.status).toBe(200);
    expect(produced.refundComplete).toEqual([claimId]);

    // finalizeClaimRefund is a refunding -> refunded CAS, so the second call
    // returns false. customer_notifications has NO unique constraint on
    // business_reference, so this guard is the only deduplication the P9 notice
    // has: the 409 must happen BEFORE the producer call.
    const second = await finalize(claimId);
    expect(second.status).toBe(409);
    expect(produced.refundComplete).toEqual([claimId]);
    expect(await refundLedgerRows(claimId)).toHaveLength(1);
  });

  it('a FAILED CAS responds 409 and sends no completion notice', async () => {
    const { claimId } = await makeRefundingClaim('FAILEDCAS');
    // The claim IS awaiting reconciliation, so the pre-CAS guard passes; the
    // guarded transition reports that it did not win this CAS. That is exactly
    // the branch the old code nested the notification inside — after its
    // unconditional `return`, making the producer call unreachable.
    const spy = vi.spyOn(db as any, 'finalizeClaimRefund').mockResolvedValue(false);
    let res: any;
    try {
      res = await finalize(claimId);
    } finally {
      spy.mockRestore();
    }

    expect(res.status).toBe(409);
    // No completion notice may be sent on a failed CAS...
    expect(produced.refundComplete).toEqual([]);
    // ...and the claim was genuinely NOT finalized.
    expect((await db.getClaim(claimId))!.status).toBe('refunding');
    expect(await refundLedgerRows(claimId)).toHaveLength(0);
  });

  it('a claim that is not awaiting reconciliation is refused and nobody is notified', async () => {
    const res = await finalize('RFN-NO-SUCH-CLAIM');

    expect(res.status).toBe(409);
    expect(produced.refundComplete).toEqual([]);
  });
});
