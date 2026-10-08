// =============================================================================
// E1 FINAL REVIEW — REGRESSION GUARDS FOR THE THREE REMEDIATED ISSUES.
// =============================================================================
//
// These assertions were added by the final security review that followed the
// SMS -> email OTP migration. They exist because three specific defects/gaps were
// found by reading the code, and a text-only report would not have stopped any
// of them from coming back:
//
//   Issue 1  PrivacyView's erasure UI still described an SMS OTP, and — the
//            functional half of the same bug — it never told the server that the
//            journey was a DATA DELETION, so the destination was resolved as an
//            agent sign-in and a customer's phone number resolved to no
//            destination at all. The copy is now accurate AND the request now
//            carries `purpose: 'data_deletion'`.
//   Issue 2  A legacy phone-only claim owner cannot receive a code. That is
//            correct and stays fail-closed; the refusal must now name the real
//            recovery path instead of dead-ending.
//   Issue 3  An email change is authorized by the SESSION plus proof of the NEW
//            mailbox, never by the code alone. Pinned so it cannot be softened.
//
// WHY SOURCE-LEVEL ASSERTIONS FOR THE UI/SERVER CONTRACT
//   The repo's established convention for exactly this class of invariant (see
//   smsMigrationN7.test.ts, prodBatch3InteractionContract.test.ts and
//   notificationServiceN5.test.ts): PrivacyView has no render harness, and
//   server.ts boots the whole application at import time so it cannot be
//   imported by a test. The runtime half of the review — the seam's refusal to
//   treat a phone number as an email destination, and the policy invariants every
//   email OTP event must satisfy — is asserted for real below with no mocks.
// =============================================================================
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  EMAIL_VERIFICATION_REQUIRED_MESSAGE,
  emailOtpRecipientIsSafe,
  sendEmailOtp,
} from '../services/emailOtp';
import { getNotificationPolicy } from '../config/notificationEvents';

const REPO_ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const privacySource = read('src/components/PrivacyView.tsx');
const serverTs = read('src/server.ts');
const claimsTs = read('src/routes/claims.ts');
const accountTs = read('src/routes/customerAccount.ts');
const dbTs = read('src/db/database.ts');

/**
 * The six migrated OTP flows, plus the pickup-code resend, as they now exist.
 * Every one of them must be an `email` event whose policy marks it
 * `not_retryable` (hash-only secret), and none of their producers may reach an
 * SMS sender.
 */
const EMAIL_OTP_EVENTS = [
  'CUSTOMER_LOGIN_OTP_EMAIL',
  'AGENT_LOGIN_OTP_EMAIL',
  'ACCOUNT_DELETION_OTP_EMAIL',
  'OWNER_CLAIM_VERIFICATION_CODE_EMAIL',
  'CLAIM_LINK_OTP_EMAIL',
  'IDENTITY_CHANGE_OTP_EMAIL',
  'PICKUP_CODE_EMAIL',
];

/** The retired SMS producers, still present as VOCABULARY (historical rows). */
const RETIRED_SMS_EVENTS = [
  'PHONE_VERIFICATION_OTP',
  'CUSTOMER_LOGIN_OTP',
  'AGENT_LOGIN_OTP',
  'OWNER_CLAIM_VERIFICATION_CODE',
  'CLAIM_LINK_OTP',
  'PICKUP_CODE',
];

