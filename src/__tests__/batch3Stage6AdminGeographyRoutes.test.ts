import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// STAGE 3B-6 — ROUTE CONTRACTS FOR THE ADMIN GEOGRAPHY SURFACES.
//
// WHY SOURCE ASSERTIONS. `src/server.ts` builds the whole app and starts its
// listeners at import time and exports nothing, so an inline route cannot be
// mounted in a test. This is the repository's established convention for that
// constraint (see batch3AdminAssignmentRouteContract.test.ts,
// foundItemCounty.test.ts, agentMutationOwnership.test.ts). Everything that CAN
// be executed — the geography comparison/validation core and the data-layer
// writers — is characterized behaviourally in
// src/services/__tests__/agentGeography.test.ts and
// src/db/__tests__/agentServiceGeographyCorrection.test.ts; this file pins the
// ROUTES' OWN contract: the order of their checks, what they refuse, and which
// primitive they call.
//
// WHAT IS PINNED HERE
//   B6-A  the administrator can correct a hub's SERVICE geography, the check
//         order is admin → exists → geography → reason → write, and the write
//         goes through the audited writer — never through the coordinate path.
// =============================================================================

const repoRoot = path.resolve(__dirname, '../..');
const SERVER_RAW = fs.readFileSync(path.resolve(repoRoot, 'src/server.ts'), 'utf8');
const DATABASE_RAW = fs.readFileSync(path.resolve(repoRoot, 'src/db/database.ts'), 'utf8');

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * One inline route handler, from its `app.<verb>(` line to the `  });` that
 * closes it, so a neighbouring handler's comments can never satisfy — or break —
 * an assertion in this file.
 */
function routeBody(anchor: string): string {
  const start = SERVER_RAW.indexOf(anchor);
  expect(start, `${anchor} not found in src/server.ts`).toBeGreaterThan(-1);
  const rest = SERVER_RAW.slice(start);
  const end = rest.indexOf('\n  });');
  const body = end === -1 ? rest : rest.slice(0, end + '\n  });'.length);
  return stripComments(body);
}

const GEOGRAPHY_ANCHOR = "app.post('/api/admin/agents/:id/geography'";
const geographyBody = () => routeBody(GEOGRAPHY_ANCHOR);

describe('B6-A — the geography correction route is admin-only, and authorization comes first', () => {
  it('rejects a non-admin with 403 before any read or write', () => {
    const body = geographyBody();
    expect(body).toContain("req.user?.role !== 'admin'");
    const gate = body.indexOf("req.user?.role !== 'admin'");
    const read = body.indexOf('await db.getAgent(');
    const write = body.indexOf('db.updateAgentServiceGeography(');
    expect(gate).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(gate);
    expect(write).toBeGreaterThan(gate);
  });
});

describe('B6-A — the route checks existence, geography and reason BEFORE it writes', () => {
  it('answers 404 for an unknown agent and touches nothing', () => {
    const body = geographyBody();
    const read = body.indexOf('const agent = await db.getAgent(agentId)');
    const notFound = body.indexOf("res.status(404).json({ error: 'Agent not found.' })");
    const write = body.indexOf('db.updateAgentServiceGeography(');
    expect(read).toBeGreaterThan(-1);
    expect(notFound).toBeGreaterThan(read);
    expect(write).toBeGreaterThan(notFound);
  });

  it('validates the submitted geography through the ONE shared validator', () => {
    const body = geographyBody();
    expect(body).toContain('validateAgentGeographyCorrection({ county, administrativeUnitId })');
    expect(body).toContain('if (!validatedGeography.ok)');
    expect(body).toContain('res.status(400)');
    // The validator's own message and field are returned, so the console can
    // point at the input that failed rather than at a generic error.
    expect(body).toContain('validatedGeography.error');
    expect(body).toContain('validatedGeography.field');
  });

  it('requires a reason and applies the shared administrator-reason policy', () => {
    const body = geographyBody();
    const reasonCheck = body.indexOf('reason.trim() ===');
    const policy = body.indexOf('validateAdminAssignmentReason(reason)');
    const write = body.indexOf('db.updateAgentServiceGeography(');
    expect(reasonCheck).toBeGreaterThan(-1);
    expect(policy).toBeGreaterThan(reasonCheck);
    expect(write).toBeGreaterThan(policy);
    // A missing reason must not be described as "assign an Agent" — that is a
    // different decision, and the message the operator sees must say so.
    expect(body).toContain('service geography');
  });

  it('writes through the audited geography writer, never through the coordinate path', () => {
    const body = geographyBody();
    expect(body).toContain('db.updateAgentServiceGeography(');
    expect(body).not.toContain('updateAgentLocation(');
    // Coordinates are a different axis and are not accepted by this route.
    expect(body).not.toContain('normalizeCoordinateInput');
  });

  it('reports not-found instead of a correction that did not happen', () => {
    const body = geographyBody();
    const write = body.indexOf('db.updateAgentServiceGeography(');
    const secondNotFound = body.indexOf("res.status(404).json({ error: 'Agent not found.' })", write);
    expect(secondNotFound).toBeGreaterThan(write);
  });

  it('returns the admin-safe hub DTO and the geography it replaced', () => {
    const body = geographyBody();
    expect(body).toContain('toAdminSafeAgentView(updated)');
    expect(body).toContain('previous_geography');
    expect(body).toContain('describeGeographyLabel(');
  });
});

