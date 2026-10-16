import { describe, it, expect } from 'vitest';
import {
  redactRequestUrlForLog,
  isSensitiveQueryParamName,
  SENSITIVE_QUERY_PARAM_NAMES,
  MAX_LOGGED_URL_LENGTH,
  TRUNCATION_MARKER,
} from '../safeRequestLog';

// =============================================================================
// BATCH S1 - THE [HTTP] REQUEST-LOG REDACTOR.
//
// The defect: the request logger in server.ts wrote `req.url` straight to the
// console, so CLICKING AN ACTIVATION LINK IN AN EMAIL (an ordinary GET of
// /activate-email?token=<32 random bytes>) put a live, single-use credential
// into the application log. These are pure-function tests of the helper that
// replaces that, plus an explicit "the old behaviour really did leak" block so
// the regression cannot come back disguised as a refactor.
//
// Every value below is a SYNTHETIC fixture, not a credential from any system.
// =============================================================================

const CUSTOMER_TOKEN = 'r4m-customer-token-3f9c1d7a2b';
const AGENT_TOKEN = 'r4m-agent-token-8e4b6f0c5d';
const OTP = '482913';
const SECRET = 'r4m-synthetic-secret-value';

/** The pre-fix logger line, verbatim: this is what the defect actually logged. */
function preFixLoggerUrl(rawUrl: string): string {
  return rawUrl.replace(/ErrorBoundary/gi, 'ErrBoundary');
}

describe('redactRequestUrlForLog: the activation links that leaked', () => {
  it('redacts a CUSTOMER activation token and keeps the path for diagnostics', () => {
    expect(redactRequestUrlForLog(`/activate-email?token=${CUSTOMER_TOKEN}`)).toBe(
      '/activate-email?token=[REDACTED]',
    );
  });

  it('redacts an AGENT activation token', () => {
    expect(redactRequestUrlForLog(`/activate-agent-email?token=${AGENT_TOKEN}`)).toBe(
      '/activate-agent-email?token=[REDACTED]',
    );
  });

  it('redacts the credential in an ABSOLUTE url too (the shape in the email)', () => {
    const url = `https://return4me.co.ke/activate-email?token=${CUSTOMER_TOKEN}`;
    const out = redactRequestUrlForLog(url);
    expect(out).not.toContain(CUSTOMER_TOKEN);
    expect(out).toBe('https://return4me.co.ke/activate-email?token=[REDACTED]');
  });

  it('redacts a DUPLICATE sensitive parameter at every occurrence', () => {
    expect(redactRequestUrlForLog(`/x?token=${CUSTOMER_TOKEN}&token=${AGENT_TOKEN}`)).toBe(
      '/x?token=[REDACTED]&token=[REDACTED]',
    );
  });

  it('redacts several different credentials in one URL, in place', () => {
    const out = redactRequestUrlForLog(`/x?token=${CUSTOMER_TOKEN}&otp=${OTP}&password=${SECRET}`);
    expect(out).toBe('/x?token=[REDACTED]&otp=[REDACTED]&password=[REDACTED]');
    for (const secret of [CUSTOMER_TOKEN, OTP, SECRET]) expect(out).not.toContain(secret);
  });

  it('preserves harmless diagnostic parameters around a redacted one', () => {
    expect(redactRequestUrlForLog(`/lost?track=1&token=${CUSTOMER_TOKEN}&utm_source=newsletter`)).toBe(
      '/lost?track=1&token=[REDACTED]&utm_source=newsletter',
    );
  });
});

