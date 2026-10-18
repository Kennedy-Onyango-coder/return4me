// =============================================================================
// WP4 follow-up — one-shot consumption of a pending Terms anchor.
// =============================================================================
//
// The public footer's "Fee Schedule" button opens the Terms page on section 4.
// App cannot scroll by itself (TermsView is lazy, so the section does not exist
// yet at click time), so it hands a *pending anchor* to the view, which applies
// it after mounting.
//
// THE BUG THIS MODULE EXISTS TO PREVENT
//   The pending anchor used to be written and never cleared. It therefore stayed
//   set for the rest of the session, and because a pending anchor is applied on
//   MOUNT, every later, ordinary visit to the Terms page re-scrolled the reader
//   to the fee schedule — after they had asked for "Terms of Service" and
//   expected the top of the document. The anchor is an intent, not a setting: it
//   has to be consumed exactly once.
//
// WHY A PURE FUNCTION
//   This repository has no DOM/React harness, so the one-shot rule is stated
//   here — where it can be unit-tested against a fake document — instead of
//   being implied by an effect's dependency list. The caller supplies the
//   document (so server rendering and tests can pass `null`) and a callback that
//   tells the owner "this anchor is spent, drop it".
// =============================================================================

/** The only part of `document` this module needs, so tests can pass a fake. */
export type TermsAnchorDocument = Pick<Document, 'getElementById'>;

export interface PendingTermsAnchorOptions {
  /** The pending anchor id, or a nullish value meaning "start at the top". */
  anchor: string | null | undefined;
  /** The document to search, or null when there is no DOM. */
  documentRef?: TermsAnchorDocument | null;
  /**
   * Called once the pending anchor has been consumed — whether or not a target
   * with that id was found. An unknown id must still consume the pending value,
   * otherwise a typo would leave the anchor armed for every future visit.
   */
  onApplied?: () => void;
}

/**
 * Applies a pending anchor to the mounted document and reports that it has been
 * spent. Returns `true` only when there was an anchor to consume.
 *
 * Deliberately NOT re-entrant-safe state: the caller owns the pending value and
 * drops it via `onApplied`. Calling this again with the same anchor would scroll
 * again, which is why App clears the value instead of leaving it set.
 */
export function applyPendingTermsAnchor({
  anchor,
  documentRef,
  onApplied,
}: PendingTermsAnchorOptions): boolean {
  // No pending anchor, or no DOM (server rendering) — nothing was consumed, so
  // the caller keeps its state untouched.
  if (!anchor || !documentRef) return false;

  const target = documentRef.getElementById(anchor);
  // A missing section is not an error: the reader simply lands at the top,
  // exactly as they would have before the deep link existed.
  if (target && typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ block: 'start' });
  }

  // Spent either way — see `onApplied` above.
  if (onApplied) onApplied();

  return true;
}
