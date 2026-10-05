# Return4me Design System

**Status:** authoritative as of **UX-01**. One visual language for the whole
platform: public pages, the authenticated workspace (account / agent / admin),
and every shared control.

This document is the reference for how Return4me looks on purpose. It describes
what exists in code today, where the single source of truth lives, and which
screens are still legacy (with the batch that will migrate them).

- Token source of truth: **`src/index.css`** (`@theme` + `:root` +
  `html[data-theme='dark']`).
- Shared primitives: **`src/components/ui/*`**, imported from
  `@/components/ui` (never reach into the individual files from a view).
- Guard tests: `src/utils/__tests__/designSystemTokens.test.ts`,
  `src/components/ui/__tests__/designSystemPrimitives.test.ts`,
  `src/utils/__tests__/contrastTokens.test.ts`,
  `src/__tests__/focusContract.test.ts`.

Nothing in this document is a new dependency or a new visual direction. It is
the consolidation of the brand the product already had: deep green, restrained
orange accent, warm cream/beige canvas, white/light surfaces, dark-mode
equivalents, real Return4me photography, Lucide iconography, and
**Plus Jakarta Sans** (`--font-sans`) with **JetBrains Mono** (`--font-mono`)
for machine identifiers.

---

## 1. Typography

Ten named steps. **12px is the floor** — no normal visible Return4me UI uses
9px, 10px or 11px.

| Utility | Size / line-height | Role |
| --- | --- | --- |
| `text-caption` | 12 / 16 | labels, eyebrows, metadata, badges |
| `text-small` | 13 / 18 | dense secondary text, helper copy |
| `text-body` | 14 / 20 | default UI text (identical to `text-sm`) |
| `text-body-large` | 16 / 24 | long-form body copy |
| `text-heading` | 18 / 26 | card / dialog / section heading (`h2`) |
| `text-subsection` | 20 / 28 | subsection |
| `text-section` | 24 / 32 | section (identical to `text-2xl`) |
| `text-page` | 32 / 40 | page |
| `text-display` | 40 / 48 | display |
| `text-hero` | 48 / 56 | exceptional hero display only |

Weights: `400` body · `500` supporting/UI · `600` card headings · `700`
buttons and important labels · `800` major headings.

Rules:
- Foundation code uses the **named** steps, so there is one place to change
  type. A raw `text-[Npx]` in new code is a defect.
- The retired 28px `display` step had zero consumers and was moved onto the
  real 40/48 display step; it was never on the ladder.
- `text-lg` (18/28) and `text-heading` (18/26) are the same size with different
  leading — prefer `text-heading` for headings so the leading stays locked.

## 2. Spacing

The rhythm is Tailwind's 4px base — there is deliberately **no parallel
`--spacing-*` namespace**, because a token declared but never consumed lies
about being used. The convention is the numeric utility:

```
1 = 4    2 = 8    3 = 12   4 = 16   5 = 20   6 = 24
8 = 32   10 = 40  12 = 48  16 = 64  20 = 80
```

Favour the 8-point rhythm (`2/4/6/8/10/12/16/20`). Never invent a value
(`p-[13px]`, `gap-[7px]`) — pick the nearest step. Viewport-relative limits
(`max-h-[90vh]`) and deliberate control sizes (`min-h-[88px]` textarea) are not
spacing and are allowed.

## 3. Radius

| Utility | Value | Use |
| --- | --- | --- |
| `rounded-compact` | 6px | compact controls |
| `rounded-small` | 8px | small controls / compact surfaces |
| `rounded-standard` | 12px | **standard controls and cards (the default)** |
| `rounded-panel` | 16px | larger cards / workspaces |
| `rounded-hero` | 24px | major visual surfaces / hero containers |

Each value is byte-identical to the Tailwind default it replaces
(`md` 6 / `lg` 8 / `xl` 12 / `2xl` 16 / `3xl` 24), so adopting a token is a
rename, never a repaint. `rounded-full` is reserved for genuinely round
things: status pills (Badge), step dots and progress rails (Stepper), avatars,
icon buttons. Anything else is a defect.

## 4. Colour semantics

Semantic roles, defined in **both** `:root` and `html[data-theme='dark']`.
Screens consume roles, never screen-specific literals.

