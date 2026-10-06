// =============================================================================
// N7 ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â SMS MIGRATION.
//
// Every production SMS call site in Return4me was moved onto the N5
// NotificationService / N6 durable limiter. This suite proves the migration did
// what it claimed and, more importantly, that it changed no business behaviour.
//
// The four things a migration like this can silently get wrong, and what each
// block below is aimed at:
//
//   1. Coverage   ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â a call site quietly left calling the provider directly, so
//                   the SMS still costs money but no longer has a durable record.
//   2. Fidelity   ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â a "harmless" refactor that changes the LIVE SMS body, the
//                   response status, or the order of send-versus-persist. The
//                   live body is the sharpest trap here: sendCodeViaSms builds
//                   it from the CODE, so a seam that forwards only the composed
//                   message sends a real, billable SMS with no code in it.
//   3. Secrets    ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â a code or phone number reaching the durable row, a log, an
//                   error, or the idempotency key.
//   4. Policy     ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â the limiter refusing before any provider call, and idempotency
//                   producing exactly one dispatch under concurrency.
//
// Providers are capture adapters; no SMS or email is ever sent.
// =============================================================================
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { db } from '../db/database';
import {
  NotificationService,
  __setEmailProvider,
  __setSmsProvider,
} from '../services/notificationService';
import { newSmsIssuanceId, sendSmsNotification } from '../services/smsNotification';
import { smsRateLimit } from '../services/smsRateLimit';

const smsSent: Array<{ to: string; body: string; label?: string; code?: string }> = [];
let accept = true;

// The capture adapter records the `code` separately from the body, mirroring the
// real seam, so a test can assert the code reached the provider even though the
// provider ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â not the caller ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â is what builds the live text.
const captureSms = {
  name: 'capture-sms',
  async send(to: string, body: string, label?: string, code?: string) {
    smsSent.push({ to, body, label, code });
    return {
      accepted: accept,
      providerMessageId: null,
      error: accept ? null : 'capture_rejected',
    };
  },
};

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');

// Every production file that could plausibly reach the SMS provider.
const PRODUCTION_SMS_FILES = [
  '../server.ts',
  '../services/auth.ts',
  '../services/notificationProviders.ts',
  '../services/smsNotification.ts',
  '../routes/claims.ts',
  '../routes/customerClaims.ts',
  '../routes/agentOps.ts',
  '../routes/finderReport.ts',
  '../routes/publicItems.ts',
  '../routes/webhooks.ts',
  '../routes/claimPayments.ts',
];

// The six migrated code flows, re-homed onto the EMAIL seam by E1, and the file
// that now owns each one. The values are the literal event names as they appear
// in the source (quoted), because server.ts resolves the agent/deletion event
// through a variable and only the literal string is a stable anchor.
const MIGRATED_FLOWS: Array<{ file: string; event: string }> = [
  { file: '../server.ts', event: "'AGENT_LOGIN_OTP_EMAIL'" },
  { file: '../server.ts', event: "'CUSTOMER_LOGIN_OTP_EMAIL'" },
  { file: '../server.ts', event: "'ACCOUNT_DELETION_OTP_EMAIL'" },
  { file: '../server.ts', event: "'IDENTITY_CHANGE_OTP_EMAIL'" },
  // The payment-time pickup code is no longer an OTP event of its own: it rides
  // inside the transactional PAYMENT_RECEIVED email rendered by server.ts.
  { file: '../server.ts', event: "'PAYMENT_RECEIVED'" },
  { file: '../routes/claims.ts', event: "'OWNER_CLAIM_VERIFICATION_CODE_EMAIL'" },
  { file: '../routes/customerClaims.ts', event: "'PICKUP_CODE_EMAIL'" },
  { file: '../routes/customerClaims.ts', event: "'CLAIM_LINK_OTP_EMAIL'" },
];

let n = 0;
const PHONE = '+254712345678';
const nextIssuance = () => newSmsIssuanceId('N7');

