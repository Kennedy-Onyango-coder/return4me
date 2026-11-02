import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// PHASE 16.1 BATCH 3 — STAGE 3B-0 (characterization) + STAGE 3B-1 (the fix).
//
// WHY SOURCE ASSERTIONS. `src/server.ts` builds the whole app and starts its
// listeners at import time and exports nothing, so the inline route cannot be
// mounted. This is the repository's established convention for exactly this
// constraint (see categoryArchitectureBatch1.test.ts, foundItemCounty.test.ts,
// agentMutationOwnership.test.ts). Everything that CAN be executed — the
// primitive this route calls — is characterized behaviourally in
// src/db/__tests__/batch3AssignmentIntegrityCharacterization.test.ts; this file
// pins the ROUTE'S OWN contract, which is what Stage 3B-3 will change.
//
// WHAT IS PINNED (audit gaps G2, G3, G4, G5 — still open, deliberately):
//   * a truthiness gate is the only thing that decides whether an assignment
//     happens — so no unassignment path exists, and `null`/'' are not entered;
//   * no custody-state precondition, and no conflict response;
//   * a reason is required only when an agent is assigned, never for other
//     edits, and it is never validated beyond "non-blank string";
//   * the write, its audit line and the notification are three separate steps
//     in that order (not atomic);
//   * the previous holder is captured but only used in prose — the outgoing
//     agent is never notified.
//
// STAGE 3B-1 CHANGED EXACTLY ONE THING HERE: the target agent is now validated
// with isAgentActionable() BEFORE any write, and a non-actionable target is
// rejected with the route's existing 400/`{ error }` convention (no override).
// The 3B-0 assertion that this route "never consults the operational predicate"
// was deliberately inverted rather than deleted.
//
// STAGE 3B-2 ADDED THE ATTRIBUTION THIS ROUTE MUST NOW SUPPLY: the third
// argument to db.adminUpdateItem() names the administrator, the trigger
// ('admin_manual'), the method ('manual_override') and the reason the route
// already requires, because the assignment history is written from it. The route
// still writes NO history itself — the single writer lives in database.ts — and
// its custody behaviour, its reason rule, its audit line and its notification are
// all unchanged (asserted below).
// =============================================================================

const repoRoot = path.resolve(__dirname, '../..');
const SERVER_RAW = fs.readFileSync(path.resolve(repoRoot, 'src/server.ts'), 'utf8');

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * One inline route handler, from its `app.<verb>(` line to the `  });` that
 * closes it. Cutting at the handler's own closing line (rather than at the next
 * route) means a neighbouring handler's comments can never satisfy — or break —
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

const ANCHOR = "app.post('/api/admin/items/:id/review'";
/** Called inside each test, so a missing anchor fails that test, not the module. */
const adminReviewBody = () => routeBody(ANCHOR);

describe('B3-0 — the admin gate is preserved (this is what the route already gets right)', () => {
  it('rejects a non-admin with 403 before anything else', () => {
    const body = adminReviewBody();
    expect(body).toContain("req.user?.role !== 'admin'");
    expect(body).toContain('res.status(403)');
  });
});

describe('B3-0 — there is no unassignment path: the write lives inside the truthiness gate', () => {
  it('writes the assignment INSIDE the gate, so there is no unassignment path', () => {
    const body = adminReviewBody();
    expect(body).toContain('if (assignedAgentId)');

    const write = body.indexOf('updates.assigned_agent_id = assignedAgentId');
    // The assignment branch itself — the LAST truthiness gate before the write
    // (3B-1 added an earlier, eligibility-only one).
    const gate = body.lastIndexOf('if (assignedAgentId)', write);
    expect(gate).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(gate);

    // No branch anywhere clears the holder: an empty string or null simply
    // makes the whole assignment block unreachable, and the item keeps its
    // current agent.
    expect(body).not.toMatch(/assigned_agent_id\s*[:=]\s*(null|undefined)/);
  });

  it('clears the manual-queue flag and the distance evidence as part of the write', () => {
    const body = adminReviewBody();
    expect(body).toContain('updates.agent_assignment_method = ');
    expect(body).toContain("'manual_override'");
    expect(body).toContain('updates.needs_manual_agent_reassignment = false');
    expect(body).toContain('updates.agent_assignment_distance_km = null');
  });
});

