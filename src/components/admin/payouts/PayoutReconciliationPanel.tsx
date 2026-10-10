import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import Banner from '../../ui/Banner';
import Button from '../../ui/Button';
import EmptyState from '../../ui/EmptyState';
import SectionHeading from '../../ui/SectionHeading';
import Skeleton from '../../ui/Skeleton';
import { ICON_SIZE } from '../../ui/iconSize';
import PayoutReconciliationTable from './PayoutReconciliationTable';
import {
  AdminPayoutReconciliationApiError,
  fetchUnresolvedPayouts,
  formatRecordedAt,
  type PayoutReconciliationRow,
} from '../../../services/adminPayoutReconciliationApi';

// =============================================================================
// BATCH 2 — UNRESOLVED PAYOUTS (ADMIN CONSOLE PANEL, READ-ONLY)
// =============================================================================
// The one place the console reads GET /api/admin/payout-reconciliation. It is
// deliberately a DISCLOSED panel rather than a tab: the overview already reports
// the unresolved-payout COUNT (Batch 1), and this is the rows behind it, read
// only when an operator asks for them — so the console's ordinary cost is
// unchanged.
//
// REQUEST DISCIPLINE (the same rules as LostReportsAdministration)
//   * one request per (mount, Refresh) — no polling, no per-row request;
//   * AbortController AND a sequence guard (`requestId`), so a slow response for
//     a superseded read can never overwrite a newer one, and leaving the tab
//     cancels a read that is no longer wanted;
//   * an aborted read is silent — it is not an error and must never be shown as
//     one (a cancelled refresh would otherwise look like a failure);
//   * nothing is logged.
//
// WHAT IT MAY NOT DO
//   There is no retry, no resubmit, no "mark as paid" and no refund control here,
//   and the client it uses cannot express one. The Refresh control re-READS the
//   list; it never re-sends a payout. That distinction is the whole point of the
//   surface: a payout whose provider outcome is unresolved may already have moved
//   money, so the only correct action is a manual check with the provider.
//
// MISSING NEVER MEANS ZERO
//   A read that failed leaves the last successfully-read rows in place and says
//   they may be out of date; a first read that failed shows the error and NO empty
//   state, because "No unresolved payouts" would be a false statement about money.
// =============================================================================

/** The panel's DOM id, so the console's disclosure button can point at it. */
export const PAYOUT_RECONCILIATION_PANEL_ID = 'payout-reconciliation-panel';

const HEADING_ID = 'payout-reconciliation-heading';

export default function PayoutReconciliationPanel({ token }: { token: string | null }) {
  const [rows, setRows] = useState<PayoutReconciliationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [lastReadAt, setLastReadAt] = useState('');
  // Only the newest read may write state.
  const requestIdRef = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const requestId = ++requestIdRef.current;
    setLoading(true);

    fetchUnresolvedPayouts(token, { signal: controller.signal })
      .then((next) => {
        if (requestId !== requestIdRef.current) return;
        setRows(next);
        setError(null);
        setLastReadAt(formatRecordedAt(new Date().toISOString()));
      })
      .catch((err: unknown) => {
        if (requestId !== requestIdRef.current) return;
        // A deliberately-cancelled read is not a failure.
        if (err instanceof AdminPayoutReconciliationApiError && err.isAbort) return;
        setError(err instanceof AdminPayoutReconciliationApiError
          ? err.message
          : 'The unresolved-payout list could not be loaded.');
      })
      .finally(() => {
        if (requestId !== requestIdRef.current) return;
        setLoading(false);
      });

    return () => controller.abort();
  }, [token, reloadToken]);

  /** The ONE re-read control. It reads; it never re-sends a payout. */
  const refresh = useCallback(() => setReloadToken((n) => n + 1), []);
  const hasRows = rows.length > 0;

  return (
    <section
      id={PAYOUT_RECONCILIATION_PANEL_ID}
      aria-labelledby={HEADING_ID}
      className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-panel shadow-raised p-4 sm:p-6 space-y-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionHeading
          titleId={HEADING_ID}
          eyebrow={'Operations'}
          title={'Unresolved payouts'}
          description={'Every finder and agent payout that is not confirmed paid and is not safe to send again automatically. Read-only: check each row with the provider. Nothing here can resend, refund or mark a payout paid.'}
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={refresh}
          loading={loading}
          loadingLabel={'Reading unresolved payouts'}
        >
          {!loading && <RefreshCw size={ICON_SIZE.metadata} aria-hidden="true" />}
          {'Refresh'}
        </Button>
      </div>

      <p className="text-caption text-[var(--appearance-text-muted)]">
        {loading
          ? 'Reading the unresolved-payout list…'
          : (lastReadAt ? `Last read ${lastReadAt}.` : 'This list has not been read yet.')}
      </p>

      {error && (
        <Banner kind={hasRows ? 'warning' : 'error'}>
          {hasRows
            ? `${error} The rows below are from the last successful read and may be out of date.`
            : error}
        </Banner>
      )}

      {loading && !hasRows ? (
        <div className="space-y-3" aria-busy="true">
          <span className="sr-only">{'Loading unresolved payouts…'}</span>
          <Skeleton shape="card" className="w-full" />
          <Skeleton shape="card" className="w-full" />
        </div>
      ) : hasRows ? (
        <PayoutReconciliationTable rows={rows} />
      ) : error ? null : (
        // Reached only after a SUCCESSFUL read that returned no rows: an empty
        // list is stated only when it was actually read.
        <EmptyState
          icon={ShieldCheck}
          title={'No unresolved payouts'}
          description={'Nothing is waiting on a provider check right now. Every finder and agent payout is either confirmed paid or still waiting for its first submission.'}
        />
      )}
    </section>
  );
}
