// =============================================================================
// ADMIN AGENT PAYOUT DESTINATION CHANGES — API CLIENT
// =============================================================================
// The ONE place the Admin Console talks to
// /api/admin/agent-payout-destination-changes.
//
// WHY THIS MODULE EXISTS
//   1. The server has already projected every row through
//      toAgentPayoutAdminView(): the raw proposed destination, verification code
//      and hash never leave the server. This client maps only the fields the
//      console renders, so a column added to the API later cannot appear on
//      screen by accident.
//   2. The paths and request bodies are built HERE. No component concatenates a
//      URL or hand-writes a JSON body.
//   3. It is React-free, so the request contract can be executed by tests in this
//      repository's node-only vitest environment.
//
// SAFETY
//   * The attestation body is exactly `{ password, note }`. The method is NOT a
//     caller choice: the server fixes it to `admin_phone_call`. Nothing here can
//     express SMS, WhatsApp, an email OTP or a verification code.
//   * The approval body is exactly `{ password }`. The approval itself is not a
//     browser value; it is the server's persisted decision.
//   * The rejection body is exactly `{ reason }`, which is the contract the
//     existing route enforces (admin session + role, required bounded reason).
//   * Passwords are never logged, never put in a URL and are never echoed into an
//     error message.
// =============================================================================

import {
  AGENT_PAYOUT_ATTESTATION_METHOD,
  AGENT_PAYOUT_ATTESTATION_NOTE_MAX_LENGTH,
  AGENT_PAYOUT_CHANGE_MAX_REJECTION_REASON_LENGTH,
  AGENT_PAYOUT_CHANGE_STATUSES,
} from '../config/agentPayoutVerification';
import type {
  AgentPayoutActivationBlocker,
  AgentPayoutAdminTimelineEvent,
  AgentPayoutAdminView,
  AgentPayoutAttestationFailure,
  AgentPayoutChangeState,
  AgentPayoutChangeStatus,
  AgentPayoutTimelineState,
} from '../config/agentPayoutVerification';

export const ADMIN_AGENT_PAYOUT_CHANGES_PATH = '/api/admin/agent-payout-destination-changes';
export {
  AGENT_PAYOUT_ATTESTATION_METHOD,
  AGENT_PAYOUT_ATTESTATION_NOTE_MAX_LENGTH,
  AGENT_PAYOUT_CHANGE_MAX_REJECTION_REASON_LENGTH,
};
export type { AgentPayoutAdminView, AgentPayoutChangeStatus };

export type AdminAgentPayoutChangeApiErrorKind =
  | 'unauthorized' // 401 — no/invalid session
  | 'forbidden' // 403 — authenticated but not an administrator
  | 'not_found' // 404 — the request no longer exists
  | 'conflict' // 409 — the request changed or a policy refuses the action
  | 'invalid' // other 4xx (includes a refused field)
  | 'server' // 5xx — genuine server failure
  | 'malformed' // 2xx whose body was not the documented envelope
  | 'network' // the request never completed
  | 'aborted'; // deliberately cancelled

export class AdminAgentPayoutChangeApiError extends Error {
  readonly kind: AdminAgentPayoutChangeApiErrorKind;
  /** HTTP status, or 0 when the request never completed. */
  readonly status: number;
  /** The server's stable refusal code, when it sent one. */
  readonly code: string | null;
  /** The persisted (masked) request when the server included it with a refusal.
   *  Used to refresh the detail so an operator sees WHY the action was refused. */
  readonly request: AgentPayoutAdminView | null;

  constructor(
    kind: AdminAgentPayoutChangeApiErrorKind,
    status: number,
    message: string,
    code: string | null = null,
    request: AgentPayoutAdminView | null = null,
  ) {
    super(message);
    this.name = 'AdminAgentPayoutChangeApiError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.request = request;
  }

  get isAbort(): boolean {
    return this.kind === 'aborted';
  }
}

/** The paths are built here, once. */
export function agentPayoutChangePath(changeId: string): string {
  return `${ADMIN_AGENT_PAYOUT_CHANGES_PATH}/${encodeURIComponent(changeId)}`;
}

export function agentPayoutChangeActionPath(
  changeId: string,
  action: 'attest' | 'approve' | 'reject',
): string {
  return `${agentPayoutChangePath(changeId)}/${action}`;
}