describe('B3-3 — a custody-state precondition and a conflict response now exist', () => {
  it('reads the item status and refuses at_agent / claimed items with 409', () => {
    const body = adminReviewBody();
    // The route asks the ONE custody policy rather than restating the statuses.
    expect(body).toContain('describeManualAssignmentRefusal(existingItem.status)');
    expect(body).toContain('res.status(409)');
  });

  it('checks existence before anything else and answers 404 without any write', () => {
    const body = adminReviewBody();
    const read = body.indexOf('const existingItem = await db.getItem(itemId)');
    const notFound = body.indexOf("res.status(404).json({ error: 'Item not found.' })");
    const write = body.indexOf('db.adminUpdateItem(');
    const audit = body.indexOf("'MANUAL_AGENT_ASSIGNMENT'");
    const notify = body.indexOf('notifyAgentAssignedToItem(');

    expect(read).toBeGreaterThan(-1);
    expect(notFound).toBeGreaterThan(read);
    // Nothing can happen before the existence check, and the 404 precedes every
    // side effect (write, audit line, notification).
    expect(write).toBeGreaterThan(notFound);
    expect(audit).toBeGreaterThan(notFound);
    expect(notify).toBeGreaterThan(notFound);
  });

  it('does not use the concurrency-guarded AUTO primitive — it calls the attributed admin write', () => {
    const body = adminReviewBody();
    expect(body).toContain('db.adminUpdateItem(');
    expect(body).not.toContain('attemptAutoAgentAssignment');
  });
});

