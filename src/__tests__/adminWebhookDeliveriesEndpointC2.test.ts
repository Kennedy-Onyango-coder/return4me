import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import type { Server } from 'http';
import { db } from '../db/database';
import { generateToken } from '../services/auth';
import { registerAdminWebhookDeliveryRoutes } from '../routes/adminWebhookDeliveries';
import { ADMIN_PERMISSIONS, adminHasPermission } from '../services/adminPermissions';

// =============================================================================
// GATE C / STAGE C2 — THE ADMIN DELIVERY LOG OVER REAL HTTP
//
// The read exists so an operator can answer "what did we tell IntaSend, and did
// the collection ever settle?" without shelling into the database. Three
// properties decide whether it is safe to expose:
//
//   1. AUTHORIZATION — every guard in the chain is real here: the REAL
//      authenticateJWT, the REAL requireAdminPermission (payments.webhook_read),
//      and the route's own inline role check. A customer token, an
//      `admin_pending_2fa` token and an anonymous request are all refused.
//   2. READ-ONLY — the module registers ONLY a GET, and the handler performs
//      exactly one read. No retry, no replay, no "mark resolved": a delivery
//      record is evidence, and evidence an administrator can edit is not
//      evidence.
//   3. BOUNDED + ALLOWLISTED — the page is capped, every query parameter is
//      validated against a closed vocabulary, and the response carries exactly
//      the documented fields (a column added to the table later cannot leak).
//
// server.ts is deliberately not imported (it calls startServer() at import
// time); `requireCurrentAdminSession` is a pass-through stand-in exactly as in
// adminClaimsEndpoints.test.ts and adminLostReportsEndpoints.test.ts, because it
// is defined inside server.ts. The permission guard is NOT stubbed: the point is
// that the real grant table decides.
// =============================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

const RUN = Date.now().toString(36);
let server: Server;
let baseUrl = '';
let adminToken = '';
let ownerToken = '';
let pending2faToken = '';

const passSession = (_req: any, _res: any, next: any) => next();
const sendServerError = (res: any, _error: any, context: string) =>
  res.status(500).json({ error: 'server error', context });

const listSpy = vi.spyOn(db, 'listAdminWebhookDeliveries');

const ROW = {
  id: 'WHD-ROW-1',
  provider: 'intasend',
  event_topic: 'collection_event',
  event_category: 'collection_complete',
  authenticated: true,
  status: 'refused_permanent',
  outcome_code: 'cross_claim_invoice',
  retryable: false,
  http_status: 409,
  claim_id: 'CLAIM-C2-1',
  payment_session_id: 'PS-C2-1',
  provider_invoice_id: 'INV-C2-1',
  provider_reference: 'MPESA-C2',
  payload_fingerprint: 'a'.repeat(64),
  diagnostic: null,
  received_at: '2026-01-01T00:00:00.000Z',
  processed_at: '2026-01-01T00:00:01.000Z',
  is_open: false,
  session_resolution: 'unresolved',
};

async function api(urlPath: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(baseUrl + urlPath, { method: 'GET', headers });
  const raw = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  return { status: res.status, body, raw };
}

