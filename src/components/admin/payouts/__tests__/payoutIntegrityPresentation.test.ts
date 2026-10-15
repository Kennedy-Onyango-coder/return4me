import { describe, expect, it } from 'vitest';
import {
  PAYOUT_RISK_CLASS_LABELS,
  describePayoutIntegritySourceSentence,
  describePayoutRiskClass,
  readPayoutIntegrityHubRow,
  readPayoutIntegrityHubs,
  readPayoutIntegritySourceState,
  summarizePayoutIntegrity,
  PAYOUT_INTEGRITY_SOURCE_UNREADABLE_TEXT,
} from '../payoutIntegrityPresentation';
import { METRIC_NOT_REPORTED } from '../../dashboard/adminOverviewMetrics';

// =============================================================================
// PROGRAMME 1 / WS1 + WS2 + WS5 — THE PAYOUT-INTEGRITY READ MODEL, EXECUTED.
// =============================================================================
// The mapping is the part of this surface that can be wrong in a way nobody
// sees: a NULL read as 0, an absent verdict read as payable, an unmasked number
// forwarded to a screen. So the cases below run against the real functions,
// rather than asserting that comments about them exist.
//
// The two properties that matter most:
//   1. PAYABLE IS AN EXPLICIT STATEMENT. Only `eligible: true` on a verdict the
//      server actually sent makes a row payable; an absent, unreadable or
//      unrecognised verdict is reported as such and grouped with the rows that
//      need a human. Unknown must never masquerade as the safe answer.
//   2. A TOTAL THAT CANNOT BE STATED IS NOT 0. `pending_earnings: null` means
//      "at least one row carried an amount this build cannot read" — money owed
//      that is UNKNOWN, which is a different fact from "nothing is owed".
// =============================================================================

/** A dashboard agent row, in the shape the server's safe DTO publishes. */
const hub = (overrides: Record<string, any> = {}) => ({
  id: 'agent-1',
  business_name: 'Hub One',
  ...overrides,
});

/** A payout_eligibility object, as the safe view whitelists it. */
const verdict = (overrides: Record<string, any> = {}) => ({
  eligible: false,
  reason: 'destination_missing',
  risk_class: 'refused_destination_missing',
  masked_destination: '(none)',
  summary: 'This hub cannot be paid.',
  ...overrides,
});

describe('WS1/WS2 — payable is an explicit statement, never a default', () => {
  it('reads an explicitly eligible verdict as payable', () => {
    const row = readPayoutIntegrityHubRow(
      hub({
        payout_eligibility: verdict({
          eligible: true,
          reason: null,
          risk_class: 'eligible',
          masked_destination: '2547****789',
          summary: 'Format and method only.',
        }),
        pending_earnings: 120,
        pending_earnings_count: 2,
      }),
    );

    expect(row).toEqual({
      agentId: 'agent-1',
      businessName: 'Hub One',
      destinationMasked: '2547****789',
      eligible: true,
      verdictUnreadable: false,
      riskClass: 'eligible',
      riskLabel: PAYOUT_RISK_CLASS_LABELS.eligible,
      summary: 'Format and method only.',
      pendingEarningsLabel: 'KES 120.00',
      pendingEarningsReported: true,
      pendingPayoutCount: 2,
    });
  });

  it('never treats an ABSENT verdict as payable — it is unreadable, not refused-with-a-guess', () => {
    for (const missing of [undefined, null, 'nope', 7]) {
      const row = readPayoutIntegrityHubRow(hub({ payout_eligibility: missing }))!;
      expect(row.eligible, `verdict ${String(missing)} must not be payable`).toBe(false);
      expect(row.verdictUnreadable).toBe(true);
      expect(row.riskClass).toBeNull();
      expect(row.riskLabel).toBe('Verdict not readable by this console — treat as not payable');
      // The destination is fully masked when there is no verdict to read it from.
      expect(row.destinationMasked).toBe('***');
    }
  });

  it('refuses to guess at a class this build does not know, and never marks it payable', () => {
    const row = readPayoutIntegrityHubRow(
      hub({ payout_eligibility: verdict({ risk_class: 'refused_by_some_future_rule' }) }),
    )!;
    expect(row.eligible).toBe(false);
    // The class is carried verbatim (an operator may need to quote it), while the
    // LABEL says this console cannot read it — it is not mapped onto the nearest
    // known refusal, which would invent a reason for a refusal the server chose.
    expect(row.riskClass).toBe('refused_by_some_future_rule');
    expect(row.riskLabel).toBe('Verdict not readable by this console — treat as not payable');
    expect(describePayoutRiskClass('refused_by_some_future_rule')).toBe(row.riskLabel);
  });

  it('states each launch-policy refusal class in its own words', () => {
    expect(describePayoutRiskClass('refused_destination_missing')).toBe(
      'Refused — no payout destination recorded',
    );
    expect(describePayoutRiskClass('refused_destination_not_a_personal_mpesa_phone')).toBe(
      'Refused — destination is not a personal M-Pesa number',
    );
    expect(describePayoutRiskClass('refused_unsupported_payout_method')).toBe(
      'Refused — unsupported payout method',
    );
  });
});

