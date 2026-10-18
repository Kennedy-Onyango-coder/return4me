// =============================================================================
// WP2 follow-up — the active-agent label only claims a count it actually has.
// =============================================================================
//
// REGRESSION UNDER TEST
//   The trust strip read `activeAgentsCount !== null ? `${count} Active Agents`
//   : 'Agent network in Kenya'`. App fills that state from unvalidated JSON
//   (`setActiveAgentsCount(data.activeAgentsCount)`), and `undefined` passes
//   `!== null`, so a missing field rendered the literal text
//   "undefined Active Agents" on the homepage.
//
//   The guard is now a pure function, so the invalid inputs can be exercised
//   directly instead of being argued about in a comment.
// =============================================================================
import { describe, it, expect } from 'vitest';
import { ACTIVE_AGENT_FALLBACK_LABEL, formatActiveAgentCount } from '../agentCountLabel';

describe('formatActiveAgentCount — a count, or a location, never a guess', () => {
  it('renders the exact count for a real number, including zero', () => {
    // Zero is a real answer and must be shown: an empty network is information,
    // not a reason to fall back to the location claim.
    expect(formatActiveAgentCount(0)).toBe('0 Active Agents');
    expect(formatActiveAgentCount(1)).toBe('1 Active Agents');
    expect(formatActiveAgentCount(12)).toBe('12 Active Agents');
  });

  it('falls back when the count is missing (the undefined regression)', () => {
    // `undefined` is the value that used to slip through the `!== null` guard.
    expect(formatActiveAgentCount(undefined)).toBe(ACTIVE_AGENT_FALLBACK_LABEL);
    expect(formatActiveAgentCount(null)).toBe(ACTIVE_AGENT_FALLBACK_LABEL);
    // The fallback is a location, never a growth claim.
    expect(ACTIVE_AGENT_FALLBACK_LABEL).toBe('Agent network in Kenya');
  });

  it('falls back for non-numeric junk from the stats endpoint', () => {
    const junk: unknown[] = [
      '12',          // a stringified count
      '',            // empty string
      true,          // coerced boolean
      {},            // a payload shape change
      [],            // an array
    ];

    for (const value of junk) {
      const label = formatActiveAgentCount(value);
      expect(label, `${JSON.stringify(value)} must not become a claim`).toBe(ACTIVE_AGENT_FALLBACK_LABEL);
      // Nothing numeric may leak into the strip from an untrusted value.
      expect(label).not.toMatch(/\d/);
    }
  });

  it('falls back for numbers that cannot be a count', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
      const label = formatActiveAgentCount(value);
      expect(label, `${String(value)} must not become a claim`).toBe(ACTIVE_AGENT_FALLBACK_LABEL);
      // "NaN Active Agents" / "Infinity Active Agents" are exactly the strings
      // a `typeof === 'number'`-only guard would have produced.
      expect(label).not.toMatch(/NaN|Infinity|-\d/);
    }
  });
});
