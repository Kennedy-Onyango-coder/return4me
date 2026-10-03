# Agent workflows

An agent is a physical collection point. This document follows an agent from
registration to handover, and records what each step authorizes and what it
changes.

Agents are the only actors who move items. No owner ever receives an item
directly, and no agent handles an item they are not assigned to.

## Registration

Registration runs through the general auth endpoints with `role: 'agent'`, which
carries business name and location address alongside the phone number.

1. The agent submits a phone number, business name and location address.
2. An SMS one-time code is sent to that number.
3. The agent redeems the code, which verifies control of the number and creates
   the agent row.
4. An activation email is sent to the agent's contact address.
5. The agent redeems the activation token at `/activate-agent-email`.

The registration response includes `activationRequired`, which is true only for
an agent whose email is not yet verified. The frontend uses it to show a
"check your inbox" state rather than a logged-in console.

Both the OTP and the activation email are required. The OTP proves the agent
controls the phone number; the activation email proves the agent controls an
address they can be reached at, and is the address settlement confirmations are
sent to.

Activation email failure returns 503 rather than a successful registration. See
[notifications.md](notifications.md) and [authentication.md](authentication.md).

## Approval

A registered agent is not yet an operational agent. Approval is an administrator
action:

| Endpoint | Purpose |
|---|---|
| `POST /api/admin/agents/:id/approve` | Approve the agent |
| `GET /api/admin/agents/:id/documents` | Review submitted documents |
| `POST /api/admin/agents/:id/location` | Assign a location |
| `POST /api/admin/agents/:id/suspend` | Suspend the agent |
| `POST /api/admin/agents/:id/warn` | Record a warning |

Approval and location assignment are separate steps. An approved agent without an
assigned location has no items to work on, because items are surfaced by
location.

## Operational authorization

An agent operational route requires all of:

- the `agent` role on the token, and
- the agent being currently active and approved.

The second condition is checked live, not from the token. Checking the role alone
is not sufficient: a suspended agent whose JWT still had hours of validity left
would otherwise continue to act. A test pins this behaviour for every
operational route.

This check applies to all six operational routes, not just some of them.

## The queue

`GET /api/agents/queue` returns the items assigned to the agent's location. This
is the agent's working list: items physically present that need verification or
are awaiting a claimant.

## Verification

`POST /api/agents/verify-item` records the agent's inspection of an item and what
they found. Where the agent's inspection differs from the finder's original
submission, each changed field is recorded as a row in
`item_verification_changes` with the reason.

The change log is per changed field, not per verification event, so "what did the
agent change, on which field, and why" is answerable after the fact. This is what
an administrator reviews when a claim is disputed.

## Dropoff

An owner brings the item to the agent, or an intermediary does. The agent records
the dropoff:

| Endpoint | Purpose |
|---|---|
| `POST /api/agents/confirm-dropoff` | Item received at the counter |
| `POST /api/agents/reject-dropoff` | Item refused |

Where the item has an active claim, the dropoff is the point at which the pickup
code is checked.

## Viewing

`POST /api/agents/claims/:claimId/confirm-viewing` records that the owner has
personally viewed the item. This is a deliberate step between payment and
handover: it is the evidence that the person collecting is the person who
claimed, and it is what distinguishes this from an unverified proxy collection.

## Handover

`POST /api/agents/confirm-handover` completes the physical transfer. It is the
operational end of the claim and the trigger for settlement.

Handover sends `ITEM_HANDED_OVER` and `FINDER_ITEM_COLLECTED` emails, and an
`ADMIN_TRANSACTION_LOG` email. All three are on the retry-eligible list, so a
failed handover email is retried automatically; the claim itself is not.

Handover evidence photos are subject to a daily retention sweep, which purges
photos past their retention window. This is the one retention category in
[DATA_RETENTION_POLICY.md](DATA_RETENTION_POLICY.md) with an implemented
automated sweep.


## Authorization requirements

| Operation | Requires |
|---|---|
| View queue | `agent` role, currently active |
| Verify an item | `agent` role, currently active |
| Confirm or reject dropoff | `agent` role, currently active |
| Confirm viewing | `agent` role, currently active, assigned to the claim's item |
| Confirm handover | `agent` role, currently active, assigned to the claim's item |
| Approve, suspend, warn, assign location | `admin` role, current admin session |

Assignment matters as much as role. An agent who is active but not assigned to
the item's location cannot act on that item's claim.

## One-time code operations

The agent reads the pickup code aloud and the owner supplies it. Codes are four
digits, hashed at rest, single-use, and covered by the attempt ceilings in
[authentication.md](authentication.md).

An agent may also request a code resend through the claim-scoped endpoint, under
the shared claim-ownership check.

## Payment and settlement consequences

An agent does not move money. Their financial exposure is the disbursement split,
which is released by settlement after the dispute window closes, not at handover.

Concretely:

- Handover does not pay the agent.
- Settlement releases the split through the CAS-guarded release operation.
- A disputed claim pauses settlement.
- `AGENT_PAYMENT_CONFIRMED` is emailed when escrow is held.

The sequence matters operationally: an agent who completes handover has not yet
been paid, and an agent whose claims are frequently disputed will see settlement
delayed or reversed.

## Related

- [claims-and-payments.md](claims-and-payments.md) — the lifecycle the agent drives
- [authentication.md](authentication.md) — agent sessions and activation
- [notifications.md](notifications.md) — codes and confirmations
- [operations.md](operations.md) — sweeps that affect agent-visible state