describe('WS1/WS2 — the only destination that can reach the screen is the masked one', () => {
  it('copies an already-masked destination and the explicit "(none)" marker', () => {
    const masked = readPayoutIntegrityHubRow(
      hub({ payout_eligibility: verdict({ masked_destination: '2547****789' }) }),
    )!;
    expect(masked.destinationMasked).toBe('2547****789');
    const none = readPayoutIntegrityHubRow(
      hub({ payout_eligibility: verdict({ masked_destination: '(none)' }) }),
    )!;
    expect(none.destinationMasked).toBe('(none)');
  });

  it('masks anything that does not already carry a mask marker', () => {
    // A raw number that reached this module by any route is replaced, not shown.
    for (const raw of ['254712345678', '  254712345678  ', '', '   ', 254712345678, null, {}]) {
      const row = readPayoutIntegrityHubRow(
        hub({ payout_eligibility: verdict({ masked_destination: raw }) }),
      )!;
      expect(row.destinationMasked, `${String(raw)} must not be rendered`).toBe('***');
    }
  });
});

describe('WS5 — a total this build cannot state is never rendered as 0', () => {
  it('renders the missing marker for a NULL total, and keeps `0` as a real zero', () => {
    const unstatable = readPayoutIntegrityHubRow(
      hub({ pending_earnings: null, pending_earnings_count: 3 }),
    )!;
    expect(unstatable.pendingEarningsLabel).toBe(METRIC_NOT_REPORTED);
    expect(unstatable.pendingEarningsReported).toBe(false);
    // The COUNT is still real: three rows are recorded as owed.
    expect(unstatable.pendingPayoutCount).toBe(3);

    const absent = readPayoutIntegrityHubRow(hub())!;
    expect(absent.pendingEarningsLabel).toBe(METRIC_NOT_REPORTED);
    expect(absent.pendingEarningsReported).toBe(false);

    const zero = readPayoutIntegrityHubRow(
      hub({ pending_earnings: 0, pending_earnings_count: 0 }),
    )!;
    expect(zero.pendingEarningsLabel).toBe('KES 0.00');
    expect(zero.pendingEarningsReported).toBe(true);
  });

  it('states a row count only when the payload carried a genuine whole number of rows', () => {
    // A fractional or negative count is a server defect, not a figure — the same
    // rule the Overview applies to its count fields (isReportedCountField). NULL
    // says "the row count could not be read": it is never rounded into looking
    // plausible and never rendered as 0, which would claim nothing is owed.
    for (const bad of [-1, 2.5, '3', null, undefined, NaN, Infinity]) {
      expect(readPayoutIntegrityHubRow(hub({ pending_earnings_count: bad }))!.pendingPayoutCount).toBeNull();
    }
    expect(readPayoutIntegrityHubRow(hub({ pending_earnings_count: 4 }))!.pendingPayoutCount).toBe(4);
    expect(readPayoutIntegrityHubRow(hub({ pending_earnings_count: 0 }))!.pendingPayoutCount).toBe(0);
  });
});

