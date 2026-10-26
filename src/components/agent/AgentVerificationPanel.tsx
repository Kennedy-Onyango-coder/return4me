import Button from '../ui/Button';
// MOBILE-FIRST BATCH B — the ONE field language shared with the rejection panel.
// Imported rather than re-typed so the two inline panels cannot drift apart.
import { FIELD_CLASS, FIELD_LABEL_CLASS, FINDER_NOTE_CLASS } from './agentPanelFieldStyles';
import { panelFocusRef } from './panelFocus';

/**
 * AGENTHUB STRUCTURAL EXTRACTION - BATCH B (presentation-only child).
 *
 * Renders ONE drop-off's item-verification panel. Pure presentation:
 *   * 0 useState / useEffect / useReducer / useRef
 *   * 0 fetch, 0 agentApi, 0 useAgentOperations import
 *   * no operational ownership - every value and callback arrives as a prop, and
 *     `useAgentOperations` remains the single owner of workflow state.
 *
 * The prop type is declared LOCALLY rather than imported from `AgentHub.tsx`,
 * because the parent imports this component: reusing the parent's domain
 * interface would create a circular import. Member names and types are
 * identical to the corresponding parent domain contract.
 *
 * The parent still owns the render gate (`verifyingItemId === item.id`), so this child only ever
 * renders for the single item the parent selected.
 */
export interface AgentVerificationPanelProps {
  /** The drop-off being verified; drives the static ids and the Finder notes. */
  item: any;
  // AGENTHUB UX BATCH 4: the submit action's consequence is now stated through
  // the existing translation bundle instead of four compound English-only
  // labels. `t` is passed for that reason only; no language state is created.
  t: any;
  categories: any[];
  verifyCategoryId: string;
  setVerifyCategoryId: (v: string) => void;
  verifyName: string;
  setVerifyName: (v: string) => void;
  verifyDocNumber: string;
  setVerifyDocNumber: (v: string) => void;
  verifyDescription: string;
  setVerifyDescription: (v: string) => void;
  verifyFoundArea: string;
  setVerifyFoundArea: (v: string) => void;
  verifyPhysicallyChecked: boolean;
  setVerifyPhysicallyChecked: (v: boolean) => void;
  verifyReason: string;
  setVerifyReason: (v: string) => void;
  verifyReasonDetail: string;
  setVerifyReasonDetail: (v: string) => void;
  verifyError: string;
  setVerifyingItemId: (id: string | null) => void;
  hasCorrections: (item: any) => boolean;
  handleSubmitVerification: (item: any, outcome: 'confirmed' | 'corrected') => void;
  /** The parent's per-item busy predicate, derived from `processingItemId`. */
  isItemBusy: (id: string | null | undefined) => boolean;
}

