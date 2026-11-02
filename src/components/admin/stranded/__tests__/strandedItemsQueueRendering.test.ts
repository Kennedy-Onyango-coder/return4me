import React from 'react';
import { readFileSync } from 'fs';
import path from 'path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import StrandedItemsQueueTable from '../StrandedItemsQueueTable';
import {
  AdminStrandedItemsApiError,
  STRANDED_ITEMS_QUEUE_PATH,
  STRANDED_NOT_RECORDED,
  buildItemUnassignPath,
  errorKindForStatus,
  fetchStrandedItemsQueue,
  mapStrandedQueueItem,
  queueReadFailureMessageForStatus,
  readStrandedItemsQueue,
  readStrandedQueueTotals,
  releaseFailureMessageForStatus,
  releaseStrandedItem,
  type AdminStrandedItemDto,
} from '../../../../services/adminStrandedItemsApi';
import { ADMIN_NAV_GROUPS } from '../../shell/adminNavRegistry';

// =============================================================================
// STAGE 3B-6B — WHAT THE STRANDED-ITEM QUEUE ACTUALLY RENDERS AND SAYS
// =============================================================================
// This is the screen an administrator reads before taking an item away from a
// hub somebody else is waiting on, so the two things that must never drift are:
//
//   1. the TABLE never offers an action the server did not authorize. Whether a
//      row shows "Return to queue" is `canRelease`, which is the server's
//      `releasable` copied through the API client. The fixtures below are built
//      through the REAL mapper, so the mapping and the rendering are exercised
//      together — a policy change re-deriving eligibility in the browser would
//      break these assertions.
//   2. the CLIENT never reports a refusal as a success. The failure vocabulary is
//      asserted string by string, including the 409 that carries the server's own
//      sentence, and the release call is asserted to make NO request at all when
//      the reason fails the shared policy.
//
// Rendered assertions use react-dom/server, the same approach as
// payouts/__tests__/payoutReconciliationRendering.test.ts and
// notifications/__tests__/notificationOutboxRendering.test.ts: this repository's
// vitest environment is node-only (no jsdom), so anything asserted "on screen"
// is asserted on real HTML from a real render.
// =============================================================================

const DEFAULT_DTO: AdminStrandedItemDto = {
  item_id: 'item-1',
  status: 'awaiting_dropoff',
  county: 'Nairobi',
  administrative_unit_id: 'unit-7',
  agent_id: 'hub-1',
  agent_business_name: 'Westlands Kiosk',
  agent_status: 'suspended',
  agent_actionable: false,
  agent_found: true,
  assigned_at: '2026-10-01T08:30:00.000Z',
  assignment_age_hours: 76,
  custody: 'not_yet_received',
  custody_note: 'The hub never recorded receiving this item.',
  releasable: true,
  refusal: null,
  review_required: false,
};

/** A row exactly as the console receives it, built through the real mapper. */
function row(overrides: Partial<AdminStrandedItemDto> = {}) {
  const mapped = mapStrandedQueueItem({ ...DEFAULT_DTO, ...overrides });
  if (!mapped) throw new Error('fixture did not map to a row');
  return mapped;
}

const renderTable = (
  rows: ReturnType<typeof row>[],
  inFlightItemId: string | null = null,
) => renderToStaticMarkup(
  React.createElement(StrandedItemsQueueTable, { rows, inFlightItemId, onRequestRelease: () => {} }),
);

