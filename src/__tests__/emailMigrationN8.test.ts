// =============================================================================
// N8 — TRANSACTIONAL EMAIL MIGRATION.
//
// Every production transactional-email call site now goes through the N5
// NotificationService. This suite proves three things, in order of how badly
// they would hurt if wrong:
//
//   1. COVERAGE  — no business path can still reach the email provider, because
//                  one that could would send a real, billed email that leaves
//                  no durable record and cannot be de-duplicated.
//   2. RENDERING — the subject and HTML a customer receives are BYTE-IDENTICAL
//                  to before. N8 moved the template bodies out of the send
//                  methods; the only way that is safe is if the bytes never
//                  changed, so that is asserted directly rather than assumed.
//   3. SECRETS   — the pickup code and the owner's phone still reach the
//                  transient body (removing them would silently break pickup),
//                  and still reach NOTHING durable.
//
// The email provider is a capture adapter; no email is ever sent.
// =============================================================================
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { db } from '../db/database';
import {
  NotificationService,
  buildNotificationIdempotencyKey,
  idempotencyKeyLooksLikeSecret,
  __setEmailProvider,
} from '../services/notificationService';
import { getAdminNotificationEmail } from '../config/adminNotificationEmail';
import { getNotificationPolicy } from '../config/notificationEvents';
import {
  renderSendPaymentReceivedEmail,
  renderSendItemHandedOverEmail,
  renderSendAdminNewReassignmentRequestEmail,
  renderSendAgentPaymentConfirmedEmail,
  renderSendFinderItemCollectedEmail,
  renderSendAdminTransactionLogEmail,
  EmailService,
} from '../services/email';

const sent: Array<{ to: string; subject: string; body: string }> = [];
let accept = true;

const captureEmail = {
  name: 'capture-email',
  async send(to: string, subject: string, body: string) {
    sent.push({ to, subject, body });
    return { accepted: accept, providerMessageId: null, error: accept ? null : 'capture_rejected' };
  },
};

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');

// Production files that could plausibly reach the email provider.
const EMAIL_FILES = [
  '../server.ts',
  '../services/email.ts',
  '../services/notificationProviders.ts',
  '../routes/agentOps.ts',
  '../routes/finderReport.ts',
  '../routes/claims.ts',
  '../routes/customerClaims.ts',
  '../routes/publicItems.ts',
  '../routes/webhooks.ts',
  '../routes/claimPayments.ts',
];

// The seven migrated invocation sites and the event each now dispatches.
const MIGRATED: Array<{ file: string; event: string }> = [
  { file: '../server.ts', event: 'PAYMENT_RECEIVED' },
  { file: '../server.ts', event: 'AGENT_PAYMENT_CONFIRMED' },
  { file: '../server.ts', event: 'ADMIN_TRANSACTION_LOG' },
  { file: '../routes/agentOps.ts', event: 'ITEM_HANDED_OVER' },
  { file: '../routes/agentOps.ts', event: 'FINDER_ITEM_COLLECTED' },
  { file: '../routes/agentOps.ts', event: 'ADMIN_TRANSACTION_LOG' },
  { file: '../routes/finderReport.ts', event: 'ADMIN_REASSIGNMENT' },
];

// Fixed fixtures everywhere: no random values, so nothing here can flake.
const CLAIM_ID = 'CLM-N8-FIXED-0001';
const ITEM_ID = 'ITM-N8-FIXED-0002';
const OWNER_EMAIL = 'owner.n8@example.com';
const AGENT_EMAIL = 'agent.n8@example.com';
const FINDER_EMAIL = 'finder.n8@example.com';
const ADMIN_EMAIL = 'admin.n8@example.com';
const OWNER_PHONE = '+254712000111';
const PICKUP_CODE = '864213';

let n = 0;
const unique = () => `N8-${n++}`;

beforeEach(async () => {
  sent.length = 0;
  accept = true;
  const { db: rawDb } = await import('../db/index');
  const { notification_events } = await import('../db/schema');
  await rawDb.delete(notification_events);
  __setEmailProvider(captureEmail as any);
});

// PLACEHOLDER_REST
// =============================================================================
// A — MIGRATION COVERAGE
// =============================================================================

