// ADMIN PAYOUT-RECONCILIATION API CLIENT (Batch 2 — read-only)
// ============================================================
// The ONE place the admin console talks to GET /api/admin/payout-reconciliation.
//
// WHY THIS MODULE EXISTS (the same reasoning as services/adminLostReportsApi.ts)
//   1. The payload is a typed, privacy-bounded contract. Keeping the type beside
//      the client means the console cannot quietly start reading a field the
//      endpoint does not define, and mapPayoutReconciliationItem() copies ONLY
//      the fields named below — so a field added to the API in future cannot
//      appear on screen by accident, and a raw phone number cannot ride along.
//   2. The path is built HERE, so no component hand-concatenates a URL.
//   3. It is REACT-FREE, so it can be tested in this repository's node-only
//      vitest environment.
//
// READ-ONLY BY CONSTRUCTION
//   * This module issues GET and nothing else. There is no exported function
//     that could submit, resubmit, refund or mark a payout paid. The payout
//     executor and its retry guards are neither imported, called nor altered —
//     and this client has no vocabulary in which to express such a call.
//   * It never logs a response.
//   * It names no credential, no bank detail and no raw phone field: the only
//     recipient value it reads is the endpoint's already-masked one, and it
//     masks AGAIN (maskRecipientForDisplay) so that a future server change which
//     stopped masking could not leak a number onto the screen.
//
// WHAT "UNRESOLVED" MEANS (one definition, shared with the server)
//   The server decides which rows are listed; this module never re-decides that.
//   But the row PRESENTATION must not disagree with it, so resolvePayoutOutcome()
//   reads the SAME vocabulary (config/payoutOutcomes.ts) that the data layer,
//   the schema and the settlement executor use, and it fails CLOSED: anything it
//   does not recognize is unresolved, and "accepted" is never shown as paid.

import { isPayoutOutcome } from '../config/payoutOutcomes';

/**
 * One row exactly as GET /api/admin/payout-reconciliation returns it
 * (src/server.ts). Note what is NOT here: no owner/customer id, no bank or
 * till details, no unmasked phone. `recipient` is the server's own masked
 * value; there is deliberately no type for the raw column it was built from.
 */
export interface AdminPayoutReconciliationItemDto {
  /** The ledger row id — the record an operator reconciles against the provider. */
  ledgerEntryId: string | null;
  claimId: string | null;
  itemId: string | null;
  /** 'finder_payout' | 'agent_payout' — an unexpected value is preserved, never dropped. */
  type: string | null;
  /** A real number from the API (parseLedgerEntry applies parseFloat). */
  amount: number | null;
  /** The ledger row's own status: 'pending' | 'failed' (completed rows are excluded). */
  status: string | null;
  /**
   * The provider submission outcome, or null. NULL means NO submission history
   * is recorded — which is NOT "never submitted": it is unresolved.
   */
  payoutOutcome: string | null;
  providerBatchId: string | null;
  providerTransactionId: string | null;
  /** Already masked by the server. Masked again before display. */
  recipient: string | null;
  reason: string | null;
  createdAt: string | null;
}

export type AdminPayoutReconciliationApiErrorKind =
  | 'unauthorized' // 401 — no/!valid session
  | 'forbidden'    // 403 — authenticated but not an administrator
  | 'invalid'      // any other 4xx
  | 'server'       // 5xx — genuine server failure
  | 'malformed'    // 2xx whose body was not the documented envelope
  | 'network'      // the request never completed
  | 'aborted';     // deliberately cancelled (superseded by a newer read)

export class AdminPayoutReconciliationApiError extends Error {
  readonly kind: AdminPayoutReconciliationApiErrorKind;
  /** HTTP status, or 0 when the request never completed. */
  readonly status: number;

  constructor(kind: AdminPayoutReconciliationApiErrorKind, status: number, message: string) {
    super(message);
    this.name = 'AdminPayoutReconciliationApiError';
    this.kind = kind;
    this.status = status;
  }

  /** True when the read was cancelled on purpose — callers must stay silent. */
  get isAbort(): boolean {
    return this.kind === 'aborted';
  }
}

/** Built here, once. No component builds this path. */
export const PAYOUT_RECONCILIATION_PATH = '/api/admin/payout-reconciliation';

