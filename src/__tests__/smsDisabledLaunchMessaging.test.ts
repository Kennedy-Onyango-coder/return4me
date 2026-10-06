import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// SMS OFF IS A CONFIGURATION CHOICE, NOT A SYSTEM FAILURE.
//
// WHY THIS EXISTS
//   Return4me launches with SMS deliberately switched off (`SMS_ENABLED="false"`)
//   and email as the transactional channel. The gateway already refused to claim
//   a send it could not make, but it reported EVERY refusal with one transient
//   message: "SMS delivery is temporarily unavailable. Please try again or use
//   another method." While SMS is switched off that sentence is wrong twice
//   over — nothing is "temporarily" unavailable, and retrying cannot help — and
//   a deliberate launch decision was presented to customers and agents as a
//   system malfunction.
//
//   The fix is a second, truthful message plus ONE place that chooses between
//   them (`isLiveSmsEnabled()` / `smsDeliveryFailureMessage()` in
//   services/auth.ts), used by the routes that surface a code-delivery failure
//   to a human.
//
// WHAT THIS FILE PINS
//   * the transient wording is UNCHANGED and still used when SMS is live;
//   * the disabled wording never says "try again", never says "temporarily
//     unavailable", and never promises delivery on a channel that does not
//     carry the code;
//   * every user-facing call site reports the code-delivery failure it ACTUALLY
//     hit. E1 moved all six one-time-code flows to email, so the SMS channel
//     state is no longer a thing any route has to word: what a caller can hit
//     now is a provider refusal (retryable, 503) or an account with no verified
//     email destination (fail closed, 403). Both are asserted below from the
//     single seam that defines them, and the retired SMS-only branch is asserted
//     to be GONE rather than merely unused;
//   * the gateway still fails closed — it never reports success when no SMS was
//     accepted — with SMS disabled;
//   * the documentation states the one thing that makes the launch decision
//     safe to make: the one-time-code flows are email-only.
// =============================================================================

