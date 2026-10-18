// =============================================================================
// WP4 follow-up — the pending Terms anchor is consumed EXACTLY ONCE.
// =============================================================================
//
// REGRESSION UNDER TEST
//   The footer's "Fee Schedule" button sets a pending anchor and opens Terms.
//   The anchor used to be written and never cleared, so it stayed set for the
//   rest of the session; because a pending anchor is applied on MOUNT, every
//   later, ordinary visit to the Terms page ("Terms of Service" link) jumped the
//   reader down to section 4 again.
//
//   These are real behavioural tests of the helper both sides share — no DOM is
//   needed because the document is injected — plus one state machine that walks
//   the exact two-step journey a visitor performs.
// =============================================================================
import { describe, it, expect } from 'vitest';
import { applyPendingTermsAnchor, type TermsAnchorDocument } from '../termsAnchor';

interface ScrollCall {
  id: string;
  options?: ScrollIntoViewOptions;
}

/** A fake document that records which sections were scrolled to, and how. */
function fakeDocument(present: string[], calls: ScrollCall[]): TermsAnchorDocument {
  return {
    getElementById: (id: string) => {
      if (!present.includes(id)) return null;
      return {
        scrollIntoView: (options?: ScrollIntoViewOptions) => {
          calls.push({ id, options });
        },
      } as unknown as HTMLElement;
    },
  };
}

describe('applyPendingTermsAnchor — the deep link lands, then is spent', () => {
  it('scrolls to the requested section and reports that it has been consumed', () => {
    const calls: ScrollCall[] = [];
    let applied = 0;

    const result = applyPendingTermsAnchor({
      anchor: 'fee-schedule',
      documentRef: fakeDocument(['fee-schedule'], calls),
      onApplied: () => { applied += 1; },
    });

    expect(result).toBe(true);
    // The jump uses `block: 'start'` so the section heading (with its
    // `scroll-mt-24`) is the thing the reader lands on.
    expect(calls).toEqual([{ id: 'fee-schedule', options: { block: 'start' } }]);
    // The owner is told the anchor is spent — this is the line that was missing.
    expect(applied).toBe(1);
  });

  it('does nothing at all when there is no pending anchor (ordinary visit)', () => {
    const calls: ScrollCall[] = [];
    let applied = 0;

    for (const anchor of [null, undefined, '']) {
      expect(
        applyPendingTermsAnchor({
          anchor,
          documentRef: fakeDocument(['fee-schedule'], calls),
          onApplied: () => { applied += 1; },
        }),
      ).toBe(false);
    }

    // An ordinary "Terms of Service" visit starts at the top of the document.
    expect(calls).toEqual([]);
    expect(applied).toBe(0);
  });

  it('still consumes the anchor when the section id does not exist', () => {
    const calls: ScrollCall[] = [];
    let applied = 0;

    const result = applyPendingTermsAnchor({
      anchor: 'no-such-section',
      documentRef: fakeDocument(['fee-schedule'], calls),
      onApplied: () => { applied += 1; },
    });

    expect(result).toBe(true);     // there WAS an anchor to consume
    expect(calls).toEqual([]);     // nothing to scroll to — the reader stays put
    // A typo must not leave the anchor armed for every future visit.
    expect(applied).toBe(1);
  });

  it('never throws and never consumes when there is no document (server render)', () => {
    let applied = 0;
    const result = applyPendingTermsAnchor({
      anchor: 'fee-schedule',
      documentRef: null,
      onApplied: () => { applied += 1; },
    });

    expect(result).toBe(false);
    // The pending value must survive: the client render has not happened yet.
    expect(applied).toBe(0);
  });

  it('remembers nothing itself — the caller owns the one-shot rule', () => {
    const calls: ScrollCall[] = [];
    const documentRef = fakeDocument(['fee-schedule'], calls);

    // Two calls with the same anchor scroll twice. That is intentional: the
    // helper has no hidden "already done" state. App clears the pending value
    // (covered by the journey test below and by the wiring contract).
    applyPendingTermsAnchor({ anchor: 'fee-schedule', documentRef });
    applyPendingTermsAnchor({ anchor: 'fee-schedule', documentRef });
    expect(calls).toHaveLength(2);
  });

  it('models the reported journey: deep link, then an ordinary visit', () => {
    // ── App state (the single source of the pending anchor) ────────────────
    let pendingAnchor: string | null = null;
    const calls: ScrollCall[] = [];
    const documentRef = fakeDocument(['fee-schedule'], calls);

    // What TermsView's effect does on every mount.
    const mountTerms = () => applyPendingTermsAnchor({
      anchor: pendingAnchor,
      documentRef,
      onApplied: () => { pendingAnchor = null; },
    });

    // 1. Click "Fee Schedule" in the footer.
    pendingAnchor = 'fee-schedule';
    expect(mountTerms()).toBe(true);
    expect(calls.map((c) => c.id)).toEqual(['fee-schedule']);
    expect(pendingAnchor).toBeNull();

    // 2. Leave Terms, then click "Terms of Service" (an ordinary navigation).
    expect(mountTerms()).toBe(false);
    expect(calls.map((c) => c.id)).toEqual(['fee-schedule']); // no second jump
    expect(pendingAnchor).toBeNull();
  });
});
