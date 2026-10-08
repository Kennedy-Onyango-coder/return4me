/**
 * RECOVERY FEE ENGINE
 * ===================
 * Replaces a single flat per-category fee with a small, explainable formula:
 *
 *   rawFee   = base_fee + complexity_fee + delay_fee   (all admin-configured per category)
 *   totalFee = declaredValue
 *                ? min(rawFee, declaredValue * ceiling_percent / 100)
 *                : rawFee
 *
 * Recovering an item should cost substantially less than replacing it — the
 * ceiling only ever pulls totalFee DOWN from rawFee, never up, and only
 * applies when the finder supplied a declared replacement value. Declared
 * value is an unverified estimate (the finder's own guess), so it is used
 * only to cap the fee in the owner's favour, never to inflate it.
 *
 * The split (finder_pct / agent_pct / platform_pct) is applied to totalFee,
 * not to the item's value — so the split never depends on how expensive the
 * item is, which is the actual point: an item's value must never change how
 * much a finder stands to gain, or it creates an incentive to "find" (i.e.
 * steal, then plant) expensive items. finder_reward_cap enforces the same
 * thing from the other direction — an absolute KES ceiling on the finder's
 * cut regardless of totalFee. Any amount trimmed by that cap is added to the
 * platform's share (not the agent's) so the three shares still always sum to
 * exactly totalFee — the ledger must balance to the cent, and no single
 * component should silently absorb another's rounding.
 *
 * What this deliberately does NOT do: invent a dynamic "how complex is this
 * claim" or "how many days has this been sitting here" signal. Those aren't
 * knowable at report time — complexity/delay are flat, admin-set amounts per
 * category (e.g. a passport's complexity_fee is higher than a wallet's
 * because verifying a passport genuinely takes more agent time), not a
 * fabricated real-time score.
 *
 * ---------------------------------------------------------------------------
 * THE TWO PRICING MODES (one category is in EXACTLY one of them)
 * ---------------------------------------------------------------------------
 * This engine is MODE 2. A category is in MODE 1 instead whenever
 * `is_admin_modified` is TRUE, and MODE 1 always wins. That single boolean is
 * the only thing that selects the mode — NOT which field the administrator
 * happened to edit. The distinction is now named and asserted in ONE place
 * (resolveCategoryPricingMode / resolveItemLockedPricing below) so the new-item
 * pricing path cannot drift from what the admin console claims is happening:
 *
 *   MODE 1 — FLAT / ADMIN OVERRIDE   (is_admin_modified === true)
 *     locked_total_fee      = category.total_fee
 *     locked_finder_share   = category.finder_share
 *     locked_agent_share    = category.agent_share
 *     locked_platform_share = category.platform_share
 *     Everything in FeeEngineCategoryInput is IGNORED for pricing.
 *
 *   MODE 2 — RECOVERY FEE ENGINE     (is_admin_modified === false)
 *     locked_* come from computeRecoveryFee(). The four flat fields above are
 *     stored (they are NOT NULL columns, and legacy items with NULL locked_*
 *     still fall back to them) but they are NOT what prices a new item, so the
 *     admin console must never present them as authoritative in this mode.
 *
 * WHY THIS IS WORTH NAMING RATHER THAN LEAVING AS AN `if`: an administrator
 * changed a category's visible Total Fee from KES 200 to KES 100, the save
 * succeeded, and the next reported item still locked KES 200 — because the
 * category was in MODE 2, where the flat Total Fee it had just edited is not
 * what prices anything. The mode must therefore be explicit to the admin, and
 * the resolution must exist as one testable unit rather than as an inline
 * condition in the report route.
 */

