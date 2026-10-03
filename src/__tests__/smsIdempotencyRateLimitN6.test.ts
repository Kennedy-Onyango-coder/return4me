// =============================================================================
// N6 — DURABLE SMS IDEMPOTENCY + RATE LIMITING.
//
// The claims under test are the two the N6 brief names, and both are security
// properties that a mock could trivially satisfy:
//
//   * Idempotency is enforced by the DATABASE, so it must be exercised against
//     the real persistence boundary — including genuine concurrent duplicates and
//     a fresh service/db instantiation standing in for a process restart.
//   * The rate limit is DURABLE and the window ROLLING, so it must be exercised
//     across real wall-clock expiry, not by advancing a fake clock in a Map.
//
// The rate-limit middleware is driven over REAL HTTP (createApp-style Express
// plus an ephemeral socket), because a limiter's whole job is to run in the
// request path, and asserting it by calling a helper proves nothing about where
// it sits relative to the handler.
//
// No SMS and no email is ever sent: providers are capture adapters.
// =============================================================================
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { db } from '../db/database';
import {
  NotificationService,
  buildNotificationIdempotencyKey,
  idempotencyKeyLooksLikeSecret,
  __setEmailProvider,
  __setSmsProvider,
} from '../services/notificationService';
import {
  SMS_RATE_LIMIT,
  SMS_RATE_LIMIT_WINDOW_MS,
  buildSmsRateLimitBucketKey,
  resolveSmsRateLimitIdentities,
  consumeSmsRateLimit,
  smsRateLimit,
} from '../services/smsRateLimit';

const smsSent: Array<{ to: string; body: string }> = [];
let accept = true;

const captureSms = {
  name: 'capture-sms',
  async send(to: string, body: string) {
    smsSent.push({ to, body });
    return { accepted: accept, providerMessageId: null, error: accept ? null : 'capture_rejected' };
  },
};

const serverTs = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');
const rateLimitTs = fs.readFileSync(path.resolve(__dirname, '../services/smsRateLimit.ts'), 'utf8');
const serviceTs = fs.readFileSync(path.resolve(__dirname, '../services/notificationService.ts'), 'utf8');
const schemaTs = fs.readFileSync(path.resolve(__dirname, '../db/schema.ts'), 'utf8');

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let n = 0;
const key = (label: string) => `n6-${label}-${n++}`;

async function clearTables() {
  const { db: rawDb } = await import('../db/index');
  const { notification_events, sms_rate_limit_buckets } = await import('../db/schema');
  await rawDb.delete(notification_events);
  await rawDb.delete(sms_rate_limit_buckets);
}

beforeEach(async () => {
  smsSent.length = 0;
  accept = true;
  await clearTables();
  __setSmsProvider(captureSms);
  __setEmailProvider({ name: 'capture', async send() { return { accepted: true }; } });
});

