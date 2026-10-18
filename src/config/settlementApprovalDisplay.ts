// =============================================================================
// POST-BATCH-4 GATE 2 — WHAT THE ADMINISTRATOR APPROVED, AS DISPLAY DATA.
// =============================================================================
//
// THE GAP THIS CLOSES
//   Batch 3 persists WHAT an approval covered: `claims.settlement_authorized_total`
//   and `claims.settlement_authorized_ledger_ids`. The settlement executor already
//   refuses an attempt that disagrees with either (Batch 3) or with a booked
//   ledger row (Batch 1.1). Nothing, however, SHOWED those facts to a human: the
//   Admin Console could say only WHO approved and WHEN. An operator preparing to
//   pay therefore could not see the amount that was approved, which payout rows it
//   covered, or whether the claim even HAS a snapshot.
//
// WHAT THIS MODULE IS (AND IS NOT)
//   A pure, read-only description of the PERSISTED approval. It decides nothing
//   about payment — the gate remains `compareSettlementAuthorization()` in
//   config/settlementAuthorizationSnapshot.ts, and this module does not
//   re-implement, weaken or bypass it. It exists so the console can render the
//   same facts the gate compares, from the same columns.
//
// THE FOUR RULES THAT MAKE IT SAFE TO SHOW
//   1. THE APPROVED TOTAL IS THE PERSISTED COLUMN. It is never recomputed from
//      the current ledger rows, from `items.locked_total_fee` or from any client
//      state. A number calculated now is not the number that was approved.
//   2. THE COVERED ROWS ARE THE PERSISTED `role:id` IDENTIFIERS. Each is only
//      ANNOTATED with the amount BOOKED on that ledger row (the booking-time
//      record the executor enforces). A row that is absent, unreadable or of the
//      wrong type is reported as such rather than silently dropped or repaired.
//   3. EVERY UNUSABLE STATE IS NAMED. `legacy` (an approval recorded before the
//      snapshot existed), `incomplete` (exactly one column set), `unreadable`
//      (present but not parseable) and `not_approved` (no approval at all) are
//      distinct, explicit states. A screen therefore shows an unavailable or
//      legacy approval — never a substitute amount.
//   4. NO PII. A covered row is identified by its ledger row id and role only.
//      The row's `phone_or_till` is never read here, because the approval does
//      not store destinations and the console does not need them to show what
//      was authorized.
// =============================================================================

import {
  parseSettlementAuthorizationLedgerIds,
  toMinorUnits,
  type SettlementAuthorizationLegRole,
} from './settlementAuthorizationSnapshot';

/** Every state a screen may have to render. */
export type SettlementApprovalDisplayState =
  /** No approval recorded: no snapshot can authorize anything. */
  | 'not_approved'
  /** A readable snapshot: total and covered rows are the persisted ones. */
  | 'authorized'
  /** Approved before Batch 3: no total and no row list were ever recorded. */
  | 'legacy'
  /** Exactly one of the two snapshot columns is set — refused at initiation. */
  | 'incomplete'
  /** Both columns are set but cannot be read — refused at initiation. */
  | 'unreadable';

/** The persisted claim facts this module reads. Nothing else is consulted. */
export interface SettlementApprovalClaimFacts {
  /** `claims.settlement_approved_at`. NULL means no approval on file. */
  approvedAt?: string | null;
  /** `claims.settlement_authorized_total` (NUMERIC may arrive as a string). */
  authorizedTotal?: number | string | null;
  /** `claims.settlement_authorized_ledger_ids` (TEXT). */
  authorizedLedgerIds?: string | null;
}

/** The ledger facts a covered row may be annotated with. */
export interface SettlementPayoutLedgerRowFacts {
  id: string;
  /** `ledger.type`; used only to confirm the row is the leg it claims to be. */
  type?: string | null;
  /** `ledger.amount`, the amount BOOKED for that row. */
  amount?: number | string | null;
}

export interface SettlementApprovalLedgerRow {
  role: SettlementAuthorizationLegRole;
  ledgerEntryId: string;
  /** Canonical `role:id`, the exact string the snapshot stores. */
  key: string;
  /** The booked amount at currency precision, or null when unreadable/absent. */
  bookedAmount: string | null;
  /** False when the approval covered a row that is no longer in the ledger. */
  ledgerRowFound: boolean;
  /**
   * False when the row exists but its `ledger.type` is not the role recorded by
   * the approval. Null when the row is absent or carries no type.
   */
  ledgerRowRoleMatches: boolean | null;
}

export interface SettlementApprovalDisplay {
  state: SettlementApprovalDisplayState;
  /** The persisted approved total formatted at currency precision; null unless `authorized`. */
  authorizedTotal: string | null;
  /** The rows the approval covered, in canonical role order; [] unless `authorized`. */
  rows: SettlementApprovalLedgerRow[];
  /** Canonical `role:id` keys; [] unless `authorized`. */
  ledgerIds: string[];
  /**
   * Diagnostic only, and never a substitute amount: true when every covered row
   * was found, its amount readable, and their sum equals the PERSISTED approved
   * total. Null when that cannot be determined. It mirrors the executor's
   * comparison for the operator's benefit; the executor still decides.
   */
  bookedRowsAgreeWithApproval: boolean | null;
  /** Operator-facing explanation of the state. Never contains a computed amount. */
  note: string;
}

