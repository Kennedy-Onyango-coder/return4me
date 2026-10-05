import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// UX-15 CLOSURE — THE ADMIN CONSOLE'S LAST POINTER-ONLY PHOTO OPENER
// =============================================================================
// UX-15A … UX-15H closed the authenticated Admin Console. UX-15H (the image
// lightbox: audited, KEPT as a specialized overlay by decision, and brought onto
// the foundation's mechanism) reported two findings it deliberately did not fix.
// This is the closure audit that decides them.
//
// 1. THE DISPUTE CLAIMANT CARD'S EVIDENCE-PHOTO OPENER WAS POINTER-ONLY — a
//    genuine closure defect. The image carried `onClick` and `cursor-zoom-in`
//    and nothing else, while the console's other three opener call sites (the
//    agent shop-photo and ID-document disclosures and the item thumbnail) each
//    offer a pointer AND a keyboard route. Fixed here in the console's own
//    idiom: `role="button"`, `tabIndex={0}`, Enter/Space through `onKeyDown` and
//    a bilingual `aria-label`. Same `onViewPhoto(...)`, same image, same URL,
//    same sizing; the viewer itself is untouched.
//
// 2. THE LIGHTBOX'S ALT / HINT ARE ENGLISH-ONLY — judged NOT a UX-15 closure
//    defect. UX-15's scope is presentation and accessibility, not language
//    coverage; the console's copy is a long-standing mix (the section chrome is
//    bilingual, while panel internals such as "Agent Verification Photographs",
//    "Quick Categories:" and the three openers' own `aria-label`s are
//    English-only); UX-15C/D/E/H left every PRE-EXISTING English string verbatim
//    and only NEW chrome follows the bilingual convention (UX-15H's own close
//    control says "Funga mwonekano wa skrini nzima"); and translating three
//    strings in one overlay would leave its three triggers and its neighbours
//    English — arbitrary spot-translation instead of the console-wide i18n pass
//    the remaining English-only copy actually needs. Recorded as future work.
//
// There is no jsdom/React harness in this repository, so — exactly as the
// UX-06 … UX-15H suites do — the contract is asserted against the shipped source
// with the same comment stripper and the same `sliceBetween` helper.
// =============================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const ADMIN_VIEW_TSX = read('src/components/AdminView.tsx');
const DESIGN_SYSTEM = read('docs/design-system.md');

const count = (source: string, pattern: RegExp) => (source.match(pattern) || []).length;

function sliceBetween(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = start === -1 ? -1 : source.indexOf(to, start + from.length);
  if (start === -1 || end === -1) throw new Error(`UX-15 closure marker not found: ${from} -> ${to}`);
  return source.slice(start, end);
}

/** The whole file, comments removed. */
const CODE = stripComments(ADMIN_VIEW_TSX);
/** The one component this audit changed. */
const CLAIMANT = stripComments(
  sliceBetween(ADMIN_VIEW_TSX, 'function DisputeClaimantPanel({', 'const CONSOLE_SECTIONS'),
);
/** The viewer UX-15H owns — changed by nothing here. */
const LIGHTBOX_TSX = ADMIN_VIEW_TSX.slice(
  ADMIN_VIEW_TSX.indexOf('{/* Lightbox Image Zoom Portal */}'),
);
const LIGHTBOX_CODE = stripComments(LIGHTBOX_TSX);
/** The UX-14 gate: every assertion about it must still hold. */
const GATE = stripComments(
  sliceBetween(ADMIN_VIEW_TSX, '{!token && (', '{/* 2. DISTINCT LOADING'),
);

