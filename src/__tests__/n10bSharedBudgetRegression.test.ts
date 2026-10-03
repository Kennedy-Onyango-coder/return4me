// =============================================================================
// N10-B — REAL-ROUTE SHARED SMS BUDGET REGRESSION
// =============================================================================
//
// N10-A made `/api/customer/profile/identity` participate in the shared N6 SMS
// budget. N10-B is the regression that keeps it that way.
//
// WHAT IS ALREADY PROVEN BY n10aSharedSmsBudget.test.ts (not duplicated here)
//   * Test B — a single producer: 200/200/200/429, with the injected delivery
//     seam counting three sends rather than four.
//   * Test C — cross-producer HTTP status sharing one bucket.
//   * Test D — a different principal does not inherit an exhausted bucket.
//   * Test E — an email identity change spends no SMS budget.
//   * Test F — the route mounts the shared middleware and defines no quota.
//
// THE GAP THIS FILE CLOSES, AND WHY IT IS A REAL ONE
//   N10-A test B counts dispatches through the `sendVerificationCode` seam that
//   the identity route's dependency injection exposes. That seam covers the
//   IDENTITY producer only. The claim-link producer dispatches through its own
//   internal seam inside routes/customerClaims.ts, so in a cross-producer
//   scenario N10-A can assert the fourth request is refused but cannot assert
//   that the refusal dispatched nothing, nor that both producers really
//   dispatched rather than one silently no-opping.
//
//   This file observes dispatch through the DURABLE, PRODUCTION record instead:
//   `notification_events`, the row N5 writes for every real dispatch and the
//   exact table the limiter's own contract talks about ("No notification_events
//   row is created, so a refused request can never be recorded as a `sent`
//   notification"). Nothing is mocked, stubbed or counted through a seam: the
//   rows are the application's own audit trail, so this is an end-to-end
//   assertion over real routes and the real notification service.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { readFileSync } from 'fs';
import { db } from '../db/database';
import { hashCode } from '../services/auth';
import { CUSTOMER_SESSION_COOKIE } from '../services/customerAuth';
import { registerCustomerAccountRoutes } from '../routes/customerAccount';
import { registerCustomerClaimRoutes } from '../routes/customerClaims';
import { recipientReferenceFor } from '../services/notificationService';
import { sendSmsNotification, newSmsIssuanceId } from '../services/smsNotification';

const RUN = Math.floor(100000 + Math.random() * 899999).toString(36).toUpperCase();

/**
 * One principal PER SCENARIO, exactly as n10aSharedSmsBudget.test.ts does.
 *
 * The shared budget is charged on BOTH the client IP and the session-verified
 * customer id, and `consumeSmsRateLimit` deliberately charges every dimension. A
 * single customer reused across scenarios would therefore let the first test's
 * exhaustion mask the next test's first request (observed while writing this
 * file: a second scenario came back 429/429/429/429 purely from the user
 * dimension). Distinct customer AND distinct IP per scenario keeps each
 * assertion about exactly one property.
 */
function principal(i: number) {
  return {
    id: 'TEST-N10B-CUS' + i + '-' + RUN,
    token: (String(i % 10) + 'b').repeat(32),
    phone: '+2547' + String(10000000 + i * 911 + Math.floor(Math.random() * 7000)).slice(-8),
    session: 'TEST-N10B-SESS' + i + '-' + RUN,
    item: 'TEST-N10B-ITEM' + i + '-' + RUN,
    claim: 'TEST-N10B-CLAIM' + i + '-' + RUN,
  };
}

/** Scenario 1 drives both real SMS producers; 2 and 3 need only the identity route. */
const P1 = principal(1);
const P2 = principal(2);
const P3 = principal(3);

let server: any;
let baseUrl = '';

/** Every status the lifecycle CHECK admits, so nothing dispatched can hide. */
const ALL_STATUSES = [
  'pending', 'sending', 'sent', 'failed', 'retryable_failure',
  'permanent_failure', 'unknown', 'cancelled', 'fallback_available',
  'fallback_requested', 'fallback_sent',
];

