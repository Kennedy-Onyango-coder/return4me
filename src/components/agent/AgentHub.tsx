import React from 'react';
import ClaimVerificationEvidence from '../ClaimVerificationEvidence';
import { agentClaimBadge, getClaimStatusDisplay } from '../claimStatus';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import { ShieldCheck, CheckCircle, AlertCircle, Loader2, Eye, RefreshCw } from 'lucide-react';
import AgentVerificationPanel from './AgentVerificationPanel';
import AgentRejectionPanel from './AgentRejectionPanel';
// BATCH 1 (UX-02): focus-return target ids for the inline panels. Pure DOM
// helpers only; the Hub remains hook-free and presentation-only.
import { panelTriggerId } from './panelFocus';

/**
 * AGENTHUB STRUCTURAL EXTRACTION — BATCH A (typed domain prop contracts).
 *
 * These four interfaces are PURE PROP GROUPING. They document which workflow
 * owns which prop; they do NOT relocate state, change ownership, or alter any
 * setter/callback signature. Every value below still arrives from
 * `useAgentOperations` (or `App`, for `lang`/`t`/`categories`) exactly as
 * before, and AgentHub remains presentation-only (0 useState, 0 useEffect,
 * 0 fetch).
 */

/** Queue lifecycle: profile/earnings read model, both queues, lookup, retry. */
export interface AgentHubQueueProps {
  agentProfile: any | null;
  agentEarnings: any | null;
  expectedDropoffs: any[];
  holdingPickups: any[];
  queueError: string;
  queueLoading: boolean;
  retryQueue: () => void;
  dropoffCodeInput: string;
  setDropoffCodeInput: (v: string) => void;
  handleLookupDropoff: (e: React.FormEvent) => void;
}

/**
 * Item-verification form. `categories` lives here deliberately: its ONLY
 * consumer in this file is the verification category `<select>`, so it is a
 * verification concern rather than a generic configuration prop.
 */
export interface AgentHubVerificationProps {
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
  categories: any[];
}

/** Drop-off rejection panel: reason, `Other` custom text, submit, cancel. */
export interface AgentHubRejectionProps {
  rejectingItemId: string | null;
  setRejectingItemId: (id: string | null) => void;
  rejectionReason: string;
  setRejectionReason: (v: string) => void;
  rejectionCustomText: string;
  setRejectionCustomText: (v: string) => void;
  handleRejectDropoff: (dropoffCode: string) => void;
}

/**
 * Cross-cutting operational feedback and busy state. `actionProcessing` and
 * `processingItemId` drive the shared per-item busy predicate used by ALL three
 * workflows, and the viewing/handover handlers are the two handover-queue
 * events, so this group is intentionally cross-cutting rather than a strict
 * single-workflow domain.
 */
export interface AgentHubFeedbackProps {
  actionSuccessMsg: string;
  operationError: string;
  setOperationError: (m: string) => void;
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
  handleConfirmViewing: (claimId: string) => void;
  handleConfirmHandover: (claimId: string) => void;
}

/**
 * The composed AgentHub contract. It is exactly the union of the four domain
 * contracts plus the two application-level props App owns (`lang`, `t`).
 *
 * `refreshCategories` is intentionally ABSENT: it was passed in but never read
 * here. It remains an operational concern of `useAgentOperations`, which still
 * calls it when opening the verification panel.
 */
