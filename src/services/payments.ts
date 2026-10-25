import { db } from '../db/database';
// BATCH 1 — the ONE place a provider payout status code becomes a decision.
// payoutOutcomes.ts has no imports of its own, so this cannot create a cycle.
import {
  readProviderTransactionStatus,
  resolvePayoutTransactionBindings,
  isBatchApprovalRequired,
  classifyPayoutSubmissionHttpFailure,
  type PayoutTransactionVerdict,
} from '../config/payoutOutcomes';
// Phase 1 remediation (F7) — the idempotency key is a shared pure contract:
// the policy must be able to check that imported evidence names the exact key
// the submission path would re-use. Re-exported below so existing imports from
// this module keep working.
import { buildPayoutLegIdempotencyKey } from '../config/payoutIdempotency';

export { buildPayoutLegIdempotencyKey };

// BATCH 2 — the wallet-routing rule lives in config/ so the payout seam and the
// settlement executor call ONE implementation.
import { resolveConfiguredPayoutWalletRouting, resolveConfiguredCollectionWalletRouting } from '../config/walletRouting';
import { describeCollectionGatewayFailure } from '../config/startupDiagnostics';

// Local copy of the phone-masking helper (also in services/auth.ts as
// maskPhoneForLog, and database.ts) — duplicated rather than imported to
// avoid a circular import (auth.ts imports isPlaceholderKey from this
// file, so this file importing back from auth.ts would be circular).
function maskPhoneForLog(phone: string | null | undefined): string {
  if (!phone) return '(none)';
  const clean = phone.toString().replace(/\s+/g, '');
  if (clean.length < 7) return '***';
  return clean.slice(0, -6) + '***' + clean.slice(-3);
}

// Configuration variables for IntaSend.
//
// PRODUCTION HOST: the current IntaSend API is served from api.intasend.com.
// The previous value (the legacy `payment.` subdomain host) no longer matches
// the documented contract — the status reconciliation below issues a POST to
// `{base}/payment/status/`, which must resolve against api.intasend.com in
// production (and sandbox.intasend.com in sandbox). The same host is used for
// the STK collection and disburse/refund calls.
const INTASEND_BASE_URL = process.env.NODE_ENV === 'production'
  ? 'https://api.intasend.com/api/v1'
  : 'https://sandbox.intasend.com/api/v1';

// PAYOUT INITIATION ENDPOINT — THE DOCUMENTED PATH (Batch 1B-C1).
//
// IntaSend initiates a payout batch by POSTing to `{base}/send-money/initiate/`,
// NOT to `{base}/send-money/`:
//
//   "Initiate a batch with POST /api/v1/send-money/initiate/."
//   — https://developers.intasend.com/guides/send-money/overview/
//
// The bare `/send-money/` path was used here for BOTH the payout batch and the
// single-transaction refund. It is not part of the documented contract, and a
// 404 there is indistinguishable — to the caller — from a provider refusal,
// which is exactly the class of defect this batch closes. It is now ONE shared
// constant so the payout and refund paths cannot drift apart again.
//
// NOT VERIFIED AGAINST OUR MERCHANT ACCOUNT. Confirming this path (and the
// approval behaviour that follows it) against the real sandbox/production
// account is a separately authorized check by the account owner.
//
// The STATUS endpoint is deliberately NOT changed: `/send-money/status/` is the
// documented status path and stays exactly as it was.

// PRODUCTION DISBURSEMENT-WALLET CONFIGURATION
//
// The IntaSend "send-money initiate" contract accepts an optional `wallet_id`
// ("Wallet to debit. It must match currency. Defaults to your settlement
// wallet for that currency. A working wallet must have can_disburse enabled."
// — https://developers.intasend.com/guides/send-money/overview/). Return4me
// exposes this as a single environment variable so the working-wallet ID is
// never hardcoded in source.
//
// Fail-closed in production: an absent, empty, whitespace-only or
// placeholder-shaped value aborts payout initiation before any provider
// request is made (never a silent settlement-wallet fallback). In
// non-production environments the configured value is never sent to the
// provider, so sandbox/test behaviour is unchanged.
//
// SCOPE OF LOCAL VALIDATION - this code only checks that the variable is
// present, non-blank and not placeholder-shaped (see isPlaceholderKey below,
// the same convention every other REPLACE_WITH_* entry in .env.example relies
// on: the documented placeholder value for THIS variable must not satisfy the
// gate). It does NOT verify that the value is a real wallet, that the wallet
// is KES-denominated, or that it has can_disburse enabled - the provider
// validates those properties at request time and rejects an invalid wallet
// there. The currency/capability requirements quoted above are
// IntaSend's contract, not something enforced locally.
const INTASEND_DISBURSEMENT_WALLET_ENV = 'INTASEND_DISBURSEMENT_WALLET_ID';

