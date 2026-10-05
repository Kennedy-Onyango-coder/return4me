import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// UX-15C/D/E — THE AUTHENTICATED ADMIN CONSOLE PANELS + THE REVIEW MODAL
// =============================================================================
// UX-15A/B (adminConsoleUx15.test.ts) ended at the console chrome: the loading /
// error / empty states, the identity band, the sign-out, the section navigation
// and the section heading band. Everything BELOW that chrome — the nine section
// panels — was left deliberately untouched and is what this batch does.
//
//   UX-15C  the panels' legacy presentation: the `stone-*` / `red-*` palettes,
//           the literal `bg-white` cards, the `brand-*` / `canvas-*` surfaces
//           that never flipped in the dark theme, and the off-ladder
//           `text-[9px]` / `[10px]` / `[11px]` captions;
//   UX-15D  every remaining direct icon size, onto the UX-01 icon ladder;
//   UX-15E  the native `window.prompt()` at the item-review reason step,
//           replaced with the SAME shared ui/Modal the refund reconciliation
//           already uses.
//
// UX-15C/D/E IS PRESENTATION AND ACCESSIBILITY ONLY. It changes none of:
//   * the authentication gate (UX-14's surface, sliced around below);
//   * the dashboard data contract, the fetch handlers or the mutation bodies;
//   * any section, state key, filter, condition, sort, table column, permission
//     or API call of the panels;
//   * the reason contract of the item-review flow (same endpoint, same
//     `{ reason }` payload, same required/optional rule, same `.trim()`, same
//     'A reason is required.' message);
//   * UX-16 (the agent verification/rejection panels, and the other rows the
//     design system still queues for it).
//
// There is no jsdom/React harness in this repository, so — exactly as the
// UX-06 … UX-15A/B suites do — the contract is asserted against the shipped
// source with the same comment stripper and the same `sliceBetween` helper, and
// every assertion is made against a SLICE rather than against the whole file.
// =============================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
/** The same comment stripper the UX-06 … UX-15A/B suites use. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const ADMIN_VIEW_TSX = read('src/components/AdminView.tsx');
const INDEX_CSS = read('src/index.css');
const DESIGN_SYSTEM = read('docs/design-system.md');
const MODAL_PRIMITIVE = read('src/components/ui/Modal.tsx');
const TEXTAREA_PRIMITIVE = read('src/components/ui/Textarea.tsx');

const count = (source: string, pattern: RegExp) => (source.match(pattern) || []).length;

function sliceBetween(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = start === -1 ? -1 : source.indexOf(to, start + from.length);
  if (start === -1 || end === -1) throw new Error(`UX-15C/D/E marker not found: ${from} -> ${to}`);
  return source.slice(start, end);
}

// -----------------------------------------------------------------------------
// The scope boundaries, each taken from the real markup so they cannot drift.
// -----------------------------------------------------------------------------
/**
 * `{/* 2. DISTINCT LOADING` is the byte-identical marker UX-14's gate ends at and
 * UX-15A/B's authenticated region begins at, so this batch can neither reach up
 * into the signed-out gate nor miss a panel.
 */
const CONSOLE_MARKER = '{/* 2. DISTINCT LOADING';
const GATE_TSX = ADMIN_VIEW_TSX.slice(0, ADMIN_VIEW_TSX.indexOf(CONSOLE_MARKER));
const CONSOLE_TSX = ADMIN_VIEW_TSX.slice(ADMIN_VIEW_TSX.indexOf(CONSOLE_MARKER));

/**
 * The BESPOKE confirm modal (`confirmModal`) is explicitly NOT part of this
 * batch — it keeps its own later scope. It is stripped here with exactly the
 * same two markers the batch itself uses, so the guard below covers every
 * migrated surface and none of the un-migrated one.
 */
const BESPOKE_MODAL = '{/* Custom Confirmation Modal */}';
const LIGHTBOX = '{/* Lightbox Image Zoom Portal */}';
const PANELS_TSX = CONSOLE_TSX.replace(sliceBetween(CONSOLE_TSX, BESPOKE_MODAL, LIGHTBOX), ' ');
const PANELS = stripComments(PANELS_TSX);
const GATE = stripComments(GATE_TSX);
const CODE = stripComments(ADMIN_VIEW_TSX);

