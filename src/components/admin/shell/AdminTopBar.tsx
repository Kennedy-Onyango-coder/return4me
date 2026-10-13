// BATCH B0 — admin shell top bar.
//
// A slim contextual bar rendered above the console title band. It states the
// current section (from the nav registry), surfaces the existing stale-data
// flag, and reuses the existing refresh handler. Presentation only: it holds
// no data, makes no requests, and never triggers a financial action.
import React from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import Button from '../../ui/Button';
import Badge from '../../ui/Badge';
import { ICON_SIZE } from '../../ui';
import type { AdminSectionId } from './adminNavRegistry';
import { describeAdminSection } from './adminNavRegistry';

interface AdminTopBarProps {
  activeSection: AdminSectionId;
  lang: 'en' | 'sw';
  dashboardStale: boolean;
  dashboardLoading: boolean;
  onRefresh: () => void;
}

export default function AdminTopBar({
  activeSection,
  lang,
  dashboardStale,
  dashboardLoading,
  onRefresh,
}: AdminTopBarProps) {
  const described = describeAdminSection(activeSection);
  const sectionLabel = described?.item.label ?? String(activeSection);
  const groupLabel = described?.groupLabel ?? '';
  return (
    <div className="r4m-admin-topbar flex flex-wrap items-center gap-3 rounded-standard border border-[var(--appearance-border)] bg-[var(--appearance-surface)] px-4 py-3 shadow-[var(--shadow-raised)]">
      <span className="inline-flex items-center gap-2 text-body font-extrabold text-[var(--appearance-text-primary)]">
        <ShieldCheck size={ICON_SIZE.ui} aria-hidden="true" className="text-primary-green" />
        {lang === 'en' ? 'Return4me Admin' : 'Msimamizi wa Return4me'}
      </span>
      <span aria-hidden="true" className="text-[var(--appearance-text-muted)]">/</span>
      {/* Deliberately a paragraph, not a heading: the console keeps its ONE h1
          in the title band below (adminConsoleSectionChrome.test.ts). */}
      <p className="text-body text-[var(--appearance-text-secondary)]">
        <span className="font-bold text-[var(--appearance-text-primary)]">{sectionLabel}</span>
        {groupLabel ? <span> · {groupLabel}</span> : null}
      </p>
      <span className="flex-1" aria-hidden="true" />
      {dashboardStale ? (
        <Badge variant="warning">{lang === 'en' ? 'Stale data' : 'Data ya zamani'}</Badge>
      ) : null}
      <Button
        variant="secondary"
        size="sm"
        loading={dashboardLoading}
        loadingLabel={lang === 'en' ? 'Refreshing dashboard' : 'Inapakua upya'}
        onClick={onRefresh}
      >
        <RefreshCw size={ICON_SIZE.metadata} aria-hidden="true" />
        {lang === 'en' ? 'Refresh' : 'Pakua upya'}
      </Button>
    </div>
  );
}
