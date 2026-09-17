/**
 * ADMIN SESSION PRESENTATION HELPER
 * =================================
 * The console's header needs to say WHO is signed in. The only identity the
 * admin flow actually establishes is the `username` submitted on the login form
 * (see AdminView) — the audit layer records `req.user?.username || req.user?.userId`
 * (see server.ts), so that is exactly the claim this helper reads.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   - It does NOT verify the token. Verification is, and remains, entirely
 *     server-side (authenticateJWT + the explicit `role !== 'admin'` check on
 *     every /api/admin route). A decoded claim is display-only and must never
 *     be treated as an authorisation decision.
 *   - It never returns, logs, stores or renders the token or its signature.
 *     The function's return type contains no field that could carry them, and
 *     the only values it can produce are `username` / `userId` / `role` claims.
 *   - It never invents an identity. If the claim is absent (e.g. an older
 *     session, or a token minted without a username) it returns a null label
 *     and the UI falls back to the generic "Administrator" wording rather than
 *     fabricating a name, email or avatar.
 */

export interface AdminSessionIdentity {
  /** The admin username claim, or null when the session carries none. */
  username: string | null;
  /** The admin user-id claim, or null when the session carries none. */
  userId: string | null;
  /** The role claim, exposed for display only (e.g. 'admin'). */
  role: string | null;
}

const EMPTY_IDENTITY: AdminSessionIdentity = { username: null, userId: null, role: null };

/** Claims that may legitimately describe the signed-in administrator. */
const ALLOWED_IDENTITY_CLAIMS = ['username', 'userId', 'role'] as const;

function decodeBase64UrlSegment(segment: string): string | null {
  try {
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    // atob is available in the browser; Buffer covers the Node-side test run.
    const decoded = typeof atob === 'function'
      ? atob(padded)
      : Buffer.from(padded, 'base64').toString('binary');
    // The payload is JSON with UTF-8 content (names may be non-ASCII).
    const bytes = Uint8Array.from(decoded, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function asDisplayString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Defensive: a claim is rendered as text, so cap it and strip anything that
  // could be interpreted as markup. React escapes by default; this is belt and
  // braces for a value that originated from a login form.
  return trimmed.slice(0, 64).replace(/[<>&"']/g, '');
}

/**
 * Reads the display-only identity claims from an admin session token.
 * Returns nulls (never a fabricated identity) for a missing/invalid token.
 */
export function readAdminSessionIdentity(token: string | null | undefined): AdminSessionIdentity {
  if (typeof token !== 'string') return EMPTY_IDENTITY;
  const parts = token.split('.');
  if (parts.length !== 3) return EMPTY_IDENTITY;

  const json = decodeBase64UrlSegment(parts[1]);
  if (!json) return EMPTY_IDENTITY;

  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    return EMPTY_IDENTITY;
  }
  if (!payload || typeof payload !== 'object') return EMPTY_IDENTITY;

  const record = payload as Record<string, unknown>;
  return {
    username: asDisplayString(record.username),
    userId: asDisplayString(record.userId),
    role: asDisplayString(record.role),
  };
}

/**
 * The single label the console shows for the active administrator. Falls back
 * to the generic word "Administrator" (never a fabricated name) when the
 * session carries no username.
 */
export function adminIdentityLabel(identity: AdminSessionIdentity): string {
  return identity.username || identity.userId || 'Administrator';
}

// Kept exported so a future settings screen can render only sanctioned claim
// names without re-deriving the list (and without reaching for the raw token).
export const ADMIN_IDENTITY_CLAIM_NAMES: readonly string[] = ALLOWED_IDENTITY_CLAIMS;