// -----------------------------------------------------------------------------
// ISSUE 1 — PRIVACYVIEW ERASURE UX AND ITS SERVER CONTRACT
// -----------------------------------------------------------------------------
describe('Issue 1 — the erasure portal describes email delivery, not SMS', () => {
  it('tells the server this is a DATA DELETION, so a destination can be resolved', () => {
    // The whole fix. Without this key the request is read as an agent sign-in,
    // and a customer's phone number resolves to no destination — no code is
    // delivered and the journey is impossible to complete.
    expect(privacySource).toMatch(
      /body: JSON\.stringify\(\{ phone, purpose: 'data_deletion' \}\)/,
    );
  });

  it('contains no wording that implies the code is sent to the phone', () => {
    for (const stale of [
      'OTP Sent to',
      'OTP Imetumwa kwa',
      'Requires OTP mobile verification',
      'Inahitaji uhakiki wa OTP wa simu',
      'Send OTP Code',
      'Tuma Msimbo wa OTP',
    ]) {
      expect(privacySource, stale).not.toContain(stale);
    }
  });

  it('says the code goes to the verified email address on the account (EN + SW)', () => {
    expect(privacySource).toContain('verified email address on that account');
    expect(privacySource).toContain('barua pepe iliyothibitishwa ya akaunti hiyo');
    expect(privacySource).toMatch(
      /Code emailed to the verified address on the account for \$\{phone\}/,
    );
    expect(privacySource).toContain(
      'Msimbo umetumwa kwa barua pepe iliyothibitishwa ya akaunti ya ${phone}',
    );
  });

  it('states plainly that the emailed code does not prove ownership of the phone', () => {
    expect(privacySource).toContain('does not prove ownership of the phone number');
    expect(privacySource).toContain('Hauthibitishi umiliki wa nambari ya simu');
  });

  it('keeps the registered phone number as the account identifier', () => {
    // The phone is still how the account is FOUND; only the destination moved.
    expect(privacySource).toContain('Registered Phone Number');
    expect(privacySource).toContain('Nambari ya Simu Iliyosajiliwa');
    expect(privacySource).toContain('Tunatumia nambari hii kupata akaunti yako pekee');
  });

  it('never renders or transmits an email address from the browser', () => {
    // No email state, no email interpolation, and no `email` field in any
    // request body: the destination is resolved server-side or not at all.
    expect(privacySource).not.toMatch(/\$\{email\}|\$\{accountEmail\}|setEmail/);
    expect(privacySource).not.toMatch(/body: JSON\.stringify\(\{[^}]*email/i);
  });

  it('keeps the authorization semantics unchanged (phone + code + consent)', () => {
    expect(privacySource).toContain("fetch('/api/auth/request-data-deletion'");
    expect(privacySource).toMatch(/phone,\s*code: otpCode,\s*confirmConsent: true,/);
  });
});

describe('Issue 1/6 — the server contract PrivacyView now matches', () => {
  it('selects the deletion branch from purpose=data_deletion', () => {
    const at = serverTs.indexOf("const isDeletionPurpose = purpose === 'data_deletion';");
    expect(at, 'the deletion branch must exist').toBeGreaterThan(-1);
    const slice = serverTs.slice(at, at + 4000);
    expect(slice).toContain("'ACCOUNT_DELETION_OTP_EMAIL'");
    expect(slice).toContain('AGENT_LOGIN_OTP_EMAIL');
  });

  it('resolves the erasure destination server-side from the authoritative row', () => {
    const at = serverTs.indexOf("const isDeletionPurpose = purpose === 'data_deletion';");
    const slice = serverTs.slice(at, at + 4000);
    expect(slice).toContain('db.getCustomerByPhone(canonicalPhone)');
    // Verified customer address first, verified agent contact_email second.
    expect(slice).toContain('customer.email_verified_at');
    expect(slice).toContain('agent.email_verified_at');
    // ...and never from the browser.
    expect(slice).not.toMatch(/destination\s*=\s*req\.body/);
  });
});

// -----------------------------------------------------------------------------
// ISSUE 2 — LEGACY PHONE-ONLY CLAIM OWNERS: FAIL CLOSED, SAY WHY
// -----------------------------------------------------------------------------
describe('Issue 2 — the no-verified-email refusal names a real recovery path', () => {
  it('keeps the original sentence, adds the path, and never promises SMS', () => {
    expect(EMAIL_VERIFICATION_REQUIRED_MESSAGE).toContain('verified email address first');
    // BATCH B — the message is English-only now. It used to carry a Swahili half
    // after a ' / ' separator; that half is gone, and this assertion pins its
    // absence so the wording cannot silently become bilingual again.
    expect(EMAIL_VERIFICATION_REQUIRED_MESSAGE).not.toContain('barua pepe iliyothibitishwa kwanza');
    expect(EMAIL_VERIFICATION_REQUIRED_MESSAGE).not.toContain(' / ');
    // The actionable half — the thing the old one-sentence version lacked.
    expect(EMAIL_VERIFICATION_REQUIRED_MESSAGE).toContain('verify your email address');
    expect(EMAIL_VERIFICATION_REQUIRED_MESSAGE).toContain('support@return4me.co.ke');
    expect(EMAIL_VERIFICATION_REQUIRED_MESSAGE).not.toContain('uthibitishe barua pepe yako');
    // No channel other than email is offered, and no SMS is ever implied.
    expect(EMAIL_VERIFICATION_REQUIRED_MESSAGE.toLowerCase()).not.toContain('sms');
    // Nothing account-specific: no phone number, no id, no address of a PERSON
    // (the only address is our own support mailbox, which is public).
    expect(EMAIL_VERIFICATION_REQUIRED_MESSAGE).not.toMatch(/\+254|\d{7,}/);
  });

  it('Track Claim resolves the owner from the claim record, not from the request', () => {
    const start = claimsTs.indexOf('async function sendClaimVerificationEmail');
    const end = claimsTs.indexOf('export function registerClaimRoutes');
    expect(start, 'the seam must exist').toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const seam = claimsTs.slice(start, end);
    expect(seam).toContain('db.getCustomerByPhone(canonicalPhone)');
    expect(seam).toContain('customer.email_verified_at');
    expect(seam).toContain('EMAIL_VERIFICATION_REQUIRED_MESSAGE');
    expect(seam).toContain("eventType: 'OWNER_CLAIM_VERIFICATION_CODE_EMAIL'");
    // The refusal is returned AFTER the phone-match proof, and the seam itself
    // has no access to the request at all — so no request-supplied address can
    // ever become an OTP destination here.
    expect(seam).not.toContain('req.body');
    expect(seam).not.toContain('req,');
  });

  it('never falls back to SMS or to a request-supplied email', () => {
    expect(claimsTs).not.toContain('sendCodeViaSms(');
    expect(claimsTs).not.toContain('sendSmsNotification(');
    expect(claimsTs).not.toContain("body?.email");
    expect(claimsTs).not.toContain("body.email");
  });
});

// -----------------------------------------------------------------------------
// ISSUE 3 — EMAIL CHANGE AUTHORIZATION CHAIN
// -----------------------------------------------------------------------------
describe('Issue 3 — an email change is authorized by the session, proved at the new address', () => {
  const start = accountTs.indexOf("'/api/customer/profile/identity',");
  const end = accountTs.indexOf("'/api/customer/profile/identity/verify'");
  const requestRoute = accountTs.slice(start, end);

  it('requires an authenticated account before anything else happens', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(requestRoute).toContain('requireCustomerAuth');
    // Auth is the FIRST middleware: it runs before the body is even read.
    expect(requestRoute.indexOf('requireCustomerAuth')).toBeLessThan(
      requestRoute.indexOf('const kind = req.body?.kind'),
    );
  });

  it('authorizes a PHONE change with the account own verified email, not the new number', () => {
    expect(requestRoute).toContain("if (kind === 'phone')");
    expect(requestRoute).toContain('account.email_verified_at');
    expect(requestRoute).toContain('EMAIL_VERIFICATION_REQUIRED_MESSAGE');
    // The body cannot name a destination at all: only the VALUE is read.
    expect(requestRoute).not.toMatch(/destination\s*=\s*req\.body/);
  });

  it('proves ownership of a NEW address before it is committed', () => {
    // Email kind: the destination IS the new address, so redeeming the code is
    // mailbox proof — but that is all it is. The account row is untouched until
    // the redeem endpoint consumes the change.
    expect(requestRoute).toMatch(/let destination = normalized;/);
    expect(requestRoute).toContain('createCustomerIdentityChange');
    expect(requestRoute).toContain("return res.status(409).json({ error: takenMessage(kind) })");
    expect(accountTs).toContain('applyVerifiedCustomerIdentifier');
    expect(accountTs).toContain('consumeCustomerIdentityChange');
    // E1-H2 UPDATED THIS. Redeeming the code sent to the NEW address is now the
    // project's authoritative proof of control of that mailbox, so the address
    // and its verified stamp are committed in the SAME statement — the earlier
    // "clear the stamp" behaviour left a completed change permanently
    // unloginable, because the activation gate reads a NULL stamp on an account
    // that has an email as "not activated". The session requirement and the
    // mailbox proof are both still mandatory; only the end state changed.
    expect(dbTs).toContain(
      '{ email: value, email_verified_at: new Date(), updated_at: new Date() }',
    );
  });

  it('the email change is not by itself proof of authorization', () => {
    // The order that makes that true: session -> (route) -> code to the new
    // address -> redeem scoped to the session customer. The redeem endpoint
    // re-authenticates too, and scopes the change to req.customer.id.
    const verifyAt = accountTs.indexOf("'/api/customer/profile/identity/verify'");
    const verifyRoute = accountTs.slice(verifyAt, verifyAt + 2500);
    expect(verifyRoute).toContain('requireCustomerAuth');
    expect(verifyRoute).toContain('db.getIdentityChangeById(changeId, req.customer.id)');
  });
});