export interface FeeBreakdown {
  totalFee: number;
  finderAmount: number;
  agentAmount: number;
  platformAmount: number;
  ceilingApplied: boolean;
  rawFee: number;
  ceilingValue: number | null;
  finderCapApplied: boolean;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface FeeEngineCategoryInput {
  base_fee: number;
  complexity_fee: number;
  delay_fee: number;
  ceiling_percent: number;
  finder_pct: number;
  agent_pct: number;
  platform_pct: number;
  finder_reward_cap: number | null;
}

export function computeRecoveryFee(
  category: FeeEngineCategoryInput,
  declaredValue: number | null
): FeeBreakdown {
  const base = Number(category.base_fee) || 0;
  const complexity = Number(category.complexity_fee) || 0;
  const delay = Number(category.delay_fee) || 0;
  const rawFee = round2(base + complexity + delay);

  let totalFee = rawFee;
  let ceilingApplied = false;
  let ceilingValue: number | null = null;

  if (declaredValue !== null && declaredValue !== undefined && !isNaN(declaredValue) && declaredValue > 0) {
    const ceilingPct = Number(category.ceiling_percent) || 0;
    ceilingValue = round2((declaredValue * ceilingPct) / 100);
    if (ceilingValue < rawFee) {
      totalFee = ceilingValue;
      ceilingApplied = true;
    }
  }

  // Never let a misconfigured or zero ceiling produce a KES 0 (or negative)
  // fee — fail safe toward the raw fee rather than silently waiving it.
  if (totalFee <= 0) {
    totalFee = rawFee;
    ceilingApplied = false;
  }

  const finderPct = Number(category.finder_pct) || 0;
  const agentPct = Number(category.agent_pct) || 0;

  let finderAmount = round2((totalFee * finderPct) / 100);
  let finderCapApplied = false;
  const cap = category.finder_reward_cap !== null && category.finder_reward_cap !== undefined
    ? Number(category.finder_reward_cap)
    : null;
  if (cap !== null && !isNaN(cap) && finderAmount > cap) {
    finderAmount = round2(cap);
    finderCapApplied = true;
  }

  let agentAmount = round2((totalFee * agentPct) / 100);

  // Platform absorbs whatever is left — including finder-cap overflow and
  // rounding — so finder + agent + platform always sums to exactly totalFee.
  // This is a deliberate design choice (see module docstring): never the
  // agent, always the platform, and always computed as a residual rather
  // than its own independent rounding, so the three numbers are guaranteed
  // to reconcile without a manual balancing step.
  let platformAmount = round2(totalFee - finderAmount - agentAmount);
  if (platformAmount < 0) {
    // Defensive: a badly misconfigured category (pcts summing well over 100)
    // could otherwise produce a negative platform share. Never let that
    // happen — clamp platform to 0 and pull the shortfall back out of the
    // agent share first, then the finder share, rather than paying out more
    // than totalFee.
    const shortfall = -platformAmount;
    platformAmount = 0;
    const fromAgent = Math.min(agentAmount, shortfall);
    agentAmount = round2(agentAmount - fromAgent);
    const remaining = shortfall - fromAgent;
    if (remaining > 0) {
      finderAmount = round2(Math.max(0, finderAmount - remaining));
    }
  }

  return {
    totalFee,
    finderAmount,
    agentAmount,
    platformAmount,
    ceilingApplied,
    rawFee,
    ceilingValue,
    finderCapApplied,
  };
}

// ---------------------------------------------------------------------------
// THE MODE CONTRACT — ONE definition of "which pricing mode is this category
// in", and ONE definition of "what will a NEW item lock".
// ---------------------------------------------------------------------------

/** MODE 1 — the four flat fields on the category are authoritative. */
export const PRICING_MODE_FLAT_ADMIN_OVERRIDE = 'flat_admin_override';
/** MODE 2 — computeRecoveryFee() prices every new item. */
export const PRICING_MODE_RECOVERY_FEE_ENGINE = 'recovery_fee_engine';

export type CategoryPricingMode =
  | typeof PRICING_MODE_FLAT_ADMIN_OVERRIDE
  | typeof PRICING_MODE_RECOVERY_FEE_ENGINE;

/**
 * The ONE place the mode is decided.
 *
 * `is_admin_modified === true` is MODE 1 and wins outright. Every other value —
 * false, undefined, null, anything not strictly `true` — is MODE 2, which is
 * the column default and therefore the fail-safe direction: an absent or
 * malformed flag never silently switches a category into "these flat numbers
 * are authoritative".
 */
export function resolveCategoryPricingMode(
  category: { is_admin_modified?: boolean | null } | null | undefined,
): CategoryPricingMode {
  return category && category.is_admin_modified === true
    ? PRICING_MODE_FLAT_ADMIN_OVERRIDE
    : PRICING_MODE_RECOVERY_FEE_ENGINE;
}

/** The four flat/admin pricing values a category must carry (NOT NULL columns). */
export interface FlatPricingInput {
  total_fee: number | string;
  finder_share: number | string;
  agent_share: number | string;
  platform_share: number | string;
}

export interface ItemLockedPricing {
  mode: CategoryPricingMode;
  totalFee: number;
  finderShare: number;
  agentShare: number;
  platformShare: number;
  /** Only ever true in MODE 2 (the flat override has no ceiling concept). */
  ceilingApplied: boolean;
}

/**
 * What a NEW item reported under this category locks in — the exact values the
 * Finder report route writes to items.locked_total_fee / locked_finder_share /
 * locked_agent_share / locked_platform_share.
 *
 * This is the ONE implementation of the two modes. The report route calls it to
 * price a real item, and the admin category route calls it (with no declared
 * value) to tell the administrator what a new item will lock — so the number the
 * console shows and the number the server charges come from the same function
 * and cannot disagree.
 *
 * History is NOT affected: this only ever describes a NEW item. An item that was
 * already reported keeps the values locked onto it at report time, whatever the
 * category says today.
 */
export function resolveItemLockedPricing(
  category: FeeEngineCategoryInput & FlatPricingInput & { is_admin_modified?: boolean | null },
  declaredValue: number | null,
): ItemLockedPricing {
  if (resolveCategoryPricingMode(category) === PRICING_MODE_FLAT_ADMIN_OVERRIDE) {
    return {
      mode: PRICING_MODE_FLAT_ADMIN_OVERRIDE,
      totalFee: Number(category.total_fee),
      finderShare: Number(category.finder_share),
      agentShare: Number(category.agent_share),
      platformShare: Number(category.platform_share),
      ceilingApplied: false,
    };
  }

  const breakdown = computeRecoveryFee(category, declaredValue);
  return {
    mode: PRICING_MODE_RECOVERY_FEE_ENGINE,
    totalFee: breakdown.totalFee,
    finderShare: breakdown.finderAmount,
    agentShare: breakdown.agentAmount,
    platformShare: breakdown.platformAmount,
    ceilingApplied: breakdown.ceilingApplied,
  };
}
