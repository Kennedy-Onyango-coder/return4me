// =============================================================================
// E1 - THE ONE PLACE A PRODUCTION FLOW MAY ISSUE AN EMAIL ONE-TIME CODE.
//
// This is the email twin of services/smsNotification.ts: a thin, typed seam
// over the N5 NotificationService so that every migrated OTP flow makes the
// same decisions identically and cannot drift apart:
//
//   1. WHICH IDENTITY a notification is deduplicated by (`issuanceId`).
//   2. THAT the destination was resolved SERVER-SIDE by the caller from the
//      authoritative record - this module refuses anything that does not look
//      like an email address, so a phone number can never be "emailed" by
//      accident and a request-supplied destination only ever reaches here after
//      the caller has bound it to the account it belongs to.
//   3. THAT the code never reaches the durable row: it crosses the boundary as
//      a transient dispatch parameter and lives only inside the rendered body,
//      which NotificationService evaluates at send time and discards.
//
// WHY NOT REUSE sendSmsNotification
//   The SMS seam builds its live body at the Africa's Talking adapter from the
//   code itself; email has no such adapter contract - the rendered body IS the
//   live message. The shared machinery (policy lookup, idempotency, the durable
//   event row) is still ONE copy: it all lives underneath in NotificationService.
//
// RATE LIMITING lives where it always did: the routes mount the shared
// `smsRateLimit()` budget (and their own per-IP/per-account limiters) BEFORE
// any code is generated. Nothing here is unlimited, and nothing here retries:
// every event is `not_retryable` because the code it carries is hash-only.
// =============================================================================
import {
  buildNotificationIdempotencyKey,
  NotificationService,
  type NotificationResult,
} from './notificationService.ts';
import { getNotificationPolicy } from '../config/notificationEvents.ts';
import { generateSecureId } from './customerAuth.ts';
import {
  EMAIL_THEME,
  buildEmailMessage,
  emailCallout,
  emailCodeBlock,
  emailDetails,
  emailDivider,
  emailHeading,
  emailKicker,
  emailNote,
  emailParagraph,
} from './emailTemplates.ts';
/**
 * A reference to ONE issued code. Opaque and non-secret: it never contains the
 * OTP, the email address or any credential, so it is safe as an idempotency-key
 * component and safe to store.
 */
export type EmailOtpIssuanceId = string;

export function newEmailOtpIssuanceId(prefix: string): EmailOtpIssuanceId {
  return generateSecureId(prefix);
}

/**
 * Which journey the code belongs to. Chooses the bilingual copy ONLY - never
 * the destination, the event type or the policy, all of which are decided by
 * the caller and the catalogue respectively.
 */
export type EmailOtpPurpose =
  | 'customer_login'
  | 'agent_login'
  | 'account_deletion'
  | 'claim_verification'
  | 'claim_link'
  | 'identity_change_phone'
  | 'identity_change_email'
  | 'pickup_code';

/**
 * Channel-neutral failure wording for routes to surface on a provider refusal.
 * Bilingual, never names internal policy (duplicate / rate-limited / provider).
 */
export const EMAIL_OTP_UNAVAILABLE_MESSAGE =
  'Imeshindwa kutuma msimbo kwa barua pepe kwa sasa. Tafadhali jaribu tena baadaye. / The code could not be emailed right now. Please try again later.';

/**
 * Fail-closed wording for a caller that proved everything it could prove but
 * whose account has no verified email address to send to. Bilingual, generic,
 * and deliberately does not say WHICH account it is about.
 *
 * WHY IT NAMES A RECOVERY PATH (final review, Issue 2)
 *   A legacy account that holds a phone number but has never verified an email
 *   address cannot receive any one-time code after the E1 migration, and there is
 *   NO safe self-service route that could change that from here. Specifically:
 *     - registration refuses an existing phone (409), so a new email cannot be
 *       attached to that account by re-registering;
 *     - sign-in requires an already-verified email, so the owner cannot get a
 *       session to add one;
 *     - the identity-change endpoints require that session;
 *     - the only "type an address and prove it" path is new-agent onboarding,
 *       which is reached solely when NO account holds the phone — reusing it for
 *       a claim owner would let a REQUEST-SUPPLIED address become the OTP
 *       destination, which is exactly the bypass this module exists to prevent.
 *   So the decision is: stay FAIL-CLOSED and make the refusal honest and
 *   actionable, rather than invent a recovery route. The message therefore says
 *   what is true (no verified address), what to do about it (verify the address
 *   in the account, or ask support), and never promises an SMS, never reveals
 *   which account it is about, and — deliberately — never says "try again":
 *   repeating the request cannot verify an address, so inviting a retry would be
 *   the same kind of untruth as SMS_NOT_ENABLED_MESSAGE above exists to avoid.
 */
