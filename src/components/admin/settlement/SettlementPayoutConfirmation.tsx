import React from 'react';
import Button from '../../ui/Button';
import Input from '../../ui/Input';
import SettlementApprovalSummary, {
  type SettlementApprovedLedgerRowProp,
} from './SettlementApprovalSummary';

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
  /** GATE 2 — the approval on file, exactly as the server described it. This
   *  step never computes an approved amount: when the snapshot is missing,
   *  legacy or unreadable the shared summary says so instead. */
  approvalState?: string | null;
  /** The PERSISTED approved total, already formatted by the server. */
  approvedTotal?: string | null;
  /** The persisted payout rows the approval covers, with booked amounts. */
  approvedLedgerRows?: readonly SettlementApprovedLedgerRowProp[] | null;
  /** Server diagnostic: do the booked rows still add up to the approved total? */
  approvedRowsAgree?: boolean | null;
  /** BATCH 1 (D) — the administrator's own password, re-verified by the server
   *  before the payout request is even considered. Held by the caller only, and
   *  cleared as soon as the attempt resolves. */
  password: string;
  onPasswordChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  passwordError?: string;
  /** A request for this claim is in flight: both controls are disabled. */
  submitting?: boolean;
  /** Cancellation: closes the step. The caller sends no request when this runs. */
  onCancel: () => void;
  /** Confirmation: the caller now initiates the payout, exactly once. */
  onConfirm: () => void;
}

export default function SettlementPayoutConfirmation({
  claimId,
  itemId,
  lockedTotalFee,
  approvalState,
  approvedTotal,
  approvedLedgerRows,
  approvedRowsAgree,
  password,
  onPasswordChange,
  passwordError,
  submitting = false,
  onCancel,
  onConfirm,
}: SettlementPayoutConfirmationProps) {
  const amount = typeof lockedTotalFee === 'number' ? `KES ${lockedTotalFee}` : null;
  return (
    <div className="space-y-3 border-t border-[var(--appearance-border)] pt-3">
      <p className="text-caption font-bold text-[var(--appearance-text-primary)]">
        {`Confirm payout initiation for claim ${claimId}`}
      </p>
      <p className="text-caption text-[var(--appearance-text-muted)]">
        {`This starts payout processing for item ${itemId}${amount ? ` (${amount} claim fee)` : ''}. Money may leave the platform on this action and it cannot be undone from here. The amount each recipient is paid is the amount booked on its payout row and is verified against the ledger before submission. Nothing has been sent yet: the payout is submitted only if you confirm below, and the provider's result is reported separately.`}
      </p>
      {/* GATE 2 — the SAME authorization the row shows and the server enforces.
          Rendered from server-supplied values only; no amount is derived here. */}
      <SettlementApprovalSummary
        approvalState={approvalState}
        approvedTotal={approvedTotal}
        approvedLedgerRows={approvedLedgerRows}
        approvedRowsAgree={approvedRowsAgree}
      />
      <Input
        label={'Your password'}
        id={'settlement-payout-password-' + claimId}
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={onPasswordChange}
        required
        disabled={submitting}
        error={passwordError || undefined}
        hint={
          'Your own administrator password, verified on the server before the payout is initiated. It is never stored and never logged.'
        }
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={submitting}>
          {'Cancel'}
        </Button>
        <Button variant="accent" size="sm" loading={submitting} onClick={onConfirm}>
          {'Confirm and initiate payout'}
        </Button>
      </div>
    </div>
  );
}
