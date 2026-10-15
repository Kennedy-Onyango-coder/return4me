import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// B1 — truthful handover language + safe earnings display.
//
// Source-contract tests (matching the other agent suites): no DOM harness, so the
// shipped source is asserted directly. Workstream A pins the corrected handover
// wording; Workstream B pins the safe-money wiring and its pure helper.
// =============================================================================

const root = path.resolve(import.meta.dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(root, rel), 'utf8');

const AGENT_VIEW = read('src/components/AgentView.tsx');
const HUB = read('src/components/agent/AgentHub.tsx');
const FORMAT = read('src/utils/formatMoney.ts');

describe('B1 — truthful handover language', () => {
  it('never promises that confirming a handover releases or pays money', () => {
    expect(AGENT_VIEW).not.toMatch(/release payment/i);
    expect(AGENT_VIEW).not.toContain('Confirm & Release Payment');
  });

  it('labels the handover action by what it actually does', () => {
    expect(AGENT_VIEW).toContain("('Confirm Handover')");
  });

  it('explains the pending-settlement outcome in the pickup-code modal', () => {
    expect(AGENT_VIEW).toContain('confirm the handover');
    expect(AGENT_VIEW).toContain('pending settlement');
    expect(AGENT_VIEW).toContain('not released');
  });
});

describe('B1 — safe earnings display wiring', () => {
  it('routes every earnings figure through the safe formatter', () => {
    expect(HUB).toContain("import { formatEarnings, isFiniteNumber } from '../../utils/formatMoney';");
    expect(HUB).toContain('formatEarnings(props.agentEarnings?.totalEarned)');
    expect(HUB).toContain('formatEarnings(props.agentEarnings?.pendingSettlementEarnings)');
  });

  it('keeps the fallback and the finite-number guard in the shared helper', () => {
    expect(FORMAT).toContain('Number.isFinite');
    expect(FORMAT).toContain('Earnings temporarily unavailable');
  });
});
