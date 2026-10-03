import React from 'react';
import { AlertCircle, CheckCircle2, Clock, Info, AlertTriangle, LucideIcon } from 'lucide-react';
import { ICON_SIZE } from './iconSize';

export type BadgeVariant = 'success' | 'warning' | 'pending' | 'danger' | 'info' | 'neutral' | 'code';

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  /** Rendered before the label. Icon must be decorative — status meaning
   *  comes from the (colored) label text and the icon, never color alone. */
  icon?: LucideIcon;
}

// Semantic status variants use the shared status tokens from index.css.
// `neutral` is the quiet surface badge; `code` renders JetBrains Mono for
// claim IDs / collection codes / till numbers (the app's mono language).
// `pending` is the waiting-state name for the same warning semantic as
// `warning` (pending / action required): it exists so a caller states the
// STATE it means rather than reusing a severity word, and both resolve to the
// identical token pair so the two can never drift apart visually.
const variantClasses: Record<BadgeVariant, string> = {
  success: 'bg-[var(--appearance-surface-muted)] text-[var(--appearance-success)] border-[var(--appearance-success)]',
  warning: 'bg-[var(--appearance-surface-muted)] text-[var(--appearance-warning)] border-[var(--appearance-warning)]',
  pending: 'bg-[var(--appearance-surface-muted)] text-[var(--appearance-warning)] border-[var(--appearance-warning)]',
  danger: 'bg-[var(--appearance-surface-muted)] text-[var(--appearance-danger)] border-[var(--appearance-danger)]',
  info: 'bg-[var(--appearance-surface-muted)] text-[var(--appearance-text-secondary)] border-[var(--appearance-border-strong)]',
  neutral: 'bg-[var(--appearance-surface-muted)] text-[var(--appearance-text-primary)] border-[var(--appearance-border)]',
  code: 'bg-[var(--appearance-surface-muted)] text-[var(--appearance-text-primary)] border-[var(--appearance-border)] font-mono tracking-wide',
};

// Status variants always include their semantic icon so meaning is never
// conveyed by color alone (icon + text; color is tertiary reinforcement).
// `pending` gets the clock rather than the warning triangle: waiting is a
// state, not a fault.
const defaultIcons: Partial<Record<BadgeVariant, LucideIcon>> = {
  success: CheckCircle2,
  warning: AlertTriangle,
  pending: Clock,
  danger: AlertCircle,
  info: Info,
};

/**
 * Shared Return4me status badge. Compact pill (text-caption, never the old
 * sub-12px sizes), readable label required. For unimportant decorative
 * statuses pass `variant="neutral"`; for machine identifiers (claim IDs,
 * pickup codes, till numbers) use `variant="code"`. `rounded-full` is the one
 * deliberate exception to the radius ladder: a status pill is a pill.
 */
export default function Badge({ variant = 'neutral', icon, className = '', children, ...rest }: BadgeProps) {
  const Icon = icon ?? defaultIcons[variant];
  return (
    <span
      className={`inline-flex items-center gap-1.5 border text-caption font-bold px-2.5 py-1 rounded-full whitespace-nowrap ${variantClasses[variant]} ${className}`}
      {...rest}
    >
      {Icon && <Icon size={ICON_SIZE.metadata} aria-hidden="true" className="shrink-0" />}
      {children}
    </span>
  );
}