export const EMAIL_VERIFICATION_REQUIRED_MESSAGE =
  'Akaunti hii inahitaji barua pepe iliyothibitishwa kwanza. Ingia kwenye akaunti yako ya Return4me na uthibitishe barua pepe yako, au wasiliana na support@return4me.co.ke kwa msaada. / This account needs a verified email address first. Sign in to your Return4me account and verify your email address, or contact support@return4me.co.ke for help.';

/** Shape check. Deliberately stricter than "contains an @". */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Anything phone-shaped is refused even if it would parse as an email local part. */
const PHONE_SHAPED = /^[+0-9][\d\s()-]{6,}$/;
/** All flows issue 4- or 6-digit numeric codes. Nothing else may be "emailed". */
const CODE_SHAPE = /^\d{4,6}$/;

export function emailOtpRecipientIsSafe(recipient: unknown): boolean {
  if (typeof recipient !== 'string') return false;
  const trimmed = recipient.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return false;
  if (!EMAIL_SHAPE.test(trimmed)) return false;
  if (PHONE_SHAPED.test(trimmed)) return false;
  return true;
}
interface EmailOtpCopy {
  subject: string;
  preheader: string;
  kicker: string;
  headingEn: string;
  headingSw: string;
  introEn: string;
  introSw: string;
  codeLabelEn: string;
  codeLabelSw: string;
  hintEn: string;
  hintSw: string;
  /** null => the code does not age out on a timer (pickup code). */
  expiresInMinutes: number | null;
  footerNote: string;
}

/**
 * Per-journey copy. Every string is bilingual (English, divider, Kiswahili) and
 * says only what is true: where the code went ("your verified email address" -
 * never the address itself, which the durable record must not echo), how long
 * it lasts, and that staff will never ask for it.
 */
