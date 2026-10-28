/**
 * MOBILE-FIRST BATCH B — the ONE field language for the two inline Agent panels.
 *
 * The verification and rejection panels are opened by an agent standing at a
 * hub counter, one-handed, usually on a phone. Every control inside them reads
 * these three constants, so the panels cannot drift apart and a later change is
 * made in exactly one place.
 *
 * WHY THESE RULES
 * ---------------
 *   * `min-h-11` — the 44px touch-target floor the shared `Button` (`md`) and
 *     `Input` already use. The previous controls (`p-2` + `text-xs`) measured
 *     roughly 30px tall, i.e. below the floor, on the two surfaces the agent
 *     actually operates.
 *   * `text-body` — 16px. Besides being a UX-01 ladder step, 16px is the
 *     smallest field font iOS Safari does not zoom to on focus, so tapping a
 *     field no longer makes the page jump on a phone.
 *   * `--appearance-*` roles only — the panels are correct in the dark theme.
 *     The literals they used (`border-stone-200`, `bg-white`, `bg-red-50/50`,
 *     `text-red-800`) were light-only, and `bg-white` on a dark surface made
 *     the rejection reason unreadable.
 *   * `break-words` on the "Finder: …" comparison notes — those render OCR
 *     names, document numbers and free-text locations. Without it a long
 *     unbroken value widened the panel past a 320px viewport.
 *
 * Presentation only: no value, validation rule, id, label association, live
 * region or handler lives here.
 */
export const FIELD_CLASS =
  'min-h-11 w-full rounded-standard border border-[var(--appearance-border)] bg-[var(--appearance-surface)] px-3 py-2 text-body text-[var(--appearance-text-primary)] placeholder:text-[var(--appearance-text-muted)] transition-colors focus:border-[var(--appearance-focus)]';

/** Field labels: the same caption/weight the shared `Input`/`Select` render. */
export const FIELD_LABEL_CLASS =
  'block text-caption font-bold text-[var(--appearance-text-secondary)]';

/** The "what the finder submitted" notes beside a correction field. */
export const FINDER_NOTE_CLASS =
  'min-w-0 break-words text-caption text-[var(--appearance-text-muted)]';
