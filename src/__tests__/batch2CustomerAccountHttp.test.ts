import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { readFileSync } from 'fs';
import type { Server } from 'http';
import { db } from '../db/database';
import { hashCode } from '../services/auth';
import { CUSTOMER_SESSION_COOKIE, CUSTOMER_OTP_MAX_ATTEMPTS } from '../services/customerAuth';
import { CUSTOMER_ACCOUNT_STRINGS, IDENTITY_CHANGE_MAX_VERIFICATION_ATTEMPTS } from '../config/customerAccountPolicy';
import { registerCustomerAccountRoutes } from '../routes/customerAccount';
import { db as drizzleDb } from '../db/index.ts';
import { customer_otps as customerOtpsTable } from '../db/schema.ts';
import { eq } from 'drizzle-orm';

// D-1D — the erasure handler is also read as SOURCE. "Is this comparison
// timing-safe?" is a property of the code, not of any response: a byte-wise
// comparison and a constant-time one return the same status, the same body and
// the same charge for the same wrong code, and differ only in latency. So the
// mechanism is pinned statically (the pattern n10aSharedSmsBudget and
// paymentAuthGate already use for exactly this kind of unobservable guarantee),
// while the scenarios below pin the unchanged behaviour.
const accountRouteSource = readFileSync(
  new URL('../routes/customerAccount.ts', import.meta.url),
  'utf8',
);

// HTTP INTEGRATION TESTS - customer account data & session security.
//
// A REAL Express app around the REAL requireCustomerAuth middleware and the REAL
// handlers, driven over a real TCP socket. That is the smallest harness that can
// prove the boundary: a request with no cookie, or with a cookie for a DIFFERENT
// customer, has to be rejected by the middleware and the query layer themselves.
// Asserting against source text cannot demonstrate that.
//
// server.ts is deliberately NOT imported (it boots the application at import
// time); routes/customerAccount.ts exists so the real handlers can be mounted in
// isolation.

const RUN = Math.floor(100000 + Math.random() * 899999).toString(36).toUpperCase();
const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);
const CUS_A = 'TEST-B2-CUS-A-' + RUN;
const CUS_B = 'TEST-B2-CUS-B-' + RUN;
const PHONE_A = '+2547' + String(10000000 + Math.floor(Math.random() * 89999999)).slice(-8);
const PHONE_B = '+2547' + String(10000000 + Math.floor(Math.random() * 89999999)).slice(-8);

/** Codes handed to the injected sender, so a test can redeem a real one. */
const sent: Array<{ destination: string; code: string; kind: string }> = [];

let server: Server;
let baseUrl = '';

async function get(path: string, token?: string) {
  return fetch(baseUrl + path, {
    headers: token ? { cookie: CUSTOMER_SESSION_COOKIE + '=' + token } : {},
  });
}

