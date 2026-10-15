import React from 'react';
import Badge from '../../ui/Badge';
import type { AdminAuditLogWindow } from '../../../services/adminAuditLogApi';

// =============================================================================
// PROGRAMME 1 / WS4 — THE AUDIT WINDOW, AS A PURE VIEW.
// =============================================================================
// WHY THIS IS ITS OWN MODULE
//   An audit trail is read to answer "who changed what, and when". What the
//   console actually prints therefore has to be assertable, so the rendering is
//   PURE — no state, no effects, no fetch, no handlers — and can be rendered with
//   `react-dom/server` in this repository's node-only vitest environment, exactly
//   like PayoutReconciliationTable.
//
// READ-ONLY BY CONSTRUCTION
//   There is no <button>, <input>, <select> or <form> in this file. The panel
//   around it may read, filter and refresh; nothing here can write, edit or
//   delete an audit entry, and the client it renders from has no such call.
//
// AN EMPTY WINDOW IS NOT AN EMPTY TRAIL
//   The applied window is always stated BEFORE the rows — the size the server
//   actually served and the filter it actually applied — and an empty result says
//   what was read ('at most N entries'), never 'nothing was ever recorded'.
//   That distinction is the difference between an audit trail an operator can
//   rely on and one that lies by omission.
//
// TRUTHFULNESS OF A ROW
//   * the action code is shown VERBATIM (audit codes are what an operator greps
//     and what other surfaces record) — it is never prettified into prose;
//   * a missing actor reads 'Not recorded', never an invented name and never the
//     neighbouring row's;
//   * a missing description says so; it is never blank (which reads as 'no
//     details were needed') and never borrowed from another row;
//   * the timestamp is shown as recorded plus its age; an unreadable timestamp
//     says so rather than showing a plausible-looking current time.
// =============================================================================

/** Shown beside the action field, so the accepted shape is stated up front. */
export const AUDIT_ACTION_FILTER_HINT =
  'An exact action code, for example PAYOUT_INITIATED. Leave empty for every action.';

/** Used when the server did not state a window size. */
export const WINDOW_NOT_STATED_TEXT = 'the size the server chose';

const TH_CLASS =
  'px-3 py-2.5 text-left text-caption font-extrabold uppercase tracking-wider text-[var(--appearance-text-muted)] whitespace-nowrap';
const TD_CLASS = 'px-3 py-3 align-top text-caption text-[var(--appearance-text-secondary)]';
const MUTED_CLASS = 'text-[var(--appearance-text-muted)]';
const MONO_CLASS = 'font-mono text-caption text-[var(--appearance-text-primary)]';

/** The sentence stating exactly what was read. Pure, so it is unit-testable. */
export function appliedWindowSentence(windowData: Pick<AdminAuditLogWindow, 'limit' | 'action' | 'count'>): string {
  const size = windowData.limit === null ? WINDOW_NOT_STATED_TEXT : `at most ${windowData.limit} entries`;
  const filter = windowData.action ? `filtered to the action ${windowData.action}` : 'with no action filter';
  return `Reading the newest ${size}, ${filter}: ${windowData.count} entr${windowData.count === 1 ? 'y' : 'ies'} in this window.`;
}

/**
 * The copy for a window that came back empty. It deliberately does not say that
 * nothing was recorded: a bounded window cannot support that claim.
 */
export function emptyWindowCopy(action: string | null): { title: string; description: string } {
  if (action) {
    return {
      title: 'No entries with this action',
      description: `No audit entry with the action code ${action} was found in the window that was read. Entries with this action may exist outside the window, or the code may be spelled differently — clear the filter to widen the read.`,
    };
  }
  return {
    title: 'No audit entries in this window',
    description: 'The newest entries the server read contain nothing. This says nothing about entries older than the window: widen the window before concluding that the trail is empty.',
  };
}

/** A stable key; the entry id is normally present, the index keeps it unique. */
function rowKey(row: AdminAuditLogWindow['rows'][number], index: number): string {
  return row.id ?? `audit:${index}`;
}

/**
 * The applied window and its rows. Renders no table at all when there are no
 * rows (the panel shows the empty statement instead), but it ALWAYS states what
 * was read, so an empty window can never be mistaken for an empty trail.
 */
export default function AuditLogWindowTable({
  window: windowData,
}: {
  window: AdminAuditLogWindow;
}) {
  return (
    <div className="space-y-3">
      <p className="text-caption text-[var(--appearance-text-secondary)]" role="status">
        {appliedWindowSentence(windowData)}
      </p>

      {windowData.rows.length > 0 && (
        <div
          className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-panel shadow-raised"
          role="region"
          aria-label={'Audit entries'}
          tabIndex={0}
        >
          <table className="w-full text-left border-collapse">
            <thead className="bg-[var(--appearance-surface-muted)]">
              <tr>
                <th scope="col" className={TH_CLASS}>{'Recorded'}</th>
                <th scope="col" className={TH_CLASS}>{'Action'}</th>
                <th scope="col" className={TH_CLASS}>{'Administrator'}</th>
                <th scope="col" className={TH_CLASS}>{'Details as recorded'}</th>
              </tr>
            </thead>
            <tbody>
              {windowData.rows.map((row, index) => (
                <tr key={rowKey(row, index)} className="border-b border-[var(--appearance-border)] last:border-0">
                  <td className={TD_CLASS}>
                    {row.recordedAtLabel ? (
                      <span>
                        <span className="block whitespace-nowrap text-[var(--appearance-text-primary)]">
                          {row.recordedAtLabel}
                        </span>
                        <span className={`block mt-1 ${MUTED_CLASS}`}>{`${row.ageLabel} ago`}</span>
                      </span>
                    ) : (
                      <span>
                        <span className="block text-[var(--appearance-text-primary)]">
                          {'Timestamp not recorded'}
                        </span>
                        <span className={`block mt-1 ${MUTED_CLASS}`}>{'Age unknown'}</span>
                      </span>
                    )}
                  </td>

                  <td className={TD_CLASS}>
                    <Badge variant="code">{row.actionLabel}</Badge>
                    {row.action === null && (
                      <span className={`block mt-1 ${MUTED_CLASS}`}>
                        {'This entry carries no action code. It is shown as recorded rather than classified by guesswork.'}
                      </span>
                    )}
                  </td>

                  <td className={TD_CLASS}>
                    <span className={MONO_CLASS}>{row.adminUserLabel}</span>
                  </td>

                  <td className={TD_CLASS}>
                    {row.detailsText ? (
                      <span>{row.detailsText}</span>
                    ) : (
                      <span className={MUTED_CLASS}>{'No description was recorded for this entry.'}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