| Role | Purpose |
| --- | --- |
| `--appearance-background` | page canvas |
| `--appearance-surface` | card / control surface |
| `--appearance-surface-muted` | quiet surface (badge fill, empty state) |
| `--appearance-surface-elevated` | floating layer above the canvas |
| `--appearance-text-primary` / `-secondary` / `-muted` | text hierarchy |
| `--appearance-border` / `--appearance-border-strong` | structural separation |
| `--appearance-primary` / `-hover` / `-foreground` | primary action |
| `--appearance-accent` / `-hover` / `-foreground` | rare emphasis |
| `--appearance-success` / `-warning` / `-danger` / `-info` | status (+`-foreground`) |
| `--appearance-focus` | focus indicator |
| `--appearance-scrim` | dialog/modal backdrop |

Balance the screen as roughly **90% neutral surfaces and content, 8% green
hierarchy, 2% orange emphasis**. Orange is a meaningful accent, not decoration:
it is not used for every button, icon, badge, border and heading, and it is
never a text background — the text-safe orange steps are `--color-accent-strong`
(`#B35A00`) and `--color-accent-strong-hover` (`#8F4800`), enforced by
`contrastTokens.test.ts`.

Status meaning is **never carried by colour alone**: every status surface pairs
its colour with an icon and a readable label.

## 5. Surfaces, borders, shadows

Hierarchy, in order of preference: **flat surface → subtle border → subtle
shadow → floating shadow.**

- Borders do the structural separation.
- There are exactly two elevation steps: `shadow-raised` (cards, tiles) and
  `shadow-floating` (overlays/dialogs). Their values live in `--elevation-*` so
  the same utility resolves differently in dark mode, where a light shadow
  reads as a halo.
- Out of brand: heavy drop shadows, glassmorphism, decorative gradients,
  excessive card elevation, random coloured borders.

## 6. Focus

One coherent keyboard language: the single global rule in `src/index.css`

```css
:focus-visible { outline: 2px solid var(--color-accent-orange); outline-offset: 2px; }
```

with a white outline on dark-green surfaces. Shared controls keep only a
`focus:border-*` mouse affordance; they must not carry their own
`focus:outline-none` or `focus:ring-*`, which is what produced the old
double-border look (guarded by `focusContract.test.ts` and the primitives
suite). The rule deliberately sets **no** `border-radius`, so the outline
follows each control's own radius instead of overriding it.

## 7. Buttons

`src/components/ui/Button.tsx` is the only button foundation.

Variants: `primary` (one primary action per view) · `secondary` (supporting
confirmations) · `accent` (reserved for the important financial / recovery
CTA — M-Pesa escrow actions) · `outline` · `inverse` (dark/photographic
surfaces) · `ghost` (low priority) · `danger` (destructive only).

Sizes: `sm` 36px (`text-caption`) · `md` 44px default (`text-body`) · `lg` 52px
(`text-body-large`) — `md` already meets the 44px touch-target floor.
Never uppercase; labels are used verbatim. Loading, disabled and focus states
are built in; the spinner replaces the leading icon slot without shifting
layout, and the label stays rendered.

## 8. Form controls

`Input` · `Select` · `Textarea` · `OTPInput` share one anatomy: 1px
`--appearance-border`, `rounded-standard`, 44px height (`h-11`) for
input/select, `text-body` text, `--appearance-surface` fill, muted placeholder,
`focus:border-[var(--appearance-focus)]`, `disabled:opacity-50`, required
marker, `<label htmlFor>` wiring, helper text, and an error state that sets
`aria-invalid` + `aria-describedby` and announces through `role="alert"`.
`OTPInput` additionally keeps the numeric keyboard, paste-to-fill, and
arrow/backspace navigation the security flow depends on.

One exception is recorded here rather than left implicit. The customer sign-in
code field (UX-07) is a labelled single `Input` with
`autoComplete="one-time-code"`, **not** `OTPInput`, because `OTPInput` names
each box in hardcoded English (`Digit n of m`), sets `autoComplete="off"` for
every multi-box group — which is precisely what the platform SMS autofill the
journey relies on needs — and has no helper-text slot. Adopting it as it stands
would cost the customer journey its bilingual labelling and its hint. A later
batch closes the gap by giving `OTPInput` a bilingual label and hint contract;
until then the single labelled field is the deliberate choice, not an oversight.
The agent sign-in code field (UX-11) is the same labelled single `Input`, for the
same three reasons and with the same `autoComplete="one-time-code"`.

