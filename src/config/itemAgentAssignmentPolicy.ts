// =============================================================================
// PHASE 16.1 BATCH 3 — STAGE 3B-2 — THE ITEM→AGENT ASSIGNMENT-HISTORY
// VOCABULARY, IN ONE PLACE.
//
// WHY THIS MODULE EXISTS
// ---------------------
// `items.assigned_agent_id` is written by three unrelated code paths
// (createItem() for a report-time match, attemptAutoAgentAssignment() for the
// guarded auto-assignment CAS, adminUpdateItem() for an administrator's manual
// decision) and the ONLY record of who held an item before was free-text audit
// prose ("agent changed from A to B"), which nothing can query, join or
// reconcile. Stage 3B-2 adds a dedicated append-only table,
// `item_agent_assignments`, that records each assignment as structured data.
//
// A CHECK constraint on that table has to be declared in THREE places in this
// repository — the Drizzle schema (src/db/schema.ts), the fresh-bootstrap
// script (sql/schema.sql) and the idempotent runtime DDL
// (ensureSchemaUpToDate() in src/db/index.ts) — and this codebase has already
// been bitten by exactly that kind of copy drifting (payout_repair_requests
// shipped with 22/23/24 columns in its three declarations). So the values are
// declared ONCE here and every declaration is generated from these lists, the
// same way src/config/payoutRepairPolicy.ts does it.
//
// WHY THE VOCABULARY IS CLOSED (and deliberately small)
// ----------------------------------------------------
//   event types   : assigned | reassigned | unassigned
//                   The first two describe an assignment mutation that leaves
//                   an agent holding the item; `unassigned` describes the one
//                   mutation that leaves nobody holding it. Stage 3B-2
//                   deliberately did NOT have that value because unassignment
//                   did not exist yet; Stage 3B-3 adds it together with the
//                   operation that writes it, so the vocabulary still never
//                   names a state change the application cannot perform.
//                   Nothing else is here: there is no `transferred`, no
//                   `custody_moved` and no `revoked`, because a physical
//                   handover is NOT implemented (see the custody policy below).
//   methods       : gps_haversine | geocoded_text | manual_override
//                   These are exactly the values services/agent.ts and the
//                   admin review route already persist in
//                   `items.agent_assignment_method`. `manual_required` is
//                   deliberately ABSENT: it names the absence of a match, so it
//                   can never describe a successful assignment.
//   triggers      : finder_report | agent_now_operational | admin_manual
//                   The three sources that can actually cause an assignment
//                   today, mirroring the notification vocabulary the same
//                   routes already use.
//   actor roles   : system | admin
//                   `system` covers the two automatic paths (no human actor, so
//                   actor_id is NULL); `admin` covers a manual decision.
//
// NOTHING HERE TOUCHES ELIGIBILITY. Stage 3B-1 made isAgentActionable() the one
// authority for who may receive work; this file only describes what was
// recorded AFTER such a decision succeeded.
// =============================================================================

/** How an assignment event changed the holder. Only real mutations are named. */
export const ITEM_ASSIGNMENT_EVENT_TYPES = ['assigned', 'reassigned', 'unassigned'] as const;
export type ItemAssignmentEventType = (typeof ITEM_ASSIGNMENT_EVENT_TYPES)[number];

/**
 * HOW the agent was chosen. These are the same strings the item row already
 * carries in `items.agent_assignment_method`, so the event and the item can be
 * compared without a translation table.
 */
export const ITEM_ASSIGNMENT_METHODS = ['gps_haversine', 'geocoded_text', 'manual_override'] as const;
export type ItemAssignmentMethod = (typeof ITEM_ASSIGNMENT_METHODS)[number];

/** WHAT caused the assignment: the three sources that exist in the system. */
export const ITEM_ASSIGNMENT_TRIGGER_SOURCES = ['finder_report', 'agent_now_operational', 'admin_manual'] as const;
export type ItemAssignmentTriggerSource = (typeof ITEM_ASSIGNMENT_TRIGGER_SOURCES)[number];

/** WHO acted. `system` events have no human actor, so actor_id stays NULL. */
export const ITEM_ASSIGNMENT_ACTOR_ROLES = ['system', 'admin'] as const;
export type ItemAssignmentActorRole = (typeof ITEM_ASSIGNMENT_ACTOR_ROLES)[number];

