import React from 'react';
import { BadgeCheck, MinusCircle } from 'lucide-react';
import Badge from '../../ui/Badge';
import { formatTimestamp, presentPayment } from './claimsPresentation';

/**
 * Payment state for one claim.
 *
 * PAYMENT TRUTH: `paidAt` (claims.paid_at, surfaced by the server as paid_at)
 * decides whether this shows as paid. `hasPaid` is the server's derived boolean
 * and is only used to stay consistent with it. There is deliberately no
 * fallback to status, financial_state or any provider reference — and no amount
 * is displayed, because the API exposes no authoritative figure. Inventing one
 * here would be a financial-safety violation.
 */
export default function ClaimPaymentState({
  hasPaid,
  paidAt,
  lang,
  showTimestamp = true,
}: {
  hasPaid: boolean;
  paidAt: string | null;
  lang: 'en' | 'sw';
  showTimestamp?: boolean;
}) {
  const payment = presentPayment(hasPaid, paidAt, lang);
  return (
    <span className="inline-flex flex-col gap-0.5">
      <Badge variant={payment.tone} icon={payment.paid ? BadgeCheck : MinusCircle}>
        {payment.label}
      </Badge>
      {showTimestamp && (
        <span className="text-[11px] text-brand-muted-text">
          {payment.at ? formatTimestamp(payment.at, lang) : lang === 'sw' ? 'Hakuna tarehe ya malipo' : 'No payment recorded'}
        </span>
      )}
    </span>
  );
}
