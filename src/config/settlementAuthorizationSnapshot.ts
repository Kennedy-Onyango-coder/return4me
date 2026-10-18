// =============================================================================
// BATCH 3 — WHAT THE ADMINISTRATOR ACTUALLY APPROVED.
// =============================================================================
//
// THE GAP THIS CLOSES
//   `settlement_approved_at` / `settlement_approved_by` record WHO approved and
//   WHEN, but nothing recorded WHAT was approved. Between approval and a later
//   initiation the claim's payable facts are ordinary mutable state: the
//   category's shares, the item's locked shares, the agent's stored payout
//   destination, the ledger rows themselves. Batch 1.1 already refuses a payout
//   that disagrees with the ledger rows BOOKED at handover, which is the
//   strongest pre-existing binding. This module adds the missing approval-time
//   binding: the total the administrator saw and the exact ledger legs the
//   approval covered.
//
// WHAT IS PERSISTED (and why not the destinations)
//   `claims.settlement_authorized_total`  — the payout total at approval time.
//   `claims.settlement_authorized_ledger_ids` — `role:id` pairs of the payout
//     legs the approval covered, canonically sorted.
//   Destinations are deliberately NOT duplicated. Each leg is identified by its
//   ledger ROW, and that row's `phone_or_till` is an immutable booking-time
//   snapshot (Batch 1.1 compares the planned destination against it). Adding a
//   second copy of every recipient's phone number to `claims` would duplicate
//   PII without adding a comparison the row-id binding does not already make
//   possible.
//
// LEGACY APPROVALS (both columns NULL)
//   An approval recorded before this batch has no snapshot. That is NOT treated
//   as a mismatch, because it would permanently block a payout that was
//   legitimately approved and cannot be re-approved (approval is immutable).
//   It is reported as `legacy` and the caller records that fact; the payout is
//   still bound to its booked ledger rows by the Batch 1.1 integrity check.
//   A HALF-present snapshot (one column set, the other NULL) is a refusal: no
//   writer in this codebase can produce it, so treating it as legacy would turn
//   corrupted state into an authorization.
//
// WHAT THIS MODULE DOES NOT DO
//   It reads nothing, writes nothing and touches no provider. It is pure, so the
//   whole comparison matrix is unit-testable (the repository runs vitest in a
//   `node` environment and cannot import server.ts).
// =============================================================================

export type SettlementAuthorizationLegRole = 'finder' | 'agent';

/** One payout leg as it exists at the moment being compared. */
export interface SettlementAuthorizationLeg {
  ledgerEntryId: string;
  recipientType: SettlementAuthorizationLegRole;
  amount: number | string | null | undefined;
}

export interface SettlementAuthorizationSnapshot {
  /** True only when every leg is identifiable and its amount is readable. */
  readable: boolean;
  /** Why an unreadable snapshot could not be built. */
  reason:
    | null
    | 'no_payout_legs'
    | 'missing_ledger_id'
    | 'duplicate_ledger_id'
    | 'unreadable_amount';
  /** Sum of the legs, in minor units (KES cents). Null when unreadable. */
  totalMinorUnits: number | null;
  /** Canonical `role:id` identifiers, sorted by role. Empty when unreadable. */
  ledgerIds: string[];
  /** The persisted form of `ledgerIds`. Empty string when unreadable. */
  serializedLedgerIds: string;
}

/** The persisted approval snapshot, as read back from the claim row. */
export interface StoredSettlementAuthorization {
  /** `claims.settlement_authorized_total` (NUMERIC may arrive as a string). */
  authorizedTotal: number | string | null | undefined;
  /** `claims.settlement_authorized_ledger_ids` (TEXT). */
  authorizedLedgerIds: string | null | undefined;
}

