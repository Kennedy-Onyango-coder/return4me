// ADMIN STRANDED-ITEMS QUEUE API CLIENT (Stage 3B-6B)
// ===================================================
// The ONE place the admin console talks to GET /api/admin/stranded-items, and to
// the EXISTING single-item release primitive
// (POST /api/admin/items/:id/unassign).
//
// WHY THIS MODULE EXISTS (the same reasoning as services/adminPayoutReconciliationApi.ts)
//   1. The payload is a typed, privacy-bounded contract. mapStrandedQueueItem()
//      copies ONLY the fields named below, so a field added to the API later
//      cannot appear on screen by accident - and a finder's phone number cannot
//      ride along, because this module has no vocabulary for one.
//   2. Both paths are built HERE, so no component hand-concatenates a URL and no
//      component can point the release at a different endpoint.
//   3. It is REACT-FREE, so it can be tested in this repository's node-only
//      vitest environment.
//
// WHAT THIS CLIENT CAN AND CANNOT SAY
//   * It can READ the queue.
//   * It can RELEASE one item, through the audited primitive that already
//     requires a reason, compare-and-swaps the holder and appends history.
//   * It CANNOT transfer an item to another hub, cannot choose a replacement hub,
//     cannot release several items at once, and cannot touch custody. The server
//     is the authority for all of it; the console only relays one explicit,
//     attributed decision at a time.
//
// RELEASABILITY IS THE SERVER'S ANSWER, NOT THIS MODULE'S
//   `releasable` is copied verbatim from the response. This module never re-derives
//   it from a status string, so a policy change on the server cannot leave a stale
//   rule here that offers an action the server would refuse.
//
// MISSING IS NEVER EMPTY
//   A row this module cannot read is COUNTED and reported (`unreadableRows`), never
//   silently dropped: a queue that quietly loses rows is worse than one that
//   admits it could not read them. A payload whose `rows` is not a list is refused
//   outright rather than rendered as "no stranded items".

import type { StrandedCustodyState } from './strandedItemsQueue';
import { validateAdminAssignmentReason } from '../config/adminAssignmentReasonPolicy';

/** Built here, once. No component builds this path. */
export const STRANDED_ITEMS_QUEUE_PATH = '/api/admin/stranded-items';

/**
 * The path of the EXISTING single-item unassign primitive. The item id is
 * percent-encoded so an id can never reshape the URL into a different route.
 */
export function buildItemUnassignPath(itemId: string): string {
  return `/api/admin/items/${encodeURIComponent(itemId)}/unassign`;
}

export type AdminStrandedItemsApiErrorKind =
  | 'unauthorized' // 401 - no/!valid session
  | 'forbidden'    // 403 - authenticated but not an administrator
  | 'invalid'      // any other 4xx
  | 'server'       // 5xx - genuine server failure
  | 'malformed'    // 2xx whose body was not the documented envelope
  | 'network'      // the request never completed
  | 'aborted';     // deliberately cancelled (superseded by a newer read)

export class AdminStrandedItemsApiError extends Error {
  readonly kind: AdminStrandedItemsApiErrorKind;
  /** HTTP status, or 0 when the request never completed. */
  readonly status: number;

  constructor(kind: AdminStrandedItemsApiErrorKind, status: number, message: string) {
    super(message);
    this.name = 'AdminStrandedItemsApiError';
    this.kind = kind;
    this.status = status;
  }

  /** True when the read was cancelled on purpose - callers must stay silent. */
  get isAbort(): boolean {
    return this.kind === 'aborted';
  }
}

/**
 * One row exactly as GET /api/admin/stranded-items returns it
 * (see services/strandedItemsQueue.ts: StrandedQueueRow).
 *
 * Note what is NOT here, and cannot be: no finder identity, no finder phone or
 * email, no document hash, no photo, no coordinate pair.
 */
export interface AdminStrandedItemDto {
  item_id: string;
  status: string;
  county: string | null;
  administrative_unit_id: string | null;
  agent_id: string;
  /** The hub's public business name, or null when its row could not be read. */
  agent_business_name: string | null;
  agent_status: string;
  agent_actionable: boolean;
  agent_found: boolean;
  assigned_at: string | null;
  assignment_age_hours: number | null;
  /** 'not_yet_received' | 'received_at_hub'. An unexpected value is preserved. */
  custody: string;
  custody_note: string;
  releasable: boolean;
  refusal: string | null;
  review_required: boolean;
}

