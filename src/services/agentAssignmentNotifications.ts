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
//      mechanism. Agent and finder notifications key on the ITEM
//      (`...:<item id>`) — the item is what was assigned, and it is assigned
//      once; the claimant notification keys on the CLAIM (`...:<claim id>`) —
//      the claim is the party's business identity. A retry, a double-clicked
//      admin action, or the same assignment observed twice therefore resolves to
//      the single existing row and is never re-sent. The canonical
//      `EVENT_TYPE:ACCOUNT_ID` shape is also exactly what
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
} from './email.ts';

/** Which lifecycle event produced the assignment. Recorded for the audit trail. */
export type AgentAssignmentTrigger = 'admin_manual' | 'agent_now_operational';

export interface AgentAssignmentNotificationInput {
  item: FoundItem;
  agent: Agent;
  trigger: AgentAssignmentTrigger;
}

/** What each recipient's notification resolved to. `null` means "not attempted". */
export interface AgentAssignmentNotificationOutcome {
  agent: NotificationResult | null;
  finder: NotificationResult | null;
  claimant: NotificationResult[];
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
      idempotencyKey: buildNotificationIdempotencyKey(input.eventType, input.businessReference),
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

  // 1. THE ASSIGNED AGENT. Always attempted — the agent is the one party that
  //    certainly exists at this point; whether they have an address is
  //    NotificationService's decision, not a second check here.
  const agentNotification = await dispatch({
    eventType: 'AGENT_ITEM_ASSIGNED',
    recipient: agent.contact_email,
    businessReference: item.id,
    render: () => renderSendAgentItemAssignedEmail(agent.business_name, item.id),
  });

  // 2. THE FINDER, when the report carried an email address. A phone-only finder
  //    has no destination for this event and is not contacted by SMS.
  const finderNotification = await dispatch({
    eventType: 'FINDER_AGENT_ASSIGNED',
    recipient: item.finder_email,
    businessReference: item.id,
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
        render: () => renderSendClaimantAgentAssignedEmail(itemName, item.id, agent.business_name),
      });
      if (notification) claimantNotifications.push(notification);
    }
  } catch (error) {
    console.error('[ASSIGNMENT NOTIFICATION] Active-claim lookup failed; no claimant notified:', error);
  }

  return {
    agent: agentNotification,
    finder: finderNotification,
    claimant: claimantNotifications,
  };
}
