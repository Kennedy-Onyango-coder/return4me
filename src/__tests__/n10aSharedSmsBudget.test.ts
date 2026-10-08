// =============================================================================
// N10-A — SHARED SMS BUDGET COMPLETENESS (real production routes)
// =============================================================================
//
// WHY THIS FILE EXISTS
//   `POST /api/customer/profile/identity` was the one customer-facing SMS
//   producer mounted WITHOUT the shared N6 SMS budget: it carried only
//   `requireCustomerAuth`, so an authenticated customer could trigger an
//   unbounded number of PHONE_VERIFICATION_OTP messages. Its only guard was the
//   identifier-collision 409, which deliberately EXCLUDES the caller's own id —
//   so repeating the request with the same number was always allowed.
//
// WHAT IS PROVEN HERE, AND WHY IT IS NOT ANOTHER SYNTHETIC APP
//   The N6 suite already proves the limiter middleware in isolation on a bare
//   `express()` app. That cannot catch this class of defect, because the defect
//   was a MOUNTING omission in production code. So this file mounts the REAL
//   route modules — `registerCustomerAccountRoutes` and
//   `registerCustomerClaimRoutes` — behind the REAL `requireCustomerAuth`, and
//   drives real requests over a real socket. If the limiter is ever unmounted
//   from the identity route, these tests fail.
//
// THE SHARED BUDGET IS PROVEN ACROSS TWO REAL PRODUCERS
//   Test C spends part of the 3-per-10-minutes budget through the claim-link
//   OTP route (`/api/customer/claims/link/request-otp`, CLAIM_LINK_OTP) and
//   then through `/api/customer/profile/identity` (PHONE_VERIFICATION_OTP),
//   showing both draw from ONE bucket. Neither route's limiter is stubbed,
//   spied on, or replaced: they are the same `smsRateLimit()` the application
//   uses in production.
//
// IDENTITY
//   Every request is a genuine session cookie for a real customer. Nothing is
//   taken from a body or query for the purpose of rate-limit identity; the
//   client IP is varied only to give each scenario its own bucket, which is the
//   same isolation the N6 and customer-claims suites already use.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { readFileSync } from 'fs';
import { db } from '../db/database';
import { hashCode } from '../services/auth';
import { CUSTOMER_SESSION_COOKIE } from '../services/customerAuth';
import { registerCustomerAccountRoutes } from '../routes/customerAccount';
import { registerCustomerClaimRoutes } from '../routes/customerClaims';
import { __setEmailProvider } from '../services/notificationService';
import { IDENTITY_EMAIL_RATE_LIMIT_MESSAGE } from '../services/identityChangeRateLimit';

const RUN = Math.floor(100000 + Math.random() * 899999).toString(36).toUpperCase();

/**
 * One customer PER SCENARIO, each with its own session and its own phone.
 *
 * The shared budget is consumed on BOTH dimensions — the client IP and the
 * session-verified customer id — and `consumeSmsRateLimit` deliberately charges
 * every dimension. Reusing one customer across scenarios would therefore let an
 * earlier test starve a later one (an early finding while writing this file:
 * test A's single request left the shared customer only two slots, so test B saw
 * 200/200/429/429). A distinct customer AND a distinct IP per scenario is what
 * makes each assertion about exactly one thing. Test D is the deliberate
 * counter-example: a different principal must not inherit another's budget.
 */
function scenario(i: number) {
  return {
    id: 'TEST-N10A-CUS' + i + '-' + RUN,
    token: (String(i % 10) + 'x').repeat(32),
    phone: '+2547' + String(10000000 + i * 137 + Math.floor(Math.random() * 8000)).slice(-8),
    session: 'TEST-N10A-SESS' + i + '-' + RUN,
  };
}

const A = scenario(1);
const B = scenario(2);
const C = scenario(3);
const D = scenario(4);
const E = scenario(5);

/**
 * E1: the verified address each scenario's account owns — the SERVER-RESOLVED
 * destination every code is delivered to now (derived from the id, so unique per
 * run and safe against the partial unique index on email).
 */
const emailFor = (who: { id: string }) => `${who.id.toLowerCase()}@example.test`;

