/**
 * RETURN4ME ICON LADDER (UX-01 — the authoritative icon sizes).
 *
 * Lucide remains the only icon system. These five sizes are the only sizes the
 * design system uses, so an icon's weight communicates its importance the same
 * way the type scale does:
 *
 *   metadata 14  dense metadata (inline status, helper rows)
 *   ui       16  standard UI (inline with text, form affordances)
 *   emphasis 18  important UI (section icons, alert leads)
 *   heading  20  buttons / headers (a leading icon on a major action)
 *   feature  24  prominent feature or action (empty states, hero affordances)
 *
 * Why a module and not a comment: the numbers are now importable, so the
 * shared primitives read their size from one place and a later UX batch can
 * adopt the same ladder without re-deriving it. Decorative icons additionally
 * pass `aria-hidden="true"` so the ladder never encodes meaning on its own.
 */
export const ICON_SIZE = {
  metadata: 14,
  ui: 16,
  emphasis: 18,
  heading: 20,
  feature: 24,
} as const;

export type IconName = keyof typeof ICON_SIZE;

/** The ladder in ascending order — used by the design-system guard test. */
export const ICON_LADDER: readonly number[] = [
  ICON_SIZE.metadata,
  ICON_SIZE.ui,
  ICON_SIZE.emphasis,
  ICON_SIZE.heading,
  ICON_SIZE.feature,
];