const REPO_ROOT = path.resolve(__dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');

const serverTs = read('src/server.ts');
const authTs = read('src/services/auth.ts');
const claimsRouteTs = read('src/routes/claims.ts');
const customerClaimsTs = read('src/routes/customerClaims.ts');
const ownerViewTs = read('src/components/OwnerView.tsx');
const readme = read('README.md');
const envExample = read('.env.example');
const configurationDoc = read('docs/configuration.md');
const deploymentDoc = read('docs/deployment.md');
const operationsDoc = read('docs/operations.md');
const notificationsDoc = read('docs/notifications.md');

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
  // Mirrors services/__tests__/smsDelivery.test.ts. `setup.testEnv.ts` clears the
  // provider credentials but deliberately says nothing about SMS_ENABLED, so the
  // flag is cleared here and re-established per test.
  delete process.env.SMS_ENABLED;
  delete process.env.AFRICASTALKING_API_KEY;
  delete process.env.AFRICASTALKING_USERNAME;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

/** Imports services/auth.ts under a local NODE_ENV=production, as smsDelivery.test.ts does. */
async function withProductionNodeEnv<T>(fn: () => Promise<T>): Promise<T> {
  const prevNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  // Satisfies db/index.ts's production guard. The database is never touched by
  // the send paths under test.
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test?sslmode=require';
  try {
    return await fn();
  } finally {
    process.env.NODE_ENV = prevNodeEnv;
    delete process.env.DATABASE_URL;
  }
}

describe('the SMS switch has exactly one predicate', () => {
  it('isLiveSmsEnabled() is true only for exactly "true", as the sender requires', async () => {
    let mod = await import('../services/auth.ts');
    expect(mod.isLiveSmsEnabled()).toBe(false); // unset

    vi.resetModules();
    process.env.SMS_ENABLED = 'false';
    mod = await import('../services/auth.ts');
    expect(mod.isLiveSmsEnabled()).toBe(false);

    vi.resetModules();
    process.env.SMS_ENABLED = 'TRUE';
    mod = await import('../services/auth.ts');
    // Case matters: `sendCodeViaSms` gates live sending on the same exact
    // comparison, so a lenient predicate here would describe a channel that is
    // not actually switched on.
    expect(mod.isLiveSmsEnabled()).toBe(false);

    vi.resetModules();
    process.env.SMS_ENABLED = 'true';
    mod = await import('../services/auth.ts');
    expect(mod.isLiveSmsEnabled()).toBe(true);
  });

  it('the predicate reads the same value that gates a real send', () => {
    // Source-level: both the predicate and the send paths must use the single
    // module-level `smsEnabled` constant, so copy and behaviour cannot diverge.
    expect(authTs).toContain("const smsEnabled = process.env.SMS_ENABLED === 'true';");
    expect(authTs).toContain('export function isLiveSmsEnabled(): boolean {');
    // sendCodeViaSms + AuthService.sendSms are the only two live-send gates.
    expect(authTs.split('smsEnabled && !isAtDummy').length - 1).toBe(2);
  });
});

describe('the failure message matches the actual reason', () => {
  it('chooses the configuration notice when SMS is not enabled', async () => {
    process.env.SMS_ENABLED = 'false';
    const mod = await import('../services/auth.ts');
    expect(mod.smsDeliveryFailureMessage()).toBe(mod.SMS_NOT_ENABLED_MESSAGE);
    expect(mod.smsDeliveryFailureMessage()).not.toBe(mod.SMS_UNAVAILABLE_MESSAGE);
  });

  it('chooses the unchanged transient wording when SMS IS enabled', async () => {
    process.env.SMS_ENABLED = 'true';
    const mod = await import('../services/auth.ts');
    expect(mod.smsDeliveryFailureMessage()).toBe(mod.SMS_UNAVAILABLE_MESSAGE);
  });

  it('the configuration notice never invites a retry that cannot succeed', async () => {
    const mod = await import('../services/auth.ts');
    const notice = mod.SMS_NOT_ENABLED_MESSAGE.toLowerCase();
    expect(notice).not.toContain('try again');
    expect(notice).not.toContain('jaribu tena');
    expect(notice).not.toContain('temporarily unavailable');
    // Bilingual, like every other user-facing string in the product.
    expect(mod.SMS_NOT_ENABLED_MESSAGE).toContain(' / ');
  });

  it('the configuration notice does not promise a channel that carries no code', async () => {
    const mod = await import('../services/auth.ts');
    const notice = mod.SMS_NOT_ENABLED_MESSAGE.toLowerCase();
    // This message is reachable only from the SMS sender, and POST-E1 no
    // production flow emits an SMS event, so nothing is actually waiting on it.
    // The property that must survive anyway is the one it was written for: this
    // string must never promise email, because the channel it speaks for does not
    // carry the code.
    expect(notice).not.toContain('we have emailed');
    expect(notice).not.toContain("we'll email");
    expect(notice).not.toContain('tumekutumia barua pepe');
  });

  it('a transient provider failure still reads as one (the old wording is intact)', async () => {
    const mod = await import('../services/auth.ts');
    // The provider-refusal wording is deliberately NOT reworded: a retry really
    // can help there, and the distinction is the whole point of the change.
    expect(mod.SMS_UNAVAILABLE_MESSAGE).toContain('SMS delivery is temporarily unavailable');
    expect(mod.SMS_UNAVAILABLE_MESSAGE.toLowerCase()).toContain('try again');
  });

  it('the gateway still fails closed in production with SMS off — no send is claimed', async () => {
    // NODE_ENV must be 'production' for BOTH the import and the call: the
    // fail-closed branch reads it at call time, so restoring it early would let
    // the dev/sandbox simulation answer instead (which is exactly the bug this
    // assertion would otherwise hide).
    const res = await withProductionNodeEnv(async () => {
      const mod = await import('../services/auth.ts');
      const result = await mod.sendCodeViaSms('+254700000000', '1234', 'TEST', 'A test message');
      return { result, unavailableMessage: mod.SMS_UNAVAILABLE_MESSAGE };
    });
    expect(res.result.success).toBe(false);
    // The transport reports a transport refusal; the user-facing choice between
    // the two messages lives in the routes.
    expect(res.result.message).toBe(res.unavailableMessage);
  });
});

describe('every user-facing call site reports the failure it actually hit', () => {
  it('the agent OTP route (server.ts) no longer hard-codes an SMS transport message', () => {
    // E1: the route dispatches through the shared email OTP seam and never names
    // an SMS transport failure again.
    expect(serverTs).toContain('sendEmailOtp(');
    expect(serverTs).not.toContain('SMS_UNAVAILABLE_MESSAGE');
    expect(serverTs).not.toContain('smsDeliveryFailureMessage()');
  });

  it('the claim-OTP route (routes/claims.ts) no longer hard-codes an SMS transport message', () => {
    expect(claimsRouteTs).toContain('sendEmailOtp(');
    expect(claimsRouteTs).not.toContain('SMS_UNAVAILABLE_MESSAGE');
    expect(claimsRouteTs).not.toContain('smsDeliveryFailureMessage()');
  });

  it('the claim-link and pickup-code routes dropped the retired SMS channel branch', () => {
    // There is no "SMS is switched off for this deployment" case to word any
    // more, because no code travels by SMS. What replaced it is the truthful,
    // channel-neutral pair: a retryable provider refusal, and the fail-closed
    // refusal for an account with no verified address.
    expect(customerClaimsTs).not.toContain('isLiveSmsEnabled()');
    expect(customerClaimsTs).not.toContain('MESSAGES.smsNotEnabled');
    expect(customerClaimsTs).not.toContain('MESSAGES.pickupSmsNotEnabled');
    expect(customerClaimsTs).toContain('EMAIL_OTP_UNAVAILABLE_MESSAGE');
    expect(customerClaimsTs).toContain('EMAIL_VERIFICATION_REQUIRED_MESSAGE');
  });

  it('the refusal wording only promises what actually happened', () => {
    // Read the two messages from the seam that defines them, so the assertions
    // follow the single source of truth instead of a copy of it.
    const seam = read('src/services/emailOtp.ts');
    const unavailable =
      seam.match(/EMAIL_OTP_UNAVAILABLE_MESSAGE\s*=\s*\r?\n\s*'([^']+)'/)?.[1] ?? '';
    const verify =
      seam.match(/EMAIL_VERIFICATION_REQUIRED_MESSAGE\s*=\s*\r?\n\s*'([^']+)'/)?.[1] ?? '';
    expect(unavailable).not.toBe('');
    expect(verify).not.toBe('');
    for (const message of [unavailable, verify]) {
      expect(message).toContain(' / '); // bilingual
    }
    // A missing verified address is not fixed by retrying: nothing the customer
    // repeats makes an account verified, so that message must not say "try again".
    expect(verify.toLowerCase()).not.toContain('try again');
    expect(verify.toLowerCase()).not.toContain('jaribu tena');
    // The retryable one must not claim a channel that no longer carries codes.
    expect(unavailable.toLowerCase()).not.toContain('sms');
  });
});

