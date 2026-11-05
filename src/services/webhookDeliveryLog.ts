// GATE C / STAGE C2 — DURABLE DELIVERY RECORDING GLUE.
//
// ONE RESPONSIBILITY: turn "a provider POSTed this payload" and "we answered with
// this result" into rows in `intasend_webhook_deliveries`, and NEVER let that
// bookkeeping change what the provider is told.
//
// THREE RULES THIS MODULE EXISTS TO ENFORCE
// -----------------------------------------
// 1. OBSERVABILITY NEVER BREAKS THE CALLBACK. Every method catches its own
//    failures. If the insert or the update fails, the provider still receives the
//    HTTP response the financial path already produced — a diagnostic table must
//    not become a new way for a payment callback to fail.
//
// 2. A WRITE FAILURE IS NEVER A RECORDED SUCCESS. The opposite direction is
//    equally forbidden: a failed write leaves the row OPEN (`received`) or
//    absent, which the admin read path reports as INCOMPLETE. It never
//    synthesises a terminal status to paper over the failure.
//
// 3. NOTHING HERE IS FINANCIAL AUTHORITY. It does not confirm, retry, refund or
//    release anything, and it never writes `reconciled` on its own authority: the
//    route derives that status from a Stage C1 outcome that itself reported a
//    reconciliation. The only read performed here is a READ-ONLY invoice ->
//    payment-session lookup used purely to CORRELATE a row.
//
// WHY THE ARRIVAL IS RECORDED BEFORE AUTHENTICATION
// -------------------------------------------------
// The defect this stage closes is that a refused delivery — including an
// authentication refusal — left no durable trace. So `begin()` runs before the
// challenge is checked: a row exists even if the challenge is wrong, the payload
// is nonsense, the handler throws, or the process dies mid-request (in which case
// the row stays open and is reported as INCOMPLETE rather than as success).
import crypto from 'crypto';
import {
  buildWebhookDeliveryFingerprint,
  eventCategoryForDelivery,
  isOpenWebhookDeliveryStatus,
  isWebhookDeliveryStatus,
  safeWebhookClaimId,
  safeWebhookDiagnostic,
  safeWebhookInvoiceId,
  safeWebhookOutcomeCode,
  safeWebhookProviderReference,
  safeWebhookSessionId,
  safeWebhookTopic,
} from '../config/webhookDeliveries';
// TYPE-ONLY: this module must be usable from a route that never touches the
// database, so nothing here imports the data layer at runtime.
import type {
  WebhookDeliveryRecordInput,
  WebhookDeliverySettlement,
} from '../db/database';

/** The narrow slice of the data layer this module needs. */
export interface WebhookDeliveryStore {
  recordWebhookDelivery(input: WebhookDeliveryRecordInput): Promise<void>;
  markWebhookDeliveryProcessing(deliveryId: string): Promise<boolean>;
  finishWebhookDelivery(
    deliveryId: string,
    settlement: WebhookDeliverySettlement,
  ): Promise<boolean>;
  /**
   * READ-ONLY correlation. Never creates, confirms or mutates a session; a
   * missing session simply leaves the delivery uncorrelated.
   */
  getPaymentSessionByProviderInvoice(invoiceId: string): Promise<any | undefined>;
}

export interface WebhookDeliveryHandle {
  /** The delivery id (`WHD-…`). Always present, even when recording failed. */
  readonly id: string;
  /** Whether an arrival row actually exists (a failed insert is not retried). */
  readonly recorded: boolean;
  /** Marks the row `processing` once the request is committed to real work. */
  processing(): Promise<void>;
  /** Records the result the provider ACTUALLY received. Never throws. */
  settle(settlement: WebhookDeliverySettlement): Promise<void>;
}

export interface WebhookDeliveryLog {
  begin(payload: unknown): Promise<WebhookDeliveryHandle>;
}

export interface WebhookDeliveryLogDeps {
  store: WebhookDeliveryStore;
  /** Injected for deterministic tests; production uses the real clock/uuid. */
  now?: () => Date;
  newId?: () => string;
}

function defaultId(): string {
  // Bounded by webhookDeliveries.WEBHOOK_DELIVERY_ID_MAX (50).
  return `WHD-${crypto.randomUUID()}`;
}

/**
 * Builds the recorder. ONE instance is created in server.ts and injected into the
 * webhook route, so the route keeps no database knowledge of its own.
 */
