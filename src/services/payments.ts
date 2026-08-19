import { db } from '../db/database';

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

    if (!publishableKey || !secretKey) {
      console.warn('[INTASEND GATEWAY] Configuration missing. Falling back to simulated payout split.');
      return generateMockStkPushSuccess(phone, amount, claimId);
    }

    const isDummyKey = isPlaceholderKey(publishableKey) || isPlaceholderKey(secretKey);
    if (isDummyKey) {
      console.warn('[INTASEND GATEWAY] Dummy placeholder keys detected. Emulating M-Pesa STK push simulation.');
      return generateMockStkPushSuccess(phone, amount, claimId);
    }

    const payload = {
      public_key: publishableKey,
      phone_number: formattedPhone,
      amount: amount,
      api_ref: claimId,
    };

    console.log('[INTASEND GATEWAY] Initiating STK Push Collection. Payload:', JSON.stringify(payload, null, 2));

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
      console.log('[INTASEND GATEWAY] Response received:', JSON.stringify(data, null, 2));

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
  async triggerIntasendPayout(
    claimId: string,
    payouts: Array<{ destination: string; amount: number; payoutMethodType?: string; recipientType: 'finder' | 'agent' }>
  ): Promise<{ success: boolean; transactionId: string }> {
    const secretKey = process.env.INTASEND_SECRET_KEY;
    if (isPlaceholderKey(secretKey)) {
      console.warn('[INTASEND DISBURSEMENT] Key missing/dummy. Emulating disbursement split.');
      return {
        success: true,
        transactionId: 'SIM-' + Math.random().toString(36).substring(2, 10).toUpperCase(),
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

    console.log('[INTASEND DISBURSEMENT] Initiating payouts split:', JSON.stringify(payload, null, 2));

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
        console.warn(`[INTASEND DISBURSEMENT] Sandbox API error (${response.status}): ${errorText.substring(0, 100)}.`);
        return {
          success: false,
          transactionId: '',
        };
      }

      const data = await response.json() as any;
      console.log('[INTASEND DISBURSEMENT] Response received:', JSON.stringify(data, null, 2));

      return {
        success: true,
        transactionId: data.tracking_id || 'ISD-' + Math.random().toString(36).substring(2, 10).toUpperCase(),
      };
    } catch (error: any) {
      console.warn('[INTASEND DISBURSEMENT] Disbursement split exception:', error.message);
      return {
        success: false,
        transactionId: '',
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