export function getDisbursementWalletId(): string | null {
  const raw = process.env[INTASEND_DISBURSEMENT_WALLET_ENV];
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

// True only for a wallet ID that is present, non-blank AND not placeholder
// shaped. The placeholder half of that rule is what stops a deployment which
// copied .env.example verbatim (INTASEND_DISBURSEMENT_WALLET_ID =
// "REPLACE_WITH_KES_WORKING_WALLET_ID") from passing this gate: a
// present-but-placeholder value is NOT a configured wallet, and sending an
// API-shaped placeholder to the provider is exactly the class of mistake this
// gate exists to catch.
//
// It reuses isPlaceholderKey() - the project-wide convention already applied
// to the IntaSend keys, the webhook challenge and the Africa's Talking
// credentials - rather than introducing a second, wallet-specific string list
// that could drift from the others. That helper is declared later in this
// module; function declarations are hoisted, so calling it from here is safe.
// A legitimate wallet ID is never matched by it: the shapes it knows
// ('replace_with', 'placeholder', 'your_key', 'changeme', 'xxx', 'todo',
// 'tbd') are not wallet-ID shapes.
//
// Both production gates call this one function - executeClaimSettlement() in
// server.ts (before any payout row is marked as submitted) and
// triggerIntasendPayout() below (before the request body is built) - so the
// placeholder rule cannot be enforced at one seam and forgotten at the other.
export function isDisbursementWalletConfigured(): boolean {
  return !isPlaceholderKey(getDisbursementWalletId());
}

// BATCH 2 — THE OPTIONAL SETTLEMENT-WALLET IDENTITY.
//
// The wallet IntaSend takes collections into. This application CANNOT select a
// collection destination (the STK request it sends carries no wallet field), so
// this value routes nothing: it is read ONLY so the payout path can prove the
// wallet it debits is not the wallet that receives collections. Absent, blank or
// placeholder-shaped means "undeclared" — payouts are unchanged and the identity
// check is reported as unavailable rather than guessed. It is never sent to the
// provider and never logged unmasked.
export function getSettlementWalletId(): string | null {
  const raw = process.env.INTASEND_SETTLEMENT_WALLET_ID;
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

const INTASEND_SEND_MONEY_INITIATE_PATH = '/send-money/initiate/';

// Recognizes an unset/placeholder API key under any of the common
// conventions used across this project's own .env.example (REPLACE_WITH...)
// and the ones commonly used when an assistant or teammate fills in a .env
// file for you (placeholder, your_key_here, xxx, changeme, etc.). Missing
// just one of these was the actual root cause of "payment simulation loads
// and does nothing": a key literally set to the word "placeholder" wasn't
// recognized as fake, so the app made a real network call with an invalid
// key instead of using the safe built-in simulation.
//
// WHY THIS IS *NOT* DELEGATED TO config/walletRouting.ts (BATCH 2): this module
// sits in a genuine import cycle (payments -> db/database -> paymentStrikePolicy
// -> services/auth -> payments), and auth.ts calls this predicate at MODULE
// EVALUATION time. A delegation to an imported binding fails there with
// "Cannot access ... before initialization" — the import is assigned only when
// payments.ts's own body starts, which the cycle defers. The same constraint the
// phone masker at the top of this file documents applies here: a small, pure
// predicate is duplicated rather than imported across the cycle. The copy in
// config/walletRouting.ts must agree with this one, and
// payoutInitiationContract.test.ts asserts that they do over every placeholder
// shape.
export function isPlaceholderKey(key: string | undefined | null): boolean {
  if (!key || key.trim() === '') return true;
  const normalized = key.trim().toLowerCase();
  return (
    normalized.includes('replace_with') ||
    normalized.includes('placeholder') ||
    normalized.includes('your_key') ||
    normalized.includes('your-key') ||
    normalized.includes('changeme') ||
    normalized.includes('change_me') ||
    normalized === 'xxx' ||
    normalized === 'todo' ||
    normalized === 'tbd'
  );
}

// =============================================================================
// BATCH 1 — THE PAYMENT SIMULATION ENVIRONMENT ALLOW-LIST (ONE POLICY).
// =============================================================================
//
// Every money-protocol function in this module has a no-credentials branch that
// reports a fabricated SUCCESS without a provider request (an STK push that no
// phone ever saw, a payout batch that never exists, a completed refund). Those
// branches are a development convenience, and they are only ever safe in an
// environment that is EXPLICITLY a development or test environment.
//
// The defect this closes: two of the three gates (collection and payout) used an
// exact-string production check —
//
//     if (process.env.NODE_ENV === 'production') { throw ... }
//
// — which fails OPEN for every value it does not recognise. `NODE_ENV` unset
// (a plain `node`/`tsx` start, some containers), an empty string, a misspelling
// ('prod', 'Producton'), a different casing ('Production') or a real deployment
// label ('staging') all fell through to the simulation branch, which returns
// `success: true` and books the attempt's payment_received ledger row. The
// caller reads that as "a payment request is out and may be approved", so in a
// misconfigured production-like deployment anyone could "pay" for any claim and
// proceed to collect the item for free, or a finder/agent payout could be
// reported as paid with nothing sent.
//
// The rule is therefore a POSITIVE ALLOW-LIST, applied identically by all three
// gates (triggerMpesaStkPush, triggerIntasendPayout and triggerIntasendRefund,
// whose gate already had this shape and is unchanged in behaviour):
//
//   * simulation is permitted ONLY when NODE_ENV is exactly 'development' or
//     exactly 'test';
//   * every other value — 'production', 'staging', an unset or empty value, a
//     misspelling, a different casing, or any other unrecognised string —
//     refuses to simulate and throws before any fabricated success can be
//     produced;
//   * an unrecognised value is NEVER treated as a development environment.
//
// This is a comparison against literals only, so it can only ever fail closed.
// It says nothing about real credentials: a configured, non-placeholder key
// takes the genuine provider path in every environment, exactly as before.
export const PAYMENT_SIMULATION_ENVS = ['development', 'test'] as const;

/** True only for an environment explicitly recognised as a simulation environment. */
export function isPaymentSimulationEnvironment(nodeEnv: string | undefined): boolean {
  return nodeEnv === 'development' || nodeEnv === 'test';
}

// The observed NODE_ENV, rendered for a fail-closed refusal message: 'unset'
// when it is absent, otherwise the value sanitised to a short, log-safe token.
// An environment variable is operator configuration rather than customer data,
// but it can still reach a log aggregator and is not guaranteed to be
// newline-free, so it is never interpolated verbatim.
export function describeNodeEnvForRefusal(nodeEnv: string | undefined): string {
  if (nodeEnv === undefined) return 'unset';
  return `"${String(nodeEnv).replace(/[^A-Za-z0-9_.-]/g, '?').slice(0, 32)}"`;
}

// =============================================================================
// BATCH 1 CORRECTION A — "WOULD THIS PAYOUT ATTEMPT HAVE TO BE SIMULATED?"
// =============================================================================
//
// A payout attempt is SIMULATED exactly when this module holds no usable
// IntaSend secret key: triggerIntasendPayout() selects its simulation branch on
// this one condition, and that branch reports every leg as 'success' without a
// provider request.
//
// The settlement executor (executeClaimSettlement in server.ts) has to answer
// the SAME question BEFORE it writes its durable pre-submission markers, because
// the service-level refusal below is too late to be recoverable: by then the
// markers are persisted, so the payout rows read 'submitting' and the claim is
// parked in its transient release lock.
//
// Both seams therefore ask THIS function, which is also the condition the branch
// itself is selected by, so the executor's preflight cannot drift from the
// branch it protects - and there is still exactly ONE simulation policy
// (isPaymentSimulationEnvironment above), not a second, conflicting one.
//
// It answers a CREDENTIAL question only. A configured, non-placeholder key
// returns false in every environment, so a genuine provider request is never
// blocked by it - in production or anywhere else.
export function isPayoutSimulationRequired(
  secretKey: string | undefined | null = process.env.INTASEND_SECRET_KEY
): boolean {
  return isPlaceholderKey(secretKey);
}

// P1: webhook amount reconciliation — pure decision logic behind
// processClaimPaymentConfirmed in server.ts, extracted here specifically
// so it's unit-testable (server.ts has no exports and a large amount of
// top-level side-effecting setup unsafe to import in a test file — same
// reasoning as isAgentActionable/isAdminSessionCurrent in services/auth.ts).
//
// P1 HARDENING (this batch). The three-result contract below is unchanged in
// shape, but 'unknown' now means EXACTLY ONE thing: "this payload carried no
// usable amount", and the caller MUST NOT treat it as a reconciliation. It is
// the trigger for an authoritative provider lookup, never a licence to proceed.
//
// WHAT CHANGED AND WHY:
//
// 1. parseFloat() accepted numeric PREFIXES. `parseFloat('500abc')` is 500, so a
//    corrupt or tampered field whose value began with the right digits was
//    silently reconciled as a MATCH. Validation is now strict: the whole trimmed
//    string must be a finite number, or the input is not numeric at all.
//
// 2. parseFloat('Infinity') is Infinity, and |Infinity - 500| is > 0.5 so it
//    happened to be caught, but only by accident of the comparison — it was not
//    rejected as non-numeric. Non-finite values are now rejected up front.
//
// 3. parseFloat(true) is NaN and parseFloat({}) is NaN, which returned 'unknown'
//    and therefore PROCEEDED TO ESCROW. A boolean or an object arriving in a
//    money field is malformed, not absent, and must not be reconciled.
//
// 4. Zero and negatives are rejected. A real collection is always a strictly
//    positive amount: a zero or negative "successful" payment is a provider or
//    data fault, never a legitimate settlement of a positive fee.
//
// The 0.5 KES epsilon tolerance is RETAINED unchanged: it absorbs decimal
// formatting differences ("500" vs "500.00") and is deliberately far too small
// to hide genuine underpayment.
export function reconcileWebhookAmount(
  confirmedAmount: unknown,
  expectedFee: unknown
): 'match' | 'mismatch' | 'unknown' {
  // Strict, type-safe numeric coercion. Only a real number, or a string that is
  // ENTIRELY a number, is numeric. Objects, arrays, booleans and functions are
  // rejected by the typeof guard before String() is ever applied.
  const toStrictNumber = (raw: unknown): number | null => {
    if (typeof raw === 'number') {
      return Number.isFinite(raw) ? raw : null;
    }
    if (typeof raw !== 'string') return null; // null, undefined, {}, [], booleans
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    // A full-string numeric match: this is what parseFloat could not do.
    // Rejects "500abc", "1,000", "12px", "--5" and any other prefix/suffix.
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const confirmedNum = toStrictNumber(confirmedAmount);
  if (confirmedNum === null) return 'unknown';

  const expectedNum = toStrictNumber(expectedFee);
  if (expectedNum === null) return 'unknown';

  // A collection can only ever settle a strictly positive amount. Zero and
  // negative values are malformed for this purpose, and are reported as
  // 'unknown' (i.e. "do not reconcile, verify with the provider") rather than
  // 'mismatch', because they tell us nothing about what was actually charged.
  if (confirmedNum <= 0) return 'unknown';

  return Math.abs(confirmedNum - expectedNum) <= 0.5 ? 'match' : 'mismatch';
}

// BATCH 1B-C1 — PROVIDER-SIDE IDEMPOTENCY KEY FOR ONE PAYOUT LEG.
//
// IntaSend documents `idempotency_key` as a PER-TRANSACTION field of the send
// money request:
//
//   "idempotency_key | No | Unique key per transaction. A repeat request with the
//    same key is rejected, so you can retry safely."
//   "Set a unique idempotency_key on every transaction (for example your internal
//    payout ID). ... duplicates are rejected with duplicate transaction detected."
//   — https://developers.intasend.com/guides/send-money/overview/
//
// So the key MUST be a pure function of the leg's stable local identity:
//   * deterministic — the same logical leg always sends the same key, so a
//     retried submission is recognised as a duplicate by the provider;
//   * distinct per leg — a claim's finder and agent legs never share one;
//   * PII-free — it carries the claim id and the recipient role only. No phone
//     number, Till/PayBill number, name or secret ever enters the key.
//
// ACTUAL RETRY BEHAVIOUR, STATED HONESTLY: the local submission guard in
// server.ts already refuses to re-send an unresolved leg, so this key is
// defence-in-depth at the provider boundary rather than the primary control.
// Whether a duplicate is replayed or rejected is the provider's semantics, and a
// "duplicate transaction detected" rejection is a 4xx. That is NOT claimed to
// make a payout exactly-once, and it does not replace any local guard.
//
// A blank claim id yields `PAYOUT_LEG_<ROLE>:` — shared across claims. That
// cannot occur for a real settlement (the claim row must exist for
// executeClaimSettlement() to be called at all), and the provider answers a
// duplicate key with a rejection, which fails closed rather than paying twice.
//
// PHASE 1 REMEDIATION (F7): the builder itself lives in
// config/payoutIdempotency.ts so the repair policy can check imported evidence
// against the same function. It is imported and re-exported above; there is no
// second implementation of the key format.


// fetch() has no built-in timeout — without one, a request to a third-party
// API that's unreachable (blocked network, DNS failure, provider outage) can
// hang far longer than any reasonable UX should wait, which looks to a user
// exactly like "I clicked the button and nothing happened."
async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number = 12000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

export const PaymentService = {
  /**
   * Triggers an M-Pesa STK Push Collection request using IntaSend Collections API
   */
  async triggerMpesaStkPush(
    phone: string,
    amount: number,
    claimId: string
  ): Promise<{ success: boolean; checkoutRequestId: string | null; mpesaReceiptCode: string; message: string; ambiguous?: boolean; unresolved?: boolean; outcome?: string }> {
    const formattedPhone = formatMpesaPhone(phone);
    const publishableKey = process.env.INTASEND_PUBLISHABLE_KEY;
    const secretKey = process.env.INTASEND_SECRET_KEY;

    // Helper generator for simulated payment when keys are dummy or API is down
    const generateMockStkPushSuccess = async (phoneNumber: string, amt: number, cId: string) => {
      const invoiceId = 'INV-' + Math.random().toString(36).substring(2, 10).toUpperCase();
      const receiptCode = 'MPX' + Math.floor(100000 + Math.random() * 900000).toString();

      // D-2A — AN INITIATED ATTEMPT IS NOT A RECEIPT.
      //
      // This row used to be booked as 'completed': the simulation asserted money
      // had been collected before anyone approved anything, which is the same
      // class of defect as promoting an abandoned attempt at settlement. It is now
      // exactly what the real path below books — an UNRESOLVED attempt carrying
      // the provider reference its own confirmation would arrive under
      // (`provider_transaction_id`, matched against the provider invoice id; see
      // db.attemptClaimEscrowHold). Nothing promotes it to 'completed' except an
      // authoritative confirmation for that reference. Simulation must not be read
      // as a payment (docs/claims-and-payments.md), so it must not be written as
      // one either.
      await db.logTransaction({
        claim_id: cId,
        item_id: null,
        type: 'payment_received',
        amount: amt,
        phone_or_till: formatMpesaPhone(phoneNumber),
        status: 'pending',
        provider_transaction_id: invoiceId,
      });

      return {
        success: true,
        checkoutRequestId: invoiceId,
        mpesaReceiptCode: receiptCode,
        message: `[SIMULATION] A payment request for KES ${amt} was sent to your phone (${phoneNumber}). Enter your M-Pesa PIN when prompted to complete the simulated payment.`,
      };
    };

    if (!publishableKey || !secretKey || isPlaceholderKey(publishableKey) || isPlaceholderKey(secretKey)) {
      // SIMULATION IS A DEVELOPMENT/TEST FACILITY — NEVER A PRODUCTION ONE.
      // A misconfigured production deployment (missing or still-placeholder IntaSend
      // keys) previously fell straight through to
      // generateMockStkPushSuccess, which does not merely pretend an STK
      // push was sent: it returns `success: true` for a request that
      // never reached a phone, and it books that attempt's
      // payment_received ledger row. The row itself is no longer written
      // as 'completed' (D-2A — see the generator above): an initiated
      // attempt is booked 'pending' and only an authoritative
      // confirmation for that attempt's own reference can complete it,
      // so a simulation cannot manufacture revenue on its own. It still
      // fabricates the appearance of a payment prompt the customer was
      // never shown, though, and every caller reads that `success: true`
      // as "a payment request is out and may be approved". In production
      // that means anyone could "pay" for any claim and proceed straight
      // to collecting the item, for free, with zero real M-Pesa
      // transaction behind it.
      // Simulated success is NEVER proof that money moved. Same fail-closed
      // principle as the database connection guard in db/index.ts: refuse to
      // start faking money movement rather than silently doing it — and, as of
      // BATCH 1, refuse for EVERY environment that is not explicitly a
      // simulation environment (see PAYMENT_SIMULATION_ENVS above). The
      // production-only check that used to live here failed OPEN for 'staging',
      // an unset NODE_ENV, a misspelling and any other unrecognised value.
      if (!isPaymentSimulationEnvironment(process.env.NODE_ENV)) {
        throw new Error(
          'FATAL: IntaSend payment credentials are missing or still a placeholder value, and NODE_ENV is ' +
          `${describeNodeEnvForRefusal(process.env.NODE_ENV)}, which is not a payment-simulation environment. ` +
          'Refusing to simulate a payment: a simulated success is not proof that money moved, and in a ' +
          'production-like environment it would let a claim be "paid" with no real M-Pesa transaction behind it. ' +
          'Set NODE_ENV to "development" or "test" for local simulation, or configure real ' +
          'INTASEND_PUBLISHABLE_KEY/INTASEND_SECRET_KEY before accepting payments.'
        );
      }
      console.warn('[INTASEND GATEWAY] Configuration missing or placeholder (development/test environment only). Falling back to the built-in payment simulation.');
      return generateMockStkPushSuccess(phone, amount, claimId);
    }

    // PHASE 5 — OPTIONAL COLLECTION-WALLET SELECTOR.
    //
    // The default STK body is exactly four fields and stays exactly that when
    // the selector is unset, blank, or the runtime is not production. A
    // production deployment that explicitly configures a real selector gets a
    // fifth field; a production deployment whose value is placeholder-shaped is
    // REFUSED here rather than silently falling back to the provider default,
    // because that fallback would settle the collection somewhere the operator
    // did not choose. Provider support for wallet_id on this endpoint is
    // verified by the account owner, not by this application.
    const collectionWalletRouting = resolveConfiguredCollectionWalletRouting();
    if (!collectionWalletRouting.ok) {
      throw new Error(`FATAL: ${collectionWalletRouting.message}`);
    }

    const payload = {
      public_key: publishableKey,
      phone_number: formattedPhone,
      amount: amount,
      api_ref: claimId,
      // Only 'ready' means production + a valid selector. The other states
      // (not_required, not_configured) must leave the four-field body unchanged.
      ...(collectionWalletRouting.code === 'ready' && collectionWalletRouting.collectionWalletId !== null
        ? { wallet_id: collectionWalletRouting.collectionWalletId }
        : {}),
    };

    // Never log the public_key (a credential, even if labeled
    // "publishable") or the full phone number — see maskPhoneForLog.
    console.log('[INTASEND GATEWAY] Initiating STK Push Collection.', {
      phone_number: maskPhoneForLog(formattedPhone),
      amount,
      api_ref: claimId,
      // Verdict only — never the unmasked wallet ID.
      collection_wallet_routing: collectionWalletRouting.code,
    });

    try {
      const response = await fetchWithTimeout(`${INTASEND_BASE_URL}/payment/mpesa-stk-push/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${secretKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.warn(
          describeCollectionGatewayFailure(process.env, response.status, INTASEND_BASE_URL) +
            ` Provider response excerpt: ${errorText.substring(0, 100)}.`,
        );
        // BATCH 1 (E) — a non-2xx is NOT automatically a definite rejection.
        // Only an HTTP status that reliably establishes the provider refused the
        // request (a 4xx that is not one of the ambiguous statuses) may be treated
        // as a definite rejection. 5xx, redirects, timeouts-as-status-codes and
        // rate-limit/lock statuses leave the provider's acceptance unknown, so
        // the outcome is ambiguous and the session stays unresolved.
        const failureClass = classifyPayoutSubmissionHttpFailure(response.status);
        if (failureClass === 'ambiguous') {
          return {
            success: false,
            checkoutRequestId: null,
            mpesaReceiptCode: '',
            message: `The M-Pesa service response was ambiguous (${response.status}); the payment request may or may not have been sent. Please check the payment status before retrying.`,
            ambiguous: true,
            unresolved: true,
            outcome: 'ambiguous' as const,
          };
        }
        return {
          success: false,
          checkoutRequestId: '',
          mpesaReceiptCode: '',
          message: `The M-Pesa service could not reach the payment system (${response.status}). Please try again later.`,
        };
      }

      const data = await response.json() as any;
      // Not logging the raw response body verbatim — its exact shape (and
      // whether it echoes the phone number back) isn't fully known
      // without live credentials; log only what's actually used.
      console.log('[INTASEND GATEWAY] Response received. Top-level keys:', Object.keys(data || {}), 'invoice_id:', data?.invoice?.invoice_id || '(none)');

      // B — DO NOT fabricate a provider invoice ID. If the provider response omits
      // invoice_id, we have no reliable evidence that the STK request was sent or
      // accepted. Preserve the unresolved outcome and block automatic resubmission.
      // The caller must handle the missing-invoice-ID case conservatively: treat it
      // as an unresolved attempt, NOT as a sent prompt.
      let invoiceId = data.invoice?.invoice_id || null;

      // D-2A — THE RECEIPT ROW CARRIES ITS OWN ATTEMPT'S PROVIDER REFERENCE.
      //
      // A 2xx from the STK endpoint means the prompt was SENT, not that anything
      // was collected. The row is booked 'pending' (unresolved) and stamped with
      // the provider invoice id of THIS attempt — the binding key the
      // authoritative confirmation resolves it by. db.attemptClaimEscrowHold
      // completes exactly the row whose `provider_transaction_id` equals the
      // confirming invoice, and no other row: an abandoned, expired or otherwise
      // unconfirmed attempt therefore keeps its own pending row forever rather
      // than becoming revenue when the claim settles (finalizeSettlement no longer
      // touches this row type at all).
      await db.logTransaction({
        claim_id: claimId,
        item_id: null,
        type: 'payment_received',
        amount,
        phone_or_till: formattedPhone,
        status: 'pending',
        provider_transaction_id: invoiceId,
      });

      return {
        success: true,
        checkoutRequestId: invoiceId,
        mpesaReceiptCode: invoiceId || '',
        message: `A payment request for KES ${amount} was sent to your phone (${phone}). Enter your M-Pesa PIN when prompted to complete the payment.`,
        ...(invoiceId ? {} : { ambiguous: true, unresolved: true, outcome: 'ambiguous' as const }),
      };
    } catch (error: any) {
      // Transport failure (timeout, DNS, connection reset, TLS, unreadable
      // body): we genuinely do not know whether IntaSend received and
      // accepted the STK request. Treating this as a definite failure would
      // mark the session failed while a prompt may already be on the
      // claimant's phone, and a later retry could double-charge. Leave the
      // session unresolved (pending, no invoice id) for reconciliation/expiry.
      console.warn('[INTASEND GATEWAY] STK Push failed with exception:', error?.message);
      return {
        success: false,
        checkoutRequestId: null,
        mpesaReceiptCode: '',
        message: `A network error occurred while sending the payment request; the outcome could not be verified. Please check the payment status before retrying.`,
        ambiguous: true,
        unresolved: true,
        outcome: 'ambiguous' as const,
      };
    }
  },

  /**
   * AUTHORITATIVE PAYMENT-STATUS LOOKUP (P1 / B-1).
   *
   * WHY THIS EXISTS. IntaSend's documented collection callback carries `value`,
   * but a callback can also arrive that does not — and a malformed value (an
   * object, a boolean, a numeric-prefix string like "500abc") is just as
   * unusable as an absent one. Previously BOTH cases returned 'unknown' from
   * reconcileWebhookAmount and the caller PROCEEDED TO ESCROW anyway, so a
   * P1 financial control was silently inert.
   *
   * This is the documented fallback for exactly that case: IntaSend's Payment
   * Status endpoint resolves an `invoice_id` to the authoritative invoice,
   * whose `state` and `value` are the settlement record. It is called ONLY when
   * the callback's own amount could not be reconciled — a normal, valid callback
   * never makes this extra network call.
   *
   * CONTRACT, deliberately narrow and fail-closed:
   *   - `verified` is true ONLY when the provider returned an invoice whose
   *     identity matches, whose state is COMPLETE, and which yielded a usable
   *     amount. Anything else is `verified: false` with a reason, and the
   *     caller's only correct response is to NOT enter escrow.
   *   - Never throws, never fabricates an amount, never logs the secret key.
   *   - Bounded by fetchWithTimeout (default 12s) so a webhook can never hang.
   *   - Honours the same sandbox/production base URL split as every other call.
   */
  async fetchAuthoritativeCollectionStatus(
    invoiceId: string,
    expectedAmount: number | string,
    expectedApiRef?: string | null
  ): Promise<{
    verified: boolean;
    reason: string;
    providerState: string | null;
    providerAmount: number | string | null;
    providerInvoiceId: string | null;
    providerReference: string | null;
  }> {
    const unverified = (reason: string, extra: Record<string, any> = {}) => ({
      verified: false,
      reason,
      providerState: null,
      providerAmount: null,
      providerInvoiceId: null,
      providerReference: null,
      ...extra,
    });

    const trimmedInvoice = String(invoiceId || '').trim();
    if (!trimmedInvoice) return unverified('missing_invoice_id');

    const secretKey = process.env.INTASEND_SECRET_KEY;
    if (isPlaceholderKey(secretKey)) {
      // Without real credentials there is nothing authoritative to consult. The
      // sandbox/simulation path must NOT be treated as proof of payment.
      return unverified('provider_credentials_unavailable');
    }

    let data: any;
    try {
      // CURRENT PROVIDER CONTRACT (IntaSend Payment Status):
      //   POST {base}/payment/status/
      //   body: { "invoice_id": "<id>" }
      //   response: { invoice: { invoice_id, state, value, api_ref, provider_ref, ... } }
      //
      // This replaced a GET {base}/payment/status/{invoiceId} call against the
      // legacy `payment.` host, which the current API no longer serves — so
      // every reconciliation attempt 404'd and a COMPLETE payment could never be
      // confirmed from the provider side (the other half of the
      // real-money-stuck-as-pending defect).
      const response = await fetchWithTimeout(
        `${INTASEND_BASE_URL}/payment/status/`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${secretKey}`,
          },
          body: JSON.stringify({ invoice_id: trimmedInvoice }),
        },
        12000
      );
      if (!response.ok) {
        return unverified(`provider_http_${response.status}`);
      }
      data = await response.json();
    } catch (error: any) {
      // Network error, DNS failure, provider outage or our own 12s timeout.
      return unverified('provider_request_failed');
    }

    // The status endpoint nests the invoice under `invoice`. Guessing at a
    // shape we do not control is exactly the failure mode this method exists to
    // close, so an unexpected shape is reported as unverified, never guessed.
    const invoice = data?.invoice;
    if (!invoice || typeof invoice !== 'object') {
      return unverified('provider_response_unrecognised');
    }

    const providerInvoiceId = invoice.invoice_id ? String(invoice.invoice_id) : null;
    // Identity must match the invoice we asked about. A provider that answers
    // with a different invoice is not evidence about this payment.
    if (!providerInvoiceId || providerInvoiceId !== trimmedInvoice) {
      return unverified('provider_invoice_identity_mismatch', { providerInvoiceId });
    }

    // CROSS-CLAIM ISOLATION (defence in depth). api_ref is the merchant
    // (Return4me) reference, which is set to the claim id when the collection is
    // created. When the caller knows which claim this invoice must belong to,
    // a response whose api_ref names a DIFFERENT claim is not evidence about
    // this payment and is refused — the same guarantee the session's
    // uq_payment_sessions_provider_invoice index enforces at the DB layer,
    // re-checked against the provider's own record.
    if (expectedApiRef != null && String(expectedApiRef).trim() !== '') {
      const providerApiRef = invoice.api_ref != null ? String(invoice.api_ref).trim() : null;
      if (!providerApiRef || providerApiRef !== String(expectedApiRef).trim()) {
        return unverified('provider_api_ref_mismatch', { providerInvoiceId, providerApiRef });
      }
    }

    const providerState = invoice.state ? String(invoice.state).trim().toUpperCase() : null;
    // IntaSend's documented successful collection state is COMPLETE. Anything
    // else — FAILED, PENDING, CANCELLED, or absent — is not a settlement.
    if (providerState !== 'COMPLETE') {
      return unverified('provider_state_not_complete', { providerState, providerInvoiceId });
    }

    // Amount is read from the same top-level `value` field the documented
    // callback uses, and is returned RAW (still a string) so the caller's
    // strict predicate — not this method — decides whether it reconciles.
    const providerAmount = (invoice.value ?? invoice.amount) ?? null;
    if (providerAmount === null || providerAmount === '') {
      return unverified('provider_amount_absent', { providerState, providerInvoiceId });
    }

    // Log the decision, never the secret and never the full provider body.
    console.warn('[INTASEND AUTHORITATIVE LOOKUP] Resolved invoice to COMPLETE; handing the amount to strict reconciliation.', {
      invoice_id: providerInvoiceId,
      state: providerState,
      expected: String(expectedAmount),
    });

    return {
      verified: true,
      reason: 'provider_confirmed_complete',
      providerState,
      providerAmount,
      providerInvoiceId,
      // provider_ref is the PROVIDER/M-Pesa transaction reference. It is the
      // only provider-side reference that is evidence about the money movement,
      // and it is deliberately returned as an opaque string — never treated as
      // proof of payment on its own (the `verified` flag, state and amount are).
      providerReference: invoice.provider_ref
        ? String(invoice.provider_ref)
        : (invoice.transaction_id ? String(invoice.transaction_id) : null),
    };
  },

  /**
   * BATCH 1 — AUTHORITATIVE PAYOUT-BATCH STATUS LOOKUP.
   *
   * The verdict half of payout confirmation: given a payout batch's provider
   * tracking id, ask IntaSend what it actually did with each transaction in it.
   * This exists because a payout callback is only a TRIGGER — the provider's own
   * per-transaction record is the evidence — and because IntaSend accepting a
   * batch (`HTTP 2xx` on submission) is NOT the same as an individual M-Pesa B2C
   * transfer having settled.
   *
   * CONTRACT, deliberately narrow and fail-closed (mirrors
   * fetchAuthoritativeCollectionStatus):
   *   - `verified` is true ONLY when the provider answered about the SAME
   *     tracking id we asked about AND returned a per-transaction array.
   *     Anything else — no credentials, a 4xx/5xx, a timeout, an unrecognised
   *     body, a mismatched id — is `verified: false` with a reason, and the only
   *     correct caller response is to confirm NOTHING.
   *   - Per-transaction status is normalised to a verdict by
   *     classifyPayoutTransactionStatus(), which maps every unrecognised code to
   *     'unknown'. Only 'completed' can ever complete a payout.
   *   - A transaction entry with no usable id is returned with
   *     `transactionId: null` rather than being dropped or guessed at, so the
   *     matcher refuses it instead of binding it to the wrong leg.
   *   - Never throws, never invents a status, never logs the secret key or the
   *     raw provider body.
   *   - Bounded by fetchWithTimeout (12s) so a webhook can never hang.
   *   - Honours the same sandbox/production base URL split as every other call.
   *
   * ASSUMPTION, STATED EXPLICITLY: the endpoint path (`/send-money/status/`) and
   * the request field (`tracking_id`) follow the same provider contract family as
   * the documented collection status endpoint. If a future IntaSend revision
   * changes either, this lookup returns `verified: false` and NOTHING is
   * confirmed — the failure mode is an inert feature, never a false completion.
   * Confirming the exact contract against the live provider is a Batch 1B item.
   */
  async fetchIntasendPayoutBatchStatus(
    trackingId: string,
  ): Promise<{
    verified: boolean;
    reason: string;
    providerTrackingId: string | null;
    transactions: Array<{ transactionId: string | null; providerStatus: string | null; verdict: PayoutTransactionVerdict }>;
  }> {
    type BatchStatusView = {
      verified: boolean;
      reason: string;
      providerTrackingId: string | null;
      transactions: Array<{ transactionId: string | null; providerStatus: string | null; verdict: PayoutTransactionVerdict }>;
    };
    const unverified = (reason: string, extra: Partial<BatchStatusView> = {}): BatchStatusView => ({
      verified: false,
      reason,
      providerTrackingId: null,
      transactions: [],
      ...extra,
    });

    const trimmed = String(trackingId || '').trim();
    if (!trimmed) return unverified('missing_tracking_id');

    const secretKey = process.env.INTASEND_SECRET_KEY;
    if (isPlaceholderKey(secretKey)) {
      // No real credentials means there is nothing authoritative to consult.
      // The simulation path must never be mistaken for evidence of a payout.
      return unverified('provider_credentials_unavailable');
    }

    let data: any;
    try {
      // CURRENT PROVIDER CONTRACT (IntaSend Send Money status):
      //   POST {base}/send-money/status/
      //   body: { "tracking_id": "<batch tracking id>" }
      //   response: { tracking_id, transactions: [ { transaction_id, status } ] }
      const response = await fetchWithTimeout(
        `${INTASEND_BASE_URL}/send-money/status/`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${secretKey}`,
          },
          body: JSON.stringify({ tracking_id: trimmed }),
        },
        12000
      );
      if (!response.ok) return unverified(`provider_http_${response.status}`);
      data = await response.json();
    } catch (error: any) {
      // Network error, DNS failure, provider outage or our own 12s timeout.
      return unverified('provider_request_failed');
    }

    // Identity must match the batch we asked about. A provider that answers with
    // a different batch is not evidence about this payout.
    const providerTrackingId = data?.tracking_id != null ? String(data.tracking_id) : null;
    if (!providerTrackingId || providerTrackingId !== trimmed) {
      return unverified('provider_tracking_identity_mismatch', { providerTrackingId });
    }

    const rawTransactions = data?.transactions ?? data?.disbursements;
    if (!Array.isArray(rawTransactions)) {
      // Guessing at a shape we do not control is the failure mode this method
      // exists to close, so an unexpected body is unverified, never inferred.
      return unverified('provider_response_unrecognised', { providerTrackingId });
    }

    const transactions = rawTransactions.map((entry: any) => {
      // BATCH 1B — the MACHINE-READABLE `status_code` is the authority; the
      // human-readable `status` label is only a documented fallback. This
      // response carries BOTH (e.g. { status: "Successful", status_code:
      // "TS100" }); reading the label first left `TS100` unrecognised, so a
      // transfer the provider had genuinely completed classified as 'unknown'
      // and its payout leg — and the settlement behind it — stayed unresolved
      // forever. See readProviderTransactionStatus() in config/payoutOutcomes.ts
      // for the precedence rule and the fail-closed label-only behaviour.
      const { providerStatus, verdict } = readProviderTransactionStatus(entry);
      const transactionId =
        entry?.transaction_id != null ? String(entry.transaction_id)
          : entry?.id != null ? String(entry.id)
            : null;
      return {
        transactionId,
        providerStatus,
        verdict,
      };
    });

    // Log the shape and the counts only — never the secret, never a phone
    // number, never the raw provider body.
    console.warn('[INTASEND PAYOUT LOOKUP] Batch status resolved; handing per-transaction verdicts to reconciliation.', {
      tracking_id: providerTrackingId,
      transactions: transactions.length,
      completed: transactions.filter(t => t.verdict === 'completed').length,
    });

    return { verified: true, reason: 'provider_status_retrieved', providerTrackingId, transactions };
  },

  /**
   * Triggers split disbursements to Finders and Agents using IntaSend Payouts/Disbursements API
   */
  /**
   * Sends a batch M-Pesa payout via IntaSend's send-money API and returns a
   * PER-RECIPIENT result, not one aggregate success/failure for the whole
   * batch. This matters because IntaSend's send-money endpoint accepts
   * multiple transactions in a single call, and a batch can partially
   * succeed — e.g. the finder's number is valid and processes, while the
   * agent's till number is wrong and fails. Collapsing that into one
   * boolean would either falsely mark BOTH as failed (retrying the
   * finder's payout a second time — a duplicate payment) or falsely mark
   * BOTH as succeeded (silently never paying the agent).
   *
   * Equally important: HTTP 200 from IntaSend only means "the batch was
   * accepted for processing" — M-Pesa B2C disbursement is asynchronous, so
   * acceptance is not the same as money having actually arrived. Every
   * result from the real (non-simulated) path is therefore reported as
   * 'pending', never 'success', regardless of the HTTP status — this
   * function cannot honestly claim a transfer completed without an actual
   * confirmation, which IntaSend does not return synchronously here. The
   * caller (executeClaimSettlement in server.ts) is responsible for
   * treating 'pending' as "accepted, awaiting reconciliation" rather than
   * "done", and only the simulation path (no real credentials configured)
   * reports 'success' immediately, since there's no real money movement to
   * wait on.
   *
   * BATCH 1B-C1-R1 — the three states, named explicitly, because collapsing
   * them is exactly what produced the refund false-completion defect (see
   * triggerIntasendRefund below):
   *
   *   * initiation accepted — an HTTP 2xx from /send-money/initiate/. The
   *                          provider took the request; nothing has
   *                          necessarily been transferred.
   *   * approval pending    — `"status_code": "BP103"`, "Preview and approve":
   *                          the batch is only a preview and pays NOTHING
   *                          until it is approved in a separate call.
   *   * confirmed success   — the provider reports THIS individual
   *                          transaction as `"status_code": "TS100"`.
   *
   * The payout path never crosses from the first state to the third: its legs
   * are reported 'pending' and only the authoritative status lookup
   * (services/payoutReconciliation.ts) may complete them.
   */
  async triggerIntasendPayout(
    claimId: string,
    payouts: Array<{ destination: string; amount: number; payoutMethodType?: string; recipientType: 'finder' | 'agent' }>
  ): Promise<{ batchId: string | null; results: Array<{ recipientType: 'finder' | 'agent'; destination: string; providerTransactionId: string | null; status: 'success' | 'pending' | 'failed' | 'unknown' }> }> {
    const secretKey = process.env.INTASEND_SECRET_KEY;
    // BATCH 1 CORRECTION A — the ONE predicate for "this attempt would have to
    // be simulated", shared with the executor's preflight so the two cannot
    // disagree. The branch below is unchanged in behaviour: the condition is the
    // same one it always was (a missing/empty/placeholder key), and an
    // unrecognised NODE_ENV still refuses rather than simulating.
    if (isPayoutSimulationRequired(secretKey)) {
      // Same fail-closed guarantee as triggerMpesaStkPush above — never
      // fabricate a 'success' payout result outside an explicitly recognised
      // simulation environment. Unlike the STK
      // push path, this doesn't write directly to the ledger itself (the
      // caller does, via recordPayoutAttempt), but reporting 'success'
      // here is exactly as dangerous: it would cause the caller to mark a
      // finder/agent payout as genuinely completed when no real M-Pesa
      // transfer occurred.
      // BATCH 1 — the same positive allow-list the collection and refund gates
      // apply (see PAYMENT_SIMULATION_ENVS above). Simulated legs are reported
      // 'success' by the branch below, so an environment that merely fails to
      // say "production" must never reach it: 'staging', an unset or empty
      // NODE_ENV, a misspelling or any other unrecognised value refuses here,
      // before any fabricated payout success exists.
      if (!isPaymentSimulationEnvironment(process.env.NODE_ENV)) {
        throw new Error(
          'FATAL: IntaSend secret key is missing or still a placeholder value, and NODE_ENV is ' +
          `${describeNodeEnvForRefusal(process.env.NODE_ENV)}, which is not a payout-simulation environment. ` +
          'Refusing to simulate a payout in a production-like environment: reporting success for a transfer that ' +
          "never happened would mark a finder's or agent's money as paid with nothing sent. Set NODE_ENV to " +
          '"development" or "test" for local simulation, or configure a real INTASEND_SECRET_KEY before processing settlements.'
        );
      }

      console.warn('[INTASEND DISBURSEMENT] Key missing/dummy (development/test environment only). Emulating disbursement split.');
      const batchId = 'SIM-BATCH-' + Math.random().toString(36).substring(2, 10).toUpperCase();
      return {
        batchId,
        results: payouts.map(p => ({
          recipientType: p.recipientType,
          destination: p.destination,
          providerTransactionId: 'SIM-' + Math.random().toString(36).substring(2, 10).toUpperCase(),
          status: 'success' as const,
        })),
      };
    }

    // PRODUCTION FAIL-CLOSED WALLET CONFIGURATION
    //
    // Service-level gate at the request seam, deliberately INDEPENDENT of the
    // API-secret check above: a valid production secret key does NOT imply a
    // configured disbursement wallet. This statement lives OUTSIDE the
    // placeholder-key branch, so it is reached on the normal production request
    // path (a real key skips the simulation return above and evaluates this
    // gate before the initiation request is built or sent). A missing, empty,
    // whitespace-only or placeholder-shaped INTASEND_DISBURSEMENT_WALLET_ID
    // (the documented .env.example value included) therefore fails closed
    // here — never a silent fallback to the provider's default settlement
    // wallet for that currency.
    //
    // This is the second line of defence behind the earlier gate in
    // executeClaimSettlement(), which runs before any payout row is marked as
    // submitted and gives the release lock back through abandonRelease(). This
    // throw performs no ledger write and takes no claim state transition of its
    // own, so it cannot itself strand a payout row as submitted.
    //
    // Non-production environments never apply this gate, and never send a
    // configured production wallet ID to a sandbox/test provider.
    // BATCH 2 — ONE ROUTING DECISION, TWO REFUSALS.
    //
    // resolveConfiguredPayoutWalletRouting() answers both questions this seam
    // must ask before a payout request exists:
    //   1. is a usable working-wallet ID configured? (the pre-existing gate), and
    //   2. is that ID the declared collection/settlement wallet? (new)
    //
    // A wallet that both receives collections and pays disbursements re-creates
    // the provider default this configuration exists to avoid: collected funds
    // and payout float become one indistinguishable balance. The refusal happens
    // here, before the request body is built, and again in executeClaimSettlement()
    // before any durable pre-submission marker is written.
    const walletRouting = resolveConfiguredPayoutWalletRouting();
    if (!walletRouting.ok) {
      throw new Error(`FATAL: ${walletRouting.message}`);
    }

    // BATCH 1B-C1 — the payload and its binding inputs are built together, so
    // the EXACT account submitted for a leg is the same string used to correlate
    // the provider's per-transaction response back to that leg (see
    // resolvePayoutTransactionBindings). Deriving them separately is how the two
    // could drift apart.
    const submittedLegs = payouts.map(p => {
      let cleanAccount = p.destination;
      const method = p.payoutMethodType || 'Personal M-Pesa';

      // Standardize phone format if it is a personal phone destination (Personal M-Pesa or Pochi la Biashara)
      if (method === 'Personal M-Pesa' || method === 'Pochi la Biashara' || p.recipientType === 'finder') {
        cleanAccount = formatMpesaPhone(p.destination);
      }

      return {
        recipientType: p.recipientType,
        destination: p.destination,
        amount: p.amount,
        account: cleanAccount,
        narrative: `R4M-${p.recipientType.toUpperCase()}-${claimId}`,
        // Per-transaction provider idempotency: a pure function of this leg's
        // stable local identity (claim + role), identical on every submission
        // attempt of the same leg and distinct for the finder and the agent.
        idempotencyKey: buildPayoutLegIdempotencyKey(claimId, p.recipientType),
      };
    });

    const transactions = submittedLegs.map(leg => ({
      name: `Return4me ${leg.recipientType === 'finder' ? 'Finder' : 'Agent'}`,
      account: leg.account,
      amount: String(leg.amount),
      narrative: leg.narrative,
      idempotency_key: leg.idempotencyKey,
    }));

    // BATCH P2 — EXPLICIT, DOCUMENTED APPROVAL MODE.
    //
    // IntaSend's send-money contract offers two modes:
    //   * `requires_approval: "NO"`   — the documented automated-payout mode; the
    //     batch is created and disbursed without a separate human approval step.
    //   * (default / "YES")            — the batch is created in the BP103
    //     "Preview and approve" state and pays NOTHING until a separate approval
    //     call is made from the dashboard/API.
    //
    // The intended approval gate for a Return4me payout is the platform's OWN
    // durable administrator settlement approval (server.ts executeClaimSettlement
    // re-checks `settlement_approved_at` and the 'releasing' lock immediately
    // before this request). That internal gate is NOT bypassed or relaxed here.
    // `requires_approval: "NO"` therefore tells the PROVIDER "do not add a second,
    // human-in-the-loop approval on top of the one we already made" — without
    // which the batch silently parks in BP103 and no money ever moves.
    //
    // If the provider STILL answers BP103 (e.g. an account-level setting forces
    // approval regardless), the response is handled explicitly below: it is never
    // treated as a completed payout, never auto-retried, and never settles the
    // claim — it is surfaced for operator review with the batch reference kept.
    const payload = {
      provider: 'MPESA-B2C',
      currency: 'KES',
      requires_approval: 'NO',
      transactions,
    };

    // PRODUCTION FAIL-CLOSED WALLET SELECTION
    //
    // executeClaimSettlement() enforces the production configuration guard
    // BEFORE the per-row CAS markers are written (see server.ts), so a missing
    // value can never leave a payout marked as submitted. In non-production
    // environments the configured wallet is never sent to the provider.
    const disbursementWalletId =
      process.env.NODE_ENV === 'production' ? getDisbursementWalletId() : null;

    // wallet_id is an optional, documented field on the initiation request.
    // It is injected only when a production disbursement wallet is configured.
    const requestBody = {
      ...payload,
      ...(disbursementWalletId !== null ? { wallet_id: disbursementWalletId } : {}),
    };


    console.log('[INTASEND DISBURSEMENT] Initiating payouts split:', JSON.stringify({
      ...payload,
      transactions: payload.transactions.map(t => ({ ...t, account: maskPhoneForLog(t.account) })),
    }, null, 2));

    try {
      const response = await fetchWithTimeout(`${INTASEND_BASE_URL}${INTASEND_SEND_MONEY_INITIATE_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${secretKey}`,
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.warn(`[INTASEND DISBURSEMENT] API error (${response.status}): ${errorText.substring(0, 200)}.`);
        // E3A / PHASE 1 F1 — A NON-2xx RESPONSE IS NOT ONE FACT.
        //
        // A status class alone never proves that no transfer executed. The
        // classification below is deliberately conservative about which
        // statuses are even ALLOWED to be recorded as a refusal:
        //
        //   * 5xx — the provider (or its gateway) failed while handling an
        //     already-transmitted request. It may have accepted and executed the
        //     batch before the error surfaced → 'unknown'.
        //   * 408 Request Timeout, 499 (client closed) → the request may have
        //     been received and processed → 'unknown'.
        //   * 409 (duplicate idempotency key) → the provider may be rejecting a
        //     repeat of a request it ALREADY EXECUTED. This is the canonical
        //     ambiguity, not a refusal → 'unknown'.
        //   * 429 (rate limited) → a limiter may reject a request that was
        //     already forwarded; ambiguity cannot be excluded → 'unknown'.
        //   * an unexpected 3xx surfaced by fetch → the request may have been
        //     redirected and processed → 'unknown'.
        //
        // Everything else (400/401/403/404/422/…) is recorded as 'failed', which
        // this codebase persists as payout_outcome 'rejected'. That value means
        // ONLY "the submission path recorded a refusal-class failure": the HTTP
        // status is not persisted, the provider's key-retention semantics are
        // unproven, and an audited repair therefore requires separately imported
        // provider evidence (see config/payoutRepairPolicy.ts). It is never
        // treated as proof of non-execution by the repair policy.
        const mayHaveBeenProcessed =
          classifyPayoutSubmissionHttpFailure(response.status) === 'ambiguous';
        return {
          batchId: null,
          results: payouts.map(p => ({
            recipientType: p.recipientType,
            destination: p.destination,
            providerTransactionId: null,
            status: mayHaveBeenProcessed ? ('unknown' as const) : ('failed' as const),
          })),
        };
      }

      const data = await response.json() as any;
      // Deliberately not logging the full raw response body — its exact
      // shape (and whether individual transaction objects echo phone
      // numbers back) isn't something this codebase can fully verify
      // without live IntaSend credentials. Log only what's actually used
      // plus the response's top-level shape, not verbatim PII-bearing
      // content from a third party.
      console.log('[INTASEND DISBURSEMENT] Response received. Top-level keys:', Object.keys(data || {}), 'tracking_id:', data?.tracking_id || data?.batch_reference || '(none)');

      // Safe audit log: record ONLY the wallet_id the provider debited from.
      // No balances, no PII, and no full response body are logged here.
      console.log(
        '[INTASEND DISBURSEMENT] Initiation response debited wallet:',
        data?.wallet?.wallet_id ?? null
      );


      const batchId: string | null = data?.tracking_id || data?.batch_reference || null;

      // BATCH P2 — BP103 IS NOT AN ACCEPTED BATCH, AND NEVER A COMPLETED ONE.
      //
      // IntaSend signals a batch parked in "Preview and approve" with the batch-
      // level status code `BP103` (see isBatchApprovalRequired in
      // config/payoutOutcomes.ts). Such a batch pays NOTHING until it is approved
      // through a separate, out-of-band step. Presenting it as an ordinary
      // accepted batch ('pending') would be a lie the settlement path would act
      // on; presenting it as success would be worse. So:
      //   * every leg is reported 'unknown' — the UNRESOLVED, never-auto-resubmitted
      //     state — so executeClaimSettlement returns the claim to pending_settlement
      //     and flags it for provider reconciliation instead of finalizing;
      //   * the provider batch reference is preserved (batchId is returned) so the
      //     operator can locate the exact batch in IntaSend;
      //   * we do NOT call an undocumented approval endpoint and do NOT retry —
      //     approval is a human/account action, and a retry could double-pay.
      //
      // The response is otherwise parsed normally when BP103 is absent: an
      // unrecognised batch-level code is left to the existing fail-closed binding
      // (which only ever yields 'pending', never 'success').
      if (isBatchApprovalRequired(data)) {
        console.warn(
          `[INTASEND DISBURSEMENT] Batch ${batchId ?? '(no ref)'} is parked in BP103 "Preview and approve": ` +
          'the provider requires a separate approval before any money moves, despite requires_approval:"NO". ' +
          'Approve the batch in the IntaSend dashboard/API (this app will not call an undocumented approval endpoint ' +
          'and will not auto-retry). Recorded as UNRESOLVED for operator reconciliation — the claim is NOT settled.',
        );
        return {
          batchId,
          results: payouts.map(p => ({
            recipientType: p.recipientType,
            destination: p.destination,
            providerTransactionId: null,
            status: 'unknown' as const,
          })),
        };
      }

      // BATCH 1B-C1 — EXPLICIT, FAIL-CLOSED BINDING (replaces the suffix guess).
      //
      // What used to happen here: each recipient was matched to a response
      // transaction by the LAST NINE DIGITS of its destination account, which is
      // ambiguous whenever two destinations share a suffix (a phone number and a
      // till number are both digit strings) and could therefore record the SAME
      // provider transaction id on two ledger legs.
      //
      // What happens now: resolvePayoutTransactionBindings() correlates a
      // response transaction to a leg ONLY by an exact match on the account we
      // submitted, and ONLY when that account is unique among the submitted legs
      // and matches exactly one response entry that carries the provider's own
      // `transaction_id`. Anything else — a missing account, a duplicated local
      // account, no match, several matches, or a match with no usable id — yields
      // `providerTransactionId: null`.
      //
      // A leg left without a transaction id is NOT a lost payout: the batch id is
      // still recorded, the leg's outcome stays 'pending' (accepted, not
      // confirmed), and it can only ever be resolved by the authoritative status
      // lookup in services/payoutReconciliation.ts — which itself refuses to
      // confirm a leg it cannot bind to exactly one provider transaction, and
      // records PAYOUT_VERIFICATION_UNMATCHED for an operator. No id is invented
      // here, and nothing here can complete a payout or release a settlement.
      //
      // Only the DOCUMENTED per-transaction fields are read. The array of
      // alternative key names this block used to probe
      // (invoices/disbursements/phone_number/destination/id/invoice) is gone:
      // guessing at a shape we do not control is the failure mode this batch
      // closes. An unrecognised body degrades to "no transaction ids bound",
      // never to a wrong one.
      const binding = resolvePayoutTransactionBindings(
        submittedLegs.map(leg => ({ id: leg.recipientType, account: leg.account })),
        Array.isArray(data?.transactions) ? data.transactions : [],
      );

      const results = submittedLegs.map((leg, index) => ({
        recipientType: leg.recipientType,
        destination: leg.destination,
        providerTransactionId: binding.bindings[index]?.providerTransactionId ?? null,
        // Deliberately 'pending', not 'success' — see function docstring.
        // IntaSend accepting the batch is not the same as the M-Pesa B2C
        // transfer having actually completed.
        status: 'pending' as const,
      }));

      // Evidence for the operator: which legs could not be bound and why. Codes
      // only — no account, no phone number, no raw provider body.
      const unbound = binding.bindings.filter(entry => entry.providerTransactionId === null);
      if (unbound.length > 0) {
        console.warn(
          `[INTASEND DISBURSEMENT] ${unbound.length} of ${binding.bindings.length} leg(s) were not bound to a provider transaction ` +
          `(${unbound.map(entry => `${entry.id}:${entry.outcome}`).join(', ')}${
            binding.unmatchedProviderTransactions > 0
              ? `; ${binding.unmatchedProviderTransactions} unmatched provider transaction(s)`
              : ''
          }). Batch ${batchId || '(none)'} retained; those legs stay unresolved for provider reconciliation.`
        );
      }

      return { batchId, results };
    } catch (error: any) {
      console.warn('[INTASEND DISBURSEMENT] Disbursement split exception:', error.message);
      // 'unknown', not 'failed' — a network/timeout error here means we
      // genuinely don't know whether IntaSend received and is processing
      // the request. Treating this as definitively failed risks a
      // duplicate disbursement if a retry fires while the original request
      // actually went through; 'unknown' is recorded as an unresolved outcome
      // that is never resubmitted automatically (E3A — see
      // src/config/payoutOutcomes.ts), and is surfaced for provider
      // reconciliation instead.
      return {
        batchId: null,
        results: payouts.map(p => ({ recipientType: p.recipientType, destination: p.destination, providerTransactionId: null, status: 'unknown' as const })),
      };
    }
  },

  /**
   * Sends a real M-Pesa refund to a claimant who paid into escrow but lost
   * a dispute resolution. Deliberately separate from triggerIntasendPayout
   * (rather than reusing it with a 1-item array) so refund failures are
   * never confused with finder/agent payout failures in logs — the two
   * cases need different admin follow-up.
   *
   * BATCH 1B-C1-R1 — A 2xx FROM THE INITIATION ENDPOINT IS NOT A REFUND.
   *
   * `POST /send-money/initiate/` INITIATES a disbursement; it does not settle
   * one. Until R1 ANY 2xx was reported as `outcome: 'completed'`, so the caller
   * (routes/adminDisputes.ts) marked the claim 'refunded' and told the customer
   * their refund was complete — including for a batch that only needs merchant
   * approval, whose documented response is a 200 carrying
   * `"status_code": "BP103"`, `"status": "Preview and approve"` and pays
   * nothing until it is approved in a separate call. That is a false
   * completion: no money moved, the claimant's escrow balance was never
   * returned, and the reconciliation workflow that exists for exactly this was
   * never reached.
   *
   * BATCH 1B-C1-R2 — NO INITIATION RESPONSE CAN COMPLETE A REFUND AT ALL.
   *
   * R1 narrowed the false completion to "only a per-transaction TS100 in the
   * initiation response completes". That was still wrong. The initiation
   * response is a SUBMISSION RECEIPT, not a settlement record:
   *
   *   * the documented response for a freshly accepted transaction is
   *     `{ "transaction_id": "…", "status": "Pending", "status_code": "TP101" }`
   *     — a snapshot taken when the batch was accepted, not a settlement fact;
   *   * the SAME endpoint answers 200 with
   *     `{ "status_code": "BP103", "status": "Preview and approve" }` for a
   *     batch that pays NOTHING until a separate approval call is made, and that
   *     response can carry per-transaction entries too;
   *   * nothing in the documented contract makes this endpoint authoritative for
   *     final settlement, and a body that merely echoes or replays a status is
   *     not proof that THIS transfer settled.
   *
   * A `TS100` read out of an initiation body is therefore NOT proof of transfer
   * and MUST NOT complete a refund. There is no code-vocabulary reading here any
   * more: EVERY 2xx from the initiation endpoint is reported as
   * `outcome: 'unknown'`. Provider identifiers that were genuinely returned are
   * preserved for reconciliation (see summarizeRefundInitiationResponse below),
   * and none is ever invented.
   *
   * The claim therefore stays locked in 'refunding' for the existing admin
   * reconciliation workflow (getRefundReconciliationClaims /
   * finalizeClaimRefund / revertClaimRefundLock), and no completion
   * notification is produced.
   *
   * AUTHORITATIVE CONFIRMATION DOES NOT EXIST YET FOR REFUNDS. The payout path
   * has one — services/payoutReconciliation.ts over
   * PaymentService.getPayoutBatchStatus, which reads the provider's batch status
   * and accepts only its documented terminal codes — but no refund-status
   * lookup, webhook or callback is implemented in this codebase today. Until one
   * is added and verified, an initiated refund is completed ONLY by an operator
   * who has confirmed the transfer with IntaSend and records that outcome
   * through the admin refund-reconciliation endpoints. That is a real,
   * deliberate operational limitation; it is NOT disguised by reporting the
   * initiation as a success.
   *
   * The payload is deliberately left alone. This path submits at most ONE
   * transaction per claim and is reached at most once per claim (the
   * resolved_at compare-and-swap inside resolveDispute is the guard), and
   * nothing auto-retries an ambiguous refund, so no refund idempotency key is
   * introduced here.
   *
   * The no-credentials branch is now a FAIL-CLOSED ALLOW-LIST rather than a
   * production-only deny-list: it emulates a completed refund ONLY when
   * NODE_ENV is exactly 'development' or 'test'. 'production', an UNSET
   * NODE_ENV, and any unrecognised value ('prod', 'Production', 'staging') all
   * throw before a simulated success can be produced. The previous exact-string
   * check (`=== 'production'`) failed OPEN for every value it did not recognise,
   * so a misconfigured deployment could report a fabricated 'completed' refund
   * that the caller reads as "the money moved". The caller treats
   * 'completed' as "the money moved" — it finalizes the claim as refunded and
   * notifies the customer — so an environment that is not positively recognised
   * as non-production must never reach a simulated completion.
   * (triggerIntasendPayout and triggerMpesaStkPush used to keep the older
   * production-only check. BATCH 1 tightened BOTH of them to this same
   * allow-list — see PAYMENT_SIMULATION_ENVS — so all three money gates now
   * refuse simulation in every environment that is not exactly 'development'
   * or 'test'.)
   *
   * R2 reachability note: the caller's `outcome === 'completed'` branch is
   * retained for a future authoritative confirmation, but it is NOT reachable
   * from this function's HTTP path any more — against a real credential this
   * function can only return 'unknown' or 'failed'. The simulation branch below
   * is the single exception: it is reachable ONLY when NODE_ENV is exactly
   * 'development' or 'test', and it throws for every other value (production,
   * unset, or unrecognised).
   */
  async triggerIntasendRefund(
    phone: string,
    amount: number,
    claimId: string
  ): Promise<{ success: boolean; transactionId: string; providerBatchId: string | null; outcome: 'completed' | 'failed' | 'unknown' }> {
    const secretKey = process.env.INTASEND_SECRET_KEY;
    if (isPlaceholderKey(secretKey)) {
      // Fail-closed allow-list; the full rationale is in the docstring above.
      // BATCH 1: this now delegates to the ONE shared predicate so the refund,
      // collection and payout gates cannot drift apart. Behaviour is unchanged
      // (it was already exactly this allow-list), so the refusal message below
      // is kept verbatim.
      if (!isPaymentSimulationEnvironment(process.env.NODE_ENV)) {
        throw new Error(
          `FATAL: IntaSend secret key is missing or a placeholder and NODE_ENV is ` +
          `${describeNodeEnvForRefusal(process.env.NODE_ENV)}, which is not a non-production simulation environment. ` +
          'Refusing to simulate a refund: a simulated completion would mark the claim as refunded and tell the ' +
          'customer their money was returned when no transfer was made. Set NODE_ENV to "development" or "test", ' +
          'or configure a real INTASEND_SECRET_KEY.'
        );
      }
      console.warn('[INTASEND REFUND] Key missing/dummy (development/test only). Emulating refund disbursement.');
      return {
        success: true,
        transactionId: 'SIM-REFUND-' + Math.random().toString(36).substring(2, 10).toUpperCase(),
        providerBatchId: null,
        outcome: 'completed',
      };
    }

    const payload = {
      provider: 'MPESA-B2C',
      currency: 'KES',
      transactions: [{
        name: 'Return4me Refund',
        account: formatMpesaPhone(phone),
        amount: String(amount),
        narrative: `R4M-REFUND-${claimId}`,
      }],
    };

    console.log('[INTASEND REFUND] Initiating refund disbursement:', JSON.stringify({
      ...payload,
      transactions: payload.transactions.map(t => ({ ...t, account: maskPhoneForLog(t.account) })),
    }, null, 2));

    try {
      const response = await fetchWithTimeout(`${INTASEND_BASE_URL}${INTASEND_SEND_MONEY_INITIATE_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${secretKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        // BATCH 1B-C1-R2 — the provider's ERROR BODY is never read and never
        // logged. IntaSend echoes submission data back in validation errors
        // (recipient name, account/phone, narrative), so truncating it is not
        // sanitising it. The HTTP status is the whole operational signal we need.
        console.warn(`[INTASEND REFUND] Provider did not accept the refund initiation request (HTTP ${response.status}).`);
        // The E3A ambiguity rule, applied here exactly as the payout path above
        // applies it. A non-2xx is NOT one fact:
        //   * 5xx — the provider (or its gateway) failed while handling a
        //     request it had already received. It may have accepted — and
        //     executed — the refund before the error surfaced, so this is
        //     'unknown'.
        //   * 408 Request Timeout — same ambiguity.
        //   * 429 Too Many Requests — a rate-limit response is NOT proof that the
        //     request was refused before execution. It reached the provider (or a
        //     gateway in front of it) far enough to be counted/rescheduled, so
        //     execution cannot be ruled out from this status alone. Classifying it
        //     as 'failed' would let the caller release the refund lock (claim
        //     'rejected') for a transfer that may already be queued — the same
        //     duplicate-refund risk as a 5xx — so it is UNRESOLVED and requires
        //     operator reconciliation.
        //   * every other non-ok status (400/401/403/404/409/422/… and an
        //     unexpected 3xx surfaced by fetch) means the provider refused the
        //     request itself with no transfer executed, so 'failed' is safe
        //     (and is what lets the caller revert the refund lock and ask an
        //     admin to act).
        const mayHaveBeenProcessed =
          response.status === 408 || response.status === 429 || response.status >= 500;
        return {
          success: false,
          transactionId: '',
          providerBatchId: null,
          outcome: mayHaveBeenProcessed ? 'unknown' : 'failed',
        };
      }

      let data: any;
      try {
        data = await response.json();
      } catch {
        // A 2xx whose body cannot be parsed carries NO evidence about the
        // individual transaction. That is neither a rejection nor a success:
        // the refund may already have been accepted and executed, so it is
        // unresolved and must be reconciled, never finalized.
        console.warn('[INTASEND REFUND] HTTP 2xx but the response body was not valid JSON — refund outcome unverified.');
        return { success: false, transactionId: '', providerBatchId: null, outcome: 'unknown' };
      }
      // BATCH 1B-C1-R2 — A 2xx FROM THE INITIATION ENDPOINT IS ACCEPTANCE, NOT
      // SETTLEMENT, and is reported as 'unknown' WITHOUT EXCEPTION. The response
      // is read only through a deliberate, safe operational projection (see
      // summarizeRefundInitiationResponse below): HTTP status, top-level key
      // NAMES, and provider identifiers/status codes. The raw body is never
      // logged — it echoes the recipient's name, account/phone and narrative and
      // can carry wallet/approval secrets — and it is never interpreted as
      // evidence that the individual refund settled, not even when it carries
      // TS100 (see the "NO INITIATION RESPONSE CAN COMPLETE A REFUND" note in
      // this function's docstring).
      const summary = summarizeRefundInitiationResponse(response.status, data);
      console.log('[INTASEND REFUND] Initiation response received (operational summary only):', JSON.stringify(summary));

      console.warn(
        `[INTASEND REFUND] Initiation accepted (HTTP ${summary.httpStatus}) but an initiation response is NOT ` +
        `evidence that the refund was paid out (transaction status: ${summary.transactions[0]?.providerStatus ?? 'absent'}, ` +
        `transactions: ${summary.transactionCount}). Recording an UNRESOLVED outcome; the claim stays in 'refunding' ` +
        `for reconciliation and no completion notification is produced.` +
        (summary.providerTrackingId ? ` Provider batch/tracking id: ${summary.providerTrackingId}.` : '')
      );

      return {
        success: false,
        // The provider's own per-transaction id, and only when exactly ONE
        // transaction entry was returned: with two or more there is no way to
        // prove which entry is this refund, so nothing is attributed. Never
        // synthesized; empty when the provider supplied none.
        transactionId: summary.transactionCount === 1 ? (summary.transactions[0].providerTransactionId ?? '') : '',
        providerBatchId: summary.providerTrackingId,
        outcome: 'unknown',
      };
    } catch {
      // A fixed, non-sensitive reason category only. An exception message can
      // embed the request URL, the provider's error text (which echoes
      // recipient data) or other submission content, so it is never
      // interpolated into a log line. BATCH 1B-C1-R2.
      console.warn('[INTASEND REFUND] Refund initiation failed with a transport/exception error; refund outcome unverified.');
      // 'unknown', not 'failed' — a network/timeout exception here means we
      // genuinely don't know whether IntaSend received and executed the
      // refund. Treating this as definitively failed (the pre-FIX#4 behavior)
      // reverted the claim to terminal 'rejected' while the owner's money may
      // actually have been sent — a silent reconciliation divergence, and any
      // retry path could double-refund. Mirroring triggerIntasendPayout's
      // established principle: an ambiguous provider response must be treated
      // as UNKNOWN, leaving the claim in 'refunding' for manual admin/provider
      // reconciliation. No automatic retry is issued from this outcome.
      return { success: false, transactionId: '', providerBatchId: null, outcome: 'unknown' };
    }
  },

  /**
   * Card payment is not offered or supported.
   */
  async processCardPayment(
    email: string,
    amount: number,
    cardNumber: string,
    claimId: string
  ): Promise<{ success: boolean; paymentReference: string; message: string }> {
    throw new Error('Card payments are not currently active or supported. Please use M-Pesa STK Push.');
  },
};

// --- HELPER UTILITIES ---

function formatMpesaPhone(phone: string): string {
  let clean = phone.replace(/\D/g, ''); // Keep numbers only
  if (clean.startsWith('0')) {
    clean = '254' + clean.slice(1);
  } else if (clean.startsWith('7') || clean.startsWith('1')) {
    clean = '254' + clean;
  }
  return clean;
}

/**
 * BATCH 1B-C1-R2 — the SAFE, OPERATIONAL view of a refund INITIATION response.
 *
 * WHAT THIS FUNCTION IS NOT
 * -------------------------
 * It returns NO verdict, NO completion flag and NO settlement claim of any
 * kind. There is deliberately nothing it can produce that would let a caller
 * treat an initiation as a finished refund: the shape itself makes "the
 * provider said TS100, so it is paid" unrepresentable. triggerIntasendRefund
 * reports every 2xx as 'unknown' without consulting a status code for a
 * decision.
 *
 * WHY (BATCH 1B-C1-R1 -> R2)
 * --------------------------
 * R1 read the per-transaction `status_code` out of this response and let TS100
 * complete a refund. That was still a false completion: `POST
 * /send-money/initiate/` is an initiation call. Its documented responses include
 *
 *   { "status_code": "BP103", "status": "Preview and approve", … }
 *     — a batch that pays nothing until a separate approval call is made;
 *   { "transaction_id": "KQ9PLXR", "status": "Pending", "status_code": "TP101" }
 *     — an accepted transaction, snapshotted at submission time.
 *
 * Neither is settlement, and a TS100 inside an initiation body cannot be
 * distinguished from replayed or unrelated data. Settlement can only be
 * established by an authoritative provider status/callback mechanism — which
 * DOES NOT EXIST YET for refunds in this codebase (the payout path's
 * services/payoutReconciliation.ts is the only such mechanism, and it covers
 * payouts, not refunds).
 *
 * WHAT IS READ (diagnostics for the operator and future reconciliation)
 * --------------------------------------------------------------------
 *   * the HTTP status
 *   * the response's top-level KEY NAMES — never their values
 *   * the provider's own batch `tracking_id`
 *   * the transaction count
 *   * per-transaction `transaction_id` and the status code chosen by the ONE
 *     documented precedence rule (status_code, then status — reused from
 *     config/payoutOutcomes.ts so it cannot drift). The code is recorded as a
 *     DIAGNOSTIC STRING only; the verdict that comes with it is dropped here on
 *     purpose and is never returned.
 *
 * WHAT IS NEVER READ, RETURNED OR LOGGED
 * --------------------------------------
 *   * `account` / `phone_number` — a third party's phone number
 *   * `name` — the recipient's name
 *   * `narrative` / submission text
 *   * wallet balances, approval nonces, or any other secret
 *
 * Identifiers are PRESERVED but never invented: a missing `tracking_id` or
 * `transaction_id` becomes null, and nothing is synthesized.
 */
function summarizeRefundInitiationResponse(httpStatus: number, data: unknown): {
  httpStatus: number;
  responseKeys: string[];
  providerTrackingId: string | null;
  transactionCount: number;
  transactions: Array<{ providerTransactionId: string | null; providerStatus: string | null }>;
} {
  const record: Record<string, unknown> =
    data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const usable = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  };
  // The provider's own transaction reference. A numeric id is a legitimate
  // identifier (JSON serializers emit digits as numbers); anything else, and
  // anything absent, yields null — never a synthesized id.
  const providerTransactionId = (entry: unknown): string | null => {
    if (entry === null || typeof entry !== 'object') return null;
    const raw = (entry as Record<string, unknown>).transaction_id;
    if (typeof raw !== 'string' && typeof raw !== 'number') return null;
    return usable(String(raw));
  };

  const entries = Array.isArray(record.transactions) ? record.transactions : [];

  return {
    httpStatus,
    // Key NAMES only: no value from the response is copied out of this branch.
    responseKeys: Object.keys(record),
    providerTrackingId: usable(record.tracking_id),
    transactionCount: entries.length,
    transactions: entries.map((entry) => ({
      providerTransactionId: providerTransactionId(entry),
      // The precedence rule is reused from the ONE place that owns it
      // (config/payoutOutcomes.ts). The verdict that call also computes is
      // dropped here deliberately: this function must not be able to report a
      // success, so nothing downstream can mistake a diagnostic code for a
      // settlement decision.
      providerStatus: readProviderTransactionStatus(entry).providerStatus,
    })),
  };
}