/** Presentation tone for an outcome. Local to this module on purpose: it keeps
 *  the service layer free of any component (or React) dependency; the panel
 *  maps a tone onto the shared Badge variant. */
export type PayoutOutcomeTone = 'success' | 'warning' | 'pending' | 'info' | 'danger' | 'neutral';

export interface PayoutOutcomePresentation {
  /** The raw token as returned, or null. Never invented, never normalized away. */
  outcome: string | null;
  /** One truthful sentence. Never claims a payment that is not confirmed. */
  label: string;
  tone: PayoutOutcomeTone;
  /** True when this row may already have moved money and cannot be proven otherwise. */
  mayHaveMovedMoney: boolean;
  /** True when an operator still has to close this row out with the provider. */
  unresolved: boolean;
}

/** The row the console renders. Built field by field — never by spreading the
 *  API response, so nothing the endpoint adds later can reach the screen. */
export interface PayoutReconciliationRow {
  ledgerEntryId: string | null;
  claimId: string | null;
  itemId: string | null;
  payoutType: string | null;
  payoutTypeLabel: string;
  /** 'KES 1500.00', or '—' when the amount was absent/unreadable. */
  amountLabel: string;
  amountReported: boolean;
  ledgerStatus: string | null;
  outcome: PayoutOutcomePresentation;
  providerBatchId: string | null;
  providerTransactionId: string | null;
  /** Masked here as well as on the server. Never a raw number. */
  recipientMasked: string | null;
  reason: string | null;
  /** The recorded timestamp, verbatim, or null. */
  recordedAt: string | null;
  /** The same timestamp, formatted for display ('' when absent). */
  recordedAtLabel: string;
  /** How long ago it was recorded: '3d', '4h', 'just now', or 'unknown'. */
  ageLabel: string;
  /** Sort key only. null when the timestamp was absent or unreadable. */
  recordedMs: number | null;
}

const PAYOUT_TYPE_LABELS: Record<string, string> = {
  finder_payout: 'Finder payout',
  agent_payout: 'Agent payout',
};

/**
 * The human name of a payout type. An unrecognized token is shown RAW rather
 * than hidden or prettified: the operator needs to see what the ledger says,
 * and a blank cell would read as "no payout at all".
 */
export function describePayoutType(type: unknown): string {
  if (typeof type !== 'string' || !type.trim()) return 'Payout type not reported';
  return PAYOUT_TYPE_LABELS[type] ?? type;
}

/**
 * A monetary figure, or an explicit missing marker.
 *
 * Two decimals, no locale grouping: grouping depends on the host ICU build, and
 * a financial figure that renders differently on two machines is a defect. The
 * console-wide formatter is a later batch's job; this function stays
 * deterministic until then. A value that is not a finite number is reported as
 * MISSING (`reported: false`), never as 0.
 */
export function formatPayoutAmount(value: unknown): { text: string; reported: boolean } {
  const n = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim() ? Number(value) : NaN);
  if (!Number.isFinite(n)) return { text: '—', reported: false };
  return { text: `KES ${n.toFixed(2)}`, reported: true };
}

/**
 * The SAME masking rule the server applies (services/auth.ts maskPhoneForLog:
 * under 7 characters is fully masked, otherwise everything but the first and
 * last three is hidden), re-applied on the client as a second line of defence.
 *
 * It is idempotent and can never un-mask: a value that already contains '*' is
 * returned untouched, so the endpoint's own masked value passes through
 * unchanged and a value that reached the browser in the clear cannot be
 * displayed in the clear. An absent value is null — the UI says "not recorded"
 * rather than showing a fabricated placeholder.
 */
export function maskRecipientForDisplay(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/\s+/g, '');
  if (!clean) return null;
  if (clean.includes('*')) return clean;
  if (clean.length < 7) return '***'; // too short to safely partially reveal
  return clean.slice(0, -6) + '***' + clean.slice(-3);
}

/** Longest recorded reason rendered. Anything longer is capped, so one row's
 *  text can never restructure the list. */
const REASON_MAX_LENGTH = 400;

