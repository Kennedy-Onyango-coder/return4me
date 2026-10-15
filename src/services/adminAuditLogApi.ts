// ADMIN AUDIT-LOG API CLIENT (PROGRAMME 1 / WS4 — read-only)
// =========================================================
// The ONE place the admin console talks to GET /api/admin/audit-logs.
//
// WHY THIS MODULE EXISTS (the same reasoning as
// services/adminPayoutReconciliationApi.ts)
//   1. The payload is a typed, privacy-bounded contract. The type lives beside
//      the client, and mapAuditLogItem() reads ONLY the fields named below — so a
//      field added to the API in future cannot appear on screen by accident.
//   2. The path and its query string are built HERE, so no component
//      hand-concatenates a URL. The window size and the action filter are
//      VALIDATED BY THE SERVER (config/auditLogWindow.ts refuses anything
//      outside its bound rather than clamping it); this client sends what the
//      operator chose and renders back the window the server ACTUALLY applied.
//   3. It is REACT-FREE, so it can be tested in this repository's node-only
//      vitest environment.
//
// READ-ONLY BY CONSTRUCTION
//   * GET only. There is no exported function that writes, edits or deletes an
//     audit entry: the console reports the trail, it does not touch it.
//   * It never logs a response.
//   * `details` is the server's own sanitised text (services/adminSafeViews.ts
//     redacts phone/email patterns before it leaves the server); there is
//     deliberately no type here for the raw column it was built from.
//
// AN EMPTY WINDOW IS NOT AN EMPTY TRAIL
//   The envelope echoes the applied `limit` and `action`, so the panel can say
//   "no entries with this action" rather than implying that nothing has ever
//   been recorded — and a window whose body could not be read reports a failure
//   instead of an empty list.

// The console's shared read-model timestamp helpers (Batch 2). Imported rather
// than re-implemented so the audit surface cannot disagree with the payout
// surface about how a recorded time is written. `payoutAgeLabel` is generic in
// behaviour — it is named for the surface that introduced it, and this client
// aliases it to say what it measures here.
import { formatRecordedAt, payoutAgeLabel as recordedAgeLabel } from './adminPayoutReconciliationApi';

// Re-exported so a consumer of THIS client has one import site for everything it
// needs — the window, the error kinds and the timestamp formatter the panel uses
// to write "Last read ...". The formatting rule stays owned by
// adminPayoutReconciliationApi.ts; this is that same function, not a copy of it,
// so the audit and payout surfaces cannot drift apart. (TypeScript flagged this
// as TS2459: the panel imported it from here while this module only imported it.)
export { formatRecordedAt };

/** Built here, once. No component builds this path. */
export const ADMIN_AUDIT_LOG_PATH = '/api/admin/audit-logs';

export type AdminAuditLogApiErrorKind =
  | 'unauthorized' // 401 — no/!valid session
  | 'forbidden'    // 403 — authenticated but not an administrator
  | 'invalid'      // any other 4xx (includes a refused window/filter)
  | 'server'       // 5xx — genuine server failure
  | 'malformed'    // 2xx whose body was not the documented envelope
  | 'network'      // the request never completed
  | 'aborted';     // deliberately cancelled (superseded by a newer read)

export class AdminAuditLogApiError extends Error {
  readonly kind: AdminAuditLogApiErrorKind;
  /** HTTP status, or 0 when the request never completed. */
  readonly status: number;

  constructor(kind: AdminAuditLogApiErrorKind, status: number, message: string) {
    super(message);
    this.name = 'AdminAuditLogApiError';
    this.kind = kind;
    this.status = status;
  }

  /** True when the read was cancelled on purpose — callers must stay silent. */
  get isAbort(): boolean {
    return this.kind === 'aborted';
  }
}

/**
 * One entry exactly as GET /api/admin/audit-logs returns it.
 *
 * THE NAMES HERE ARE THE SERVER'S OWN WIRE NAMES (`admin_user`, `created_at`),
 * NOT THE CONSOLE'S camelCase. They are the fields
 * services/adminSafeViews.ts#toAdminSafeAuditLog whitelists, and the same DTO the
 * bulk dashboard already ships and the console's audit timeline renders. Reading
 * `adminUser`/`createdAt` here silently produced "Not recorded" and "unknown" for
 * every row of a window whose actor the server HAD sent — a truthfulness defect
 * on an audit surface, not a naming preference. The names are pinned against the
 * builder itself by adminProgramme1Sections.test.ts, whose "the client reads the
 * field names the server actually sends" block builds a real
 * toAdminSafeAuditLog row and asserts the snake_case shape (including that the
 * camelCase spelling is NOT what the server sends).
 */
