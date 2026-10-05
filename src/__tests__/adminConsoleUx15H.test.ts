import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// UX-15H — THE ADMIN IMAGE LIGHTBOX / IMAGE-ZOOM VIEWER: AUDITED, KEPT, BROUGHT IN LINE
// =============================================================================
// UX-15G closed the shared confirmation dialog and recorded one deliberate,
// out-of-scope finding: the image lightbox was still bespoke. This batch is that
// audit — and the audit's answer is NOT "everything must become the Modal".
//
// WHAT THE SOURCE ACTUALLY SAYS (the findings this file pins)
//   * ONE piece of state, `lightboxImage: string | null`, opened by six trigger
//     call sites — the two item thumbnails, the agent shop-photo and
//     ID-document disclosures (each with a pointer and a keyboard path), and the
//     dispute claimant card through its `onViewPhoto` prop — and dismissed by a
//     click anywhere on the veil or Escape. (The claimant card's image was the
//     one trigger with NO keyboard route of its own; the UX-15 closure audit
//     gave it one — see adminConsoleUx15Closure.test.ts.)
//   * The marker called it a "Portal" and nothing was portalled. The veil is
//     `fixed inset-0` inside the `.fade-in` console root, and `.fade-in`'s
//     `forwards` entrance animation leaves `transform: translateY(0)` applied. A
//     transformed ancestor is the containing block for `fixed` descendants, so
//     the "full screen" veil was sized to the console rather than to the
//     viewport for every admin whose OS does not request reduced motion.
//   * Focus was moved into the viewer on open (an earlier batch's fix, so that
//     Escape had a listener at all) but never restored; Tab walked straight out
//     of the viewer into the console dimmed behind it; body scroll was not
//     locked; and there was no close control at all.
//
// THE DECISION: KEEP IT SPECIALIZED (Outcome B of the batch brief)
//   The shared `Modal` is a card — on phones a bottom sheet, on desktop a
//   bordered `sm:max-w-lg` (32rem / 512px) `--appearance-surface` panel with a
//   header bar, a padded scrollable body and a footer slot. The viewer's whole
//   purpose is the opposite: a photograph BIGGER than any card, contained to
//   `max-w-4xl` / `max-h-[80vh]` and laid directly on a near-opaque black veil,
//   with no card, no header, no footer and no bottom-sheet behaviour. Hosting it
//   in the primitive would mean `hideTitle` (leaving an empty header bar behind)
//   plus a class-order-dependent `sm:max-w-*` override — fighting the primitive
//   at every level, and shrinking the photograph while doing it. So it stays
//   specialized, and this batch modernises only what is safe, by sharing the
//   foundation's MECHANISM rather than its layout:
//     * a `createPortal` to `document.body` — the primitive's own target — which
//       is what makes the `fixed` veil genuinely viewport-anchored;
//     * the same `utils/modalFocus.ts` Trap for Tab: no second focus system;
//     * focus restored to the opener, and body scroll locked with scrollbar
//       compensation, in the primitive's own order;
//     * a labelled 44px close control beside the existing dismissals;
//     * `rounded-panel` on the image; white on the fixed black hint pill (the
//       appearance text roles flip with the theme and measure under 3:1 there).
//   Deliberately PRESERVED: `bg-black/90`, `z-[120]`, `fade-in`, the copy, the
//   alt text and the image sizing. `--appearance-scrim` is 0.6 opaque in the
//   light theme, so adopting it would let the console show through behind the
//   photograph being investigated.
//
// There is no jsdom/React harness in this repository, so — exactly as the
// UX-06 … UX-15G suites do — the contract is asserted against the shipped source
// with the same comment stripper and the same `sliceBetween` helper, and every
// assertion is made against a SLICE rather than against the whole file.
// =============================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const ADMIN_VIEW_TSX = read('src/components/AdminView.tsx');
const DESIGN_SYSTEM = read('docs/design-system.md');
const INDEX_CSS = read('src/index.css');
const MODAL_PRIMITIVE = read('src/components/ui/Modal.tsx');
const MODAL_FOCUS_UTIL = read('src/utils/modalFocus.ts');

const count = (source: string, pattern: RegExp) => (source.match(pattern) || []).length;

