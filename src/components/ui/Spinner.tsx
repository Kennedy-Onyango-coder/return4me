import React from 'react';
import { Loader2 } from 'lucide-react';

export interface SpinnerProps {
  /** Pixel size of the icon. Defaults to 18 — matches the existing
   *  Loader2 usages across the views (14–28px range supported). */
  size?: number;
  /** Accessible text announced while loading; hidden visually. */
  label?: string;
  className?: string;
}

/**
 * Shared loading spinner. Wraps the lucide-react Loader2 icon that the
 * app already uses everywhere — one place to keep spinners consistent
 * (color inherits from the text color, so it works on green banners,
 * white cards and dark buttons alike). Reduced-motion users see the
 * static icon (the pulse is decorative; loading is also conveyed by the
 * surrounding UI disabling controls).
 */
export default function Spinner({ size = 18, label = 'Loading', className = '' }: SpinnerProps) {
  return (
    <span role="status" aria-label={label} className={`inline-flex items-center justify-center ${className}`}>
      <Loader2 size={size} aria-hidden="true" className="animate-spin" />
    </span>
  );
}
