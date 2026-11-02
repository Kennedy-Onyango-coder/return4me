# Assignment integrity — Agent service geography

Operational policy for the geographic controls added in Phase 16.1 Batch 3
(Stages 3B-6A to 3B-6E) and for the assignment lifecycle they sit inside
(Stage 3B-7). It states what the platform decides on its own, what an
administrator decides, and what neither may do.

Read this with [`operations.md`](./operations.md) (how to run the console),
[`agent-workflows.md`](./agent-workflows.md) (what an Agent can do) and
[`data-and-privacy.md`](./data-and-privacy.md) (what may be recorded).

## 1. Three geographies that must never be collapsed

| Concept | Stored on | What it means | What it is **not** |
|---|---|---|---|
| Declared find geography | `items.found_county`, `items.administrative_unit_id` | The county/sub-county the Finder selected, re-validated server-side | Not a verified physical location |
| Operational hub coordinate | `agents.latitude`, `agents.longitude` | Where the hub says it operates | Not a boundary test |
| **Service geography** | `agents.county`, `agents.administrative_unit_id` | The county/sub-county the hub is eligible to receive items for | Not where the hub physically is |

The platform holds **no boundary data**. There is no polygon, GeoJSON,
point-in-polygon test or PostGIS call anywhere in assignment. Two values agree
because they name the same county in the canonical list
(`src/config/kenyaCounties.ts`), never because a shape contains a point. Every
structured geography response carries `boundary_verified: false` for exactly this
reason.

## 2. County normalization (Stage 3B-6C)

Matching decides "does this hub serve this item's county?" with
`compareCounties()` in `src/services/agentGeography.ts`, not with `===`.

- Case, leading/trailing whitespace, runs of internal whitespace and the
  documented spelling aliases are tolerated (`nairobi` → `Nairobi City`,
  `muranga` → `Murang'a`).
- A value that does not name a Kenyan county is never guessed at. It matches only
  the identical value, and a county that is missing on either side yields
  `unknown` — which is **not** a match and **not** a mismatch.
- Sub-county ids are configured data (`KE-47-SC-01`), so only case and padding
  are ignored. There is no alias table for sub-counties and none may be invented.

The county remains a **filter**: if no eligible hub serves the item's county, the
item goes to the manual-assignment queue. The scope is never widened
automatically.

## 3. Admin Agent geographic correction (Stage 3B-6A)

`POST /api/admin/agents/:id/geography`

Corrects a hub's **service** geography — its county and sub-county. It does not
move the hub and does not touch its coordinate pair (that is
`POST /api/admin/agents/:id/location`, a separate action on a separate axis).

**When to use it**

- The hub's county was recorded wrongly (the operator picked the neighbouring
  county at signup).
- The hub has no county at all (a legacy row) and is therefore never matched.
- The hub has been re-located to a genuinely different service area.

**Required inputs:** a county from the canonical 47, a sub-county that belongs to
that county, and a reason of at least 10 characters with no phone number, email
address or ID number (the same policy as every manual assignment decision).

**What happens:** the values are canonicalised server-side, the audit trail
records who corrected what, from what, to what
(`ADMIN_AGENT_GEOGRAPHY_CORRECTION`), and the hub becomes matchable for the new
county immediately.

**Post-correction matching.** The correction commits first; then the existing
lifecycle trigger (`matchPendingItemsForOperationalAgent()` — the same call the
approval and location routes already make) runs for this hub before the response
is sent, and the response reports it as `auto_assignment`.

- It runs **outside** the correction's transaction, and it never throws, so a
  matching failure cannot undo — or mis-report as failed — a committed
  correction.
- What it may touch is bounded by code that already exists: the hub must be
  operational (`isAgentActionable()`); the item must be in the manual queue
  (`assigned_agent_id IS NULL`, `needs_manual_agent_reassignment = true`,
  `status = 'awaiting_dropoff'`); the matcher scopes by county, so nothing is
  assigned across a boundary and no radius threshold is consulted; and the
  assignment CAS means a repeat correction assigns an item once and records one
  history event.
- An item in another hub's custody, or one an administrator already placed, is
  **never** taken. Item status is not changed by this pass.

**Not permitted:** clearing the sub-county (registration already requires one — a
correction must not make a hub *less* matchable), storing a non-canonical county,
storing a sub-county from another county, or writing `location_source`. The
provenance column is deliberately left alone: GEO-D+ persists only
`user_selected` as authoritative, so stamping `admin_corrected` would read back
as `NULL` and could erase an existing value. The audit row is the record.

