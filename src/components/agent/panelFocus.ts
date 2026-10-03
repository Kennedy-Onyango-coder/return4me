// AGENTHUB UX BATCH 1 (UX-02) — inline panel focus, without hooks.
//
// AgentHub and both panels are contractually hook-free: the extraction suites
// assert `use(State|Effect|Memo|Callback|Ref)(` never appears in them, so focus
// is coordinated with a REF CALLBACK plus stable per-item element ids rather
// than useRef/useEffect. This is deterministic React commit behaviour, not a
// timing hack.
//
// WHY A SHARED MODULE: both panels need identical open/close logic. Duplicating
// it would recreate exactly the duplication the structural extraction removed.
//
// This module is pure DOM. It holds no application state, performs no fetch,
// and imports nothing from the Agent stack.

/** Prefix for the per-item id of the control that opened a panel. */
const TRIGGER_ID_PREFIX = 'agent-panel-trigger-';

export type PanelKind = 'verify' | 'reject';

/**
 * The stable DOM id of a panel's originating action for a given item.
 *
 * Keyed by ITEM ID, never by a single global ref, so focus can never be
 * returned to a different card's button when several items are queued.
 */
export function panelTriggerId(itemId: string, kind: PanelKind): string {
  return `${TRIGGER_ID_PREFIX}${kind}-${itemId}`;
}

/**
 * Ref callback for a panel's focus target.
 *
 * On mount: moves focus into the panel, so a keyboard or screen-reader user
 * lands on the content that just replaced the control they activated rather
 * than on a node that no longer exists. Only the FIRST mount focuses, so
 * ordinary re-renders never steal focus and focus can never loop.
 *
 * On unmount (node === null): returns focus to that same item's originating
 * action. React invokes ref callbacks for DETACHED nodes during the mutation
 * phase and for ATTACHED nodes in the layout phase, so the trigger is
 * re-inserted by the very commit that closed the panel; the restore is queued
 * as a microtask, which runs once that commit has finished. That is
 * commit-ordering, not an arbitrary delay.
 *
 * SAFETY: if the originating element no longer exists — the item left the
 * queue after a successful action — `getElementById` returns null and focus is
 * simply left where the browser put it. Nothing throws and no focus is taken
 * from an unrelated element.
 */
export function panelFocusRef(itemId: string, kind: PanelKind) {
  let hasFocused = false;
  return (node: HTMLElement | null) => {
    if (node) {
      if (hasFocused) return;
      hasFocused = true;
      node.focus?.();
      return;
    }
    hasFocused = false;
    const triggerId = panelTriggerId(itemId, kind);
    queueMicrotask(() => {
      const trigger = document.getElementById(triggerId);
      if (trigger && typeof trigger.focus === 'function') trigger.focus();
    });
  };
}
