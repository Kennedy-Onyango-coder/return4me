// Customer dashboard routes: the scoped claims list, per-claim detail, and the
// explicit claim-linking / unlinking flow.
//
// WHY THIS IS A SEPARATE MODULE
// server.ts constructs the whole application and calls startServer() at import
// time, so it cannot be imported by a test without booting Vite middleware,
// background sweeps and listeners. These routes are therefore registered into
// the caller's Express app, which lets the HTTP integration tests mount a REAL
// Express app around the REAL middleware and the REAL handlers.
//
// AUTHORIZATION MODEL
//  - Identity comes ONLY from req.customer, which requireCustomerAuth resolves
//    from the session cookie's hash. No customer id from the body, the query
//    string, or a claim id is ever trusted.
//  - A claim appears for a customer ONLY because an explicit
//    customer_claim_links row says so. No phone-equality matching, no
//    "all claims for this number" query, and no bulk or historical import.
//  - Linking requires proof of control through the EXISTING claim OTP (the same
//    challenge the Track Claim flow uses) AND the claim's stored security
//    answers.
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { db } from '../db/database.ts';
import { toE164Kenyan, hashCode, timingSafeEqualHex } from '../services/auth.ts';
import {
  newEmailOtpIssuanceId,
  sendEmailOtp,
  emailOtpRecipientIsSafe,
  EMAIL_OTP_UNAVAILABLE_MESSAGE,
  EMAIL_VERIFICATION_REQUIRED_MESSAGE,
} from '../services/emailOtp.ts';
import { smsRateLimit } from '../services/smsRateLimit.ts';
import { requireCustomerAuth, generateSecureId, customerOtpLastSent } from '../services/customerAuth.ts';
import { INACTIVE_CLAIM_STATUSES, isPickupEligibleClaimStatus } from '../config/claimStatuses';
// The ONE server-authoritative claim payment window (24 hours). Imported rather
// than re-typed so the customer-facing deadline can never drift from the window
// server.ts actually enforces (it previously hard-coded 15 minutes here).
import { CLAIM_PAYMENT_WINDOW_MS } from '../config/paymentWindows';
import { toOwnerSafeAgentView, toOwnerSafeItemView } from '../services/ownerSafeViews';
import { compareVerificationAnswers, isAnswerValidationFailure } from '../services/verificationValidation';

/**
 * E1 seam for the customer pickup-code resend.
 *
 * Only `accepted` is surfaced, because that is all the caller consumed before:
 * it gates whether `db.createPickupCode` is allowed to make the new code
 * authoritative. Preserving that gate exactly is what keeps the existing
 * send-first-then-persist safety property intact - a provider failure must leave
 * the previous, still-working code in place.
 *
 * The destination is the SIGNED-IN account's own verified email, resolved by
 * the route from `req.customer` and passed in here; it is never read from the
 * request body. `code` crosses only as the transient dispatch parameter, so the
 * durable notification row and every log line stay free of the secret.
 */
async function sendPickupCodeEmail(params: {
  destination: string;
  code: string;
}): Promise<{ success: boolean }> {
  try {
    const outcome = await sendEmailOtp({
      eventType: 'PICKUP_CODE_EMAIL',
      recipient: params.destination,
      // Each resend regenerates and OVERWRITES the claim's pickup code, so each is
      // a distinct notification; deduplicating by claimId would suppress every
      // resend after the first and leave the customer with an undelivered code.
      //
      // The claim id is deliberately NOT embedded: N5's key guard rejects any key
      // whose final token runs 40+ characters of credential-shaped base64url, and
      // "PICK-<claim id>-<20 hex>" crosses that line, which would silently refuse
      // every resend with `idempotency_key_contains_secret`.
      issuanceId: newEmailOtpIssuanceId('PICK'),
      code: params.code,
      purpose: 'pickup_code',
    });
    return { success: outcome.accepted };
  } catch (e) {
    console.error('[PICKUP_CODE_EMAIL_ERROR]', e);
    return { success: false };
  }
}

