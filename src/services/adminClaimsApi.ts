// Claims Administration API client (Phase 6F).
//
// WHY THIS MODULE EXISTS
// Every other admin fetch in this repository is inlined inside AdminView.tsx.
// This one is extracted on purpose, for three reasons:
//
//   1. The Claims list/detail calls are the only admin reads with a typed,
//      versioned contract (Phase 6E). The types live beside this file so the UI
//      cannot quietly start consuming a field the safe DTO does not define.
//   2. Query parameters are the security-relevant part of this feature. They
//      are built with URLSearchParams HERE, in one place, so no view can
//      hand-concatenate an unencoded claim id, phone number or date into a URL.
//   3. It is React-free, so it is testable over real HTTP in this repo's
//      node-only vitest environment (there is no jsdom / React Testing Library).
//
// BOUNDARY RULES (guarded by src/__tests__/claimsAdminUiBoundary.test.ts)
//   - reads ONLY GET /api/admin/claims and GET /api/admin/claims/:claimId
//   - never imports the database, the read model or the DTO layer
//   - never logs a response (no console.log of claim data)
//   - never names payment_reference: payment truth is has_paid / paid_at,
//     which the server derived from claims.paid_at alone
//   - contains no mutation verb
import type {
  AdminClaimDetailView,
  AdminClaimListView,
  AdminClaimsListFilters,
} from './adminClaimsApiTypes';
import { AdminClaimsApiError, errorKindForStatus, type AdminClaimsApiErrorKind } from './adminClaimsApiErrors';

export type {
  AdminClaimDetailDisputeView,
  AdminClaimDetailView,
  AdminClaimHistoricalClaimView,
  AdminClaimItemDetailView,
  AdminClaimItemView,
  AdminClaimListView,
  AdminClaimSiblingView,
  AdminClaimVerificationView,
  AdminClaimsListFilters,
} from './adminClaimsApiTypes';
export { AdminClaimsApiError } from './adminClaimsApiErrors';
export type { AdminClaimsApiErrorKind } from './adminClaimsApiErrors';

/** Matches the server's ADMIN_CLAIMS_DEFAULT_LIMIT — 25 rows per page. */
export const ADMIN_CLAIMS_PAGE_SIZE = 25;
/** Mirrors the server's ADMIN_CLAIMS_MAX_LIMIT; the server rejects anything above it. */
export const ADMIN_CLAIMS_MAX_PAGE_SIZE = 100;

