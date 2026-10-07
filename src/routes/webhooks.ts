// P2-A3.3 - INTA SEND WEBHOOK ROUTE EXTRACTION.
//
// WHY THIS ROUTE IS ITS OWN MODULE
//
// The IntaSend collection callback is the most financially sensitive entry
// point in the product: it is the only thing that can move a claim into
// escrow_held, and it is the producer of the pickup code that physically
// releases an item to its owner. Extracting it is purely structural, so a test
// can mount the real route over a real Express app.
//
// ---------------------------------------------------------------------------
// PROVIDER CONTRACT (current IntaSend collection webhook)
// ---------------------------------------------------------------------------
// IntaSend collection events are authenticated with a shared CHALLENGE value
// that the merchant configures in the IntaSend dashboard and sends back in the
// payload, NOT with an HMAC signature header. The payload carries:
//
//   topic         : "collection_event"
//   challenge     : the configured shared secret (must equal ours)
//   invoice_id    : IntaSend invoice identity (used to bind the payment session)
//   state         : "COMPLETE" once the M-Pesa collection has settled
//   value         : the amount collected
//   api_ref       : the merchant/application reference (Return4me sets this to
//                   the CLAIM id, so it is how the event is reconciled to a claim)
//   provider_ref  : the provider/M-Pesa transaction reference
//
// The route therefore verifies the CHALLENGE (not a signature), requires a
// usable invoice_id and api_ref, only processes state === 'COMPLETE', ignores
// every other lifecycle event safely, and remains idempotent because the
// canonical confirmation path (processClaimPaymentConfirmed, injected) is a
// compare-and-swap on both the payment session and the claim. The webhook is
// NEVER trusted as the sole authority on money: the injected confirmation still
// reconciles the amount and can itself escalate to the authoritative provider
// status lookup.
//
// EVERYTHING FINANCIAL STAYS IN server.ts
//
// processClaimPaymentConfirmed - which owns the P1 amount reconciliation, the
// authoritative IntaSend status lookup, the claim CAS, the escrow transition
// and pickup-code issuance - is NOT moved and NOT duplicated. It is shared with
// the dev-only payment simulator still in server.ts, so it is INJECTED. There
// is exactly one implementation of every financial rule, and this module calls
// it. sendServerError is likewise injected so error disclosure stays identical
// to every other route in the application.
import crypto from 'crypto';
import { maskPhoneForLog } from '../services/auth';

/**
 * Timing-safe equality for two arbitrary (non-hex) secret strings.
 *
 * The challenge is an opaque merchant-configured value, so it is NOT a hex
 * digest and cannot go through timingSafeEqualHex. Both values are hashed to a
 * fixed 32 bytes first, which makes the buffers equal length (crypto.timingSafeEqual
 * requires that) and means a length difference cannot leak via early exit.
 */