function copyFor(purpose: EmailOtpPurpose): EmailOtpCopy {
  switch (purpose) {
    case 'customer_login':
      return {
        subject: 'Your Return4me sign-in code / Msimbo wako wa kuingia - Return4me',
        preheader: 'Use this one-time code to sign in to your Return4me account.',
        kicker: 'Sign-in code',
        headingEn: 'Your sign-in code',
        headingSw: 'Msimbo wako wa kuingia',
        introEn: 'Use the code below to sign in to your Return4me account. It was sent to your verified email address, which is where your account is verified.',
        introSw: 'Tumia msimbo hapa chini kuingia kwenye akaunti yako ya Return4me. Umetumwa kwenye barua pepe iliyothibitishwa, ambapo akaunti yako iliyothibitishwa.',
        codeLabelEn: 'Sign-in code',
        codeLabelSw: 'Msimbo wa kuingia',
        hintEn: 'Valid for 5 minutes. If you did not ask for this, ignore this email - nobody can sign in without the code.',
        hintSw: 'Halali kwa dakika 5. Hukuomba wewe, kupuuza barua pepe hii - mtu hawezi kuingia bila msimbo.',
        expiresInMinutes: 5,
        footerNote: 'Return4me never asks for a sign-in code by phone, SMS or social media.',
      };
    case 'agent_login':
      return {
        subject: 'Your Return4me verification code / Msimbo wako wa uthibitisho - Return4me',
        preheader: 'Use this one-time code to continue to the Return4me Agent Hub.',
        kicker: 'Agent verification',
        headingEn: 'Your verification code',
        headingSw: 'Msimbo wako wa uthibitisho',
        introEn: 'Use the code below to continue signing in, or to finish creating your Return4me agent account. It was sent to the verified email address on the account.',
        introSw: 'Tumia msimbo hapa chini kuendelea kuingia, au kumaliza kuunda akaunti yako ya wakala wa Return4me. Umetumwa kwenye barua pepe iliyothibitishwa kwenye akaunti.',
        codeLabelEn: 'Verification code',
        codeLabelSw: 'Msimbo wa uthibitisho',
        hintEn: 'Valid for 5 minutes. Return4me staff will never ask you for this code.',
        hintSw: 'Halali kwa dakika 5. Wafanyakazi wa Return4me hawatawahi kuomba msimbo huu.',
        expiresInMinutes: 5,
        footerNote: 'Return4me never asks for a verification code by phone call or social media.',
      };
    case 'account_deletion':
      return {
        subject: 'Confirm your data deletion / Thibitisha ufutaji wa data yako - Return4me',
        preheader: 'This one-time code confirms it is really you requesting erasure.',
        kicker: 'Data erasure',
        headingEn: 'Confirm your data deletion',
        headingSw: 'Thibitisha ufutaji wa data yako',
        introEn: 'The code below confirms that you - and only you - asked Return4me to delete your personal data. It was sent to your verified email address.',
        introSw: 'Msimbo hapa chini unathibitisha kwamba wewe - na wewe pekee - uliomba Return4me ifute data yako ya binafsi. Umetumwa kwenye barua pepe iliyothibitishwa.',
        codeLabelEn: 'Deletion confirmation code',
        codeLabelSw: 'Msimbo wa uthibitisho wa ufutaji',
        hintEn: 'Valid for 5 minutes. If you did not request deletion, ignore this email and nothing will be deleted.',
        hintSw: 'Halali kwa dakika 5. Hukuomba ufutaji, kupuuza barua pepe hii na hakutafutwa kitu.',
        expiresInMinutes: 5,
        footerNote: 'Erasure is permanent once confirmed. / Ufutaji ni wa kudumu ukithibitishwa.',
      };
    case 'claim_verification':
      return {
        subject: 'Your Return4me claim code / Msimbo wako wa claim - Return4me',
        preheader: 'Use this one-time code to verify ownership of your claim.',
        kicker: 'Claim verification',
        headingEn: 'Your claim verification code',
        headingSw: 'Msimbo wako wa uthibitisho wa claim',
        introEn: 'Use the code below to verify that you own the claim you are tracking. It was sent to the verified email address registered on the owner account.',
        introSw: 'Tumia msimbo hapa chini kuthibitisha kwamba wewe ni mmiliki wa claim unayofuatilia. Umetumwa kwenye barua pepe iliyothibitishwa iliyosajiliwa kwenye akaunti ya mmiliki.',
        codeLabelEn: 'Claim verification code',
        codeLabelSw: 'Msimbo wa uthibitisho wa claim',
        hintEn: 'Valid for 5 minutes. Never share this code - it moves the claim to the next stage.',
        hintSw: 'Halali kwa dakika 5. Usishiriki msimbo huu - husogeza claim hatua inayofuata.',
        expiresInMinutes: 5,
        footerNote: 'Return4me never asks for a claim code before you are physically at the agent hub.',
      };
    case 'claim_link':
      return {
        subject: 'Link this claim to your account / Unganisha claim na akaunti yako - Return4me',
        preheader: 'This one-time code links the claim to your Return4me account.',
        kicker: 'Claim linking',
        headingEn: 'Your claim-linking code',
        headingSw: 'Msimbo wa kuunganisha claim',
        introEn: 'Use the code below to link this claim to your Return4me account. It was sent to your verified email address.',
        introSw: 'Tumia msimbo hapa chini kuunganisha claim hii na akaunti yako ya Return4me. Umetumwa kwenye barua pepe iliyothibitishwa.',
        codeLabelEn: 'Linking code',
        codeLabelSw: 'Msimbo wa kuunganisha',
        hintEn: 'Valid for 5 minutes and usable once.',
        hintSw: 'Halali kwa dakika 5 na inatumika mara moja.',
        expiresInMinutes: 5,
        footerNote: 'Linking is optional and can be undone from your dashboard.',
      };
    case 'identity_change_phone':
      return {
        subject: 'Authorize your phone change / Idhini ya kubadilisha simu yako - Return4me',
        preheader: 'This one-time code authorizes the phone number change on your account.',
        kicker: 'Account security',
        headingEn: 'Authorize the phone change',
        headingSw: 'Idhini ya kubadilisha simu',
        introEn: 'The code below authorizes changing the phone number on your Return4me account. It was sent to your verified email address. This code does NOT prove the new number works - it proves that you, the account holder, approved the change.',
        introSw: 'Msimbo hapa chini huruhusu kubadilisha nambari ya simu kwenye akaunti yako ya Return4me. Umetumwa kwenye barua pepe iliyothibitishwa. Msimbo huu HAUUTHIBITISHI kwamba nambari mpya inafanya kazi - unathibitisha kwamba wewe, mmiliki wa akaunti, umeidhinisha mabadiliko.',
        codeLabelEn: 'Phone-change authorization code',
        codeLabelSw: 'Msimbo wa idhini ya kubadilisha simu',
        hintEn: 'Valid for 30 minutes. If you did not ask to change your phone number, ignore this email - nothing has changed.',
        hintSw: 'Halali kwa dakika 30. Hukuomba kubadilisha nambari yako ya simu, kupuuza barua pepe hii - hakijabadilika kitu.',
        expiresInMinutes: 30,
        footerNote: 'Your current details stay unchanged until this code is entered.',
      };
    case 'identity_change_email':
      return {
        subject: 'Confirm your new email address / Thibitisha barua pepe mpya - Return4me',
        preheader: 'This one-time code confirms the new email address for your account.',
        kicker: 'Account security',
        headingEn: 'Confirm your new email address',
        headingSw: 'Thibitisha barua pepe mpya',
        introEn: 'The code below confirms the new email address you asked to add to your Return4me account. It was sent to that address so only its owner can confirm it.',
        introSw: 'Msimbo hapa chini unathibitisha barua pepe mpya uliyoomba kuongeza kwenye akaunti yako ya Return4me. Umetumwa kwenye anwani hiyo ili mmiliki wake pekee aweze kuthibitisha.',
        codeLabelEn: 'Email confirmation code',
        codeLabelSw: 'Msimbo wa uthibitisho wa barua pepe',
        hintEn: 'Valid for 30 minutes. Your current email address keeps working until this code is entered.',
        hintSw: 'Halali kwa dakika 30. Barua pepe yako ya sasa inaendelea kufanya kazi hadi msimbo huu utapigwa.',
        expiresInMinutes: 30,
        footerNote: 'If you did not ask for this change, ignore this email.',
      };
    case 'pickup_code':
      return {
        subject: 'Your secret pickup code / Msimbo wako wa siri wa kuchukua - Return4me',
        preheader: 'Read this code to the agent when collecting your item.',
        kicker: 'Item pickup',
        headingEn: 'Your secret pickup code',
        headingSw: 'Msimbo wako wa siri wa kuchukua',
        introEn: 'Use the code below when collecting your item. It was sent to your verified email address. Any previous pickup code for this claim is no longer valid.',
        introSw: 'Tumia msimbo hapa chini unapochukua bidhaa yako. Umetumwa kwenye barua pepe iliyothibitishwa. Msimbo wowote wa awali wa claim hii haubadiliki tena.',
        codeLabelEn: 'Secret pickup code',
        codeLabelSw: 'Msimbo wa siri wa kuchukua',
        hintEn: 'Read this code to the agent only when you are standing at the counter. It is single use. It is NOT the public item reference.',
        hintSw: 'Mpe msimbo huu wakala tu wakati umesimama kaunta. Unatumika mara moja tu. SI nambari ya rejea ya bidhaa.',
        expiresInMinutes: null,
        footerNote: 'Return4me staff or agents will never ask you for this code before you are at the counter.',
      };
  }
}