beforeEach(async () => {
  smsSent.length = 0;
  accept = true;
  const { db: rawDb } = await import('../db/index');
  const { notification_events, sms_rate_limit_buckets } = await import('../db/schema');
  await rawDb.delete(notification_events);
  await rawDb.delete(sms_rate_limit_buckets);
  __setSmsProvider(captureSms as any);
  __setEmailProvider({ name: 'capture', async send() { return { accepted: true }; } });
});
// =============================================================================
// A ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â MIGRATION COVERAGE
// =============================================================================

describe('N7-A ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â migration coverage', () => {
  it('every migrated flow dispatches a typed notification event', () => {
    for (const flow of MIGRATED_FLOWS) {
      expect(read(flow.file), `${flow.file} -> ${flow.event}`)
        .toContain(flow.event);
    }
  });

  it('NO production business flow calls the SMS provider directly', () => {
    // The invariant that makes N7 worth doing: business code must not be able to
    // spend money on an SMS that leaves no durable record.
    //
    // Excluded, and deliberately: services/auth.ts is the provider
    // IMPLEMENTATION (both real seams live there) and
    // services/notificationProviders.ts is the single ADAPTER allowed to call it.
    // Nothing else may name either function.
    const callers = PRODUCTION_SMS_FILES.filter(
      (f) => f !== '../services/auth.ts' && f !== '../services/notificationProviders.ts',
    );
    for (const rel of callers) {
      const src = read(rel);
      expect(src, rel).not.toMatch(/sendCodeViaSms\(/);
      expect(src, rel).not.toMatch(/AuthService\.sendSms\(/);
      expect(src, rel).not.toMatch(/atSMSClient/);
    }
  });

  it('the provider implementation and its adapter remain, behind the boundary', () => {
    // A boundary change, not a deletion: the real transport must still exist and
    // the adapter must still be the thing that reaches it.
    const auth = read('../services/auth.ts');
    expect(auth).toContain('export async function sendCodeViaSms');
    expect(auth).toContain('async sendSms(');
    const adapter = read('../services/notificationProviders.ts');
    expect(adapter).toMatch(/sendCodeViaSms\(phone, code, label, message\)/);
    expect(adapter).toMatch(/AuthService\.sendSms\(phone, message\)/);
  });

  it('all code flows go through ONE seam, so they cannot drift apart', () => {
    // E1: the seam every code-bearing flow now goes through is the EMAIL OTP
    // seam. The property is unchanged â€” one place builds the idempotency key and
    // carries the code, so call sites cannot invent their own â€” only the seam it
    // names is different.
    for (const rel of ['../server.ts', '../routes/claims.ts', '../routes/customerClaims.ts']) {
      const src = read(rel);
      expect(src, rel).toContain('sendEmailOtp(');
      expect(src, rel).not.toContain('sendSmsNotification(');
    }
    // Key building and code handling must live in exactly one place. A direct
    // NotificationService.notify() is still legitimate in server.ts for the N8
    // transactional emails, so what is forbidden is a direct call that carries a
    // code â€” that is the path that would let a call site invent its own key and
    // quietly bypass idempotency.
    for (const rel of ['../server.ts', '../routes/claims.ts', '../routes/customerClaims.ts']) {
      const src = read(rel);
      const direct = src.indexOf('NotificationService.notify(');
      if (direct === -1) continue;
      const block = src.slice(direct, direct + 900);
      expect(block, rel).not.toContain('smsCode');
    }
  });

  it('no call site can supply its own idempotency key - the derivation stays central', () => {
    // P2-A follow-up to the TypeScript error at the customer phone-verification
    // call site: that call still carried an `idempotencyKey` from an older SMS
    // architecture. `idempotencyKey` is REQUIRED on NotificationService.notify(),
    // so "fixing" that error by accepting the field on SmsNotificationInput would
    // have created a SECOND, competing idempotency identity for the same send.
    // The seam owns the derivation - buildNotificationIdempotencyKey(eventType,
    // issuanceId) - so no production flow may supply a key of its own.
    let inspected = 0;
    for (const rel of PRODUCTION_SMS_FILES) {
      const src = read(rel);
      // E1: the seam every code-bearing flow goes through is now sendEmailOtp's
      // object argument, so the inspected shape is that call.
      const blocks = src.match(/sendEmailOtp\(\{[\s\S]*?\n\s*\}\)/g) ?? [];
      const hasCallSite = /sendEmailOtp\(\{/.test(src);
      // The shape is uniform across every production call site, so a guard that
      // silently matched nothing would be worse than no guard. (The DEFINITION in
      // services/emailOtp.ts is not a call site and is therefore not
      // required to produce a block.)
      if (hasCallSite) {
        expect(blocks.length, `${rel} produced no inspectable call block`).toBeGreaterThan(0);
      }
      for (const rawBlock of blocks) {
        // Comments are stripped before the key assertion: this call site's own
        // documentation (and this test's) names the field it forbids, so judging
        // the CODE requires removing the prose - the same reason
        // claimTrackingDisclosure.test.ts strips comments before its own
        // field-name assertions.
        const block = rawBlock
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^[ \t]*\/\/.*$/gm, '');
        expect(block, rel).not.toContain('idempotencyKey');
      }
      inspected += blocks.length;
    }
    // 6 today: server.ts x3 (login, identity change, agent/deletion share one
    // ternary-shaped call), routes/claims.ts x1, routes/customerClaims.ts x2. The
    // floor is the guard against a seam that silently stopped being called
    // anywhere. (The payment-time pickup code is not one of these: it rides in the
    // N8 transactional PAYMENT_RECEIVED email, which is why that flow is anchored
    // on its event name above rather than on this seam.)
    expect(inspected).toBeGreaterThanOrEqual(6);

    // ...and the key is derived in exactly ONE place, from the caller's own
    // issuance reference, never from a caller-supplied key.
    const seam = read('../services/emailOtp.ts');
    expect(seam).toContain('buildNotificationIdempotencyKey(input.eventType, input.issuanceId)');
    expect(seam).not.toContain('input.idempotencyKey');

    // The INPUT CONTRACT itself must not accept a key either: declaring the field
    // is the change that would make a second, competing idempotency identity
    // expressible again - and it is exactly the "correction" a TS error at a
    // call site invites.
    const iface = seam.slice(
      seam.indexOf('export interface EmailOtpInput'),
      seam.indexOf('export async function sendEmailOtp'),
    );
    expect(iface.length).toBeGreaterThan(0);
    expect(iface).not.toMatch(/^\s*idempotencyKey\??:/m);
  });


  it('the durable limiter is mounted on every SMS-triggering HTTP route', () => {
    expect(read('../server.ts')).toMatch(/'\/api\/auth\/request-otp',[\s\S]{0,200}smsRateLimit\(\)/);
    expect(read('../server.ts')).toMatch(/'\/api\/customer\/login',[\s\S]{0,200}smsRateLimit\(\)/);
    expect(read('../routes/claims.ts'))
      .toMatch(/'\/api\/claims\/:id\/request-otp',[\s\S]{0,300}smsRateLimit\(\)/);
    expect(read('../routes/customerClaims.ts'))
      .toMatch(/'\/api\/customer\/claims\/:claimId\/pickup-code\/resend',[\s\S]{0,400}smsRateLimit\(\)/);
    expect(read('../routes/customerClaims.ts'))
      .toMatch(/'\/api\/customer\/claims\/link\/request-otp',[\s\S]{0,400}smsRateLimit\(\)/);
  });

  it('authenticated SMS routes authenticate BEFORE the limiter is consulted', () => {
    // Otherwise the limiter would key on a client-asserted identity and a caller
    // could mint unlimited buckets by inventing a customer id.
    const src = read('../routes/customerClaims.ts');
    for (const route of [
      '/api/customer/claims/:claimId/pickup-code/resend',
      '/api/customer/claims/link/request-otp',
    ]) {
      const at = src.indexOf(`'${route}'`);
      expect(at, route).toBeGreaterThan(-1);
      const chain = src.slice(at, src.indexOf('async (req', at));
      expect(chain.indexOf('requireCustomerAuth'), route).toBeGreaterThan(-1);
      expect(chain.indexOf('requireCustomerAuth'), route)
        .toBeLessThan(chain.indexOf('smsRateLimit()'));
    }
  });
});
// =============================================================================
// B ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â IDEMPOTENCY
// =============================================================================

describe('N7-B ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â idempotency', () => {
  it('a duplicate logical SMS request is suppressed and re-dispatches nothing', async () => {
    const issuanceId = nextIssuance();
    const first = await sendSmsNotification({
      eventType: 'PICKUP_CODE', recipient: PHONE, issuanceId,
      seam: 'code', code: '1234', message: 'm',
    });
    const second = await sendSmsNotification({
      eventType: 'PICKUP_CODE', recipient: PHONE, issuanceId,
      seam: 'code', code: '1234', message: 'm',
    });

    expect(first.accepted).toBe(true);
    expect(first.dispatched).toBe(true);
    // The duplicate is SUPPRESSED ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â `dispatched: false`, and the provider is not
    // called a second time. It still reports accepted: true because the message
    // genuinely WAS delivered on the first attempt; a caller must not be told a
    // code failed to send merely because it asked twice.
    expect(second.dispatched).toBe(false);
    expect(second.status).toBe('duplicate');
    expect(smsSent).toHaveLength(1);
  });

  it('concurrent duplicates of ONE logical request dispatch exactly once', async () => {
    // The race a check-then-send implementation loses: every caller asks at the
    // same instant and only the database decides who actually sends.
    const issuanceId = nextIssuance();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        sendSmsNotification({
          eventType: 'CLAIM_LINK_OTP', recipient: PHONE, issuanceId,
          seam: 'code', code: '4321', message: 'm',
        }),
      ),
    );
    expect(results.filter((r) => r.accepted)).toHaveLength(1);
    expect(smsSent).toHaveLength(1);
  });

  it('a GENUINE resend is a new logical event and is delivered again', async () => {
    // Suppression binds to the issued credential, not the recipient. A resend
    // mints a new code and must reach the handset, or the user would be left
    // holding a code that was never sent.
    const first = await sendSmsNotification({
      eventType: 'CLAIM_LINK_OTP', recipient: PHONE, issuanceId: nextIssuance(),
      seam: 'code', code: '1111', message: 'm',
    });
    const resend = await sendSmsNotification({
      eventType: 'CLAIM_LINK_OTP', recipient: PHONE, issuanceId: nextIssuance(),
      seam: 'code', code: '2222', message: 'm',
    });
    expect(first.accepted).toBe(true);
    expect(resend.accepted).toBe(true);
    expect(smsSent).toHaveLength(2);
    expect(smsSent.map((s) => s.code)).toEqual(['1111', '2222']);
  });

  it('different events for the same recipient stay independent', async () => {
    const issuanceId = nextIssuance();
    await sendSmsNotification({
      eventType: 'PICKUP_CODE', recipient: PHONE, issuanceId, seam: 'code', code: '1', message: 'm',
    });
    await sendSmsNotification({
      eventType: 'CLAIM_LINK_OTP', recipient: PHONE, issuanceId, seam: 'code', code: '1', message: 'm',
    });
    expect(smsSent).toHaveLength(2);
  });

  it('the idempotency key is derived from the issuance, never from the code', async () => {
    // A key containing the OTP would be a leaked credential in a durable column,
    // and N5's guard would (correctly) refuse it.
    // DETERMINISTIC BY CONSTRUCTION.
    //
    // The issuance reference is a FIXED fixture rather than a random one. The
    // invariant under test is that the key is a pure function of (event type,
    // issuance) and carries neither the OTP nor the recipient. Asserting that
    // with a random 20-char hex reference is a coin flip ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â a hex run can
    // legitimately contain '9876' or a phone fragment ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â so the test would flake
    // for reasons that have nothing to do with the behaviour it claims to check.
    const issuanceId = 'N7-FIXED-ISSUANCE-REFERENCE';
    await sendSmsNotification({
      eventType: 'PICKUP_CODE', recipient: PHONE, issuanceId, seam: 'code', code: '9876', message: 'm',
    });
    const row = await db.getNotificationEventByIdempotencyKey(`PICKUP_CODE:${issuanceId}`);
    expect(row).toBeTruthy();
    // STRONGER than the substring checks it replaces: exact equality proves the
    // key is derived from the event type and the issuance reference and from
    // nothing else. If a future change ever interpolated the code, the recipient
    // or a timestamp into this key, this assertion fails immediately.
    expect(row.idempotency_key).toBe(`PICKUP_CODE:${issuanceId}`);
    // ...and, spelled out, neither the code nor the recipient is present.
    expect(row.idempotency_key).not.toContain('9876');
    expect(row.idempotency_key).not.toContain('254712345678');
  });

  it('a key carrying a phone number is refused before any send', async () => {
    // The guard is part of the migrated surface, not just N5's: a future call
    // site must not be able to build a key out of the recipient it is about to
    // message, which would put personal data in a durable, operator-visible,
    // non-hashed column.
    const result = await NotificationService.notify({
      eventType: 'PICKUP_CODE',
      recipient: PHONE,
      idempotencyKey: 'PICKUP_CODE:254712345678',
      render: () => ({ body: 'm' }),
    } as any);
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain('secret');
    expect(smsSent).toHaveLength(0);
  });
});
// =============================================================================
// C ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â RATE LIMITING (over real HTTP)
// =============================================================================

describe('N7-C ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â rate limiting over real HTTP', () => {
  let server: any;
  let base = '';

  beforeEach(async () => {
    smsSent.length = 0;
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    let issued = 0;
    // Mounted exactly as the migrated routes mount it: the limiter runs in the
    // request path, before the handler that would generate a code and reach a
    // provider.
    app.post('/sms', smsRateLimit(), async (_req: any, res: any) => {
      issued += 1;
      const result = await sendSmsNotification({
        eventType: 'PICKUP_CODE',
        recipient: PHONE,
        issuanceId: nextIssuance(),
        seam: 'code',
        code: String(issued),
        message: 'm',
      });
      res.json({ ok: result.accepted });
    });
    await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  const post = (ip: string) =>
    fetch(base + '/sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      body: '{}',
    });

  it('permits requests 1-3 and refuses the 4th inside the rolling window', async () => {
    const ip = '10.55.0.1';
    for (let i = 0; i < 3; i++) {
      expect((await post(ip)).status, `request ${i + 1}`).toBe(200);
    }
    expect((await post(ip)).status).toBe(429);
    // The refusal happened BEFORE the provider: three dispatches, not four.
    expect(smsSent).toHaveLength(3);
  });

  it('limits are keyed per identity: a different IP is unaffected', async () => {
    const ip = '10.55.0.2';
    for (let i = 0; i < 4; i++) await post(ip);
    expect((await post(ip)).status).toBe(429);
    expect((await post('10.55.0.3')).status).toBe(200);
  });

  it('a limited request never reaches the provider', async () => {
    const ip = '10.55.0.4';
    for (let i = 0; i < 3; i++) await post(ip);
    smsSent.length = 0;
    await post(ip);
    expect(smsSent).toHaveLength(0);
  });

  it('the refusal is generic, carries Retry-After, and leaks no identity', async () => {
    const ip = '10.55.0.5';
    for (let i = 0; i < 3; i++) await post(ip);
    const res = await post(ip);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    const body = await res.text();
    expect(body).not.toContain(ip);
    expect(body).not.toMatch(/2547/);
  });

  it('an authenticated principal is limited independently of the IP', async () => {
    // Both dimensions are consumed, so a user cannot escape the limit by changing
    // network, nor escape the IP limit by changing accounts. This is why the
    // migrated customer routes must authenticate BEFORE the limiter runs.
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.post('/as-user', (req: any, _res: any, next: any) => {
      // Stands in for authenticateJWT / requireCustomerAuth: a VERIFIED principal.
      req.customer = { id: String(req.headers['x-test-user'] || '') };
      next();
    }, smsRateLimit(), (_req: any, res: any) => res.json({ ok: true }));

    const s2: any = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => s2.once('listening', () => r()));
    const b2 = `http://127.0.0.1:${s2.address().port}`;
    const asUser = (ip: string, user: string) =>
      fetch(b2 + '/as-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, 'X-Test-User': user },
        body: '{}',
      });

    const user = 'CUS-N7-1';
    for (let i = 0; i < 3; i++) expect((await asUser('10.56.0.1', user)).status).toBe(200);
    // A brand-new IP does NOT help: the user dimension is already exhausted.
    expect((await asUser('10.56.0.2', user)).status).toBe(429);
    // A different user from the already-limited IP does NOT help either.
    expect((await asUser('10.56.0.1', 'CUS-N7-2')).status).toBe(429);
    // A different user on a different IP is allowed.
    expect((await asUser('10.56.0.3', 'CUS-N7-2')).status).toBe(200);

    await new Promise<void>((r) => s2.close(() => r()));
  });
});
// =============================================================================
// D ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â BUSINESS-FLOW PRESERVATION (live SMS fidelity)
// =============================================================================

