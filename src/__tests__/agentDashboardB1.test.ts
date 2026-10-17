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
const TYPES = read('src/types.ts');

// AGENT DASHBOARD BATCH 1 additions below. Same source-contract strategy as the
// rest of this file and the other agent suites: the shipped source is read
// directly (there is no DOM harness), comments are stripped wherever a prose
// sentence that DESCRIBES a guarantee must not be able to satisfy an assertion
// ABOUT it, and no snapshot and no line-number assertion is used.
const count = (src: string, needle: string | RegExp) => src.split(needle).length - 1;
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const HUB_CODE = stripComments(HUB);

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

// =============================================================================
// BATCH 1 — dashboard hierarchy and "what do I do first?".
//
// The redesign must make the page legible to an agent who is not a power user
// while staying strictly presentation-only: no new data source, no new state, no
// new business rule and no financial arithmetic in the browser. The earlier
// pinned batches (UX-07 work-before-identity, UX-13 operational summary) are
// honoured, so these tests assert that ordering is PRESERVED and that the groups
// are now NAMED instead of being re-ordered.
//
// Counts are asserted against comment-stripped source so a prose sentence that
// merely describes a guarantee cannot satisfy an assertion about it.
// =============================================================================

describe('Batch 1 — earnings are a named group, and the work still comes first', () => {
  it('gives the payout/earnings block a heading and a labelled section', () => {
    expect(HUB_CODE).toContain('aria-labelledby="agent-payout-earnings-heading"');
    expect(HUB_CODE).toMatch(/<section[^>]*aria-labelledby="agent-payout-earnings-heading"/);
    expect(HUB_CODE).toMatch(/<h2\s+id="agent-payout-earnings-heading"[\s\S]{0,300}t\.agentEarningsSectionTitle/);
  });

  it('states the one distinction an agent must not misread', () => {
    const intro = (TYPES.match(/agentEarningsSectionIntro: '([^']*)'/) ?? [])[1] ?? '';
    expect(intro.length).toBeGreaterThan(60);
    expect(intro).toMatch(/already paid out/);
    expect(intro).toMatch(/not paid yet/);
    // Pending settlement must never be described as spendable or approved money.
    expect(intro).not.toMatch(/approved|released|ready to withdraw|available to withdraw|received/i);
  });

  it('keeps the operational queues ahead of the identity/earnings group', () => {
    const work = HUB_CODE.indexOf('props.holdingPickups.map');
    expect(work).toBeGreaterThan(-1);
    expect(HUB_CODE.indexOf('props.agentProfile.business_name')).toBeGreaterThan(work);
    expect(HUB_CODE.indexOf('Total Earned (your commission share)')).toBeGreaterThan(work);
  });

  it('still counts the work with the three real summary tiles', () => {
    expect(count(HUB_CODE, '<StatCard')).toBe(3);
    expect(HUB_CODE).toContain('t.agentNeedsAttention');
  });
});

