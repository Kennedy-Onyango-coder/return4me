import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { computeRecoveryFee } from '../services/feeEngine';

// =============================================================================
// CATEGORY FEE PREVIEW — the console must SHOW the split, using the ONE engine
// =============================================================================
// The requirement: an admin enters an amount and the configured percentages, and
// the console shows what those percentages actually pay out — without the admin
// doing the arithmetic, and WITHOUT a second financial calculation existing.
//
// These tests do two things:
//   1. prove the UI consumes `computeRecoveryFee()` and displays ITS results
//      (rather than hand-rolling amount × pct / 100);
//   2. pin the engine-backed numbers for the cases the requirement names, so a
//      displayed split that drifts from the engine fails here.
// =============================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
const adminTsx = read('src/components/AdminView.tsx');
const adminCode = adminTsx.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** A category configuration in the shape the engine consumes. */
const category = (over: Partial<Parameters<typeof computeRecoveryFee>[0]> = {}) => ({
  base_fee: 0,
  complexity_fee: 0,
  delay_fee: 0,
  ceiling_percent: 12,
  finder_pct: 25,
  agent_pct: 35,
  platform_pct: 40,
  finder_reward_cap: null,
  ...over,
});

describe('the preview is powered by the ONE authoritative fee engine', () => {
  it('AdminView imports computeRecoveryFee from the shared engine', () => {
    expect(adminTsx).toContain("import { computeRecoveryFee } from '../services/feeEngine'");
  });

  it('the preview feeds the form values into the engine and displays ITS outputs', () => {
    for (const field of [
      'base_fee: Number(catFormBaseFee) || 0',
      'complexity_fee: Number(catFormComplexityFee) || 0',
      'delay_fee: Number(catFormDelayFee) || 0',
      'finder_pct: Number(catFormFinderPct) || 0',
      'agent_pct: Number(catFormAgentPct) || 0',
      'platform_pct: Number(catFormPlatformPct) || 0',
    ]) {
      expect(adminCode, `preview must feed ${field} to the engine`).toContain(field);
    }
    for (const out of [
      'kes(enginePreview.totalFee)',
      'kes(enginePreview.finderAmount)',
      'kes(enginePreview.agentAmount)',
      'kes(enginePreview.platformAmount)',
      'kes(enginePreviewSplitTotal)',
    ]) {
      expect(adminCode, `preview must render ${out}`).toContain(out);
    }
  });

  it('the preview does NOT hand-roll the split formula (no second implementation)', () => {
    expect(adminCode).not.toMatch(/catFormFinderPct\s*\)\s*\/\s*100/);
    expect(adminCode).not.toMatch(/catFormAgentPct\s*\)\s*\/\s*100/);
    expect(adminCode).not.toMatch(/catFormPlatformPct\s*\)\s*\/\s*100/);
    expect(adminCode).not.toMatch(/\*\s*catFormFinderPct/);
  });

  it('keeps the browser non-authoritative in its messaging', () => {
    expect(adminTsx).toMatch(/never the financial authority/);
  });
});

describe('Case 1 — normal split (1000 at 25 / 35 / 40)', () => {
  const fee = computeRecoveryFee(category({ base_fee: 1000 }), null);

  it('prices the claim fee at the configured amount and splits it as configured', () => {
    expect(fee.totalFee).toBe(1000);
    expect(fee.finderAmount).toBe(250);
    expect(fee.agentAmount).toBe(350);
    expect(fee.platformAmount).toBe(400);
  });

  it('reconciles: finder + agent + platform === claim fee', () => {
    expect(fee.finderAmount + fee.agentAmount + fee.platformAmount).toBe(fee.totalFee);
  });
});

describe('Case 2 — rounding is the engine’s, at 2 decimals', () => {
  const fee = computeRecoveryFee(category({ base_fee: 333.33 }), null);

  it('rounds each share to 2 decimals exactly as the engine reports', () => {
    expect(fee.totalFee).toBe(333.33);
    expect(fee.finderAmount).toBe(83.33);
    expect(fee.agentAmount).toBe(116.67);
    expect(fee.platformAmount).toBe(133.33);
  });

  it('still reconciles to the cent after rounding', () => {
    expect(Number((fee.finderAmount + fee.agentAmount + fee.platformAmount).toFixed(2))).toBe(fee.totalFee);
  });

  it('the preview reuses the engine’s rounding rather than rounding again', () => {
    expect(adminCode).not.toMatch(/Math\.round\([\s\S]{0,60}enginePreview/);
  });
});

describe('Case 3 — finder reward cap', () => {
  const fee = computeRecoveryFee(category({ base_fee: 1000, finder_reward_cap: 100 }), null);

  it('caps the finder share and lets the platform absorb the difference', () => {
    expect(fee.finderCapApplied).toBe(true);
    expect(fee.finderAmount).toBe(100);
    expect(fee.agentAmount).toBe(350);
    expect(fee.platformAmount).toBe(550);
  });

  it('still reconciles to the claim fee', () => {
    expect(fee.finderAmount + fee.agentAmount + fee.platformAmount).toBe(fee.totalFee);
  });

  it('the preview surfaces the cap to the admin', () => {
    expect(adminCode).toContain('enginePreview.finderCapApplied');
    expect(adminTsx).toMatch(/Finder reward cap applied/);
  });
});

describe('Case 4 — percentages that do not total 100 are still reconciled (existing model)', () => {
  // 20 + 30 + 20 = 70. The engine deliberately makes PLATFORM the residual, so
  // the three shares still sum to the fee. This pins the EXISTING architecture
  // rather than imposing a new "must total 100" rule.
  const fee = computeRecoveryFee(
    category({ base_fee: 1000, finder_pct: 20, agent_pct: 30, platform_pct: 20 }),
    null,
  );

  it('platform absorbs the remainder so the ledger still balances', () => {
    expect(fee.finderAmount).toBe(200);
    expect(fee.agentAmount).toBe(300);
    expect(fee.platformAmount).toBe(500);
    expect(fee.finderAmount + fee.agentAmount + fee.platformAmount).toBe(1000);
  });

  it('the existing non-100% warning is retained in the form', () => {
    expect(adminTsx).toContain('not 100%');
  });

  it('the preview warns if the three shares ever fail to reconcile', () => {
    expect(adminCode).toContain('enginePreviewSplitTotal !== enginePreview.totalFee');
  });
});

describe('Case 5 — an empty/incomplete form is NOT given a fabricated fee', () => {
  it('the engine reports zero for an unconfigured category (the baseline being guarded)', () => {
    const fee = computeRecoveryFee(category(), null);
    expect(fee.totalFee).toBe(0);
    expect(fee.finderAmount + fee.agentAmount + fee.platformAmount).toBe(0);
  });

  it('the preview distinguishes "not yet calculable" from a computed value', () => {
    // An unconfigured form must show a prompt, not "KES 0.00" dressed up as a fee.
    expect(adminCode).toContain('catFormAmountEntered');
    expect(adminTsx).toMatch(/Enter an amount|not yet calculable/i);
  });

  it('the KES formatter is not applied in the not-yet-calculable branch', () => {
    // Structural proof: the prompt branch is chosen before any kes() call.
    const enterIdx = adminCode.indexOf('catFormAmountEntered ?');
    const kesIdx = adminCode.indexOf('kes(enginePreview.totalFee)');
    expect(enterIdx).toBeGreaterThan(-1);
    expect(kesIdx).toBeGreaterThan(enterIdx);
  });
});