export function agentPayoutChangesListPath(options: {
  status?: AgentPayoutChangeStatus | '' | null;
  limit?: number | null;
  offset?: number | null;
} = {}): string {
  const params = new URLSearchParams();
  if (options.status) params.set('status', options.status);
  if (typeof options.limit === 'number' && Number.isFinite(options.limit)) {
    params.set('limit', String(Math.min(Math.max(Math.trunc(options.limit), 1), 200)));
  }
  if (typeof options.offset === 'number' && Number.isFinite(options.offset) && options.offset > 0) {
    params.set('offset', String(Math.trunc(options.offset)));
  }
  const query = params.toString();
  return query ? `${ADMIN_AGENT_PAYOUT_CHANGES_PATH}?${query}` : ADMIN_AGENT_PAYOUT_CHANGES_PATH;
}

// ---------------------------------------------------------------------------
// RESPONSE MAPPING — named fields only
// ---------------------------------------------------------------------------

const CHANGE_STATES: readonly AgentPayoutChangeState[] = [
  'pending_verification',
  'pending_admin_approval',
  'ready_to_activate',
  'attester_approver_conflict',
  'activated',
  'rejected',
  'expired',
];

const TIMELINE_STATES: readonly AgentPayoutTimelineState[] = ['done', 'current', 'pending', 'blocked'];

const TIMELINE_KEYS: readonly AgentPayoutAdminTimelineEvent['key'][] = [
  'requested',
  'attested',
  'approved',
  'activated',
];

const ACTIVATION_BLOCKERS: readonly AgentPayoutActivationBlocker[] = [
  'already_activated',
  'rejected',
  'expired',
  'destination_not_eligible',
  'attestation_required',
  'admin_approval_required',
  'attester_approver_conflict',
];

const ATTESTATION_FAILURES: readonly AgentPayoutAttestationFailure[] = [
  'attestation_missing',
  'attestation_method_unsupported',
  'attestation_note_missing',
  'attestation_note_too_long',
  'attestation_actor_missing',
  'attestation_time_missing',
];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function requiredText(value: unknown): string {
  const text = optionalText(value);
  if (text === null) throw new Error('A required text field was missing.');
  return text;
}

function timestamp(value: unknown): string | null {
  return optionalText(value);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new Error(`The server sent an unrecognised ${field}.`);
}

function mapTimelineEvent(value: unknown): AgentPayoutAdminTimelineEvent {
  const event = record(value);
  if (!event) throw new Error('The server sent a malformed timeline event.');
  return {
    key: oneOf(event.key, TIMELINE_KEYS, 'timeline step'),
    state: oneOf(event.state, TIMELINE_STATES, 'timeline state'),
    label: requiredText(event.label),
    at: timestamp(event.at),
    actor: optionalText(event.actor),
    note: optionalText(event.note),
    next_action: optionalText(event.next_action),
  };
}

/**
 * Map ONE administrator row. Throws when the envelope is not the documented
 * projection, so a malformed response is an error rather than a half-rendered
 * request that could imply the wrong state of a money destination.
 */
export function mapAgentPayoutAdminView(value: unknown): AgentPayoutAdminView {
  const row = record(value);
  if (!row) throw new Error('The server sent a malformed payout destination change.');
  const timelineRaw = row.timeline;
  if (!Array.isArray(timelineRaw)) {
    throw new Error('The server omitted the payout destination change timeline.');
  }
  const blockersRaw = row.activation_blockers;
  const blockers = Array.isArray(blockersRaw)
    ? blockersRaw.map((blocker) => oneOf(blocker, ACTIVATION_BLOCKERS, 'activation blocker'))
    : [];

  return {
    id: requiredText(row.id),
    agent_id: requiredText(row.agent_id),
    status: oneOf(row.status, CHANGE_STATES, 'payout destination change state'),
    masked_proposed_destination: requiredText(row.masked_proposed_destination),
    proposed_payout_method: requiredText(row.proposed_payout_method),
    destination_format_eligible: row.destination_format_eligible === true,
    phone_verification: row.phone_verification === 'verified' ? 'verified' : 'not_verified',
    phone_verified_at: timestamp(row.phone_verified_at),
    attestation: row.attestation === 'attested' ? 'attested' : 'not_attested',
    attested_at: timestamp(row.attested_at),
    attestation_method: optionalText(row.attestation_method),
    admin_approval:
      row.admin_approval === 'approved' || row.admin_approval === 'rejected'
        ? row.admin_approval
        : 'not_requested',
    admin_approved_at: timestamp(row.admin_approved_at),
    admin_rejected_at: timestamp(row.admin_rejected_at),
    rejection_reason: optionalText(row.rejection_reason),
    created_at: timestamp(row.created_at),
    expires_at: timestamp(row.expires_at),
    activated_at: timestamp(row.activated_at),
    can_activate: row.can_activate === true,
    activation_blockers: blockers,
    attested_by: optionalText(row.attested_by),
    attestation_note: optionalText(row.attestation_note),
    attestation_failure:
      typeof row.attestation_failure === 'string'
        ? oneOf(row.attestation_failure, ATTESTATION_FAILURES, 'attestation failure')
        : null,
    admin_approved_by: optionalText(row.admin_approved_by),
    admin_rejected_by: optionalText(row.admin_rejected_by),
    attester_approver_conflict: row.attester_approver_conflict === true,
    timeline: timelineRaw.map(mapTimelineEvent),
  };
}