## 4. Suspended-Agent stranded items (Stage 3B-6B)

Suspending a hub closes every Agent route but does **not** move the items already
pointing at it. Those items are *stranded*: still `awaiting_dropoff`, still
assigned, and out of the manual queue.

- `GET /api/admin/agents/:id/stranded-items` classifies them.
- The suspension response reports the same summary (`stranded`,
  `stranded_headline`). Suspending never releases anything.
- `POST /api/admin/agents/:id/release-stranded-items` returns the **releasable**
  items to the queue, one audit-logged unassignment each, and reports any
  per-item refusal instead of presenting a partial release as complete.

| Item status | Class | What happens |
|---|---|---|
| `awaiting_dropoff` | releasable | Holder removed; item returns to the manual queue |
| `at_agent` | held at hub | **Never released here** — the hub physically holds it; escalate for a custody decision |
| `claimed`, `expired`, `rejected`, `suspected_stolen`, `legal_hold` | other | Untouched by the hub's status |

**Console-wide discovery (the Stranded Items section).** The per-hub read only
answers a question about a hub you already suspect. `GET /api/admin/stranded-items`
classifies the whole platform in one read, so the hub nobody has opened still
appears. Each row carries the item's status, its county and sub-county, the hub's
public name and standing, the custody state (`not_yet_received` /
`received_at_hub`), a `review_required` flag, the reason a release is refused, and
the assignment's age when a committed event exists. Rows are ordered
most-dangerous first (custody review before releasable), then oldest first, then by
item id, so two administrators looking at the same data see the same order. The
route writes nothing: it classifies, and its one action per row is the existing
audited unassign endpoint.

**Operational runbook**

1. Suspend the hub. Read the stranded summary in the response or open the hub's
   *Items Held By This Hub* panel.
2. Confirm the hub is genuinely unable to process them (suspension, or an
   unverified email — the console shows whether the hub is actionable).
3. Release the releasable items with a reason that names the cause. Each item gets
   its own `MANUAL_AGENT_UNASSIGNMENT` audit row and an `unassigned` history
   event, and the outgoing hub is notified.
4. Re-assign from the manual queue as normal.
5. For `at_agent` items, do **not** clear the holder by hand. The platform has no
   custody-transfer feature; a physically held item is resolved out-of-band and
   recorded as an operational note, not by editing the assignment.

A release can refuse an item (`holder_changed`) if another administrator
re-assigned it in the meantime. Nothing is erased; reload and re-check.

## 5. Admin geographic assignment (Stage 3B-6D)

The item review panel shows the chosen hub's service area and compares it with
the item's declared county.

- Same county, or an unknown county on either side → no confirmation is asked for.
- **Different county → the server refuses the save (409,
  `ASSIGNMENT_GEOGRAPHY_UNCONFIRMED`) unless the operator ticks the explicit
  confirmation.** This is an acknowledgement, not a limit: out-of-county
  assignment remains permitted and is sometimes correct.

**Policy on out-of-county assignments:** use them when no hub serves the item's
county, when the Finder clearly mis-selected the county, or when a hub is
temporarily unable to receive. Say which of those applies in the reason. Record
the acknowledgement; do not work around it by editing the item's county unless
the county itself is wrong.

No distance threshold is involved. `MAX_AGENT_ASSIGNMENT_RADIUS_KM` remains
`null` (disabled); see `src/config/geoMatching.ts` for why no number may be
chosen without evidence.

## 6. Assignment lifecycle and custody (Stage 3B-7)

Sections 2–5 describe geography. This section describes the lifecycle those
geographic decisions act on, so an operator can tell "this hub has it" from
"this hub was *asked* to take it".

### 6.1 The only three mutations the platform can perform

| Mutation | Performed by | History event | Item afterwards |
|---|---|---|---|
| Assignment (first holder) | `createItem()` at report time, or the automatic matcher | `assigned` | `assigned_agent_id` set, `needs_manual_agent_reassignment = false` |
| Re-assignment (holder replaced) | the admin review panel (`adminUpdateItem()`) | `reassigned` | New holder, `agent_assignment_method = 'manual_override'`, distance cleared |
| Unassignment (holder removed) | `POST /api/admin/items/:id/unassign` and the stranded-item release | `unassigned` | Holder `NULL`, `agent_assignment_method = 'manual_required'`, distance cleared, back in the manual queue |

There is no fourth mutation. A physical handover between hubs is **not
implemented** and has no event type — see §9.

