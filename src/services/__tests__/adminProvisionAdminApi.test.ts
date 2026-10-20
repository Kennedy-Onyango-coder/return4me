// ADMIN PROVISIONING API CLIENT — CONTRACT + SAFETY TESTS (frontend only)
// ========================================================================
// The react-free client behind the Administrator Management panel
// (services/adminProvisionAdminApi.ts). Everything here runs against a
// MOCKED fetch — no request ever leaves this process, no admin account is
// ever created, and nothing here touches the real backend.
//
// What these tests pin:
//   * the EXACT wire contract read from src/server.ts (6af77c2): path, POST,
//     Bearer header, and the camelCase `fullName` body field — so the UI can
//     never drift from the endpoint or invent one;
//   * the one-time closure codes (provisioning_closed / no_bootstrap_admin)
//     are distinguished from the retryable username conflict, because those
//     two need opposite UI;
//   * NO error path can carry the submitted password or a raw server body —
//     fixed, codebase-written sentences only;
//   * the success read is a four-field whitelist, so credential columns can
//     never reach the console even if a server included them;
//   * client-side validation mirrors the server's limits exactly (never
//     stricter, never looser) and never echoes a typed password.
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  ADMIN_PROVISION_ADMIN_PATH,
  PROVISION_ADMIN_LIMITS,
  ProvisionAdminApiError,
  mapProvisionAdminFailure,
  mapProvisionedAdmin,
  provisionAdminFailureFromResponse,
  provisionSecondAdmin,
  sanitizeProvisionAdminServerMessage,
  validateProvisionAdminForm,
} from '../adminProvisionAdminApi';

/** Minimal mocked Response: only what the client reads. No real network. */
function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

interface CapturedCall { url: string; init: RequestInit | undefined; }

/** Stub global fetch with a handler that records every call. */
function stubFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: CapturedCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init: RequestInit | undefined) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }));
  return calls;
}

const TOKEN = 'header.payload.signature';
const REQUEST = { fullName: 'Asha Mwangi', username: 'asha.admin', password: 'Temp-Passw0rd!xyz' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the client speaks the backend contract exactly (POST /api/admin/provision-admin)', () => {
  it('targets the documented path — built in the client, never in a component', () => {
    expect(ADMIN_PROVISION_ADMIN_PATH).toBe('/api/admin/provision-admin');
  });

  it('sends POST with the console token and the EXACT body fields the route reads', async () => {
    const calls = stubFetch(() => jsonResponse(200, { ok: true, admin: { id: 'ADM-1', username: 'asha.admin', full_name: 'Asha Mwangi', created_at: '2026-01-01T00:00:00.000Z' } }));
    await provisionSecondAdmin(TOKEN, REQUEST);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/admin/provision-admin');
    const init = calls[0].init!;
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Authorization']).toBe(`Bearer ${TOKEN}`);

    // The wire names are the ROUTE'S own: username, camelCase fullName,
    // password — nothing else (no confirmPassword, no token, no extras).
    const body = JSON.parse(String(init.body));
    expect(Object.keys(body).sort()).toEqual(['fullName', 'password', 'username']);
    expect(body).toEqual({ fullName: REQUEST.fullName, username: REQUEST.username, password: REQUEST.password });
    // And the password never travels in the URL.
    expect(calls[0].url).not.toContain('?');
    expect(calls[0].url).not.toContain(REQUEST.password);
  });

  it('refuses to send anything when the console token is absent', async () => {
    const calls = stubFetch(() => jsonResponse(200, { ok: true, admin: { username: 'x' } }));
    await expect(provisionSecondAdmin(null, REQUEST)).rejects.toMatchObject({ kind: 'unauthorized' });
    await expect(provisionSecondAdmin('   ', REQUEST)).rejects.toBeInstanceOf(ProvisionAdminApiError);
    expect(calls).toHaveLength(0); // no token -> no request, ever
  });

  it('reads ONLY the four whitelisted success fields — credential columns are dropped', async () => {
    stubFetch(() => jsonResponse(200, {
      ok: true,
      admin: {
        id: 'ADM-9', username: 'asha.admin', full_name: 'Asha Mwangi',
        created_at: '2026-01-01T00:00:00.000Z',
        // A hostile/buggy server could add these — they must NOT surface:
        password_hash: '$2b$12$should-never-render', token_version: 1, totp_enabled: false,
      },
    }));
    const dto = await provisionSecondAdmin(TOKEN, REQUEST);
    expect(dto).toEqual({ id: 'ADM-9', username: 'asha.admin', full_name: 'Asha Mwangi', created_at: '2026-01-01T00:00:00.000Z' });
    expect(JSON.stringify(dto)).not.toContain('password_hash');
    expect(JSON.stringify(dto)).not.toContain('$2b$');
  });

  it('treats a 2xx body that is not the documented envelope as a failure, not a success', async () => {
    stubFetch(() => jsonResponse(200, { ok: false }));
    await expect(provisionSecondAdmin(TOKEN, REQUEST)).rejects.toMatchObject({ kind: 'malformed' });
    stubFetch(() => jsonResponse(200, { ok: true })); // no admin object
    await expect(provisionSecondAdmin(TOKEN, REQUEST)).rejects.toMatchObject({ kind: 'malformed' });
    stubFetch(() => jsonResponse(200, { ok: true, admin: { id: 'ADM-9' } })); // no username
    await expect(provisionSecondAdmin(TOKEN, REQUEST)).rejects.toMatchObject({ kind: 'malformed' });
  });
});