export interface AdminAuditLogItemDto {
  id: string | null;
  /** The action code, e.g. PAYOUT_INITIATED. Never prettified away. */
  action: string | null;
  /** The acting administrator, as recorded. Legitimate audit data. */
  admin_user: string | null;
  created_at: string | null;
  /** Already sanitised by the server. Never the raw stored text. */
  details: string | null;
}

/** The row the console renders. Built field by field, never by spreading. */
export interface AdminAuditLogRow {
  id: string | null;
  action: string | null;
  /** The recorded code verbatim, or 'Action not recorded'. */
  actionLabel: string;
  /** The recorded actor, or 'Not recorded'. Never invented. */
  adminUserLabel: string;
  /** The sanitised, control-character-free description; '' when none was stored. */
  detailsText: string;
  /** The recorded timestamp, verbatim, or null. */
  recordedAt: string | null;
  /** The same timestamp, formatted for display ('' when absent). */
  recordedAtLabel: string;
  /** How long ago it was recorded: '3d', '4h', 'just now', or 'unknown'. */
  ageLabel: string;
}

/** The window the server served, plus the rows in it. */
export interface AdminAuditLogWindow {
  /** The window size actually applied by the server, or null if it did not say. */
  limit: number | null;
  /** The action filter actually applied; null means every action. */
  action: string | null;
  /**
   * The number of rows in this response. Cross-checked against the rows that
   * could be read, and never allowed to exceed them: a count the operator cannot
   * see the rows behind would be a claim about records this console never got.
   */
  count: number;
  rows: AdminAuditLogRow[];
}

/** Longest details line rendered. A stored blob cannot restructure the list. */
const DETAILS_MAX_LENGTH = 500;

/**
 * A stored description, made safe for display.
 *
 * Control characters (including the newlines a stored message may contain) are
 * collapsed to single spaces and the text is capped. A missing or empty value
 * becomes '' and the UI says no description was recorded — it never borrows the
 * neighbouring row's text and never invents a summary. React escapes the text as
 * a second layer; this function exists so the value is also structurally
 * incapable of breaking the row.
 */
export function safeAuditDetailsText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  return normalized.length > DETAILS_MAX_LENGTH
    ? `${normalized.slice(0, DETAILS_MAX_LENGTH)}\u2026`
    : normalized;
}

/**
 * The action code as recorded, or an explicit missing marker.
 *
 * Deliberately NOT prettified into prose. The audit action vocabulary is a set of
 * codes an operator greps for (and that other surfaces record), so rendering
 * 'PAYOUT_INITIATED' rather than 'Payout initiated' keeps the console and the
 * stored trail readable against each other.
 */
export function describeAuditAction(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return 'Action not recorded';
  return value.trim();
}

/** A trimmed, non-empty string, or null. Used for ids and actors. */
function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * One response item -> one renderable row. Returns null for an entry that is not
 * an object, so a malformed item is dropped rather than rendered as a blank row
 * that would read as "an action happened, details missing".
 */
export function mapAuditLogItem(item: unknown): AdminAuditLogRow | null {
  if (!item || typeof item !== 'object') return null;
  const dto = item as Partial<AdminAuditLogItemDto>;
  // The wire names are the server's own (see AdminAuditLogItemDto): `created_at`
  // and `admin_user`. Reading the camelCase spelling here would make the console
  // report "Not recorded" for an actor the window actually carried.
  const recordedAt = optionalText(dto.created_at);
  return {
    id: optionalText(dto.id),
    action: optionalText(dto.action),
    actionLabel: describeAuditAction(dto.action),
    adminUserLabel: optionalText(dto.admin_user) ?? 'Not recorded',
    detailsText: safeAuditDetailsText(dto.details),
    recordedAt,
    recordedAtLabel: formatRecordedAt(recordedAt),
    ageLabel: recordedAgeLabel(recordedAt),
  };
}

