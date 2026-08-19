import { describe, it, expect } from 'vitest';
import { computeRecoveryFee, FeeEngineCategoryInput } from '../feeEngine';

// The Recovery Fee Engine is the single source of truth for how much an
// owner pays and how it's split — a bug here either overcharges an owner,
// underpays a finder/agent, or breaks the invariant that finder+agent+
// platform must sum to exactly totalFee (money literally doesn't balance).
// These tests pin down the financial-integrity guarantees the module
// docstring promises, not just its happy path.

const baseCategory: FeeEngineCategoryInput = {
  base_fee: 300,
  complexity_fee: 100,
  delay_fee: 50,
  ceiling_percent: 12,
  finder_pct: 25,
  agent_pct: 35,
  platform_pct: 40,
  finder_reward_cap: null,
};

describe('computeRecoveryFee', () => {
  it('uses rawFee (base+complexity+delay) when no declared value is given', () => {
    const result = computeRecoveryFee(baseCategory, null);
    expect(result.totalFee).toBe(450); // 300 + 100 + 50
    expect(result.ceilingApplied).toBe(false);
  });

  it('applies the ceiling when it is lower than rawFee', () => {
    // 12% of 2000 = 240, which is less than rawFee (450)
    const result = computeRecoveryFee(baseCategory, 2000);
    expect(result.totalFee).toBe(240);
    expect(result.ceilingApplied).toBe(true);
    expect(result.ceilingValue).toBe(240);
  });

  it('never raises the fee above rawFee even with a very high declared value', () => {
    // 12% of 100000 = 12000, far above rawFee (450) — ceiling should never win here
    const result = computeRecoveryFee(baseCategory, 100000);
    expect(result.totalFee).toBe(450);
    expect(result.ceilingApplied).toBe(false);
  });

  it('finder + agent + platform always sum to exactly totalFee (no declared value)', () => {
    const result = computeRecoveryFee(baseCategory, null);
    const sum = result.finderAmount + result.agentAmount + result.platformAmount;
    expect(sum).toBeCloseTo(result.totalFee, 2);
  });

  it('finder + agent + platform always sum to exactly totalFee (ceiling applied)', () => {
    const result = computeRecoveryFee(baseCategory, 500); // ceiling = 60, well under rawFee
    const sum = result.finderAmount + result.agentAmount + result.platformAmount;
    expect(sum).toBeCloseTo(result.totalFee, 2);
  });

  it('splits totalFee by the configured percentages', () => {
    const result = computeRecoveryFee(baseCategory, null);
    expect(result.finderAmount).toBeCloseTo(450 * 0.25, 2);
    expect(result.agentAmount).toBeCloseTo(450 * 0.35, 2);
  });

  it('applies the finder reward cap and routes the overflow to the platform, never the agent', () => {
    const capped: FeeEngineCategoryInput = { ...baseCategory, finder_reward_cap: 50 };
    const result = computeRecoveryFee(capped, null);
    expect(result.finderCapApplied).toBe(true);
    expect(result.finderAmount).toBe(50);
    // agent share is untouched by the finder cap
    expect(result.agentAmount).toBeCloseTo(450 * 0.35, 2);
    // platform absorbed the difference between the uncapped finder share and the cap
    const uncappedFinder = 450 * 0.25;
    expect(result.platformAmount).toBeCloseTo(450 * 0.40 + (uncappedFinder - 50), 2);
    const sum = result.finderAmount + result.agentAmount + result.platformAmount;
    expect(sum).toBeCloseTo(result.totalFee, 2);
  });

  it('an item-specific declared value never changes the split percentages, only the ceiling', () => {
    // Two identical categories, one for a cheap item and one for an
    // expensive one, both under their own ceiling — the finder/agent/
    // platform percentages must be identical regardless of item value.
    // This is the core anti-fraud property: a finder's cut is never a
    // function of how expensive the item is.
    const cheap = computeRecoveryFee(baseCategory, 10000); // ceiling well above rawFee, doesn't bind
    const expensive = computeRecoveryFee(baseCategory, 1000000); // same, doesn't bind
    expect(cheap.finderAmount).toBe(expensive.finderAmount);
    expect(cheap.totalFee).toBe(expensive.totalFee);
  });

  it('falls back to rawFee if a misconfigured ceiling would produce a zero or negative fee', () => {
    const zeroCeiling: FeeEngineCategoryInput = { ...baseCategory, ceiling_percent: 0 };
    const result = computeRecoveryFee(zeroCeiling, 1000);
    expect(result.totalFee).toBe(450); // falls back to rawFee, never KES 0
    expect(result.ceilingApplied).toBe(false);
  });

  it('defensively clamps when finder_pct + agent_pct + platform_pct sum to over 100', () => {
    const misconfigured: FeeEngineCategoryInput = { ...baseCategory, finder_pct: 60, agent_pct: 60, platform_pct: 60 };
    const result = computeRecoveryFee(misconfigured, null);
    const sum = result.finderAmount + result.agentAmount + result.platformAmount;
    // Even with wildly misconfigured percentages, the three shares must
    // never sum to more than totalFee — money paid out can never exceed
    // money collected.
    expect(sum).toBeCloseTo(result.totalFee, 2);
    expect(result.platformAmount).toBeGreaterThanOrEqual(0);
    expect(result.agentAmount).toBeGreaterThanOrEqual(0);
    expect(result.finderAmount).toBeGreaterThanOrEqual(0);
  });

  it('ignores an invalid declared value (zero, negative, NaN) and falls back to rawFee', () => {
    expect(computeRecoveryFee(baseCategory, 0).totalFee).toBe(450);
    expect(computeRecoveryFee(baseCategory, -500).totalFee).toBe(450);
    expect(computeRecoveryFee(baseCategory, NaN).totalFee).toBe(450);
  });
});
