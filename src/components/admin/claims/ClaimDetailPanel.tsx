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
  onClose,
  onRetry,
  onOpenClaim,
}: {
  claimId: string | null;
  claim: AdminClaimDetailView | null;
  loading: boolean;
  error: string | null;
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
            <p className="text-caption font-extrabold uppercase tracking-widest text-brand-muted-text">
              {'Claim details'}
            </p>
            <h2 id="r4m-claim-detail-title" className="font-mono text-sm font-extrabold text-brand-dark-text break-all">
              {claimId}
            </h2>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label={'Close claim details'}>
            <ExternalLink size={14} aria-hidden="true" />
            {'Close'}
          </Button>
        </header>

        <div className="p-5 space-y-4">
          {loading && <DetailSkeleton />}

          {!loading && error && (
            <div className="space-y-3">
              <Banner kind="error">{error}</Banner>
              <Button variant="outline" size="sm" onClick={onRetry}>
                <RefreshCw size={14} aria-hidden="true" />
                {'Retry'}
              </Button>
            </div>
          )}

          {!loading && !error && claim && (
            <ClaimDetailBody claim={claim} onOpenClaim={onOpenClaim} />
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
      <h3 className="text-caption font-extrabold uppercase tracking-widest text-brand-muted-text mb-2">{title}</h3>
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
  onOpenClaim,
}: {
  claim: AdminClaimDetailView;
  onOpenClaim: (claimId: string) => void;
}) {
  const settlement = presentFinancialState(claim.settlement.state);
  const siblingClaims = Array.isArray(claim.sibling_claims) ? claim.sibling_claims : [];

  return (
    <>
      <Panel title={'Claim identity'}>
        <Field label={'Current status'}>
          <ClaimStatusBadge status={claim.status} />
        </Field>
        <Field label={'Active'}>
          {claim.is_active ? 'Yes' : 'No (closed)'}
        </Field>
        <Field label={'Created'}>{formatTimestamp(claim.created_at)}</Field>
        <Field label={'Updated'}>{formatTimestamp(claim.updated_at)}</Field>
        <Field label={'Agent confirmed'}>
          {formatTimestamp(claim.agent_confirmed_at)}
        </Field>
      </Panel>

      <Panel title={'Claimant'}>
        <Field label={'Phone (masked)'}>
          <span className="font-mono">{claim.claimant_phone || 'Not available'}</span>
        </Field>
        <Field label={'Verification tier'}>
          {presentVerificationTier(claim.verification.tier)}
        </Field>
        <PresenceField
          label={'ID proof'}
          present={claim.verification.id_proof_present}
        />
        <PresenceField
          label={'Identifying detail'}
          present={claim.verification.identifying_detail_present}
        />
        <PresenceField
          label={'Handover photo'}
          present={claim.verification.handover_photo_present}
        />
      </Panel>

      <Panel title={'Item'}>
        {claim.item ? (
          <>
            <Field label={'Item ID'}>
              <span className="font-mono">{claim.item.id}</span>
            </Field>
            <Field label={'Category'}>
              {claim.item.category_name_en || claim.item.category_id}
            </Field>
            <Field label={'Item status'}>{claim.item.status}</Field>
            <Field label={'Description'}>{claim.item.description || 'Not available'}</Field>
            <Field label={'Location'}>
              {claim.item.location_description || 'Not available'}
            </Field>
            <Field label={'Sensitive document'}>
              {presentBoolean(claim.item.is_sensitive_document)}
            </Field>
            <Field label={'Flagged for review'}>
              {presentBoolean(claim.item.flagged_for_review)}
            </Field>
          </>
        ) : (
          <p className="text-xs text-brand-muted-text">Not available</p>
        )}
      </Panel>

      <Panel title={'Agent'}>
        {claim.agent ? (
          <>
            <Field label={'Business'}>{claim.agent.business_name}</Field>
            <Field label={'Contact phone'}>
              <span className="font-mono">{claim.agent.contact_phone || 'Not available'}</span>
            </Field>
          </>
        ) : (
          <p className="text-xs text-brand-muted-text">
            {'No agent assigned.'}
          </p>
        )}
      </Panel>

      <Panel title={'Payment'}>
        <Field label={'Payment'}>
          <ClaimPaymentState hasPaid={claim.has_paid} paidAt={claim.paid_at} showTimestamp={false} />
        </Field>
        <Field label={'Paid at'}>{formatTimestamp(claim.paid_at)}</Field>
        <Field label={'Financial stage'}>
          <Badge variant={settlement.tone}>{settlement.label}</Badge>
        </Field>
        <Field label={'Settlement release'}>
          {formatTimestamp(claim.settlement.settle_at)}
        </Field>
        <p className="text-caption text-brand-muted-text pt-1">
          {'This system keeps no monetary balance record, so no amount is shown.'}
        </p>
      </Panel>

      <DisputePanels claim={claim} />

      <RelatedClaimsPanel claim={claim} onOpenClaim={onOpenClaim} siblings={siblingClaims} />
    </>
  );
}

function PresenceField({ label, present }: { label: string; present: boolean;  }) {
  const p = presentPresence(present);
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
function DisputePanels({ claim }: { claim: AdminClaimDetailView;  }) {
  const dispute = claim.dispute;
  if (!dispute) {
    return (
      <Panel title={'Dispute'}>
        <p className="text-xs text-brand-muted-text">
          {'This claim is not part of a dispute.'}
        </p>
      </Panel>
    );
  }

  const state = presentDisputeState(dispute.state);
  const thisHistorical = presentHistoricalClaim(
    { status_at_dispute: dispute.this_claim.status_at_dispute, paid_at_dispute: dispute.this_claim.paid_at_dispute },
    dispute.snapshot_incomplete,
  );
  const otherHistorical = presentHistoricalClaim(
    { status_at_dispute: dispute.other_claim.status_at_dispute, paid_at_dispute: dispute.other_claim.paid_at_dispute },
    dispute.snapshot_incomplete,
  );

  return (
    <>
      <Panel title={'Dispute — current state'}>
        <Field label={'State'}>
          <Badge variant={state.tone} icon={Scale}>
            {state.label}
          </Badge>
        </Field>
        <Field label={'This claim role'}>
          {presentRole(dispute.role)}
        </Field>
        <Field label={'Other claim role'}>
          {presentRole(dispute.other_claim.role)}
        </Field>
        <Field label={'Resolved'}>
          {formatTimestamp(dispute.resolved_at)}
        </Field>
        <Field label={'Resolved by'}>
          {dispute.resolved_by || 'Not available'}
        </Field>
        <Field label={'Winning claim'}>
          {dispute.resolved_claim_id ? (
            <span className="font-mono">{dispute.resolved_claim_id}</span>
          ) : (
            'Not available'
          )}
        </Field>
      </Panel>

      <Panel title={'Dispute — state when filed'}>
        {thisHistorical.unknown && (
          <p className="flex items-start gap-1.5 text-caption text-brand-muted-text pb-1">
            <AlertCircle size={13} aria-hidden="true" className="mt-0.5 shrink-0" />
            {'This dispute predates the historical snapshot, so the state at filing is genuinely unknown — it does not mean unpaid.'}
          </p>
        )}
        <p className="text-caption font-bold text-brand-dark-text pt-1">
          {'This claim'}
        </p>
        <Field label={'Status at dispute'}>{thisHistorical.status}</Field>
        <Field label={'Payment at dispute'}>{thisHistorical.payment}</Field>
        <p className="text-caption font-bold text-brand-dark-text pt-2">
          {'Other claim'}
        </p>
        <Field label={'Status at dispute'}>{otherHistorical.status}</Field>
        <Field label={'Payment at dispute'}>{otherHistorical.payment}</Field>
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
  onOpenClaim,
  siblings,
}: {
  claim: AdminClaimDetailView;
  onOpenClaim: (claimId: string) => void;
  siblings: AdminClaimDetailView['sibling_claims'];
}) {
  const disputeOther = claim.dispute?.other_claim ?? null;
  if (siblings.length === 0 && !disputeOther?.claim_id) return null;

  return (
    <Panel title={'Related claims'}>
      {disputeOther?.claim_id && (
        <div className="pb-2">
          <p className="text-caption text-brand-muted-text mb-1">
            {'Other side of the dispute'}
          </p>
          <SiblingRow id={disputeOther.claim_id} onOpenClaim={onOpenClaim} />
        </div>
      )}
      {siblings.length > 0 && (
        <ul className="divide-y divide-brand-border">
          {siblings.map((sib) => (
            <li key={sib.id} className="py-2">
              <SiblingRow id={sib.id} onOpenClaim={onOpenClaim} />
              <span className="flex flex-wrap items-center gap-2 mt-1 pl-0.5">
                <ClaimStatusBadge status={sib.status} />
                <ClaimPaymentState hasPaid={sib.has_paid} paidAt={sib.paid_at} showTimestamp={false} />
                <span className="font-mono text-caption text-brand-muted-text">
                  {sib.claimant_phone || 'Not available'}
                </span>
                <span className="text-caption text-brand-muted-text">{formatTimestamp(sib.created_at)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-caption text-brand-muted-text pt-1">
        {'No claim is assumed to be a winner or fraudulent here — only server state is shown.'}
      </p>
    </Panel>
  );
}

function SiblingRow({
  id,
  onOpenClaim,
}: {
  id: string | null;
  onOpenClaim: (claimId: string) => void;
}) {
  if (!id) return <span className="text-xs text-brand-muted-text">Not available</span>;
  return (
    <button
      type="button"
      onClick={() => onOpenClaim(id)}
      aria-label={`Open claim ${id}`}
      className="font-mono text-xs font-bold text-primary-green underline decoration-dotted underline-offset-4 rounded-md focus-visible:outline-2 focus-visible:outline-accent-orange"
    >
      {id}
    </button>
  );
}
