// =============================================================================
// BATCH B — AGENT-ASSIGNMENT NOTIFICATIONS.
//
// WHAT THIS IS
//   The one place that turns "this item now has an agent" into the notifications
//   that fact deserves:
//
//     the AGENT    — you have work waiting at your hub
//     the FINDER   — an agent hub will receive the item you reported
//     the CLAIMANT — an agent is now handling the item on your live claim
//
// WHY IT IS ONE SERVICE AND NOT THREE CALL SITES
//   TWO different triggers reach this fact — an administrator assigning by hand,
//   and an agent becoming operational (services/agentAutoAssignment.ts) — and each
//   of the three recipients can be legitimately absent. Writing those rules once
//   is what stops the manual path and the automatic path from drifting into
//   telling different people different things, or from one of them forgetting a
//   recipient entirely.
//
// THE CONTRACT IT KEEPS
//
//   1. IT NEVER THROWS. An assignment that has already committed must not be
//      rolled back — or reported to the caller as failed — because an optional
//      message could not be queued. Every failure is logged and swallowed, which
//      is the same "delivery failure is not business failure" boundary the
//      customer-notification producers use.
//
//   2. IT NEVER INVENTS A RECIPIENT. The agent is reached at `contact_email`, the
//      finder at `finder_email`, the claimant at the claim's `owner_email`. A
//      missing destination means the event is not attempted at all: nothing is
//      sent and no event row is created. Nothing is guessed, no phone number is
//      substituted for an email address, and an un-addressed claimant is simply
//      not notified.
//
//   3. IT IS IDEMPOTENT BY CONSTRUCTION, using the repository's EXISTING
//      `notification_events.idempotency_key` UNIQUE index rather than any new
//      mechanism.
//
//      STAGE 3B-3 CHANGED WHAT THE KEY IS BUILT FROM, BECAUSE THE OLD KEY WAS
//      WRONG FOR TRANSFERS. Agent and finder notifications used to key on the
//      ITEM (`...:<item id>`), which meant an item could only ever have ONE
//      assignment message in its lifetime: the second assignment resolved to the
//      existing row and was suppressed as a duplicate, so the incoming agent of a
//      transfer was told nothing and the outgoing agent was never told at all.
//      The key is now built from the COMMITTED assignment-history event id
//      (falling back to `item:agent` for the automatic path, which has no event
//      id in hand), so:
//
//        * two different assignments of the same item are two logical events and
//          are both delivered;
//        * a retry, a double-click or the same event observed twice resolves to
//          the single existing row and is never re-sent;
//        * a claimant notification is additionally keyed per claim, because two
//          live claims on one item are two recipients.
//
//      The canonical `EVENT_TYPE:IDENTITY` shape is also exactly what
//      `idempotencyKeyLooksLikeSecret` is written not to reject.
//
//   4. IT CARRIES NO SECRET AND NO UNNECESSARY PRIVATE DATA. All three events are
//      `reconstructable` because none of them contains an OTP, a pickup code, an
//      activation token or a phone number. The agent's routing method, the
//      finder's phone number and the claim's security answers are all absent.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   It does not send SMS. The finder's destination is the email address on the
//   report — identical to the pre-existing FINDER_ITEM_COLLECTED event — so a
//   Finder who reported with a phone number only has no outbound destination for
//   this event and simply is not notified. It also does not write an in-app
//   customer notification: that layer is driven by the existing claim-status
//   producers and this batch does not reinterpret it.
// =============================================================================

import { db, type Agent, type FoundItem } from '../db/database.ts';
import {
  NotificationService,
  buildNotificationIdempotencyKey,
  type NotificationResult,
} from './notificationService.ts';
import {
  renderSendAgentItemAssignedEmail,
  renderSendFinderAgentAssignedEmail,
  renderSendClaimantAgentAssignedEmail,
  renderSendAgentItemReassignedEmail,
  renderSendAgentItemUnassignedEmail,
  renderSendFinderAgentUnassignedEmail,
  renderSendClaimantAgentUnassignedEmail,
} from './email.ts';

/** Which lifecycle event produced the assignment. Recorded for the audit trail. */
export type AgentAssignmentTrigger = 'admin_manual' | 'agent_now_operational';

export interface AgentAssignmentNotificationInput {
  item: FoundItem;
  agent: Agent;
  trigger: AgentAssignmentTrigger;
  /**
   * STAGE 3B-3 — THE COMMITTED HISTORY EVENT THIS MESSAGE ANNOUNCES.
   *
   * Optional only so the automatic path (which has no route to hand it an id)
   * keeps working unchanged. When present it IS the notification's identity: two
   * different assignments of the same item are two different messages, while a
   * retry or a double-clicked request for the SAME event resolves to the one
   * existing row. Before this, the key was the item id, so the second
   * assignment of an item could never be announced at all.
   */
  assignmentEventId?: string | null;
  /**
   * The agent that held the item before this assignment, when this call
   * announces a TRANSFER. Supplying it is what makes the outgoing agent get the
   * "responsibility has changed" message; omitting it (a first assignment, or the
   * automatic path) sends nothing to anyone else.
   */
  previousAgent?: Agent | null;
}