function sliceBetween(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = start === -1 ? -1 : source.indexOf(to, start + from.length);
  if (start === -1 || end === -1) throw new Error(`UX-15H marker not found: ${from} -> ${to}`);
  return source.slice(start, end);
}

/** The whole file, comments removed. */
const CODE = stripComments(ADMIN_VIEW_TSX);

/* ---------------------------------------------------------------------------
 * The scope boundaries, each taken from the real source so they cannot drift.
 * ------------------------------------------------------------------------- */
/** The lightbox marker itself. Three earlier suites use this exact string as the
 *  end of the confirmation-dialog slice, so it is pinned byte-for-byte. */
const LIGHTBOX = '{/* Lightbox Image Zoom Portal */}';
const LIGHTBOX_TSX = ADMIN_VIEW_TSX.slice(ADMIN_VIEW_TSX.indexOf(LIGHTBOX));
const LIGHTBOX_CODE = stripComments(LIGHTBOX_TSX);
/** The state and the open/close lifecycle effect that own the viewer. */
const STATE_EFFECT = sliceBetween(
  ADMIN_VIEW_TSX,
  'const lightboxCloseRef = useRef<HTMLDivElement | null>(null);',
  '// Categories loading for admin corrections',
);
/** UX-14's gate ends — and UX-15's authenticated console begins — here. */
const GATE_TSX = ADMIN_VIEW_TSX.slice(0, ADMIN_VIEW_TSX.indexOf('{/* 2. DISTINCT LOADING'));
const GATE = stripComments(GATE_TSX);

/* ---------------------------------------------------------------------------
 * The guards — the same ones the UX-15C/D/E/F/G suites use, plus the radius
 * ladder this batch also puts its own surface on.
 * ------------------------------------------------------------------------- */
