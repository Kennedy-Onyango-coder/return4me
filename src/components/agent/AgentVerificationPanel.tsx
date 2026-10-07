import { Loader2 } from 'lucide-react';
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
<div ref={panelFocusRef(item.id, 'verify')} tabIndex={-1} className="bg-brand-beige/60 p-4 rounded-xl border border-stone-200 space-y-3">
  <h4 className="text-xs font-extrabold text-primary-green uppercase tracking-wide">
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
    <label htmlFor="agent-verify-category" className="text-xs font-bold text-stone-500 uppercase block">Category</label>
    <select
      id="agent-verify-category"
      value={verifyCategoryId}
      onChange={(e) => setVerifyCategoryId(e.target.value)}
      className="w-full border border-stone-200 rounded-lg p-2 text-xs bg-white"
    >
      {categories.map((c: any) => (
        <option key={c.id} value={c.id}>{c.name_en}</option>
      ))}
    </select>
    {verifyCategoryId !== (item.category_id || '') && (
      <p className="text-xs text-stone-400">Finder: {item.category_id}</p>
    )}
  </div>

  {item.is_sensitive_document && (
    <>
      <div className="space-y-1">
        <label htmlFor="agent-verify-doc-name" className="text-xs font-bold text-stone-500 uppercase block">Name on document</label>
        <input
          id="agent-verify-doc-name"
          type="text"
          value={verifyName}
          onChange={(e) => setVerifyName(e.target.value)}
          className="w-full border border-stone-200 rounded-lg p-2 text-xs"
        />
        {verifyName !== (item.ocr_extracted_name || '') && (
          <p className="text-xs text-stone-400">Finder: {item.ocr_extracted_name || '(none)'}</p>
        )}
      </div>
      <div className="space-y-1">
        <label htmlFor="agent-verify-doc-number" className="text-xs font-bold text-stone-500 uppercase block">Document number</label>
        <input
          id="agent-verify-doc-number"
          type="text"
          value={verifyDocNumber}
          onChange={(e) => setVerifyDocNumber(e.target.value)}
          className="w-full border border-stone-200 rounded-lg p-2 text-xs font-mono"
        />
        {verifyDocNumber !== (item.ocr_extracted_number || '') && (
          <p className="text-xs text-stone-400">Finder: {item.ocr_extracted_number || '(none)'}</p>
        )}
      </div>
    </>
  )}

  <div className="space-y-1">
    <label htmlFor="agent-verify-description" className="text-xs font-bold text-stone-500 uppercase block">Description</label>
    <input
      id="agent-verify-description"
      type="text"
      value={verifyDescription}
      onChange={(e) => setVerifyDescription(e.target.value)}
      className="w-full border border-stone-200 rounded-lg p-2 text-xs"
    />
    {verifyDescription !== (item.description || '') && (
      <p className="text-xs text-stone-400">Finder: {item.description || '(none)'}</p>
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
    <label htmlFor="agent-verify-exact-place" className="text-xs font-bold text-stone-500 uppercase block">Exact place</label>
    <input
      id="agent-verify-exact-place"
      type="text"
      value={verifyFoundArea}
      onChange={(e) => setVerifyFoundArea(e.target.value)}
      className="w-full border border-stone-200 rounded-lg p-2 text-xs"
      aria-describedby={
        verifyFoundArea !== (item.location_description || '')
          ? 'agent-verify-exact-place-finder-note'
          : undefined
      }
    />
    {verifyFoundArea !== (item.location_description || '') && (
      <p id="agent-verify-exact-place-finder-note" className="text-xs text-stone-400">Finder: {item.location_description}</p>
    )}
  </div>

  {hasCorrections(item) && (
    <div className="space-y-1">
      {/* PHASE 16.1 BATCH 3 (A-2) — the select had no
          `htmlFor`/`id`, and the detail input below had
          NO LABEL AT ALL (only a placeholder, which is
          not an accessible name). Both are now properly
          associated. */}
      <label htmlFor="agent-verify-reason" className="text-xs font-bold text-stone-500 uppercase block">Reason for correction</label>
      <select
        id="agent-verify-reason"
        value={verifyReason}
        onChange={(e) => setVerifyReason(e.target.value)}
        className="w-full border border-stone-200 rounded-lg p-2 text-xs bg-white"
      >
        <option value="Finder entered wrong information">Finder entered wrong information</option>
        <option value="Finder information incomplete">Finder information incomplete</option>
        <option value="Physical item differs from report">Physical item differs from report</option>
        <option value="Wrong category">Wrong category</option>
        <option value="Wrong description">Wrong description</option>
        <option value="Wrong location">Wrong location</option>
        <option value="Other">Other</option>
      </select>
      <label htmlFor="agent-verify-reason-detail" className="text-xs font-bold text-stone-500 uppercase block">Correction reason detail</label>
      <input
        id="agent-verify-reason-detail"
        type="text"
        value={verifyReasonDetail}
        onChange={(e) => setVerifyReasonDetail(e.target.value)}
        placeholder="Optional explanation..."
        className="w-full border border-stone-200 rounded-lg p-2 text-xs"
      />
    </div>
  )}

  <label className="flex items-center space-x-2 text-xs text-stone-700 font-semibold">
    <input
      type="checkbox"
      checked={verifyPhysicallyChecked}
      onChange={(e) => setVerifyPhysicallyChecked(e.target.checked)}
    />
    <span>{'I have physically inspected this item'}</span>
  </label>
  {item.is_sensitive_document && (verifyName !== (item.ocr_extracted_name || '') || verifyDocNumber !== (item.ocr_extracted_number || '')) && !verifyPhysicallyChecked && (
    <p className="text-xs text-red-600 font-semibold">
      {'Correcting name/ID number on a sensitive document requires physical inspection — check the box above.'}
    </p>
  )}

  // BATCH 1 (UX-01): the verification failure is a dynamic, actionable
  // failure, so it is announced immediately. `role="alert"` implies
  // aria-live="assertive", so the two are not stacked redundantly. The text,
  // its condition, and the server as its source are all unchanged.
  {verifyError && (
    <p role="alert" className="text-xs text-red-600 font-semibold">{verifyError}</p>
  )}

  <div className="flex flex-wrap gap-2 justify-end pt-1">
    <button type="button" onClick={() => setVerifyingItemId(null)}
      className="text-stone-500 hover:text-stone-700 text-xs px-3 py-1.5 rounded-lg"
    >
      Cancel
    </button>
    <button
      disabled={isItemBusy(item.id)}
      aria-busy={isItemBusy(item.id)}
      onClick={() => handleSubmitVerification(item, hasCorrections(item) ? 'corrected' : 'confirmed')}
      className="bg-primary-green hover:bg-primary-hover text-white text-xs font-bold px-4 py-1.5 rounded-xl transition disabled:opacity-50 flex items-center gap-1.5"
    >
      {isItemBusy(item.id) ? <Loader2 className="animate-spin" size={12} aria-hidden={true} /> : null}
      {hasCorrections(item) ? t.agentVerifySaveCorrections : t.agentVerifyConfirmReported}
    </button>
  </div>
  {/* AGENTHUB UX BATCH 4: this ONE submit action does two possible things,
      decided by a single fact the agent controls - whether the item was
      physically inspected. The previous compound label bundled that second
      consequence behind an ampersand, hiding it. This states the actual
      consequence of the CURRENT state. Both strings describe only what the
      existing server route already does (record the verification; approve the
      drop-off when physically checked) and imply nothing about payment,
      refund, payout, claim approval, or notification. */}
  <p className="text-xs text-stone-500 leading-tight">
    <span className="font-semibold">{t.agentVerifySubmitHint}:</span>{' '}
    {verifyPhysicallyChecked ? t.agentVerifyApprovesToo : t.agentVerifySavesOnly}
  </p>
</div>
  );
}
