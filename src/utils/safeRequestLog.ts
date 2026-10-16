/**
 * SAFE HTTP REQUEST-LOG REDACTION (Batch S1)
 * ==========================================
 *
 * WHY THIS EXISTS (the reproduced defect it replaces)
 * --------------------------------------------------
 * The [HTTP] request logger in server.ts logged `req.url` verbatim:
 *
 *     const safeUrl = req.url.replace(/ErrorBoundary/gi, 'ErrBoundary');
 *     console.log(`[HTTP] ${req.method} ${safeUrl}`);
 *
 * That middleware is registered BEFORE every /api route and before the static
 * and SPA handlers, so it sees EVERY request. Activation emails carry a
 * one-time credential in the query string:
 *
 *     https://return4me.co.ke/activate-email?token=<32 random bytes>
 *     https://return4me.co.ke/activate-agent-email?token=<32 random bytes>
 *
 * The activation page is reached by an ordinary GET of that URL, so CLICKING
 * THE LINK IN THE EMAIL wrote a live, single-use credential into the
 * application log and into whatever store or forwarder consumes stdout. A log
 * line is not a private place: it is copied into aggregators, attached to bug
 * reports and retained far longer than the 24h token lifetime. The same applies
 * to the agent token, which uses the identical link shape.
 *
 * WHAT THIS DOES
 * --------------
 * `redactRequestUrlForLog()` returns a string that is safe to write to a log:
 *
 *   * the VALUE of every credential-looking query parameter is replaced with
 *     `[REDACTED]` (duplicates included, one replacement per occurrence);
 *   * a sensitive parameter with NO value (`?token`) is left as it is, because
 *     a bare name discloses nothing;
 *   * every other parameter, and the whole path, are preserved verbatim so
 *     ordinary operational diagnostics are not lost;
 *   * query VALUES are never percent-decoded, so `%0d%0a` cannot become a real
 *     CRLF in the log (log injection); literal control characters are removed
 *     before anything else runs;
 *   * the result is capped at MAX_LOGGED_URL_LENGTH characters with an explicit
 *     truncation marker, so one crafted URL cannot flood or forge a log line;
 *   * it NEVER throws: unexpected, missing, null, non-string or malformed input
 *     produces a safe fixed string instead.
 *
 * MATCHING RULES (name-based, deliberately broad)
 * ----------------------------------------------
 * A name is sensitive when its NORMALISED form is in
 * SENSITIVE_QUERY_PARAM_NAMES, or when it ENDS WITH one of the documented
 * suffixes. Normalisation is for matching only and never reaches the output:
 * percent-decode the NAME only (safely - malformed escapes fall back to the raw
 * text), lowercase it, drop array brackets (`token[]`, `token[0]`), then drop
 * every remaining non-alphanumeric character (`api_key`, `api-key`, `X-Api-Key`
 * all normalise to `xapikey`).
 *
 * The suffix rule is intentionally FAIL-CLOSED, and it does produce false
 * positives: `zipcode`, `postcode` and `areacode` are redacted because they end
 * in `code`, and `monkey` because it ends in `key`. Losing the value of a
 * harmless parameter costs a little diagnostics; missing a credential costs the
 * credential. It is also intentionally one-directional: a credential hidden in
 * the value of a harmlessly-named parameter (`?q=token%3Dabc`) is NOT detected.
 * What IS covered is the case where a whole second query is smuggled inside a
 * value (`/?a=1?token=x`): a second `?` or a `#` makes the remaining text
 * unparsable, so it is redacted wholesale rather than guessed at.
 *
 * LIMITS (what this cannot do)
 * ----------------------------
 *   * It only protects what THIS APPLICATION writes. A reverse proxy, CDN or
 *     load balancer that logs the request line outside this process is out of
 *     scope and needs its own rule.
 *   * It does not change what the activation page receives: the credential
 *     still reaches the page (that is how activation works).
 *   * It is name-based, so a NEW credential parameter must be added to the
 *     lists below to be covered by name - the suffix rule only catches the
 *     shapes it already knows.
 *
 * Deliberately pure and dependency-free so it is unit-testable in this
 * repository's node-only vitest environment (no jsdom), like
 * utils/safeStaticPath.ts and utils/publicRoutes.ts.
 */

/** What replaces the value of a sensitive query parameter. */
export const REDACTED_VALUE = '[REDACTED]';

