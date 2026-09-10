// Return4me shared UI foundation.
//
// Every primitive exports both as a named export and a default import so
// callers can use whichever style fits their file. Import from '@/components/ui'
// (or the relative path) — never reach into individual files from outside
// the design system, so we can refactor internals without touching views.

export { default as Button } from './Button';
export type { ButtonVariant, ButtonSize } from './Button';

export { default as Input } from './Input';
export type { InputProps } from './Input';

export { default as Select } from './Select';
export type { SelectProps } from './Select';

export { default as Badge } from './Badge';
export type { BadgeVariant } from './Badge';

export { default as Banner } from './Banner';
export type { BannerKind } from './Banner';

export { default as Modal } from './Modal';

export { default as EmptyState } from './EmptyState';

export { default as Spinner } from './Spinner';
export type { SpinnerProps } from './Spinner';

export { default as Skeleton } from './Skeleton';

export { default as SectionHeading } from './SectionHeading';

export { default as StatCard } from './StatCard';

export { default as Stepper } from './Stepper';
export type { Step } from './Stepper';

export { default as OTPInput } from './OTPInput';