**Re-saving the same holder is not a mutation.** If an administrator re-submits a
review form that names the hub already on the item, the item is saved exactly as
before but no history event is written and no transfer is announced, because
nothing was transferred.

### 6.2 Statuses decide what may be assigned, and what may be released

One allow-list (`ITEM_ASSIGNABLE_STATUSES` in
`src/config/itemAgentAssignmentPolicy.ts`) governs **both** adding a holder and
removing one. The route asks it to answer with a precise 409; the data-layer
primitive asks it again inside its own transaction, so a status that changes
between the form being rendered and the write cannot slip through the gap.

| Item status | May gain/change a holder? | May lose its holder? | What it means |
|---|---|---|---|
| `awaiting_dropoff` | yes | yes | Assigned to a hub; the finder has not delivered yet |
| `at_agent` | **no** | **no** | The hub has physically received it — the only record of *where the item is* |
| `claimed` | no | no | The finder has collected it; the holder is history |
| `expired`, `rejected` | no | no | Left the drop-off lifecycle |
| `suspected_stolen`, `legal_hold` | no | no | Frozen; a human decision is pending |
| anything else / missing | no | no | Fails closed by construction |

It is an allow-list rather than a deny-list on purpose: the status vocabulary has
grown before (`suspected_stolen`, `legal_hold`), and a deny-list would silently
permit every status added later.

### 6.3 The manual-assignment queue

An item sits in the manual queue exactly when all three hold:
`status = 'awaiting_dropoff'`, `needs_manual_agent_reassignment = true`, and
`assigned_agent_id IS NULL`. Unassignment is what sets the middle flag; the next
successful assignment clears it. Because the queue and the assignment CAS read the
same three conditions, the matcher can never spend time on an item the primitive
would refuse.

### 6.4 Who may receive work

`isAgentActionable()` (`src/services/auth.ts`) remains the single authority — the
matcher, `requireActiveAgent`, the admin assignment route and the stranded-item
queue all ask it, and none restates it:

| Hub state | Actionable |
|---|---|
| `pending` | no |
| `suspended` | no |
| `active` + verified email | yes |
| `active` + unverified email | no |
| `active` + no email at all (pre-N4 legacy row) | yes, grandfathered |
| unknown / garbage status | no (fails closed) |

The admin route rejects a non-actionable hub with a hard 400 **before** any write,
hash, audit line or notification. There is no override, by design.

### 6.5 Custody is a physical fact, not a workflow state

`at_agent` means an object is on a shelf. Clearing the holder of such an item
would erase the only record of where it physically is, so no route in this batch
can do it — not the review form, not the unassign endpoint, not the stranded-item
release. Those items are *shown* (see §4 and §8) and escalated for an out-of-band
custody decision, never silently released.

## 7. Assignment history, audit trail and concurrency (Stage 3B-7)

### 7.1 The history table is append-only

`item_agent_assignments` records one row per assignment mutation:
`previous_agent_id`, `new_agent_id`, `event_type`, `assignment_method`,
`trigger_source`, `actor_id`, `actor_role`, `reason`, `distance_km`, `created_at`.

- **Exactly one insert site** exists (`insertItemAssignmentEventInTx()`), and it is
  always issued on the transaction handle of the mutation it describes. There is no
  `UPDATE` and no `DELETE` path for a stored event anywhere in the application.
- The vocabularies are closed and declared once, in
  `src/config/itemAgentAssignmentPolicy.ts`; the three schema declarations (Drizzle,
  `sql/schema.sql`, runtime `ensureSchemaUpToDate()`) are generated from the same
  lists and are asserted column-for-column by the test suite.
  - event types: `assigned` | `reassigned` | `unassigned`
  - methods: `gps_haversine` | `geocoded_text` | `manual_override`
  - triggers: `finder_report` | `agent_now_operational` | `admin_manual`
  - actor roles: `system` | `admin`
  (`manual_required` names the *absence* of a match, so it can never describe a
  successful assignment and is deliberately absent from the method list.)
- `unassigned` rows are constrained to carry **no** incoming agent, and every other
  event type to carry one (`item_agent_assignments_holder_shape_check`), so a row
  can never contradict its own event type.
- The table is internal: no route, DTO or public projection names it, so no
  claimant, finder or public view gained a field.

### 7.2 Two read APIs, each with a declared shape

| Reader | Question it answers | Order |
|---|---|---|
| `getItemAssignmentHistory(itemId)` | "what happened to **this** item?" | `created_at` ASC, `id` ASC (a total order) |
| `getLatestAssignmentEventsForItems(itemIds)` | "what is the newest event for **each of these** items?" | one set-based query, `created_at` DESC, `id` DESC, reduced to one entry per item |

