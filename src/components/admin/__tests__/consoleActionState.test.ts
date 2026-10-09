import { describe, expect, it } from 'vitest';
import {
  NO_ACTIONS_IN_FLIGHT,
  NO_CONSOLE_ACTIONS,
  SOCIAL_PUBLISHING_PAUSE_ACTION_KEY,
  beginAction,
  finishAction,
  isActionInFlight,
  isPayoutConfirmationOpenFor,
  itemReviewActionKey,
  legacySettlementReleaseActionKey,
  pauseScopeActionKey,
  reduceConsoleActions,
  settlementApprovalActionKey,
  settlementInitiateActionKey,
} from '../consoleActionState';
import type { ConsoleActionEvent, ConsoleActions } from '../consoleActionState';

// =============================================================================
// D-2B-B BATCH 2 — THE CONSOLE'S ACTION STATE, TESTED AS BEHAVIOUR.
// =============================================================================
// These assertions drive the REAL functions the console calls, with no DOM and no
// source-text matching, because the defects this batch fixes are behavioural:
//
//   * one action's begin/finish must not disturb another action's in-flight
//     state (the old single scalar let claim B's start/finish clear claim A);
//   * a duplicate submission for the SAME action must not be sent twice;
//   * opening or cancelling the payout confirmation must send NOTHING, and only a
//     confirmation may produce a request — exactly once;
//   * a failed or refused request must leave no in-flight key behind.
// =============================================================================

const openPayout = (actions: ConsoleActions, claimId: string): ConsoleActions =>
  reduceConsoleActions(actions, { type: 'open-payout-confirmation', claimId }).actions;

const confirmPayout = (actions: ConsoleActions, claimId: string) =>
  reduceConsoleActions(actions, { type: 'confirm-payout', claimId });

const finish = (actions: ConsoleActions, key: string): ConsoleActions =>
  reduceConsoleActions(actions, { type: 'finish', key }).actions;

describe('D-2B-B Batch 2: the action keys are the ones that already shipped', () => {
  it('builds every key in the previous vocabulary, byte for byte', () => {
    expect(pauseScopeActionKey('payouts')).toBe('pause:payouts');
    expect(itemReviewActionKey('item-1', 'legal-hold')).toBe('item-1legal-hold');
    expect(SOCIAL_PUBLISHING_PAUSE_ACTION_KEY).toBe('social-pause');
    expect(settlementApprovalActionKey('claim-1')).toBe('settlement-approve:claim-1');
    expect(settlementInitiateActionKey('claim-1')).toBe('settlement-initiate:claim-1');
    expect(legacySettlementReleaseActionKey('claim-1')).toBe('settlement:claim-1');
  });

  it('keeps the legacy release and the supported initiation on their own keys', () => {
    // A legacy release in flight must never read as an in-flight payout (and the
    // reverse), or one route's button would report the other route's progress.
    expect(legacySettlementReleaseActionKey('claim-1')).not.toBe(settlementInitiateActionKey('claim-1'));
  });

  it('keeps two different claims on different keys', () => {
    expect(settlementInitiateActionKey('claim-a')).not.toBe(settlementInitiateActionKey('claim-b'));
  });
});

