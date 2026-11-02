// =============================================================================
// STAGE 3B-6B — THE ADMINISTRATOR'S STRANDED-ITEM QUEUE (PURE CLASSIFIER).
//
// THE PROBLEM THIS SOLVES
// -----------------------
// Suspending a hub (or leaving a new hub's email unverified) makes it
// non-actionable: `isAgentActionable()` is false, `requireActiveAgent` closes
// every agent route, and no finder can drop off there. But nothing moves the
// items already pointing at it. They keep `assigned_agent_id = <that hub>` and
// `awaiting_dropoff`, so the finder waits for a drop-off that can never happen —
// and because `needs_manual_agent_reassignment` is still false, the item is
// invisible in the manual-assignment queue too.
//
// Stage 3B-6B's per-agent panel answered this for ONE hub an administrator
// already suspected (services/agentStrandedItems.ts +
// GET /api/admin/agents/:id/stranded-items). The gap that remained was
// DISCOVERY: a suspended hub is exactly the hub nobody opens. This module
// classifies the whole platform's waiting items in one pass, so the console can
// show a queue of everything stranded anywhere, most dangerous first.
//
// WHAT IT DECIDES, AND WHAT IT REFUSES TO DECIDE
// ----------------------------------------------
//   * WHO CANNOT ACT — never this module. It asks `isAgentActionable()`, the
//     single eligibility authority, which also consults the independent
//     email-verification axis. An item whose holder IS actionable is excluded:
//     an active hub's waiting items are ordinary work, not a stranded queue.
//   * WHAT MAY BE RELEASED — never this module's opinion either. It asks
//     `describeManualUnassignmentRefusal()`, the Stage 3B-3 custody policy that
//     the unassignment primitive enforces inside its own transaction. So a row
//     this module calls `releasable` is exactly a row the primitive would accept,
//     and a row it calls held is exactly a row the primitive refuses.
//   * IT NEVER WRITES. There is no database handle in this file, no status
//     change, no custody transfer and no reassignment. It returns a description.
//
// THE ONE THING AN OPERATOR MUST NOT MISREAD
// ------------------------------------------
// A suspended hub has NOT thereby handed over the items it physically holds. An
// `at_agent` item is still on that hub's shelf; suspending the account changed
// nothing about where the object is. Those rows are therefore reported as
// `custody: 'received_at_hub'` with `review_required: true` and are never
// offered as releasable. Clearing the holder of such an item would erase the only
// record of where the item physically is — the exact misrepresentation the
// custody policy exists to prevent.
//
// PRIVACY. A row carries the item id, its lifecycle status, its county and
// sub-county, the HUB's public business name and standing, and timestamps. It
// never carries finder identity, a phone number, an email address, a document
// hash, a photo or a coordinate pair. Lost-report privacy is untouched because
// nothing here reads a lost report at all.
// =============================================================================

import type { Agent, FoundItem, ItemAgentAssignment } from '../db/database';
import {
  describeManualUnassignmentRefusal,
  isItemStatusAwaitingAgentAction,
} from '../config/itemAgentAssignmentPolicy';
import { isAgentActionable } from './auth';

/** Where the item physically is, as far as the platform's own data can say. */
export type StrandedCustodyState =
  /** Nothing has been received at the hub: the holder can be removed safely. */
  | 'not_yet_received'
  /** The hub has received the item. Only a human can resolve this. */
  | 'received_at_hub';

/** The hub fields the queue is allowed to show. Deliberately a narrow slice of Agent. */
export interface StrandedQueueAgent {
  id: string;
  business_name?: string | null;
  status?: string | null;
  email_verified_at?: string | Date | null;
  contact_email?: string | null;
  county?: string | null;
  administrative_unit_id?: string | null;
}
/** One stranded item, ready to render. No finder identity, no hash, no coordinates. */
export interface StrandedQueueRow {
  item_id: string;
  status: string;
  /** The item's declared county, as stored (never re-guessed here). */
  county: string | null;
  administrative_unit_id: string | null;

  agent_id: string;
  /** The hub's public business name, or null when the agent row is missing. */
  agent_business_name: string | null;
  /** The hub's stored status ('active' | 'pending' | 'suspended'), or 'unknown'. */
  agent_status: string;
  /** `isAgentActionable()`'s answer for the holder. Always false in this queue. */
  agent_actionable: boolean;
  /** False when the holder's agent row could not be read — a data-integrity flag. */
  agent_found: boolean;

  /** The newest committed assignment event's timestamp, or null when none exists. */
  assigned_at: string | null;
  /** Whole hours since that assignment, or null when the age is genuinely unknown. */
  assignment_age_hours: number | null;

  custody: StrandedCustodyState;
  /** Operator-facing sentence about custody. Safe to render verbatim. */
  custody_note: string;
  /** True only when the Stage 3B-3 custody policy would accept the removal now. */
  releasable: boolean;
  /** The policy's refusal, or null when releasable. Safe to render verbatim. */
  refusal: string | null;
  /** True when a human decision is required before anything is changed. */
  review_required: boolean;
}

