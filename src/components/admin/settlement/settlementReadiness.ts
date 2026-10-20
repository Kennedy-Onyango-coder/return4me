// =============================================================================
// PHASE 3 — SETTLEMENT READINESS, CLIENT RULES
// =============================================================================
// PURE / React-free. This module owns three things the Pending Settlements
// screen must get right, and nothing else:
//
//   1. The DEPENDENCY KEY. Readiness is server state, but whether it needs to be
//      re-read depends on the dashboard fields that can change a condition. The
//      key includes each claim's durable-approval flag and settle_at, so recording
//      an approval changes the key and triggers a re-read even before the data
//      reload lands.
//   2. The INITIATE GATE. The button is enabled only when the claim has a durable
//      approval, the review window has elapsed, no other action is in flight,
//      and the SERVER's readiness response says `ready: true`. Missing data, a
//      failed read and a pending read all fail CLOSED.
//   3. The RESPONSE READER. A malformed or failed response is an error; it can
//      never be mistaken for `ready: true`.
//
// The initiation route re-decides every condition itself. This is UI gating and
// an operator explanation, never authorization.
// =============================================================================

export interface SettlementReadinessConditionView {
  code: string;
  ok: boolean;
  label: string;
  detail: string;
  next_action: string;
}

export interface SettlementReadinessView {
  ready: boolean;
  blockers: string[];
  conditions: SettlementReadinessConditionView[];
  checked_at?: string;
}

export function settlementReadinessPath(claimId: string): string {
  return `/api/admin/claims/${encodeURIComponent(claimId)}/settlement-readiness`;
}

/**
 * A key over every readiness input the dashboard payload carries.
 *
 * Approval flips from absent → true; settle_at can move; a row can leave the
 * queue. Any of those changes produces a different key, so an effect keyed on
 * it re-reads readiness. The per-claim mutation handlers ALSO call the refresh
 * helper explicitly, because the server can change state for reasons this
 * payload does not expose (for example a concurrent decision).
 */
export function settlementReadinessDependencyKey(rows: unknown): string {
  if (!Array.isArray(rows)) return '';
  return rows
    .map((row) => {
      const claimId = typeof row?.claimId === 'string' ? row.claimId : '';
      if (!claimId) return '';
      const approved = row?.hasSettlementApproval === true ? 'approved' : 'not-approved';
      const settleAt = typeof row?.settleAt === 'string' && row.settleAt ? row.settleAt : 'no-settle-at';
      return `${claimId}:${approved}:${settleAt}`;
    })
    .filter((part) => part !== '')
    .join('|');
}

export interface SettlementInitiateGateInput {
  hasApproval: boolean;
  isDue: boolean;
  /** Any sibling action on this row (approve, approve-and-pay, release, initiate). */
  busy: boolean;
  readiness: SettlementReadinessView | null | undefined;
  readinessLoading: boolean;
  readinessError: string | null;
}

/**
 * The ONE definition of "Initiate payout may be enabled".
 *
 * `readiness?.ready === true` — not `!== false` — is deliberate. A missing entry
 * means "not checked yet", and an optimistic enablement before the recheck lands
 * is exactly the failure this phase fixes.
 */
export function canInitiateSettlementPayout(input: SettlementInitiateGateInput): boolean {
  if (input.busy) return false;
  if (!input.hasApproval || !input.isDue) return false;
  if (input.readinessLoading) return false;
  if (input.readinessError) return false;
  return input.readiness?.ready === true;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Throws on anything that is not the documented readiness envelope. */
export function readSettlementReadinessPayload(body: unknown): SettlementReadinessView {
  const envelope = record(body);
  if (!envelope || typeof envelope.ready !== 'boolean') {
    throw new Error('The readiness response was not readable.');
  }
  if (!Array.isArray(envelope.conditions)) {
    throw new Error('The readiness response carried no checklist.');
  }
  const conditions = envelope.conditions.map((value) => {
    const condition = record(value);
    if (!condition || typeof condition.code !== 'string' || typeof condition.ok !== 'boolean') {
      throw new Error('The readiness checklist contained a malformed condition.');
    }
    return {
      code: condition.code,
      ok: condition.ok,
      label: text(condition.label),
      detail: text(condition.detail),
      next_action: text(condition.next_action),
    };
  });
  const blockers = Array.isArray(envelope.blockers)
    ? envelope.blockers.filter((blocker): blocker is string => typeof blocker === 'string')
    : [];
  return {
    ready: envelope.ready,
    blockers,
    conditions,
    checked_at: typeof envelope.checked_at === 'string' ? envelope.checked_at : undefined,
  };
}

export async function fetchSettlementReadiness(
  token: string | null,
  claimId: string,
): Promise<SettlementReadinessView> {
  if (!token) throw new Error('Your session has expired. Sign in again to check payout readiness.');
  if (!claimId) throw new Error('A claim id is required to check payout readiness.');

  let response: Response;
  try {
    response = await fetch(settlementReadinessPath(claimId), {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new Error('The readiness check could not be reached. Payout initiation stays disabled.');
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const envelope = record(body);
    const serverMessage = envelope && typeof envelope.error === 'string' ? envelope.error : null;
    throw new Error(
      serverMessage || `Readiness request failed (${response.status}). Payout initiation stays disabled.`,
    );
  }

  return readSettlementReadinessPayload(body);
}
