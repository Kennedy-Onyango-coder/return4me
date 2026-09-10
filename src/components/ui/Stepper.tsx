import React from 'react';
import { Check } from 'lucide-react';

export interface Step {
  /** Short label, e.g. "Photo". */
  label: string;
  /** Longer description, shown on wide screens only. */
  description?: string;
}

interface StepperProps {
  steps: Step[];
  /** Zero-based index of the current step. Steps before it render as
   *  completed, steps after as upcoming. */
  currentStep: number;
  /** Accessible context for the whole control, e.g. "Report a found item progress". */
  label?: string;
  className?: string;
}

/**
 * Shared multi-step progress indicator for the two long flows (found-item
 * report; owner claim). Mobile-first: on small screens it renders a compact
 * "step 2 of 4" progress bar + current-step label (zero vertical waste),
 * expanding to the full numbered rail with connectors on sm+ screens.
 * Accessibility: the group exposes its label via aria-label, the current
 * item is marked aria-current="step", and completed steps announce as
 * such with a check icon + sr-only "Completed" text.
 */
export default function Stepper({ steps, currentStep, label = 'Progress', className = '' }: StepperProps) {
  const safeIndex = Math.max(0, Math.min(currentStep, steps.length - 1));

  return (
    <nav aria-label={label} className={`w-full ${className}`}>
      {/* Mobile: compact progress bar + label */}
      <div className="sm:hidden space-y-1.5">
        <div className="flex items-baseline justify-between">
          <p className="text-xs font-extrabold text-brand-dark-text">
            {steps[safeIndex].label}
          </p>
          <p className="text-xs font-bold text-brand-muted-text tabular-nums">
            Step {safeIndex + 1} of {steps.length}
          </p>
        </div>
        <div className="flex gap-1.5" aria-hidden="true">
          {steps.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 flex-1 rounded-full transition-colors ${
                i <= safeIndex ? 'bg-primary-green' : 'bg-brand-border'
              }`}
            />
          ))}
        </div>
      </div>

      {/* sm+ : full numbered rail */}
      <ol className="hidden sm:flex items-start w-full">
        {steps.map((step, i) => {
          const isCompleted = i < safeIndex;
          const isCurrent = i === safeIndex;
          return (
            <li key={i} className="flex-1 flex items-start last:flex-none min-w-0">
              <div className="flex flex-col items-center text-center gap-1.5 w-16 shrink-0">
                <span
                  aria-current={isCurrent ? 'step' : undefined}
                  className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-extrabold border transition-colors ${
                    isCompleted
                      ? 'bg-primary-green border-primary-green text-white'
                      : isCurrent
                        ? 'bg-white border-2 border-primary-green text-primary-green'
                        : 'bg-white border-brand-border text-brand-muted-text'
                  }`}
                >
                  {isCompleted ? (
                    <>
                      <Check size={13} aria-hidden="true" />
                      <span className="sr-only">Completed</span>
                    </>
                  ) : (
                    i + 1
                  )}
                </span>
                <span
                  className={`text-[11px] font-bold leading-tight ${
                    isCurrent ? 'text-primary-green' : isCompleted ? 'text-brand-dark-text' : 'text-brand-muted-text'
                  }`}
                >
                  {step.label}
                </span>
                {step.description && (
                  <span className="hidden lg:block text-[10px] text-brand-muted-text leading-tight">
                    {step.description}
                  </span>
                )}
              </div>
              {i < steps.length - 1 && (
                <span
                  aria-hidden="true"
                  className={`flex-1 h-0.5 mt-3.5 mx-1 rounded-full transition-colors ${
                    i < safeIndex ? 'bg-primary-green' : 'bg-brand-border'
                  }`}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
