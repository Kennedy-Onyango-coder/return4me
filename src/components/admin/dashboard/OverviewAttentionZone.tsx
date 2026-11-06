import React from 'react';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import Button from '../../ui/Button';
import Badge from '../../ui/Badge';
import StatCard from '../../ui/StatCard';
import { ICON_SIZE } from '../../ui';
import { formatKesAmount, formatMetricCount, isReportedNumber as isReported } from './adminOverviewMetrics';
import { classifySettlementQueue, settlementQueueBreakdownText } from './settlementQueueStates';

// =============================================================================
// STAGE 4B — THE OVERVIEW'S ATTENTION ZONE (Z1).
// =============================================================================
// WHAT THIS IS
//   The one panel an administrator reads first: the queues whose rows are waiting
//   on them right now. STAGE 4B moved this markup out of AdminView.tsx into one
//   contained component; AdminView still owns the dashboard fetch, the coalescing
//   and sequence-number guard, the stale/retry behaviour, the active-tab routing
//   and every permission check. This component receives the read-only payload and
//   a navigation callback through props, fetches nothing, writes nothing and
//   knows about no endpoint.
//
// WHAT CHANGED (and what deliberately did NOT)
//   * B1 (pending agent approvals), B3 (items flagged for review), B4 (open
//     disputes) and B5 (unresolved payouts) are the SAME cards, word for word and
//     class for class. B4 is the card that answers "open disputes": it reads the
//     server's `stats.disputesOpenCount` — never `disputes.length`, which counts
//     resolved disputes too — and it opens the `disputes` section, not `review`.
//   * B2 ("Settlements awaiting action") is CORRECTED (F-04). It used to count
//     `pendingSettlements.length`, i.e. every claim in `pending_settlement`
//     whatever its real state. It now shows the actionable figure and states the
//     classification behind it — see settlementQueueStates.ts for the precedence
//     and for why no server change was needed.
//   * The four DYNAMIC cards that rendered above this grid (A1 "Pending
//     Settlements", A2 "Open Disputes", A3 "Payment Strikes", A4 "Unresolved
//     Payouts") are gone. A1 duplicated B2 verbatim; A3 and A4 could never render
//     because `paymentStrikes` is not published by the dashboard and the agent DTO
//     exposes no `payoutStatus`; A2's corrected card IS B4, one card below. Every
//     figure an operator had is still on screen exactly once, and there is now no
//     second card whose count or destination could disagree with the first.
// =============================================================================

// ---------------------------------------------------------------------------
// B1 — THE OVERVIEW'S "NEEDS ATTENTION" QUEUE CARD.
//
// The Overview is opened to decide what to do next, so every queue it shows is
// three things in one card: the figure, what the figure counts in plain words,
// and the control that opens the section holding the rows behind it — a count
// must never be a dead end.
//
// PRESENTATION ONLY. The count arrives as display text, already formatted by
// the shared read-out module (adminOverviewMetrics), so this component never
// computes, formats or defaults a number: a figure the server did not report
// reaches it as the same em dash every other Overview card shows, and cannot
// be dressed up as a zero here.
// ---------------------------------------------------------------------------
interface OverviewQueueCardProps {
  label: string;
  /** Already-formatted display text — formatMetricCount(...).text, never a raw figure. */
  count: string;
  description: string;
  /** Opens the section whose rows this figure counts. */
  actionLabel: string;
  onOpen: () => void;
}

function OverviewQueueCard({ label, count, description, actionLabel, onOpen }: OverviewQueueCardProps) {
  return (
    <div className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-panel p-4 sm:p-5 shadow-raised flex flex-col gap-3">
      <div className="space-y-1 min-w-0">
        <p className="text-caption font-extrabold uppercase tracking-widest text-[var(--appearance-text-muted)]">{label}</p>
        <p className="text-section font-extrabold text-[var(--appearance-text-primary)] tabular-nums tracking-tight leading-tight">{count}</p>
        <p className="text-caption text-[var(--appearance-text-muted)] leading-snug">{description}</p>
      </div>
      <Button variant="ghost" size="sm" className="self-start" onClick={onOpen}>
        {actionLabel}
        <ArrowRight size={ICON_SIZE.metadata} aria-hidden="true" />
      </Button>
    </div>
  );
}

/** The sections this zone can open. Every one is a real `adminNavRegistry` id. */
export type OverviewAttentionSection = 'agents' | 'review' | 'disputes' | 'ledger' | 'payouts';

export interface OverviewAttentionZoneProps {
  /** The validated dashboard payload. Read-only: nothing here mutates it. */
  dashboardData: any;
  /** AdminView's active-tab setter — this component never routes on its own. */
  onOpenSection: (section: OverviewAttentionSection) => void;
}

