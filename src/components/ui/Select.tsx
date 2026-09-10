import React, { forwardRef, useId } from 'react';
import { AlertCircle, ChevronDown } from 'lucide-react';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hint?: string;
  error?: string;
  hideLabel?: boolean;
  className?: string;
  children?: React.ReactNode;
}

/**
 * Shared Return4me select. Same visual language as <Input> (brand border,
 * rounded-xl, 44px height, orange focus) with a custom chevron. Purely
 * presentational — options are the caller's responsibility, either as
 * <option> children or via the standard props.
 */
const Select = forwardRef<HTMLSelectElement, SelectProps>(
  (
    {
      label,
      hint,
      error,
      hideLabel = false,
      required,
      disabled,
      className = '',
      id,
      children,
      ...rest
    },
    ref
  ) => {
    const autoId = useId();
    const selectId = id ?? autoId;
    const describedBy = error ? `${selectId}-error` : hint ? `${selectId}-hint` : undefined;

    return (
      <div className={`w-full space-y-1 ${className}`}>
        {label && (
          <label
            htmlFor={selectId}
            className={`block text-xs font-bold text-brand-dark-text ${hideLabel ? 'sr-only' : ''}`}
          >
            {label}
            {required && <span className="text-status-danger" aria-hidden="true"> *</span>}
          </label>
        )}
        <div className="relative">
          <select
            ref={ref}
            id={selectId}
            required={required}
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            className={`w-full h-11 border rounded-xl pl-3 pr-9 text-sm transition-colors focus:outline-none focus:border-accent-orange focus:ring-2 focus:ring-accent-orange/30 disabled:opacity-50 disabled:cursor-not-allowed appearance-none bg-white ${
              error ? 'border-status-danger' : 'border-brand-border'
            }`}
            {...rest}
          >
            {children}
          </select>
          <ChevronDown
            size={16}
            aria-hidden="true"
            className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-brand-muted-text"
          />
        </div>
        {error ? (
          <p
            id={`${selectId}-error`}
            role="alert"
            className="flex items-center gap-1.5 text-xs font-bold text-status-danger"
          >
            <AlertCircle size={13} aria-hidden="true" />
            {error}
          </p>
        ) : hint ? (
          <p id={`${selectId}-hint`} className="text-xs text-brand-muted-text">
            {hint}
          </p>
        ) : null}
      </div>
    );
  }
);

Select.displayName = 'Select';

export default Select;