function renderEmailOtp(purpose: EmailOtpPurpose, code: string): { subject: string; body: string } {
  const copy = copyFor(purpose);
  const expiresIn = copy.expiresInMinutes;

  const content = [
    emailKicker(copy.kicker),
    emailHeading(copy.headingEn),
    emailParagraph(copy.introEn),
    emailCodeBlock({
      label: copy.codeLabelEn,
      code,
      tone: purpose === 'pickup_code' ? 'success' : 'brand',
      hint: copy.hintEn,
    }),
    ...(expiresIn !== null
      ? [emailDetails([{ label: 'Expires in', value: `${expiresIn} minutes` }])]
      : []),
    emailCallout({
      tone: 'warning',
      label: 'Keep this code private',
      text: 'Never share a Return4me code. Our staff and agents will never ask you for one by phone, SMS, WhatsApp or social media.',
    }),
    emailNote(copy.footerNote),
    emailDivider('Kiswahili'),
    emailHeading(copy.headingSw),
    emailParagraph(copy.introSw),
    emailCodeBlock({
      label: copy.codeLabelSw,
      code,
      tone: purpose === 'pickup_code' ? 'success' : 'brand',
      hint: copy.hintSw,
    }),
    ...(expiresIn !== null
      ? [emailDetails([{ label: 'Inaisha baada ya', value: `dakika ${expiresIn}` }])]
      : []),
    emailCallout({
      tone: 'warning',
      label: 'Usishiriki msimbo huu',
      text: 'Usishiriki msimbo wa Return4me. Wafanyakazi na mawakala wetu hawatawahi kuomba kwa simu, SMS, WhatsApp au mitandao ya kijamii.',
    }),
  ].join('\n');

  const { html } = buildEmailMessage({
    subject: copy.subject,
    preheader: copy.preheader,
    headerLabel: 'Return4me security code',
    accent: EMAIL_THEME.green,
    content,
    footerNote: copy.footerNote,
  });

  return { subject: copy.subject, body: html };
}

