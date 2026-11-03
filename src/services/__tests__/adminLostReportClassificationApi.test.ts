import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_LOST_REPORTS_PATH,
  AdminLostReportClassifyApiError,
  classifyLostReport,
  lostReportClassifyPath,
  unclassifyLostReport,
} from '../adminLostReportClassificationApi';

// =============================================================================
// BATCH 1 — THE CLASSIFICATION REQUEST CONTRACT
// =============================================================================
// The route reads `req.body.categoryId`. A body that carries any other name is
// read as `undefined`, i.e. "no category", which would silently CLEAR the
// report's classification instead of setting one. So the exact method, URL,
// headers and body are asserted literally here rather than described in prose.
//
// The same file pins the failure surface: an operator must be told what went
// wrong (expired session, wrong role, missing report, refused category, outage)
// and a refusal must never be turned into a success.

const TOKEN = 'test-admin-jwt';
const REPORT = 'LR-ABC123';
const CATEGORY = 'cat-electronics';

interface Captured {
  url: string;
  init: RequestInit;
}

function installFetch(status: number, body: unknown): Captured[] {
  const calls: Captured[] = [];
  const spy = vi.fn(async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', spy);
  return calls;
}

function installFetchRejecting(error: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw error;
    }),
  );
}

function installFetchWithUnreadableBody(status: number): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        ({
          ok: status >= 200 && status < 300,
          status,
          json: async () => {
            throw new SyntaxError('Unexpected token < in JSON');
          },
        }) as unknown as Response,
    ),
  );
}

/** The typed failure a call produced, or a loud failure if it resolved. */
async function failureOf(promise: Promise<unknown>): Promise<AdminLostReportClassifyApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AdminLostReportClassifyApiError);
    return error as AdminLostReportClassifyApiError;
  }
  throw new Error('expected the classification call to fail, but it resolved');
}

