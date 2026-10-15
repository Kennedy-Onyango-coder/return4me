import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import Banner from '../../ui/Banner';
import Button from '../../ui/Button';
import EmptyState from '../../ui/EmptyState';
import Input from '../../ui/Input';
import SectionHeading from '../../ui/SectionHeading';
import Select from '../../ui/Select';
import Skeleton from '../../ui/Skeleton';
import { ICON_SIZE } from '../../ui/iconSize';
import AuditLogWindowTable, { AUDIT_ACTION_FILTER_HINT, emptyWindowCopy } from './AuditLogWindowTable';
import {
  AUDIT_LOG_WINDOW_DEFAULT,
  AUDIT_LOG_WINDOW_OPTIONS,
  isAuditActionFilter,
} from '../../../config/auditLogWindow';
import {
  AdminAuditLogApiError,
  fetchAuditLogWindow,
  formatRecordedAt,
  type AdminAuditLogWindow,
} from '../../../services/adminAuditLogApi';

// =============================================================================
// PROGRAMME 1 / WS4 — THE AUDIT-LOG SECTION (ADMIN CONSOLE, READ-ONLY)
// =============================================================================
// The one place the console reads GET /api/admin/audit-logs. Provisioning an
// administrator left no trail an operator could read afterwards; this is that
// trail, and it is deliberately a bounded WINDOW rather than the whole table.
//
// THE WINDOW IS THE SERVER'S DECISION
//   config/auditLogWindow.ts owns the bound and REFUSES a bad request rather
//   than clamping it. This panel therefore:
//     * offers only sizes from AUDIT_LOG_WINDOW_OPTIONS (every one within the
//       server's maximum), so the console cannot ask for a refused window by
//       accident;
//     * states the window the server ACTUALLY applied (its `limit` and `action`
//       echo), not the one this panel asked for;
//     * shows the server's own refusal sentence when a request is refused.
//
// A TYPO IS NEVER AN EMPTY RESULT
//   The action filter is validated with the SAME predicate the server uses
//   (isAuditActionFilter) BEFORE anything is sent, and it is applied only when
//   the operator presses Apply — a half-typed code never reaches the API and can
//   never be mistaken for "no entries with this action". Clearing re-reads.
//
// REQUEST DISCIPLINE (the same rules as PayoutReconciliationPanel)
//   * one request per (mount, Apply, Clear, Refresh, window change) — no polling;
//   * an AbortController AND a sequence guard, so a slow superseded read cannot
//     overwrite a newer one and leaving the tab cancels the read;
//   * an aborted read is silent — it is not an error and is never shown as one;
//   * nothing is logged.
//
// READ-ONLY BY CONSTRUCTION
//   The client this panel uses exposes GET only and the table renders no control.
//   There is no way from this section to write, edit or delete an audit entry;
//   Refresh re-READS.
//
// MISSING NEVER MEANS EMPTY
//   A failed read keeps the last successfully-read window on screen and says it
//   may be out of date. A FIRST read that failed shows the error and no empty
//   statement, because "no audit entries" would be a claim this console did not
//   earn.
// =============================================================================

/** The panel's DOM id, so the console's nav can point at it. */
export const AUDIT_LOG_PANEL_ID = 'audit-log-panel';

const HEADING_ID = 'audit-log-heading';
const ACTION_INPUT_ID = 'audit-action-filter';
const WINDOW_SELECT_ID = 'audit-window-size';

/** The sentence shown when a typed filter is not an action code. Fixed text. */
const INVALID_FILTER_MESSAGE =
  'An audit action filter must be an upper-case action code, for example PAYOUT_INITIATED.';

