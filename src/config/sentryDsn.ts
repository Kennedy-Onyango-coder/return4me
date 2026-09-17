// SENTRY DSN ACCEPTABILITY — ONE POLICY, TWO PROCESSES (Phase 10, F-5)
// ===================================================================
// THE DEFECT THIS CLOSES
// Both Sentry bootstrap paths (server.ts for Node, main.tsx for the browser)
// decided whether to initialise with a check that only rejected an empty value
// and the literal substring 'REPLACE_WITH':
//
//     const enabled = dsn && !dsn.includes('REPLACE_WITH') && dsn.trim() !== '';
//
// and then printed "[SENTRY] ... initialized successfully" immediately after
// Sentry.init() returned without throwing. Sentry.init() does NOT throw on an
// unusable DSN — it prints its own warning ("Invalid Sentry Dsn: ...") and
// carries on — so the application announced error tracking as live when no
// event could ever be delivered. Operationally that is worse than having no
// error tracking at all, because a monitored-looking system stops being
// watched.
//
// WHAT WAS EMPIRICALLY ESTABLISHED BEFORE WRITING THIS
// Verified directly against the installed SDK (@sentry/node 10.66.0):
//   * Sentry.init({ dsn: 'placeholder' }) does not throw.
//   * Sentry.getClient() is NOT null afterwards — the SDK still builds a client
//     around the rejected DSN — so getClient() is not a usable validity signal.
//   * client.getOptions().enabled is undefined for that case.
//   * the SDK's own DSN parser (dsnFromString) is NOT exported from
//     @sentry/node, so it cannot be reused here.
// Therefore no synchronous, network-free "did the provider accept this DSN?"
// answer is available from the SDK, and none is invented below.
//
// WHAT THIS MODULE CAN AND CANNOT PROVE
// It answers exactly one question: "is this value acceptable according to the
// application's own configuration policy?" — i.e. is it present, not one of
// this repository's documented placeholder conventions, and structurally a
// Sentry DSN (scheme, public key, host, project path). That is enough to catch
// every configuration mistake actually observed (.env.example's
// REPLACE_WITH_* template and the bare word 'placeholder').
//
// It CANNOT prove the provider will accept the DSN — a revoked key or a
// deleted project needs network I/O to detect, which this project deliberately
// does not perform at boot. Callers must therefore word their logs as
// configuration/initialisation statements ("initialised with a configured
// DSN"), never as a claim of external acceptance or delivery. See server.ts.
//
// This module is pure and isomorphic (no node built-ins, no DOM) because it is
// imported by BOTH the Node server and the browser bundle, so the policy has
// exactly one implementation instead of two drifting copies.

/** Why a Sentry DSN cannot be used. */
export type SentryDsnProblem = 'missing' | 'placeholder' | 'malformed';

// Placeholder conventions already used across this repository:
//   .env.example            SENTRY_DSN_BACKEND="REPLACE_WITH_SENTRY_DSN_BACKEND"
//   server.ts / main.tsx    !== 'MY_GEMINI_API_KEY' style "MY_*" templates
//   this codebase           the literal word "placeholder" used by local .env
// Matched case-insensitively so any casing of the template is still caught.
const PLACEHOLDER_MARKERS = ['REPLACE_WITH', 'PLACEHOLDER', 'MY_'];

// Sentry DSN shape: scheme://<publicKey>@<host>[:port]/<projectId>
// An optional secret key (`key:secret@`) is permitted. A non-numeric project
// id is accepted on purpose — newer Sentry deployments allow slug-style project
// identifiers, and this guard exists to reject non-DSNs like 'placeholder',
// not to be stricter than the provider about a real DSN's project id.
const SENTRY_DSN_PATTERN = /^https?:\/\/[^@/\s]+@[A-Za-z0-9.-]+(:\d{1,5})?\/[A-Za-z0-9_-]+\/?$/;

/**
 * Classify a DSN value. Returns null when the value is acceptable under the
 * application's own configuration policy.
 */
export function sentryDsnProblem(dsn: unknown): SentryDsnProblem | null {
  if (typeof dsn !== 'string') return 'missing';

  const trimmed = dsn.trim();
  if (trimmed === '') return 'missing';

  const upper = trimmed.toUpperCase();
  if (PLACEHOLDER_MARKERS.some((marker) => upper.includes(marker))) {
    return 'placeholder';
  }

  if (!SENTRY_DSN_PATTERN.test(trimmed)) return 'malformed';

  return null;
}

/**
 * Whether this DSN is acceptable and therefore worth initialising Sentry with.
 * True means "configured correctly enough to initialise" — NOT "the provider
 * has accepted it", which only a network call could establish.
 */
export function isSentryDsnUsable(dsn: unknown): boolean {
  return sentryDsnProblem(dsn) === null;
}

/** Human-readable reason for a rejected DSN, for truthful boot logging. */
export function sentryDsnProblemLabel(problem: SentryDsnProblem): string {
  switch (problem) {
    case 'missing':
      return 'not configured (missing or empty)';
    case 'placeholder':
      return 'still a placeholder value';
    case 'malformed':
      return 'not a valid Sentry DSN (expected https://<key>@<host>/<projectId>)';
  }
}
