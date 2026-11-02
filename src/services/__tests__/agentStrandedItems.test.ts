import { describe, expect, it } from 'vitest';
import type { FoundItem } from '../../db/database';
import {
  describeStrandedItem,
  describeStrandedItemsHeadline,
  summariseStrandedItems,
} from '../agentStrandedItems';
import { describeManualUnassignmentRefusal } from '../../config/itemAgentAssignmentPolicy';

// =============================================================================
// STAGE 3B-6B — CLASSIFYING THE ITEMS A HUB CAN NO LONGER RECEIVE (PURE).
//
// The classification must come from the ONE custody policy
// (config/itemAgentAssignmentPolicy.ts), not from a list repeated here, so these
// tests assert the correspondence directly: an item is "releasable" exactly when
// the unassignment policy raises no refusal for its status.
//
// WHAT THEY PIN
//   * only `awaiting_dropoff` items are releasable;
//   * an item already received by the hub is reported SEPARATELY and is never
//     offered for release (removing its holder would erase where the item is);
//   * claimed / expired / frozen items are reported as unaffected;
//   * another hub's items are never counted;
//   * the console view carries no finder identity.
// =============================================================================

let counter = 0;

function item(status: FoundItem['status'], overrides: Partial<Record<string, unknown>> = {}): FoundItem {
  const id = `ITM-${counter++}`;
  return {
    id,
    category_id: 'phone',
    photo_url: 'https://example.test/photo.jpg',
    ocr_extracted_number: null,
    ocr_extracted_name: null,
    document_number_hash: null,
    document_name_fuzzy: null,
    location_description: 'Near the Market, Nairobi',
    latitude: null,
    longitude: null,
    found_county: 'Nairobi City',
    administrative_unit_id: 'KE-47-SC-01',
    finder_phone: '+254700111222',
    assigned_agent_id: 'AGENT-1',
    status,
    flaggedForReview: false,
    isDescriptionOnly: false,
    description: null,
    is_sensitive_document: false,
    rejection_reason: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as FoundItem;
}

const ALL_STATUSES: FoundItem['status'][] = [
  'awaiting_dropoff',
  'at_agent',
  'claimed',
  'expired',
  'rejected',
  'suspected_stolen',
  'legal_hold',
];

describe('B6-B — releasability is the custody policy’s answer, not a second list', () => {
  it('agrees with describeManualUnassignmentRefusal for every item status', () => {
    for (const status of ALL_STATUSES) {
      const view = describeStrandedItem(item(status));
      const policyRefusal = describeManualUnassignmentRefusal(status);
      expect(view.releasable, `status=${status}`).toBe(policyRefusal === null);
      expect(view.refusal, `status=${status}`).toBe(policyRefusal);
    }
  });

  it('offers only awaiting_dropoff items for release', () => {
    const summary = summariseStrandedItems(ALL_STATUSES.map((status) => item(status)), 'AGENT-1');
    expect(summary.releasable.map(entry => entry.status)).toEqual(['awaiting_dropoff']);
    expect(summary.held_at_hub.map(entry => entry.status)).toEqual(['at_agent']);
    expect(summary.other.map(entry => entry.status)).toEqual([
      'claimed',
      'expired',
      'rejected',
      'suspected_stolen',
      'legal_hold',
    ]);
    expect(summary.total).toBe(ALL_STATUSES.length);
  });

  it('never offers to release an item the hub already physically received', () => {
    const summary = summariseStrandedItems([item('at_agent')], 'AGENT-1');
    expect(summary.releasable).toHaveLength(0);
    expect(summary.held_at_hub).toHaveLength(1);
    // The refusal text is the shared policy's, so the console and the unassign
    // route cannot disagree about why it is not offered.
    expect(summary.held_at_hub[0].refusal).toContain('physically held');
  });

  it('ignores items assigned to a different hub', () => {
    const summary = summariseStrandedItems(
      [item('awaiting_dropoff', { assigned_agent_id: 'AGENT-2' }), item('awaiting_dropoff')],
      'AGENT-1',
    );
    expect(summary.total).toBe(1);
    expect(summary.releasable).toHaveLength(1);
  });

  it('reports an empty hub plainly', () => {
    const summary = summariseStrandedItems([], 'AGENT-1');
    expect(summary.total).toBe(0);
    expect(summary.releasable).toHaveLength(0);
    expect(describeStrandedItemsHeadline(summary)).toContain('no items');
  });

  it('survives a missing agent id or a malformed list without inventing items', () => {
    expect(summariseStrandedItems([item('awaiting_dropoff')], '').total).toBe(0);
    expect(summariseStrandedItems(null as any, 'AGENT-1').total).toBe(0);
  });
});


describe('B6-B — the console view carries no finder identity', () => {
  it('exposes id, status, county and location only', () => {
    const view = describeStrandedItem(item('awaiting_dropoff'));
    expect(Object.keys(view).sort()).toEqual(
      [
        'administrative_unit_id',
        'county',
        'item_id',
        'location_description',
        'refusal',
        'releasable',
        'status',
      ].sort(),
    );
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain('+254700111222');
    expect(serialised).not.toContain('finder');
    expect(serialised).not.toContain('document_number_hash');
  });
});

describe('B6-B — the headline states counts and never implies the platform moved anything', () => {
  it('distinguishes releasable items from items the hub already holds', () => {
    const headline = describeStrandedItemsHeadline(
      summariseStrandedItems([item('awaiting_dropoff'), item('at_agent')], 'AGENT-1'),
    );
    expect(headline).toContain('1 item');
    expect(headline).toContain('returned to the assignment queue');
    expect(headline).toContain('custody decision');
  });

  it('states the custody problem when only received items exist', () => {
    const headline = describeStrandedItemsHeadline(
      summariseStrandedItems([item('at_agent')], 'AGENT-1'),
    );
    expect(headline).toBe(
      '1 item has already been received by this hub and needs a separate custody decision.',
    );
  });
});