/** Presentation tone for the custody state. Mapped onto a Badge variant by the table. */
export type StrandedCustodyTone = 'warning' | 'danger';

export interface StrandedCustodyPresentation {
  /** The raw stored state, or null when the payload did not carry a usable one. */
  state: StrandedCustodyState | null;
  label: string;
  tone: StrandedCustodyTone;
  /** The server's own sentence. Rendered verbatim; it is the custody record. */
  note: string;
}

export interface StrandedAgentPresentation {
  /** 'active' | 'pending' | 'suspended' | whatever the row carried. */
  status: string;
  label: string;
  tone: 'success' | 'pending' | 'warning' | 'danger' | 'neutral';
}

/** The row the console renders. Built field by field - never by spreading the DTO. */
export interface StrandedQueueViewRow {
  itemId: string;
  status: string;
  /** 'Awaiting drop-off', 'Received at the hub', or the raw token if unknown. */
  statusLabel: string;
  /** The item's stored county, or the visible not-recorded marker. */
  countyLabel: string;
  /** The stored administrative unit id, or null (rendered as not recorded). */
  administrativeUnitId: string | null;

  agentId: string;
  /** The hub's public business name, or a stated fallback - never blank. */
  agentName: string;
  /** True when the server could read the hub's own record. */
  agentFound: boolean;
  agentStanding: StrandedAgentPresentation;

  /** The newest assignment event's timestamp, verbatim, or null. */
  assignedAt: string | null;
  /** That timestamp formatted for display; '' when absent. */
  assignedAtLabel: string;
  /** Whole hours since assignment, or null when the age is genuinely unknown. */
  ageHours: number | null;
  /** '3 days 4 hours', 'less than an hour', or an admitted 'unknown'. */
  ageLabel: string;

  custody: StrandedCustodyPresentation;
  /** The server's releasability verdict, copied verbatim. */
  releasable: boolean;
  /** The server's refusal sentence, or null when releasable. */
  refusal: string | null;
  /** True when a human decision is required before anything is changed. */
  reviewRequired: boolean;
  /**
   * Whether the console may offer the release control for this row. It is the
   * SERVER's verdict and nothing else: `releasable === true`.
   */
  canRelease: boolean;
}

export interface StrandedQueueTotalsView {
  stranded: number;
  releasable: number;
  custodyReviewRequired: number;
  hubs: number;
}

/** What a successful read produced, including what it could not read. */
export interface StrandedQueueRead {
  rows: StrandedQueueViewRow[];
  /** The server's one-sentence headline, or null when it did not carry one. */
  headline: string | null;
  /** When the server built this classification, or null when unreadable. */
  generatedAt: string | null;
  /** The server's own totals, or null when it did not report usable ones. */
  totals: StrandedQueueTotalsView | null;
  /** Rows the response carried but this module could not read. Stated, never hidden. */
  unreadableRows: number;
}

/** The visible marker for a value the row genuinely does not carry. */
export const STRANDED_NOT_RECORDED = 'Not recorded';

const ITEM_STATUS_LABELS: Record<string, string> = {
  awaiting_dropoff: 'Awaiting drop-off',
  at_agent: 'Received at the hub',
};

/**
 * The human name of an item status. An unrecognized token is shown RAW rather
 * than hidden or prettified: the operator needs to see what the row says, and a
 * blank cell would read as "no status at all".
 */
export function describeItemStatus(status: unknown): string {
  if (typeof status !== 'string' || status.trim() === '') return 'Status not reported';
  return ITEM_STATUS_LABELS[status] ?? status;
}

/**
 * The hub's standing, in the operator's words.
 *
 * 'suspended' is the reason this queue exists, so it is named exactly; 'pending'
 * is a waiting state, not a fault. Anything unrecognized is shown raw (falls back
 * to the neutral tone), never upgraded to 'active'.
 */
export function describeAgentStanding(status: unknown): StrandedAgentPresentation {
  const raw = typeof status === 'string' && status.trim() !== '' ? status : 'unknown';
  switch (raw) {
    case 'active':
      return { status: raw, label: 'Active', tone: 'success' };
    case 'suspended':
      return { status: raw, label: 'Suspended', tone: 'danger' };
    case 'pending':
      return { status: raw, label: 'Pending approval', tone: 'pending' };
    case 'unknown':
      return { status: raw, label: 'Standing not recorded', tone: 'neutral' };
    default:
      return { status: raw, label: raw, tone: 'neutral' };
  }
}

