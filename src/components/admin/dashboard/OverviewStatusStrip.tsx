import { Loader2 } from 'lucide-react';
import { ICON_SIZE } from '../../ui';

// =============================================================================
// STAGE 4B — THE OVERVIEW'S READING PROVENANCE STRIP (Z0).
// =============================================================================
// BATCH 3 — Every figure on the Overview carries the time of the reading it came
// from, and a background refresh is stated in prose (aria-live) rather than
// replacing the figures with a spinner: an operator mid-read must never lose the
// numbers they were looking at, and must never have to guess their age.
//
// STAGE 4B moved this markup out of AdminView.tsx UNCHANGED. The component holds
// no state, fetches nothing and writes nothing: AdminView still owns the fetch,
// the coalescing, the sequence-number guard, the stale flag and the retry. This
// is a presentation boundary only.
// =============================================================================

export interface OverviewStatusStripProps {
  /** The dashboard payload, or null. Only its PRESENCE is read here. */
  dashboardData: any;
  /** When the current reading was loaded (or '' before the first one). */
  dashboardLoadedAt: string;
  /** True when the newest refresh failed and the figures on screen are older. */
  dashboardStale: boolean;
  /** True while a refresh is in flight. */
  dashboardLoading: boolean;
}

export default function OverviewStatusStrip({
  dashboardData,
  dashboardLoadedAt,
  dashboardStale,
  dashboardLoading,
}: OverviewStatusStripProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2" aria-live="polite">
      <p className="text-caption text-[var(--appearance-text-muted)]">
        {dashboardLoadedAt
          ? `Last updated ${new Date(dashboardLoadedAt).toLocaleTimeString()}${dashboardStale ? ' — the latest refresh failed, so this is an older reading' : ''}`
          : 'Waiting for the first reading…'}
      </p>
      {dashboardLoading && dashboardData && (
        <p className="flex items-center gap-2 text-caption font-semibold text-[var(--appearance-text-muted)]" aria-busy="true">
          <Loader2 className="animate-spin" size={ICON_SIZE.metadata} aria-hidden="true" />
          {'Refreshing…'}
        </p>
      )}
    </div>
  );
}
