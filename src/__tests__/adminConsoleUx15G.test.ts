import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// UX-15G — THE ADMIN CONFIRMATION DIALOG: HAND-BUILT OVERLAY -> THE SHARED MODAL
// =============================================================================
// UX-15F closed the last browser-native dialog in AdminView and recorded one
// deliberate, out-of-scope finding: the bespoke `confirmModal` overlay — the
// confirmation surface every destructive and consequential console action still
// rendered through. This batch is that follow-up.
//
// WHAT THIS BATCH IS
//   The confirmation dialog is now the SAME shared ui/Modal the refund
//   reconciliation (P1-01), the item-review reason step (UX-15E) and the
//   agent-warning reason step (UX-15F) use. The hand-built overlay is gone, so
//   the dialog structure, the focus trap, focus restoration, Escape and the
//   scrim are the primitive's job. No second dialog component was introduced.
//
// WHAT THE OVERLAY ACTUALLY WAS (forensic findings this file pins)
//   * ONE generic dialog served SIX flows, all through one piece of state:
//     `{ title: string; message: string; onConfirm: () => void } | null`;
//     delete category, clear payment strikes, approve agent, suspend agent,
//     resolve dispute and clear reputation flag each stored their own title,
//     message and callback.
//   * Cancel was the ONLY dismissal: there was no close control, no Escape
//     handling, no focus management and the scrim could not be clicked at all.
//   * Confirm ran the stored callback and then cleared the state, in that order,
//     and the request itself was fire-and-forget.
//   * The confirm control was the ONE generic green action for all six flows,
//     destructive and non-destructive alike, because the shared state carries no
//     per-action marker. UX-15G therefore does NOT guess a destructive variant
//     (the design system reserves `danger` for destructive actions only, and
//     switching Approve Agent or Resolve Dispute to red would mislabel them);
//     the destructive meaning stays where it already lived — in each flow's own
//     wording, which this batch preserves verbatim.
//
// UX-15G IS PRESENTATION AND ACCESSIBILITY ONLY. It changes none of:
//   * which flows open the confirmation, or what they store in it;
//   * the confirmation callback, the endpoint, the method, the payload, the
//     authorization, the success/error handling, the refreshes, the processing
//     flags or the bilingual labels;
//   * the UX-14 authentication gate, the UX-15E item-review dialog, the UX-15F
//     agent-warning dialog, anything UX-16 still owns, or the lightbox (which is
//     deliberately deferred to its own UX-15H audit).
//
// There is no jsdom/React harness in this repository, so — exactly as the
// UX-06 … UX-15F suites do — the contract is asserted against the shipped source
// with the same comment stripper and the same `sliceBetween` helper, and every
// assertion is made against a SLICE rather than against the whole file.
// =============================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
/** The same comment stripper the UX-06 … UX-15F suites use. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const ADMIN_VIEW_TSX = read('src/components/AdminView.tsx');
const DESIGN_SYSTEM = read('docs/design-system.md');
const MODAL_PRIMITIVE = read('src/components/ui/Modal.tsx');
const BUTTON_PRIMITIVE = read('src/components/ui/Button.tsx');
const BANNER_PRIMITIVE = read('src/components/ui/Banner.tsx');

const count = (source: string, pattern: RegExp) => (source.match(pattern) || []).length;

function sliceBetween(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = start === -1 ? -1 : source.indexOf(to, start + from.length);
  if (start === -1 || end === -1) throw new Error(`UX-15G marker not found: ${from} -> ${to}`);
  return source.slice(start, end);
}
/** The whole file, with comments removed. */
const CODE = stripComments(ADMIN_VIEW_TSX);

/* ---------------------------------------------------------------------------
 * The scope boundaries, each taken from the real source so they cannot drift.
 * ------------------------------------------------------------------------- */