async function send(method: string, path: string, token: string | undefined, body?: any, ip?: string) {
  return fetch(baseUrl + path, {
    method,
    headers: {
      ...(token ? { cookie: CUSTOMER_SESSION_COOKIE + '=' + token } : {}),
      'content-type': 'application/json',
      // Rate-limit identity: only the cases that pass an explicit IP are
      // isolated from one another, so every pre-existing request above continues
      // to arrive from 127.0.0.1. E1-H2 metered the email identity-change branch
      // on the session CUSTOMER and on the client IP, so the scenarios below that
      // exercise that branch declare their own client IP — the same
      // per-scenario isolation n10aSharedSmsBudget.test.ts documents.
      ...(ip ? { 'x-forwarded-for': ip } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  await db.createCustomer(CUS_A, 'Batch Two Customer A', PHONE_A);
  await db.createCustomer(CUS_B, 'Batch Two Customer B', PHONE_B);
  const week = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await db.createCustomerSession('TEST-B2-SESS-A-' + RUN, CUS_A, hashCode(TOKEN_A), week, 'Mozilla/5.0 (Windows NT 10.0) Chrome/120');
  await db.createCustomerSession('TEST-B2-SESS-B-' + RUN, CUS_B, hashCode(TOKEN_B), week, 'Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile');

  const app = express();
  // N10-A: the shared SMS budget keys on req.ip, which Express only derives from
  // X-Forwarded-For when the proxy is trusted. Mirrors the N6 rate-limit suite.
  app.set('trust proxy', 1);
  app.use(express.json());
  registerCustomerAccountRoutes(app, {
    // Captured rather than delivered: the account layer decides WHAT must be
    // verified, and these tests are about the authorization and identity rules,
    // not about delivery.
    sendVerificationCode: async (input) => {
      sent.push({ destination: input.destination, code: input.code, kind: input.kind });
      return true;
    },
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
});

describe('B2 HTTP - authentication is required', () => {
  it('rejects the session list with no cookie', async () => {
    expect((await get('/api/customer/sessions')).status).toBe(401);
  });

  it('rejects revoke-others with no cookie', async () => {
    expect((await send('POST', '/api/customer/sessions/revoke-others', undefined)).status).toBe(401);
  });

  it('rejects the data export with no cookie', async () => {
    expect((await get('/api/customer/data-export')).status).toBe(401);
  });

  it('rejects a profile update with no cookie', async () => {
    expect((await send('PATCH', '/api/customer/profile', undefined, { fullName: 'X' })).status).toBe(401);
  });

  it('rejects an identity change with no cookie', async () => {
    expect(
      (await send('POST', '/api/customer/profile/identity', undefined, { kind: 'email', value: 'a@b.test' })).status,
    ).toBe(401);
  });

  it('rejects erasure with no cookie', async () => {
    expect(
      (await send('POST', '/api/customer/account/erasure', undefined, { code: '123456', confirm: true })).status,
    ).toBe(401);
  });
});

describe('B2 HTTP - sessions (H9)', () => {
  it('lists the customer own session and marks it current', async () => {
    const res = await get('/api/customer/sessions', TOKEN_A);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessions.length).toBeGreaterThanOrEqual(1);
    expect(body.sessions.some((s: any) => s.current)).toBe(true);
  });

  it('never exposes the token hash or the raw device string', async () => {
    const text = await (await get('/api/customer/sessions', TOKEN_A)).text();
    expect(text).not.toContain('token_hash');
    expect(text).not.toContain(hashCode(TOKEN_A));
    expect(text).not.toContain('Mozilla');
    expect(text).not.toContain('Chrome/120');
  });

  it('shows a customer-friendly device label instead', async () => {
    const body = await (await get('/api/customer/sessions', TOKEN_A)).json();
    expect(body.sessions[0].device).toBeTruthy();
  });

  it('customer B never sees customer A sessions', async () => {
    const a = await (await get('/api/customer/sessions', TOKEN_A)).text();
    const b = await (await get('/api/customer/sessions', TOKEN_B)).json();
    expect(b.sessions.every((s: any) => typeof s.id === 'string')).toBe(true);
    // B's list must not contain A's session id.
    const aIds = (JSON.parse(a).sessions as any[]).map((s) => s.id);
    for (const s of b.sessions) expect(aIds).not.toContain(s.id);
  });
});

describe('B2 HTTP - data export (G1)', () => {
  it('returns the customer own account', async () => {
    const res = await get('/api/customer/data-export', TOKEN_A);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.account.id).toBe(CUS_A);
  });

  it('carries no secret, credential or infrastructure field', async () => {
    const text = (await (await get('/api/customer/data-export', TOKEN_A)).text()).toLowerCase();
    for (const banned of ['token_hash', 'code_hash', 'password', 'secret', 'provider', 'webhook', 'retry', 'user_agent', 'ocr', 'idempotency']) {
      expect(text).not.toContain(banned);
    }
  });

  it('exposes no other customer data', async () => {
    const text = await (await get('/api/customer/data-export', TOKEN_A)).text();
    expect(text).not.toContain(CUS_B);
    expect(text).not.toContain(PHONE_B);
  });

  it('is machine-readable JSON', async () => {
    const res = await get('/api/customer/data-export', TOKEN_A);
    expect(res.headers.get('content-type')).toContain('application/json');
    const text = await res.text();
    expect(() => JSON.parse(text)).not.toThrow();
  });

});
describe('B2 HTTP - revoke other sessions (H9-b)', () => {
  it('keeps the current session usable and kills the others', async () => {
    // A second session for A, then A signs out everywhere else.
    const extraToken = 'c'.repeat(64);
    await db.createCustomerSession('TEST-B2-EXTRA-' + RUN, CUS_A, hashCode(extraToken), new Date(Date.now() + 86400000));
    const bBefore = await get('/api/customer/sessions', TOKEN_B);

    const res = await send('POST', '/api/customer/sessions/revoke-others', TOKEN_A);
    expect(res.status).toBe(200);
    expect((await res.json()).revoked).toBeGreaterThanOrEqual(1);

    // A's current session still authenticates.
    expect((await get('/api/customer/sessions', TOKEN_A)).status).toBe(200);
    // A's other session does not.
    expect((await get('/api/customer/sessions', extraToken)).status).toBe(401);
    // B is entirely unaffected.
    expect((await bBefore).status).toBe(200);
    expect((await get('/api/customer/sessions', TOKEN_B)).status).toBe(200);
  });

  it('is safely repeatable', async () => {
    const res = await send('POST', '/api/customer/sessions/revoke-others', TOKEN_A);
    expect(res.status).toBe(200);
    expect((await res.json()).revoked).toBe(0);
    expect((await get('/api/customer/sessions', TOKEN_A)).status).toBe(200);
  });
});

describe('B2 HTTP - profile (G3)', () => {
  /**
   * A FRESH authenticated customer for ONE scenario.
   *
   * E1-H2 metered this endpoint's email branch on the session-verified CUSTOMER
   * and on the client IP, so reusing one account (or one client address) across
   * scenarios would exhaust the shared 3-per-10-minutes allowance and a later
   * assertion would observe a 429 instead of the property under test. One
   * principal and one client IP per scenario is the remedy
   * n10aSharedSmsBudget.test.ts already documents for the same limiter.
   */
  let scenario = 0;
  async function freshPrincipal() {
    scenario += 1;
    const id = 'TEST-B2-P' + scenario + '-' + RUN;
    const token = (String(scenario % 10) + 'p').repeat(32);
    const phone = '+2547' + String(70000000 + scenario * 6151 + Math.floor(Math.random() * 5000)).slice(-8);
    // Each scenario also gets its OWN client address. E1-H2 charges the client IP
    // dimension on every request, so two scenarios sharing 127.0.0.1 would starve
    // one another even with distinct principals — the same per-scenario isolation
    // n10aSharedSmsBudget.test.ts documents.
    const ip = '10.20.0.' + scenario;
    const week = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db.createCustomer(id, 'Batch Two Principal ' + scenario, phone);
    await db.createCustomerSession('TEST-B2-PS' + scenario + '-' + RUN, id, hashCode(token), week);
    return { id, token, phone, ip };
  }

  it('updates the name', async () => {
    const res = await send('PATCH', '/api/customer/profile', TOKEN_A, { fullName: 'Renamed Person' });
    expect(res.status).toBe(200);
    expect((await res.json()).customer.full_name).toBe('Renamed Person');
  });

  it('rejects an empty name', async () => {
    expect((await send('PATCH', '/api/customer/profile', TOKEN_A, { fullName: '  ' })).status).toBe(400);
  });

  it('an email change does NOT take effect until verified', async () => {
    const P = await freshPrincipal();
    const before = (await (await get('/api/customer/data-export', P.token)).json()).account.email;
    const newEmail = 'changed-' + RUN.toLowerCase() + '@example.test';
    const res = await send('POST', '/api/customer/profile/identity', P.token, { kind: 'email', value: newEmail }, P.ip);
    expect(res.status).toBe(200);
    const payload = await res.json();
    const { changeId } = payload;
    // Unverified: the account still carries the OLD address.
    expect((await (await get('/api/customer/data-export', P.token)).json()).account.email).toBe(before);
    // And the customer is told plainly that nothing has moved yet.
    expect(payload.message).toContain('unchanged');
    expect(changeId).toBeTruthy();
  });

  it('completes the email change with the correct code', async () => {
    const P = await freshPrincipal();
    const before = (await (await get('/api/customer/data-export', P.token)).json()).account.email;
    const newEmail = 'done-' + RUN.toLowerCase() + '@example.test';
    const start = await send('POST', '/api/customer/profile/identity', P.token, { kind: 'email', value: newEmail }, P.ip);
    const { changeId } = await start.json();
    const issued = sent[sent.length - 1];

    const res = await send('POST', '/api/customer/profile/identity/verify', P.token, {
      changeId,
      code: issued.code,
    });
    expect(res.status).toBe(200);
    const after = (await (await get('/api/customer/data-export', P.token)).json()).account.email;
    expect(after).toBe(newEmail);
    expect(after).not.toBe(before);

    // E1-H2 — THE LIFECYCLE COMPLETES. The address proved by a code sent to it is
    // not left in the "new address, unverified" state: that state is exactly what
    // the login activation gate reads as "account not activated", and because no
    // code is ever sent to the previous mailbox again it was a one-way door.
    const row = await db.getCustomerById(P.id);
    expect(row.email).toBe(newEmail);
    expect(row.email_verified_at).not.toBeNull();
  });

  it('a WRONG code changes nothing', async () => {
    const P = await freshPrincipal();
    const before = (await (await get('/api/customer/data-export', P.token)).json()).account.email;
    const newEmail = 'wrong-' + RUN.toLowerCase() + '@example.test';
    const start = await send('POST', '/api/customer/profile/identity', P.token, { kind: 'email', value: newEmail }, P.ip);
    const { changeId } = await start.json();

    const res = await send('POST', '/api/customer/profile/identity/verify', P.token, { changeId, code: '000000' });
    expect(res.status).toBe(400);
    expect((await (await get('/api/customer/data-export', P.token)).json()).account.email).toBe(before);
  });

  it('burns the change after the guess ceiling, so the six-digit space cannot be walked', async () => {
    // A six-digit code is only ~10^6 wide. Without a ceiling an attacker who
    // holds the (session-bound) changeId could walk the whole range inside the
    // 30-minute TTL. The route must DESTROY the pending change at the ceiling so
    // that even the CORRECT code can no longer redeem it.
    const P = await freshPrincipal();
    const newEmail = 'ceiling-' + RUN.toLowerCase() + '@example.test';
    const start = await send('POST', '/api/customer/profile/identity', P.token, { kind: 'email', value: newEmail }, P.ip);
    const { changeId } = await start.json();
    const issued = sent[sent.length - 1];
    // Guaranteed not to equal the real code, so every one of these is a failure.
    const wrong = issued.code === '000000' ? '111111' : '000000';

    // IDENTITY_CHANGE_MAX_VERIFICATION_ATTEMPTS === 5: five wrong codes are each
    // answered 400, and the fifth destroys the change.
    for (let i = 0; i < 5; i++) {
      expect((await send('POST', '/api/customer/profile/identity/verify', P.token, { changeId, code: wrong })).status).toBe(400);
    }
    // The correct code is now dead too - there is no change left to redeem.
    expect((await send('POST', '/api/customer/profile/identity/verify', P.token, { changeId, code: issued.code })).status).toBe(400);
    // And nothing moved.
    expect((await (await get('/api/customer/data-export', P.token)).json()).account.email).not.toBe(newEmail);
  });


  it('a code can be redeemed only ONCE', async () => {
    const P = await freshPrincipal();
    const newEmail = 'once-' + RUN.toLowerCase() + '@example.test';
    const start = await send('POST', '/api/customer/profile/identity', P.token, { kind: 'email', value: newEmail }, P.ip);
    const { changeId } = await start.json();
    const issued = sent[sent.length - 1];

    expect((await send('POST', '/api/customer/profile/identity/verify', P.token, { changeId, code: issued.code })).status).toBe(200);
    // Replaying the same change is refused.
    expect((await send('POST', '/api/customer/profile/identity/verify', P.token, { changeId, code: issued.code })).status).toBe(400);
  });

  it('customer B cannot redeem customer A change', async () => {
    const A2 = await freshPrincipal();
    const B2 = await freshPrincipal();
    const start = await send('POST', '/api/customer/profile/identity', A2.token, {
      kind: 'email',
      value: 'cross-' + RUN.toLowerCase() + '@example.test',
    }, A2.ip);
    const { changeId } = await start.json();
    const issued = sent[sent.length - 1];

    // B holds the genuine changeId and code, and still cannot use them.
    const res = await send('POST', '/api/customer/profile/identity/verify', B2.token, { changeId, code: issued.code });
    expect(res.status).toBe(404);
  });

  it('refuses an email already held by another account', async () => {
    const A2 = await freshPrincipal();
    const B2 = await freshPrincipal();
    const res = await send('POST', '/api/customer/profile/identity', A2.token, {
      kind: 'email',
      value: 'someone-else-' + RUN.toLowerCase() + '@example.test',
    }, A2.ip);
    expect(res.status).toBe(200);
    // B claims an address, then A tries to claim the same one.
    const bStart = await send('POST', '/api/customer/profile/identity', B2.token, {
      kind: 'email',
      value: 'contested-' + RUN.toLowerCase() + '@example.test',
    }, B2.ip);
    const { changeId } = await bStart.json();
    await send('POST', '/api/customer/profile/identity/verify', B2.token, {
      changeId,
      code: sent[sent.length - 1].code,
    });
    const aTry = await send('POST', '/api/customer/profile/identity', A2.token, {
      kind: 'email',
      value: 'contested-' + RUN.toLowerCase() + '@example.test',
    }, A2.ip);
    expect(aTry.status).toBe(409);
  });

  it('rejects an invalid email and an unknown kind', async () => {
    const P = await freshPrincipal();
    expect((await send('POST', '/api/customer/profile/identity', P.token, { kind: 'email', value: 'nope' }, P.ip)).status).toBe(400);
    // An unknown kind is passed through UNMETERED on purpose (the handler rejects
    // it before a code could be issued), so it is a 400 regardless of the budget —
    // and it must not consume the caller's email allowance either.
    expect((await send('POST', '/api/customer/profile/identity', P.token, { kind: 'fax', value: 'x' }, P.ip)).status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // D-1E — THE IDENTITY-CHANGE COMPARISON ITSELF IS NOW TIMING-SAFE.
  //
  // As with the erasure route (D-1D below), no response can witness this: the
  // byte-wise comparison this route used to make and the shared constant-time
  // helper answer with the identical status, body and charged count for the
  // identical wrong code, and differ only in how long they take. The MECHANISM is
  // therefore pinned from the source — the static-audit treatment
  // n10aSharedSmsBudget and paymentAuthGate give properties no response can
  // reveal — and the scenarios after it pin the unchanged behaviour.
  //
  // Each scenario gets its OWN principal, session token and client address. The
  // token `freshPrincipal` builds is derived from `scenario % 10`, so it cycles
  // and resolves to an earlier, already-used account once this block passes ten
  // scenarios; and the email identity branch is metered 3-per-10-minutes on the
  // CUSTOMER and on the CLIENT IP, so a shared either way would let a neighbour
  // starve these assertions (the same per-scenario isolation the erasure block
  // below and n10aSharedSmsBudget.test.ts document).
  // ---------------------------------------------------------------------------
  let idvScenario = 500;
  async function identityPrincipal() {
    idvScenario += 1;
    const id = 'TEST-B2-IDV' + idvScenario + '-' + RUN;
    const token = ('v' + idvScenario).padEnd(64, 'q');
    const phone = '+2547' + String(10000000 + Math.floor(Math.random() * 89999999)).slice(-8);
    await db.createCustomer(id, 'Identity Principal ' + idvScenario, phone);
    await db.createCustomerSession(
      'TEST-B2-IVS' + idvScenario + '-' + RUN,
      id,
      hashCode(token),
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    );
    return { id, token, phone, ip: '10.30.0.' + idvScenario };
  }

  it('verifies an identity-change code with the shared timing-safe helper, not byte-wise', () => {
    const identityVerifyRoute = accountRouteSource.slice(
      accountRouteSource.indexOf("'/api/customer/profile/identity/verify'"),
      accountRouteSource.indexOf("'/api/customer/account/erasure'"),
    );
    // Both ends of the slice are real route markers and the handler still makes
    // its own scoped query, so none of the assertions below can pass vacuously.
    expect(identityVerifyRoute).toContain("'/api/customer/profile/identity/verify'");
    expect(identityVerifyRoute).toContain('getIdentityChangeById(changeId, req.customer.id)');
    // The SAME helper, with the SAME argument order (stored digest first, computed
    // digest second), that login verification and the erasure route use.
    expect(identityVerifyRoute).toContain('timingSafeEqualHex(record.code_hash, hashCode(code))');
    // No byte-wise comparison of the digest may survive on this route.
    expect(identityVerifyRoute).not.toContain('hashCode(code) !== record.code_hash');
    expect(identityVerifyRoute).not.toContain('record.code_hash !== hashCode(code)');
    expect(identityVerifyRoute).not.toContain('hashCode(code) === record.code_hash');
  });

  it('still accepts the genuine code and still charges a wrong one, now timing-safe', async () => {
    const P = await identityPrincipal();
    // A brand-new account has no verified address, so "nothing moved" below is a
    // claim with content rather than a comparison against the changed value.
    const before = (await db.getCustomerById(P.id)).email;
    expect(before).toBeFalsy();

    const newEmail = 'd1e-' + RUN.toLowerCase() + '@example.test';
    const start = await send('POST', '/api/customer/profile/identity', P.token, { kind: 'email', value: newEmail }, P.ip);
    expect(start.status).toBe(200);
    const { changeId } = await start.json();
    const issued = sent[sent.length - 1];

    // A well-formed guess that cannot equal the issued code: refused with the
    // response contract this route has always used, charged exactly once, and
    // nothing applied.
    const wrong = issued.code === '000000' ? '111111' : '000000';
    const rejected = await send('POST', '/api/customer/profile/identity/verify', P.token, { changeId, code: wrong });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: 'That code is not correct.' });
    expect((await db.getCustomerById(P.id)).email).toBe(before);
    expect(Number((await db.getIdentityChangeById(changeId, P.id)).attempt_count)).toBe(1);

    // The acceptance path is untouched: the genuine code on the SAME change, still
    // inside the five-guess budget, still completes the change.
    const accepted = await send('POST', '/api/customer/profile/identity/verify', P.token, { changeId, code: issued.code });
    expect(accepted.status).toBe(200);
    expect((await db.getCustomerById(P.id)).email).toBe(newEmail);
    // ...and the code is spent.
    expect((await db.getIdentityChangeById(changeId, P.id)).consumed_at).not.toBeNull();
  });

  it('refuses an EXPIRED change and an already-CONSUMED change even with the right code', async () => {
    const P = await identityPrincipal();
    const before = (await db.getCustomerById(P.id)).email;
    expect(before).toBeFalsy();

    // (1) EXPIRED. Recorded directly as an already-stale row, so what refuses it is
    // the route's own expiry rule rather than a row that never existed.
    const staleCode = '135790';
    const staleId = 'TEST-B2-CICH-EXP-' + RUN;
    await db.createCustomerIdentityChange({
      id: staleId,
      customerId: P.id,
      kind: 'email',
      targetValue: 'stale-' + RUN.toLowerCase() + '@example.test',
      codeHash: hashCode(staleCode),
      expiresAt: new Date(Date.now() - 1000),
    });
    const expired = await send('POST', '/api/customer/profile/identity/verify', P.token, {
      changeId: staleId,
      code: staleCode,
    });
    expect(expired.status).toBe(400);
    expect(await expired.json()).toEqual({ error: 'That code has expired.' });

    // (2) CONSUMED. A live change already redeemed — the state a replay leaves
    // behind — cannot be redeemed a second time, correct code or not.
    const liveCode = '246813';
    const liveId = 'TEST-B2-CICH-CON-' + RUN;
    await db.createCustomerIdentityChange({
      id: liveId,
      customerId: P.id,
      kind: 'email',
      targetValue: 'consumed-' + RUN.toLowerCase() + '@example.test',
      codeHash: hashCode(liveCode),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });
    expect(await db.consumeCustomerIdentityChange({ id: liveId, customerId: P.id })).toBe(true);
    const consumed = await send('POST', '/api/customer/profile/identity/verify', P.token, {
      changeId: liveId,
      code: liveCode,
    });
    expect(consumed.status).toBe(400);
    expect(await consumed.json()).toEqual({ error: 'That code has already been used.' });

    // Neither attempt applied anything.
    expect((await db.getCustomerById(P.id)).email).toBe(before);
  });

  it('answers a malformed identity-change code with the generic refusal, never a server error', async () => {
    const P = await identityPrincipal();
    const before = (await db.getCustomerById(P.id)).email;
    expect(before).toBeFalsy();

    const newEmail = 'malformed-' + RUN.toLowerCase() + '@example.test';
    const start = await send('POST', '/api/customer/profile/identity', P.token, { kind: 'email', value: newEmail }, P.ip);
    const { changeId } = await start.json();

    // `crypto.timingSafeEqual` THROWS on buffers of unequal length, which is why
    // the helper length-checks first. A short, non-hex or oversized code must
    // therefore stay an ordinary generic 400 — a 500 here would be both a bug and
    // an oracle — and must be charged exactly like any other wrong guess.
    const malformed = ['abc', 'zzzzzz', 'not-a-code', '0'.repeat(200)];
    for (const candidate of malformed) {
      const res = await send('POST', '/api/customer/profile/identity/verify', P.token, { changeId, code: candidate });
      expect(res.status, candidate).toBe(400);
      expect(await res.json(), candidate).toEqual({ error: 'That code is not correct.' });
    }
    const row = await db.getIdentityChangeById(changeId, P.id);
    // Four guesses, four charges, still under the ceiling: the change survives with
    // its budget reduced, as designed, and the code was never accepted.
    expect(Number(row.attempt_count)).toBe(malformed.length);
    expect(row.consumed_at == null).toBe(true);

    // A code that is not even a string is refused by the input validation BEFORE
    // any comparison, so it is a 400 and is not charged. Either way: never a 500.
    for (const candidate of [12345, {}, [], null] as any[]) {
      const res = await send('POST', '/api/customer/profile/identity/verify', P.token, { changeId, code: candidate });
      expect(res.status, String(candidate)).toBe(400);
    }
    expect(Number((await db.getIdentityChangeById(changeId, P.id)).attempt_count)).toBe(malformed.length);
    expect((await db.getCustomerById(P.id)).email).toBe(before);
  });

  it('charges a SIMULTANEOUS burst of wrong codes exactly once each and burns the change', async () => {
    const P = await identityPrincipal();
    const before = (await db.getCustomerById(P.id)).email;
    expect(before).toBeFalsy();

    const newEmail = 'd1f-burst-' + RUN.toLowerCase() + '@example.test';
    const start = await send('POST', '/api/customer/profile/identity', P.token, { kind: 'email', value: newEmail }, P.ip);
    expect(start.status).toBe(200);
    const { changeId } = await start.json();
    const issued = sent[sent.length - 1];
    const wrong = issued.code === '000000' ? '111111' : '000000';

    // D-1F. Twelve wrong codes presented AT THE SAME TIME against one change. Under
    // the old read-modify-write the charges overwrote one another, so the change
    // survived having spent far fewer than its five-guess allowance and the ceiling
    // never fired — which is the entire point of this counter. Under the bounded
    // compare-and-swap every landed charge is counted exactly once, so the ceiling
    // is reached exactly.
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        send('POST', '/api/customer/profile/identity/verify', P.token, { changeId, code: wrong }),
      ),
    );

    // Never an acceptance, and never a server error: every path refuses the burst.
    // (No rate limiter guards this endpoint — deliberately, see the route — so a 429
    // here would itself be a surprise, not an explanation.)
    expect(responses.map((r) => r.status).filter((s) => s !== 400)).toEqual([]);
    // Each refusal is one of the two bodies this route already used: the wrong-code
    // body, or — for a request that read the row AFTER an earlier one burned it —
    // the already-used body. The burst discloses nothing new.
    const bodies = await Promise.all(responses.map((r) => r.json()));
    for (const body of bodies) {
      expect([
        { error: 'That code is not correct.' },
        { error: 'That code has already been used.' },
      ]).toContainEqual(body);
    }

    // THE PERSISTED STATE IS THE EVIDENCE, not the status codes: the stored total is
    // EXACTLY the ceiling — a lost update would leave it lower with the change still
    // alive and still guessable, and nothing may ever store more — and the change is
    // BURNED.
    const row = await db.getIdentityChangeById(changeId, P.id);
    expect(Number(row.attempt_count)).toBe(IDENTITY_CHANGE_MAX_VERIFICATION_ATTEMPTS);
    expect(row.consumed_at).not.toBeNull();

    // And the burn is real: the GENUINE code can no longer complete the change, so
    // the burst did not merely add noise to a still-redeemable code.
    const genuine = await send('POST', '/api/customer/profile/identity/verify', P.token, {
      changeId,
      code: issued.code,
    });
    expect(genuine.status).toBe(400);
    expect((await db.getCustomerById(P.id)).email).toBe(before);
  });
});

describe('B2 HTTP - erasure (G2)', () => {
  /**
   * A FRESH authenticated customer whose ONE live `login` challenge the scenario
   * below controls.
   *
   * Erasure re-authenticates against the account's CURRENT phone using the same
   * `login` challenge the sign-in flow issues, so every scenario needs a challenge
   * it owns and a phone no other scenario shares: a reused account would let one
   * scenario's wrong guesses burn another scenario's challenge.
   */
  let eraScenario = 200;
  async function erasurePrincipal() {
    eraScenario += 1;
    const id = 'TEST-B2-ERA' + eraScenario + '-' + RUN;
    // Unique per scenario: a repeated 64-char pattern would collide across
    // scenarios once the counter cycled, and a colliding token resolves to the
    // FIRST session stored for it — which, in this block, may be an account an
    // earlier scenario already erased.
    const token = ('e' + eraScenario).padEnd(64, 'z');
    const phone = '+2547' + String(10000000 + Math.floor(Math.random() * 89999999)).slice(-8);
    await db.createCustomer(id, 'Erasure Principal ' + eraScenario, phone);
    await db.createCustomerSession(
      'TEST-B2-ES' + eraScenario + '-' + RUN,
      id,
      hashCode(token),
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    );
    return { id, token, phone };
  }

  /**
   * Issues this account's `login` challenge and returns the code it proves.
   *
   * The challenge is created with the account's own id — the way the login
   * endpoint creates it — unless a scenario deliberately seeds a foreign or
   * ownerless row to prove the route does not trust it.
   */
  async function issueLoginChallenge(
    p: { id: string; phone: string },
    opts: { code?: string; expiresInMs?: number; customerId?: string | null; label?: string } = {},
  ) {
    eraScenario += 1;
    const code = opts.code ?? '654321';
    const challengeId = 'TEST-B2-EOTP' + eraScenario + '-' + (opts.label ?? 'own') + '-' + RUN;
    await db.createCustomerOtp(
      challengeId,
      p.phone,
      'login',
      hashCode(code),
      new Date(Date.now() + (opts.expiresInMs ?? 5 * 60 * 1000)),
      opts.customerId === undefined ? p.id : opts.customerId,
    );
    return { code, challengeId };
  }

  /** The stored challenge row — the authoritative evidence of what was charged. */
  async function storedChallenge(challengeId: string) {
    const [row] = await drizzleDb
      .select()
      .from(customerOtpsTable)
      .where(eq(customerOtpsTable.id, challengeId));
    return row;
  }

  function erase(token: string, body: any) {
    return send('POST', '/api/customer/account/erasure', token, body);
  }

  it('refuses without a correct confirmation code', async () => {
    const res = await send('POST', '/api/customer/account/erasure', TOKEN_A, { code: '000000', confirm: true });
    expect(res.status).toBe(400);
    // The account is untouched.
    expect((await get('/api/customer/data-export', TOKEN_A)).status).toBe(200);
  });

  it('refuses without explicit confirmation even with a valid-shaped body', async () => {
    const res = await send('POST', '/api/customer/account/erasure', TOKEN_A, { code: '000000' });
    expect(res.status).toBe(400);
  });

  it('erases with a correct confirmation code and keeps the same success response', async () => {
    const P = await erasurePrincipal();
    const { code } = await issueLoginChallenge(P, { code: '432198' });

    const res = await erase(P.token, { code, confirm: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    // The response contract is unchanged by this batch.
    expect(body.success).toBe(true);
    expect(body.message).toBe(CUSTOMER_ACCOUNT_STRINGS.erasureStarted.en);

    // The erasure itself is the existing one: identity redacted, account closed.
    const row = await db.getCustomerById(P.id);
    expect(row.full_name).toBe('[REDACTED-DPA-2019]');
    expect(row.status).toBe('suspended');
    // The erased account cannot keep acting, and the proof is spent.
    expect((await get('/api/customer/data-export', P.token)).status).toBe(401);
    expect(await db.getCustomerOtpForPurpose(P.phone, 'login')).toBeUndefined();
  });

  it('accepts the correct code after wrong guesses that are below the ceiling', async () => {
    const P = await erasurePrincipal();
    const { code } = await issueLoginChallenge(P, { code: '112233' });
    const wrong = '998877';

    // One guess short of the ceiling: still inside the budget, so the genuine
    // code must still work and the account must still be intact.
    for (let i = 0; i < CUSTOMER_OTP_MAX_ATTEMPTS - 1; i++) {
      expect((await erase(P.token, { code: wrong, confirm: true })).status).toBe(400);
    }
    expect((await get('/api/customer/data-export', P.token)).status).toBe(200);

    expect((await erase(P.token, { code, confirm: true })).status).toBe(200);
    expect((await db.getCustomerById(P.id)).full_name).toBe('[REDACTED-DPA-2019]');
  });

  it('burns the challenge at the ceiling, so the correct code can no longer erase', async () => {
    const P = await erasurePrincipal();
    const { code, challengeId } = await issueLoginChallenge(P, { code: '246810' });
    const wrong = '135791';

    for (let i = 0; i < CUSTOMER_OTP_MAX_ATTEMPTS; i++) {
      expect((await erase(P.token, { code: wrong, confirm: true })).status).toBe(400);
    }

    // The ceiling DESTROYS the proof rather than merely throttling it: the real
    // code is refused too, and there is no challenge left to spend.
    expect((await erase(P.token, { code, confirm: true })).status).toBe(400);
    expect(await db.getCustomerOtpForPurpose(P.phone, 'login')).toBeUndefined();
    expect((await storedChallenge(challengeId)).used_at).not.toBeNull();
    // Nothing was erased.
    expect((await get('/api/customer/data-export', P.token)).status).toBe(200);
    const row = await db.getCustomerById(P.id);
    expect(row.status).toBe('active');
    expect(row.full_name).not.toBe('[REDACTED-DPA-2019]');
  });

  it('charges CONCURRENT wrong guesses exactly once each and never more than the ceiling', async () => {
    const P = await erasurePrincipal();
    // An explicit code, so the burst below is guaranteed to contain none of it.
    const { code, challengeId } = await issueLoginChallenge(P, { code: '505050' });

    const burst = await Promise.all(
      Array.from({ length: 10 }, (_, i) => erase(P.token, { code: String(100000 + i), confirm: true })),
    );
    for (const res of burst) expect(res.status).toBe(400);

    // The stored counter is EXACTLY at the ceiling — a lost increment would leave
    // it lower (and the challenge still alive), and nothing may ever store more.
    expect(Number((await storedChallenge(challengeId)).attempt_count)).toBe(CUSTOMER_OTP_MAX_ATTEMPTS);
    expect(await db.getCustomerOtpForPurpose(P.phone, 'login')).toBeUndefined();

    // So the real code is dead even though ten guesses raced for it, and the
    // account is untouched.
    expect((await erase(P.token, { code, confirm: true })).status).toBe(400);
    expect((await get('/api/customer/data-export', P.token)).status).toBe(200);
  });

  it('refuses an expired confirmation code without charging the challenge', async () => {
    const P = await erasurePrincipal();
    const { code, challengeId } = await issueLoginChallenge(P, {
      code: '707070',
      expiresInMs: -1000,
    });

    expect((await erase(P.token, { code, confirm: true })).status).toBe(400);
    expect(Number((await storedChallenge(challengeId)).attempt_count)).toBe(0);
    expect((await get('/api/customer/data-export', P.token)).status).toBe(200);
  });

  it('a spent code cannot be presented again', async () => {
    const P = await erasurePrincipal();
    const { code } = await issueLoginChallenge(P, { code: '808080' });

    expect((await erase(P.token, { code, confirm: true })).status).toBe(200);
    // The session that erased is revoked...
    expect((await erase(P.token, { code, confirm: true })).status).toBe(401);
    // ...and a NEW session on the same, now closed account is refused outright.
    const retryToken = ('9' + 'f').repeat(32);
    await db.createCustomerSession(
      'TEST-B2-ES-REPLAY-' + RUN,
      P.id,
      hashCode(retryToken),
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    );
    expect((await erase(retryToken, { code, confirm: true })).status).toBe(403);
  });

  it('cannot use another customer challenge, and does not burn it', async () => {
    const A = await erasurePrincipal();
    const B = await erasurePrincipal();
    const { code, challengeId } = await issueLoginChallenge(A, { code: '313131' });

    // B holds A's genuine code. The challenge is resolved from B's OWN phone, so
    // B proves nothing and A's challenge is untouched — a wrong guess here must
    // not spend A's allowance.
    expect((await erase(B.token, { code, confirm: true })).status).toBe(400);
    const aRow = await storedChallenge(challengeId);
    expect(Number(aRow.attempt_count)).toBe(0);
    // Never burned. (`== null` covers both a stored NULL and a column the mock
    // never wrote — the same loose check the DB suite uses for `revoked_at`.)
    expect(aRow.used_at == null).toBe(true);
    expect(await db.getCustomerOtpForPurpose(A.phone, 'login')).toBeDefined();

    // A's own code still erases A's account, and B is untouched.
    expect((await erase(A.token, { code, confirm: true })).status).toBe(200);
    expect((await get('/api/customer/data-export', B.token)).status).toBe(200);
  });

  it('refuses a challenge row that names a different customer, without charging it', async () => {
    const P = await erasurePrincipal();
    // The only way such a row can exist is if a phone were ever reused; the route
    // must not trust it either way.
    const { code, challengeId } = await issueLoginChallenge(P, {
      code: '121212',
      customerId: 'TEST-B2-SOMEONE-ELSE-' + RUN,
      label: 'foreign',
    });

    expect((await erase(P.token, { code, confirm: true })).status).toBe(400);
    const row = await storedChallenge(challengeId);
    expect(Number(row.attempt_count)).toBe(0);
    expect(row.used_at == null).toBe(true);
    // Nothing was erased.
    expect((await get('/api/customer/data-export', P.token)).status).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // D-1D — THE COMPARISON ITSELF IS NOW TIMING-SAFE.
  //
  // Every scenario above asserts BEHAVIOUR, and behaviour cannot witness this
  // defect: the byte-wise comparison this route used to make and the shared
  // constant-time helper return the identical status, body and charged count for
  // the identical wrong code. Only the MECHANISM is testable, so it is pinned
  // from the source — the same static-audit treatment n10aSharedSmsBudget and
  // paymentAuthGate give properties no response can reveal.
  // ---------------------------------------------------------------------------
  it('compares the code with the shared timing-safe helper, not byte-wise', () => {
    const erasureRoute = accountRouteSource.slice(
      accountRouteSource.indexOf("'/api/customer/account/erasure'"),
      accountRouteSource.indexOf('function normalizeTarget'),
    );
    // The handler was located, so the assertions below cannot pass vacuously.
    expect(erasureRoute).toContain("'/api/customer/account/erasure'");
    expect(erasureRoute).toContain('consumeCustomerOtp(challenge.id)');
    // The SAME helper, with the SAME argument order, that login verification
    // uses in server.ts: `timingSafeEqualHex(otp.code_hash, hashCode(code))`.
    expect(erasureRoute).toContain('timingSafeEqualHex(challenge.code_hash, hashCode(code))');
    // ...taken from the one shared module rather than re-implemented locally.
    expect(accountRouteSource).toMatch(
      /import \{[^}]*\btimingSafeEqualHex\b[^}]*\} from '\.\.\/services\/auth\.ts';/,
    );
    // No byte-wise comparison of the digest may survive on this route.
    expect(erasureRoute).not.toContain('challenge.code_hash !== hashCode(code)');
    expect(erasureRoute).not.toContain('hashCode(code) !== challenge.code_hash');
    expect(erasureRoute).not.toContain('challenge.code_hash === hashCode(code)');
  });

  it('still charges a wrong guess and still accepts the genuine code, now timing-safe', async () => {
    const P = await erasurePrincipal();
    const { code, challengeId } = await issueLoginChallenge(P, { code: '424242' });

    // A well-formed guess sharing NO digit with the stored code: rejected with
    // the one generic body, charged exactly once, nothing erased.
    const wrong = await erase(P.token, { code: '777777', confirm: true });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: 'That confirmation code is not correct.' });
    expect(Number((await storedChallenge(challengeId)).attempt_count)).toBe(1);
    expect((await get('/api/customer/data-export', P.token)).status).toBe(200);

    // The acceptance path is untouched: the genuine code on the SAME challenge,
    // still inside the budget, erases.
    expect((await erase(P.token, { code, confirm: true })).status).toBe(200);
    expect((await db.getCustomerById(P.id)).full_name).toBe('[REDACTED-DPA-2019]');
  });

  it('answers a malformed code with the generic refusal, never a server error', async () => {
    const P = await erasurePrincipal();
    const { challengeId } = await issueLoginChallenge(P, { code: '606060' });
    const GENERIC = { error: 'That confirmation code is not correct.' };

    // `crypto.timingSafeEqual` THROWS on buffers of unequal length, which is why
    // the helper length-checks first. A short, non-hex or oversized code must
    // therefore remain an ordinary generic 400 — a 500 here would be both a bug
    // and an oracle — and must be charged exactly like any other wrong guess.
    const malformed = ['abc', 'zzzzzz', 'not-a-code', '0'.repeat(200)];
    for (const candidate of malformed) {
      const res = await erase(P.token, { code: candidate, confirm: true });
      expect(res.status, candidate).toBe(400);
      expect(await res.json(), candidate).toEqual(GENERIC);
    }
    expect(Number((await storedChallenge(challengeId)).attempt_count)).toBe(malformed.length);
    expect((await get('/api/customer/data-export', P.token)).status).toBe(200);
  });

  it('is not an oracle: every refusal reason yields the identical body', async () => {
    const P = await erasurePrincipal();
    const GENERIC = { error: 'That confirmation code is not correct.' };

    // (1) No challenge exists for this account at all.
    const absent = await erase(P.token, { code: '123456', confirm: true });
    expect(absent.status).toBe(400);
    expect(await absent.json()).toEqual(GENERIC);

    // (2) A challenge that has EXPIRED. `getCustomerOtpForPurpose` filters expiry
    // in SQL, so this narrows to the same "no challenge" shape as (1) — and it
    // must stay indistinguishable from a wrong code, which is the point.
    const stale = await issueLoginChallenge(P, {
      code: '123456',
      expiresInMs: -1000,
      label: 'oracle',
    });
    const expired = await erase(P.token, { code: stale.code, confirm: true });
    expect(expired.status).toBe(400);
    expect(await expired.json()).toEqual(GENERIC);

    // (3) A LIVE challenge and a wrong code — the same body once more.
    await issueLoginChallenge(P, { code: '123456', label: 'oracle-live' });
    const wrong = await erase(P.token, { code: '999999', confirm: true });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual(GENERIC);

    // None of the three erased anything.
    expect((await get('/api/customer/data-export', P.token)).status).toBe(200);
  });
});