/**
 * E1 seam for the customer claim-link OTP.
 *
 * The caller already established that this claim's registered number belongs to
 * this customer, so surfacing a delivery failure is safe: the status is
 * unchanged and the body is the sanitised bilingual provider-retry copy. The
 * destination is the SIGNED-IN account's own verified email, resolved by the
 * route from `req.customer` - never from the request body.
 */
async function sendClaimLinkEmail(params: {
  destination: string;
  code: string;
}): Promise<{ success: boolean }> {
  try {
    const outcome = await sendEmailOtp({
      eventType: 'CLAIM_LINK_OTP_EMAIL',
      recipient: params.destination,
      // A new code overwrites the claim's stored challenge, so a new request is a
      // new notification - see sendPickupCodeEmail. As there, the claim id is not
      // embedded, because it would push the key past N5's secret-shape guard.
      issuanceId: newEmailOtpIssuanceId('LINK'),
      code: params.code,
      purpose: 'claim_link',
    });
    return { success: outcome.accepted };
  } catch (e) {
    console.error('[CLAIM_LINK_OTP_EMAIL_ERROR]', e);
    return { success: false };
  }
}

// Claim OTP parameters — deliberately identical to the existing Track Claim OTP
// (4 digits, 5 minutes, 5 attempts) because this flow REUSES that exact
// challenge mechanism. A different size/lifetime would be a second credential
// system by stealth.
const CLAIM_OTP_TTL_MS = 5 * 60 * 1000;
const CLAIM_OTP_MAX_ATTEMPTS = 5;
const CLAIM_LINK_RESEND_MS = 30 * 1000;
// P1 (B-2). Cooldown between pickup-code regenerations, per claim. Sized above
// the email round-trip so a client that ignores the UI cannot drive delivery
// spend against a victim's claim, and small enough that an owner who genuinely
// lost the first message is not locked out for long.
const PICKUP_CODE_RESEND_COOLDOWN_MS = 2 * 60 * 1000;
// The claim payment window the lifecycle enforces (agent_confirmed_at + the
// canonical 24-hour CLAIM_PAYMENT_WINDOW_MS — see config/paymentWindows.ts and
// checkClaimExpiry in server.ts). Used only to derive a display-safe
// `expires_at`; it does not itself expire anything.
const PAYMENT_WINDOW_MS = CLAIM_PAYMENT_WINDOW_MS;

const MESSAGES = {
  notLinked: 'This claim is not linked to your account.',
  codeInvalid: 'The code is invalid or has expired.',
  answersInvalid: 'The details provided do not match this claim.',
  alreadyLinkedOther: 'This claim is already linked to another account.',
  claimIdRequired: 'Enter the claim ID.',
  // E1 renamed from `smsFailed`: the code no longer travels by SMS, and the
  // wording itself was always channel-neutral ("could not send the code"). The
  // route uses it for the unexpected-error path; a provider REFUSAL is a 503
  // carrying EMAIL_OTP_UNAVAILABLE_MESSAGE instead.
  codeSendFailed: 'Could not send the code right now. Please try again.',
  // P1 (B-2). Reuses the SAME message as every other "not your claim" refusal in
  // this file so the recovery endpoint cannot become an existence oracle.
  pickupNotAvailable: 'A pickup code is not available for this claim at this stage.',
  pickupCooldown: 'Please wait a moment before requesting another pickup code.',
};

// P1 (B-2). Rate limit for pickup-code regeneration. Bounded on the CLAIM (the
// expensive thing being triggered) rather than the caller's IP, so a distributed
// attacker cannot sidestep it by rotating source addresses. Paired with the
// per-claim cooldown inside the handler and the IP-independent global ceiling
// below, so neither a per-IP limit alone nor a client-side button is relied on.
const pickupCodeResendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 5 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  keyGenerator: (req: any) => String(req.params?.claimId || req.body?.claimId || req.ip || 'unknown'),
  message: { error: 'Too many pickup code requests. Please wait before trying again.' },
});

// Every regeneration costs a real email dispatch, so — exactly as with the
// claim-link OTP above — there is a hard platform-wide ceiling that does not
// depend on IP.
const pickupCodeResendGlobalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 30 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  keyGenerator: () => 'global-pickup-code-resend-bucket',
  message: { error: 'The system is receiving too many code requests right now. Please try again shortly.' },
});

