// OWNER CLAIM LIFECYCLE — claim submission and claim OTP dispatch/verification.
//
// P2-A3.1 — MECHANICAL EXTRACTION. These three handlers were moved VERBATIM out
// of server.ts so they can be mounted for real HTTP integration testing. Nothing
// was redesigned: middleware order, validation order, every authorization and
// state guard, every status code, every message and every side effect is
// byte-identical to the inline versions they replace.
//
// ROUTES MOVED HERE
//   POST /api/claims/submit        (tiered identity verification)
//   POST /api/claims/:id/request-otp
//   POST /api/claims/:id/verify-otp
//
// DELIBERATELY NOT MOVED (payment batch owns these):
//   POST /api/claims/:id/payment-auth
//   POST /api/claims/:id/payment-session
//   POST /api/claims/:id/payment-session/:sessionId/initiate
//   GET  /api/claims/:id/payment-session/:sessionId/status
//   POST /api/claims/:id/pay
//   POST /api/claims/lookup
//   POST /api/claims/:id/rate
//   GET  /api/claims/:id/status
//
// WHY THIS IS A SEPARATE MODULE
// server.ts constructs the whole application and boots it at import time
// (Vite middleware, background sweeps and listeners), so it cannot be imported
// by a test. These routes are registered into the caller's Express app, letting
// an integration test mount a REAL Express app around the REAL handlers — the
// same pattern established by routes/finderReport.ts, routes/publicSearch.ts,
// routes/customerClaims.ts, routes/publicItems.ts, routes/lostReports.ts,
// routes/adminClaims.ts, routes/adminDisputes.ts, routes/adminLostReports.ts and
// routes/categories.ts. This module must never boot anything itself.
//
// SECURITY INVARIANTS PRESERVED FROM server.ts (do not "tidy" any of these):
//  - canCreateClaim is the ONE claimability rule, injected so this route,
//    routes/publicSearch.ts, routes/publicItems.ts and the payment routes can
//    never disagree about which items are claimable.
//  - The duplicate-claim check compares NORMALIZED E.164 phones on both sides,
//    and only INACTIVE_CLAIM_STATUSES claims stop reserving an item.
//  - The verification profile is derived from the item's SERVER-KNOWN category,
//    never from anything the claimant supplies.
//  - Claim OTP: crypto.randomInt, hash-only persistence, 5-minute expiry, 5
//    attempts, timing-safe compare, single-use (deleted only AFTER the
//    transition commits), and a non-production-only mock bypass.
//  - request-otp proves OWNERSHIP (normalized phone match) BEFORE the state
//    gate, so a wrong-phone caller cannot learn a claim's status. Both failures
//    return the SAME 404 and the SAME body.
//  - verify-otp refuses any transition except from 'pending_verification', so a
//    paid/settled claim can never be pushed BACKWARD by a fresh OTP.
//  - The customer-account link is strictly ADDITIVE and runs only after the
//    transition and OTP consumption, wrapped so linkage failure can never turn a
//    successful verification into a 500.
//
// CHANGED SINCE THE EXTRACTION — the ONE deliberate deviation, called out here
// because the note above promises byte-identical handlers:
//  - POST /api/claims/submit is now an AUTHENTICATED write. requireCustomerAuth
//    is its FIRST middleware, so the anonymous-claim hole is closed at the
//    server rather than only in the UI. The three handlers are otherwise still
//    byte-identical; the OTP journey (request-otp / verify-otp) deliberately
//    stays anonymous. Full rationale and blast radius are on the route itself.
import crypto from 'crypto';
import { db } from '../db/database.ts';
import { toE164Kenyan, hashCode, timingSafeEqualHex, SMS_UNAVAILABLE_MESSAGE } from '../services/auth.ts';
import { newSmsIssuanceId, sendSmsNotification } from '../services/smsNotification.ts';
import { smsRateLimit } from '../services/smsRateLimit.ts';
import { isValidImageSignature } from '../services/imageSignature.ts';
import { uploadBase64Image } from '../services/storage.ts';
import { INACTIVE_CLAIM_STATUSES, CLAIM_UNAVAILABLE_MESSAGE } from '../config/claimStatuses.ts';
import { PAYMENT_STRIKE_RESTRICTION_THRESHOLD } from '../config/paymentStrikePolicy.ts';
import { validateVerificationAnswers, isAnswerValidationFailure } from '../services/verificationValidation.ts';
import { requireCustomerAuth, resolveOptionalCustomer, linkVerifiedClaimToCustomer } from '../services/customerAuth.ts';
import { produceClaimVerificationAccepted } from '../services/claimNotificationProducers.ts';

