import React from 'react';
import ClaimVerificationEvidence from '../ClaimVerificationEvidence';
import { agentClaimBadge, getClaimStatusDisplay } from '../claimStatus';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import { ShieldCheck, CheckCircle, AlertCircle, Loader2, Eye, RefreshCw } from 'lucide-react';

export interface AgentHubProps {
  lang: 'en' | 'sw';
  t: any;
  agentProfile: any | null;
  agentEarnings: any | null;
  actionSuccessMsg: string;
  operationError: string;
  setOperationError: (m: string) => void;
  queueError: string;
  queueLoading: boolean;
  retryQueue: () => void;
  expectedDropoffs: any[];
  dropoffCodeInput: string;
  setDropoffCodeInput: (v: string) => void;
  actionProcessing: boolean;
  /**
   * PHASE 16.1 BATCH 4B-1 (B3) - THE PER-ITEM BUSY IDENTITY.
   *
   * `actionProcessing` is a single global flag, so one card's action used to
   * disable and spin every card in the Hub. This prop carries WHICH record is
   * actually in flight, and it is populated by AgentView (the Hub stays
   * presentational and hook-free):
   *   * drop-off actions  (verify/correct, reject)      -> the item's drop-off
   *     code (`item.id`, an R4M- code)
   *   * held-item actions (confirm viewing, handover)   -> the claim id
   *     (`item.associatedClaim.id`, a CLM- id)
   * Those two namespaces are disjoint, so one field is unambiguous here.
   *
   * This is a UX guard only: it never authorizes anything. The server-side
   * ownership guards, the claim-status CAS in transitionClaimStatus, and the
   * pickup-code check remain the authoritative protections against a duplicate
   * or unauthorized submission - and `actionProcessing` is retained alongside
   * it for the modal-driven operations whose global protection is deliberate.
   */
  processingItemId: string | null;
  handleLookupDropoff: (e: React.FormEvent) => void;
  verifyingItemId: string | null;
  setVerifyingItemId: (id: string | null) => void;
  openVerificationPanel: (item: any) => void;
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
  hasCorrections: (item: any) => boolean;
  handleSubmitVerification: (item: any, outcome: 'confirmed' | 'corrected') => void;
  rejectingItemId: string | null;
  setRejectingItemId: (id: string | null) => void;
  rejectionReason: string;
  setRejectionReason: (v: string) => void;
  rejectionCustomText: string;
  setRejectionCustomText: (v: string) => void;
  handleRejectDropoff: (dropoffCode: string) => void;
  handleConfirmHandover: (claimId: string) => void;
  handleConfirmViewing: (claimId: string) => void;
  categories: any[];
  holdingPickups: any[];
  refreshCategories?: () => void;
}

