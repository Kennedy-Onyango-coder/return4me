import React from 'react';
import Badge, { type BadgeVariant } from '../../ui/Badge';
import Button from '../../ui/Button';
import type { StrandedQueueViewRow } from '../../../services/adminStrandedItemsApi';
import { STRANDED_NOT_RECORDED } from '../../../services/adminStrandedItemsApi';

// =============================================================================
// STAGE 3B-6B - THE STRANDED-ITEM QUEUE, AS A PURE TABLE
// =============================================================================
// WHY THIS IS ITS OWN MODULE
//   This is the screen an administrator reads before deciding that an item
//   somebody else is waiting for should stop being assigned to a hub that cannot
//   act, so what it renders has to be assertable. Keeping the table PURE (no
//   state, no effects, no fetch) means it can be rendered with react-dom/server
//   in this repository's node-only vitest environment and pinned cell by cell -
//   the same approach PayoutReconciliationTable and NotificationOutboxTable take.
//
// IT DECIDES NOTHING ABOUT WHO MAY BE RELEASED
//   Whether a row offers the release control is `row.canRelease`, which is the
//   SERVER's verdict (services/strandedItemsQueue.ts consults the Stage 3B-3
//   custody policy) copied through the API client. There is no release rule in
//   this file, so a policy change cannot leave a stale copy here offering an
//   action the server would refuse.
//
// WHAT IT RENDERS FOR A HELD ITEM
//   The row is LISTED, with the server's own custody sentence, and the action
//   cell says why there is no control. A disabled button is deliberately not
//   used: it explains nothing, and "not offered" is the truthful description of a
//   row that needs a human custody decision.
//
// TRUTHFULNESS
//   Every cell is written out field by field from the typed row - the table never
//   spreads a row and never renders raw JSON, so a field added to the API cannot
//   appear on screen by accident. A missing value renders the visible
//   STRANDED_NOT_RECORDED marker: never blank (which reads as "nothing here") and
//   never zero (which reads as a real figure).
// =============================================================================

const toneToVariant: Record<string, BadgeVariant> = {
  success: 'success',
  warning: 'warning',
  pending: 'pending',
  danger: 'danger',
  info: 'info',
  neutral: 'neutral',
};

const HEAD_CELL =
  'px-3 py-2 text-caption font-extrabold uppercase tracking-widest text-[var(--appearance-text-muted)] whitespace-nowrap';
const CELL = 'px-3 py-3 align-top text-caption text-[var(--appearance-text-primary)]';
const MUTED = 'block text-[var(--appearance-text-muted)]';
const MUTED_NOTE = 'block mt-1 max-w-[22rem] leading-relaxed text-[var(--appearance-text-muted)]';

/** A labelled sub-line, so a missing value is explicit rather than an empty cell. */
function SubLine({ label, value, mono = false }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <span className="block mt-1">
      <span className="text-[var(--appearance-text-muted)]">{`${label}: `}</span>
      <span className={mono ? 'font-mono break-all' : undefined}>{value ?? STRANDED_NOT_RECORDED}</span>
    </span>
  );
}

export interface StrandedItemsQueueTableProps {
  /** Rows in the server's order (most dangerous first). Never re-sorted here. */
  rows: readonly StrandedQueueViewRow[];
  /** The item whose release is currently in flight, or null. */
  inFlightItemId: string | null;
  /** Asks for the confirmation step. This is not the release itself. */
  onRequestRelease: (row: StrandedQueueViewRow) => void;
}

export default function StrandedItemsQueueTable({
  rows,
  inFlightItemId,
  onRequestRelease,
}: StrandedItemsQueueTableProps) {
  if (rows.length === 0) return null;

  return (
    <div
      className="r4m-scroll-x rounded-panel border border-[var(--appearance-border)] bg-[var(--appearance-surface)]"
      role="region"
      aria-label="Items stranded at hubs that cannot act"
      tabIndex={0}
    >
      <table className="w-full min-w-[62rem] border-collapse text-left">
        <caption className="sr-only">
          {'Items still assigned to a hub that cannot act. Each row shows the item, its hub and the hub\'s standing, how long the assignment has been in place, what the platform can say about the item\'s physical custody, and whether the assignment can be returned to the queue now.'}
        </caption>
        <thead>
          <tr className="border-b border-[var(--appearance-border)]">
            <th scope="col" className={HEAD_CELL}>{'Item'}</th>
            <th scope="col" className={HEAD_CELL}>{'Hub holding it'}</th>
            <th scope="col" className={HEAD_CELL}>{'Assigned'}</th>
            <th scope="col" className={HEAD_CELL}>{'Custody'}</th>
            <th scope="col" className={HEAD_CELL}>{'Review'}</th>
            <th scope="col" className={HEAD_CELL}>{'Action'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const busy = inFlightItemId === row.itemId;
            return (
              <tr
                key={row.itemId}
                className="border-b border-[var(--appearance-border)] last:border-0"
              >
                <td className={CELL}>
                  <span className="block font-mono font-bold break-all">{row.itemId}</span>
                  <span className="mt-1 block">
                    <Badge variant="neutral">{row.statusLabel}</Badge>
                  </span>
                  <SubLine label={'County'} value={row.countyLabel} />
                  <SubLine label={'Administrative unit'} value={row.administrativeUnitId} mono />
                </td>

                <td className={CELL}>
                  <span className="block font-bold">{row.agentName}</span>
                  <span className="mt-1 block">
                    <Badge variant={toneToVariant[row.agentStanding.tone] ?? 'neutral'}>
                      {row.agentStanding.label}
                    </Badge>
                  </span>
                  <SubLine label={'Hub id'} value={row.agentId} mono />
                  {!row.agentFound && (
                    <span className={MUTED_NOTE}>
                      {'The hub record could not be read, so its standing is unverified and nothing is offered for this row.'}
                    </span>
                  )}
                </td>
                <td className={CELL}>
                  {row.assignedAtLabel ? (
                    <span className="block whitespace-nowrap">{row.assignedAtLabel}</span>
                  ) : (
                    <span className={MUTED}>{STRANDED_NOT_RECORDED}</span>
                  )}
                  <span className={MUTED}>{row.ageLabel}</span>
                </td>

                <td className={CELL}>
                  <Badge variant={toneToVariant[row.custody.tone] ?? 'warning'}>
                    {row.custody.label}
                  </Badge>
                  <span className={MUTED_NOTE}>{row.custody.note}</span>
                </td>

                <td className={CELL}>
                  {row.reviewRequired ? (
                    <Badge variant="warning">{'Needs a human custody decision'}</Badge>
                  ) : (
                    <Badge variant="success">{'Safe to return now'}</Badge>
                  )}
                </td>

                <td className={CELL}>
                  {row.canRelease ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => onRequestRelease(row)}
                      disabled={inFlightItemId !== null}
                      loading={busy}
                      loadingLabel={'Returning this item to the queue'}
                      aria-label={`Return item ${row.itemId} to the assignment queue`}
                    >
                      {'Return to queue'}
                    </Button>
                  ) : (
                    <span className="block max-w-[22rem] leading-relaxed text-[var(--appearance-text-muted)]">
                      {row.refusal ?? 'This row cannot be returned to the queue from here.'}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
