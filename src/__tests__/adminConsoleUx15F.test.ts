import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// UX-15F — THE AGENT-WARNING REASON STEP: BROWSER PROMPT -> THE SHARED MODAL
// =============================================================================
// UX-15C/D/E ended at the nine authenticated section panels and the item-review
// reason step. It recorded ONE deliberate, out-of-scope finding: the bare
// `prompt()` in the Admin Console's agent-warning flow (`handleWarnAgent`, the
// "Issue Warning" control in the agents panel). This batch is that follow-up.
//
// WHAT THIS BATCH IS
//   The agent warning now collects its audit-logged reason in the SAME shared
//   ui/Modal the refund reconciliation (P1-01) and the item-review reason step
//   (UX-15E) already use. No second dialog component, no second endpoint, no new
//   business rule.
//
// UX-15F IS PRESENTATION AND ACCESSIBILITY ONLY. It changes none of:
//   * the warning target, the endpoint, the payload or the authorization;
//   * the EXACT blank-reason guard the prompt used
//     (`!reason || reason.trim() === ''` — a missing, empty or whitespace-only
//     reason issued no warning at all, and still does not);
//   * the UNTRIMMED reason that is sent, or the success / error / refresh flow;
//   * the UX-14 authentication gate, the UX-15E item-review dialog, the
//     confirmation dialog (which UX-15G later moved onto this same shared
//     Modal), the lightbox, or anything UX-16 still owns.
//
// There is no jsdom/React harness in this repository, so — exactly as the
// UX-06 … UX-15C/D/E suites do — the contract is asserted against the shipped
// source with the same comment stripper and the same `sliceBetween` helper, and
// every assertion is made against a SLICE rather than against the whole file.
// =============================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
/** The same comment stripper the UX-06 … UX-15C/D/E suites use. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const ADMIN_VIEW_TSX = read('src/components/AdminView.tsx');
const DESIGN_SYSTEM = read('docs/design-system.md');
const MODAL_PRIMITIVE = read('src/components/ui/Modal.tsx');
const TEXTAREA_PRIMITIVE = read('src/components/ui/Textarea.tsx');
const BANNER_PRIMITIVE = read('src/components/ui/Banner.tsx');
const BUTTON_PRIMITIVE = read('src/components/ui/Button.tsx');

const count = (source: string, pattern: RegExp) => (source.match(pattern) || []).length;

function sliceBetween(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = start === -1 ? -1 : source.indexOf(to, start + from.length);
  if (start === -1 || end === -1) throw new Error(`UX-15F marker not found: ${from} -> ${to}`);
  return source.slice(start, end);
}

/** The whole file, with comments removed. */
const CODE = stripComments(ADMIN_VIEW_TSX);

/** UX-14's gate ends — and UX-15's authenticated console begins — at the
 *  byte-identical marker the earlier batches assert against. */
const CONSOLE_MARKER = '{/* 2. DISTINCT LOADING';
const GATE_TSX = ADMIN_VIEW_TSX.slice(0, ADMIN_VIEW_TSX.indexOf(CONSOLE_MARKER));
const CONSOLE_TSX = ADMIN_VIEW_TSX.slice(ADMIN_VIEW_TSX.indexOf(CONSOLE_MARKER));
const GATE = stripComments(GATE_TSX);
/** The UX-14 gate's OWN JSX: from its marker to the console marker. */
const GATE_JSX = GATE_TSX.slice(GATE_TSX.indexOf('{/* 1. SECURE ADMIN AUTHENTICATION GATE'));
const CONFIRM_MODAL = '{/* Custom Confirmation Modal */}';
const LIGHTBOX = '{/* Lightbox Image Zoom Portal */}';
/** The authenticated panels, with the confirmation dialog (the shared `Modal`
 *  since UX-15G) and the lightbox (still its own scope) carved out. */
const PANELS = stripComments(
  CONSOLE_TSX.replace(sliceBetween(CONSOLE_TSX, CONFIRM_MODAL, LIGHTBOX), ' '),
);