export interface AgentHubProps
  extends AgentHubQueueProps,
    AgentHubVerificationProps,
    AgentHubRejectionProps,
    AgentHubFeedbackProps {
  lang: 'en' | 'sw';
  t: any;
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
                // PROD BATCH 3 / P2-03: the retry action itself was the one real gap.
                // The error presentation was already correct (role="alert" +
                // aria-live="assertive", bilingual body and label), so no cosmetic
                // change was made there. But the control did not disable itself
                // while the refresh was in flight, so a rapid double-tap could fire
                // two queue reloads. `disabled` gives it the same double-submit
                // guard the shared Button applies via `loading`.
                disabled={props.queueLoading}
                className="shrink-0 underline font-bold disabled:opacity-50 disabled:cursor-not-allowed"
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
                              {/* BATCH 1 (UX-02): stable, PER-ITEM trigger ids are
                                  the focus-return targets for the panels these
                                  actions open. Keying by item id means focus can
                                  never be returned to a different card's button
                                  when several items are queued. Attribute order
                                  keeps the pre-existing Button literals intact.
                                  Behaviour of both actions is unchanged. */}
                              <Button onClick={() => props.openVerificationPanel(item)} id={panelTriggerId(item.id, 'verify')}>{t.agentReview}</Button>
                              {/* BATCH 2 (UX-04): Review and Reject stay in the
                                  same row and in the same order, and both keep
                                  their existing handler and per-item focus-return
                                  id, but the destructive action is no longer
                                  flush against the normal one. A vertical rule
                                  separates them from `sm` up; below `sm` the
                                  wrapper takes the full width and right-aligns,
                                  so the destructive action drops to its own line
                                  instead of crowding Review on a 320px screen. */}
                              <span className="flex w-full items-center justify-end sm:w-auto sm:border-l sm:border-stone-200 sm:pl-3">
                              <Button variant="danger" size="sm" id={panelTriggerId(item.id, 'reject')} onClick={() => {
                                props.setRejectingItemId(item.id);
                                props.setRejectionReason("Not a real item");
                                props.setRejectionCustomText("");
                              }}>{t.agentReject}</Button>
                              </span>
                            </div>
                          )}

                        {/* ITEM VERIFICATION — Original vs Verified. This is the
                            required review step before the item can be
                            physically approved; confirm-dropoff refuses to run
                            until it's completed (server-enforced). Batch B: the
                            panel body now lives in
                            components/agent/AgentVerificationPanel.tsx; the
                            render gate and every prop stay here. */}
                        {props.verifyingItemId === item.id && (
                          <AgentVerificationPanel
                            item={item}
                            lang={props.lang}
                            t={t}
                            categories={props.categories}
                            verifyCategoryId={props.verifyCategoryId}
                            setVerifyCategoryId={props.setVerifyCategoryId}
                            verifyName={props.verifyName}
                            setVerifyName={props.setVerifyName}
                            verifyDocNumber={props.verifyDocNumber}
                            setVerifyDocNumber={props.setVerifyDocNumber}
                            verifyDescription={props.verifyDescription}
                            setVerifyDescription={props.setVerifyDescription}
                            verifyFoundArea={props.verifyFoundArea}
                            setVerifyFoundArea={props.setVerifyFoundArea}
                            verifyPhysicallyChecked={props.verifyPhysicallyChecked}
                            setVerifyPhysicallyChecked={props.setVerifyPhysicallyChecked}
                            verifyReason={props.verifyReason}
                            setVerifyReason={props.setVerifyReason}
                            verifyReasonDetail={props.verifyReasonDetail}
                            setVerifyReasonDetail={props.setVerifyReasonDetail}
                            verifyError={props.verifyError}
                            setVerifyingItemId={props.setVerifyingItemId}
                            hasCorrections={props.hasCorrections}
                            handleSubmitVerification={props.handleSubmitVerification}
                            isItemBusy={isItemBusy}
                          />
                        )}

                        {/* Batch B: the rejection panel body now lives in
                            components/agent/AgentRejectionPanel.tsx; the render
                            gate and every prop stay here. */}
                        {props.rejectingItemId === item.id && (
                          <AgentRejectionPanel
                            item={item}
                            t={t}
                            rejectionReason={props.rejectionReason}
                            setRejectionReason={props.setRejectionReason}
                            rejectionCustomText={props.rejectionCustomText}
                            setRejectionCustomText={props.setRejectionCustomText}
                            setRejectingItemId={props.setRejectingItemId}
                            handleRejectDropoff={props.handleRejectDropoff}
                            isItemBusy={isItemBusy}
                          />
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

          {/* BATCH 3 (UX-07) — OPERATIONAL WORK LEADS THE PAGE.
              The profile banner and the earnings card are IDENTITY and
              COMPENSATION information: useful, but static, and unchanged by
              anything the agent does on this screen. They used to render first,
              so an agent landing on the Hub saw a business card and a KES
              figure before the actual work waiting for them.

              The two queues now come first, in their established workflow order
              — Receive (drop-offs) before Release (pickups/handover) — and the
              identity/earnings block follows them. This is a PRESENTATION-ONLY
              reordering of two existing blocks inside the same wrapper:

                * no section was added, removed, duplicated, or re-authored;
                * no data, calculation, or API input changed (the banner still
                  reads agentProfile.*, the card still reads agentEarnings.*);
                * Receive/Release order is untouched;
                * the transient success/operational-error/queue-error banners
                  stay at the very top, because those are the messages the agent
                  must see immediately, and they render only when set.

              Ownership is unchanged: this component is still hook-free
              presentation over values owned by useAgentOperations. */}
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

        </div>
  );
}
