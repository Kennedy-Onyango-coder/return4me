import React from 'react';
import { LucideIcon } from 'lucide-react';
import { ICON_SIZE } from './iconSize';

interface EmptyStateProps {
  /** Decorative context icon (lucide). Status meaning lives in the text. */
  icon?: LucideIcon;
  title: string;
  description?: string;
  /** Single primary follow-up action, if the user can do something about it. */
  action?: React.ReactNode;
  className?: string;
}

/**
 * Shared Return4me empty state — the replacement for the ad-hoc
 * "No pending …" boxes scattered across views. Compact by design:
 * icon, one-line title, optional description, optional action.
 * No illustrations, no filler copy.
 */
export default function EmptyState({ icon: Icon, title, description, action, className = '' }: EmptyStateProps) {
  return (
    <div
      className={`bg-[var(--appearance-surface-muted)] border border-[var(--appearance-border)] rounded-panel px-6 py-8 text-center space-y-2 ${className}`}
    >
      {Icon && (
        <Icon size={ICON_SIZE.feature} aria-hidden="true" className="mx-auto text-[var(--appearance-text-muted)] mb-1" />
      )}
      <p className="text-body font-extrabold text-[var(--appearance-text-primary)]">{title}</p>
      {description && (
        <p className="text-caption text-[var(--appearance-text-muted)] max-w-sm mx-auto leading-relaxed">
          {description}
        </p>
      )}
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}