/**
 * The custody state, as the server classified it.
 *
 * Fails CLOSED: anything this module does not recognize is reported as unstated
 * custody with the loud tone, and the release control is governed separately by
 * the server's own `releasable` flag - so an unrecognized value can never
 * license a release.
 */
export function describeCustody(custody: unknown, note: unknown): StrandedCustodyPresentation {
  const noteText = typeof note === 'string' && note.trim() !== ''
    ? note
    : "The server did not state the item's physical custody. Treat it as unknown.";

  if (custody === 'received_at_hub') {
    return { state: 'received_at_hub', label: 'Received at the hub', tone: 'danger', note: noteText };
  }
  if (custody === 'not_yet_received') {
    return { state: 'not_yet_received', label: 'Not yet received at the hub', tone: 'warning', note: noteText };
  }
  return { state: null, label: 'Custody not reported', tone: 'danger', note: noteText };
}

/**
 * How long an item has been assigned, in words.
 *
 * Null means the age is genuinely unknown (no assignment event was recorded), and
 * it is said plainly rather than rendered as "0 hours". A negative or unreadable
 * figure is treated the same way instead of producing a nonsensical age.
 */
export function formatAssignmentAge(hours: unknown): { label: string; known: boolean } {
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0) {
    return { label: 'Unknown - no assignment event was recorded', known: false };
  }
  const whole = Math.floor(hours);
  if (whole < 1) return { label: 'Less than an hour', known: true };
  if (whole === 1) return { label: '1 hour', known: true };
  if (whole < 48) return { label: `${whole} hours`, known: true };
  const days = Math.floor(whole / 24);
  const remainder = whole % 24;
  const dayPart = days === 1 ? '1 day' : `${days} days`;
  if (remainder === 0) return { label: dayPart, known: true };
  return { label: `${dayPart} ${remainder === 1 ? '1 hour' : `${remainder} hours`}`, known: true };
}

const pad2 = (value: number) => (value < 10 ? `0${value}` : String(value));

/** A recorded timestamp for display, or '' when it is absent or unreadable. */
export function formatStrandedTimestamp(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return `${parsed.getFullYear()}-${pad2(parsed.getMonth() + 1)}-${pad2(parsed.getDate())} ${pad2(parsed.getHours())}:${pad2(parsed.getMinutes())}`;
}

/** A non-empty string, or null. Used for every optional text field below. */
function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Maps one API row onto the row the console renders.
 *
 * Returns null when the row does not carry the three facts the console cannot
 * invent: an item id, a holder id, and a status. The caller COUNTS those nulls
 * instead of dropping them silently.
 */
export function mapStrandedQueueItem(raw: unknown): StrandedQueueViewRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const dto = raw as Partial<AdminStrandedItemDto>;
  const itemId = textOrNull(dto.item_id);
  const agentId = textOrNull(dto.agent_id);
  const status = textOrNull(dto.status);
  if (!itemId || !agentId || !status) return null;

  const age = formatAssignmentAge(dto.assignment_age_hours);

  return {
    itemId,
    status,
    statusLabel: describeItemStatus(status),
    countyLabel: textOrNull(dto.county) ?? STRANDED_NOT_RECORDED,
    administrativeUnitId: textOrNull(dto.administrative_unit_id),

    agentId,
    agentName: textOrNull(dto.agent_business_name) ?? `Hub ${agentId}`,
    agentFound: dto.agent_found === true,
    agentStanding: describeAgentStanding(dto.agent_status),

    assignedAt: textOrNull(dto.assigned_at),
    assignedAtLabel: formatStrandedTimestamp(dto.assigned_at),
    ageHours: typeof dto.assignment_age_hours === 'number' ? dto.assignment_age_hours : null,
    ageLabel: age.label,

    custody: describeCustody(dto.custody, dto.custody_note),
    releasable: dto.releasable === true,
    refusal: textOrNull(dto.refusal),
    reviewRequired: dto.review_required === true,
    // The server's verdict, and only the server's verdict.
    canRelease: dto.releasable === true,
  };
}

