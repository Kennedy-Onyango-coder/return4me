// THE ONE SERVER-PORT RESOLVER (Phase 10, F-1)
// ============================================
// WHY THIS EXISTS
// server.ts used to hardcode `const PORT = 3000;` and ignore the environment
// entirely. That is a deployment-correctness defect, not a preference: managed
// container platforms (Cloud Run — which .env.example's own comments say this
// app targets) inject `PORT` and route traffic/health checks to the port they
// assigned. A server that ignores it binds to a port nothing is routed to, so
// the app can boot "successfully" while serving zero traffic. It also makes the
// app unhostable on any platform that assigns a dynamic port.
//
// This module is deliberately PURE (no process/DOM access) and takes the raw
// value as an argument, so every branch is unit-testable without booting the
// server — server.ts boots the whole application on import and cannot be
// imported by a test.
//
// STRICTNESS IS THE POINT
// The previous behaviour was "unconfigurable", so there was no permissive
// parsing to preserve. A permissive parseInt()/parseFloat() would accept
// '3000xyz' as 3000, '1.5' as 1 and ' 3000 ' as 3000 — each of which is a
// misconfiguration the operator should hear about, not something to silently
// reinterpret. Validation is therefore WHOLE-STRING: the value must be nothing
// but ASCII digits, and must land inside the valid TCP range.
//
// PORT = 0 IS REJECTED, DELIBERATELY
// Port 0 means "let the OS pick a free ephemeral port" to Node's listen().
// That is meaningful for tests but never for this server, which is reached at a
// known address; binding an ephemeral port would produce a running process that
// is unreachable where anyone expects it — exactly the class of silent
// misconfiguration this phase exists to remove. Since the port was previously
// a hardcoded constant, no deployment can depend on 0 today, so rejecting it
// invents no new interpretation. A rejected value falls back to the documented
// default (see below) and is REPORTED rather than silently swallowed.
//
// FALLBACK, NOT CRASH
// The brief requires an invalid PORT to fall back safely rather than crash the
// boot — a typo in PORT must never be the reason the service is down. So the
// resolver always answers with a usable port, and separately reports whether
// the environment value was used or rejected so the caller can log the truth.

/** The long-standing default, and the local-development port. */
export const DEFAULT_SERVER_PORT = 3000;

/** Valid TCP port range. 0 (ephemeral) is intentionally excluded — see above. */
export const MIN_TCP_PORT = 1;
export const MAX_TCP_PORT = 65535;

export interface ServerPortResolution {
  /** The port the server must listen on. Always a valid TCP port. */
  port: number;
  /** Where `port` came from: the environment, or the fallback. */
  source: 'env' | 'default';
  /**
   * The trimmed raw value that was present but rejected, or null when the
   * environment value was absent or accepted. Used only for truthful logging —
   * never to influence the chosen port.
   */
  rejectedRawValue: string | null;
}

/**
 * Strict whole-string TCP port parse.
 *
 * Accepts ONLY a string of ASCII digits (no sign, no decimal point, no
 * exponent, no surrounding whitespace, no trailing characters) resolving to an
 * integer inside [1, 65535]. Returns null for everything else, including
 * non-strings — it never coerces, never parses a prefix, and never returns NaN.
 */
export function parseServerPort(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  // Whole-string digits only. This single test rejects '', ' ', 'abc', '-1',
  // '+3000', '1.5', '1e3', '3000xyz', '3 000' and ' 3000 '/'3000 ' alike.
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return null;
  if (value < MIN_TCP_PORT || value > MAX_TCP_PORT) return null;
  return value;
}

/**
 * Resolve the port to listen on from a raw environment value.
 *
 * - absent (undefined/null/empty) -> default
 * - valid                         -> that port, source 'env'
 * - anything else                 -> default, with `rejectedRawValue` set so
 *                                    the caller can log that PORT was ignored
 */
export function resolveServerPort(rawPort: unknown): ServerPortResolution {
  // A completely absent value is the normal local-development case: no warning.
  if (rawPort === undefined || rawPort === null || rawPort === '') {
    return { port: DEFAULT_SERVER_PORT, source: 'default', rejectedRawValue: null };
  }

  const parsed = parseServerPort(rawPort);
  if (parsed !== null) {
    return { port: parsed, source: 'env', rejectedRawValue: null };
  }

  return {
    port: DEFAULT_SERVER_PORT,
    source: 'default',
    rejectedRawValue: typeof rawPort === 'string' ? rawPort.trim() : String(rawPort),
  };
}
