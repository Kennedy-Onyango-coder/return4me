import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_NOTIFICATIONS_PATH,
  AdminNotificationsApiError,
  adminNotificationRetryPath,
  buildAdminNotificationsPath,
  fetchAdminNotifications,
  mapAdminNotificationRetryResponse,
  mapAdminNotificationsWindow,
  retryAdminNotification,
  safeNotificationErrorText,
} from '../../../../services/adminNotificationsApi';

// =============================================================================
// BATCH A2 — THE OUTBOX CLIENT CONTRACT
// =============================================================================
// Everything here runs against a MOCKED fetch: no request leaves this process, no
// notification is sent, and no provider is contacted. The suite pins:
//   * the exact paths and query strings (so the console cannot drift from the
//     endpoints that exist, or invent a parameter the server does not accept);
//   * that an unreadable body is a FAILURE, never an empty outbox;
//   * that `retried` and `retryable` are strict booleans (a truthy string cannot
//     become a success or a retry);
//   * that a 409 is surfaced as a refusal carrying the server's own
//     `reviewRequired` signal, with fixed client-side wording and no echoed body;
//   * that the recipient field is carried as the masked reference it is — this
//     module has no field for a full number, address, OTP or message body.
// =============================================================================

const TOKEN = 'test-admin-token';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function stubFetch(implementation: (input: string, init?: RequestInit) => Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const mock = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return implementation(String(input), init);
  });
  vi.stubGlobal('fetch', mock);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the request paths are built here, and only documented values are sent', () => {
  it('reads the bare endpoint when no filter is chosen', () => {
    expect(buildAdminNotificationsPath()).toBe(ADMIN_NOTIFICATIONS_PATH);
    expect(buildAdminNotificationsPath({ status: '', eventType: '', channel: '' })).toBe(ADMIN_NOTIFICATIONS_PATH);
  });

  it('sends the three documented filters', () => {
    const path = buildAdminNotificationsPath({
      status: 'retryable_failure',
      eventType: 'ITEM_HANDED_OVER',
      channel: 'email',
    });
    expect(path).toBe(
      `${ADMIN_NOTIFICATIONS_PATH}?status=retryable_failure&eventType=ITEM_HANDED_OVER&channel=email`,
    );
  });

  it('DROPS a status or channel the route would answer 400 for', () => {
    // Deliberately hostile values, cast past the type: the point is that the
    // RUNTIME guard holds for a hand-edited or persisted filter, not that the
    // compiler forbids the call (it does — see the types on AdminNotificationFilters).
    const hostile = {
      status: 'totally_made_up',
      channel: 'carrier_pigeon',
    } as unknown as Parameters<typeof buildAdminNotificationsPath>[0];
    expect(buildAdminNotificationsPath(hostile)).toBe(ADMIN_NOTIFICATIONS_PATH);
  });

  it('trims the event type and drops an empty one', () => {
    expect(buildAdminNotificationsPath({ eventType: '  ITEM_HANDED_OVER  ' }))
      .toBe(`${ADMIN_NOTIFICATIONS_PATH}?eventType=ITEM_HANDED_OVER`);
    expect(buildAdminNotificationsPath({ eventType: '   ' })).toBe(ADMIN_NOTIFICATIONS_PATH);
  });

  it('addresses one notification through the retry sub-path', () => {
    expect(adminNotificationRetryPath('ne 1/2')).toBe(`${ADMIN_NOTIFICATIONS_PATH}/ne%201%2F2/retry`);
  });
});

