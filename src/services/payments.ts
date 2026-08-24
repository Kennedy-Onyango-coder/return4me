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

// Configuration variables for IntaSend
const INTASEND_BASE_URL = process.env.NODE_ENV === 'production'
  ? 'https://payment.intasend.com/api/v1'
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
        message: `[SIMULATION] Ombi la malipo ya KES ${amt} limetumwa kwa simu yako (${phoneNumber}). Tafadhali weka PIN ya M-Pesa utakapoulizwa ili kukamilisha simulation ya malipo.`,
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
          message: `Miamala ya M-Pesa imeshindwa kuwasiliana na mfumo wa malipo. (${response.status}) Tafadhali jaribu tena baadaye.`,
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
        message: `Ombi la malipo ya KES ${amount} limetumwa kwa simu yako (${phone}). Tafadhali weka PIN ya M-Pesa utakapoulizwa ili kukamilisha malipo.`,
      };
    } catch (error: any) {
      console.warn('[INTASEND GATEWAY] STK Push failed with exception:', error.message);
      return {
        success: false,
        checkoutRequestId: '',
        mpesaReceiptCode: '',
        message: `Kuna hitilafu ya mtandao wakati wa kutuma ombi la malipo: ${error.message}. Tafadhali jaribu tena.`,
      };
    }
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
        name: `Return4me ${p.recipientType === 'finder' ? 'Mtafutaji' : 'Wakala'}`,
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
  ): Promise<{ success: boolean; transactionId: string }> {
    const secretKey = process.env.INTASEND_SECRET_KEY;
    if (isPlaceholderKey(secretKey)) {
      console.warn('[INTASEND REFUND] Key missing/dummy. Emulating refund disbursement.');
      return {
        success: true,
        transactionId: 'SIM-REFUND-' + Math.random().toString(36).substring(2, 10).toUpperCase(),
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

    console.log('[INTASEND REFUND] Initiating refund disbursement:', JSON.stringify(payload, null, 2));

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
        return { success: false, transactionId: '' };
      }

      const data = await response.json() as any;
      console.log('[INTASEND REFUND] Response received:', JSON.stringify(data, null, 2));

      return {
        success: true,
        transactionId: data.tracking_id || 'ISD-REFUND-' + Math.random().toString(36).substring(2, 10).toUpperCase(),
      };
    } catch (error: any) {
      console.warn('[INTASEND REFUND] Refund exception:', error.message);
      return { success: false, transactionId: '' };
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
