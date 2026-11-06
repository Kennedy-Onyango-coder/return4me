import React from 'react';
import { Package, Users, Coins, Banknote, ShieldCheck, ClipboardList, RefreshCw } from 'lucide-react';
import StatCard from '../../ui/StatCard';
import { ICON_SIZE } from '../../ui';
import { formatKesAmount, formatMetricCount, isReportedNumber as isReported } from './adminOverviewMetrics';

// =============================================================================
// STAGE 4B — THE OVERVIEW'S MONEY ZONE (Z2).
// =============================================================================
// Two blocks that must never be conflated, kept as two blocks:
//
//   * the HEADLINE METRIC GRID — terminal-state figures. "Escrow Funds Held" is
//     the SUM of the locked fees of claims still in `escrow_held` (money), and
//     "Claims in Escrow" is the COUNT of those claims (rows). The two are
//     deliberately separate cards with separate labels; adminEscrowMetric.test.ts
//     pins that a count is never rendered under a money label.
//   * "MONEY IN FLIGHT" — money attached to a claim that has already moved on.
//     Each state is its own labelled fact and they are deliberately NOT summed
//     into an "available funds" number: no provider or accounting model in this
//     codebase supports one, so such a figure would be invented rather than
//     computed. (The KES 422 wallet balance is not available payout funds either,
//     and never appears here.)
//
// STAGE 4B moved this markup out of AdminView.tsx UNCHANGED — same labels, same
// classes, same sources, same em dash for "this build did not report it". The
// component fetches nothing, writes nothing and derives nothing; the money rules
// live in adminOverviewMetrics.ts and the aggregation lives on the server.
// =============================================================================

export interface OverviewMoneyZoneProps {
  /** The validated dashboard payload. Read-only: nothing here mutates it. */
  dashboardData: any;
  /** The translated "Total Revenue" label AdminView already resolves. */
  totalRevenueLabel: string;
  /**
   * The Overview's one money formatter (`inFlightAmountLabel` in AdminView), passed
   * in rather than re-implemented so every money figure on this screen keeps
   * reaching the SAME read-out rule.
   */
  amountLabel: (value: unknown) => string;
}

