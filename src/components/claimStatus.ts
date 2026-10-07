// Shared claim-status vocabulary.
//
// Single source of truth for how a claim status is presented to a HUMAN in the
// Return4me UI. Previously this map lived privately inside OwnerView.tsx, which
// meant any second surface showing claim status (now: the customer dashboard)
// would either duplicate it or drift from it — and it was missing two real,
// owner-reachable statuses entirely (`pending_settlement`, `releasing`), so
// those fell through to a raw snake_case token shown to the customer.
//
// Every value in the database's claims_status_check constraint
// (sql/schema.sql, src/db/schema.ts, and the runtime DDL in src/db/index.ts)
// must have an entry here. `CLAIM_STATUS_VALUES` below is that list, so a test
// can assert coverage mechanically rather than by eyeballing.

export type ClaimStatusBadgeVariant =
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'neutral'
  | 'code';

export interface ClaimStatusDisplay {
  label: string;
  /** Tailwind classes for the pre-existing badge rendering in OwnerView. */
  className: string;
  /** Semantic variant for the shared <Badge> primitive (ui/Badge.tsx). */
  variant: ClaimStatusBadgeVariant;
}

// The canonical status list lives in src/config/claimStatuses.ts so the
// backend can import the same vocabulary without pulling in a component-layer
// module. Re-exported here so UI code has one import site.
export { CLAIM_STATUS_VALUES } from '../config/claimStatuses';

type StatusEntry = { en: string; className: string; variant: ClaimStatusBadgeVariant };

const CLAIM_STATUS_MAP: Record<string, StatusEntry> = {
  pending_verification: { en: 'Pending Verification', className: 'bg-amber-100 text-amber-800', variant: 'warning' },
  awaiting_agent_confirmation: { en: 'Awaiting Agent Confirmation', className: 'bg-amber-100 text-amber-800', variant: 'warning' },
  pending_payment: { en: 'Payment Pending', className: 'bg-amber-100 text-amber-800', variant: 'warning' },
  payment_window_expired: { en: 'Payment Window Expired', className: 'bg-red-100 text-red-800', variant: 'danger' },
  escrow_held: { en: 'Payment Confirmed', className: 'bg-emerald-100 text-emerald-800', variant: 'success' },
  // Handover is physically complete and the payout split is booked, but the
  // real disbursement waits out the dispute window (settle_at). Sits directly
  // after escrow_held in the lifecycle, so it reads as a success-family state
  // rather than an amber "action required" one — nothing is required of the
  // customer here.
  pending_settlement: { en: 'Awaiting Payout Release', className: 'bg-emerald-100 text-emerald-800', variant: 'success' },
  // Brief in-flight window while the disbursement is actually being sent.
  releasing: { en: 'Payout In Progress', className: 'bg-emerald-100 text-emerald-800', variant: 'success' },
  released: { en: 'Item Collected', className: 'bg-emerald-100 text-emerald-800', variant: 'success' },
  disputed: { en: 'Under Dispute Review', className: 'bg-orange-100 text-orange-800', variant: 'warning' },
  rejected: { en: 'Claim Rejected', className: 'bg-red-100 text-red-800', variant: 'danger' },
  refunding: { en: 'Refund In Progress', className: 'bg-amber-100 text-amber-800', variant: 'warning' },
  refunded: { en: 'Refunded to M-Pesa', className: 'bg-sky-100 text-sky-800', variant: 'info' },
};

/**
 * Maps a claim status to a human-readable English label plus styling.
 *
 * The fallback is deliberately last-resort only: every value the database can
 * actually store is mapped above, so a customer should never see a raw token.
 * The raw value is retained in the fallback purely so an unexpected/legacy
 * status stays diagnosable rather than silently rendering as blank.
 */
export function getClaimStatusDisplay(status: string): ClaimStatusDisplay {
  const entry = CLAIM_STATUS_MAP[status];
  if (!entry) {
    return { label: status, className: 'bg-stone-100 text-stone-800', variant: 'neutral' };
  }
  return {
    label: entry.en,
    className: entry.className,
    variant: entry.variant,
  };
}

/**
 * PHASE 16.1 BATCH 4 — AGENT-SIDE CLAIM BADGE (neutral home).
 *
 * Moved here from components/AgentView.tsx so both AgentView and the
 * extracted components/agent/AgentHub.tsx can consume it WITHOUT a
 * reverse dependency (AgentHub -> AgentView). Batch 3 (F-4) semantics
 * preserved verbatim: two agent-actionable statuses keep agent-specific
 * wording; everything else delegates to the shared map above.
 */
export function agentClaimBadge(
  status: string | null | undefined
): { label: string; className: string } {
  if (status === 'awaiting_agent_confirmation') {
    return {
      label: 'Awaiting Verification',
      className: 'bg-amber-100 text-amber-800 animate-pulse',
    };
  }
  if (status === 'escrow_held') {
    return {
      label: 'Escrow Held (Ready)',
      className: 'bg-emerald-100 text-emerald-800',
    };
  }
  // PHASE 16.1 BATCH 4B-1 (B2) — HONEST "NO CLAIM DATA" FALLBACK.
  //
  // This branch is reached whenever an item arrives with no `associatedClaim`
  // at all. "No Claim Yet" ASSERTED an absence the client cannot establish:
  // GET /api/agents/queue attaches `associatedClaim` only for five statuses
  // (escrow_held, released, disputed, awaiting_agent_confirmation,
  // pending_payment), so an absent claim means EITHER that no claim exists OR
  // that one exists in a status the agent queue deliberately withholds
  // (e.g. pending_verification, payment_window_expired, rejected, refunded).
  // The wording below is true in both cases: it reports what the agent's own
  // queue sent, and asserts nothing about a claim it cannot see. It also stays
  // inside the `neutral` family, so it never reads as a payment claim.
  if (!status) {
    return {
      label: 'No Claim Information',
      className: 'bg-stone-100 text-stone-800',
    };
  }
  const shared = getClaimStatusDisplay(status);
  return { label: shared.label, className: shared.className };
}