describe('N7-D ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â business-flow preservation', () => {
  it('the CODE reaches the provider, because the provider builds the live body', async () => {
    // THE fidelity trap. sendCodeViaSms composes the live SMS from the code and
    // ignores the caller's message; N5's adapter originally passed code: ''.
    // Routing a code-bearing OTP through it would send a real, billable SMS
    // reading "Msimbo wako wa Return4me ni ." ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â accepted by the provider,
    // delivered to the handset, and completely useless.
    await sendSmsNotification({
      eventType: 'OWNER_CLAIM_VERIFICATION_CODE', recipient: PHONE,
      issuanceId: nextIssuance(), seam: 'code', code: '8412',
      message: 'Msimbo mpya wa thibitisho la claim umetumwa.',
    });
    expect(smsSent).toHaveLength(1);
    expect(smsSent[0].code).toBe('8412');
  });

  it('the MESSAGE seam sends its text verbatim, for full-sentence notifications', async () => {
    const text = 'Payment confirmed. Your secret pickup code is 5150.';
    await sendSmsNotification({
      eventType: 'PICKUP_CODE', recipient: PHONE,
      issuanceId: nextIssuance(), seam: 'message', message: text,
    });
    expect(smsSent[0].body).toBe(text);
    // No code is forwarded, because this seam does not use one.
    expect(smsSent[0].code).toBeUndefined();
  });

  it('a code-seam send without a code REFUSES rather than sending a blank SMS', async () => {
    await expect(
      sendSmsNotification({
        eventType: 'PICKUP_CODE', recipient: PHONE,
        issuanceId: nextIssuance(), seam: 'code', message: 'm',
      }),
    ).rejects.toThrow(/requires a code/);
    expect(smsSent).toHaveLength(0);
  });

  it('OTP generation, expiry and send-before-persist ordering are untouched', () => {
    // The migration moved transport only. These are the business invariants the
    // handlers still depend on.
    const claims = read('../routes/claims.ts');
    expect(claims).toMatch(/crypto\.randomInt\(1000, 10000\)/);
    expect(claims).toMatch(/5 \* 60 \* 1000/);
    expect(claims.indexOf('await sendClaimVerificationEmail(')).toBeGreaterThan(-1);

    const customer = read('../routes/customerClaims.ts');
    const pickAt = customer.indexOf('await sendPickupCodeEmail(');
    expect(pickAt).toBeGreaterThan(-1);
    // Send strictly BEFORE persisting, so a provider failure cannot destroy the
    // pickup code that is currently working.
    expect(pickAt).toBeLessThan(customer.indexOf('await db.createPickupCode', pickAt));
  });

  it('existing in-process OTP limiters are KEPT as defence in depth', () => {
    const server = read('../server.ts');
    for (const limiter of ['otpIpLimiter', 'otpPhoneLimiter', 'otpGlobalLimiter', 'otpVerifyLimiter']) {
      expect(server, limiter).toContain(limiter);
    }
  });

  it('the anti-enumeration customer-login contract is unchanged', () => {
    // The customer login route ignores the dispatch result entirely and always
    // answers identically, so it cannot be used to discover which numbers are
    // registered. E1 moved the delivery from SMS to email but must not
    // weaken that.
    const src = read('../server.ts');
    const at = src.indexOf("'/api/customer/login'");
    expect(at).toBeGreaterThan(-1);
    const route = src.slice(at, src.indexOf("'/api/customer/login/verify'"));
    expect(route).toContain('sendEmailOtp(');
    // The result is awaited but deliberately not branched on.
    expect(route).not.toMatch(/if \(\s*!?\w*outcome\.accepted\s*\)/);
    expect(route).toContain('If this account has a verified email address');
  });
});
// =============================================================================
// E ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â FAILURE AND CONCURRENCY
// =============================================================================