describe('redactRequestUrlForLog: name normalisation is for MATCHING only', () => {
  it('matches case-insensitively and keeps the name as it was sent', () => {
    expect(redactRequestUrlForLog(`/x?TOKEN=${CUSTOMER_TOKEN}`)).toBe('/x?TOKEN=[REDACTED]');
    expect(redactRequestUrlForLog(`/x?ToKeN=${CUSTOMER_TOKEN}`)).toBe('/x?ToKeN=[REDACTED]');
    expect(redactRequestUrlForLog(`/x?OTP=${OTP}`)).toBe('/x?OTP=[REDACTED]');
  });

  it('matches a percent-encoded NAME (the name is decoded, the value is not)', () => {
    // %74 = 't' in 'token'. The OUTPUT still shows the name exactly as received.
    expect(redactRequestUrlForLog(`/x?%74oken=${CUSTOMER_TOKEN}`)).toBe('/x?%74oken=[REDACTED]');
    expect(redactRequestUrlForLog(`/x?TOKEN%5B0%5D=${CUSTOMER_TOKEN}`)).toBe('/x?TOKEN%5B0%5D=[REDACTED]');
  });

  it('matches ARRAY-STYLE names (token[], token[0], token[field])', () => {
    for (const name of ['token[]', 'token[0]', 'token[field]', 'token[]']) {
      expect(redactRequestUrlForLog(`/x?${name}=${CUSTOMER_TOKEN}`), name).toBe(`/x?${name}=[REDACTED]`);
    }
  });

  it('matches separator variants of the same name (api_key / api-key / X-Api-Key)', () => {
    for (const name of ['api_key', 'api-key', 'X-Api-Key', 'api.key', 'session_id']) {
      expect(redactRequestUrlForLog(`/x?${name}=${SECRET}`), name).toBe(`/x?${name}=[REDACTED]`);
    }
  });

  it('covers the documented credential CLASSES', () => {
    // One name per class the batch is required to protect. Kept as a table so a
    // name that stops being recognised fails with its own name in the message.
    const cases: Array<[string, string]> = [
      ['token', CUSTOMER_TOKEN],
      ['secret', SECRET],
      ['password', SECRET],
      ['pass', SECRET],
      ['pwd', SECRET],
      ['otp', OTP],
      ['code', OTP],
      ['pin', '1234'],
      ['session', SECRET],
      ['sessionid', SECRET],
      ['sid', SECRET],
      ['cookie', SECRET],
      ['authorization', 'Bearer ' + SECRET],
      ['bearer', SECRET],
      ['signature', SECRET],
      ['sig', SECRET],
      ['key', SECRET],
      ['apikey', SECRET],
      ['nonce', SECRET],
      ['challenge', SECRET],
      ['claim', 'R4M-123ABC'],
      ['claim_token', SECRET],
      ['claimToken', SECRET],
      ['reset_token', SECRET],
      ['verification_code', OTP],
      ['verificationCode', OTP],
      ['pickup_code', '4321'],
      ['hash', SECRET],
      ['jwt', SECRET],
      ['credential', SECRET],
      ['csrf_token', SECRET],
    ];
    for (const [name, value] of cases) {
      const out = redactRequestUrlForLog(`/x?${name}=${encodeURIComponent(value)}`);
      expect(out, name).toBe(`/x?${name}=[REDACTED]`);
      expect(out, name).not.toContain(encodeURIComponent(value));
    }
  });

  it('leaves ordinary operational parameters completely untouched', () => {
    const benign = '/api/claims?status=escrow_held&county=nairobi&category=phone&page=2'
      + '&limit=50&sort=created&order=desc&from=2026-01-01&to=2026-02-01&q=blue+bag'
      + '&utm_source=newsletter&utm_medium=email&utm_campaign=launch&track=1&next=%2Fitem%2FR4M-123ABC'
      + '&itemid=R4M-123ABC&ref=home&lang=en&error=not_found';
    expect(redactRequestUrlForLog(benign)).toBe(benign);
  });

  it('does not treat a bare or empty sensitive parameter as a leak', () => {
    // Nothing is disclosed by a NAME with no value, so nothing is rewritten.
    expect(redactRequestUrlForLog('/x?token')).toBe('/x?token');
    expect(redactRequestUrlForLog('/x?token=')).toBe('/x?token=');
    expect(redactRequestUrlForLog('/x?token=&page=1')).toBe('/x?token=&page=1');
  });
});

describe('redactRequestUrlForLog: no decoding, no log injection', () => {
  it('never decodes a query VALUE', () => {
    expect(redactRequestUrlForLog('/x?utm_source=a%20b')).toBe('/x?utm_source=a%20b');
    expect(redactRequestUrlForLog('/x?q=blue%2Bbag')).toBe('/x?q=blue%2Bbag');
    // The credential is REPLACED, never decoded and rewritten.
    expect(redactRequestUrlForLog(`/x?token=${encodeURIComponent(CUSTOMER_TOKEN)}`)).toBe(
      '/x?token=[REDACTED]',
    );
  });

  it('a percent-encoded CRLF stays encoded, so it cannot forge a log line', () => {
    const out = redactRequestUrlForLog('/x?q=%0d%0a[HTTP] GET /api/admin/dashboard');
    expect(out).toBe('/x?q=%0d%0a[HTTP] GET /api/admin/dashboard');
    expect(out).not.toContain('\n');
    expect(out).not.toContain('\r');
  });

  it('literal control characters are stripped before anything else runs', () => {
    const out = redactRequestUrlForLog('/x?a=1\r\n[HTTP] GET /api/admin/dashboard');
    expect(out).not.toContain('\n');
    expect(out).not.toContain('\r');
    expect(out).toBe('/x?a=1[HTTP] GET /api/admin/dashboard');
  });

  it('redacts the remainder when a whole second query hides inside a value', () => {
    const out = redactRequestUrlForLog(`/x?a=1?token=${CUSTOMER_TOKEN}`);
    expect(out).toBe('/x?[REDACTED]');
    expect(out).not.toContain(CUSTOMER_TOKEN);
  });

  it('redacts a fragment wholesale (it is never useful in a request log)', () => {
    expect(redactRequestUrlForLog(`/x?a=1#token=${CUSTOMER_TOKEN}`)).toBe('/x?a=1#[REDACTED]');
  });
});

