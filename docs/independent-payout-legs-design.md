# Independent payout legs — design note

**Status: design only.** Nothing in this document is implemented. The shipped
settlement executor remains deliberately **all-or-nothing**: if any required leg
is ineligible or fails before submission, no leg in that attempt is submitted.
This note records the problem, the invariants a future change must preserve, and
one recommended design for review. It is not authorization to implement it.

## 1. The current behaviour

A claim has up to two payout legs, one `finder_payout` and one `agent_payout`,
each booked as its own `ledger` row when the claim enters `pending_settlement`.
The executor (`executeClaimSettlement()` in `src/server.ts`) re-reads the claim,
item and booked rows, evaluates every outstanding leg, and builds one provider
batch containing the submittable legs.

The current policy is explicitly all-or-nothing:

- `resolvePayoutBatchEligibility()` reports a batch eligible only when **every**
  leg is eligible;
- one ineligible leg aborts the whole attempt before any pre-submission marker
  or provider request;
- every refused leg is audited with a masked destination and a stable reason;
- the claim returns to `pending_settlement`, and a later initiation may pay the
  corrected batch.

This is a safety property, not an accident. It prevents a mixed outcome in which
one recipient is paid while the other's destination was never valid.

## 2. The problem with all-or-nothing

A legitimate claim can be blocked indefinitely by one bad leg. Examples:

- the finder's destination is a valid Personal M-Pesa number, while the agent's
  stored destination is a Till that the launch policy cannot pay;
- one leg is under provider reconciliation (`accepted`, `unknown` or
  `submitting`) after an earlier attempt, while the other leg is positively
  `not_submitted` and could be paid safely;
- an agent corrects a destination after booking, but the corrected value no
  longer matches the immutable `ledger.phone_or_till` snapshot and requires
  operator repair before that one leg can be released.

The current design withholds money from a blameless recipient until the other
leg is corrected. The business question is whether that delay is acceptable.
The safety question is whether paying the valid leg can be done without creating
a duplicate-transfer or reconciliation hazard.

## 3. Goals

1. Pay a leg only when that leg is independently eligible under the existing
   destination, amount, authorization and submission-outcome rules.
2. Never submit a row that is not positively `status = 'pending'` and
   `payout_outcome = 'not_submitted'`.
3. Keep every leg's idempotency key stable and scoped to the claim and recipient
   role, exactly as `buildPayoutLegIdempotencyKey()` does today.
4. Preserve a truthful claim state: a partially paid claim must never appear
   fully `released`, and a completed row must never be reopened.
5. Keep refusals auditable, masked and attributable, with no automatic retry of
   an unresolved leg.
6. Leave the durable approval snapshot and booked-ledger comparison in force for
   every leg.

## 4. Non-goals

- No change to the provider contract or endpoint.
- No weakening of phone-only destination eligibility.
- No automatic retry of `submitting`, `accepted`, `unknown`, `rejected` or
  legacy-NULL outcomes.
- No silent rewrite of a booked amount or destination.
- No new claim-status vocabulary in this note. Any new state requires a
  separate reviewed migration and transition contract.
- No implementation, migration or provider call as part of this design.

## 5. Options considered

### Option A — keep one batch, but submit eligible legs only

Build the provider batch from the eligible subset and leave ineligible legs
unsubmitted. This is the smallest code change, but it breaks the current
all-or-nothing audit sentence and makes the batch contents depend on a partial
policy. A provider batch could contain only the finder transaction while the
claim still has an agent row. Reconciliation would need to distinguish
"intentionally omitted" from "batch truncated", which the provider response does
not necessarily make clear.

**Assessment:** not recommended. It weakens the meaning of a batch without
giving each leg an independent provider identity.

### Option B — one provider batch per leg

Submit each eligible leg as its own one-transaction batch, sequentially. Each
row already has `provider_batch_id` and `provider_transaction_id`, and the
idempotency key is already per leg, so reconciliation can bind a provider
transaction to exactly one ledger row.

**Assessment: recommended for review.** It gives the strongest per-leg
isolation, keeps the existing row-level state machine, and makes a partial
outcome explicit. The cost is more provider calls and per-call fees/limits that
must be confirmed with IntaSend before launch.

### Option C — configurable grouping

Group adjacent eligible legs into one batch, with a per-claim policy switch.
This preserves batch efficiency but adds a second execution mode and a second
reconciliation interpretation.

**Assessment:** not recommended for a first change. The extra mode is harder to
test exhaustively and gives no safety benefit over Option B.

## 6. Recommended design (Option B, design only)

### 6.1 Unit of work

The unit remains the booked `ledger` row, not the claim. A leg is independently
eligible only when all of the following hold, evaluated on freshly re-read
state immediately before submission:

- the row belongs to the claim and is `finder_payout` or `agent_payout`;
- `status === 'pending'` and `payout_outcome === 'not_submitted'`;
- the planned amount equals the booked amount at currency precision;
- the planned destination equals the booked `phone_or_till` after the existing
  phone normalisation;
- the destination is a Personal M-Pesa phone under the launch allow-list;
- the durable approval snapshot covers this exact row and amount;
- the claim is still `releasing`, payouts are not paused, and the item is not on
  legal hold;
- the wallet routing and simulation gates still pass.

An ineligible leg is skipped **for this attempt only**, audited, and left
untouched. It does not prevent another eligible leg from being submitted.

### 6.2 Claim-level lock and state

The existing `attemptSettlementRelease()` claim-level lock remains the outer
guard. It prevents two administrators initiating the same claim concurrently.
It is not a per-leg lock; row-level eligibility and the pre-submission CAS are
still the final authority.

If at least one leg is submitted and at least one remains outstanding, the claim
must **not** be finalized. The safest first version keeps the claim in
`pending_settlement` after the attempt, records which rows completed, and
returns a result that names both the submitted and withheld legs. A later
initiation may submit only rows that are still `pending` + `not_submitted`.

If every leg completes, the existing `finalizeSettlement()` path runs unchanged.
If no leg can be submitted, the existing refusal path returns the lock through
`abandonRelease()`.

### 6.3 Provider calls and idempotency

For each eligible leg:

1. persist `payout_outcome = 'submitting'` through the existing
   pre-submission marker;
2. call the provider with a one-transaction batch whose `idempotency_key` is
   the existing per-leg key;
3. record the provider batch/transaction identifiers on that row;
4. classify the response with the existing outcome vocabulary;
5. never retry an unresolved outcome automatically.

A failure on leg two must not roll back or re-send leg one. Leg one's completed
row and provider identifiers are durable evidence. The claim result reports the
partial outcome truthfully; it does not say "paid" for the whole claim.

### 6.4 Refusal and audit vocabulary

The existing refusal codes remain the vocabulary. A partial attempt needs one
additional **result shape**, not a new provider outcome: the response should
carry the submitted legs, the withheld legs and each withheld leg's existing
reason code. Audit rows should name the leg, the masked destination and the
reason, never the raw destination.

No new `ledger.payout_outcome` value is required. `completed`, `submitting`,
`accepted`, `unknown`, `rejected` and `not_submitted` retain their current
meanings.

### 6.5 Ledger and claim invariants

- A completed row is never reopened or re-sent.
- A row with any unresolved outcome is never re-sent automatically.
- The sum of completed leg amounts never exceeds the approved snapshot.
- A claim is `released` only when every required leg is `completed`.
- A partially paid claim remains visible in the admin console and provider
  reconciliation queue; it is never described as fully paid.
- The claim-level audit explains why a leg was withheld.

## 7. Failure matrix to test before implementation

Any implementation proposal must include, at minimum:

| Scenario | Required outcome |
| --- | --- |
| Finder eligible, agent ineligible | Finder may be submitted; agent withheld with its code; claim not finalized |
| Finder ineligible, agent eligible | Agent may be submitted; finder withheld; claim not finalized |
| Both eligible | Both submitted, each with its own idempotency key; finalize only after both complete |
| First leg completes, second returns `unknown` | First remains completed; second unresolved; no resubmission; claim not finalized |
| First leg returns `accepted`, second is `not_submitted` | No automatic retry of the first; second follows the explicit policy and is never silently bundled |
| Provider rejects first leg | First `rejected`; no automatic retry; second's treatment is explicit and audited |
| Duplicate initiation races | Claim-level lock admits one attempt; row-level CAS prevents duplicate submission |
| Payouts paused mid-attempt | No new leg is submitted; completed rows stay completed; the rest are withheld |
| Approval snapshot covers only one row | The uncovered row is refused; no substitution of a fresh amount |
| Destination changes after approval | The affected leg is refused; the other leg follows the explicit policy, never a silent batch rewrite |

## 8. Open questions for the product and provider review

1. Is partial payment acceptable to the business, or must both recipients
   always be paid together? This is a policy decision, not a code decision.
2. Does IntaSend charge per batch or per transaction, and are there minimum
   amounts or limits that make one-transaction batches impractical?
3. Can a provider batch contain one transaction with the same documented
   idempotency semantics as a multi-transaction batch?
4. How should the customer/agent-facing status describe a claim where one
   recipient has been paid and the other has not?
5. Does the admin console need a dedicated "partially paid" presentation, or is
   the existing per-row ledger display sufficient?
6. Which role may authorize a retry of a withheld leg, and does that require a
   fresh password confirmation?

## 9. Explicitly not decided here

This note does not choose the product policy for partial payment, does not add a
claim status, does not change the provider request shape, and does not authorize
any implementation. The current all-or-nothing behaviour remains the shipped
contract until a separately reviewed change updates the executor, tests, API
documentation and operator runbook together.
