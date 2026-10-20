// ADMIN SECOND-ADMINISTRATOR PROVISIONING API CLIENT
// ===================================================
// The ONE place the admin console talks to POST /api/admin/provision-admin —
// the backend committed in 6af77c2 (db.provisionSecondAdmin + the route behind
// authenticateJWT -> requireCurrentAdminSession -> the inline admin role
// check). This module adds NO backend behaviour and invents no contract: the
// path, the camelCase `fullName` request field, the snake_case response field
// names and every status/code below are read from src/server.ts and
// src/db/database.ts as they are actually shipped.
//
// WHY THIS MODULE EXISTS (the same reasoning as services/adminAuditLogApi.ts)
//   1. The payload is a typed, privacy-bounded contract. Only the four
//      documented response fields are ever read, so a field added to the API in
//      future cannot appear on screen by accident — and a password hash could
//      never be rendered even if a server built one into the envelope.
//   2. The path is built HERE, so no component hand-concatenates a URL and the
//      password can never end up in a query string (this is a POST body only).
//   3. It is REACT-FREE, so it can be tested in this repository's node-only
//      vitest environment.
//
// WHAT THIS CLIENT DELIBERATELY DOES NOT DO
//   * It does NOT decide availability. There is deliberately NO status
//     endpoint for provisioning: probing "can I still provision?" would either
//     leak the gate's state or race the one-time transaction. The server's
//     decision on submission is the ONLY authority; a 409 with code
//     `provisioning_closed` (or `no_bootstrap_admin`) is the closure signal.
//   * It does NOT mint, store, forward or refresh any session. The caller
//     passes the console's existing admin token, exactly as the other admin
//     clients do; nothing here touches localStorage/sessionStorage.
//   * It never logs a request, a response or a field of either, and no error
//     it throws ever carries the submitted password: fixed, codebase-written
//     sentences only.
//
// THE ONE-TIME RULE LIVES SERVER-SIDE
//   db.provisionSecondAdmin succeeds only while exactly one administrator
//   exists and the caller IS that bootstrap administrator; afterwards every
//   attempt is a 409. This client only TRANSLATES that decision for the UI —
//   it can never open or widen the gate.

/** Built here, once. No component builds this path. */
export const ADMIN_PROVISION_ADMIN_PATH = '/api/admin/provision-admin';

/**
 * The request exactly as POST /api/admin/provision-admin reads it.
 *
 * `fullName` is camelCase because that is the wire name the ROUTE destructures
 * from the body (`{ username, password, fullName }` in server.ts) and passes to
 * db.provisionSecondAdmin. The server validates: username non-empty (<=50),
 * fullName non-empty (<=100), password non-empty (<=200). Mirrored by
 * validateProvisionAdminForm() below so the UI cannot promise a length the API
 * refuses or accept one it would.
 */
export interface ProvisionAdminRequest {
  fullName: string;
  username: string;
  password: string;
}

/**
 * The created administrator, exactly as the success envelope's `admin` object
 * names it (`full_name` / `created_at` — the SERVER'S wire names, not the
 * console's camelCase). These four fields are the client's entire read
 * whitelist: `password_hash`, `token_version`, `totp_enabled` and friends are
 * never read even if present, so no credential material can ride along.
 */
export interface ProvisionedAdminDto {
  id: string | null;
  username: string;
  full_name: string | null;
  created_at: string | null;
}

export type ProvisionAdminApiErrorKind =
  | 'validation'   // 400 — a field was refused (mirrors the 400 codes below)
  | 'unauthorized' // 401 — no/!valid session
  | 'forbidden'    // 403 — not the bootstrap administrator (or not an admin)
  | 'closed'       // 409 provisioning_closed | no_bootstrap_admin: the ONE-TIME
                   //    gate has closed permanently; the UI must disable the form
  | 'conflict'     // 409 admin_username_exists (username taken; a different
                   //    username may still be attempted while the gate is open)
  | 'server'       // 5xx — genuine server failure; nothing was committed
  | 'malformed'    // 2xx whose body was not the documented envelope
  | 'network';     // the request never completed

/**
 * A provisioning failure, translated for the operator. The message is a FIXED
 * sentence: for validation/closed/conflict it is the server's own
 * ProvisionAdminError text (client-safe strings pinned by the backend's
 * errorDisclosure tests) after sanitisation; for every other kind it is
 * written HERE and the response body is never read into it. No field of the
 * submitted request is ever echoed.
 */