beforeAll(async () => {
  adminToken = generateToken({
    userId: `ADM-C2-${RUN}`,
    phone: '+254700000000',
    role: 'admin',
    username: `test-c2-admin-${RUN}`,
  } as any);
  ownerToken = generateToken({
    userId: `TEST-C2-OWNER-${RUN}`,
    phone: '+254700000009',
    role: 'owner',
  } as any);
  pending2faToken = generateToken({
    userId: `ADM-C2-${RUN}`,
    phone: '+254700000000',
    role: 'admin_pending_2fa',
    username: `test-c2-admin-${RUN}`,
  } as any);

  const app = express();
  app.use(express.json());
  registerAdminWebhookDeliveryRoutes(app, {
    requireCurrentAdminSession: passSession,
    sendServerError,
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = 'http://127.0.0.1:' + port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  listSpy.mockRestore();
});

beforeEach(() => {
  vi.clearAllMocks();
  listSpy.mockResolvedValue({ rows: [ROW] as any, hasMore: false });
});


describe('C2 — only a live administrator holding payments.webhook_read may read the log', () => {
  it('refuses an anonymous request', async () => {
    const res = await api('/api/admin/webhook-deliveries');
    expect(res.status).toBe(401);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('refuses a customer/owner token', async () => {
    const res = await api('/api/admin/webhook-deliveries', ownerToken);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Access denied.' });
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('refuses an admin_pending_2fa token, even though the user id is an admin', async () => {
    // The incomplete-login role must never satisfy an admin read: the permission
    // guard checks `role === 'admin'` as well as the grant.
    const res = await api('/api/admin/webhook-deliveries', pending2faToken);
    expect(res.status).toBe(403);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('grants the read to the documented single admin role', async () => {
    // No new privilege tier is introduced: the flat model documented in
    // docs/ROLE_SEPARATION_PLAN.md means the existing administrator reads this,
    // and the permission exists so the route DECLARES what it needs.
    expect(adminHasPermission({ role: 'admin' }, ADMIN_PERMISSIONS.PAYMENTS_WEBHOOK_READ)).toBe(true);
    expect(adminHasPermission({ role: 'owner' }, ADMIN_PERMISSIONS.PAYMENTS_WEBHOOK_READ)).toBe(false);
    expect(
      adminHasPermission({ role: 'admin_pending_2fa' }, ADMIN_PERMISSIONS.PAYMENTS_WEBHOOK_READ),
    ).toBe(false);

    const res = await api('/api/admin/webhook-deliveries', adminToken);
    expect(res.status).toBe(200);
  });
});


describe('C2 — the page is bounded, filtered and allowlisted', () => {
  it('answers the documented envelope with defaults applied', async () => {
    const res = await api('/api/admin/webhook-deliveries', adminToken);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.pagination).toEqual({ limit: 25, offset: 0, hasMore: false });
    expect(res.body.data).toHaveLength(1);

    const [row] = res.body.data;
    // The view is an ALLOWLIST, mapped to camelCase. A column added to the table
    // later cannot appear here without a deliberate edit.
    expect(Object.keys(row).sort()).toEqual(
      [
        'id', 'provider', 'eventTopic', 'eventCategory', 'authenticated', 'status',
        'outcomeCode', 'retryable', 'httpStatus', 'claimId', 'paymentSessionId',
        'providerInvoiceId', 'providerReference', 'payloadFingerprint', 'diagnostic',
        'receivedAt', 'processedAt', 'incomplete', 'sessionResolution',
      ].sort(),
    );
    expect(row.id).toBe('WHD-ROW-1');
    expect(row.httpStatus).toBe(409);
    expect(row.incomplete).toBe(false);
    expect(row.sessionResolution).toBe('unresolved');
  });

  it('passes every supplied filter through to the single read', async () => {
    const res = await api(
      '/api/admin/webhook-deliveries?limit=10&offset=20&status=received&status=ignored' +
        '&eventCategory=collection_complete&claimId=CLAIM-C2-1&paymentSessionId=PS-C2-1' +
        '&providerInvoiceId=INV-C2-1&receivedFrom=2026-01-01T00:00:00.000Z&receivedTo=2026-02-01T00:00:00.000Z',
      adminToken,
    );
    expect(res.status).toBe(200);
    // EXACTLY one read, with the parsed values — no second query, no mutation.
    expect(listSpy).toHaveBeenCalledTimes(1);
    const args = listSpy.mock.calls[0][0] as any;
    expect(args.limit).toBe(10);
    expect(args.offset).toBe(20);
    expect(args.statuses).toEqual(['received', 'ignored']);
    expect(args.eventCategory).toBe('collection_complete');
    expect(args.claimId).toBe('CLAIM-C2-1');
    expect(args.paymentSessionId).toBe('PS-C2-1');
    expect(args.providerInvoiceId).toBe('INV-C2-1');
    expect(args.receivedFrom).toBeInstanceOf(Date);
    expect(args.receivedTo).toBeInstanceOf(Date);
  });

  it('reports hasMore instead of truncating silently', async () => {
    listSpy.mockResolvedValue({ rows: [ROW, { ...ROW, id: 'WHD-ROW-2' }] as any, hasMore: true });
    const res = await api('/api/admin/webhook-deliveries?limit=2', adminToken);
    expect(res.status).toBe(200);
    expect(res.body.pagination).toEqual({ limit: 2, offset: 0, hasMore: true });
    expect(res.body.data).toHaveLength(2);
  });

  it('marks an OPEN delivery as incomplete and never as a success', async () => {
    listSpy.mockResolvedValue({
      rows: [
        {
          ...ROW,
          status: 'received',
          http_status: null,
          processed_at: null,
          outcome_code: null,
          is_open: undefined,
          session_resolution: 'no_payment_session',
        },
      ] as any,
      hasMore: false,
    });
    const res = await api('/api/admin/webhook-deliveries', adminToken);
    const [row] = res.body.data;
    expect(row.incomplete).toBe(true);
    expect(row.httpStatus).toBeNull();
    expect(row.processedAt).toBeNull();
    expect(row.sessionResolution).toBe('no_payment_session');
  });

  it('keeps `authenticated` NULL when no verdict was reached', async () => {
    listSpy.mockResolvedValue({
      rows: [{ ...ROW, authenticated: null, retryable: null }] as any,
      hasMore: false,
    });
    const [row] = (await api('/api/admin/webhook-deliveries', adminToken)).body.data;
    // NULL, not false — the console must be able to distinguish "nothing was
    // checked" from "a check failed".
    expect(row.authenticated).toBeNull();
    expect(row.retryable).toBeNull();
  });
});


describe('C2 — a malformed parameter is refused, never silently ignored', () => {
  const rejected: Array<[string, string]> = [
    ['limit=0', 'below the floor'],
    ['limit=101', 'above the ceiling'],
    ['limit=abc', 'not digits'],
    ['limit=', 'empty'],
    ['limit=1&limit=2', 'repeated (ambiguous)'],
    ['offset=-1', 'signed'],
    ['status=not_a_status', 'out of vocabulary'],
    ['status=', 'empty status'],
    ['eventCategory=not_a_category', 'out of vocabulary'],
    ['claimId=a%20b', 'illegal characters'],
    ['receivedFrom=notadate', 'unparseable date'],
    ['receivedTo=notadate', 'unparseable date'],
  ];

  for (const [query, why] of rejected) {
    it(`refuses ?${query} (${why})`, async () => {
      const res = await api(`/api/admin/webhook-deliveries?${query}`, adminToken);
      expect(res.status).toBe(400);
      // A rejected request performs NO read: a diagnostic page must not be
      // produced from input the route could not interpret.
      expect(listSpy).not.toHaveBeenCalled();
    });
  }

  it('ignores parameters outside the contract instead of forwarding them', async () => {
    const res = await api('/api/admin/webhook-deliveries?unexpected=1&sort=id', adminToken);
    expect(res.status).toBe(200);
    expect(listSpy).toHaveBeenCalledTimes(1);
    const args = listSpy.mock.calls[0][0] as any;
    expect(Object.keys(args).sort()).toEqual(
      [
        'claimId', 'eventCategory', 'limit', 'offset', 'paymentSessionId',
        'providerInvoiceId', 'receivedFrom', 'receivedTo', 'statuses',
      ].sort(),
    );
  });

  it('answers 500 with its own context when the read fails', async () => {
    listSpy.mockRejectedValue(new Error('db down'));
    const res = await api('/api/admin/webhook-deliveries', adminToken);
    expect(res.status).toBe(500);
    expect(res.body.context).toBe('ADMIN_WEBHOOK_DELIVERIES_ERROR');
    // Nothing about the failure is echoed to the caller.
    expect(res.raw).not.toContain('db down');
  });
});

describe('C2 — the module is READ-ONLY by construction', () => {
  const source = read('src/routes/adminWebhookDeliveries.ts');

  it('registers exactly one route, and it is a GET', () => {
    expect(source.match(/app\.(get|post|patch|put|delete)\(/g) ?? []).toEqual(['app.get(']);
  });

  it('has no mutating verb at all — no retry, replay or "mark resolved"', () => {
    expect(source).not.toMatch(/\.post\(/);
    expect(source).not.toMatch(/\.patch\(/);
    expect(source).not.toMatch(/\.put\(/);
    expect(source).not.toMatch(/\.delete\(/);
    // And no financial or reconciliation primitive is imported into it.
    for (const forbidden of [
      'processClaimPaymentConfirmed',
      'reconcilePayoutBatchStatus',
      'reconcileCollectionFailureEvent',
      'finishWebhookDelivery',
      'markWebhookDeliveryProcessing',
      'recordWebhookDelivery',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('declares the permission it needs and keeps the inline role check', () => {
    expect(source).toContain('ADMIN_PERMISSIONS.PAYMENTS_WEBHOOK_READ');
    // authenticateJWT does not check role, so without the inline check an
    // `admin_pending_2fa` token would reach the handler.
    expect(source).toContain(`req.user?.role !== 'admin'`);
  });
});
