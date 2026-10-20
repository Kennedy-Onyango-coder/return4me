import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SettlementReadinessChecklist from '../SettlementReadinessChecklist';

// =============================================================================
// PHASE 3 — READINESS CHECKLIST RENDERING
// =============================================================================

const blocked = {
  ready: false,
  blockers: ['settlement_window_open', 'durable_approval_missing'],
  conditions: [
    {
      code: 'settlement_window_open',
      ok: false,
      label: 'Dispute review window has elapsed',
      detail: 'The dispute review window has not elapsed.',
      next_action: 'Wait until the recorded settle time has passed.',
    },
    {
      code: 'durable_approval_missing',
      ok: false,
      label: 'A durable settlement approval is on file',
      detail: 'No durable administrator approval is recorded.',
      next_action: 'Record the settlement approval.',
    },
    {
      code: 'payout_paused',
      ok: true,
      label: 'Payouts are not paused',
      detail: '',
      next_action: '',
    },
  ],
};

describe('Phase 3 — the Pending Settlement checklist says exactly what the server says', () => {
  it('renders each failing condition with its code, detail and next action', () => {
    const html = renderToStaticMarkup(
      React.createElement(SettlementReadinessChecklist, { readiness: blocked }),
    );
    expect(html).toContain('data-readiness="blocked"');
    expect(html).toContain('2 conditions must be resolved');
    expect(html).toContain('[settlement_window_open]');
    expect(html).toContain('[durable_approval_missing]');
    expect(html).toContain('Next: Wait until the recorded settle time has passed.');
    expect(html).toContain('Next: Record the settlement approval.');
    // A passing condition is shown, but without a failure detail or action.
    expect(html).toContain('Payouts are not paused');
    expect(html).not.toContain('Payouts are paused platform-wide');
  });

  it('states that readiness is local and that the server re-checks everything', () => {
    const ready = {
      ...blocked,
      ready: true,
      blockers: [] as string[],
      conditions: blocked.conditions.map((c) => ({ ...c, ok: true })),
    };
    const html = renderToStaticMarkup(
      React.createElement(SettlementReadinessChecklist, { readiness: ready }),
    );
    expect(html).toContain('data-readiness="ready"');
    expect(html).toContain('All local checks pass');
    expect(html).toContain('do not contact the provider');
    expect(html).toContain('server re-checks everything');
  });

  it('a failed readiness request is visible and does not claim readiness', () => {
    const html = renderToStaticMarkup(
      React.createElement(SettlementReadinessChecklist, {
        readiness: null,
        error: 'Readiness request failed (500).',
      }),
    );
    expect(html).toContain('Readiness could not be checked');
    expect(html).toContain('The server still decides every condition');
    expect(html).not.toContain('All local checks pass');
  });
});
