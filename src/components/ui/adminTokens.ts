/*
 * Return4me Admin Design Tokens — Stage 3
 *
 * Admin-scoped design tokens derived from the Stage 2 blueprint.
 *
 * SCOPE, DELIBERATELY NARROW. The console already has a locked design system
 * (the index.css typography/radius ladders, the `--appearance-*` colour roles
 * and the UX-01 `ICON_SIZE` ladder). Nothing here redefines those: this module
 * adds only the measurements the shared admin SHELL needs and that no other
 * surface owns — the sidebar column widths, the drawer width, the shell's one
 * transition duration and its minimum touch target.
 *
 * Earlier Stage 3 drafts of this file also carried an `adminButton` table
 * (background/hover/text utilities per variant) and an `adminIcon` size map.
 * Both were removed here because they were DUPLICATES that could drift
 * silently: `Button.tsx` is the single owner of variant styling and `ICON_SIZE`
 * in `./iconSize` is the single owner of icon sizing. Two sources of truth for
 * one decision is exactly what the design system exists to prevent.
 *
 * The colour/type/spacing/radius/shadow scales are kept as values for any
 * future shell surface, but the shipped shell components express their colours
 * and radii through the existing `--appearance-*` CSS variables and the locked
 * Tailwind type steps, so dark mode keeps working through the same switch every
 * other screen already uses.
 */

/** The admin palette, mirroring the Stage 2 blueprint. Values only. */
export const adminColors = {
  // Slate neutrals (primary surface/text scheme)
  slate: {
    50: '#f8fafc',
    100: '#f1f5f9',
    200: '#e2e8f0',
    300: '#cbd5e1',
    400: '#94a3b8',
    500: '#64748b',
    600: '#475569',
    700: '#1e293b',
    800: '#0f172a',
    900: '#020617',
  },
  // Primary accent
  indigo: {
    50: '#eef2ff',
    100: '#e0e7ff',
    600: '#4f46e5',
    700: '#3730a3',
  },
  // Semantic tokens
  emerald: {
    50: '#f0fdf4',
    600: '#10b981',
    700: '#059669',
  },
  amber: {
    50: '#fffbeb',
    600: '#f59e0b',
    700: '#d97706',
  },
  rose: {
    50: '#fef2f2',
    600: '#ef4444',
    700: '#dc2626',
  },
  sky: {
    50: '#f0f9ff',
    600: '#0891b2',
    700: '#0e7490',
  },
} as const;

/** Admin typography scale (rem). The console renders these through the locked
 *  `text-caption` / `text-body` / `text-subsection` / `text-section` steps. */
export const adminTypography = {
  fontFamily: '"Inter", system-ui, -apple-system, sans-serif',
  fontSize: {
    xs: '0.75rem', // 12px
    sm: '0.875rem', // 14px
    base: '1rem', // 16px
    lg: '1.25rem', // 20px
    xl: '1.5rem', // 24px
    '2xl': '2rem', // 32px
    '3xl': '2.5rem', // 40px
  },
  fontWeight: {
    normal: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  },
  lineHeight: {
    normal: 1.5,
    tight: 1.25,
    relaxed: 1.625,
  },
} as const;

/** Admin spacing scale (4px base). */
export const adminSpacing = {
  1: '0.25rem', // 4px
  2: '0.5rem', // 8px
  3: '0.75rem', // 12px
  4: '1rem', // 16px
  5: '1.5rem', // 24px
  6: '2rem', // 32px
  8: '4rem', // 64px
  10: '5rem', // 80px
} as const;

/** Admin radius scale. */
export const adminRadius = {
  none: '0',
  sm: '0.125rem', // 2px
  md: '0.25rem', // 4px
  lg: '0.5rem', // 8px
  xl: '0.75rem', // 12px
  full: '9999px',
} as const;

/** Admin shadow scale (restrained — overlays only). */
export const adminShadow = {
  sm: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
  md: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
  lg: '0 10px 15px -3px rgba(0, 0, 0, 0.1)',
  xl: '0 20px 25px -5px rgba(0, 0, 0, 0.1)',
  none: 'none',
} as const;

/* --------------------------------------------------------------------------
 * SHELL MEASUREMENTS
 *
 * `expanded` is the long-standing 236px column already declared for
 * `.r4m-admin-nav` in src/index.css (`@media (min-width: 1024px)`). The
 * stylesheet keeps ownership of the RENDERED width — the collapsed rail is
 * applied by `.r4m-admin-shell[data-sidebar='collapsed']` — and this constant
 * documents the same value for JS callers so the two cannot drift apart
 * unnoticed.
 * -------------------------------------------------------------------------- */
export const adminSidebarWidth = {
  expanded: '236px',
  collapsed: '4.5rem', // 72px icon rail
} as const;

/** Mobile drawer width. `18rem` = 288px, capped further by `max-w-[85vw]` in
 *  the drawer, so a 360px phone still leaves the backdrop tappable. */
export const adminDrawerWidth = '18rem';

/** The single duration the shell animates with (ms). The stylesheet's
 *  `prefers-reduced-motion` rule neutralises it, as it does every transition. */
export const adminShellTransitionMs = 200;

/** The minimum touch target the shell keeps for its own controls (44px). */
export const adminTouchTarget = '44px';

/** Stable ids, so a trigger can point `aria-controls` at the surface it opens. */
export const ADMIN_SIDEBAR_NAV_ID = 'r4m-admin-sidebar-nav';
export const ADMIN_MOBILE_DRAWER_ID = 'r4m-admin-mobile-drawer';