// -----------------------------------------------------------------------------
// ISSUE 5 — DESTINATIONS ARE SERVER-RESOLVED, AND THE SEAM REFUSES THE REST
// -----------------------------------------------------------------------------
describe('Issue 5 — the seam refuses any destination that is not a mailbox', () => {
  it('refuses a phone number, in either Kenyan format', async () => {
    for (const phoneShaped of ['+254700000000', '0712345678']) {
      expect(emailOtpRecipientIsSafe(phoneShaped)).toBe(false);
      await expect(
        sendEmailOtp({
          eventType: 'CUSTOMER_LOGIN_OTP_EMAIL',
          recipient: phoneShaped,
          issuanceId: 'FINAL-REVIEW-PHONE-SHAPED',
          code: '123456',
          purpose: 'customer_login',
        }),
      ).rejects.toThrow(/usable email address/);
    }
    expect(emailOtpRecipientIsSafe('')).toBe(false);
    expect(emailOtpRecipientIsSafe('owner@example.test')).toBe(true);
  });

  it('refuses a RETIRED SMS event, so an SMS flow cannot be re-pointed at email', async () => {
    for (const smsEvent of RETIRED_SMS_EVENTS) {
      await expect(
        sendEmailOtp({
          eventType: smsEvent,
          recipient: 'owner@example.test',
          issuanceId: 'FINAL-REVIEW-RETIRED-EVENT',
          code: '1234',
          purpose: 'customer_login',
        }),
      ).rejects.toThrow(/not a known EMAIL notification event/);
    }
  });

  it('refuses a code that is not 4-6 digits (no free-form content can be emailed)', async () => {
    await expect(
      sendEmailOtp({
        eventType: 'CUSTOMER_LOGIN_OTP_EMAIL',
        recipient: 'owner@example.test',
        issuanceId: 'FINAL-REVIEW-BAD-CODE',
        code: 'ABC123',
        purpose: 'customer_login',
      }),
    ).rejects.toThrow(/4- or 6-digit numeric string/);
  });

  it('every email OTP event is transactional and hash-only (not retryable)', () => {
    for (const event of EMAIL_OTP_EVENTS) {
      const policy = getNotificationPolicy(event) as any;
      expect(policy, event).toBeTruthy();
      expect(policy.channel, event).toBe('email');
      expect(policy.priority, event).toBe('transactional');
      expect(policy.retryClass, event).toBe('not_retryable');
    }
  });

  it('the caller cannot supply an idempotency key — it is derived in exactly one place', () => {
    const emailOtpTs = read('src/services/emailOtp.ts');
    expect(emailOtpTs).toContain(
      'buildNotificationIdempotencyKey(input.eventType, input.issuanceId)',
    );
    const inputBlock = emailOtpTs.slice(
      emailOtpTs.indexOf('export interface EmailOtpInput'),
      emailOtpTs.indexOf('export async function sendEmailOtp'),
    );
    expect(inputBlock).toContain('issuanceId: EmailOtpIssuanceId');
    expect(inputBlock).not.toContain('idempotencyKey');
  });
});