describe('N7-E ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â failure behaviour', () => {
  it('a provider rejection is a failure, never a false success', async () => {
    accept = false;
    const result = await sendSmsNotification({
      eventType: 'PICKUP_CODE', recipient: PHONE,
      issuanceId: nextIssuance(), seam: 'code', code: '1234', message: 'm',
    });
    expect(result.accepted).toBe(false);
    expect(result.status).toBe('failed');
    // The route branches on accepted, so the user is never told a code was sent.
    expect(result.reason).not.toContain('1234');
  });

  it('a provider that THROWS is a failure, not a crash', async () => {
    __setSmsProvider({
      name: 'exploding',
      async send() { throw new Error('provider exploded: token=SECRETVALUE'); },
    } as any);
    const result = await sendSmsNotification({
      eventType: 'PICKUP_CODE', recipient: PHONE,
      issuanceId: nextIssuance(), seam: 'code', code: '1234', message: 'm',
    });
    expect(result.accepted).toBe(false);
    expect(result.status).toBe('failed');
  });

  it('a retry after a provider FAILURE cannot double-send the same event', async () => {
    accept = false;
    const issuanceId = nextIssuance();
    await sendSmsNotification({
      eventType: 'PICKUP_CODE', recipient: PHONE, issuanceId, seam: 'code', code: '1', message: 'm',
    });
    const retry = await sendSmsNotification({
      eventType: 'PICKUP_CODE', recipient: PHONE, issuanceId, seam: 'code', code: '1', message: 'm',
    });
    // The failed event was recorded, so the retry is a duplicate and must not
    // reach the provider a second time.
    expect(retry.status).toBe('duplicate');
    expect(smsSent).toHaveLength(1);

    // A genuine resend ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â new code, new key ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â is allowed and dispatched.
    accept = true;
    const resend = await sendSmsNotification({
      eventType: 'PICKUP_CODE', recipient: PHONE, issuanceId: nextIssuance(),
      seam: 'code', code: '2', message: 'm',
    });
    expect(resend.accepted).toBe(true);
    expect(smsSent).toHaveLength(2);
  });

  it('a persistence failure sends nothing at all', async () => {
    const original = (db as any).createNotificationEvent;
    (db as any).createNotificationEvent = async () => { throw new Error('db down'); };
    try {
      const result = await sendSmsNotification({
        eventType: 'PICKUP_CODE', recipient: PHONE,
        issuanceId: nextIssuance(), seam: 'code', code: '1234', message: 'm',
      });
      expect(result.accepted).toBe(false);
      expect(result.dispatched).toBe(false);
      // An SMS nobody can audit is not sent.
      expect(smsSent).toHaveLength(0);
    } finally {
      (db as any).createNotificationEvent = original;
    }
  });

  it('an unknown event type is refused before any provider call', async () => {
    const result = await NotificationService.notify({
      eventType: 'NOT_A_REAL_EVENT',
      recipient: PHONE,
      idempotencyKey: `N7-UNKNOWN-${n++}`,
      render: () => ({ body: 'm' }),
    } as any);
    expect(result.accepted).toBe(false);
    expect(smsSent).toHaveLength(0);
  });
});