export interface AgentPayoutChangeList {
  requests: AgentPayoutAdminView[];
  has_more: boolean;
}

export function mapAgentPayoutChangeList(body: unknown): AgentPayoutChangeList {
  const envelope = record(body);
  if (!envelope || !Array.isArray(envelope.requests)) {
    throw new Error('The payout destination change list could not be read.');
  }
  return {
    requests: envelope.requests.map(mapAgentPayoutAdminView),
    has_more: envelope.has_more === true,
  };
}

export interface AgentPayoutChangeActionResult {
  message: string;
  request: AgentPayoutAdminView;
  attested: boolean;
  alreadyAttested: boolean;
  approved: boolean;
  activated: boolean;
  activationCode: string | null;
  rejected: boolean;
}

function mapActionResult(body: unknown, fallbackMessage: string): AgentPayoutChangeActionResult {
  const envelope = record(body);
  if (!envelope || !envelope.request) {
    throw new Error('The server did not return the updated payout destination change.');
  }
  return {
    message: optionalText(envelope.message) ?? fallbackMessage,
    request: mapAgentPayoutAdminView(envelope.request),
    attested: envelope.attested === true,
    alreadyAttested: envelope.already_attested === true,
    approved: envelope.approved === true,
    activated: envelope.activated === true,
    activationCode: optionalText(envelope.activation_code),
    rejected: envelope.rejected === true,
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function errorKindForStatus(status: number): AdminAgentPayoutChangeApiErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status >= 500) return 'server';
  return 'invalid';
}

/** The operator-facing sentence for a failed request. Fixed text, never data. */
export function agentPayoutChangeFailureMessage(
  kind: AdminAgentPayoutChangeApiErrorKind,
): string {
  if (kind === 'unauthorized') return 'Your session has expired. Sign in again to review payout destination changes.';
  if (kind === 'forbidden') return 'This account is not permitted to review payout destination changes.';
  if (kind === 'not_found') return 'That payout destination change no longer exists. Refresh the list.';
  if (kind === 'conflict') return 'The request changed or a policy refused that action. Re-read the request before trying again.';
  if (kind === 'server') return 'The server could not complete that request. Nothing was changed by this browser.';
  return 'The payout destination change request could not be completed.';
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function request(
  path: string,
  init: RequestInit,
  token: string | null,
): Promise<unknown> {
  if (!token) {
    throw new AdminAgentPayoutChangeApiError(
      'unauthorized',
      401,
      'Your session has expired. Sign in again to review payout destination changes.',
    );
  }

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') {
      throw new AdminAgentPayoutChangeApiError('aborted', 0, 'Request cancelled.');
    }
    throw new AdminAgentPayoutChangeApiError(
      'network',
      0,
      'The payout destination change service could not be reached.',
    );
  }

  const body = await readBody(response);
  if (!response.ok) {
    const envelope = record(body);
    const code = envelope && typeof envelope.code === 'string' ? envelope.code : null;
    const serverMessage = envelope && typeof envelope.error === 'string' ? envelope.error : null;
    let persisted: AgentPayoutAdminView | null = null;
    if (envelope && envelope.request) {
      try {
        persisted = mapAgentPayoutAdminView(envelope.request);
      } catch {
        persisted = null;
      }
    }
    const kind = errorKindForStatus(response.status);
    const fallback = agentPayoutChangeFailureMessage(kind);
    // A bare 401/403 from a proxy can say only "Forbidden", which tells an
    // operator nothing about the remedy. Those two kinds use the fixed sentence;
    // every other server refusal is surfaced in the server's own words.
    const message =
      kind === 'unauthorized' || kind === 'forbidden'
        ? fallback
        : serverMessage ?? fallback;
    throw new AdminAgentPayoutChangeApiError(
      kind,
      response.status,
      message,
      code,
      persisted,
    );
  }

  return body;
}