export class ProvisionAdminApiError extends Error {
  readonly kind: ProvisionAdminApiErrorKind;
  /** HTTP status, or 0 when the request never completed / no token was held. */
  readonly status: number;
  /** The server's `code` when it sent one (e.g. 'provisioning_closed'). */
  readonly code: string | null;

  constructor(kind: ProvisionAdminApiErrorKind, status: number, code: string | null, message: string) {
    super(message);
    this.name = 'ProvisionAdminApiError';
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

/** Longest server-supplied sentence ever shown. A blob cannot restructure UI. */
const SERVER_MESSAGE_MAX_LENGTH = 240;

/**
 * A server-written, fixed, client-safe sentence (the ProvisionAdminError
 * messages), made structurally safe to render: control characters collapsed,
 * length capped. Returns '' for anything that is not a non-empty string, so a
 * malformed body can never inject `undefined`, an object or a stack trace.
 */
export function sanitizeProvisionAdminServerMessage(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  return normalized.length > SERVER_MESSAGE_MAX_LENGTH
    ? `${normalized.slice(0, SERVER_MESSAGE_MAX_LENGTH)}\u2026`
    : normalized;
}

/** A trimmed, non-empty string, or null. Used for the whitelisted response fields. */
function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Map an HTTP status + server `code` onto an error kind. Kept pure and
 * exported so the UI tests can pin the mapping without a network.
 *
 * The two closure codes are recognised by NAME, not by status alone: a 409 is
 * the only status the route uses for both "the gate is closed" and "username
 * taken", and those two outcomes need opposite UI (disable the form forever
 * vs. correct one field and retry).
 */
export function mapProvisionAdminFailure(status: number, code: string | null): ProvisionAdminApiErrorKind {
  if (code === 'provisioning_closed' || code === 'no_bootstrap_admin') return 'closed';
  if (code === 'admin_username_exists') return 'conflict';
  if (status === 400) return 'validation';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 409) return 'conflict'; // unknown 409 code — treat conservatively
  if (status >= 500) return 'server';
  return 'validation';
}

/**
 * The operator-facing sentence for kinds whose text must never come from the
 * response body (session/server/network/malformed). Fixed text, echoing no
 * data of any kind.
 */
function fixedMessageForKind(kind: ProvisionAdminApiErrorKind): string {
  switch (kind) {
    case 'unauthorized':
      return 'Your administrator session is missing or has expired. Sign in again, then retry.';
    case 'forbidden':
      return 'Only the bootstrap administrator can run this one-time provisioning action.';
    case 'server':
      return 'The server could not complete the request. Nothing was created — try again shortly.';
    case 'malformed':
      return 'The server confirmed the request but its response could not be read. Nothing is assumed to have been created — check the administrator list before retrying.';
    case 'network':
      return 'The provisioning request could not reach the server. Nothing was created — check the connection and retry.';
    default:
      return 'The provisioning request was refused.';
  }
}

/**
 * Build the Error for a non-2xx response. `validation` / `closed` / `conflict`
 * show the server's OWN fixed ProvisionAdminError sentence (sanitised); every
 * other kind ignores the body entirely.
 */
export function provisionAdminFailureFromResponse(status: number, body: unknown): ProvisionAdminApiError {
  const envelope = (body ?? {}) as { error?: unknown; code?: unknown };
  const code = optionalText(envelope.code);
  const kind = mapProvisionAdminFailure(status, code);
  const serverMessage = sanitizeProvisionAdminServerMessage(envelope.error);
  const message = (kind === 'validation' || kind === 'closed' || kind === 'conflict') && serverMessage
    ? serverMessage
    : fixedMessageForKind(kind);
  return new ProvisionAdminApiError(kind, status, code, message);
}

/**
 * The success envelope -> the DTO the console renders. Throws 'malformed' when
 * `ok !== true` or the `admin` object is missing/unreadable: a body this client
 * cannot read is a failure to report, not a success to guess at.
 */
export function mapProvisionedAdmin(body: unknown): ProvisionedAdminDto {
  const envelope = (body ?? null) as { ok?: unknown; admin?: unknown } | null;
  if (!envelope || envelope.ok !== true || !envelope.admin || typeof envelope.admin !== 'object') {
    throw new ProvisionAdminApiError('malformed', 200, null, fixedMessageForKind('malformed'));
  }
  const admin = envelope.admin as Record<string, unknown>;
  const username = optionalText(admin.username);
  if (!username) {
    throw new ProvisionAdminApiError('malformed', 200, null, fixedMessageForKind('malformed'));
  }
  return {
    id: optionalText(admin.id),
    username,
    full_name: optionalText(admin.full_name),
    created_at: optionalText(admin.created_at),
  };
}