export default function AgentHub({ t, ...props }: AgentHubProps) {
  /**
   * PHASE 16.1 BATCH 4B-1 (B3) - per-item busy predicate.
   *
   * A card's action controls are busy ONLY when this exact record is the one in
   * flight, so a long handover no longer greys out an unrelated drop-off (and
   * vice versa). The identity arrives through props because the Hub owns no
   * state of its own - AgentView remains the single owner of hub state, and the
   * server remains the single authority on what an agent may actually do.
   */
  const isItemBusy = (id: string | null | undefined) =>
    Boolean(id) && props.processingItemId === id;

  const itemContextLabel = (item: any) => {
    const title = [item.title, item.item_title, item.description]
      .find((value) => typeof value === 'string' && value.trim());
    return title ? title.trim() : t.agentItemContextUnavailable;
  };

  const itemHeading = (item: any) => itemContextLabel(item);
  const itemReference = (item: any) => item.id;

  const itemLocationLabel = (item: any) => {
    const parts = [item.county, item.found_area, item.found_area_details]
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => value.trim());
    return parts.length ? [...new Set(parts)].join(' · ') : t.agentItemContextUnavailable;
  };

  const claimBadgeVariant = (item: any) => {
    if (!item.associatedClaim?.status) return 'neutral' as const;
    return getClaimStatusDisplay(item.associatedClaim.status, props.lang).variant;
  };

  const ItemMetadata = ({ item }: { item: any }) => (
    <div className="grid gap-2 text-xs text-stone-600 sm:grid-cols-2" aria-label={t.agentItemContextItem}>
      {item.category_name || item.category_id ? (
        <p className="min-w-0 break-words"><span className="font-semibold text-stone-500">{t.agentItemContextCategory}:</span>{' '}{item.category_name || item.category_id}</p>
      ) : null}
      <p className="min-w-0 break-words"><span className="font-semibold text-stone-500">{t.agentItemContextLocation}:</span>{' '}{itemLocationLabel(item)}</p>
      {item.created_at ? <p><span className="font-semibold text-stone-500">{t.agentItemContextReported}:</span>{' '}{new Date(item.created_at).toLocaleDateString()}</p> : null}
    </div>
  );

  return (        <div className="space-y-8 fade-in">
          
          {/* Hub Profile Banner */}
          <div className="bg-primary-green text-white p-6 rounded-2xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div>
              <span className="bg-emerald-800 text-accent-orange border border-emerald-700 text-xs font-extrabold px-3 py-1 rounded-full uppercase tracking-wider inline-block mb-2">
                Verified Return4me Partner Point
              </span>
              <h1 className="text-2xl font-extrabold">{props.agentProfile.business_name}</h1>
              <p className="text-stone-300 text-xs mt-0.5">{props.agentProfile.location_address}</p>
            </div>
            <div className="bg-white/10 p-4 rounded-2xl border border-white/5 text-right font-mono">
              <span className="text-xs text-stone-300 block uppercase font-sans font-bold">Payout via {props.agentProfile.payout_method_type || "Till Number"}</span>
              <span className="text-lg font-extrabold text-accent-orange">{props.agentProfile.mpesa_till_or_paybill}</span>
            </div>
          </div>

          {/* Total Earnings Card — your commission share after each escrow release */}
          {props.agentEarnings && (
            <div className="bg-white border border-stone-100 rounded-2xl p-6 shadow-sm flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
              <div>
                <span className="text-stone-400 text-xs font-extrabold uppercase tracking-widest block">
                  {props.lang === 'en' ? 'Total Earned (your commission share)' : 'Jumla Uliyopata (sehemu yako ya kamisheni)'}
                </span>
                <span className="text-3xl font-black text-primary-green block mt-1">
                  KES {props.agentEarnings.totalEarned.toLocaleString()}
                </span>
              </div>
              <div className="bg-emerald-50 text-emerald-700 border border-emerald-100 rounded-2xl px-4 py-2 text-xs font-bold">
                {props.agentEarnings.completedPayoutsCount} {props.lang === 'en' ? 'completed handovers paid out' : 'kukabidhi zilizolipwa'}
              </div>
            </div>
          )}

          {props.actionSuccessMsg && (
            <div
              className="bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-3 rounded-2xl flex items-center space-x-2 text-sm font-semibold"
              role="status"
              aria-live="polite"
            >
              <CheckCircle size={18} className="shrink-0" aria-hidden={true} />
              <span>{props.actionSuccessMsg}</span>
            </div>
          )}

          {/* OPERATIONAL ERROR — PHASE 16.1 BATCH 3 (F-1 + A-1).
              This is the branch that was missing entirely. Four operator
              actions (reject drop-off, confirm viewing, confirm handover,
              camera start) and the drop-off code lookup used to write their
              failures to `authError`, which is rendered ONLY inside the
              signed-out card — so a signed-in agent saw the spinner stop and
              nothing else, with no way to learn that (for example) the owner's
              pickup code was wrong.

              `role="alert"` + `aria-live="assertive"` announce it immediately,
              and it sits in the same visual slot as the success message so both
              outcomes are unmistakable. Dismissible, because an agent retrying
              an action should not have to clear a stale failure first; it is
              also cleared automatically at the start of every operation. */}
          {props.operationError && (
            <div
              className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-2xl flex items-start space-x-2 text-sm font-semibold"
              role="alert"
              aria-live="assertive"
            >
              <AlertCircle size={18} className="shrink-0 mt-0.5" aria-hidden={true} />
              <span className="flex-1">{props.operationError}</span>
              <button
                type="button"
                onClick={() => props.setOperationError('')}
                aria-label={props.lang === 'en' ? 'Dismiss error' : 'Ondoa kosa'}
                className="shrink-0 text-red-700/70 hover:text-red-900 font-bold leading-none px-1"
              >
                ×
              </button>
            </div>
          )}

          {/* REFRESH FAILURE WHILE THE HUB IS ALREADY OPEN — F-5 / H-3.
              A re-fetch that fails after a successful load must not blank the
              Hub (the data in hand is still the last server truth) and must not
              claim a status change. It is reported here, in context. */}
          {props.queueError && (
            <div
              className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-2xl flex items-start space-x-2 text-sm font-semibold"
              role="alert"
              aria-live="assertive"
            >
              <AlertCircle size={18} className="shrink-0 mt-0.5" aria-hidden={true} />
              <span className="flex-1">
                {props.lang === 'en'
                  ? `Could not refresh: ${props.queueError}`
                  : `Imeshindwa kuonyesha upya: ${props.queueError}`}
              </span>
              <button
                type="button"
                onClick={props.retryQueue}
                aria-busy={props.queueLoading}
                className="shrink-0 underline font-bold"
              >
                {props.lang === 'en' ? 'Retry' : 'Jaribu tena'}
              </button>
            </div>
          )}

          {/* Quick Confirmation Actions */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            
            {/* Confirm finder dropoff */}
            <div className="bg-white rounded-2xl border border-stone-100 p-5 shadow-lg space-y-4">
              <div className="flex items-center space-x-2 text-primary-green">
                <ShieldCheck size={20} className="text-accent-orange" />
                <h3 className="font-extrabold text-sm uppercase tracking-wide">{t.confirmDropBtn}</h3>
              </div>
              <form onSubmit={props.handleLookupDropoff} className="flex gap-2">
                <input
                  type="text"
                  value={props.dropoffCodeInput}
                  onChange={(e) => props.setDropoffCodeInput(e.target.value)}
                  placeholder={t.enterDropCode}
                  aria-label={t.enterDropCode}
                  className="flex-1 border border-stone-200 rounded-xl px-3 py-2 text-xs font-mono focus:outline-none focus:border-accent-orange"
                  required
                />
                <button
                  type="submit"
                  disabled={props.actionProcessing}
                  aria-busy={props.actionProcessing}
                  className="bg-accent-strong hover:bg-accent-strong-hover text-white text-xs font-bold px-4 py-2 rounded-xl transition flex items-center justify-center space-x-1.5 disabled:opacity-50"
                >
                  {props.actionProcessing ? (
                    <Loader2 className="animate-spin" size={14} aria-hidden={true} />
                  ) : (
                    <span>{props.lang === 'en' ? 'Verify' : 'Thibitisha'}</span>
                  )}
                </button>
              </form>
            </div>

            {/* Hub rules note */}
            <div className="bg-emerald-50 border border-emerald-100 text-primary-green p-5 rounded-2xl text-xs space-y-1">
              <span className="font-bold block">Hub Handover Golden Rule:</span>
              <span>Always visually match the name on the owner national ID against the document name on the system before typing collection codes! Incorrect handovers result in permanent agent suspension.</span>
            </div>
          </div>

          {/* Processing Queues */}
          {/* PHASE 16.1 BATCH 4B-1 (B5 / B6) - the queue header now carries a
              manual refresh control and a VISIBLE refreshing state. `retryQueue`
              is the SAME callback the queueError branch above already uses, so
              no polling, no second fetch loop, no new endpoint and no change to
              the queue projection were introduced; `queueLoading` was already
              owned by AgentView and is now simply visible while the Hub is
              healthy, instead of being exposed only through the error branch.
              The status line is a single polite live region that exists only
              while a refresh is in flight, so it announces once per refresh
              rather than on every render; it never hides the queue contents, so
              the agent keeps reading the last server truth while fresh data
              loads. */}
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-xl font-extrabold text-primary-green">{t.agentQueue}</h2>
              <div className="flex items-center gap-3">
                {props.queueLoading && (
                  <span
                    role="status"
                    aria-live="polite"
                    className="flex items-center gap-1.5 text-xs font-semibold text-stone-500"
                  >
                    <Loader2 className="animate-spin" size={12} aria-hidden={true} />
                    <span>{t.agentQueueRefreshing}</span>
                  </span>
                )}
                <button
                  type="button"
                  onClick={props.retryQueue}
                  disabled={props.queueLoading}
                  aria-busy={props.queueLoading}
                  className="flex items-center gap-1.5 bg-white border border-stone-200 text-stone-600 hover:text-primary-green hover:border-primary-green text-xs font-bold px-3 py-1.5 rounded-xl transition disabled:opacity-50"
                >
                  <RefreshCw size={12} aria-hidden={true} />
                  <span>{t.agentQueueRefresh}</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              
              {/* Drop-offs Queue */}
              <div className="space-y-3">
                <h3 className="font-bold text-sm text-stone-500 uppercase tracking-widest">{t.expectedDropoffs} ({props.expectedDropoffs.length})</h3>
                {props.expectedDropoffs.length === 0 ? (
                  <div className="rounded-2xl border border-stone-200 bg-stone-50 p-6 text-center text-sm text-stone-500">
                    {t.agentDropoffsEmpty}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {props.expectedDropoffs.map((item) => (
                      <article key={item.id} className="overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm">
                        <div className="space-y-4 p-4 sm:p-5">
                          <div className="min-w-0">
                            <p className="font-mono text-sm font-extrabold text-primary-green break-all">{itemReference(item)}</p>
                            <h4 className="mt-1 break-words text-base font-extrabold text-stone-900">{itemHeading(item)}</h4>
                            <p className="mt-1 text-xs font-bold uppercase tracking-wide text-accent-orange">{t.agentDropoffQueueRole}</p>
                          </div>
                          <ItemMetadata item={item} />
                          <div className="border-t border-stone-100 pt-3">
                            <p className="mb-2 text-xs font-semibold text-stone-500">{t.agentWorkflowLabel}</p>
                            <p className="text-sm font-semibold text-stone-800">{t.agentDropoffWorkflow}</p>
                          </div>
                          {props.rejectingItemId !== item.id && props.verifyingItemId !== item.id && (
                            <div className="flex flex-wrap gap-2">
                              <Button onClick={() => props.openVerificationPanel(item)}>{t.agentReview}</Button>
                              <Button variant="danger" size="sm" onClick={() => {
                                props.setRejectingItemId(item.id);
                                props.setRejectionReason("Not a real item");
                                props.setRejectionCustomText("");
                              }}>{t.agentReject}</Button>
                            </div>
                          )}

                        {/* ITEM VERIFICATION — Original vs Verified. This is the
                            required review step before the item can be
                            physically approved; confirm-dropoff refuses to run
                            until it's completed (server-enforced). */}
                        {props.verifyingItemId === item.id && (
                          <div className="bg-brand-beige/60 p-4 rounded-xl border border-stone-200 space-y-3">
                            <h4 className="text-xs font-extrabold text-primary-green uppercase tracking-wide">
                              {props.lang === 'en' ? 'Item Verification' : 'Uthibitisho wa Bidhaa'}
                            </h4>

                            {/* PHASE 16.1 BATCH 3 (A-2) — programmatic label
                                association. This label had no `htmlFor` and the
                                select no `id`, so assistive technology announced
                                an unlabelled combobox. Static ids are safe: the
                                panel renders for at most ONE item at a time
                                (props.verifyingItemId === item.id), the same reasoning
                                the P14C-5B fix below already relies on. */}
                            <div className="space-y-1">
                              <label htmlFor="agent-verify-category" className="text-xs font-bold text-stone-500 uppercase block">Category</label>
                              <select
                                id="agent-verify-category"
                                value={props.verifyCategoryId}
                                onChange={(e) => props.setVerifyCategoryId(e.target.value)}
                                className="w-full border border-stone-200 rounded-lg p-2 text-xs bg-white"
                              >
                                {props.categories.map((c: any) => (
                                  <option key={c.id} value={c.id}>{props.lang === 'en' ? c.name_en : c.name_sw}</option>
                                ))}
                              </select>
                              {props.verifyCategoryId !== (item.category_id || '') && (
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
                                    value={props.verifyName}
                                    onChange={(e) => props.setVerifyName(e.target.value)}
                                    className="w-full border border-stone-200 rounded-lg p-2 text-xs"
                                  />
                                  {props.verifyName !== (item.ocr_extracted_name || '') && (
                                    <p className="text-xs text-stone-400">Finder: {item.ocr_extracted_name || '(none)'}</p>
                                  )}
                                </div>
                                <div className="space-y-1">
                                  <label htmlFor="agent-verify-doc-number" className="text-xs font-bold text-stone-500 uppercase block">Document number</label>
                                  <input
                                    id="agent-verify-doc-number"
                                    type="text"
                                    value={props.verifyDocNumber}
                                    onChange={(e) => props.setVerifyDocNumber(e.target.value)}
                                    className="w-full border border-stone-200 rounded-lg p-2 text-xs font-mono"
                                  />
                                  {props.verifyDocNumber !== (item.ocr_extracted_number || '') && (
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
                                value={props.verifyDescription}
                                onChange={(e) => props.setVerifyDescription(e.target.value)}
                                className="w-full border border-stone-200 rounded-lg p-2 text-xs"
                              />
                              {props.verifyDescription !== (item.description || '') && (
                                <p className="text-xs text-stone-400">Finder: {item.description || '(none)'}</p>
                              )}
                            </div>

                            {/* P14C-5B — this label had no `htmlFor` and the input
                                no `id`, so assistive technology saw an unlabelled
                                text box. The panel renders for at most ONE item at
                                a time (`props.verifyingItemId === item.id`), so a static
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
                                value={props.verifyFoundArea}
                                onChange={(e) => props.setVerifyFoundArea(e.target.value)}
                                className="w-full border border-stone-200 rounded-lg p-2 text-xs"
                                aria-describedby={
                                  props.verifyFoundArea !== (item.location_description || '')
                                    ? 'agent-verify-exact-place-finder-note'
                                    : undefined
                                }
                              />
                              {props.verifyFoundArea !== (item.location_description || '') && (
                                <p id="agent-verify-exact-place-finder-note" className="text-xs text-stone-400">Finder: {item.location_description}</p>
                              )}
                            </div>

                            {props.hasCorrections(item) && (
                              <div className="space-y-1">
                                {/* PHASE 16.1 BATCH 3 (A-2) — the select had no
                                    `htmlFor`/`id`, and the detail input below had
                                    NO LABEL AT ALL (only a placeholder, which is
                                    not an accessible name). Both are now properly
                                    associated. */}
                                <label htmlFor="agent-verify-reason" className="text-xs font-bold text-stone-500 uppercase block">Reason for correction</label>
                                <select
                                  id="agent-verify-reason"
                                  value={props.verifyReason}
                                  onChange={(e) => props.setVerifyReason(e.target.value)}
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
                                  value={props.verifyReasonDetail}
                                  onChange={(e) => props.setVerifyReasonDetail(e.target.value)}
                                  placeholder="Optional explanation..."
                                  className="w-full border border-stone-200 rounded-lg p-2 text-xs"
                                />
                              </div>
                            )}

                            <label className="flex items-center space-x-2 text-xs text-stone-700 font-semibold">
                              <input
                                type="checkbox"
                                checked={props.verifyPhysicallyChecked}
                                onChange={(e) => props.setVerifyPhysicallyChecked(e.target.checked)}
                              />
                              <span>{props.lang === 'en' ? 'I have physically inspected this item' : 'Nimekagua bidhaa hii kimwili'}</span>
                            </label>
                            {item.is_sensitive_document && (props.verifyName !== (item.ocr_extracted_name || '') || props.verifyDocNumber !== (item.ocr_extracted_number || '')) && !props.verifyPhysicallyChecked && (
                              <p className="text-xs text-red-600 font-semibold">
                                {props.lang === 'en' ? 'Correcting name/ID number on a sensitive document requires physical inspection — check the box above.' : 'Kurekebisha jina/nambari ya hati nyeti kunahitaji ukaguzi wa kimwili — weka alama kwenye kisanduku hapo juu.'}
                              </p>
                            )}

                            {props.verifyError && (
                              <p className="text-xs text-red-600 font-semibold">{props.verifyError}</p>
                            )}

                            <div className="flex flex-wrap gap-2 justify-end pt-1">
                              <button type="button" onClick={() => props.setVerifyingItemId(null)}
                                className="text-stone-500 hover:text-stone-700 text-xs px-3 py-1.5 rounded-lg"
                              >
                                Cancel
                              </button>
                              <button
                                disabled={isItemBusy(item.id)}
                                aria-busy={isItemBusy(item.id)}
                                onClick={() => props.handleSubmitVerification(item, props.hasCorrections(item) ? 'corrected' : 'confirmed')}
                                className="bg-primary-green hover:bg-primary-hover text-white text-xs font-bold px-4 py-1.5 rounded-xl transition disabled:opacity-50 flex items-center gap-1.5"
                              >
                                {isItemBusy(item.id) ? <Loader2 className="animate-spin" size={12} aria-hidden={true} /> : null}
                                {props.hasCorrections(item)
                                  ? (props.verifyPhysicallyChecked ? 'Save Corrections & Approve' : 'Save Corrections & Continue')
                                  : (props.verifyPhysicallyChecked ? 'Confirm As Reported & Approve' : 'Confirm As Reported')}
                              </button>
                            </div>
                          </div>
                        )}

                        {props.rejectingItemId === item.id && (
                          <div className="bg-red-50/50 p-3 rounded-xl border border-red-100/50 space-y-3">
                            <label htmlFor={`reject-reason-${item.id}`} className="text-xs font-bold text-red-800 block">Reject Drop-off Reason:</label>
                            <div className="space-y-2">
                              <select
                                id={`reject-reason-${item.id}`}
                                value={props.rejectionReason}
                                onChange={(e) => props.setRejectionReason(e.target.value)}
                                className="w-full border border-stone-200 rounded-lg p-2 text-xs bg-white focus:outline-none focus:border-red-500"
                              >
                                <option value="Not a real item">Not a real item</option>
                                <option value="Item doesn't match description">Item doesn't match description</option>
                                <option value="Suspected test/spam">Suspected test/spam</option>
                                <option value="Other">Other (Please specify)</option>
                              </select>

                              {props.rejectionReason === "Other" && (
                                <input
                                  type="text"
                                  value={props.rejectionCustomText}
                                  onChange={(e) => props.setRejectionCustomText(e.target.value)}
                                  placeholder="Enter custom rejection reason..."
                                  aria-label="Custom rejection reason"
                                  className="w-full border border-stone-200 rounded-lg p-2 text-xs focus:outline-none focus:border-red-500"
                                  required
                                />
                              )}
                            </div>

                            <div className="flex space-x-2 justify-end">
                              <button type="button" onClick={() => props.setRejectingItemId(null)}
                                className="text-stone-500 hover:text-stone-700 text-xs px-3 py-1 rounded-lg"
                              >
                                Cancel
                              </button>
                              <button type="button" onClick={() => props.handleRejectDropoff(item.id)}
                                disabled={isItemBusy(item.id) || (props.rejectionReason === "Other" && props.rejectionCustomText.trim() === "")}
                                aria-busy={isItemBusy(item.id)}
                                className="bg-red-600 text-white hover:bg-red-700 text-xs font-bold px-3 py-1 rounded-lg transition flex items-center justify-center space-x-1 disabled:opacity-50"
                              >
                                {isItemBusy(item.id) ? (
                                  <Loader2 className="animate-spin" size={12} aria-hidden={true} />
                                ) : (
                                  <span>Submit Rejection</span>
                                )}
                              </button>
                            </div>
                          </div>
                        )}
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </div>

              {/* Handover / Pickups Queue */}
              <div className="space-y-3">
                <h3 className="font-bold text-sm text-stone-500 uppercase tracking-widest">{t.holdingPickups} ({props.holdingPickups.length})</h3>
                {props.holdingPickups.length === 0 ? (
                  <div className="rounded-2xl border border-stone-200 bg-stone-50 p-6 text-center text-sm text-stone-500">
                    {t.agentHandoversEmpty}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {props.holdingPickups.map((item) => (
                      <article key={item.id} className="overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm">
                        <div className="space-y-4 p-4 sm:p-5">
                          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0">
                              <p className="break-all font-mono text-sm font-extrabold text-primary-green">{itemReference(item)}</p>
                              <h4 className="mt-1 break-words text-base font-extrabold text-stone-900">{itemHeading(item)}</h4>
                              <p className="mt-1 text-xs font-bold uppercase tracking-wide text-accent-orange">{t.agentHandoverQueueRole}</p>
                            </div>
                            <Badge variant={claimBadgeVariant(item)} className="self-start whitespace-normal text-left">
                              {agentClaimBadge(item.associatedClaim?.status, props.lang).label}
                            </Badge>
                          </div>
                          <ItemMetadata item={item} />

                        {/* PHASE 16.1 BATCH 4B-1 (B1) - HONEST pending_payment
                            PRESENTATION.
                            The queue projection CAN attach a claim in
                            `pending_payment`, but the Hub rendered nothing for
                            it beyond the badge: the agent was told a payment
                            exists and then given no explanation and no next
                            step. This states the two facts the agent actually
                            needs - the claim is waiting on the OWNER'S payment,
                            and the item therefore cannot be handed over yet.
                            It deliberately offers NO action: there is no agent
                            task here, the agent cannot take or confirm payment
                            manually, and the item may not be released. No
                            transition, no endpoint and no payment detail (no
                            amount, no reference, no phone) is exposed. */}
                        {item.associatedClaim?.status === 'pending_payment' && (
                          <p className="text-xs text-stone-500 font-medium text-left border-t border-stone-100 pt-3">
                            {t.agentPendingPaymentNote}
                          </p>
                        )}

                        {/* PHASE 16.1 BATCH 4B-1 (B2) - NO FALSE CLAIM-ABSENCE
                            CLAIM.
                            `associatedClaim` is absent BOTH when an item really
                            has no claim and when a claim exists in a status this
                            queue deliberately withholds, so the Hub must assert
                            neither. The badge above now reports only what the
                            queue actually sent ("No Claim Information"), and this
                            note adds the single fact that IS provable from the
                            projection: a claim the agent can act on is always
                            attached, so nothing shown here is actionable,
                            whatever the reason for the absence. It exposes no
                            withheld status and no claim detail. */}
                        {!item.associatedClaim && (
                          <p className="text-xs text-stone-500 font-medium text-left border-t border-stone-100 pt-3">
                            {t.agentNoClaimInfoNote}
                          </p>
                        )}

                        {/* PHASE 16.1 BATCH 3 (F-4) — TRUTHFUL INFORMATIONAL
                            STATE FOR A STATUS THE AGENT CANNOT ACT ON.
                            A disputed claim is neither payable nor handover-able;
                            a released one is finished. Both were previously
                            labelled "Awaiting Payment". Neither gets an invented
                            action — only an explanation, so the agent knows the
                            item must not leave the hub. */}
                        {(item.associatedClaim?.status === 'disputed' || item.associatedClaim?.status === 'released') && (
                          <p className="text-xs text-stone-500 font-medium text-left border-t border-stone-100 pt-3">
                            {item.associatedClaim.status === 'disputed'
                              ? (props.lang === 'en'
                                ? 'This claim is under dispute review. Do NOT release the item — Return4me will contact you.'
                                : 'Dai hili linakaguliwa kwa mzozo. USITOE bidhaa — Return4me itawasiliana nawe.')
                              : (props.lang === 'en'
                                ? 'This claim is complete — the payout settlement is handled by Return4me.'
                                : 'Dai hili limekamilika — malipo yanashughulikiwa na Return4me.')}
                          </p>
                        )}

                        {/* If claim is awaiting physical agent confirmation, show verification action button */}
                        {item.associatedClaim?.status === 'awaiting_agent_confirmation' && (
                          <div className="border-t border-stone-100 pt-3 space-y-2">
                            <p className="text-xs text-stone-500 font-medium text-left">
                              {props.lang === 'en' 
                                ? 'The owner must travel to your station and visually verify this item is theirs.' 
                                : 'Mwenye mali lazima afike kituoni kwako na athibitishe kwa macho kuwa bidhaa hii ni yake.'}
                            </p>

                            {/* What the claimant said before ever seeing this item — compare it
                                against what they say in person now. This is the agent's real
                                evidence for a non-document item; it was being collected but
                                never shown here before. */}
                                                        <ClaimVerificationEvidence
                              lang={props.lang}
                              answers={item.associatedClaim.security_answers}
                              identifyingDetails={item.associatedClaim.owner_identifying_details}
                            />

                            <button
                              type="button"
                              onClick={() => props.handleConfirmViewing(item.associatedClaim.id)}
                              disabled={isItemBusy(item.associatedClaim.id)}
                              aria-busy={isItemBusy(item.associatedClaim.id)}
                              className="w-full bg-amber-500 text-white text-xs font-extrabold px-3 py-2 rounded-lg hover:bg-amber-600 flex items-center justify-center space-x-1.5 disabled:opacity-50 transition cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2"
                            >
                              {isItemBusy(item.associatedClaim.id) ? (
                                <Loader2 className="animate-spin" size={12} aria-hidden={true} />
                              ) : (
                                <>
                                  <Eye size={14} />
                                  <span>{props.lang === 'en' ? 'Confirm Owner Viewed & Verified Item' : 'Thibitisha Mwenye Mali Ameiona & Kukagua'}</span>
                                </>
                              )}
                            </button>
                          </div>
                        )}

                        {/* If claim is ready, show collection actions.
                            PHASE 16.1 BATCH 3 (F-2) — the dead "Enter Handover
                            Code (CLM-…)" text box that used to sit beside this
                            button is GONE. Nothing ever read it: the handover
                            requires the OWNER'S secret pickup code, which is
                            collected in the pickup-code dialog this button
                            opens. Keeping the field implied a second, different
                            handover code existed. */}
                        {item.associatedClaim?.status === 'escrow_held' && (
                          <div className="border-t border-stone-100 pt-3 space-y-2">
                            <p className="text-xs text-stone-500 font-medium text-left">
                              {props.lang === 'en'
                                ? 'Payment is held. Ask the owner for their secret pickup code to complete the handover.'
                                : 'Malipo yameshikiliwa. Muulize mmiliki msimbo wake wa siri wa kuchukua ili kukamilisha kukabidhi.'}
                            </p>
                            <button
                              type="button"
                              onClick={() => props.handleConfirmHandover(item.associatedClaim.id)}
                              disabled={isItemBusy(item.associatedClaim.id)}
                              aria-busy={isItemBusy(item.associatedClaim.id)}
                              className="w-full bg-accent-orange text-white text-xs font-extrabold px-3 py-2 rounded-lg hover:bg-accent-hover flex items-center justify-center space-x-1.5 disabled:opacity-50 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-orange focus-visible:ring-offset-2"
                            >
                              {isItemBusy(item.associatedClaim.id) ? (
                                <Loader2 className="animate-spin" size={12} aria-hidden={true} />
                              ) : (
                                <span>{props.lang === 'en' ? 'Complete Handover' : 'Kamilisha Kukabidhi'}</span>
                              )}
                            </button>
                          </div>
                        )}
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </div>

            </div>
          </div>

        </div>
  );
}
