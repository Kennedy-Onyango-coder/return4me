import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// SMS AS AN OPTIONAL LAUNCH CHANNEL.
//
// WHY THIS EXISTS
//   Africa's Talking SMS used to be a hard PRODUCTION BOOT DEPENDENCY. Even with
//   SMS_ENABLED unset — the recommended launch posture — a production deployment
//   refused to boot unless AFRICASTALKING_API_KEY, AFRICASTALKING_USERNAME and
//   AFRICASTALKING_SENDER_ID were all real: `isPlaceholderKey(undefined)` is
//   true, and neither boot check consulted the flag. That made it impossible to
//   launch Return4me on email/Resend alone while an approved Sender ID was still
//   being arranged.
//
//   The fix gates the two Africa's Talking checks in assertBootSecrets()
//   (src/server.ts) on the SAME predicate the runtime send path already uses in
//   src/services/auth.ts:
//
//       process.env.SMS_ENABLED === 'true'
//
//   ...so the guard and the sender can never disagree about whether SMS is live.
//
// THE CONTRACT THIS FILE PINS
//   Case 1  SMS_ENABLED is NOT 'true' -> the production boot guard does NOT
//                                        require Africa's Talking credentials.
//   Case 2  SMS_ENABLED IS 'true'     -> a missing/placeholder credential or
//                                        Sender ID still refuses to boot.
//   Case 3  Nothing else changed      -> every OTHER production secret (JWT,
//                                        admin, IntaSend, Resend, the dev-flag
//                                        refusals) is still unconditionally
//                                        enforced.
//
// TESTING PHILOSOPHY
//   The same one used by serverBootGuardP2A4.test.ts and
//   devPaymentSimulation.test.ts: server.ts never exports assertBootSecrets(),
//   and the guard throws for a dozen unrelated reasons before it could be
//   exercised in isolation, so this is a focused SOURCE AUDIT of the guard's
//   structure — the gate exists, it is exactly the runtime predicate, and it is
//   applied to exactly the two SMS checks and nothing else. The runtime
//   behaviour of the send path it mirrors is covered separately
//   (services/__tests__/smsDelivery.test.ts, __tests__/notificationServiceN5,
//   __tests__/smsIdempotencyRateLimitN6).
// =============================================================================

const REPO_ROOT = path.resolve(__dirname, '../..');
const readRepo = (relative: string) => fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');

const serverTs = readRepo('src/server.ts');
const authTs = readRepo('src/services/auth.ts');

/** The single predicate shape both the boot guard and the SMS sender must use. */
const SMS_PREDICATE = "const smsEnabled = process.env.SMS_ENABLED === 'true';";

/** The production placeholder gate the SMS credentials sit behind. */
const SMS_PLACEHOLDER_GATE =
  'if (smsEnabled && (isPlaceholderKey(process.env.AFRICASTALKING_API_KEY)';

/** The .env presence gate the SMS credentials sit behind. */
const SMS_ENV_GATE = 'if (realEnvExists && smsEnabled) {';

/**
 * The body of assertBootSecrets(), from its declaration to the email assertion
 * that closes it. Scoping every assertion to this slice means an identical
 * string elsewhere in the 4k-line file cannot make a broken guard look intact.
 * Returns '' if the markers cannot be found, which the first describe below
 * reports explicitly rather than letting the other assertions fail obscurely.
 */
function bootGuardSource(): string {
  const start = serverTs.indexOf('function assertBootSecrets()');
  if (start === -1) return '';
  const endMarker = 'assertEmailTransportConfiguration();';
  const end = serverTs.indexOf(endMarker, start);
  if (end === -1) return '';
  return serverTs.slice(start, end + endMarker.length);
}

const GUARD = bootGuardSource();

describe('the audit can see the guard it is auditing (guards against a broken scan)', () => {
  it('locates assertBootSecrets() and its closing email assertion', () => {
    expect(serverTs).toContain('function assertBootSecrets()');
    expect(serverTs).toContain('assertEmailTransportConfiguration();');
    expect(GUARD.length).toBeGreaterThan(1000);
    expect(GUARD).toContain('AFRICASTALKING_API_KEY');
  });
});

