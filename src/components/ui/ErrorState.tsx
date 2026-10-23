import React from 'react';
import { AlertCircle } from 'lucide-react';

interface ErrorStateProps {
  /** Optional title describing the error. */
  title: string;
  /** Optional description with more details. */
  description?: string;
  /** Primary action the user can take. */
  action?: React.ReactNode;
  /** Optional on-click for the action button. */
  onAction?: () => void;
  className?: string;
}

/** Shared Return4me error state — replacement for ad-hoc error boxes.
 *  Uses the danger status token for visual consistency.
 */
export default function ErrorState({ title, description, action, onAction, className = '' }: ErrorStateProps) {
  const handleAction = () => {
    if (onAction) onAction();
  };

  return (
    <div
      className={`bg-[var(--appearance-danger-surface)] border border-[var(--appearance-danger)] rounded-panel p-6 px-8 text-center space-y-4 ${className}`}
    >
      <AlertCircle
        size={48}
        className="mx-auto text-[var(--appearance-danger)] mb-4"
        aria-label="Error"
      />
      <p className="text-body font-bold text-[var(--appearance-danger)]">{title}</p>
      {description && (
        <p className="text-caption text-[var(--appearance-text-muted)] max-w-sm mx-auto leading-relaxed">
          {description}
        </p>
      )}
      {action && <div className="pt-4">{action}</div>}
    </div>
  );
}