describe('the pickup-code panel tells the owner the truth', () => {
  it('does not assert that a code was sent by SMS and email', () => {
    expect(ownerViewTs).not.toContain('sent a secret 6-digit code to your phone (SMS) and email');
    expect(ownerViewTs).not.toContain('kwa SMS na barua pepe');
    expect(ownerViewTs).toContain("We\\'ve sent your secret 6-digit code");
  });

  it('surfaces the server reason instead of replacing it with "try again"', () => {
    // The failure state must be able to carry the server's wording; the local
    // fallback is only for a response that cannot be parsed at all.
    expect(ownerViewTs).toContain('pickupCodeResendState.message');
    expect(ownerViewTs).toContain('message: data?.error || undefined');
  });
});

describe('the documentation states why the launch configuration is safe', () => {
  it('names the email-only code flows in every document that recommends SMS_ENABLED=false', () => {
    expect(readme).toContain('one-time-code flows');
    for (const [name, doc] of [
      ['.env.example', envExample],
      ['docs/configuration.md', configurationDoc],
      ['docs/deployment.md', deploymentDoc],
      ['docs/operations.md', operationsDoc],
      ['docs/notifications.md', notificationsDoc],
    ] as const) {
      expect(doc, `${name} must state that no one-time codes are delivered by SMS`).toContain('one-time codes');
    }
    // The canonical notification document must point at the mechanism itself.
    expect(notificationsDoc).toContain('SMS_NOT_ENABLED_MESSAGE');
    expect(notificationsDoc).toContain('smsDeliveryFailureMessage()');
  });
});