/**
 * Format a persisted currency amount (NUMERIC) at currency precision.
 *
 * String-based through `toMinorUnits`, exactly like the gate, so display and
 * refusal agree on how a value is read. Null for anything that is not a
 * non-negative decimal — a value this build cannot read is never guessed.
 */
export function formatPersistedCurrencyAmount(
  amount: number | string | null | undefined,
): string | null {
  const minor = toMinorUnits(amount);
  if (minor === null) return null;
  return (minor / 100).toFixed(2);
}

const LEDGER_ROLE_BY_TYPE: Record<string, SettlementAuthorizationLegRole> = {
  finder_payout: 'finder',
  agent_payout: 'agent',
};

export const SETTLEMENT_APPROVAL_NOTES: Record<SettlementApprovalDisplayState, string> = {
  not_approved:
    'No settlement approval is recorded, so no amount or set of payout rows has been authorized. Payout initiation is refused until an approval is on file.',
  authorized:
    'The approved total and the payout rows shown are the values recorded by the approval itself. The payout is refused if those rows or their amounts no longer match them.',
  legacy:
    'This approval was recorded before approved amounts were stored, so the approved total and the covered payout rows are not available. The payout remains bound to the payout rows booked at handover, and the server refuses it if any row or amount has changed.',
  incomplete:
    'The approval on file carries only part of its amount/row record, so the approved total and covered rows cannot be shown. The server refuses the payout until an administrator reviews the claim and the approval.',
  unreadable:
    'The approval on file carries an amount/row record this build cannot read, so the approved total and covered rows cannot be shown. The server refuses the payout until an administrator reviews the claim and the approval.',
};

/**
 * Describe the approval on file for a claim. Pure and total: every input,
 * including a missing claim, produces a named state.
 */
export function describeSettlementApproval(
  claim: SettlementApprovalClaimFacts | null | undefined,
  ledgerRows?: readonly SettlementPayoutLedgerRowFacts[] | null,
): SettlementApprovalDisplay {
  const approvedAt = claim?.approvedAt;
  const approved = typeof approvedAt === 'string' && approvedAt.trim() !== '';

  // `''` and NULL are the same fact here — nothing was stored — but a HALF-set
  // pair is not: it is corrupt state the gate refuses, and it must not be shown
  // as a legacy approval (see the module header).
  const totalText = claim?.authorizedTotal === null || claim?.authorizedTotal === undefined
    ? ''
    : String(claim.authorizedTotal).trim();
  const idsText = typeof claim?.authorizedLedgerIds === 'string'
    ? claim.authorizedLedgerIds.trim()
    : '';

  const empty = {
    authorizedTotal: null,
    rows: [] as SettlementApprovalLedgerRow[],
    ledgerIds: [] as string[],
    bookedRowsAgreeWithApproval: null,
  };

  if (!approved) {
    // A snapshot without an approval cannot authorize anything: the route that
    // pays requires the approval column, so showing an amount here would imply
    // an authorization that does not exist.
    return { ...empty, state: 'not_approved', note: SETTLEMENT_APPROVAL_NOTES.not_approved };
  }

  if (totalText === '' && idsText === '') {
    return { ...empty, state: 'legacy', note: SETTLEMENT_APPROVAL_NOTES.legacy };
  }

  if (totalText === '' || idsText === '') {
    return { ...empty, state: 'incomplete', note: SETTLEMENT_APPROVAL_NOTES.incomplete };
  }

  const parsedIds = parseSettlementAuthorizationLedgerIds(idsText);
  const approvedTotalMinor = toMinorUnits(totalText);
  if (parsedIds === null || parsedIds.length === 0 || approvedTotalMinor === null) {
    return { ...empty, state: 'unreadable', note: SETTLEMENT_APPROVAL_NOTES.unreadable };
  }

  const rowsById = new Map<string, SettlementPayoutLedgerRowFacts>();
  for (const row of Array.isArray(ledgerRows) ? ledgerRows : []) {
    if (row && typeof row.id === 'string') rowsById.set(row.id, row);
  }

  let bookedTotalMinor = 0;
  let bookedRowsReadable = true;
  const rows: SettlementApprovalLedgerRow[] = parsedIds.map((entry) => {
    const ledgerRow = rowsById.get(entry.id);
    const bookedMinor = ledgerRow ? toMinorUnits(ledgerRow.amount) : null;
    if (bookedMinor === null) bookedRowsReadable = false;
    else bookedTotalMinor += bookedMinor;

    const ledgerRole = ledgerRow && typeof ledgerRow.type === 'string'
      ? LEDGER_ROLE_BY_TYPE[ledgerRow.type] ?? null
      : null;

    return {
      role: entry.role,
      ledgerEntryId: entry.id,
      key: `${entry.role}:${entry.id}`,
      bookedAmount: bookedMinor === null ? null : (bookedMinor / 100).toFixed(2),
      ledgerRowFound: ledgerRow !== undefined,
      ledgerRowRoleMatches: ledgerRow === undefined || ledgerRole === null ? null : ledgerRole === entry.role,
    };
  });

  return {
    state: 'authorized',
    // The PERSISTED total, formatted. Never the sum of the rows below.
    authorizedTotal: (approvedTotalMinor / 100).toFixed(2),
    rows,
    ledgerIds: rows.map((row) => row.key),
    bookedRowsAgreeWithApproval:
      bookedRowsReadable && rows.every((row) => row.ledgerRowFound)
        ? bookedTotalMinor === approvedTotalMinor
        : null,
    note: SETTLEMENT_APPROVAL_NOTES.authorized,
  };
}