describe('the one-time closure and the username conflict are different outcomes', () => {
  it('maps 409 provisioning_closed to a PERMANENT closure (the gate is spent)', async () => {
    const serverSentence = 'Provisioning is closed: a second administrator already exists.';
    stubFetch(() => jsonResponse(409, { error: serverSentence, code: 'provisioning_closed' }));
    const failure = await provisionSecondAdmin(TOKEN, REQUEST).catch((e) => e as ProvisionAdminApiError);
    expect(failure).toBeInstanceOf(ProvisionAdminApiError);
    expect(failure.kind).toBe('closed');
    expect(failure.status).toBe(409);
    expect(failure.code).toBe('provisioning_closed');
    // The server's OWN fixed, client-safe sentence is shown (it is pinned by
    // the backend errorDisclosure tests), sanitised.
    expect(failure.message).toBe(serverSentence);
  });

  it('maps 409 no_bootstrap_admin to closure as well (nothing can authorise it)', () => {
    const failure = provisionAdminFailureFromResponse(409, { error: 'No bootstrap administrator exists to authorize provisioning a second account.', code: 'no_bootstrap_admin' });
    expect(failure.kind).toBe('closed');
  });

  it('maps 409 admin_username_exists to a RETRYABLE conflict — not closure', async () => {
    const serverSentence = 'An administrator with that username already exists.';
    stubFetch(() => jsonResponse(409, { error: serverSentence, code: 'admin_username_exists' }));
    const failure = await provisionSecondAdmin(TOKEN, REQUEST).catch((e) => e as ProvisionAdminApiError);
    expect(failure.kind).toBe('conflict');
    expect(failure.code).toBe('admin_username_exists');
    expect(failure.message).toBe(serverSentence);
  });

  it('treats an unknown 409 code conservatively as a conflict, never as closure', () => {
    expect(mapProvisionAdminFailure(409, null)).toBe('conflict');
    expect(mapProvisionAdminFailure(409, 'something_else')).toBe('conflict');
  });

  it('maps the documented 400 / 401 / 403 / 5xx outcomes onto their kinds', () => {
    expect(mapProvisionAdminFailure(400, 'username_required')).toBe('validation');
    expect(mapProvisionAdminFailure(400, 'password_too_long')).toBe('validation');
    expect(mapProvisionAdminFailure(401, null)).toBe('unauthorized');
    expect(mapProvisionAdminFailure(403, 'not_the_bootstrap_administrator')).toBe('forbidden');
    expect(mapProvisionAdminFailure(500, 'insert_failed')).toBe('server');
    expect(mapProvisionAdminFailure(503, null)).toBe('server');
  });

  it('closure is inferred ONLY from the explicit server answer — a network failure never closes the form', async () => {
    stubFetch(() => { throw new TypeError('fetch failed'); });
    const failure = await provisionSecondAdmin(TOKEN, REQUEST).catch((e) => e as ProvisionAdminApiError);
    expect(failure.kind).toBe('network');
    expect(failure.kind).not.toBe('closed');
    expect(failure.status).toBe(0);
  });
});

