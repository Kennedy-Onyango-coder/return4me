// =============================================================================
// PHASE 3 — LEDGER ROW PRESENTATION (ICONS AND STATUS LABELS)
// =============================================================================
// The ledger table used ONE clock icon and the word "PENDING" for every pending
// row. On a `payment_received` row that reads as "the customer has not paid",
// and on a `platform_fee` row it reads as "a payout is waiting", although the
// platform share is never paid to a recipient at all.
//
// This module changes PRESENTATION ONLY. It never touches `ledger.status`,
// `payout_outcome`, amounts or any write path: the stored semantics remain
// exactly what they were. Tests pin that a payment-received and platform-fee row
// can never render the word "PENDING".
// =============================================================================

export type LedgerIconKind = 'inbound' | 'fee' | 'outbound' | 'neutral';

export function ledgerEntryIconKind(entry: any): LedgerIconKind {
  switch (entry?.type) {
    case 'payment_received':
      return 'inbound';
    case 'platform_fee':
      return 'fee';
    case 'finder_payout':
    case 'agent_payout':
    case 'goodwill_payout':
    case 'refund':
      return 'outbound';
    default:
      return 'neutral';
  }
}

export function ledgerTypeLabel(type: unknown): string {
  switch (type) {
    case 'payment_received':
      return 'Payment received';
    case 'platform_fee':
      return 'Platform fee';
    case 'finder_payout':
      return 'Finder payout';
    case 'agent_payout':
      return 'Agent payout';
    case 'goodwill_payout':
      return 'Goodwill payout';
    case 'refund':
      return 'Refund';
    default:
      return String(type ?? 'Unknown').replace(/_/g, ' ');
  }
}

/**
 * What the STATUS cell says for this row.
 *
 * A payout row keeps the lifecycle word PENDING because its provider outcome is
 * genuinely undecided. The two non-payout inbound/internal rows get wording that
 * describes what is actually happening to them.
 */
export function ledgerStatusLabel(entry: any): string {
  const status = String(entry?.status ?? '').toLowerCase();
  if (entry?.type === 'payment_received') {
    if (status === 'completed') return 'Received';
    if (status === 'failed') return 'Payment failed';
    return 'Awaiting provider confirmation';
  }
  if (entry?.type === 'platform_fee') {
    if (status === 'completed') return 'Booked internal share';
    if (status === 'failed') return 'Booking failed';
    return 'Recorded internal share';
  }
  return status ? status.toUpperCase() : 'UNKNOWN';
}

export function ledgerStatusVariant(entry: any): 'success' | 'danger' | 'pending' | 'info' {
  const status = String(entry?.status ?? '').toLowerCase();
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'danger';
  if (entry?.type === 'platform_fee') return 'info';
  if (entry?.type === 'payment_received') return 'info';
  return 'pending';
}

/** The row's amount direction, stated without changing the sign of the value. */
export function ledgerAmountDirectionLabel(entry: any): string {
  switch (ledgerEntryIconKind(entry)) {
    case 'inbound':
      return 'Money in';
    case 'fee':
      return 'Platform share';
    case 'outbound':
      return entry?.type === 'refund' ? 'Money out (refund)' : 'Money out (payout)';
    default:
      return 'Ledger entry';
  }
}