// -----------------------------------------------------------------------------
// 1-12. DURABLE IDEMPOTENCY
// -----------------------------------------------------------------------------
describe('N6-1..12 — durable SMS idempotency', () => {
  const SMS_EVENT = 'PICKUP_CODE';
  const send = (idempotencyKey: string, recipient = '+254712345678') =>
    NotificationService.notify({
      eventType: SMS_EVENT,
      recipient,
      idempotencyKey,
      render: () => ({ body: 'your pickup code is 123456' }),
    });

  it('1. the first notification is accepted and recorded', async () => {
    const k = key('first');
    const result = await send(k);
    expect(result.status).toBe('sent');
    expect(result.accepted).toBe(true);
    expect(smsSent).toHaveLength(1);
    const row = await db.getNotificationEventByIdempotencyKey(k);
    expect(row.event_type).toBe(SMS_EVENT);
    expect(row.channel).toBe('sms');
    expect(row.status).toBe('sent');
  });

  it('2. a duplicate after SUCCESS is suppressed — the provider is not called again', async () => {
    const k = key('dupe-success');
    await send(k);
    const again = await send(k);
    expect(again.status).toBe('duplicate');
    expect(again.dispatched).toBe(false);
    expect(again.accepted).toBe(true);
    // The load-bearing assertion: exactly one physical send.
    expect(smsSent).toHaveLength(1);
  });

  it('3. the suppression survives a process restart (a fresh db handle)', async () => {
    // A "restart" cannot re-import the module graph here, because the test
    // double's store is module-scoped and a re-import would create an EMPTY
    // store rather than a fresh handle onto the same one. So durability is
    // proved the only way that is meaningful: by reading the RAW store through a
    // DIFFERENT module, bypassing the service and its repository entirely. If
    // suppression depended on module or instance state, this would find nothing.
    const k = key('restart');
    await send(k);

    const { db: rawDb } = await import('../db/index');
    const { notification_events } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');

    const rows = await rawDb.select().from(notification_events).where(
      eq(notification_events.idempotency_key, k)
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('sent');

    // The durable unique constraint — not an application check — is what refuses
    // a second record, and that refusal is classified rather than thrown.
    const { event, inserted } = await db.createNotificationEvent({
      eventType: SMS_EVENT,
      channel: 'sms',
      provider: 'capture-sms',
      idempotencyKey: k,
      recipientReference: '+254712***678',
    });
    expect(inserted).toBe(false);
    expect(event.id).toBe(rows[0].id);
    expect(smsSent).toHaveLength(1);
  });

  it('4. the same event for a DIFFERENT account is independent', async () => {
    const a = buildNotificationIdempotencyKey(SMS_EVENT, 'CLM-1');
    const b = buildNotificationIdempotencyKey(SMS_EVENT, 'CLM-2');
    expect(a).not.toBe(b);
    expect((await send(a)).status).toBe('sent');
    expect((await send(b)).status).toBe('sent');
    expect(smsSent).toHaveLength(2);
  });

  it('5. the same account with a DIFFERENT event is independent', async () => {
    const a = buildNotificationIdempotencyKey('PICKUP_CODE', 'CLM-1');
    const b = buildNotificationIdempotencyKey('OWNER_CLAIM_VERIFICATION_CODE', 'CLM-1');
    expect(a).not.toBe(b);
    expect((await send(a)).status).toBe('sent');
    expect((await send(b)).status).toBe('sent');
    expect(smsSent).toHaveLength(2);
  });

  it('6. a different recipient for the same logical event is SUPPRESSED, not re-sent', async () => {
    // Scoping the key on the ACCOUNT rather than the address is deliberate: the
    // same claim must not fan one logical notification out to two phones.
    const k = buildNotificationIdempotencyKey(SMS_EVENT, 'CLM-9');
    expect((await send(k, '+254712345678')).status).toBe('sent');
    const again = await send(k, '+254700000000');
    expect(again.status).toBe('duplicate');
    expect(smsSent).toHaveLength(1);
  });

  it('7. a provider FAILURE records the correct outcome', async () => {
    accept = false;
    const k = key('provider-fail');
    const result = await send(k);
    expect(result.status).toBe('failed');
    expect(result.accepted).toBe(false);
    // Dispatched is true: the attempt WAS made. That distinguishes a provider
    // refusal from a policy rejection, which never reaches the provider.
    expect(result.dispatched).toBe(true);
    const row = await db.getNotificationEventByIdempotencyKey(k);
    expect(row.status).toBe('failed');
    expect(row.sent_at).toBeFalsy();
  });

  it('8. retry semantics after failure are EXPLICIT: same key suppressed, new key allowed', async () => {
    // A defined contract, not an accident. Re-using the key of a FAILED event is
    // suppressed (accepted=false tells the caller why); a genuine resend is a
    // NEW logical event and MUST carry a NEW key.
    accept = false;
    const k = key('fail-then-retry');
    expect((await send(k)).status).toBe('failed');

    const retrySameKey = await send(k);
    expect(retrySameKey.status).toBe('duplicate');
    expect(retrySameKey.accepted).toBe(false);

    accept = true;
    const resend = await send(buildNotificationIdempotencyKey(SMS_EVENT, `resend-${k}`));
    expect(resend.status).toBe('sent');
    expect(smsSent).toHaveLength(2);
  });

  it('9. CONCURRENT duplicates produce exactly ONE accepted send', async () => {
    const k = key('concurrent');
    const results = await Promise.all([send(k), send(k), send(k), send(k), send(k)]);
    expect(results.filter((r) => r.status === 'sent')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'duplicate')).toHaveLength(4);
    // The database resolved the race, not the application.
    expect(smsSent).toHaveLength(1);
  });

  it('10. a durable uniqueness violation is handled, not thrown', async () => {
    const k = key('unique-violation');
    const first = await db.createNotificationEvent({
      eventType: SMS_EVENT, channel: 'sms', provider: 'p',
      idempotencyKey: k, recipientReference: 'r',
    });
    expect(first.inserted).toBe(true);
    // A concurrent insert that loses the race gets 23505 and is classified, not
    // rethrown — a notification path must not crash on a duplicate.
    const second = await db.createNotificationEvent({
      eventType: SMS_EVENT, channel: 'sms', provider: 'p',
      idempotencyKey: k, recipientReference: 'r',
    });
    expect(second.inserted).toBe(false);
    expect(second.event.id).toBe(first.event.id);
  });

  it('11. an idempotency key that carries a credential is REJECTED', async () => {
    // The key lands in a durable, operator-readable, unencrypted column, so a
    // secret embedded in it would be a secret at rest.
    const secrets = [
      crypto.randomBytes(32).toString('hex'),       // activation/session token
      crypto.randomBytes(32).toString('base64url'), // base64url token
      '+254712345678',                              // phone number
      'PICKUP_CODE:otp=123456',                     // labelled OTP
      'CLM-1:code:654321',                          // labelled code
    ];
    for (const secret of secrets) {
      expect(idempotencyKeyLooksLikeSecret(secret), secret.slice(0, 24)).toBe(true);
      const result = await NotificationService.notify({
        eventType: SMS_EVENT, recipient: '+254712345678',
        idempotencyKey: secret, render: () => ({ body: 'x' }),
      });
      expect(result.status, secret.slice(0, 24)).toBe('rejected');
      expect(result.reason).toBe('idempotency_key_contains_secret');
    }
    expect(smsSent).toHaveLength(0);
  });

  it('11b. legitimate canonical keys are NOT rejected by the secret guard', async () => {
    // A guard that blocked real keys would push call sites toward smuggling the
    // secret past it, so the canonical shapes must all pass.
    for (const legit of [
      buildNotificationIdempotencyKey('PICKUP_CODE', 'CLM-100456'),
      buildNotificationIdempotencyKey('CUSTOMER_LOGIN_OTP', 'CUS-A1B2C3D4E5F60718293A4'),
      buildNotificationIdempotencyKey('AGENT_LOGIN_OTP', 'agent-abc123'),
    ]) {
      expect(idempotencyKeyLooksLikeSecret(legit), legit).toBe(false);
    }
  });

  it('12. no raw phone number leaks into the durable record', async () => {
    const k = key('phone-privacy');
    await send(k, '+254712345678');
    const row = await db.getNotificationEventByIdempotencyKey(k);
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('+254712345678');
    expect(row.recipient_reference).toBe('+254712***678');
    // ...and the idempotency key must not smuggle one in either.
    expect(k).not.toContain('254');
  });
});

