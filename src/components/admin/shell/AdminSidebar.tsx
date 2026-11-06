import React from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { ICON_SIZE } from '../../ui';
import {
  ADMIN_SIDEBAR_NAV_ID,
  adminShellTransitionMs,
  adminTouchTarget,
} from '../../ui/adminTokens';

export interface AdminSidebarProps {
  /** True when the desktop sidebar is collapsed to an icon rail. */
  collapsed: boolean;
  /** Flips the collapsed state. Owned by the console, so the drawer's own open
   *  state and this rail state can never overwrite one another. */
  onToggleCollapsed: () => void;
  /**
   * The console's existing navigation markup.
   *
   * Deliberately `children` rather than a registry-driven list rendered HERE.
   * `AdminView` keeps the single definition of every destination — its
   * `<nav aria-label="Admin sections">` with the 14 `setActiveTab(...)` handlers
   * and `aria-current={activeTab === '<id>' ? 'page' : undefined}` markers — and
   * that markup is pinned by `adminConsoleShell.test.ts` and
   * `adminProgramme1Sections.test.ts`. Re-rendering the same list from a second
   * place would create two definitions of one navigation, which is precisely
   * the "duplicate navigation" Stage 3B §9 forbids. This component owns the
   * SHELL around it: the desktop breakpoint, the column, the rail collapse and
   * the toggle's accessibility contract.
   */
  children: React.ReactNode;
}

/**
 * The desktop admin sidebar shell.
 *
 * Rendered only from `lg` up (`hidden lg:flex`); below that the console swaps in
 * `MobileDrawer`, so exactly one navigation is presented at any viewport. The
 * collapse animation duration comes from the admin token set, and the stylesheet
 * neutralises it under `prefers-reduced-motion` like every other transition.
 *
 * Collapsing does not remove the section names from the accessibility tree: the
 * rail hides each button's label visually (clipped, not `display: none`) in
 * `src/index.css`, so an icon-only button is still announced by its full name.
 */
export function AdminSidebar({
  collapsed,
  onToggleCollapsed,
  children,
}: AdminSidebarProps) {
  const toggleLabel = collapsed
    ? 'Expand navigation sidebar'
    : 'Collapse navigation sidebar';

  return (
    <aside
      className="r4m-admin-sidebar hidden min-w-0 lg:flex lg:flex-col lg:self-stretch"
      data-collapsed={collapsed ? 'true' : 'false'}
      style={{ transitionDuration: `${adminShellTransitionMs}ms` }}
    >
      <div id={ADMIN_SIDEBAR_NAV_ID} className="min-w-0 flex-1">
        {children}
      </div>

      <div className="mt-2 border-t border-[var(--appearance-border)] pt-2">
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          aria-controls={ADMIN_SIDEBAR_NAV_ID}
          aria-label={toggleLabel}
          title={toggleLabel}
          style={{ minHeight: adminTouchTarget }}
          className="flex w-full items-center gap-2 rounded-small px-3 py-2 text-caption font-bold text-[var(--appearance-text-muted)] transition-colors hover:bg-[var(--appearance-surface-muted)] hover:text-[var(--appearance-text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--appearance-primary)]"
        >
          {collapsed ? (
            <PanelLeftOpen
              size={ICON_SIZE.ui}
              aria-hidden="true"
              className="shrink-0"
            />
          ) : (
            <PanelLeftClose
              size={ICON_SIZE.ui}
              aria-hidden="true"
              className="shrink-0"
            />
          )}
          <span className="r4m-admin-sidebar-toggle-label truncate">
            {collapsed ? 'Expand' : 'Collapse'}
          </span>
        </button>
      </div>
    </aside>
  );
}

export default AdminSidebar;
