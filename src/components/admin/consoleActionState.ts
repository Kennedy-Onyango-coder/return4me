// D-2B-B BATCH 2 — THE CONSOLE'S IN-FLIGHT ACTION STATE, AS ONE PURE VALUE.
//
// WHY THIS EXISTS
//   Every admin action used to record its own progress in ONE `string | null`
//   (`itemActionProcessing`). A single scalar cannot represent two concurrent
//   operations, and that produced three concrete defects:
//
//     * starting an action on claim B OVERWROTE claim A's marker, so A's control
//       re-enabled while A's request was still in flight — the button said "idle"
//       for a request that had not finished, and a second click was accepted;
//     * finishing B wrote `null`, which also cleared the marker of an action that
//       was still running (its `finally` ran even for a request it did not own);
//     * because "is this action already in flight?" was not answerable, nothing
//       could refuse a duplicate submission at all.
//
//   The state is now a SET of action keys. Several actions may be in flight at
//   once, each begin/finish touches ONLY its own key, and a second begin for a
//   key that is already in flight is refused — which is what makes "confirming
//   twice cannot send two payouts" a property of the data, not of a UI accident.
//
// WHY IT LIVES HERE, AND WHY IT IS REACT-FREE
//   This repository runs vitest in a `node` environment with no jsdom / React
//   Testing Library (claimsPresentation.ts documents the same constraint for the
//   Claims surface), so the ONLY way to regression-test this behaviour is to keep
//   the rules in plain functions and let the view be thin wiring over them.
//   Nothing here imports React, touches the DOM, or calls `fetch`:
//   `reduceConsoleActions` DECIDES, and the caller performs.
//
// WHAT IS DELIBERATELY UNCHANGED
//   The key VOCABULARY is byte-for-byte what the view already used
//   (`pause:<scope>`, `<itemId><action>`, `social-pause`, `settlement:<claimId>`,
//   `settlement-approve:<claimId>`, `settlement-initiate:<claimId>`), so every
//   existing control keeps its own identity and no unrelated action flow changes
//   meaning. The builders below exist so those strings are constructed in ONE
//   place instead of being hand-concatenated at each call site.

/** The set of action keys currently in flight. Immutable: every transition
 *  returns either the same value (nothing changed) or a new set. */
export type InFlightActions = ReadonlySet<string>;

/** No action in flight. Shared, because it is never mutated. */
export const NO_ACTIONS_IN_FLIGHT: InFlightActions = new Set<string>();

/** One pause-scope toggle. Identical to the previous `'pause:' + scope`. */
export const pauseScopeActionKey = (scope: string): string => `pause:${scope}`;

/** One item-review transition. Identical to the previous `itemId + action` (no
 *  separator — kept exactly as it shipped so no item-review marker shifts). */
export const itemReviewActionKey = (itemId: string, action: string): string => `${itemId}${action}`;

/** The social-publishing pause toggle. */
export const SOCIAL_PUBLISHING_PAUSE_ACTION_KEY = 'social-pause';

/** Recording a claim's settlement approval (moves no money). */
export const settlementApprovalActionKey = (claimId: string): string => `settlement-approve:${claimId}`;

/** Initiating a claim's payout — the only money-moving step. */
export const settlementInitiateActionKey = (claimId: string): string => `settlement-initiate:${claimId}`;

/** The retained legacy manual release. Deliberately DISTINCT from
 *  `settlementInitiateActionKey` so the two routes can never mask each other. */
export const legacySettlementReleaseActionKey = (claimId: string): string => `settlement:${claimId}`;

/** Is this exact key in flight? */
export function isActionInFlight(inFlight: InFlightActions, key: string): boolean {
  return inFlight.has(key);
}

/** Adds one key. Returns the SAME set when the key was already in flight, so a
 *  caller can both refuse the duplicate and skip a pointless re-render. */
export function beginAction(inFlight: InFlightActions, key: string): InFlightActions {
  if (inFlight.has(key)) return inFlight;
  const next = new Set(inFlight);
  next.add(key);
  return next;
}

/** Removes one key — and ONLY that key. A completion for claim B can never clear
 *  a request still in flight for claim A, or for any other action. Returns the
 *  same set when there was nothing to clear. */