## 9. Badges and status

`src/components/ui/Badge.tsx`: `success` · `warning` · `pending` · `danger` ·
`info` · `neutral` · `code`. `pending` is the waiting state and resolves to the
same token pair as `warning`, so the two can never drift apart; it gets a clock
rather than a warning triangle. `code` renders mono for claim IDs, collection
codes and till numbers. Every status variant ships its semantic icon.
`Banner.tsx` carries the same vocabulary for inline messages (`success`,
`error`, `warning`, `info`) with `role="alert"` for the interruptive kinds and
`role="status"` otherwise.

Screens must not invent `bg-red-*` / `bg-green-*` / `bg-amber-*` / `bg-blue-*`
for status. Business-state terminology is unchanged and owned elsewhere.

## 10. Icons

Lucide only. Five sizes, exported as `ICON_SIZE` / `ICON_LADDER` from
`@/components/ui`:

| Step | px | Use |
| --- | --- | --- |
| `metadata` | 14 | dense metadata |
| `ui` | 16 | standard UI |
| `emphasis` | 18 | important UI |
| `heading` | 20 | buttons / headers |
| `feature` | 24 | prominent feature or action |

Decorative icons pass `aria-hidden="true"`. No decorative icon overload.

## 11. Motion

```
--motion-quick       150ms   ordinary interaction
--motion-standard    200ms   ordinary interaction (upper bound)
--motion-deliberate  300ms   deliberate transition
--motion-slow        400ms   deliberate transition (upper bound)
--ease-standard      cubic-bezier(0.2, 0, 0, 1)
```

`prefers-reduced-motion: reduce` is honoured globally in `src/index.css`
(animations and transitions are neutralised). No bounce, excessive scale,
repeated pulsing, gratuitous parallax, or animation that delays a task.

## 12. Modals and dialogs

`src/components/ui/Modal.tsx` is the only dialog foundation: `role="dialog"`,
`aria-modal="true"`, `aria-labelledby` with a visible (or `hideTitle`
screen-reader-only) heading, focus moved into the dialog on open, focus
restored on close, Tab trapped through the existing `utils/modalFocus.ts`,
Escape to close, backdrop click only on the backdrop itself, body scroll lock
with scrollbar compensation, a solid scrim (no backdrop blur), `rounded-panel`,
`shadow-floating`, and a footer action row. Its close button uses the single
global focus language; the container is a programmatic focus target and is
deliberately `outline-none`.

