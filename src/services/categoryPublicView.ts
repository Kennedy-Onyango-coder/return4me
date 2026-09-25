// Hand-built PUBLIC DTO for a category (Phase 16.1 Batch 2 — CAT-09).
//
// WHY THIS EXISTS: `GET /api/categories` is unauthenticated, and it used to
// serialize the raw `categories` row — including the platform's internal
// operating configuration. An unauthenticated caller could read the Recovery Fee
// Engine's internals (base/complexity/delay inputs, the ceiling percentage, the
// payout split percentages, the finder reward cap), whether an administrator had
// customised a category, whether it is forced through manual review, and the
// document-number masking policy applied to its public posts. None of that is
// needed to choose a category, and several of those fields describe exactly how
// the platform defends itself.
//
// Every function here enumerates its allowed fields explicitly and never spreads
// a raw row, so a future column cannot leak by simply existing.
//
// WHAT IS PUBLIC, AND WHY (traced from the real consumers of this endpoint):
//   id, name_en, name_sw  — every selector and every category label
//                           (Finder, Owner, lost reports, Agent, homepage).
//   is_sensitive_document — the Finder's own form depends on it: it decides
//                           whether the document-number/name fields are shown and
//                           whether a photo is auto-scanned.
//   total_fee + the three shares
//                         — the OWNER'S PUBLISHED PRICE. OwnerView renders the
//                           escrow fee breakdown from exactly these four fields
//                           ("Finder Honorarium", "Physical Agent Hub Handling",
//                           "Return4me Escrow & Platform", total). This is a
//                           deliberately public figure, not an internal one.
//   sort_order            — the canonical display order (CAT-03), so a client
//                           can preserve it.
//
// WHAT IS DELIBERATELY ABSENT: is_admin_modified, elevated_review,
// public_clue_style, base_fee, complexity_fee, delay_fee, ceiling_percent,
// finder_pct, agent_pct, platform_pct, finder_reward_cap, and is_active (this
// endpoint only ever serves ACTIVE categories, so the field would carry no
// information).
//
// NOTE: this is the PUBLIC (unauthenticated) surface only. The ADMIN console
// reads `GET /api/admin/categories`, which deliberately keeps serializing the
// complete record (see getCategoriesWithUsage in db/database.ts).

export interface PublicCategoryView {
  id: string;
  name_en: string;
  name_sw: string;
  total_fee: number;
  finder_share: number;
  agent_share: number;
  platform_share: number;
  is_sensitive_document: boolean;
  sort_order: number;
}

/**
 * The public, unauthenticated view of a category.
 *
 * `is_sensitive_document` uses `!== false` (fail-closed) so a row that somehow
 * lacks the flag is treated as a sensitive document rather than silently
 * flipping the Finder's form into its non-document shape.
 */
export function toPublicCategoryView(category: any): PublicCategoryView | null {
  if (!category) return null;
  return {
    id: String(category.id),
    name_en: category.name_en ?? '',
    name_sw: category.name_sw ?? '',
    total_fee: Number(category.total_fee) || 0,
    finder_share: Number(category.finder_share) || 0,
    agent_share: Number(category.agent_share) || 0,
    platform_share: Number(category.platform_share) || 0,
    is_sensitive_document: category.is_sensitive_document !== false,
    sort_order: Number(category.sort_order) || 0,
  };
}