/**
 * The real, durable dispatch record for ONE recipient, read straight from the
 * production read model.
 *
 * `recipient_reference` is deliberately NOT the raw phone: notificationService
 * writes the opaque masked handle from `recipientReferenceFor`, so a leaked
 * audit row never carries an address. The test therefore derives the same handle
 * with the same exported function instead of comparing against the phone, which
 * also scopes the count to this scenario's unique number so concurrent test
 * files cannot pollute it.
 */
async function dispatchedFor(eventType: string, phone: string): Promise<number> {
  const rows = await db.listNotificationEventsByStatus({
    statuses: ALL_STATUSES,
    eventType,
    limit: 500,
  });
  const masked = recipientReferenceFor(phone, 'sms');
  return rows.filter((r: any) => r.recipient_reference === masked).length;
}

async function post(path: string, who: { token: string }, body: any, ip: string) {
  const res = await fetch(baseUrl + path, {
    method: 'POST',
    headers: {
      cookie: CUSTOMER_SESSION_COOKIE + '=' + who.token,
      'content-type': 'application/json',
      'x-forwarded-for': ip,
    },
    body: JSON.stringify(body),
  });
  let parsed: any = null;
  try {
    parsed = await res.json();
  } catch {
    /* not json */
  }
  return { status: res.status, body: parsed };
}