/** UX-15F — the warning flow: the unchanged mutation, the dialog state and the
 *  open / close / confirm handlers, from its banner comment to the next flow. */
const WARN_FLOW = stripComments(
  sliceBetween(
    ADMIN_VIEW_TSX,
    '// UX-15F — THE REASON STEP IS THE SHARED ui/Modal',
    'const fetchRefundReconciliation = async () => {',
  ),
);
/** UX-15F — the UNCHANGED mutation the dialog submits into. */
const WARN_MUTATION = sliceBetween(
  WARN_FLOW,
  'const handleWarnAgent = (id: string, reason: string) => {',
  'const [agentWarnPrompt, setAgentWarnPrompt]',
);
const WARN_OPEN = sliceBetween(WARN_FLOW, 'const openAgentWarnDialog = (id: string) => {', '};');
const WARN_CLOSE = sliceBetween(WARN_FLOW, 'const closeAgentWarnDialog = () => {', '};');
const WARN_CONFIRM = sliceBetween(WARN_FLOW, 'const confirmAgentWarn = () => {', '};');
/** UX-15F — the dialog itself (the shared Modal's props and body). */
const WARN_MODAL = sliceBetween(ADMIN_VIEW_TSX, 'open={agentWarnPrompt !== null}', CONFIRM_MODAL);

