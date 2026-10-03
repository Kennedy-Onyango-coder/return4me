// =============================================================================
// PI-1 / B — POST /api/claims/submit is an AUTHENTICATED WRITE.
// =============================================================================
//
// THE GAP. The UI gated claim entry (PublicItemView checks GET /api/customer/me
// and hands a signed-out visitor to the /account boundary; OwnerView's
// search-result button refuses to enter the confidence gate without a live
// session), but the SERVER did not. Anyone with curl could still create claims
// anonymously: an unauthenticated, unmetered point of unbounded row growth,
// notification fan-out and support load — and a second code path where "who is
// claiming" was never established at all.
//
// THE FIX. Mount the ONE existing primitive — requireCustomerAuth
// (services/customerAuth.ts) — as the FIRST middleware of the route. No second
// authentication mechanism was introduced and no other route changed. The
// claim-OTP journey (request-otp / verify-otp) deliberately stays anonymous: the
// claim OTP, not an account, is what proves ownership of a claim, and verify-otp
// keeps using resolveOptionalCustomer for the strictly additive
// post-verification account link.
//
// WHAT THIS FILE PROVES
//  A. SOURCE CONTRACT — the primitive is the shared one, it is mounted FIRST,
//     the path is registered exactly once for the whole application, the handler
//     body never reads an identity at all (identity is exclusively the
//     middleware's job), and the OTP routes are NOT behind it.
//  B. REAL HTTP BEHAVIOUR — a real Express app around the REAL middleware and
//     the REAL handler over an actual TCP socket: missing / forged / expired /
//     revoked session and a suspended account are all refused BEFORE any side
//     effect; a client-supplied customer id cannot authenticate; the identical
//     request WITH the owner's real session succeeds; and the claim-OTP journey
//     still works with no cookie at all.
//
// LIMITATIONS (documented rather than hidden)
//  - `canCreateClaim` is INJECTED in production (server.ts owns the single
//    definition; this route must never fork it), so the harness injects a
//    PERMISSIVE stub. That is deliberate: the behaviour under test here is the
//    AUTHENTICATION BOUNDARY, and a permissive claimability rule means every
//    refusal asserted below can only have come from that boundary. The real
//    claimability rule is covered by its own suites.
//  - The OTP rate limiters are injected pass-throughs: mounting the real
//    limiters in a per-file harness would only measure this file's own request
//    volume. The real wiring is pinned by claimOtpAbuseGate.test.ts,
//    customerAccountSecurity.test.ts and smsIdempotencyRateLimitN6.test.ts.
//  - Only the SMS/notification seam is doubled (capture-only). Hashing,
//    timing-safe comparison, session resolution and every state transition stay
//    REAL.
//  - The complete lifecycle (report -> verify -> dropoff -> submit -> OTP) is
//    driven against the REAL application in lifecycleHttpE2E.test.ts (stage 3b).
//    This file mounts the claim module in isolation so that a failure localizes
//    to the boundary instead of to the surrounding journey.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { db } from '../db/database';
import { hashCode } from '../services/auth';
import { ensureTestCategory, testRunId } from '../db/__tests__/ensureTestCategory';

const claimsTs = fs.readFileSync(path.resolve(__dirname, '../routes/claims.ts'), 'utf8');
const serverTs = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');

// Capture the claim OTP instead of dispatching a real SMS.
const sms = vi.hoisted(() => ({ sent: [] as Array<{ phone: string; code: string }> }));

vi.mock('../services/smsNotification', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    sendSmsNotification: vi.fn(async (params: any) => {
      sms.sent.push({ phone: String(params?.recipient ?? ''), code: String(params?.code ?? '') });
      return { accepted: true };
    }),
  };
});

// Imported AFTER the mock above is registered, so the routes module is
// evaluated with the capture-only notification seam in place.
const { registerClaimRoutes } = await import('../routes/claims');

/**
 * The handler BODY: from the first statement after the route registration to the
 * next route registration. The registration line itself is deliberately excluded
 * — it names the middleware — so the slice contains only the code that executes
 * once the boundary has already passed.
 */
function submitRouteBody(): string {
  const marker = "app.post('/api/claims/submit'";
  const start = claimsTs.indexOf(marker);
  expect(start, 'POST /api/claims/submit is not registered in routes/claims.ts').toBeGreaterThan(-1);
  const end = claimsTs.indexOf('\n  app.', start + marker.length);
  expect(end, 'could not find the end of the submit handler').toBeGreaterThan(-1);
  return claimsTs.slice(start, end).split('\n').slice(1).join('\n');
}