describe('the window mapping states only what the response carried', () => {
  const base = {
    notifications: [
      {
        id: 'ne-1',
        eventType: 'ITEM_HANDED_OVER',
        channel: 'email',
        provider: 'resend',
        status: 'retryable_failure',
        recipientReference: 'o***@example.com',
        lastError: 'provider_550',
        businessReference: 'CLM-1',
        retryClass: 'reconstructable',
        retryable: true,
        attemptCount: 2,
        retryAttemptCount: 1,
        createdAt: '2026-01-01T09:00:00.000Z',
        updatedAt: null,
        sentAt: null,
        nextAttemptAt: null,
      },
    ],
    retryableEventTypes: ['ITEM_HANDED_OVER', 'FINDER_ITEM_COLLECTED'],
  };

  it('maps the named fields and keeps the masked reference verbatim', () => {
    const window = mapAdminNotificationsWindow(base);
    expect(window.returned).toBe(1);
    expect(window.reachedServerCap).toBe(false);
    expect(window.retryableEventTypes).toEqual(['ITEM_HANDED_OVER', 'FINDER_ITEM_COLLECTED']);
    const row = window.rows[0];
    expect(row.id).toBe('ne-1');
    expect(row.recipientReference).toBe('o***@example.com');
    expect(row.retryable).toBe(true);
    expect(row.attemptCount).toBe(2);
    expect(row.createdAtLabel).not.toBe('');
  });

  it('renders a missing value as null rather than inventing one', () => {
    const window = mapAdminNotificationsWindow({ notifications: [{ id: 'ne-2' }] });
    const row = window.rows[0];
    expect(row.eventType).toBeNull();
    expect(row.status).toBeNull();
    expect(row.recipientReference).toBeNull();
    expect(row.lastError).toBeNull();
    expect(row.attemptCount).toBeNull();
    expect(row.retryable).toBe(false);
    expect(row.createdAtLabel).toBe('');
  });

  it('drops only items that are not objects', () => {
    const window = mapAdminNotificationsWindow({
      notifications: [null, 'nope', 42, { id: 'ne-3', retryable: true }],
    });
    expect(window.returned).toBe(1);
    expect(window.rows[0].id).toBe('ne-3');
  });

  it('treats an unreadable body as a FAILURE, not an empty outbox', () => {
    expect(() => mapAdminNotificationsWindow({})).toThrow(AdminNotificationsApiError);
    expect(() => mapAdminNotificationsWindow(null)).toThrow(AdminNotificationsApiError);
    expect(() => mapAdminNotificationsWindow({ notifications: 'none' })).toThrow(AdminNotificationsApiError);
  });

  it('flags the server cap only when the window was actually filled', () => {
    const rows = Array.from({ length: 200 }, (_, index) => ({ id: `ne-${index}` }));
    expect(mapAdminNotificationsWindow({ notifications: rows }).reachedServerCap).toBe(true);
    expect(mapAdminNotificationsWindow({ notifications: rows.slice(0, 199) }).reachedServerCap).toBe(false);
  });

  it('survives a payload with no retryableEventTypes list', () => {
    expect(mapAdminNotificationsWindow({ notifications: [] }).retryableEventTypes).toEqual([]);
  });
});

describe('a stored error string cannot restructure the row', () => {
  it('collapses control characters and caps the length', () => {
    expect(safeNotificationErrorText('line\nbreak\u0000end')).toBe('line break end');
    expect(safeNotificationErrorText(42)).toBe('');
    expect(safeNotificationErrorText('x'.repeat(900)).length).toBe(401);
  });
});