export default function OverviewAttentionZone({
  dashboardData,
  onOpenSection,
}: OverviewAttentionZoneProps) {
  // F-04 — one classification per render, from the facts the payload already
  // carries (see settlementQueueStates.ts). It counts states; it approves,
  // initiates and reconciles nothing.
  const settlementQueue = classifySettlementQueue(dashboardData.pendingSettlements);

  return (
    <div className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-2xl p-4 sm:p-6 shadow-sm space-y-4">
      <div className="space-y-1">
        <h3 className="font-extrabold text-caption text-[var(--appearance-text-muted)] uppercase tracking-widest flex items-center gap-2">
          <AlertTriangle size={ICON_SIZE.ui} aria-hidden="true" />
          {'Needs attention'}
        </h3>
        <p className="text-body text-[var(--appearance-text-muted)]">
          {'Work waiting on an administrator right now. Each figure opens the section that holds the rows behind it.'}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 sm:gap-4">
        <OverviewQueueCard
          label={'Pending agent approvals'}
          count={formatMetricCount(dashboardData.stats.pendingAgentsCount).text}
          description={'Agent applications waiting for a decision.'}
          actionLabel={'Review agents'}
          onOpen={() => onOpenSection('agents')}
        />
        {/* F-04 — "Settlements awaiting action" counted every row in
            `pending_settlement` and therefore overstated the work: a claim whose
            review window is still open is not actionable, and a claim whose
            payout leg is already with the provider must never be offered for
            initiation again. The headline is now the actionable figure and the
            line under it states the classification — "3 ready now · 7 in window
            · 2 approved, not initiated (1 automatic, 1 by an administrator) ·
            1 payout activity recorded". The section it opens is unchanged, and
            the server still re-checks every condition on any real initiation
            request. */}
        <OverviewQueueCard
          label={'Settlements awaiting action'}
          count={formatMetricCount(settlementQueue.reported ? settlementQueue.counts.ready_now : undefined).text}
          description={settlementQueueBreakdownText(settlementQueue)}
          actionLabel={'Open settlements'}
          onOpen={() => onOpenSection('ledger')}
        />
        <OverviewQueueCard
          label={'Items flagged for review'}
          count={formatMetricCount(Array.isArray(dashboardData.items) ? dashboardData.items.filter((item: any) => item.flaggedForReview).length : undefined).text}
          description={'Listings with low-confidence or missing details waiting for a manual check.'}
          actionLabel={'Open review queue'}
          onOpen={() => onOpenSection('review')}
        />
        <OverviewQueueCard
          label={'Open disputes'}
          count={formatMetricCount(dashboardData.stats.disputesOpenCount).text}
          description={'Disputes with no recorded resolution yet.'}
          actionLabel={'Review disputes'}
          onOpen={() => onOpenSection('disputes')}
        />
        {/* The unresolved-payout figure lives here with the queues —
            it counts rows an administrator must reconcile. PROGRAMME 1
            promoted the rows behind it into their own section (Payout
            Integrity), so the figure now opens that section instead of
            expanding in place: the count is still never a dead end, and
            the rows now sit with the launch-policy verdict per hub, in
            the one place an operator works them. The rows are still
            read only when asked for — the section's own disclosure gates
            the single read of GET /api/admin/payout-reconciliation. */}
        <div className="space-y-2">
          <StatCard
            icon={AlertTriangle}
            label={'Unresolved Payouts'}
            value={formatMetricCount(dashboardData.stats?.unresolvedPayoutsCount).text}
            status={
              isReported(dashboardData.stats?.unresolvedPayoutsCount) && dashboardData.stats.unresolvedPayoutsCount > 0
                ? <Badge variant="warning">Needs provider check</Badge>
                : undefined
            }
            description={isReported(dashboardData.stats?.unresolvedPayoutsCount)
              ? (dashboardData.stats.unresolvedPayoutsCount > 0
                  ? (`${formatKesAmount(dashboardData.stats?.unresolvedPayoutsAmount).text} is neither confirmed paid nor safe to resend automatically. Verify each row with the provider before any manual action.`)
                  : ('No payout row is awaiting provider reconciliation.'))
              : ('Not reported by this server build — treat as unknown, not as zero.')}
          />
          {/* PROGRAMME 1 — the figure's own control. It opens the
              section that holds the rows, so the count an operator
              reads here always has somewhere to go. */}
          <Button
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={() => onOpenSection('payouts')}
          >
            {'Open payout integrity'}
          </Button>
        </div>
      </div>
    </div>
  );
}