export interface StrandedQueueTotals {
  /** Rows in the queue. */
  stranded: number;
  /** Rows whose holder can be removed today (status `awaiting_dropoff`). */
  releasable: number;
  /** Rows that need a human custody decision (status `at_agent`, or unreadable). */
  custody_review_required: number;
  /** Distinct hubs represented. */
  hubs: number;
}

export interface StrandedItemsQueue {
  generated_at: string;
  rows: StrandedQueueRow[];
  totals: StrandedQueueTotals;
  headline: string;
}

export interface StrandedQueueBuildInput {
  /** Candidate rows. See db.getItemsAwaitingAgentAction(). */
  items: FoundItem[] | null | undefined;
  /** The holders, as read for the candidates. A Map is accepted for large sets. */
  agents: StrandedQueueAgent[] | Map<string, StrandedQueueAgent> | null | undefined;
  /** Newest assignment event per item. See db.getLatestAssignmentEventsForItems(). */
  latestEvents?: Map<string, ItemAgentAssignment> | null;
  /** Injected clock, so an age assertion cannot depend on wall time. */
  now?: Date | string | null;
}

const MISSING_AGENT_CUSTODY_NOTE =
  'The assigned hub record could not be read, so the platform cannot say whether this item was ever received. Treat physical custody as unknown.';

const NOT_YET_RECEIVED_CUSTODY_NOTE =
  'Nothing has been received at the hub yet. The assignment can be returned to the queue without changing the item, but first confirm the finder has not already handed it over.';

const RECEIVED_AT_HUB_CUSTODY_NOTE =
  'The hub has already received this item. Removing the holder here would erase the only record of where it physically is, so this needs a human custody decision before any change.';