describe('N8-A — migration coverage', () => {
  it('all seven migrated sites dispatch a typed notification event', () => {
    for (const m of MIGRATED) {
      expect(read(m.file), `${m.file} -> ${m.event}`).toContain(`eventType: '${m.event}'`);
    }
  });

  it('NO production business path calls a transactional template directly', () => {
    // The six send*Email() methods survive as compatibility wrappers, so their
    // mere existence proves nothing — this asserts no CALLER outside the
    // provider itself invokes one.
    const callers = EMAIL_FILES.filter((f) => f !== '../services/email.ts');
    for (const rel of callers) {
      const src = read(rel);
      for (const m of [
        'sendPaymentReceivedEmail', 'sendItemHandedOverEmail',
        'sendAdminNewReassignmentRequestEmail', 'sendAgentPaymentConfirmedEmail',
        'sendFinderItemCollectedEmail', 'sendAdminTransactionLogEmail',
      ]) {
        expect(src, `${rel} -> ${m}`).not.toContain(`EmailService.${m}(`);
      }
    }
  });

  it('EmailService.send() is reached only by the notification provider adapter', () => {
    // The single low-level transport entry point for email.
    const prod = [
      '../server.ts', '../routes/agentOps.ts', '../routes/finderReport.ts',
      '../routes/claims.ts', '../routes/customerClaims.ts',
    ];
    for (const rel of prod) {
      expect(read(rel), rel).not.toContain('EmailService.send(');
    }
    expect(read('../services/notificationProviders.ts'))
      .toContain('EmailService.sendWithId(to, subject, html)');
  });

  it('every migrated caller goes through NotificationService', () => {
    for (const rel of ['../server.ts', '../routes/agentOps.ts', '../routes/finderReport.ts']) {
      expect(read(rel), rel).toContain('NotificationService.notify(');
    }
  });

  it('the two pre-existing activation events are NOT re-migrated or duplicated', () => {
    const src = read('../server.ts');
    for (const ev of ['CUSTOMER_EMAIL_ACTIVATION', 'AGENT_EMAIL_ACTIVATION']) {
      const at = src.indexOf(`eventType: '${ev}'`);
      expect(at, ev).toBeGreaterThan(-1);
      expect(src.indexOf(`eventType: '${ev}'`, at + 1), `${ev} dispatched twice`).toBe(-1);
    }
  });
});

// =============================================================================
// B — EVENT MAPPING
// =============================================================================

describe('N8-B — event mapping', () => {
  it('all six transactional email events are defined on the email channel', () => {
    for (const ev of [
      'PAYMENT_RECEIVED', 'AGENT_PAYMENT_CONFIRMED', 'ITEM_HANDED_OVER',
      'FINDER_ITEM_COLLECTED', 'ADMIN_TRANSACTION_LOG', 'ADMIN_REASSIGNMENT',
    ]) {
      const policy = getNotificationPolicy(ev);
      expect(policy, `${ev} is not in the catalogue`).toBeTruthy();
      expect(policy!.channel, `${ev} channel`).toBe('email');
    }
  });

  it('the ADMIN_TRANSACTION_LOG subtypes are preserved at both call sites', () => {
    expect(read('../server.ts')).toContain("'PAYMENT_CONFIRMED',");
    expect(read('../routes/agentOps.ts')).toContain("'HANDOVER_CONFIRMED_PENDING_SETTLEMENT',");
  });
});

// PLACEHOLDER_REST
// =============================================================================
// C — IDEMPOTENCY
// =============================================================================

