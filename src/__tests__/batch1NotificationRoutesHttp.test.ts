import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { db } from '../db/database';
import { hashCode } from '../services/auth';
import { CUSTOMER_SESSION_COOKIE } from '../services/customerAuth';
import { registerCustomerNotificationRoutes } from '../routes/customerNotifications';
import { recordCustomerNotification } from '../services/customerNotifications';

// HTTP INTEGRATION TESTS - the customer notification authorization boundary.
//
// These mount a REAL Express app around the REAL requireCustomerAuth middleware
// and the REAL route handlers, then drive them over a real TCP socket with
// fetch(). That is the smallest harness that can actually prove the boundary: a
// request with no cookie, or with a cookie for a DIFFERENT customer, has to be
// rejected by the middleware and the query layer themselves. Asserting against
// source text cannot demonstrate that.
//
// server.ts is deliberately NOT imported - it calls startServer() at import time.
// routes/customerNotifications.ts exists precisely so the real handlers can be
// mounted in isolation.

const RUN = Math.floor(100000 + Math.random() * 899999).toString(36).toUpperCase();
const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);
const CUS_A = 'TEST-B1-CUS-A-' + RUN;
const CUS_B = 'TEST-B1-CUS-B-' + RUN;
const PHONE_A = '+2547' + String(10000000 + Math.floor(Math.random() * 89999999)).slice(-8);
const PHONE_B = '+2547' + String(10000000 + Math.floor(Math.random() * 89999999)).slice(-8);

let server: Server;
let baseUrl = '';
let notificationB = '';

async function get(path: string, token?: string) {
  return fetch(baseUrl + path, { headers: token ? { cookie: CUSTOMER_SESSION_COOKIE + '=' + token } : {} });
}

async function postPref(token: string, body: any) {
  return fetch(baseUrl + '/api/customer/notifications/preferences', {
    method: 'POST',
    headers: { cookie: CUSTOMER_SESSION_COOKIE + '=' + token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  await db.createCustomer(CUS_A, 'Batch One Customer A', PHONE_A);
  await db.createCustomer(CUS_B, 'Batch One Customer B', PHONE_B);
  const week = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await db.createCustomerSession('TEST-B1-SESS-A-' + RUN, CUS_A, hashCode(TOKEN_A), week);
  await db.createCustomerSession('TEST-B1-SESS-B-' + RUN, CUS_B, hashCode(TOKEN_B), week);

  const created = await recordCustomerNotification({
    customerId: CUS_B,
    category: 'account_security',
    title: 'B security alert',
    body: 'Sign-in from a new device.',
  });
  notificationB = created.id;

  const app = express();
  app.use(express.json());
  registerCustomerNotificationRoutes(app);
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

describe('Batch 1 HTTP - authentication is required', () => {
  it('rejects the notification list with no session cookie', async () => {
    expect((await get('/api/customer/notifications')).status).toBe(401);
  });

  it('rejects the history endpoint with no session cookie', async () => {
    expect((await get('/api/customer/notifications/history')).status).toBe(401);
  });

  it('rejects opening a notification with no session cookie', async () => {
    expect((await get('/api/customer/notifications/' + notificationB)).status).toBe(401);
  });

  it('rejects a preference change with no session cookie', async () => {
    const res = await fetch(baseUrl + '/api/customer/notifications/preferences', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'lost_report', channel: 'sms', enabled: false }),
    });
    expect(res.status).toBe(401);
  });
});

describe('Batch 1 HTTP - one customer cannot reach another (requirement 16)', () => {
  it('never lists another customer notifications', async () => {
    const res = await get('/api/customer/notifications', TOKEN_A);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notifications).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('B security alert');
  });

  it('never exposes another customer notification through HISTORY', async () => {
    const res = await get('/api/customer/notifications/history', TOKEN_A);
    const body = await res.json();
    expect(body.notifications).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('B security alert');
  });

  it('404s when opening another customer notification by its real id', async () => {
    // The strongest form of the boundary: A holds B's genuine notification id and
    // it still does not resolve.
    const res = await get('/api/customer/notifications/' + notificationB, TOKEN_A);
    expect(res.status).toBe(404);
  });

  it('keeps each customer unread count and content separate', async () => {
    // Seeds its OWN unread notification rather than reusing the fixture: the test
    // above legitimately 404s on B's item, and each assertion stands alone.
    const mine = await recordCustomerNotification({
      customerId: CUS_A,
      category: 'claim_status',
      title: 'A unread item',
    });
    const a = await (await get('/api/customer/notifications', TOKEN_A)).json();
    const b = await (await get('/api/customer/notifications', TOKEN_B)).json();
    expect(a.unread).toBe(1);
    expect(a.notifications.some((n: any) => n.id === mine.id)).toBe(true);
    expect(JSON.stringify(a)).not.toContain('B security alert');
    expect(JSON.stringify(b)).not.toContain('A unread item');
  });

  it('marks read only for the owner', async () => {
    const own = await recordCustomerNotification({
      customerId: CUS_B,
      category: 'claim_status',
      title: 'B opens this',
    });
    expect((await get('/api/customer/notifications/' + own.id, TOKEN_A)).status).toBe(404);
    const opened = await (await get('/api/customer/notifications/' + own.id, TOKEN_B)).json();
    expect(opened.notification.read).toBe(true);
  });
});

describe('Batch 1 HTTP - preferences are honoured and enforced server-side', () => {
  it('lets a customer disable an OPTIONAL channel', async () => {
    const res = await postPref(TOKEN_A, { category: 'lost_report', channel: 'sms', enabled: false });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(true);
    const entry = body.preferences.find((p: any) => p.category === 'lost_report');
    expect(entry.channels.find((c: any) => c.channel === 'sms').enabled).toBe(false);
  });

  it('REFUSES to disable an ESSENTIAL channel and says so', async () => {
    const res = await postPref(TOKEN_A, { category: 'payment_status', channel: 'sms', enabled: false });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Confirmed honestly to the customer rather than silently reverted.
    expect(body.applied).toBe(false);
    expect(body.enabled).toBe(true);
    expect(body.reason).toBeTruthy();
    expect(body.reason.toLowerCase()).not.toContain('provider');
  });

  it('does not let A change B preferences', async () => {
    const before = JSON.stringify(await (await get('/api/customer/notifications/preferences', TOKEN_B)).json());
    await postPref(TOKEN_A, { category: 'found_item_report', channel: 'email', enabled: false });
    const after = JSON.stringify(await (await get('/api/customer/notifications/preferences', TOKEN_B)).json());
    expect(after).toEqual(before);
  });

  it('rejects a malformed preference request', async () => {
    const res = await postPref(TOKEN_A, { category: 'lost_report', channel: 'sms' });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown channel rather than storing it', async () => {
    const res = await postPref(TOKEN_A, { category: 'lost_report', channel: 'carrier_pigeon', enabled: false });
    expect(res.status).toBe(400);
  });
});

describe('Batch 1 HTTP - no delivery internals in any response', () => {
  it('keeps provider and retry vocabulary out of every payload', async () => {
    for (const path of [
      '/api/customer/notifications',
      '/api/customer/notifications/history',
      '/api/customer/notifications/preferences',
    ]) {
      const body = (await (await get(path, TOKEN_B)).text()).toLowerCase();
      for (const leak of ['provider', 'webhook', 'retry', 'africa', 'talking', 'resend', 'gateway', 'next_attempt']) {
        expect(body).not.toContain(leak);
      }
    }
  });
});
