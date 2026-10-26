import { describe, expect, it } from 'vitest';
import { mapAdminNotificationItem, type AdminNotificationRow } from '../../../../services/adminNotificationsApi';
import {
  NOT_RECORDED_TEXT,
  describeAttempts,
  describeNotificationChannel,
  describeNotificationStatus,
  describeRetryOutcome,
  describeServerCapNotice,
  outboxEmptyCopy,
  paginateOutbox,
  planRetryClick,
  retryEligibility,
} from '../notificationOutboxPresentation';

// =============================================================================
// BATCH A2 — THE OUTBOX READ MODEL
// =============================================================================
// These are the decisions the screen makes in WORDS and in ELIGIBILITY, executed
// directly (no DOM, no network). They matter because each one is a claim about a
// delivery that may or may not have happened:
//   * which statuses say "a person must decide" versus "the server may resend";
//   * whether retry is offered at all;
//   * whether a second click can become a second send;
//   * whether an empty window is described as "nothing matches" or as "nothing
//     has ever failed".
//
// Fixtures are built through the REAL mapper (mapAdminNotificationItem) so the
// vocabulary these tests exercise is the one the client actually produces.
// =============================================================================

function row(overrides: Record<string, unknown> = {}): AdminNotificationRow {
  const mapped = mapAdminNotificationItem({
    id: 'ne-1',
    eventType: 'ITEM_HANDED_OVER',
    channel: 'email',
    provider: 'resend',
    status: 'retryable_failure',
    recipientReference: 'o***@example.com',
    lastError: 'provider_550_message_rejected',
    businessReference: 'CLM-1',
    retryClass: 'reconstructable',
    retryable: true,
    attemptCount: 2,
    retryAttemptCount: 1,
    createdAt: '2026-01-01T09:00:00.000Z',
    updatedAt: '2026-01-01T09:05:00.000Z',
    sentAt: null,
    nextAttemptAt: null,
    ...overrides,
  });
  if (!mapped) throw new Error('fixture did not map');
  return mapped;
}

describe('status wording never turns "unknown" into something safe', () => {
  it('describes the four statuses the operator list can return', () => {
    expect(describeNotificationStatus('retryable_failure').label).toBe('Retryable failure');
    expect(describeNotificationStatus('permanent_failure').tone).toBe('danger');
    expect(describeNotificationStatus('unknown').label).toBe('Unknown outcome');
    expect(describeNotificationStatus('unknown').meaning).toContain('may already have arrived');
    expect(describeNotificationStatus('failed').meaning).toContain('never retries it');
  });

  it('states an unrecognised status as unrecognised rather than guessing', () => {
    const described = describeNotificationStatus('quantum_failure');
    expect(described.label).toBe('Unrecognised status — quantum_failure');
    expect(described.tone).toBe('neutral');
    expect(described.meaning).toContain('does not recognise');
  });

  it('renders a missing status as "Not recorded"', () => {
    expect(describeNotificationStatus(null).label).toBe(NOT_RECORDED_TEXT);
  });

  it('names the channel in the schema vocabulary and flags anything else', () => {
    expect(describeNotificationChannel('sms')).toBe('SMS');
    expect(describeNotificationChannel('email')).toBe('Email');
    expect(describeNotificationChannel(null)).toBe(NOT_RECORDED_TEXT);
    expect(describeNotificationChannel('pigeon')).toContain('Unrecognised channel');
  });
});

describe('attempt history is stated, never invented', () => {
  it('states the counts in words', () => {
    expect(describeAttempts(row({ attemptCount: 1, retryAttemptCount: 0 }))).toBe('1 attempt, 0 retries');
    expect(describeAttempts(row({ attemptCount: 3, retryAttemptCount: 2 }))).toBe('3 attempts, 2 retries');
  });

  it('says the counts were not recorded instead of printing zero', () => {
    expect(describeAttempts(row({ attemptCount: null, retryAttemptCount: null })))
      .toBe('Attempts not recorded');
    // One of the two missing is stated, not silently treated as 0.
    expect(describeAttempts(row({ attemptCount: null, retryAttemptCount: 1 })))
      .toBe('attempts not recorded, 1 retry');
  });
});

describe('retry is offered only where the route would accept it', () => {
  it('allows a retryable failure that the server says it can rebuild', () => {
    const eligibility = retryEligibility(row());
    expect(eligibility.allowed).toBe(true);
    expect(eligibility.reason).toContain('administrator session');
  });

  it('refuses a row the server says it cannot rebuild', () => {
    const eligibility = retryEligibility(row({ eventType: 'PAYMENT_RECEIVED', retryable: false }));
    expect(eligibility.allowed).toBe(false);
    expect(eligibility.reason).toContain('cannot be re-sent');
  });

  it('refuses an unknown outcome even when the type is rebuildable', () => {
    const eligibility = retryEligibility(row({ status: 'unknown' }));
    expect(eligibility.allowed).toBe(false);
    expect(eligibility.reason).toContain("'unknown'");
  });

  it('refuses a row with no id, because the endpoint cannot address it', () => {
    const eligibility = retryEligibility(row({ id: null }));
    expect(eligibility.allowed).toBe(false);
    expect(eligibility.reason).toContain('No notification id');
  });

  it('treats a non-boolean retryable flag as NOT retryable (fails closed)', () => {
    expect(row({ retryable: 'true' }).retryable).toBe(false);
    expect(retryEligibility(row({ retryable: 'yes' })).allowed).toBe(false);
  });
});

