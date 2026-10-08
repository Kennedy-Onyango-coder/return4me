import { db } from '../db/database';

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

// Recognizes an unset/placeholder API key under any of the common
// conventions used across this project's own .env.example (REPLACE_WITH...)
// and the ones commonly used when an assistant or teammate fills in a .env
// file for you (placeholder, your_key_here, xxx, changeme, etc.). Missing
// just one of these was the actual root cause of "payment simulation loads
// and does nothing": a key literally set to the word "placeholder" wasn't
// recognized as fake, so the app made a real network call with an invalid
// key instead of using the safe built-in simulation.
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
  ): Promise<{ success: boolean; checkoutRequestId: string; mpesaReceiptCode: string; message: string }> {
    const formattedPhone = formatMpesaPhone(phone);
    const publishableKey = process.env.INTASEND_PUBLISHABLE_KEY;
    const secretKey = process.env.INTASEND_SECRET_KEY;

    // Helper generator for simulated payment when keys are dummy or API is down
    const generateMockStkPushSuccess = async (phoneNumber: string, amt: number, cId: string) => {
      const invoiceId = 'INV-' + Math.random().toString(36).substring(2, 10).toUpperCase();
      const receiptCode = 'MPX' + Math.floor(100000 + Math.random() * 900000).toString();

      await db.logTransaction({
        claim_id: cId,
        item_id: null,
        type: 'payment_received',
        amount: amt,
        phone_or_till: formatMpesaPhone(phoneNumber),
        status: 'completed',
      });

      return {
        success: true,
        checkoutRequestId: invoiceId,
        mpesaReceiptCode: receiptCode,
        message: `[SIMULATION] A payment request for KES ${amt} was sent to your phone (${phoneNumber}). Enter your M-Pesa PIN when prompted to complete the simulated payment.`,
      };
    };

    if (!publishableKey || !secretKey || isPlaceholderKey(publishableKey) || isPlaceholderKey(secretKey)) {
      // PRODUCTION MUST NEVER SIMULATE A PAYMENT. A misconfigured
      // production deployment (missing or still-placeholder IntaSend
      // keys) previously fell straight through to
      // generateMockStkPushSuccess, which doesn't just simulate an STK
      // push request — it directly writes a COMPLETED payment_received
      // ledger entry for money that never moved. In production that
      // means anyone could "pay" for any claim and proceed straight to
      // collecting the item, for free, with zero real M-Pesa transaction
      // behind it. Same fail-closed principle as the database connection
      // guard in db/index.ts: refuse to start faking money movement
      // rather than silently doing it.
      if (process.env.NODE_ENV === 'production') {
        throw new Error(
          'FATAL: IntaSend payment credentials are missing or still a placeholder value in a production environment. ' +
          'Refusing to simulate a payment in production — configure real INTASEND_PUBLISHABLE_KEY/INTASEND_SECRET_KEY before accepting payments.'
        );
      }
      console.warn('[INTASEND GATEWAY] Configuration missing or placeholder (non-production only). Falling back to simulated payout split.');
      return generateMockStkPushSuccess(phone, amount, claimId);
    }

    const payload = {
      public_key: publishableKey,
      phone_number: formattedPhone,
      amount: amount,
      api_ref: claimId,
    };

    // Never log the public_key (a credential, even if labeled
    // "publishable") or the full phone number — see maskPhoneForLog.
    console.log('[INTASEND GATEWAY] Initiating STK Push Collection.', {
      phone_number: maskPhoneForLog(formattedPhone),
      amount,
      api_ref: claimId,
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
        console.warn(`[INTASEND GATEWAY] Sandbox API error (${response.status}): ${errorText.substring(0, 100)}.`);
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

      const invoiceId = data.invoice?.invoice_id || 'INV-' + Math.random().toString(36).substring(2, 10).toUpperCase();

      await db.logTransaction({
        claim_id: claimId,
        item_id: null,
        type: 'payment_received',
        amount,
        phone_or_till: formattedPhone,
        status: 'pending',
      });

      return {
        success: true,
        checkoutRequestId: invoiceId,
        mpesaReceiptCode: invoiceId,
        message: `A payment request for KES ${amount} was sent to your phone (${phone}). Enter your M-Pesa PIN when prompted to complete the payment.`,
      };
    } catch (error: any) {
      console.warn('[INTASEND GATEWAY] STK Push failed with exception:', error.message);
      return {
        success: false,
        checkoutRequestId: '',
        mpesaReceiptCode: '',
        message: `A network error occurred while sending the payment request: ${error.message}. Please try again.`,
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
   */
  async triggerIntasendPayout(
    claimId: string,
    payouts: Array<{ destination: string; amount: number; payoutMethodType?: string; recipientType: 'finder' | 'agent' }>
  ): Promise<{ batchId: string | null; results: Array<{ recipientType: 'finder' | 'agent'; destination: string; providerTransactionId: string | null; status: 'success' | 'pending' | 'failed' | 'unknown' }> }> {
    const secretKey = process.env.INTASEND_SECRET_KEY;
    if (isPlaceholderKey(secretKey)) {
      // Same fail-closed guarantee as triggerMpesaStkPush above — never
      // fabricate a 'success' payout result in production. Unlike the STK
      // push path, this doesn't write directly to the ledger itself (the
      // caller does, via recordPayoutAttempt), but reporting 'success'
      // here is exactly as dangerous: it would cause the caller to mark a
      // finder/agent payout as genuinely completed when no real M-Pesa
      // transfer occurred.
      if (process.env.NODE_ENV === 'production') {
        throw new Error(
          'FATAL: IntaSend secret key is missing or still a placeholder value in a production environment. ' +
          'Refusing to simulate a payout in production — configure a real INTASEND_SECRET_KEY before processing settlements.'
        );
      }
      console.warn('[INTASEND DISBURSEMENT] Key missing/dummy (non-production only). Emulating disbursement split.');
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

    const transactions = payouts.map(p => {
      let cleanAccount = p.destination;
      const method = p.payoutMethodType || 'Personal M-Pesa';

      // Standardize phone format if it is a personal phone destination (Personal M-Pesa or Pochi la Biashara)
      if (method === 'Personal M-Pesa' || method === 'Pochi la Biashara' || p.recipientType === 'finder') {
        cleanAccount = formatMpesaPhone(p.destination);
      }

      return {
        name: `Return4me ${p.recipientType === 'finder' ? 'Finder' : 'Agent'}`,
        account: cleanAccount,
        amount: String(p.amount),
        narrative: `R4M-${p.recipientType.toUpperCase()}-${claimId}`,
      };
    });

    const payload = {
      provider: 'MPESA-B2C',
      currency: 'KES',
      transactions,
    };

    console.log('[INTASEND DISBURSEMENT] Initiating payouts split:', JSON.stringify({
      ...payload,
      transactions: payload.transactions.map(t => ({ ...t, account: maskPhoneForLog(t.account) })),
    }, null, 2));

    try {
      const response = await fetchWithTimeout(`${INTASEND_BASE_URL}/send-money/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${secretKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.warn(`[INTASEND DISBURSEMENT] API error (${response.status}): ${errorText.substring(0, 200)}.`);
        return {
          batchId: null,
          results: payouts.map(p => ({ recipientType: p.recipientType, destination: p.destination, providerTransactionId: null, status: 'failed' as const })),
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

      const batchId: string | null = data?.tracking_id || data?.batch_reference || null;

      // Defensively attempt to match individual transaction identifiers
      // back to each recipient by account number, if IntaSend's response
      // includes a per-transaction array (field name varies by API
      // version — checking the common candidates rather than assuming
      // one specific shape, since this cannot be verified without live
      // credentials in this environment). If no per-transaction detail is
      // present at all, every recipient still gets a real batchId to
      // reconcile against later, just no individual transaction id yet.
      const rawTxns: any[] = data?.transactions || data?.invoices || data?.disbursements || [];
      const results = payouts.map(p => {
        const match = rawTxns.find((t: any) => {
          const acct = (t?.account || t?.phone_number || t?.destination || '').toString().replace(/\s+/g, '');
          return acct && acct.endsWith(p.destination.replace(/\s+/g, '').slice(-9));
        });
        return {
          recipientType: p.recipientType,
          destination: p.destination,
          providerTransactionId: match?.transaction_id || match?.id || match?.invoice || null,
          // Deliberately 'pending', not 'success' — see function docstring.
          // IntaSend accepting the batch is not the same as the M-Pesa B2C
          // transfer having actually completed.
          status: 'pending' as const,
        };
      });

      return { batchId, results };
    } catch (error: any) {
      console.warn('[INTASEND DISBURSEMENT] Disbursement split exception:', error.message);
      // 'unknown', not 'failed' — a network/timeout error here means we
      // genuinely don't know whether IntaSend received and is processing
      // the request. Treating this as definitively failed risks a
      // duplicate disbursement if a retry fires while the original request
      // actually went through; leaving it 'unknown' routes it to manual
      // admin reconciliation instead of an automatic retry.
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
   */
  async triggerIntasendRefund(
    phone: string,
    amount: number,
    claimId: string
  ): Promise<{ success: boolean; transactionId: string; outcome: 'completed' | 'failed' | 'unknown' }> {
    const secretKey = process.env.INTASEND_SECRET_KEY;
    if (isPlaceholderKey(secretKey)) {
      console.warn('[INTASEND REFUND] Key missing/dummy. Emulating refund disbursement.');
      return {
        success: true,
        transactionId: 'SIM-REFUND-' + Math.random().toString(36).substring(2, 10).toUpperCase(),
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
      const response = await fetchWithTimeout(`${INTASEND_BASE_URL}/send-money/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${secretKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.warn(`[INTASEND REFUND] Sandbox API error (${response.status}): ${errorText.substring(0, 100)}.`);
        // HTTP error response = IntaSend RECEIVED the request and explicitly
        // rejected it. The refund was definitively NOT executed, so classifying
        // this as 'failed' is safe (no duplicate-refund risk on retry).
        return { success: false, transactionId: '', outcome: 'failed' };
      }

      const data = await response.json() as any;
      console.log('[INTASEND REFUND] Response received:', JSON.stringify(data, null, 2));

      return {
        success: true,
        transactionId: data.tracking_id || 'ISD-REFUND-' + Math.random().toString(36).substring(2, 10).toUpperCase(),
        outcome: 'completed',
      };
    } catch (error: any) {
      console.warn('[INTASEND REFUND] Refund exception:', error.message);
      // 'unknown', not 'failed' — a network/timeout exception here means we
      // genuinely don't know whether IntaSend received and executed the
      // refund. Treating this as definitively failed (the pre-FIX#4 behavior)
      // reverted the claim to terminal 'rejected' while the owner's money may
      // actually have been sent — a silent reconciliation divergence, and any
      // retry path could double-refund. Mirroring triggerIntasendPayout's
      // established principle: an ambiguous provider response must be treated
      // as UNKNOWN, leaving the claim in 'refunding' for manual admin/provider
      // reconciliation. No automatic retry is issued from this outcome.
      return { success: false, transactionId: '', outcome: 'unknown' };
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
