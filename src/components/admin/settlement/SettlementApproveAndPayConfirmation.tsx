import React from 'react';
import Button from '../../ui/Button';
import Input from '../../ui/Input';
import Textarea from '../../ui/Textarea';

// =============================================================================
// D-2B-B BATCH 4 — THE COMBINED "APPROVE & PAY" STEP, AS ONE PRESENTATIONAL BLOCK.
// =============================================================================
// The console offers the two single-purpose settlement actions separately, and
// they stay separate. This step is the third, EXPLICIT option for the case the
// two-step flow handles badly: an operator looking at a due, unapproved
// settlement who has decided to pay it now. Rather than approve, wait for the
// row to re-render, and then confirm the payout again, they confirm both
// decisions ONCE — with the target named, the amount named, the reason the
// approval requires, and their OWN password re-proving who is behind the session.
//
// WHY IT SENDS NOTHING ITSELF
//   No hooks, no state, no `fetch`, no endpoint string: every value is a prop and
//   every decision belongs to the caller and, ultimately, to the server. That
//   purity is what lets this repository's node-only vitest render the step for
//   real (react-dom/server) and assert what an administrator actually sees.
//
// WHY THE PASSWORD IS A FIELD AND NOT A RE-TYPED "ARE YOU SURE"
//   The route re-verifies the password against the administrator's stored bcrypt
//   hash BEFORE it records the approval, so a stolen session alone can never
//   approve-and-pay. The value is never echoed back, never persisted and never
//   logged: this component only hands it to the caller's change handler.
//
// WHY NOT A DIALOG
//   The settlement panel collects its other required input inline, in the row,
//   and the D-2B-B contracts pin that the panel introduces no new dialog and no
//   native prompt. This step follows the same established in-row pattern.
// =============================================================================

export interface SettlementApproveAndPayConfirmationProps {
  /** The settlement being acted on. Rendered, so the operator can never confirm
   *  a payout without seeing which claim it belongs to. */
  claimId: string;
  /** The item that changes hands. */
  itemId: string;
  /** The locked settlement fee, when the row has one. Omitted rather than guessed
   *  when the payload carries none — this view invents no amounts. */
  lockedTotalFee?: number | null;
  /** The approval reason. Required by the route; collected here, trimmed there. */
  reason: string;
  onReasonChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
  reasonError?: string;
  /** The administrator's own password for re-authentication. */
  password: string;
  onPasswordChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  passwordError?: string;
  /** A request for this claim is in flight: both controls are disabled. */
  submitting: boolean;
  /** Cancellation: closes the step. The caller sends no request when this runs. */
  onCancel: () => void;
  /** Confirmation: the caller records the approval AND initiates the payout. */
  onConfirm: () => void;
}

export default function SettlementApproveAndPayConfirmation({
  claimId,
  itemId,
  lockedTotalFee,
  reason,
  onReasonChange,
  reasonError,
  password,
  onPasswordChange,
  passwordError,
  submitting,
  onCancel,
  onConfirm,
}: SettlementApproveAndPayConfirmationProps) {
  const amount = typeof lockedTotalFee === 'number' ? `KES ${lockedTotalFee}` : null;
  return (
    <div className="space-y-3 border-t border-[var(--appearance-border)] pt-3">
      <p className="text-caption font-bold text-[var(--appearance-text-primary)]">
        {`Approve and pay claim ${claimId}`}
      </p>
      <p className="text-caption text-[var(--appearance-text-muted)]">
        {`This records the settlement approval AND then submits the payout for item ${itemId}${amount ? ` (${amount} claim fee)` : ''} in one action. The approval is saved with your reason; the payout is submitted immediately afterwards and cannot be undone from here. The amount each recipient is paid is the amount booked on its payout row and is verified against the ledger before submission. Nothing has been sent yet.`}
      </p>
      <Textarea
        label={'Reason (recorded in the audit log)'}
        id={'settlement-approve-and-pay-reason-' + claimId}
        rows={3}
        value={reason}
        onChange={onReasonChange}
        required
        disabled={submitting}
        error={reasonError || undefined}
        hint={'Required. It is stored with the approval and with this combined action, so the decision to pay is always attributable.'}
      />
      <Input
        label={'Your password'}
        id={'settlement-approve-and-pay-password-' + claimId}
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={onPasswordChange}
        required
        disabled={submitting}
        error={passwordError || undefined}
        hint={'Your own administrator password, verified on the server before anything is recorded. It is never stored and never logged.'}
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={submitting}>
          {'Cancel'}
        </Button>
        <Button variant="accent" size="sm" loading={submitting} onClick={onConfirm}>
          {'Record approval and initiate payout'}
        </Button>
      </div>
    </div>
  );
}