/** Off-ladder / sub-12px type: the UX-01 ladder is the only scale allowed. */
const offLadderType = (source: string): string[] => [
  ...(source.match(/text-\[\d+px\]/g) || []),
  ...(source.match(/\btext-(?:xs|sm|base|lg|xl|2xl|3xl|4xl|5xl)(?![\w-])/g) || []),
];
/** Pre-UX-01 colour: raw hex, a fixed palette, or a literal white surface. */
const legacyColour = (source: string): string[] => [
  ...(source.match(/#[0-9a-fA-F]{3,8}\b/g) || []),
  ...(source.match(/\b(?:bg|text|border)-(?:stone|slate|gray|zinc|emerald|amber|sky|red)-/g) || []),
  ...(source.match(/\bbg-white\b/g) || []),
];
/** Icons sized by a magic number instead of the UX-01 ladder. */
const magicIconSize = (source: string): string[] => [
  ...(source.match(/size=\{\d+\}/g) || []),
  ...(source.match(/(?:^|[\s"])w-6 h-6(?![\w-])/g) || []),
];
/** Any browser dialog: the console is a page, never a native prompt. */
const browserDialog = (source: string): string[] =>
  source.match(/\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/g) || [];
/** Off-ladder radius: the UX-01 ladder is compact / small / standard / panel / hero. */
const offLadderRadius = (source: string): string[] =>
  source.match(/\brounded-(?:md|lg|xl|2xl|3xl)(?![\w-])/g) || [];

// -----------------------------------------------------------------------------
// A. The contract the audit found: one piece of state, six triggers, three exits.
// -----------------------------------------------------------------------------

describe('UX-15H: the lightbox contract as it actually shipped', () => {
  it('still owns exactly one piece of state and one close ref', () => {
    expect(ADMIN_VIEW_TSX).toContain(
      'const [lightboxImage, setLightboxImage] = useState<string | null>(null);',
    );
    expect(count(CODE, /const \[lightboxImage, setLightboxImage\]/g)).toBe(1);
    expect(STATE_EFFECT).toContain(
      'const lightboxCloseRef = useRef<HTMLDivElement | null>(null);',
    );
    // The ref is the viewer's programmatic focus target and nothing else.
    expect(count(CODE, /const lightboxCloseRef/g)).toBe(1);
  });

  it('is opened by six call sites and closed by three dismissal paths', () => {
    const calls = CODE.match(/setLightboxImage\([^)]*\)/g) || [];
    expect(calls).toHaveLength(9);
    // Six triggers store a real URL — each with a pointer and a keyboard path.
    expect(calls.filter((c) => c === 'setLightboxImage(agentDocs.shop_photo_url)')).toHaveLength(2);
    expect(calls.filter((c) => c === 'setLightboxImage(agentDocs.id_document_photo_url)')).toHaveLength(2);
    expect(calls.filter((c) => c === 'setLightboxImage(item.photo_url)')).toHaveLength(2);
    // …and the dispute claimant card reaches the same state through its prop.
    expect(CODE).toContain('onViewPhoto={setLightboxImage}');
    expect(CODE).toContain('onClick={() => onViewPhoto(ev.evidence_photo_url)}');
    // Three exits, all of them `null`.
    expect(calls.filter((c) => c === 'setLightboxImage(null)')).toHaveLength(3);
  });
});

// -----------------------------------------------------------------------------
// B. It deliberately does NOT become the shared Modal — and the reason is real.
// -----------------------------------------------------------------------------

describe('the viewer is not the shared Modal, and cannot be without damage', () => {
  it('keeps its own full-bleed viewer markup instead of the primitive', () => {
    expect(ADMIN_VIEW_TSX).toContain(LIGHTBOX);
    expect(LIGHTBOX_TSX).not.toContain('<Modal');
    // The four primitives in the file are unchanged: P1-01, UX-15E, UX-15F, UX-15G.
    expect(count(CODE, /<Modal/g)).toBe(4);
    expect(LIGHTBOX_CODE).toContain('role="dialog"');
    expect(LIGHTBOX_CODE).toContain('aria-modal="true"');
    expect(LIGHTBOX_CODE).toContain('aria-label="Zoomed photograph"');
    expect(LIGHTBOX_CODE).toContain('tabIndex={-1}');
    expect(LIGHTBOX_CODE).toContain('ref={lightboxCloseRef}');
  });

  it('pins the primitive properties that make it the wrong host', () => {
    // The card: a phone bottom sheet, a 32rem cap, a header bar with a border.
    expect(MODAL_PRIMITIVE).toContain('fixed inset-0 z-50 flex items-end sm:items-center justify-center');
    expect(MODAL_PRIMITIVE).toContain('w-full sm:max-w-lg max-h-[90vh] sm:max-h-[85vh] flex flex-col');
    expect(MODAL_PRIMITIVE).toContain('border-b border-[var(--appearance-border)] shrink-0');
    expect(MODAL_PRIMITIVE).toContain("aria-labelledby=\"r4m-modal-title\"");
    // …and the viewer needs the opposite: a photograph as large as the viewport
    // will give it, edge to edge, with no card surface around it.
    expect(LIGHTBOX_CODE).toContain('max-w-4xl');
    expect(LIGHTBOX_CODE).toContain('max-h-[80vh]');
    expect(LIGHTBOX_CODE).not.toContain('sm:max-w-lg');
    expect(LIGHTBOX_CODE).not.toContain('bg-[var(--appearance-surface)]');
    expect(LIGHTBOX_CODE).not.toContain('r4m-modal-title');
  });
});

// -----------------------------------------------------------------------------
// C. The portal: the marker always claimed one; UX-15H actually made it one.
// -----------------------------------------------------------------------------

describe('the veil is genuinely viewport-anchored now', () => {
  it('portals to document.body, like the shared primitive', () => {
    expect(ADMIN_VIEW_TSX).toContain("import { createPortal } from 'react-dom';");
    expect(LIGHTBOX_CODE).toContain('createPortal(');
    expect(LIGHTBOX_CODE).toContain('document.body,');
    expect(count(LIGHTBOX_CODE, /createPortal\(/g)).toBe(1);
    expect(MODAL_PRIMITIVE).toContain('createPortal');
  });

  it('records the transform that trapped its `fixed` geometry', () => {
    // The console root carries the entrance animation, which is what made it the
    // containing block for the `fixed` veil.
    expect(CODE).toContain('<div className="w-full fade-in">');
    expect(INDEX_CSS).toContain('.fade-in {');
    expect(INDEX_CSS).toContain('animation: fadeIn 0.4s ease-out forwards;');
    expect(INDEX_CSS).toContain('transform: translateY(0);');
    // …and the veil itself is byte-identical to what it always was.
    expect(LIGHTBOX_CODE).toContain(
      'fixed inset-0 z-[120] bg-black/90 flex items-center justify-center p-4 cursor-zoom-out fade-in',
    );
  });
});

// -----------------------------------------------------------------------------
// D. Focus: one trap, contained and returned — no second focus system.
// -----------------------------------------------------------------------------

describe('keyboard focus is contained and returned', () => {
  it('reuses the ONE focus trap the primitive already uses', () => {
    expect(MODAL_FOCUS_UTIL).toContain('export function trapModalFocus');
    expect(ADMIN_VIEW_TSX).toContain("import { trapModalFocus } from '../utils/modalFocus';");
    expect(LIGHTBOX_CODE).toContain('trapModalFocus(e.nativeEvent, lightboxCloseRef.current);');
    // …the same util the foundation wires on the same kind of container.
    expect(MODAL_PRIMITIVE).toContain('trapModalFocus(event, dialogRef.current);');
  });

  it('introduces no second trap of its own', () => {
    expect(LIGHTBOX_CODE).not.toContain('querySelector');
    expect(LIGHTBOX_CODE).not.toContain('addEventListener');
    expect(LIGHTBOX_CODE).not.toContain('focusableSelector');
    expect(LIGHTBOX_CODE).not.toContain('inert');
  });

  it('moves focus in on open and back to the opener on close', () => {
    expect(STATE_EFFECT).toContain(
      'const previouslyFocused = document.activeElement as HTMLElement | null;',
    );
    expect(STATE_EFFECT).toContain('lightboxCloseRef.current?.focus();');
    expect(STATE_EFFECT).toContain('previouslyFocused?.focus?.();');
    expect(STATE_EFFECT).toContain('if (!lightboxImage) return;');
    expect(STATE_EFFECT).toContain('}, [lightboxImage]);');
    // The restore lives in the cleanup, which is what runs as the veil unmounts.
    expect(STATE_EFFECT).toMatch(
      /return \(\) => \{[\s\S]*?previouslyFocused\?\.focus\?\.\(\);[\s\S]*?\};/,
    );
  });

  it('locks body scroll while it is open, and unlocks it on close', () => {
    expect(STATE_EFFECT).toContain(
      'const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;',
    );
    expect(STATE_EFFECT).toContain("document.body.style.overflow = 'hidden';");
    expect(STATE_EFFECT).toContain('document.body.style.paddingRight = `${scrollbarWidth}px`;');
    expect(STATE_EFFECT).toContain("document.body.style.overflow = previousOverflow;");
    expect(STATE_EFFECT).toContain(
      'document.body.style.paddingRight = previousPaddingRight;',
    );
  });
});

// -----------------------------------------------------------------------------
// E. Dismissal: click anywhere, Escape — and now a real, labelled close control.
// -----------------------------------------------------------------------------

describe('the viewer still dismisses the way it always did — plus one control', () => {
  it('closes on a click anywhere on the veil, on Escape, and on the close control', () => {
    expect(count(LIGHTBOX_CODE, /onClick=\{\(\) => setLightboxImage\(null\)\}/g)).toBe(2);
    expect(LIGHTBOX_CODE).toContain("e.key === 'Escape'");
    expect(LIGHTBOX_CODE).toContain('cursor-zoom-out');
    expect(LIGHTBOX_CODE).toContain('Click anywhere, or press Escape, to close full screen view');
  });

  it('gives the close control an accessible label and a 44px target', () => {
    expect(LIGHTBOX_CODE).toContain('type="button"');
    expect(LIGHTBOX_CODE).toContain(
      "aria-label={lang === 'en' ? 'Close full screen view' : 'Funga mwonekano wa skrini nzima'}",
    );
    expect(LIGHTBOX_CODE).toContain('absolute top-4 right-4 z-10 h-11 w-11 rounded-full');
    expect(LIGHTBOX_CODE).toContain('<X size={ICON_SIZE.emphasis} aria-hidden="true" />');
    // 44px is the documented touch floor, and `h-11 w-11` is how the hero
    // carousel controls (the existing "control over a photograph" idiom) meet it.
    expect(count(LIGHTBOX_CODE, /h-11 w-11/g)).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// F. The photograph itself: nothing about the image or its openers was lost.
// -----------------------------------------------------------------------------

describe('the photograph and every one of its openers survive the batch', () => {
  it('keeps the state-driven source, the alt text and the containment', () => {
    expect(LIGHTBOX_CODE).toContain('<img');
    expect(LIGHTBOX_CODE).toContain('src={lightboxImage}');
    expect(LIGHTBOX_CODE).toContain('alt="Zoomed Photograph"');
    expect(LIGHTBOX_CODE).toContain('max-w-full max-h-[80vh] object-contain rounded-panel');
    expect(LIGHTBOX_CODE).toContain('referrerPolicy="no-referrer"');
    expect(LIGHTBOX_CODE).toContain(
      'relative max-w-4xl max-h-[90vh] w-full h-full flex flex-col items-center justify-center',
    );
  });

  it('leaves every opener’s own affordance and keyboard path intact', () => {
    expect(count(CODE, /cursor-zoom-in/g)).toBe(2);
    expect(CODE).toContain('aria-label="View item photo full-size"');
    expect(CODE).toContain("if (e.key === 'Enter' || e.key === ' ')");
    // Four of these pre-dated this audit (the details disclosure and the three
    // opener containers); the fifth is the dispute claimant card's evidence
    // photograph, which the UX-15 closure audit gave the keyboard route it was
    // missing — see adminConsoleUx15Closure.test.ts.
    expect(count(CODE, /role="button"/g)).toBe(5);
    // The evidence-photo opener still passes its own URL through the card's prop.
    expect(CODE).toContain('onViewPhoto(ev.evidence_photo_url)');
  });
});

// -----------------------------------------------------------------------------
// G. Presentation: modernised only where a documented rule or role says so.
// -----------------------------------------------------------------------------

describe('the legacy presentation is modernised only where that is safe', () => {
  it('moves the image radius onto the UX-01 ladder', () => {
    expect(offLadderRadius(LIGHTBOX_CODE)).toEqual([]);
    expect(count(LIGHTBOX_CODE, /rounded-panel/g)).toBe(1);
    expect(LIGHTBOX_CODE).not.toContain('rounded-2xl');
  });

  it('keeps the photographic veil and the stacking as deliberate presentation', () => {
    // Not a token swap, and that is a recorded decision: the scrim role is 0.6
    // opaque in the light theme, which would let the console show through.
    expect(INDEX_CSS).toContain('--appearance-scrim: rgba(12, 10, 9, 0.6);');
    expect(INDEX_CSS).toContain('--appearance-scrim: rgba(0, 0, 0, 0.72);');
    expect(LIGHTBOX_CODE).toContain('bg-black/90');
    expect(LIGHTBOX_CODE).not.toContain('var(--appearance-scrim)');
    // Above the sticky header (z-40), the mobile drawer and the dialogs (z-50).
    expect(LIGHTBOX_CODE).toContain('z-[120]');
  });

  it('keeps the sanctioned entrance animation, and only that', () => {
    expect(LIGHTBOX_CODE).toContain('fade-in');
    expect(count(LIGHTBOX_CODE, /fade-in/g)).toBe(1);
    expect(INDEX_CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.fade-in \{\s*animation: none;/,
    );
  });

  it('reads the hint off a fixed photographic surface, not a theme role', () => {
    expect(LIGHTBOX_CODE).toContain(
      'text-white text-caption mt-4 font-bold bg-black/70 px-4 py-2 rounded-full uppercase tracking-wider',
    );
    expect(LIGHTBOX_CODE).not.toContain('text-[var(--appearance-text-muted)]');
  });

  it('introduces no off-ladder type, palette literal, magic icon size or native dialog', () => {
    expect(offLadderType(LIGHTBOX_CODE)).toEqual([]);
    expect(legacyColour(LIGHTBOX_CODE)).toEqual([]);
    expect(magicIconSize(LIGHTBOX_CODE)).toEqual([]);
    expect(browserDialog(LIGHTBOX_CODE)).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// H. Scope: UX-14, UX-15E, UX-15F, UX-15G and UX-16 stay exactly where they are.
// -----------------------------------------------------------------------------

describe('the batch stays in its lane', () => {
  it('leaves the UX-14 authentication gate exactly where it was', () => {
    expect(count(CODE, /\{!token && \(/g)).toBe(1);
    expect(GATE_TSX).toContain('{!token && (');
    expect(GATE_TSX).not.toContain('{/* 2. DISTINCT LOADING');
    expect(GATE).toContain('Admin Authentication');
    expect(GATE).toContain('pendingTwoFactorToken');
  });

  it('leaves the three shared dialogs on the primitive', () => {
    expect(ADMIN_VIEW_TSX).toContain('open={itemReviewPrompt !== null}');
    expect(ADMIN_VIEW_TSX).toContain('onClose={closeItemReviewPrompt}');
    expect(ADMIN_VIEW_TSX).toContain('open={agentWarnPrompt !== null}');
    expect(ADMIN_VIEW_TSX).toContain('onClick={confirmAgentWarn}');
    expect(ADMIN_VIEW_TSX).toContain('open={confirmModal !== null}');
    expect(ADMIN_VIEW_TSX).toContain('onClick={closeConfirmModal}');
    expect(ADMIN_VIEW_TSX).toContain('onClick={confirmPendingAction}');
    // The six confirmation flows still store their request in the shared state.
    expect(count(CODE, /setConfirmModal\(\{/g)).toBe(6);
  });

  it('does not reach into the viewer from any dialog', () => {
    expect(LIGHTBOX_CODE).not.toContain('confirmModal');
    expect(LIGHTBOX_CODE).not.toContain('itemReviewPrompt');
    expect(LIGHTBOX_CODE).not.toContain('agentWarnPrompt');
    expect(LIGHTBOX_CODE).not.toContain('setAdminActionProcessing');
  });

  it('does not start UX-16', () => {
    expect(ADMIN_VIEW_TSX).not.toContain('AgentVerificationPanel');
    expect(ADMIN_VIEW_TSX).not.toContain('AgentRejectionPanel');
    expect(ADMIN_VIEW_TSX).not.toContain('OTPInput');
    expect(ADMIN_VIEW_TSX).not.toMatch(/from '\.\/agent\//);
  });

  it('records the audit in the design system without weakening the queue', () => {
    const row = DESIGN_SYSTEM.split(/\r?\n/).find((line) => line.startsWith('| AdminView |'));
    expect(row, 'the design system must keep the AdminView queue row').toBeDefined();
    expect(row as string).toContain('UX-15H');
    // The five earlier UX-15 records still pin both cells of that row.
    expect(row as string).toContain('MIGRATE LATER');
    expect(row as string).toContain('UX-16');
    // §12 records WHY the viewer is not a dialog, in the Modals section itself.
    expect(DESIGN_SYSTEM).toContain('One overlay deliberately stays outside that foundation');
    expect(DESIGN_SYSTEM).toContain('image lightbox / image-zoom viewer');
  });
});

// -----------------------------------------------------------------------------
// I. The guards are live, not decorative.
// -----------------------------------------------------------------------------

describe('the UX-15H guards are live, not decorative (mutation checks)', () => {
  it('detects a reintroduced off-ladder type size', () => {
    expect(offLadderType(`${LIGHTBOX_CODE} text-xs`)).not.toEqual([]);
    expect(offLadderType(`${LIGHTBOX_CODE} text-[11px]`)).not.toEqual([]);
  });

  it('detects a reintroduced legacy colour literal', () => {
    expect(legacyColour(`${LIGHTBOX_CODE} bg-white`)).not.toEqual([]);
    expect(legacyColour(`${LIGHTBOX_CODE} text-stone-500`)).not.toEqual([]);
  });

  it('detects a reintroduced magic icon size', () => {
    expect(magicIconSize(`${LIGHTBOX_CODE} size={16}`)).not.toEqual([]);
    expect(
      magicIconSize('<Loader2 className="animate-spin w-6 h-6" aria-hidden="true" />'),
    ).not.toEqual([]);
  });

  it('detects a reintroduced off-ladder radius', () => {
    expect(offLadderRadius(`${LIGHTBOX_CODE} rounded-2xl`)).not.toEqual([]);
  });

  it('detects a reintroduced browser dialog', () => {
    expect(browserDialog(`${LIGHTBOX_CODE} window.confirm('really?')`)).not.toEqual([]);
  });

  it('detects the viewer being re-hosted in the primitive', () => {
    // The B-suite assertion is not vacuous: this is the exact shape it rejects.
    expect(`${LIGHTBOX_TSX} <Modal open={lightboxImage !== null}>`).toContain('<Modal');
  });
});