const successBody = {
  success: true,
  previousCategory: CATEGORY,
  newCategory: 'cat-bags',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Batch 1 classification client: the request it sends', () => {
  let calls: Captured[];

  beforeEach(() => {
    calls = installFetch(200, successBody);
  });

  it('PATCHes the documented admin route and nothing else', async () => {
    await classifyLostReport(TOKEN, REPORT, CATEGORY);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/admin/lost-reports/LR-ABC123/classify');
    expect(calls[0].url).toBe(`${ADMIN_LOST_REPORTS_PATH}/${REPORT}/classify`);
    expect(calls[0].init.method).toBe('PATCH');
  });

  it('authenticates with a bearer token and declares JSON', async () => {
    await classifyLostReport(TOKEN, REPORT, CATEGORY);

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('sends EXACTLY { categoryId } — the name the route actually reads', async () => {
    await classifyLostReport(TOKEN, REPORT, CATEGORY);

    const body = String(calls[0].init.body);
    expect(body).toBe('{"categoryId":"cat-electronics"}');

    const parsed = JSON.parse(body);
    expect(Object.keys(parsed)).toEqual(['categoryId']);
    // The two names the route does NOT read. Sending either would be read as
    // "no category" and would unclassify the report.
    expect(parsed).not.toHaveProperty('report_id');
    expect(parsed).not.toHaveProperty('category_id');
  });

  it('URL-encodes the report reference instead of trusting it as a path segment', async () => {
    await classifyLostReport(TOKEN, 'LR-1/2 3', CATEGORY);

    expect(calls[0].url).toBe('/api/admin/lost-reports/LR-1%2F2%203/classify');
    expect(calls[0].url).not.toContain('LR-1/2 3');
  });

  it('trims a padded category id rather than sending the padding', async () => {
    await classifyLostReport(TOKEN, REPORT, '  cat-electronics  ');

    expect(JSON.parse(String(calls[0].init.body))).toEqual({ categoryId: 'cat-electronics' });
  });

  it('maps the server confirmation, including the previous category', async () => {
    const result = await classifyLostReport(TOKEN, REPORT, 'cat-bags');

    expect(result).toEqual({ previousCategoryId: CATEGORY, categoryId: 'cat-bags' });
  });
});
describe('Batch 1 classification client: nothing is ever guessed', () => {
  it('refuses a blank category WITHOUT sending a request (it would unclassify)', async () => {
    const calls = installFetch(200, successBody);

    const error = await failureOf(classifyLostReport(TOKEN, REPORT, '   '));

    expect(error.kind).toBe('invalid');
    expect(error.message).toBe('Choose an item category before saving.');
    expect(calls).toHaveLength(0);
  });

  it('refuses a blank report reference without sending a request', async () => {
    const calls = installFetch(200, successBody);

    const error = await failureOf(classifyLostReport(TOKEN, '', CATEGORY));

    expect(error.kind).toBe('invalid');
    expect(calls).toHaveLength(0);
  });

  it('refuses to call the API with no admin token at all', async () => {
    const calls = installFetch(200, successBody);

    const error = await failureOf(classifyLostReport(null, REPORT, CATEGORY));

    expect(error.kind).toBe('unauthorized');
    expect(error.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('never turns a refused request into a confirmed classification', async () => {
    installFetch(200, { success: false, error: 'nope' });

    const error = await failureOf(classifyLostReport(TOKEN, REPORT, CATEGORY));

    expect(error.kind).toBe('malformed');
    expect(error.message).toBe('The server did not confirm the classification.');
  });

  it('treats an unreadable 200 body as malformed, not as success', async () => {
    installFetchWithUnreadableBody(200);

    const error = await failureOf(classifyLostReport(TOKEN, REPORT, CATEGORY));

    expect(error.kind).toBe('malformed');
  });
});

describe('Batch 1 classification client: the failures an operator can meet', () => {
  it('401 — the session ended (fixed sentence, never a bare proxy word)', async () => {
    installFetch(401, { error: 'Forbidden' });

    const error = await failureOf(classifyLostReport(TOKEN, REPORT, CATEGORY));

    expect(error.kind).toBe('unauthorized');
    expect(error.status).toBe(401);
    expect(error.message).toBe('Your admin session has ended. Please sign in again.');
  });

  it('403 — authenticated but not an administrator', async () => {
    installFetch(403, { error: 'Admin access required' });

    const error = await failureOf(classifyLostReport(TOKEN, REPORT, CATEGORY));

    expect(error.kind).toBe('forbidden');
    expect(error.status).toBe(403);
    expect(error.message).toBe('Access denied — this action needs an administrator session.');
  });

  it('404 — the report is gone', async () => {
    installFetch(404, { error: 'Lost report not found' });

    const error = await failureOf(classifyLostReport(TOKEN, REPORT, CATEGORY));

    expect(error.kind).toBe('not_found');
    expect(error.status).toBe(404);
    expect(error.message).toBe('Lost report not found');
  });

  it('400 — the category was refused, using the server wording', async () => {
    installFetch(400, { error: 'That item category is not valid.' });

    const error = await failureOf(classifyLostReport(TOKEN, REPORT, CATEGORY));

    expect(error.kind).toBe('invalid');
    expect(error.status).toBe(400);
    expect(error.message).toBe('That item category is not valid.');
  });

  it('500 — the service failed, and says so instead of pretending', async () => {
    installFetch(503, {});

    const error = await failureOf(classifyLostReport(TOKEN, REPORT, CATEGORY));

    expect(error.kind).toBe('server');
    expect(error.status).toBe(503);
    expect(error.message).toBe('The classification could not be saved. Please try again.');
  });

  it('network — the request never completed', async () => {
    installFetchRejecting(new TypeError('Failed to fetch'));

    const error = await failureOf(classifyLostReport(TOKEN, REPORT, CATEGORY));

    expect(error.kind).toBe('network');
    expect(error.status).toBe(0);
    expect(error.message).toBe('The lost-report service could not be reached.');
  });

  it('abort — a deliberate cancel is flagged so the UI can stay silent', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    installFetchRejecting(abort);

    const error = await failureOf(classifyLostReport(TOKEN, REPORT, CATEGORY));

    expect(error.kind).toBe('aborted');
    expect(error.isAbort).toBe(true);
  });

  it('never logs the token, the reference or the response', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installFetch(500, { error: 'boom' });

    await failureOf(classifyLostReport(TOKEN, REPORT, CATEGORY));

    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('Batch 1 classification client: clearing a category is explicit', () => {
  it('unclassify sends categoryId: null, by its own call and no other way', async () => {
    const calls = installFetch(200, {
      success: true,
      previousCategory: CATEGORY,
      newCategory: null,
    });

    const result = await unclassifyLostReport(TOKEN, REPORT);

    expect(String(calls[0].init.body)).toBe('{"categoryId":null}');
    expect(calls[0].init.method).toBe('PATCH');
    expect(result).toEqual({ previousCategoryId: CATEGORY, categoryId: null });
  });

  it('the path helper is the only place the route is spelled', () => {
    expect(lostReportClassifyPath('LR-9')).toBe('/api/admin/lost-reports/LR-9/classify');
  });
});