// =============================================================================
// F ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â SECRETS AND RESTART SAFETY
// =============================================================================

describe('N7-F ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â secrets and durability', () => {
  it('neither the code nor the phone number reaches the durable record', async () => {
    const issuanceId = nextIssuance();
    await sendSmsNotification({
      eventType: 'CLAIM_LINK_OTP', recipient: PHONE, issuanceId,
      seam: 'code', code: '3141', message: 'code 3141 to 254712345678',
    });
    const row = await db.getNotificationEventByIdempotencyKey(`CLAIM_LINK_OTP:${issuanceId}`);
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('3141');
    expect(serialized).not.toContain('+254712345678');
    expect(row.recipient_reference).toBe('+254712***678');
  });

  it('suppression survives a restart: a fresh db read still sees the event', async () => {
    // No in-memory migration state: the record is durable, so a new process
    const issuanceId = nextIssuance();
    // reading the same row still suppresses the duplicate.
    await sendSmsNotification({
      eventType: 'PICKUP_CODE', recipient: PHONE, issuanceId, seam: 'code', code: '5678', message: 'm',
    });
    const reread = await db.getNotificationEventByIdempotencyKey(`PICKUP_CODE:${issuanceId}`);
    expect(reread).toBeTruthy();
    expect(reread.status).toBe('sent');
    const again = await sendSmsNotification({
      eventType: 'PICKUP_CODE', recipient: PHONE, issuanceId, seam: 'code', code: '5678', message: 'm',
    });
    expect(again.dispatched).toBe(false);
    expect(smsSent).toHaveLength(1);
  });
});