`window.prompt()` / `window.confirm()` are **not** part of the design system
(and no longer appear in AdminView's refund path).

## 13. Dashboards

`src/components/dashboard/DashboardShell.tsx` owns the authenticated workspace
foundation: workspace background, header/navigation surface, identity area,
content surface and heading hierarchy, with the public navigation deliberately
**absent** (not hidden). The public chrome and the authenticated chrome are two
different shells and this split must be preserved.

## 14. Legacy inventory (migration queue)

These pockets are known, classified, and deliberately **not** touched by UX-01.

| Area | Finding | Classification | Future queue |
| --- | --- | --- | --- |
| AdminView | 63 × 9/10/11px text, 61 × `stone-*`, 60 hand-built `<button>`, 30 `<input>`, one `window.prompt()` at the reject-reason step | MIGRATE LATER | UX-15 / UX-16 |
| AgentView + agent/* | 51 × `stone-*`, 19 hand-built buttons, hand-rolled panels; the signed-out **sign-in card** moved onto the primitives and the appearance tokens in UX-11, and its **registration fields** followed as a guided five-step application in UX-12 — the authenticated **Agent dashboard / Hub** moved onto the shared primitives and the appearance tokens in UX-13, leaving only the Batch-B verification/rejection panels | MIGRATE LATER | UX-16 |
| Agent registration (`/agent_portal`, signed-out card) | the registration fields became a five-step guided application — Account, Location, Verification, Payout, Review — on the shared `Stepper` rail, with one dominant action per step (the ONE existing submit), a per-step explanation of what is needed and why, a review that groups the same values and returns to any group, and bilingual copy throughout; the fields, their `required` rules, the N4 email guard, the 5MB photograph limits, the two endpoints, the 17-field verify-otp payload, the county/sub-county dependence, the document handling and the M-Pesa payout option values are all unchanged | MIGRATED in UX-12 (agent registration) | — |
| FinderView | UX-05 put the five-stage journey on the shared foundation (`Stepper` + `Input`/`Select`/`Button`) with the reviewed chrome on the appearance tokens. Still legacy: the category `<select>`, the photograph controls, the two GPS boxes and the legacy submit button | MIGRATE LATER | UX-16 |
| OwnerView | the customer claim / recovery journey (search → confidence gate → OTP → payment → handover) now sits on the shared primitives, the `Stepper` rail and the appearance tokens, with one dominant action per stage; residual: the Track-claim modal's hand-built button and the two `stone-*` shades on the dark thumbnail chip | MIGRATED in UX-09 (customer claim / recovery journey) | UX-16 |
| HomeView | hand-built buttons where the shared Button applies | MIGRATE LATER | UX-02 / UX-03 |
| PublicItemView | `bg-white` / `brand-*` / `status-*` literals, `rounded-2xl`, sub-ladder icon sizes (13/28/32), a local `focus-visible:ring-2`, and 14px metadata | MIGRATED in UX-06 (public item detail) | — |
| Public "Become an agent" page (`/becomeAgent`) | the public agent journey now explains the role in six ordered sections — the hero, why the role exists, the three responsibilities, the requirements, the three REAL approval stages on the shared `Stepper` rail, and one closing action — with one dominant apply action per screen and the fee share as the only economic claim; the only literals are the fixed brand pairing on the closing CTA band (`bg-primary-green` + `bg-white` / `brand-light-gray` / `primary-green`) | MIGRATED in UX-10 (public agent journey) | — |
| PrivacyView / TermsView | 88 / 11 × `stone-*`, ad-hoc headings | MIGRATE LATER | UX-17 |
| Navbar | 24 hand-built buttons, 2 × `shadow-[…]` literals | MIGRATE LATER | UX-02 |
| Authentication screens | customer registration / sign-in / activation and the **agent sign-in surface** now on the primitives and the appearance tokens; **admin authentication is a different audience and is untouched** | MIGRATED in UX-07 (customer authentication) · MIGRATED in UX-11 (agent sign-in) | — |
| Agent dashboard / Agent Hub (`/agent_portal`, signed-in workspace) | the authenticated operational workspace now opens with a calm workspace header and a three-tile operational summary derived ONLY from the two existing queues (drop-offs to receive, items in custody, claims waiting on the owner's payment), then the action queue in its established Receive—Release order with one real next-step control per item, deliberate empty states on the shared `EmptyState`, a reserved-layout `Skeleton` loading state, actionable error/retry channels and the appearance tokens throughout; no API contract, payload, DTO, state transition, custody rule, OTP/verification behaviour, payout value, county/sub-county behaviour or permission changed | MIGRATED in UX-13 (agent dashboard) | — |
| Agent sign in (`/agent_portal`, signed-out card) | one focused single-column authentication surface on the shared `Button` / `Input` / `Banner` primitives and the appearance tokens: a 44px pressed-state mode switch, a labelled credential field with `autoComplete`, the existing one-time-code step, ONE dominant action with a loading state, ONE error live region, and the restrained secondary route to the existing public agent journey; the endpoints, payloads, token, validation and error semantics are unchanged | MIGRATED in UX-11 (agent sign-in) | — |
| CustomerDashboard | `bg-white` / `brand-*` / `line-subtle` / `status-*` literals, `rounded-2xl` + `rounded-xl`, off-ladder `text-xs`/`text-sm`/`text-base`, sub-ladder icon sizes (13/14/16/17), two local `focus-visible:ring-2` rings, and an Overview whose section cards duplicated the navigation beside them | MIGRATED in UX-08 (customer dashboard) | — |
| `Modal` scroll lock + focus trap | already correct | FOUNDATION | — |
| `text-[11px]` in SectionHeading / StatCard | fixed in UX-01 (now `text-caption`) | FOUNDATION | — |
| Agent verification/rejection panels | legacy inline error boxes, raw `red-600` text | MIGRATE LATER | UX-16 |

## 15. Adding something new

1. Use an existing primitive and variant before creating anything.
2. If a new primitive is genuinely needed, build it from the tokens in
   `src/index.css` and export it from `src/components/ui/index.ts`.
3. Never introduce an off-ladder type size, radius, spacing value, colour,
   icon size or duration.
4. If a legacy screen needs redesign, record it in the queue table above —
   do not redesign the screen inside an unrelated batch.