/**
 * A recorded failure reason, made safe for display.
 *
 * Control characters (including the newlines a stored message may contain) are
 * collapsed to single spaces and the text is capped. An empty or absent reason
 * is null, and the UI states that no reason was recorded rather than inventing
 * one. React escapes the text as a second layer; this function exists so the
 * value is also structurally incapable of breaking the row.
 */
export function safeReasonText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;
  return normalized.length > REASON_MAX_LENGTH
    ? `${normalized.slice(0, REASON_MAX_LENGTH)}…`
    : normalized;
}

/** A parsed timestamp in ms, or null when the value is absent/unreadable. */
function toTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** '11 Oct 2026, 14:30', or '' when there is no readable timestamp. */
export function formatRecordedAt(value: unknown): string {
  const ms = toTimestampMs(value);
  if (ms === null) return '';
  return new Date(ms).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * How long ago the row was recorded — the number an operator triages by. An
 * unreadable timestamp reports 'unknown': it is never rendered as "0m ago",
 * which would read as brand new.
 */
export function payoutAgeLabel(value: unknown, now: number = Date.now()): string {
  const ms = toTimestampMs(value);
  if (ms === null) return 'unknown';
  const elapsed = now - ms;
  if (elapsed < 0) return 'in the future'; // clock skew, stated rather than hidden
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

/**
 * What the recorded provider outcome MEANS for an operator. Fails CLOSED.
 *
 * The three rules this encodes, which are the whole point of the surface:
 *   * an unrecognized token is UNRESOLVED (never a quiet "fine");
 *   * 'accepted' is the provider acknowledging the REQUEST — it is NOT
 *     confirmation that the transfer happened, and the label says so;
 *   * null means no submission history is recorded, which is not proof of
 *     "never submitted", so it is unresolved too.
 */
export function resolvePayoutOutcome(outcome: unknown): PayoutOutcomePresentation {
  const raw = typeof outcome === 'string' && outcome.trim() ? outcome.trim() : null;

  if (raw === null) {
    return {
      outcome: null,
      label: 'No submission history recorded — verify with the provider',
      tone: 'warning',
      mayHaveMovedMoney: true,
      unresolved: true,
    };
  }

  if (!isPayoutOutcome(raw)) {
    // Impossible through this codebase's write path, but not through a manual
    // SQL edit — so it is treated exactly like an unknown outcome.
    return {
      outcome: raw,
      label: 'Unrecognized outcome recorded — treat as unresolved',
      tone: 'danger',
      mayHaveMovedMoney: true,
      unresolved: true,
    };
  }

  switch (raw) {
    case 'completed':
      return { outcome: raw, label: 'Completed — confirmed paid', tone: 'success', mayHaveMovedMoney: false, unresolved: false };
    case 'rejected':
      return { outcome: raw, label: 'Refused by the provider — no transfer was made', tone: 'info', mayHaveMovedMoney: false, unresolved: true };
    case 'not_submitted':
      return { outcome: raw, label: 'No provider submission recorded for this row', tone: 'pending', mayHaveMovedMoney: false, unresolved: true };
    case 'submitting':
      return { outcome: raw, label: 'Submission started — no provider result was recorded', tone: 'warning', mayHaveMovedMoney: true, unresolved: true };
    case 'accepted':
      return { outcome: raw, label: 'Accepted by the provider — NOT confirmed paid', tone: 'warning', mayHaveMovedMoney: true, unresolved: true };
    case 'unknown':
      return { outcome: raw, label: 'Unknown — the transfer may already have been made', tone: 'warning', mayHaveMovedMoney: true, unresolved: true };
    default:
      return { outcome: raw, label: 'Unrecognized outcome recorded — treat as unresolved', tone: 'danger', mayHaveMovedMoney: true, unresolved: true };
  }
}

/** A string field, or null. Numbers/ids are stringified for display only. */
function optionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() ? value : null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * The API response -> the row the console renders. ALLOW-LIST ONLY: each field
 * is named here, so a key the endpoint (or a future version of it) adds cannot
 * reach the screen by accident. A non-object entry is dropped rather than
 * rendered as an empty row.
 */
export function mapPayoutReconciliationItem(dto: unknown): PayoutReconciliationRow | null {
  if (!dto || typeof dto !== 'object') return null;
  const item = dto as AdminPayoutReconciliationItemDto;
  const amount = formatPayoutAmount(item.amount);
  const recordedAt = optionalText(item.createdAt);
  return {
    ledgerEntryId: optionalText(item.ledgerEntryId),
    claimId: optionalText(item.claimId),
    itemId: optionalText(item.itemId),
    payoutType: optionalText(item.type),
    payoutTypeLabel: describePayoutType(item.type),
    amountLabel: amount.text,
    amountReported: amount.reported,
    ledgerStatus: optionalText(item.status),
    outcome: resolvePayoutOutcome(item.payoutOutcome),
    providerBatchId: optionalText(item.providerBatchId),
    providerTransactionId: optionalText(item.providerTransactionId),
    recipientMasked: maskRecipientForDisplay(item.recipient),
    reason: safeReasonText(item.reason),
    recordedAt,
    recordedAtLabel: formatRecordedAt(recordedAt),
    ageLabel: payoutAgeLabel(recordedAt),
    recordedMs: toTimestampMs(recordedAt),
  };
}

/**
 * Oldest first: this is a work queue, so the row that has been unresolved the
 * longest is the one that most needs checking. Rows whose timestamp could not be
 * read sort last — never silently to the top as if they were brand new.
 */
export function sortPayoutRowsOldestFirst(
  rows: readonly PayoutReconciliationRow[],
): PayoutReconciliationRow[] {
  return [...rows].sort((a, b) => {
    if (a.recordedMs === null && b.recordedMs === null) return 0;
    if (a.recordedMs === null) return 1;
    if (b.recordedMs === null) return -1;
    return a.recordedMs - b.recordedMs;
  });
}

/** Maps an HTTP status onto the operator-facing failure class. */
function errorKindForStatus(status: number): AdminPayoutReconciliationApiErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status >= 500) return 'server';
  return 'invalid';
}

