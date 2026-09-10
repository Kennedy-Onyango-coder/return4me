import React from 'react';
import { AlertCircle, CheckCircle2, Info, AlertTriangle, LucideIcon } from 'lucide-react';

export type BadgeVariant = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'code';

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  /** Rendered before the label. Icon must be decorative — status meaning
   *  comes from the (colored) label text and the icon, never color alone. */
  icon?: LucideIcon;
}

// Semantic status variants use the shared status tokens from index.css.
// `neutral` is the quiet surface badge; `code` renders JetBrains Mono for
// claim IDs / collection codes / till numbers (the app's mono language).
const variantClasses: Record<BadgeVariant, string> = {
  success: 'bg-status-success-surface text-status-success border-status-success-border',
  warning: 'bg-status-warning-surface text-status-warning border-status-warning-border',
  danger: 'bg-status-danger-surface text-status-danger border-status-danger-border',
  info: 'bg-status-info-surface text-status-info border-status-info-border',
  neutral: 'bg-brand-light-gray text-brand-dark-text border-brand-border',
  code: 'bg-brand-light-gray text-brand-dark-text border-brand-border font-mono tracking-wide',
};

// Status variants always include their semantic icon so meaning is never
// conveyed by color alone (icon + text; color is tertiary reinforcement).
const defaultIcons: Partial<Record<BadgeVariant, LucideIcon>> = {
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: AlertCircle,
  info: Info,
};

/**
 * Shared Return4me status badge. Compact pill (text-xs, never the old
 * text-[9px]/[10px]), readable label required. For unimportant decorative
 * statuses pass `variant="neutral"`; for machine identifiers (claim IDs,
 * pickup codes, till numbers) use `variant="code"`.
 */
export default function Badge({ variant = 'neutral', icon, className = '', children, ...rest }: BadgeProps) {
  const Icon = icon ?? defaultIcons[variant];
  return (
    <span
      className={`inline-flex items-center gap-1.5 border text-xs font-bold px-2.5 py-1 rounded-full whitespace-nowrap ${variantClasses[variant]} ${className}`}
      {...rest}
    >
      {Icon && <Icon size={13} aria-hidden="true" className="shrink-0" />}
      {children}
    </span>
  );
}
