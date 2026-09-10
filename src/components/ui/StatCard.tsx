import React from 'react';
import { LucideIcon } from 'lucide-react';

interface StatCardProps {
  label: string;
  /** The headline number/amount. Rendered tabular-nums so digits align. */
  value: React.ReactNode;
  /** Optional currency/code prefix formatting is the caller's job — pass
   *  the final display string (e.g. "KES 12,500"). */
  icon?: LucideIcon;
  description?: string;
  /** Optional status badge content (e.g. <Badge variant="success">Settled</Badge>). */
  status?: React.ReactNode;
  className?: string;
}

/**
 * Shared dashboard stat tile — the DS replacement for the hand-rolled
 * earnings/admin stat cards (currently re-implemented 5+ times with
 * different paddings and radii). Compact on mobile (single row), roomy
 * on desktop. Purely presentational — it knows nothing about AdminView,
 * agents or payments; label/value come entirely from props.
 */
export default function StatCard({ label, value, icon: Icon, description, status, className = '' }: StatCardProps) {
  return (
    <div className={`bg-white border border-brand-border rounded-2xl p-4 sm:p-5 shadow-sm flex items-start justify-between gap-3 ${className}`}>
      <div className="space-y-1 min-w-0">
        <p className="text-[11px] font-extrabold uppercase tracking-widest text-brand-muted-text">
          {label}
        </p>
        <p className="text-2xl font-extrabold text-primary-green tabular-nums tracking-tight leading-tight">
          {value}
        </p>
        {description && (
          <p className="text-xs text-brand-muted-text leading-snug">{description}</p>
        )}
      </div>
      {(Icon || status) && (
        <div className="flex flex-col items-end gap-2 shrink-0">
          {status}
          {Icon && (
            <span
              aria-hidden="true"
              className="w-9 h-9 rounded-xl bg-primary-green/10 text-primary-green flex items-center justify-center"
            >
              <Icon size={17} />
            </span>
          )}
        </div>
      )}
    </div>
  );
}
