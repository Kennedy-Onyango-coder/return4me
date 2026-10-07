import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { db } from '../db/database';
import { hashCode } from '../services/auth';
import { CUSTOMER_SESSION_COOKIE } from '../services/customerAuth';
import { registerCustomerAccountRoutes } from '../routes/customerAccount';

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
});

describe('B2 HTTP - erasure (G2)', () => {
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
});
