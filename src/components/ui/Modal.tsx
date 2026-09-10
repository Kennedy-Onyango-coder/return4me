import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { trapModalFocus } from '../../utils/modalFocus';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Accessible dialog name. Rendered as the visible heading; pass
   *  `hideTitle` to name the dialog without rendering duplicate text. */
  title: string;
  hideTitle?: boolean;
  children: React.ReactNode;
  /** Optional footer (action row) pinned under the scrollable body. */
  footer?: React.ReactNode;
  closeLabel?: string;
  className?: string;
}

/**
 * Shared Return4me modal dialog.
 *
 * Integrates with the EXISTING focus-trap util (utils/modalFocus.ts) —
 * it does not introduce a second focus-management implementation. On open
 * it moves focus into the dialog, traps Tab, closes on Escape, and locks
 * body scroll (compensating for the scrollbar so the page doesn't shift).
 * Renders through a portal with a solid scrim (no backdrop blur — cheap
 * on low-end phones and visually cleaner). Accessible semantics:
 * role="dialog" aria-modal="true" with an aria-labelledby heading.
 *
 * NOTE: this does not change any existing modal yet — views migrate in
 * later phases.
 */
export default function Modal({
  open,
  onClose,
  title,
  hideTitle = false,
  children,
  footer,
  closeLabel,
  className = '',
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Focus management + ESC + scroll lock, all tied to the open lifecycle.
  useEffect(() => {
    if (!open) return;

    previouslyFocused.current = document.activeElement as HTMLElement | null;
    // Focus the dialog container itself (it is focusable via tabIndex=-1),
    // so the first Tab lands on the first control, Shift+Tab on the last.
    dialogRef.current?.focus();

    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    const previousOverflow = document.body.style.overflow;
    const previousPaddingRight = document.body.style.paddingRight;
    document.body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dialogRef.current) {
        event.stopPropagation();
        onClose();
        return;
      }
      if (dialogRef.current) {
        trapModalFocus(event, dialogRef.current);
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.body.style.overflow = previousOverflow;
      document.body.style.paddingRight = previousPaddingRight;
      // Return focus to where the user was before the dialog opened.
      previouslyFocused.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onMouseDown={(e) => {
        // Backdrop click closes — but only when the press started on the
        // scrim itself, so dragging text inside the dialog can't dismiss it.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Solid scrim — deliberately NOT blurred (glassmorphism is out of
          brand, and blur is expensive on low-cost Android devices). */}
      <div className="absolute inset-0 bg-stone-950/60" aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="r4m-modal-title"
        tabIndex={-1}
        className={`relative bg-white w-full sm:max-w-lg max-h-[90vh] sm:max-h-[85vh] flex flex-col rounded-t-3xl sm:rounded-3xl border border-brand-border shadow-xl outline-none ${className}`}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-brand-border shrink-0">
          <h2
            id="r4m-modal-title"
            className={`text-base font-extrabold text-brand-dark-text ${hideTitle ? 'sr-only' : ''}`}
          >
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel ?? 'Close dialog'}
            className="shrink-0 p-1.5 -m-1.5 cursor-pointer text-brand-muted-text hover:text-brand-dark-text transition-colors rounded-lg"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="px-5 py-4 overflow-y-auto text-sm text-brand-dark-text">{children}</div>
        {footer && (
          <div className="px-5 py-4 border-t border-brand-border shrink-0 bg-white rounded-b-3xl">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