import { toOwnerSafeClaimView } from '../services/ownerSafeViews.ts';

/**
 * N7 seam for the Track-Claim OTP.
 *
 * Maps the notification outcome back onto the EXACT contract
 * `sendCodeViaSms` returned to this route before N7, so the handler's status
 * codes and user-facing strings are untouched:
 *
 *   accepted -> { success: true,  message: <the composed message> }
 *   rejected -> { success: false, message: <the generic provider retry text> }
 *
 * Note the failure message is deliberately the gateway's own sanitised text
 * (SMS_UNAVAILABLE_MESSAGE), not `NotificationResult.reason` — `reason` names
 * internal policy (duplicate / rate-limited / provider error) and this route
 * forwards the message straight to the end user on 503. Surfacing it would leak
 * notification internals and, for a duplicate, would tell a legitimate user
 * something the gateway never told them.
 */
async function sendClaimVerificationSms(params: {
  recipient: string;
  code: string;
}): Promise<{ success: boolean; message: string }> {
  const message = `Msimbo mpya wa thibitisho la claim umetumwa kwa nambari ya simu ya ${params.recipient}.`;
  const outcome = await sendSmsNotification({
    eventType: 'OWNER_CLAIM_VERIFICATION_CODE',
    recipient: params.recipient,
    // The claim-OTP store is keyed by claimId and OVERWRITES on each request,
    // so a new code is a new notification. Binding the key to the claimId alone
    // would suppress every resend after the first — leaving the owner with a
    // code they never received. Each issuance gets its own opaque reference.
    //
    // The claim id is deliberately NOT part of this reference. N5's key guard
    // rejects any key whose final token runs 40+ characters of credential-shaped
    // base64url, and "CLM-<id>-<20 hex>" crosses that line — every claim OTP
    // would have been silently refused with `idempotency_key_contains_secret`.
    // The issuance reference alone is unique and sufficient; the claim is
    // already identifiable from the event type and the masked recipient.
    issuanceId: newSmsIssuanceId('CLMOTP'),
    seam: 'code',
    code: params.code,
    label: 'CLAIM OTP',
    message,
  });
  return {
    success: outcome.accepted,
    message: outcome.accepted ? message : SMS_UNAVAILABLE_MESSAGE,
  };
}

