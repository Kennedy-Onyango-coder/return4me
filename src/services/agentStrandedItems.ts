// =============================================================================
// STAGE 3B-6B — ITEMS STRANDED AT AN AGENT WHO CAN NO LONGER ACT.
//
// THE PROBLEM
// -----------
// Suspending an agent (or an agent whose email was never verified) makes them
// ineligible for new work — `isAgentActionable()` and `requireActiveAgent` close
// every agent route — but it does NOT move the items already pointing at them.
// Those items keep `assigned_agent_id = <that hub>` and status `awaiting_dropoff`,
// so:
//
//   * the finder is told their item has a drop-off point that will never accept
//     it;
//   * the item is invisible in the manual-assignment queue, because
//     `needs_manual_agent_reassignment` is false;
//   * nothing in the console says so — the suspension response was silent.
//
// This module answers ONE question, purely and without a database: given the
// items currently pointing at an agent, which of them can be returned to the
// queue safely right now, and which must NOT be touched?
//
// WHY THE SPLIT IS NOT COSMETIC
// -----------------------------
// Stage 3B-3's custody policy (config/itemAgentAssignmentPolicy.ts) refuses to
// remove the holder of an item a hub has already physically received
// (`at_agent`), or of a claimed item. That refusal is correct here too: dropping
// the assignment of an item that is physically on that hub's shelf would erase
// the only record of where the item is. So an `at_agent` item stranded at a
// suspended hub is reported SEPARATELY as needing a custody decision, and the
// release action never offers it.
//
// WHAT THIS IS NOT
// ----------------
//   * It does NOT decide eligibility (isAgentActionable() does), does NOT write
//     anything, and does NOT itself perform a reassignment.
//   * It does NOT transfer custody, and does not pretend the platform has a
//     custody-transfer feature. It only classifies.
//   * It NEVER invents a replacement agent. Releasing an item returns it to the
//     manual queue; a human chooses the next hub.
// =============================================================================

import type { FoundItem } from '../db/database';
import { describeManualUnassignmentRefusal } from '../config/itemAgentAssignmentPolicy';

/** One stranded item, described for the console. No finder identity, no hash. */
export interface StrandedItemView {
  item_id: string;
  status: string;
  county: string | null;
  administrative_unit_id: string | null;
  location_description: string | null;
  /** True when the Stage 3B-3 policy allows the holder to be removed now. */
  releasable: boolean;
  /** Why it cannot be released, or null when it can. Safe to show verbatim. */
  refusal: string | null;
}

export interface StrandedItemsSummary {
  agent_id: string;
  /** `awaiting_dropoff` items: nothing is physically held, safe to release. */
  releasable: StrandedItemView[];
  /** Items a hub has already received — reported, never silently unassigned. */
  held_at_hub: StrandedItemView[];
  /** Claimed / expired / frozen / unsupported statuses — no action here. */
  other: StrandedItemView[];
  total: number;
}

/** Describes one item through the shared custody policy rather than a local rule. */
export function describeStrandedItem(item: FoundItem): StrandedItemView {
  const refusal = describeManualUnassignmentRefusal(item?.status);
  return {
    item_id: item?.id ?? '',
    status: typeof item?.status === 'string' ? item.status : '',
    county: item?.found_county ?? null,
    administrative_unit_id: item?.administrative_unit_id ?? null,
    location_description:
      typeof item?.location_description === 'string' ? item.location_description : null,
    releasable: refusal === null,
    refusal,
  };
}

/**
 * Classifies every item currently assigned to an agent.
 *
 * The caller passes the rows it read (see db.getItemsAssignedToAgent); anything
 * in that list assigned to a DIFFERENT agent is ignored, so a caller that
 * fetched too much cannot mis-report another hub's work as stranded.
 */
export function summariseStrandedItems(items: FoundItem[], agentId: string): StrandedItemsSummary {
  const owned = (Array.isArray(items) ? items : []).filter(
    (item) => item && agentId && item.assigned_agent_id === agentId,
  );

  const releasable: StrandedItemView[] = [];
  const heldAtHub: StrandedItemView[] = [];
  const other: StrandedItemView[] = [];

  for (const item of owned) {
    const view = describeStrandedItem(item);
    if (view.releasable) releasable.push(view);
    else if (item.status === 'at_agent') heldAtHub.push(view);
    else other.push(view);
  }

  return {
    agent_id: agentId,
    releasable,
    held_at_hub: heldAtHub,
    other,
    total: owned.length,
  };
}

/**
 * The sentence the suspension response and the console both use. States counts
 * and the rule; never implies the platform moved anything.
 */
export function describeStrandedItemsHeadline(summary: StrandedItemsSummary): string {
  const total = summary?.total ?? 0;
  if (total === 0) {
    return 'This Agent hub holds no items, so nothing is stranded by this suspension.';
  }

  const releasable = summary.releasable.length;
  const held = summary.held_at_hub.length;
  const parts: string[] = [];

  if (releasable > 0) {
    parts.push(
      `${releasable} item${releasable === 1 ? '' : 's'} still waiting for drop-off can be returned to the assignment queue`,
    );
  }
  if (held > 0) {
    parts.push(
      held === 1
        ? '1 item has already been received by this hub and needs a separate custody decision'
        : `${held} items have already been received by this hub and need a separate custody decision`,
    );
  }
  if (parts.length === 0) {
    return `This Agent hub has ${total} item${total === 1 ? '' : 's'} on record, none of which can be released from here.`;
  }
  return `${parts.join('; ')}.`;
}