const SOURCE_DIR = new URL('../', import.meta.url);
const readSource = (file: string) => readFileSync(new URL(file, SOURCE_DIR), 'utf8');
/** Source with comments stripped, so prose ABOUT a control is not read as one. */
const code = (file: string) =>
  readSource(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('the table offers the release control ONLY when the server said the row is releasable', () => {
  it('renders exactly one action for a releasable row, named after the item', () => {
    const html = renderTable([row()]);
    expect(html).toContain('Return to queue');
    expect(html).toContain('aria-label="Return item item-1 to the assignment queue"');
    expect(html.match(/<button/g)).toHaveLength(1);
    // Nothing that could act on a batch is rendered.
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('<form');
  });

  it('renders NO control for a row the server refuses, and says why', () => {
    const refusal = 'A hub that has recorded receiving this item cannot be released from here.';
    const html = renderTable([
      row({
        item_id: 'item-held',
        custody: 'received_at_hub',
        custody_note: 'The hub recorded receiving this item on 1 October.',
        releasable: false,
        refusal,
        review_required: true,
      }),
    ]);

    expect(html).not.toContain('<button');
    // The refusal is the server's own sentence, rendered verbatim.
    expect(html).toContain(refusal);
    // A held row is never silently presented as releasable.
    expect(html).toContain('Needs a human custody decision');
    expect(html).not.toContain('Safe to return now');
  });

  it('offers the control on one row without offering it on its neighbour', () => {
    const html = renderTable([
      row({ item_id: 'item-ok', releasable: true }),
      row({
        item_id: 'item-no',
        releasable: false,
        refusal: 'Held for a human custody decision.',
        review_required: true,
      }),
    ]);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Return item item-ok to the assignment queue"');
    expect(html).toContain('Held for a human custody decision.');
  });

  it('drops and re-labels nothing when the server read the hub only partly', () => {
    const html = renderTable([
      row({ agent_business_name: null, agent_found: false, agent_status: 'unknown', releasable: false }),
    ]);
    // The hub still has a name on screen, and the reason it is unverified is said.
    expect(html).toContain('Hub hub-1');
    expect(html).toContain('The hub record could not be read');
    expect(html).toContain('Standing not recorded');
    expect(html).not.toContain('<button');
  });
});

describe('a value the row does not carry is stated, never blank and never zero', () => {
  it('marks the absent county and assignment time with the visible marker', () => {
    const html = renderTable([
      row({ county: null, administrative_unit_id: null, assigned_at: null, assignment_age_hours: null }),
    ]);
    expect(html).toContain(STRANDED_NOT_RECORDED);
    expect(html).toContain('Unknown - no assignment event was recorded');
    // A missing county is not silently rendered as the string "null".
    expect(html).not.toMatch(/>\s*null\s*</);
  });

  it('states unstated custody loudly rather than implying the hub has nothing', () => {
    const html = renderTable([
      row({ custody: 'something_new', custody_note: '', releasable: false, review_required: true }),
    ]);
    expect(html).toContain('Custody not reported');
    // The sentence is server copy and React escapes its apostrophe, so the
    // assertion is made on the unpunctuated tail rather than on the raw quote.
    expect(html).toContain('physical custody. Treat it as unknown.');
  });

  it('shows the in-flight row as busy and disables every other release', () => {
    const html = renderTable([row({ item_id: 'item-1' }), row({ item_id: 'item-2' })], 'item-1');
    // Both controls are still rendered; neither can start a second release.
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).toContain('Returning this item to the queue');
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });

  it('renders nothing at all for an empty list, so the panel owns the empty state', () => {
    expect(renderTable([])).toBe('');
  });
});

describe('the table is a presentation of the server verdict, not a second policy', () => {
  const source = code('StrandedItemsQueueTable.tsx');

  it('reads `canRelease` and never re-derives it from a status string', () => {
    expect(source).toContain('row.canRelease');
    expect(source).not.toMatch(/status\s*===\s*'at_agent'/);
    expect(source).not.toMatch(/status\s*===\s*'awaiting_dropoff'/);
    expect(source).not.toMatch(/'suspended'\s*===/);
  });

  it('sends nothing and reaches no endpoint of its own', () => {
    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('/api/');
    expect(source).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/);
    expect(source).not.toContain('useState');
    expect(source).not.toContain('useEffect');
  });
});


// ---------------------------------------------------------------------------
// THE CLIENT: WHAT IT REFUSES TO SEND, AND WHAT IT SAYS WHEN REFUSED
// ---------------------------------------------------------------------------

const VALID_REASON = 'Hub is suspended, so the item goes back to the assignment queue.';

/** The smallest Response the client touches: ok, status, json(). */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the failure vocabulary never presents a refusal as an outcome', () => {
  it('classifies a status into one kind, with 5xx as server and the rest as invalid', () => {
    expect(errorKindForStatus(401)).toBe('unauthorized');
    expect(errorKindForStatus(403)).toBe('forbidden');
    expect(errorKindForStatus(500)).toBe('server');
    expect(errorKindForStatus(503)).toBe('server');
    expect(errorKindForStatus(400)).toBe('invalid');
    expect(errorKindForStatus(409)).toBe('invalid');
  });

  it('gives every failed READ one fixed sentence, and each one says nothing changed', () => {
    expect(queueReadFailureMessageForStatus(401)).toContain('session has expired');
    expect(queueReadFailureMessageForStatus(403)).toContain('not an administrator');
    expect(queueReadFailureMessageForStatus(404)).toContain('not available on this build');
    expect(queueReadFailureMessageForStatus(500)).toContain('Nothing was changed by this read');
    expect(queueReadFailureMessageForStatus(400)).toBe('The stranded-item queue could not be read.');
  });

  it('repeats the server’s own refusal sentence for a 400/409, and closes it', () => {
    const serverSentence = 'This item was recorded as received by the hub.';
    const message = releaseFailureMessageForStatus(409, serverSentence);
    expect(message).toContain(serverSentence);
    expect(message).toContain('Nothing was released.');
  });

  it('still refuses unambiguously when the server wrote no sentence', () => {
    const conflict = releaseFailureMessageForStatus(409, null);
    expect(conflict).toContain('custody or holder changed');
    expect(conflict).toContain('Nothing was released.');
    expect(conflict).toContain('Re-read the queue');

    expect(releaseFailureMessageForStatus(400, '')).toBe(
      'The server refused this release. Nothing was released.',
    );
    // A 5xx is the one case where the outcome is genuinely unknown, and it says so.
    const server = releaseFailureMessageForStatus(502, null);
    expect(server).toContain('Nothing was confirmed as released');
    expect(server).toContain('re-read the queue');
    expect(releaseFailureMessageForStatus(401)).toContain('session has expired');
    expect(releaseFailureMessageForStatus(403)).toContain('not an administrator');
    expect(releaseFailureMessageForStatus(404)).toContain('no longer exists');
  });

  it('never uses the word "released" as a bare past-tense claim on a failure', () => {
    for (const status of [400, 401, 403, 404, 409, 410, 422, 500, 502]) {
      const message = releaseFailureMessageForStatus(status, null);
      expect(message).not.toMatch(/(?:has|was) been released|successfully/i);
    }
  });
});