describe('B6-A — the writer records the audit line on the mutation’s own transaction', () => {
  const writerBody = () => {
    const start = DATABASE_RAW.indexOf('public async updateAgentServiceGeography(');
    expect(start).toBeGreaterThan(-1);
    const end = DATABASE_RAW.indexOf('public async getItemsAssignedToAgent(', start);
    expect(end).toBeGreaterThan(start);
    return stripComments(DATABASE_RAW.slice(start, end));
  };

  it('issues logAuditInTx BEFORE the update, on the same handle', () => {
    const body = writerBody();
    const audit = body.indexOf('logAuditInTx(');
    const update = body.indexOf('.update(agentsTable)');
    expect(audit).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(audit);
    // The audit names the acting administrator, not the literal 'ADMIN'.
    expect(body).toContain('by ${adminUser}');
  });

  it('deliberately does NOT stamp the provenance column', () => {
    // GEO-D+ persists only 'user_selected' as authoritative geography, so writing
    // 'admin_corrected' would read back through parseAgent() as NULL and could
    // erase a hub's existing user_selected value. The correction is recorded in
    // the audit trail instead.
    expect(writerBody()).not.toContain('location_source');
  });

  it('validates again inside the writer, so a direct caller cannot bypass the rule', () => {
    expect(writerBody()).toContain('validateAgentGeographyCorrection(');
  });
});

// -----------------------------------------------------------------------------
// STAGE 3B-6B — STRANDED ITEMS AT A SUSPENDED HUB.
// -----------------------------------------------------------------------------

const STRANDED_READ_ANCHOR = "app.get('/api/admin/agents/:id/stranded-items'";
const RELEASE_ANCHOR = "app.post('/api/admin/agents/:id/release-stranded-items'";
const SUSPEND_ANCHOR = "app.post('/api/admin/agents/:id/suspend'";

describe('B6-B — the stranded-items read is admin-only and scoped to one hub', () => {
  it('rejects a non-admin before reading anything', () => {
    const body = routeBody(STRANDED_READ_ANCHOR);
    const gate = body.indexOf("req.user?.role !== 'admin'");
    const read = body.indexOf('await db.getItemsAssignedToAgent(');
    expect(gate).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(gate);
  });

  it('answers 404 for an unknown hub and uses the shared classification', () => {
    const body = routeBody(STRANDED_READ_ANCHOR);
    expect(body).toContain("res.status(404).json({ error: 'Agent not found.' })");
    expect(body).toContain('summariseStrandedItems(');
    expect(body).toContain('describeStrandedItemsHeadline(');
    // Whether the hub can act is the SHARED predicate's answer.
    expect(body).toContain('isAgentActionable(agent)');
  });
});

describe('B6-B — the release route reuses the one unassignment primitive', () => {
  it('is admin-only, requires a reason, and validates it before releasing', () => {
    const body = routeBody(RELEASE_ANCHOR);
    const gate = body.indexOf("req.user?.role !== 'admin'");
    const reasonCheck = body.indexOf('reason.trim() ===');
    const policy = body.indexOf('validateAdminAssignmentReason(reason)');
    const release = body.indexOf('db.adminUnassignAgent(');
    expect(gate).toBeGreaterThan(-1);
    expect(reasonCheck).toBeGreaterThan(gate);
    expect(policy).toBeGreaterThan(reasonCheck);
    expect(release).toBeGreaterThan(policy);
  });

  it('releases ONLY the items the custody policy allows, and never the held ones', () => {
    const body = routeBody(RELEASE_ANCHOR);
    const loop = body.indexOf('for (const target of stranded.releasable)');
    expect(loop).toBeGreaterThan(-1);
    // The refusal class is reported back, never swallowed or presented as success.
    expect(body).toContain('refused.push({ itemId: target.item_id, code: error.code })');
    expect(body).toContain('held_at_hub: stranded.held_at_hub');
    // The hub named in the URL is the observed holder, so a newer assignment is
    // refused by the primitive instead of being erased.
    expect(body).toMatch(/db\.adminUnassignAgent\([\s\S]*?agentId,\s*\)/);
  });

  it('does not invent a replacement agent or touch the item status', () => {
    const body = routeBody(RELEASE_ANCHOR);
    expect(body).not.toContain('assigned_agent_id:');
    expect(body).not.toContain("status:");
    expect(body).not.toContain('attemptAutoAgentAssignment');
  });
});