/** UX-14's gate ends — and UX-15's authenticated console begins — here. */
const CONSOLE_MARKER = '{/* 2. DISTINCT LOADING';
const GATE_TSX = ADMIN_VIEW_TSX.slice(0, ADMIN_VIEW_TSX.indexOf(CONSOLE_MARKER));
const GATE = stripComments(GATE_TSX);

/** UX-15G's own surfaces: the state it reuses, the two handlers it adds and the
 *  dialog itself. `CONFIRM_MODAL` is the same slice the earlier suites carve out
 *  of their panel guards, so the two cannot disagree about where it starts. */
const CONFIRM_STATE = sliceBetween(ADMIN_VIEW_TSX, '// Confirmation Modal State', '// UX-15G');
const CONFIRM_HANDLERS = sliceBetween(ADMIN_VIEW_TSX, '// UX-15G', '// PROD BATCH 3 / P1-01');
const CONFIRM_MARKER = '{/* Custom Confirmation Modal */}';
const LIGHTBOX = '{/* Lightbox Image Zoom Portal */}';
const CONFIRM_MODAL = sliceBetween(ADMIN_VIEW_TSX, CONFIRM_MARKER, LIGHTBOX);
const CONFIRM_MODAL_CODE = stripComments(CONFIRM_MODAL);
/** The lightbox — deferred to UX-15H — and the two shared dialogs that must not
 *  move: UX-15E's item-review step and UX-15F's agent-warning step. */
const LIGHTBOX_TSX = ADMIN_VIEW_TSX.slice(ADMIN_VIEW_TSX.indexOf(LIGHTBOX));
const REVIEW_MODAL = sliceBetween(
  ADMIN_VIEW_TSX,
  'open={itemReviewPrompt !== null}',
  '{/* UX-15F — the agent-warning reason step',
);
const WARN_MODAL = sliceBetween(ADMIN_VIEW_TSX, 'open={agentWarnPrompt !== null}', CONFIRM_MARKER);

/** One confirmation flow, from its handler to the next one, comments removed. */
const flow = (from: string, to: string) => stripComments(sliceBetween(ADMIN_VIEW_TSX, from, to));
const FLOWS: Record<string, string> = {
  deleteCategory: flow('const handleDeleteCategory = (id: string, nameEn: string) => {', 'const handleToggleCategoryActive'),
  clearStrikes: flow('const handleClearStrikes = (phone: string) => {', '// Admin authenticate'),
  approveAgent: flow('const handleApproveAgent = (id: string) => {', '// Suspend Agent'),
  suspendAgent: flow('const handleSuspendAgent = (id: string) => {', '// Issue Official Warning to Agent'),
  resolveDispute: flow('const handleResolveDispute = (dispute: any, claimant: any) => {', 'const handleRejectAsSpam'),
  clearReputation: flow('const handleClearReputation = (phone: string) => {', 'const splitsMatch'),
};
const ALL_FLOWS = Object.values(FLOWS).join('\n');

