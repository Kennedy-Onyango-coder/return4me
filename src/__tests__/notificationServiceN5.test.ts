// =============================================================================
// N5 — NOTIFICATION SERVICE + POLICY.
//
// Two classes of assertion, matching the two things N5 actually claims:
//
//  1. EXECUTED against the real database and the real service. These witness the
//     durable row, the dedup decision and the provider delegation actually
//     happening — not a description of them.
//  2. SOURCE assertions, only for the negative guarantees that are cheaper to
//     state structurally than to execute (e.g. "no body is ever written to the
//     event row", which is a claim about the whole call graph).
//
// Providers are NEVER real. The email adapter is swapped for a capture, exactly
// as lifecycleHttpE2E and the N3/N4 suites already do, and the SMS path is
// asserted at the policy/adapter layer only — no SMS is sent in this file.
// =============================================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { db } from '../db/database';
import {
  getNotificationPolicy,
  isKnownNotificationEvent,
  getPermittedChannel,
  NOTIFICATION_EVENT_TYPES,
  ABSENT_EVENTS,
} from '../config/notificationEvents';
import {
  NotificationService,
  buildNotificationIdempotencyKey,
  recipientReferenceFor,
  __setEmailProvider,
  __setSmsProvider,
} from '../services/notificationService';
import { sanitizeProviderError } from '../services/notificationProviders';
import { EmailService } from '../services/email';

// A capture adapter. Nothing leaves the process.
const sent: Array<{ channel: string; to: string; subject: string; body: string }> = [];
let accept = true;

const captureEmail = {
  name: 'capture-email',
  async send(to: string, subject: string, body: string) {
    sent.push({ channel: 'email', to, subject, body });
    return { accepted: accept, providerMessageId: 'fake-1', error: accept ? null : 'capture_rejected' };
  },
};
const captureSms = {
  name: 'capture-sms',
  async send(to: string, body: string) {
    sent.push({ channel: 'sms', to, subject: '', body });
    return { accepted: accept, providerMessageId: null, error: accept ? null : 'capture_rejected' };
  },
};

const serverTs = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');
const serviceTs = fs.readFileSync(path.resolve(__dirname, '../services/notificationService.ts'), 'utf8');
const providerTs = fs.readFileSync(path.resolve(__dirname, '../services/notificationProviders.ts'), 'utf8');
const dbTs = fs.readFileSync(path.resolve(__dirname, '../db/database.ts'), 'utf8');

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let n = 0;
const key = (label: string) => `n5-${label}-${Date.now()}-${n++}`;

/** Clears the durable table so idempotency assertions are deterministic. */
async function clearEvents() {
  const { db: rawDb } = await import('../db/index');
  const { notification_events } = await import('../db/schema');
  await rawDb.delete(notification_events);
}

beforeEach(async () => {
  sent.length = 0;
  accept = true;
  await clearEvents();
  __setEmailProvider(captureEmail);
  __setSmsProvider(captureSms);
});

