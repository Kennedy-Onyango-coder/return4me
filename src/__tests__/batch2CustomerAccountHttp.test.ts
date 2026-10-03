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
      // N10-A: only the N10-A cases below pass an explicit IP, so every
      // pre-existing request here is unchanged and continues to arrive from
      // 127.0.0.1 — none of them spends an SMS budget unit (they are email
      // kind), so they are unaffected by the new limiter.
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
  it('updates the name', async () => {
    const res = await send('PATCH', '/api/customer/profile', TOKEN_A, { fullName: 'Renamed Person' });
    expect(res.status).toBe(200);
    expect((await res.json()).customer.full_name).toBe('Renamed Person');
  });

  it('rejects an empty name', async () => {
    expect((await send('PATCH', '/api/customer/profile', TOKEN_A, { fullName: '  ' })).status).toBe(400);
  });

  it('an email change does NOT take effect until verified', async () => {
    const before = (await (await get('/api/customer/data-export', TOKEN_A)).json()).account.email;
    const newEmail = 'changed-' + RUN.toLowerCase() + '@example.test';
    const res = await send('POST', '/api/customer/profile/identity', TOKEN_A, { kind: 'email', value: newEmail });
    expect(res.status).toBe(200);
    const payload = await res.json();
    const { changeId } = payload;
    // Unverified: the account still carries the OLD address.
    expect((await (await get('/api/customer/data-export', TOKEN_A)).json()).account.email).toBe(before);
    // And the customer is told plainly that nothing has moved yet.
    expect(payload.message).toContain('unchanged');
    expect(changeId).toBeTruthy();
  });

  it('completes the email change with the correct code', async () => {
    const before = (await (await get('/api/customer/data-export', TOKEN_A)).json()).account.email;
    const newEmail = 'done-' + RUN.toLowerCase() + '@example.test';
    const start = await send('POST', '/api/customer/profile/identity', TOKEN_A, { kind: 'email', value: newEmail });
    const { changeId } = await start.json();
    const issued = sent[sent.length - 1];

    const res = await send('POST', '/api/customer/profile/identity/verify', TOKEN_A, {
      changeId,
      code: issued.code,
    });
    expect(res.status).toBe(200);
    const after = (await (await get('/api/customer/data-export', TOKEN_A)).json()).account.email;
    expect(after).toBe(newEmail);
    expect(after).not.toBe(before);
  });

  it('a WRONG code changes nothing', async () => {
    const before = (await (await get('/api/customer/data-export', TOKEN_A)).json()).account.email;
    const newEmail = 'wrong-' + RUN.toLowerCase() + '@example.test';
    const start = await send('POST', '/api/customer/profile/identity', TOKEN_A, { kind: 'email', value: newEmail });
    const { changeId } = await start.json();

    const res = await send('POST', '/api/customer/profile/identity/verify', TOKEN_A, { changeId, code: '000000' });
    expect(res.status).toBe(400);
    expect((await (await get('/api/customer/data-export', TOKEN_A)).json()).account.email).toBe(before);
  });

  it('a code can be redeemed only ONCE', async () => {
    const newEmail = 'once-' + RUN.toLowerCase() + '@example.test';
    const start = await send('POST', '/api/customer/profile/identity', TOKEN_A, { kind: 'email', value: newEmail });
    const { changeId } = await start.json();
    const issued = sent[sent.length - 1];

    expect((await send('POST', '/api/customer/profile/identity/verify', TOKEN_A, { changeId, code: issued.code })).status).toBe(200);
    // Replaying the same change is refused.
    expect((await send('POST', '/api/customer/profile/identity/verify', TOKEN_A, { changeId, code: issued.code })).status).toBe(400);
  });

  it('customer B cannot redeem customer A change', async () => {
    const start = await send('POST', '/api/customer/profile/identity', TOKEN_A, {
      kind: 'email',
      value: 'cross-' + RUN.toLowerCase() + '@example.test',
    });
    const { changeId } = await start.json();
    const issued = sent[sent.length - 1];

    // B holds the genuine changeId and code, and still cannot use them.
    const res = await send('POST', '/api/customer/profile/identity/verify', TOKEN_B, { changeId, code: issued.code });
    expect(res.status).toBe(404);
  });

  it('refuses an email already held by another account', async () => {
    const res = await send('POST', '/api/customer/profile/identity', TOKEN_A, {
      kind: 'email',
      value: 'someone-else-' + RUN.toLowerCase() + '@example.test',
    });
    expect(res.status).toBe(200);
    // B claims an address, then A tries to claim the same one.
    const bStart = await send('POST', '/api/customer/profile/identity', TOKEN_B, {
      kind: 'email',
      value: 'contested-' + RUN.toLowerCase() + '@example.test',
    });
    const { changeId } = await bStart.json();
    await send('POST', '/api/customer/profile/identity/verify', TOKEN_B, {
      changeId,
      code: sent[sent.length - 1].code,
    });
    const aTry = await send('POST', '/api/customer/profile/identity', TOKEN_A, {
      kind: 'email',
      value: 'contested-' + RUN.toLowerCase() + '@example.test',
    });
    expect(aTry.status).toBe(409);
  });

  it('rejects an invalid email and an unknown kind', async () => {
    expect((await send('POST', '/api/customer/profile/identity', TOKEN_A, { kind: 'email', value: 'nope' })).status).toBe(400);
    expect((await send('POST', '/api/customer/profile/identity', TOKEN_A, { kind: 'fax', value: 'x' })).status).toBe(400);
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
