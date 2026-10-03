// P2-A3.3 - INTA SEND WEBHOOK ROUTE EXTRACTION.
//
// WHY THIS ROUTE IS ITS OWN MODULE
//
// The IntaSend collection callback is the most financially sensitive entry
// point in the product: it is the only thing that can move a claim into
// escrow_held, and it is the producer of the pickup code that physically
// releases an item to its owner. Extracting it is purely structural, so a test
// can mount the real route over a real Express app. No behaviour changes here.
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
//
// PRESERVED VERBATIM (and proven by the existing P1 tests):
//   - HMAC-SHA256 signature validation over the raw payload
//   - timingSafeEqualHex for BOTH the header and the embedded signature
//   - production 401 for a missing header, a bad signature, or a missing secret
//   - the masked minimal log payload (never the raw payload / full phone)
//   - the amount read (value ?? amount) and the COMPLETE/COMPLETED/SUCCESS gate
//   - the { status: 'ok' } acknowledgement
import crypto from 'crypto';
import { maskPhoneForLog, timingSafeEqualHex } from '../services/auth';

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

  // Webhook for IntaSend payment confirmation events
  app.post('/api/webhooks/intasend', async (req, res) => {
    const payload = req.body;
    const signatureHeader = req.headers['x-intasend-signature'] as string || req.headers['signature'] as string;
    const webhookSecret = process.env.INTASEND_WEBHOOK_SECRET;

    // SECURITY/LOGGING: this used to log the complete raw payload via
    // JSON.stringify(payload, null, 2) — IntaSend collection callbacks
    // typically carry the payer's phone number (and sometimes account/
    // narrative fields), so that line was writing an unmasked phone number
    // to production logs every single payment, in direct violation of the
    // no-full-phone-numbers-in-logs rule this codebase already follows
    // elsewhere (see maskPhoneForLog, used for the exact same purpose in
    // auth.ts and the sweep job below). Log only the fields actually
    // useful for debugging a webhook delivery, with the phone masked.
    const logSafePayload = {
      invoice_id: payload?.invoice_id,
      state: payload?.state,
      api_ref: payload?.api_ref,
      value: payload?.value,
      phone_number: maskPhoneForLog(payload?.phone_number),
    };
    console.log('[INTASEND WEBHOOK] Received callback event:', JSON.stringify(logSafePayload, null, 2));

    // Missing signature rejection in production
    if (!signatureHeader && !payload.signature) {
      console.warn('[INTASEND WEBHOOK] Missing signature header and signature field.');
      if (process.env.NODE_ENV === 'production') {
        return res.status(401).json({ error: 'Missing signature' });
      }
    }

    if (webhookSecret) {
      let isValid = false;

      // Method 1: Check signature header
      if (signatureHeader) {
        const computed = crypto.createHmac('sha256', webhookSecret).update(JSON.stringify(payload)).digest('hex');
        // BUGFIX: this used to compare with plain `===`, a variable-time
        // string comparison — inconsistent with the timing-safe comparison
        // this codebase already uses everywhere else a secret/HMAC value is
        // checked (OTP codes, pickup codes, the claim payment-auth token).
        // A `===` comparison on a hex digest leaks (in principle, via
        // response-timing statistics across many attempts) how many
        // leading characters an attacker's guess got right, incrementally
        // narrowing the search space for a value that's supposed to be
        // computationally infeasible to guess at all.
        if (timingSafeEqualHex(computed, signatureHeader)) {
          isValid = true;
        }
      }

      // Method 2: Check embedded signature
      if (!isValid && payload.signature) {
        const { signature, ...rest } = payload;
        const computed = crypto.createHmac('sha256', webhookSecret).update(JSON.stringify(rest)).digest('hex');
        if (typeof signature === 'string' && timingSafeEqualHex(computed, signature)) {
          isValid = true;
        }
      }

      if (!isValid) {
        console.warn('[INTASEND WEBHOOK] Webhook signature verification failed.');
        if (process.env.NODE_ENV === 'production') {
          return res.status(401).json({ error: 'Signature verification failed' });
        }
        console.warn('[INTASEND WEBHOOK] Continuing in sandbox/development mode.');
      } else {
        console.log('[INTASEND WEBHOOK] Signature verified successfully.');
      }
    } else if (process.env.NODE_ENV === 'production') {
      console.warn('[INTASEND WEBHOOK] Webhook secret is missing in production.');
      return res.status(401).json({ error: 'Webhook secret is missing' });
    }

    const { invoice_id, state, api_ref, value, amount } = payload;
    const claimId = api_ref;
    // Best-effort field-name guess — see the NOTE ON FIELD NAME comment on
    // processClaimPaymentConfirmed.
    const webhookAmount = value ?? amount;

    if (claimId && (state === 'COMPLETE' || state === 'COMPLETED' || state === 'SUCCESS')) {
      try {
        await processClaimPaymentConfirmed(claimId, invoice_id, webhookAmount);
      } catch (err: any) {
        console.error('[INTASEND WEBHOOK] Error handling claim payment webhook update:', err);
        return sendServerError(res, err, 'INTASEND_WEBHOOK_CLAIM_UPDATE_ERROR');
      }
    }

    res.json({ status: 'ok' });
  });
}

