import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Clock, Loader2, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import Badge from '../../ui/Badge';
import Banner from '../../ui/Banner';
import Button from '../../ui/Button';
import EmptyState from '../../ui/EmptyState';
import Input from '../../ui/Input';
import SectionHeading from '../../ui/SectionHeading';
import Select from '../../ui/Select';
import Skeleton from '../../ui/Skeleton';
import Textarea from '../../ui/Textarea';
import { ICON_SIZE } from '../../ui/iconSize';
import { formatRecordedAt } from '../../../services/adminPayoutReconciliationApi';
import {
  AdminAgentPayoutChangeApiError,
  AGENT_PAYOUT_ATTESTATION_METHOD,
  AGENT_PAYOUT_ATTESTATION_NOTE_MAX_LENGTH,
  AGENT_PAYOUT_CHANGE_MAX_REJECTION_REASON_LENGTH,
  AGENT_PAYOUT_CHANGE_STATUS_FILTERS,
  approveAgentPayoutDestinationChange,
  attestAgentPayoutDestinationChange,
  fetchAgentPayoutDestinationChange,
  fetchAgentPayoutDestinationChanges,
  rejectAgentPayoutDestinationChange,
  type AgentPayoutAdminView,
  type AgentPayoutChangeStatus,
} from '../../../services/adminAgentPayoutDestinationChangesApi';
import {
  AGENT_PAYOUT_ACTION_BLOCK_MESSAGES,
  AGENT_PAYOUT_STATE_LABELS,
  agentPayoutStateVariant,
  approvalActionFor,
  attestationActionFor,
  buildAgentPayoutTimeline,
  describeActivationBlocker,
  isLiveAgentPayoutChange,
  rejectionActionFor,
} from './agentPayoutDestinationChangesPresentation';

// =============================================================================
// PHASE 2 — AGENT PAYOUT DESTINATION CHANGES (ADMIN CONSOLE)
// =============================================================================
// This is the Admin Console surface for the routes that already existed:
//   GET  /api/admin/agent-payout-destination-changes
//   GET  /api/admin/agent-payout-destination-changes/:id
//   POST /api/admin/agent-payout-destination-changes/:id/attest
//   POST /api/admin/agent-payout-destination-changes/:id/approve
//   POST /api/admin/agent-payout-destination-changes/:id/reject
//
// The server owns every decision. This panel:
//   * renders only the masked destination the server projected;
//   * calls the attestation an ATTESTATION, never "verification", and states
//     plainly that no code was sent and no email OTP proves a phone number;
//   * shows the server's timeline plus its terminal outcome;
//   * refuses to offer an approval to the administrator who attested, while the
//     server independently refuses ATTESTER_APPROVER_CONFLICT;
//   * sends one request per deliberate submission, with no polling and no
//     optimistic state change.
//
// HIDING A CONTROL IS NEVER THE AUTHORIZATION. Every mutation still runs
// through authenticateJWT + requireCurrentAdminSession + requireAdminRole on the
// server, and attest/approve additionally re-authenticate the operator password.
// =============================================================================

export const AGENT_PAYOUT_CHANGES_PANEL_ID = 'agent-payout-destination-changes-panel';
const HEADING_ID = 'agent-payout-destination-changes-heading';
const PAGE_SIZE = 25;

type ActionKind = 'attest' | 'approve' | 'reject';

function showTimestamp(value: string | null): string {
  const formatted = formatRecordedAt(value);
  return formatted || 'Not recorded';
}

