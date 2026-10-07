// Claim PAYMENT and status routes extracted from server.ts (P2-A3.2).
//
// WHY A SEPARATE MODULE. server.ts boots the HTTP listener at import time, so a
// test cannot import it without booting Vite middleware, background sweeps and
// listeners. Extracting these handlers into a registration function lets an
// HTTP integration test mount the REAL handlers around the REAL middleware
// (same pattern as routes/claims.ts, routes/customerClaims.ts,
// routes/publicItems.ts).
//
// THIS IS A MOVE, NOT A REWRITE. Every handler body below was relocated
// verbatim from server.ts. Nothing was refactored, consolidated, renamed or
// "improved". The financial behaviour, P1 security controls, timing-safe
// comparisons, session binding, state guards, limiters, status codes and
// response bodies are byte-identical to their inline originals.
//
// WHAT WAS INJECTED RATHER THAN MOVED. canCreateClaim,
// claimabilityErrorMessage, checkClaimExpiry, isPlatformOperationPaused,
// sendServerError, pauseSettingKey and the three limiters all still have live
// callers inside server.ts (the IntaSend webhook and the six agent routes), so
// moving them would have split one implementation in two. They are injected,
// exactly as routes/claims.ts already does, so both sides share ONE definition.
//
// WHAT WAS MOVED. toSafePaymentSession and resolveAuthoritativePaymentFee were
// used ONLY by these eight handlers, so moving them keeps the public DTO shape
// and the server-authoritative fee rule in exactly one place. Moving them
// cannot orphan anything: both have zero callers outside this module.
import crypto from 'crypto';
import { db } from '../db/database.ts';
import { requireCustomerAuth } from '../services/customerAuth.ts';
import { hashCode, timingSafeEqualHex, toE164Kenyan } from '../services/auth.ts';
import { PaymentService } from '../services/payments.ts';
import { isPickupEligibleClaimStatus, CLAIM_UNAVAILABLE_MESSAGE } from '../config/claimStatuses.ts';
import { PAYMENT_SESSION_WINDOW_MS } from '../config/paymentWindows.ts';
import { toOwnerSafeAgentView, toOwnerSafeItemView, toOwnerSafeClaimView } from '../services/ownerSafeViews.ts';