/** The claim owned by C's registered number, used by the cross-producer test. */
const ITEM_C = 'TEST-N10A-ITEM-C-' + RUN;
const CLAIM_C = 'TEST-N10A-CLAIM-C-' + RUN;

/** Codes the identity route asked to be delivered, so a refusal can be proven not to send. */
const sentCodes: Array<{ destination: string; kind: string }> = [];

let server: any;
let baseUrl = '';

/** Post to a real route as a real session cookie from a chosen client IP. */
async function postAs(
  path: string,
  token: string,
  body: any,
  ip: string,
): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(baseUrl + path, {
    method: 'POST',
    headers: {
      cookie: CUSTOMER_SESSION_COOKIE + '=' + token,
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
  return { status: res.status, body: parsed, headers: res.headers };
}

/** A phone identity change — the SMS-spending branch of the identity route. */
function phoneChange(ip: string, who: { token: string; phone: string }, phone?: string) {
  return postAs('/api/customer/profile/identity', who.token, { kind: 'phone', value: phone ?? who.phone }, ip);
}

const RATE_LIMIT_MESSAGE =
  'Too many SMS requests. Please wait before trying again.';
beforeAll(async () => {
  const week = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  for (const who of [A, B, C, D, E]) {
    // E1: every one-time code is delivered to the account's own VERIFIED EMAIL,
    // so each fixture principal needs one. The real production pair
    // (createCustomerPendingActivation + activateCustomerAccount) is the only
    // writer of that state.
    await db.createCustomerPendingActivation(who.id, 'N10-A ' + who.id, who.phone, emailFor(who));
    await db.activateCustomerAccount(who.id);
    await db.createCustomerSession(who.session, who.id, hashCode(who.token), week);
  }
  // The email provider is a CAPTURE adapter, exactly as the SMS provider is in
  // the N6/N7 suites: dispatch SUCCEEDS, so what these tests measure is the
  // budget and the route behaviour, never a missing credential. The real seam is
  // untouched, so a genuine notification_events row is still written.
  __setEmailProvider({
    name: 'capture-n10a',
    async send() {
      return { accepted: true, providerMessageId: null, error: null };
    },
  });

  // A claim owned by C's registered number and NOT yet linked, so the claim-link
  // OTP route reaches its real SMS dispatch in the cross-producer test.
  await db.createItem({
    id: ITEM_C,
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
    id: CLAIM_C,
    item_id: ITEM_C,
    owner_phone: C.phone,
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
    sendVerificationCode: async (input) => {
      sentCodes.push({ destination: input.destination, kind: input.kind });
      return true;
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

describe('N10-A — the identity route spends the shared SMS budget', () => {
  it('A: an authenticated customer may still request a phone identity change', async () => {
    const before = sentCodes.length;
    const res = await phoneChange('10.60.0.1', A);
    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);
    // The existing flow is untouched: a changeId is returned and a verification
    // code really was handed to the delivery seam — addressed to the account's
    // own verified email (E1: the new number is never a delivery destination).
    expect(typeof res.body?.changeId).toBe('string');
    expect(sentCodes.length).toBe(before + 1);
    expect(sentCodes[sentCodes.length - 1].destination).toBe(emailFor(A));
  });

  it('B: the fourth request from the same principal and IP is refused with the standard 429', async () => {
    const ip = '10.60.0.2';
    const before = sentCodes.length;

    const statuses: number[] = [];
    let fourth: any = null;
    for (let i = 0; i < 4; i++) {
      const res = await phoneChange(ip, B);
      statuses.push(res.status);
      if (i === 3) fourth = res;
    }

    expect(statuses).toEqual([200, 200, 200, 429]);
    // The EXISTING generic bilingual body — identical for every cause, so it
    // cannot be used to discover whether an account or number is known.
    expect(fourth.body?.error).toBe(RATE_LIMIT_MESSAGE);
    expect(fourth.headers.get('retry-after')).toBeTruthy();
    // The refusal spent no provider call: three sends, not four.
    expect(sentCodes.length).toBe(before + 3);
  });

  it('C: it shares ONE budget with the real claim-link OTP producer', async () => {
    const ip = '10.60.0.3';

    // Producer A: a genuine CLAIM_LINK_OTP through the real claim-link route.
    const link = await postAs(
      '/api/customer/claims/link/request-otp',
      C.token,
      { claimId: CLAIM_C },
      ip,
    );
    expect(link.status).toBe(200);

    // Producer B: the identity route draws on what A left. One + two = three,
    // which is the whole budget, so the next request must be refused.
    expect((await phoneChange(ip, C)).status).toBe(200);
    expect((await phoneChange(ip, C)).status).toBe(200);

    // The fourth request across BOTH producers is refused, proving the two
    // routes are governed by one 3-per-10-minutes bucket rather than one each.
    const fourth = await phoneChange(ip, C);
    expect(fourth.status).toBe(429);
    expect(fourth.body?.error).toBe(RATE_LIMIT_MESSAGE);
  });

  it('D: a different legitimate principal does not inherit the first customer budget', async () => {
    // C's budget is exhausted by the test above. D is a different customer AND a
    // different client IP, so neither the user nor the IP dimension is shared.
    const res = await phoneChange('10.60.0.4', D);
    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);
  });

  it('E: email changes spend no SMS budget, and are metered by their own', async () => {
    // E1-H2: an email identity change now has its OWN budget (3 per rolling 10
    // minutes), so four attempts from one account are 200/200/200/429 and the
    // refusal dispatches nothing. What must ALSO stay true is the N10-A property
    // this test has always asserted: the email branch never charges the SHARED
    // SMS budget — proven here by still being allowed a shared-budget phone
    // change after the email budget is exhausted.
    const ip = '10.60.0.5';
    const before = sentCodes.length;

    const statuses: number[] = [];
    let refused: any = null;
    for (let i = 0; i < 4; i++) {
      const res = await postAs(
        '/api/customer/profile/identity',
        E.token,
        { kind: 'email', value: `n10a-${RUN}-${i}@example.test` },
        ip,
      );
      statuses.push(res.status);
      if (i === 3) refused = res;
    }

    expect(statuses).toEqual([200, 200, 200, 429]);
    // The refusal carries the email-change budget's own generic body — not the
    // SMS wording, which would misdescribe the channel — plus the standard
    // Retry-After the other limiters emit.
    expect(refused.body?.error).toBe(IDENTITY_EMAIL_RATE_LIMIT_MESSAGE);
    expect(refused.body?.error).not.toBe(RATE_LIMIT_MESSAGE);
    expect(refused.headers.get('retry-after')).toBeTruthy();
    // Three dispatches, not four: a refused request never reaches the seam.
    expect(sentCodes.length).toBe(before + 3);
    // Every dispatched code went to the NEW address being proved. The route
    // normalizes the address before it becomes a destination, so the comparison
    // is against the normalized (lowercased) form of this run's marker.
    expect(sentCodes[sentCodes.length - 1].destination).toContain('n10a-' + RUN.toLowerCase());

    // THE SHARED BUDGET IS UNTOUCHED BY ALL OF THAT: this phone change draws on
    // it and is still admitted. Had the four email requests charged it (three is
    // the whole allowance), this request would have been refused with the SMS
    // message instead.
    const phone = await phoneChange(ip, E);
    expect(phone.status).toBe(200);
    expect(phone.body?.error).toBeUndefined();
  });

  it('F: the route mounts the shared limiter rather than a second one', () => {
    // The behavioural tests above already prove the limiter is MOUNTED on the
    // real route. This guards the "reuse, do not reinvent" requirement: the
    // route consumes the exported shared middleware and declares no numeric
    // budget of its own, so the 3-per-10-minutes semantics stay in one place.
    const source = readFileSync(new URL('../routes/customerAccount.ts', import.meta.url), 'utf8');
    expect(source).toContain("import { smsRateLimit } from '../services/smsRateLimit.ts'");
    expect(source).toMatch(/smsRateLimit\(\)/);
    expect(source).not.toMatch(/SMS_RATE_LIMIT\s*=|WINDOW_MS\s*=|10\s*\*\s*60\s*\*\s*1000/);
  });
});