// ---------------------------------------------------------------------------
// SQL fragments for CHECK constraints, generated so the three declarations
// cannot drift apart.
// ---------------------------------------------------------------------------
export const ITEM_ASSIGNMENT_EVENT_TYPE_SQL_LIST = ITEM_ASSIGNMENT_EVENT_TYPES.map((v) => `'${v}'`).join(', ');
export const ITEM_ASSIGNMENT_METHOD_SQL_LIST = ITEM_ASSIGNMENT_METHODS.map((v) => `'${v}'`).join(', ');
export const ITEM_ASSIGNMENT_TRIGGER_SOURCE_SQL_LIST = ITEM_ASSIGNMENT_TRIGGER_SOURCES.map((v) => `'${v}'`).join(', ');
export const ITEM_ASSIGNMENT_ACTOR_ROLE_SQL_LIST = ITEM_ASSIGNMENT_ACTOR_ROLES.map((v) => `'${v}'`).join(', ');

/**
 * THE ONE ORDERED COLUMN LIST for `item_agent_assignments`.
 *
 * The Drizzle schema, sql/schema.sql and the runtime DDL must declare these
 * columns in exactly this order. The parity test compares all three against
 * this list (rather than merely asserting that a few column names appear
 * somewhere in each file), because "the name is present" is what let the
 * payout-repair drift through.
 */
export const ITEM_AGENT_ASSIGNMENT_COLUMNS = [
  'id',
  'item_id',
  'previous_agent_id',
  'new_agent_id',
  'event_type',
  'assignment_method',
  'trigger_source',
  'actor_id',
  'actor_role',
  'reason',
  'distance_km',
  'created_at',
] as const;

// ---------------------------------------------------------------------------
// RUNTIME GUARDS.
//
// The CHECK constraints are the database's copy of these rules, but the
// in-memory test double does not enforce CHECK constraints (it has no schema to
// enforce), so an out-of-vocabulary value would be persisted happily in tests
// and rejected only in production. These guards let the writer refuse such an
// event BEFORE it reaches either engine, which is what makes the two
// environments agree.
// ---------------------------------------------------------------------------

export function isItemAssignmentEventType(value: unknown): value is ItemAssignmentEventType {
  return typeof value === 'string' && (ITEM_ASSIGNMENT_EVENT_TYPES as readonly string[]).includes(value);
}

export function isItemAssignmentMethod(value: unknown): value is ItemAssignmentMethod {
  return typeof value === 'string' && (ITEM_ASSIGNMENT_METHODS as readonly string[]).includes(value);
}

export function isItemAssignmentTriggerSource(value: unknown): value is ItemAssignmentTriggerSource {
  return typeof value === 'string' && (ITEM_ASSIGNMENT_TRIGGER_SOURCES as readonly string[]).includes(value);
}