export default function AuditLogPanel({ token }: { token: string | null }) {
  // The window size the operator chose; the server still validates it.
  const [limit, setLimit] = useState<number>(AUDIT_LOG_WINDOW_DEFAULT);
  // The typed filter and the APPLIED one are separate: only Apply moves it.
  const [draftAction, setDraftAction] = useState('');
  const [appliedAction, setAppliedAction] = useState<string | null>(null);
  const [filterError, setFilterError] = useState<string | null>(null);

  const [windowData, setWindowData] = useState<AdminAuditLogWindow | null>(null);
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

    fetchAuditLogWindow(token, { limit, action: appliedAction, signal: controller.signal })
      .then((next) => {
        if (requestId !== requestIdRef.current) return;
        setWindowData(next);
        setError(null);
        setLastReadAt(formatRecordedAt(new Date().toISOString()));
      })
      .catch((err: unknown) => {
        if (requestId !== requestIdRef.current) return;
        // A deliberately-cancelled read is not a failure.
        if (err instanceof AdminAuditLogApiError && err.isAbort) return;
        setError(err instanceof AdminAuditLogApiError
          ? err.message
          : 'The audit log could not be read.');
      })
      .finally(() => {
        if (requestId !== requestIdRef.current) return;
        setLoading(false);
      });

    return () => controller.abort();
  }, [token, limit, appliedAction, reloadToken]);

  /** The ONE re-read control. It reads; it never writes an entry. */
  const refresh = useCallback(() => setReloadToken((n) => n + 1), []);

  /**
   * Apply the typed action filter. A code this build does not recognise is
   * refused HERE with the same predicate the server applies, so neither a typo
   * nor a stray space can be answered with an empty window.
   */
  const applyFilter = useCallback(() => {
    const trimmed = draftAction.trim();
    if (trimmed && !isAuditActionFilter(trimmed)) {
      setFilterError(INVALID_FILTER_MESSAGE);
      return;
    }
    setFilterError(null);
    const next = trimmed ? trimmed : null;
    // Re-applying the same filter is still an explicit "read it again", so it
    // must not silently do nothing.
    if (next === appliedAction) setReloadToken((n) => n + 1);
    else setAppliedAction(next);
  }, [draftAction, appliedAction]);

  /** Clear the filter and re-read every action. */
  const clearFilter = useCallback(() => {
    setDraftAction('');
    setFilterError(null);
    if (appliedAction === null) setReloadToken((n) => n + 1);
    else setAppliedAction(null);
  }, [appliedAction]);

  const hasRows = (windowData?.rows.length ?? 0) > 0;
  const emptyCopy = !loading && !error && windowData !== null && !hasRows
    ? emptyWindowCopy(windowData.action)
    : null;

  return (
    <section
      id={AUDIT_LOG_PANEL_ID}
      aria-labelledby={HEADING_ID}
      className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-panel shadow-raised p-4 sm:p-6 space-y-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionHeading
          titleId={HEADING_ID}
          eyebrow={'Configuration'}
          title={'Audit log'}
          description={'The most recent recorded administrative actions: who acted, which action code was recorded, and when. This is a READ of a bounded window of the trail — no control on this screen can write, edit or delete an audit entry.'}
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={refresh}
          loading={loading}
          loadingLabel={'Reading the audit log'}
        >
          {!loading && <RefreshCw size={ICON_SIZE.metadata} aria-hidden="true" />}
          {'Refresh'}
        </Button>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,16rem)] lg:items-start">
        <div className="flex flex-wrap items-start gap-2">
          <Input
            id={ACTION_INPUT_ID}
            className="min-w-[16rem] flex-1"
            label={'Action code'}
            hint={AUDIT_ACTION_FILTER_HINT}
            error={filterError ?? undefined}
            value={draftAction}
            onChange={(event) => setDraftAction(event.target.value)}
            placeholder={'PAYOUT_INITIATED'}
            spellCheck={false}
            autoComplete="off"
          />
          <Button variant="secondary" size="sm" onClick={applyFilter} loading={loading} loadingLabel={'Applying the filter'}>
            {'Apply filter'}
          </Button>
          <Button variant="ghost" size="sm" onClick={clearFilter} disabled={loading}>
            {'Clear'}
          </Button>
        </div>

        <Select
          id={WINDOW_SELECT_ID}
          label={'Window size'}
          hint={'How many of the newest entries to read. The API refuses a window larger than 500.'}
          value={String(limit)}
          onChange={(event) => setLimit(Number(event.target.value))}
        >
          {AUDIT_LOG_WINDOW_OPTIONS.map((size) => (
            <option key={size} value={String(size)}>{`${size} entries`}</option>
          ))}
        </Select>
      </div>

      <p className="text-caption text-[var(--appearance-text-muted)]">
        {loading
          ? 'Reading the audit log…'
          : lastReadAt
            ? `Last read ${lastReadAt}.`
            : 'This window has not been read yet.'}
      </p>

      {error && (
        <Banner kind={hasRows ? 'warning' : 'error'}>
          {hasRows
            ? `${error} The entries below are from the last successful read and may be out of date.`
            : error}
        </Banner>
      )}

      {loading && windowData === null ? (
        <div className="space-y-3" aria-busy="true">
          <span className="sr-only">{'Loading the audit log…'}</span>
          <Skeleton shape="card" className="w-full" />
          <Skeleton shape="card" className="w-full" />
        </div>
      ) : windowData ? (
        <>
          <AuditLogWindowTable window={windowData} />
          {emptyCopy && (
            <EmptyState
              icon={ShieldCheck}
              title={emptyCopy.title}
              description={emptyCopy.description}
            />
          )}
        </>
      ) : null}
    </section>
  );
}
