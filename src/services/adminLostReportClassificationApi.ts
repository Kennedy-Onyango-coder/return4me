// =============================================================================
// ADMIN LOST-REPORT CLASSIFICATION — API CLIENT
// =============================================================================
// The ONE place the Admin Console changes a lost report's item category:
//   PATCH /api/admin/lost-reports/:id/classify
//
// WHY THIS MODULE EXISTS (and why it is SEPARATE from adminLostReportsApi.ts)
//   1. `services/adminLostReportsApi.ts` is deliberately GET-only, and its own
//      boundary test asserts that it contains no POST/PUT/PATCH/DELETE literal.
//      Adding the mutation there would silently turn the read path into a
//      write-capable module. Classification therefore lives here.
//   2. The path and the request body are built HERE. No component concatenates
//      a URL or hand-writes the JSON, so the shape the route reads
//      (`req.body.categoryId`) cannot drift away from what the console sends.
//   3. It is React-free, so the request contract can be executed by tests in
//      this repository's node-only vitest environment.
//
// THE CONTRACT THIS CLIENT HONOURS (routes/adminLostReports.ts)
//   - `authenticateJWT` + `requireCurrentAdminSession` + an explicit role check,
//     so a non-administrator gets 403 and no session gets 401;
//   - the body is read as `req.body.categoryId` — NOT `report_id`/`category_id`.
//     A body carrying those other names is read as `undefined`, i.e. "no
//     category", which would silently UNCLASSIFY the report. That is exactly
//     why the body is built in one place and asserted byte-for-byte by test.
//   - a non-empty category must exist in `db.getActiveCategories()`, otherwise
//     400 "That item category is not valid.";
//   - an unknown reference is 404.
//
// WHAT THIS CLIENT DELIBERATELY DOES NOT DO
//   - it never logs a token, a report reference, a category or a response;
//   - it never invents a success: only an envelope with `success === true` is
//     mapped, and every other 2xx shape is a `malformed` error;
//   - `null` is only ever sent by `unclassifyLostReport()`, so a stray empty
//     selection can never remove a report's classification by accident.
// =============================================================================

/** The admin lost-report path. The list client owns the GET; this owns the PATCH. */
export const ADMIN_LOST_REPORTS_PATH = '/api/admin/lost-reports';

/**
 * PATCH /api/admin/lost-reports/:id/classify
 *
 * The reference is URL-encoded: a report reference is normally `LR-XXXXXX`, but
 * the client must not depend on that, because the path is built from a value
 * that arrived over the network.
 */
export function lostReportClassifyPath(reportId: string): string {
  return `${ADMIN_LOST_REPORTS_PATH}/${encodeURIComponent(reportId)}/classify`;
}

export type AdminLostReportClassifyErrorKind =
  | 'unauthorized' // 401 — no/invalid admin session
  | 'forbidden' // 403 — authenticated but not an administrator
  | 'not_found' // 404 — no such lost report
  | 'invalid' // 400 — refused category / malformed body
  | 'server' // 5xx — genuine server failure
  | 'malformed' // 2xx whose body was not the documented envelope
  | 'network' // the request never completed
  | 'aborted'; // deliberately cancelled

export class AdminLostReportClassifyApiError extends Error {
  readonly kind: AdminLostReportClassifyErrorKind;
  /** HTTP status, or 0 when the request never completed. */
  readonly status: number;

  constructor(kind: AdminLostReportClassifyErrorKind, status: number, message: string) {
    super(message);
    this.name = 'AdminLostReportClassifyApiError';
    this.kind = kind;
    this.status = status;
  }

  /** True when the request was cancelled on purpose — callers must stay silent. */
  get isAbort(): boolean {
    return this.kind === 'aborted';
  }
}

/** What the server confirmed, in the console's own vocabulary. */
export interface AdminLostReportClassification {
  /** The category the report carried BEFORE this change (null = unclassified). */
  previousCategoryId: string | null;
  /** The category the report carries now (null = unclassified). */
  categoryId: string | null;
}

export interface ClassifyLostReportOptions {
  signal?: AbortSignal;
}

function errorKindForStatus(status: number): AdminLostReportClassifyErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server';
  return 'invalid';
}

