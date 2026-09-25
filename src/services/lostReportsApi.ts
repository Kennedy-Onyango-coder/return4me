// CUSTOMER LOST-REPORT API CLIENT (Phase 9C)
// ==========================================
// The ONE place the frontend talks to the Phase 9A/9B lost-report endpoints.
//
// WHY THIS MODULE EXISTS (same reasoning as services/adminClaimsApi.ts)
//   1. The candidate DTO is a typed, privacy-bounded contract. Keeping the
//      types beside the client means the UI cannot quietly start reading a
//      field the safe DTO does not define.
//   2. Paths are built HERE, with encodeURIComponent, so no component can
//      hand-concatenate a report reference into a URL.
//   3. It is REACT-FREE, so it is testable in this repository's node-only
//      vitest environment (there is no jsdom / React Testing Library) against
//      the REAL route handlers.
//
// BOUNDARY RULES (guarded by src/components/customer/__tests__/lostReportUxBoundary.test.ts)
//   - reads/writes ONLY the documented lost-report endpoints;
//   - imports NOTHING from the database, the routes, the matching engine or
//     any server module — the browser is not the matcher, and the UI must never
//     re-implement matching locally;
//   - never logs a response;
//   - never names a finder/agent/identifier field: those are not part of the
//     DTO this client is allowed to consume.
//
// WHAT THE SERVER ACTUALLY RETURNS (verified against Phase 9A/9B, not assumed):
//   POST /api/lost-reports            -> 201 { success, reference, status, created_at }
//   GET  /api/lost-reports            -> 200 { lost_reports: LostReportView[] }
//   GET  /api/lost-reports/:id        -> 200 { lost_report: LostReportView }
//   GET  /api/lost-reports/:id/matches-> 200 {
//                                            lost_report_id,
//                                            ownership_confirmed: false,
//                                            notice,
//                                            disclosure: { en, sw },
//                                            matches: LostReportMatchCandidate[]
//                                          }

/** The authenticated owner's own report (services/lostReportView.ts). */
export interface LostReportView {
  id: string;
  status: string;
  category_id: string;
  county: string;
  administrative_unit_id: string | null;
  administrative_unit_name: string | null;
  location_area: string;
  location_landmark: string | null;
  lost_at_from: string | null;
  lost_at_to: string | null;
  brand: string | null;
  model: string | null;
  colour: string | null;
  material: string | null;
  description: string | null;
  distinctive_marks: string | null;
  document_type: string | null;
  /** True when a protected identifier was recorded. The hash is never sent. */
  has_document_number: boolean;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * One possible match. This is the COMPLETE public DTO — no score, no engine
 * signals, no finder contact, no identifier (hashed or plain), no coordinates,
 * no agent. The type is deliberately closed: adding a field here without
 * changing the server DTO would be a compile error, and adding one to both
 * without a privacy review would be a visible diff.
 */
export interface LostReportMatchCandidate {
  id: string;
  category_id: string;
  photo_url: string | null;
  is_sensitive_document: boolean;
  document_name_fuzzy: string | null;
  /** Phase 16.1 (GEO-16-03): the canonical county, or null for a legacy item. */
  found_county: string | null;
  location_description: string | null;
  description: string | null;
  isDescriptionOnly: boolean;
  found_at: string | null;
  match_reasons: string[];
}

export interface LostReportMatchResponse {
  lost_report_id: string | null;
  /** Always false from the server: a candidate is never ownership. */
  ownership_confirmed: boolean;
  notice: string;
  disclosure: { en: string; sw: string };
  matches: LostReportMatchCandidate[];
}

export interface LostReportCreationResponse {
  success: boolean;
  reference: string;
  status: string;
  created_at: string | null;
}

/** The payload the wizard submits. Mirrors routes/lostReports.ts exactly. */
export interface LostReportCreatePayload {
  categoryId: string;
  county: string;
  administrativeUnitId: string;
  locationArea: string;
  locationLandmark?: string | null;
  lostAtFrom: string;
  lostAtTo?: string | null;
  brand?: string | null;
  model?: string | null;
  colour?: string | null;
  material?: string | null;
  description?: string | null;
  distinctiveMarks?: string | null;
  documentType?: string | null;
  documentNumber?: string | null;
}

// ---------------------------------------------------------------------------
// RESULT MODEL
// ---------------------------------------------------------------------------
// Deliberately a single interface with optional members rather than a
// boolean-discriminated union: this project compiles with `strictNullChecks`
// OFF (see tsconfig.json), under which narrowing on a boolean discriminant is
// not reliable (the same constraint Phase 9A/9B worked around).
//
// The `kind` is what callers branch on. Note that NOT EVERY non-OK status is
// surfaced distinctly to the customer: 'not_found' covers malformed, unknown
// AND another customer's reference, because the UI must not become an
// enumeration oracle by describing which of those it was.
export type LostReportsApiErrorKind =
  | 'auth'         // 401 — session missing/expired/revoked
  | 'forbidden'    // 403 — suspended account
  | 'not_found'    // 404 — malformed, unknown or not-owned reference
  | 'rate_limited' // 429
  | 'validation'   // 400 — server-supplied bilingual message
  | 'server'       // 5xx
  | 'network'      // the request never completed
  | 'malformed';   // a 2xx whose body was not the documented shape

export interface LostReportsApiError {
  kind: LostReportsApiErrorKind;
  status: number;
  /** Server-supplied bilingual message, present only for 'validation'. */
  message?: string;
}

export interface LostReportsApiResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: LostReportsApiError;
}

