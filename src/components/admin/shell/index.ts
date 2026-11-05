// BATCH B0 — admin shell barrel.
export { default as AdminTopBar } from './AdminTopBar';
export { default as AdminNavGroupLabel } from './AdminNavGroupLabel';

// STAGE 3 / 3B — the shared shell surfaces.
//   * AdminSidebar — the desktop (lg+) sidebar: column, sticky wrapper, numeric
//     collapse state and the rail toggle. Renders the console's own <nav> as
//     children so the one definition of each destination stays in AdminView.
//   * MobileDrawer — the sub-lg navigation drawer, rendered from the registry
//     and restricted to the sections the console can actually reach.
//   * Breadcrumb / PageHeader — the shared location + heading primitives.
export { AdminSidebar } from './AdminSidebar';
export type { AdminSidebarProps } from './AdminSidebar';
export { MobileDrawer } from './MobileDrawer';
export type { MobileDrawerProps } from './MobileDrawer';
export { Breadcrumb } from './Breadcrumb';
export type { BreadcrumbItem, BreadcrumbProps } from './Breadcrumb';
export { PageHeader } from './PageHeader';
export type { PageHeaderProps } from './PageHeader';

export {
  ADMIN_NAV_GROUPS,
  ADMIN_SECTION_IDS,
  describeAdminSection,
  describeAdminSectionCopy,
} from './adminNavRegistry';
export type {
  AdminSectionId,
  AdminNavGroup,
  AdminNavItem,
  AdminSectionCopy,
} from './adminNavRegistry';