/** What each recipient's notification resolved to. `null` means "not attempted". */
export interface AgentAssignmentNotificationOutcome {
  agent: NotificationResult | null;
  finder: NotificationResult | null;
  claimant: NotificationResult[];
  /** The outgoing agent of a transfer; `null` when there was no predecessor. */
  previousAgent: NotificationResult | null;
}

/** The input for the removal of a holder. There is deliberately no incoming agent. */
export interface AgentUnassignmentNotificationInput {
  item: FoundItem;
  /** The agent being removed. Required: the whole event is about them. */
  previousAgent: Agent;
  /** The committed `unassigned` history event id. */
  assignmentEventId: string;
}

/** What a removal notified. `null` means "not attempted" (no destination). */
export interface AgentUnassignmentNotificationOutcome {
  agent: NotificationResult | null;
  finder: NotificationResult | null;
  claimant: NotificationResult[];
}

/**
 * STAGE 3B-3 — THE EVENT IDENTITY EVERY KEY IS BUILT FROM.
 *
 * With a committed history event id, the identity is the EVENT: retrying it is
 * suppressed, a second assignment of the same item is not. Without one (the
 * automatic matcher, which has no event id in hand) the identity falls back to
 * `item:agent`, which is still a strictly better key than the bare item id: a
 * transfer to a DIFFERENT agent is no longer suppressed. The one case the
 * fallback cannot distinguish is the same item being given to the SAME agent
 * twice, which requires an unassignment in between and is documented as a known
 * limitation rather than claimed away.
 */
function assignmentIdentity(itemId: string, agentId: string, assignmentEventId?: string | null): string {
  const eventId = typeof assignmentEventId === 'string' ? assignmentEventId.trim() : '';
  return eventId ? eventId : `${itemId}:${agentId}`;
}

/** The same fallback label the existing handover emails already use. */
const UNKNOWN_ITEM_NAME = 'Found Document / Item';

async function resolveItemName(item: FoundItem): Promise<string> {
  try {
    const category = item.category_id ? await db.getCategory(item.category_id) : undefined;
    return category ? category.name_en : UNKNOWN_ITEM_NAME;
  } catch (error) {
    console.error('[ASSIGNMENT NOTIFICATION] Item name lookup failed; using the generic label:', error);
    return UNKNOWN_ITEM_NAME;
  }
}

interface DispatchInput {
  eventType: string;
  recipient: string | null | undefined;
  /** The business identity the idempotency key is built from. */
  businessReference: string;
  /**
   * The logical-event identity used for deduplication. Kept separate from
   * `businessReference` (which is what an operator reads to find the item or
   * claim) because an event-keyed notification must still name its item.
   */
  identity: string;
  render: () => { subject?: string; body: string };
}

/**
 * The single send path. Returns null when there is no destination (nothing
 * attempted) and also when dispatch itself fails (nothing to report but the
 * failure) — either way the caller's assignment stands.
 */
async function dispatch(input: DispatchInput): Promise<NotificationResult | null> {
  const recipient = typeof input.recipient === 'string' ? input.recipient.trim() : '';
  if (!recipient) return null;

  try {
    return await NotificationService.notify({
      eventType: input.eventType,
      recipient,
      businessReference: input.businessReference,
      idempotencyKey: buildNotificationIdempotencyKey(input.eventType, input.identity),
      render: input.render,
    });
  } catch (error) {
    console.error(
      `[ASSIGNMENT NOTIFICATION] ${input.eventType} dispatch failed for ${input.businessReference}:`,
      error,
    );
    return null;
  }
}

/**
 * Emits the assignment notifications for one item/agent pair.
 *
 * NEVER throws. Call it AFTER the assignment has committed — for the automatic
 * paths, that means only when the compare-and-swap actually returned true, so a
 * losing concurrent attempt cannot produce a notification for an assignment that
 * never happened.
 */