// Per-connection cap on the two linking endpoints.
const claimLinkLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 10 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { error: 'Too many claim-linking attempts. Please wait a few minutes.' },
});

// IP-independent platform-wide ceiling on claim-link OTP sends. Mirrors
// otpGlobalLimiter in server.ts: every send costs a real email dispatch and a
// per-IP limiter alone is bypassable on a deployment where `trust proxy` does not
// match the real hop count, so the hard ceiling must not depend on IP.
const claimLinkGlobalOtpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 60 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  keyGenerator: () => 'global-claim-link-otp-bucket',
  message: { error: 'The system is receiving too many code requests right now. Please try again shortly.' },
});

// Verification attempts bounded per CLAIM (the thing being attacked), so the
// limit follows the target rather than the caller's IP.
const claimLinkVerifyLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  keyGenerator: (req: any) => String(req.params?.id || req.body?.claimId || req.ip || 'unknown'),
  message: { error: 'Too many code attempts for this claim. Please wait a few minutes.' },
});

function toIso(value: any): string | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// Hand-built customer DTO. Enumerates every field explicitly. The input is
// already a narrow shape from getClaimsForCustomer (which never carries
// security_answers, owner_*, finder_*, payment_reference or provider ids), and
// item/agent masking is delegated to the SAME owner-safe views the Track Claim
// flow uses, so there is exactly one implementation of each masking rule.
//
// payment_reference, provider invoice ids/references, ledger rows and all
// admin/fraud fields are deliberately absent — the dashboard shows claim
// lifecycle state, never payment internals.
function toCustomerSafeClaimView(row: any, statusOverride?: string): any {
  const status = statusOverride || row.status;
  const expiresAt = status === 'pending_payment' && row.agent_confirmed_at
    ? toIso(new Date(new Date(row.agent_confirmed_at).getTime() + PAYMENT_WINDOW_MS))
    : null;
  return {
    id: row.id,
    status,
    // Active vs History is decided by the SAME set server.ts uses to decide
    // whether a claim is a live reservation or a closed historical attempt.
    is_active: !INACTIVE_CLAIM_STATUSES.has(status),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    expires_at: expiresAt,
    item: toOwnerSafeItemView(row.item),
    agent: toOwnerSafeAgentView(row.agent),
  };
}

