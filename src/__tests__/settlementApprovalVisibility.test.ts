import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

// =============================================================================
// GATE 2 — THE APPROVED TOTAL COMES FROM THE SERVER, NOT FROM THE BROWSER.
// =============================================================================
// The rendering suite proves what an operator READS. This suite pins WHERE those
// values come from, because a view that renders a correct-looking number is
// worthless if the number was calculated in the browser or taken from the claim
// fee instead of the persisted approval snapshot.
//
// It asserts, on the shipped source:
//   * the dashboard describes the approval from `settlement_authorized_total`
//     and `settlement_authorized_ledger_ids` — the same columns the payout gate
//     compares — and passes NO other amount into that description;
//   * the pending-settlement row and BOTH confirmation steps receive the same
//     `approvalState` / `approvedTotal` / `approvedLedgerRows` values;
//   * the approved total is never derived from `lockedTotalFee`, and the claim
//     fee and the platform share are labelled separately;
//   * the payout gate (`compareSettlementAuthorization`) is still present and
//     untouched by this display-only change.
// =============================================================================

const repoRoot = path.resolve(__dirname, '../..');
const SERVER = readFileSync(path.resolve(repoRoot, 'src/server.ts'), 'utf8');
const ADMIN = readFileSync(path.resolve(repoRoot, 'src/components/AdminView.tsx'), 'utf8');

const sliceBetween = (src: string, start: string, end: string) => {
  const from = src.indexOf(start);
  if (from === -1) return '';
  const to = src.indexOf(end, from + start.length);
  return to === -1 ? src.slice(from) : src.slice(from, to);
};

// The dashboard handler's pending-settlement mapping, isolated from the rest of
// server.ts so an assertion here cannot be satisfied by unrelated code.
const DASHBOARD_MAP = sliceBetween(
  SERVER,
  'const pendingSettlements = claims',
  '// `disputes` is mapped through the explicit admin whitelist',
);
// The pending-settlement JSX, isolated the same way the settlement lifecycle
// suite isolates it.
const LEDGER_JSX = sliceBetween(ADMIN, 'dashboardData.pendingSettlements.map(', 'Recent ledger transactions');

describe('GATE 2: the server describes the PERSISTED approval snapshot', () => {
  it('slices real shipped code, not empty regions', () => {
    expect(DASHBOARD_MAP.length).toBeGreaterThan(0);
    expect(LEDGER_JSX.length).toBeGreaterThan(0);
  });

  it('passes the two persisted snapshot columns into the description', () => {
    expect(DASHBOARD_MAP).toContain('describeSettlementApproval(');
    expect(DASHBOARD_MAP).toContain('authorizedTotal: c.settlement_authorized_total');
    expect(DASHBOARD_MAP).toContain('authorizedLedgerIds: c.settlement_authorized_ledger_ids');
    expect(DASHBOARD_MAP).toContain('approvedAt: c.settlement_approved_at');
  });

  it('never feeds the claim fee, the item or a computed sum into the approved total', () => {
    const call = sliceBetween(DASHBOARD_MAP, 'describeSettlementApproval(', 'payoutRows.map(');
    expect(call.length).toBeGreaterThan(0);
    expect(call).not.toContain('lockedTotalFee');
    expect(call).not.toContain('locked_total_fee');
    expect(call).not.toContain('item');
    expect(call).not.toContain('reduce(');
  });

  it('publishes the state, the total and the covered rows — and no recipient value', () => {
    expect(DASHBOARD_MAP).toContain('settlementApproval: {');
    expect(DASHBOARD_MAP).toContain('state: settlementApproval.state');
    expect(DASHBOARD_MAP).toContain('authorizedTotal: settlementApproval.authorizedTotal');
    expect(DASHBOARD_MAP).toContain('ledgerRows: settlementApproval.rows.map(');
    expect(DASHBOARD_MAP).toContain('bookedRowsAgreeWithApproval: settlementApproval.bookedRowsAgreeWithApproval');
    // The approval rows are ids and booked amounts; a destination is never copied.
    const approvalPayload = sliceBetween(DASHBOARD_MAP, 'settlementApproval: {', 'platformFee:');
    expect(approvalPayload).not.toContain('phone_or_till');
  });

  it('publishes the booked platform share separately, from its own ledger row', () => {
    expect(DASHBOARD_MAP).toContain("row.type === 'platform_fee'");
    expect(DASHBOARD_MAP).toContain('formatPersistedCurrencyAmount(platformFeeRow.amount)');
  });

  it('leaves the payout gate in place — this change is display only', () => {
    expect(SERVER).toContain('compareSettlementAuthorization(');
    expect(SERVER).toContain('SETTLEMENT_AUTHORIZATION_MISMATCH');
    expect(SERVER).toContain('SETTLEMENT_AUTHORIZATION_SNAPSHOT_MISSING');
  });
});

describe('GATE 2: every view renders the same server-supplied authorization', () => {
  it('derives the displayed values from the payload only', () => {
    expect(ADMIN).toContain('const approvalSnapshot = ps.settlementApproval');
    expect(ADMIN).toContain("const approvedTotal: string | null = typeof approvalSnapshot?.authorizedTotal === 'string'");
    expect(ADMIN).toContain('const approvedLedgerRows: any[] = Array.isArray(approvalSnapshot?.ledgerRows)');
    // No arithmetic on the approved figure anywhere in the pending-settlements UI.
    expect(LEDGER_JSX).not.toMatch(/approvedTotal\s*[-+*/]/);
    expect(LEDGER_JSX).not.toMatch(/Number\(\s*approvedTotal/);
  });

  it('passes the SAME authorization to the payout confirmation and the combined step', () => {
    const payoutStep = sliceBetween(LEDGER_JSX, '<SettlementPayoutConfirmation', '/>');
    const approveAndPayStep = sliceBetween(LEDGER_JSX, '<SettlementApproveAndPayConfirmation', '/>');
    for (const [label, step] of [['payout', payoutStep], ['approve-and-pay', approveAndPayStep]] as const) {
      expect(step.length, label).toBeGreaterThan(0);
      expect(step, label).toContain('approvalState={approvalState}');
      expect(step, label).toContain('approvedTotal={approvedTotal}');
      expect(step, label).toContain('approvedLedgerRows={approvedLedgerRows}');
    }
  });

  it('names an absent snapshot instead of falling back to the claim fee', () => {
    expect(ADMIN).toContain(": hasApproval ? 'unavailable' : 'not_approved'");
    expect(LEDGER_JSX).toContain("approvalState === 'legacy'");
    expect(LEDGER_JSX).toContain("approvalState === 'incomplete' || approvalState === 'unreadable' || approvalState === 'unavailable'");
  });

  it('labels the claim fee, the approved payout and the platform share distinctly', () => {
    expect(LEDGER_JSX).toContain('claim fee');
    expect(LEDGER_JSX).toContain('platform share (not paid to a recipient)');
    expect(LEDGER_JSX).toContain('Approved payout total KES');
    // The approved total is never labelled as the claim fee.
    expect(LEDGER_JSX).not.toMatch(/Approved payout total KES[^`]*claim fee/);
  });
});
