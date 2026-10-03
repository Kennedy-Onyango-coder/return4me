// AGENTHUB UX MODERNIZATION BATCH 2 — destructive-action clarity.
//
// Two defects are covered:
//   UX-03  the rejection confirmation did not read as a destructive action —
//          its submit bypassed the shared `danger` Button variant and nothing
//          told the agent what rejecting actually does.
//   UX-04  Review and Reject sat flush against each other with no separation.
//
// These are SOURCE-CONTRACT tests, matching the strategy already used by the
// structural and reliability suites in this area. The repository has no
// DOM/React rendering harness, so nothing here claims runtime rendering.

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { translations } from '../types';

const root = path.resolve(import.meta.dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.resolve(root, relative), 'utf8');
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const HUB = read('src/components/agent/AgentHub.tsx');
const HUB_CODE = stripComments(HUB);
const REJECT = read('src/components/agent/AgentRejectionPanel.tsx');
const REJECT_CODE = stripComments(REJECT);
const BUTTON = read('src/components/ui/Button.tsx');
const TYPES = read('src/types.ts');

const actionRow = HUB.slice(
  HUB.indexOf('props.rejectingItemId !== item.id'),
  HUB.indexOf('ITEM VERIFICATION'),
);

describe('AgentHub UX Batch 2 — UX-03 destructive rejection treatment', () => {
  it('the shared Button already provides a danger variant, so no new primitive was needed', () => {
    expect(BUTTON).toMatch(/'danger'/);
    expect(BUTTON).toContain('--appearance-danger');
    // The pre-existing design system was reused, not extended: comments aside,
    // no new "destructive" variant was invented alongside `danger`.
    expect(stripComments(BUTTON)).not.toContain('destructive');
  });

  it('the rejection submit uses the shared danger variant instead of a hand-rolled literal', () => {
    expect(REJECT_CODE).toMatch(/<Button[\s\S]{0,400}variant="danger"/);
    // The old hard-coded red button is gone: the destructive colour now comes
    // from the appearance token rather than a fixed light-mode literal, so the
    // action is correct in both light and dark.
    expect(REJECT_CODE).not.toMatch(/bg-red-600/);
    expect(REJECT_CODE).not.toMatch(/hover:bg-red-700/);
    expect(REJECT_CODE).not.toMatch(/<button/);
    // It is the same shared component the Hub's Reject trigger already used, so
    // the two halves of the destructive flow now read identically.
    expect(REJECT_CODE).toContain("import Button from '../ui/Button'");
  });

  it('the normal Review action is NOT given destructive treatment', () => {
    const reviewButton = actionRow.slice(
      actionRow.indexOf('<Button onClick={() => props.openVerificationPanel(item)}'),
      actionRow.indexOf("panelTriggerId(item.id, 'verify')}") + 30,
    );
    expect(reviewButton).not.toContain('variant="danger"');
    expect(reviewButton).not.toContain('danger');
  });

  it('rejection behaviour, payload path, and validation are unchanged', () => {
    // Same handler, same pre-transport guards, same busy semantics.
    expect(REJECT_CODE).toContain('onClick={() => handleRejectDropoff(item.id)}');
    expect(REJECT_CODE).toContain('rejectionCustomText.trim() === ""');
    expect(REJECT_CODE).toContain('rejectionReason === "Other"');
    expect(REJECT_CODE).toContain('aria-busy={isItemBusy(item.id)}');
    expect(REJECT_CODE).toContain('loading={isItemBusy(item.id)}');
    // Reason values and the Other branch are untouched.
    for (const reason of [
      'Not a real item',
      "Item doesn't match description",
      'Suspected test/spam',
      'Other',
    ]) {
      expect(REJECT_CODE).toContain(`value="${reason}"`);
    }
    expect(REJECT_CODE).toContain('onClick={() => setRejectingItemId(null)}');
    // No new state, transport, or workflow ownership in the child.
    expect(REJECT_CODE).not.toMatch(/\buse(State|Effect|Memo|Callback|Ref|Reducer)\s*\(/);
    expect(REJECT_CODE).not.toMatch(/\bfetch\s*\(/);
    expect(REJECT_CODE).not.toMatch(/agentApi|useAgentOperations/);
  });
});


describe('AgentHub UX Batch 2 — UX-03 consequence statement', () => {
  it('states the consequence inside the action area, not in a hidden place', () => {
    expect(REJECT_CODE).toContain('t.agentRejectConsequence');
    // Placement matters: after the reason control is chosen, immediately before
    // the action row, so it is read as part of the decision.
    const reasonAt = REJECT_CODE.indexOf('reject-reason-${item.id}');
    const copyAt = REJECT_CODE.indexOf('t.agentRejectConsequence');
    const submitAt = REJECT_CODE.indexOf('Submit Rejection');
    expect(reasonAt).toBeGreaterThan(-1);
    expect(copyAt).toBeGreaterThan(reasonAt);
    expect(submitAt).toBeGreaterThan(copyAt);
  });

  it('is bilingual through the existing translation architecture, with no new dictionary', () => {
    for (const lang of ['en', 'sw'] as const) {
      expect(translations[lang].agentRejectConsequence).toBeTruthy();
    }
    // Both languages exist in the ONE existing bundle — no parallel dictionary.
    expect((TYPES.match(/agentRejectConsequence:/g) ?? []).length).toBe(2);
    expect(TYPES).not.toMatch(/agentTranslations|agentI18n/);
    // The key is passed explicitly; nothing is spread.
    const rejCall = HUB.slice(
      HUB.indexOf('<AgentRejectionPanel'),
      HUB.indexOf('/>', HUB.indexOf('<AgentRejectionPanel')) + 2,
    );
    expect(rejCall).toMatch(/\bt=/);
    expect(rejCall).not.toMatch(/\{\.\.\./);
  });

  it('claims only consequences the rejection route actually enforces', () => {
    const copy = translations.en.agentRejectConsequence;
    // Truthful: the server rejects and removes the item, and attributes the
    // decision to the acting Agent.
    expect(copy).toMatch(/removes this item from Return4me permanently/i);
    expect(copy).toMatch(/recorded against your Agent account/i);
    // Not promised, because this route does not decide any of it.
    expect(copy).not.toMatch(/refund|payment|finder will be notified|guarantee/i);
  });
});

describe('AgentHub UX Batch 2 — UX-04 Review / Reject separation', () => {
  it('separates the destructive action from the normal one, responsively', () => {
    // A visible rule from `sm` up; full-width + right-aligned below `sm` so the
    // two actions never have to share one cramped 320px line.
    expect(actionRow).toMatch(
      /<span className="flex w-full items-center justify-end sm:w-auto sm:border-l sm:border-stone-200 sm:pl-3">/,
    );
    expect(actionRow).toContain('</span>');
  });

  it('keeps both actions, their order, their handlers, and their focus ids', () => {
    const reviewAt = actionRow.indexOf('props.openVerificationPanel(item)');
    const rejectAt = actionRow.indexOf('setRejectingItemId(item.id)');
    expect(reviewAt).toBeGreaterThan(-1);
    expect(rejectAt).toBeGreaterThan(reviewAt); // order unchanged
    // The Batch 1 per-item focus-return ids are still on the same controls.
    expect(actionRow).toMatch(/id=\{panelTriggerId\(item\.id, 'verify'\)\}/);
    expect(actionRow).toMatch(/id=\{panelTriggerId\(item\.id, 'reject'\)\}/);
    // The pre-existing reset behaviour of opening the panel is unchanged.
    expect(actionRow).toContain('props.setRejectionReason("Not a real item")');
    expect(actionRow).toContain('props.setRejectionCustomText("")');
    // Neither action was removed.
    expect((actionRow.match(/<Button/g) ?? []).length).toBe(2);
  });
});

describe('AgentHub UX Batch 2 — Batch 1 regression', () => {
  it('leaves every Batch 1 focus and live-region contract intact', () => {
    // Panel focus targets from UX-02.
    expect(REJECT_CODE).toContain("panelFocusRef(item.id, 'reject')");
    expect(REJECT_CODE).toContain('tabIndex={-1}');
    expect(HUB_CODE).toContain("import { panelTriggerId } from './panelFocus'");
    // IDs and label association from the extraction batch.
    expect(REJECT_CODE).toContain('htmlFor={`reject-reason-${item.id}`}');
    expect(REJECT_CODE).toContain('aria-busy={isItemBusy(item.id)}');
    // panelFocus.ts itself was not modified.
    const focus = read('src/components/agent/panelFocus.ts');
    expect(focus).toContain('export function panelTriggerId');
    expect(focus).toContain('export function panelFocusRef');
  });

  it('leaves AgentHub hook-free with its four domain contracts unchanged', () => {
    expect(HUB_CODE).not.toMatch(/\buse(State|Effect|Memo|Callback|Ref)\s*\(/);
    for (const iface of [
      'AgentHubQueueProps',
      'AgentHubVerificationProps',
      'AgentHubRejectionProps',
      'AgentHubFeedbackProps',
    ]) {
      expect(HUB_CODE).toContain(`export interface ${iface}`);
    }
    // No live region was added or converted by this batch.
    expect((HUB_CODE.match(/role="alert"/g) ?? []).length).toBe(2);
    expect(HUB_CODE).toContain('role="status"');
  });

  it('adds no new state, store, or transport surface', () => {
    // Exactly one new key per language, in the existing bundle.
    expect((TYPES.match(/agentRejectConsequence:/g) ?? []).length).toBe(2);
    expect(HUB_CODE).not.toMatch(/createContext|zustand|redux/i);
  });
});