export function registerCustomerClaimRoutes(
  app: any,
  deps: { checkClaimExpiry: (claim: any) => Promise<any> }
) {
  const { checkClaimExpiry } = deps;

  // ---------------------------------------------------------------------------
  // PICKUP-CODE RECOVERY (P1 / B-2).
  //
  // WHY THIS EXISTS. When a claim reaches 'escrow_held' the platform generates a
  // 6-digit pickup code, persists ONLY its hash, and sends the plaintext by email
  // (fire-and-forget at payment time; E1 then re-homed this resend onto the email
  // OTP seam). If that message never arrives the owner holds no copy at
  // all, the agent is correctly blocked from completing the handover, and the
  // money stays in escrow with no way forward. There was previously NO recovery
  // path: the plaintext is not stored, so it is not recoverable.
  //
  // SECURITY MODEL — deliberately mirroring the two link endpoints below:
  //  - Identity comes ONLY from req.customer (requireCustomerAuth, httpOnly
  //    session cookie). No customer id, phone, email or owner name from the
  //    request is ever trusted.
  //  - The customer must ALSO hold a customer_claim_links row for this claim.
  //    That row only exists because the customer separately proved control of
  //    the claim through the claim OTP plus the claim's security answers, and
  //    the database guarantees a claim belongs to AT MOST ONE customer
  //    (uq_customer_claim_links_claim).
  //  - Wrong customer / unlinked claim / unknown claim all return the SAME 404
  //    and the SAME body (MESSAGES.notLinked), so this endpoint can never
  //    become a claim-existence oracle.
  //  - The plaintext code is NEVER returned in the response, never logged, and
  //    never written to the audit log. Only its hash is persisted.
  //  - Regenerating OVERWRITES the stored hash (createPickupCode updates in
  //    place and clears verified_at), so the previous code stops working
  //    immediately. Intended, and surfaced to the user in the UI.
  // ---------------------------------------------------------------------------
  app.post(
    '/api/customer/claims/:claimId/pickup-code/resend',
    requireCustomerAuth,
    claimLinkLimiter,
    pickupCodeResendLimiter,
    pickupCodeResendGlobalLimiter,
    smsRateLimit(),
    async (req: any, res: any) => {
      try {
        const claimId = String(req.params?.claimId || '').trim().toUpperCase();
        if (!claimId) return res.status(400).json({ error: MESSAGES.claimIdRequired });

        // One uniform failure class for: no such claim, a claim belonging to
        // another account, and a claim this account never proved control of.
        const claim = await db.getClaim(claimId);
        if (!claim) return res.status(404).json({ error: MESSAGES.notLinked });

        const link = await db.getCustomerClaimLinkForClaim(claimId);
        if (!link || link.customer_id !== req.customer.id) {
          return res.status(404).json({ error: MESSAGES.notLinked });
        }

        // Reuse the SHARED pickup-eligibility rule rather than re-listing
        // statuses, so this endpoint can never disagree with the agent-side
        // pickup-details gate about when a code is meaningful. Terminal,
        // refunded and released claims are excluded by that helper.
        if (!isPickupEligibleClaimStatus(claim.status)) {
          return res.status(409).json({ error: MESSAGES.pickupNotAvailable });
        }

        // E1: the destination is THIS session's own verified email, resolved
        // server-side; the request body never supplies one. Fail closed BEFORE
        // the cooldown is spent and before a code is generated, so an account
        // without a verified address cannot burn its own throttle.
        const destination =
          req.customer.email && req.customer.email_verified_at && emailOtpRecipientIsSafe(req.customer.email)
            ? req.customer.email
            : null;
        if (!destination) {
          return res.status(403).json({ error: EMAIL_VERIFICATION_REQUIRED_MESSAGE });
        }

        // Cooldown. Keyed on the claim, mirroring the existing customerOtpLastSent
        // throttle used by the claim-link OTP, so a client that ignores the UI
        // cannot drive delivery spend against a victim's claim.
        const throttleKey = claimId + ':pickup-resend';
        if (Date.now() - (customerOtpLastSent.get(throttleKey) || 0) < PICKUP_CODE_RESEND_COOLDOWN_MS) {
          return res.status(429).json({ error: MESSAGES.pickupCooldown });
        }
        customerOtpLastSent.set(throttleKey, Date.now());

        // CSPRNG, identical to the original generation site in server.ts.
        const code = crypto.randomInt(100000, 1000000).toString();
        const codeHash = hashCode(code);

        // SEND BEFORE PERSIST — this ordering is deliberate and IS the fix for
        // the original defect.
        //
        // If we stored first and the email then failed, the previous (possibly
        // already-known-to-the-agent) code would be destroyed and the new one
        // would never arrive: the owner would have NO usable code and no way to
        // obtain one, which is exactly the permanent strand we are removing.
        //
        // Sending first means a provider failure leaves the EXISTING stored code
        // untouched — the world is no worse than before the request, and the
        // owner can simply retry.
        //
        // Delivery is judged on the provider's ACCEPTANCE result, never on the
        // absence of an exception. The system can prove acceptance, never
        // handset delivery, and the message must not overclaim.
        const emailResult = await sendPickupCodeEmail({
          destination,
          code,
        });

        if (!emailResult.success) {
          // Nothing was persisted, so the previous code is still the live one.
          await db.logAudit(
            String(req.customer.id),
            'PICKUP_CODE_RESEND_FAILED',
            `Claim ${claimId}: pickup code resend attempted but the email provider did not accept the message. The existing pickup code was left unchanged.`
          );
          return res.status(503).json({ error: EMAIL_OTP_UNAVAILABLE_MESSAGE });
        }

        // Provider accepted. Only now is the new code made authoritative, which
        // atomically invalidates the previous one.
        await db.createPickupCode(claimId, codeHash);
        await db.logAudit(
          String(req.customer.id),
          'PICKUP_CODE_RESENT',
          `Claim ${claimId}: a new pickup code was generated and accepted by the email provider. The previous code is now invalid.`
        );

        // Deliberately minimal: no code, no hash, no phone, no provider reference.
        return res.json({ success: true });
      } catch (e) {
        console.error('[CUSTOMER_PICKUP_CODE_RESEND_ERROR]', e);
        return res.status(500).json({ error: MESSAGES.codeSendFailed });
      }
    }
  );

  // ---------------------------------------------------------------------------
  // STEP 1 — request the claim OTP for an explicit link.
  //
  // Reuses the EXISTING claim-OTP challenge store (db.setClaimOtp) and the
  // existing notification seam (E1: email, was the SMS gateway). It deliberately does NOT call the public
  // POST /api/claims/:id/verify-otp route, because that route also performs a
  // lifecycle transition (status -> awaiting_agent_confirmation). Running that
  // against an already-paid or already-collected claim during linking would
  // corrupt the claim's state, which is exactly the kind of regression this
  // phase must not introduce.
  // ---------------------------------------------------------------------------
  app.post(
    '/api/customer/claims/link/request-otp',
    requireCustomerAuth,
    claimLinkLimiter,
    claimLinkGlobalOtpLimiter,
    smsRateLimit(),
    async (req: any, res: any) => {
      try {
        const claimId = String(req.body?.claimId || '').trim().toUpperCase();
        if (!claimId) return res.status(400).json({ error: MESSAGES.claimIdRequired });

        const claim = await db.getClaim(claimId);
        // 404 — not 403 — for both "no such claim" and "not your number", so an
        // authenticated customer cannot use this endpoint to discover whether
        // an arbitrary claim ID exists.
        if (!claim) return res.status(404).json({ error: MESSAGES.notLinked });

        // The claim's registered phone must be the phone this account already
        // proved control of (customer registration/login OTP). This is the same
        // bar the Track Claim flow applies before sending its OTP.
        const ownerPhone = toE164Kenyan(String(claim.owner_phone || '').replace(/\s+/g, ''));
        if (ownerPhone !== req.customer.phone) {
          return res.status(404).json({ error: MESSAGES.notLinked });
        }

        // E1: the destination is THIS session's own verified email, resolved
        // server-side; the request body never supplies one. Fail closed BEFORE
        // the throttle window is set and before a code is persisted.
        const destination =
          req.customer.email && req.customer.email_verified_at && emailOtpRecipientIsSafe(req.customer.email)
            ? req.customer.email
            : null;
        if (!destination) {
          return res.status(403).json({ error: EMAIL_VERIFICATION_REQUIRED_MESSAGE });
        }

        // Already linked? Say so plainly rather than issuing another code.
        const existingLink = await db.getCustomerClaimLinkForClaim(claimId);
        if (existingLink && existingLink.customer_id === req.customer.id) {
          return res.json({ success: true, alreadyLinked: true, claimId });
        }
        if (existingLink) {
          return res.status(409).json({ error: MESSAGES.alreadyLinkedOther });
        }

        // The item's category is returned so the client can render the correct
        // ownership question fields (the shared verificationProfiles are the
        // single source of truth for those). This is exactly the category the
        // existing /api/claims/lookup already discloses to anyone holding the
        // claim ID *and* the owner phone number — both of which this caller has
        // just demonstrated — so it is not a new disclosure.
        const item = await db.getItem(claim.item_id);
        const categoryId = (item && item.category_id) || 'other-item';

        const throttleKey = claimId + ':link';
        if (Date.now() - (customerOtpLastSent.get(throttleKey) || 0) < CLAIM_LINK_RESEND_MS) {
          return res.status(429).json({ error: 'Please wait before requesting another code.' });
        }

        // Identical generation/hashing/expiry to the Track Claim OTP.
        const code = crypto.randomInt(1000, 10000).toString();
        await db.setClaimOtp(claimId, hashCode(code), new Date(Date.now() + CLAIM_OTP_TTL_MS));
        customerOtpLastSent.set(throttleKey, Date.now());

        const emailResult = await sendClaimLinkEmail({
          destination,
          code,
        });
        // Safe to surface a delivery failure here: the claim is already
        // confirmed to be this customer's own registered number, so there is no
        // enumeration signal to leak.
        if (!emailResult.success) {
          return res.status(503).json({ error: EMAIL_OTP_UNAVAILABLE_MESSAGE });
        }

        return res.json({ success: true, categoryId, message: 'A code has been sent to your verified email address.' });
      } catch (e) {
        console.error('[CUSTOMER_CLAIM_LINK_OTP_ERROR]', e);
        return res.status(500).json({ error: 'A server error occurred. Please try again later.' });
      }
    }
  );

  // ---------------------------------------------------------------------------
  // STEP 2 — verify the OTP AND the claim's own security answers, then link.
  //
  // Both proofs are required and both are checked server-side in this one
  // request, which is why no reusable "OTP verified" proof primitive exists or
  // is needed: the browser never gets to assert that a step happened, it only
  // ever submits the code and the answers, and the server decides. There is
  // nothing for a client to fabricate.
  //
  // The code check mirrors the Track Claim verify-otp sequence exactly
  // (expiry -> attempt ceiling -> timing-safe hash compare -> consume), using
  // the same db.getClaimOtp / incrementClaimOtpAttempts / deleteClaimOtp
  // primitives — minus the lifecycle transition that route also performs.
  // ---------------------------------------------------------------------------
  app.post(
    '/api/customer/claims/link/verify',
    requireCustomerAuth,
    claimLinkLimiter,
    claimLinkVerifyLimiter,
    async (req: any, res: any) => {
      try {
        const claimId = String(req.body?.claimId || '').trim().toUpperCase();
        const code = String(req.body?.code || '').trim();
        if (!claimId) return res.status(400).json({ error: MESSAGES.claimIdRequired });

        const claim = await db.getClaim(claimId);
        if (!claim) return res.status(404).json({ error: MESSAGES.notLinked });

        const ownerPhone = toE164Kenyan(String(claim.owner_phone || '').replace(/\s+/g, ''));
        if (ownerPhone !== req.customer.phone) {
          return res.status(404).json({ error: MESSAGES.notLinked });
        }

        const existingLink = await db.getCustomerClaimLinkForClaim(claimId);
        if (existingLink && existingLink.customer_id === req.customer.id) {
          return res.json({ success: true, alreadyLinked: true, claimId });
        }
        if (existingLink) {
          return res.status(409).json({ error: MESSAGES.alreadyLinkedOther });
        }

        const record = await db.getClaimOtp(claimId);
        if (!record) return res.status(400).json({ error: MESSAGES.codeInvalid });

        if (record.expires_at.getTime() < Date.now()) {
          await db.deleteClaimOtp(claimId);
          return res.status(400).json({ error: MESSAGES.codeInvalid });
        }

        const codeMatches = /^\d{4}$/.test(code) && timingSafeEqualHex(hashCode(code), record.code_hash);
        if (!codeMatches) {
          const attempts = await db.incrementClaimOtpAttempts(claimId);
          if (attempts >= CLAIM_OTP_MAX_ATTEMPTS) {
            await db.deleteClaimOtp(claimId);
          }
          return res.status(400).json({ error: MESSAGES.codeInvalid });
        }

        // SINGLE-USE: consume the challenge before anything is created, so a
        // replayed code can never be used a second time.
        await db.deleteClaimOtp(claimId);

        // Second proof: the claim's own stored security answers. Category comes
        // from the server-side item (never from the request), exactly as the
        // claim-submission route does.
        const item = await db.getItem(claim.item_id);
        const categoryId = (item && item.category_id) || 'other-item';
        const answersOk = compareVerificationAnswers(
          categoryId,
          claim.security_answers,
          req.body?.securityAnswers
        );
        if (isAnswerValidationFailure(answersOk)) {
          // Generic on purpose — never reveals which field was wrong or what
          // the expected value was.
          return res.status(400).json({ error: MESSAGES.answersInvalid });
        }

        // The database (uq_customer_claim_links_claim) is what actually
        // enforces "at most one customer per claim" under a race.
        const outcome = await db.linkClaimToCustomer(
          generateSecureId('CCL'),
          req.customer.id,
          claimId,
          'claim_otp+security_answers'
        );
        if (outcome === 'already_linked_other') {
          return res.status(409).json({ error: MESSAGES.alreadyLinkedOther });
        }

        await db.logAudit(
          'CUSTOMER',
          'CUSTOMER_CLAIM_LINK',
          `Customer ${req.customer.id} linked claim ${claimId} via claim OTP + security answers.`
        );

        return res.json({ success: true, linked: true, claimId });
      } catch (e) {
        console.error('[CUSTOMER_CLAIM_LINK_VERIFY_ERROR]', e);
        return res.status(500).json({ error: 'A server error occurred. Please try again later.' });
      }
    }
  );

  // Applies the SAME lazy expiry rule the Track Claim status route applies, so
  // a pending_payment claim whose 15-minute window has long passed is never
  // presented to the customer as active. Only pending_payment rows are re-read
  // in full — the check is a no-op for every other status — so this stays a
  // bounded number of queries rather than an N+1 across the whole list.
  async function resolveDisplayStatus(row: any): Promise<string> {
    if (row.status !== 'pending_payment') return row.status;
    const full = await db.getClaim(row.id);
    if (!full) return row.status;
    const refreshed = await checkClaimExpiry(full);
    return (refreshed && refreshed.status) || row.status;
  }

  // ---------------------------------------------------------------------------
  // The customer's own claims. Scope is the customer_claim_links row and
  // nothing else: no phone matching, no claim-id-only access, and never the
  // anonymous /api/claims/:id/status endpoint.
  // ---------------------------------------------------------------------------
  app.get('/api/customer/claims', requireCustomerAuth, async (req: any, res: any) => {
    try {
      const rows = await db.getClaimsForCustomer(req.customer.id);
      const claims = [];
      for (const row of rows) {
        claims.push(toCustomerSafeClaimView(row, await resolveDisplayStatus(row)));
      }
      return res.json({ claims });
    } catch (e) {
      console.error('[CUSTOMER_CLAIMS_LIST_ERROR]', e);
      return res.status(500).json({ error: 'A server error occurred. Please try again later.' });
    }
  });

  // ---------------------------------------------------------------------------
  // A single claim, only if it is linked to THIS customer.
  //
  // 404 (never 403) when the claim is not linked to the caller — including when
  // it belongs to another customer — so the endpoint cannot be used to confirm
  // that someone else's claim exists. The anonymous Track Claim status route is
  // deliberately not consulted as an authorization shortcut.
  // ---------------------------------------------------------------------------
  app.get('/api/customer/claims/:id', requireCustomerAuth, async (req: any, res: any) => {
    try {
      const claimId = String(req.params.id || '').trim().toUpperCase();
      const rows = await db.getClaimsForCustomer(req.customer.id);
      const row = rows.find((r: any) => r.id === claimId);
      if (!row) return res.status(404).json({ error: MESSAGES.notLinked });
      return res.json({ claim: toCustomerSafeClaimView(row, await resolveDisplayStatus(row)) });
    } catch (e) {
      console.error('[CUSTOMER_CLAIM_DETAIL_ERROR]', e);
      return res.status(500).json({ error: 'A server error occurred. Please try again later.' });
    }
  });

  // ---------------------------------------------------------------------------
  // Unlink. Removes only the authenticated customer's OWN link: the ownership
  // check is part of the DB call, so a cross-customer delete is impossible by
  // construction. 404 rather than 403 when there is no such link for this
  // customer, so it never reveals another customer's link.
  //
  // The claim itself is untouched — ownership evidence, payment state and
  // lifecycle history all stay exactly as they were.
  // ---------------------------------------------------------------------------
  app.delete('/api/customer/claims/:id/link', requireCustomerAuth, async (req: any, res: any) => {
    try {
      const claimId = String(req.params.id || '').trim().toUpperCase();
      const removed = await db.unlinkClaimFromCustomer(req.customer.id, claimId);
      if (!removed) return res.status(404).json({ error: MESSAGES.notLinked });

      await db.logAudit(
        'CUSTOMER',
        'CUSTOMER_CLAIM_UNLINK',
        `Customer ${req.customer.id} unlinked claim ${claimId}.`
      );
      return res.json({ success: true });
    } catch (e) {
      console.error('[CUSTOMER_CLAIM_UNLINK_ERROR]', e);
      return res.status(500).json({ error: 'A server error occurred. Please try again later.' });
    }
  });
}
