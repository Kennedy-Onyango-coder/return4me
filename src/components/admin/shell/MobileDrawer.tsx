import React, { useEffect, useMemo, useRef } from 'react';
import { ChevronRight, X } from 'lucide-react';
import { ICON_SIZE } from '../../ui';
import {
  ADMIN_NAV_GROUPS,
  type AdminNavGroup,
  type AdminSectionId,
} from './adminNavRegistry';
import {
  ADMIN_MOBILE_DRAWER_ID,
  adminDrawerWidth,
  adminShellTransitionMs,
  adminTouchTarget,
} from '../../ui/adminTokens';

export interface MobileDrawerProps {
  /** Open state, owned by the console so it cannot collide with the desktop
   *  sidebar's collapsed state. */
  open: boolean;
  /** Closes the drawer: backdrop click, the close button, Escape, or a pick. */
  onClose: () => void;
  /** The section currently rendered by the console. */
  activeSection: AdminSectionId;
  /** Selects a section. The drawer closes itself afterwards. */
  onSelect: (section: AdminSectionId) => void;
  /**
   * The sections the console can actually reach, in registry order.
   *
   * Passed in rather than assumed from the registry, because the registry is
   * allowed to describe a section the console has not wired yet. Rendering such
   * an id would put a control on screen that leads nowhere — Stage 3B §9
   * forbids inert controls, so this drawer renders the intersection only.
   */
  sections: readonly AdminSectionId[];
}


/**
 * The small-screen admin navigation drawer.
 *
 * Shown below `lg` (`lg:hidden`) — from `lg` up the console renders
 * `AdminSidebar` instead, so exactly one navigation is presented per viewport.
 *
 * Interaction contract, all of it exercised by the markup below:
 *   * backdrop click closes (the backdrop is its own element, so a click inside
 *     the panel never reaches it);
 *   * the close button closes;
 *   * Escape closes, listened for on `document` while open;
 *   * picking a section selects it AND closes;
 *   * focus moves into the panel on open and returns to whatever was focused
 *     before it closed;
 *   * background scrolling is locked while open and restored on close.
 *
 * The caller supplies a fresh `onClose` each render, so the listener reads it
 * through a ref instead of re-subscribing — otherwise every state change in the
 * console would re-run the focus effect and steal focus back to the close
 * button.
 */
export function MobileDrawer({
  open,
  onClose,
  activeSection,
  onSelect,
  sections,
}: MobileDrawerProps) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  // Keep the latest callback without making it an effect dependency.
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const visibleGroups = useMemo<AdminNavGroup[]>(() => {
    const allowed = new Set<AdminSectionId>(sections);
    return ADMIN_NAV_GROUPS.map((group) => ({
      ...group,
      items: group.items.filter((item) => allowed.has(item.id)),
    })).filter((group) => group.items.length > 0);
  }, [sections]);

  useEffect(() => {
    if (!open) return undefined;

    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const focusTimer = window.setTimeout(() => {
      closeButtonRef.current?.focus();
    }, 0);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      const previous = previouslyFocusedRef.current;
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      {/* Backdrop. Its own element (not a handler on the container) so a click
          inside the panel cannot bubble into a close. */}
      <div
        className="absolute inset-0 bg-black/50 fade-in"
        aria-hidden="true"
        onClick={() => onCloseRef.current()}
      />

      <div
        id={ADMIN_MOBILE_DRAWER_ID}
        role="dialog"
        aria-modal="true"
        aria-label="Admin sections"
        style={{
          width: adminDrawerWidth,
          transitionDuration: `${adminShellTransitionMs}ms`,
        }}
        className="absolute inset-y-0 left-0 flex max-w-[85vw] flex-col border-r border-[var(--appearance-border)] bg-[var(--appearance-surface)] shadow-[var(--shadow-raised)]"
      >
        <div className="flex items-center justify-between gap-3 border-b border-[var(--appearance-border)] px-4 py-3">
          <span className="truncate text-body font-extrabold text-[var(--appearance-text-primary)]">
            {'Return4me Admin'}
          </span>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={() => onCloseRef.current()}
            aria-label="Close navigation"
            style={{ minHeight: adminTouchTarget, minWidth: adminTouchTarget }}
            className="flex shrink-0 items-center justify-center rounded-small text-[var(--appearance-text-muted)] transition-colors hover:bg-[var(--appearance-surface-muted)] hover:text-[var(--appearance-text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--appearance-primary)]"
          >
            <X size={ICON_SIZE.heading} aria-hidden="true" />
          </button>
        </div>

        <nav
          aria-label="Admin sections"
          className="flex-1 overflow-y-auto px-2 py-3"
        >
          {visibleGroups.map((group) => (
            <div key={group.id} className="mb-2 last:mb-0">
              {/* A paragraph, not a heading: the console keeps its single
                  page-level <h1> in the title band. */}
              <p className="px-3 pb-1 pt-2 text-caption font-extrabold uppercase tracking-wide text-[var(--appearance-text-muted)]">
                {group.label}
              </p>
              <ul className="space-y-1">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const isActive = item.id === activeSection;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => {
                          onSelect(item.id);
                          onCloseRef.current();
                        }}
                        aria-current={isActive ? 'page' : undefined}
                        style={{ minHeight: adminTouchTarget }}
                        className={`flex w-full items-center gap-3 rounded-small px-3 py-2 text-left text-caption transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--appearance-primary)] ${
                          isActive
                            ? 'font-extrabold text-[var(--appearance-text-primary)] bg-[var(--appearance-surface-muted)]'
                            : 'font-bold text-[var(--appearance-text-secondary)] hover:bg-[var(--appearance-surface-muted)] hover:text-[var(--appearance-text-primary)]'
                        }`}
                      >
                        <Icon
                          size={ICON_SIZE.ui}
                          aria-hidden="true"
                          className="shrink-0"
                        />
                        <span className="truncate">{item.label}</span>
                        {isActive ? (
                          <ChevronRight
                            size={ICON_SIZE.metadata}
                            aria-hidden="true"
                            className="ml-auto shrink-0"
                          />
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </div>
    </div>
  );
}

export default MobileDrawer;