describe('D-2B-B Batch 2: one action never clears or overwrites another claim', () => {
  const aKey = settlementInitiateActionKey('claim-a');
  const bKey = itemReviewActionKey('item-b', 'flag-stolen');

  it('keeps claim A in flight while claim B starts and finishes', () => {
    let inFlight = beginAction(NO_ACTIONS_IN_FLIGHT, aKey);
    inFlight = beginAction(inFlight, bKey);
    expect(isActionInFlight(inFlight, aKey)).toBe(true);
    expect(isActionInFlight(inFlight, bKey)).toBe(true);

    // B finishing is the old defect: `finally { setItemActionProcessing(null) }`
    // cleared A's marker as well, re-enabling A's control mid-request.
    inFlight = finishAction(inFlight, bKey);
    expect(isActionInFlight(inFlight, aKey)).toBe(true);
    expect(isActionInFlight(inFlight, bKey)).toBe(false);
  });

  it('refuses to start an action that is already in flight, without touching it', () => {
    const started = beginAction(NO_ACTIONS_IN_FLIGHT, aKey);
    const again = beginAction(started, aKey);
    expect(isActionInFlight(again, aKey)).toBe(true);
    // Identity, not a copy: a caller can both detect the refusal and skip a
    // pointless re-render.
    expect(again).toBe(started);
  });

  it('does nothing when finishing an action that is not in flight', () => {
    const started = beginAction(NO_ACTIONS_IN_FLIGHT, aKey);
    expect(finishAction(started, bKey)).toBe(started);
  });

  it('leaves the unrelated action flows working independently', () => {
    const keys = [pauseScopeActionKey('payouts'), SOCIAL_PUBLISHING_PAUSE_ACTION_KEY, settlementApprovalActionKey('claim-c')];
    let inFlight = NO_ACTIONS_IN_FLIGHT;
    for (const key of keys) inFlight = beginAction(inFlight, key);
    inFlight = finishAction(inFlight, keys[1]);
    expect(isActionInFlight(inFlight, keys[0])).toBe(true);
    expect(isActionInFlight(inFlight, keys[1])).toBe(false);
    expect(isActionInFlight(inFlight, keys[2])).toBe(true);
  });
});

describe('D-2B-B Batch 2: opening and cancelling the payout confirmation send nothing', () => {
  it('opening the step records the claim and issues no request', () => {
    const { actions, payoutClaimIdToInitiate } = reduceConsoleActions(NO_CONSOLE_ACTIONS, {
      type: 'open-payout-confirmation',
      claimId: 'claim-a',
    });
    expect(payoutClaimIdToInitiate).toBeNull();
    expect(actions.payoutConfirmationClaimId).toBe('claim-a');
    // Nothing may be in flight, or an unconfirmed click would have taken a slot.
    expect(actions.inFlight.size).toBe(0);
  });

  it('cancelling the step issues no request and changes nothing else', () => {
    const opened = openPayout(NO_CONSOLE_ACTIONS, 'claim-a');
    const { actions, payoutClaimIdToInitiate } = reduceConsoleActions(opened, {
      type: 'cancel-payout-confirmation',
    });
    expect(payoutClaimIdToInitiate).toBeNull();
    expect(actions.payoutConfirmationClaimId).toBeNull();
    expect(actions.inFlight.size).toBe(0);
  });

  it('cancelling one claim leaves another claim\'s in-flight request alone', () => {
    const aKey = settlementInitiateActionKey('claim-a');
    const openedB: ConsoleActions = {
      inFlight: beginAction(NO_ACTIONS_IN_FLIGHT, aKey),
      payoutConfirmationClaimId: 'claim-b',
    };
    const cancelled = reduceConsoleActions(openedB, { type: 'cancel-payout-confirmation' }).actions;
    expect(isActionInFlight(cancelled.inFlight, aKey)).toBe(true);
    expect(cancelled.payoutConfirmationClaimId).toBeNull();
  });

  it('opens the step for one claim at a time', () => {
    const openedA = openPayout(NO_CONSOLE_ACTIONS, 'claim-a');
    expect(isPayoutConfirmationOpenFor(openedA, 'claim-a')).toBe(true);
    expect(isPayoutConfirmationOpenFor(openedA, 'claim-b')).toBe(false);

    const openedB = openPayout(openedA, 'claim-b');
    expect(isPayoutConfirmationOpenFor(openedB, 'claim-b')).toBe(true);
    expect(isPayoutConfirmationOpenFor(openedB, 'claim-a')).toBe(false);
  });
});