describe('B6-B — suspending reports what it stranded without moving it', () => {
  it('keeps the suspension response successful and adds the stranded summary', () => {
    const body = routeBody(SUSPEND_ANCHOR);
    const suspend = body.indexOf('await db.suspendAgent(');
    const summary = body.indexOf('summariseStrandedItems(');
    expect(suspend).toBeGreaterThan(-1);
    expect(summary).toBeGreaterThan(suspend);
    expect(body).toContain('stranded: strandedSummary');
    expect(body).toContain('stranded_headline');
  });

  it('can never turn a committed suspension into an error', () => {
    const body = routeBody(SUSPEND_ANCHOR);
    const suspend = body.indexOf('await db.suspendAgent(');
    const guarded = body.indexOf('try {', suspend);
    expect(guarded).toBeGreaterThan(suspend);
    // The read is wrapped, and a failure degrades to `null` rather than throwing.
    expect(body).toContain('strandedSummary = null');
    // Releasing is NOT a side effect of suspending.
    expect(body).not.toContain('adminUnassignAgent(');
  });
});

// -----------------------------------------------------------------------------
// STAGE 3B-6D — THE ADMINISTRATIVE ASSIGNMENT KNOWS ABOUT GEOGRAPHY.
// -----------------------------------------------------------------------------

const REVIEW_ANCHOR = "app.post('/api/admin/items/:id/review'";

describe('B6-D — an out-of-county assignment must be acknowledged, and checked before any write', () => {
  it('computes the assessment from the item and the chosen hub, via the shared function', () => {
    const body = routeBody(REVIEW_ANCHOR);
    expect(body).toContain('assessAssignmentGeography({');
    expect(body).toContain('itemCounty: existingItem.found_county');
    expect(body).toContain('agentCounty: targetAgent.county');
  });

  it('refuses with 409 BEFORE the write, the audit line and the notification', () => {
    const body = routeBody(REVIEW_ANCHOR);
    const check = body.indexOf('assignmentGeography.requires_acknowledgement');
    const conflict = body.indexOf('res.status(409)', check);
    const write = body.indexOf('db.adminUpdateItem(');
    expect(check).toBeGreaterThan(-1);
    expect(conflict).toBeGreaterThan(check);
    expect(write).toBeGreaterThan(conflict);
  });

  it('accepts only an explicit boolean acknowledgement', () => {
    const body = routeBody(REVIEW_ANCHOR);
    // A truthy string ("true"), 1 or any other value must NOT satisfy the gate.
    expect(body).toContain('geographyAcknowledged !== true');
    expect(body).toContain('geographyAcknowledged,');
  });

  it('states the disagreement in words the operator can act on', () => {
    const body = routeBody(REVIEW_ANCHOR);
    expect(body).toContain('OUT_OF_COUNTY_ASSIGNMENT_ACKNOWLEDGEMENT_MESSAGE');
    expect(body).toContain("code: 'ASSIGNMENT_GEOGRAPHY_UNCONFIRMED'");
    expect(body).toContain('geography: assignmentGeography');
  });

  it('introduces NO distance threshold and leaves eligibility untouched', () => {
    const body = routeBody(REVIEW_ANCHOR);
    expect(body).not.toContain('exceedsAssignmentRadius');
    expect(body).not.toContain('MAX_AGENT_ASSIGNMENT_RADIUS_KM');
    // The existing hard eligibility gate is still there, unchanged.
    expect(body).toContain('isAgentActionable(targetAgent)');
    // As is the reason policy.
    expect(body).toContain('validateAdminAssignmentReason(reason)');
  });

  it('reports the geography behind a successful save', () => {
    const body = routeBody(REVIEW_ANCHOR);
    expect(body).toContain('geography: assignmentGeography');
  });
});
// -----------------------------------------------------------------------------
// STAGE 3B-6A §4 — THE POST-CORRECTION MATCHING PASS.
//
// A correction changes which manual-queue items a hub can serve, so the route
// re-runs the EXISTING lifecycle matcher. These assertions pin exactly that: the
// existing trigger, after the write, never before it, with no assignment logic of
// its own, and with a summary the operator can read.
// -----------------------------------------------------------------------------

