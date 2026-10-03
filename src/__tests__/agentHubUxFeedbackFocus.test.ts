// AGENTHUB UX MODERNIZATION BATCH 1 — feedback and focus correctness.
//
// Source-contract coverage for UX-01 (operational error announcement) and
// UX-02 (inline panel focus). It does NOT replace or weaken the existing
// extraction/reliability/comprehension contracts; it only pins the two new
// accessibility guarantees so a later refactor cannot silently drop them.
//
// The Hub's `operationError` and `queueError` blocks were ALREADY assertive
// before Batch 1 and remain so. Batch 1 only had to add announcement to
// `verifyError`, the one error surface that had none.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8');

/** Strip comments so prose describing a contract can never satisfy a test. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

const HUB_CODE = stripComments(read('src/components/agent/AgentHub.tsx'));
const VERIFY_CODE = stripComments(read('src/components/agent/AgentVerificationPanel.tsx'));
const REJECT_CODE = stripComments(read('src/components/agent/AgentRejectionPanel.tsx'));
const FOCUS_CODE = stripComments(read('src/components/agent/panelFocus.ts'));

describe('AgentHub UX Batch 1 — error announcement (UX-01)', () => {
  it('announces every dynamic operational error surface', () => {
    // operationError and queueError were ALREADY assertive; this pins them so
    // a future edit cannot quietly downgrade them.
    const operationBlock = HUB_CODE.slice(
      HUB_CODE.indexOf('{props.operationError &&'),
      HUB_CODE.indexOf('{/* REFRESH FAILURE')
    );
    expect(operationBlock).toContain('role="alert"');

    const queueBlock = HUB_CODE.slice(
      HUB_CODE.indexOf('{props.queueError &&'),
      HUB_CODE.indexOf('{/* Quick Confirmation Actions */')
    );
    expect(queueBlock).toContain('role="alert"');

    // UX-01: this is the surface that had none.
    const verifyBlock = VERIFY_CODE.slice(
      VERIFY_CODE.indexOf('{verifyError &&'),
      VERIFY_CODE.indexOf('<div className="flex flex-wrap gap-2 justify-end pt-1">')
    );
    expect(verifyBlock).toContain('role="alert"');
  });

  it('does not stack redundant live-region semantics', () => {
    // role="alert" already implies aria-live="assertive"; adding both would be
    // a redundant announcement, not a stronger one.
    expect(VERIFY_CODE.slice(VERIFY_CODE.indexOf('{verifyError &&'))).not.toContain('aria-live=');
    // The success banner is a status, not an error, and must stay polite.
    // Boundaries are code markers only, because the source was comment-stripped.
    const successBlock = HUB_CODE.slice(
      HUB_CODE.indexOf('{props.actionSuccessMsg &&'),
      HUB_CODE.indexOf('{props.operationError &&')
    );
    expect(successBlock).toContain('role="status"');
    expect(successBlock).not.toContain('role="alert"');
  });

  it('leaves the error channels, text, and affordances untouched', () => {
    expect(HUB_CODE).toContain('props.operationError');
    expect(HUB_CODE).toContain('props.queueError');
    expect(VERIFY_CODE).toContain('verifyError');
    expect(HUB_CODE).toContain("onClick={() => props.setOperationError('')}");
    expect(HUB_CODE).toContain('onClick={props.retryQueue}');
  });
});

describe('AgentHub UX Batch 1 — inline panel focus (UX-02)', () => {
  it('gives each panel a programmatic, non-tab-order focus target', () => {
    expect(VERIFY_CODE).toContain("ref={panelFocusRef(item.id, 'verify')}");
    expect(VERIFY_CODE).toContain('tabIndex={-1}');
    expect(REJECT_CODE).toContain("ref={panelFocusRef(item.id, 'reject')}");
    expect(REJECT_CODE).toContain('tabIndex={-1}');
  });

  it('gives each originating action a stable, per-item focus-return target', () => {
    expect(HUB_CODE).toContain("id={panelTriggerId(item.id, 'verify')}");
    expect(HUB_CODE).toContain("id={panelTriggerId(item.id, 'reject')}");
    // Ids derive from the ITEM id, so focus can never be returned to a
    // different card's control when several items are queued.
    expect(FOCUS_CODE).toContain('agent-panel-trigger-');
    expect(FOCUS_CODE).not.toMatch(/useRef/);
  });

  it('keeps the parent-owned render gates intact', () => {
    expect(HUB_CODE).toContain('props.verifyingItemId === item.id');
    expect(HUB_CODE).toContain('props.rejectingItemId === item.id');
  });

  it('focuses only on the first mount and never loops', () => {
    expect(FOCUS_CODE).toContain('if (hasFocused) return;');
    expect(FOCUS_CODE).toContain('node.focus?.();');
  });

  it('degrades safely when the originating element no longer exists', () => {
    // After a successful action the item leaves the queue, so the trigger may
    // be gone: getElementById returns null and focus is left where the browser
    // put it — no throw, and no focus stolen from an unrelated element.
    expect(FOCUS_CODE).toContain('document.getElementById(triggerId)');
    expect(FOCUS_CODE).toContain(
      "if (trigger && typeof trigger.focus === 'function') trigger.focus();"
    );
  });

  it('contains no application state, transport, or authorization logic', () => {
    for (const code of [FOCUS_CODE, VERIFY_CODE, REJECT_CODE]) {
      expect(code).not.toMatch(/fetch\(/);
      expect(code).not.toMatch(/agentApi\./);
      expect(code).not.toMatch(/useAgentOperations/);
      expect(code).not.toMatch(/Authorization/);
      expect(code).not.toMatch(/localStorage|sessionStorage/);
    }
  });

  it('leaves AgentHub hook-free and does not widen its prop contract', () => {
    expect(HUB_CODE).not.toMatch(/\buse(State|Effect|Memo|Callback|Ref)\s*\(/);
    expect(HUB_CODE).toContain('export interface AgentHubQueueProps');
    expect(HUB_CODE).toContain('export interface AgentHubVerificationProps');
    expect(HUB_CODE).toContain('export interface AgentHubRejectionProps');
    expect(HUB_CODE).toContain('export interface AgentHubFeedbackProps');
  });

  it('preserves panel interaction contracts while adding the focus target', () => {
    expect(VERIFY_CODE).not.toMatch(/\buse(State|Effect|Memo|Callback|Ref)\s*\(/);
    expect(REJECT_CODE).not.toMatch(/\buse(State|Effect|Memo|Callback|Ref)\s*\(/);
    expect(VERIFY_CODE).toContain('id="agent-verify-category"');
    expect(VERIFY_CODE).toContain('htmlFor="agent-verify-category"');
    expect(VERIFY_CODE).toContain('aria-busy={isItemBusy(item.id)}');
    expect(REJECT_CODE).toContain('htmlFor={`reject-reason-${item.id}`}');
    expect(REJECT_CODE).toContain('aria-busy={isItemBusy(item.id)}');
    // The empty-"Other" guard and the Cancel paths are untouched.
    expect(REJECT_CODE).toContain('rejectionCustomText.trim() === ""');
    expect(REJECT_CODE).toContain('onClick={() => setRejectingItemId(null)}');
  });
});
