// ADMIN LOST-REPORTS API CLIENT (Phase 11A)
// =========================================
// The ONE place the admin console talks to GET /api/admin/lost-reports.
//
// WHY THIS MODULE EXISTS (same reasoning as services/adminClaimsApi.ts)
//   1. The DTO below is a typed, privacy-bounded contract. Keeping the type
//      beside the client means the console cannot quietly start reading a field
//      the admin-safe DTO does not define. In particular this client has no way
//      to express `document_number_hash` or `customer_id`: they are absent from
//      the type, so referencing them is a compile error, not a leak.
//   2. The path is built HERE, so no component hand-concatenates a URL.
//   3. It is REACT-FREE, so it can be tested in this repository's node-only
//      vitest environment.
//
// BOUNDARY RULES (the same discipline as the claims client)
//   - issues GET only. This module has no admin lost-report mutation anywhere:
//     classification lives in services/adminLostReportClassificationApi.ts, and
//     components/customer/__tests__/lostReportUxBoundary.test.ts pins that split
//     by asserting that THIS file contains no POST/PUT/PATCH/DELETE literal;
//   - imports nothing from the database, the routes, the matching engine or any
//     server module;
//   - never logs a response;
//   - never names a finder/agent/identifier-secret field.

/** One row of the admin-safe lost-report list (services/lostReportView.ts). */
export interface AdminLostReportListView {
  /** The public lost-report reference, e.g. LR-XXXXXX. */
  id: string;
  status: string;
  /**
   * PHASE 16.1 (BATCH 1) — NULLABLE, and the type says so because the backend
   * says so: `lost_reports.category_id` no longer carries a NOT NULL
   * constraint, `PATCH /api/admin/lost-reports/:id/classify` accepts a null
   * category, and the list DTO forwards the null. The earlier `string` type was
   * a client-side fiction that made an unclassified report look impossible; the
   * console now renders such a row explicitly as "Unclassified" instead of a
   * blank cell or a raw `null`.
   */
  category_id: string | null;
  /** The name the reporter typed. `null` for a pre-Batch-1 report. */
  item_name: string | null;
  /** Optional lost-report photo path. `null` when the reporter gave none. */
  photo_url: string | null;
  county: string;
  administrative_unit_id: string | null;
  administrative_unit_name: string | null;
  location_area: string;
  location_landmark: string | null;
  lost_at_from: string | null;
  lost_at_to: string | null;
  /** Presence of a protected identifier. The hash itself is never sent. */
  has_document_number: boolean;
  /** null = not applicable (closed report); a number = computed candidate count. */
  possible_match_count: number | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface AdminLostReportsPagination {
  limit: number;
  offset: number;
  hasMore: boolean;
}

export type AdminLostReportsApiErrorKind =
  | 'unauthorized' // 401 — no/!valid session
  | 'forbidden'    // 403 — authenticated but not an administrator
  | 'invalid'      // 400 — malformed query
  | 'server'       // 5xx — genuine server failure
  | 'network'      // the request never completed
  | 'aborted';     // deliberately cancelled (superseded by a newer request)

export class AdminLostReportsApiError extends Error {
  readonly kind: AdminLostReportsApiErrorKind;
  /** HTTP status, or 0 when the request never completed. */
  readonly status: number;

  constructor(kind: AdminLostReportsApiErrorKind, status: number, message: string) {
    super(message);
    this.name = 'AdminLostReportsApiError';
    this.kind = kind;
    this.status = status;
  }

  /** True when the request was cancelled on purpose — callers must stay silent. */
  get isAbort(): boolean {
    return this.kind === 'aborted';
  }
}

export const ADMIN_LOST_REPORTS_PAGE_SIZE = 25;

const LIST_PATH = '/api/admin/lost-reports';

function errorKindForStatus(status: number): AdminLostReportsApiErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status >= 500) return 'server';
  return 'invalid';
}

/**
 * A bounded page of lost reports. Returns the rows and the server's own
 * pagination envelope verbatim — the client never re-derives `hasMore`.
 *
 * A 401/403 is surfaced as a classified error rather than as an empty list, so
 * the console can fall back to its sign-in gate instead of rendering a
 * misleading "no lost reports".
 *
 * PHASE 16.1 (GEO-16-04): `county` is the optional canonical county filter
 * (e.g. 'Mombasa'). It is omitted from the query string entirely when the
 * administrator has "All Counties" selected, so the unfiltered request is
 * byte-for-byte the pre-16.1 request. A cleared filter therefore restores the
 * unfiltered list rather than asking the server for `county=`.
 *
 * PHASE 16.1 (BATCH 1): `unclassifiedOnly` adds `unclassified=true` to the
 * query string and NOTHING when it is false, for exactly the same reason — the
 * default request must stay byte-identical to the pre-Batch-1 one. It composes
 * with `county`, so "unclassified reports in Mombasa" is one request.
 */
export async function fetchAdminLostReports(
  token: string | null,
  opts: {
    limit?: number;
    offset?: number;
    county?: string | null;
    unclassifiedOnly?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<{ items: AdminLostReportListView[]; pagination: AdminLostReportsPagination }> {
  const limit = opts.limit ?? ADMIN_LOST_REPORTS_PAGE_SIZE;
  const offset = opts.offset ?? 0;
  let url = `${LIST_PATH}?limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}`;
  if (opts.county) url += `&county=${encodeURIComponent(opts.county)}`;
  // Only ever the literal `true`: `unclassified=false` would be a second way of
  // spelling "no filter" and there is no reason to send bytes the server must
  // then re-interpret.
  if (opts.unclassifiedOnly) url += '&unclassified=true';

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: opts.signal,
    });
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      throw new AdminLostReportsApiError('aborted', 0, 'Request cancelled.');
    }
    throw new AdminLostReportsApiError('network', 0, 'The lost-report service could not be reached.');
  }

  if (!res.ok) {
    throw new AdminLostReportsApiError(
      errorKindForStatus(res.status),
      res.status,
      res.status === 403
        ? 'Access denied.'
        : res.status === 401
          ? 'Your admin session has ended. Please sign in again.'
          : 'The lost-report list could not be loaded.',
    );
  }

  const body = await res.json();
  if (!body || !Array.isArray(body.data)) {
    throw new AdminLostReportsApiError('server', res.status, 'The lost-report list could not be read.');
  }

  return {
    items: body.data as AdminLostReportListView[],
    pagination: (body.pagination ?? { limit, offset, hasMore: false }) as AdminLostReportsPagination,
  };
}