const AUTO_ASSIGNMENT_SRC = fs.readFileSync(
  path.resolve(repoRoot, 'src/services/agentAutoAssignment.ts'),
  'utf8',
);

describe('B6-A — the correction re-runs the existing matcher, and only after the write', () => {
  it('calls matchPendingItemsForOperationalAgent() after the committed write and its guards', () => {
    const body = geographyBody();
    const write = body.indexOf('db.updateAgentServiceGeography(');
    const guard = body.indexOf('if (!updated)');
    const match = body.indexOf('matchPendingItemsForOperationalAgent(agentId)');
    const respond = body.indexOf('return res.json({');
    expect(write).toBeGreaterThan(-1);
    // After the write, so it can only ever act on a correction that committed.
    expect(guard).toBeGreaterThan(write);
    expect(match).toBeGreaterThan(guard);
    // Before the response, so the call is not cut short by the request ending.
    expect(respond).toBeGreaterThan(match);
  });

  it('never matches when the request was refused or the agent is unknown', () => {
    const body = geographyBody();
    const match = body.indexOf('matchPendingItemsForOperationalAgent(');
    expect(match).toBeGreaterThan(-1);
    // Exactly one call: the route cannot run a second, unguarded pass.
    expect(body.indexOf('matchPendingItemsForOperationalAgent(', match + 1)).toBe(-1);
    // EVERY refusal (403, both 404s, both 400s) returns before the matching call.
    for (const refusal of ['res.status(403)', 'res.status(404)', 'res.status(400)']) {
      let at = body.indexOf(refusal);
      let seen = 0;
      while (at !== -1) {
        expect(at, `${refusal} must return before matching`).toBeLessThan(match);
        seen++;
        at = body.indexOf(refusal, at + 1);
      }
      expect(seen, `${refusal} should appear at least once`).toBeGreaterThan(0);
    }
  });

  it('cannot let a matching failure fail the correction', () => {
    // The trigger is the repository's non-throwing lifecycle call: its body is
    // wrapped, and every failure returns an empty outcome. That is why the route
    // may await it outside any extra guard of its own.
    const trigger = stripComments(AUTO_ASSIGNMENT_SRC);
    const fn = trigger.indexOf('export async function matchPendingItemsForOperationalAgent(');
    expect(fn).toBeGreaterThan(-1);
    expect(trigger.indexOf('} catch (error) {', fn)).toBeGreaterThan(fn);
    expect(trigger.indexOf('return NOTHING_DONE;', fn)).toBeGreaterThan(fn);
  });

  it('holds no assignment logic of its own — it delegates, never re-implements', () => {
    const body = geographyBody();
    expect(body).not.toContain('assignNearestAgent');
    expect(body).not.toContain('attemptAutoAgentAssignment');
    expect(body).not.toContain('adminUpdateItem');
    expect(body).not.toContain('adminUnassignAgent');
    // It also does not invent a distance limit on the way.
    expect(body).not.toContain('MAX_AGENT_ASSIGNMENT_RADIUS_KM');
    expect(body).not.toContain('exceedsAssignmentRadius');
  });

  it('reports the pass, and the primitive it relies on still protects custody', () => {
    const body = geographyBody();
    expect(body).toContain('auto_assignment: autoAssignment');

    // The queue contract lives in the assignment CAS, not in the route. If any of
    // these preconditions were dropped, a correction could take an item another
    // hub holds, or one an administrator placed.
    const primitive = stripComments(DATABASE_RAW).slice(
      stripComments(DATABASE_RAW).indexOf('public async attemptAutoAgentAssignment('),
      stripComments(DATABASE_RAW).indexOf('public async getItemsAwaitingManualAgentAssignment('),
    );
    expect(primitive).toContain('isNull(itemsTable.assigned_agent_id)');
    expect(primitive).toContain('eq(itemsTable.needs_manual_agent_reassignment, true)');
    expect(primitive).toContain('eq(itemsTable.status, "awaiting_dropoff")');
    // Exactly one history event, written by the winner, inside the same
    // transaction as the assignment it describes.
    const lossCheck = primitive.indexOf('if (rows.length === 0) return false;');
    expect(lossCheck).toBeGreaterThan(-1);
    expect(primitive.indexOf('insertItemAssignmentEventInTx')).toBeGreaterThan(lossCheck);
  });
});