export function createWebhookDeliveryLog(deps: WebhookDeliveryLogDeps): WebhookDeliveryLog {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? defaultId;

  return {
    async begin(payload: unknown): Promise<WebhookDeliveryHandle> {
      const body: any = payload && typeof payload === 'object' ? payload : {};
      const id = newId();

      // Every stored value passes the vocabulary's sanitisers first: a payload
      // field must never become a free-text column, and a rejected value is
      // stored as NULL rather than truncated into a DIFFERENT identifier.
      const topic = safeWebhookTopic(body.topic);
      const invoiceId = safeWebhookInvoiceId(body.invoice_id);
      const claimId = safeWebhookClaimId(body.api_ref);
      const providerReference = safeWebhookProviderReference(body.provider_ref);
      const category = eventCategoryForDelivery(body.topic, body.state);
      const fingerprint = buildWebhookDeliveryFingerprint({
        topic: body.topic,
        invoiceId: body.invoice_id,
        state: body.state,
        apiRef: body.api_ref,
        providerRef: body.provider_ref,
        value: body.value,
      });

      let recorded = false;
      try {
        await store.recordWebhookDelivery({
          id,
          eventCategory: category,
          eventTopic: topic,
          // Not decided yet: the arrival row must not claim a verdict it has not
          // reached. It is filled in at settlement.
          authenticated: null,
          claimId,
          paymentSessionId: null,
          providerInvoiceId: invoiceId,
          providerReference,
          payloadFingerprint: fingerprint,
          diagnostic: null,
          receivedAt: now(),
        });
        recorded = true;
      } catch (error: any) {
        // Deliberately swallowed: the callback's response is already correct and
        // its correctness does not depend on this row existing.
        console.error(
          `[WEBHOOK DELIVERY] Could not record arrival ${id}: ${error?.message ?? error}`
        );
      }

      let sessionId: string | null = null;

      return {
        id,
        get recorded() {
          return recorded;
        },

        /**
         * Marks the row `processing` once the request is committed to real work.
         * Not fatal if it fails: the row then still reads `received`, which the
         * admin path reports as INCOMPLETE — the truthful state.
         */
        async processing(): Promise<void> {
          if (!recorded) return;
          try {
            await store.markWebhookDeliveryProcessing(id);
          } catch (error: any) {
            console.error(
              `[WEBHOOK DELIVERY] Could not mark ${id} as processing: ${error?.message ?? error}`
            );
          }
        },

        /** Records the result the provider ACTUALLY received. Never throws. */
        async settle(settlement: WebhookDeliverySettlement): Promise<void> {
          if (!recorded) return;

          // Refuse to write a status the vocabulary does not contain, or one that
          // is not terminal — the DDL's processed_shape_check says the same.
          if (!isWebhookDeliveryStatus(settlement?.status)) {
            console.error(`[WEBHOOK DELIVERY] Refusing to settle ${id} with an unknown status.`);
            return;
          }
          if (isOpenWebhookDeliveryStatus(settlement.status)) {
            console.error(`[WEBHOOK DELIVERY] Refusing to settle ${id} into a non-terminal status.`);
            return;
          }
          const httpStatus = settlement.httpStatus;
          if (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599) {
            console.error(`[WEBHOOK DELIVERY] Refusing to settle ${id} without a real HTTP status.`);
            return;
          }

          // CORRELATION ONLY. A collection delivery names a provider invoice, and
          // the session bound to that invoice is what makes "was this collection
          // eventually resolved" answerable. Read-only; a miss leaves the row
          // uncorrelated rather than guessing.
          if (!sessionId && invoiceId) {
            try {
              const session = await store.getPaymentSessionByProviderInvoice(invoiceId);
              sessionId = safeWebhookSessionId(session?.id);
            } catch (error: any) {
              console.error(
                `[WEBHOOK DELIVERY] Could not correlate ${id} to a payment session: ${error?.message ?? error}`
              );
            }
          }

          try {
            await store.finishWebhookDelivery(id, {
              status: settlement.status,
              httpStatus,
              outcomeCode: safeWebhookOutcomeCode(settlement.outcomeCode),
              retryable: settlement.retryable ?? null,
              claimId: safeWebhookClaimId(settlement.claimId),
              paymentSessionId: sessionId ?? safeWebhookSessionId(settlement.paymentSessionId),
              authenticated: settlement.authenticated,
              diagnostic: safeWebhookDiagnostic(settlement.diagnostic),
              processedAt: now(),
            });
          } catch (error: any) {
            // The provider already has its response. Report the record as
            // incomplete; never upgrade a failed write into a recorded outcome.
            console.error(
              `[WEBHOOK DELIVERY] Could not settle ${id} (${settlement.status}): ${error?.message ?? error}`
            );
          }
        },
      };
    },
  };
}
