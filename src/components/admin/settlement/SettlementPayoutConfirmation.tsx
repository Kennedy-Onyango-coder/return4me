import React from 'react';
import Button from '../../ui/Button';

// =============================================================================
// D-2B-B BATCH 2 — THE PAYOUT CONFIRMATION STEP, AS ONE PRESENTATIONAL BLOCK.
// =============================================================================
// The irreversible "Initiate payout" action must not fire from a single click on
// the settlement row. This is the step that stands between the click and the
// request: it names the exact settlement being acted on, states in plain words
// that this starts payout processing and may move money, and offers the operator
// two DISTINCT controls — confirm and cancel. It sends nothing itself.
//
// WHY NOT A DIALOG
//   The console's settlement panel already collects its other required input (the
//   approval reason) in an INLINE step inside the same row, and the D-2B-B
//   contracts pin that this panel introduces no new dialog and no native prompt
//   (see the settlement lifecycle tripwires). So the confirmation follows that
//   established in-row pattern rather than adding a second dialog component, and
//   the settlement keeps its own dedicated scope.
//
// WHY IT IS PURELY PRESENTATIONAL
//   No hooks, no state, no `fetch`, no endpoint string: every value is a prop and
//   every decision belongs to `components/admin/consoleActionState.ts` (which
//   owns the rule that cancelling sends nothing and that a duplicate confirmation
//   is refused). That purity is what lets this repository's node-only vitest
//   render the step for real (react-dom/server) and assert what an administrator
//   would actually see.
// =============================================================================

export interface SettlementPayoutConfirmationProps {
  /** The settlement being acted on. Rendered, so the operator can never confirm
   *  a payout without seeing which claim it belongs to. */
  claimId: string;
  /** The item that changes hands. */
  itemId: string;
  /** The locked settlement fee, when the row has one. Omitted rather than
   *  guessed when the payload carries none — this view invents no amounts. */
  lockedTotalFee?: number | null;
  /** Cancellation: closes the step. The caller sends no request when this runs. */
  onCancel: () => void;
  /** Confirmation: the caller now initiates the payout, exactly once. */
  onConfirm: () => void;
}

export default function SettlementPayoutConfirmation({
  claimId,
  itemId,
  lockedTotalFee,
  onCancel,
  onConfirm,
}: SettlementPayoutConfirmationProps) {
  const amount = typeof lockedTotalFee === 'number' ? `KES ${lockedTotalFee}` : null;
  return (
    <div className="space-y-2 border-t border-[var(--appearance-border)] pt-3">
      <p className="text-caption font-bold text-[var(--appearance-text-primary)]">
        {`Confirm payout initiation for claim ${claimId}`}
      </p>
      <p className="text-caption text-[var(--appearance-text-muted)]">
        {`This starts payout processing for item ${itemId}${amount ? ` (${amount} released)` : ''}. Money may leave the platform on this action and it cannot be undone from here. Nothing has been sent yet: the payout is submitted only if you confirm below, and the provider's result is reported separately.`}
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel}>
          {'Cancel'}
        </Button>
        <Button variant="accent" size="sm" onClick={onConfirm}>
          {'Confirm and initiate payout'}
        </Button>
      </div>
    </div>
  );
}