export interface FetchUnresolvedPayoutsOptions {
  /** Lets a superseded read be cancelled; an abort is never surfaced as an error. */
  signal?: AbortSignal;
}

/**
 * Reads the unresolved-payout list. THE ONLY exported network call in this
 * module, and it is a GET.
 *
 * Failure messages are fixed strings chosen here, not text echoed from the
 * response body: the console never renders arbitrary server output, and an HTML
 * error page can never be mistaken for a table. Cancellation is reported as
 * 'aborted' so callers can ignore it instead of flashing an error over a read
 * that was deliberately replaced.
 */
export async function fetchUnresolvedPayouts(
  token: string | null,
  options: FetchUnresolvedPayoutsOptions = {},
): Promise<PayoutReconciliationRow[]> {
  let response: Response;
  try {
    response = await fetch(PAYOUT_RECONCILIATION_PATH, {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: options.signal,
    });
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') {
      throw new AdminPayoutReconciliationApiError('aborted', 0, 'Read cancelled.');
    }
    throw new AdminPayoutReconciliationApiError(
      'network',
      0,
      'The payout reconciliation service could not be reached.',
    );
  }

  if (!response.ok) {
    throw new AdminPayoutReconciliationApiError(
      errorKindForStatus(response.status),
      response.status,
      failureMessageForStatus(response.status),
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AdminPayoutReconciliationApiError(
      'malformed',
      response.status,
      'The unresolved-payout list could not be read.',
    );
  }

  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) {
    throw new AdminPayoutReconciliationApiError(
      'malformed',
      response.status,
      'The unresolved-payout list could not be read.',
    );
  }

  return sortPayoutRowsOldestFirst(
    items
      .map(mapPayoutReconciliationItem)
      .filter((row): row is PayoutReconciliationRow => row !== null),
  );
}

/** Operator-facing text per failure class. Fixed strings, never server output. */
export function failureMessageForStatus(status: number): string {
  switch (errorKindForStatus(status)) {
    case 'unauthorized':
      return 'Your admin session has ended. Sign in again, then reload this list.';
    case 'forbidden':
      return 'This account is not allowed to view payout reconciliation.';
    case 'server':
      return 'The server could not build the unresolved-payout list. Read-only: nothing was changed.';
    default:
      return 'The unresolved-payout list could not be loaded.';
  }
}

