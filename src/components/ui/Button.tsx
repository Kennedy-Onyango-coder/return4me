import React, { forwardRef } from 'react';
import { Loader2 } from 'lucide-react';

export type ButtonVariant = 'primary' | 'secondary' | 'accent' | 'outline' | 'inverse' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual role. `primary` = Return4me green (default action).
   *  `accent` = Return4me orange — reserved for the important financial /
   *  recovery CTAs (claim & pay, submit report). `danger` = destructive. */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows an inline spinner and disables interaction while true. The
   *  spinner replaces only the leading content slot — the label stays
   *  rendered (and the fixed min-height keeps), so the button never
   *  changes width/height and surrounding layout cannot jump. */
  loading?: boolean;
  /** Screen-reader announcement while loading; defaults to 'Loading…'. */
  loadingLabel?: string;
}

// Fixed-height ladder (px ≈): sm 36 / md 44 / lg 52 — md is the default so
// every standard button already meets the ≥44px touch-target floor on
// mobile. Font sizes are Tailwind-scale (text-sm / text-xs+), never the
// tiny arbitrary px sizes the old hand-rolled buttons used.
const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-9 px-3 text-xs gap-1.5 rounded-lg',
  md: 'h-11 px-5 text-sm rounded-xl',
  lg: 'h-12 px-6 text-base rounded-xl',
};

// Each variant is self-contained (no compound selectors) so callers can
// still append utility overrides via className without specificity fights.
const variantClasses: Record<ButtonVariant, string> = {
  // Primary action — Return4me deep green.
  primary:
    'bg-primary-green hover:bg-primary-hover text-white shadow-sm shadow-primary-green/20 border border-transparent transition-colors',
  // Secondary — subtle green tint, for supporting confirmations.
  secondary:
    'bg-primary-green/10 hover:bg-primary-green/20 text-primary-green border border-primary-green/20 transition-colors',
  // Accent — the important financial / recovery CTA (M-Pesa escrow actions).
  accent:
    'bg-accent-orange hover:bg-accent-hover text-white shadow-sm shadow-accent-orange/20 border border-transparent transition-colors',
  // Outline — visible on both light and dark backgrounds via strong border
  // and solid button surface that never disappears into photographic backdrops.
  outline:
    'bg-white hover:bg-brand-light-gray text-primary-green border-2 border-primary-green/40 hover:border-primary-green transition-colors shadow-sm',
  // Inverse — for dark/photographic backgrounds (hero slides). Semi-transparent
  // white surface with strong border ensures visibility without relying on text
  // color alone. Better than overriding outline which creates invisible text.
  inverse:
    'bg-white/15 hover:bg-white/25 text-white border-2 border-white/70 hover:border-white transition-colors shadow-sm',
  // Ghost — subtle, for inline actions on light surfaces.
  ghost:
    'bg-transparent hover:bg-primary-green/10 text-primary-green border border-transparent transition-colors',
  // Danger — destructive actions.
  danger:
    'bg-status-danger hover:bg-red-800 text-white border border-transparent transition-colors',
};

/**
 * Shared Return4me button.
 *
 * Never renders uppercase text (the old per-screen buttons forced
 * `uppercase text-xs`); the caller's label text is used verbatim.
 * The loading spinner replaces the leading icon slot without unmounting
 * the label, so pressing "Submit" → spinner does not shift layout.
 * Icon-only usage is allowed but must set `aria-label` (or any aria-*
 * attribute) — enforced by the type signature below rather than silently
 * shipping an unlabeled control.
 */
const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      loading = false,
      loadingLabel,
      disabled,
      type = 'button',
      className = '',
      children,
      ...rest
    },
    ref
  ) => {
    const isDisabled = disabled || loading;
    return (
      <button
        ref={ref}
        type={type}
        disabled={isDisabled}
        aria-busy={loading || undefined}
        className={`inline-flex items-center justify-center gap-2 font-bold select-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none ${sizeClasses[size]} ${variantClasses[variant]} ${className}`}
        {...rest}
      >
        {loading && (
          <Loader2
            className="animate-spin shrink-0"
            size={size === 'sm' ? 14 : 16}
            aria-hidden="true"
          />
        )}
        {loading && loadingLabel ? (
          <span className="sr-only">{loadingLabel}</span>
        ) : null}
        {children}
      </button>
    );
  }
);

Button.displayName = 'Button';

export default Button;