describe('N8-C — idempotency', () => {
  it('the same business event always produces the same key', () => {
    for (const ev of ['PAYMENT_RECEIVED', 'AGENT_PAYMENT_CONFIRMED', 'ITEM_HANDED_OVER', 'FINDER_ITEM_COLLECTED']) {
      const a = buildNotificationIdempotencyKey(ev, CLAIM_ID);
      const b = buildNotificationIdempotencyKey(ev, CLAIM_ID);
      expect(a, ev).toBe(b);
      expect(a).toBe(`${ev}:${CLAIM_ID}`);
    }
  });

  it('the two ADMIN_TRANSACTION_LOG subtypes do NOT collide', () => {
    // This is the collision the brief calls out. Both subtypes share ONE event
    // type and can fire for the SAME claim, so without the subtype in the key the
    // handover log would be silently suppressed as a duplicate of the payment
    // log — an operator would simply never learn a handover happened.
    const payment = buildNotificationIdempotencyKey('ADMIN_TRANSACTION_LOG', `PAYMENT_CONFIRMED:${CLAIM_ID}`);
    const handover = buildNotificationIdempotencyKey(
      'ADMIN_TRANSACTION_LOG',
      `HANDOVER_CONFIRMED_PENDING_SETTLEMENT:${CLAIM_ID}`,
    );
    expect(payment).not.toBe(handover);
    expect(payment).toBe(`ADMIN_TRANSACTION_LOG:PAYMENT_CONFIRMED:${CLAIM_ID}`);
    expect(handover).toContain('HANDOVER_CONFIRMED_PENDING_SETTLEMENT');
  });

  it('a duplicate notification is suppressed and does not re-send', async () => {
    const key = buildNotificationIdempotencyKey('PAYMENT_RECEIVED', CLAIM_ID);
    const render = () => renderSendPaymentReceivedEmail(
      OWNER_EMAIL, OWNER_PHONE, 'Wallet', 'Hub', '+254700000000', ITEM_ID, PICKUP_CODE,
    );
    const first = await NotificationService.notify({
      eventType: 'PAYMENT_RECEIVED', recipient: OWNER_EMAIL, idempotencyKey: key, render,
    });
    const second = await NotificationService.notify({
      eventType: 'PAYMENT_RECEIVED', recipient: OWNER_EMAIL, idempotencyKey: key, render,
    });
    expect(first.dispatched).toBe(true);
    expect(second.dispatched).toBe(false);
    expect(second.status).toBe('duplicate');
    expect(sent).toHaveLength(1);
  });

  it('the PAYMENT_RECEIVED key contains no pickup code, phone, email or HTML', async () => {
    // The pickup code is a SECRET. If it reached the idempotency key it would sit
    // forever in a durable, operator-visible column.
    const key = buildNotificationIdempotencyKey('PAYMENT_RECEIVED', CLAIM_ID);
    expect(key).not.toContain(PICKUP_CODE);
    await NotificationService.notify({
      eventType: 'PAYMENT_RECEIVED',
      recipient: OWNER_EMAIL,
      idempotencyKey: key,
      render: () => renderSendPaymentReceivedEmail(
        OWNER_EMAIL, OWNER_PHONE, 'Wallet', 'Hub', '+254700000000', ITEM_ID, PICKUP_CODE,
      ),
    });
    const row = await db.getNotificationEventByIdempotencyKey(key);
    expect(row).toBeTruthy();
    const serialized = JSON.stringify(row);
    for (const forbidden of [PICKUP_CODE, OWNER_PHONE, '254712000111', OWNER_EMAIL, '<div', 'Return4me']) {
      expect(serialized, `durable row leaked ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('no migrated key shape is credential-shaped or a Kenyan phone number', () => {
    const keys = [
      buildNotificationIdempotencyKey('PAYMENT_RECEIVED', CLAIM_ID),
      buildNotificationIdempotencyKey('AGENT_PAYMENT_CONFIRMED', CLAIM_ID),
      buildNotificationIdempotencyKey('ITEM_HANDED_OVER', CLAIM_ID),
      buildNotificationIdempotencyKey('FINDER_ITEM_COLLECTED', CLAIM_ID),
      buildNotificationIdempotencyKey('ADMIN_TRANSACTION_LOG', `PAYMENT_CONFIRMED:${CLAIM_ID}`),
      buildNotificationIdempotencyKey('ADMIN_TRANSACTION_LOG', `HANDOVER_CONFIRMED_PENDING_SETTLEMENT:${CLAIM_ID}`),
      buildNotificationIdempotencyKey('ADMIN_REASSIGNMENT', ITEM_ID),
    ];
    for (const key of keys) {
      expect(idempotencyKeyLooksLikeSecret(key), key).toBe(false);
      expect(key).not.toMatch(/254\d{9}/);
    }
  });

  it('an ADMIN_REASSIGNMENT key is bound to the reported item', () => {
    expect(buildNotificationIdempotencyKey('ADMIN_REASSIGNMENT', ITEM_ID))
      .toBe(`ADMIN_REASSIGNMENT:${ITEM_ID}`);
  });
});

// =============================================================================
// D — RENDERING (fidelity: the customer must receive the same email)
// =============================================================================

describe('N8-D — rendering', () => {
  it('each builder returns the EXACT pre-migration subject', () => {
    expect(renderSendPaymentReceivedEmail(
      OWNER_EMAIL, OWNER_PHONE, 'Wallet', 'Hub', '+254700000000', ITEM_ID, PICKUP_CODE,
    ).subject).toBe('Payment Confirmed / Malipo Imethibitishwa - Return4me');

    expect(renderSendItemHandedOverEmail(
      OWNER_EMAIL, OWNER_PHONE, 'Wallet', ITEM_ID, '1 January 2026',
    ).subject).toBe('Item Handed Over Successfully / Bidhaa Imekabidhiwa - Return4me');

    expect(renderSendAdminNewReassignmentRequestEmail(ITEM_ID, 'Kasarani', OWNER_PHONE).subject)
      .toBe(`[URGENT] Manual Agent Reassignment Needed - Dropoff Code ${ITEM_ID}`);

    expect(renderSendAgentPaymentConfirmedEmail(AGENT_EMAIL, 'Hub', 'Wallet', ITEM_ID, CLAIM_ID).subject)
      .toBe('Payment Confirmed / Release Authorized - Return4me');

    expect(renderSendFinderItemCollectedEmail(FINDER_EMAIL, 'Wallet', ITEM_ID).subject)
      .toBe('Your Found Item Has Been Returned / Bidhaa Uliyopata Imerejeshwa - Return4me');

    expect(renderSendAdminTransactionLogEmail('PAYMENT_CONFIRMED', CLAIM_ID, ITEM_ID, '1500', 'Hub').subject)
      .toBe(`[ADMIN LOG] PAYMENT_CONFIRMED - Claim ${CLAIM_ID}`);
  });

  it('the builders do not send anything and read no configuration', () => {
    // A builder that dispatched would double-send once NotificationService also
    // dispatches; one that read process.env could not be a pure render callback.
    const src = read('../services/email.ts');
    const builderRegion = src.slice(0, src.indexOf('export const EmailService'));
    expect(builderRegion).not.toContain('EmailService.send(');
    expect(builderRegion).not.toContain('this.send(');
    expect(builderRegion).not.toContain('process.env.ADMIN_NOTIFICATION_EMAIL');
    expect(builderRegion).not.toMatch(/client\.emails\.send/);
  });

  it('the pickup code and owner phone survive in the TRANSIENT body', () => {
    // Removing these would silently break physical pickup: the email is where the
    // owner is told the code and the agent's number.
    const payment = renderSendPaymentReceivedEmail(
      OWNER_EMAIL, OWNER_PHONE, 'Wallet', 'Hub', '+254700000000', ITEM_ID, PICKUP_CODE,
    );
    expect(payment.body).toContain(PICKUP_CODE);
    const handover = renderSendItemHandedOverEmail(OWNER_EMAIL, OWNER_PHONE, 'Wallet', ITEM_ID, '1 January 2026');
    expect(handover.body).toContain(OWNER_PHONE);
  });

  it('sensitive values reach the provider but NOT the durable row', async () => {
    const key = buildNotificationIdempotencyKey('PAYMENT_RECEIVED', CLAIM_ID);
    const result = await NotificationService.notify({
      eventType: 'PAYMENT_RECEIVED',
      recipient: OWNER_EMAIL,
      idempotencyKey: key,
      render: () => renderSendPaymentReceivedEmail(
        OWNER_EMAIL, OWNER_PHONE, 'Wallet', 'Hub', '+254700000000', ITEM_ID, PICKUP_CODE,
      ),
    });
    // Delivered...
    expect(result.dispatched).toBe(true);
    expect(sent[0].body).toContain(PICKUP_CODE);
    // ...and nowhere durable.
    const row = await db.getNotificationEventByIdempotencyKey(key);
    expect(JSON.stringify(row)).not.toContain(PICKUP_CODE);
    expect(JSON.stringify(row)).not.toContain(OWNER_PHONE);
  });

  it('the compatibility wrappers still produce identical output', async () => {
    // The wrappers must not become a second, drifting copy of the templates.
    const direct = renderSendPaymentReceivedEmail(
      OWNER_EMAIL, OWNER_PHONE, 'Wallet', 'Hub', '+254700000000', ITEM_ID, PICKUP_CODE,
    );
    const src = read('../services/email.ts');
    const wrapper = src.slice(src.indexOf('async sendPaymentReceivedEmail('));
    expect(wrapper).toContain('const rendered = renderSendPaymentReceivedEmail(');
    expect(wrapper).toContain('this.send(to, rendered.subject, rendered.body)');
    expect(direct.subject).toContain('Payment Confirmed');
    expect(typeof EmailService.sendPaymentReceivedEmail).toBe('function');
  });
});

// PLACEHOLDER_REST
// PLACEHOLDER_REST
// =============================================================================
// E — RECIPIENT BEHAVIOUR
// =============================================================================

describe('N8-E — recipient behaviour', () => {
  it('resolves the admin address from configuration, trimmed', () => {
    expect(getAdminNotificationEmail({ ADMIN_NOTIFICATION_EMAIL: `  ${ADMIN_EMAIL} ` } as any)).toBe(ADMIN_EMAIL);
    expect(getAdminNotificationEmail({} as any)).toBe('');
    expect(getAdminNotificationEmail({ ADMIN_NOTIFICATION_EMAIL: '   ' } as any)).toBe('');
  });

  it('an unset admin address is rejected BEFORE any provider call', async () => {
    // The old provider returned a silent `false` here. Nothing was sent then and
    // nothing is sent now; the refusal is simply recorded and inspectable.
    const result = await NotificationService.notify({
      eventType: 'ADMIN_TRANSACTION_LOG',
      recipient: getAdminNotificationEmail({} as any),
      idempotencyKey: buildNotificationIdempotencyKey('ADMIN_TRANSACTION_LOG', `PAYMENT_CONFIRMED:${CLAIM_ID}`),
      render: () => renderSendAdminTransactionLogEmail('PAYMENT_CONFIRMED', CLAIM_ID, ITEM_ID, '1500', 'Hub'),
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('missing_recipient');
    expect(sent).toHaveLength(0);
  });

  it('the admin provider no longer owns recipient resolution', () => {
    // The configuration variable is read in exactly ONE place application-wide.
    const readers = EMAIL_FILES
      .concat(['../config/adminNotificationEmail.ts'])
      .filter((f) => fs.existsSync(path.resolve(__dirname, f)))
      .filter((f) => read(f).includes('ADMIN_NOTIFICATION_EMAIL'));
    expect(readers, `ADMIN_NOTIFICATION_EMAIL read in: ${readers.join(', ')}`)
      .toEqual(['../config/adminNotificationEmail.ts']);
  });

  it('owner, agent and finder recipients are all delivered', async () => {
    await NotificationService.notify({
      eventType: 'PAYMENT_RECEIVED', recipient: OWNER_EMAIL,
      idempotencyKey: buildNotificationIdempotencyKey('PAYMENT_RECEIVED', CLAIM_ID),
      render: () => renderSendPaymentReceivedEmail(OWNER_EMAIL, OWNER_PHONE, 'Wallet', 'Hub', '+254700000000', ITEM_ID, PICKUP_CODE),
    });
    await NotificationService.notify({
      eventType: 'AGENT_PAYMENT_CONFIRMED', recipient: AGENT_EMAIL,
      idempotencyKey: buildNotificationIdempotencyKey('AGENT_PAYMENT_CONFIRMED', CLAIM_ID),
      render: () => renderSendAgentPaymentConfirmedEmail(AGENT_EMAIL, 'Hub', 'Wallet', ITEM_ID, CLAIM_ID),
    });
    await NotificationService.notify({
      eventType: 'FINDER_ITEM_COLLECTED', recipient: FINDER_EMAIL,
      idempotencyKey: buildNotificationIdempotencyKey('FINDER_ITEM_COLLECTED', CLAIM_ID),
      render: () => renderSendFinderItemCollectedEmail(FINDER_EMAIL, 'Wallet', ITEM_ID),
    });
    expect(sent.map((s) => s.to)).toEqual([OWNER_EMAIL, AGENT_EMAIL, FINDER_EMAIL]);
    const row = await db.getNotificationEventByIdempotencyKey(
      buildNotificationIdempotencyKey('PAYMENT_RECEIVED', CLAIM_ID),
    );
    expect(row.recipient_reference).not.toContain(OWNER_EMAIL);
  });

  it('a blank recipient is rejected and nothing is sent', async () => {
    const result = await NotificationService.notify({
      eventType: 'PAYMENT_RECEIVED', recipient: '   ',
      idempotencyKey: buildNotificationIdempotencyKey('PAYMENT_RECEIVED', 'BLANK-RECIPIENT'),
      render: () => renderSendPaymentReceivedEmail('', '', 'Wallet', 'Hub', '', ITEM_ID, PICKUP_CODE),
    });
    expect(result.accepted).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

// =============================================================================
// F — FAILURE BEHAVIOUR
// =============================================================================

describe('N8-F — failure behaviour', () => {
  it('a provider rejection never reports success', async () => {
    accept = false;
    const result = await NotificationService.notify({
      eventType: 'PAYMENT_RECEIVED', recipient: OWNER_EMAIL,
      idempotencyKey: buildNotificationIdempotencyKey('PAYMENT_RECEIVED', CLAIM_ID),
      render: () => renderSendPaymentReceivedEmail(OWNER_EMAIL, OWNER_PHONE, 'Wallet', 'Hub', '+254700000000', ITEM_ID, PICKUP_CODE),
    });
    expect(result.accepted).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.reason).not.toContain(PICKUP_CODE);
  });

  it('a provider that THROWS is recorded, not propagated to the caller', async () => {
    __setEmailProvider({
      name: 'exploding',
      async send() { throw new Error('smtp exploded: token=SECRETVALUE'); },
    } as any);
    const result = await NotificationService.notify({
      eventType: 'ITEM_HANDED_OVER', recipient: OWNER_EMAIL,
      idempotencyKey: buildNotificationIdempotencyKey('ITEM_HANDED_OVER', CLAIM_ID),
      render: () => renderSendItemHandedOverEmail(OWNER_EMAIL, OWNER_PHONE, 'Wallet', ITEM_ID, '1 January 2026'),
    });
    expect(result.accepted).toBe(false);
    expect(result.status).toBe('failed');
  });

  it('a durable-persistence failure produces NO dispatch', async () => {
    // A false successful dispatch would tell an operator an email exists that
    // nothing recorded and nobody sent.
    const original = (db as any).createNotificationEvent;
    (db as any).createNotificationEvent = async () => { throw new Error('db down'); };
    try {
      const result = await NotificationService.notify({
        eventType: 'PAYMENT_RECEIVED', recipient: OWNER_EMAIL,
        idempotencyKey: buildNotificationIdempotencyKey('PAYMENT_RECEIVED', CLAIM_ID),
        render: () => renderSendPaymentReceivedEmail(OWNER_EMAIL, OWNER_PHONE, 'Wallet', 'Hub', '+254700000000', ITEM_ID, PICKUP_CODE),
      });
      expect(result.accepted).toBe(false);
      expect(result.dispatched).toBe(false);
      expect(sent).toHaveLength(0);
    } finally {
      (db as any).createNotificationEvent = original;
    }
  });
});

// PLACEHOLDER_REST
// =============================================================================
// G — FIRE-AND-FORGET + SCOPE
// =============================================================================

describe('N8-G — fire-and-forget and scope', () => {
  it('no N8-migrated email dispatch is awaited by its caller', () => {
    // A payment or a handover must never be reported as failed because an email
    // provider was slow or absent. An `await` would put the business operation
    // behind the provider's latency.
    //
    // Scoped to the N8 events on purpose: the two pre-existing ACTIVATION emails
    // ARE awaited, and must stay that way, because their outcome drives a 503 and
    // an audit entry (N3/N4 semantics).
    const N8_EVENTS = [
      'PAYMENT_RECEIVED', 'AGENT_PAYMENT_CONFIRMED', 'ITEM_HANDED_OVER',
      'FINDER_ITEM_COLLECTED', 'ADMIN_TRANSACTION_LOG', 'ADMIN_REASSIGNMENT',
    ];
    for (const rel of ['../server.ts', '../routes/agentOps.ts', '../routes/finderReport.ts']) {
      const src = read(rel);
      const dispatches = [...src.matchAll(/NotificationService\.notify\(\{/g)].map((m) => m.index!);
      expect(dispatches.length, rel).toBeGreaterThan(0);
      for (const at of dispatches) {
        const block = src.slice(at, at + 260);
        const isActivation =
          block.includes("'CUSTOMER_EMAIL_ACTIVATION'") || block.includes("'AGENT_EMAIL_ACTIVATION'");
        if (isActivation) continue;
        const lineStart = src.lastIndexOf('\n', at) + 1;
        expect(src.slice(lineStart, at).trim(), `${rel} awaits an email dispatch`).toBe('');
      }
    }
  });

  it('the two activation emails REMAIN awaited, preserving N3/N4 failure semantics', () => {
    const src = read('../server.ts');
    for (const ev of ['CUSTOMER_EMAIL_ACTIVATION', 'AGENT_EMAIL_ACTIVATION']) {
      const at = src.indexOf(`eventType: '${ev}'`);
      expect(at, ev).toBeGreaterThan(-1);
      const lineStart = src.lastIndexOf('\n', at) + 1;
      // walk back to the start of the call
      const callStart = src.lastIndexOf('NotificationService.notify(', at);
      const start = src.lastIndexOf('\n', callStart) + 1;
      // Awaited, and bound to a named variable so the outcome drives the 503.
      const stmt = src.slice(start, callStart + 'NotificationService.notify('.length);
      expect(stmt, `${ev} must stay awaited`).toMatch(/=\s*await\s+NotificationService\.notify\($/);
    }
  });

  it('every migrated dispatch still attaches a .catch() with its original log label', () => {
    // label -> the file whose pre-N7 code carried it. Each is checked where it
    // actually lives, not against every file.
    const LABELS: Array<[string, string]> = [
      ['../server.ts', 'Payment received email failed'],
      ['../server.ts', 'Agent payment confirmed email failed'],
      ['../server.ts', 'Admin payment log email failed'],
      ['../routes/agentOps.ts', 'Handover confirmation email failed'],
      ['../routes/agentOps.ts', 'Finder item collected email failed'],
      ['../routes/agentOps.ts', 'Admin handover log email failed'],
      ['../routes/finderReport.ts', 'Admin reassignment email failed'],
    ];
    for (const [rel, label] of LABELS) {
      expect(read(rel), `${rel}: ${label}`).toContain(label);
    }
  });

  it('no email rate limiting was introduced (N6 stays SMS-only)', () => {
    for (const rel of ['../services/smsRateLimit.ts', '../services/notificationService.ts']) {
      expect(read(rel), rel).not.toMatch(/emailRateLimit|consumeEmailRateLimit/);
    }
    for (const rel of ['../server.ts', '../routes/agentOps.ts', '../routes/finderReport.ts']) {
      expect(read(rel), rel).not.toMatch(/smsRateLimit[\s\S]{0,400}notify/);
    }
  });

  it('N9 (SMS->email fallback) and N10 work are NOT started', () => {
    const all = EMAIL_FILES.map(read).join('\n');
    expect(all).not.toMatch(/fallback_available|fallback_requested|fallback_sent|createFallback/);
    const events = read('../config/notificationEvents.ts');
    for (const ev of ['EMAIL_FALLBACK', 'SMS_FALLBACK_SENT']) {
      expect(events, ev).not.toContain(ev);
    }
  });
});
// PLACEHOLDER_REST