function challengeMatches(provided: unknown, configured: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const b = crypto.createHash('sha256').update(configured, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

export function registerWebhookRoutes(
  app: any,
  deps: {
    /** The ONE payment-confirmation implementation. Never duplicated here. */
    processClaimPaymentConfirmed: (
      claimId: string,
      invoiceId: string,
      confirmedAmount?: number | string | null
    ) => Promise<string | null>;
    /** Shared error disclosure, identical to every other route. */
    sendServerError: (res: any, error: any, context: string) => any;
  }
) {
  const { processClaimPaymentConfirmed, sendServerError } = deps;

  // Webhook for IntaSend collection confirmation events
  app.post('/api/webhooks/intasend', async (req, res) => {
    const payload = req.body || {};

    // SECURITY/LOGGING: never log the raw payload. IntaSend collection
    // callbacks typically carry the payer's phone number (and sometimes
    // account/narrative fields), so log only the fields that are useful for
    // debugging a delivery, with the phone masked — the same
    // no-full-phone-numbers-in-logs rule this codebase follows everywhere else
    // (see maskPhoneForLog). The challenge itself is a secret and is NEVER
    // logged.
    const logSafePayload = {
      topic: payload.topic,
      invoice_id: payload.invoice_id,
      state: payload.state,
      api_ref: payload.api_ref,
      value: payload.value,
      provider_ref: payload.provider_ref,
      phone_number: maskPhoneForLog(payload.phone_number),
    };
    console.log('[INTASEND WEBHOOK] Received collection event:', JSON.stringify(logSafePayload, null, 2));

    // ---------------------------------------------------------------------
    // 1. CHALLENGE AUTHENTICATION.
    // ---------------------------------------------------------------------
    const configuredChallenge = process.env.INTASEND_WEBHOOK_CHALLENGE;
    if (process.env.NODE_ENV === 'production' && !configuredChallenge) {
      // A production deployment with no configured challenge cannot authenticate
      // anything, so it refuses rather than accepting unverified payment events.
      // boot() also refuses to start in this state — this is a second, local guard.
      console.warn('[INTASEND WEBHOOK] INTASEND_WEBHOOK_CHALLENGE is not configured in production. Refusing.');
      return res.status(401).json({ error: 'Webhook challenge is not configured' });
    }
    if (configuredChallenge) {
      if (!challengeMatches(payload.challenge, configuredChallenge)) {
        console.warn('[INTASEND WEBHOOK] Challenge verification failed.');
        return res.status(401).json({ error: 'Challenge verification failed' });
      }
      console.log('[INTASEND WEBHOOK] Challenge verified successfully.');
    }
    // When no challenge is configured we are in sandbox/development: the route
    // still requires the payload identity fields below and still runs the full
    // amount/provider reconciliation, so a dev event can drive the flow without
    // a real challenge — but it can never fabricate money in production.

    // ---------------------------------------------------------------------
    // 2. TOPIC. A non-collection lifecycle event is acknowledged and ignored.
    // ---------------------------------------------------------------------
    if (payload.topic && payload.topic !== 'collection_event') {
      console.log(`[INTASEND WEBHOOK] Ignoring non-collection topic "${payload.topic}".`);
      return res.json({ status: 'ignored' });
    }

    // ---------------------------------------------------------------------
    // 3. REQUIRED IDENTITY FIELDS.
    // ---------------------------------------------------------------------
    const { invoice_id, state, api_ref, value, amount } = payload;
    const claimId = api_ref;
    // Best-effort amount field: IntaSend's collection payload uses `value` (the
    // same field the authoritative status invoice uses); `amount` is kept as a
    // compatibility fallback. A missing/malformed amount does NOT block the
    // payment here — processClaimPaymentConfirmed escalates to the authoritative
    // provider status lookup rather than trusting this value.
    const webhookAmount = value ?? amount;

    if (!invoice_id || typeof invoice_id !== 'string') {
      console.warn('[INTASEND WEBHOOK] Missing invoice_id; cannot reconcile.');
      return res.status(400).json({ error: 'Missing invoice_id' });
    }
    if (!claimId || typeof claimId !== 'string') {
      console.warn('[INTASEND WEBHOOK] Missing api_ref; cannot reconcile to a claim.');
      return res.status(400).json({ error: 'Missing api_ref' });
    }

    // ---------------------------------------------------------------------
    // 4. SUCCESS STATE ONLY. Non-COMPLETE events are safe no-ops.
    // ---------------------------------------------------------------------
    if (state !== 'COMPLETE') {
      console.log(`[INTASEND WEBHOOK] Non-complete state "${state}"; no action.`);
      return res.json({ status: 'ignored' });
    }

    try {
      await processClaimPaymentConfirmed(claimId, invoice_id, webhookAmount);
    } catch (err: any) {
      console.error('[INTASEND WEBHOOK] Error handling claim payment webhook update:', err);
      return sendServerError(res, err, 'INTASEND_WEBHOOK_CLAIM_UPDATE_ERROR');
    }

    res.json({ status: 'ok' });
  });
}