export default function AgentVerificationPanel({
  item,
  t,
  categories,
  verifyCategoryId,
  setVerifyCategoryId,
  verifyName,
  setVerifyName,
  verifyDocNumber,
  setVerifyDocNumber,
  verifyDescription,
  setVerifyDescription,
  verifyFoundArea,
  setVerifyFoundArea,
  verifyPhysicallyChecked,
  setVerifyPhysicallyChecked,
  verifyReason,
  setVerifyReason,
  verifyReasonDetail,
  setVerifyReasonDetail,
  verifyError,
  setVerifyingItemId,
  hasCorrections,
  handleSubmitVerification,
  isItemBusy,
}: AgentVerificationPanelProps) {
  return (
// BATCH 1 (UX-02): the panel container is the focus target. It is NOT in the
// tab order (tabIndex -1) so no visible focus stop is added to normal
// keyboard flow, and `panelFocusRef` moves focus here on open and returns it
// to this item's originating action on close.
//
// MOBILE-FIRST BATCH B: the container is a THEMED, single-column surface that
// stacks under the queue card it belongs to. `rounded-panel` / `space-y-4` are
// the UX-01 radius and spacing ladders, and the muted surface plus the
// appearance border keep the panel correct in the dark theme - the previous
// `bg-brand-beige/60` + `border-stone-200` pair was light-only. Every field
// inside reads the ONE field language in agentPanelFieldStyles.ts.
<div ref={panelFocusRef(item.id, 'verify')} tabIndex={-1} className="space-y-4 rounded-panel border border-[var(--appearance-border)] bg-[var(--appearance-surface-muted)] p-4 shadow-raised sm:p-5">
  <h4 className="text-heading font-extrabold text-[var(--appearance-primary)]">
    {'Item Verification'}
  </h4>

  {/* PHASE 16.1 BATCH 3 (A-2) — programmatic label
      association. This label had no `htmlFor` and the
      select no `id`, so assistive technology announced
      an unlabelled combobox. Static ids are safe: the
      panel renders for at most ONE item at a time
      (verifyingItemId === item.id), the same reasoning
      the P14C-5B fix below already relies on. */}
  <div className="space-y-1">
    <label htmlFor="agent-verify-category" className={FIELD_LABEL_CLASS}>{'Category'}</label>
    <select
      id="agent-verify-category"
      value={verifyCategoryId}
      onChange={(e) => setVerifyCategoryId(e.target.value)}
      className={FIELD_CLASS}
    >
      {categories.map((c: any) => (
        <option key={c.id} value={c.id}>{c.name_en}</option>
      ))}
    </select>
    {verifyCategoryId !== (item.category_id || '') && (
      <p className={FINDER_NOTE_CLASS}>Finder: {item.category_id}</p>
    )}
  </div>

  {item.is_sensitive_document && (
    <>
      <div className="space-y-1">
        <label htmlFor="agent-verify-doc-name" className={FIELD_LABEL_CLASS}>{'Name on document'}</label>
        <input
          id="agent-verify-doc-name"
          type="text"
          value={verifyName}
          onChange={(e) => setVerifyName(e.target.value)}
          className={FIELD_CLASS}
        />
        {verifyName !== (item.ocr_extracted_name || '') && (
          <p className={FINDER_NOTE_CLASS}>Finder: {item.ocr_extracted_name || '(none)'}</p>
        )}
      </div>
      <div className="space-y-1">
        <label htmlFor="agent-verify-doc-number" className={FIELD_LABEL_CLASS}>{'Document number'}</label>
        <input
          id="agent-verify-doc-number"
          type="text"
          value={verifyDocNumber}
          onChange={(e) => setVerifyDocNumber(e.target.value)}
          className={`${FIELD_CLASS} font-mono`}
        />
        {verifyDocNumber !== (item.ocr_extracted_number || '') && (
          <p className={FINDER_NOTE_CLASS}>Finder: {item.ocr_extracted_number || '(none)'}</p>
        )}
      </div>
    </>
  )}

  <div className="space-y-1">
    <label htmlFor="agent-verify-description" className={FIELD_LABEL_CLASS}>{'Description'}</label>
    <input
      id="agent-verify-description"
      type="text"
      value={verifyDescription}
      onChange={(e) => setVerifyDescription(e.target.value)}
      className={FIELD_CLASS}
    />
    {verifyDescription !== (item.description || '') && (
      <p className={FINDER_NOTE_CLASS}>Finder: {item.description || '(none)'}</p>
    )}
  </div>

  {/* P14C-5B — this label had no `htmlFor` and the input
      no `id`, so assistive technology saw an unlabelled
      text box. The panel renders for at most ONE item at
      a time (`verifyingItemId === item.id`), so a static
      id cannot collide. The "Finder: …" note is itself
      conditionally rendered, so the `aria-describedby`
      reference is attached under the SAME condition — a
      reference is never left dangling. Label text only:
      the state, the `foundArea` payload and the
      `verified_found_area` column are unchanged. */}
  <div className="space-y-1">
    <label htmlFor="agent-verify-exact-place" className={FIELD_LABEL_CLASS}>{'Exact place'}</label>
    <input
      id="agent-verify-exact-place"
      type="text"
      value={verifyFoundArea}
      onChange={(e) => setVerifyFoundArea(e.target.value)}
      className={FIELD_CLASS}
      aria-describedby={
        verifyFoundArea !== (item.location_description || '')
          ? 'agent-verify-exact-place-finder-note'
          : undefined
      }
    />
    {verifyFoundArea !== (item.location_description || '') && (
      <p id="agent-verify-exact-place-finder-note" className={FINDER_NOTE_CLASS}>Finder: {item.location_description}</p>
    )}
  </div>

  {hasCorrections(item) && (
    <div className="space-y-1">
      {/* PHASE 16.1 BATCH 3 (A-2) — the select had no
          `htmlFor`/`id`, and the detail input below had
          NO LABEL AT ALL (only a placeholder, which is
          not an accessible name). Both are now properly
          associated. */}
      <label htmlFor="agent-verify-reason" className={FIELD_LABEL_CLASS}>{'Reason for correction'}</label>
      <select
        id="agent-verify-reason"
        value={verifyReason}
        onChange={(e) => setVerifyReason(e.target.value)}
        className={FIELD_CLASS}
      >
        <option value="Finder entered wrong information">Finder entered wrong information</option>
        <option value="Finder information incomplete">Finder information incomplete</option>
        <option value="Physical item differs from report">Physical item differs from report</option>
        <option value="Wrong category">Wrong category</option>
        <option value="Wrong description">Wrong description</option>
        <option value="Wrong location">Wrong location</option>
        <option value="Other">Other</option>
      </select>
      <label htmlFor="agent-verify-reason-detail" className={FIELD_LABEL_CLASS}>{'Correction reason detail'}</label>
      <input
        id="agent-verify-reason-detail"
        type="text"
        value={verifyReasonDetail}
        onChange={(e) => setVerifyReasonDetail(e.target.value)}
        placeholder="Optional explanation..."
        className={FIELD_CLASS}
      />
    </div>
  )}

  {/* MOBILE-FIRST BATCH B — the physical-inspection control is a 44px row and
      the whole row is the target (the <label> wraps the box), because this is
      the one control an agent must hit one-handed before approving a drop-off.

      Both paragraphs below were previously written as RAW `//` LINES INSIDE
      THE JSX BODY. JSX renders bare text, so the agent was shown a paragraph
      that literally began "// BATCH 1 (UX-01): ..." above the action row. They
      are real JSX comments now: the rationale stays in the source and never
      reaches the screen.

      The error keeps the ONLY `role="alert"` in this panel; `role="alert"`
      already implies aria-live="assertive", so the two are not stacked, and its
      text, condition and server source are unchanged. */}
  <label className="flex min-h-11 items-center gap-3 text-body font-semibold text-[var(--appearance-text-primary)]">
    <input
      type="checkbox"
      checked={verifyPhysicallyChecked}
      onChange={(e) => setVerifyPhysicallyChecked(e.target.checked)}
      className="h-5 w-5 shrink-0 accent-[var(--appearance-primary)]"
    />
    <span>{'I have physically inspected this item'}</span>
  </label>
  {item.is_sensitive_document && (verifyName !== (item.ocr_extracted_name || '') || verifyDocNumber !== (item.ocr_extracted_number || '')) && !verifyPhysicallyChecked && (
    <p className="break-words text-caption font-semibold text-[var(--appearance-danger)]">
      {'Correcting name/ID number on a sensitive document requires physical inspection — check the box above.'}
    </p>
  )}

  {verifyError && (
    <p role="alert" className="break-words text-caption font-semibold text-[var(--appearance-danger)]">{verifyError}</p>
  )}

  {/* The action row keeps its established wrapper (the Batch-1 focus suite reads
      up to it as a boundary) but each action is now full-width on phones: the
      primary action gets its own thumb-height row instead of being squeezed
      beside Cancel at 320px, and returns to an inline right-aligned row at
      `sm` and up. Cancel stays enabled while a submit is in flight, exactly as
      before; the submit keeps its per-item `disabled`/`aria-busy` pair and the
      shared Button renders the loading spinner (16px, UX-01 ladder) beside the
      unchanged label. */}
  <div className="flex flex-wrap gap-2 justify-end pt-1">
    <Button
      type="button"
      variant="ghost"
      size="md"
      onClick={() => setVerifyingItemId(null)}
      className="w-full sm:w-auto"
    >
      {'Cancel'}
    </Button>
    <Button
      type="button"
      variant="primary"
      size="md"
      disabled={isItemBusy(item.id)}
      aria-busy={isItemBusy(item.id)}
      loading={isItemBusy(item.id)}
      onClick={() => handleSubmitVerification(item, hasCorrections(item) ? 'corrected' : 'confirmed')}
      className="w-full sm:w-auto"
    >
      {hasCorrections(item) ? t.agentVerifySaveCorrections : t.agentVerifyConfirmReported}
    </Button>
  </div>
  {/* AGENTHUB UX BATCH 4: this ONE submit action does two possible things,
      decided by a single fact the agent controls - whether the item was
      physically inspected. The previous compound label bundled that second
      consequence behind an ampersand, hiding it. This states the actual
      consequence of the CURRENT state. Both strings describe only what the
      existing server route already does (record the verification; approve the
      drop-off when physically checked) and imply nothing about payment,
      refund, payout, claim approval, or notification. */}
  <p className="break-words text-caption leading-relaxed text-[var(--appearance-text-muted)]">
    <span className="font-semibold">{t.agentVerifySubmitHint}:</span>{' '}
    {verifyPhysicallyChecked ? t.agentVerifyApprovesToo : t.agentVerifySavesOnly}
  </p>
</div>
  );
}