// ---------------------------------------------------------------------------
// CLIENT-SIDE VALIDATION (mirrors the server's rules; never invents stricter
// or looser limits than db.provisionSecondAdmin enforces).
// ---------------------------------------------------------------------------

export type ProvisionAdminFormField = 'fullName' | 'username' | 'password' | 'confirmPassword';

export type ProvisionAdminFieldErrors = Partial<Record<ProvisionAdminFormField, string>>;

export interface ProvisionAdminFormValues {
  fullName: string;
  username: string;
  password: string;
  /** Client-only confirmation; the server never sees this field. */
  confirmPassword: string;
}

/** Server-enforced length ceilings (db.provisionSecondAdmin). */
export const PROVISION_ADMIN_LIMITS = { username: 50, fullName: 100, password: 200 } as const;

/**
 * Validate the form BEFORE any network call. Each rule mirrors the server's:
 * non-empty (trimmed) and at or under the same ceiling, so the UI can never
 * promise a value the API will refuse or accept one it would. The password
 * confirmation is the only client-only rule. Messages are fixed text and never
 * echo the typed values (a password must never be rendered back).
 */
export function validateProvisionAdminForm(values: ProvisionAdminFormValues): ProvisionAdminFieldErrors {
  const errors: ProvisionAdminFieldErrors = {};

  const fullName = typeof values.fullName === 'string' ? values.fullName.trim() : '';
  if (!fullName) errors.fullName = 'The new administrator\u2019s full name is required.';
  else if (fullName.length > PROVISION_ADMIN_LIMITS.fullName) errors.fullName = `The full name must be at most ${PROVISION_ADMIN_LIMITS.fullName} characters.`;

  const username = typeof values.username === 'string' ? values.username.trim() : '';
  if (!username) errors.username = 'A username is required.';
  else if (username.length > PROVISION_ADMIN_LIMITS.username) errors.username = `The username must be at most ${PROVISION_ADMIN_LIMITS.username} characters.`;

  const password = typeof values.password === 'string' ? values.password : '';
  if (!password) errors.password = 'A temporary initial password is required.';
  else if (password.length > PROVISION_ADMIN_LIMITS.password) errors.password = `The password must be at most ${PROVISION_ADMIN_LIMITS.password} characters.`;

  const confirmPassword = typeof values.confirmPassword === 'string' ? values.confirmPassword : '';
  if (!confirmPassword) errors.confirmPassword = 'Re-enter the temporary password to confirm it.';
  else if (password !== confirmPassword) errors.confirmPassword = 'The two passwords do not match.';

  return errors;
}

/**
 * Provision the second administrator. POST only; the password travels in the
 * request BODY (never the URL), authenticated with the console's existing
 * bearer token — this client mints no session and stores nothing.
 *
 * Resolves with the whitelisted DTO of the created account. Rejects with
 * ProvisionAdminApiError whose message is always a fixed, non-sensitive
 * sentence (see above); the submitted password can never appear in it.
 */
export async function provisionSecondAdmin(
  token: string | null,
  request: ProvisionAdminRequest,
): Promise<ProvisionedAdminDto> {
  if (typeof token !== 'string' || !token.trim()) {
    throw new ProvisionAdminApiError('unauthorized', 0, null, fixedMessageForKind('unauthorized'));
  }

  let response: Response;
  try {
    response = await fetch(ADMIN_PROVISION_ADMIN_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      // The body names ONLY the fields the route destructures. Anything else
      // (a stray confirmPassword, a token, a log line) is deliberately absent.
      body: JSON.stringify({
        username: request.username,
        fullName: request.fullName,
        password: request.password,
      }),
    });
  } catch {
    // The request never completed. Nothing about the request — password
    // included — is echoed into the error.
    throw new ProvisionAdminApiError('network', 0, null, fixedMessageForKind('network'));
  }

  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null; // a non-JSON error body is treated as carrying no message
    }
    throw provisionAdminFailureFromResponse(response.status, body);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ProvisionAdminApiError('malformed', response.status, null, fixedMessageForKind('malformed'));
  }
  return mapProvisionedAdmin(body);
}
