import React, { forwardRef, useRef, useCallback, useId } from 'react';

interface OTPInputProps {
  /** Number of digits. Defaults to 4 (matches the existing owner flow). */
  length?: number;
  /** Current value. Controlled — parent owns the string. */
  value: string;
  /** Called with the full new string on every keystroke/paste. */
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Accessible label for the group. A single <label> is wired via
   *  aria-labelledby so each box shares one name. */
  label?: string;
  /** Where to put the label: above the boxes (block) or visually hidden. */
  hideLabel?: boolean;
  error?: string;
  className?: string;
}

/**
 * Shared Return4me OTP / numeric-code input.
 *
 * UI ONLY — this does not implement or touch any verification logic. It is
 * a presentational replacement for the single text-input OTP field used in
 * the owner flow today; later phases wire it to the same handlers.
 *
 * Behaviour the security flow depends on, preserved here:
 *  - numeric keyboard on phones (inputMode="numeric", pattern, type="text"
 *    to avoid spinner UI and to let leading zeroes survive).
 *  - paste of a full code fills every box left-to-right.
 *  - arrow-key + backspace navigation between boxes.
 *  - configurable length so the same component covers 4-digit OTP and the
 *    6-digit admin codes.
 *  - one accessible name for the group, error announced via role="alert".
 */
const OTPInput = forwardRef<HTMLDivElement, OTPInputProps>(
  (
    {
      length = 4,
      value,
      onChange,
      disabled = false,
      label = 'Verification code',
      hideLabel = false,
      error,
      className = '',
    },
    ref
  ) => {
    const groupRef = useRef<HTMLDivElement>(null);
    const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
    const autoId = useId();
    const groupId = autoId;

    const focusBox = useCallback((index: number) => {
      const clamped = Math.max(0, Math.min(index, length - 1));
      inputRefs.current[clamped]?.focus();
    }, [length]);

    const handleChange = (index: number, raw: string) => {
      const char = raw.replace(/\D/g, '').slice(-1); // keep last digit typed
      const next = value.split('');
      next[index] = char;
      onChange(next.join(''));
      if (char && index < length - 1) focusBox(index + 1);
    };

    const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Backspace') {
        if (value[index]) {
          const next = value.split('');
          next[index] = '';
          onChange(next.join(''));
        } else if (index > 0) {
          focusBox(index - 1);
        }
        return;
      }
      if (e.key === 'ArrowLeft' && index > 0) {
        e.preventDefault();
        focusBox(index - 1);
      } else if (e.key === 'ArrowRight' && index < length - 1) {
        e.preventDefault();
        focusBox(index + 1);
      }
    };

    const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
      const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, length);
      if (!pasted) return;
      e.preventDefault();
      onChange(pasted.padEnd(length, '').slice(0, length));
      // focus the last filled box
      focusBox(Math.min(pasted.length, length - 1));
    };

    return (
      <div ref={ref} className={`w-full ${className}`}>
        {label && (
          <label
            id={groupId}
            className={`block text-xs font-bold text-brand-dark-text mb-1.5 ${hideLabel ? 'sr-only' : ''}`}
          >
            {label}
          </label>
        )}
        <div
          ref={groupRef}
          role="group"
          aria-labelledby={label ? groupId : undefined}
          aria-label={label ? undefined : 'Verification code'}
          className="flex gap-2 justify-between"
        >
          {Array.from({ length }).map((_, i) => (
            <input
              key={i}
              ref={(el) => { inputRefs.current[i] = el; }}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={1}
              autoComplete={length === 1 ? 'one-time-code' : 'off'}
              disabled={disabled}
              value={value[i] ?? ''}
              onChange={(e) => handleChange(i, e.target.value)}
              onKeyDown={(e) => handleKeyDown(i, e)}
              onPaste={handlePaste}
              aria-label={length > 1 ? `Digit ${i + 1} of ${length}` : label}
              aria-invalid={error ? true : undefined}
              className={`h-12 w-full text-center text-lg font-extrabold font-mono rounded-xl border px-0 transition-colors focus:outline-none focus:border-accent-orange focus:ring-2 focus:ring-accent-orange/30 disabled:opacity-50 disabled:cursor-not-allowed ${
                error ? 'border-status-danger bg-status-danger-surface/40' : 'border-brand-border bg-white'
              }`}
            />
          ))}
        </div>
        {error && (
          <p role="alert" className="mt-1.5 text-xs font-bold text-status-danger">
            {error}
          </p>
        )}
      </div>
    );
  }
);

OTPInput.displayName = 'OTPInput';

export default OTPInput;
