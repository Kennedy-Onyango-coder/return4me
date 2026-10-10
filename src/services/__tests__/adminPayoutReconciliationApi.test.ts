import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AdminPayoutReconciliationApiError,
  PAYOUT_RECONCILIATION_PATH,
  describePayoutType,
  failureMessageForStatus,
  fetchUnresolvedPayouts,
  formatPayoutAmount,
  mapPayoutReconciliationItem,
  maskRecipientForDisplay,
  resolvePayoutOutcome,
  safeReasonText,
  sortPayoutRowsOldestFirst,
} from '../adminPayoutReconciliationApi';

// =============================================================================
// BATCH 2 — THE PAYOUT-RECONCILIATION CLIENT (read-only)
// =============================================================================
// These are BEHAVIOUR tests: this module is deliberately React-free (see its
// header) precisely so the rules that matter can be executed rather than
// described. The rules pinned here are the ones that decide whether an operator
// can safely reconcile a payout against the provider, or would be misled into
// re-sending one:
//
//   * only GET is ever issued, to the one constant path, with the session token;
//   * a provider outcome we do not recognize — and a NULL one — fail CLOSED
//     (unresolved, may have moved money), never open;
//   * a raw recipient number can never survive this module unmasked;
//   * a missing amount is never rendered as 0;
//   * the list is OLDEST FIRST, because it is a work queue, and an unreadable
//     timestamp sorts last instead of looking brand new.

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The module reads only `ok`, `status` and `json()` off the response. */
function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function stubFetch(result: Response | Error) {
  const mock = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

const ONE_ROW = {
  ledgerEntryId: 'led-1',
  claimId: 'claim-1',
  itemId: 'item-1',
  type: 'finder_payout',
  amount: 1500,
  status: 'pending',
  payoutOutcome: 'unknown',
  providerBatchId: 'batch-9',
  providerTransactionId: null,
  recipient: '0712345678',
  reason: null,
  createdAt: '2026-10-01T08:30:00.000Z',
};

describe('describePayoutType', () => {
  it('names the two provider payout types', () => {
    expect(describePayoutType('finder_payout')).toBe('Finder payout');
    expect(describePayoutType('agent_payout')).toBe('Agent payout');
  });

  it('shows an unrecognized token RAW rather than hiding it or prettifying it', () => {
    // A blank cell would read as "no payout at all", which is a different claim.
    expect(describePayoutType('mystery_payout')).toBe('mystery_payout');
    expect(describePayoutType('')).toBe('Payout type not reported');
    expect(describePayoutType(null)).toBe('Payout type not reported');
    expect(describePayoutType(42)).toBe('Payout type not reported');
  });
});

describe('formatPayoutAmount', () => {
  it('renders a deterministic, un-grouped currency figure', () => {
    expect(formatPayoutAmount(1500)).toEqual({ text: 'KES 1500.00', reported: true });
    expect(formatPayoutAmount('250.5')).toEqual({ text: 'KES 250.50', reported: true });
    // 0 is a real, reportable figure — it is not a stand-in for "missing".
    expect(formatPayoutAmount(0)).toEqual({ text: 'KES 0.00', reported: true });
  });

  it('reports a missing amount as missing, never as zero', () => {
    expect(formatPayoutAmount(null)).toEqual({ text: '—', reported: false });
    expect(formatPayoutAmount(undefined)).toEqual({ text: '—', reported: false });
    expect(formatPayoutAmount('not-a-number')).toEqual({ text: '—', reported: false });
    expect(formatPayoutAmount(NaN)).toEqual({ text: '—', reported: false });
    expect(formatPayoutAmount(Infinity)).toEqual({ text: '—', reported: false });
  });
});

describe('maskRecipientForDisplay', () => {
  it('masks a cleared number the same way the server does, and never returns it whole', () => {
    expect(maskRecipientForDisplay('0712345678')).toBe('0712***678');
    expect(maskRecipientForDisplay('+254712345678')).toBe('+254712***678');
  });

  it('is idempotent over the server’s own mask, so a masked value cannot be un-masked', () => {
    const serverMasked = '0712***678';
    expect(maskRecipientForDisplay(serverMasked)).toBe(serverMasked);
  });

  it('fully masks anything too short to reveal part of', () => {
    expect(maskRecipientForDisplay('12345')).toBe('***');
  });

  it('reports an absent recipient as absent rather than fabricating one', () => {
    expect(maskRecipientForDisplay(null)).toBeNull();
    expect(maskRecipientForDisplay(undefined)).toBeNull();
    expect(maskRecipientForDisplay('   ')).toBeNull();
    expect(maskRecipientForDisplay(12345)).toBeNull();
  });
});

describe('resolvePayoutOutcome — the reconciliation rule, failing closed', () => {
  it('treats a NULL outcome as unresolved: no history is not proof of no submission', () => {
    const p = resolvePayoutOutcome(null);
    expect(p.outcome).toBeNull();
    expect(p.unresolved).toBe(true);
    expect(p.mayHaveMovedMoney).toBe(true);
    expect(p.tone).toBe('warning');
    expect(p.label).toContain('verify with the provider');
  });

  it('never presents an ACCEPTED transfer as paid, and calls it unresolved', () => {
    const p = resolvePayoutOutcome('accepted');
    expect(p.unresolved).toBe(true);
    expect(p.mayHaveMovedMoney).toBe(true);
    expect(p.label).toContain('NOT confirmed paid');
    expect(p.tone).toBe('warning');
  });

  it('treats submitting / unknown as unresolved and possibly already moved', () => {
    for (const outcome of ['submitting', 'unknown']) {
      const p = resolvePayoutOutcome(outcome);
      expect(p.unresolved, outcome).toBe(true);
      expect(p.mayHaveMovedMoney, outcome).toBe(true);
    }
  });

  it('marks only a completed transfer as settled', () => {
    const p = resolvePayoutOutcome('completed');
    expect(p.unresolved).toBe(false);
    expect(p.mayHaveMovedMoney).toBe(false);
    expect(p.tone).toBe('success');
  });

  it('treats a recognized-but-refused transfer as unresolved work, not as a silent success', () => {
    const p = resolvePayoutOutcome('rejected');
    expect(p.unresolved).toBe(true);
    expect(p.mayHaveMovedMoney).toBe(false);
  });

  it('fails CLOSED on a token the vocabulary does not contain', () => {
    const p = resolvePayoutOutcome('something_else');
    expect(p.outcome).toBe('something_else'); // shown raw, never normalized away
    expect(p.unresolved).toBe(true);
    expect(p.mayHaveMovedMoney).toBe(true);
    expect(p.tone).toBe('danger');
  });
});

describe('sortPayoutRowsOldestFirst', () => {
  const row = (id: string, recordedMs: number | null) => ({ ledgerEntryId: id, recordedMs } as any);

  it('puts the longest-unresolved row first', () => {
    const sorted = sortPayoutRowsOldestFirst([row('c', 300), row('a', 100), row('b', 200)]);
    expect(sorted.map((r) => r.ledgerEntryId)).toEqual(['a', 'b', 'c']);
  });

  it('sorts an unreadable timestamp LAST rather than treating it as brand new', () => {
    const sorted = sortPayoutRowsOldestFirst([row('nope', null), row('old', 100), row('new', 900)]);
    expect(sorted.map((r) => r.ledgerEntryId)).toEqual(['old', 'new', 'nope']);
  });

  it('does not mutate the array it is given', () => {
    const input = [row('b', 200), row('a', 100)];
    sortPayoutRowsOldestFirst(input);
    expect(input.map((r) => r.ledgerEntryId)).toEqual(['b', 'a']);
  });
});

describe('safeReasonText', () => {
  it('collapses control characters so one row cannot restructure the list', () => {
    expect(safeReasonText('transfer\n failed\t hard')).toBe('transfer failed hard');
    expect(safeReasonText('')).toBeNull();
    expect(safeReasonText(null)).toBeNull();
  });

  it('caps the length so a wall of text cannot bury the other rows', () => {
    const capped = safeReasonText('x'.repeat(500));
    expect(capped).not.toBeNull();
    expect(capped!.length).toBe(401); // 400 kept characters + the ellipsis
    expect(capped!.endsWith('…')).toBe(true);
  });
});

describe('fetchUnresolvedPayouts — the only network call, and it is a GET', () => {
  it('GETs the one constant path with the session token as a bearer credential', async () => {
    const mock = stubFetch(jsonResponse({ items: [ONE_ROW] }));
    await fetchUnresolvedPayouts('session-token');

    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(PAYOUT_RECONCILIATION_PATH);
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ Authorization: 'Bearer session-token' });
  });

  it('sends no Authorization header when there is no session, and still only GETs', async () => {
    const mock = stubFetch(jsonResponse({ items: [] }));
    await fetchUnresolvedPayouts(null);
    const [, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('GET');
    expect(init.headers).toBeUndefined();
  });

  it('maps a full row through the privacy-bounded type and masks the recipient again', async () => {
    stubFetch(jsonResponse({ items: [ONE_ROW] }));
    const rows = await fetchUnresolvedPayouts('t');
    const row = rows[0];

    expect(row.ledgerEntryId).toBe('led-1');
    expect(row.payoutTypeLabel).toBe('Finder payout');
    expect(row.recipientMasked).toBe('0712***678');
    expect(row.recipientMasked).not.toBe(ONE_ROW.recipient);
    expect(row.amountLabel).toBe('KES 1500.00');
    expect(row.amountReported).toBe(true);
    expect(row.outcome.unresolved).toBe(true);
  });

  it('returns rows oldest first, as a work queue', async () => {
    stubFetch(
      jsonResponse({
        items: [
          { ...ONE_ROW, ledgerEntryId: 'new', createdAt: '2026-10-05T00:00:00.000Z' },
          { ...ONE_ROW, ledgerEntryId: 'old', createdAt: '2026-09-01T00:00:00.000Z' },
        ],
      }),
    );
    const rows = await fetchUnresolvedPayouts('t');
    expect(rows.map((r) => r.ledgerEntryId)).toEqual(['old', 'new']);
  });

  it('treats an empty list as a real, successful answer', async () => {
    stubFetch(jsonResponse({ items: [] }));
    await expect(fetchUnresolvedPayouts('t')).resolves.toEqual([]);
  });

  it('drops an entry that is not a row object instead of rendering an empty one', async () => {
    stubFetch(jsonResponse({ items: [null, 'nope', 7, ONE_ROW] }));
    const rows = await fetchUnresolvedPayouts('t');
    expect(rows).toHaveLength(1);
    expect(rows[0].ledgerEntryId).toBe('led-1');
  });

  it('keeps a row whose id is missing, but reports the id as absent rather than inventing one', async () => {
    stubFetch(jsonResponse({ items: [{ ...ONE_ROW, ledgerEntryId: null }] }));
    const rows = await fetchUnresolvedPayouts('t');
    expect(rows).toHaveLength(1);
    expect(rows[0].ledgerEntryId).toBeNull();
  });

describe('fetchUnresolvedPayouts — how it fails, and that it never fails open', () => {
  async function expectKind(status: number, kind: string) {
    stubFetch(jsonResponse({ items: [] }, status));
    await expect(fetchUnresolvedPayouts('t')).rejects.toMatchObject({ kind, status });
  }

  it('classifies 401 / 403 / other-4xx / 5xx so the console can say something true', async () => {
    await expectKind(401, 'unauthorized');
    await expectKind(403, 'forbidden');
    await expectKind(400, 'invalid');
    await expectKind(503, 'server');
  });

  it('never accepts a 2xx body that is not the documented envelope', async () => {
    // An HTML error page, a bare array, a renamed key — all the same outcome: no
    // rows and an explicit error, never an empty table that reads as "all clean".
    const bodies: unknown[] = ['<html>not json</html>', [], {}, { items: 'nope' }, { rows: [] }, null];
    for (const body of bodies) {
      stubFetch(jsonResponse(body));
      await expect(fetchUnresolvedPayouts('t')).rejects.toMatchObject({ kind: 'malformed' });
    }
  });

  it('reports a body that cannot be parsed as malformed rather than as no rows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token <'); },
    } as unknown as Response)));

    await expect(fetchUnresolvedPayouts('t')).rejects.toMatchObject({ kind: 'malformed' });
  });

  it('reports a cancelled read as an abort, so a superseded read stays silent', async () => {
    const abortError = new Error('The operation was aborted.');
    abortError.name = 'AbortError';
    stubFetch(abortError);

    const error = await fetchUnresolvedPayouts('t').then(
      () => null,
      (e: AdminPayoutReconciliationApiError) => e,
    );

    expect(error).toBeInstanceOf(AdminPayoutReconciliationApiError);
    expect(error!.kind).toBe('aborted');
    expect(error!.isAbort).toBe(true);
    expect(error!.status).toBe(0);
  });

  it('passes the caller signal through, so an in-flight read can actually be cancelled', async () => {
    const mock = stubFetch(jsonResponse({ items: [] }));
    const controller = new AbortController();
    await fetchUnresolvedPayouts('t', { signal: controller.signal });
    const [, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });

  it('never puts server-supplied text into a failure message', async () => {
    stubFetch(jsonResponse({ error: '<script>alert(1)</script>' }, 500));
    const error = await fetchUnresolvedPayouts('t').then(
      () => null,
      (e: Error) => e,
    );
    expect(error!.message).not.toContain('<script>');
    expect(error!.message).toBe(failureMessageForStatus(500));
  });
});

describe('failureMessageForStatus', () => {
  it('gives every failure class its own truthful sentence', () => {
    const messages = [401, 403, 400, 500].map((s) => failureMessageForStatus(s));
    expect(new Set(messages).size).toBe(4);
    expect(failureMessageForStatus(401)).toContain('Sign in');
    expect(failureMessageForStatus(403)).toContain('not allowed');
    // A read-only surface must SAY it is read-only when it fails, or a failed
    // read can look like a failed write.
    expect(failureMessageForStatus(500)).toContain('Read-only: nothing was changed.');
  });
});

  it('reports an unreachable service as a network failure, not as an empty list', async () => {
    stubFetch(new TypeError('Failed to fetch'));
    await expect(fetchUnresolvedPayouts('t')).rejects.toMatchObject({ kind: 'network', status: 0 });
  });

});

