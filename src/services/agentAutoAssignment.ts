// =============================================================================
// BATCH B — AUTOMATIC MATCHING FOR A NEWLY OPERATIONAL AGENT.
//
// THE REAL-WORLD GAP THIS CLOSES
//   1. A finder reports an item.
//   2. No eligible agent is available, so the report flow writes
//      `assigned_agent_id = NULL` and `needs_manual_agent_reassignment = true`,
//      and the item enters the admin manual-assignment queue.
//   3. The admin does not get to it.
//   4. Later — days later — a new agent finishes onboarding and becomes
//      operational.
//
//   Before this module, that agent's arrival changed NOTHING for the items already
//   sitting in the queue: the only way out was an admin opening the console. This
//   module is the missing link. It runs at the moment an agent becomes
//   operational, re-runs the REAL matcher over the REAL manual queue, and assigns
//   anything that can now be matched.
//
// WHAT IT DELIBERATELY REUSES (and never duplicates)
//   * services/agent.ts — AgentMatchingService.assignNearestAgent() is THE only
//     matching implementation: it owns county scoping, sub-county preference,
//     Haversine distance, the geocoding fallback, the radius seam and
//     deterministic tie-breaking. Nothing here recomputes a distance or ranks
//     candidates, so the decision this module makes is exactly the decision the
//     finder-report flow would have made in the same conditions.
//   * services/auth.ts — isAgentActionable() is THE operational predicate that
//     gates every protected agent route. It is re-used, not re-derived: if this
//     module considered an agent operational whom requireActiveAgent would
//     refuse, it would hand work to an account the rest of the system treats as
//     not operational.
//   * db.attemptAutoAgentAssignment() — THE atomic primitive. See below.
//
// CONCURRENCY (two agents becoming operational at once)
//   The match decision is taken per item, and then made conditional at the
//   database: `attemptAutoAgentAssignment` re-states the preconditions in the
//   UPDATE's WHERE clause and reports whether THIS call was the one that wrote.
//   Two overlapping runs therefore produce exactly ONE assignment per item — the
//   loser gets `false` and moves on, leaving the winner's row untouched. No item
//   is ever assigned twice, and no assignment is overwritten.
//
// WHICH ITEMS ARE ELIGIBLE (the lifecycle contract, not a guess)
//   Only rows that BOTH the queue query and the CAS agree are waiting:
//     status = 'awaiting_dropoff'                (not at_agent / claimed / expired
//                                                 / rejected / suspected_stolen /
//                                                 legal_hold)
//     needs_manual_agent_reassignment = true     (genuinely in the manual queue)
//     assigned_agent_id IS NULL                  (nobody holds it)
//   `assigned_agent_id IS NULL` alone is deliberately NOT the test — an item
//   whose owner has already paid also has no second agent, and re-pointing it
//   would be wrong.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO
//   * It is NOT a periodic sweep. There is no interval, no timer and no polling.
//     It runs only from the lifecycle points where an agent becomes operational.
//   * It never assigns an agent to an item in another agent's county: county
//     scoping happens inside the matcher, and when no in-scope agent exists the
//     matcher returns "manual" and the item stays in the queue.
//   * It never touches an item that already has an agent, and it never replaces
//     one agent with another.
// =============================================================================

import { db, type Agent, type FoundItem } from '../db/database.ts';
import { AgentMatchingService, type AgentAssignmentMethod } from './agent.ts';
import { isAgentActionable } from './auth.ts';
import { isValidCoordinatePair } from './coordinates.ts';
import { notifyAgentAssignedToItem } from './agentAssignmentNotifications.ts';

/**
 * A hard ceiling on how much work ONE lifecycle event may trigger.
 *
 * Each unmatched item can cost one outbound geocode request (the matcher's
 * second fallback), and the geocoding provider is an external, rate-limited
 * third party. Without a bound, approving one agent could fire an unbounded burst
 * of provider calls. Items beyond the ceiling simply stay in the manual queue —
 * which is where they already were — and are picked up by the next such event.
 */
const MAX_ITEMS_PER_TRIGGER = 200;

export interface AgentAutoAssignmentDeps {
  getAgent: (id: string) => Promise<Agent | undefined>;
  getItemsAwaitingManualAgentAssignment: () => Promise<FoundItem[]>;
  attemptAutoAgentAssignment: (
    itemId: string,
    agentId: string,
    method: string,
    distanceKm: number | null,
  ) => Promise<boolean>;
  matchAgent: typeof AgentMatchingService.assignNearestAgent;
  notify: typeof notifyAgentAssignedToItem;
}

const defaultDeps: AgentAutoAssignmentDeps = {
  getAgent: (id: string) => db.getAgent(id),
  getItemsAwaitingManualAgentAssignment: () => db.getItemsAwaitingManualAgentAssignment(),
  attemptAutoAgentAssignment: (itemId, agentId, method, distanceKm) =>
    db.attemptAutoAgentAssignment(itemId, agentId, method, distanceKm),
  matchAgent: AgentMatchingService.assignNearestAgent,
  notify: notifyAgentAssignedToItem,
};

