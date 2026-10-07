import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, Lock, Smartphone } from 'lucide-react';
import { Banner, Button, ICON_SIZE } from '../ui';

// =============================================================================
// CLAIM PAYMENT ACTION — the private /account surface.
//
// WHY THIS EXISTS
//   The private dashboard could SHOW a claim awaiting payment (the shared
//   ClaimStatus vocabulary renders it "Payment Pending", and the card already
//   showed the 15-minute "Pay before …" deadline) but offered NO way to pay.
//   The only M-Pesa action in the product lived in the public owner journey
//   (OwnerView), so a customer who reached /account saw an actionable state
//   with nothing to act on. This child closes that gap.
//
// NO NEW ENDPOINT, NO NEW TRUST
//   It re-wires the SAME server-controlled payment flow OwnerView already
//   uses, with the identical contract:
//
//     1. POST /api/claims/:id/payment-auth      { phone }
//           -> short-lived ownership token (server proves phone == owner_phone)
//     2. POST /api/claims/:id/payment-session   { phone, payerPhone }
//           -> create/reuse a claim-bound session pinning the
//              server-authoritative amount (the body NEVER carries an amount)
//     3. POST /api/claims/:id/payment-session/:sid/initiate { paymentAuthToken }
//           -> the M-Pesa STK push; idempotent server-side (one push/session)
//     4. GET  /api/claims/:id/payment-session/:sid/status   -> "Check payment status"
//        GET  /api/claims/:id/status                        -> 3s confirmation poll
//
//   Nothing is invented, and the browser never declares a payment successful:
//   a confirmation is ONLY read back from the server (claim status escrow_held /
//   released, or session status confirmed). The amount shown is always the one
//   the server computed for the session — never a client-side number.
//
// WHERE IT RENDERS
//   It self-gates on the claim status, so the dashboard can mount it in every
//   claim card WITHOUT the dashboard itself naming the status token (the
//   dashboard's only source for status copy stays components/claimStatus.ts).
// =============================================================================

export interface ClaimPaymentActionProps {
  claimId: string;
  /** The claim's lifecycle status, read from the customer-safe claim view. */
  status: string;
  /**
   * The account's own phone. The server authorizes a payment only when this
   * matches the claim's registered owner phone, so the account that sees a
   * claim here is the account that can pay for it.
   */
  phone: string;
  /**
   * Called once the server reports the payment is confirmed (or the window has
   * closed), so the dashboard can reload the claim and move on.
   */
  onConfirmed: () => void;
}

// The single status this action is offered for. Kept in THIS file (never the
// dashboard) so the dashboard keeps reading status exclusively through the
// shared vocabulary.
const PAYABLE_STATUS = 'pending_payment';

// The server opens a 15-minute payment window. The poll mirrors OwnerView: a
// 3-second cadence with a 90-second ceiling so a stalled provider can never
// leave an unbounded request loop running.
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 90000;

// +254712345678 -> 0712 *** 678. The payment prompt goes to the account's own
// number, which is masked on this surface exactly as the dashboard does.
function maskPhone(phone: string): string {
  const m = /^\+254(\d{9})$/.exec(phone || '');
  if (!m) return phone || '';
  const d = m[1];
  return '0' + d.slice(0, 3) + ' *** ' + d.slice(6);
}

function formatAmount(value: number): string {
  return `KES ${Math.round(value).toLocaleString('en-KE')}`;
}

// 'idle'      — nothing sent yet; the pay action is offered.
// 'awaiting'  — the prompt is out; the server is being polled for confirmation.
// 'confirmed' — the server confirmed the payment (transient; the reload follows).
// 'error'     — a request failed, the window closed, or the poll throttled/timed out.
type Phase = 'idle' | 'awaiting' | 'confirmed' | 'error';