describe('F3 — an unread hub list is unknown, and a read empty list is genuinely empty', () => {
  // The review's F3. `readPayoutIntegrityHubs` returns `[]` for a payload that
  // carried no list and for a real list that happens to be empty, so the LIST'S
  // OWN STATE is read separately. Without it the section printed
  // "0 hub row(s) read" under a payload that carried nothing, which is the same
  // missing-as-zero defect F5 removes one level down.
  it('reports a carried array as READ, whether it is populated or empty', () => {
    expect(readPayoutIntegritySourceState([])).toBe('read');
    expect(readPayoutIntegritySourceState([hub({ id: 'a' })])).toBe('read');
    // A populated list whose entries are all malformed is still READ: the payload
    // carried a list, and the rows simply could not be described.
    expect(readPayoutIntegritySourceState([null, 5, 'x'])).toBe('read');
  });

  it('reports every absent or non-array list as UNREADABLE — never as zero', () => {
    for (const missing of [undefined, null, {}, 'agents', 3, NaN, () => undefined]) {
      expect(readPayoutIntegritySourceState(missing)).toBe('unreadable');
    }
  });

  it('states the unreadable list in words, and prints no count of any kind', () => {
    // The unavailable statement REPLACES the counts sentence, so no figure of 0
    // can appear beside a claim that nothing was read.
    const unavailable = describePayoutIntegritySourceSentence('unreadable');
    expect(unavailable).toContain('unknown');
    expect(unavailable).not.toMatch(/\d/);
    expect(unavailable).not.toContain('hub row(s) read');
  });

  it('states the counts for a list that WAS read, including a genuine empty one', () => {
    // A read empty list is the one case where a zero count is the truth, so the
    // counts sentence is still printed for it.
    const empty = describePayoutIntegritySourceSentence('read', summarizePayoutIntegrity([]));
    expect(empty).toContain('0 hub row(s) read: 0 payable, 0 not payable, of which 0');
    expect(empty).not.toContain(PAYOUT_INTEGRITY_SOURCE_UNREADABLE_TEXT);

    const rows = readPayoutIntegrityHubs([hub({ id: 'a' }), hub({ id: 'b' })]);
    // Neither fixture carries a verdict, so both are not payable AND unreadable —
    // the sentence states both figures rather than collapsing them.
    expect(
      describePayoutIntegritySourceSentence('read', summarizePayoutIntegrity(rows)),
    ).toContain('2 hub row(s) read: 0 payable, 2 not payable, of which 2');
  });

  it('keeps the three states distinguishable from one another', () => {
    // valid-empty vs missing vs valid-but-zero-ineligible: three different facts.
    const readEmpty = describePayoutIntegritySourceSentence(
      'read',
      summarizePayoutIntegrity(readPayoutIntegrityHubs([])),
    );
    const missing = describePayoutIntegritySourceSentence(
      'unreadable',
      summarizePayoutIntegrity(readPayoutIntegrityHubs(undefined)),
    );
    const zeroIneligible = describePayoutIntegritySourceSentence(
      'read',
      summarizePayoutIntegrity(
        readPayoutIntegrityHubs([
          hub({ id: 'ok', payout_eligibility: verdict({ eligible: true, risk_class: 'eligible' }) }),
        ]),
      ),
    );

    expect(readEmpty).not.toBe(missing);
    expect(missing).not.toBe(zeroIneligible);
    // Both read states assert the array was read; only the missing one disclaims it.
    expect(missing).toContain('did not carry a readable list');
    expect(readEmpty).not.toContain('did not carry a readable list');
    expect(zeroIneligible).not.toContain('did not carry a readable list');
  });
});

describe('the rows and the summary are exactly what the payload contained', () => {
  it('names a hub the payload did not name instead of leaving the cell blank', () => {
    const row = readPayoutIntegrityHubRow({})!;
    expect(row.businessName).toBe('Hub name not recorded');
    expect(row.agentId).toBeNull();
  });

  it('drops an entry that is not an object rather than inventing an empty hub', () => {
    expect(readPayoutIntegrityHubRow(null)).toBeNull();
    expect(readPayoutIntegrityHubRow('hub')).toBeNull();
    expect(readPayoutIntegrityHubs([null, hub({ id: 'a' }), 5, hub({ id: 'b' })])).toHaveLength(2);
  });

  it('returns no rows for a payload that is not an array', () => {
    for (const bad of [undefined, null, {}, 'agents', 3]) {
      expect(readPayoutIntegrityHubs(bad)).toEqual([]);
    }
  });

  it('counts the rows it rendered, so a figure can never disagree with the table below it', () => {
    const rows = readPayoutIntegrityHubs([
      hub({ id: 'payable', payout_eligibility: verdict({ eligible: true, risk_class: 'eligible' }) }),
      hub({ id: 'refused', payout_eligibility: verdict() }),
      hub({ id: 'unreadable' }),
    ]);
    expect(summarizePayoutIntegrity(rows)).toEqual({
      total: 3,
      payable: 1,
      notPayable: 2,
      unreadable: 1,
    });
    expect(summarizePayoutIntegrity([])).toEqual({ total: 0, payable: 0, notPayable: 0, unreadable: 0 });
  });
});
