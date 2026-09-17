import React from 'react';
import { AlertCircle, ExternalLink, RefreshCw, Scale } from 'lucide-react';
import Badge from '../../ui/Badge';
import Banner from '../../ui/Banner';
import Button from '../../ui/Button';
import Skeleton from '../../ui/Skeleton';
import ClaimStatusBadge from './ClaimStatusBadge';
import ClaimPaymentState from './ClaimPaymentState';
import {
  formatTimestamp,
  presentBoolean,
  presentDisputeState,
  presentFinancialState,
  presentHistoricalClaim,
  presentPresence,
  presentRole,
  presentVerificationTier,
} from './claimsPresentation';
import type { AdminClaimDetailView } from '../../../services/adminClaimsApiTypes';

/**
 * Claim detail panel — a right-hand drawer rendering ONE claim's safe detail DTO.
 *
 * READ-ONLY. There is no action button here at all: no approve, reject, resolve,
 * refund, release-settlement, reassign or edit. Phase 6F deliberately exposes no
 * mutation of any kind on this surface, so none is drawn.
 *
 * PRIVACY. Only fields the DTO defines are rendered. Identity artifacts are shown
 * as presence flags ("Provided"/"Not provided") because the DTO carries booleans,
 * not values — there is no code path here that could display an ID-proof URL, a
 * signed evidence URL, an OTP, a session token or a payment reference.
 *
 * DISPUTE. Current state and the historical at-dispute snapshot are rendered in
 * two separate sections on purpose, and
 * `snapshot_incomplete` renders as "Unknown — historical snapshot unavailable"
 * (never "not paid").
 */
export default function ClaimDetailPanel({
  claimId,
  claim,
  loading,
  error,
  lang,
  onClose,
  onRetry,
  onOpenClaim,
}: {
  claimId: string | null;
  claim: AdminClaimDetailView | null;
  loading: boolean;
  error: string | null;
  lang: 'en' | 'sw';
  onClose: () => void;
  onRetry: () => void;
  onOpenClaim: (claimId: string) => void;
}) {
  if (!claimId) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="presentation">
      <div
        className="absolute inset-0 bg-stone-950/50"
        aria-hidden="true"
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="r4m-claim-detail-title"
        className="relative bg-brand-beige w-full sm:max-w-2xl h-full overflow-y-auto border-l border-brand-border"
      >
        <header className="sticky top-0 z-10 bg-white border-b border-brand-border px-5 py-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-extrabold uppercase tracking-widest text-brand-muted-text">
              {lang === 'sw' ? 'Maelezo ya claim' : 'Claim details'}
            </p>
            <h2 id="r4m-claim-detail-title" className="font-mono text-sm font-extrabold text-brand-dark-text break-all">
              {claimId}
            </h2>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label={lang === 'sw' ? 'Funga' : 'Close claim details'}>
            <ExternalLink size={14} aria-hidden="true" />
            {lang === 'sw' ? 'Funga' : 'Close'}
          </Button>
        </header>

        <div className="p-5 space-y-4">
          {loading && <DetailSkeleton />}

          {!loading && error && (
            <div className="space-y-3">
              <Banner kind="error">{error}</Banner>
              <Button variant="outline" size="sm" onClick={onRetry}>
                <RefreshCw size={14} aria-hidden="true" />
                {lang === 'sw' ? 'Jaribu tena' : 'Retry'}
              </Button>
            </div>
          )}

          {!loading && !error && claim && (
            <ClaimDetailBody claim={claim} lang={lang} onOpenClaim={onOpenClaim} />
          )}
        </div>
      </aside>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-3" aria-hidden="true">
      <Skeleton shape="card" />
      <Skeleton shape="card" />
      <Skeleton shape="rect" className="w-2/3" />
      <Skeleton shape="rect" className="w-1/2" />
    </div>
  );
}

/** A titled block. Keeps the hierarchy consistent across every section. */
function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white border border-brand-border rounded-2xl px-4 py-3">
      <h3 className="text-[11px] font-extrabold uppercase tracking-widest text-brand-muted-text mb-2">{title}</h3>
      <div className="space-y-1.5 text-sm text-brand-dark-text">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="text-xs text-brand-muted-text min-w-[9.5rem]">{label}</span>
      <span className="text-xs font-medium text-brand-dark-text flex-1 min-w-0 break-words">{children}</span>
    </div>
  );
}