/**
 * The sentence shown when the server sends no usable text. 401/403 always use
 * the fixed sentence: a bare proxy "Forbidden" tells an operator nothing about
 * the remedy, and the route's own refusal is a role rejection.
 */
function failureMessage(kind: AdminLostReportClassifyErrorKind): string {
  switch (kind) {
    case 'unauthorized':
      return 'Your admin session has ended. Please sign in again.';
    case 'forbidden':
      return 'Access denied — this action needs an administrator session.';
    case 'not_found':
      return 'That lost report could not be found.';
    case 'server':
      return 'The classification could not be saved. Please try again.';
    default:
      return 'That classification was refused.';
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** A body that is not JSON is `null`, never an exception escaping to the caller. */
async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * The single request path. Sends exactly `{ categoryId }`; the caller decides
 * whether that value is a real category id or the explicit `null` used to clear
 * a classification.
 */
async function requestClassification(
  token: string | null,
  reportId: string,
  body: { categoryId: string | null },
  options: ClassifyLostReportOptions,
): Promise<unknown> {
  if (!token) {
    throw new AdminLostReportClassifyApiError(
      'unauthorized',
      401,
      failureMessage('unauthorized'),
    );
  }

  const reference = typeof reportId === 'string' ? reportId.trim() : '';
  if (!reference) {
    throw new AdminLostReportClassifyApiError(
      'invalid',
      0,
      'A lost-report reference is required.',
    );
  }

  let response: Response;
  try {
    response = await fetch(lostReportClassifyPath(reference), {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') {
      throw new AdminLostReportClassifyApiError('aborted', 0, 'Request cancelled.');
    }
    throw new AdminLostReportClassifyApiError(
      'network',
      0,
      'The lost-report service could not be reached.',
    );
  }

  const parsed = await readBody(response);

  if (!response.ok) {
    const envelope = record(parsed);
    const serverMessage = envelope && typeof envelope.error === 'string' ? envelope.error : null;
    const kind = errorKindForStatus(response.status);
    // A 401/403 keeps the fixed sentence whichever way the refusal arrived.
    const fixed = kind === 'unauthorized' || kind === 'forbidden' ? failureMessage(kind) : null;
    throw new AdminLostReportClassifyApiError(
      kind,
      response.status,
      fixed ?? serverMessage ?? failureMessage(kind),
    );
  }

  return parsed;
}

function mapClassification(value: unknown): AdminLostReportClassification {
  const envelope = record(value);
  if (!envelope || envelope.success !== true) {
    throw new AdminLostReportClassifyApiError(
      'malformed',
      200,
      'The server did not confirm the classification.',
    );
  }
  return {
    previousCategoryId: optionalText(envelope.previousCategory),
    categoryId: optionalText(envelope.newCategory),
  };
}

/**
 * Assign a category to a lost report.
 *
 * A blank selection is refused locally as `invalid` and never sent: the route
 * reads a missing/blank `categoryId` as "no category", so an empty value would
 * CLEAR the classification instead of setting one.
 */
export async function classifyLostReport(
  token: string | null,
  reportId: string,
  categoryId: string,
  options: ClassifyLostReportOptions = {},
): Promise<AdminLostReportClassification> {
  const selected = typeof categoryId === 'string' ? categoryId.trim() : '';
  if (!selected) {
    throw new AdminLostReportClassifyApiError(
      'invalid',
      0,
      'Choose an item category before saving.',
    );
  }
  const body = await requestClassification(token, reportId, { categoryId: selected }, options);
  return mapClassification(body);
}

/**
 * Clear a report's category. This is the ONLY function that sends `null`, so
 * removing a classification is always an explicit, separately-called action
 * rather than the side effect of an empty form field.
 *
 * The console does not currently offer this action: the audit behind this
 * module found no existing removal UX to extend, so a destructive control was
 * not invented. The endpoint supports it, so the capability is modelled — and
 * covered by test — here rather than being left to an ad-hoc fetch later.
 */
export async function unclassifyLostReport(
  token: string | null,
  reportId: string,
  options: ClassifyLostReportOptions = {},
): Promise<AdminLostReportClassification> {
  const body = await requestClassification(token, reportId, { categoryId: null }, options);
  return mapClassification(body);
}