export type SettlementAuthorizationVerdict =
  /** No snapshot on file (approval predates the snapshot). Not a refusal. */
  | { ok: true; code: 'legacy_approval'; totalMinorUnits: null }
  /** Snapshot matches the current legs exactly. */
  | { ok: true; code: 'matches'; totalMinorUnits: number }
  /** The approval cannot be compared with the current legs. Refuse. */
  | {
      ok: false;
      code:
        | 'incomplete_snapshot'
        | 'unparseable_snapshot'
        | 'unreadable_authorized_total'
        | 'no_payout_legs'
        | 'current_legs_unreadable'
        | 'ledger_ids_changed'
        | 'amount_changed';
      message: string;
    };

const ROLE_ORDER: SettlementAuthorizationLegRole[] = ['finder', 'agent'];

function normaliseRole(value: unknown): SettlementAuthorizationLegRole {
  return value === 'agent' ? 'agent' : 'finder';
}

/** NUMERIC(10,2) -> integer minor units. Null for anything not a usable amount. */
export function toMinorUnits(amount: number | string | null | undefined): number | null {
  if (amount === null || amount === undefined) return null;
  if (typeof amount === 'number' && !Number.isFinite(amount)) return null;
  const text = (typeof amount === 'number' ? amount.toString() : String(amount)).trim();
  // Non-negative decimal only. Deliberately string-based: `250.005 * 100` is
  // 25000.499999999996 in binary floating point, so a numeric round would turn a
  // half-cent UP into a DOWN — the wrong direction for money.
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const whole = Number(match[1]);
  if (!Number.isSafeInteger(whole)) return null;
  const fraction = (match[2] ?? '').padEnd(3, '0');
  let minor = whole * 100 + Number(fraction.slice(0, 2));
  if (Number(fraction[2]) >= 5) minor += 1;
  return minor;
}

function formatMinorUnits(minor: number): string {
  return (minor / 100).toFixed(2);
}


/**
 * Build the canonical snapshot from the payout legs that exist right now.
 *
 * FAIL-CLOSED: a duplicate id, a blank id, no legs at all, or an unreadable
 * amount yields `readable: false` with the specific reason. The caller must then
 * refuse (at approval time) or treat it as unverifiable (at initiation time) —
 * never "assume they match".
 */