function ClaimDetailBody({
  claim,
  lang,
  onOpenClaim,
}: {
  claim: AdminClaimDetailView;
  lang: 'en' | 'sw';
  onOpenClaim: (claimId: string) => void;
}) {
  const settlement = presentFinancialState(claim.settlement.state, lang);
  const siblingClaims = Array.isArray(claim.sibling_claims) ? claim.sibling_claims : [];

  return (
    <>
      <Panel title={lang === 'sw' ? 'Utambulisho wa claim' : 'Claim identity'}>
        <Field label={lang === 'sw' ? 'Hali ya sasa' : 'Current status'}>
          <ClaimStatusBadge status={claim.status} lang={lang} />
        </Field>
        <Field label={lang === 'sw' ? 'Inafanya kazi' : 'Active'}>
          {claim.is_active ? 'Yes' : lang === 'sw' ? 'Hapana (imefungwa)' : 'No (closed)'}
        </Field>
        <Field label={lang === 'sw' ? 'Imeundwa' : 'Created'}>{formatTimestamp(claim.created_at, lang)}</Field>
        <Field label={lang === 'sw' ? 'Imesasishwa' : 'Updated'}>{formatTimestamp(claim.updated_at, lang)}</Field>
        <Field label={lang === 'sw' ? 'Wakala alithibitisha' : 'Agent confirmed'}>
          {formatTimestamp(claim.agent_confirmed_at, lang)}
        </Field>
      </Panel>

      <Panel title={lang === 'sw' ? 'Mdai' : 'Claimant'}>
        <Field label={lang === 'sw' ? 'Simu (imefichwa)' : 'Phone (masked)'}>
          <span className="font-mono">{claim.claimant_phone || 'Not available'}</span>
        </Field>
        <Field label={lang === 'sw' ? 'Kiwango cha uthibitisho' : 'Verification tier'}>
          {presentVerificationTier(claim.verification.tier, lang)}
        </Field>
        <PresenceField
          label={lang === 'sw' ? 'Kitambulisho' : 'ID proof'}
          present={claim.verification.id_proof_present}
          lang={lang}
        />
        <PresenceField
          label={lang === 'sw' ? 'Maelezo binafsi' : 'Identifying detail'}
          present={claim.verification.identifying_detail_present}
          lang={lang}
        />
        <PresenceField
          label={lang === 'sw' ? 'Picha ya makabidhiano' : 'Handover photo'}
          present={claim.verification.handover_photo_present}
          lang={lang}
        />
      </Panel>

      <Panel title={lang === 'sw' ? 'Kitu' : 'Item'}>
        {claim.item ? (
          <>
            <Field label={lang === 'sw' ? 'Kitambulisho' : 'Item ID'}>
              <span className="font-mono">{claim.item.id}</span>
            </Field>
            <Field label={lang === 'sw' ? 'Kundi' : 'Category'}>
              {claim.item.category_name_en || claim.item.category_id}
            </Field>
            <Field label={lang === 'sw' ? 'Hali ya kitu' : 'Item status'}>{claim.item.status}</Field>
            <Field label={lang === 'sw' ? 'Maelezo' : 'Description'}>{claim.item.description || 'Not available'}</Field>
            <Field label={lang === 'sw' ? 'Mahali' : 'Location'}>
              {claim.item.location_description || 'Not available'}
            </Field>
            <Field label={lang === 'sw' ? 'Hati nyeti' : 'Sensitive document'}>
              {presentBoolean(claim.item.is_sensitive_document, lang)}
            </Field>
            <Field label={lang === 'sw' ? 'Inahitaji ukaguzi' : 'Flagged for review'}>
              {presentBoolean(claim.item.flagged_for_review, lang)}
            </Field>
          </>
        ) : (
          <p className="text-xs text-brand-muted-text">Not available</p>
        )}
      </Panel>

      <Panel title={lang === 'sw' ? 'Wakala' : 'Agent'}>
        {claim.agent ? (
          <>
            <Field label={lang === 'sw' ? 'Jina' : 'Business'}>{claim.agent.business_name}</Field>
            <Field label={lang === 'sw' ? 'Simu' : 'Contact phone'}>
              <span className="font-mono">{claim.agent.contact_phone || 'Not available'}</span>
            </Field>
          </>
        ) : (
          <p className="text-xs text-brand-muted-text">
            {lang === 'sw' ? 'Hakuna wakala aliyepangiwa.' : 'No agent assigned.'}
          </p>
        )}
      </Panel>

      <Panel title={lang === 'sw' ? 'Malipo' : 'Payment'}>
        <Field label={lang === 'sw' ? 'Hali ya malipo' : 'Payment'}>
          <ClaimPaymentState hasPaid={claim.has_paid} paidAt={claim.paid_at} lang={lang} showTimestamp={false} />
        </Field>
        <Field label={lang === 'sw' ? 'Muda wa malipo' : 'Paid at'}>{formatTimestamp(claim.paid_at, lang)}</Field>
        <Field label={lang === 'sw' ? 'Awamu ya kifedha' : 'Financial stage'}>
          <Badge variant={settlement.tone}>{settlement.label}</Badge>
        </Field>
        <Field label={lang === 'sw' ? 'Malipo yanatolewa' : 'Settlement release'}>
          {formatTimestamp(claim.settlement.settle_at, lang)}
        </Field>
        <p className="text-[11px] text-brand-muted-text pt-1">
          {lang === 'sw'
            ? 'Mfumo hauhifadhi salio la kifedha, kwa hivyo hakuna kiasi kinachoonyeshwa.'
            : 'This system keeps no monetary balance record, so no amount is shown.'}
        </p>
      </Panel>

      <DisputePanels claim={claim} lang={lang} />

      <RelatedClaimsPanel claim={claim} lang={lang} onOpenClaim={onOpenClaim} siblings={siblingClaims} />
    </>
  );
}