describe('a click cannot become two sends', () => {
  it('ignores any click while a retry is in flight', () => {
    expect(planRetryClick({ row: row(), inFlightId: 'ne-1', confirmingId: null }))
      .toEqual({ action: 'ignored', why: 'in-flight' });
  });

  it('ignores a second click on the row already awaiting confirmation', () => {
    expect(planRetryClick({ row: row(), inFlightId: null, confirmingId: 'ne-1' }))
      .toEqual({ action: 'ignored', why: 'already-confirming' });
  });

  it('refuses an ineligible row with the same sentence the table shows', () => {
    const ineligible = row({ status: 'permanent_failure' });
    const plan = planRetryClick({ row: ineligible, inFlightId: null, confirmingId: null });
    expect(plan.action).toBe('refused');
    expect(plan.action === 'refused' && plan.reason).toBe(retryEligibility(ineligible).reason);
  });

  it('opens the confirmation for an eligible row when nothing is in flight', () => {
    expect(planRetryClick({ row: row(), inFlightId: null, confirmingId: null }))
      .toEqual({ action: 'open-confirmation' });
  });
});

describe('paging slices the rows that were received — nothing more', () => {
  const rows = Array.from({ length: 25 }, (_, index) => row({ id: `ne-${index + 1}` }));

  it('reports the page, the page count and the visible range', () => {
    const first = paginateOutbox(rows, 1, 10);
    expect(first.page).toBe(1);
    expect(first.pageCount).toBe(3);
    expect(first.total).toBe(25);
    expect(first.rows).toHaveLength(10);
    expect(first.firstIndex).toBe(1);
    expect(first.lastIndex).toBe(10);

    const last = paginateOutbox(rows, 3, 10);
    expect(last.rows).toHaveLength(5);
    expect(last.firstIndex).toBe(21);
    expect(last.lastIndex).toBe(25);
  });

  it('clamps an out-of-range page instead of showing an empty table', () => {
    expect(paginateOutbox(rows, 99, 10).page).toBe(3);
    expect(paginateOutbox(rows, 0, 10).page).toBe(1);
    expect(paginateOutbox(rows, 99, 10).rows).toHaveLength(5);
  });

  it('reports an empty window as one empty page rather than zero pages', () => {
    const empty = paginateOutbox([], 2, 10);
    expect(empty.pageCount).toBe(1);
    expect(empty.page).toBe(1);
    expect(empty.firstIndex).toBeNull();
    expect(empty.lastIndex).toBeNull();
    expect(empty.rows).toEqual([]);
  });
});

describe('a retry result is reported as what the server said', () => {
  it('describes a genuine resend as a resend', () => {
    expect(describeRetryOutcome('sent')).toContain('re-sent this notification');
  });

  it('describes every refusal as a refusal', () => {
    const refusals = [
      'not_retryable_event',
      'not_a_retryable_state',
      'not_due_yet',
      'claim_lost',
      'missing_business_reference',
      'reconstruction_unavailable',
      'retry_budget_exhausted',
    ];
    for (const outcome of refusals) {
      const sentence = describeRetryOutcome(outcome);
      expect(sentence).toContain('refused');
      expect(sentence).toContain('nothing was re-sent');
    }
  });

  it('never claims delivery for a failed or unknown dispatch', () => {
    expect(describeRetryOutcome('dispatch_failed')).toContain('remains a failure');
    expect(describeRetryOutcome('dispatch_unknown')).toContain('may or may not have arrived');
  });

  it('says an unrecognised outcome cannot be read', () => {
    expect(describeRetryOutcome(null)).toContain('report an outcome');
    expect(describeRetryOutcome('something_new')).toContain('report an outcome');
  });
});

describe('an empty window says which question came back empty', () => {
  it('distinguishes "nothing matches these filters" from "nothing has failed"', () => {
    const narrowed = outboxEmptyCopy({ status: 'retryable_failure', eventType: '', channel: '' });
    expect(narrowed.title).toBe('No notifications match these filters');

    const unfiltered = outboxEmptyCopy({ status: '', eventType: '', channel: '' });
    expect(unfiltered.title).toBe('No notification failures in this read');
    expect(unfiltered.description).toContain('not proof that nothing has ever failed');
  });

  it('states the server cap only when the window was actually filled', () => {
    expect(describeServerCapNotice(199, 200)).toBe('');
    const notice = describeServerCapNotice(200, 200);
    expect(notice).toContain('maximum of 200 rows');
    expect(notice).toContain('no offset or cursor');
  });
});