/** Reads the four reported counts, or null when any of them is not a number. */
export function readStrandedQueueTotals(raw: unknown): StrandedQueueTotalsView | null {
  if (!raw || typeof raw !== 'object') return null;
  const totals = raw as Record<string, unknown>;
  const stranded = totals.stranded;
  const releasable = totals.releasable;
  const custodyReviewRequired = totals.custody_review_required;
  const hubs = totals.hubs;
  for (const value of [stranded, releasable, custodyReviewRequired, hubs]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  }
  return {
    stranded: stranded as number,
    releasable: releasable as number,
    custodyReviewRequired: custodyReviewRequired as number,
    hubs: hubs as number,
  };
}

/**
 * Validates a whole response body into the read model.
 *
 * A body whose `rows` is not a list is REFUSED ('malformed') rather than being
 * treated as an empty queue: "nothing is stranded" is a claim this console must
 * earn from a response it could actually read.
 */
export function readStrandedItemsQueue(body: unknown): StrandedQueueRead {
  const rowsRaw = (body as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rowsRaw)) {
    throw new AdminStrandedItemsApiError(
      'malformed',
      200,
      'The stranded-item queue could not be read.',
    );
  }

  const rows: StrandedQueueViewRow[] = [];
  let unreadableRows = 0;
  for (const raw of rowsRaw) {
    const row = mapStrandedQueueItem(raw);
    if (row) rows.push(row);
    else unreadableRows += 1;
  }

  const envelope = (body ?? {}) as { headline?: unknown; generated_at?: unknown; totals?: unknown };
  return {
    rows,
    headline: textOrNull(envelope.headline),
    generatedAt: textOrNull(envelope.generated_at),
    totals: readStrandedQueueTotals(envelope.totals),
    unreadableRows,
  };
}

// ---------------------------------------------------------------------------
// THE FAILURE VOCABULARY
// ---------------------------------------------------------------------------
// Maps an HTTP status onto a kind, and onto the one sentence the operator is
// shown. Kept as plain exported functions so they can be unit-tested without a
// browser, exactly as services/adminNotificationsApi.ts does.
// ---------------------------------------------------------------------------

export function errorKindForStatus(status: number): AdminStrandedItemsApiErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status >= 500) return 'server';
  return 'invalid';
}

/** The operator-facing sentence for a failed READ. Nothing was changed by one. */
export function queueReadFailureMessageForStatus(status: number): string {
  if (status === 401) return 'Your session has expired. Sign in again to read the stranded-item queue.';
  if (status === 403) return 'This account is not an administrator, so the stranded-item queue is not available.';
  if (status === 404) return 'The stranded-item endpoint is not available on this build.';
  if (status >= 500) return 'The server could not classify the stranded items. Nothing was changed by this read.';
  return 'The stranded-item queue could not be read.';
}

/**
 * The operator-facing sentence for a failed RELEASE.
 *
 * A 400 or a 409 is the server DECLINING, not a transport failure, so it is
 * reported as a refusal that changed nothing - never as a partial success. When
 * the server wrote its own bounded sentence for that refusal (the custody and
 * holder-changed cases do), that sentence is used verbatim instead of a generic
 * one: it is the only text that says WHY this item was not released.
 */
export function releaseFailureMessageForStatus(status: number, serverSentence?: string | null): string {
  if (status === 401) return 'Your session has expired. Sign in again to release an item.';
  if (status === 403) return 'This account is not an administrator, so this item cannot be released.';
  if (status === 404) return 'That item no longer exists, so nothing was released.';
  if (serverSentence) return `The server refused this release: ${serverSentence} Nothing was released.`;
  if (status === 409) return "The server refused this release: the item's custody or holder changed. Nothing was released. Re-read the queue before trying again.";
  if (status === 400) return 'The server refused this release. Nothing was released.';
  if (status >= 500) return 'The server could not process the release. Nothing was confirmed as released - re-read the queue before acting again.';
  return 'The release could not be sent. Nothing was confirmed as released.';
}

/** What a successful release reports back. The item id is echoed, never invented. */
export interface ReleaseStrandedItemResult {
  itemId: string;
  /** The server's own sentence. Rendered verbatim; '' when it carried none. */
  message: string;
}