// -----------------------------------------------------------------------------
// A. SOURCE CONTRACT
// -----------------------------------------------------------------------------
describe('PI-1 B — submit is gated by the ONE shared auth primitive', () => {
  it('reuses requireCustomerAuth from services/customerAuth (no second mechanism)', () => {
    expect(claimsTs).toMatch(
      /import \{[^}]*\brequireCustomerAuth\b[^}]*\} from '\.\.\/services\/customerAuth\.ts'/
    );
  });

  it('mounts that middleware FIRST on POST /api/claims/submit', () => {
    // Positional: the very next token after the route string is the middleware,
    // so nothing (no limiter, no lookup, no validation) can run ahead of it.
    expect(claimsTs).toMatch(
      /app\.post\('\/api\/claims\/submit',\s*requireCustomerAuth,\s*async \(req, res\) => \{/
    );
  });

  it('the path is registered exactly once for the whole application', () => {
    const registrations = claimsTs.match(/app\.post\('\/api\/claims\/submit'/g) || [];
    expect(registrations).toHaveLength(1);
    // No second, unguarded copy left behind in server.ts.
    expect(serverTs).not.toMatch(/app\.post\('\/api\/claims\/submit'/);
  });

  it('the handler body never reads an identity — the middleware is the only source', () => {
    const body = submitRouteBody();
    // Non-vacuity guard: an empty or truncated slice must not pass this test.
    expect(body).toMatch(/db\.getItem\(/);
    // The strongest form of the claim: the handler mentions no customer at all,
    // so it cannot consult req.body / req.query / req.params for one.
    expect(body).not.toMatch(/customer/i);
  });

  it('the OTP routes are deliberately NOT behind the boundary', () => {
    // request-otp keeps its exact limiter chain; verify-otp keeps its limiter.
    expect(claimsTs).toMatch(
      /app\.post\('\/api\/claims\/:id\/request-otp',\s*otpGlobalLimiter,\s*otpIpLimiter,\s*otpClaimLimiter,\s*smsRateLimit\(\),\s*async \(req, res\) => \{/
    );
    expect(claimsTs).toMatch(
      /app\.post\('\/api\/claims\/:id\/verify-otp',\s*otpVerifyLimiter,\s*async \(req, res\) => \{/
    );
    for (const route of ['/api/claims/:id/request-otp', '/api/claims/:id/verify-otp']) {
      const line = claimsTs.split('\n').find((l) => l.includes(`app.post('${route}'`));
      expect(line, `${route} registration not found`).toBeTruthy();
      expect(line!).not.toMatch(/requireCustomerAuth/);
    }
  });

  it('verify-otp keeps the strictly additive resolveOptionalCustomer link', () => {
    const start = claimsTs.indexOf("app.post('/api/claims/:id/verify-otp'");
    const body = claimsTs.slice(start, start + 6000);
    expect(body).toMatch(/resolveOptionalCustomer\(req\)/);
    expect(body).toMatch(/linkVerifiedClaimToCustomer\(/);
  });
});

// -----------------------------------------------------------------------------
// B. REAL HTTP BEHAVIOUR
//
// One Express app, the REAL registerClaimRoutes, the REAL requireCustomerAuth
// and an actual TCP socket. Only the claimability rule and the OTP limiters are
// injected (see the limitations at the top of this file).
// -----------------------------------------------------------------------------
const RUN = testRunId;
const CATEGORY_ID = `psi-b-cat-${RUN}`;

const base = 10000000 + Math.floor(Math.random() * 80000000);
const PHONE = `+2547${String(base).slice(-8)}`;
const PHONE_SUSPENDED = `+2547${String(base + 1).slice(-8)}`;

const CUSTOMER = `TEST-PI1B-CUS-${RUN}`;
const CUSTOMER_SUSPENDED = `TEST-PI1B-CUS-SUS-${RUN}`;
const SESSION = `TEST-PI1B-SESS-${RUN}`;
const SESSION_EXPIRED = `TEST-PI1B-SESS-EXP-${RUN}`;
const SESSION_REVOKED = `TEST-PI1B-SESS-REV-${RUN}`;
const SESSION_SUSPENDED = `TEST-PI1B-SESS-SUS-${RUN}`;

const TOKEN = 'a'.repeat(64);
const TOKEN_EXPIRED = 'b'.repeat(64);
const TOKEN_REVOKED = 'c'.repeat(64);
const TOKEN_SUSPENDED = 'd'.repeat(64);
const TOKEN_FORGED = 'f'.repeat(64);

const ITEM_ID = `TEST-PI1B-ITEM-${RUN}`;
const ITEM_UNKNOWN = `TEST-PI1B-ITEM-MISSING-${RUN}`;

const ANSWERS = { description: 'Black phone with a scratched back panel' };

let server: any;
let baseUrl = '';
let claimSeq = 0;
let createdClaimId = '';

async function seed(): Promise<void> {
  await ensureTestCategory(CATEGORY_ID);
  await db.createCustomer(CUSTOMER, 'PI1 B Owner', PHONE);
  await db.createCustomer(CUSTOMER_SUSPENDED, 'PI1 B Suspended', PHONE_SUSPENDED);
  // Live session for the owner; the other three differ only in the one property
  // under test (expiry / revocation / account status).
  await db.updateCustomerStatus(CUSTOMER_SUSPENDED, 'suspended');
  const in7Days = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await db.createCustomerSession(SESSION, CUSTOMER, hashCode(TOKEN), in7Days);
  await db.createCustomerSession(SESSION_EXPIRED, CUSTOMER, hashCode(TOKEN_EXPIRED), new Date(Date.now() - 60000));
  await db.createCustomerSession(SESSION_REVOKED, CUSTOMER, hashCode(TOKEN_REVOKED), in7Days);
  await db.revokeCustomerSession(SESSION_REVOKED);
  await db.createCustomerSession(SESSION_SUSPENDED, CUSTOMER_SUSPENDED, hashCode(TOKEN_SUSPENDED), in7Days);

  await db.createItem({
    id: ITEM_ID,
    category_id: CATEGORY_ID,
    photo_url: 'photo.jpg',
    ocr_extracted_number: null,
    ocr_extracted_name: null,
    document_number_hash: null,
    document_name_fuzzy: null,
    location_description: 'Nairobi CBD',
    latitude: null,
    longitude: null,
    finder_phone: '+254700000000',
    assigned_agent_id: null,
    status: 'at_agent',
    flaggedForReview: false,
    isDescriptionOnly: false,
    description: null,
    is_sensitive_document: false,
    rejection_reason: null,
  } as any);
}

beforeAll(async () => {
  await seed();

  const app = express();
  app.use(express.json());
  const passThrough = (_req: any, _res: any, next: any) => next();

  registerClaimRoutes(app, {
    sendServerError: (res: any, error: any, context: string) => {
      console.error(context, error);
      res.status(500).json({ error: 'Hitilafu imetokea upande wa seva.' });
    },
    // PERMISSIVE by design: see the limitations at the top of this file.
    canCreateClaim: async () => ({ allowed: true, reason: '' }),
    claimabilityErrorMessage: () => 'Item is not claimable.',
    generateUniqueClaimId: async () => `CLM-TEST-PI1B-${RUN}-${++claimSeq}`,
    pauseSettingKey: (scope: string) => `platform_paused_${scope}`,
    isPlatformOperationPaused: async () => false,
    PAUSED_MESSAGES: {
      claims: 'Claims are paused.',
      reports: 'Reports are paused.',
      payments: 'Payments are paused.',
      payouts: 'Payouts are paused.',
      handovers: 'Handovers are paused.',
      social_publishing: 'Publishing is paused.',
    },
    otpGlobalLimiter: passThrough,
    otpIpLimiter: passThrough,
    otpClaimLimiter: passThrough,
    otpVerifyLimiter: passThrough,
  } as any);

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** POSTs JSON over a real socket; `token` is the ONLY way to authenticate. */
async function api(
  urlPath: string,
  opts: { token?: string; body?: any } = {}
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.cookie = `r4m_customer_session=${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(baseUrl + urlPath, {
    method: 'POST',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, body: json };
}

async function claimsForItem(itemId: string): Promise<any[]> {
  const all = await db.getClaims();
  return (all as any[]).filter((c) => c.item_id === itemId);
}

/** The body a signed-in visitor sends — identical in every refusal test. */
function submitBody(itemId: string): any {
  return {
    itemId,
    ownerPhone: PHONE,
    securityAnswers: { ...ANSWERS },
    termsAccepted: true,
    ownerIdentifyingDetails: 'Serial 12345',
  };
}


describe('PI-1 B — anonymous callers cannot create a claim', () => {
  it('B1. an anonymous submit is refused 401 and writes nothing at all', async () => {
    const beforeSms = sms.sent.length;
    const r = await api('/api/claims/submit', { body: submitBody(ITEM_ID) });

    expect(r.status).toBe(401);
    expect(r.body?.claim).toBeUndefined();
    expect(r.body?.success).toBeUndefined();
    // No claim row, and therefore no notification fan-out either.
    expect(await claimsForItem(ITEM_ID)).toHaveLength(0);
    expect(sms.sent.length).toBe(beforeSms);
  });

  it('B2. the boundary runs BEFORE the item lookup (an unknown item is still 401, never 404)', async () => {
    const r = await api('/api/claims/submit', { body: submitBody(ITEM_UNKNOWN) });
    expect(r.status).toBe(401);
    expect(await claimsForItem(ITEM_UNKNOWN)).toHaveLength(0);
  });

  it('B3. a forged cookie cannot authenticate', async () => {
    const r = await api('/api/claims/submit', { token: TOKEN_FORGED, body: submitBody(ITEM_ID) });
    expect(r.status).toBe(401);
    expect(await claimsForItem(ITEM_ID)).toHaveLength(0);
  });

  it('B4. an expired session is refused and cannot be replayed', async () => {
    const r = await api('/api/claims/submit', { token: TOKEN_EXPIRED, body: submitBody(ITEM_ID) });
    expect(r.status).toBe(401);
    expect(await claimsForItem(ITEM_ID)).toHaveLength(0);
  });

  it('B5. a revoked session is refused', async () => {
    const r = await api('/api/claims/submit', { token: TOKEN_REVOKED, body: submitBody(ITEM_ID) });
    expect(r.status).toBe(401);
    expect(await claimsForItem(ITEM_ID)).toHaveLength(0);
  });

  it('B6. a suspended account is refused 403 even while holding a live session', async () => {
    const r = await api('/api/claims/submit', { token: TOKEN_SUSPENDED, body: submitBody(ITEM_ID) });
    expect(r.status).toBe(403);
    expect(await claimsForItem(ITEM_ID)).toHaveLength(0);
  });

  it('B7. a client-supplied customer id cannot authenticate', async () => {
    // The header-less caller names a REAL, ACTIVE account in the payload.
    const r = await api('/api/claims/submit', {
      body: { ...submitBody(ITEM_ID), customerId: CUSTOMER, customer_id: CUSTOMER, id: CUSTOMER },
    });
    expect(r.status).toBe(401);
    expect(await claimsForItem(ITEM_ID)).toHaveLength(0);
  });
});

describe('PI-1 B — the owner with a live session is unaffected', () => {
  it('B8. the identical body plus the real session cookie creates the claim', async () => {
    const r = await api('/api/claims/submit', { token: TOKEN, body: submitBody(ITEM_ID) });

    expect(r.status).toBe(200);
    expect(r.body?.success).toBe(true);
    createdClaimId = String(r.body?.claim?.id || '');
    expect(createdClaimId).not.toBe('');

    const rows = await claimsForItem(ITEM_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].owner_phone).toBe(PHONE);
    expect(rows[0].status).toBe('pending_verification');
  });

  it('B9. the claim-OTP journey still works with NO cookie at all', async () => {
    expect(createdClaimId).not.toBe('');
    sms.sent.length = 0;

    const otp = await api(`/api/claims/${createdClaimId}/request-otp`, { body: { phone: PHONE } });
    // NOT 401: the boundary applies to claim CREATION only.
    expect(otp.status).toBe(200);
    expect(otp.body?.success).toBe(true);

    const code = sms.sent.length ? sms.sent[sms.sent.length - 1].code : '';
    expect(code).toMatch(/^\d{4}$/);

    const verified = await api(`/api/claims/${createdClaimId}/verify-otp`, { body: { code } });
    expect(verified.status).toBe(200);
    expect(verified.body?.success).toBe(true);
    // Anonymous: the additive account link simply does not happen.
    expect(verified.body?.linked).toBe(false);
    expect((await db.getClaim(createdClaimId)).status).toBe('awaiting_agent_confirmation');
  });
});