/** Appended when the output is capped, so a truncation is never mistaken for the whole URL. */
export const TRUNCATION_MARKER = '...[truncated]';

/** Hard ceiling on a logged URL. Long enough for every real path + query, short enough to bound a log line. */
export const MAX_LOGGED_URL_LENGTH = 512;

/** Returned for input that cannot be read as a URL at all. Never echoes the input. */
const UNLOGGABLE_URL = '[unloggable request URL]';

/**
 * Credential parameter names, in NORMALISED (compact, lowercase, alphanumeric)
 * form. Exported so a reviewer can see exactly which names are treated as
 * credentials, and so a future credential parameter has one obvious place to be
 * added.
 */
export const SENSITIVE_QUERY_PARAM_NAMES: ReadonlyArray<string> = [
  // Activation / verification link tokens.
  'token', 'tokens', 'tokenid', 'tokenvalue', 'accesstoken', 'refreshtoken',
  'idtoken', 'sessiontoken', 'authtoken', 'resettoken', 'activationtoken',
  'claimtoken', 'invitetoken', 'bearertoken',
  // API keys and secrets.
  'apikey', 'apikeys', 'secret', 'secrets', 'secretkey', 'clientsecret',
  'privatekey',
  // One-time and verification codes.
  'otp', 'otpcode', 'code', 'codes', 'pin', 'pincode', 'passcode', 'passcodes',
  'authcode', 'securitycode', 'verificationcode', 'recoverycode', 'claimcode',
  'activationcode', 'invitecode', 'handovercode', 'dropoffcode', 'pickupcode',
  'mfa', 'mfacode', 'totp', 'twofactor', 'twofactorcode',
  // Passwords.
  'password', 'passwords', 'passwd', 'pwd', 'pass', 'passphrase', 'phrase',
  // Session / cookie / authorization material.
  'session', 'sessions', 'sessionid', 'sid', 'cookie', 'cookies', 'auth',
  'authorization', 'authorisation', 'bearer', 'jwt', 'credential', 'credentials',
  // Signatures, challenges, nonces and hashes.
  'signature', 'signatures', 'sig', 'signed', 'nonce', 'challenge', 'csrf',
  'csrftoken', 'xsrf', 'xsrftoken', 'hash', 'hashcode', 'key', 'keys', 'keyid',
  // Claim-related credential parameters. `claim` itself is included because the
  // legacy published link is `/?claim=<itemId>` (utils/publicRoutes.ts) and it
  // is the one value that turns into a redirect; the item id is public, so this
  // is fail-closed rather than strictly necessary.
  'claim', 'claimid', 'claimref', 'claims',
  // Bare process words that only ever name a credential.
  'verification', 'verify', 'reset', 'activation', 'invite', 'recovery',
];

/**
 * Suffixes that make a name sensitive even when it is not in the list above.
 * See the "deliberately broad" note in the file header: this is FAIL-CLOSED and
 * its false positives are accepted on purpose.
 */
const SENSITIVE_NAME_SUFFIXES: ReadonlyArray<string> = [
  'token', 'tokens', 'secret', 'secrets', 'password', 'passwd', 'pwd',
  'passcode', 'pin', 'otp', 'apikey', 'key', 'keys', 'signature', 'sig',
  'code', 'codes', 'hash', 'nonce', 'challenge', 'csrf', 'xsrf', 'session',
  'sessionid', 'sid', 'cookie', 'cookies', 'jwt', 'bearer', 'credential',
  'credentials', 'auth', 'phrase', 'recovery', 'verification',
];

const EXACT_SENSITIVE_NAME_SET: ReadonlySet<string> = new Set(SENSITIVE_QUERY_PARAM_NAMES);

/**
 * Remove C0/C1 control characters, including CR and LF.
 *
 * Done FIRST, before parsing, because a caller-supplied newline is the classic
 * way to forge an extra log line ("[HTTP] GET /x\n[HTTP] GET /admin/..."). This
 * is independent of percent-encoding: `%0d%0a` stays encoded because values are
 * never decoded.
 */
function stripControlCharacters(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '');
}

/**
 * Coerce the input to a string, or null when it cannot honestly be one.
 *
 * Objects, arrays, functions and symbols return null rather than being
 * stringified: `String(value)` on a hostile object can invoke its own
 * `toString`/`toJSON`, and a request URL is never an object.
 */
function toLoggableString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return null;
}