export function registerClaimRoutes(
  app: any,
  deps: {
    // Shared, not re-implemented: identical error disclosure to every inline route.
    sendServerError: (res: any, error: any, context: string) => void;
    // The single claimability rule and its user-facing refusal messages. Both are
    // INJECTED rather than moved: server.ts still calls them from the payment
    // routes this batch does not touch, so moving either would split the
    // implementation in two.
    canCreateClaim: (item: any, preFetchedDisputes?: any[]) => Promise<{ allowed: boolean; reason: string }>;
    claimabilityErrorMessage: (reason: string) => string;
    // Claim-id minting stays authored in server.ts and is injected, so the
    // "under 900,000 values" entropy note and the collision-retry/fallback logic
    // keep a single authoritative definition. server.ts still references it in
    // its own explanatory comments, so it is NOT moved.
    generateUniqueClaimId: (maxAttempts?: number) => Promise<string>;
    // Emergency admin pause — injected so this route keeps reading the same
    // admin setting through the same fail-safe helper.
    pauseSettingKey: (scope: 'reports' | 'claims' | 'payments' | 'payouts' | 'handovers' | 'social_publishing') => string;
    isPlatformOperationPaused: (settingKey: string) => Promise<boolean>;
    PAUSED_MESSAGES: Record<string, string>;
    // The SAME middleware instances server.ts already uses, so the buckets and
    // the effective limits are unchanged by the move.
    otpGlobalLimiter: any;
    otpIpLimiter: any;
    otpClaimLimiter: any;
    otpVerifyLimiter: any;
  }
) {
  const {
    sendServerError,
    canCreateClaim,
    claimabilityErrorMessage,
    generateUniqueClaimId,
    pauseSettingKey,
    isPlatformOperationPaused,
    PAUSED_MESSAGES,
    otpGlobalLimiter,
    otpIpLimiter,
    otpClaimLimiter,
    otpVerifyLimiter,
  } = deps;
  // 6. OWNER CLAIMS: TIERED IDENTITY VERIFICATION
  //
  // SECURITY BOUNDARY — this route is an AUTHENTICATED WRITE.
  //
  // The gap being closed: the UI already gated claim entry (PublicItemView
  // checks GET /api/customer/me and hands a signed-out visitor to the /account
  // boundary; OwnerView's search-result button refuses to enter the confidence
  // gate without a live session). The SERVER did not. Hiding a form is not a
  // control, so anyone with curl could still create claims anonymously: an
  // unauthenticated, unmetered point of unbounded row growth, notification
  // fan-out and support load, and a second code path where "who is claiming"
  // was never established at all.
  //
  // The fix reuses the ONE primitive every other customer-authenticated route
  // already uses — requireCustomerAuth (services/customerAuth.ts), the same
  // middleware behind /api/claims/lookup, /api/claims/:id/rate and the whole
  // /api/customer/* surface. No second authentication mechanism was introduced.
  // It is an ordinary Express middleware mounted FIRST, so it either calls
  // next() after a fully validated session or terminates the request itself:
  // no item lookup, no claimability check, no verification-answer validation,
  // no ID-proof upload, no duplicate/dispute scan and no insert can run for a
  // caller without a live session. It reads identity EXCLUSIVELY from the
  // httpOnly r4m_customer_session cookie (never the body, query or params), so
  // a client-supplied customer id cannot select or impersonate an account, and
  // a dependency failure is answered 500 instead of falling through — the
  // boundary fails CLOSED in every branch.
  //
  // WHAT DELIBERATELY DID NOT CHANGE — the claim OTP journey below. The claim
  // OTP, not an account, is what proves ownership of a claim, so request-otp
  // and verify-otp stay reachable without a session; verify-otp keeps using
  // resolveOptionalCustomer for the strictly additive post-verification account
  // link, which is exactly the one purpose its own docblock permits it for
  // ("Anything that REQUIRES authentication must keep using
  // requireCustomerAuth"). Nothing about the OTP contract, the phone match,
  // the state machine or the optional link is altered by this boundary.
  app.post('/api/claims/submit', requireCustomerAuth, async (req, res) => {
    const { itemId, ownerPhone, securityAnswers, verificationTier, idProofBase64, termsAccepted, ownerIdentifyingDetails, ownerEmail } = req.body;

    if (await isPlatformOperationPaused(pauseSettingKey('claims'))) {
      return res.status(503).json({ error: PAUSED_MESSAGES.claims });
    }

    if (!itemId || !ownerPhone || !securityAnswers) {
      return res.status(400).json({ error: 'Tafadhali jaza maelezo yote ya usajili wa claim.' });
    }

    if (!termsAccepted) {
      return res.status(400).json({ error: 'Ni lazima ukubali Vigezo na Masharti yetu kabla ya kuendelea (You must agree to our Terms and Privacy Policy).' });
    }

    // The frontend previously fell back to a hardcoded sandbox number when a
    // phone was missing. That fallback must never reach production identity
    // handling: a claim's owner_phone is the handle used for OTP, pickup-code
    // delivery and claimant lookup, so the server now requires a real value.
    const normalizedOwnerPhone = toE164Kenyan(String(ownerPhone).replace(/\s+/g, ''));
    if (!/^\+254\d{9}$/.test(normalizedOwnerPhone)) {
      return res.status(400).json({ error: 'Nambari ya simu halali ya Kenya inahitajika. / A valid Kenyan phone number is required.' });
    }

    const ownerIdentifyingDetailValue =
      typeof ownerIdentifyingDetails === 'string' ? ownerIdentifyingDetails.trim() : '';
    if (!ownerIdentifyingDetailValue) {
      return res.status(400).json({ error: 'Maelezo ya kitambulisho yanahitajika. / An identifying detail is required.' });
    }
    if (ownerIdentifyingDetailValue.length > 300) {
      return res.status(400).json({ error: 'Maelezo ya kitambulisho ni marefu kupita kiasi. / Identifying detail is too long.' });
    }

    try {
      // A1: the AUTHORITATIVE active-strike count. Previously this read the raw
      // aggregate counter, which never expired - a strike was permanent and the
      // counter could not shrink. It now counts only strikes inside their 5-day
      // window, which is what "active" means in the locked decision.
      //
      // Threshold unchanged (>=3) and the protected operation unchanged (filing a
      // claim), so the gate blocks exactly what it blocked before; only the
      // definition of "3" is now time-bounded.
      const strikeCount = await db.getActivePaymentStrikeCount(ownerPhone);
      if (strikeCount >= PAYMENT_STRIKE_RESTRICTION_THRESHOLD) {
        return res.status(403).json({
          error: "Akaunti yako imezuiliwa kwa muda kwa sababu ya kutolipa baada ya kuthibitisha mara kwa mara. Tafadhali wasiliana na usaidizi. / Your account is temporarily restricted due to repeated unpaid confirmations. Please contact support or administrator."
        });
      }

      const item = await db.getItem(itemId);
      if (!item) {
        return res.status(404).json({ error: 'Bidhaa inayotafutwa haikupatikana.' });
      }

      // Central claimability rule — see canCreateClaim(). Independently
      // re-verified here rather than trusting that the item was claimable
      // when it appeared in a search result; the two checks must never be
      // allowed to drift apart, which is exactly why they share one
      // function instead of being reimplemented per-endpoint.
      const claimability = await canCreateClaim(item);
      if (!claimability.allowed) {
        return res.status(423).json({ error: claimabilityErrorMessage(claimability.reason) });
      }

      // Server-authoritative verification profile enforcement. The category is
      // the item's SERVER-KNOWN category, never a category supplied by the
      // claimant. Unknown keys, wrong types, oversized/forbidden values and
      // missing required fields are rejected before anything is stored.
      const categoryId = item.category_id || 'other-item';
      const validation = validateVerificationAnswers(categoryId, securityAnswers);
      if (isAnswerValidationFailure(validation)) {
        return res.status(400).json({
          error: `Majibu ya usalama si sahihi. ${validation.error} / Verification answers are invalid. ${validation.error}`,
        });
      }
      const sanitizedAnswers = validation.sanitized;

      // If ID proof is provided, validate its signature and upload to S3 storage
      let idProofUrl: string | null = null;
      if (idProofBase64 && item.is_sensitive_document !== false) {
        if (!isValidImageSignature(idProofBase64)) {
          return res.status(400).json({ error: 'Aina ya picha ya kitambulisho haikubaliki. Pakia picha ya JPEG, PNG, WEBP, au HEIC.' });
        }
        idProofUrl = await uploadBase64Image(idProofBase64, 'id-proofs');
      }

      // Check if there is already an active (non-disputed, non-rejected) claim on this item_id to trigger an auto-dispute.
      // Runs for every item type — not just sensitive documents. A second
      // claimant on a laptop or phone is exactly as much a collision risk as
      // a second claimant on a national ID; the item shouldn't be handed to
      // "whoever clicked claim first" in either case.
      // Only ACTIVE claims count here. A claim whose status is in
      // INACTIVE_CLAIM_STATUSES is a CLOSED attempt (most importantly:
      // 'payment_window_expired' = simple abandonment, NOT a competing
      // claimant and NOT a dispute). Historical records stay in the DB
      // for audit; they must simply stop acting as live reservations.
      {
        // P12-F2: compare NORMALIZED phones on both sides — claims are stored in
        // E.164 (`normalizedOwnerPhone`), so comparing the raw client string let a
        // returning claimant miss their own claim, creating a duplicate plus a
        // self-collision dispute that froze the item with 423. Full rationale and
        // the live reproduction: src/__tests__/claimDuplicatePhoneNormalization.test.ts
        const normalizeOwnerPhone = (p: unknown) => toE164Kenyan(String(p || '').replace(/\s+/g, ''));
        const targetOwnerPhone = normalizedOwnerPhone;
        const isActiveClaim = (c: { status: string }) => !INACTIVE_CLAIM_STATUSES.has(c.status);
        const sameOwnerClaim = (await db.getClaims()).find(c =>
          c.item_id === itemId &&
          isActiveClaim(c) &&
          c.owner_phone &&
          normalizeOwnerPhone(c.owner_phone) === targetOwnerPhone
        );

        if (sameOwnerClaim) {
          return res.json({
            claim: toOwnerSafeClaimView(sameOwnerClaim),
            message: 'Unarejelea claim yako ya awali.',
          });
        }

        const existingClaims = (await db.getClaims()).filter(c =>
          c.item_id === itemId &&
          isActiveClaim(c) &&
          c.owner_phone &&
          normalizeOwnerPhone(c.owner_phone) !== targetOwnerPhone
        );

        if (existingClaims.length > 0) {
          const existingClaim = existingClaims[0];
          const newClaimCode = await generateUniqueClaimId();

          // Save duplicate claim as disputed
          const newClaim = await db.createClaim({
            id: newClaimCode,
            item_id: itemId,
            owner_phone: normalizedOwnerPhone,
            owner_email: ownerEmail || null,
            security_answers: sanitizedAnswers,
            verification_tier: verificationTier || 1,
            status: 'disputed',
            owner_id_proof_url: idProofUrl,
            payment_reference: null,
            owner_identifying_details: ownerIdentifyingDetailValue || null,
          });

          // Generate a dispute. createDispute() only marks both claims
          // 'disputed' — it deliberately does not touch item.status, since
          // a dispute is about ownership, not physical custody (see the
          // comment in database.ts).
          const disputeCode = 'DSP-' + Math.floor(1000 + Math.random() * 9000).toString();
          try {
            await db.createDispute({
              id: disputeCode,
              item_id: itemId,
              claimant_1_claim_id: existingClaim.id,
              claimant_2_claim_id: newClaim.id,
              claimant_1_id_proof_url: existingClaim.owner_id_proof_url || 'no-proof-yet',
              claimant_2_id_proof_url: newClaim.owner_id_proof_url || 'no-proof-yet',
              resolved_by: null,
              resolved_claim_id: null,
              resolved_at: null,
              admin_notes: null,
            });
          } catch (disputeErr: any) {
            // uq_disputes_one_unresolved_per_item — an unresolved dispute
            // was already created for this item in the gap between our
            // read above and this insert (e.g. a third near-simultaneous
            // claimant). That's fine: the item is already correctly
            // frozen by the dispute that won the race, so this claim
            // still needs to be surfaced to admin the same way.
            const isUniqueViolation = disputeErr?.code === '23505' || String(disputeErr?.cause?.code) === '23505' || /uq_disputes_one_unresolved_per_item/.test(String(disputeErr?.message || disputeErr?.cause?.message || ''));
            if (!isUniqueViolation) throw disputeErr;
          }

          return res.status(409).json({
            error: 'Bidhaa hii tayari inadaiwa na mtu mwingine. Mzozo (Dispute) umefunguliwa na utachunguzwa na wasimamizi wetu.',
            claim: toOwnerSafeClaimView(newClaim),
            isDisputed: true
          });
        }
      }

      // Tier 1 Validation: Check security answers (e.g. last 4 digits of the document matches OCR)
      // Skip for non-sensitive items
      let tierPassed = true;
      if (item.is_sensitive_document !== false && item.ocr_extracted_number) {
        const lastDigitsInput = sanitizedAnswers.lastDigits ? sanitizedAnswers.lastDigits.toUpperCase() : '';
        if (lastDigitsInput) {
          // 1. Raw comparison (removing non-alphanumeric, case-insensitive)
          const rawOcr = item.ocr_extracted_number.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
          const cleanInput = lastDigitsInput.replace(/[^A-Z0-9]/g, '');
          const lastRawOcr = rawOcr.substring(Math.max(0, rawOcr.length - cleanInput.length));

          // 2. Numeric-only comparison (for pure-numeric document numbers)
          const cleanOcrDigits = item.ocr_extracted_number.replace(/\D/g, '');
          const cleanInputDigits = lastDigitsInput.replace(/\D/g, '');
          const lastDigitsOcr = cleanOcrDigits.substring(Math.max(0, cleanOcrDigits.length - cleanInputDigits.length));

          const rawMatch = cleanInput && lastRawOcr === cleanInput;
          const digitsMatch = cleanInputDigits && lastDigitsOcr === cleanInputDigits;

          if (!rawMatch && !digitsMatch) {
            tierPassed = false;
          }
        }
      }

      if (!tierPassed) {
        return res.status(400).json({
          error: 'Majibu ya usalama hayajalingana na maelezo ya hati hii. Tafadhali thibitisha na ujaribu tena.',
        });
      }

      // Tier 3 Validation: Require and store ID proof upload
      // Skip for non-sensitive items
      const isTier3 = item.is_sensitive_document !== false && (verificationTier === 3 || !!idProofBase64);
      if (isTier3) {
        if (!idProofUrl) {
          return res.status(400).json({ error: 'Uthibitisho wa Kitambulisho (ID Proof upload) unahitajika kwa Tier 3.' });
        }
      }

      const claimCode = await generateUniqueClaimId();

      // Create Claim in pending_verification until Tier 2 OTP is satisfied.
      // The application-level duplicate check above narrows the race window
      // but can't close it entirely (two requests can both pass that check
      // before either commits) — uq_claims_one_active_per_item is the real
      // backstop. If we lose that race here, someone else's claim on this
      // item committed in the gap between our check and our insert; that's
      // not a server error, it's a legitimate "someone else got there
      // first" outcome, so we surface it as one.
      let claim;
      try {
        claim = await db.createClaim({
          id: claimCode,
          item_id: itemId,
          owner_phone: normalizedOwnerPhone,
          owner_email: ownerEmail || null,
          security_answers: sanitizedAnswers,
          verification_tier: isTier3 ? 3 : 2,
          status: 'pending_verification',
          owner_id_proof_url: idProofUrl,
          payment_reference: null,
          owner_identifying_details: ownerIdentifyingDetailValue || null,
        });
      } catch (raceErr: any) {
        const isUniqueViolation = raceErr?.code === '23505' || String(raceErr?.cause?.code) === '23505' || /uq_claims_one_active_per_item/.test(String(raceErr?.message || raceErr?.cause?.message || ''));
        if (isUniqueViolation) {
          return res.status(409).json({
            error: 'Mtu mwingine ameshadai bidhaa hii sekunde chache zilizopita. Tafadhali onyesha usaidizi ikiwa unaamini hii ni makosa. / Someone else just claimed this item moments ago. Please contact support if you believe this is a mistake.',
          });
        }
        throw raceErr;
      }

      // Log terms acceptance in audit log server-side
      await db.logAudit(
        ownerPhone,
        'TERMS_ACCEPTED',
        `Owner claim terms and privacy accepted for claim ${claimCode} on item ${itemId} (Phone: ${ownerPhone})`
      );

      let warning: string | null = null;
      if (strikeCount === 1 || strikeCount === 2) {
        warning = "Kumbuka: Uliwahi kuthibitisha kuwa bidhaa ni yako physically lakini hukulipia. Uthibitishaji unaorudiwa bila malipo unaweza kuzuia akaunti yako. / Note: you previously confirmed an item was yours in person but did not complete payment. Repeated occurrences may restrict your access to Return4me.";
      }

      res.json({
        success: true,
        claim: toOwnerSafeClaimView(claim),
        warning,
        message: isTier3
          ? 'Thibitisho la Tier 1 na Tier 3 limepita! Tafadhali thibitisha OTP yako ili uendelee kwenye malipo.'
          : (item.is_sensitive_document !== false 
            ? 'Thibitisho la utambulisho (Tier 1) limepita! Tafadhali thibitisha OTP ili uendelee kwenye malipo.'
            : 'Ombi lako limepokelewa! Tafadhali thibitisha OTP yako ili uendelee kwenye malipo.'),
      });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });
  // 6b. Tier 2: CLAIM SPECIFIC OTP DISPATCH & VERIFICATION
  app.post('/api/claims/:id/request-otp', otpGlobalLimiter, otpIpLimiter, otpClaimLimiter, smsRateLimit(), async (req, res) => {
    const claimId = req.params.id;
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Nambari ya simu inahitajika. / Phone number is required.' });
    }

    try {
      const claim = await db.getClaim(claimId);
      if (!claim) {
        // One response for BOTH ownership failures (Phase 16.1 Batch 2A) — see
        // the constant's own comment in config/claimStatuses.ts.
        return res.status(404).json({ error: CLAIM_UNAVAILABLE_MESSAGE });
      }

      // P0: claim ID alone (a guessable, ~900k-combination numeric space)
      // used to be sufficient to trigger an OTP SMS to this claim's real
      // owner_phone — no proof the caller was that owner at all. Now
      // requires the same phone-match standard already used by /lookup,
      // /pay, and /payment-auth elsewhere in this file.
      //
      // PHASE 16.1 Batch 2A — the failure response is now the SAME status and
      // the SAME body as the unknown-claim branch above. Previously an
      // anonymous caller learned whether a guessed claim ID existed (404) and,
      // for one that did, whether a guessed phone was its registered owner
      // phone (403 with different wording) — the exact oracle Phase 7C.7 (R2)
      // removed from /lookup and F4 removed from /pickup-details.
      const normalizedInput = toE164Kenyan(String(phone).replace(/\s+/g, ''));
      const normalizedOwner = toE164Kenyan(String(claim.owner_phone || '').replace(/\s+/g, ''));
      if (normalizedInput !== normalizedOwner) {
        return res.status(404).json({ error: CLAIM_UNAVAILABLE_MESSAGE });
      }

      // SC-1 (companion guard): an OTP is only meaningful for a claim still
      // awaiting its first verification. Without this, the route would happily
      // send a real SMS to the owner of an already-paid/handed-over/refunded
      // claim and set up exactly the backward transition the verify-otp guard
      // above now refuses. Returns 409 (a state conflict, not a bad request).
      //
      // ORDER IS A SECURITY PROPERTY (same rule as /pickup-details, F9): the
      // state gate runs only AFTER ownership has been proven above. If it ran
      // first, a caller with a wrong phone could still tell which state a real
      // claim is in — a status oracle for a non-owner.
      if (claim.status !== 'pending_verification') {
        return res.status(409).json({
          error: 'Claim hii imeshapitia uthibitisho. Hakuna OTP mpya inayohitajika. / This claim has already passed verification. No new OTP is required.',
        });
      }

      // Generate secure 4-digit code using Node crypto
      const code = crypto.randomInt(1000, 10000).toString();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // valid for 5 mins
      await db.setClaimOtp(claimId, hashCode(code), expiresAt);

      // BUGFIX: this used to only console.log the raw OTP code and the
      // owner's full phone number — unconditionally, even in production —
      // and never actually sent an SMS at all. A real owner in production
      // would never have received this code on their phone. Now routed
      // through the same gateway phone-verification OTP uses; the raw
      // code is only ever printed to the console in dev/sandbox
      // simulation mode (no real Africa's Talking credentials configured),
      // clearly labeled as such — see sendCodeViaSms in services/auth.ts.
      // N7: delivery now goes through the notification boundary, so this route gains
      // a durable notification record and N5/N6 idempotency. Code generation, the
      // 5-minute expiry, the claim-OTP store key and the persist-then-send ordering
      // above are unchanged; the result is mapped back onto the exact pre-N7
      // response shape, including the 503 + provider retry message below.
      const smsResult = await sendClaimVerificationSms({
        recipient: claim.owner_phone,
        code,
      });
      if (!smsResult.success) {
        // P1 (B-4). A provider-side SMS rejection is a TEMPORARY, RETRYABLE
        // condition, not an internal server fault. 500 told the user (and any
        // monitoring) that our application broke, which is both false and
        // discourages a retry that would very likely now succeed. 503 with the
        // provider's own (already-sanitised) Swahili/English retry message is
        // the honest signal. The message never contains provider credentials or
        // raw provider detail — it is composed by sendCodeViaSms.
        return res.status(503).json({ error: smsResult.message });
      }

      res.json({
        success: true,
        message: smsResult.message,
      });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });
  app.post('/api/claims/:id/verify-otp', otpVerifyLimiter, async (req, res) => {
    const claimId = req.params.id;
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ error: 'Msimbo wa OTP unahitajika.' });
    }

    try {
      const claim = await db.getClaim(claimId);
      if (!claim) {
        return res.status(404).json({ error: 'Claim haikupatikana.' });
      }

      const record = await db.getClaimOtp(claimId);
      if (!record) {
        return res.status(400).json({ error: 'Hakuna OTP iliyoombwa kwa claim hii au muda wake umeisha.' });
      }

      if (record.expires_at.getTime() < Date.now()) {
        await db.deleteClaimOtp(claimId);
        return res.status(400).json({ error: 'Muda wa OTP umeisha. Tafadhali omba msimbo mpya.' });
      }

      const isMockBypass = (
        process.env.NODE_ENV !== 'production' &&
        process.env.ALLOW_MOCK_OTP_BYPASS === 'true' &&
        (code === '1234' || code === '4114')
      );
      const codeMatches = timingSafeEqualHex(hashCode(code), record.code_hash);
      if (!codeMatches && !isMockBypass) {
        const attempts = await db.incrementClaimOtpAttempts(claimId);
        if (attempts >= 5) {
          await db.deleteClaimOtp(claimId);
          return res.status(400).json({ error: 'Umekosea msimbo wa OTP mara 5. OTP hii imefutwa kwa usalama wako. Tafadhali omba msimbo mpya. / You have entered the wrong OTP 5 times. For your security, this OTP has been invalidated. Please request a new code.' });
        }
        return res.status(400).json({ error: `Msimbo wa OTP si sahihi. Una fursa ${5 - attempts} zilizobaki. / Incorrect OTP code. You have ${5 - attempts} attempts remaining.` });
      }

      // SC-1 — LIFECYCLE GUARD. This route used to write
      // 'awaiting_agent_confirmation' from ANY source state, which meant a
      // claim that had already progressed (escrow_held, pending_settlement,
      // releasing, released, refunding, refunded, rejected) could be pushed
      // BACKWARD by a fresh OTP verification. Only 'pending_verification' is a
      // legal source, and the check runs BEFORE the OTP is consumed so a
      // refused attempt does not destroy the caller's still-valid code.
      if (claim.status !== 'pending_verification') {
        return res.status(409).json({
          error: 'Claim hii haiwezi kuthibitishwa kwa OTP katika hali yake ya sasa. / This claim cannot be OTP-verified from its current state.',
        });
      }

      // The transition is expressed through the central contract so the
      // allowed-edge table, the expected-state CAS and the audit write are all
      // enforced in one place.
      const otpTransition = await db.transitionClaimStatus({
        claimId,
        expected: ['pending_verification'],
        to: 'awaiting_agent_confirmation',
        actor: claim.owner_phone || 'CLAIMANT',
        action: 'CLAIM_OTP_VERIFIED',
        details: `Claim ${claimId} OTP verified; awaiting in-person agent confirmation.`,
      });
      if (!otpTransition.ok) {
        // NOT_FOUND cannot happen (the claim was read above) but is mapped for
        // completeness; STATE_CONFLICT means another request moved the claim
        // first — a 409, never a 500. The OTP is still NOT consumed here.
        return res.status(otpTransition.code === 'NOT_FOUND' ? 404 : 409).json({
          error: 'Claim hii imeshabadilika hivi punde. Tafadhali pakia upya. / This claim changed moments ago. Please reload.',
        });
      }

      // Single-use: consume the challenge only AFTER the transition committed.
      await db.deleteClaimOtp(claimId);

      // F11 (Phase 7C.3) — IDENTITY CONTINUITY. Everything above is the
      // authoritative, already-committed verification and must NOT depend on
      // anything below. The claim journey has always been valid for anonymous
      // visitors (the claim OTP is sent to the claim's own registered phone),
      // so the customer-account link is strictly ADDITIVE and is attempted
      // only once the OTP is spent:
      //
      //   * no / invalid / expired / revoked session  -> anonymous, linked:false
      //   * customer's normalised phone != claim phone -> no link, linked:false
      //   * matching phone -> the EXISTING link primitive is used, linked:true
      //
      // It runs AFTER the transition + OTP consumption by design, so it can
      // never weaken the claim's own proof standard, and it is wrapped so that
      // a linkage failure cannot turn a successful verification into a 500.
      let journeyLinked = false;
      try {
        const journeyCustomer = await resolveOptionalCustomer(req);
        if (journeyCustomer) {
          const journeyLink = await linkVerifiedClaimToCustomer(journeyCustomer, claim);
          journeyLinked = journeyLink.linked;
        }
      } catch (e: any) {
        console.error('[CUSTOMER_CLAIM_JOURNEY_LINK_ERROR]', e);
        journeyLinked = false;
      }

      // BATCH 3 / P1 - customer notification, AFTER the journey link above.
      //
      // ORDERING IS LOAD-BEARING. The customer/claim link is created at the very
      // END of the verify-otp flow, strictly after the transition and OTP
      // consumption, so a producer placed next to the transition would resolve
      // no customer and write nothing. Running it here means the customer the
      // link was just created for actually receives the notice.
      //
      // Fail-closed by design: an anonymous claimant has no link, so no
      // notification is written. The transition above is already committed and is
      // unaffected either way - the producer cannot throw, and cannot roll back.
      await produceClaimVerificationAccepted(claimId);


      res.json({
        success: true,
        message: 'Msimbo umethibitishwa kikamilifu! Tafadhali nenda kwa wakala physically ili athibitishe kuwa bidhaa hii ni yako kabla ya kulipa. / Verification code approved! Please visit the agent physically to verify the item belongs to you before initiating payment.',
        linked: journeyLinked,
      });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });
}