describe('a reason that fails the shared policy never leaves the browser', () => {
  it('refuses a blank, too-short or personal-data reason without any request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const cases: Array<[string, string]> = [
      ['', 'A reason is required'],
      ['   ', 'A reason is required'],
      ['n/a', 'at least 10 characters'],
      ['Call the owner on 0712 345 678 about this.', 'personal details'],
    ];

    for (const [reason, expected] of cases) {
      await expect(releaseStrandedItem('token', 'item-1', reason)).rejects.toBeInstanceOf(
        AdminStrandedItemsApiError,
      );
      await expect(releaseStrandedItem('token', 'item-1', reason)).rejects.toMatchObject({
        kind: 'invalid',
        status: 0,
      });
      await expect(releaseStrandedItem('token', 'item-1', reason)).rejects.toThrow(expected);
    }

    // Not one request was attempted: the shared validator refused all of them.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a missing item id before it reads the reason', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(releaseStrandedItem('token', '   ', VALID_REASON)).rejects.toThrow(
      'An item id is required',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});


describe('the read refuses to call an unreadable payload an empty queue', () => {
  it('throws malformed when `rows` is not a list, instead of reporting zero stranded items', () => {
    for (const body of [{}, { rows: null }, { rows: 'none' }, { rows: {} }, null, 'x']) {
      expect(() => readStrandedItemsQueue(body)).toThrow(AdminStrandedItemsApiError);
      try {
        readStrandedItemsQueue(body);
      } catch (error) {
        expect((error as AdminStrandedItemsApiError).kind).toBe('malformed');
      }
    }
  });

  it('counts the rows it could not read instead of dropping them', () => {
    const read = readStrandedItemsQueue({
      rows: [
        DEFAULT_DTO,
        { ...DEFAULT_DTO, item_id: '' },        // no item id
        { ...DEFAULT_DTO, agent_id: null },      // no holder
        { ...DEFAULT_DTO, status: undefined },   // no status
      ],
      headline: '2 items are stranded at hubs that cannot act.',
      generated_at: '2026-10-31T09:00:00.000Z',
      totals: { stranded: 2, releasable: 1, custody_review_required: 1, hubs: 1 },
    });

    expect(read.rows).toHaveLength(1);
    expect(read.unreadableRows).toBe(3);
    expect(read.headline).toContain('2 items are stranded');
    expect(read.generatedAt).toBe('2026-10-31T09:00:00.000Z');
    expect(read.totals).toEqual({
      stranded: 2,
      releasable: 1,
      custodyReviewRequired: 1,
      hubs: 1,
    });
  });

  it('reports no totals at all rather than inventing zeros', () => {
    expect(readStrandedQueueTotals({ stranded: 0 })).toBeNull();
    expect(
      readStrandedQueueTotals({ stranded: -1, releasable: 0, custody_review_required: 0, hubs: 0 }),
    ).toBeNull();
    expect(
      readStrandedQueueTotals({ stranded: '0', releasable: 0, custody_review_required: 0, hubs: 0 }),
    ).toBeNull();
    expect(readStrandedQueueTotals(null)).toBeNull();
    const read = readStrandedItemsQueue({ rows: [] });
    expect(read.totals).toBeNull();
    expect(read.headline).toBeNull();
    // An empty LIST is a readable answer, and the only case where "none" is claimed.
    expect(read.rows).toHaveLength(0);
    expect(read.unreadableRows).toBe(0);
  });


  it('reads the queue with GET and the session token, from the one path this module owns', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { rows: [DEFAULT_DTO] }));
    vi.stubGlobal('fetch', fetchMock);

    const read = await fetchStrandedItemsQueue('session-token');

    expect(read.rows).toHaveLength(1);
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe(STRANDED_ITEMS_QUEUE_PATH);
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ Authorization: 'Bearer session-token' });
  });

  it('turns a failed read into the fixed sentence for that status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(403, { error: 'nope' })));
    await expect(fetchStrandedItemsQueue('session-token')).rejects.toMatchObject({
      kind: 'forbidden',
      status: 403,
      message: queueReadFailureMessageForStatus(403),
    });
  });

  it('lets a cancelled read stay silent, and names an unreachable server as unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue({ name: 'AbortError' }));
    const aborted = await fetchStrandedItemsQueue('session-token').catch((error) => error);
    expect(aborted).toBeInstanceOf(AdminStrandedItemsApiError);
    expect(aborted.isAbort).toBe(true);

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(fetchStrandedItemsQueue('session-token')).rejects.toMatchObject({
      kind: 'network',
      status: 0,
    });
  });
});

