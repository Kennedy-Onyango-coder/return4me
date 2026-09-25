import React, { forwardRef, useId } from 'react';
import { AlertCircle } from 'lucide-react';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Visible label; rendered with a proper <label htmlFor> link. */
  label?: string;
  /** Persistent helper text below the field. */
  hint?: string;
  /** Validation / submission error. Overrides hint when present and wires
   *  aria-describedby + aria-invalid automatically. */
  error?: string;
  /** Visually hide the label while keeping it for screen readers. */
  hideLabel?: boolean;
  /** Wrapper div classes (layout), not the control itself. */
  className?: string;
}

/**
 * Shared Return4me multiline input.
 *
 * WHY THIS EXISTS: <Input> only renders a single-line <input>, so every view
 * that needed a free-text description either forced a one-line box (bad for
 * a real description) or hand-rolled its own textarea with slightly different
 * border/radius/focus styling. This is the design-system primitive for that
 * case, deliberately identical to <Input> in border, radius, focus treatment,
 * label wiring and error/hint rendering — only the element differs — so the
 * ~5 description fields across the app can share one appearance instead of
 * five.
 *
 * Purely presentational: it never touches values, validation or the network.
 * The caller keeps full control via the standard textarea props (ref forwarded).
 */
const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
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
      rows = 4,
      ...rest
    },
    ref
  ) => {
    const autoId = useId();
    const fieldId = id ?? autoId;
    const describedBy = error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined;

    return (
      <div className={`w-full space-y-1 ${className}`}>
        {label && (
          <label
            htmlFor={fieldId}
            className={`block text-xs font-bold text-[var(--appearance-text-primary)] ${hideLabel ? 'sr-only' : ''}`}
          >
            {label}
            {required && <span className="text-status-danger" aria-hidden="true"> *</span>}
          </label>
        )}
        <textarea
          ref={ref}
          id={fieldId}
          rows={rows}
          required={required}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={`w-full border rounded-xl px-3 py-2.5 text-sm leading-relaxed text-[var(--appearance-text-primary)] transition-colors focus:outline-none focus:border-[var(--appearance-focus)] focus:ring-2 focus:ring-[var(--appearance-focus)]/30 disabled:opacity-50 disabled:cursor-not-allowed placeholder:text-[var(--appearance-text-muted)] resize-y min-h-[88px] ${
            error
              ? 'border-[var(--appearance-danger)] bg-[var(--appearance-surface)]'
              : 'border-[var(--appearance-border)] bg-[var(--appearance-surface)]'
          }`}
          {...rest}
        />
        {error ? (
          <p
            id={`${fieldId}-error`}
            role="alert"
            className="flex items-center gap-1.5 text-xs font-bold text-status-danger"
          >
            <AlertCircle size={13} aria-hidden="true" />
            {error}
          </p>
        ) : hint ? (
          <p id={`${fieldId}-hint`} className="text-xs text-[var(--appearance-text-muted)]">
            {hint}
          </p>
        ) : null}
      </div>
    );
  }
);

Textarea.displayName = 'Textarea';

export default Textarea;
