import Button from '../ui/Button';
import { panelFocusRef } from './panelFocus';

/**
 * AGENTHUB STRUCTURAL EXTRACTION - BATCH B (presentation-only child).
 *
 * Renders ONE drop-off's drop-off rejection panel. Pure presentation:
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
 * The parent still owns the render gate (`rejectingItemId === item.id`), so this child only ever
 * renders for the single item the parent selected.
 */
export interface AgentRejectionPanelProps {
  /** The drop-off being rejected; drives the reason select id. */
  item: any;
  /** The Hub's existing translation bundle. BATCH 2 (UX-03) needs it ONLY for
   *  the new consequence statement; the pre-existing English literals below are
   *  deliberately left exactly as they were (rejection-panel bilingual parity
   *  is not this batch's scope). */
  t: any;
  rejectionReason: string;
  setRejectionReason: (v: string) => void;
  rejectionCustomText: string;
  setRejectionCustomText: (v: string) => void;
  setRejectingItemId: (id: string | null) => void;
  handleRejectDropoff: (dropoffCode: string) => void;
  /** The parent's per-item busy predicate, derived from `processingItemId`. */
  isItemBusy: (id: string | null | undefined) => boolean;
}

export default function AgentRejectionPanel({
  item,
  t,
  rejectionReason,
  setRejectionReason,
  rejectionCustomText,
  setRejectionCustomText,
  setRejectingItemId,
  handleRejectDropoff,
  isItemBusy,
}: AgentRejectionPanelProps) {
  return (
// BATCH 1 (UX-02): the panel container is the focus target. It is NOT in the
// tab order (tabIndex -1), so no visible focus stop is added to normal
// keyboard flow, and `panelFocusRef` moves focus here on open and returns it
// to this item's originating Reject action on close.
<div ref={panelFocusRef(item.id, 'reject')} tabIndex={-1} className="bg-red-50/50 p-3 rounded-xl border border-red-100/50 space-y-3">
  <label htmlFor={`reject-reason-${item.id}`} className="text-xs font-bold text-red-800 block">Reject Drop-off Reason:</label>
  <div className="space-y-2">
    <select
      id={`reject-reason-${item.id}`}
      value={rejectionReason}
      onChange={(e) => setRejectionReason(e.target.value)}
      className="w-full border border-stone-200 rounded-lg p-2 text-xs bg-white focus:outline-none focus:border-red-500"
    >
      <option value="Not a real item">Not a real item</option>
      <option value="Item doesn't match description">Item doesn't match description</option>
      <option value="Suspected test/spam">Suspected test/spam</option>
      <option value="Other">Other (Please specify)</option>
    </select>

    {rejectionReason === "Other" && (
      <input
        type="text"
        value={rejectionCustomText}
        onChange={(e) => setRejectionCustomText(e.target.value)}
        placeholder="Enter custom rejection reason..."
        aria-label="Custom rejection reason"
        className="w-full border border-stone-200 rounded-lg p-2 text-xs focus:outline-none focus:border-red-500"
        required
      />
    )}
  </div>

  {/* BATCH 2 (UX-03): the consequence statement sits directly above the
      action row, inside the action area, so it is read as part of deciding to
      reject. It is static content, not a new error or live region, and it
      asserts only what POST /api/agents/reject-dropoff actually enforces. */}
  <p className="rounded-lg border border-red-200 bg-white/70 px-3 py-2 text-xs font-semibold leading-snug text-red-800">
    {t.agentRejectConsequence}
  </p>

  <div className="flex flex-wrap items-center justify-end gap-2">
    <Button type="button" variant="outline" size="sm" onClick={() => setRejectingItemId(null)}>
      Cancel
    </Button>
    {/* BATCH 2 (UX-03): the destructive action now uses the SHARED Button
        `danger` variant instead of a hand-rolled `bg-red-600` literal, so it
        follows the appearance tokens (--appearance-danger) and stays correct in
        light and dark, and so it is visually consistent with the Hub's Reject
        trigger. Behaviour is unchanged: same handler, same empty-"Other" guard,
        same explicit aria-busy. Button's `loading` renders the shared spinner
        and keeps the label mounted, so the row cannot jump while submitting. */}
    <Button
      type="button"
      variant="danger"
      size="sm"
      onClick={() => handleRejectDropoff(item.id)}
      disabled={isItemBusy(item.id) || (rejectionReason === "Other" && rejectionCustomText.trim() === "")}
      loading={isItemBusy(item.id)}
      aria-busy={isItemBusy(item.id)}
    >
      Submit Rejection
    </Button>
  </div>
</div>
  );
}