describe('redactRequestUrlForLog: malformed and unexpected input never throws', () => {
  it('a malformed percent-escape in a NAME does not crash or leak', () => {
    expect(redactRequestUrlForLog(`/x?%zz=1&token=${CUSTOMER_TOKEN}`)).toBe('/x?%zz=1&token=[REDACTED]');
    expect(redactRequestUrlForLog('/x?%E0%A4%A=1')).toBe('/x?%E0%A4%A=1');
    expect(redactRequestUrlForLog('/x?token%=' + CUSTOMER_TOKEN)).toBe('/x?token%=[REDACTED]');
  });

  it('returns a fixed, non-echoing string when the input is not a URL at all', () => {
    for (const bad of [null, undefined, {}, [], () => {}, Symbol('token')]) {
      const out = redactRequestUrlForLog(bad as unknown);
      expect(typeof out).toBe('string');
      expect(out).toBe('[unloggable request URL]');
    }
  });

  it('coerces primitives that can honestly be text', () => {
    expect(redactRequestUrlForLog(42)).toBe('42');
    expect(redactRequestUrlForLog(true)).toBe('true');
    expect(redactRequestUrlForLog('')).toBe('');
    expect(redactRequestUrlForLog('/lost')).toBe('/lost');
    expect(redactRequestUrlForLog('/item/R4M-123ABC')).toBe('/item/R4M-123ABC');
  });
});

describe('redactRequestUrlForLog: the 512-character bound', () => {
  it('caps a long URL and marks the cut unambiguously', () => {
    const out = redactRequestUrlForLog('/api/items/search?q=' + 'a'.repeat(900));
    expect(out.length).toBe(MAX_LOGGED_URL_LENGTH);
    expect(out.length).toBe(512);
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it('a long hostile URL cannot push a credential past the cap', () => {
    const out = redactRequestUrlForLog('/x?pad=' + 'b'.repeat(600) + `&token=${CUSTOMER_TOKEN}`);
    expect(out.length).toBe(MAX_LOGGED_URL_LENGTH);
    expect(out).not.toContain(CUSTOMER_TOKEN);
  });

  it('a short URL is never touched by the cap', () => {
    expect(redactRequestUrlForLog('/lost?track=1')).toBe('/lost?track=1');
  });
});

describe('the exported inventory stays usable', () => {
  it('every documented name is already in NORMALISED form', () => {
    for (const name of SENSITIVE_QUERY_PARAM_NAMES) {
      expect(name, name).toBe(name.toLowerCase().replace(/[^a-z0-9]/g, ''));
      expect(isSensitiveQueryParamName(name), name).toBe(true);
    }
    expect(SENSITIVE_QUERY_PARAM_NAMES).toContain('token');
    expect(SENSITIVE_QUERY_PARAM_NAMES).toContain('claim');
    expect(SENSITIVE_QUERY_PARAM_NAMES).toContain('otp');
    expect(SENSITIVE_QUERY_PARAM_NAMES.length).toBeGreaterThan(50);
  });

  it('isSensitiveQueryParamName refuses non-strings and empty names', () => {
    expect(isSensitiveQueryParamName(undefined as unknown as string)).toBe(false);
    expect(isSensitiveQueryParamName('')).toBe(false);
    expect(isSensitiveQueryParamName('[]')).toBe(false);
    expect(isSensitiveQueryParamName('status')).toBe(false);
    expect(isSensitiveQueryParamName('access_token')).toBe(true);
  });
});

describe('the defect was REAL: what the previous logger line did', () => {
  it('the pre-fix line contained the live customer token; the redactor does not', () => {
    const requestUrl = `/activate-email?token=${CUSTOMER_TOKEN}`;
    // Exactly what server.ts logged before this batch (only ErrorBoundary was
    // replaced), so this assertion cannot silently stop describing the defect.
    expect(preFixLoggerUrl(requestUrl)).toContain(CUSTOMER_TOKEN);
    expect(redactRequestUrlForLog(requestUrl)).not.toContain(CUSTOMER_TOKEN);
  });

  it('the pre-fix line leaked the agent token too', () => {
    const requestUrl = `/activate-agent-email?token=${AGENT_TOKEN}`;
    expect(preFixLoggerUrl(requestUrl)).toContain(AGENT_TOKEN);
    expect(redactRequestUrlForLog(requestUrl)).not.toContain(AGENT_TOKEN);
  });

  it('the credential cannot be recovered from the redacted form', () => {
    const out = redactRequestUrlForLog(`/activate-email?token=${CUSTOMER_TOKEN}`);
    expect(out).not.toContain(encodeURIComponent(CUSTOMER_TOKEN));
    expect(out).not.toContain(CUSTOMER_TOKEN.slice(0, 8));
    expect(out).toContain('[REDACTED]');
  });
});