export function finishAction(inFlight: InFlightActions, key: string): InFlightActions {
  if (!inFlight.has(key)) return inFlight;
  const next = new Set(inFlight);
  next.delete(key);
  return next;
}

/**
 * The whole console action state: what is in flight, and which settlement (if
 * any) has its payout-confirmation step open. The confirmation target lives here
 * rather than in a second piece of view state so that "the step is open" and
 * "a request for that claim is already in flight" are decided together, in the
 * one place that decides anything.
 */
export interface ConsoleActions {
  readonly inFlight: InFlightActions;
  readonly payoutConfirmationClaimId: string | null;
}

export const NO_CONSOLE_ACTIONS: ConsoleActions = {
  inFlight: NO_ACTIONS_IN_FLIGHT,
  payoutConfirmationClaimId: null,
};

export type ConsoleActionEvent =
  /** One action started. */
  | { readonly type: 'begin'; readonly key: string }
  /** One action ended, successfully or not. */
  | { readonly type: 'finish'; readonly key: string }
  /** The operator asked to initiate a payout: this OPENS a confirmation step. */
  | { readonly type: 'open-payout-confirmation'; readonly claimId: string }
  /** The operator declined: the step closes and nothing else changes. */
  | { readonly type: 'cancel-payout-confirmation' }
  /** The operator confirmed the open step for that claim. */
  | { readonly type: 'confirm-payout'; readonly claimId: string };

export interface ConsoleActionTransition {
  readonly actions: ConsoleActions;
  /**
   * The claim whose payout initiation must now be sent, or `null` when this
   * event must send nothing. ONLY `confirm-payout` can ever produce a claim id,
   * so opening or cancelling the step cannot reach the network by construction,
   * and a refused duplicate reports no request for the caller to make.
   */
  readonly payoutClaimIdToInitiate: string | null;
}

/**
 * The single decision point for the console's actions.
 *
 * `confirm-payout` refuses — sending nothing at all — when:
 *   * no step is open (nothing was confirmed), or
 *   * the step belongs to a DIFFERENT claim than the one being confirmed (a
 *     stale control must never initiate another claim's payout), or
 *   * a payout request for that claim is ALREADY in flight — the duplicate
 *     submission the previous scalar could not detect.
 * In every refusal the step still closes and no key is added, so a failed or
 * refused attempt never leaves a permanently disabled control behind.
 */
export function reduceConsoleActions(
  actions: ConsoleActions,
  event: ConsoleActionEvent,
): ConsoleActionTransition {
  switch (event.type) {
    case 'begin':
      return {
        actions: { ...actions, inFlight: beginAction(actions.inFlight, event.key) },
        payoutClaimIdToInitiate: null,
      };
    case 'finish':
      return {
        actions: { ...actions, inFlight: finishAction(actions.inFlight, event.key) },
        payoutClaimIdToInitiate: null,
      };
    case 'open-payout-confirmation':
      return {
        actions: { ...actions, payoutConfirmationClaimId: event.claimId },
        payoutClaimIdToInitiate: null,
      };
    case 'cancel-payout-confirmation':
      return {
        actions: { ...actions, payoutConfirmationClaimId: null },
        payoutClaimIdToInitiate: null,
      };
    case 'confirm-payout': {
      const openClaimId = actions.payoutConfirmationClaimId;
      const closed: ConsoleActions = { ...actions, payoutConfirmationClaimId: null };
      if (openClaimId === null || openClaimId !== event.claimId) {
        return { actions: closed, payoutClaimIdToInitiate: null };
      }
      const key = settlementInitiateActionKey(openClaimId);
      if (isActionInFlight(actions.inFlight, key)) {
        return { actions: closed, payoutClaimIdToInitiate: null };
      }
      return {
        actions: { inFlight: beginAction(actions.inFlight, key), payoutConfirmationClaimId: null },
        payoutClaimIdToInitiate: openClaimId,
      };
    }
  }
}

/** Is the payout-confirmation step open for THIS claim? The step is per claim,
 *  so one opened for a settlement never reads as open for another. */
export function isPayoutConfirmationOpenFor(actions: ConsoleActions, claimId: string): boolean {
  return actions.payoutConfirmationClaimId === claimId;
}