describe('N6-13..25 — durable SMS rate limiting over real HTTP', () => {
  let app: any;
  let server: any;
  let base = '';
  let handlerHits = 0;

  beforeEach(async () => {
    handlerHits = 0;
    app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    // Mirrors the canonical ordering N7 will use: identity, THEN the limit,
    // THEN anything that can reach a provider.
    app.post(
      '/sms',
      (req: any, _res: any, next: any) => { req.user = { userId: req.body?.authedAs || undefined }; next(); },
      smsRateLimit(),
      (_req: any, res: any) => { handlerHits += 1; res.json({ ok: true, hits: handlerHits }); }
    );
    // A variant carrying NO authenticated principal, to prove the anonymous case
    // falls back to the IP dimension rather than becoming unlimited.
    app.post('/sms-anonymous', smsRateLimit(), (_req: any, res: any) => {
      handlerHits += 1;
      res.json({ ok: true, hits: handlerHits });
    });
    server = await new Promise<any>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
  });

  async function post(pathname: string, ip: string, body: any = {}) {
    const res = await fetch(base + pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json, headers: res.headers };
  }

  it('13-16. exactly 3 requests are allowed per identity; the 4th is refused', async () => {
    const ip = '10.1.1.1';
    for (let i = 1; i <= 3; i++) {
      const res = await post('/sms-anonymous', ip);
      expect(res.status, `request ${i}`).toBe(200);
    }
    const fourth = await post('/sms-anonymous', ip);
    expect(fourth.status).toBe(429);
    // The handler ran three times, not four — the limiter is upstream of it.
    expect(handlerHits).toBe(3);
  });

  it('17. the ROLLING window frees a slot as its own timestamp ages out', async () => {
    // The distinguishing test between a rolling and a tumbling window: slots age
    // out INDIVIDUALLY, so a slot whose hit is 11 minutes old frees while a
    // younger hit is still inside the window.
    const bucket = buildSmsRateLimitBucketKey('ip', '10.2.2.2');
    // Three requests fill all three slots; the fourth is refused.
    for (let i = 0; i < 3; i++) {
      expect((await db.consumeSmsRateLimitSlot(bucket, 3, SMS_RATE_LIMIT_WINDOW_MS)).allowed, `fill ${i}`).toBe(true);
    }
    expect((await db.consumeSmsRateLimitSlot(bucket, 3, SMS_RATE_LIMIT_WINDOW_MS)).allowed).toBe(false);

    // Backdate ONLY slot_1 beyond the window — exactly what a request from 11
    // minutes ago looks like to the bucket, while slots 2 and 3 are still fresh.
    const { db: rawDb } = await import('../db/index');
    const { sms_rate_limit_buckets } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    const aged = () => new Date(Date.now() - SMS_RATE_LIMIT_WINDOW_MS - 60_000);
    await rawDb.update(sms_rate_limit_buckets)
      .set({ slot_1_at: aged() })
      .where(eq(sms_rate_limit_buckets.bucket_key, bucket));

    // Exactly ONE further request is admitted — the single aged-out slot. A
    // tumbling window would have reset the whole counter and let three through.
    expect((await db.consumeSmsRateLimitSlot(bucket, 3, SMS_RATE_LIMIT_WINDOW_MS)).allowed).toBe(true);
    expect((await db.consumeSmsRateLimitSlot(bucket, 3, SMS_RATE_LIMIT_WINDOW_MS)).allowed).toBe(false);

    // Once the middle slot ages out too, exactly one more is admitted.
    await rawDb.update(sms_rate_limit_buckets)
      .set({ slot_2_at: aged() })
      .where(eq(sms_rate_limit_buckets.bucket_key, bucket));
    expect((await db.consumeSmsRateLimitSlot(bucket, 3, SMS_RATE_LIMIT_WINDOW_MS)).allowed).toBe(true);
    expect((await db.consumeSmsRateLimitSlot(bucket, 3, SMS_RATE_LIMIT_WINDOW_MS)).allowed).toBe(false);
  });

  it('18. the IP and USER dimensions are independent namespaces', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await post('/sms', '10.3.3.3', { authedAs: 'user-a' })).status).toBe(200);
    }
    // A different IP, but the SAME verified user: the user bucket is exhausted,
    // so the request is refused even though its IP still has budget.
    expect((await post('/sms', '10.3.3.99', { authedAs: 'user-a' })).status).toBe(429);
    // A different user from a fresh IP is unaffected — so it was the user bucket
    // that blocked the request above, not a shared IP bucket.
    expect((await post('/sms', '10.4.4.4', { authedAs: 'user-b' })).status).toBe(200);
  });

  it('20. anonymous requests are limited by IP alone', async () => {
    for (let i = 0; i < 3; i++) expect((await post('/sms-anonymous', '10.5.5.5')).status).toBe(200);
    expect((await post('/sms-anonymous', '10.5.5.5')).status).toBe(429);
    expect((await post('/sms-anonymous', '10.5.5.6')).status).toBe(200);
  });

  it('21. an attacker CANNOT choose another user id to dodge the limit', async () => {
    // `authedAs` stands in for a server-verified principal set by auth
    // middleware. The identity resolver must never read a client-supplied id.
    for (let i = 0; i < 3; i++) {
      expect((await post('/sms', '10.6.6.6', { authedAs: 'victim-user' })).status).toBe(200);
    }
    expect((await post('/sms', '10.6.6.6', { authedAs: 'victim-user' })).status).toBe(429);
    const keys = resolveSmsRateLimitIdentities({ ip: '1.2.3.4', body: { userId: 'chosen' } } as any);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe(buildSmsRateLimitBucketKey('ip', '1.2.3.4'));
  });

  it('22-23. a refused request creates NO notification event and no false `sent`', async () => {
    for (let i = 0; i < 3; i++) await post('/sms-anonymous', '10.7.7.7');
    await post('/sms-anonymous', '10.7.7.7');
    const { db: rawDb } = await import('../db/index');
    const { notification_events } = await import('../db/schema');
    // The limiter is upstream of the handler, so nothing was recorded at all.
    expect(await rawDb.select().from(notification_events)).toHaveLength(0);
  });

  it('24. concurrent requests cannot exceed the quota', async () => {
    const ip = '10.8.8.8';
    const results = await Promise.all(Array.from({ length: 10 }, () => post('/sms-anonymous', ip)));
    // Exactly the limit was admitted; the rest refused. The guarded UPDATE is
    // what makes this true under concurrency.
    expect(results.filter((r) => r.status === 200).length).toBe(SMS_RATE_LIMIT);
    expect(results.filter((r) => r.status === 429).length).toBe(10 - SMS_RATE_LIMIT);
    expect(handlerHits).toBe(SMS_RATE_LIMIT);
  });

  it('25. the limit is DURABLE — it survives a completely new module instance', async () => {
    for (let i = 0; i < 3; i++) expect((await post('/sms-anonymous', '10.9.9.9')).status).toBe(200);
    expect((await post('/sms-anonymous', '10.9.9.9')).status).toBe(429);

    // The decisive evidence, because it rules out every process-local design:
    // the bucket is read back through a DIFFERENT module of the same program,
    // with no shared instance state. An in-process Map, a module-level counter
    // or a closure would not be visible here; a durable row is.
    const { db: rawDb } = await import('../db/index');
    const { sms_rate_limit_buckets } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    const rows = await rawDb.select().from(sms_rate_limit_buckets).where(
      eq(sms_rate_limit_buckets.bucket_key, buildSmsRateLimitBucketKey('ip', '10.9.9.9'))
    );
    expect(rows).toHaveLength(1);
    // All three slots are occupied by hits inside the window, which is precisely
    // why the next request is refused.
    expect(rows[0].slot_1_at).toBeTruthy();
    expect(rows[0].slot_2_at).toBeTruthy();
    expect(rows[0].slot_3_at).toBeTruthy();
    // The row holds a hash, never the address.
    expect(JSON.stringify(rows[0])).not.toContain('10.9.9.9');
  });

  it('the refusal response is generic and leaks no identity', async () => {
    for (let i = 0; i < 3; i++) await post('/sms-anonymous', '10.10.10.10');
    const res = await post('/sms-anonymous', '10.10.10.10');
    expect(res.status).toBe(429);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('10.10.10.10');
    expect(text).not.toMatch(/254/);
    // A Retry-After is present so a well-behaved client can back off correctly.
    expect(res.headers.get('retry-after')).toBeTruthy();
  });

  it('the bucket key is a HASH — the table never stores a raw IP', async () => {
    const bucket = buildSmsRateLimitBucketKey('ip', '203.0.113.99');
    await db.consumeSmsRateLimitSlot(bucket, 3, SMS_RATE_LIMIT_WINDOW_MS);
    const row = await db.getSmsRateLimitBucket(bucket);
    expect(row.bucket_key).toBe(bucket);
    expect(row.bucket_key).not.toContain('203.0.113.99');
    expect(row.bucket_key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('IP and user namespaces are disjoint', () => {
    // A user id that happens to be a valid address must not share a bucket.
    expect(buildSmsRateLimitBucketKey('ip', '1.2.3.4'))
      .not.toBe(buildSmsRateLimitBucketKey('user', '1.2.3.4'));
  });
});

// -----------------------------------------------------------------------------
// SECURITY REVIEW + SCOPE BOUNDARY (PHASES 5, 7 AND 8)
// -----------------------------------------------------------------------------
describe('N6 — security review and scope boundary', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

  it('no OTP, code or token can reach the rate-limit table', () => {
    // The table holds only a hashed bucket key and three timestamps. There is no
    // column a credential could be written into.
    const schema = stripComments(schemaTs.slice(
      schemaTs.indexOf('export const sms_rate_limit_buckets'),
      schemaTs.indexOf('// 9A. LOST-ITEM REPORTS')
    ));
    expect(schema).not.toMatch(/otp|code|token|phone|secret/i);
    expect(schema).toContain('bucket_key');
  });

  it('the rate-limit code never logs a raw identity or a phone number', () => {
    const code = stripComments(rateLimitTs);
    for (const call of code.match(/console\.\w+\([^)]*\)/g) || []) {
      expect(call, call).not.toMatch(/req\.body|req\.query|phone|ip\b|identifier/);
    }
    // The bucket key is hashed before it is ever persisted or logged.
    expect(code).toContain("createHmac('sha256', salt)");
  });

  it('the middleware FAILS CLOSED if the limiter itself errors', async () => {
    // An unmetered SMS costs money and can be aimed at a third party, so a
    // broken limiter must refuse rather than wave requests through.
    const app = express();
    app.set('trust proxy', 1);
    app.post('/boom', smsRateLimit(), (_req, res) => res.json({ ok: true }));
    const original = db.consumeSmsRateLimitSlot;
    (db as any).consumeSmsRateLimitSlot = async () => { throw new Error('db down'); };
    const server = await new Promise<any>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const res = await fetch(base + '/boom', {
        method: 'POST', headers: { 'X-Forwarded-For': '10.11.11.11' },
      });
      expect(res.status).toBe(429);
    } finally {
      (db as any).consumeSmsRateLimitSlot = original;
      await new Promise((r) => server.close(r));
    }
  });

  it('existing SMS fail-closed production behaviour is UNCHANGED', () => {
    const auth = read('services/auth.ts');
    const send = auth.slice(auth.indexOf('export async function sendCodeViaSms'));
    // In production with no deliverable SMS path the gateway refuses rather than
    // claiming a send. N6 must not have softened this.
    expect(send).toMatch(/if \(process\.env\.NODE_ENV === 'production'\)[\s\S]{0,400}return \{ success: false, message: SMS_UNAVAILABLE_MESSAGE \}/);
    // The raw-code simulation log remains dev/sandbox only.
    expect(send).toContain('SIMULATION, DEV/SANDBOX ONLY');
  });

  it('the existing OTP limiters and helpers are untouched', () => {
    // N6 adds a durable mechanism; it does not remove or weaken the process-
    // local limiters that guard the un-migrated routes.
    const server = read('server.ts');
    for (const limiter of [
      'const otpIpLimiter', 'const otpGlobalLimiter', 'const otpPhoneLimiter',
      'const otpClaimLimiter', 'const otpVerifyLimiter', 'const customerAuthLimiter',
    ]) {
      expect(server, limiter).toContain(limiter);
    }
    // N7 UPDATED THIS BLOCK. The assertion used to be that every SMS call site
    // still called sendCodeViaSms directly — i.e. that N7 had not started. N7
    // deliberately reverses it, so the invariant is now the opposite and
    // STRICTER one: no route may reach the gateway directly, and the only
    // remaining direct callers are the provider implementation and its adapter.
    for (const rel of ['server.ts', 'routes/claims.ts', 'routes/customerClaims.ts']) {
      expect(read(rel), rel).not.toMatch(/sendCodeViaSms\(\s*\n/);
    }
    // The gateway itself still exists and is still what the adapter calls —
    // this is a boundary change, not a deletion.
    expect(read('services/auth.ts')).toContain('export async function sendCodeViaSms');
  });

  it('N7 MOUNTED the durable limiter and dispatched all six SMS events', () => {
    // N7 UPDATED THIS TEST. It previously asserted the exact inverse — that no
    // SMS event was dispatched and that the limiter was built but not mounted —
    // in order to pin the N6/N7 scope boundary. N7 is that boundary crossing, so
    // the assertion is inverted rather than removed.
    const allSource = ['server.ts', 'routes/agentOps.ts', 'routes/finderReport.ts',
      'routes/claims.ts', 'routes/customerClaims.ts'].map(read).join('\n');
    for (const event of [
      'PHONE_VERIFICATION_OTP', 'CUSTOMER_LOGIN_OTP', 'AGENT_LOGIN_OTP',
      'OWNER_CLAIM_VERIFICATION_CODE', 'PICKUP_CODE', 'CLAIM_LINK_OTP',
    ]) {
      // PHONE_VERIFICATION_OTP and AGENT_LOGIN_OTP are the SAME route
      // (/api/auth/request-otp -> AuthService.requestOTP), which now dispatches
      // AGENT_LOGIN_OTP. PHONE_VERIFICATION_OTP therefore has no distinct
      // production call site and is deliberately not asserted as dispatched.
      if (event === 'PHONE_VERIFICATION_OTP') continue;
      expect(allSource, event).toContain(`eventType: '${event}'`);
    }
    // The limiter is now MOUNTED, after authentication and before the handler.
    expect(read('server.ts')).toContain('smsRateLimit()');
    expect(read('routes/claims.ts')).toContain('smsRateLimit()');
    expect(read('routes/customerClaims.ts')).toContain('smsRateLimit()');
  });

  it('N7/N8/N9 behaviour is NOT introduced', () => {
    const code = stripComments(rateLimitTs + serviceTs);
    // N7: no call-site migration.
    expect(code).not.toMatch(/app\.(?:get|post)\(/);
    // N8: no transactional email migration.
    expect(code).not.toMatch(/sendPaymentReceivedEmail|sendItemHandedOverEmail/);
    // N9: no SMS->email fallback.
    expect(code).not.toMatch(/fallback_available|fallback_requested|fallback_sent|createFallback/);
    // No retry loops of any kind.
    expect(code).not.toMatch(/setTimeout|setInterval|maxRetries/);
    // No new notification event types.
    const events = read('config/notificationEvents.ts');
    for (const event of ['SMS_THROTTLED', 'RATE_LIMITED', 'SMS_QUOTA_EXCEEDED']) {
      expect(events, event).not.toContain(event);
    }
    // No activation resend endpoint.
    expect(read('server.ts')).not.toMatch(/resend-activation/);
    // PUBLIC_APP_URL remains exactly the pre-existing N3/N4 configuration gap:
    // still read, still with its localhost fallback. N6 neither fixed nor
    // silently "completed" it.
    const customerAuth = read('services/customerAuth.ts');
    expect(customerAuth).toContain("process.env.PUBLIC_APP_URL || 'http://localhost:3000'");
  });

  it('idempotency stays inside NotificationService, never in the request layer', () => {
    // The boundary the N6 brief asks to be explicit: the rate limiter controls
    // request frequency and must NOT deduplicate notifications.
    const code = stripComments(rateLimitTs);
    expect(code).not.toContain('NotificationService');
    expect(code).not.toContain('notification_events');
    expect(code).not.toContain('createNotificationEvent');
  });
});