export interface EmailOtpInput {
  /**
   * Typed event from the catalogue. Must be a KNOWN event whose channel is
   * `email` - an SMS event, an unknown event or a blank is refused BEFORE any
   * database row or provider call happens.
   */
  eventType: string;
  /**
   * Server-resolved destination. The caller has already bound this address to
   * the account it belongs to (verified customer email / verified agent
   * contact_email); this module only re-checks the SHAPE.
   */
  recipient: string;
  /** Identity of THIS notification - see the module header. */
  issuanceId: EmailOtpIssuanceId;
  /** The OTP / pickup code. Required. Never persisted by anything below. */
  code: string;
  /** Chooses the bilingual copy. */
  purpose: EmailOtpPurpose;
  /** Authenticated actor, when the flow has one, for the durable record. */
  actorUserId?: string | null;
  actorRole?: string | null;
}

/**
 * Dispatches one email one-time code through the N5 notification boundary.
 *
 * `accepted` is the field callers branch on: true only when the provider
 * accepted the message. A duplicate, a policy rejection and a provider failure
 * are all `accepted: false`, so no caller can tell a user a code was sent when
 * it was not.
 *
 * Throws only for programmer errors (bad event type, unsafe recipient, bad
 * code) - those indicate a broken call site and must never be swallowed into a
 * "sent" response.
 */
export async function sendEmailOtp(input: EmailOtpInput): Promise<NotificationResult> {
  const policy = getNotificationPolicy(input.eventType);
  if (!policy || policy.channel !== 'email') {
    throw new Error(
      `sendEmailOtp: event "${input.eventType}" is not a known EMAIL notification event`,
    );
  }
  if (!emailOtpRecipientIsSafe(input.recipient)) {
    // Fail closed: an unusable destination must never fall through to a provider
    // call that could report a phantom success (or treat a phone number as an
    // address).
    throw new Error('sendEmailOtp: recipient is not a usable email address');
  }
  if (!CODE_SHAPE.test(input.code)) {
    throw new Error('sendEmailOtp: code must be a 4- or 6-digit numeric string');
  }

  const idempotencyKey = buildNotificationIdempotencyKey(input.eventType, input.issuanceId);

  return NotificationService.notify({
    eventType: input.eventType,
    recipient: input.recipient.trim(),
    idempotencyKey,
    // Transient only - evaluated inside the service at send time and discarded.
    // The durable row stores neither the body nor the code.
    render: () => renderEmailOtp(input.purpose, input.code),
    ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
    ...(input.actorRole ? { actorRole: input.actorRole } : {}),
  });
}