describe('the read is a GET with the admin token, and failures are ours to word', () => {
  it('requests the filtered path with a bearer token and maps the window', async () => {
    const calls = stubFetch(async () => jsonResponse(200, {
      notifications: [{ id: 'ne-1', status: 'retryable_failure', retryable: true }],
      retryableEventTypes: ['ITEM_HANDED_OVER'],
    }));

    const window = await fetchAdminNotifications(TOKEN, { status: 'retryable_failure' });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${ADMIN_NOTIFICATIONS_PATH}?status=retryable_failure`);
    expect(calls[0].init?.method).toBe('GET');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(window.returned).toBe(1);
    expect(window.rows[0].id).toBe('ne-1');
  });

  it('maps a 403 to a forbidden failure with its own sentence', async () => {
    stubFetch(async () => jsonResponse(403, { error: 'raw server wording ZZZ' }));
    const error = await fetchAdminNotifications(TOKEN).catch((e: AdminNotificationsApiError) => e);
    expect(error).toBeInstanceOf(AdminNotificationsApiError);
    expect((error as AdminNotificationsApiError).kind).toBe('forbidden');
    expect((error as AdminNotificationsApiError).status).toBe(403);
    expect((error as AdminNotificationsApiError).message).toContain('not an administrator');
    expect((error as AdminNotificationsApiError).message).not.toContain('ZZZ');
  });

  it('reports a transport failure as a network failure, not as an empty outbox', async () => {
    stubFetch(async () => { throw new TypeError('fetch failed'); });
    await expect(fetchAdminNotifications(TOKEN)).rejects.toMatchObject({ kind: 'network', status: 0 });
  });

  it('treats a cancelled read as an abort, not an error', async () => {
    const aborted = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    stubFetch(async () => { throw aborted; });
    const error = await fetchAdminNotifications(TOKEN).catch((e: AdminNotificationsApiError) => e);
    expect(error).toBeInstanceOf(AdminNotificationsApiError);
    expect((error as AdminNotificationsApiError).isAbort).toBe(true);
  });

  it('treats a 2xx with an unreadable body as malformed', async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new Error('not json'); },
    }) as unknown as Response);
    await expect(fetchAdminNotifications(TOKEN)).rejects.toMatchObject({ kind: 'malformed' });
  });
});

describe('the retry is one POST, and a refusal is never a success', () => {
  it('posts to the retry sub-path and maps a genuine resend', async () => {
    const calls = stubFetch(async () => jsonResponse(200, { retried: true, outcome: 'sent' }));

    const result = await retryAdminNotification(TOKEN, 'ne-1');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${ADMIN_NOTIFICATIONS_PATH}/ne-1/retry`);
    expect(calls[0].init?.method).toBe('POST');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(result).toEqual({ retried: true, outcome: 'sent', detail: null });
  });

  it('refuses to call the API at all without an id', async () => {
    const calls = stubFetch(async () => jsonResponse(200, { retried: true, outcome: 'sent' }));
    await expect(retryAdminNotification(TOKEN, '   ')).rejects.toMatchObject({ kind: 'invalid' });
    expect(calls).toHaveLength(0);
  });

  it('surfaces a 409 with reviewRequired as a refusal that needs a person', async () => {
    stubFetch(async () => jsonResponse(409, {
      error: "Only a retryable_failure can be retried; this one is 'unknown'.",
      reviewRequired: true,
    }));

    const error = await retryAdminNotification(TOKEN, 'ne-1').catch((e: AdminNotificationsApiError) => e);
    expect(error).toBeInstanceOf(AdminNotificationsApiError);
    expect((error as AdminNotificationsApiError).kind).toBe('conflict');
    expect((error as AdminNotificationsApiError).reviewRequired).toBe(true);
    expect((error as AdminNotificationsApiError).message).toContain('human decision');
  });

  it('surfaces a 409 without reviewRequired as a state refusal', async () => {
    stubFetch(async () => jsonResponse(409, { error: 'changed', reviewRequired: false }));
    const error = await retryAdminNotification(TOKEN, 'ne-1').catch((e: AdminNotificationsApiError) => e);
    expect((error as AdminNotificationsApiError).reviewRequired).toBe(false);
    expect((error as AdminNotificationsApiError).message).toContain('no longer in a retryable state');
  });

  it('maps 404 and 5xx to their own kinds, without echoing the body', async () => {
    stubFetch(async () => jsonResponse(404, { error: 'gone' }));
    await expect(retryAdminNotification(TOKEN, 'ne-1')).rejects.toMatchObject({ kind: 'not_found' });

    stubFetch(async () => jsonResponse(500, { error: 'SqliteError: stack at line 41' }));
    const error = await retryAdminNotification(TOKEN, 'ne-1').catch((e: AdminNotificationsApiError) => e);
    expect((error as AdminNotificationsApiError).kind).toBe('server');
    expect((error as AdminNotificationsApiError).message).not.toContain('SqliteError');
  });
});

describe('a retry body cannot be read as a success by accident', () => {
  it('requires a literal true for `retried`', () => {
    expect(mapAdminNotificationRetryResponse({ retried: 'true', outcome: 'sent' }).retried).toBe(false);
    expect(mapAdminNotificationRetryResponse({ outcome: 'sent' }).retried).toBe(false);
    expect(mapAdminNotificationRetryResponse({ retried: true, outcome: 'sent' }).retried).toBe(true);
  });

  it('maps an outcome this console does not know to null', () => {
    expect(mapAdminNotificationRetryResponse({ retried: true, outcome: 'brand_new' }).outcome).toBeNull();
    expect(mapAdminNotificationRetryResponse({ retried: false, outcome: 'not_due_yet' }).outcome).toBe('not_due_yet');
  });

  it('keeps the server detail code without inventing one', () => {
    expect(mapAdminNotificationRetryResponse({ retried: false, outcome: 'dispatch_failed', detail: 'provider_500' }).detail)
      .toBe('provider_500');
    expect(mapAdminNotificationRetryResponse({ retried: false }).detail).toBeNull();
  });
});