export async function notifyAgentAssignedToItem(
  input: AgentAssignmentNotificationInput,
): Promise<AgentAssignmentNotificationOutcome> {
  const { item, agent } = input;
  const itemName = await resolveItemName(item);
  // The identity of THIS assignment event, shared by the three "an agent now
  // holds it" messages so one event is one message per recipient.
  const identity = assignmentIdentity(item.id, agent.id, input.assignmentEventId);

  // 1. THE ASSIGNED AGENT. Always attempted — the agent is the one party that
  //    certainly exists at this point; whether they have an address is
  //    NotificationService's decision, not a second check here.
  const agentNotification = await dispatch({
    eventType: 'AGENT_ITEM_ASSIGNED',
    recipient: agent.contact_email,
    businessReference: item.id,
    identity,
    render: () => renderSendAgentItemAssignedEmail(agent.business_name, item.id),
  });

  // 2. THE FINDER, when the report carried an email address. A phone-only finder
  //    has no destination for this event and is not contacted by SMS.
  const finderNotification = await dispatch({
    eventType: 'FINDER_AGENT_ASSIGNED',
    recipient: item.finder_email,
    businessReference: item.id,
    identity,
    render: () =>
      renderSendFinderAgentAssignedEmail(
        itemName,
        item.id,
        agent.business_name,
        agent.location_address,
      ),
  });

  // 3. THE CLAIMANT — only where a genuinely live claim exists on this item, and
  //    only where that claim carries an email address. A terminal claim means the
  //    journey is over and there is nobody left to tell; an absent claim means the
  //    item is still anonymous-first, which is a legitimate state.
  const claimantNotifications: NotificationResult[] = [];
  try {
    const activeClaims = await db.getActiveClaimsForItem(item.id);
    for (const claim of activeClaims) {
      const notification = await dispatch({
        eventType: 'CLAIMANT_AGENT_ASSIGNED',
        recipient: claim.owner_email,
        businessReference: claim.id,
        // One claimant message per (event, claim): two live claims on the same
        // item are two recipients, not one suppressed duplicate.
        identity: `${identity}:${claim.id}`,
        render: () => renderSendClaimantAgentAssignedEmail(itemName, item.id, agent.business_name),
      });
      if (notification) claimantNotifications.push(notification);
    }
  } catch (error) {
    console.error('[ASSIGNMENT NOTIFICATION] Active-claim lookup failed; no claimant notified:', error);
  }

  // 4. THE OUTGOING AGENT — only on a TRANSFER, and only when the caller named
  //    the predecessor. This is the message that did not exist at all before
  //    Stage 3B-3: an agent whose hub was expecting an item was told nothing when
  //    it was given to a different hub. It names no replacement agent: the
  //    outgoing hub needs to know the work is gone, not who took it.
  let previousAgentNotification: NotificationResult | null = null;
  if (input.previousAgent && input.previousAgent.id !== agent.id) {
    const outgoing = input.previousAgent;
    previousAgentNotification = await dispatch({
      eventType: 'AGENT_ITEM_REASSIGNED',
      recipient: outgoing.contact_email,
      businessReference: item.id,
      identity,
      render: () => renderSendAgentItemReassignedEmail(outgoing.business_name, item.id),
    });
  }

  return {
    agent: agentNotification,
    finder: finderNotification,
    claimant: claimantNotifications,
    previousAgent: previousAgentNotification,
  };
}

/**
 * STAGE 3B-3 — THE REMOVAL OF A HOLDER, ANNOUNCED TO THE PEOPLE IT AFFECTS.
 *
 * WHO HEARS ABOUT IT, AND WHY:
 *   * the OUTGOING AGENT, always — their hub was expecting this item and that
 *     expectation has been withdrawn. This is the message an unassignment most
 *     obviously needs;
 *   * the FINDER, when the report carried an email address — they were told a hub
 *     would receive the item, so they are told that is no longer true;
 *   * a LIVE CLAIMANT, when the claim carries an email address — their recovery
 *     still exists; only the hub changed.
 *
 * THE FINDER AND CLAIMANT GET DIFFERENT EVENTS FROM THE ASSIGNMENT ONES, on
 * purpose: "an agent hub will receive your item" would be false now. Nothing
 * here names a replacement agent, because there is none.
 *
 * NEVER THROWS, exactly like the assignment path: the removal has already
 * committed and must not be reported as failed because a message could not be
 * queued.
 */
export async function notifyAgentUnassignedFromItem(
  input: AgentUnassignmentNotificationInput,
): Promise<AgentUnassignmentNotificationOutcome> {
  const { item, previousAgent } = input;
  const itemName = await resolveItemName(item);
  const identity = assignmentIdentity(item.id, previousAgent.id, input.assignmentEventId);

  const agentNotification = await dispatch({
    eventType: 'AGENT_ITEM_UNASSIGNED',
    recipient: previousAgent.contact_email,
    businessReference: item.id,
    identity,
    render: () => renderSendAgentItemUnassignedEmail(previousAgent.business_name, item.id),
  });

  const finderNotification = await dispatch({
    eventType: 'FINDER_AGENT_UNASSIGNED',
    recipient: item.finder_email,
    businessReference: item.id,
    identity,
    render: () => renderSendFinderAgentUnassignedEmail(itemName, item.id),
  });

  const claimantNotifications: NotificationResult[] = [];
  try {
    const activeClaims = await db.getActiveClaimsForItem(item.id);
    for (const claim of activeClaims) {
      const notification = await dispatch({
        eventType: 'CLAIMANT_AGENT_UNASSIGNED',
        recipient: claim.owner_email,
        businessReference: claim.id,
        identity: `${identity}:${claim.id}`,
        render: () => renderSendClaimantAgentUnassignedEmail(itemName, item.id),
      });
      if (notification) claimantNotifications.push(notification);
    }
  } catch (error) {
    console.error('[UNASSIGNMENT NOTIFICATION] Active-claim lookup failed; no claimant notified:', error);
  }

  return {
    agent: agentNotification,
    finder: finderNotification,
    claimant: claimantNotifications,
  };
}