/** A server-written refusal sentence, bounded, or null when there is not one. */
function readServerRefusal(body: unknown): string | null {
  const text = textOrNull((body as { error?: unknown } | null)?.error);
  if (!text) return null;
  // A refusal is one sentence, not a payload: cap it so a verbose server string
  // cannot flood the banner, and keep the full text in the logs only.
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

/** Read an error body without ever letting a parse failure escape. */
async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// THE TWO CALLS
// ---------------------------------------------------------------------------

/**
 * Read the stranded-item queue: every item still pointing at a hub the platform
 * will not hand work to.
 *
 * GET only; nothing is written, and nothing is decided here. The server
 * classifies (services/strandedItemsQueue.ts) and its `releasable` verdict is
 * carried through untouched. A read that is superseded throws 'aborted' and the
 * caller stays silent; every other failure carries the fixed sentence the
 * operator is shown.
 */
export async function fetchStrandedItemsQueue(
  token: string | null,
  signal?: AbortSignal,
): Promise<StrandedQueueRead> {
  let response: Response;
  try {
    response = await fetch(STRANDED_ITEMS_QUEUE_PATH, {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal,
    });
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') {
      throw new AdminStrandedItemsApiError('aborted', 0, 'Read cancelled.');
    }
    throw new AdminStrandedItemsApiError('network', 0, 'The stranded-item queue could not be reached.');
  }

  if (!response.ok) {
    throw new AdminStrandedItemsApiError(
      errorKindForStatus(response.status),
      response.status,
      queueReadFailureMessageForStatus(response.status),
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AdminStrandedItemsApiError(
      'malformed',
      response.status,
      'The stranded-item queue could not be read.',
    );
  }

  // A 200 body is validated as strictly as the transport envelope: a body whose
  // `rows` is not a list is refused rather than shown as an empty queue.
  return readStrandedItemsQueue(body);
}

/**
 * Return ONE stranded item to the assignment queue.
 *
 * This calls the EXISTING audited primitive (POST /api/admin/items/:id/unassign).
 * No new endpoint, no bulk variant: the server re-checks the custody policy,
 * compare-and-swaps the holder it expects to find, requires a reason, writes the
 * assignment history and appends the audit line. The browser names an item and a
 * reason - it cannot name a replacement hub, cannot move custody and cannot send
 * a list of items.
 *
 * A 400/409 is the server DECLINING (custody blocked, holder changed, no current
 * holder, unusable reason). It is modelled as a typed error carrying the server's
 * own sentence, so a caller cannot render a refusal as success.
 */
export async function releaseStrandedItem(
  token: string | null,
  itemId: string,
  reason: string,
): Promise<ReleaseStrandedItemResult> {
  const targetId = typeof itemId === 'string' ? itemId.trim() : '';
  if (!targetId) {
    throw new AdminStrandedItemsApiError(
      'invalid',
      0,
      'An item id is required to return an item to the queue.',
    );
  }

  // The SAME policy the route enforces (src/config/adminAssignmentReasonPolicy.ts).
  // One rule, applied in both places: a blank, too-short or personal-data reason
  // never leaves the browser at all, and the operator sees the reason it was
  // refused rather than a server round-trip.
  const validated = validateAdminAssignmentReason(reason);
  if (!validated.ok) {
    throw new AdminStrandedItemsApiError('invalid', 0, validated.error);
  }

  let response: Response;
  try {
    response = await fetch(buildItemUnassignPath(targetId), {
      method: 'POST',
      headers: token
        ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
        : { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: validated.reason }),
    });
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') {
      throw new AdminStrandedItemsApiError('aborted', 0, 'Release cancelled.');
    }
    throw new AdminStrandedItemsApiError(
      'network',
      0,
      'The release request could not be completed. Nothing was confirmed as released.',
    );
  }

  if (!response.ok) {
    // Only the two "server declined" statuses carry a sentence worth repeating.
    const body = response.status === 400 || response.status === 409
      ? await readJsonSafely(response)
      : null;
    throw new AdminStrandedItemsApiError(
      errorKindForStatus(response.status),
      response.status,
      releaseFailureMessageForStatus(response.status, readServerRefusal(body)),
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AdminStrandedItemsApiError(
      'malformed',
      response.status,
      'The server accepted the release but its answer could not be read, so the release may already have been applied. Re-read the queue before acting again.',
    );
  }

  return {
    itemId: targetId,
    // The server's sentence, verbatim, or '' - the panel says so rather than
    // inventing an outcome.
    message: textOrNull((body as { message?: unknown } | null)?.message) ?? '',
  };
}