export interface FetchAgentPayoutChangesOptions {
  status?: AgentPayoutChangeStatus | '' | null;
  limit?: number | null;
  offset?: number | null;
  signal?: AbortSignal;
}

/** Read one page of requests. GET only. */
export async function fetchAgentPayoutDestinationChanges(
  token: string | null,
  options: FetchAgentPayoutChangesOptions = {},
): Promise<AgentPayoutChangeList> {
  const body = await request(
    agentPayoutChangesListPath(options),
    { method: 'GET', signal: options.signal },
    token,
  );
  return mapAgentPayoutChangeList(body);
}

/** Read one request, including its administrative timeline. GET only. */
export async function fetchAgentPayoutDestinationChange(
  token: string | null,
  changeId: string,
  options: { signal?: AbortSignal } = {},
): Promise<AgentPayoutAdminView> {
  const body = await request(
    agentPayoutChangePath(changeId),
    { method: 'GET', signal: options.signal },
    token,
  );
  const envelope = record(body);
  if (!envelope || !envelope.request) {
    throw new AdminAgentPayoutChangeApiError(
      'malformed',
      200,
      'The payout destination change could not be read.',
    );
  }
  try {
    return mapAgentPayoutAdminView(envelope.request);
  } catch (error) {
    throw new AdminAgentPayoutChangeApiError(
      'malformed',
      200,
      error instanceof Error ? error.message : 'The payout destination change could not be read.',
    );
  }
}

/**
 * Record the administrator phone-call attestation. The body is exactly
 * `{ password, note }`; the method is fixed server-side and cannot be chosen
 * here. This is NOT phone verification and sends no code.
 */
export async function attestAgentPayoutDestinationChange(
  token: string | null,
  changeId: string,
  input: { password: string; note: string },
): Promise<AgentPayoutChangeActionResult> {
  const body = await request(
    agentPayoutChangeActionPath(changeId, 'attest'),
    {
      method: 'POST',
      body: JSON.stringify({ password: input.password, note: input.note }),
    },
    token,
  );
  try {
    return mapActionResult(body, 'Phone-call attestation recorded.');
  } catch (error) {
    throw new AdminAgentPayoutChangeApiError(
      'malformed',
      200,
      error instanceof Error ? error.message : 'The attestation could not be confirmed.',
    );
  }
}

/**
 * Record the separate administrator approval. The body is exactly
 * `{ password }` — the approval is the server's persisted decision, never a
 * browser-supplied value. The server refuses when the attester is the approver.
 */
export async function approveAgentPayoutDestinationChange(
  token: string | null,
  changeId: string,
  input: { password: string },
): Promise<AgentPayoutChangeActionResult> {
  const body = await request(
    agentPayoutChangeActionPath(changeId, 'approve'),
    { method: 'POST', body: JSON.stringify({ password: input.password }) },
    token,
  );
  try {
    return mapActionResult(body, 'Approval recorded.');
  } catch (error) {
    throw new AdminAgentPayoutChangeApiError(
      'malformed',
      200,
      error instanceof Error ? error.message : 'The approval could not be confirmed.',
    );
  }
}

/**
 * Reject the request with a required, bounded reason. The route's authorization
 * is the administrator session + role; it moves no money, so it does not take a
 * password. The UI must not imply a password check the server does not perform.
 */
export async function rejectAgentPayoutDestinationChange(
  token: string | null,
  changeId: string,
  input: { reason: string },
): Promise<AgentPayoutChangeActionResult> {
  const body = await request(
    agentPayoutChangeActionPath(changeId, 'reject'),
    { method: 'POST', body: JSON.stringify({ reason: input.reason }) },
    token,
  );
  try {
    return mapActionResult(body, 'The change was rejected.');
  } catch (error) {
    throw new AdminAgentPayoutChangeApiError(
      'malformed',
      200,
      error instanceof Error ? error.message : 'The rejection could not be confirmed.',
    );
  }
}

/** The status filter values the route accepts. */
export const AGENT_PAYOUT_CHANGE_STATUS_FILTERS: readonly AgentPayoutChangeStatus[] =
  AGENT_PAYOUT_CHANGE_STATUSES;