/* ---------------------------------------------------------------------------
 * The guards — the same ones the UX-15C/D/E suite uses, so a reintroduced
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
// A. The native dialog is gone — from the flow and from the whole console.
// -----------------------------------------------------------------------------

describe('UX-15F: the agent-warning reason step is the shared Modal', () => {
  it('removes the browser prompt from the agent-warning flow entirely', () => {
    expect(browserDialog(WARN_FLOW)).toEqual([]);
    expect(WARN_FLOW).not.toContain('window.prompt');
    expect(WARN_FLOW).not.toContain('prompt(');
    expect(WARN_FLOW).not.toContain('window.confirm');
    expect(WARN_FLOW).not.toContain('window.alert');
    // …and the bilingual prompt label the old dialog used is gone with it.
    expect(WARN_FLOW).not.toContain('Enter reason for issuing warning to this agent');
  });

  it('leaves ZERO browser-native dialogs anywhere in AdminView', () => {
    // The whole file: the UX-14 gate, the UX-15 chrome, the panels and every
    // dialog. (UX-15C/D/E recorded the one remaining prompt; UX-15F closed it.)
    expect(browserDialog(CODE)).toEqual([]);
    expect(browserDialog(PANELS)).toEqual([]);
    expect(browserDialog(GATE)).toEqual([]);
    expect(CODE).not.toContain('window.confirm');
  });

  it('keeps the guards live, not decorative (mutation checks)', () => {
    expect(browserDialog(WARN_FLOW)).toEqual([]);
    expect(browserDialog(`${WARN_FLOW} prompt('reason')`)).not.toEqual([]);
    expect(browserDialog(`${WARN_FLOW} window.prompt('reason')`)).not.toEqual([]);
    expect(legacyColour(WARN_MODAL)).toEqual([]);
    expect(legacyColour(`${WARN_MODAL} bg-stone-100`)).not.toEqual([]);
    expect(offLadderType(WARN_MODAL)).toEqual([]);
    expect(offLadderType(`${WARN_MODAL} text-xs`)).not.toEqual([]);
    expect(magicIconSize(WARN_MODAL)).toEqual([]);
    expect(magicIconSize(`${WARN_MODAL} size={16}`)).not.toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// B. The control opens the shared dialog — which records the target only.
// -----------------------------------------------------------------------------

describe('the "Issue Warning" control opens the shared dialog', () => {
  it('is the same control, now opened through the shared Modal', () => {
    expect(PANELS).toContain('Issue Warning');
    expect(PANELS).toContain('onClick={() => openAgentWarnDialog(agent.id)}');
    // It is the panel's own control, still disabled by the pre-existing guard.
    const control = sliceBetween(PANELS, 'onClick={() => openAgentWarnDialog(agent.id)}', '</Button>');
    expect(PANELS).not.toContain('onClick={() => handleWarnAgent(agent.id)}');
    expect(control).not.toContain('fetch(');
  });

  it('opening records the target only: no request, no mutation, no banner reset', () => {
    expect(WARN_OPEN).toContain('setAgentWarnPrompt({ agentId: id });');
    expect(WARN_OPEN).not.toContain('handleWarnAgent');
    expect(WARN_OPEN).not.toContain('fetch(');
    // The old prompt also left the console banners alone until a warning was
    // actually issued, so opening must not clear them either.
    expect(WARN_OPEN).not.toContain('setActionSuccess');
    expect(WARN_OPEN).not.toContain('setActionWarning');
    expect(WARN_OPEN).not.toContain('setDataError');
    expect(WARN_OPEN).not.toContain('setAdminActionProcessing');
  });

  it('uses the ONE shared Modal — no new dialog component was introduced', () => {
    // Exactly four shared Modal usages exist in the file: the P1-01 refund
    // reconciliation, the UX-15E item-review reason step, this one, and the
    // confirmation dialog UX-15G later migrated onto the same primitive.
    expect(count(ADMIN_VIEW_TSX, /<Modal\b/g)).toBe(4);
    expect(ADMIN_VIEW_TSX).toContain("import Modal from './ui/Modal';");
    expect(WARN_MODAL).toContain('open={agentWarnPrompt !== null}');
    expect(WARN_MODAL).toContain('onClose={closeAgentWarnDialog}');
    expect(WARN_MODAL).toContain('footer={');
    // The dialog names itself and says what it is for.
    expect(WARN_MODAL).toContain("title={lang === 'en' ? 'Issue agent warning' : 'Toa onyo kwa wakala'}");
    expect(WARN_MODAL).toContain('official warning');
    // Accessibility comes from the primitive: focus trap, Escape, focus
    // restoration, role="dialog" + aria-modal — none of which a prompt had.
    expect(MODAL_PRIMITIVE).toContain('role="dialog"');
    expect(MODAL_PRIMITIVE).toContain('aria-modal="true"');
    expect(MODAL_PRIMITIVE).toContain('aria-labelledby');
    expect(MODAL_PRIMITIVE).toContain('trapModalFocus');
    expect(MODAL_PRIMITIVE).toContain('previouslyFocused.current?.focus?.()');
  });
});

// -----------------------------------------------------------------------------
// C. Cancel, Escape and the scrim: no mutation, no request, no state change.
// -----------------------------------------------------------------------------

describe('cancel performs no mutation and no request', () => {
  it('clears the temporary dialog state and never reaches the warning', () => {
    expect(WARN_CLOSE).toContain('setAgentWarnPrompt(null)');
    expect(WARN_CLOSE).toContain("setAgentWarnReason('')");
    expect(WARN_CLOSE).toContain("setAgentWarnReasonError('')");
    expect(WARN_CLOSE).not.toContain('handleWarnAgent');
    expect(WARN_CLOSE).not.toContain('fetch(');
    expect(WARN_CLOSE).not.toContain('setActionProcessing');
  });

  it('routes Cancel, Escape and the scrim through the same close path', () => {
    // The primitive calls onClose() for Escape and for a scrim press, so the
    // dialog's onClose IS the cancel contract — there is no second path.
    expect(WARN_MODAL).toContain('onClose={closeAgentWarnDialog}');
    expect(WARN_MODAL).toContain('onClick={closeAgentWarnDialog}');
    expect(MODAL_PRIMITIVE).toContain("if (event.key === 'Escape'");
    expect(MODAL_PRIMITIVE).toContain('onClose();');
    expect(MODAL_PRIMITIVE).toContain('if (e.target === e.currentTarget) onClose();');
    const escape = sliceBetween(MODAL_PRIMITIVE, "if (event.key === 'Escape'", 'document.addEventListener');
    expect(escape).toContain('onClose();');
    expect(escape).not.toContain('fetch(');
  });
});

// -----------------------------------------------------------------------------
// D. The reason: a labelled field, and the EXACT validation rule as before.
// -----------------------------------------------------------------------------

describe('the reason field and its validation', () => {
  it('collects the reason in a labelled, controlled multi-line field', () => {
    expect(WARN_MODAL).toContain('<Textarea');
    expect(WARN_MODAL).toContain('id="agent-warn-reason"');
    expect(WARN_MODAL).toContain('rows={3}');
    expect(WARN_MODAL).toContain('value={agentWarnReason}');
    expect(WARN_MODAL).toContain('setAgentWarnReason(e.target.value);');
    // Label → control association comes from the shared primitive.
    expect(TEXTAREA_PRIMITIVE).toContain('htmlFor={fieldId}');
    expect(TEXTAREA_PRIMITIVE).toContain('aria-describedby={describedBy}');
  });

  it('keeps the EXACT blank-reason guard the native prompt used', () => {
    // The prompt's rule — `if (!reason || reason.trim() === '') return;` — is
    // preserved verbatim: a missing, empty or whitespace-only reason still
    // issues NO warning at all. Only the failure MODE changed (it is now shown
    // in place, and the dialog stays open, instead of silently doing nothing).
    expect(WARN_CONFIRM).toContain("if (!reason || reason.trim() === '') {");
    // The mutation still never trims: the guard is the ONLY place the reason is
    // tested for blankness, exactly as the prompt's single line was.
    expect(WARN_MUTATION).not.toContain('reason.trim()');
    // The guard runs BEFORE the dialog closes and BEFORE the mutation, so a
    // blank reason can never reach a request.
    const guardAt = WARN_CONFIRM.indexOf("if (!reason || reason.trim() === '') {");
    const messageAt = WARN_CONFIRM.indexOf('setAgentWarnReasonError(');
    const closeAt = WARN_CONFIRM.indexOf('closeAgentWarnDialog();');
    const mutateAt = WARN_CONFIRM.indexOf('handleWarnAgent(agentId, reason);');
    expect(guardAt).toBeGreaterThan(-1);
    expect(messageAt).toBeGreaterThan(guardAt);
    expect(closeAt).toBeGreaterThan(messageAt);
    expect(mutateAt).toBeGreaterThan(closeAt);
  });

  it('announces a rejected reason inside the dialog, through the shared Banner', () => {
    expect(WARN_CONFIRM).toContain(
      "setAgentWarnReasonError(lang === 'en' ? 'A reason is required.' : 'Sababu inahitajika.');",
    );
    expect(WARN_MODAL).toContain('{agentWarnReasonError && <Banner kind="error">{agentWarnReasonError}</Banner>}');
    // The Banner already owns the live region — no second announcement channel.
    expect(BANNER_PRIMITIVE).toContain("aria-live={isInterruptive ? 'assertive' : 'polite'}");
    expect(BANNER_PRIMITIVE).toContain("const isInterruptive = kind === 'error' || kind === 'warning';");
    // …and typing clears a stale message.
    expect(WARN_MODAL).toContain('if (agentWarnReasonError) setAgentWarnReasonError(');
  });
});

// -----------------------------------------------------------------------------
// E. The mutation contract is byte-identical.
// -----------------------------------------------------------------------------

describe('the warning mutation is unchanged', () => {
  it('still posts the same endpoint with the same authorization and body', () => {
    expect(WARN_MUTATION).toContain('const handleWarnAgent = (id: string, reason: string) => {');
    expect(WARN_MUTATION).toContain('fetch(`/api/admin/agents/${id}/warn`, {');
    expect(WARN_MUTATION).toContain("method: 'POST',");
    expect(WARN_MUTATION).toContain("'Content-Type': 'application/json',");
    expect(WARN_MUTATION).toContain('Authorization: `Bearer ${token}`,');
    expect(WARN_MUTATION).toContain('body: JSON.stringify({ reason }),');
    // Exactly ONE request: the dialog collects input, it does not duplicate it.
    expect(count(WARN_FLOW, /fetch\(/g)).toBe(1);
  });

  it('preserves the success, error and refresh behaviour', () => {
    expect(WARN_MUTATION).toContain("if (!res.ok) throw new Error(data.error || 'Failed to warn agent');");
    expect(WARN_MUTATION).toContain('setActionSuccess(data.message);');
    expect(WARN_MUTATION).toContain('fetchDashboardData();');
    expect(WARN_MUTATION).toContain('.catch(err => setDataError(err.message))');
    expect(WARN_MUTATION).toContain('.finally(() => setAdminActionProcessing(false));');
    // …and the pre-existing in-flight guard still clears the banners and sets
    // the processing flag BEFORE the request is issued.
    const clearAt = WARN_MUTATION.indexOf("setActionSuccess('')");
    const processingAt = WARN_MUTATION.indexOf('setAdminActionProcessing(true);');
    const fetchAt = WARN_MUTATION.indexOf('fetch(');
    expect(clearAt).toBeGreaterThan(-1);
    expect(processingAt).toBeGreaterThan(clearAt);
    expect(fetchAt).toBeGreaterThan(processingAt);
    // The originating control is still disabled by that same guard.
    expect(PANELS).toContain('disabled={adminActionProcessing}');
  });

  it('sends the UNTRIMMED reason, exactly as the prompt did', () => {
    expect(WARN_CONFIRM).toContain('const reason = agentWarnReason;');
    expect(WARN_CONFIRM).toContain('handleWarnAgent(agentId, reason);');
    expect(WARN_CONFIRM).not.toContain('handleWarnAgent(agentId, reason.trim());');
    expect(WARN_CONFIRM).not.toContain('agentWarnReason.trim()');
    // The mutation reads the ARGUMENT, never the dialog state.
    expect(WARN_MUTATION).not.toContain('agentWarnReason');
    expect(WARN_MUTATION).not.toContain('agentWarnPrompt');
  });
});

// -----------------------------------------------------------------------------
// F. Scope: UX-14, UX-15E, the confirmation dialog, the lightbox and UX-16.
// -----------------------------------------------------------------------------

describe('the batch stays in its lane', () => {
  it('leaves the UX-14 authentication gate exactly where it was', () => {
    expect(count(CODE, /\{!token && \(/g)).toBe(1);
    expect(GATE_TSX).toContain('{!token && (');
    expect(GATE_TSX).not.toContain(CONSOLE_MARKER);
    expect(GATE).toContain('Admin Authentication');
    expect(GATE).toContain('pendingTwoFactorToken');
    expect(browserDialog(GATE)).toEqual([]);
    // The warning dialog lives AFTER the marker, i.e. inside the console.
    expect(CONSOLE_TSX.indexOf('open={agentWarnPrompt !== null}')).toBeGreaterThan(-1);
    // …and the gate's OWN JSX is untouched by this batch.
    expect(GATE_JSX).toContain('pendingTwoFactorToken');
    expect(GATE_JSX).toContain('onSubmit={pendingTwoFactorToken ? handleTwoFactorVerify : handleAdminAuth}');
    expect(GATE_JSX).not.toContain('open={agentWarnPrompt !== null}');
    expect(GATE_JSX).not.toContain('agentWarnReason');
  });

  it('leaves the UX-15E item-review dialog intact', () => {
    expect(ADMIN_VIEW_TSX).toContain('open={itemReviewPrompt !== null}');
    expect(ADMIN_VIEW_TSX).toContain('onClose={closeItemReviewPrompt}');
    expect(ADMIN_VIEW_TSX).toContain('onClick={confirmItemReviewStatusChange}');
    expect(ADMIN_VIEW_TSX).toContain(
      "if ((action === 'flag-stolen' || action === 'legal-hold') && !reason.trim()) {",
    );
    expect(ADMIN_VIEW_TSX).toContain("setItemReviewReasonError('A reason is required.');");
    expect(ADMIN_VIEW_TSX).toContain('handleItemReviewStatusChange(itemId, action, reason.trim());');
    // The two shared dialogs stay independent of one another.
    expect(WARN_MODAL).not.toContain('itemReviewPrompt');
    expect(WARN_FLOW).not.toContain('itemReviewPrompt');
  });

  it('leaves the shared confirmation dialog and the lightbox in their own lanes', () => {
    const confirmDialog = sliceBetween(ADMIN_VIEW_TSX, CONFIRM_MODAL, LIGHTBOX);
    // UX-15G moved this overlay onto the shared primitive: the dialog is now the
    // same Modal, and the hand-built presentation is gone.
    expect(confirmDialog).toContain('<Modal');
    expect(confirmDialog).toContain('open={confirmModal !== null}');
    expect(confirmDialog).toContain('onClick={confirmPendingAction}');
    expect(confirmDialog).toContain('onClick={closeConfirmModal}');
    expect(confirmDialog).not.toContain('bg-stone-900/60');
    expect(confirmDialog).not.toContain('bg-primary-green hover:bg-primary-hover');
    // The two shared dialogs stay independent of one another.
    expect(WARN_MODAL).not.toContain('confirmModal');
    expect(WARN_FLOW).not.toContain('confirmModal');
    expect(ADMIN_VIEW_TSX).toContain(LIGHTBOX);
    expect(WARN_MODAL).not.toContain('lightboxImage');
    expect(WARN_FLOW).not.toContain('lightboxImage');
  });

  it('does not start UX-16 or any later batch', () => {
    expect(ADMIN_VIEW_TSX).not.toContain('AgentVerificationPanel');
    expect(ADMIN_VIEW_TSX).not.toContain('AgentRejectionPanel');
    expect(ADMIN_VIEW_TSX).not.toMatch(/from '\.\/agent\//);
    const queued = DESIGN_SYSTEM.split(/\r?\n/).filter(
      (line) => line.startsWith('| ') && line.includes('UX-16'),
    );
    expect(queued.length).toBeGreaterThanOrEqual(4);
  });
});

// -----------------------------------------------------------------------------
// G. The dialog uses the existing design system, and the batch is recorded.
// -----------------------------------------------------------------------------

describe('presentation and the recorded state', () => {
  it('uses the existing appearance tokens and primitives — no new ones', () => {
    expect(WARN_MODAL).toContain('text-[var(--appearance-text-secondary)]');
    expect(WARN_MODAL).toContain('variant="secondary"');
    expect(WARN_MODAL).toContain('variant="danger"');
    expect(WARN_MODAL).toContain('kind="error"');
    expect(offLadderType(WARN_MODAL)).toEqual([]);
    expect(legacyColour(WARN_MODAL)).toEqual([]);
    expect(magicIconSize(WARN_MODAL)).toEqual([]);
    expect(browserDialog(WARN_MODAL)).toEqual([]);
    // Both button variants and the error kind already exist in the foundation.
    expect(BUTTON_PRIMITIVE).toContain('danger:');
    expect(BUTTON_PRIMITIVE).toContain('secondary:');
  });

  it('is recorded in the design-system reference without weakening the queue', () => {
    const row = DESIGN_SYSTEM.split(/\r?\n/).find((line) => line.startsWith('| AdminView |'));
    expect(row).toBeDefined();
    expect(row as string).toContain('MIGRATE LATER');
    expect(row as string).toContain('UX-15C/D/E');
    expect(row as string).toContain('UX-15F');
    expect(row as string).toContain('no browser-native dialog remains in AdminView at all');
    // Neighbouring batches keep their exact classification counts.
    expect(count(DESIGN_SYSTEM, /MIGRATED in UX-14/g)).toBe(2);
    expect(count(DESIGN_SYSTEM, /MIGRATED in UX-11/g)).toBe(2);
    expect(count(DESIGN_SYSTEM, /MIGRATED in UX-13/g)).toBe(1);
  });

  it('no longer records a live prompt in the design-system reference', () => {
    const note = sliceBetween(DESIGN_SYSTEM, '`window.prompt()` / `window.confirm()`', '`Modal`)');
    expect(note).not.toContain('remains in');
    expect(note).toContain('UX-15F');
  });
});