/* ---------------------------------------------------------------------------
 * The guards — the same ones the UX-15C/D/E/F suites use, so a reintroduced
 * browser dialog / legacy literal is detected the same way here.
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

// -----------------------------------------------------------------------------
// A. The bespoke overlay is gone; the shared Modal is the confirmation dialog.
// -----------------------------------------------------------------------------

describe('the confirmation dialog is the shared Modal, not bespoke markup', () => {
  it('removes the hand-built overlay entirely', () => {
    expect(CONFIRM_MODAL_CODE).toContain('<Modal');
    expect(CONFIRM_MODAL_CODE).not.toContain('fixed inset-0');
    expect(CONFIRM_MODAL_CODE).not.toContain('fade-in');
    expect(CONFIRM_MODAL_CODE).not.toContain('z-[100]');
    expect(CONFIRM_MODAL_CODE).not.toContain('max-w-sm');
    expect(CONFIRM_MODAL_CODE).not.toContain('<h3');
    expect(CONFIRM_MODAL_CODE).not.toContain('<button');
    expect(CONFIRM_MODAL_CODE).not.toContain('rounded-xl');
  });

  it('is the SAME primitive UX-15E and UX-15F already use', () => {
    expect(CONFIRM_MODAL_CODE).toContain('<Modal');
    expect(CONFIRM_MODAL_CODE).toContain('open={confirmModal !== null}');
    expect(CONFIRM_MODAL_CODE).toContain('onClose={closeConfirmModal}');
    expect(CONFIRM_MODAL_CODE).toContain("title={confirmModal?.title ?? ''}");
    expect(CONFIRM_MODAL_CODE).toContain("closeLabel={lang === 'en' ? 'Close' : 'Funga'}");
    expect(CONFIRM_MODAL_CODE).toContain('footer={');
    expect(CONFIRM_MODAL_CODE).toContain('{confirmModal.message}');
    // Exactly four shared Modal usages: P1-01, UX-15E, UX-15F and this one.
    expect(count(ADMIN_VIEW_TSX, /<Modal\b/g)).toBe(4);
    expect(ADMIN_VIEW_TSX).toContain("import Modal from './ui/Modal';");
  });

  it('introduces no second dialog component and no duplicated dialog machinery', () => {
    // No portal, no focus trap, no key handling, no scroll lock of its own: the
    // dialog is the primitive's markup plus a body and a footer.
    expect(CONFIRM_MODAL_CODE).not.toContain('createPortal');
    expect(CONFIRM_MODAL_CODE).not.toContain('trapModalFocus');
    expect(CONFIRM_MODAL_CODE).not.toContain('previouslyFocused');
    expect(CONFIRM_MODAL_CODE).not.toContain('addEventListener');
    expect(CONFIRM_MODAL_CODE).not.toContain('removeEventListener');
    expect(CONFIRM_MODAL_CODE).not.toContain('useRef');
    expect(CONFIRM_MODAL_CODE).not.toContain('useEffect');
    expect(CONFIRM_MODAL_CODE).not.toContain('tabIndex');
    expect(CONFIRM_MODAL_CODE).not.toContain('onKeyDown');
    expect(CONFIRM_MODAL_CODE).not.toContain('role="dialog"');
    expect(CONFIRM_MODAL_CODE).not.toContain('aria-modal');
    expect(CONFIRM_MODAL_CODE).not.toContain('document.body');
    // …and the same machinery IS supplied by the one foundation.
    expect(MODAL_PRIMITIVE).toContain('createPortal');
    expect(MODAL_PRIMITIVE).toContain('trapModalFocus');
    expect(MODAL_PRIMITIVE).toContain("document.body.style.overflow = 'hidden';");
  });

  it('uses the shared Button controls instead of hand-built buttons', () => {
    expect(CONFIRM_MODAL_CODE).toContain(
      '<Button variant="secondary" size="sm" onClick={closeConfirmModal}>',
    );
    expect(CONFIRM_MODAL_CODE).toContain(
      '<Button variant="primary" size="sm" onClick={confirmPendingAction}>',
    );
    expect(count(CONFIRM_MODAL_CODE, /<Button\b/g)).toBe(2);
    expect(CONFIRM_MODAL_CODE).not.toContain('<button');
  });
});

// -----------------------------------------------------------------------------
// B. The confirmation contract: state, targets, callbacks, endpoints, behaviour.
// -----------------------------------------------------------------------------

describe('the confirmation contract is unchanged', () => {
  it('keeps the exact confirmation state the six flows already set', () => {
    expect(CONFIRM_STATE).toContain('const [confirmModal, setConfirmModal] = useState<{');
    expect(CONFIRM_STATE).toContain('title: string;');
    expect(CONFIRM_STATE).toContain('message: string;');
    expect(CONFIRM_STATE).toContain('onConfirm: () => void;');
    expect(CONFIRM_STATE).toContain('} | null>(null);');
    // Still exactly three fields: the migration added no per-action marker.
    expect(count(CONFIRM_STATE, /^\s+\w+: /gm)).toBe(3);
  });

  it('is still opened by the same six flows, each with its own bilingual copy', () => {
    expect(count(CODE, /setConfirmModal\(\{/g)).toBe(6);
    for (const [name, source] of Object.entries(FLOWS)) {
      expect(source, `${name} must still open the confirmation`).toContain('setConfirmModal({');
      expect(source, `${name} must still supply title + message + callback`).toContain('title:');
      expect(source).toContain('message:');
      expect(source).toContain('onConfirm: async () => {');
    }
    expect(FLOWS.deleteCategory).toContain("lang === 'en' ? 'Delete Category' : 'Futa Kitengo'");
    expect(FLOWS.clearStrikes).toContain("lang === 'en' ? 'Clear Payment Strikes' : 'Ondoa Vikwazo vya Malipo'");
    expect(FLOWS.approveAgent).toContain("lang === 'en' ? 'Approve Agent' : 'Muidhinishe Wakala'");
    expect(FLOWS.suspendAgent).toContain("lang === 'en' ? 'Suspend Agent' : 'Msimamishe Wakala'");
    expect(FLOWS.resolveDispute).toContain("lang === 'en' ? 'Resolve Dispute' : 'Suluhisha Mzozo'");
    expect(FLOWS.clearReputation).toContain("lang === 'en' ? 'Clear Reputation Flag' : 'Ondoa Bendera ya Sifa'");
  });

  it('is still opened from the same pre-existing controls', () => {
    expect(CODE).toContain('onClick={() => handleDeleteCategory(cat.id, cat.name_en)}');
    expect(CODE).toContain('onClick={() => handleClearStrikes(strike.phone)}');
    expect(CODE).toContain('onClick={() => handleApproveAgent(agent.id)}');
    expect(CODE).toContain('onClick={() => handleSuspendAgent(agent.id)}');
    expect(CODE).toContain('onClick={() => handleResolveDispute(dispute, claimant)}');
    expect(CODE).toContain('handleClearReputation(item.finder_phone);');
  });

  it('keeps the confirmation callback wired, running before the dismissal', () => {
    expect(CONFIRM_MODAL_CODE).toContain('onClick={confirmPendingAction}');
    expect(CONFIRM_HANDLERS).toContain('const confirmPendingAction = () => {');
    expect(CONFIRM_HANDLERS).toContain('if (!confirmModal) return;');
    const confirmFn = sliceBetween(CONFIRM_HANDLERS, 'const confirmPendingAction = () => {', '};');
    const runAt = confirmFn.indexOf('confirmModal.onConfirm();');
    const closeAt = confirmFn.indexOf('setConfirmModal(null);');
    expect(runAt).toBeGreaterThan(-1);
    expect(closeAt).toBeGreaterThan(runAt);
    // Exactly ONE place in the file reaches the stored callback.
    expect(count(CONFIRM_HANDLERS, /confirmModal\.onConfirm\(\)/g)).toBe(1);
    expect(count(CONFIRM_MODAL, /confirmModal\.onConfirm\(\)/g)).toBe(0);
    expect(count(CODE, /confirmModal\.onConfirm\(\)/g)).toBe(1);
  });

  it('leaves every endpoint, method, authorization and payload untouched', () => {
    expect(FLOWS.deleteCategory).toContain('fetch(`/api/admin/categories/${id}`, {');
    expect(FLOWS.deleteCategory).toContain("method: 'DELETE',");
    expect(FLOWS.clearStrikes).toContain('fetch(`/api/admin/payment-strikes/${phone}/clear`, {');
    expect(FLOWS.clearStrikes).toContain("method: 'POST',");
    expect(FLOWS.approveAgent).toContain('fetch(`/api/admin/agents/${id}/approve`, {');
    expect(FLOWS.suspendAgent).toContain('fetch(`/api/admin/agents/${id}/suspend`, {');
    expect(FLOWS.resolveDispute).toContain("fetch('/api/admin/disputes/resolve', {");
    expect(FLOWS.resolveDispute).toContain('disputeId: dispute.id,');
    expect(FLOWS.resolveDispute).toContain('winningClaimId,');
    expect(FLOWS.clearReputation).toContain('fetch(`/api/admin/reputations/${phone}/clear`, {');
    // Every flow still carries the same bearer credential.
    expect(count(ALL_FLOWS, /Authorization: `Bearer \$\{token\}`/g)).toBe(6);
  });

  it('preserves the banner resets, success/error handling, refreshes and flags', () => {
    expect(count(ALL_FLOWS, /setActionSuccess\(''\);/g)).toBe(6);
    expect(count(ALL_FLOWS, /setActionWarning\(''\);/g)).toBe(6);
    expect(count(ALL_FLOWS, /setDataError\(''\);/g)).toBe(6);
    expect(count(ALL_FLOWS, /setDataError\(e\.message\);/g)).toBe(6);
    // The processing flag is still set and cleared by the same five flows;
    // delete-category still touches none of it, exactly as before.
    expect(count(ALL_FLOWS, /setAdminActionProcessing\(true\);/g)).toBe(5);
    expect(count(ALL_FLOWS, /setAdminActionProcessing\(false\);/g)).toBe(5);
    expect(FLOWS.deleteCategory).not.toContain('setAdminActionProcessing');
    expect(FLOWS.deleteCategory).toContain("setActionSuccess('Category deleted successfully!');");
    expect(FLOWS.deleteCategory).toContain('fetchAdminCategories();');
    expect(FLOWS.deleteCategory).toContain('onCategoriesChanged?.();');
    expect(FLOWS.clearStrikes).toContain('fetchPaymentStrikes();');
    for (const name of ['approveAgent', 'suspendAgent', 'resolveDispute', 'clearReputation']) {
      expect(FLOWS[name], `${name} must still refresh`).toContain('fetchDashboardData();');
    }
    // The dispute flow still separates a stuck refund from a clean success.
    expect(FLOWS.resolveDispute).toContain('if (data.refundFailed) {');
    expect(FLOWS.resolveDispute).toContain('setActionWarning(data.message);');
    expect(FLOWS.resolveDispute).toContain('setActionSuccess(data.message);');
  });
});

// -----------------------------------------------------------------------------
// C. Cancel, Escape, the scrim and Confirm: exactly one mutation path.
// -----------------------------------------------------------------------------

describe('dismissal can never confirm anything', () => {
  it('gives Cancel, the close control, Escape and the scrim ONE dismissal path', () => {
    expect(CONFIRM_MODAL_CODE).toContain('onClose={closeConfirmModal}');
    expect(CONFIRM_MODAL_CODE).toContain('onClick={closeConfirmModal}');
    const closeLine = CONFIRM_HANDLERS.split(/\r?\n/)
      .find((line) => line.includes('const closeConfirmModal')) as string;
    // The dismissal is exactly one statement: it clears the pending request.
    expect(closeLine.trim()).toBe('const closeConfirmModal = () => setConfirmModal(null);');
    expect(closeLine).not.toContain('onConfirm');
    expect(closeLine).not.toContain('fetch(');
  });

  it('performs no mutation and issues no request from Cancel', () => {
    const cancelButton = sliceBetween(
      CONFIRM_MODAL,
      '<Button variant="secondary" size="sm" onClick={closeConfirmModal}>',
      '</Button>',
    );
    expect(cancelButton).toContain("{lang === 'en' ? 'Cancel' : 'Ghairi'}");
    expect(cancelButton).not.toContain('fetch(');
    expect(cancelButton).not.toContain('onConfirm');
    expect(cancelButton).not.toContain('confirmPendingAction');
  });

  it('performs no mutation from Escape — the primitive routes it to onClose', () => {
    expect(MODAL_PRIMITIVE).toContain("if (event.key === 'Escape' && dialogRef.current) {");
    const escape = sliceBetween(
      MODAL_PRIMITIVE,
      "if (event.key === 'Escape'",
      'document.addEventListener',
    );
    expect(escape).toContain('onClose();');
    expect(escape).not.toContain('fetch(');
    // The dialog adds no key handling of its own.
    expect(CONFIRM_MODAL_CODE).not.toContain('Escape');
  });

  it('performs no mutation from the scrim', () => {
    // The primitive closes only when the press started on the scrim itself, and
    // it closes through the SAME onClose the Cancel control uses.
    expect(MODAL_PRIMITIVE).toContain('if (e.target === e.currentTarget) onClose();');
    expect(CONFIRM_MODAL_CODE).not.toContain('onMouseDown');
    expect(CONFIRM_MODAL_CODE).not.toContain('e.target');
  });

  it('lets only the explicit Confirm control run the stored callback', () => {
    expect(count(CONFIRM_MODAL_CODE, /onClick=\{confirmPendingAction\}/g)).toBe(1);
    expect(count(CONFIRM_MODAL_CODE, /onClick=\{closeConfirmModal\}/g)).toBe(1);
    expect(CONFIRM_MODAL_CODE).not.toContain('confirmModal.onConfirm');
    // The dialog and its handlers issue no request of their own: every request
    // still belongs to the flow that opened the confirmation.
    expect(count(CONFIRM_MODAL, /fetch\(/g)).toBe(0);
    expect(count(CONFIRM_HANDLERS, /fetch\(/g)).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// D. Presentation: the shared vocabulary, and no invented semantics.
// -----------------------------------------------------------------------------

describe('the dialog reads the design system, and nothing else', () => {
  it('leaves no legacy presentation behind in the migrated overlay', () => {
    expect(legacyColour(CONFIRM_MODAL_CODE)).toEqual([]);
    expect(offLadderType(CONFIRM_MODAL_CODE)).toEqual([]);
    expect(magicIconSize(CONFIRM_MODAL_CODE)).toEqual([]);
    expect(CONFIRM_MODAL_CODE).not.toContain('bg-stone-900/60');
    expect(CONFIRM_MODAL_CODE).not.toContain('bg-white');
    expect(CONFIRM_MODAL_CODE).not.toContain('bg-primary-green');
    expect(CONFIRM_MODAL_CODE).not.toContain('text-amber');
    expect(CONFIRM_MODAL_CODE).not.toContain('uppercase');
  });

  it('keeps the guards live, not decorative (mutation checks)', () => {
    expect(legacyColour(`${CONFIRM_MODAL_CODE} bg-stone-100`)).not.toEqual([]);
    expect(legacyColour(`${CONFIRM_MODAL_CODE} bg-white`)).not.toEqual([]);
    expect(offLadderType(`${CONFIRM_MODAL_CODE} text-xs`)).not.toEqual([]);
    expect(magicIconSize(`${CONFIRM_MODAL_CODE} size={16}`)).not.toEqual([]);
  });

  it('uses appearance roles that already existed in the foundation', () => {
    expect(CONFIRM_MODAL_CODE).toContain('text-[var(--appearance-text-secondary)]');
    expect(CONFIRM_MODAL_CODE).toContain('text-[var(--appearance-warning)]');
    expect(CONFIRM_MODAL_CODE).toContain('size={ICON_SIZE.emphasis}');
    // Both roles are pre-existing: the Banner owns the warning role, and the
    // secondary text role is already read across this file.
    expect(BANNER_PRIMITIVE).toContain('text-[var(--appearance-warning)]');
    expect(count(CODE, /text-\[var\(--appearance-text-secondary\)\]/g)).toBeGreaterThan(3);
    // The scrim is the primitive's semantic token, not a palette literal.
    expect(MODAL_PRIMITIVE).toContain('bg-[var(--appearance-scrim)]');
  });

  it('leaves the file on the shared vocabulary end to end', () => {
    // The confirmation dialog was the LAST legacy surface in this file, so the
    // file is now free of legacy colours, off-ladder type, magic icon sizes and
    // browser-native dialogs.
    expect(legacyColour(CODE)).toEqual([]);
    expect(offLadderType(CODE)).toEqual([]);
    expect(magicIconSize(CODE)).toEqual([]);
    expect(browserDialog(CODE)).toEqual([]);
  });

  it('keeps destructive wording, and does not guess a destructive variant', () => {
    // The destructive meaning lives in each flow's own copy, preserved verbatim.
    expect(FLOWS.deleteCategory).toContain('This action cannot be undone.');
    expect(FLOWS.suspendAgent).toContain(
      'They will no longer be able to accept drop-offs or process handovers.',
    );
    expect(FLOWS.resolveDispute).toContain('This decision is final and cannot be undone.');
    expect(CONFIRM_MODAL_CODE).toContain("{lang === 'en' ? 'Confirm' : 'Thibitisha'}");
    // The ONE generic dialog cannot know which of its six callers is destructive,
    // so it must not paint all six destructive: `danger` stays reserved for the
    // actions that already carried it (UX-15E's legal hold, UX-15F's warning).
    expect(CONFIRM_MODAL_CODE).not.toContain('variant="danger"');
    expect(BUTTON_PRIMITIVE).toContain('danger:');
    expect(DESIGN_SYSTEM).toContain('`danger` (destructive only)');
  });
});

// -----------------------------------------------------------------------------
// E. Accessibility: the primitive's dialog semantics, and the bilingual labels.
// -----------------------------------------------------------------------------

describe('the dialog is accessible because the primitive is', () => {
  it('is named by the stored title through the primitive heading', () => {
    expect(CONFIRM_MODAL_CODE).toContain("title={confirmModal?.title ?? ''}");
    expect(MODAL_PRIMITIVE).toContain('role="dialog"');
    expect(MODAL_PRIMITIVE).toContain('aria-modal="true"');
    expect(MODAL_PRIMITIVE).toContain('aria-labelledby="r4m-modal-title"');
    expect(MODAL_PRIMITIVE).toContain('<h2');
    expect(MODAL_PRIMITIVE).toContain('id="r4m-modal-title"');
  });

  it('delegates focus management and Escape handling to the shared primitive', () => {
    expect(MODAL_PRIMITIVE).toContain('trapModalFocus(event, dialogRef.current);');
    expect(MODAL_PRIMITIVE).toContain('dialogRef.current?.focus();');
    expect(MODAL_PRIMITIVE).toContain('previouslyFocused.current?.focus?.();');
    // …and adds no second focus system of its own.
    expect(CONFIRM_MODAL_CODE).not.toContain('trapModalFocus');
    expect(CONFIRM_MODAL_CODE).not.toContain('previouslyFocused');
    expect(CONFIRM_MODAL_CODE).not.toContain('createPortal');
    expect(CONFIRM_MODAL_CODE).not.toContain('tabIndex');
  });

  it('keeps an accessible close control and the bilingual labels', () => {
    expect(CONFIRM_MODAL_CODE).toContain("closeLabel={lang === 'en' ? 'Close' : 'Funga'}");
    expect(MODAL_PRIMITIVE).toContain("aria-label={closeLabel ?? 'Close dialog'}");
    expect(CONFIRM_MODAL_CODE).toContain("{lang === 'en' ? 'Cancel' : 'Ghairi'}");
    expect(CONFIRM_MODAL_CODE).toContain("{lang === 'en' ? 'Confirm' : 'Thibitisha'}");
    // The alert lead icon is decorative: the heading carries the meaning.
    expect(CONFIRM_MODAL_CODE).toContain('aria-hidden="true"');
  });
});

// -----------------------------------------------------------------------------
// F. Scope: UX-14, UX-15E, UX-15F, UX-16 and the lightbox stay where they are.
// -----------------------------------------------------------------------------

describe('the batch stays in its lane', () => {
  it('leaves the UX-14 authentication gate exactly where it was', () => {
    expect(count(CODE, /\{!token && \(/g)).toBe(1);
    expect(GATE_TSX).toContain('{!token && (');
    expect(GATE_TSX).not.toContain(CONSOLE_MARKER);
    expect(GATE).toContain('Admin Authentication');
    expect(GATE).toContain('pendingTwoFactorToken');
    expect(CONFIRM_MODAL).not.toContain('pendingTwoFactorToken');
  });

  it('leaves the UX-15E item-review dialog untouched', () => {
    expect(REVIEW_MODAL).toContain('open={itemReviewPrompt !== null}');
    expect(REVIEW_MODAL).toContain('onClose={closeItemReviewPrompt}');
    expect(REVIEW_MODAL).toContain('<Textarea');
    expect(REVIEW_MODAL).toContain(
      '{itemReviewReasonError && <Banner kind="error">{itemReviewReasonError}</Banner>}',
    );
    expect(REVIEW_MODAL).not.toContain('confirmModal');
    expect(CONFIRM_MODAL).not.toContain('itemReviewPrompt');
  });

  it('leaves the UX-15F agent-warning dialog untouched', () => {
    expect(WARN_MODAL).toContain('open={agentWarnPrompt !== null}');
    expect(WARN_MODAL).toContain('onClose={closeAgentWarnDialog}');
    expect(WARN_MODAL).toContain('onClick={confirmAgentWarn}');
    expect(WARN_MODAL).toContain('variant="danger"');
    expect(WARN_MODAL).not.toContain('confirmModal');
    expect(CONFIRM_MODAL).not.toContain('agentWarnPrompt');
  });

  it('leaves the lightbox alone — it keeps its own UX-15H audit', () => {
    expect(LIGHTBOX_TSX).toContain('role="dialog"');
    expect(LIGHTBOX_TSX).toContain('aria-label="Zoomed photograph"');
    expect(LIGHTBOX_TSX).toContain('lightboxCloseRef');
    expect(LIGHTBOX_TSX).not.toContain('<Modal');
    expect(CONFIRM_MODAL).not.toContain('lightboxImage');
  });

  it('does not start UX-16 or any later batch', () => {
    expect(ADMIN_VIEW_TSX).not.toContain('AgentVerificationPanel');
    expect(ADMIN_VIEW_TSX).not.toContain('AgentRejectionPanel');
    expect(ADMIN_VIEW_TSX).not.toContain('OTPInput');
    expect(ADMIN_VIEW_TSX).not.toMatch(/from '\.\/agent\//);
    const queued = DESIGN_SYSTEM.split(/\r?\n/).filter(
      (line) => line.startsWith('| ') && line.includes('UX-16'),
    );
    expect(queued.length).toBeGreaterThanOrEqual(4);
  });

  it('records the migration without weakening the queue', () => {
    const row = DESIGN_SYSTEM.split(/\r?\n/).find((line) => line.startsWith('| AdminView |'));
    expect(row).toBeDefined();
    expect(row as string).toContain('UX-15G');
    expect(row as string).toContain('MIGRATE LATER');
    expect(row as string).toContain('no browser-native dialog remains in AdminView at all');
    // The neighbouring batches keep their exact classification counts.
    expect(count(DESIGN_SYSTEM, /MIGRATED in UX-14/g)).toBe(2);
    expect(count(DESIGN_SYSTEM, /MIGRATED in UX-11/g)).toBe(2);
    expect(count(DESIGN_SYSTEM, /MIGRATED in UX-13/g)).toBe(1);
  });

  it('records the confirmation dialog in the native-dialog note', () => {
    const note = sliceBetween(DESIGN_SYSTEM, '`window.prompt()` / `window.confirm()`', '`Modal`)');
    expect(note).toContain('UX-15G');
    expect(note).not.toContain('remains in');
  });
});

