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
//   - issues GET only — there is no admin lost-report mutation anywhere;
//   - imports nothing from the database, the routes, the matching engine or any
//     server module;
//   - never logs a response;
//   - never names a finder/agent/identifier-secret field.

/** One row of the admin-safe lost-report list (services/lostReportView.ts). */
export interface AdminLostReportListView {
  /** The public lost-report reference, e.g. LR-XXXXXX. */
  id: string;
  status: string;
  category_id: string;
  county: string;
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
 */
export async function fetchAdminLostReports(
  token: string | null,
  opts: { limit?: number; offset?: number; signal?: AbortSignal } = {},
): Promise<{ items: AdminLostReportListView[]; pagination: AdminLostReportsPagination }> {
  const limit = opts.limit ?? ADMIN_LOST_REPORTS_PAGE_SIZE;
  const offset = opts.offset ?? 0;
  const url = `${LIST_PATH}?limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}`;

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
        ? 'Ruhusa imekataliwa.'
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