describe('Case 1 — SMS_ENABLED not "true": boot must not require Africa\'s Talking', () => {
  it('derives its SMS stance from the same predicate the sender uses', () => {
    expect(GUARD).toContain(SMS_PREDICATE);
    // Byte-identical to the runtime seam, so guard and sender cannot disagree.
    expect(authTs).toContain(SMS_PREDICATE);
    // Declared exactly once in server.ts — no second, divergent definition.
    expect(serverTs.split(SMS_PREDICATE).length - 1).toBe(1);
  });

  it('gates the production placeholder check on smsEnabled', () => {
    expect(GUARD).toContain(SMS_PLACEHOLDER_GATE);
    // The ungated form is gone: this exact shape is the regression that made a
    // production launch impossible without SMS credentials.
    expect(GUARD).not.toMatch(/^ {4}if \(isPlaceholderKey\(process\.env\.AFRICASTALKING_API_KEY\)/m);
  });

  it('gates the .env presence check on smsEnabled', () => {
    expect(GUARD).toContain(SMS_ENV_GATE);
    expect(GUARD).not.toContain('if (realEnvExists) {');
  });

  it('announces the optional channel on boot when SMS is off', () => {
    expect(GUARD).toContain('if (!smsEnabled) {');
    const logAt = GUARD.indexOf('if (!smsEnabled) {');
    const logBlock = GUARD.slice(logAt, logAt + 800);
    expect(logBlock).toMatch(/console\.log\(/);
    expect(logBlock).toContain('OPTIONAL');
    expect(logBlock).toContain('NOT required');
  });

  it('is still on the boot path, before the schema migration', () => {
    expect(serverTs).toContain('assertBootSecrets();');
    expect(serverTs.indexOf('assertBootSecrets();'))
      .toBeLessThan(serverTs.indexOf('await ensureSchemaUpToDate(pool);'));
  });
});

describe('Case 2 — SMS_ENABLED "true": the strict Africa\'s Talking requirement stands', () => {
  it('still refuses to boot on a missing/placeholder credential in production', () => {
    const at = GUARD.indexOf(SMS_PLACEHOLDER_GATE);
    expect(at, 'the gated placeholder check must exist').toBeGreaterThan(-1);
    const block = GUARD.slice(at, at + 800);
    expect(block).toMatch(/throw new Error\(/);
    expect(block).toContain('refuses to boot');
    // Every credential is still named — dropping SENDER_ID would silently
    // reintroduce the "codes only ever reach the console" failure.
    expect(block).toContain('AFRICASTALKING_API_KEY');
    expect(block).toContain('AFRICASTALKING_USERNAME');
    expect(block).toContain('AFRICASTALKING_SENDER_ID');
  });

  it('still refuses to boot when the three variables are absent from .env', () => {
    const at = GUARD.indexOf(SMS_ENV_GATE);
    expect(at, 'the gated presence check must exist').toBeGreaterThan(-1);
    const block = GUARD.slice(at, at + 800);
    expect(block).toMatch(/throw new Error\(/);
    expect(block).toContain('AFRICASTALKING_API_KEY');
    expect(block).toContain('AFRICASTALKING_USERNAME');
    expect(block).toContain('AFRICASTALKING_SENDER_ID');
    expect(block).toContain('refuses to boot');
  });

  it('keeps both SMS checks inside the production-only block', () => {
    const productionAt = GUARD.indexOf("if (process.env.NODE_ENV === 'production') {");
    expect(productionAt, 'the production block must still exist').toBeGreaterThan(-1);
    expect(productionAt).toBeLessThan(GUARD.indexOf(SMS_PLACEHOLDER_GATE));
    expect(productionAt).toBeLessThan(GUARD.indexOf(SMS_ENV_GATE));
  });
});

describe('Case 3 — making SMS optional must not have made anything else optional', () => {
  it('gates ONLY the two Africa\'s Talking checks with smsEnabled', () => {
    // Exactly one `smsEnabled &&` in the whole file: the SMS placeholder gate.
    expect(serverTs.split('smsEnabled &&').length - 1).toBe(1);
    // Exactly one `realEnvExists && smsEnabled`, i.e. the SMS presence gate.
    expect(serverTs.split(SMS_ENV_GATE).length - 1).toBe(1);
    // And the guard mentions no other provider behind smsEnabled.
    for (const other of ['INTASEND', 'JWT_SECRET', 'ADMIN_PASSCODE', 'DOC_HASH_SALT', 'RESEND']) {
      expect(GUARD).not.toContain(`smsEnabled && ${other}`);
    }
  });

  it('keeps every other production secret unconditional', () => {
    const unconditional = [
      "checkSecret('JWT_SECRET', process.env.JWT_SECRET, 32);",
      "checkSecret('DOC_HASH_SALT', process.env.DOC_HASH_SALT, 32);",
      "if (!process.env.ADMIN_PASSCODE || process.env.ADMIN_PASSCODE === '4114' || process.env.ADMIN_PASSCODE === '1234') {",
      "if (process.env.ALLOW_MOCK_OTP_BYPASS === 'true') {",
      "if (process.env.ENABLE_DEV_PAYMENT_SIMULATION === 'true') {",
      'if (isPlaceholderKey(process.env.INTASEND_PUBLISHABLE_KEY) || isPlaceholderKey(process.env.INTASEND_SECRET_KEY)) {',
      'if (isPlaceholderKey(process.env.INTASEND_WEBHOOK_SECRET)) {',
      'if (!process.env.JWT_SECRET) {',
      'if (!process.env.DOC_HASH_SALT) {',
      'if (!process.env.ADMIN_PASSCODE) {',
      'if (!process.env.INTASEND_PUBLISHABLE_KEY) {',
      'if (!process.env.INTASEND_SECRET_KEY) {',
      'assertEmailTransportConfiguration();',
    ];
    for (const line of unconditional) {
      expect(GUARD, `${line} must still be enforced by the boot guard`).toContain(line);
      expect(GUARD, `${line} must NOT be conditional on SMS_ENABLED`)
        .not.toContain(`smsEnabled && ${line}`);
    }
  });

  it('keeps both dev-gate refusals loud rather than quietly ignored', () => {
    for (const flag of ['ALLOW_MOCK_OTP_BYPASS', 'ENABLE_DEV_PAYMENT_SIMULATION']) {
      const at = GUARD.indexOf(`if (process.env.${flag} === 'true') {`);
      expect(at, `${flag} must still be refused in production`).toBeGreaterThan(-1);
      expect(GUARD.slice(at, at + 400)).toMatch(/throw new Error\(/);
    }
  });
});



