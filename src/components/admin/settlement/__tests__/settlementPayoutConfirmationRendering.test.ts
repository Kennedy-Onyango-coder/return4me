import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import SettlementPayoutConfirmation from '../SettlementPayoutConfirmation';

// =============================================================================
// D-2B-B BATCH 2 — WHAT THE PAYOUT CONFIRMATION ACTUALLY RENDERS.
// =============================================================================
// The settlement panel's confirmation step is the ONLY thing standing between a
// single click on "Initiate payout" and an irreversible payout request, so its
// content is asserted against REAL rendered output rather than against source
// text. This repository has no jsdom / React Testing Library, but it does render
// components with `react-dom/server` (see config/__tests__/verificationRendering
// .test.ts), which is enough to pin exactly what an administrator reads: which
// settlement is being confirmed, what the action may cost, and that both choices
// are present and distinct.
//
// The step sends nothing itself — it holds no state, calls no endpoint and owns
// no rule. Everything it can cause is decided by components/admin/
// consoleActionState.ts, whose behaviour is covered separately in
// components/admin/__tests__/consoleActionState.test.ts.
// =============================================================================

const handlers = {
  onCancel: () => {},
  onConfirm: () => {},
  // BATCH 1 (D) — the step now collects the operator's own password, so every
  // rendering assertion supplies it explicitly rather than relying on a default.
  password: '',
  onPasswordChange: () => {},
};

const render = (props: Partial<React.ComponentProps<typeof SettlementPayoutConfirmation>> = {}) =>
  renderToStaticMarkup(
    React.createElement(SettlementPayoutConfirmation, {
      claimId: 'claim-77',
      itemId: 'item-9',
      lockedTotalFee: 1500,
      ...handlers,
      ...props,
    }),
  );

describe('D-2B-B Batch 2: the confirmation identifies the settlement being acted on', () => {
  it('names the claim, the item and the locked amount', () => {
    const html = render();
    expect(html).toContain('claim-77');
    expect(html).toContain('item-9');
    expect(html).toContain('KES 1500');
  });

  it('invents no amount when the row carries none', () => {
    const html = render({ lockedTotalFee: null });
    expect(html).not.toContain('KES');
    expect(html).not.toContain('released');
  });
});

describe('D-2B-B Batch 2: the confirmation states the financial consequence', () => {
  it('says the action starts payout processing and may move money', () => {
    const html = render();
    expect(html).toContain('starts payout processing');
    expect(html).toContain('Money may leave the platform');
  });

  it('does not imply a payout has already been sent or completed', () => {
    const html = render();
    expect(html).toContain('Nothing has been sent yet');
    // The provider's outcome is reported elsewhere, never assumed here.
    expect(html).toContain('provider');
    expect(html).not.toMatch(/has been paid|payment sent|payout complete/i);
  });
});

describe('BATCH 1 (D): the confirmation re-authenticates the operator', () => {
  it('renders a real password field that is never pre-filled or auto-submitted', () => {
    const html = render();
    expect(html).toContain('type="password"');
    expect(html).toContain('Your password');
    expect(html).toContain('autoComplete="current-password"');
    // No value is ever supplied by the component itself.
    expect(html).not.toMatch(/value="[^"]+"/);
  });

  it('states that the password is verified server-side and never stored', () => {
    const html = render();
    expect(html).toContain('verified on the server');
    expect(html).toContain('never stored and never logged');
  });

  it('shows the field error it is given, in place', () => {
    const html = render({ passwordError: 'Incorrect password.' });
    expect(html).toContain('Incorrect password.');
  });

  it('disables both controls while the request is in flight', () => {
    const html = render({ submitting: true });
    expect((html.match(/disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe('D-2B-B Batch 2: confirm and cancel are distinct, and neither is the legacy route', () => {
  it('offers exactly one confirmation and one cancellation control', () => {
    const html = render();
    expect(html).toContain('Confirm and initiate payout');
    expect(html).toContain('Cancel');
    expect((html.match(/<button/g) ?? []).length).toBe(2);
  });

  it('never carries the legacy release control or the approval step', () => {
    const html = render();
    expect(html).not.toContain('Release Now');
    expect(html).not.toContain('Approve settlement');
    expect(html).not.toContain('Record approval');
  });

  it('is not a dialog and starts no browser-native prompt', () => {
    const html = render();
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('aria-modal');
    expect(html).not.toContain('window.');
  });
});

describe('D-2B-B Batch 2: the step is purely presentational', () => {
  it('invokes neither handler while it renders', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render({ onCancel, onConfirm });
    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('holds no state, makes no request and knows no endpoint', () => {
    const source = readFileSync(new URL('../SettlementPayoutConfirmation.tsx', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    expect(code).not.toMatch(/use(?:State|Effect|Ref|Memo|Callback|Reducer|Context|LayoutEffect)\s*\(/);
    expect(code).not.toContain('fetch(');
    expect(code).not.toContain('/api/');
  });
});