export function buildSettlementAuthorizationSnapshot(
  legs: readonly SettlementAuthorizationLeg[] | null | undefined,
): SettlementAuthorizationSnapshot {
  const supplied = Array.isArray(legs) ? legs : [];
  const unreadable = (reason: SettlementAuthorizationSnapshot['reason']) => ({
    readable: false as const,
    reason,
    totalMinorUnits: null,
    ledgerIds: [] as string[],
    serializedLedgerIds: '',
  });

  if (supplied.length === 0) return unreadable('no_payout_legs');

  const entries: Array<{ role: SettlementAuthorizationLegRole; id: string }> = [];
  const seen = new Set<string>();
  let totalMinorUnits = 0;

  for (const leg of supplied) {
    const id = typeof leg?.ledgerEntryId === 'string' ? leg.ledgerEntryId.trim() : '';
    if (id === '') return unreadable('missing_ledger_id');
    const role = normaliseRole(leg?.recipientType);
    if (seen.has(id)) return unreadable('duplicate_ledger_id');
    seen.add(id);
    const minor = toMinorUnits(leg?.amount);
    if (minor === null) return unreadable('unreadable_amount');
    totalMinorUnits += minor;
    entries.push({ role, id });
  }

  entries.sort((a, b) => {
    const roleDelta = ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role);
    if (roleDelta !== 0) return roleDelta;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const ledgerIds = entries.map((entry) => `${entry.role}:${entry.id}`);
  return {
    readable: true,
    reason: null,
    totalMinorUnits,
    ledgerIds,
    serializedLedgerIds: ledgerIds.join(','),
  };
}

/**
 * Parse the persisted `role:id,role:id` form. Null when the text is not exactly
 * that shape — an unrecognised form is unverifiable, not empty.
 */
export function parseSettlementAuthorizationLedgerIds(
  stored: string | null | undefined,
): Array<{ role: SettlementAuthorizationLegRole; id: string }> | null {
  if (typeof stored !== 'string') return null;
  const trimmed = stored.trim();
  if (trimmed === '') return null;
  const out: Array<{ role: SettlementAuthorizationLegRole; id: string }> = [];
  const seen = new Set<string>();
  for (const part of trimmed.split(',')) {
    const separator = part.indexOf(':');
    if (separator <= 0) return null;
    const roleText = part.slice(0, separator).trim();
    const id = part.slice(separator + 1).trim();
    if (id === '' || seen.has(id)) return null;
    if (roleText !== 'finder' && roleText !== 'agent') return null;
    seen.add(id);
    out.push({ role: roleText, id });
  }
  return out;
}


/**
 * Compare the stored approval snapshot with the legs the attempt WOULD submit.
 *
 * ORDER-INDEPENDENT on the ids (the persistence layer sorts them) and exact on
 * the total at currency precision. Every ambiguity is a refusal.
 */
export function compareSettlementAuthorization(
  stored: StoredSettlementAuthorization,
  currentLegs: readonly SettlementAuthorizationLeg[] | null | undefined,
): SettlementAuthorizationVerdict {
  const authorizedIdsRaw =
    typeof stored?.authorizedLedgerIds === 'string' ? stored.authorizedLedgerIds.trim() : '';
  const authorizedTotalRaw =
    stored?.authorizedTotal === null || stored?.authorizedTotal === undefined
      ? ''
      : String(stored.authorizedTotal).trim();

  if (authorizedIdsRaw === '' && authorizedTotalRaw === '') {
    return { ok: true, code: 'legacy_approval', totalMinorUnits: null };
  }

  if (authorizedIdsRaw === '' || authorizedTotalRaw === '') {
    return {
      ok: false,
      code: 'incomplete_snapshot',
      message:
        'the settlement approval has an incomplete amount/row snapshot ' +
        '(one of settlement_authorized_total / settlement_authorized_ledger_ids is missing), so the ' +
        'payout cannot be proven to be the one that was approved',
    };
  }

  const authorizedIds = parseSettlementAuthorizationLedgerIds(authorizedIdsRaw);
  if (authorizedIds === null) {
    return {
      ok: false,
      code: 'unparseable_snapshot',
      message:
        'the settlement approval snapshot of approved payout rows could not be read, so the payout ' +
        'cannot be proven to be the one that was approved',
    };
  }

  const authorizedTotalMinor = toMinorUnits(authorizedTotalRaw);
  if (authorizedTotalMinor === null) {
    return {
      ok: false,
      code: 'unreadable_authorized_total',
      message:
        'the total amount recorded by the settlement approval could not be read as currency, so the ' +
        'payout cannot be proven to be the one that was approved',
    };
  }

  const current = buildSettlementAuthorizationSnapshot(currentLegs);
  if (!current.readable) {
    return {
      ok: false,
      code: current.reason === 'no_payout_legs' ? 'no_payout_legs' : 'current_legs_unreadable',
      message:
        `the claim's payout rows could not be read unambiguously (${current.reason ?? 'unknown'}), so ` +
        'they cannot be compared with what was approved',
    };
  }

  const authorizedKeys = authorizedIds.map((entry) => `${entry.role}:${entry.id}`).sort();
  const currentKeys = [...current.ledgerIds].sort();
  const sameIds =
    authorizedKeys.length === currentKeys.length &&
    authorizedKeys.every((key, index) => key === currentKeys[index]);

  if (!sameIds) {
    return {
      ok: false,
      code: 'ledger_ids_changed',
      message:
        `the payout rows being submitted (${currentKeys.join(', ')}) are not the rows the settlement ` +
        `approval covered (${authorizedKeys.join(', ')})`,
    };
  }

  if (authorizedTotalMinor !== current.totalMinorUnits) {
    return {
      ok: false,
      code: 'amount_changed',
      message:
        `the approved total KES ${formatMinorUnits(authorizedTotalMinor)} does not match the total this ` +
        `attempt would submit KES ${formatMinorUnits(current.totalMinorUnits ?? 0)}`,
    };
  }

  return { ok: true, code: 'matches', totalMinorUnits: current.totalMinorUnits };
}