export default function ClaimPaymentAction({
  claimId,
  status,
  phone,
  onConfirmed,
}: ClaimPaymentActionProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState<number | null>(null);
  const [sessionId, setSessionId] = useState('');
  const [note, setNote] = useState('');

  // The reload callback identity must NOT restart the poll loop, so it lives in
  // a ref that is refreshed on every render instead of in the effect's deps.
  const onConfirmedRef = useRef(onConfirmed);
  useEffect(() => { onConfirmedRef.current = onConfirmed; }, [onConfirmed]);

  // Whether a background confirmation poll should be running at all.
  const [polling, setPolling] = useState(false);

  const payable = status === PAYABLE_STATUS;

  const readAmount = useCallback((raw: unknown) => {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) setAmount(n);
  }, []);

  // ---------------------------------------------------------------------------
  // Confirmation poll. Runs only while `polling` AND the claim is still payable,
  // so the moment the parent reloads the claim (status flips after a confirmed
  // payment) or the claim is otherwise no longer awaiting payment, the interval
  // is cleared by the effect cleanup — no runaway loop, no duplicate work.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!payable || !polling) return;
    let elapsed = 0;
    let stopped = false;
    const interval = setInterval(async () => {
      elapsed += POLL_INTERVAL_MS;
      if (elapsed > POLL_TIMEOUT_MS) {
        stopped = true;
        setPolling(false);
        setPhase('error');
        setNote('We are still waiting for M-Pesa to confirm. If you entered your M-Pesa PIN, the payment may still complete — check again in a moment.');
        return;
      }
      try {
        const res = await fetch(`/api/claims/${claimId}/status`);
        if (stopped) return;
        if (res.status === 429) {
          stopped = true;
          setPolling(false);
          setPhase('error');
          setNote('Status checks are paused for a moment to avoid overloading the server. Your claim is safe — check again in a minute.');
          return;
        }
        if (!res.ok) return;
        const data = await res.json();
        if (data?.status === 'escrow_held' || data?.status === 'released') {
          stopped = true;
          setPolling(false);
          setPhase('confirmed');
          onConfirmedRef.current();
        } else if (data?.status === 'payment_window_expired') {
          stopped = true;
          setPolling(false);
          setPhase('error');
          setNote('The payment window has closed. Link the claim again from the item page to start a new payment.');
          onConfirmedRef.current();
        }
      } catch {
        /* transient — keep polling until the ceiling */
      }
    }, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, [payable, polling, claimId]);

  // ---------------------------------------------------------------------------
  // The M-Pesa STK push. Steps 1-3, mirroring OwnerView.triggerEscrowPayment.
  // A second press is safe: the server's session CAS means a repeated initiate
  // returns `alreadyInitiated: true` WITHOUT issuing a second push.
  // ---------------------------------------------------------------------------
  const payNow = useCallback(async () => {
    if (!payable || busy) return;
    setBusy(true);
    setNote('');
    try {
      const authRes = await fetch(`/api/claims/${claimId}/payment-auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ phone }),
      });
      const authData = await authRes.json().catch(() => ({}));
      if (!authRes.ok) {
        throw new Error(authData?.error || 'We could not authorize this payment. Please try again.');
      }

      const sessionRes = await fetch(`/api/claims/${claimId}/payment-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ phone, payerPhone: phone }),
      });
      const sessionData = await sessionRes.json().catch(() => ({}));
      if (!sessionRes.ok) {
        throw new Error(sessionData?.error || 'We could not start the payment. Please try again.');
      }
      const sid = sessionData?.paymentSession?.id;
      if (!sid) {
        throw new Error('We could not start the payment. Please try again.');
      }
      setSessionId(sid);
      readAmount(sessionData?.paymentSession?.amount);

      const initiateRes = await fetch(`/api/claims/${claimId}/payment-session/${sid}/initiate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ paymentAuthToken: authData?.paymentAuthToken }),
      });
      const initiateData = await initiateRes.json().catch(() => ({}));
      if (!initiateRes.ok) {
        throw new Error(initiateData?.error || 'We could not send the M-Pesa prompt. Please try again.');
      }

      setPhase('awaiting');
      setPolling(true);
    } catch (e: any) {
      setPhase('error');
      setNote(e?.message || 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }, [claimId, phone, payable, busy, readAmount]);

  // ---------------------------------------------------------------------------
  // "Check payment status" — asks the BACKEND, never trusts the browser. It can
  // only reflect what the server and provider have actually recorded.
  // ---------------------------------------------------------------------------
  const checkStatus = useCallback(async () => {
    if (!sessionId || busy) return;
    setBusy(true);
    setNote('');
    try {
      const res = await fetch(`/api/claims/${claimId}/payment-session/${sessionId}/status`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || 'We could not check the payment status. Please try again.');
      }
      readAmount(data?.paymentSession?.amount);
      const sessionStatus = data?.paymentSession?.status;
      const claimStatus = data?.claim?.status;
      if (sessionStatus === 'confirmed' || claimStatus === 'escrow_held' || claimStatus === 'released') {
        setPolling(false);
        setPhase('confirmed');
        onConfirmedRef.current();
      } else if (sessionStatus === 'expired' || claimStatus === 'payment_window_expired') {
        setPolling(false);
        setPhase('error');
        setNote('The payment window has closed. Link the claim again from the item page to start a new payment.');
        onConfirmedRef.current();
      } else if (sessionStatus === 'failed') {
        setPolling(false);
        setPhase('error');
        setNote('The payment failed. Please try again.');
      } else {
        setPhase('awaiting');
      }
    } catch (e: any) {
      setPhase('error');
      setNote(e?.message || 'We could not check the payment status. Please try again.');
    } finally {
      setBusy(false);
    }
  }, [claimId, sessionId, busy, readAmount]);

  // Hooks have all run; now it is safe to render nothing for a claim that is
  // not awaiting payment (and during the brief moment before the reload lands).
  if (!payable) return null;

  return (
    <div className="space-y-3 rounded-standard border border-[var(--appearance-border)] bg-[var(--appearance-surface-muted)] p-4">
      <div className="flex items-center gap-2">
        <Smartphone size={ICON_SIZE.ui} aria-hidden="true" className="shrink-0 text-[var(--appearance-accent)]" />
        <p className="text-body font-extrabold text-[var(--appearance-text-primary)]">
          {'Complete your payment'}
        </p>
      </div>

      {phase === 'confirmed' ? (
        <p role="status" aria-live="polite" className="flex items-center gap-2 text-small font-semibold text-[var(--appearance-success)]">
          <CheckCircle2 size={ICON_SIZE.ui} aria-hidden="true" className="shrink-0" />
          {'Payment received. Thank you — your claim is moving forward.'}
        </p>
      ) : (
        <>
          <p className="text-small text-[var(--appearance-text-secondary)]">
            {'Pay with M-Pesa to keep this claim active. An M-Pesa prompt will be sent to '}
            <span className="font-semibold text-[var(--appearance-text-primary)]">{maskPhone(phone)}</span>
            {'.'}
          </p>

          {amount !== null && (
            <div className="flex items-center justify-between gap-3 text-small">
              <span className="text-[var(--appearance-text-muted)]">{'Amount due'}</span>
              <span className="font-mono font-extrabold text-[var(--appearance-text-primary)]">
                {formatAmount(amount)}
              </span>
            </div>
          )}

          {phase === 'awaiting' && (
            <p role="status" aria-live="polite" className="flex items-center gap-2 text-small font-medium text-[var(--appearance-text-secondary)]">
              <Loader2 size={ICON_SIZE.metadata} aria-hidden="true" className="shrink-0 animate-spin text-[var(--appearance-accent)]" />
              {'Waiting for M-Pesa confirmation — enter your M-Pesa PIN on your phone.'}
            </p>
          )}

          {phase === 'error' && note && (
            <Banner kind="error">{note}</Banner>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {phase === 'awaiting' ? (
              <>
                <Button variant="accent" size="md" onClick={checkStatus} disabled={busy}>
                  {'Check payment status'}
                </Button>
                <Button variant="secondary" size="md" onClick={payNow} loading={busy} loadingLabel={'Resending the M-Pesa prompt'}>
                  {'Didn\u2019t get the prompt? Resend'}
                </Button>
              </>
            ) : (
              <Button variant="accent" size="md" onClick={payNow} loading={busy} loadingLabel={'Sending the M-Pesa prompt'}>
                {phase === 'error' ? 'Try again' : 'Pay with M-Pesa'}
              </Button>
            )}
          </div>

          <p className="flex items-center gap-1.5 text-caption text-[var(--appearance-text-muted)]">
            <Lock size={ICON_SIZE.metadata} aria-hidden="true" className="shrink-0" />
            {'Your payment is held securely as escrow until you collect the item.'}
          </p>
        </>
      )}
    </div>
  );
}