describe('Batch 1 — the dashboard says which queue to open first', () => {
  it('derives the guidance from the two queue props it already renders', () => {
    expect(HUB_CODE).toMatch(
      /props\.expectedDropoffs\.length > 0[\s\S]{0,200}t\.agentNextStepDropoffs[\s\S]{0,200}props\.holdingPickups\.length > 0[\s\S]{0,200}t\.agentNextStepHandovers[\s\S]{0,200}t\.agentNextStepAllClear/,
    );
    expect(HUB_CODE).toContain('t.agentWorkflowLabel');
  });

  it('orders the guidance receive-first, then release, then all-clear', () => {
    const receive = HUB_CODE.indexOf('t.agentNextStepDropoffs');
    const release = HUB_CODE.indexOf('t.agentNextStepHandovers');
    const clear = HUB_CODE.indexOf('t.agentNextStepAllClear');
    expect(receive).toBeLessThan(release);
    expect(release).toBeLessThan(clear);
    // Guidance sits above the queues it describes, and below the page title.
    expect(clear).toBeLessThan(HUB_CODE.indexOf('t.agentQueue}'));
    expect(receive).toBeGreaterThan(HUB_CODE.indexOf('t.agentWorkspaceTitle'));
  });

  it('calls an empty queue normal instead of sounding like a failure', () => {
    const clear = (TYPES.match(/agentNextStepAllClear: '([^']*)'/) ?? [])[1] ?? '';
    expect(clear).toMatch(/Nothing is waiting on you right now/);
    expect(clear).not.toMatch(/error|failed|problem|urgent|overdue/i);
  });

  it('ships each new string exactly once in the translation bundle', () => {
    const keys = [
      'agentNextStepDropoffs',
      'agentNextStepHandovers',
      'agentNextStepAllClear',
      'agentEarningsSectionTitle',
      'agentEarningsSectionIntro',
      'agentEarningsUnavailableNote',
    ];
    for (const key of keys) {
      expect(count(TYPES, `${key}: `)).toBe(1);
    }
  });

  it('adds no state, no timer, no fetch and no new counter to the Hub', () => {
    expect(HUB_CODE).not.toMatch(/\buse(State|Effect|Memo|Callback|Ref|Reducer)\s*\(/);
    expect(HUB_CODE).not.toMatch(/setInterval\(|setTimeout\(/);
    expect(HUB_CODE).not.toMatch(/agentApi|axios|\bfetch\(/);
    expect(HUB_CODE).not.toMatch(/\b(dropoffCount|pickupCount|queueCount|itemCount|totalCount|workCount|nextStepCount)\b/);
    // The pre-existing refresh affordances are untouched.
    expect(count(HUB_CODE, 'props.retryQueue')).toBeGreaterThanOrEqual(2);
  });
});

describe('Batch 1 — earnings stay truthful when a figure cannot be read', () => {
  it('keeps completed earnings separate from pending settlement', () => {
    const total = HUB_CODE.indexOf('formatEarnings(props.agentEarnings?.totalEarned)');
    const pending = HUB_CODE.indexOf('formatEarnings(props.agentEarnings?.pendingSettlementEarnings)');
    expect(total).toBeGreaterThan(-1);
    expect(pending).toBeGreaterThan(total);
    // Exactly one render site each: no figure is invented or duplicated.
    expect(count(HUB_CODE, 'formatEarnings(')).toBe(2);
    expect(HUB_CODE).toContain('not yet paid');
    expect(HUB_CODE).toContain('completed handovers paid out');
    expect(HUB_CODE).toContain('handovers awaiting settlement');
  });

  it('explains an unreadable figure instead of printing a made-up zero', () => {
    expect(HUB_CODE).toContain('t.agentEarningsUnavailableNote');
    expect(HUB_CODE).toMatch(/!isFiniteNumber\(props\.agentEarnings\?\.totalEarned\)/);
    expect(HUB_CODE).toMatch(/!isFiniteNumber\(props\.agentEarnings\?\.pendingSettlementsCount\)/);
    expect(FORMAT).toContain("'Earnings temporarily unavailable'");
    const note = (TYPES.match(/agentEarningsUnavailableNote: '([^']*)'/) ?? [])[1] ?? '';
    expect(note).toMatch(/unavailable/i);
    expect(note).toMatch(/instead of/i);
    expect(note).not.toMatch(/KES\s?0/);
  });

  it('renders no currency literal outside the shared formatter', () => {
    // Every amount goes through formatEarnings, so the Hub never spells a
    // currency amount or hardcodes a currency code itself.
    expect(HUB_CODE).not.toMatch(/\bKES\b/);
    expect(HUB_CODE).not.toMatch(/toLocaleString\(/);
  });

  it('performs no financial arithmetic in the browser', () => {
    expect(HUB_CODE).not.toMatch(/agentEarnings\?\.(totalEarned|pendingSettlementEarnings)\s*[-+*/]/);
    expect(HUB_CODE).not.toMatch(/(?<![A-Za-z])(Number|parseInt|parseFloat)\s*\(/);
    expect(HUB_CODE).not.toMatch(/netPayout|grossAmount|feeAmount|commissionRate/i);
  });
});

describe('Batch 1 — read-only payout details and every existing action remain intact', () => {
  it('shows payout details as text only, with no editing affordance', () => {
    expect(count(HUB_CODE, 'props.agentProfile.payout_method_type')).toBe(1);
    expect(count(HUB_CODE, 'props.agentProfile.mpesa_till_or_paybill')).toBe(1);
    // The only input on the Hub is still the drop-off code lookup field.
    expect(count(HUB_CODE, '<input')).toBe(1);
    expect(HUB_CODE).not.toMatch(/<input[\s\S]{0,200}(payout|mpesa|till|paybill|phone)/i);
    expect(HUB_CODE).not.toMatch(/editPayout|updatePayout|withdraw|setPayoutMethod/i);
  });

  it('leaves every operational action on its existing handler', () => {
    expect(count(HUB_CODE, 'handleLookupDropoff')).toBe(2);
    expect(count(HUB_CODE, 'openVerificationPanel')).toBe(2);
    expect(count(HUB_CODE, 'handleConfirmViewing')).toBe(2);
    expect(count(HUB_CODE, 'handleConfirmHandover')).toBe(2);
    expect(count(HUB_CODE, 'panelTriggerId')).toBe(3);
    expect(count(HUB_CODE, 'setOperationError(')).toBe(1);
  });

  it('keeps empty, loading, success and failure states distinct', () => {
    expect(count(HUB_CODE, '<EmptyState')).toBe(2);
    expect(count(HUB_CODE, 'role="alert"')).toBe(2);
    expect(HUB_CODE).toContain('props.actionSuccessMsg');
    expect(HUB_CODE).toContain('props.queueError');
    expect(count(HUB_CODE, 'agentQueueRefreshing')).toBe(1);
    expect(count(HUB_CODE, 'queueLoading')).toBeGreaterThanOrEqual(2);
  });

  it('leaves the AgentView composition root and its role gate untouched', () => {
    expect(AGENT_VIEW).toContain("import AgentHub from './agent/AgentHub';");
    expect(count(AGENT_VIEW, '<AgentHub')).toBe(1);
    expect(AGENT_VIEW).toMatch(/agentStatus === 'active'[\s\S]{0,600}<AgentHub/);
    expect(AGENT_VIEW).toContain("('Confirm Handover')");
    expect(AGENT_VIEW).not.toMatch(/release payment/i);
  });
});