// =============================================================================
// G ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â SCOPE BOUNDARY
// =============================================================================

describe('N7-G ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â scope boundary', () => {
  it('N8 (transactional email) and N9 (SMS->email fallback) are NOT started', () => {
    const seam = read('../services/smsNotification.ts');
    expect(seam).not.toMatch(/fallback|createFallback|fallback_sent/);
    const all = PRODUCTION_SMS_FILES.map(read).join('\n');
    expect(all).not.toMatch(/fallback_available|fallback_requested|createFallback/);
    // No new event types were invented for this phase.
    const events = read('../config/notificationEvents.ts');
    for (const event of ['SMS_THROTTLED', 'RATE_LIMITED', 'SMS_FALLBACK']) {
      expect(events, event).not.toContain(event);
    }
  });

  it('no retry loop was introduced at the SMS notification boundary', () => {
    // Scoped deliberately to the SMS boundary. server.ts contains four
    // PRE-EXISTING background schedulers (claim expiry, settlement release,
    // social retry sweep, evidence retention) that have nothing to do with
    // notifications and were not touched by N7; asserting against the whole
    // file would flag unrelated, correct code. What must be true is that the
    // migrated SMS path does no retrying of its own â€” a retried send would
    // defeat the idempotency guarantee N6 exists to provide.
    expect(read('../services/smsNotification.ts')).not.toMatch(/setTimeout|setInterval|maxRetries/);
    expect(read('../services/notificationProviders.ts')).not.toMatch(/setTimeout|setInterval|maxRetries/);
    for (const rel of ['../routes/claims.ts', '../routes/customerClaims.ts']) {
      expect(read(rel), rel).not.toMatch(/setTimeout|setInterval|maxRetries/);
    }
    // ...and each migrated server.ts dispatch is a single awaited call, not a loop.
    const src = read('../server.ts');
    for (const event of ['CUSTOMER_LOGIN_OTP_EMAIL', 'IDENTITY_CHANGE_OTP_EMAIL']) {
      const at = src.indexOf(`eventType: '${event}'`);
      expect(at, event).toBeGreaterThan(-1);
      expect(src.slice(at, at + 200), event).not.toMatch(/for\s*\(|while\s*\(/);
    }
  });
});
