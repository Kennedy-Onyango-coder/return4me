import React from 'react';

// =============================================================================
// GATE 2 — WHAT THE APPROVAL ON FILE COVERS, AS ONE SHARED BLOCK.
// =============================================================================
// The pending-settlement row, the payout confirmation step and the combined
// "approve & pay" step must all describe the SAME authorization: the approved
// total and the exact payout rows the server's gate compares. Rendering that in
// one component is what stops the three views drifting into three different
// accounts of the same approval — the drift this batch exists to close.
//
// EVERY VALUE IS A PROP AND NOTHING IS CALCULATED HERE.
//   * `approvedTotal` is the PERSISTED approval total, already formatted by the
//     server. This component never sums ledger rows, never subtracts a platform
//     share and never falls back to the claim fee.
//   * `approvedLedgerRows` are the persisted `role:id` rows, annotated by the
//     server with the amount BOOKED on each ledger row.
//   * Every state that is not a readable snapshot is NAMED. `legacy`,
//     `incomplete`, `unreadable` and `unavailable` all render an explicit
//     "not available" message — never a blank, and never a substitute amount.
//
// No hooks, no state, no `fetch`: this renders in the repository's node-only
// vitest (react-dom/server), so what an operator reads is asserted directly.
// =============================================================================

/** The state vocabulary the server publishes (`settlementApproval.state`). */
export type SettlementApprovalDisplayStateProp =
  | 'not_approved'
  | 'authorized'
  | 'legacy'
  | 'incomplete'
  | 'unreadable'
  /** The payload did not carry a usable snapshot at all (older server / shape drift). */
  | 'unavailable';

/** One payout row covered by the approval, as the server described it. */
export interface SettlementApprovedLedgerRowProp {
  role: 'finder' | 'agent';
  ledgerEntryId: string;
  /** The amount BOOKED on that ledger row, already formatted; null when unreadable. */
  bookedAmount?: string | null;
  /** False when the row the approval covered is no longer in the ledger. */
  ledgerRowFound?: boolean;
  /** False when the ledger row is not the payout leg the approval records. */
  ledgerRowRoleMatches?: boolean | null;
}

export interface SettlementApprovalSummaryProps {
  approvalState?: SettlementApprovalDisplayStateProp | string | null;
  approvedTotal?: string | null;
  approvedLedgerRows?: readonly SettlementApprovedLedgerRowProp[] | null;
  /** Server diagnostic: do the booked rows still add up to the approved total? */
  approvedRowsAgree?: boolean | null;
  /** Shown when no approval is on file. The caller supplies its own context. */
  notApprovedNote?: string;
}

const rowLabel = (row: SettlementApprovedLedgerRowProp): string =>
  `${row.role === 'agent' ? 'agent' : 'finder'}:${String(row.ledgerEntryId)}`;

export default function SettlementApprovalSummary({
  approvalState,
  approvedTotal,
  approvedLedgerRows,
  approvedRowsAgree,
  notApprovedNote,
}: SettlementApprovalSummaryProps) {
  const rows = Array.isArray(approvedLedgerRows) ? approvedLedgerRows : [];
  const state = typeof approvalState === 'string' ? approvalState : '';

  if (state === 'authorized' && typeof approvedTotal === 'string') {
    return (
      <div className="space-y-1 rounded-lg border border-[var(--appearance-border)] p-2 text-caption text-[var(--appearance-text-muted)]">
        <p>
          <span className="font-bold text-[var(--appearance-text-primary)]">{`Approved payout total KES ${approvedTotal}`}</span>
          {' — the amount the settlement approval recorded, not a recalculation.'}
        </p>
        {rows.length > 0 ? (
          <>
            <p>{'Covered payout rows, with the amount booked on each:'}</p>
            {rows.map((row) => (
              <p key={rowLabel(row)} className="font-mono text-caption">
                {`${rowLabel(row)} — ${
                  row.ledgerRowFound === false
                    ? 'row not found in the current ledger'
                    : typeof row.bookedAmount === 'string'
                      ? `KES ${row.bookedAmount} booked`
                      : 'booked amount unreadable'
                }`}
              </p>
            ))}
            <p>{'Recipients are paid the booked amount on each row. The platform share of the claim fee is not part of this payout.'}</p>
          </>
        ) : (
          <p className="font-bold text-status-warning">
            {'The approval records no covered payout rows, so the server refuses this payout. Review the claim and the approval.'}
          </p>
        )}
        {approvedRowsAgree === false && (
          <p className="font-bold text-status-warning">
            {'The booked payout rows no longer add up to the approved total. The server refuses this payout until the claim and the approval are reviewed.'}
          </p>
        )}
        {rows.some((row) => row.ledgerRowFound === false) && (
          <p className="font-bold text-status-warning">
            {'A payout row covered by the approval is not in the current ledger. The server refuses this payout until it is reviewed.'}
          </p>
        )}
        {rows.some((row) => row.ledgerRowRoleMatches === false) && (
          <p className="font-bold text-status-warning">
            {'A covered ledger row is not the payout leg the approval records. The server refuses this payout until it is reviewed.'}
          </p>
        )}
        {rows.some((row) => row.ledgerRowFound !== false && typeof row.bookedAmount !== 'string') && (
          <p className="font-bold text-status-warning">
            {'A covered payout row has an amount this build cannot read. The server refuses this payout until it is reviewed.'}
          </p>
        )}
      </div>
    );
  }

  const message =
    state === 'legacy'
      ? 'This approval predates approved-amount storage: the approved total and the covered payout rows are not available. The payout remains bound to the payout rows booked at handover, and the server refuses it if any row or amount has changed.'
      : state === 'incomplete' || state === 'unreadable' || state === 'unavailable'
        ? 'The approval on file carries no readable amount/row record, so the approved total and covered payout rows cannot be shown. The server refuses this payout until the claim and the approval are reviewed.'
        : notApprovedNote || 'No settlement approval is on file, so no payout is authorized.';

  return (
    <div className="rounded-lg border border-[var(--appearance-border)] p-2 text-caption text-[var(--appearance-text-muted)]">
      <p>{message}</p>
    </div>
  );
}
