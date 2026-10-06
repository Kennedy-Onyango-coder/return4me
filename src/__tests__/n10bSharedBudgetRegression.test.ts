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
import { recipientReferenceFor, __setEmailProvider } from '../services/notificationService';
import { sendEmailOtp, newEmailOtpIssuanceId } from '../services/emailOtp';

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

/** Scenario 1 drives both real metered producers; 2 and 3 need only the identity route. */
const P1 = principal(1);
const P2 = principal(2);
const P3 = principal(3);

/**
 * E1: the verified address each principal's account owns — the SERVER-RESOLVED
 * destination every one-time code is delivered to now (derived from the id, so
 * unique per run and safe against the partial unique index on email).
 */
const emailFor = (who: { id: string }) => `${who.id.toLowerCase()}@example.test`;

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
 * `recipient_reference` is deliberately NOT the raw address: notificationService
 * writes the opaque masked handle from `recipientReferenceFor`, so a leaked
 * audit row never carries an address. The test therefore derives the same handle
 * with the same exported function instead of comparing against the address,
 * which also scopes the count to this scenario's unique recipient so concurrent
 * test files cannot pollute it.
 *
 * E1: the channel is a parameter now, because the routed code events moved from
 * SMS to email — the mask is computed per channel.
 */
async function dispatchedFor(
  eventType: string,
  recipient: string,
  channel: 'email' | 'sms' = 'email',
): Promise<number> {
  const rows = await db.listNotificationEventsByStatus({
    statuses: ALL_STATUSES,
    eventType,
    limit: 500,
  });
  const masked = recipientReferenceFor(recipient, channel);
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
    // E1: every one-time code is delivered to the account's own VERIFIED EMAIL,
    // so each fixture principal needs one. The real production pair
    // (createCustomerPendingActivation + activateCustomerAccount) is the only
    // writer of that state.
    await db.createCustomerPendingActivation(who.id, 'N10-B ' + who.id, who.phone, emailFor(who));
    await db.activateCustomerAccount(who.id);
    await db.createCustomerSession(who.session, who.id, hashCode(who.token), week);
  }
  // The email provider is a CAPTURE adapter: dispatch SUCCEEDS, so the durable
  // accounting below measures the application's own audit trail and never a
  // missing credential. Nothing else is doubled.
  __setEmailProvider({
    name: 'capture-n10b',
    async send() {
      return { accepted: true, providerMessageId: null, error: null };
    },
  });

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
    // The REAL delivery seam, mirroring server.ts: E1 routes an identity change
    // through the shared email OTP seam, so this writes a genuine
    // IDENTITY_CHANGE_OTP_EMAIL row in notification_events. Stubbing this to a
    // no-op would make the durable accounting below vacuous — the claim-link
    // producer already writes its own row, so an identity stub would simply
    // contribute nothing, which is exactly the false "shared bucket" outcome
    // this file exists to rule out.
    //
    // The destination is resolved by the route (verified email for a phone
    // change, the new address for an email change) and is never taken from the
    // body here.
    sendVerificationCode: async ({ destination, code, kind }) => {
      const outcome = await sendEmailOtp({
        eventType: 'IDENTITY_CHANGE_OTP_EMAIL',
        recipient: destination,
        issuanceId: newEmailOtpIssuanceId('N10B'),
        code,
        purpose: kind === 'phone' ? 'identity_change_phone' : 'identity_change_email',
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
  it('CLAIM_LINK_OTP_EMAIL and IDENTITY_CHANGE_OTP_EMAIL draw one 3-per-10-minute bucket', async () => {
    // One principal, one client IP, two DIFFERENT real producers, in the
    // canonical order. The first three are the entire budget; the fourth must be
    // refused no matter which producer it arrives through.
    const ip = '10.70.0.1';

    const linkBefore = await dispatchedFor('CLAIM_LINK_OTP_EMAIL', emailFor(P1));
    const identityBefore = await dispatchedFor('IDENTITY_CHANGE_OTP_EMAIL', emailFor(P1));

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
    // Exactly ONE claim-link code and exactly TWO identity codes were really
    // dispatched, counted from notification_events rather than from a seam.
    // This proves both producers genuinely dispatched (neither silently
    // no-opped and masqueraded as a shared bucket) AND that the two refused
    // requests created NO notification record at all — so a refusal can
    // neither have reached the provider nor left a false "sent" audit trail.
    // ---------------------------------------------------------------------
    expect(await dispatchedFor('CLAIM_LINK_OTP_EMAIL', emailFor(P1))).toBe(linkBefore + 1);
    expect(await dispatchedFor('IDENTITY_CHANGE_OTP_EMAIL', emailFor(P1))).toBe(identityBefore + 2);
  });

  it('a refused identity request records no notification and reaches no provider', async () => {
    // The limiter's own documented guarantee, asserted directly: refusal happens
    // BEFORE the provider and BEFORE any durable row, so an exhausted customer
    // cannot accumulate phantom "sent" notifications.
    const ip = '10.70.0.2';
    const before = await dispatchedFor('IDENTITY_CHANGE_OTP_EMAIL', emailFor(P2));

    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await post('/api/customer/profile/identity', P2, { kind: 'phone', value: P2.phone }, ip)).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);

    // Three dispatches total; the fourth added nothing.
    expect(await dispatchedFor('IDENTITY_CHANGE_OTP_EMAIL', emailFor(P2))).toBe(before + 3);
  });

  it('email identity changes use their OWN budget and never draw on the shared one', async () => {
    // E1-H2: the email branch is now metered — by its OWN 3-per-10-minutes
    // budget — so a fourth consecutive request from one principal is refused,
    // and a refusal dispatches nothing. What is unchanged is the N10-A
    // distinction: none of these requests touched the shared code budget, which
    // is proven at the end of the test rather than asserted from memory.
    const ip = '10.70.0.3';
    const targets = [0, 1, 2, 3].map((i) => `n10b-${RUN}-${i}@example.test`);
    const statuses: number[] = [];

    for (const target of targets) {
      // Counted as a DELTA per request: the durable table is shared across runs in
      // the sandbox database, so an absolute count would depend on history rather
      // than on this request. The property is one dispatch per ADMITTED request,
      // and none at all for a refused one.
      const before = await dispatchedFor('IDENTITY_CHANGE_OTP_EMAIL', target);
      const res = await post(
        '/api/customer/profile/identity',
        P3,
        { kind: 'email', value: target },
        ip,
      );
      statuses.push(res.status);
      expect(await dispatchedFor('IDENTITY_CHANGE_OTP_EMAIL', target)).toBe(
        res.status === 200 ? before + 1 : before,
      );
    }

    // Admitted three times by the email budget, refused by it on the fourth —
    // and, crucially, the refused one is refused no matter which address it
    // named, because the ACCOUNT dimension is charged on every request.
    expect(statuses).toEqual([200, 200, 200, 429]);

    // The shared code budget was never charged by any of the four: this phone
    // change draws on it and is still admitted (its allowance is three, so four
    // prior charges would have refused it).
    const phone = await post(
      '/api/customer/profile/identity',
      P3,
      { kind: 'phone', value: P3.phone },
      ip,
    );
    expect(phone.status).toBe(200);
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