// -----------------------------------------------------------------------------
// 1-4. EVENT VALIDATION AND POLICY
// -----------------------------------------------------------------------------
describe('N5-1..4 — canonical event vocabulary and policy', () => {
  it('recognises every declared event and rejects anything else', () => {
    expect(NOTIFICATION_EVENT_TYPES.length).toBeGreaterThan(0);
    for (const type of NOTIFICATION_EVENT_TYPES) {
      expect(getNotificationPolicy(type), type).not.toBeNull();
      expect(isKnownNotificationEvent(type), type).toBe(true);
    }
    for (const bogus of ['NOT_A_THING', '', 'customer_email_activation', 'CUSTOMER EMAIL ACTIVATION']) {
      expect(getNotificationPolicy(bogus), bogus).toBeNull();
      expect(isKnownNotificationEvent(bogus), bogus).toBe(false);
    }
  });

  it('routes URGENCY events to SMS and everything else to email', () => {
    for (const type of NOTIFICATION_EVENT_TYPES) {
      const policy = getNotificationPolicy(type)!;
      // The policy invariant N1's routing decision implies: a 'urgent' event is
      // read in seconds at a counter, so it is SMS; a 'transactional' one is
      // asynchronous or asset-heavy, so it is email.
      expect(policy.channel, type).toBe(policy.priority === 'urgent' ? 'sms' : 'email');
    }
  });

  it('classifies the counter-interaction events as urgent SMS', () => {
    for (const type of ['PICKUP_CODE', 'OWNER_CLAIM_VERIFICATION_CODE', 'CUSTOMER_LOGIN_OTP']) {
      expect(getPermittedChannel(type), type).toBe('sms');
      expect(getNotificationPolicy(type)!.priority, type).toBe('urgent');
    }
  });

  it('classifies account activation as transactional EMAIL', () => {
    expect(getPermittedChannel('CUSTOMER_EMAIL_ACTIVATION')).toBe('email');
    expect(getPermittedChannel('AGENT_EMAIL_ACTIVATION')).toBe('email');
  });

  it('does NOT invent events the application does not emit', () => {
    // Each of these was suggested for the vocabulary but has no trigger in the
    // current source. Defining it would create vocabulary that reads as
    // supported but can never fire.
    for (const type of ABSENT_EVENTS) {
      expect(getNotificationPolicy(type), type).toBeNull();
      expect(NOTIFICATION_EVENT_TYPES, type).not.toContain(type);
    }
  });

  it('the policy sends nothing — it is a pure lookup', () => {
    const code = stripComments(fs.readFileSync(
      path.resolve(__dirname, '../config/notificationEvents.ts'), 'utf8'
    ));
    // No runtime dependency of any kind: no provider, no database, no network.
    // The `origin` provenance strings legitimately NAME EmailService methods —
    // they are documentation of where a call site currently lives, not calls —
    // so what is asserted is the absence of imports and invocations.
    expect(code).not.toMatch(/^import /m);
    expect(code).not.toMatch(/\bawait\b/);
    expect(code).not.toMatch(/EmailService\.\w+\(/);
    expect(code).not.toMatch(/sendCodeViaSms\(/);
    expect(code).not.toMatch(/fetch\(/);
  });

  it('rejects an unsupported event WITHOUT sending or storing anything', async () => {
    const result = await NotificationService.notify({
      eventType: 'TOTALLY_MADE_UP',
      recipient: 'someone@example.com',
      idempotencyKey: key('bogus'),
      render: () => ({ subject: 's', body: 'b' }),
    });
    expect(result.status).toBe('rejected');
    expect(result.reason).toBe('unknown_event_type');
    expect(result.dispatched).toBe(false);
    expect(sent).toHaveLength(0);
    expect(await db.getNotificationEventByIdempotencyKey(key('bogus'))).toBeUndefined();
  });

  it('rejects a MISSING idempotency key rather than generating one', async () => {
    // Generating a random or timestamped key here would make every call unique
    // and silently defeat deduplication.
    const result = await NotificationService.notify({
      eventType: 'CUSTOMER_EMAIL_ACTIVATION',
      recipient: 'someone@example.com',
      render: () => ({ subject: 's', body: 'b' }),
    } as any);
    expect(result.status).toBe('rejected');
    expect(result.reason).toBe('missing_idempotency_key');
    expect(sent).toHaveLength(0);
  });

  it('rejects a blank recipient', async () => {
    const result = await NotificationService.notify({
      eventType: 'CUSTOMER_EMAIL_ACTIVATION',
      recipient: '   ',
      idempotencyKey: key('blank'),
      render: () => ({ subject: 's', body: 'b' }),
    });
    expect(result.status).toBe('rejected');
    expect(result.reason).toBe('missing_recipient');
    expect(sent).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// 5-11. DURABLE EVENT, IDEMPOTENCY, RECIPIENT NORMALIZATION, PROVIDER DELEGATION
// -----------------------------------------------------------------------------
describe('N5-5..11 — durable event, idempotency and provider delegation', () => {
  it('creates the durable event and delegates to the email provider', async () => {
    const k = key('basic');
    const result = await NotificationService.notify({
      eventType: 'CUSTOMER_EMAIL_ACTIVATION',
      recipient: 'Someone@Example.COM',
      idempotencyKey: k,
      render: () => ({ subject: 'Activate', body: '<p>hello</p>' }),
    });
    expect(result.status).toBe('sent');
    expect(result.accepted).toBe(true);
    expect(result.dispatched).toBe(true);

    const row = await db.getNotificationEventByIdempotencyKey(k);
    expect(row).toBeTruthy();
    expect(row.event_type).toBe('CUSTOMER_EMAIL_ACTIVATION');
    expect(row.channel).toBe('email');
    expect(row.status).toBe('sent');
    expect(row.sent_at).toBeTruthy();
    expect(row.idempotency_key).toBe(k);
    // The provider actually received the rendered content.
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toBe('<p>hello</p>');
  });

  it('normalizes the recipient: email is trimmed and lower-cased', async () => {
    await NotificationService.notify({
      eventType: 'CUSTOMER_EMAIL_ACTIVATION',
      recipient: '  Mixed.Case@Example.COM  ',
      idempotencyKey: key('norm-email'),
      render: () => ({ subject: 's', body: 'b' }),
    });
    // The provider receives the normalized value, not the raw input.
    expect(sent[0].to).toBe('mixed.case@example.com');
  });

  it('normalizes the recipient: SMS uses the app\'s existing E.164 canonicalizer', async () => {
    await NotificationService.notify({
      eventType: 'PICKUP_CODE',
      recipient: '0712345678',
      idempotencyKey: key('norm-sms'),
      render: () => ({ body: 'your code' }),
    });
    // toE164Kenyan, the SAME canonicalizer the OTP stores use, so a notification
    // row and an OTP row cannot disagree about who the recipient is.
    expect(sent[0].to).toBe('+254712345678');
  });

  it('stores only an OPAQUE, MASKED recipient reference', async () => {
    const k = key('masked');
    await NotificationService.notify({
      eventType: 'CUSTOMER_EMAIL_ACTIVATION',
      recipient: 'real.person@example.com',
      idempotencyKey: k,
      render: () => ({ subject: 's', body: 'b' }),
    });
    const row = await db.getNotificationEventByIdempotencyKey(k);
    // Enough to tell recipients apart in an operator view, not a contact list.
    expect(row.recipient_reference).toBe('r***@example.com');
    expect(row.recipient_reference).not.toContain('real.person');
    expect(JSON.stringify(row)).not.toContain('real.person@example.com');
  });

  it('masks an SMS recipient with the app\'s existing masker', async () => {
    const k = key('masked-sms');
    await NotificationService.notify({
      eventType: 'PICKUP_CODE',
      recipient: '+254712345678',
      idempotencyKey: k,
      render: () => ({ body: 'code' }),
    });
    const row = await db.getNotificationEventByIdempotencyKey(k);
    expect(row.recipient_reference).toBe('+254712***678');
    expect(row.recipient_reference).not.toBe('+254712345678');
  });

  it('is IDEMPOTENT: a duplicate key is recorded once and NOT re-sent', async () => {
    const k = key('dupe');
    const first = await NotificationService.notify({
      eventType: 'CUSTOMER_EMAIL_ACTIVATION',
      recipient: 'dupe@example.com',
      idempotencyKey: k,
      render: () => ({ subject: 's', body: 'first' }),
    });
    const second = await NotificationService.notify({
      eventType: 'CUSTOMER_EMAIL_ACTIVATION',
      recipient: 'dupe@example.com',
      idempotencyKey: k,
      render: () => ({ subject: 's', body: 'second' }),
    });
    expect(first.status).toBe('sent');
    expect(second.status).toBe('duplicate');
    expect(second.dispatched).toBe(false);
    // The load-bearing assertion: exactly ONE message left the system.
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toBe('first');
  });

  it('the idempotency key builder is deterministic and account-scoped', () => {
    const a = buildNotificationIdempotencyKey('CUSTOMER_EMAIL_ACTIVATION', 'CUS-1');
    expect(a).toBe(buildNotificationIdempotencyKey('CUSTOMER_EMAIL_ACTIVATION', 'CUS-1'));
    // A different account, or a different event, is a different notification.
    expect(a).not.toBe(buildNotificationIdempotencyKey('CUSTOMER_EMAIL_ACTIVATION', 'CUS-2'));
    expect(a).not.toBe(buildNotificationIdempotencyKey('AGENT_EMAIL_ACTIVATION', 'CUS-1'));
    // Never a timestamp or a random value, which would defeat dedup entirely.
    expect(a).not.toMatch(/\d{10,}/);
  });

  it('persists a provider FAILURE without leaking a provider payload', async () => {
    accept = false;
    const k = key('fail');
    const result = await NotificationService.notify({
      eventType: 'CUSTOMER_EMAIL_ACTIVATION',
      recipient: 'fail@example.com',
      idempotencyKey: k,
      render: () => ({ subject: 's', body: 'b' }),
    });
    expect(result.status).toBe('failed');
    expect(result.accepted).toBe(false);
    // The attempt WAS made — dispatched is true, unlike a policy rejection.
    expect(result.dispatched).toBe(true);
    const row = await db.getNotificationEventByIdempotencyKey(k);
    expect(row.status).toBe('failed');
    expect(row.last_error).toBeTruthy();
    // A failed send is never stamped as accepted.
    expect(row.sent_at).toBeFalsy();
  });

  it('records a provider that THROWS as an unknown outcome, not a crash', async () => {
    // N9 REFINED THE EXPECTED STATUS, and the refinement is the point of this
    // phase. The test's actual purpose is preserved exactly: a throwing provider
    // is RECORDED durably and is NOT propagated into the caller as a crash, and
    // the caller still sees `failed` so no route can mistake it for success.
    //
    // What changed is only the durable status: a throw is AMBIGUOUS, not a
    // definite failure — the message may already have been delivered before the
    // transport broke. N9 records that honestly as 'unknown', which is terminal
    // and never auto-retried, rather than calling it 'failed' and inviting a
    // resend that could duplicate a delivered email.
    __setEmailProvider({
      name: 'throwing',
      async send() { throw new Error('provider exploded'); },
    });
    const k = key('throws');
    const result = await NotificationService.notify({
      eventType: 'CUSTOMER_EMAIL_ACTIVATION',
      recipient: 'boom@example.com',
      idempotencyKey: k,
      render: () => ({ subject: 's', body: 'b' }),
    });
    // The CALLER contract is unchanged.
    expect(result.status).toBe('failed');
    expect(result.accepted).toBe(false);
    // The durable record is now honest about the ambiguity.
    expect((await db.getNotificationEventByIdempotencyKey(k)).status).toBe('unknown');
  });

  it('a render() that throws is a failure, and nothing is sent', async () => {
    const k = key('render-throws');
    const result = await NotificationService.notify({
      eventType: 'CUSTOMER_EMAIL_ACTIVATION',
      recipient: 'r@example.com',
      idempotencyKey: k,
      render: () => { throw new Error('template missing'); },
    });
    expect(result.status).toBe('failed');
    expect(sent).toHaveLength(0);
    expect((await db.getNotificationEventByIdempotencyKey(k)).status).toBe('failed');
  });
});

// -----------------------------------------------------------------------------
// 12-14. TOKEN AND SECRET SAFETY IN THE DURABLE RECORD
// -----------------------------------------------------------------------------
describe('N5-12..14 — no credential ever reaches the event row or a log', () => {
  const ACTIVATION_TOKEN = 'a1b2c3d4e5f6'.repeat(5) + 'abcd'; // 64 hex chars

  it('never persists a rendered activation body in the event row', async () => {
    const k = key('token');
    const result = await NotificationService.notify({
      eventType: 'CUSTOMER_EMAIL_ACTIVATION',
      recipient: 'tokenholder@example.com',
      idempotencyKey: k,
      render: () => ({
        subject: 'Activate your Return4me account',
        body: `<a href="https://r4m.test/activate-email?token=${ACTIVATION_TOKEN}">Click</a>`,
      }),
    });
    expect(result.status).toBe('sent');
    // The provider genuinely received the link.
    expect(sent[0].body).toContain(ACTIVATION_TOKEN);

    // ...and the DURABLE record does not.
    const row = await db.getNotificationEventByIdempotencyKey(k);
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(ACTIVATION_TOKEN);
    expect(serialized).not.toContain('token=');
    expect(serialized).not.toContain('activate-email');
  });

  it('the service has NO field through which a body could be persisted', () => {
    // Structural, not incidental: `render` is a callback, so the rendered string
    // never exists as a request property that could be logged or serialized.
    expect(serviceTs).toMatch(/render\?: \(\) =>/);
    // The only columns the insert writes are identity + status. Scoped to THIS
    // method's own .values({...}) block — bounded to the next method, so the
    // assertion cannot accidentally reach the activation-token code that follows
    // further down the file and produce a misleading match.
    const methodStart = dbTs.indexOf('public async createNotificationEvent');
    const nextMethod = dbTs.indexOf('public async', methodStart + 10);
    const method = stripComments(dbTs.slice(methodStart, nextMethod));
    const valuesStart = method.indexOf('.values({');
    const valuesEnd = method.indexOf('.returning()', valuesStart);
    expect(valuesStart, 'values block').toBeGreaterThan(-1);
    expect(valuesEnd, 'returning').toBeGreaterThan(valuesStart);
    const values = method.slice(valuesStart, valuesEnd);
    for (const column of ['event_type', 'channel', 'provider', 'idempotency_key', 'recipient_reference', 'status']) {
      expect(values, column).toContain(column);
    }
    // No message content, and no credential, has a field to be written into.
    for (const forbidden of ['body', 'html', 'subject', 'token']) {
      expect(values, forbidden).not.toContain(forbidden);
    }
  });

  it('sanitizes a provider error so a token cannot come to rest in last_error', () => {
    // A provider exception can carry a request body; for an activation email
    // that body contains a live link. last_error is a durable operator column.
    const dirty = 'Resend rejected https://x.test/activate-email?token=SECRETTOKEN&a=1';
    const safe = sanitizeProviderError(dirty);
    expect(safe).not.toContain('SECRETTOKEN');
    expect(safe).toContain('[redacted]');
    // Bounded, so the column cannot become a payload store.
    expect(sanitizeProviderError('x'.repeat(5000)).length).toBeLessThanOrEqual(200);
    // An unknown object is never stringified — it can hold an API key.
    expect(sanitizeProviderError({ apiKey: 'sk-live-secret' })).toBe('provider_error');
    expect(sanitizeProviderError(new Error('plain message'))).toBe('plain message');
  });

  it('the service never logs a rendered body or a recipient', () => {
    const code = stripComments(serviceTs);
    // The only console call is the event-record failure, which logs an Error
    // object and no request data.
    const consoleCalls = code.match(/console\.\w+\([^)]*\)/g) || [];
    for (const call of consoleCalls) {
      expect(call, call).not.toMatch(/rendered|body|subject|recipient\b/);
    }
  });
});

// -----------------------------------------------------------------------------
// 15-20. PROVIDER SEAMS, EXISTING BEHAVIOUR, AND NO N6-N9 SCOPE CREEP
// -----------------------------------------------------------------------------
describe('N5-15..20 — provider abstraction and preserved existing behaviour', () => {
  it('the email adapter still delegates to the REAL EmailService', async () => {
    // N5 wraps the provider; it does not replace it. The fail-closed production
    // behaviour inside EmailService.send must keep running for real calls.
    expect(providerTs).toContain('EmailService.sendWithId(to, subject, html)');
    expect(typeof EmailService.send).toBe('function');
  });

  it('the SMS adapter still delegates to the REAL sendCodeViaSms', () => {
    expect(providerTs).toContain('sendCodeViaSms(phone');
    // The provider's own production fail-closed behaviour is untouched, because
    // the adapter calls the real function rather than reimplementing it.
    const authTs = fs.readFileSync(path.resolve(__dirname, '../services/auth.ts'), 'utf8');
    expect(authTs).toContain('SMS_UNAVAILABLE_MESSAGE');
    // In production with no deliverable SMS path, the gateway REFUSES rather than
    // claiming a send. N5 must not have removed that.
    const productionBranch = authTs.slice(authTs.indexOf('export async function sendCodeViaSms'));
    expect(productionBranch).toMatch(/if \(process\.env\.NODE_ENV === 'production'\)[\s\S]{0,400}return \{ success: false, message: SMS_UNAVAILABLE_MESSAGE \}/);
  });

  it('both provider seams are independently overridable', () => {
    // A coarse seam added ALONGSIDE the existing EmailService.send mock, not
    // instead of it, so no existing test lost a hook.
    expect(serviceTs).toContain('export function __setEmailProvider');
    expect(serviceTs).toContain('export function __setSmsProvider');
  });

  it('the customer activation call site now routes through the service', () => {
    const body = serverTs.slice(serverTs.indexOf("app.post('/api/customer/register'"));
    const send = body.slice(0, body.indexOf("app.post('/api/customer/activate'"));
    expect(send).toContain("eventType: 'CUSTOMER_EMAIL_ACTIVATION'");
    expect(send).toContain('NotificationService.notify');
    // It no longer calls EmailService.send directly.
    expect(send).not.toContain('EmailService.send(');
    // ...and the N3 failure semantics survive verbatim.
    expect(send).toContain('if (!emailAccepted)');
    expect(send).toContain('CUSTOMER_ACTIVATION_EMAIL_FAILED');
  });

  it('the agent activation call site now routes through the service', () => {
    const body = serverTs.slice(serverTs.indexOf("app.post('/api/auth/verify-otp'"));
    expect(body).toContain("eventType: 'AGENT_EMAIL_ACTIVATION'");
    expect(body).toContain('NotificationService.notify');
    expect(body).toContain('if (!agentEmailAccepted)');
    expect(body).toContain('AGENT_ACTIVATION_EMAIL_FAILED');
  });

  it('both activation emails still render the SAME link via the SAME builders', () => {
    // N5 changed the delivery path, not the message: the existing URL builders
    // and templates are still what the recipient receives.
    expect(serverTs).toContain('buildCustomerActivationEmailHtml(fullName, buildCustomerActivationUrl(rawToken))');
    expect(serverTs).toContain('buildAgentActivationEmailHtml(businessName, buildAgentActivationUrl(rawAgentActivationToken))');
  });

  it('migrates ONLY the two activation events at N5, and N8 owns the rest', () => {
    // N8 UPDATED THIS BLOCK, but only its PHASE ANCHOR — the underlying
    // behavioural purpose is preserved and, in the email half, strengthened.
    //
    // The purpose of the email assertions is "the transactional-email flows N5
    // found still exist, in the same files, and are still rendered by the same
    // template". Before N8 they were pinned as six literal
    // `EmailService.send*Email(` call strings; N8 legitimately replaced those
    // with NotificationService dispatches, so the anchor is now the EVENT each
    // flow emits plus the render builder it uses. Same flows, same templates —
    // only the transport changed.
    const allSource = ['../server.ts', '../routes/agentOps.ts', '../routes/finderReport.ts']
      .map((rel) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8'))
      .join('\n');
    for (const event of [
      'PAYMENT_RECEIVED', 'AGENT_PAYMENT_CONFIRMED', 'ADMIN_TRANSACTION_LOG',
      'ITEM_HANDED_OVER', 'FINDER_ITEM_COLLECTED', 'ADMIN_REASSIGNMENT',
    ]) {
      expect(allSource, event).toContain(`eventType: '${event}'`);
    }
    // The same six templates are still what the recipient receives — N8 moved
    // them out of the send methods into pure builders, and both the migrated
    // callers and the compatibility wrappers go through those builders.
    const emailTs = fs.readFileSync(path.resolve(__dirname, '../services/email.ts'), 'utf8');
    for (const builder of [
      'renderSendPaymentReceivedEmail', 'renderSendAgentPaymentConfirmedEmail',
      'renderSendAdminTransactionLogEmail', 'renderSendItemHandedOverEmail',
      'renderSendFinderItemCollectedEmail', 'renderSendAdminNewReassignmentRequestEmail',
    ]) {
      expect(allSource, builder).toContain(builder);
      expect(emailTs, builder).toContain(builder);
    }
    // N7's SMS migration assertions below are unchanged.
    for (const rel of ['../routes/claims.ts', '../routes/customerClaims.ts']) {
      const src = fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
      // Migrated: they go through the notification seam and no longer name the
      // gateway. Neither file may construct a NotificationService directly —
      // it must go through the single smsNotification seam, so that key building
      // and code handling cannot diverge between call sites.
      expect(src, rel).not.toContain('sendCodeViaSms(');
      expect(src, rel).toContain('sendSmsNotification(');
      expect(src, rel).not.toContain('NotificationService');
    }
    // server.ts dispatches the three SMS events whose flows it owns, and — the
    // point of this block — still NO transactional email event (that is N8).
    for (const smsEvent of ['CUSTOMER_LOGIN_OTP', 'AGENT_LOGIN_OTP', 'PICKUP_CODE']) {
      expect(serverTs, smsEvent).toContain(`eventType: '${smsEvent}'`);
    }
    // The remaining two live in their own route modules, asserted above.
    expect(fs.readFileSync(path.resolve(__dirname, '../routes/claims.ts'), 'utf8'))
      .toContain("eventType: 'OWNER_CLAIM_VERIFICATION_CODE'");
    expect(fs.readFileSync(path.resolve(__dirname, '../routes/customerClaims.ts'), 'utf8'))
      .toContain("eventType: 'CLAIM_LINK_OTP'");
  });

  it('introduces NO N6/N7/N8/N9 behaviour', () => {
    const serviceCode = stripComments(serviceTs);
    // N6: no rate limiting, no throttle counter, no quota.
    expect(serviceCode).not.toMatch(/rateLimit|tooMany|quota|throttle/i);
    // N9: no fallback. The N2 vocabulary has fallback_* states and the service
    // must not create or transition to any of them.
    expect(serviceCode).not.toMatch(/fallback_available|fallback_requested|fallback_sent|createFallback/);
    // N9: no retry loop anywhere.
    expect(serviceCode).not.toMatch(/setTimeout|setInterval|maxRetries/);
    // Only the two N2 outcomes the service is allowed to write.
    expect(serviceCode).toMatch(/status: 'sent'/);
    expect(serviceCode).toMatch(/status: 'failed'/);
    // No second notification table.
    expect(dbTs).toContain('notificationEventsTable');
  });

  it('does not change the N2 schema', () => {
    // The vocabulary is an application concern; the table is unchanged, and its
    // channel/status CHECK constraints still govern what the service may write.
    // (schema.ts expresses them through a Drizzle sql`` template, so the raw
    // column reference is interpolated rather than written out.)
    const schemaTs = fs.readFileSync(path.resolve(__dirname, '../db/schema.ts'), 'utf8');
    expect(schemaTs).toContain("sql`${table.channel} IN ('sms', 'email')`");
    for (const status of ['pending', 'sending', 'sent', 'failed', 'fallback_available', 'fallback_requested', 'fallback_sent', 'cancelled']) {
      expect(schemaTs, status).toContain(status);
    }
  });
});