The second reader exists for the stranded-item queue, which classifies a whole
console page of rows per request; looping the single-item reader there would be one
query per row. It is the same table and the same parse — a second question, not a
second history. Both live inside the data layer, and the queue reaches history only
through them; neither reader writes anything.

**Absent means absent.** An assignment made before Stage 3B-2 has no event, so the
queue reports that row's age as *unknown* rather than substituting
`items.created_at` (which records when the *finder* reported the item — a different
fact). An invented age would be worse than an admitted gap.

### 7.3 Which audit line is written, and when

| Audit action | Written by | Timing |
|---|---|---|
| `ADMIN_UPDATE_ITEM` | manual assignment / item update | On the mutation's own transaction, **before** the write, first attempt only |
| `MANUAL_AGENT_UNASSIGNMENT` | every unassignment (single or stranded release) | On the mutation's own transaction, **before** the removal |
| `AUTO_AGENT_ASSIGNMENT` | the automatic matcher | **After** commit (`SYSTEM` actor); a failure here cannot undo the assignment |
| `ADMIN_AGENT_GEOGRAPHY_CORRECTION` | geography correction (§3) | On the mutation's own transaction, before the update |

The manual lines are inside the transaction for one reason: a committed mutation
with no record of who made it, why, and whose custody ended is the one outcome an
audit trail must never produce. Ordering them *before* the write makes the guarantee
observable even in the test harness, which cannot model rollback.

Notifications are sent **after** commit and are best-effort: the mutation is already
durable, so a messaging failure is logged and never presented as a failed
assignment. The outgoing hub's unassignment notice carries the committed event id as
its idempotency key, which is what lets a *second* assignment of the same item be
announced at all while a retry of the *same* event stays suppressed.

### 7.4 Concurrency protections

- **Automatic assignment is a compare-and-swap.** One conditional `UPDATE` guarded
  by `assigned_agent_id IS NULL AND needs_manual_agent_reassignment = true AND
  status = 'awaiting_dropoff'`. Zero rows affected means another writer won: the
  call returns `false` and records **no** event, **no** audit line and **no**
  notification. Losing is not an error.
- **Manual assignment re-reads and retries, bounded.** Up to five attempts; each
  attempt re-reads the current holder and writes only while the holder is still the
  one it observed, so the event can never name a holder it did not replace. After
  five losses the call fails loudly rather than recording an event against a stale
  holder.
- **Unassignment deliberately does not retry.** Its intent is "remove *this*
  holder"; retrying after a change would delete a *newer* assignment. It refuses
  with `holder_changed` instead and the operator reloads.
- **Refusals are answers, not failures.** `item_not_found` → 404; `custody_blocked`,
  `holder_changed`, `no_current_holder` → 409 with an operator-readable sentence.
  Nothing has been written, audited or sent at the point of refusal.
- `SELECT ... FOR UPDATE` is deliberately not used anywhere in these paths (the
  in-memory double returns zero rows for it, so it could never be exercised); the
  conditional writes are what carry the guarantee.

## 8. Operational troubleshooting (Stage 3B-7)

| Symptom | What it almost always means | What to do |
|---|---|---|
| A finder has an item "assigned" but no hub will take it | The hub is suspended or its email is unverified — `isAgentActionable()` is false, but the item still points at it | Open **Stranded Items**. Release the `awaiting_dropoff` rows (§4); escalate the `at_agent` ones |
| The console shows an item with a hub, yet it is missing from the manual queue | `needs_manual_agent_reassignment` is false: the item still has a holder, so it is not queue work | Use the stranded-item queue, or unassign the item first |
| "No item was released" on a release | Every candidate was held at the hub, or refused as `holder_changed` | Read the per-item refusals; for held items escalate custody, do not edit the holder |
| A save is refused with "this item has already been received by an agent hub" (409) | The item is `at_agent`; the custody allow-list permits changes only in `awaiting_dropoff` | Resolve custody out-of-band; a handover feature does not exist (§9) |
| A save is refused with `ASSIGNMENT_GEOGRAPHY_UNCONFIRMED` (409) | The chosen hub serves a **different** county from the item | Confirm the acknowledgement if the decision is deliberate (§5), or pick a hub in the item's county |
| A save is refused because the hub "cannot receive items" (400) | The hub is pending, suspended, or has an unverified email | Choose an active, verified hub. There is no override |
| A hub serves the county but was never matched | Its stored county is non-canonical (`nairobi`, trailing space) or missing | Correct the hub's service geography (§3); matching tolerates case, padding, internal whitespace and the documented aliases only |
| An item was re-assigned twice but only one history event exists | The second save named the same holder — re-saving the same holder is not a mutation | Expected. No event, no announcement |
| The queue shows "unknown" age for an item | The assignment predates Stage 3B-2, so no event exists (there was no backfill) | Use the hub's received/custody records; the age is genuinely unknown |
| A release or save fails as `holder_changed` | Another administrator reassigned the item while the form was open | Reload; nothing was erased and nothing was recorded |