describe('no error path can leak the password or a raw server body', () => {
  it('a network failure never echoes the request values', async () => {
    stubFetch(() => { throw new TypeError('connect ECONNREFUSED 127.0.0.1:4000'); });
    const failure = await provisionSecondAdmin(TOKEN, REQUEST).catch((e) => e as ProvisionAdminApiError);
    expect(failure.message).not.toContain(REQUEST.password);
    expect(failure.message).not.toContain(REQUEST.username);
    expect(failure.message).not.toContain('ECONNREFUSED');
  });

  it('a 5xx body is never rendered — the client shows its own fixed sentence', async () => {
    stubFetch(() => jsonResponse(500, { error: 'SqliteError: SQLITE_ERROR table admin_users stack at line 41', code: 'insert_failed' }));
    const failure = await provisionSecondAdmin(TOKEN, REQUEST).catch((e) => e as ProvisionAdminApiError);
    expect(failure.kind).toBe('server');
    expect(failure.message).not.toContain('SqliteError');
    expect(failure.message).not.toContain('stack');
    expect(failure.message).not.toContain(REQUEST.password);
  });

  it('a 401/403 body is never rendered either', () => {
    const failure = provisionAdminFailureFromResponse(401, { error: 'raw jwt traceback ABC123' });
    expect(failure.kind).toBe('unauthorized');
    expect(failure.message).not.toContain('ABC123');
    const forbidden = provisionAdminFailureFromResponse(403, { error: 'raw detail ZZZ' });
    expect(forbidden.kind).toBe('forbidden');
    expect(forbidden.message).not.toContain('ZZZ');
  });

  it('an unparseable error body degrades to a fixed message, never a crash', async () => {
    stubFetch(() => ({ ok: false, status: 500, json: async () => { throw new Error('not json'); } }) as unknown as Response);
    const failure = await provisionSecondAdmin(TOKEN, REQUEST).catch((e) => e as ProvisionAdminApiError);
    expect(failure.kind).toBe('server');
    expect(failure.message.length).toBeGreaterThan(0);
  });

  it('the sanitiser collapses control characters and caps length (a blob cannot restructure the UI)', () => {
    expect(sanitizeProvisionAdminServerMessage(42)).toBe('');
    expect(sanitizeProvisionAdminServerMessage(undefined)).toBe('');
    expect(sanitizeProvisionAdminServerMessage('line\nbreak\u0000end')).toBe('line break end');
    const long = 'x'.repeat(500);
    const capped = sanitizeProvisionAdminServerMessage(long);
    expect(capped.length).toBeLessThanOrEqual(241); // 240 + ellipsis
  });
});

describe('client-side validation mirrors the server rules and never echoes the password', () => {
  const valid = { fullName: 'Asha Mwangi', username: 'asha.admin', password: 'Temp-Passw0rd!xyz', confirmPassword: 'Temp-Passw0rd!xyz' };

  it('accepts a fully valid form', () => {
    expect(validateProvisionAdminForm(valid)).toEqual({});
  });

  it('requires every field', () => {
    const errors = validateProvisionAdminForm({ fullName: '   ', username: '', password: '', confirmPassword: '' });
    expect(errors.fullName).toBeTruthy();
    expect(errors.username).toBeTruthy();
    expect(errors.password).toBeTruthy();
    expect(errors.confirmPassword).toBeTruthy();
  });

  it('enforces the SAME ceilings the database layer enforces — no stricter, no looser', () => {
    expect(PROVISION_ADMIN_LIMITS).toEqual({ username: 50, fullName: 100, password: 200 });
    const atLimit = validateProvisionAdminForm({
      fullName: 'n'.repeat(100),
      username: 'u'.repeat(50),
      password: 'p'.repeat(200),
      confirmPassword: 'p'.repeat(200),
    });
    expect(atLimit).toEqual({});
    const overLimit = validateProvisionAdminForm({
      fullName: 'n'.repeat(101),
      username: 'u'.repeat(51),
      password: 'p'.repeat(201),
      confirmPassword: 'p'.repeat(201),
    });
    expect(overLimit.fullName).toContain('100');
    expect(overLimit.username).toContain('50');
    expect(overLimit.password).toContain('200');
  });

  it('rejects a password confirmation that does not match, without echoing either value', () => {
    const errors = validateProvisionAdminForm({ ...valid, confirmPassword: 'Different-Value-9' });
    expect(errors.confirmPassword).toBeTruthy();
    expect(errors.confirmPassword).not.toContain(valid.password);
    expect(errors.confirmPassword).not.toContain('Different-Value-9');
  });

  it('no validation message contains the typed password, whatever the field mix', () => {
    const errors = validateProvisionAdminForm({ fullName: '', username: '', password: valid.password, confirmPassword: 'mismatch' });
    const rendered = JSON.stringify(errors);
    expect(rendered).not.toContain(valid.password);
  });

  it('the shipped client module touches no browser storage and logs nothing', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../adminProvisionAdminApi.ts'), 'utf8');
    // Comments may NAME the forbidden mechanisms in prose (that is how the
    // policy is documented); the CODE must not reference any of them.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(code).not.toMatch(/localStorage|sessionStorage|indexedDB/i);
    expect(code).not.toMatch(/console\./);
    // The endpoint is a plain POST path — never a URL with credentials or a query.
    expect(code).not.toMatch(/provision-admin\?/);
    expect(code).not.toMatch(/new URL\(/);
  });
});