/** UX-15E — the handlers that replaced `window.prompt()`. */
const REVIEW_FLOW = sliceBetween(
  ADMIN_VIEW_TSX,
  'const [itemReviewPrompt, setItemReviewPrompt] = useState<null | {',
  'const handleReleaseSettlementNow = async (claimId: string)',
);
/** UX-15E — the dialog itself (the shared Modal's props and body). It ends where
 *  the UX-15F agent-warning dialog begins, so the two shared dialogs stay
 *  separately assertable. */
const REVIEW_MODAL = sliceBetween(
  ADMIN_VIEW_TSX,
  'open={itemReviewPrompt !== null}',
  '{/* UX-15F — the agent-warning reason step',
);

/* ---------------------------------------------------------------------------
 * The guards. They are the same guards UX-15A/B mutation-checks, extended with
 * the two surface families and the magic icon box this batch also removed.
 * ------------------------------------------------------------------------- */
/** Off-ladder / sub-12px type: the UX-01 ladder is the only scale allowed. */
const offLadderType = (source: string): string[] => [
  ...(source.match(/text-\[\d+px\]/g) || []),
  ...(source.match(/\btext-(?:xs|sm|base|lg|xl|2xl|3xl|4xl|5xl)(?![\w-])/g) || []),
];
/** Pre-UX-01 colour: raw hex, a fixed palette (raw red included — the old error
 *  copy used exactly that), or a literal white surface. */
