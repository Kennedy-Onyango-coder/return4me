import { describe, it, expect } from 'vitest';
import {
  ledgerAmountDirectionLabel,
  ledgerEntryIconKind,
  ledgerStatusLabel,
  ledgerStatusVariant,
  ledgerTypeLabel,
} from '../ledgerPresentation';

// =============================================================================
// PHASE 3 — LEDGER PRESENTATION (NO SEMANTICS CHANGE)
// =============================================================================

describe('Phase 3 — payment-received and platform-fee rows never read "PENDING"', () => {
  it('payment_received pending is described as awaiting provider confirmation', () => {
    const entry = { type: 'payment_received', status: 'pending' };
    expect(ledgerStatusLabel(entry)).toBe('Awaiting provider confirmation');
    expect(ledgerStatusLabel(entry)).not.toContain('PENDING');
    expect(ledgerStatusVariant(entry)).toBe('info');
    expect(ledgerEntryIconKind(entry)).toBe('inbound');
    expect(ledgerTypeLabel(entry.type)).toBe('Payment received');
  });

  it('platform_fee pending is described as an internal share, not a payout', () => {
    const entry = { type: 'platform_fee', status: 'pending' };
    expect(ledgerStatusLabel(entry)).toBe('Recorded internal share');
    expect(ledgerStatusLabel(entry)).not.toContain('PENDING');
    expect(ledgerStatusVariant(entry)).toBe('info');
    expect(ledgerEntryIconKind(entry)).toBe('fee');
    expect(ledgerTypeLabel(entry.type)).toBe('Platform fee');
    expect(ledgerStatusLabel({ type: 'platform_fee', status: 'completed' })).toBe(
      'Booked internal share',
    );
  });

  it('payout rows keep their lifecycle word because their outcome is genuinely undecided', () => {
    const entry = { type: 'agent_payout', status: 'pending' };
    expect(ledgerStatusLabel(entry)).toBe('PENDING');
    expect(ledgerStatusVariant(entry)).toBe('pending');
    expect(ledgerEntryIconKind(entry)).toBe('outbound');
  });

  it('states the direction without changing the amount or its sign', () => {
    expect(ledgerAmountDirectionLabel({ type: 'payment_received' })).toBe('Money in');
    expect(ledgerAmountDirectionLabel({ type: 'platform_fee' })).toBe('Platform share');
    expect(ledgerAmountDirectionLabel({ type: 'finder_payout' })).toBe('Money out (payout)');
    expect(ledgerAmountDirectionLabel({ type: 'refund' })).toBe('Money out (refund)');
  });
});