describe('D-2B-B Batch 2: confirming initiates exactly one payout request', () => {
  const aKey = settlementInitiateActionKey('claim-a');

  it('requests the confirmed claim once and marks it in flight', () => {
    const opened = openPayout(NO_CONSOLE_ACTIONS, 'claim-a');
    const { actions, payoutClaimIdToInitiate } = confirmPayout(opened, 'claim-a');
    expect(payoutClaimIdToInitiate).toBe('claim-a');
    expect(isActionInFlight(actions.inFlight, aKey)).toBe(true);
    // The step closes on confirmation, so it cannot be confirmed twice.
    expect(actions.payoutConfirmationClaimId).toBeNull();
  });

  it('refuses a second confirmation of the same claim while it is in flight', () => {
    const confirmed = confirmPayout(openPayout(NO_CONSOLE_ACTIONS, 'claim-a'), 'claim-a').actions;
    // Re-opening the step (the row renders its step again) must not create a
    // second submission: the in-flight key refuses it outright.
    const reopened = openPayout(confirmed, 'claim-a');
    const duplicate = confirmPayout(reopened, 'claim-a');
    expect(duplicate.payoutClaimIdToInitiate).toBeNull();
    expect(duplicate.actions.inFlight.size).toBe(1);
    expect(duplicate.actions.payoutConfirmationClaimId).toBeNull();
  });

  it('refuses a confirmation for a claim whose step is not open', () => {
    const { actions, payoutClaimIdToInitiate } = confirmPayout(NO_CONSOLE_ACTIONS, 'claim-a');
    expect(payoutClaimIdToInitiate).toBeNull();
    expect(actions.inFlight.size).toBe(0);
  });

  it('refuses a stale confirmation aimed at a different claim', () => {
    const openedA = openPayout(NO_CONSOLE_ACTIONS, 'claim-a');
    const wrongClaim = confirmPayout(openedA, 'claim-b');
    expect(wrongClaim.payoutClaimIdToInitiate).toBeNull();
    expect(wrongClaim.actions.inFlight.size).toBe(0);
    expect(wrongClaim.actions.payoutConfirmationClaimId).toBeNull();
  });

  it('clears the step on a refusal, so nothing stays disabled for ever', () => {
    const openedA = openPayout(NO_CONSOLE_ACTIONS, 'claim-a');
    expect(confirmPayout(openedA, 'claim-a').actions.payoutConfirmationClaimId).toBeNull();
    expect(confirmPayout(openedA, 'claim-b').actions.payoutConfirmationClaimId).toBeNull();
  });
});

describe('D-2B-B Batch 2: a finished request frees its own claim for a retry', () => {
  const aKey = settlementInitiateActionKey('claim-a');
  const bKey = settlementInitiateActionKey('claim-b');

  it('finishing clears only that claim and allows it to be initiated again', () => {
    const confirmedA = confirmPayout(openPayout(NO_CONSOLE_ACTIONS, 'claim-a'), 'claim-a').actions;
    const finished = finish(confirmedA, aKey);
    expect(isActionInFlight(finished.inFlight, aKey)).toBe(false);
    const retry = confirmPayout(openPayout(finished, 'claim-a'), 'claim-a');
    expect(retry.payoutClaimIdToInitiate).toBe('claim-a');
  });

  it('finishing claim A never interrupts a payout already in flight for claim B', () => {
    // Both claims initiated; A's request completes while B's is still running.
    let actions = confirmPayout(openPayout(NO_CONSOLE_ACTIONS, 'claim-a'), 'claim-a').actions;
    actions = confirmPayout(openPayout(actions, 'claim-b'), 'claim-b').actions;
    expect(actions.inFlight.size).toBe(2);

    actions = finish(actions, aKey);
    expect(isActionInFlight(actions.inFlight, aKey)).toBe(false);
    expect(isActionInFlight(actions.inFlight, bKey)).toBe(true);
  });
});