// -----------------------------------------------------------------------------
// ISSUE 4/6 — NO PRODUCTION OTP FLOW CAN REACH AN SMS SENDER
// -----------------------------------------------------------------------------
describe('Issue 4/6 — no production OTP flow reaches Africa\'s Talking', () => {
  const PRODUCERS = [
    'src/server.ts',
    'src/routes/claims.ts',
    'src/routes/customerClaims.ts',
    'src/routes/customerAccount.ts',
  ];

  for (const rel of PRODUCERS) {
    it(`${rel} dispatches through the email seam only`, () => {
      const src = read(rel);
      expect(src).not.toContain('sendCodeViaSms(');
      expect(src).not.toContain('sendSmsNotification(');
    });
  }

  it('the SMS sender survives only as an optional transport adapter', () => {
    // The single remaining CALL site in production code is the notification
    // provider's SMS adapter, which nothing on an OTP path invokes any more.
    expect(read('src/services/notificationProviders.ts')).toContain('sendCodeViaSms(phone');
    expect(read('src/services/auth.ts')).toContain('export async function sendCodeViaSms(');
  });

  it('the only module that loads the Africa\'s Talking SDK is the SMS transport itself', () => {
    const authTs = read('src/services/auth.ts');
    expect(authTs).toContain("import AfricaTalking from 'africastalking'");
    for (const rel of PRODUCERS) {
      expect(read(rel), rel).not.toContain('africastalking');
    }
  });

  it('the OTP producers that own a flow dispatch the email twin', () => {
    expect(serverTs).toContain('sendEmailOtp(');
    expect(claimsTs).toContain('sendEmailOtp(');
    expect(read('src/routes/customerClaims.ts')).toContain('sendEmailOtp(');
    // The account layer never touches a transport at all: the seam is injected.
    expect(accountTs).toContain('sendVerificationCode');
    expect(accountTs).not.toContain('sendEmailOtp');
  });

  it('SMS_ENABLED="false" is the launch posture, and nothing else becomes optional', () => {
    expect(read('.env.example')).toMatch(/^SMS_ENABLED="false"/m);
    expect(read('src/services/auth.ts')).toContain(
      "const smsEnabled = process.env.SMS_ENABLED === 'true';",
    );
    expect(serverTs).toContain("const smsEnabled = process.env.SMS_ENABLED === 'true';");
    // The two Africa's Talking boot checks are gated on SMS being live...
    expect(serverTs).toContain('if (realEnvExists && smsEnabled) {');
    expect(serverTs).toContain('if (smsEnabled && (isPlaceholderKey(process.env.AFRICASTALKING_API_KEY)');
    // ...and nothing else in the guard is.
    expect(serverTs.split('smsEnabled &&').length - 1).toBe(1);
  });
});



