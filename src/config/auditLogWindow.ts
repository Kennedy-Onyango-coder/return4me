// PROGRAMME 1 / WS4 — BOUNDED AUDIT-LOG WINDOW PARAMETERS (PURE, NO I/O)
// =====================================================================
// The admin console's audit surface reads an ADMIN-ONLY endpoint
// (GET /api/admin/audit-logs) that returns a BOUNDED window of the audit trail.
//
// WHY THE BOUND IS PART OF THE CONTRACT, NOT OF THE UI
// ---------------------------------------------------
// The audit table grows without limit. A read surface whose size is chosen by
// the caller is one URL away from streaming the entire history of every
// administrative action ever recorded, so the bound is decided HERE, by the
// server, and the request is either inside it or refused. There is no
// "unbounded" mode, and a malformed parameter is NOT silently repaired:
//
//   * absent / empty `limit`   -> AUDIT_LOG_WINDOW_DEFAULT (a documented default);
//   * a present `limit` that is not a canonical integer in
//     [1, AUDIT_LOG_WINDOW_MAX] -> REFUSED (400), never clamped. Clamping would
//     answer a different question from the one asked and hide the mistake;
//   * a present `action` that is not a plausible audit action code -> REFUSED,
//     so a filter typo can never be mistaken for "no such audit entries".
//
// Refusing beats repairing because an operator reading an audit trail must be
// able to trust that what they see is what they asked for. The refusal reason is
// a fixed sentence with no echo of the input, so no query-string content is
// reflected back.

/** Window size when the caller does not ask for one. */
export const AUDIT_LOG_WINDOW_DEFAULT = 100;

/** The largest window this server will ever build in one response. */
export const AUDIT_LOG_WINDOW_MAX = 500;

/** The window sizes the console offers. Every one is <= AUDIT_LOG_WINDOW_MAX. */
export const AUDIT_LOG_WINDOW_OPTIONS: readonly number[] = [50, 100, 200, 500];

/**
 * The shape of an audit action code (`ACTION_NAME`): it starts with a letter and
 * is upper-case letters, digits and underscores. Deliberately a positive shape
 * test — a filter this build does not recognise is refused rather than passed
 * through to a pattern match against stored text.
 */
export const AUDIT_LOG_ACTION_FILTER_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;

export interface AuditLogWindowRequest {
  /** True only when the request may be served with exactly the window decided here. */
  ok: boolean;
  /** The number of rows to read. Only meaningful when ok. */
  limit: number;
  /** The exact action code to filter by, or null for "all actions". */
  action: string | null;
  /** Operator-facing explanation of the refusal. Present iff !ok. */
  reason?: string;
}

/** Whether a value looks like an audit action code (see the pattern above). */
export function isAuditActionFilter(value: unknown): boolean {
  return typeof value === 'string' && AUDIT_LOG_ACTION_FILTER_PATTERN.test(value);
}

/** A query value, flattened from Express's `string | string[] | undefined`. */
function firstValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

/**
 * Decide the window for one request. Nothing here reads the database, and
 * nothing here defaults a value the caller supplied but got wrong.
 */
export function readAuditLogWindowRequest(query: unknown): AuditLogWindowRequest {
  const source = (query && typeof query === 'object' ? query : {}) as Record<string, unknown>;

  const rawLimit = firstValue(source.limit);
  let limit = AUDIT_LOG_WINDOW_DEFAULT;
  if (rawLimit !== null && rawLimit.trim() !== '') {
    const trimmed = rawLimit.trim();
    // A canonical integer only: '100' is a window, '1e2', ' 100 ', '10.0' and
    // '-5' are not. The refusal keeps the window the server's decision.
    if (!/^\d{1,4}$/.test(trimmed)) {
      return { ok: false, limit: AUDIT_LOG_WINDOW_DEFAULT, action: null, reason: `The audit window must be a whole number of entries between 1 and ${AUDIT_LOG_WINDOW_MAX}.` };
    }
    const parsed = Number(trimmed);
    if (parsed < 1 || parsed > AUDIT_LOG_WINDOW_MAX) {
      return { ok: false, limit: AUDIT_LOG_WINDOW_DEFAULT, action: null, reason: `The audit window must be between 1 and ${AUDIT_LOG_WINDOW_MAX} entries.` };
    }
    limit = parsed;
  }

  const rawAction = firstValue(source.action);
  let action: string | null = null;
  if (rawAction !== null && rawAction.trim() !== '') {
    const trimmed = rawAction.trim();
    if (!isAuditActionFilter(trimmed)) {
      return { ok: false, limit, action: null, reason: 'An audit action filter must be an upper-case action code, for example PAYOUT_INITIATED.' };
    }
    action = trimmed;
  }

  return { ok: true, limit, action };
}