describe('the release calls ONE audited primitive and relays its answer verbatim', () => {
  it('posts the trimmed reason to the single-item unassign path', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { message: 'Item returned to the assignment queue.' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await releaseStrandedItem('session-token', ' item-1 ', `  ${VALID_REASON}  `);

    expect(result).toEqual({
      itemId: 'item-1',
      message: 'Item returned to the assignment queue.',
    });
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/admin/items/item-1/unassign');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ reason: VALID_REASON });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('percent-encodes the item id so an id cannot reshape the route', () => {
    expect(buildItemUnassignPath('a/b?c=d')).toBe('/api/admin/items/a%2Fb%3Fc%3Dd/unassign');
    expect(buildItemUnassignPath('item-1')).toBe('/api/admin/items/item-1/unassign');
  });
});


describe('a server refusal is surfaced, an unknown outcome is said out loud', () => {
  it('carries the server sentence for a 409 and closes it with "Nothing was released."', async () => {
    const serverSentence = 'This item is recorded as received at the hub and cannot be released.';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(409, { error: serverSentence })));

    const error = await releaseStrandedItem('session-token', 'item-1', VALID_REASON)
      .then(() => null)
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(AdminStrandedItemsApiError);
    expect(error.status).toBe(409);
    expect(error.message).toContain(serverSentence);
    expect(error.message).toContain('Nothing was released.');
  });

  it('caps an over-long server sentence instead of pasting a payload into the banner', async () => {
    const longSentence = `${'x'.repeat(400)}`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(400, { error: longSentence })));
    const error = await releaseStrandedItem('session-token', 'item-1', VALID_REASON)
      .then(() => null)
      .catch((caught) => caught);
    expect(error.message.length).toBeLessThan(420);
    expect(error.message).toContain('...');
  });

  it('says the outcome is UNKNOWN when a 2xx body cannot be read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('not json');
        },
      } as unknown as Response),
    );

    const error = await releaseStrandedItem('session-token', 'item-1', VALID_REASON)
      .then(() => null)
      .catch((caught) => caught);

    expect(error.kind).toBe('malformed');
    expect(error.message).toContain('may already have been applied');
    expect(error.message).toContain('Re-read the queue');
  });
});

describe('the section is reachable from the admin console', () => {
  const ADMIN_VIEW = readFileSync(
    path.resolve(process.cwd(), 'src/components/AdminView.tsx'),
    'utf8',
  );

  it('is registered exactly once, in the Operations group', () => {
    const occurrences = ADMIN_NAV_GROUPS
      .flatMap((group) => group.items.map((item) => ({ group: group.label, id: item.id })))
      .filter((item) => item.id === 'stranded_items');
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].group).toBe('Operations');
  });

  it('is mounted by AdminView behind its own tab, and nowhere else', () => {
    expect(ADMIN_VIEW).toContain("from './admin/stranded/StrandedItemsQueueSection'");
    expect(ADMIN_VIEW).toMatch(/\|\s*'stranded_items'/);
    expect(ADMIN_VIEW).toContain("{activeTab === 'stranded_items' && (");
    expect(ADMIN_VIEW).toContain('<StrandedItemsQueueSection token={token} />');
    expect(ADMIN_VIEW).toContain("onClick={() => setActiveTab('stranded_items')}");
  });

  it('mounts the panel exactly once and passes it nothing but the session token', () => {
    // The panel owns every request and every confirmation; the view only selects it.
    expect(ADMIN_VIEW.match(/<StrandedItemsQueueSection/g)).toHaveLength(1);
    expect(ADMIN_VIEW).toContain('<StrandedItemsQueueSection token={token} />');
  });
});
