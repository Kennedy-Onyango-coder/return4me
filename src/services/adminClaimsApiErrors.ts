// Error taxonomy for the Claims Administration API client.
//
// Kept in its own module so the UI and the pure presentation layer can branch on
// an error WITHOUT importing the client (and so the client's fetch code has no
// reason to grow UI concerns).
//
// Every failure mode the UI must handle is pre-classified. `kind` is what the
// UI branches on; `message` is always safe to render — never a stack trace,
// never SQL, never a server path, never a database error.

export type AdminClaimsApiErrorKind =
  | 'unauthorized' // 401 — no/!valid session
  | 'forbidden' // 403 — authenticated but not authorized
  | 'not_found' // 404 — claim does not exist
  | 'invalid' // 400 — malformed request
  | 'server' // 5xx — genuine server failure
  | 'network' // request never completed
  | 'aborted'; // deliberately cancelled (superseded by a newer request)

export class AdminClaimsApiError extends Error {
  readonly kind: AdminClaimsApiErrorKind;
  /** HTTP status, or 0 when the request never completed. */
  readonly status: number;

  constructor(kind: AdminClaimsApiErrorKind, status: number, message: string) {
    super(message);
    this.name = 'AdminClaimsApiError';
    this.kind = kind;
    this.status = status;
  }

  /** True when the request was cancelled on purpose — callers must stay silent. */
  get isAbort(): boolean {
    return this.kind === 'aborted';
  }
}

export function errorKindForStatus(status: number): AdminClaimsApiErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server';
  return 'invalid';
}