beforeAll(async () => {
  const week = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  for (const who of [P1, P2, P3]) {
    await db.createCustomer(who.id, 'N10-B ' + who.id, who.phone);
    await db.createCustomerSession(who.session, who.id, hashCode(who.token), week);
  }

  // P1 also owns a claim on its registered number, not yet linked, so the
  // claim-link OTP route reaches its genuine dispatch.
  await db.createItem({
    id: P1.item,
    category_id: 'national-id',
    photo_url: 'photo.jpg',
    document_name_fuzzy: 'National ID',
    location_description: 'Nairobi CBD',
    latitude: null,
    longitude: null,
    finder_phone: '+254700000000',
    assigned_agent_id: null,
    status: 'at_agent',
  } as any);
  await db.createClaim({
    id: P1.claim,
    item_id: P1.item,
    owner_phone: P1.phone,
    security_answers: [{ q: 'q', a: 'a' }],
    verification_tier: 1,
    status: 'at_agent',
  } as any);

  const app = express();
  // The shared budget keys on req.ip, which Express only derives from
  // X-Forwarded-For when the proxy is trusted — the N6 suite's own arrangement.
  app.set('trust proxy', 1);
  app.use(express.json());
  registerCustomerAccountRoutes(app, {
    // The REAL delivery seam, mirroring server.ts: a phone identity change goes
    // through sendSmsNotification exactly as production does, so it writes a
    // genuine PHONE_VERIFICATION_OTP row in notification_events. Stubbing this
    // to a no-op would make the durable accounting below vacuous — the claim-link
    // producer already writes its own row, so an identity stub would simply
    // contribute nothing, which is exactly the false "shared bucket" outcome
    // this file exists to rule out.
    //
    // The provider itself is untouched: the suite runs in the existing
    // console-only fallback, so no external SMS service is contacted.
    sendVerificationCode: async ({ destination, code, kind }) => {
      if (kind !== 'phone') return true;
      const outcome = await sendSmsNotification({
        eventType: 'PHONE_VERIFICATION_OTP',
        recipient: destination,
        issuanceId: newSmsIssuanceId('N10B'),
        seam: 'code',
        code,
        // Required by SmsNotificationInput. The live body for `seam: 'code'` is
        // built by the provider from the code; this is the console/sandbox line.
        message: `Msimbo wa uthibitisho wa Return4me ni ${code}. / Your Return4me verification code is ${code}.`,
      });
      return outcome.accepted;
    },
  });
  registerCustomerClaimRoutes(app, {
    checkClaimExpiry: async (claim: any) => claim,
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  baseUrl = 'http://127.0.0.1:' + (typeof address === 'object' && address ? address.port : 0);
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});
describe('N10-B — the shared budget spans real producers, and a refusal dispatches nothing', () => {
  it('CLAIM_LINK_OTP and PHONE_VERIFICATION_OTP draw one 3-per-10-minute bucket', async () => {
    // One principal, one client IP, two DIFFERENT real SMS producers, in the
    // canonical order. The first three are the entire budget; the fourth must be
    // refused no matter which producer it arrives through.
    const ip = '10.70.0.1';

    const linkSmsBefore = await dispatchedFor('CLAIM_LINK_OTP', P1.phone);
    const identitySmsBefore = await dispatchedFor('PHONE_VERIFICATION_OTP', P1.phone);

    // Producer 1 — the real claim-link OTP route.
    const first = await post('/api/customer/claims/link/request-otp', P1, { claimId: P1.claim }, ip);
    expect(first.status).toBe(200);

    // Producer 2 — the real identity route, twice.
    const second = await post('/api/customer/profile/identity', P1, { kind: 'phone', value: P1.phone }, ip);
    expect(second.status).toBe(200);
    const third = await post('/api/customer/profile/identity', P1, { kind: 'phone', value: P1.phone }, ip);
    expect(third.status).toBe(200);

    // The fourth request is refused even though this producer has only been used
    // twice: the bucket is per principal/IP, not per route.
    const fourth = await post('/api/customer/profile/identity', P1, { kind: 'phone', value: P1.phone }, ip);
    expect(fourth.status).toBe(429);

    // And a further request through the OTHER producer is refused too — the
    // budget did not silently refill per route.
    const fourthViaLink = await post('/api/customer/claims/link/request-otp', P1, { claimId: P1.claim }, ip);
    expect(fourthViaLink.status).toBe(429);

    // ---------------------------------------------------------------------
    // DURABLE DISPATCH ACCOUNTING — the part N10-A cannot see.
    //
    // Exactly ONE claim-link SMS and exactly TWO identity SMS were really
    // dispatched, counted from notification_events rather than from a seam.
    // This proves both producers genuinely dispatched (neither silently
    // no-opped and masqueraded as a shared bucket) AND that the two refused
    // requests created NO notification record at all — so a refusal can
    // neither have reached the provider nor left a false "sent" audit trail.
    // ---------------------------------------------------------------------
    expect(await dispatchedFor('CLAIM_LINK_OTP', P1.phone)).toBe(linkSmsBefore + 1);
    expect(await dispatchedFor('PHONE_VERIFICATION_OTP', P1.phone)).toBe(identitySmsBefore + 2);
  });

  it('a refused identity request records no notification and reaches no provider', async () => {
    // The limiter's own documented guarantee, asserted directly: refusal happens
    // BEFORE the provider and BEFORE any durable row, so an exhausted customer
    // cannot accumulate phantom "sent" notifications.
    const ip = '10.70.0.2';
    const before = await dispatchedFor('PHONE_VERIFICATION_OTP', P2.phone);

    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await post('/api/customer/profile/identity', P2, { kind: 'phone', value: P2.phone }, ip)).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);

    // Three dispatches total; the fourth added nothing.
    expect(await dispatchedFor('PHONE_VERIFICATION_OTP', P2.phone)).toBe(before + 3);
  });

  it('email identity changes still spend no SMS budget and record no SMS event', async () => {
    // Regression on the N10-A distinction: a change that never reaches the SMS
    // provider must not be charged to the SMS budget, and must not create an
    // SMS notification record.
    const ip = '10.70.0.3';
    const before = await dispatchedFor('PHONE_VERIFICATION_OTP', P3.phone);

    for (let i = 0; i < 4; i++) {
      const res = await post(
        '/api/customer/profile/identity',
        P3,
        { kind: 'email', value: `n10b-${RUN}-${i}@example.test` },
        ip,
      );
      expect(res.status).toBe(200);
    }

    expect(await dispatchedFor('PHONE_VERIFICATION_OTP', P3.phone)).toBe(before);
  });

  it('an unmounted limiter on the identity route would be caught here', async () => {
    // Structural guard, complementing the behavioural proof above: the real
    // route must still import and mount the SHARED limiter, so the property
    // cannot be quietly deleted at the source.
    const source = readFileSync(new URL('../routes/customerAccount.ts', import.meta.url), 'utf8');
    expect(source).toContain("import { smsRateLimit } from '../services/smsRateLimit.ts'");
    expect(source).toMatch(/smsRateLimit\(\)/);
  });
});