export function registerClaimPaymentRoutes(
  app: any,
  deps: {
    sendServerError: (res: any, error: any, context: string) => void;
    canCreateClaim: (item: any) => any;
    claimabilityErrorMessage: (reason: string) => string;
    checkClaimExpiry: (claim: any) => Promise<any>;
    isPlatformOperationPaused: (key: string) => Promise<boolean>;
    pauseSettingKey: (scope: string) => string;
    PAUSED_MESSAGES: Record<string, string>;
    claimGuessLimiter: any;
    paymentSessionStatusLimiter: any;
    claimStatusPollLimiter: any;
    /**
     * The ONE canonical financial-confirmation path (server.ts). Injected so the
     * payment-session status route can perform on-demand provider reconciliation
     * for a missed webhook WITHOUT inventing a second confirmation implementation.
     * Returns a pickup code on an actual confirmation, or null otherwise.
     */
    processClaimPaymentConfirmed: (
      claimId: string,
      invoiceId: string,
      confirmedAmount?: number | string | null
    ) => Promise<string | null>;
  }
) {
  const {
    sendServerError,
    canCreateClaim,
    claimabilityErrorMessage,
    checkClaimExpiry,
    isPlatformOperationPaused,
    pauseSettingKey,
    PAUSED_MESSAGES,
    claimGuessLimiter,
    paymentSessionStatusLimiter,
    claimStatusPollLimiter,
    processClaimPaymentConfirmed,
  } = deps;

  // Per-session throttle for ON-DEMAND provider reconciliation (see the session
  // status route). The route is polled every 3 seconds by the claimant's
  // browser, so without this a single open tab could hammer IntaSend. The
  // background sweep is the durable backstop; this only makes the on-demand
  // path responsive for a missed webhook.
  const SESSION_RECONCILE_MIN_INTERVAL_MS = 15 * 1000;
  const lastSessionReconcileAttempt = new Map<string, number>();

  function toSafePaymentSession(session: any): any {
    if (!session) return null;
    return {
      id: session.id,
      claim_id: session.claim_id,
      amount: session.amount,
      currency: session.currency,
      method: session.method,
      status: session.status,
      payer_phone: session.payer_phone,
      created_at: session.created_at ? new Date(session.created_at).toISOString() : null,
      expires_at: session.expires_at ? new Date(session.expires_at).toISOString() : null,
      confirmed_at: session.confirmed_at ? new Date(session.confirmed_at).toISOString() : null,
    };
  }

  // Resolves the authoritative amount owed for a claim's payment, using exactly
  // the same rule /pay uses: the item's locked_total_fee when present and valid,
  // otherwise the category's total_fee. The payer/browser never supplies this.
  function resolveAuthoritativePaymentFee(item: any, category: any): number {
    let fee = Number(category ? category.total_fee : 0);
    if (Number.isNaN(fee)) fee = 0;
    if (item && item.locked_total_fee !== undefined && item.locked_total_fee !== null) {
      const lockedVal = typeof item.locked_total_fee === 'string' ? parseFloat(item.locked_total_fee) : Number(item.locked_total_fee);
      if (!Number.isNaN(lockedVal) && lockedVal > 0) fee = lockedVal;
    }
    return fee;
  }

    app.post('/api/claims/:id/payment-auth', claimGuessLimiter, async (req, res) => {
      const claimId = req.params.id;
      const { phone } = req.body;
      if (!phone) {
        return res.status(400).json({ error: 'Nambari ya simu inahitajika. / Phone number is required.' });
      }

      try {
        const claim = await db.getClaim(claimId);
        if (!claim) {
          return res.status(404).json({ error: CLAIM_UNAVAILABLE_MESSAGE });
        }

        // ORDER IS A SECURITY PROPERTY (Phase 16.1 Batch 2A). Ownership is proven
        // BEFORE the claim's state is consulted, and both ownership failures share
        // ONE status and ONE body. Previously the status gate ran first and the
        // phone mismatch answered 403 with different wording, so a caller with a
        // wrong phone could still separate "no such claim" from "a real claim in
        // pending_payment", and could confirm whether a guessed number was the
        // registered owner phone. That is the F4/F9 rule /pickup-details already
        // applies; this route now applies it too.
        const normalizedInput = toE164Kenyan(String(phone).replace(/\s+/g, ''));
        const normalizedOwner = toE164Kenyan(String(claim.owner_phone || '').replace(/\s+/g, ''));
        if (normalizedInput !== normalizedOwner) {
          return res.status(404).json({ error: CLAIM_UNAVAILABLE_MESSAGE });
        }

        // Ownership is proven. Only NOW may claim state be consulted.
        if (claim.status !== 'pending_payment') {
          return res.status(400).json({
            error: 'Lazima kwanza uthibitishwe na wakala kabla ya kuomba idhini ya malipo. / You must be confirmed by the agent in person before requesting payment authorization.'
          });
        }

        const paymentAuthToken = crypto.randomBytes(32).toString('hex');
        const paymentAuthExpiresAt = new Date(Date.now() + 20 * 60 * 1000);
        await db.setClaimPaymentAuthToken(claimId, hashCode(paymentAuthToken), paymentAuthExpiresAt);

        res.json({ success: true, paymentAuthToken, expiresAt: paymentAuthExpiresAt.toISOString() });
      } catch (e: any) {
        sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
      }
    });

    app.post('/api/claims/:id/payment-session', claimGuessLimiter, async (req, res) => {
      const claimId = req.params.id;
      const { phone, payerPhone } = req.body;

      if (await isPlatformOperationPaused(pauseSettingKey('payments'))) {
        return res.status(503).json({ error: PAUSED_MESSAGES.payments });
      }

      try {
        if (!phone) {
          return res.status(400).json({ error: 'Nambari ya simu inahitajika. / Phone number is required.' });
        }

        const claim = await db.getClaim(claimId);
        if (!claim) {
          return res.status(404).json({ error: CLAIM_UNAVAILABLE_MESSAGE });
        }

        // Ownership proof (unchanged security bar): you must know the claim's
        // registered owner phone to open a session for it. This is NOT the rule
        // for the payer M-Pesa number — see payerPhone below.
        //
        // ORDER IS A SECURITY PROPERTY (Phase 16.1 Batch 2A): the required-field
        // guard runs BEFORE any database read, ownership is proven BEFORE the
        // claim's state is consulted, and both ownership failures share ONE
        // status + ONE body — so a caller who guesses a claim ID learns nothing
        // about whether it exists, nor whether a guessed number is its owner.
        const normalizedInput = toE164Kenyan(String(phone).replace(/\s+/g, ''));
        const normalizedOwner = toE164Kenyan(String(claim.owner_phone || '').replace(/\s+/g, ''));
        if (normalizedInput !== normalizedOwner) {
          return res.status(404).json({ error: CLAIM_UNAVAILABLE_MESSAGE });
        }

        // Ownership is proven. Only NOW may claim state be consulted.
        if (claim.status !== 'pending_payment') {
          return res.status(400).json({ error: 'Lazima kwanza uthibitishwe na wakala kabla ya kulipa. / You must be confirmed by the agent in person before you can pay.' });
        }
        const freshClaim = await checkClaimExpiry(claim);
        if (!freshClaim || freshClaim.status !== 'pending_payment') {
          return res.status(410).json({ error: 'Muda wa malipo umeisha. / The payment window has expired.' });
        }

        // Payer M-Pesa number — may differ from owner_phone. Must be a valid
        // Kenyan number when supplied; defaults to owner_phone when omitted.
        let normalizedPayer = normalizedOwner;
        if (payerPhone !== undefined && payerPhone !== null && String(payerPhone).trim() !== '') {
          const candidate = toE164Kenyan(String(payerPhone).replace(/\s+/g, ''));
          if (!/^\+254\d{9}$/.test(candidate)) {
            return res.status(400).json({ error: 'Nambari ya simu ya M-Pesa sio sahihi. / Enter a valid Kenyan M-Pesa number.' });
          }
          normalizedPayer = candidate;
        }

        const item = await db.getItem(claim.item_id);
        if (!item) {
          return res.status(404).json({ error: 'Bidhaa inayodaiwa haikupatikana.' });
        }
        const claimability = await canCreateClaim(item);
        if (!claimability.allowed) {
          return res.status(423).json({ error: claimabilityErrorMessage(claimability.reason) });
        }
        const category = await db.getCategory(item.category_id);
        if (!category) {
          return res.status(404).json({ error: 'Ada ya kategoria haikupatikana.' });
        }

        // Authoritative server-side amount — never taken from the client.
        const resolvedFee = resolveAuthoritativePaymentFee(item, category);

        // Reuse an existing active (non-terminal AND not-yet-expired) session for
        // this claim so a refresh or tab-reopen never spawns duplicate concurrent
        // sessions. A session whose short STK window has elapsed is NOT reusable:
        // it is expired here (an authoritative server-side transition) and a FRESH
        // session is created below, while the CLAIM stays in pending_payment for
        // the whole 24-hour claim window.
        const nowMs = Date.now();
        const activeSession = (await db.listPaymentSessionsForClaim(claimId))
          .find((s: any) => !['confirmed', 'failed', 'cancelled', 'expired'].includes(s.status));
        if (activeSession && new Date(activeSession.expires_at).getTime() >= nowMs) {
          return res.json({ success: true, paymentSession: toSafePaymentSession(activeSession), reused: true });
        }
        if (activeSession) {
          // Stale attempt: expire it so it can never be re-initiated or reused,
          // then fall through and create a fresh session.
          await db.expirePaymentSession(activeSession.id);
        }

        // The individual STK attempt gets its OWN short window — deliberately NOT
        // tied to agent_confirmed_at, so a claimant who returns hours later can
        // still open a new attempt while the claim window remains open.
        const expiresAt = new Date(nowMs + PAYMENT_SESSION_WINDOW_MS);
        const sessionId = 'PS-' + crypto.randomBytes(8).toString('hex').toUpperCase();
        const created = await db.createPaymentSession({
          id: sessionId,
          claimId,
          amount: resolvedFee,
          currency: 'KES',
          payerPhone: normalizedPayer,
          method: 'mpesa_stk',
          expiresAt,
        });
        if (!created) {
          return res.status(500).json({ error: 'Kushindwa kuunda session ya malipo. / Failed to create the payment session.' });
        }

        const session = await db.getPaymentSessionById(sessionId);
        await db.logAudit('CLAIMANT', 'PAYMENT_SESSION_CREATED', `Payment session ${sessionId} created for claim ${claimId} (KES ${resolvedFee}).`);
        res.json({ success: true, paymentSession: toSafePaymentSession(session), reused: false });
      } catch (e: any) {
        sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
      }
    });

    app.post('/api/claims/:id/payment-session/:sessionId/initiate', claimGuessLimiter, async (req, res) => {
      const claimId = req.params.id;
      const sessionId = req.params.sessionId;
      const { paymentAuthToken } = req.body;

      if (await isPlatformOperationPaused(pauseSettingKey('payments'))) {
        return res.status(503).json({ error: PAUSED_MESSAGES.payments });
      }

      try {
        // Authorization to spend: present a valid, unexpired ownership token.
        //
        // PHASE 16.1 Batch 2A — ORDER IS A SECURITY PROPERTY. The token is the
        // ownership proof for this route, so it is validated BEFORE the claim is
        // even read: an unknown claim ID and an invalid token now produce the
        // SAME 403 (getClaimPaymentAuthToken returns null for both), and the
        // claim's state is only consulted once ownership is proven. Previously a
        // caller with no token at all could still tell "no such claim" from a
        // real claim in pending_payment / an expired payment window.
        if (!paymentAuthToken) {
          return res.status(403).json({ error: 'Idhini ya malipo imekosekana. Tafadhali omba idhini mpya kabla ya kulipa. / Payment authorization is missing. Please request authorization before paying.' });
        }
        const authRecord = await db.getClaimPaymentAuthToken(claimId);
        if (!authRecord || authRecord.expires_at.getTime() < Date.now() || !timingSafeEqualHex(hashCode(String(paymentAuthToken)), authRecord.token_hash)) {
          return res.status(403).json({ error: 'Idhini ya malipo si sahihi au imeisha muda. Tafadhali omba idhini mpya. / Payment authorization is invalid or has expired. Please request a new authorization.' });
        }

        const claim = await db.getClaim(claimId);
        if (!claim) {
          return res.status(404).json({ error: 'Claim haikupatikana.' });
        }

        // Ownership is proven. Only NOW may claim state be consulted.
        if (claim.status !== 'pending_payment') {
          return res.status(400).json({ error: 'Lazima kwanza uthibitishwe na wakala kabla ya kulipa. / You must be confirmed by the agent in person before you can pay.' });
        }
        const freshClaim = await checkClaimExpiry(claim);
        if (!freshClaim || freshClaim.status !== 'pending_payment') {
          return res.status(410).json({ error: 'Muda wa malipo umeisha. / The payment window has expired.' });
        }

        const session = await db.getPaymentSessionById(sessionId);
        if (!session) {
          return res.status(404).json({ error: 'Session ya malipo haikupatikana. / Payment session not found.' });
        }
        // A payment session is bound to exactly ONE claim. Refuse any attempt to
        // use a session opened for a different claim.
        if (session.claim_id !== claimId) {
          return res.status(403).json({ error: 'Session ya malipo haihusiani na claim hii. / This payment session does not belong to this claim.' });
        }
        if (['confirmed', 'failed', 'cancelled', 'expired'].includes(session.status)) {
          return res.status(409).json({ error: 'Session ya malipo haitumiki tena. / This payment session is no longer usable.' });
        }
        if (new Date(session.expires_at).getTime() < Date.now()) {
          await db.expirePaymentSession(sessionId);
          return res.status(410).json({ error: 'Muda wa session ya malipo umeisha. / The payment session has expired.' });
        }

        const item = await db.getItem(claim.item_id);
        if (!item) {
          return res.status(404).json({ error: 'Bidhaa inayodaiwa haikupatikana.' });
        }
        const claimability = await canCreateClaim(item);
        if (!claimability.allowed) {
          return res.status(423).json({ error: claimabilityErrorMessage(claimability.reason) });
        }

        // Concurrency-safe: only the caller that wins the created -> payment_initiated
        // CAS may issue the provider STK push. A repeated/double request loses and
        // is told so (it does NOT trigger a second push).
        const reserved = await db.reservePaymentSession(sessionId);
        if (!reserved) {
          const current = await db.getPaymentSessionById(sessionId);
          const stillActive = current && ['created', 'payment_initiated', 'pending'].includes(current.status)
            && new Date(current.expires_at).getTime() >= Date.now();
          if (stillActive) {
            return res.json({ success: true, paymentSession: toSafePaymentSession(current), alreadyInitiated: true });
          }
          return res.status(409).json({ error: 'Session ya malipo haikuweza kuanzishwa. / The payment session could not be initiated.' });
        }

        // Authoritative amount and payer phone come from the session, never the body.
        const paymentResult = await PaymentService.triggerMpesaStkPush(
          session.payer_phone || claim.owner_phone,
          session.amount,
          session.claim_id
        );
        if (!paymentResult.success) {
          await db.markPaymentSessionFailed(sessionId, paymentResult.message || 'STK initiation failed');
          return res.status(400).json({ error: paymentResult.message || 'Malipo hayakufaulu, jaribu tena.' });
        }

        await db.finalizePaymentSessionInitiated(sessionId, paymentResult.checkoutRequestId, paymentResult.mpesaReceiptCode);
        await db.logAudit('CLAIMANT', 'PAYMENT_SESSION_INITIATED', `M-Pesa STK push requested for session ${sessionId} (claim ${claimId}, KES ${session.amount}).`);

        const updated = await db.getPaymentSessionById(sessionId);
        res.json({ success: true, paymentSession: toSafePaymentSession(updated), alreadyInitiated: false });
      } catch (e: any) {
        sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
      }
    });

    app.get('/api/claims/:id/payment-session/:sessionId/status', paymentSessionStatusLimiter, async (req, res) => {
      const claimId = req.params.id;
      const sessionId = req.params.sessionId;
      try {
        let claim = await db.getClaim(claimId);
        if (!claim) {
          return res.status(404).json({ error: 'Claim haikupatikana.' });
        }
        claim = await checkClaimExpiry(claim);

        const session = await db.getPaymentSessionById(sessionId);
        if (!session) {
          return res.status(404).json({ error: 'Session ya malipo haikupatikana. / Payment session not found.' });
        }
        // Cross-claim isolation: this session is simply not visible under another
        // claim's URL.
        if (session.claim_id !== claimId) {
          return res.status(403).json({ error: 'Session ya malipo haihusiani na claim hii. / This payment session does not belong to this claim.' });
        }

        // ------------------------------------------------------------------
        // ON-DEMAND PROVIDER RECONCILIATION.
        //
        // A completed M-Pesa payment must not be lost merely because the webhook
        // was missed, delayed, or the browser was closed. When the session still
        // carries a provider invoice and the CLAIM is still awaiting payment —
        // OR has just been swept to 'payment_window_expired' (a late, but real,
        // provider approval the canonical path may still recover via its gated
        // predicate) — ask IntaSend for the authoritative status through the ONE
        // canonical
        // confirmation path — the same function the webhook uses. This can only
        // ever confirm a real, provider-verified, amount-reconciled payment; the
        // browser is never trusted to declare success. Throttled per session so
        // the 3-second poll cannot hammer the provider.
        // ------------------------------------------------------------------
        if (
          (claim.status === 'pending_payment' || claim.status === 'payment_window_expired')
          && session.provider_invoice_id
          && (session.status === 'pending' || session.status === 'expired')
        ) {
          const lastAttempt = lastSessionReconcileAttempt.get(sessionId) || 0;
          if (Date.now() - lastAttempt >= SESSION_RECONCILE_MIN_INTERVAL_MS) {
            lastSessionReconcileAttempt.set(sessionId, Date.now());
            try {
              await processClaimPaymentConfirmed(claimId, session.provider_invoice_id);
            } catch (reconcileErr: any) {
              console.error(`[PAYMENT SESSION STATUS] On-demand reconciliation failed for session ${sessionId}:`, reconcileErr);
            }
            // Re-read the authoritative state after the attempt.
            const refreshedClaim = await db.getClaim(claimId);
            if (refreshedClaim) claim = refreshedClaim;
            const refreshedSession = await db.getPaymentSessionById(sessionId);
            if (refreshedSession) {
              session.status = refreshedSession.status;
              session.confirmed_at = refreshedSession.confirmed_at;
              session.provider_reference = refreshedSession.provider_reference;
            }
          }
        }

        // Authoritative server-side session expiry: a session past its window that
        // is not yet terminal is expired here (not by a browser countdown).
        if (!['confirmed', 'failed', 'cancelled', 'expired'].includes(session.status)
          && new Date(session.expires_at).getTime() < Date.now()) {
          await db.expirePaymentSession(sessionId);
          session.status = 'expired';
        }

        res.json({
          success: true,
          claim: { id: claim.id, status: claim.status },
          paymentSession: toSafePaymentSession(session),
        });
      } catch (e: any) {
        sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
      }
    });

    app.post('/api/claims/:id/pay', claimGuessLimiter, async (req, res) => {
      const claimId = req.params.id;
      const { phone, paymentAuthToken } = req.body;

      if (await isPlatformOperationPaused(pauseSettingKey('payments'))) {
        return res.status(503).json({ error: PAUSED_MESSAGES.payments });
      }

      try {
        // SECURITY: this route is deliberately unauthenticated (owners aren't
        // logged in at payment time — see claimGuessRateLimit.test.ts). It used to
        // accept a bare claim ID as sufficient — `phone` was only checked if the
        // caller bothered to send it, so omitting it entirely let anyone who
        // found/guessed a claim ID trigger an M-Pesa STK push against the claim's
        // real owner_phone with zero proof of ownership. BOTH are now required and
        // checked: `phone` must resolve (E.164-normalized) to the claim's own
        // owner_phone, exactly as /lookup already requires, AND the caller must
        // present a valid, unexpired paymentAuthToken minted by
        // POST /api/claims/:id/payment-auth (which itself required that same phone
        // match to issue). Knowing the claim ID, or the phone number, is no longer
        // individually or jointly sufficient without also holding a token that
        // expires in 20 minutes and was minted for this specific payment attempt.
        //
        // PHASE 16.1 Batch 2A — ORDER IS A SECURITY PROPERTY. The required-field
        // guard runs BEFORE any database read, ownership is proven BEFORE the
        // claim's state is consulted, and both ownership failures share ONE status
        // + ONE body (CLAIM_UNAVAILABLE_MESSAGE). Previously a caller with a wrong
        // phone could still distinguish "no such claim" (404) from "a real claim
        // in pending_payment" (400) — a claim-existence and owner-phone oracle on
        // a ~900,000-combination claim-ID space. This is the same F4/F9 rule
        // /pickup-details already applies.
        if (!phone) {
          return res.status(400).json({
            error: 'Nambari ya simu inahitajika. / Phone number is required.'
          });
        }
        const claim = await db.getClaim(claimId);
        if (!claim) {
          return res.status(404).json({ error: CLAIM_UNAVAILABLE_MESSAGE });
        }
        const normalizedInput = toE164Kenyan(String(phone).replace(/\s+/g, ''));
        const normalizedOwner = toE164Kenyan(String(claim.owner_phone || '').replace(/\s+/g, ''));
        if (normalizedInput !== normalizedOwner) {
          return res.status(404).json({ error: CLAIM_UNAVAILABLE_MESSAGE });
        }

        if (!paymentAuthToken) {
          return res.status(403).json({
            error: 'Idhini ya malipo imekosekana. Tafadhali omba idhini mpya kabla ya kulipa. / Payment authorization is missing. Please request authorization before paying.'
          });
        }
        const authRecord = await db.getClaimPaymentAuthToken(claimId);
        if (!authRecord || authRecord.expires_at.getTime() < Date.now() || !timingSafeEqualHex(hashCode(String(paymentAuthToken)), authRecord.token_hash)) {
          return res.status(403).json({
            error: 'Idhini ya malipo si sahihi au imeisha muda. Tafadhali omba idhini mpya. / Payment authorization is invalid or has expired. Please request a new authorization.'
          });
        }

        // Ownership is proven (phone match + live authorization token). Only NOW
        // may claim state be consulted.
        if (claim.status !== 'pending_payment') {
          return res.status(400).json({
            error: "Lazima kwanza uthibitishwe na wakala kabla ya kulipa. / You must be confirmed by the agent in person before you can pay."
          });
        }

        const item = await db.getItem(claim.item_id);
        if (!item) {
          return res.status(404).json({ error: 'Bidhaa inayodaiwa haikupatikana.' });
        }

        // Central claimability rule, re-checked here as defense in depth: an
        // item's state can change between claim creation and payment (e.g.
        // flagged stolen/legal-hold, or a dispute opened by a competing
        // claimant) — never let money move on an item that's no longer
        // currently claimable, even if this specific claim slipped past the
        // earlier check at submission time.
        const claimability = await canCreateClaim(item);
        if (!claimability.allowed) {
          return res.status(423).json({ error: claimabilityErrorMessage(claimability.reason) });
        }

        const category = await db.getCategory(item.category_id);
        if (!category) {
          return res.status(404).json({ error: 'Ada ya kategoria haikupatikana.' });
        }

        // Authoritative server-side amount — never taken from the client, and
        // resolved by the SAME helper the payment-session route uses:
        // item.locked_total_fee when present and valid (> 0), else
        // category.total_fee. Sharing one implementation keeps the two
        // claimant-facing money routes from drifting apart.
        const resolvedFee = resolveAuthoritativePaymentFee(item, category);

        // Trigger IntaSend M-Pesa STK Push
        const paymentResult = await PaymentService.triggerMpesaStkPush(phone || claim.owner_phone, resolvedFee, claimId);

        if (!paymentResult.success) {
          return res.status(400).json({ error: paymentResult.message || 'Malipo hayakufaulu, jaribu tena.' });
        }

        // STK push initiated — claim remains in 'pending_payment' while we wait for
        // the IntaSend/M-Pesa webhook to confirm success and move it to 'escrow_held'.
        //
        // SC-4/SC-6 FIX: this call used to pass paymentResult.checkoutRequestId as
        // the `paymentRef` argument, which wrote the provider's CHECKOUT REQUEST
        // ID into claims.payment_reference at INITIATION — i.e. before any money
        // existed. Because resolveDispute() used `!!payment_reference` as "this
        // claimant actually paid", merely STARTING an STK push was enough to
        // create a refund obligation for money that was never received.
        //
        // The checkout request id is transient STK metadata with no claim-level
        // use (the authoritative receipt arrives on the webhook, and the
        // payment-session path already persists provider_reference on the
        // session), so it is deliberately not persisted here at all. The status
        // write is retained only to refresh updated_at; `paid_at` is untouched —
        // only attemptClaimEscrowHold()'s guarded CAS may ever set it.
        await db.updateClaimStatus(claimId, 'pending_payment');

        const updatedClaim = await db.getClaim(claimId);
        let agent = null;
        if (updatedClaim && (updatedClaim.status === 'escrow_held' || updatedClaim.status === 'released')) {
          agent = await db.getAgent(item.assigned_agent_id);
        }

        // SECURITY: same leak as /api/claims/:id/status above, and arguably
        // worse here — the phone-match check a few lines up only runs when
        // `phone` is actually provided in the body, so calling this route
        // with just a claim ID (no phone at all) is enough to reach this
        // point without proving ownership. Only the fields the frontend
        // (triggerEscrowPayment in OwnerView.tsx) actually consumes are
        // returned instead of the raw row.
        res.json({
          success: true,
          paymentResult,
          claim: updatedClaim ? {
            id: updatedClaim.id,
            status: updatedClaim.status,
            agent_confirmed_at: updatedClaim.agent_confirmed_at,
          } : null,
          agent: toOwnerSafeAgentView(agent),
          message: 'Malipo yameanzishwa kikamilifu! Tafadhali weka PIN ya M-Pesa kwenye simu yako ili kukamilisha.',
        });
      } catch (e: any) {
        sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
      }
    });

    app.post('/api/claims/lookup', requireCustomerAuth, claimGuessLimiter, async (req, res) => {
      const { claimId, phone } = req.body;
      if (!claimId || !phone) {
        return res.status(400).json({ error: 'Msimbo wa claim (Claim ID) na nambari ya simu zinahitajika.' });
      }

      try {
        const cleanClaimId = String(claimId).trim().toUpperCase();
        const cleanPhone = String(phone).replace(/\s+/g, '');
        const e164Phone = toE164Kenyan(cleanPhone);

        // ONE response object for both ownership failures below — a single shared
        // constant so the two branches can never drift apart again.
        const claimUnavailable = {
          error: 'Claim haikupatikana au nambari ya simu hailingani. / Claim not found, or the phone number does not match.'
        };

        const claim = await db.getClaim(cleanClaimId);
        if (!claim) {
          return res.status(404).json(claimUnavailable);
        }

        const claimPhoneClean = claim.owner_phone ? claim.owner_phone.replace(/\s+/g, '') : '';
        if (claimPhoneClean !== cleanPhone && claimPhoneClean !== e164Phone && toE164Kenyan(claimPhoneClean) !== e164Phone) {
          // Same status AND same body as the unknown-claim branch above.
          return res.status(404).json(claimUnavailable);
        }

        const item = await db.getItem(claim.item_id);
        let agent = null;
        if (item && item.assigned_agent_id) {
          agent = await db.getAgent(item.assigned_agent_id);
        }

        res.json({
          success: true,
          claim: toOwnerSafeClaimView(claim),
          item: toOwnerSafeItemView(item),
          // Phase 7C.7 (R1): the hub's operational contact phone, exact address and
          // GPS coordinates are only disclosed while the claim is still entitled to
          // active pickup instructions — the SAME canonical policy the
          // ownership-gated pickup-details route applies (config/claimStatuses.ts,
          // Phase 7C.5). Without this gate, a claim that /pickup-details refuses
          // (terminal, rejected, expired, refunded, disputed, or still
          // OTP-unverified) could obtain the identical agent DTO from here instead.
          //
          // The `agent` KEY is deliberately preserved (null, never removed) and the
          // claim status + masked item are untouched, so the Track/resume surface
          // keeps working and still shows claim/item/status information.
          agent: isPickupEligibleClaimStatus(claim.status) ? toOwnerSafeAgentView(agent) : null,
        });
      } catch (e: any) {
        sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
      }
    });

    app.post('/api/claims/:id/rate', requireCustomerAuth, claimGuessLimiter, async (req, res) => {
      const claimId = req.params.id;
      const { userRating } = req.body;

      try {
        const claim = await db.getClaim(claimId);
        if (!claim) {
          return res.status(404).json({ error: 'Claim haikupatikana.' });
        }

        const handoverHasOccurred = ['pending_settlement', 'releasing', 'released'].includes(claim.status);
        if (!handoverHasOccurred) {
          return res.status(400).json({ error: 'Huwezi kutoa ukadiriaji kabla ya bidhaa kukabidhiwa. / You can only rate after the item has actually been handed over.' });
        }

        const item = await db.getItem(claim.item_id);
        if (!item) {
          return res.status(404).json({ error: 'Bidhaa inayodaiwa haikupatikana.' });
        }

        if (!item.assigned_agent_id) {
          return res.status(400).json({ error: 'Hakuna hub/wakala aliyepangiwa bidhaa hii.' });
        }

        const wonRatingSlot = await db.markClaimRatedIfNotAlready(claimId);
        if (!wonRatingSlot) {
          return res.status(409).json({ error: 'Dai hili tayari limekadiriwa. / This claim has already been rated.' });
        }

        if (userRating) {
          const ratingVal = parseFloat(String(userRating));
          if (!isNaN(ratingVal) && ratingVal >= 1 && ratingVal <= 5) {
            await db.rateAgent(item.assigned_agent_id, ratingVal);
          }
        }

        res.json({ success: true, message: 'Ukadiriaji umewasilishwa kikamilifu! Ahsante.' });
      } catch (e: any) {
        sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
      }
    });

    app.get('/api/claims/:id/status', claimStatusPollLimiter, async (req, res) => {
      const claimId = req.params.id;
      try {
        let claim = await db.getClaim(claimId);
        if (!claim) {
          return res.status(404).json({ error: 'Claim haikupatikana.' });
        }
        claim = await checkClaimExpiry(claim);
        if (!claim) {
          return res.status(404).json({ error: 'Claim haikupatikana.' });
        }
        res.json({
          status: claim.status,
          claim: {
            id: claim.id,
            status: claim.status,
            agent_confirmed_at: claim.agent_confirmed_at,
          },
        });
      } catch (e: any) {
        sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
      }
    });
}