/**
 * The request path for a window. Pure, so the query string is unit-testable
 * without a network.
 *
 * An absent or non-integer limit is simply not sent — the SERVER then applies its
 * documented default, which is the only place the default is decided. This client
 * never substitutes its own bound: doing so would let the console and the API
 * disagree about what "one page" means.
 */
export function buildAuditLogRequestPath(
  limit?: number | null,
  action?: string | null,
): string {
  const params = new URLSearchParams();
  if (typeof limit === 'number' && Number.isInteger(limit)) params.set('limit', String(limit));
  if (typeof action === 'string' && action.trim()) params.set('action', action.trim());
  const query = params.toString();
  return query ? `${ADMIN_AUDIT_LOG_PATH}?${query}` : ADMIN_AUDIT_LOG_PATH;
}

/**
 * The documented envelope -> the window the console renders. Throws 'malformed'
 * when there is no items array: a body this client cannot read is a failure, not
 * an empty trail.
 */
export function mapAuditLogWindow(body: unknown): AdminAuditLogWindow {
  const envelope = (body ?? {}) as { limit?: unknown; action?: unknown; count?: unknown; items?: unknown };
  if (!Array.isArray(envelope.items)) {
    throw new AdminAuditLogApiError('malformed', 200, 'The audit-log window could not be read.');
  }
  const rows = envelope.items
    .map(mapAuditLogItem)
    .filter((row): row is AdminAuditLogRow => row !== null);
  const serverCount = typeof envelope.count === 'number' && Number.isFinite(envelope.count)
    ? envelope.count
    : rows.length;
  return {
    limit: typeof envelope.limit === 'number' && Number.isFinite(envelope.limit) ? envelope.limit : null,
    action: optionalText(envelope.action),
    // Trust the server's count only when it matches what the operator can see.
    count: serverCount === rows.length ? serverCount : rows.length,
    rows,
  };
}

/** The operator-facing sentence for a failed read. Fixed text, never echoed data. */
export function failureMessageForStatus(status: number): string {
  if (status === 401) return 'Your session has expired. Sign in again to read the audit log.';
  if (status === 403) return 'This account is not an administrator, so the audit log is not available.';
  if (status === 400) return 'That audit window is not one the API accepts — ask for 500 entries or fewer.';
  if (status === 404) return 'The audit-log endpoint is not available on this build.';
  if (status >= 500) return 'The server could not produce the audit log. Nothing was changed by this read.';
  return 'The audit log could not be read.';
}

/** Map an HTTP status onto a kind. Kept separate so it is unit-testable. */
export function errorKindForStatus(status: number): AdminAuditLogApiErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status >= 500) return 'server';
  return 'invalid';
}

export interface FetchAuditLogWindowOptions {
  /** Window size requested. Omit to let the server apply its default. */
  limit?: number | null;
  /** Exact action code to filter on; omit/null for every action. */
  action?: string | null;
  signal?: AbortSignal;
}

/**
 * Read one bounded window of the audit trail. GET only; nothing is written.
 *
 * The token is passed in by the caller, exactly as the payout-reconciliation
 * client does, so this module has no opinion about where credentials come from.
 * A read that never resolves (or is superseded) throws 'aborted' and callers stay
 * silent; every other failure carries the sentence the operator is shown.
 */
export async function fetchAuditLogWindow(
  token: string | null,
  options: FetchAuditLogWindowOptions = {},
): Promise<AdminAuditLogWindow> {
  const path = buildAuditLogRequestPath(options.limit, options.action);

  let response: Response;
  try {
    response = await fetch(path, {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: options.signal,
    });
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') {
      throw new AdminAuditLogApiError('aborted', 0, 'Read cancelled.');
    }
    throw new AdminAuditLogApiError('network', 0, 'The audit log could not be reached.');
  }

  if (!response.ok) {
    throw new AdminAuditLogApiError(
      errorKindForStatus(response.status),
      response.status,
      failureMessageForStatus(response.status),
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AdminAuditLogApiError('malformed', response.status, 'The audit-log window could not be read.');
  }

  return mapAuditLogWindow(body);
}