export interface AdminClaimsPagination {
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface AdminClaimsListPage {
  items: AdminClaimListView[];
  pagination: AdminClaimsPagination;
}

const LIST_PATH = '/api/admin/claims';

/**
 * Builds the list query string with URLSearchParams — never string
 * concatenation — so a claim id, phone number or date containing `&`, `#`,
 * spaces or non-ASCII characters is percent-encoded rather than being able to
 * change the shape of the request. Absent/empty values are omitted entirely
 * (the server applies its own defaults), and booleans are serialised as the
 * literal 'true'/'false' the endpoint validates strictly.
 */
export function buildClaimsListQuery(
  filters: AdminClaimsListFilters,
  limit: number,
  offset: number,
): string {
  const params = new URLSearchParams();

  const put = (key: string, value: string | undefined | null) => {
    if (value === undefined || value === null) return;
    const trimmed = String(value).trim();
    if (trimmed === '') return;
    params.set(key, trimmed);
  };

  put('claimId', filters.claimId);
  put('itemId', filters.itemId);
  put('claimantPhone', filters.claimantPhone);
  put('status', filters.status);
  put('createdFrom', filters.createdFrom);
  put('createdTo', filters.createdTo);
  if (filters.disputeState) put('disputeState', filters.disputeState);
  if (filters.hasPaid === true) put('hasPaid', 'true');
  if (filters.hasPaid === false) put('hasPaid', 'false');

  params.set('limit', String(limit));
  params.set('offset', String(offset));

  return params.toString();
}

/**
 * The 6E error contract returns `{ error: '<bilingual message>' }`. That string
 * is curated server-side and safe to show for a 400 (it explains which
 * parameter was malformed). For every other status the UI uses its own wording,
 * so a server-side change can never leak something new into the console.
 */
async function readSafeMessage(response: Response, kind: AdminClaimsApiErrorKind): Promise<string> {
  const fallback: Record<AdminClaimsApiErrorKind, string> = {
    unauthorized: 'Your admin session has ended. Please sign in again. / Kipindi chako kimeisha. Tafadhali ingia tena.',
    forbidden: 'Your account is not authorized to view claims. / Akaunti yako hairuhusiwi kuona claim.',
    not_found: 'Claim not found. / Claim haikupatikana.',
    invalid: 'The request was rejected as invalid. / Ombi lilikataliwa kwa sababu si sahihi.',
    server: 'The claims service could not complete the request. Please try again. / Huduma imeshindwa kukamilisha ombi. Tafadhali jaribu tena.',
    network: 'The claims service could not be reached. Check your connection and try again. / Huduma haifikiki. Angalia mtandao na ujaribu tena.',
    aborted: 'Request cancelled.',
  };

  if (kind !== 'invalid') return fallback[kind];

  try {
    const text = await response.text();
    const parsed = JSON.parse(text);
    const message = parsed?.error;
    // Only a short, plain server message is surfaced — never a blob, never a
    // stack trace.
    if (typeof message === 'string' && message.length > 0 && message.length <= 300) {
      return message;
    }
  } catch {
    // Non-JSON body — fall through to the generic message.
  }
  return fallback.invalid;
}

async function getJson<T>(path: string, token: string | null, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'GET',
      // Same bearer scheme as every other authenticated admin request.
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal,
    });
  } catch (e: any) {
    if (e?.name === 'AbortError' || signal?.aborted) {
      throw new AdminClaimsApiError('aborted', 0, 'Request cancelled.');
    }
    throw new AdminClaimsApiError('network', 0, 'The claims service could not be reached.');
  }

  if (!response.ok) {
    const kind = errorKindForStatus(response.status);
    throw new AdminClaimsApiError(kind, response.status, await readSafeMessage(response, kind));
  }

  let body: any;
  try {
    body = await response.json();
  } catch {
    throw new AdminClaimsApiError('server', response.status, 'The claims service returned an unreadable response.');
  }
  return body as T;
}

/**
 * GET /api/admin/claims — one bounded page of the safe list DTO.
 * Pagination comes from the server (`hasMore`); no total count exists in the
 * contract, so none is invented here.
 */
export async function fetchAdminClaimsList(
  token: string | null,
  options: { filters?: AdminClaimsListFilters; limit?: number; offset?: number; signal?: AbortSignal } = {},
): Promise<AdminClaimsListPage> {
  const limit = options.limit ?? ADMIN_CLAIMS_PAGE_SIZE;
  const offset = options.offset ?? 0;
  const query = buildClaimsListQuery(options.filters ?? {}, limit, offset);
  const body = await getJson<any>(`${LIST_PATH}?${query}`, token, options.signal);

  const items = Array.isArray(body?.data) ? (body.data as AdminClaimListView[]) : [];
  return {
    items,
    pagination: {
      limit: typeof body?.pagination?.limit === 'number' ? body.pagination.limit : limit,
      offset: typeof body?.pagination?.offset === 'number' ? body.pagination.offset : offset,
      hasMore: body?.pagination?.hasMore === true,
    },
  };
}

/**
 * GET /api/admin/claims/:claimId — one claim's safe detail DTO.
 * 404 is returned as a typed `not_found` error so the UI can show a real
 * not-found state rather than an empty panel.
 */
export async function fetchAdminClaimDetail(
  token: string | null,
  claimId: string,
  signal?: AbortSignal,
): Promise<AdminClaimDetailView> {
  const path = `${LIST_PATH}/${encodeURIComponent(claimId)}`;
  const body = await getJson<any>(path, token, signal);
  if (!body?.claim || typeof body.claim !== 'object') {
    throw new AdminClaimsApiError('server', 200, 'The claims service returned an unreadable response.');
  }
  return body.claim as AdminClaimDetailView;
}

