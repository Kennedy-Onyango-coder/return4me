import React, { forwardRef, useId } from 'react';
import { AlertCircle } from 'lucide-react';
import { ICON_SIZE } from './iconSize';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Visible label; rendered with a proper <label htmlFor> link. */
  label?: string;
  /** Persistent helper text below the field. */
  hint?: string;
  /** Validation / submission error. Overrides hint when present and
   *  wires aria-describedby + aria-invalid automatically. */
  error?: string;
  /** Visually hide the label while keeping it for screen readers. */
  hideLabel?: boolean;
  /** Wrapper div classes (layout), not the control itself. */
  className?: string;
}

/**
 * Shared Return4me text input. One visual language for every form in the
 * app: 1px brand border, rounded-xl, 44px default height, orange focus
 * treatment (border-color plus the global :focus-visible ring), white
 * surface. Purely presentational — it never touches values, validation
 * or the network; callers keep full control via the standard input props
 * (value/onChange/inputMode/type etc. passthrough, ref forwarded).
 */
const Input = forwardRef<HTMLInputElement, InputProps>(
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
      ...rest
    },
    ref
  ) => {
    const autoId = useId();
    const inputId = id ?? autoId;
    const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;

    return (
      <div className={`w-full space-y-1 ${className}`}>
        {label && (
          <label
            htmlFor={inputId}
            className={`block text-caption font-bold text-[var(--appearance-text-primary)] ${hideLabel ? 'sr-only' : ''}`}
          >
            {label}
            {required && <span className="text-status-danger" aria-hidden="true"> *</span>}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          required={required}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={`w-full h-11 border rounded-standard px-3 text-body text-[var(--appearance-text-primary)] transition-colors focus:border-[var(--appearance-focus)] disabled:opacity-50 disabled:cursor-not-allowed placeholder:text-[var(--appearance-text-muted)] ${
            error
              ? 'border-[var(--appearance-danger)] bg-[var(--appearance-surface)]'
              : 'border-[var(--appearance-border)] bg-[var(--appearance-surface)]'
          }`}
          {...rest}
        />
        {error ? (
          <p
            id={`${inputId}-error`}
            role="alert"
            className="flex items-center gap-1.5 text-caption font-bold text-status-danger"
          >
            <AlertCircle size={ICON_SIZE.metadata} aria-hidden="true" />
            {error}
          </p>
        ) : hint ? (
          <p id={`${inputId}-hint`} className="text-caption text-[var(--appearance-text-muted)]">
            {hint}
          </p>
        ) : null}
      </div>
    );
  }
);

Input.displayName = 'Input';

export default Input;
