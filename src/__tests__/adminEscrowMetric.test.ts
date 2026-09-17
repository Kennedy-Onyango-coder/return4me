import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Phase 10 (F-2) — WIRING test.
//
// The aggregation itself is covered behaviourally in
// services/__tests__/escrowFunds.test.ts. This file covers the two places the
// audit found the defect, which a pure-function test cannot reach:
//
//   1. the admin dashboard handler must publish a MONETARY field
//      (escrowHeldAmount) derived from the authoritative aggregate, and
//   2. the console must render that amount under the label "Escrow Funds Held"
//      — and must NOT render the claim COUNT under that label, which is exactly
//      what made a count read as money beside a genuine `KES {totalRevenue}`.
//
// These are static source assertions. That is a deliberate, documented
// limitation: this repository has no DOM/component test harness (vitest runs
// with `environment: 'node'` and includes only `src/**/*.test.ts`), and
// server.ts boots the whole application on import so its Express handlers
// cannot be mounted here. Static assertions on the exact wiring are the
// strongest check available without introducing a new testing framework, and
// they are the same technique adminRouteAudit.test.ts already uses for
// un-mountable server.ts routes.

const serverTs = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');
const adminView = fs.readFileSync(path.resolve(__dirname, '../components/AdminView.tsx'), 'utf8');

describe('admin dashboard publishes escrow funds as money, not a count', () => {
  it('derives the escrow statistics from the authoritative aggregate helper', () => {
    const start = serverTs.indexOf("const escrowFundsHeld = computeEscrowFundsHeld(");
    expect(start, 'the dashboard must use computeEscrowFundsHeld').toBeGreaterThan(-1);
    // Computed from the rows already loaded by the handler, not from request input.
    expect(serverTs.slice(start, start + 80)).toContain('computeEscrowFundsHeld(claims, items)');
  });

  it('publishes escrowHeldAmount as the monetary total and keeps the count separately', () => {
    const statsStart = serverTs.indexOf('const stats = {');
    expect(statsStart).toBeGreaterThan(-1);
    const statsBlock = serverTs.slice(statsStart, serverTs.indexOf('};', statsStart));

    expect(statsBlock).toContain('escrowHeldAmount: escrowFundsHeld.amount');
    expect(statsBlock).toContain('escrowHeldCount: escrowFundsHeld.count');
  });

  it('no longer computes the escrow statistic inline as a bare claim count', () => {
    // The old expression was:
    //   escrowHeldCount: claims.filter(c => c.status === 'escrow_held').length,
    // which is precisely how a count ended up displayed as held funds.
    expect(serverTs).not.toContain("escrowHeldCount: claims.filter(c => c.status === 'escrow_held').length");
    expect(serverTs).toContain("escrowHeldCount: escrowFundsHeld.count");
  });
});

describe('admin console renders the escrow card truthfully', () => {
  // Anchor on the rendered JSX label (`>Escrow Funds Held</span>`), NOT on the
  // bare words: the words also appear in the explanatory comment above the card,
  // and anchoring on those would test the comment instead of the UI.
  const ESCROW_LABEL = '>Escrow Funds Held</span>';

  it('renders "Escrow Funds Held" as a KES monetary amount', () => {
    const labelIndex = adminView.indexOf(ESCROW_LABEL);
    expect(labelIndex, 'the Escrow Funds Held card must exist').toBeGreaterThan(-1);

    // The value rendered for that card is in the same JSX card, immediately
    // after the label.
    const cardWindow = adminView.slice(labelIndex, labelIndex + 400);
    expect(cardWindow).toContain('KES {dashboardData.stats.escrowHeldAmount}');
  });

  it('does NOT render the claim count under the "Escrow Funds Held" label', () => {
    const labelIndex = adminView.indexOf(ESCROW_LABEL);
    const cardWindow = adminView.slice(labelIndex, labelIndex + 400);
    // The exact original defect: `{dashboardData.stats.escrowHeldCount}` under
    // this label. It must never come back.
    expect(cardWindow).not.toContain('dashboardData.stats.escrowHeldCount');
  });

  it('renders the count under its own truthful "Claims in Escrow" label', () => {
    const labelIndex = adminView.indexOf('>Claims in Escrow</span>');
    expect(labelIndex, 'the Claims in Escrow card must exist').toBeGreaterThan(-1);
    const cardWindow = adminView.slice(labelIndex, labelIndex + 400);
    expect(cardWindow).toContain('dashboardData.stats.escrowHeldCount');
  });

  it('keeps both escrow cards adjacent, so the amount and the count are read together', () => {
    const amountCard = adminView.indexOf('KES {dashboardData.stats.escrowHeldAmount}');
    const countCard = adminView.indexOf('dashboardData.stats.escrowHeldCount}');
    expect(amountCard).toBeGreaterThan(-1);
    expect(countCard).toBeGreaterThan(amountCard);
    // Same grid, same card styling — a small, non-invasive change.
    expect(countCard - amountCard).toBeLessThan(600);
  });
});
