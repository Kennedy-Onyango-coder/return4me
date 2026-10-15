import React from 'react';
import Badge from '../../ui/Badge';
import { NOT_RECORDED_TEXT } from './PayoutReconciliationTable';
import type { PayoutIntegrityHubRow } from './payoutIntegrityPresentation';

// =============================================================================
// PROGRAMME 1 / WS1 + WS2 + WS5 — THE PER-HUB PAYOUT VERDICT, AS A PURE TABLE.
// =============================================================================
// WHY THIS IS ITS OWN MODULE
//   "Which hubs can never be paid?" is the question an administrator has to act
//   on, so what the console renders for it has to be assertable. This table is
//   PURE — no state, no effects, no fetch, no handlers — so it can be rendered
//   with `react-dom/server` in this repository's node-only vitest environment
//   and pinned cell by cell, exactly like PayoutReconciliationTable beside it.
//
// READ-ONLY BY CONSTRUCTION
//   There is no <button>, <input>, <select> or <form> here: nothing in this file
//   can change a hub's destination, method or payout state. This build offers NO
//   control that corrects a stored destination or method, and retrying a refused
//   payout does not correct it either — the same stored value is refused again.
//   This table only states what the settlement executor will do with the hub as
//   it stands.
//
// TRUTHFULNESS
//   * a cell the row does not carry renders the visible missing marker — never
//     blank (which reads as "nothing here") and never 0 (which reads as a real
//     figure);
//   * the destination column shows ONLY the masked value; this file has no way
//     to express an unmasked number;
//   * a verdict this console could not read is shown as its own badge with no
//     invented reason — not as payable and not as a guessed refusal;
//   * "Earned, not yet paid" states the missing case in words, so an unstatable
//     total is never read as "nothing owed".
// =============================================================================

const TH_CLASS =
  'px-3 py-2.5 text-left text-caption font-extrabold uppercase tracking-wider text-[var(--appearance-text-muted)] whitespace-nowrap';
const TD_CLASS = 'px-3 py-3 align-top text-caption text-[var(--appearance-text-secondary)]';
const MUTED_CLASS = 'text-[var(--appearance-text-muted)]';
const MONO_CLASS = 'font-mono text-caption text-[var(--appearance-text-primary)]';

/** The visible statement for a total the server could not state. */
export const PENDING_EARNINGS_UNSTATABLE_TEXT =
  'No total could be stated for this hub: at least one payout row carries an amount this build cannot read. Check the ledger before paying this hub.';

/** A stable key: the hub id is normally present; the index keeps it unique. */
function rowKey(row: PayoutIntegrityHubRow, index: number): string {
  return row.agentId ?? `hub:${index}`;
}

/** The badge tone for a verdict. Unreadable is neutral-and-explicit, never green. */
function verdictVariant(row: PayoutIntegrityHubRow): 'success' | 'danger' | 'neutral' {
  if (row.eligible) return 'success';
  return row.verdictUnreadable ? 'neutral' : 'danger';
}

/**
 * The hub rows, exactly as given: the console does not re-sort or filter here,
 * so what an operator sees is what the payload contained.
 */
export default function PayoutIntegrityHubsTable({
  rows,
}: {
  rows: readonly PayoutIntegrityHubRow[];
}) {
  return (
    <div
      className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-panel shadow-raised"
      role="region"
      aria-label={'Payout eligibility by hub'}
      tabIndex={0}
    >
      <table className="w-full text-left border-collapse">
        <thead className="bg-[var(--appearance-surface-muted)]">
          <tr>
            <th scope="col" className={TH_CLASS}>{'Hub'}</th>
            <th scope="col" className={TH_CLASS}>{'Payout destination (masked)'}</th>
            <th scope="col" className={TH_CLASS}>{'Launch-policy verdict'}</th>
            <th scope="col" className={TH_CLASS}>{'Earned, not yet paid'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={rowKey(row, index)} className="border-b border-[var(--appearance-border)] last:border-0">
              <td className={TD_CLASS}>
                <span className="block font-bold text-[var(--appearance-text-primary)]">
                  {row.businessName}
                </span>
                <span className="block mt-1">
                  <span className={MUTED_CLASS}>{'Hub id: '}</span>
                  <span className={MONO_CLASS}>{row.agentId ?? NOT_RECORDED_TEXT}</span>
                </span>
              </td>

              <td className={TD_CLASS}>
                <span className={MONO_CLASS}>{row.destinationMasked}</span>
                <span className={`block mt-1 ${MUTED_CLASS}`}>
                  {row.destinationMasked === '(none)'
                    ? 'No destination is recorded for this hub.'
                    : 'Masked. The full number is never sent to this screen.'}
                </span>
              </td>

              <td className={TD_CLASS}>
                <Badge variant={verdictVariant(row)}>{row.riskLabel}</Badge>
                <span className="block mt-1">
                  <span className={MUTED_CLASS}>{'Class: '}</span>
                  <span className={MONO_CLASS}>{row.riskClass ?? NOT_RECORDED_TEXT}</span>
                </span>
                {row.summary && <span className="block mt-1">{row.summary}</span>}
                {!row.eligible && (
                  <span className={`block mt-1 ${MUTED_CLASS}`}>
                    {'Settlement refuses this hub as it stands. This build provides no control that corrects a stored destination or method, so the value cannot be fixed here; retrying a refused payout does not correct it. This screen only reports the verdict.'}
                  </span>
                )}
              </td>

              <td className={TD_CLASS}>
                <span className="block font-bold text-[var(--appearance-text-primary)] tabular-nums">
                  {row.pendingEarningsLabel}
                </span>
                {row.pendingEarningsReported ? (
                  <span className={`block mt-1 ${MUTED_CLASS}`}>
                    {row.pendingPayoutCount === null
                      ? 'The number of payout rows behind this total could not be read. The figure above is still the money recorded as owed.'
                      : `${row.pendingPayoutCount} payout row(s) recorded as owed and not yet paid out.`}
                  </span>
                ) : (
                  <span className={`block mt-1 ${MUTED_CLASS}`}>{PENDING_EARNINGS_UNSTATABLE_TEXT}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