describe('D-2B-B Batch 3: one claim, one request — counted through the ref protocol', () => {
  // The view applies every event to the value it read SYNCHRONOUSLY from
  // `consoleActionsRef` and stores the result (AdminView's `applyConsoleAction`),
  // then sends only what the reducer returned (`confirmSettlementPayout` calls the
  // handler when, and only when, a claim id comes back). `apply` below is exactly
  // that protocol: it holds no rules of its own — it records the requests that
  // production would send, so the COUNT is the reducer's decision, not the test's.
  const aKey = settlementInitiateActionKey('claim-a');
  const bKey = settlementApprovalActionKey('claim-b');

  it('allows exactly one request for the confirmation and one for the retry', () => {
    let actions: ConsoleActions = NO_CONSOLE_ACTIONS;
    const requests: string[] = [];
    const apply = (event: ConsoleActionEvent): string | null => {
      const { actions: next, payoutClaimIdToInitiate } = reduceConsoleActions(actions, event);
      actions = next;
      if (payoutClaimIdToInitiate !== null) requests.push(payoutClaimIdToInitiate);
      return payoutClaimIdToInitiate;
    };

    // 1. Opening claim A's confirmation decides nothing and sends nothing.
    expect(apply({ type: 'open-payout-confirmation', claimId: 'claim-a' })).toBeNull();
    expect(requests).toEqual([]);

    // 2. Opening claim B's confirmation keeps ONE open step — and still sends
    //    nothing, so the step is a selection, not a request.
    expect(apply({ type: 'open-payout-confirmation', claimId: 'claim-b' })).toBeNull();
    expect(isPayoutConfirmationOpenFor(actions, 'claim-b')).toBe(true);
    expect(isPayoutConfirmationOpenFor(actions, 'claim-a')).toBe(false);
    expect(requests).toEqual([]);

    // 3. Cancelling claim B's confirmation closes the step and sends nothing.
    expect(apply({ type: 'cancel-payout-confirmation' })).toBeNull();
    expect(actions.payoutConfirmationClaimId).toBeNull();
    expect(requests).toEqual([]);

    // Nothing is open now, so a confirmation aimed at claim A is STALE and is
    // refused. This is what makes the requests counted below the product of a
    // VALID confirmation rather than of a reducer that pays on any event.
    expect(apply({ type: 'confirm-payout', claimId: 'claim-a' })).toBeNull();
    expect(requests).toEqual([]);

    // 4. The operator re-opens claim A (production: the row's own control) and
    //    confirms it — the ONE request this step is allowed to produce.
    expect(apply({ type: 'open-payout-confirmation', claimId: 'claim-a' })).toBeNull();
    expect(apply({ type: 'confirm-payout', claimId: 'claim-a' })).toBe('claim-a');
    expect(isActionInFlight(actions.inFlight, aKey)).toBe(true);
    expect(actions.payoutConfirmationClaimId).toBeNull();
    expect(requests).toEqual(['claim-a']);

    // An UNRELATED action on claim B is in flight from here on.
    expect(apply({ type: 'begin', key: bKey })).toBeNull();
    expect(isActionInFlight(actions.inFlight, bKey)).toBe(true);

    // 5. Confirming claim A AGAIN while its initiation is in flight sends
    //    nothing — not even after the step is re-opened, because the per-claim
    //    key refuses the duplicate. (Re-opening commits nothing; only a valid
    //    confirmation is ever granted a request.)
    expect(apply({ type: 'open-payout-confirmation', claimId: 'claim-a' })).toBeNull();
    expect(apply({ type: 'confirm-payout', claimId: 'claim-a' })).toBeNull();
    expect(requests).toEqual(['claim-a']);
    // ...and the refusal still closes the step, so no control stays disabled.
    expect(actions.payoutConfirmationClaimId).toBeNull();
    expect(isActionInFlight(actions.inFlight, aKey)).toBe(true);

    // 6. Finishing claim A removes ONLY claim A's key.
    expect(apply({ type: 'finish', key: aKey })).toBeNull();
    expect(isActionInFlight(actions.inFlight, aKey)).toBe(false);
    expect(isActionInFlight(actions.inFlight, bKey)).toBe(true);

    // 7. A legitimate retry after the finish IS allowed: the guard suppresses
    //    duplicates, it does not wall the claim off for ever.
    expect(apply({ type: 'open-payout-confirmation', claimId: 'claim-a' })).toBeNull();
    expect(apply({ type: 'confirm-payout', claimId: 'claim-a' })).toBe('claim-a');

    // THE INVARIANT: exactly TWO requests for the whole sequence — one initial
    // confirmation and one permitted retry, both for the claim that was
    // confirmed, and none for the duplicate submission.
    expect(requests).toEqual(['claim-a', 'claim-a']);
    expect(requests).toHaveLength(2);
    expect(isActionInFlight(actions.inFlight, aKey)).toBe(true);
    expect(isActionInFlight(actions.inFlight, bKey)).toBe(true);
    expect(actions.inFlight.size).toBe(2);
  });
});