/** Maps an HTTP status to the client's error kind. */
export function errorKindForStatus(status: number): LostReportsApiErrorKind {
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status === 400) return 'validation';
  if (status >= 500) return 'server';
  return 'malformed';
}

export const LOST_REPORTS_PATH = '/api/lost-reports';

/** Encoded path for one report's matches. Never hand-built by a component. */
export function lostReportMatchesPath(reference: string): string {
  return `${LOST_REPORTS_PATH}/${encodeURIComponent(reference)}/matches`;
}

/** Encoded path for one report. */
export function lostReportPath(reference: string): string {
  return `${LOST_REPORTS_PATH}/${encodeURIComponent(reference)}`;
}

/**
 * Performs the request and normalizes every failure into a `kind`.
 *
 * `credentials: 'same-origin'` is what carries the customer session cookie —
 * the same setting every other authenticated customer call in this app uses.
 * No response is ever logged.
 */
async function request<T>(
  path: string,
  init: RequestInit = {},
  validate: (body: any) => boolean = () => true,
): Promise<LostReportsApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: {
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
    });
  } catch {
    // The request never completed (offline, DNS, aborted). Nothing to inspect.
    return { ok: false, status: 0, error: { kind: 'network', status: 0 } };
  }

  const status = res.status;

  if (!res.ok) {
    let message: string | undefined;
    try {
      const body = await res.json();
      if (body && typeof body.error === 'string') message = body.error;
    } catch {
      // Non-JSON error body — the kind alone is enough for the UI.
    }
    const kind = errorKindForStatus(status);
    return {
      ok: false,
      status,
      error: { kind, status, ...(kind === 'validation' && message ? { message } : {}) },
    };
  }

  let body: any;
  try {
    body = await res.json();
  } catch {
    return { ok: false, status, error: { kind: 'malformed', status } };
  }

  if (!validate(body)) {
    return { ok: false, status, error: { kind: 'malformed', status } };
  }
  return { ok: true, status, data: body as T };
}

export interface LostReportsRequestOptions {
  /** Lets a caller cancel an in-flight read (e.g. on unmount). */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// ENDPOINTS
// ---------------------------------------------------------------------------

/**
 * Creates a lost report for the AUTHENTICATED customer. Identity is derived
 * server-side from the session — this client never and cannot send a customer
 * id, and sends no contact details at all (the account's own verified number is
 * the contact).
 */
export async function createLostReport(
  payload: LostReportCreatePayload,
): Promise<LostReportsApiResult<LostReportCreationResponse>> {
  return request<LostReportCreationResponse>(
    LOST_REPORTS_PATH,
    { method: 'POST', body: JSON.stringify(payload) },
    (body) => Boolean(body && body.success === true && typeof body.reference === 'string'),
  );
}

/** The authenticated customer's OWN reports. Owner-scoped by the server. */
export async function listMyLostReports(
  options: LostReportsRequestOptions = {},
): Promise<LostReportsApiResult<{ lost_reports: LostReportView[] }>> {
  return request<{ lost_reports: LostReportView[] }>(
    LOST_REPORTS_PATH,
    { method: 'GET', signal: options.signal },
    (body) => Boolean(body && Array.isArray(body.lost_reports)),
  );
}

/**
 * One OWN report. A 404 here means malformed, unknown OR not-owned — the caller
 * must present all three identically.
 */
export async function getMyLostReport(
  reference: string,
  options: LostReportsRequestOptions = {},
): Promise<LostReportsApiResult<{ lost_report: LostReportView }>> {
  return request<{ lost_report: LostReportView }>(
    lostReportPath(reference),
    { method: 'GET', signal: options.signal },
    (body) => Boolean(body && body.lost_report && typeof body.lost_report.id === 'string'),
  );
}

/**
 * Possible found-item matches for ONE OWN report (Phase 9B).
 *
 * READ-ONLY BY CONSTRUCTION: this is a GET, and it is the ONLY match-related
 * call this client makes. Viewing candidates cannot create a claim, verify
 * ownership, move an item's state, or touch payment — the server route writes
 * nothing, and the client has no match-mutating call to make in the first
 * place.
 */
export async function fetchLostReportMatches(
  reference: string,
  options: LostReportsRequestOptions = {},
): Promise<LostReportsApiResult<LostReportMatchResponse>> {
  return request<LostReportMatchResponse>(
    lostReportMatchesPath(reference),
    { method: 'GET', signal: options.signal },
    (body) => Boolean(
      body
      && Array.isArray(body.matches)
      && typeof body.notice === 'string'
      && body.disclosure
      && typeof body.disclosure.en === 'string'
      && typeof body.disclosure.sw === 'string',
    ),
  );
}

/**
 * The server's own notice codes, so a component compares against a named
 * constant instead of a bare string literal. Both come from
 * services/lostReportMatchView.ts (Phase 9B).
 */
export const POSSIBLE_MATCH_NOTICE = 'possible_matches_do_not_confirm_ownership';
export const REPORT_NOT_ACTIVE_NOTICE = 'lost_report_not_active';