describe('B3-1 — the target agent is gated by isAgentActionable() before ANY write', () => {
  it('consults the shared operational predicate, not a local status rule', () => {
    const body = adminReviewBody();
    expect(body).toContain('if (!isAgentActionable(targetAgent))');
    expect(body).toContain('await db.getAgent(assignedAgentId)');
    // No second opinion about eligibility is introduced in the route.
    expect(body).not.toContain("status === 'active'");
    expect(body).not.toContain('email_verified_at');
  });

  it("rejects a non-actionable target with the route's existing 400/{ error } convention", () => {
    const body = adminReviewBody();
    const gate = body.indexOf('if (!isAgentActionable(targetAgent)) {');
    expect(gate).toBeGreaterThan(-1);
    // The rejection is UNCONDITIONAL — no override flag, no bypass branch, no
    // "justification" escape hatch. A non-actionable target is simply refused.
    expect(body.slice(gate)).toMatch(
      /^if \(!isAgentActionable\(targetAgent\)\) \{\s*return res\.status\(400\)\.json\(\{ error: /,
    );
  });

  it('places the gate before the write, the audit line and the notification', () => {
    const body = adminReviewBody();
    const gate = body.indexOf('if (!isAgentActionable(targetAgent)) {');
    const write = body.indexOf('db.adminUpdateItem(');
    const audit = body.indexOf("'MANUAL_AGENT_ASSIGNMENT'");
    const notify = body.indexOf('notifyAgentAssignedToItem(');

    expect(gate).toBeGreaterThan(-1);
    // Nothing is written, recorded or announced for a refused target, so the
    // item keeps its holder and stays in the manual assignment queue.
    expect(write).toBeGreaterThan(gate);
    expect(audit).toBeGreaterThan(gate);
    expect(notify).toBeGreaterThan(gate);
  });

  it('loads the target agent BEFORE the write, so a bad target can never reach the update', () => {
    const body = adminReviewBody();
    const write = body.indexOf('db.adminUpdateItem(');
    const lookup = body.indexOf('await db.getAgent(assignedAgentId)');
    expect(lookup).toBeGreaterThan(-1);
    expect(lookup).toBeLessThan(write);
  });

  it('introduces no administrative override and leaves the admin gate intact', () => {
    const body = adminReviewBody();
    expect(body).not.toMatch(/allowNonActionable|forceAssign|skipEligibility|bypassEligibility/);
    // The ONLY role decision in the handler is still the existing admin gate.
    expect((body.match(/req\.user\?\.role !== 'admin'/g) ?? []).length).toBe(1);
  });
});

describe('B3-3 — the reason requirement is policy-based, and still covers assignment only', () => {
  it('validates the reason with the ONE shared policy exactly when an agent is assigned', () => {
    const body = adminReviewBody();
    expect(body).toContain('if (assignedAgentId) {');
    expect(body).toContain('validateAdminAssignmentReason(reason)');
    expect(body).toContain('if (!validatedReason.ok) {');
    expect(body).toContain('res.status(400).json({ error: validatedReason.error })');
    // The historical refusal message survives inside the policy constant, so a
    // blank reason still produces the same 400 body it always did.
    expect(body).toContain('validatedReason.error');
  });

  it('requires no reason for a non-assignment edit', () => {
    const body = adminReviewBody();
    // The only reason validation in the handler is the assignment-gated one; there
    // is no unconditional `if (!reason)`.
    expect(body).not.toMatch(/if \(!reason\)/);
    expect((body.match(/assignmentReason/g) ?? []).length).toBeGreaterThan(0);
    // And the validated reason is what the audit line and the event receive.
    expect(body).not.toContain('reason.trim()');
  });
});

describe('B3-0 — write, audit and notification are three separate steps in that order', () => {
  it('commits the update, then the audit line, then the notification', () => {
    const body = adminReviewBody();
    const write = body.indexOf('db.adminUpdateItem(');
    const audit = body.indexOf("'MANUAL_AGENT_ASSIGNMENT'");
    const notify = body.indexOf('notifyAgentAssignedToItem(');

    expect(write).toBeGreaterThan(-1);
    expect(audit).toBeGreaterThan(write);
    expect(notify).toBeGreaterThan(audit);
  });

  it('writes exactly one assignment audit row, naming both agents and the reason', () => {
    const body = adminReviewBody();
    expect(
      (body.match(/'MANUAL_AGENT_ASSIGNMENT'/g) ?? []).length,
    ).toBe(1);
    // This prose row is the ONLY human-readable record of the previous holder.
    expect(body).toContain("agent changed from ${oldAgentId || '(none)'} to ${assignedAgentId}");
    expect(body).toContain('Reason: ${assignmentReason}');
  });
});

describe('B3-3 — the notification reaches the incoming AND the outgoing agent', () => {
  it('passes the COMMITTED event and the outgoing agent, never the pre-write read', () => {
    const body = adminReviewBody();
    const notify = body.indexOf('notifyAgentAssignedToItem(');
    expect(notify).toBeGreaterThan(-1);
    const afterNotify = body.slice(notify);
    // The identity is the committed event, so a second assignment of the same item
    // is announced instead of being suppressed as a duplicate.
    expect(afterNotify).toContain('assignmentEventId: assignmentOutcome.eventId');
    // The outgoing agent comes from that same committed event, never from the
    // route's stale pre-write read.
    expect(body).toContain('assignmentOutcome.previousAgentId');
    expect(afterNotify).toContain('previousAgent: outgoingAgent');
    expect(body).not.toContain('previousAgent: oldAgentId');
    // A re-save that keeps the same holder produces no outcome and therefore no
    // transfer message.
    expect(body).toContain('if (assignmentOutcome) {');
  });

  it('calls the service once, with the new agent and the admin_manual trigger', () => {
    const body = adminReviewBody();
    expect((body.match(/notifyAgentAssignedToItem\(/g) ?? []).length).toBe(1);
    expect(body).toContain('agent: assignedAgent');
    expect(body).toContain("trigger: 'admin_manual'");
    // Guarded on both rows existing, because the item and agent are re-read
    // after the update.
    expect(body).toContain('if (assignedAgent && assignedItem)');
  });
});

// =============================================================================
// B3-2 — THE ROUTE SUPPLIES THE ATTRIBUTION, AND STILL WRITES NO HISTORY ITSELF.
//
// The assignment history row is written inside db.adminUpdateItem()'s
// transaction, never by the route: a route that wrote its own event could
// disagree with the mutation it claims to describe, and could write one for an
// assignment that rolled back. What the route must do is TELL the primitive who
// did it and why — with values it already had.
// =============================================================================
describe('B3-2 — the write is attributed, from values the route already had', () => {
  it('passes the admin, the admin_manual trigger and the manual_override method', () => {
    const body = adminReviewBody();
    expect(body).toContain('actorId: adminIdentifier');
    expect(body).toContain("actorRole: 'admin'");
    expect(body).toContain("triggerSource: 'admin_manual'");
    expect(body).toContain("method: 'manual_override'");
    // The SAME reason the route validated for an assignment. Never a default, a
    // placeholder or a synthesized explanation - and never an untrimmed copy of
    // what the administrator typed.
    expect(body).toContain('reason: assignmentReason');
  });

  it('resolves the acting admin BEFORE the write, exactly as it did for the audit line', () => {
    const body = adminReviewBody();
    const resolve = body.indexOf('const adminIdentifier = req.user?.username || req.user?.userId');
    const write = body.indexOf('db.adminUpdateItem(');
    expect(resolve).toBeGreaterThan(-1);
    expect(resolve).toBeLessThan(write);
    // Resolved once, not twice: one identity for the event, the audit line and
    // the log, so they can never name different people.
    expect((body.match(/const adminIdentifier =/g) ?? []).length).toBe(1);
  });

  it('supplies attribution only for an assignment, never for a plain edit', () => {
    const body = adminReviewBody();
    // A ternary on the assignment gate, whose else-branch is `undefined`.
    expect(body).toMatch(/assignedAgentId\s*\?/);
    expect(body).toMatch(/\}\s*\n\s*:\s*undefined,/);
    // The reason value can only be non-empty where the policy accepted it: its
    // use inside the write comes after the validation gate.
    const reasonGuard = body.indexOf('validateAdminAssignmentReason(reason)');
    const reasonUse = body.indexOf('reason: assignmentReason');
    expect(reasonGuard).toBeGreaterThan(-1);
    expect(reasonUse).toBeGreaterThan(reasonGuard);
  });

  it('never writes the history itself: there is exactly one writer, and it is in the data layer', () => {
    const body = adminReviewBody();
    expect(body).not.toContain('item_agent_assignments');
    expect(body).not.toContain('insertItemAssignmentEventInTx');
    expect(body).not.toContain('getItemAssignmentHistory');
    // One write call, so one transaction and therefore at most one event.
    expect((body.match(/db\.adminUpdateItem\(/g) ?? []).length).toBe(1);
  });
});


// =============================================================================
// STAGE 3B-3 — THE UNASSIGNMENT ENDPOINT'S OWN CONTRACT.
//
// A separate endpoint, not "review with no assignedAgentId": removing a holder is
// a different decision from saving the form, so it has its own audit line, its
// own history event type and its own notification set.
// =============================================================================
const UNASSIGN_ANCHOR = "app.post('/api/admin/items/:id/unassign'";
const unassignBody = () => routeBody(UNASSIGN_ANCHOR);

describe('B3-3 — the unassignment route: existence, reason and custody before any write', () => {
  it('is admin-gated, and 404s a missing item before anything else', () => {
    const body = unassignBody();
    expect(body).toContain("req.user?.role !== 'admin'");
    expect(body).toContain('res.status(403)');
    expect(body).toContain('const existingItem = await db.getItem(itemId)');
    expect(body).toContain("res.status(404).json({ error: 'Item not found.' })");
  });

  it('orders its checks: 404, then the reason (400), then custody (409), then the primitive', () => {
    const body = unassignBody();
    const notFound = body.indexOf("res.status(404).json({ error: 'Item not found.' })");
    const reason = body.indexOf('validateAdminAssignmentReason(reason)');
    const custody = body.indexOf('describeManualUnassignmentRefusal(existingItem.status)');
    const write = body.indexOf('db.adminUnassignAgent(');

    expect(notFound).toBeGreaterThan(-1);
    expect(reason).toBeGreaterThan(notFound);
    expect(custody).toBeGreaterThan(reason);
    expect(write).toBeGreaterThan(custody);
  });

  it('requires a reason UNCONDITIONALLY (there is no "no agent" case here)', () => {
    const body = unassignBody();
    // Not inside an `if (assignedAgentId)` gate: an unassignment always has one.
    expect(body).toContain('const validatedReason = validateAdminAssignmentReason(reason);');
    expect(body).toContain('if (!validatedReason.ok) {');
    expect(body).toContain('res.status(400).json({ error: validatedReason.error })');
  });

  it('tells the primitive which holder the administrator saw, so a newer assignment survives', () => {
    const body = unassignBody();
    expect(body).toContain('existingItem.assigned_agent_id ?? null');
    expect(body).toContain('actorId: adminIdentifier');
    expect(body).toContain("actorRole: 'admin'");
    expect(body).toContain("triggerSource: 'admin_manual'");
    expect(body).toContain("method: 'manual_override'");
    expect(body).toContain('reason: validatedReason.reason');
  });

  it('maps a refusal onto a status code instead of hiding it behind a 500', () => {
    const body = unassignBody();
    expect(body).toContain('error instanceof ItemAssignmentRefusedError');
    expect(body).toContain("error.code === 'item_not_found'");
    expect(body).toContain("error.code === 'custody_blocked'");
    expect(body).toContain("error.code === 'holder_changed'");
    expect(body).toContain('res.status(409)');
  });

  it('notifies only AFTER the removal committed, and never writes history itself', () => {
    const body = unassignBody();
    const write = body.indexOf('db.adminUnassignAgent(');
    const notify = body.indexOf('notifyAgentUnassignedFromItem(');
    expect(notify).toBeGreaterThan(write);
    expect(body).toContain('assignmentEventId: outcome.eventId');
    expect(body).not.toContain('item_agent_assignments');
    expect(body).not.toContain('insertItemAssignmentEventInTx');
    // One write call, so one transaction and therefore at most one event.
    expect((body.match(/db\.adminUnassignAgent\(/g) ?? []).length).toBe(1);
  });
});
