// =============================================================================
// WP2 follow-up — the honest active-agent label.
// =============================================================================
//
// The homepage trust strip states how many agents are active, and the number is
// only ever what `/api/stats` actually returned. App stores that response with
// `setActiveAgentsCount(data.activeAgentsCount)` — unvalidated JSON — so the
// value can arrive as `null`, as `undefined` (field missing, or a proxy/error
// payload), as a string, or as `NaN`/`Infinity` from a bad serialization.
//
// The original guard was `activeAgentsCount !== null`, which only rejected the
// one invalid case the TypeScript type mentioned. `undefined` passed the guard
// and rendered the literal words "undefined Active Agents" on the homepage.
//
// The rule this module states: render a count ONLY for a real, finite,
// non-negative number; otherwise describe where the network operates — the one
// claim the page can make without a number. No total is inferred, defaulted, or
// rounded to keep the strip looking busy.
// =============================================================================

/** The claim used when there is no trustworthy count. Location, never growth. */
export const ACTIVE_AGENT_FALLBACK_LABEL = 'Agent network in Kenya';

/**
 * Formats the active-agent trust-strip label.
 *
 * Accepts `unknown` on purpose: the argument is an unvalidated API field, and
 * typing it `number | null` would let the compiler promise something the wire
 * format does not.
 */
export function formatActiveAgentCount(count: unknown): string {
  // `typeof count === 'number'` alone would still admit NaN and ±Infinity, which
  // stringify as "NaN Active Agents" / "Infinity Active Agents".
  if (typeof count !== 'number' || !Number.isFinite(count)) {
    return ACTIVE_AGENT_FALLBACK_LABEL;
  }
  // A negative count is not a count. It is junk that must not become a claim.
  if (count < 0) {
    return ACTIVE_AGENT_FALLBACK_LABEL;
  }
  return `${count} Active Agents`;
}