/**
 * Normalise a parameter NAME for matching only (never for output).
 *
 * `token[0]` -> `token`, `%74oken` -> `token`, `X-Api-Key` -> `xapikey`. A
 * malformed percent-escape (`%zz`, a trailing `%`) is not an error here: the
 * raw text is matched instead, so a broken name can still be recognised as a
 * credential rather than silently passed through.
 */
function normaliseParamNameForMatching(rawName: string): string {
  let decoded = rawName;
  if (rawName.includes('%') || rawName.includes('+')) {
    try {
      // '+' is a space in form encoding; decoding it keeps both encodings equal.
      decoded = decodeURIComponent(rawName.replace(/\+/g, ' '));
    } catch {
      decoded = rawName;
    }
  }
  return decoded
    // Array-style names: token[], token[0], token[field] all name `token`.
    .replace(/\[[^\]]*\]/g, '')
    .toLowerCase()
    // api_key / api-key / x-api-key / api.key all collapse to `xapikey`.
    .replace(/[^a-z0-9]/g, '');
}

/** Whether a query parameter NAME names a credential. Exported for direct testing. */
export function isSensitiveQueryParamName(rawName: string): boolean {
  if (typeof rawName !== 'string') return false;
  const compact = normaliseParamNameForMatching(rawName);
  if (compact === '') return false;
  if (EXACT_SENSITIVE_NAME_SET.has(compact)) return true;
  for (const suffix of SENSITIVE_NAME_SUFFIXES) {
    // Strictly longer: a name that IS the bare suffix (`token`, `code`) is
    // covered by the exact set above, so this cannot double-count.
    if (compact.length > suffix.length && compact.endsWith(suffix)) return true;
  }
  return false;
}

/**
 * Redact one `name=value` segment.
 *
 * A segment with no `=` (`?token`) or an empty value (`?token=`) is returned
 * unchanged: there is no value to disclose. Otherwise the NAME decides, and the
 * value is replaced without ever being read, decoded or logged.
 */
function redactQuerySegment(segment: string): string {
  const equalsAt = segment.indexOf('=');
  if (equalsAt === -1) return segment;
  const name = segment.slice(0, equalsAt);
  const value = segment.slice(equalsAt + 1);
  if (value === '') return segment;
  return isSensitiveQueryParamName(name) ? `${name}=${REDACTED_VALUE}` : segment;
}

/** Redact every sensitive segment of a query string, preserving order and shape. */
function redactQueryString(query: string): string {
  return query.split('&').map(redactQuerySegment).join('&');
}

/** Bound the output, marking the cut explicitly so a truncation cannot be missed. */
function capLength(value: string): string {
  if (value.length <= MAX_LOGGED_URL_LENGTH) return value;
  return value.slice(0, MAX_LOGGED_URL_LENGTH - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/**
 * The one function the [HTTP] logger calls.
 *
 * Total by construction: every branch returns a string, and the whole body is
 * guarded so no input can turn a log line into an exception inside a request
 * middleware. The fallback is a fixed string, never the input.
 */
export function redactRequestUrlForLog(rawUrl: unknown): string {
  try {
    const raw = toLoggableString(rawUrl);
    if (raw === null) return UNLOGGABLE_URL;

    const cleaned = stripControlCharacters(raw);

    // A fragment is not sent by a browser, but a raw request CAN contain one,
    // and it is a place a credential could sit unparsed. It is never useful in a
    // request log, so it is redacted wholesale.
    let rest = cleaned;
    let fragment = '';
    const hashAt = rest.indexOf('#');
    if (hashAt !== -1) {
      fragment = `#${REDACTED_VALUE}`;
      rest = rest.slice(0, hashAt);
    }

    const queryAt = rest.indexOf('?');
    if (queryAt === -1) return capLength(rest + fragment);

    const pathPart = rest.slice(0, queryAt);
    const query = rest.slice(queryAt + 1);

    // A second '?' means the "query" is not a query this app ever produces, and
    // a whole second parameter list may be hiding inside a single value. Rather
    // than guess, the remainder is redacted as one opaque blob.
    if (query.includes('?')) {
      return capLength(`${pathPart}?${REDACTED_VALUE}${fragment}`);
    }

    return capLength(`${pathPart}?${redactQueryString(query)}${fragment}`);
  } catch {
    return UNLOGGABLE_URL;
  }
}