function PresenceField({ label, present, lang }: { label: string; present: boolean; lang: 'en' | 'sw' }) {
  const p = presentPresence(present, lang);
  return (
    <Field label={label}>
      <Badge variant={p.tone}>{p.label}</Badge>
    </Field>
  );
}


/**
 * Dispute presentation — CURRENT state and HISTORICAL snapshot in two clearly
 * separate panels. They are never merged into one status, because "under dispute
 * review now" and "this claimant was [x] when the dispute was filed" are
 * different facts and conflating them would be misleading.
 */
function DisputePanels({ claim, lang }: { claim: AdminClaimDetailView; lang: 'en' | 'sw' }) {
  const dispute = claim.dispute;
  if (!dispute) {
    return (
      <Panel title={lang === 'sw' ? 'Mzozo' : 'Dispute'}>
        <p className="text-xs text-brand-muted-text">
          {lang === 'sw' ? 'Claim hii haihusiani na mzozo.' : 'This claim is not part of a dispute.'}
        </p>
      </Panel>
    );
  }

  const state = presentDisputeState(dispute.state, lang);
  const thisHistorical = presentHistoricalClaim(
    { status_at_dispute: dispute.this_claim.status_at_dispute, paid_at_dispute: dispute.this_claim.paid_at_dispute },
    dispute.snapshot_incomplete,
    lang,
  );
  const otherHistorical = presentHistoricalClaim(
    { status_at_dispute: dispute.other_claim.status_at_dispute, paid_at_dispute: dispute.other_claim.paid_at_dispute },
    dispute.snapshot_incomplete,
    lang,
  );

  return (
    <>
      <Panel title={lang === 'sw' ? 'Mzozo — hali ya sasa' : 'Dispute — current state'}>
        <Field label={lang === 'sw' ? 'Hali' : 'State'}>
          <Badge variant={state.tone} icon={Scale}>
            {state.label}
          </Badge>
        </Field>
        <Field label={lang === 'sw' ? 'Nafasi ya claim hii' : 'This claim role'}>
          {presentRole(dispute.role, lang)}
        </Field>
        <Field label={lang === 'sw' ? 'Nafasi ya claim nyingine' : 'Other claim role'}>
          {presentRole(dispute.other_claim.role, lang)}
        </Field>
        <Field label={lang === 'sw' ? 'Imetatuliwa' : 'Resolved'}>
          {formatTimestamp(dispute.resolved_at, lang)}
        </Field>
        <Field label={lang === 'sw' ? 'Iliamuliwa na' : 'Resolved by'}>
          {dispute.resolved_by || 'Not available'}
        </Field>
        <Field label={lang === 'sw' ? 'Claim iliyoshinda' : 'Winning claim'}>
          {dispute.resolved_claim_id ? (
            <span className="font-mono">{dispute.resolved_claim_id}</span>
          ) : (
            'Not available'
          )}
        </Field>
      </Panel>

      <Panel title={lang === 'sw' ? 'Mzozo — hali wakati ulipoanzishwa' : 'Dispute — state when filed'}>
        {thisHistorical.unknown && (
          <p className="flex items-start gap-1.5 text-[11px] text-brand-muted-text pb-1">
            <AlertCircle size={13} aria-hidden="true" className="mt-0.5 shrink-0" />
            {lang === 'sw'
              ? 'Mzozo huu ulianzishwa kabla ya rekodi za kihistoria, kwa hivyo hali halisi haijulikani — haimaanishi kuwa haikulipwa.'
              : 'This dispute predates the historical snapshot, so the state at filing is genuinely unknown — it does not mean unpaid.'}
          </p>
        )}
        <p className="text-[11px] font-bold text-brand-dark-text pt-1">
          {lang === 'sw' ? 'Claim hii' : 'This claim'}
        </p>
        <Field label={lang === 'sw' ? 'Hali wakati huo' : 'Status at dispute'}>{thisHistorical.status}</Field>
        <Field label={lang === 'sw' ? 'Malipo wakati huo' : 'Payment at dispute'}>{thisHistorical.payment}</Field>
        <p className="text-[11px] font-bold text-brand-dark-text pt-2">
          {lang === 'sw' ? 'Claim ya upande wa pili' : 'Other claim'}
        </p>
        <Field label={lang === 'sw' ? 'Hali wakati huo' : 'Status at dispute'}>{otherHistorical.status}</Field>
        <Field label={lang === 'sw' ? 'Malipo wakati huo' : 'Payment at dispute'}>{otherHistorical.payment}</Field>
      </Panel>
    </>
  );
}