export default function AgentPayoutDestinationChangesPanel({
  token,
  currentAdministrator = null,
}: {
  token: string | null;
  /** Display/gating only. The server identifies the approver from the token. */
  currentAdministrator?: string | null;
}) {
  // ---- list ---------------------------------------------------------------
  const [statusFilter, setStatusFilter] = useState<AgentPayoutChangeStatus | ''>('');
  const [offset, setOffset] = useState(0);
  const [requests, setRequests] = useState<AgentPayoutAdminView[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [lastReadAt, setLastReadAt] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const listRequestIdRef = useRef(0);

  // ---- detail -------------------------------------------------------------
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgentPayoutAdminView | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailRequestIdRef = useRef(0);

  // ---- action forms -------------------------------------------------------
  const [actionInFlight, setActionInFlight] = useState<ActionKind | null>(null);
  const [actionMessage, setActionMessage] = useState('');
  const [actionError, setActionError] = useState<{ message: string; code: string | null } | null>(null);
  const [attestNote, setAttestNote] = useState('');
  const [attestPassword, setAttestPassword] = useState('');
  const [attestFieldError, setAttestFieldError] = useState('');
  const [approvePassword, setApprovePassword] = useState('');
  const [approveFieldError, setApproveFieldError] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [rejectFieldError, setRejectFieldError] = useState('');

  // ---- list read ----------------------------------------------------------
  useEffect(() => {
    const controller = new AbortController();
    const requestId = ++listRequestIdRef.current;
    setListLoading(true);
    fetchAgentPayoutDestinationChanges(token, {
      status: statusFilter,
      limit: PAGE_SIZE,
      offset,
      signal: controller.signal,
    })
      .then((next) => {
        if (requestId !== listRequestIdRef.current) return;
        setRequests(next.requests);
        setHasMore(next.has_more);
        setListError(null);
        setLastReadAt(new Date().toLocaleTimeString());
      })
      .catch((error: unknown) => {
        if (requestId !== listRequestIdRef.current) return;
        if (error instanceof AdminAgentPayoutChangeApiError && error.isAbort) return;
        setListError(
          error instanceof AdminAgentPayoutChangeApiError
            ? error.message
            : 'The payout destination change list could not be loaded.',
        );
      })
      .finally(() => {
        if (requestId !== listRequestIdRef.current) return;
        setListLoading(false);
      });
    return () => controller.abort();
  }, [token, statusFilter, offset, reloadToken]);

  const refreshList = useCallback(() => setReloadToken((value) => value + 1), []);

  // ---- detail read --------------------------------------------------------
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }
    const controller = new AbortController();
    const requestId = ++detailRequestIdRef.current;
    setDetailLoading(true);
    setDetailError(null);
    fetchAgentPayoutDestinationChange(token, selectedId, { signal: controller.signal })
      .then((next) => {
        if (requestId !== detailRequestIdRef.current) return;
        setDetail(next);
      })
      .catch((error: unknown) => {
        if (requestId !== detailRequestIdRef.current) return;
        if (error instanceof AdminAgentPayoutChangeApiError && error.isAbort) return;
        setDetailError(
          error instanceof AdminAgentPayoutChangeApiError
            ? error.message
            : 'The payout destination change could not be loaded.',
        );
      })
      .finally(() => {
        if (requestId !== detailRequestIdRef.current) return;
        setDetailLoading(false);
      });
    return () => controller.abort();
  }, [token, selectedId]);

  const resetActionFeedback = () => {
    setActionMessage('');
    setActionError(null);
  };

  const clearActionFields = (kind: ActionKind) => {
    if (kind === 'attest') {
      setAttestNote('');
      setAttestPassword('');
      setAttestFieldError('');
    } else if (kind === 'approve') {
      setApprovePassword('');
      setApproveFieldError('');
    } else {
      setRejectReason('');
      setRejectFieldError('');
    }
  };

  /** Apply the server's returned row to BOTH surfaces, never an optimistic guess. */
  const applyUpdatedRequest = (updated: AgentPayoutAdminView) => {
    setDetail(updated);
    setRequests((current) => current.map((row) => (row.id === updated.id ? updated : row)));
  };

  const handleActionError = (kind: ActionKind, error: unknown) => {
    // The credential is single-use per attempt and never survives a refusal.
    clearActionFields(kind);
    if (error instanceof AdminAgentPayoutChangeApiError) {
      if (error.request) applyUpdatedRequest(error.request);
      setActionError({ message: error.message, code: error.code });
      // A conflict means the persisted row moved under us. Re-read the queue and
      // the detail rather than leaving a stale decision on screen.
      if (error.kind === 'conflict' || error.kind === 'not_found') {
        refreshList();
        if (selectedId) {
          detailRequestIdRef.current += 1;
          setDetailLoading(true);
          fetchAgentPayoutDestinationChange(token, selectedId)
            .then((next) => setDetail(next))
            .catch(() => undefined)
            .finally(() => setDetailLoading(false));
        }
      }
      return;
    }
    setActionError({
      message: error instanceof Error ? error.message : 'The request could not be completed.',
      code: null,
    });
  };

  const submitAttestation = async () => {
    if (!detail || actionInFlight !== null) return;
    const note = attestNote.trim();
    if (!note) {
      setAttestFieldError('Describe what the phone call established. This note is required.');
      return;
    }
    if (note.length > AGENT_PAYOUT_ATTESTATION_NOTE_MAX_LENGTH) {
      setAttestFieldError(`The note must be at most ${AGENT_PAYOUT_ATTESTATION_NOTE_MAX_LENGTH} characters.`);
      return;
    }
    if (!attestPassword) {
      setAttestFieldError('Your password is required to record this attestation.');
      return;
    }
    resetActionFeedback();
    setAttestFieldError('');
    setActionInFlight('attest');
    try {
      const result = await attestAgentPayoutDestinationChange(token, detail.id, {
        password: attestPassword,
        note,
      });
      applyUpdatedRequest(result.request);
      setActionMessage(result.message);
      setAttestNote('');
      refreshList();
    } catch (error) {
      handleActionError('attest', error);
    } finally {
      setAttestPassword('');
      setActionInFlight(null);
    }
  };

  const submitApproval = async () => {
    if (!detail || actionInFlight !== null) return;
    const decision = approvalActionFor(detail, currentAdministrator);
    if (!decision.allowed) {
      setApproveFieldError(
        decision.reason ? AGENT_PAYOUT_ACTION_BLOCK_MESSAGES[decision.reason] : 'This approval is not available.',
      );
      return;
    }
    if (!approvePassword) {
      setApproveFieldError('Your password is required to approve this change.');
      return;
    }
    resetActionFeedback();
    setApproveFieldError('');
    setActionInFlight('approve');
    try {
      const result = await approveAgentPayoutDestinationChange(token, detail.id, {
        password: approvePassword,
      });
      applyUpdatedRequest(result.request);
      setActionMessage(result.message);
      refreshList();
    } catch (error) {
      handleActionError('approve', error);
    } finally {
      setApprovePassword('');
      setActionInFlight(null);
    }
  };

  const submitRejection = async () => {
    if (!detail || actionInFlight !== null) return;
    const reason = rejectReason.trim();
    if (!reason) {
      setRejectFieldError('A rejection reason is required.');
      return;
    }
    if (reason.length > AGENT_PAYOUT_CHANGE_MAX_REJECTION_REASON_LENGTH) {
      setRejectFieldError(
        `A rejection reason must be at most ${AGENT_PAYOUT_CHANGE_MAX_REJECTION_REASON_LENGTH} characters.`,
      );
      return;
    }
    resetActionFeedback();
    setRejectFieldError('');
    setActionInFlight('reject');
    try {
      const result = await rejectAgentPayoutDestinationChange(token, detail.id, { reason });
      applyUpdatedRequest(result.request);
      setActionMessage(result.message);
      refreshList();
    } catch (error) {
      handleActionError('reject', error);
    } finally {
      setRejectReason('');
      setActionInFlight(null);
    }
  };

  const openRequest = (id: string) => {
    setSelectedId(id);
    setDetail(null);
    setActionMessage('');
    setActionError(null);
    clearActionFields('attest');
    clearActionFields('approve');
    clearActionFields('reject');
  };

  const attestationDecision = detail ? attestationActionFor(detail, currentAdministrator) : null;
  const approvalDecision = detail ? approvalActionFor(detail, currentAdministrator) : null;
  const rejectionDecision = detail ? rejectionActionFor(detail) : null;
  const terminalDetail = detail !== null && !isLiveAgentPayoutChange(detail);

  return (
    <section
      id={AGENT_PAYOUT_CHANGES_PANEL_ID}
      aria-labelledby={HEADING_ID}
      className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-panel shadow-raised p-4 sm:p-6 space-y-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionHeading
          titleId={HEADING_ID}
          eyebrow={'Agents'}
          title={'Payout destination changes'}
          description={
            'Review an agent’s proposed Personal M-Pesa number, record the administrator phone call, and record a separate approval. ' +
            'An attestation is NOT phone verification: no code is sent and no email OTP proves control of a mobile number. ' +
            'The current destination stays in use until the server records both steps and activates the change.'
          }
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={refreshList}
          loading={listLoading}
          loadingLabel={'Reading payout destination changes'}
        >
          {!listLoading && <RefreshCw size={ICON_SIZE.metadata} aria-hidden="true" />}
          {'Refresh'}
        </Button>
      </div>

      <p className="text-caption text-[var(--appearance-text-muted)]" aria-live="polite">
        {listLoading
          ? 'Reading the payout destination change queue…'
          : lastReadAt
            ? `Last read ${lastReadAt}. Masked destinations only; the full number never leaves the server.`
            : 'This queue has not been read yet.'}
      </p>

      {listError && (
        <Banner kind={requests.length > 0 ? 'warning' : 'error'}>
          {requests.length > 0
            ? `${listError} The rows below are from the last successful read and may be out of date.`
            : listError}
        </Banner>
      )}

      {actionMessage && (
        <Banner kind="success" onDismiss={() => setActionMessage('')} dismissLabel="Dismiss the recorded action message">
          {actionMessage}
        </Banner>
      )}

      {actionError && (
        <Banner kind="error" onDismiss={() => setActionError(null)} dismissLabel="Dismiss the payout destination change error">
          <p className="font-bold">{actionError.message}</p>
          {actionError.code && <p className="mt-1 font-mono text-caption">{actionError.code}</p>}
        </Banner>
      )}

      {!selectedId ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <Select
              label={'Status'}
              value={statusFilter}
              onChange={(event) => {
                setStatusFilter(event.target.value as AgentPayoutChangeStatus | '');
                setOffset(0);
              }}
              className="sm:max-w-xs"
            >
              <option value="">All statuses</option>
              {AGENT_PAYOUT_CHANGE_STATUS_FILTERS.map((status) => (
                <option key={status} value={status}>
                  {AGENT_PAYOUT_STATE_LABELS[status]}
                </option>
              ))}
            </Select>
          </div>

          {listLoading && requests.length === 0 ? (
            <div className="space-y-3" aria-busy="true">
              <span className="sr-only">{'Loading payout destination changes…'}</span>
              <Skeleton shape="card" className="w-full" />
              <Skeleton shape="card" className="w-full" />
            </div>
          ) : requests.length === 0 ? (
            listError ? null : (
              <EmptyState
                icon={ShieldCheck}
                title={'No payout destination changes'}
                description={
                  statusFilter
                    ? 'No request currently has that status. Change the filter to read the rest of the queue.'
                    : 'No agent has proposed a new payout destination. Nothing is waiting for an administrator decision.'
                }
              />
            )
          ) : (
            <div className="r4m-scroll-x" role="region" aria-label={'Payout destination change queue'} tabIndex={0}>
              <table className="w-full min-w-[760px] text-left text-caption">
                <thead>
                  <tr className="border-b border-[var(--appearance-border)] text-[var(--appearance-text-muted)]">
                    <th scope="col" className="py-2 pr-3 font-extrabold uppercase tracking-wide">{'Agent'}</th>
                    <th scope="col" className="py-2 pr-3 font-extrabold uppercase tracking-wide">{'Proposed destination'}</th>
                    <th scope="col" className="py-2 pr-3 font-extrabold uppercase tracking-wide">{'State'}</th>
                    <th scope="col" className="py-2 pr-3 font-extrabold uppercase tracking-wide">{'Requested'}</th>
                    <th scope="col" className="py-2 pr-3 font-extrabold uppercase tracking-wide">{'Attestation'}</th>
                    <th scope="col" className="py-2 pr-3 font-extrabold uppercase tracking-wide">{'Approval'}</th>
                    <th scope="col" className="py-2 font-extrabold uppercase tracking-wide">{'Review'}</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((row) => (
                    <tr key={row.id} className="border-b border-[var(--appearance-border)] last:border-b-0 align-top">
                      <td className="py-2 pr-3 font-mono">{row.agent_id}</td>
                      <td className="py-2 pr-3">
                        <span className="font-bold">{row.masked_proposed_destination}</span>
                        <span className="block text-[var(--appearance-text-muted)]">{row.proposed_payout_method}</span>
                      </td>
                      <td className="py-2 pr-3">
                        <Badge variant={agentPayoutStateVariant(row.status)}>
                          {AGENT_PAYOUT_STATE_LABELS[row.status]}
                        </Badge>
                      </td>
                      <td className="py-2 pr-3">{showTimestamp(row.created_at)}</td>
                      <td className="py-2 pr-3">
                        {row.attestation === 'attested'
                          ? `Recorded by ${row.attested_by ?? '(unknown)'}`
                          : 'Not recorded'}
                      </td>
                      <td className="py-2 pr-3">
                        {row.admin_approval === 'approved'
                          ? `Approved by ${row.admin_approved_by ?? '(unknown)'}`
                          : row.admin_approval === 'rejected'
                            ? `Rejected by ${row.admin_rejected_by ?? '(unknown)'}`
                            : 'Not recorded'}
                      </td>
                      <td className="py-2">
                        <Button variant="secondary" size="sm" onClick={() => openRequest(row.id)}>
                          {'Review'}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-caption text-[var(--appearance-text-muted)]">
              {`Showing ${requests.length === 0 ? 0 : offset + 1}–${offset + requests.length}.`}
            </p>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={offset === 0 || listLoading}
                onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
              >
                {'Previous'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={!hasMore || listLoading}
                onClick={() => setOffset((value) => value + PAGE_SIZE)}
              >
                {'Next'}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button variant="secondary" size="sm" onClick={() => setSelectedId(null)}>
              {'Back to queue'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                if (!selectedId) return;
                detailRequestIdRef.current += 1;
                setDetailLoading(true);
                setDetailError(null);
                fetchAgentPayoutDestinationChange(token, selectedId)
                  .then((next) => setDetail(next))
                  .catch((error: unknown) => {
                    setDetailError(
                      error instanceof AdminAgentPayoutChangeApiError
                        ? error.message
                        : 'The payout destination change could not be reloaded.',
                    );
                  })
                  .finally(() => setDetailLoading(false));
              }}
              loading={detailLoading}
              loadingLabel={'Reloading the payout destination change'}
            >
              {'Reload request'}
            </Button>
          </div>

          {detailLoading && !detail ? (
            <div className="space-y-3" aria-busy="true">
              <span className="sr-only">{'Loading the payout destination change…'}</span>
              <Skeleton shape="card" className="w-full" />
              <Skeleton shape="card" className="w-full" />
            </div>
          ) : detailError && !detail ? (
            <Banner kind="error">{detailError}</Banner>
          ) : detail ? (
            <div className="space-y-4">
              <div className="rounded-standard border border-[var(--appearance-border)] p-3 sm:p-4 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-caption font-extrabold uppercase tracking-widest text-[var(--appearance-text-muted)]">
                      {'Payout destination change'}
                    </p>
                    <p className="font-mono text-code break-all">{detail.id}</p>
                  </div>
                  <Badge variant={agentPayoutStateVariant(detail.status)}>
                    {AGENT_PAYOUT_STATE_LABELS[detail.status]}
                  </Badge>
                </div>

                <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-caption">
                  <div>
                    <dt className="font-extrabold text-[var(--appearance-text-muted)]">{'Agent'}</dt>
                    <dd className="font-mono break-all">{detail.agent_id}</dd>
                  </div>
                  <div>
                    <dt className="font-extrabold text-[var(--appearance-text-muted)]">{'Proposed destination (masked)'}</dt>
                    <dd className="font-bold">{detail.masked_proposed_destination}</dd>
                  </div>
                  <div>
                    <dt className="font-extrabold text-[var(--appearance-text-muted)]">{'Payout method'}</dt>
                    <dd>{detail.proposed_payout_method}</dd>
                  </div>
                  <div>
                    <dt className="font-extrabold text-[var(--appearance-text-muted)]">{'Format check'}</dt>
                    <dd>
                      {detail.destination_format_eligible
                        ? 'Passed — looks like a Personal M-Pesa number'
                        : 'Failed — not a Personal M-Pesa number'}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-extrabold text-[var(--appearance-text-muted)]">{'Phone verification (delivery channel)'}</dt>
                    <dd>
                      {detail.phone_verification === 'verified'
                        ? `Verified by a delivery channel at ${showTimestamp(detail.phone_verified_at)}`
                        : 'Not verified. No code was sent; an email OTP would not prove this number.'}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-extrabold text-[var(--appearance-text-muted)]">{'Phone-call attestation'}</dt>
                    <dd>
                      {detail.attestation === 'attested'
                        ? `Recorded by ${detail.attested_by ?? '(unknown)'} at ${showTimestamp(detail.attested_at)}`
                        : 'Not recorded'}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-extrabold text-[var(--appearance-text-muted)]">{'Administrator approval'}</dt>
                    <dd>
                      {detail.admin_approval === 'approved'
                        ? `By ${detail.admin_approved_by ?? '(unknown)'} at ${showTimestamp(detail.admin_approved_at)}`
                        : detail.admin_approval === 'rejected'
                          ? `Rejected at ${showTimestamp(detail.admin_rejected_at)}`
                          : 'Not recorded'}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-extrabold text-[var(--appearance-text-muted)]">{'Requested'}</dt>
                    <dd>{showTimestamp(detail.created_at)}</dd>
                  </div>
                  <div>
                    <dt className="font-extrabold text-[var(--appearance-text-muted)]">{'Expires'}</dt>
                    <dd>{showTimestamp(detail.expires_at)}</dd>
                  </div>
                  <div>
                    <dt className="font-extrabold text-[var(--appearance-text-muted)]">{'Activated'}</dt>
                    <dd>{detail.activated_at ? showTimestamp(detail.activated_at) : 'Not activated'}</dd>
                  </div>
                </dl>

                {detail.activation_blockers.length > 0 && (
                  <div className="rounded-standard border border-[var(--appearance-warning)] bg-[var(--appearance-surface-muted)] p-3">
                    <p className="text-caption font-extrabold uppercase tracking-widest text-[var(--appearance-warning)]">
                      {'Why this destination is not active'}
                    </p>
                    <ul className="mt-1 list-disc pl-5 text-caption space-y-0.5">
                      {detail.activation_blockers.map((blocker) => (
                        <li key={blocker}>{describeActivationBlocker(blocker)}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <div className="rounded-standard border border-[var(--appearance-border)] p-3 sm:p-4 space-y-2">
                <h4 className="text-caption font-extrabold uppercase tracking-widest text-[var(--appearance-text-muted)]">
                  {'Administrative timeline'}
                </h4>
                <ol className="space-y-2">
                  {buildAgentPayoutTimeline(detail).map((event, index) => {
                    const Icon =
                      event.state === 'done'
                        ? CheckCircle2
                        : event.state === 'blocked'
                          ? XCircle
                          : event.state === 'current'
                            ? Clock
                            : Loader2;
                    const tone =
                      event.state === 'done'
                        ? 'text-[var(--appearance-success)]'
                        : event.state === 'blocked'
                          ? 'text-[var(--appearance-danger)]'
                          : event.state === 'current'
                            ? 'text-[var(--appearance-warning)]'
                            : 'text-[var(--appearance-text-muted)]';
                    return (
                      <li key={`${event.key}-${index}`} className="flex items-start gap-2 text-caption">
                        <Icon size={15} className={`mt-0.5 shrink-0 ${tone}`} aria-hidden="true" />
                        <div className="min-w-0 space-y-0.5">
                          <p className="font-bold text-[var(--appearance-text-primary)]">
                            {event.label}
                            <span className="ml-1.5 font-mono text-[var(--appearance-text-muted)]">
                              {`[${event.state}]`}
                            </span>
                          </p>
                          <p className="text-[var(--appearance-text-muted)]">
                            {event.at ? showTimestamp(event.at) : 'No time recorded'}
                            {event.actor ? ` · ${event.actor}` : ''}
                          </p>
                          {event.note && (
                            <p className="font-semibold text-[var(--appearance-text-primary)]">{event.note}</p>
                          )}
                          {event.next_action && !terminalDetail && (
                            <p className="font-bold text-[var(--appearance-text-primary)]">
                              {`Next: ${event.next_action}`}
                            </p>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
                <p className="text-caption text-[var(--appearance-text-muted)]">
                  {'These steps come from the server’s persisted row. You cannot record an approval for a request that has no complete phone-call attestation, and the current destination stays in use until activation is recorded.'}
                </p>
              </div>

              <div className="rounded-standard border border-[var(--appearance-border)] p-3 sm:p-4 space-y-2">
                <h4 className="text-caption font-extrabold uppercase tracking-widest text-[var(--appearance-text-muted)]">
                  {'Attestation evidence (administrators only)'}
                </h4>
                {detail.attestation === 'attested' ? (
                  <>
                    <p className="text-caption">
                      {`Method: ${detail.attestation_method ?? AGENT_PAYOUT_ATTESTATION_METHOD}. Recorded by ${detail.attested_by ?? '(unknown)'} at ${showTimestamp(detail.attested_at)}.`}
                    </p>
                    <p className="text-caption font-semibold text-[var(--appearance-text-primary)]">
                      {detail.attestation_note ?? 'No note was returned.'}
                    </p>
                  </>
                ) : (
                  <p className="text-caption">
                    {'No complete attestation is on file.'}
                    {detail.attestation_failure ? ` Server reason: ${detail.attestation_failure}.` : ''}
                  </p>
                )}
                <p className="text-caption font-semibold text-[var(--appearance-text-muted)]">
                  {'A phone call is evidence that an administrator spoke to the agent. It is not delivery-channel phone verification, it sets no verification timestamp, and no code or email OTP is accepted as proof of control.'}
                </p>
              </div>

              {terminalDetail ? (
                <Banner kind="info">
                  {'This request is terminal. No attestation, approval or rejection can be recorded, and the current payout destination remains in use unless the row says it was activated.'}
                </Banner>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  <div className="rounded-standard border border-[var(--appearance-border)] p-3 space-y-2">
                    <h4 className="text-caption font-extrabold uppercase tracking-widest text-[var(--appearance-text-muted)]">
                      {'Step 1 — Record the phone-call attestation'}
                    </h4>
                    <p className="text-caption text-[var(--appearance-text-muted)]">
                      {`Call the proposed number and speak to the agent. The method is fixed to ${AGENT_PAYOUT_ATTESTATION_METHOD}; this screen cannot send an SMS, a WhatsApp message or a code. The server records YOUR administrator identity and the time with the note.`}
                    </p>
                    {attestationDecision?.allowed ? (
                      <>
                        <Textarea
                          label={'What did the call establish?'}
                          hint={`Required. At most ${AGENT_PAYOUT_ATTESTATION_NOTE_MAX_LENGTH} characters. Stored for administrators only.`}
                          value={attestNote}
                          onChange={(event) => setAttestNote(event.target.value)}
                          maxLength={AGENT_PAYOUT_ATTESTATION_NOTE_MAX_LENGTH}
                          required
                          disabled={actionInFlight !== null}
                        />
                        <Input
                          label={'Your password'}
                          type={'password'}
                          autoComplete={'current-password'}
                          value={attestPassword}
                          onChange={(event) => setAttestPassword(event.target.value)}
                          error={attestFieldError || undefined}
                          required
                          disabled={actionInFlight !== null}
                        />
                        <Button
                          variant={'primary'}
                          size={'sm'}
                          onClick={submitAttestation}
                          loading={actionInFlight === 'attest'}
                          loadingLabel={'Recording the attestation'}
                          disabled={actionInFlight !== null && actionInFlight !== 'attest'}
                        >
                          {'Record phone-call attestation'}
                        </Button>
                      </>
                    ) : (
                      <p className="text-caption font-semibold text-[var(--appearance-text-muted)]">
                        {attestationDecision?.reason
                          ? AGENT_PAYOUT_ACTION_BLOCK_MESSAGES[attestationDecision.reason]
                          : 'This attestation is not available.'}
                      </p>
                    )}
                  </div>

                  <div className="rounded-standard border border-[var(--appearance-border)] p-3 space-y-2">
                    <h4 className="text-caption font-extrabold uppercase tracking-widest text-[var(--appearance-text-muted)]">
                      {'Step 2 — Record the separate approval'}
                    </h4>
                    <p className="text-caption text-[var(--appearance-text-muted)]">
                      {'A DIFFERENT administrator must approve. The server compares the authenticated approver with the administrator who recorded the attestation and refuses a conflict.'}
                    </p>
                    {approvalDecision?.allowed ? (
                      <>
                        <Input
                          label={'Your password'}
                          type={'password'}
                          autoComplete={'current-password'}
                          value={approvePassword}
                          onChange={(event) => setApprovePassword(event.target.value)}
                          error={approveFieldError || undefined}
                          required
                          disabled={actionInFlight !== null}
                        />
                        <Button
                          variant={'primary'}
                          size={'sm'}
                          onClick={submitApproval}
                          loading={actionInFlight === 'approve'}
                          loadingLabel={'Recording the approval'}
                          disabled={actionInFlight !== null && actionInFlight !== 'approve'}
                        >
                          {'Approve change'}
                        </Button>
                      </>
                    ) : (
                      <p className="text-caption font-semibold text-[var(--appearance-text-muted)]">
                        {approvalDecision?.reason
                          ? AGENT_PAYOUT_ACTION_BLOCK_MESSAGES[approvalDecision.reason]
                          : 'This approval is not available.'}
                      </p>
                    )}
                  </div>

                  <div className="rounded-standard border border-[var(--appearance-border)] p-3 space-y-2">
                    <h4 className="text-caption font-extrabold uppercase tracking-widest text-[var(--appearance-text-muted)]">
                      {'Reject the request'}
                    </h4>
                    <p className="text-caption text-[var(--appearance-text-muted)]">
                      {'Rejection is terminal and needs a required reason. It moves no money and takes no password; your administrator session and role are the authorization the route checks.'}
                    </p>
                    {rejectionDecision?.allowed ? (
                      <>
                        <Textarea
                          label={'Rejection reason'}
                          hint={`Required. At most ${AGENT_PAYOUT_CHANGE_MAX_REJECTION_REASON_LENGTH} characters.`}
                          value={rejectReason}
                          onChange={(event) => setRejectReason(event.target.value)}
                          maxLength={AGENT_PAYOUT_CHANGE_MAX_REJECTION_REASON_LENGTH}
                          required
                          disabled={actionInFlight !== null}
                        />
                        {rejectFieldError && (
                          <p role="alert" className="text-caption font-bold text-[var(--appearance-danger)]">
                            {rejectFieldError}
                          </p>
                        )}
                        <Button
                          variant={'secondary'}
                          size={'sm'}
                          onClick={submitRejection}
                          loading={actionInFlight === 'reject'}
                          loadingLabel={'Recording the rejection'}
                          disabled={actionInFlight !== null && actionInFlight !== 'reject'}
                        >
                          {'Reject change'}
                        </Button>
                      </>
                    ) : (
                      <p className="text-caption font-semibold text-[var(--appearance-text-muted)]">
                        {'This request can no longer be rejected.'}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