/* The same guards the UX-15C/D/E/F/G/H suites use. */
const offLadderType = (source: string): string[] => [
  ...(source.match(/text-\[\d+px\]/g) || []),
  ...(source.match(/\btext-(?:xs|sm|base|lg|xl|2xl|3xl|4xl|5xl)(?![\w-])/g) || []),
];
const legacyColour = (source: string): string[] => [
  ...(source.match(/#[0-9a-fA-F]{3,8}\b/g) || []),
  ...(source.match(/\b(?:bg|text|border)-(?:stone|slate|gray|zinc|emerald|amber|sky|red)-/g) || []),
  ...(source.match(/\bbg-white\b/g) || []),
];
const magicIconSize = (source: string): string[] => [
  ...(source.match(/size=\{\d+\}/g) || []),
  ...(source.match(/(?:^|[\s"])w-6 h-6(?![\w-])/g) || []),
];
const browserDialog = (source: string): string[] =>
  source.match(/\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/g) || [];
const offLadderRadius = (source: string): string[] =>
  source.match(/\brounded-(?:md|lg|xl|2xl|3xl)(?![\w-])/g) || [];

// -----------------------------------------------------------------------------
// A. The defect this audit closes: the last pointer-only photo opener.
// -----------------------------------------------------------------------------

describe('the dispute claimant evidence-photo opener is reachable from the keyboard', () => {
  it('is a button with a tab stop and an accessible name', () => {
    expect(CLAIMANT).toContain('role="button"');
    expect(CLAIMANT).toContain('tabIndex={0}');
    expect(CLAIMANT).toContain('onKeyDown={(e) => {');
    // New chrome follows the console's bilingual convention, so the audit adds
    // no fresh English-only string to a component whose copy is bilingual.
    expect(CLAIMANT).toContain(
      "aria-label={en ? 'View evidence photograph full-size' : 'Tazama picha ya ushahidi kwa ukubwa kamili'}",
    );
  });

  it('fires the same onViewPhoto call from the pointer and from Enter/Space', () => {
    expect(CLAIMANT).toContain('onClick={() => onViewPhoto(ev.evidence_photo_url)}');
    expect(CLAIMANT).toContain("if (e.key === 'Enter' || e.key === ' ') {");
    expect(CLAIMANT).toContain('e.preventDefault();');
    // Exactly two routes to the one existing call — and the prop is unchanged.
    expect(count(CLAIMANT, /onViewPhoto\(ev\.evidence_photo_url\)/g)).toBe(2);
    expect(CODE).toContain('onViewPhoto={setLightboxImage}');
  });

  it('keeps the image, its bilingual alt and its sizing exactly as they were', () => {
    expect(CLAIMANT).toContain('src={ev.evidence_photo_url}');
    expect(CLAIMANT).toContain(
      "alt={en ? 'Evidence photograph submitted with this claim' : 'Picha ya ushahidi iliyowasilishwa'}",
    );
    expect(CLAIMANT).toContain('referrerPolicy="no-referrer"');
    expect(CLAIMANT).toContain(
      'w-full max-h-40 object-contain rounded-lg border border-[var(--appearance-border)]',
    );
  });

  it('leaves the zoom affordance declared exactly once, on the control', () => {
    // `cursor` is inherited, so the wrapper carries it and the image does not.
    expect(count(CLAIMANT, /cursor-zoom-in/g)).toBe(1);
    // …and the file's two zoom affordances (this one, the item thumbnail) stand.
    expect(count(CODE, /cursor-zoom-in/g)).toBe(2);
  });
});

// -----------------------------------------------------------------------------
// B. Nothing else in the batch moves.
// -----------------------------------------------------------------------------

describe('the audit does not disturb the batch it closes', () => {
  it('leaves the viewer UX-15H shipped alone', () => {
    expect(LIGHTBOX_CODE).toContain('createPortal(');
    expect(LIGHTBOX_CODE).toContain('document.body,');
    expect(LIGHTBOX_CODE).toContain('role="dialog"');
    expect(LIGHTBOX_CODE).toContain('aria-modal="true"');
    expect(LIGHTBOX_CODE).toContain('trapModalFocus(e.nativeEvent, lightboxCloseRef.current)');
    expect(LIGHTBOX_CODE).toContain('aria-label="Zoomed photograph"');
    expect(LIGHTBOX_CODE).toContain('alt="Zoomed Photograph"');
    expect(LIGHTBOX_CODE).not.toContain('<Modal');
  });

  it('keeps the console’s four dialogs, six confirmation flows and openers', () => {
    expect(count(CODE, /<Modal/g)).toBe(4);
    expect(count(CODE, /setConfirmModal\(\{/g)).toBe(6);
    // Five role="button" containers: the details disclosure, the three
    // pre-existing photo openers and — since this audit — the claimant card.
    expect(count(CODE, /role="button"/g)).toBe(5);
    expect(CODE).toContain('aria-label="View item photo full-size"');
    expect(CODE).toContain('setLightboxImage(agentDocs.shop_photo_url)');
    expect(CODE).toContain('setLightboxImage(agentDocs.id_document_photo_url)');
    expect(CODE).toContain('setLightboxImage(item.photo_url)');
  });

  it('starts no native dialog, no UX-16 surface and no gate change', () => {
    expect(browserDialog(CODE)).toEqual([]);
    expect(ADMIN_VIEW_TSX).not.toContain('AgentVerificationPanel');
    expect(ADMIN_VIEW_TSX).not.toContain('AgentRejectionPanel');
    expect(ADMIN_VIEW_TSX).not.toContain('OTPInput');
    expect(ADMIN_VIEW_TSX).not.toMatch(/from '\.\/agent\//);
    expect(count(CODE, /\{!token && \(/g)).toBe(1);
    // The fix is in a console panel, never in the signed-out gate.
    expect(GATE).not.toMatch(/tabIndex|aria-modal/);
    expect(GATE).toContain('Admin Authentication');
  });

  it('records the closure in the design system without weakening the queue', () => {
    const row = DESIGN_SYSTEM.split(/\r?\n/).find((line) => line.startsWith('| AdminView |'));
    expect(row).toBeDefined();
    expect(row as string).toContain('MIGRATE LATER');
    expect(DESIGN_SYSTEM).toContain('One overlay deliberately stays outside that foundation');
    expect(DESIGN_SYSTEM).toContain(
      "Every one of the viewer's openers now offers both a pointer and a keyboard route",
    );
  });
});

// -----------------------------------------------------------------------------
// C. The guards are live on the component this audit touched.
// -----------------------------------------------------------------------------

describe('the guards are live on the component this audit touched', () => {
  it('finds no off-ladder type, palette literal, magic icon size or native dialog', () => {
    expect(offLadderType(CLAIMANT)).toEqual([]);
    expect(legacyColour(CLAIMANT)).toEqual([]);
    expect(magicIconSize(CLAIMANT)).toEqual([]);
    expect(browserDialog(CLAIMANT)).toEqual([]);
    expect(offLadderRadius(LIGHTBOX_CODE)).toEqual([]);
  });

  it('is not vacuous: each guard still detects the regression it exists for', () => {
    expect(offLadderType(`${CLAIMANT} text-xs`)).not.toEqual([]);
    expect(legacyColour(`${CLAIMANT} text-stone-500`)).not.toEqual([]);
    expect(magicIconSize(`${CLAIMANT} size={16}`)).not.toEqual([]);
    expect(browserDialog(`${CLAIMANT} window.confirm('really?')`)).not.toEqual([]);
    expect(offLadderRadius(`${LIGHTBOX_CODE} rounded-2xl`)).not.toEqual([]);
  });
});
