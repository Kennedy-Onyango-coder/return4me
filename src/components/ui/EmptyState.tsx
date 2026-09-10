import React from 'react';
import { LucideIcon } from 'lucide-react';

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
      className={`bg-brand-light-gray/60 border border-brand-border rounded-2xl px-6 py-8 text-center space-y-2 ${className}`}
    >
      {Icon && (
        <Icon size={22} aria-hidden="true" className="mx-auto text-brand-muted-text mb-1" />
      )}
      <p className="text-sm font-extrabold text-brand-dark-text">{title}</p>
      {description && (
        <p className="text-xs text-brand-muted-text max-w-sm mx-auto leading-relaxed">
          {description}
        </p>
      )}
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}