const legacyColour = (source: string): string[] => [
  ...(source.match(/#[0-9a-fA-F]{3,8}\b/g) || []),
  ...(source.match(/\b(?:bg|text|border)-(?:stone|slate|gray|zinc|emerald|amber|sky|red)-/g) || []),
  ...(source.match(/\bbg-white\b/g) || []),
];
/** Legacy light-only surfaces: the `brand-*` / `canvas-*` pairs (declared once,
 *  for the light palette only) and the light-only brand green. */
const legacySurface = (source: string): string[] => [
  ...(source.match(/\b(?:bg|text|border|divide)-(?:brand|canvas)-[\w-]+/g) || []),
  ...(source.match(/\b(?:text|bg|border|ring)-primary-(?:green|hover)\b/g) || []),
];
/** Icons sized by a magic number instead of the UX-01 ladder. */
const magicIconSize = (source: string): string[] => [
  ...(source.match(/size=\{\d+\}/g) || []),
  ...(source.match(/(?:^|[\s"])w-6 h-6(?![\w-])/g) || []),
];
/** Any browser dialog: the console is a page, never a native prompt. */
const browserDialog = (source: string): string[] =>
  source.match(/\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/g) || [];

// -----------------------------------------------------------------------------
// A. UX-15C — the panels' legacy presentation is gone.
// -----------------------------------------------------------------------------

describe('UX-15C: the console panels read the design system, not the old palette', () => {
  it('keeps the whole authenticated console on the UX-01 type ladder', () => {
    expect(offLadderType(PANELS)).toEqual([]);
    // The ladder steps the panels actually use — all size-preserving versus the
    // class each one replaced (caption 12 == text-xs, body 14 == text-sm,
    // body-large 16 == text-base, section 24 == text-2xl).
    expect(PANELS).toContain('text-caption');
    expect(PANELS).toContain('text-body');
    expect(PANELS).toContain('text-heading');
    expect(PANELS).toContain('text-section');
    // …and the floor is the ladder's 12px caption, not a 9/10/11px literal.
    expect(INDEX_CSS).toContain('--text-caption: 0.75rem;');
    expect(INDEX_CSS).toContain('HARD RULE: no normal visible Return4me UI uses 9px, 10px or 11px.');
  });

  it('keeps no legacy palette literal and no light-only surface', () => {
    expect(legacyColour(PANELS)).toEqual([]);
    expect(legacySurface(PANELS)).toEqual([]);
  });

  it('reads every surface, text and rule from an appearance token', () => {
    expect(count(PANELS, /bg-\[var\(--appearance-surface\)\]/g)).toBeGreaterThan(15);
    expect(PANELS).toContain('bg-[var(--appearance-surface-muted)]');
    expect(PANELS).toContain('text-[var(--appearance-text-primary)]');
    expect(PANELS).toContain('text-[var(--appearance-text-muted)]');
    expect(PANELS).toContain('text-[var(--appearance-text-secondary)]');
    expect(PANELS).toContain('border-[var(--appearance-border)]');
  });

  it('maps status meaning onto the semantic status roles', () => {
    expect(PANELS).toContain('text-[var(--appearance-danger)]');
    expect(PANELS).toContain('text-[var(--appearance-warning)]');
    expect(PANELS).toContain('text-[var(--appearance-success)]');
    expect(PANELS).toContain('text-[var(--appearance-primary)]');
  });

  it('works in the dark theme: every role it uses is declared for both themes', () => {
    // index.css declares each --appearance-* role TWICE: once for the light
    // palette and once inside html[data-theme='dark']. A role with a single
    // declaration would leave a migrated surface light-only.
    for (const token of [
      '--appearance-surface',
      '--appearance-surface-muted',
      '--appearance-text-primary',
      '--appearance-text-muted',
      '--appearance-text-secondary',
      '--appearance-border',
      '--appearance-danger',
      '--appearance-warning',
      '--appearance-success',
      '--appearance-primary',
      '--appearance-primary-hover',
      '--appearance-primary-foreground',
    ]) {
      expect(
        count(INDEX_CSS, new RegExp(`^\\s*${token}:`, 'gm')),
        `${token} must be declared for BOTH themes`,
      ).toBe(2);
    }
    expect(INDEX_CSS).toContain("html[data-theme='dark']");
  });
});

// -----------------------------------------------------------------------------
// B. UX-15D — the icon ladder.
// -----------------------------------------------------------------------------

describe('UX-15D: the console panels size every icon from the UX-01 ladder', () => {
  it('leaves no magic icon size behind', () => {
    expect(magicIconSize(PANELS)).toEqual([]);
  });

  it('reads the ladder instead of a literal, at the role-correct step', () => {
    expect(count(PANELS, /size=\{ICON_SIZE\.(?:metadata|ui|emphasis|heading|feature)\}/g)).toBeGreaterThan(15);
    expect(PANELS).toContain('size={ICON_SIZE.metadata}');
    expect(PANELS).toContain('size={ICON_SIZE.ui}');
    expect(PANELS).toContain('size={ICON_SIZE.feature}');
  });
});

// -----------------------------------------------------------------------------
// C. UX-15E — the item-review reason step: browser prompt -> shared Modal.
// -----------------------------------------------------------------------------

describe('UX-15E: the item-review reason step is the shared Modal, not window.prompt()', () => {
  it('removes the browser prompt from the item-review flow entirely', () => {
    expect(REVIEW_FLOW).not.toContain('window.prompt');
    expect(browserDialog(REVIEW_FLOW)).toEqual([]);
    expect(browserDialog(PANELS)).toEqual([]);
  });

  it('uses the ONE shared Modal — no second dialog component was introduced', () => {
    // Exactly three shared Modal usages exist in the file: the P1-01 refund
    // reconciliation, this reason step, and the agent-warning reason step UX-15F
    // added on the SAME primitive (it introduced no dialog component).
    expect(count(ADMIN_VIEW_TSX, /<Modal\b/g)).toBe(3);
    expect(ADMIN_VIEW_TSX).toContain("import Modal from './ui/Modal';");
    expect(REVIEW_MODAL).toContain('open={itemReviewPrompt !== null}');
    expect(REVIEW_MODAL).toContain('onClose={closeItemReviewPrompt}');
    expect(REVIEW_MODAL).toContain("title={itemReviewPrompt?.promptLabel ?? ''}");
    expect(REVIEW_MODAL).toContain('footer={');
    // Accessibility comes from the primitive itself: focus trap, Escape,
    // aria-modal, focus restoration — none of which window.prompt() had.
    expect(MODAL_PRIMITIVE).toContain('role="dialog"');
    expect(MODAL_PRIMITIVE).toContain('aria-modal="true"');
    expect(MODAL_PRIMITIVE).toContain('aria-labelledby');
    expect(MODAL_PRIMITIVE).toContain('trapModalFocus');
  });

  it('collects the reason in a labelled multi-line field', () => {
    expect(REVIEW_MODAL).toContain('<Textarea');
    expect(REVIEW_MODAL).toContain('id="item-review-reason"');
    expect(REVIEW_MODAL).toContain('rows={3}');
    // The shared Textarea renders the real <label htmlFor> link.
    expect(TEXTAREA_PRIMITIVE).toContain('htmlFor={fieldId}');
  });

  it('offers Cancel and the action confirm control', () => {
    expect(REVIEW_MODAL).toContain("{lang === 'en' ? 'Cancel' : 'Ghairi'}");
    expect(REVIEW_MODAL).toContain('onClick={confirmItemReviewStatusChange}');
    expect(REVIEW_MODAL).toContain('onClick={closeItemReviewPrompt}');
  });

  it('is opened by all three existing controls, with the same arguments as before', () => {
    expect(PANELS).toContain("promptItemReviewStatusChange(item.id, 'flag-stolen', 'Reason for flagging this item as suspected stolen (required, audit-logged):')");
    expect(PANELS).toContain("promptItemReviewStatusChange(item.id, 'legal-hold', 'Reason for placing this item under legal hold (required, audit-logged):')");
    expect(PANELS).toContain("promptItemReviewStatusChange(item.id, 'clear-hold', 'Reason for clearing this hold (optional):')");
    // …and opening only RECORDS the request: no request, no mutation.
    const opener = sliceBetween(REVIEW_FLOW, 'const promptItemReviewStatusChange = (itemId', '};');
    expect(opener).toContain('setItemReviewPrompt({ itemId, action, promptLabel });');
    expect(opener).not.toContain('handleItemReviewStatusChange');
    expect(opener).not.toContain('fetch(');
  });

  it('cancelling performs no mutation', () => {
    const close = sliceBetween(REVIEW_FLOW, 'const closeItemReviewPrompt = () => {', '};');
    expect(close).toContain('setItemReviewPrompt(null)');
    expect(close).toContain("setItemReviewReason('')");
    expect(close).toContain("setItemReviewReasonError('')");
    expect(close).not.toContain('handleItemReviewStatusChange');
    expect(close).not.toContain('fetch(');
    expect(REVIEW_MODAL).toContain('onClose={closeItemReviewPrompt}');
  });

  it('rejects a blank reason for flag-stolen and legal-hold, with the original message', () => {
    expect(REVIEW_FLOW).toContain("if ((action === 'flag-stolen' || action === 'legal-hold') && !reason.trim()) {");
    expect(REVIEW_FLOW).toContain("setItemReviewReasonError('A reason is required.');");
    // Rejected BEFORE the mutation is reached, so handleItemReviewStatusChange
    // can never be called with a blank reason.
    const guardAt = REVIEW_FLOW.indexOf("if ((action === 'flag-stolen' || action === 'legal-hold') && !reason.trim()) {");
    const messageAt = REVIEW_FLOW.indexOf("setItemReviewReasonError('A reason is required.');");
    const mutationAt = REVIEW_FLOW.indexOf('handleItemReviewStatusChange(itemId, action, reason.trim());');
    expect(guardAt).toBeGreaterThan(-1);
    expect(messageAt).toBeGreaterThan(guardAt);
    expect(mutationAt).toBeGreaterThan(messageAt);
    // The message is announced INSIDE the dialog (the shared Banner is a live
    // region) instead of as a console-level error banner.
    expect(REVIEW_MODAL).toContain('{itemReviewReasonError && <Banner kind="error">{itemReviewReasonError}</Banner>}');
  });

  it('keeps clear-hold optional', () => {
    // The requiredness is DERIVED from the action, so clear-hold is the one
    // action whose reason may be empty.
    expect(REVIEW_MODAL).toContain("required={itemReviewPrompt?.action !== 'clear-hold'}");
    expect(REVIEW_MODAL).toContain("hint={itemReviewPrompt?.action === 'clear-hold'");
    expect(REVIEW_FLOW).not.toContain("action === 'clear-hold' &&");
  });

  it('submits the same trimmed reason contract through the same mutation', () => {
    expect(REVIEW_FLOW).toContain('handleItemReviewStatusChange(itemId, action, reason.trim());');
    // The mutation itself is untouched: same endpoint, same bearer, same body.
    expect(ADMIN_VIEW_TSX).toContain('fetch(`/api/admin/items/${itemId}/${action}`');
    expect(ADMIN_VIEW_TSX).toContain('Authorization: `Bearer ${token}`');
    expect(ADMIN_VIEW_TSX).toContain('body: JSON.stringify({ reason }),');
    expect(ADMIN_VIEW_TSX).toContain(
      "const handleItemReviewStatusChange = async (itemId: string, action: 'flag-stolen' | 'legal-hold' | 'clear-hold', reason: string) => {",
    );
  });

  it('closes the dialog on submit, before the mutation runs', () => {
    const confirmFn = sliceBetween(REVIEW_FLOW, 'const confirmItemReviewStatusChange = () => {', '};');
    const closeAt = confirmFn.indexOf('closeItemReviewPrompt();');
    const mutateAt = confirmFn.indexOf('handleItemReviewStatusChange(itemId, action, reason.trim());');
    expect(closeAt).toBeGreaterThan(-1);
    expect(mutateAt).toBeGreaterThan(closeAt);
  });
});

// -----------------------------------------------------------------------------
// D. The scope: UX-14 untouched above, UX-16 untouched beside, bespoke modal kept.
// -----------------------------------------------------------------------------

describe('the batch stays inside its scope', () => {
  it('leaves the UX-14 authentication gate exactly where it was', () => {
    // The gate is still the ONE unauthenticated branch, it still ends at the
    // byte-identical marker the console starts at, and this batch never reached
    // into it.
    expect(count(CODE, /\{!token && \(/g)).toBe(1);
    expect(GATE_TSX).toContain('{!token && (');
    expect(GATE_TSX).not.toContain(CONSOLE_MARKER);
    expect(CONSOLE_TSX).toContain(CONSOLE_MARKER);
    expect(GATE).toContain('Admin Authentication');
    expect(GATE).toContain('pendingTwoFactorToken');
    expect(GATE).toContain('src="/assets/logo_wordmark_transparent.png"');
    expect(GATE).toContain('<h1 className="text-section font-extrabold tracking-tight text-[var(--appearance-text-primary)]">');
  });

  it('does not regress the gate UX-14 already migrated', () => {
    expect(offLadderType(GATE)).toEqual([]);
    expect(legacyColour(GATE)).toEqual([]);
    expect(magicIconSize(GATE)).toEqual([]);
  });

  it('does not touch the bespoke confirm modal (its own later scope)', () => {
    const bespoke = sliceBetween(ADMIN_VIEW_TSX, BESPOKE_MODAL, LIGHTBOX);
    expect(bespoke).toContain('{confirmModal && (');
    expect(bespoke).toContain('confirmModal.onConfirm();');
    expect(bespoke).toContain("onClick={() => setConfirmModal(null)}");
    // …and it is outside the slice every UX-15C guard above is asserted against.
    expect(PANELS).not.toContain('confirmModal.onConfirm();');
  });

  it('does not start UX-16', () => {
    // The UX-16 surfaces live in their own modules and are not imported here.
    expect(ADMIN_VIEW_TSX).not.toContain('AgentVerificationPanel');
    expect(ADMIN_VIEW_TSX).not.toContain('AgentRejectionPanel');
    expect(ADMIN_VIEW_TSX).not.toContain('AgentHub');
    expect(ADMIN_VIEW_TSX).not.toContain('OTPInput');
    expect(ADMIN_VIEW_TSX).not.toMatch(/from '\.\/agent\//);
    // …and every queue row UX-16 owns is still queued.
    const queued = DESIGN_SYSTEM.split(/\r?\n/).filter((line) => line.startsWith('| ') && line.includes('UX-16'));
    expect(queued.length).toBeGreaterThanOrEqual(4);
    for (const row of queued.filter((r) => /AgentView|FinderView|verification/.test(r))) {
      expect(row).toContain('MIGRATE LATER');
    }
  });
});

// -----------------------------------------------------------------------------
// E. The guards are live, not decorative.
// -----------------------------------------------------------------------------

describe('the UX-15C/D/E guards are live, not decorative (mutation checks)', () => {
  it('detects a reintroduced off-ladder type size', () => {
    expect(offLadderType(PANELS)).toEqual([]);
    expect(offLadderType(`${PANELS} text-xs`)).not.toEqual([]);
    expect(offLadderType(`${PANELS} text-sm`)).not.toEqual([]);
    expect(offLadderType(`${PANELS} text-[11px]`)).not.toEqual([]);
    expect(offLadderType(`${PANELS} text-[9px]`)).not.toEqual([]);
  });

  it('detects a reintroduced legacy colour or light-only surface', () => {
    expect(legacyColour(PANELS)).toEqual([]);
    expect(legacyColour(`${PANELS} bg-stone-100`)).not.toEqual([]);
    expect(legacyColour(`${PANELS} text-red-600`)).not.toEqual([]);
    expect(legacyColour(`${PANELS} bg-white`)).not.toEqual([]);
    expect(legacyColour(`${PANELS} text-[#003820]`)).not.toEqual([]);
    expect(legacySurface(PANELS)).toEqual([]);
    expect(legacySurface(`${PANELS} text-brand-muted-text`)).not.toEqual([]);
    expect(legacySurface(`${PANELS} bg-canvas-sunken`)).not.toEqual([]);
    expect(legacySurface(`${PANELS} bg-primary-green`)).not.toEqual([]);
  });

  it('detects a magic-number icon size and a browser dialog', () => {
    expect(magicIconSize(PANELS)).toEqual([]);
    expect(magicIconSize(`${PANELS} size={16}`)).not.toEqual([]);
    expect(magicIconSize('<Loader2 className="animate-spin w-6 h-6" aria-hidden="true" />')).not.toEqual([]);
    expect(browserDialog(REVIEW_FLOW)).toEqual([]);
    expect(browserDialog(`${REVIEW_FLOW} window.prompt('reason')`)).not.toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// F. The record: the design-system queue, and the ONE remaining native dialog.
// -----------------------------------------------------------------------------

describe('the batch is recorded in the design-system reference', () => {
  it('annotates the AdminView queue row without deleting it', () => {
    const row = DESIGN_SYSTEM.split(/\r?\n/).find((line) => line.startsWith('| AdminView |'));
    expect(row, 'the design system must keep the AdminView queue row').toBeDefined();
    expect(row as string).toContain('MIGRATE LATER');
    expect(row as string).toContain('UX-15A/B');
    expect(row as string).toContain('UX-15C/D/E');
    expect(row as string).toContain('UX-16');
    // The neighbouring batches keep their exact counts.
    expect(count(DESIGN_SYSTEM, /MIGRATED in UX-14/g)).toBe(2);
    expect(count(DESIGN_SYSTEM, /MIGRATED in UX-11/g)).toBe(2);
    expect(count(DESIGN_SYSTEM, /MIGRATED in UX-13/g)).toBe(1);
  });
});

describe('the previously recorded native dialog was migrated in UX-15F', () => {
  it('leaves ZERO browser-native dialogs in the console', () => {
    // RECORDED FINDING, NOW CLOSED — this block used to pin the ONE remaining
    // native dialog: the bare `prompt()` in the agent-warning flow
    // (`handleWarnAgent`, the "Issue Warning" control in the agents panel), which
    // UX-15C/D/E deliberately left in place and REPORTED rather than migrating
    // silently. UX-15F is that follow-up batch, so the tripwire is now the
    // STRICTER zero-dialog assertion across the whole file — gate, chrome and
    // panels — instead of "exactly one, and here it is".
    expect(browserDialog(CODE)).toEqual([]);
    expect(REVIEW_FLOW).not.toContain('prompt(');
    expect(PANELS).not.toContain('prompt(');
    // The panels still reach that (unchanged) action — through the shared dialog.
    expect(PANELS).toContain('onClick={() => openAgentWarnDialog(agent.id)}');
  });
});