/**
 * Related claims. Each sibling is display-only plus a link that re-fetches that
 * claim's detail through the SAME 6E endpoint — a sibling is never embedded as a
 * second raw claim object, and no sibling is labelled winner/paid/fraudulent:
 * only the server's own fields are shown.
 */
function RelatedClaimsPanel({
  claim,
  lang,
  onOpenClaim,
  siblings,
}: {
  claim: AdminClaimDetailView;
  lang: 'en' | 'sw';
  onOpenClaim: (claimId: string) => void;
  siblings: AdminClaimDetailView['sibling_claims'];
}) {
  const disputeOther = claim.dispute?.other_claim ?? null;
  if (siblings.length === 0 && !disputeOther?.claim_id) return null;

  return (
    <Panel title={lang === 'sw' ? 'Claims zinazohusiana' : 'Related claims'}>
      {disputeOther?.claim_id && (
        <div className="pb-2">
          <p className="text-[11px] text-brand-muted-text mb-1">
            {lang === 'sw' ? 'Upande wa pili wa mzozo' : 'Other side of the dispute'}
          </p>
          <SiblingRow id={disputeOther.claim_id} onOpenClaim={onOpenClaim} lang={lang} />
        </div>
      )}
      {siblings.length > 0 && (
        <ul className="divide-y divide-brand-border">
          {siblings.map((sib) => (
            <li key={sib.id} className="py-2">
              <SiblingRow id={sib.id} onOpenClaim={onOpenClaim} lang={lang} />
              <span className="flex flex-wrap items-center gap-2 mt-1 pl-0.5">
                <ClaimStatusBadge status={sib.status} lang={lang} />
                <ClaimPaymentState hasPaid={sib.has_paid} paidAt={sib.paid_at} lang={lang} showTimestamp={false} />
                <span className="font-mono text-[11px] text-brand-muted-text">
                  {sib.claimant_phone || 'Not available'}
                </span>
                <span className="text-[11px] text-brand-muted-text">{formatTimestamp(sib.created_at, lang)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-brand-muted-text pt-1">
        {lang === 'sw'
          ? 'Hakuna claim inayochukuliwa kama mshindi au mlaghai hapa — data inaonyeshwa kama ilivyo.'
          : 'No claim is assumed to be a winner or fraudulent here — only server state is shown.'}
      </p>
    </Panel>
  );
}

function SiblingRow({
  id,
  onOpenClaim,
  lang,
}: {
  id: string | null;
  onOpenClaim: (claimId: string) => void;
  lang: 'en' | 'sw';
}) {
  if (!id) return <span className="text-xs text-brand-muted-text">Not available</span>;
  return (
    <button
      type="button"
      onClick={() => onOpenClaim(id)}
      aria-label={lang === 'sw' ? `Fungua claim ${id}` : `Open claim ${id}`}
      className="font-mono text-xs font-bold text-primary-green underline decoration-dotted underline-offset-4 rounded-md focus-visible:outline-2 focus-visible:outline-accent-orange"
    >
      {id}
    </button>
  );
}
