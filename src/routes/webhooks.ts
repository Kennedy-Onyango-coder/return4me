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
// GATE C / STAGE C1 - the ACKNOWLEDGEMENT CONTRACT.
//
// The canonical confirmation path hands back an explicit outcome (reconciled /
// already_reconciled / refused-with-a-stable-code). This module maps that
// outcome to the provider-facing status and body in exactly ONE place, so no
// part of this route can decide to call a refusal a success. Pure module: it
// performs no I/O and grants nothing.
import {
  describePaymentConfirmationOutcome,
  paymentConfirmationHttpResult,
  type PaymentConfirmationOutcome,
} from '../config/paymentConfirmationOutcome';
// GATE C / STAGE C2 — the delivery vocabulary, used only to NAME the result that
// was produced. `deliveryOutcomeForPaymentConfirmation` is a pure translation of
// the C1 outcome above: this route never invents a delivery status of its own,
// and the only source of `reconciled` / `already_reconciled` / `refused_*` is the
// canonical confirmation path's verdict.
import {
  deliveryOutcomeForPaymentConfirmation,
  safeWebhookOutcomeCode,
  type WebhookDeliveryStatus,
} from '../config/webhookDeliveries';
import type {
  WebhookDeliveryHandle,
  WebhookDeliveryLog,
} from '../services/webhookDeliveryLog';

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
    ) => Promise<PaymentConfirmationOutcome>;
    /** Shared error disclosure, identical to every other route. */
    sendServerError: (res: any, error: any, context: string) => any;
    /**
     * BATCH 1 — the payout-batch VERIFICATION TRIGGER. Injected, never
     * reimplemented here: the authoritative provider lookup
     * (services/payments.ts), the exact transaction-to-leg matching and the
     * ledger compare-and-swap (services/payoutReconciliation.ts) all live
     * outside this module. This route only decides WHETHER to ask.
     */
    reconcilePayoutBatchStatus: (trackingId: string) => Promise<unknown>;
    /**
     * NON-COMPLETE COLLECTION EVENTS. Delegated here (injected) so this
     * module keeps no financial logic of its own.
     */
    reconcileCollectionFailureEvent: (event: {
      claimId: string;
      invoiceId: string;
      reportedState: unknown;
    }) => Promise<{ outcome: string }>;
    /**
     * GATE C / STAGE C2 — durable delivery records.
     *
     * OPTIONAL so this module can still be mounted with no database (the C1
     * acknowledgement contract test does exactly that). When it is absent NO
     * delivery is recorded — and because the recorder is never allowed to change
     * the response, the callback behaves exactly as it does with it present.
     * server.ts always supplies it.
     */
    webhookDeliveryLog?: WebhookDeliveryLog;
  }
) {
  const { processClaimPaymentConfirmed, sendServerError, reconcilePayoutBatchStatus, reconcileCollectionFailureEvent } = deps;

  /**
   * The recorder, or a handle-shaped NO-OP. Using a no-op rather than scattered
   * `if (deliveryLog)` guards guarantees that every exit path in this route is
   * instrumented identically whether or not a database is wired: there is no
   * branch that silently skips recording on one deployment and records on
   * another.
   */
  const deliveryLog: WebhookDeliveryLog =
    deps.webhookDeliveryLog ?? {
      async begin(): Promise<WebhookDeliveryHandle> {
        return {
          id: '',
          recorded: false,
          async processing() {},
          async settle() {},
        };
      },
    };

  /**
   * Settles a delivery with the status the provider ACTUALLY received.
   *
   * `res.statusCode` is read AFTER the response helper ran, so a
   * `sendServerError` that chose 500 or 503 is recorded as what it chose, and a
   * `res.json()` success is recorded as 200. Nothing in this helper can change
   * the response — it runs after it — and the recorder never throws.
   */
  const settleDelivery = async (
    handle: WebhookDeliveryHandle,
    res: any,
    settlement: {
      status: WebhookDeliveryStatus;
      outcomeCode?: string | null;
      retryable?: boolean | null;
      claimId?: string | null;
      authenticated?: boolean | null;
      diagnostic?: string | null;
    }
  ): Promise<void> => {
    await handle.settle({ ...settlement, httpStatus: res.statusCode });
  };

  /**
   * BATCH 1 — the `send_money_event` (payout / disbursement) TRIGGER.
   *
   * A payout callback is a HINT, not proof. Its own per-transaction status field
   * is never read and never trusted: IntaSend's documented guidance is to confirm
   * critical events against the API, and a payout is the most critical event
   * there is. So this handler does exactly one thing — it extracts the batch
   * tracking id and asks the injected verification path to RE-READ that batch
   * from the provider. Only a leg the provider authoritatively reports as
   * completed AND that matches exactly one local ledger row can be confirmed
   * there, and even then nothing about the claim's settlement is released.
   *
   * A missing tracking id is refused (400) — with no batch identity there is
   * nothing to verify. A verification failure is surfaced as an error (so the
   * provider retries) and confirms nothing. The response body is deliberately
   * uninformative about local state.
   *
   * Accepted field names mirror the submission path's own defensive alias
   * handling (`tracking_id`, with `trackingId`/`batch_reference` as
   * compatibility aliases). A wrong id simply fails verification — the trigger
   * can never complete a payout on its own.
   */
  const handlePayoutBatchEvent = async (
    payload: any,
    res: any,
    handle: WebhookDeliveryHandle,
    authenticated: boolean | null,
  ) => {
    const trackingId = payload?.tracking_id ?? payload?.trackingId ?? payload?.batch_reference ?? null;
    if (!trackingId || typeof trackingId !== 'string' || trackingId.trim() === '') {
      console.warn('[INTASEND WEBHOOK] send_money_event carried no usable tracking_id; nothing to verify.');
      res.status(400).json({ error: 'Missing tracking_id' });
      await settleDelivery(handle, res, {
        status: 'validation_rejected',
        outcomeCode: 'missing_tracking_id',
        retryable: false,
        authenticated,
      });
      return;
    }
    try {
      // The verification round-trip is real work on a real provider event.
      await handle.processing();
      const outcome: any = await reconcilePayoutBatchStatus(trackingId.trim());
      // Log the OUTCOME SHAPE, never the payload: a payout callback carries
      // recipient details, and the counts are what an operator needs.
      console.log('[INTASEND WEBHOOK] send_money_event handled as a verification trigger.', JSON.stringify({
        tracking_id: trackingId.trim(),
        handled: outcome?.handled ?? null,
        confirmed: Array.isArray(outcome?.confirmedLegIds) ? outcome.confirmedLegIds.length : 0,
      }));
      res.json({ status: 'ok' });
      // A payout callback never confirms money here: it only ROUTES the batch to
      // authoritative re-verification, and the record must say exactly that.
      await settleDelivery(handle, res, {
        status: 'payout_verification_routed',
        retryable: null,
        authenticated,
      });
      return;
    } catch (err: any) {
      console.error('[INTASEND WEBHOOK] Payout verification trigger failed:', err);
      sendServerError(res, err, 'INTASEND_WEBHOOK_PAYOUT_VERIFY_ERROR');
      // A failed verification is retryable: the provider re-sending the same
      // callback can succeed once the provider API answers again.
      await settleDelivery(handle, res, {
        status: 'internal_error',
        outcomeCode: 'INTASEND_WEBHOOK_PAYOUT_VERIFY_ERROR',
        retryable: true,
        authenticated,
      });
      return;
    }
  };

  // Webhook for IntaSend collection confirmation events
  app.post('/api/webhooks/intasend', async (req, res) => {
    const payload = req.body || {};

    // ---------------------------------------------------------------------
    // 0. DURABLE ARRIVAL RECORD (Gate C / stage C2).
    //
    // Recorded BEFORE the challenge is checked, on purpose: a refused delivery
    // — including an authentication refusal — used to leave no durable trace at
    // all, which is the defect this stage closes. The recorder never throws and
    // never alters the response, so a delivery whose insert fails still gets
    // exactly the answer the financial path produced; the missing row simply
    // means "not recorded", never "succeeded".
    // ---------------------------------------------------------------------
    const delivery = await deliveryLog.begin(payload);

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
    // NULL until something is actually verified: in sandbox/development with no
    // challenge configured nothing was checked, and the record must say so
    // rather than implying a verification that never happened.
    let authenticated: boolean | null = null;
    const configuredChallenge = process.env.INTASEND_WEBHOOK_CHALLENGE;
    if (process.env.NODE_ENV === 'production' && !configuredChallenge) {
      // A production deployment with no configured challenge cannot authenticate
      // anything, so it refuses rather than accepting unverified payment events.
      // boot() also refuses to start in this state — this is a second, local guard.
      console.warn('[INTASEND WEBHOOK] INTASEND_WEBHOOK_CHALLENGE is not configured in production. Refusing.');
      res.status(401).json({ error: 'Webhook challenge is not configured' });
      await settleDelivery(delivery, res, {
        status: 'authentication_rejected',
        outcomeCode: 'challenge_not_configured',
        retryable: false,
      });
      return;
    }
    if (configuredChallenge) {
      if (!challengeMatches(payload.challenge, configuredChallenge)) {
        console.warn('[INTASEND WEBHOOK] Challenge verification failed.');
        res.status(401).json({ error: 'Challenge verification failed' });
        await settleDelivery(delivery, res, {
          status: 'authentication_rejected',
          outcomeCode: 'challenge_mismatch',
          retryable: false,
          authenticated: false,
        });
        return;
      }
      authenticated = true;
      console.log('[INTASEND WEBHOOK] Challenge verified successfully.');
    }
    // When no challenge is configured we are in sandbox/development: the route
    // still requires the payload identity fields below and still runs the full
    // amount/provider reconciliation, so a dev event can drive the flow without
    // a real challenge — but it can never fabricate money in production.

    // ---------------------------------------------------------------------
    // 2. TOPIC ROUTING. Only TWO topics are actionable; every other lifecycle
    //    event is acknowledged and ignored.
    //
    //    `collection_event` — the collection path below.
    //    `send_money_event` — a PAYOUT/disbursement callback, handled as a
    //                         TRIGGER ONLY (see handlePayoutBatchEvent above):
    //                         the payload is never trusted as proof that money
    //                         moved, it only causes an authoritative provider
    //                         status re-read.
    //
    //    Routing lives INSIDE this one registered handler deliberately: this is
    //    the ONLY route in the module (the collection contract test asserts
    //    that shape), so there is exactly one authenticated entry point to
    //    reason about and one place the challenge is verified.
    // ---------------------------------------------------------------------
    if (payload.topic && payload.topic !== 'collection_event') {
      if (payload.topic === 'send_money_event') {
        await handlePayoutBatchEvent(payload, res, delivery, authenticated);
        return;
      }
      console.log(`[INTASEND WEBHOOK] Ignoring non-collection topic "${payload.topic}".`);
      res.json({ status: 'ignored' });
      // Seen, authenticated, deliberately not acted on. `ignored` says exactly
      // that; it is neither a refusal nor a success.
      await settleDelivery(delivery, res, {
        status: 'ignored',
        outcomeCode: 'topic_not_routed',
        retryable: null,
        authenticated,
      });
      return;
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
      res.status(400).json({ error: 'Missing invoice_id' });
      await settleDelivery(delivery, res, {
        status: 'validation_rejected',
        outcomeCode: 'missing_invoice_id',
        retryable: false,
        authenticated,
      });
      return;
    }
    if (!claimId || typeof claimId !== 'string') {
      console.warn('[INTASEND WEBHOOK] Missing api_ref; cannot reconcile to a claim.');
      res.status(400).json({ error: 'Missing api_ref' });
      await settleDelivery(delivery, res, {
        status: 'validation_rejected',
        outcomeCode: 'missing_api_ref',
        retryable: false,
        authenticated,
      });
      return;
    }

    // ---------------------------------------------------------------------
    // 4. SUCCESS STATE ONLY. Non-COMPLETE events are safe no-ops.
    // ---------------------------------------------------------------------
    if (state !== 'COMPLETE') {
      try {
        // A durable local write (a corroborated terminal failure) or a genuine
        // no-op — either way this delivery entered the financial path.
        await delivery.processing();
        const outcome: any = await reconcileCollectionFailureEvent({ claimId, invoiceId: invoice_id, reportedState: state });
        if (outcome === 'not_a_failure_state' || outcome?.outcome === 'not_a_failure_state') {
          console.log(`[INTASEND WEBHOOK] Non-complete state "${state}"; no action.`);
          res.json({ status: 'ignored' });
          await settleDelivery(delivery, res, {
            status: 'ignored',
            outcomeCode: 'not_a_failure_state',
            retryable: null,
            claimId,
            authenticated,
          });
          return;
        }
        res.json({ status: 'ok' });
        // NOT a reconciliation: a FAILED/CANCELLED event records a terminal
        // failure, which is neither money nor success.
        await settleDelivery(delivery, res, {
          status: 'collection_failure_recorded',
          outcomeCode: safeWebhookOutcomeCode(state),
          retryable: null,
          claimId,
          authenticated,
        });
        return;
      } catch (err: any) {
        console.error('[INTASEND WEBHOOK] COLLECTION_FAILURE_ERROR:', err);
        sendServerError(res, err, 'INTASEND_WEBHOOK_COLLECTION_FAILURE_ERROR');
        await settleDelivery(delivery, res, {
          status: 'internal_error',
          outcomeCode: 'INTASEND_WEBHOOK_COLLECTION_FAILURE_ERROR',
          retryable: true,
          claimId,
          authenticated,
        });
        return;
      }
    }

    // ---------------------------------------------------------------------
    // 5. TRUTHFUL ACKNOWLEDGEMENT (Gate C / stage C1).
    //
    // This used to answer 200 {"status":"ok"} for EVERY callback that did not
    // throw. The canonical path signalled eleven DIFFERENT refusals as `null`,
    // all indistinguishable from success here, so a provider-confirmed
    // collection the application had refused to reconcile was acknowledged to
    // IntaSend as handled: no retry, no operator, no audit trail naming the
    // refusal - recovery depended entirely on the 60-second sweep. That is the
    // false-success acknowledgement this stage removes.
    //
    // The canonical path now returns an explicit outcome and the response is
    // DERIVED from it (config/paymentConfirmationOutcome.ts is the only place
    // that decides status codes):
    //
    //   reconciled           -> 200  the collection really was reconciled by
    //                                 this delivery (unchanged success body)
    //   already_reconciled   -> 200  duplicate delivery; idempotent SUCCESS,
    //                                 nothing was written a second time
    //   refused, transient   -> 424  the refusal depended on an authority that
    //                                 could not corroborate the event (the
    //                                 provider status lookup). Escrow withheld.
    //   refused, permanent   -> 409  verified facts disagree with local truth
    //                                 (cross-claim invoice, amount mismatch, no
    //                                 confirmable session, claim not payable).
    //
    // Nothing here retries, initiates, pays out or writes a ledger row: the
    // route only reports what the canonical path already decided. The two
    // existing recovery paths (the 60-second `reconcilePendingPaymentSessions`
    // sweep and the on-demand payment-session status route) are untouched and
    // remain the durable recovery for anything refused.
    //
    // An unexpected exception is NOT converted into a 2xx: it becomes
    // sendServerError (5xx), exactly as before - a bug must never be reported
    // to the provider as a handled collection.
    // ---------------------------------------------------------------------
    try {
      await delivery.processing();
      const outcome = await processClaimPaymentConfirmed(claimId, invoice_id, webhookAmount);

      // FAIL CLOSED on an outcome this route cannot interpret. The injected
      // contract is the closed union; anything else means the acknowledgement
      // cannot be truthful, and an unacknowledged delivery must never look
      // like a reconciled one.
      if (!outcome || typeof outcome !== 'object' || typeof (outcome as any).kind !== 'string') {
        console.error(
          '[INTASEND WEBHOOK] The canonical confirmation path returned an unrecognised outcome; refusing to acknowledge it as a handled collection.'
        );
        sendServerError(
          res,
          new Error('Unrecognised payment-confirmation outcome'),
          'INTASEND_WEBHOOK_CONFIRMATION_OUTCOME_UNKNOWN'
        );
        await settleDelivery(delivery, res, {
          status: 'internal_error',
          outcomeCode: 'INTASEND_WEBHOOK_CONFIRMATION_OUTCOME_UNKNOWN',
          retryable: true,
          claimId,
          authenticated,
        });
        return;
      }

      const encoded = paymentConfirmationHttpResult(outcome);
      // IDs, the stable outcome code and its retryability only - never an
      // amount, a phone number, the pickup code or any part of the payload.
      console.log(
        `[INTASEND WEBHOOK] Collection claim ${claimId} (invoice ${invoice_id}): ${describePaymentConfirmationOutcome(outcome)} -> HTTP ${encoded.status}.`
      );
      res.status(encoded.status).json(encoded.body);
      // The delivery status is TRANSLATED from the canonical outcome, never
      // chosen here: `reconciled` therefore means the confirmation path said so,
      // and a refusal is recorded as the refusal it was (with its own code and
      // retryability) instead of being flattened into a handled collection.
      const mapped = deliveryOutcomeForPaymentConfirmation(outcome);
      await settleDelivery(delivery, res, {
        status: mapped.status,
        outcomeCode: mapped.code,
        retryable: mapped.retryable,
        claimId,
        authenticated,
      });
      return;
    } catch (err: any) {
      console.error('[INTASEND WEBHOOK] Error handling claim payment webhook update:', err);
      sendServerError(res, err, 'INTASEND_WEBHOOK_CLAIM_UPDATE_ERROR');
      await settleDelivery(delivery, res, {
        status: 'internal_error',
        outcomeCode: 'INTASEND_WEBHOOK_CLAIM_UPDATE_ERROR',
        retryable: true,
        claimId,
        authenticated,
      });
      return;
    }
  });
}

