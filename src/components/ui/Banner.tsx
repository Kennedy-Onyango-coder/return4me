import React from 'react';
import { AlertCircle, CheckCircle2, Info, AlertTriangle, X, LucideIcon } from 'lucide-react';

export type BannerKind = 'success' | 'error' | 'warning' | 'info';

interface BannerProps extends React.HTMLAttributes<HTMLDivElement> {
  kind: BannerKind;
  /** The message. Plain text or rich content — always readable (text-sm). */
  children: React.ReactNode;
  /** Optional dismiss button. Must supply the accessible name. */
  onDismiss?: () => void;
  dismissLabel?: string;
  /** Replace the semantic icon for the kind (decorative by default). */
  icon?: LucideIcon;
}

const kindClasses: Record<BannerKind, string> = {
  success: 'bg-status-success-surface border-status-success-border text-status-success',
  error: 'bg-status-danger-surface border-status-danger-border text-status-danger',
  warning: 'bg-status-warning-surface border-status-warning-border text-status-warning',
  info: 'bg-status-info-surface border-status-info-border text-status-info',
};

const kindIcons: Record<BannerKind, LucideIcon> = {
  success: CheckCircle2,
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
};

/**
 * Shared Return4me banner — the single replacement for the ~20 duplicated
 * hand-rolled `bg-red-50 border-red-200 …` inline boxes across the views.
 * Errors and warnings announce themselves to assistive tech (role="alert"
 * — interruptive); success/info use role="status" (polite). Padding and
 * radius are fixed here so banners are visually consistent app-wide.
 * NOTE: this does NOT migrate any existing banner yet — later phases
 * swap views over one at a time.
 */
export default function Banner({
  kind,
  children,
  onDismiss,
  dismissLabel,
  icon,
  className = '',
  ...rest
}: BannerProps) {
  const Icon = icon ?? kindIcons[kind];
  const isInterruptive = kind === 'error' || kind === 'warning';
  return (
    <div
      role={isInterruptive ? 'alert' : 'status'}
      aria-live={isInterruptive ? 'assertive' : 'polite'}
      className={`border rounded-xl px-4 py-3 text-sm flex items-start gap-2.5 font-medium ${kindClasses[kind]} ${className}`}
      {...rest}
    >
      <Icon size={17} aria-hidden="true" className="shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">{children}</div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={dismissLabel ?? 'Dismiss notification'}
          className="shrink-0 cursor-pointer transition-colors hover:opacity-70 focus-visible:opacity-70"
        >
          <X size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