export function isItemAssignmentActorRole(value: unknown): value is ItemAssignmentActorRole {
  return typeof value === 'string' && (ITEM_ASSIGNMENT_ACTOR_ROLES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// CUSTODY PROTECTION — WHICH ITEMS THE MANUAL REVIEW ROUTE MAY TOUCH (3B-3).
//
// THE PROBLEM THIS SOLVES. Stage 3B-2 made an administrator's manual decision
// traceable, but it still wrote whatever it was told, in whatever status the
// item happened to be. An item already physically received by a hub
// (`at_agent`) or already claimed (`claimed`) could therefore be re-pointed at a
// different agent by a single dropdown change: the database then claimed B held
// an item that is physically at A, and the recorded custodian was silently
// transferred by a form submission. Nothing in this product records a physical
// handover, so no form submission may imply one.
//
// THE POLICY, IN ONE SENTENCE: an assignment change is allowed only for an item
// that has not yet been physically received, and every other status fails
// CLOSED. That is deliberately an allow-list rather than a deny-list of the two
// dangerous statuses: the items table's status vocabulary has grown before
// (`suspected_stolen`, `legal_hold`), and a deny-list would silently permit
// every status added later. The allow-list makes a new status safe by default.
//
// WHY IT LIVES HERE AND NOT IN THE ROUTE. The route needs this to answer with a
// precise 409, and the database primitive needs the SAME rule so a concurrent
// status change between the route's check and the write cannot slip through the
// gap. One predicate, two callers — the same discipline the SQL vocabularies
// above already use, so the two can never disagree about what "received" means.
//
// WHAT IT DOES NOT DO. It does not move an item, change a status, release a
// hold, or define a handover. `at_agent` and `claimed` items keep their holder
// and their custody; an administrator who must genuinely move a physically held
// item needs a custody-transfer feature that does not exist and is not
// authorised here.
// ---------------------------------------------------------------------------

/** The ONLY statuses in which the manual route may add, change or remove a holder. */
export const ITEM_ASSIGNABLE_STATUSES = ['awaiting_dropoff'] as const;
export type ItemAssignableStatus = (typeof ITEM_ASSIGNABLE_STATUSES)[number];

export function isItemAssignableStatus(value: unknown): value is ItemAssignableStatus {
  return typeof value === 'string' && (ITEM_ASSIGNABLE_STATUSES as readonly string[]).includes(value);
}

/** Human name for a status, only for the statuses this policy reasons about. */
function custodyStatusLabel(status: unknown): string {
  switch (status) {
    case 'awaiting_dropoff':
      return 'awaiting drop-off';
    case 'at_agent':
      return 'already received by an agent hub';
    case 'claimed':
      return 'already claimed';
    case 'expired':
      return 'expired';
    case 'rejected':
      return 'rejected';
    case 'suspected_stolen':
      return 'frozen as suspected stolen';
    case 'legal_hold':
      return 'under legal hold';
    default:
      return 'in an unsupported state';
  }
}

/**
 * Why an ASSIGNMENT (initial or change of holder) is refused for this item
 * status, or `null` when the item may be assigned.
 *
 * The returned string is safe to show an administrator: it names the item's
 * state and the rule, never an internal column, id or stack.
 */
export function describeManualAssignmentRefusal(status: unknown): string | null {
  if (isItemAssignableStatus(status)) return null;

  if (status === 'at_agent') {
    return 'This item has already been received by an agent hub, so its assigned agent cannot be changed here. Physical custody must be resolved separately; no assignment change was made.';
  }
  if (status === 'claimed') {
    return 'This item has already been claimed, so its assigned agent cannot be changed here. No assignment change was made.';
  }
  return `An item that is ${custodyStatusLabel(status)} cannot be assigned to an agent. No assignment change was made.`;
}

/**
 * Why an UNASSIGNMENT is refused for this item status, or `null` when the
 * holder may be removed. The set of permitted statuses is IDENTICAL to
 * assignment's: removing the recorded custodian of an item a hub is physically
 * holding would lose the only record of where the item is, which is exactly what
 * the custody policy exists to prevent.
 */
export function describeManualUnassignmentRefusal(status: unknown): string | null {
  if (isItemAssignableStatus(status)) return null;

  if (status === 'at_agent') {
    return 'This item is physically held by its assigned agent hub, so the assignment cannot be removed. No unassignment was made.';
  }
  if (status === 'claimed') {
    return 'This item has already been claimed, so its assignment cannot be removed. No unassignment was made.';
  }
  return `An item that is ${custodyStatusLabel(status)} cannot be unassigned. No unassignment was made.`;
}

// -----------------------------------------------------------------------------
// STAGE 3B-6B — THE STATUSES IN WHICH AN ITEM IS STILL "WITH" ITS ASSIGNED HUB.
//
// The administrator stranded-item queue has to answer one question: which items
// are STILL WAITING on an agent who can no longer act? The answer is a status
// predicate, and it belongs here — next to the custody policy that already names
// these statuses — rather than typed into a Drizzle `where(...)` clause, a
// service and a UI filter separately. The read in src/db/database.ts and the
// pure classifier in src/services/strandedItemsQueue.ts both consume THIS list,
// so the query and the classification cannot disagree about what "still with a
// hub" means.
//
// WHY EXACTLY THESE TWO:
//   * `awaiting_dropoff` — assigned to a hub, finder has not delivered yet. The
//     item is genuinely outstanding work for that hub.
//   * `at_agent`         — the hub has physically received it. It is still that
//     hub's responsibility, so a suspended hub strands it too — but it is NOT
//     releasable (describeManualUnassignmentRefusal above), which is exactly why
//     the queue must show it rather than hide it.
//
// WHY EVERYTHING ELSE IS ABSENT: claimed, expired, rejected, suspected_stolen
// and legal_hold items have left the drop-off lifecycle. Their holder field is
// historical, not outstanding work, and nothing in this batch may treat them as
// a queue entry — classifying them as stranded would invite an operator to
// unassign an item that has already moved on.
//
// THIS IS NOT A CUSTODY STATE. It invents no new status, writes nothing and
// changes no eligibility rule; it only names which EXISTING statuses the queue
// reads. `at_agent` items stay assigned to their hub until a human resolves the
// physical custody — see the security note in services/strandedItemsQueue.ts.
// -----------------------------------------------------------------------------

/** The statuses in which an item is still outstanding work for its assigned hub. */
export const ITEM_STATUSES_AWAITING_AGENT_ACTION = ['awaiting_dropoff', 'at_agent'] as const;
export type ItemStatusAwaitingAgentAction = (typeof ITEM_STATUSES_AWAITING_AGENT_ACTION)[number];

export function isItemStatusAwaitingAgentAction(value: unknown): value is ItemStatusAwaitingAgentAction {
  return (
    typeof value === 'string' &&
    (ITEM_STATUSES_AWAITING_AGENT_ACTION as readonly string[]).includes(value)
  );
}