/** Reads a clock input, tolerating a bad value rather than producing NaN ages. */
function resolveNow(now: Date | string | null | undefined): Date {
  if (now instanceof Date && !Number.isNaN(now.getTime())) return now;
  if (typeof now === 'string') {
    const parsed = new Date(now);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

/**
 * Whole hours between an assignment event and `now`.
 *
 * Null when the timestamp is absent or unreadable, and clamped at zero: a clock
 * skew must never render as a negative age, and an unknown age must never render
 * as a confident "0 hours".
 */
export function assignmentAgeHours(assignedAt: string | null | undefined, now: Date): number | null {
  if (typeof assignedAt !== 'string' || assignedAt === '') return null;
  const assigned = new Date(assignedAt);
  if (Number.isNaN(assigned.getTime())) return null;
  const elapsedMs = now.getTime() - assigned.getTime();
  if (!Number.isFinite(elapsedMs)) return null;
  return Math.max(0, Math.floor(elapsedMs / 3_600_000));
}

/** Indexes the holder rows by id, accepting either shape a caller has to hand. */
function indexAgents(
  agents: StrandedQueueAgent[] | Map<string, StrandedQueueAgent> | null | undefined,
): Map<string, StrandedQueueAgent> {
  const index = new Map<string, StrandedQueueAgent>();
  if (!agents) return index;
  const entries: Iterable<StrandedQueueAgent> =
    agents instanceof Map ? agents.values() : Array.isArray(agents) ? agents : [];
  for (const agent of entries) {
    if (agent && typeof agent.id === 'string' && agent.id !== '') {
      index.set(agent.id, agent);
    }
  }
  return index;
}

/**
 * Asks the eligibility authority whether this holder can act.
 *
 * The narrow holder shape is widened to `isAgentActionable()`'s contract HERE
 * rather than in the policy: an absent status is passed as a value the authority
 * already fails closed on, never defaulted to 'active'. No eligibility rule is
 * restated — this is a type-level adapter and nothing else.
 */
function holderIsActionable(agent: StrandedQueueAgent | undefined | null): boolean {
  if (!agent) return false;
  return isAgentActionable({
    status: typeof agent.status === 'string' ? agent.status : '',
    email_verified_at: agent.email_verified_at ?? null,
    contact_email: agent.contact_email ?? null,
  });
}

/**
 * Builds the whole queue from rows the caller already read.
 *
 * The caller supplies data; every DECISION made here is delegated to the shared
 * predicates, so this function cannot become a second policy.
 */
export function buildStrandedItemsQueue(input: StrandedQueueBuildInput): StrandedItemsQueue {
  const now = resolveNow(input.now);
  const agentIndex = indexAgents(input.agents);
  const latestEvents = input.latestEvents instanceof Map ? input.latestEvents : new Map();

  const rows: StrandedQueueRow[] = [];
  const candidates = Array.isArray(input.items) ? input.items : [];

  for (const item of candidates) {
    if (!item || typeof item.id !== 'string' || item.id === '') continue;

    const agentId = typeof item.assigned_agent_id === 'string' ? item.assigned_agent_id : '';
    // No holder means no stranded assignment. An item already returned to the
    // manual queue is deliberately excluded: clearing the holder is what the
    // review action DOES, so re-listing it would make the queue unable to empty.
    if (agentId === '') continue;
    if (item.needs_manual_agent_reassignment === true) continue;
    // Defensive: the query already filters, but a caller that passes too much
    // must not turn a claimed or frozen item into a queue entry.
    if (!isItemStatusAwaitingAgentAction(item.status)) continue;

    const agent = agentIndex.get(agentId);
    // THE ELIGIBILITY DECISION — the shared authority's answer, never a local one.
    if (holderIsActionable(agent)) continue;

    const refusal = describeManualUnassignmentRefusal(item.status);
    // Without a readable holder there is nothing to compare a compare-and-swap
    // against, so the row is shown and reviewed but never offered for release.
    const releasable = Boolean(agent) && refusal === null;
    const custody: StrandedCustodyState =
      item.status === 'at_agent' ? 'received_at_hub' : 'not_yet_received';
    const custodyNote = !agent
      ? MISSING_AGENT_CUSTODY_NOTE
      : custody === 'received_at_hub'
        ? RECEIVED_AT_HUB_CUSTODY_NOTE
        : NOT_YET_RECEIVED_CUSTODY_NOTE;

    const latestEvent = latestEvents.get(item.id) ?? null;
    const assignedAt = latestEvent?.created_at ?? null;

    rows.push({
      item_id: item.id,
      status: typeof item.status === 'string' ? item.status : '',
      county: item.found_county ?? null,
      administrative_unit_id: item.administrative_unit_id ?? null,

      agent_id: agentId,
      agent_business_name: agent?.business_name ?? null,
      agent_status: typeof agent?.status === 'string' && agent.status !== '' ? agent.status : 'unknown',
      agent_actionable: holderIsActionable(agent),
      agent_found: Boolean(agent),

      assigned_at: assignedAt,
      assignment_age_hours: assignmentAgeHours(assignedAt, now),

      custody,
      custody_note: custodyNote,
      releasable,
      // An unreadable holder is reported as a refusal of its own: the console
      // must not offer a release it cannot justify from the hub's own record.
      refusal: agent ? refusal : MISSING_AGENT_CUSTODY_NOTE,
      review_required: !releasable,
    });
  }

  rows.sort(compareRows);

  const totals: StrandedQueueTotals = {
    stranded: rows.length,
    releasable: rows.filter((row) => row.releasable).length,
    custody_review_required: rows.filter((row) => row.review_required).length,
    hubs: new Set(rows.map((row) => row.agent_id)).size,
  };

  return {
    generated_at: now.toISOString(),
    rows,
    totals,
    headline: describeStrandedQueueHeadline(totals),
  };
}

/**
 * Most-dangerous first, then oldest first, then by id.
 *
 * Deterministic on purpose: two administrators looking at the same data must see
 * the same order, and a queue that reshuffles between refreshes is not
 * reviewable. Rows with an unknown age sort after dated ones of the same class,
 * because "we cannot say how long" is not the same as "just now".
 */
function compareRows(a: StrandedQueueRow, b: StrandedQueueRow): number {
  if (a.review_required !== b.review_required) return a.review_required ? -1 : 1;
  const ageA = a.assignment_age_hours;
  const ageB = b.assignment_age_hours;
  if (ageA === null && ageB !== null) return 1;
  if (ageA !== null && ageB === null) return -1;
  if (ageA !== null && ageB !== null && ageA !== ageB) return ageB - ageA;
  return a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : 0;
}

/**
 * The one sentence the queue's own header renders. States counts and the rule;
 * never implies the platform moved, released or reassigned anything.
 */
export function describeStrandedQueueHeadline(totals: StrandedQueueTotals): string {
  const stranded = totals?.stranded ?? 0;
  if (stranded === 0) {
    return 'No items are waiting at a hub that cannot act.';
  }

  const hubWord = totals.hubs === 1 ? 'hub' : 'hubs';
  const itemWord = stranded === 1 ? 'item is' : 'items are';
  const parts: string[] = [
    `${stranded} ${itemWord} waiting at ${totals.hubs} ${hubWord} that cannot act`,
  ];

  if (totals.releasable > 0) {
    parts.push(`${totals.releasable} can be returned to the assignment queue now`);
  }
  if (totals.custody_review_required > 0) {
    parts.push(
      totals.custody_review_required === 1
        ? '1 needs a human custody decision before anything is changed'
        : `${totals.custody_review_required} need a human custody decision before anything is changed`,
    );
  }

  return `${parts.join('; ')}.`;
}

/**
 * Whether this row may be offered the release action at all.
 *
 * Exported so the route and the console agree without re-deriving it, and so a
 * test can assert that a suspension by itself never opens the action for a
 * physically held item.
 */
export function canReleaseStrandedItem(row: StrandedQueueRow | null | undefined): boolean {
  return Boolean(row && row.releasable === true && row.review_required === false);
}

/** The narrow view of a hub the queue is allowed to return. Nothing else leaks. */
export function toStrandedQueueAgent(agent: Agent | null | undefined): StrandedQueueAgent | null {
  if (!agent || typeof agent.id !== 'string' || agent.id === '') return null;
  return {
    id: agent.id,
    business_name: agent.business_name ?? null,
    status: agent.status ?? null,
    email_verified_at: agent.email_verified_at ?? null,
    contact_email: agent.contact_email ?? null,
    county: agent.county ?? null,
    administrative_unit_id: agent.administrative_unit_id ?? null,
  };
}
