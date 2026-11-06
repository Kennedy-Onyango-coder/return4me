import React from 'react';
import { ArrowRight, ClipboardList } from 'lucide-react';
import Button from '../../ui/Button';
import Badge from '../../ui/Badge';
import EmptyState from '../../ui/EmptyState';
import { ICON_SIZE } from '../../ui';
import { formatKesAmount } from './adminOverviewMetrics';

// =============================================================================
// STAGE 4B — THE OVERVIEW'S ACTIVITY ZONE (Z3).
// =============================================================================
// The five newest ledger entries out of the newest 100 the dashboard publishes,
// plus the control that opens the Ledger section where the full list, its
// filters and its per-claim actions live. It is a READING, not a ledger: nothing
// here writes, retries or reconciles, and a row's own status is rendered exactly
// as recorded.
//
// STAGE 4B moved this markup out of AdminView.tsx UNCHANGED — same columns, same
// badges, same empty state, same destination. The component fetches nothing and
// writes nothing; AdminView still owns the fetch, the stale/retry behaviour and
// the active-tab routing (`onOpenLedger` is that router, passed in).
// =============================================================================

export interface OverviewActivityZoneProps {
  /** The validated dashboard payload. Read-only: nothing here mutates it. */
  dashboardData: any;
  /** Opens the Ledger section (AdminView's active-tab setter). */
  onOpenLedger: () => void;
}

export default function OverviewActivityZone({
  dashboardData,
  onOpenLedger,
}: OverviewActivityZoneProps) {
  return (
    <div className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-2xl p-6 shadow-sm space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-extrabold text-caption text-[var(--appearance-text-muted)] uppercase tracking-widest flex items-center gap-2">
          <ClipboardList size={ICON_SIZE.ui} aria-hidden="true" />
          {'Recent platform activity'}
        </h3>
        <Button variant="ghost" size="sm" onClick={onOpenLedger}>
          {'Open ledger'}
          <ArrowRight size={ICON_SIZE.metadata} aria-hidden="true" />
        </Button>
      </div>
      {dashboardData.ledger.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title={'No ledger entries yet'}
          description={'Ledger entries appear here as soon as they are recorded.'}
        />
      ) : (
        <div className="r4m-scroll-x" role="region" aria-label={'Latest ledger entries'} tabIndex={0}>
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-[var(--appearance-surface-muted)] text-caption font-extrabold text-[var(--appearance-text-muted)] uppercase tracking-widest border-b border-[var(--appearance-border)]">
                <th scope="col" className="px-5 py-3 font-bold">{'Time'}</th>
                <th scope="col" className="px-5 py-3 font-bold">{'Type'}</th>
                <th scope="col" className="px-5 py-3 font-bold">{'Amount'}</th>
                <th scope="col" className="px-5 py-3 font-bold">{'Claim'}</th>
                <th scope="col" className="px-5 py-3 font-bold">{'Status'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--appearance-border)] text-caption text-[var(--appearance-text-muted)]">
              {dashboardData.ledger.slice(0, 5).map((entry: any) => (
                <tr key={entry.id} className="hover:bg-[var(--appearance-surface-muted)]/50 transition">
                  <td className="px-5 py-3.5 text-[var(--appearance-text-muted)] whitespace-nowrap">
                    {entry.created_at ? new Date(entry.created_at).toLocaleString() : '—'}
                  </td>
                  <td className="px-5 py-3.5">
                    <Badge
                      variant={
                        entry.type === 'payment_received' ? 'info' :
                          entry.type === 'finder_payout' ? 'success' :
                            entry.type === 'agent_payout' ? 'warning' : 'neutral'
                      }
                    >
                      {entry.type.replace('_', ' ')}
                    </Badge>
                  </td>
                  <td className="px-5 py-3.5 font-bold text-[var(--appearance-text-primary)] tabular-nums">{formatKesAmount(entry.amount).text}</td>
                  <td className="px-5 py-3.5">{entry.claim_id || '—'}</td>
                  <td className="px-5 py-3.5">
                    <Badge
                      variant={
                        entry.status === 'completed' ? 'success'
                          : entry.status === 'failed' ? 'danger' : 'warning'
                      }
                    >
                      {entry.status.toUpperCase()}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
