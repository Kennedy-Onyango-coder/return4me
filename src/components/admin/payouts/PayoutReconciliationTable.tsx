import React from 'react';
import Badge from '../../ui/Badge';
import type { PayoutReconciliationRow } from '../../../services/adminPayoutReconciliationApi';

// =============================================================================
// BATCH 2 — THE UNRESOLVED-PAYOUT ROWS, AS A PURE TABLE.
// =============================================================================
// WHY THIS IS ITS OWN MODULE
//   The console's reconciliation list is the surface an operator reads while
//   checking a payout against the provider, so what it actually renders has to be
//   assertable. Keeping the table PURE (no state, no effects, no fetch, no
//   handlers) means it can be rendered with `react-dom/server` in this
//   repository's node-only vitest environment and pinned cell by cell — the same
//   approach components/admin/settlement/SettlementPayoutConfirmation.tsx takes
//   for the payout confirmation, whose rendering test covers it the same way.
//
// READ-ONLY BY CONSTRUCTION
//   There is no <button>, no <input>, no <select> and no <form> here. Nothing in
//   this file can retry, resubmit, refund or mark a payout paid, and nothing calls
//   a handler: the rows are visible, not actionable. The one mutation the
//   reconciliation workflow has (a manual provider check) happens OUTSIDE this
//   platform, which is exactly why this surface only reports.
//
// TRUTHFULNESS
//   Every cell is written out field by field from the typed row — the table never
//   spreads a row object and never renders raw JSON, so a field added to the API
//   in future cannot appear on screen by accident. A value the row does not carry
//   renders the visible NOT_RECORDED_TEXT marker; it is never blank (which would
//   read as "nothing here") and never 0 (which would read as a real figure). The
//   recipient column shows only the masked value the service module already
//   produced — this file has no way to express an unmasked number.

/** The single visible marker for a value the row does not carry. */
export const NOT_RECORDED_TEXT = 'Not recorded';

const TH_CLASS =
  'px-3 py-2.5 text-left text-caption font-extrabold uppercase tracking-wider text-[var(--appearance-text-muted)] whitespace-nowrap';
const TD_CLASS = 'px-3 py-3 align-top text-caption text-[var(--appearance-text-secondary)]';
const MUTED_CLASS = 'text-[var(--appearance-text-muted)]';
const MONO_CLASS = 'font-mono text-caption text-[var(--appearance-text-primary)]';

/** A labelled sub-line inside a cell ("Claim: …"), so a missing id is explicit. */
function SubLine({ label, value, mono = false }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <span className="block mt-1">
      <span className={MUTED_CLASS}>{`${label}: `}</span>
      <span className={mono ? MONO_CLASS : undefined}>{value ?? NOT_RECORDED_TEXT}</span>
    </span>
  );
}

/** A stable key for a row. The ledger id is normally present; the fallback keeps
 *  two rows sharing a claim/item from colliding. */
function rowKey(row: PayoutReconciliationRow, index: number): string {
  return row.ledgerEntryId ?? `${row.claimId ?? 'claim'}:${row.itemId ?? 'item'}:${index}`;
}

/**
 * The unresolved-payout rows. Oldest recorded first (the service module sorts
 * them, and this table renders the order it is given rather than re-sorting).
 */
export default function PayoutReconciliationTable({
  rows,
}: {
  rows: readonly PayoutReconciliationRow[];
}) {
  return (
    <div
      className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-panel shadow-sm r4m-scroll-x"
      role="region"
      aria-label={'Unresolved payouts table'}
      tabIndex={0}
    >
      <table className="min-w-full">
        <caption className="sr-only">
          {'Unresolved finder and agent payouts, oldest recorded first'}
        </caption>
        <thead className="bg-[var(--appearance-surface-muted)] border-b border-[var(--appearance-border)]">
          <tr>
            <th scope="col" className={TH_CLASS}>{'Payout'}</th>
            <th scope="col" className={TH_CLASS}>{'Amount'}</th>
            <th scope="col" className={TH_CLASS}>{'Ledger status'}</th>
            <th scope="col" className={TH_CLASS}>{'Provider outcome'}</th>
            <th scope="col" className={TH_CLASS}>{'Recipient'}</th>
            <th scope="col" className={TH_CLASS}>{'Provider references'}</th>
            <th scope="col" className={TH_CLASS}>{'Recorded'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={rowKey(row, index)} className="border-b border-[var(--appearance-border)] last:border-0">
              <td className={TD_CLASS}>
                <Badge variant="neutral">{row.payoutTypeLabel}</Badge>
                <SubLine label={'Claim'} value={row.claimId} mono />
                <SubLine label={'Item'} value={row.itemId} mono />
                <SubLine label={'Ledger row'} value={row.ledgerEntryId} mono />
              </td>

              <td className={TD_CLASS}>
                <span className="font-bold text-[var(--appearance-text-primary)] tabular-nums">
                  {row.amountLabel}
                </span>
                {!row.amountReported && (
                  <span className={`block mt-1 ${MUTED_CLASS}`}>{'No amount was recorded for this row.'}</span>
                )}
              </td>

              <td className={TD_CLASS}>{row.ledgerStatus ?? NOT_RECORDED_TEXT}</td>

              <td className={TD_CLASS}>
                {/* The badge carries the tone AND the sentence: the label states
                    what the recorded outcome means, and 'accepted' never reads as
                    paid. An unknown or absent outcome falls to "unresolved". */}
                <Badge variant={row.outcome.tone}>{row.outcome.label}</Badge>
                <SubLine label={'Recorded outcome'} value={row.outcome.outcome} mono />
                {row.reason && (
                  <span className="block mt-1">
                    <span className={MUTED_CLASS}>{'Recorded reason: '}</span>
                    {row.reason}
                  </span>
                )}
              </td>

              <td className={TD_CLASS}>
                <span className={MONO_CLASS}>{row.recipientMasked ?? NOT_RECORDED_TEXT}</span>
                {row.recipientMasked && (
                  <span className={`block mt-1 ${MUTED_CLASS}`}>{'Masked'}</span>
                )}
              </td>

              <td className={TD_CLASS}>
                <SubLine label={'Batch'} value={row.providerBatchId} mono />
                <SubLine label={'Transaction'} value={row.providerTransactionId} mono />
              </td>

              <td className={TD_CLASS}>
                {row.recordedAtLabel
                  ? (
                    <span>
                      <span className="block whitespace-nowrap">{row.recordedAtLabel}</span>
                      <span className={`block mt-1 ${MUTED_CLASS}`}>{`${row.ageLabel} ago`}</span>
                    </span>
                  )
                  : (
                    <span>
                      <span className="block">{NOT_RECORDED_TEXT}</span>
                      <span className={`block mt-1 ${MUTED_CLASS}`}>{'Age unknown'}</span>
                    </span>
                  )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