## 9. Deferred policies (Stages 3B-6A to 3B-7)

- No polygons, boundary dataset, point-in-polygon or PostGIS.
- No automatic re-assignment when a hub is suspended — release is an explicit,
  audited decision.
- No automatic distance limit, and no change to eligibility
  (`isAgentActionable()` remains the only authority).
- No county inference from free text, and no reverse-geocoding used as matching
  evidence.
- No custody transfer, no handover endpoint and no `transferred` / `custody_moved`
  event type. An item a hub has physically received keeps its holder until a human
  resolves the physical situation out-of-band.
- No backfill. Assignments made before Stage 3B-2 have no history event, and none
  was invented for them; the queue reports their age as unknown instead.
- No retention, archiving or purge policy for `item_agent_assignments` is defined
  or configured. The table is append-only in the application and nothing in this
  codebase deletes rows from it; no retention window may be assumed from this
  document, and none is implemented.
- No bulk release endpoint. Releasing stranded items is one audited unassignment
  per item, so a mixed queue can never be cleared by a single click (§4).
- No override of `isAgentActionable()`. A non-actionable hub is a hard 400 at the
  admin route; no administrator flag, role or reason can bypass it.
- No `agent` actor role and no agent-initiated assignment: the only actors the
  vocabulary can name are `system` and `admin`.
- No admin edit of an item's county as a way to make an assignment "match". The
  county is corrected only when the county itself is wrong (§5).

## 10. Verification and known limitations (Stages 3B-6A to 3B-7)

- Automatic matching is unchanged except for the comparison rule (6C); the matcher
  still returns `manual_required` whenever it cannot establish sufficiently
  useful routing evidence.
- The regression suite (`src/__tests__/geoAssignmentRegression.test.ts`) exercises
  correction → matchability, suspension → release, assessment → correction, and
  the post-correction matching pass (new county only, no existing holder taken, no
  duplicate history), against the real data layer.
- **Database verification limitation:** the test harness runs the in-memory mock
  when `DATABASE_URL` is empty, and that mock does not model
  `BEGIN/COMMIT/ROLLBACK`. Transaction boundaries in the new writers are therefore
  asserted by structure (the audit insert is issued on the mutation's own
  transaction handle, before the write), not by a real rollback. A disposable
  PostgreSQL run remains outstanding.
- **What is asserted by test, and where.** `batch3AssignmentHistory` and
  `batch3AssignmentHistorySchema` pin the append-only table, its three declarations,
  the single insert site, the two declared read APIs and the transaction handle each
  write path uses; `batch3CustodyAndUnassignment` and
  `batch3AssignmentIntegrityCharacterization` pin the custody allow-list and the
  refusal codes; `agentAssignmentConcurrency` pins the CAS behaviour;
  `agentServiceGeographyCorrection`, `geoAssignmentRegression` and
  `batch3Stage6AdminGeographyRoutes` pin the geographic controls of §2-§5;
  `suspendedAgentStrandedItems` and `strandedItemsQueueRendering` pin the stranded
  classification, the queue route and the console panel.
- **PostgreSQL behaviour is NOT integration-tested.** No run against a live
  database has been recorded for these stages. Specifically unverified against
  PostgreSQL: that the `CHECK` constraints reject the vocabularies at runtime,
  that the unique/partial indexes behave as declared, that the `IN (...)` batch
  read and its `ORDER BY` produce the same result the code-side tie-break produces,
  and that the transactions really roll back as a unit. The in-memory double also
  ignores `ORDER BY`, so ordering is demonstrated by the additional code-side
  comparison rather than by executing the SQL sort. Until a disposable PostgreSQL
  run is done, these remain structurally-asserted guarantees, not observed ones.
- **No notification is transactional with an assignment.** The mutation commits
  first and messaging follows; a messaging failure is logged, never surfaced as a
  failed assignment, and never rolls anything back.