export default function OverviewMoneyZone({
  dashboardData,
  totalRevenueLabel,
  amountLabel,
}: OverviewMoneyZoneProps) {
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3 sm:gap-4">
        <StatCard
          icon={Package}
          label={'Active Holding Items'}
          value={formatMetricCount(dashboardData.stats.itemsAtAgentCount).text}
          description={'Items physically held at an agent, awaiting the claimant’s collection.'}
        />
        <StatCard
          icon={Users}
          label={'Pending Agents'}
          value={formatMetricCount(dashboardData.stats.pendingAgentsCount).text}
          description={'Agent applications still awaiting approval.'}
        />
        {/* PHASE 10 (F-2): this card previously rendered
            `stats.escrowHeldCount` — a COUNT of claims — under the label
            "Escrow Funds Held", immediately to the left of a genuine
            `KES {totalRevenue}` card, so the figure read as money. It now
            shows the authoritative monetary total (SUM of the
            escrow-held claims' locked_total_fee, computed server-side),
            and the count has its own card under a label that says what it
            is. The misleading presentation is gone from both the value
            and the label. */}
        {/* These two cards are deliberately NOT <StatCard>: their exact
            rendered label/value markup is pinned by adminEscrowMetric.test.ts
            (the financial-truthfulness guard that stops a claim COUNT
            being shown as money). They are styled to the same visual
            language as StatCard so the grid still reads as one set. */}
        <div className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-2xl p-4 sm:p-5 shadow-sm">
          <span className="block text-caption font-extrabold uppercase tracking-widest text-[var(--appearance-text-muted)]">Escrow Funds Held</span>
          <span className="block mt-1 text-section font-extrabold text-[var(--appearance-primary)] tabular-nums tracking-tight leading-tight">{formatKesAmount(dashboardData.stats.escrowHeldAmount).text}</span>
        </div>
        <div className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-2xl p-4 sm:p-5 shadow-sm">
          <span className="block text-caption font-extrabold uppercase tracking-widest text-[var(--appearance-text-muted)]">Claims in Escrow</span>
          <span className="block mt-1 text-section font-extrabold text-[var(--appearance-primary)] tabular-nums tracking-tight leading-tight">{formatMetricCount(dashboardData.stats.escrowHeldCount).text}</span>
        </div>
        <StatCard
          icon={Coins}
          label={totalRevenueLabel}
          value={formatKesAmount(dashboardData.stats.totalRevenue).text}
          description={'Platform-fee ledger entries already marked completed — confirmed money, not the in-flight figures below.'}
        />
        {/* PROGRAMME 1 / WS2 — hubs the launch policy would refuse at
            settlement time. Read through the same read-out module as
            every other Overview figure, so a build that does not report
            it shows the em dash rather than a reassuring 0. This figure
            counts hubs; this build provides NO control that corrects a
            stored destination or method, and the verdict per hub is
            stated in Payout Integrity. */}
        <StatCard
          icon={Banknote}
          label={'Hubs That Cannot Be Paid'}
          value={formatMetricCount(dashboardData.stats?.payoutIneligibleAgentsCount).text}
          description={'Registered hubs whose stored payout destination or method the launch policy refuses at settlement time. Open Payout Integrity for the verdict per hub.'}
        />
      </div>

      {/* MONEY IN FLIGHT (Batch 1) — the cards above are TERMINAL-STATE
          figures: "Escrow Funds Held" counts only claims still in
          escrow_held, and "Total Revenue" only platform_fee rows already
          marked completed. Money attached to a claim that has moved on —
          the dispute window still running, or a payout submitted whose
          provider outcome is not yet confirmed — was invisible on this
          overview, which is exactly the state an approved settlement with
          an unresolved finder payout sits in.

          Each state is shown as its OWN labelled fact. They are
          deliberately NOT merged into an "available funds" number: no
          provider or accounting model in this codebase supports one, so
          such a figure would be invented rather than computed.

          A figure this server build did not report renders as "—", never
          as 0 (see inFlightAmountLabel), so a missing value can never be
          mistaken for a genuine zero. */}
      <div className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-2xl p-4 sm:p-6 shadow-sm space-y-4">
        <div className="space-y-1">
          <h3 className="font-extrabold text-caption text-[var(--appearance-text-muted)] uppercase tracking-widest flex items-center gap-2">
            <ShieldCheck size={ICON_SIZE.ui} aria-hidden="true" />
            {'Money in flight'}
          </h3>
          <p className="text-body text-[var(--appearance-text-muted)]">
            {isReported(dashboardData.stats?.fundsInFlightAmount)
              ? ('Funds the platform is still holding for claims that have not been paid out yet.')
              : ('This server build does not report in-flight funds — read the figures below as unknown, not as zero.')}
          </p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 sm:gap-4">
          <StatCard
            icon={Coins}
            label={'Funds Held (not yet paid out)'}
            value={amountLabel(dashboardData.stats?.fundsInFlightAmount)}
            description={isReported(dashboardData.stats?.fundsInFlightCount)
              ? (`Across ${dashboardData.stats.fundsInFlightCount} claim(s) in escrow, inside the dispute window, or mid-payout.`)
              : ('The claim count was not reported by this server build.')}
          />
          <StatCard
            icon={ClipboardList}
            label={'Awaiting Payout'}
            value={amountLabel(dashboardData.stats?.settlementPendingAmount)}
            description={isReported(dashboardData.stats?.settlementPendingCount)
              ? (`Dispute window closed; ${dashboardData.stats.settlementPendingCount} claim(s) awaiting settlement approval or payout initiation.`)
              : ('The claim count was not reported by this server build.')}
          />
          <StatCard
            icon={RefreshCw}
            label={'Payout In Flight'}
            value={amountLabel(dashboardData.stats?.releasingAmount)}
            description={isReported(dashboardData.stats?.releasingCount)
              ? (`Submitted to the provider; ${dashboardData.stats.releasingCount} claim(s) not yet confirmed paid.`)
              : ('The claim count was not reported by this server build.')}
          />
        </div>
      </div>
    </>
  );
}
