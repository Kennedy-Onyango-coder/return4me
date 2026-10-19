import React from 'react';
import Badge, { type BadgeVariant } from '../../ui/Badge';

// =============================================================================
// ADM-007 — THE MASKED RECIPIENT PREVIEW, AS ONE PRESENTATIONAL BLOCK.
// =============================================================================
// The settlement confirmation steps used to state the claim, the item and an
// aggregate amount, but never WHO the payout would pay. An operator therefore
// confirmed an irreversible, money-moving action without being able to see that
// a leg was addressed to an unexpected destination, or that one leg had already
// been submitted on an earlier attempt.
//
// WHAT THIS RENDERS
//   * one row per persisted payout leg (finder / agent),
//   * the destination MASKED by the server (this component never receives a full
//     number and performs no masking of its own),
//   * the amount BOOKED on that leg, exactly as the server formatted it,
//   * the leg's own submission state, in the same vocabulary the executor uses.
//
// WHAT IT DOES NOT DO
//   Nothing here authorizes, submits, retries or re-arms anything. There are no
//   hooks, no requests and no endpoint strings: every value is a prop, so the
//   node-only test environment can render it for real and assert what an
//   operator actually sees. The server re-reads the rows and re-checks the
//   destinations immediately before submission, so this preview is a
//   confirmation aid, never a control.

export type SettlementRecipientLeg = {
  role: 'finder' | 'agent';
  /** Already masked by the server. '(none)' / '***' mean the stored value is
   *  missing or too short to mask meaningfully — both are blocking states. */
  maskedDestination: string;
  /** The amount booked on the row, formatted by the server. Never recomputed. */
  amount: string | null;
  /** ledger.status — 'pending' | 'completed' | 'failed'. */
  status?: string | null;
  /** ledger.payout_outcome — null means no submission history was recorded. */
  payoutOutcome?: string | null;
};

export const SETTLEMENT_RECIPIENTS_UNAVAILABLE_TEXT =
  'The payout legs for this claim could not be read from the dashboard payload, so this step cannot show who would be paid. Do not confirm until the settlement row has been reloaded.';

export const SETTLEMENT_RECIPIENTS_NONE_TEXT =
  'No payout leg is booked for this claim. The payout executor would refuse it, so there is nothing to confirm.';

/** A destination the payout policy cannot pay, or one this build cannot read. */
function destinationIsBlocked(leg: SettlementRecipientLeg): boolean {
  const masked = typeof leg.maskedDestination === 'string' ? leg.maskedDestination.trim() : '';
  return masked === '' || masked === '(none)' || masked === '***';
}

/**
 * The submission state of one leg, described in the operator's vocabulary.
 *
 * These labels deliberately never say "paid": acceptance is not completion, an
 * unknown outcome may already have moved money, and a rejected leg was refused
 * before execution. The executor's own definitions are the source.
 */
export function describeSettlementLegState(leg: SettlementRecipientLeg): {
  label: string;
  variant: BadgeVariant;
  /** True when this leg must not be treated as a fresh, submittable payout. */
  blocking: boolean;
} {
  if (leg.status === 'completed') {
    return { label: 'Completed — provider-confirmed', variant: 'success', blocking: true };
  }
  switch (leg.payoutOutcome) {
    case 'not_submitted':
      return { label: 'Not submitted yet', variant: 'pending', blocking: false };
    case 'submitting':
      return { label: 'Submission in flight — do not resend', variant: 'warning', blocking: true };
    case 'accepted':
      return { label: 'Accepted by provider — not yet confirmed', variant: 'warning', blocking: true };
    case 'unknown':
      return { label: 'Outcome unknown — reconciliation required', variant: 'danger', blocking: true };
    case 'rejected':
      return { label: 'Rejected — no transfer was made', variant: 'danger', blocking: true };
    case 'completed':
      return { label: 'Completed — provider-confirmed', variant: 'success', blocking: true };
    default:
      // NULL is "no submission history was recorded", which the executor treats
      // as UNRESOLVED rather than as never submitted. Say so instead of guessing.
      return { label: 'No submission history recorded', variant: 'neutral', blocking: true };
  }
}

export default function SettlementRecipientPreview({
  legs,
}: {
  legs?: readonly SettlementRecipientLeg[] | null;
}) {
  if (!Array.isArray(legs)) {
    return (
      <div className="space-y-1.5 border-t border-[var(--appearance-border)] pt-3">
        <p className="text-caption font-bold text-[var(--appearance-text-primary)]">{'Payout recipients'}</p>
        <p className="text-caption text-[var(--appearance-danger)]">{SETTLEMENT_RECIPIENTS_UNAVAILABLE_TEXT}</p>
      </div>
    );
  }

  if (legs.length === 0) {
    return (
      <div className="space-y-1.5 border-t border-[var(--appearance-border)] pt-3">
        <p className="text-caption font-bold text-[var(--appearance-text-primary)]">{'Payout recipients'}</p>
        <p className="text-caption text-[var(--appearance-warning)]">{SETTLEMENT_RECIPIENTS_NONE_TEXT}</p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5 border-t border-[var(--appearance-border)] pt-3">
      <p className="text-caption font-bold text-[var(--appearance-text-primary)]">{'Payout recipients'}</p>
      <ul className="space-y-1.5">
        {legs.map((leg, index) => {
          const state = describeSettlementLegState(leg);
          const blocked = destinationIsBlocked(leg);
          return (
            <li
              key={`${leg.role}-${index}`}
              className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-caption"
            >
              <span className="font-bold text-[var(--appearance-text-primary)]">
                {leg.role === 'agent' ? 'Agent payout' : 'Finder payout'}
              </span>
              <span className="font-mono text-[var(--appearance-text-primary)]">
                {blocked ? 'Destination unavailable' : leg.maskedDestination}
              </span>
              <span className="text-[var(--appearance-text-muted)]">
                {leg.amount ? `KES ${leg.amount}` : 'amount not recorded'}
              </span>
              <Badge variant={state.variant}>{state.label}</Badge>
              {blocked && (
                <span className="text-[var(--appearance-danger)]">
                  {'This destination cannot be paid under the phone-only payout policy.'}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-caption text-[var(--appearance-text-muted)]">
        {'Destinations are masked. Each amount is the amount booked on that payout row; the executor verifies it against the ledger and re-reads the destination before anything is sent.'}
      </p>
    </div>
  );
}