export interface AutoAssignedItem {
  itemId: string;
  agentId: string;
  method: AgentAssignmentMethod;
  distanceKm: number | null;
}

export interface AgentAutoAssignmentOutcome {
  /** True when the agent was operational and had usable coverage at all. */
  evaluated: boolean;
  /** How many manual-queue items were actually put through the matcher. */
  considered: number;
  /** Items this run assigned. */
  assigned: AutoAssignedItem[];
  /** Items the matcher still could not confidently match (they stay queued). */
  stillUnmatched: number;
  /** True when MAX_ITEMS_PER_TRIGGER truncated the work. */
  truncated: boolean;
}

const NOTHING_DONE: AgentAutoAssignmentOutcome = {
  evaluated: false,
  considered: 0,
  assigned: [],
  stillUnmatched: 0,
  truncated: false,
};

/**
 * Does this agent have enough location/coverage data for the assignment
 * algorithm to be able to place them at all?
 *
 * Both halves are existing repository facts, not new requirements:
 *   * a valid coordinate pair is what the matcher's Haversine strategy (and its
 *     geocoding fallback) measure distance TO;
 *   * a county is what the matcher's candidate filter scopes BY.
 *
 * An agent with neither cannot be confidently matched to anything, so no item is
 * taken out of the manual queue on their behalf. The item keeps its existing
 * manual-link path — the queue is never emptied by guessing.
 */
function hasUsableCoverage(agent: Agent): boolean {
  if (isValidCoordinatePair(agent.latitude, agent.longitude)) return true;
  return typeof agent.county === 'string' && agent.county.trim() !== '';
}

/**
 * THE ENTRY POINT. Called at the exact point an agent becomes operational.
 *
 * NEVER throws: it is invoked from a route whose own success (an approval, a
 * verification, a location correction) must not be undone by a matching problem.
 * Every failure is logged and the caller's outcome stands.
 *
 * Returns a small, safe summary — item ids, the winning agent, the existing
 * assignment method and the distance — so the caller can audit what its lifecycle
 * event actually changed without re-reading the database.
 */
export async function matchPendingItemsForOperationalAgent(
  agentId: string,
  deps: AgentAutoAssignmentDeps = defaultDeps,
): Promise<AgentAutoAssignmentOutcome> {
  try {
    const agent = await deps.getAgent(agentId);
    if (!agent) return NOTHING_DONE;

    // THE OPERATIONAL GATE. Same predicate as requireActiveAgent: a 'pending'
    // applicant, a suspended hub, or an active agent whose new email address is
    // still unverified is NOT operational, and no item may be assigned to them.
    if (!isAgentActionable(agent)) return NOTHING_DONE;

    // THE COVERAGE GATE. No usable location means no confident match is possible,
    // and the manual queue must survive intact.
    if (!hasUsableCoverage(agent)) {
      console.log(
        `[AGENT AUTO-ASSIGNMENT] Agent ${agentId} is operational but has no usable location/coverage — items stay in the manual queue.`,
      );
      return { ...NOTHING_DONE, evaluated: true };
    }

    const queue = await deps.getItemsAwaitingManualAgentAssignment();
    const truncated = queue.length > MAX_ITEMS_PER_TRIGGER;
    const batch = truncated ? queue.slice(0, MAX_ITEMS_PER_TRIGGER) : queue;
    if (truncated) {
      console.log(
        `[AGENT AUTO-ASSIGNMENT] Manual queue holds ${queue.length} items; evaluating the first ${MAX_ITEMS_PER_TRIGGER}. The remainder stay queued.`,
      );
    }

    const assigned: AutoAssignedItem[] = [];
    let stillUnmatched = 0;

    for (const item of batch) {
      // THE SAME DECISION FUNCTION THE REPORT FLOW USES. County scoping,
      // sub-county preference, distance, the geocoding fallback, the radius seam
      // and tie-breaking all belong to the matcher — not to this loop.
      const match = await deps.matchAgent(
        item.latitude,
        item.longitude,
        item.location_description,
        item.found_county,
        item.administrative_unit_id,
      );

      if (!match.agent) {
        stillUnmatched++;
        continue;
      }

      // ATOMIC. Anything other than `true` means another concurrent assignment
      // won this item, so it must be left exactly as the winner left it and must
      // NOT be notified about again.
      const won = await deps.attemptAutoAgentAssignment(
        item.id,
        match.agent.id,
        match.method,
        match.distanceKm,
      );
      if (!won) continue;

      assigned.push({
        itemId: item.id,
        agentId: match.agent.id,
        method: match.method,
        distanceKm: match.distanceKm,
      });

      // ONLY AFTER THE ASSIGNMENT HAS COMMITTED, and with the agent who actually
      // won — which is not necessarily the agent whose arrival triggered this run.
      await deps.notify({ item, agent: match.agent, trigger: 'agent_now_operational' });
    }

    return {
      evaluated: true,
      considered: batch.length,
      assigned,
      stillUnmatched,
      truncated,
    };
  } catch (error) {
    console.error(`[AGENT AUTO-ASSIGNMENT] Matching failed for agent ${agentId}:`, error);
    return NOTHING_DONE;
  }
}

