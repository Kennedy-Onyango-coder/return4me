import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { toAdminSafeAgentView } from '../services/adminSafeViews';

// =============================================================================
// STAGE 3B-6D — THE CONTRACT BEHIND THE MANUAL-ASSIGNMENT PICKER.
//
// The picker became more informative (eligibility, county/sub-county relation,
// real distance, a cross-county warning), and the risk that creates is exactly
// the one this file pins down: a richer LIST must never become a second
// AUTHORITY. Concretely:
//
//   * the eligibility verdict the console renders is the server's
//     isAgentActionable() answer, copied through the admin DTO — not re-derived
//     from `status` (which would offer a hub that cannot receive work);
//   * an unstated verdict (`null`) is never silently read as "eligible" — only
//     an explicit `true` can be chosen, and the route re-reads the agent and
//     re-checks before any write, so a verdict that changes between render and
//     submit is still refused;
//   * the cross-county warning is a CONFIRMATION, not a block: the arm's-length
//     decision stays with the administrator, but it must be deliberate, and the
//     server enforces the same rule it renders;
//   * the geography-correction receipt does NOT state a verdict, so it cannot
//     become a second source of one.
//
// AdminView and server.ts cannot be mounted here (no DOM harness, and the route
// module opens the database at import time); this repository's admin-console
// tests pin UI/server contracts by reading source, exactly as
// adminReviewAssignmentReasonUi.test.ts and the other admin tests do.
// =============================================================================

const repoRoot = path.resolve(__dirname, '../..');
const SERVER = fs.readFileSync(path.resolve(repoRoot, 'src/server.ts'), 'utf8');
const ADMIN_VIEW = fs.readFileSync(path.resolve(repoRoot, 'src/components/AdminView.tsx'), 'utf8');

const REVIEW_ROUTE_START = SERVER.indexOf("app.post('/api/admin/items/:id/review'");
const GEOGRAPHY_ROUTE_START = SERVER.indexOf("app.post('/api/admin/agents/:id/geography'");

function routeAt(start: number): string {
  expect(start).toBeGreaterThan(-1);
  const next = SERVER.indexOf('\n  app.', start + 10);
  return SERVER.slice(start, next === -1 ? SERVER.length : next);
}

const REVIEW_ROUTE = routeAt(REVIEW_ROUTE_START);
const GEOGRAPHY_ROUTE = routeAt(GEOGRAPHY_ROUTE_START);

describe('3B-6D — the server states the eligibility verdict the console renders', () => {
  it('builds the admin Agent DTO with isAgentActionable() — never from status', () => {
    const verdicts = SERVER.match(/actionable: isAgentActionable\(agent\)/g) ?? [];
    // The bulk dashboard and the single-hub reads both state it.
    expect(verdicts.length).toBeGreaterThanOrEqual(2);
    expect(SERVER).toContain('isAgentActionable');
  });

  it('the geography-correction receipt stays silent about eligibility', () => {
    // It is a receipt for the correction, not a candidate source: the console
    // re-fetches the dashboard, which states the verdict. If this route also
    // stated one, there would be two sources and no reason to trust either.
    expect(GEOGRAPHY_ROUTE).toContain('toAdminSafeAgentView(updated)');
    expect(GEOGRAPHY_ROUTE).not.toContain('actionable:');
    expect(GEOGRAPHY_ROUTE).toMatch(/leaves `actionable` null here/);
  });

  it('the DTO copies the verdict verbatim and never infers it from status', () => {
    // `status: 'active'` with no stated verdict must NOT read as eligible...
    expect(toAdminSafeAgentView({ id: 'hub-1', status: 'active' }).actionable).toBeNull();
    expect(toAdminSafeAgentView({ id: 'hub-1', status: 'active' }, {}).actionable).toBeNull();
    expect(toAdminSafeAgentView({ id: 'hub-1', status: 'active' }, { actionable: null }).actionable).toBeNull();
    // ...an explicit verdict is passed through unchanged, whatever status says.
    expect(toAdminSafeAgentView({ id: 'hub-1', status: 'active' }, { actionable: true }).actionable).toBe(true);
    expect(toAdminSafeAgentView({ id: 'hub-1', status: 'active' }, { actionable: false }).actionable).toBe(false);
    expect(toAdminSafeAgentView({ id: 'hub-1', status: 'suspended' }, { actionable: true }).actionable).toBe(true);
    expect(toAdminSafeAgentView({ id: 'hub-1', status: 'suspended' }, { actionable: false }).actionable).toBe(false);
    expect(toAdminSafeAgentView(null)).toBeNull();
  });
});

describe('3B-6D — the review route re-checks eligibility before it writes anything', () => {
  it('re-reads the target hub from the database and applies the one predicate', () => {
    expect(REVIEW_ROUTE).toContain('const targetAgent = await db.getAgent(assignedAgentId);');
    expect(REVIEW_ROUTE).toContain('if (!isAgentActionable(targetAgent)) {');
    // The client's payload is never allowed to supply a verdict of its own.
    expect(REVIEW_ROUTE).not.toMatch(/req\.body\.\w*actionable/);
    expect(REVIEW_ROUTE).not.toMatch(/body\?\.actionable/);
  });

  it('rejects an ineligible hub with a 400, before the geography check and before any write', () => {
    const eligibility = REVIEW_ROUTE.indexOf('if (!isAgentActionable(targetAgent)) {');
    const geography = REVIEW_ROUTE.indexOf('assignmentGeography = assessAssignmentGeography({');
    const write = REVIEW_ROUTE.indexOf('await db.adminUpdateItem(');
    expect(eligibility).toBeGreaterThan(-1);
    expect(geography).toBeGreaterThan(eligibility);
    expect(write).toBeGreaterThan(geography);
    expect(REVIEW_ROUTE).toContain(
      "return res.status(400).json({ error: 'That Agent cannot receive items. Choose an active Agent with a verified email.' });",
    );

    // Nothing between the read and the decision can persist a thing: a refused
    // assignment must leave the item exactly as it was, still in the queue.
    const guard = REVIEW_ROUTE.slice(eligibility, geography);
    expect(guard).not.toMatch(/db\.(adminUpdateItem|updateAgent|setItem|assign)/);
    expect(guard).not.toContain('sendNotification');
    expect(guard).not.toContain('assignmentOutcome');
  });

  it('asks for a deliberate confirmation when the hub serves another county', () => {
    expect(REVIEW_ROUTE).toContain('if (assignmentGeography.requires_acknowledgement && geographyAcknowledged !== true) {');
    expect(REVIEW_ROUTE).toContain("code: 'ASSIGNMENT_GEOGRAPHY_UNCONFIRMED'");
    expect(REVIEW_ROUTE).toContain('geography: assignmentGeography,');
    // The same rule the console renders is enforced here; the confirmation is a
    // gate, never an override of eligibility.
    const geography = REVIEW_ROUTE.indexOf('assignmentGeography = assessAssignmentGeography({');
    const write = REVIEW_ROUTE.indexOf('await db.adminUpdateItem(');
    expect(write).toBeGreaterThan(geography);
  });

  it('records the decision as a manual override with its actor and reason', () => {
    expect(REVIEW_ROUTE).toContain("method: 'manual_override',");
    expect(REVIEW_ROUTE).toContain("triggerSource: 'admin_manual',");
    expect(REVIEW_ROUTE).toContain('actorId: adminIdentifier,');
    expect(REVIEW_ROUTE).toContain('reason: assignmentReason,');
    expect(REVIEW_ROUTE).toContain("updates.agent_assignment_method = 'manual_override';");
  });
});


describe('3B-6D — the console offers only cleared hubs, and shows the geography', () => {
  it('no longer filters the dropdown on the business-approval status', () => {
    // The old list was `dashboardData.agents.filter(agent => agent.status === 'active')`.
    // That is not the eligibility rule: it would have offered a hub whose email
    // is unverified (or that is suspended) as a valid target.
    expect(ADMIN_VIEW).not.toContain(".filter((agent: any) => agent.status === 'active')");
    expect(ADMIN_VIEW).not.toContain("filter((a: any) => a.status === 'active')");
    // `status === 'active'` still legitimately drives a STATUS BADGE elsewhere on
    // the console; what must not survive is the picker's use of it as a filter.
    const picker = ADMIN_VIEW.slice(
      ADMIN_VIEW.indexOf('id="review-assigned-agent"'),
      ADMIN_VIEW.indexOf('</Select>', ADMIN_VIEW.indexOf('id="review-assigned-agent"')),
    );
    expect(picker.length).toBeGreaterThan(500);
    expect(picker).not.toContain("status === 'active'");
  });

  it('derives the list from the candidate projection', () => {
    expect(ADMIN_VIEW).toContain(
      'buildAssignmentCandidates({ item: selectedReviewItem, agents: dashboardData?.agents })',
    );
    expect(ADMIN_VIEW).toContain('selectableAssignmentCandidates(reviewAssignmentCandidates)');
    expect(ADMIN_VIEW).toContain('describeAssignmentCandidate(candidate)');
    // The current holder stays visible even if it is no longer eligible, so the
    // control never goes blank while the form still holds an agent id.
    expect(ADMIN_VIEW).toContain('current holder, not eligible for new work');
  });

  it('says why a hub cannot be chosen instead of dropping it silently', () => {
    expect(ADMIN_VIEW).toContain('excludedAssignmentCandidates(reviewAssignmentCandidates)');
    expect(ADMIN_VIEW).toMatch(/Not selectable — /);
    expect(ADMIN_VIEW).toMatch(/eligibility is decided by the server, not by the hub's recorded status/);
  });

  it('shows the relationship and a real distance for the current selection', () => {
    expect(ADMIN_VIEW).toContain('findAssignmentCandidate(reviewAssignmentCandidates, reviewAssignedAgentId)');
    expect(ADMIN_VIEW).toContain('chosenCandidate.relationLabel');
    expect(ADMIN_VIEW).toContain('chosenCandidate.distanceLabel');
    // The panel describes the SAME candidate the option was rendered from, so it
    // cannot describe a different hub than the one selected.
    expect(ADMIN_VIEW).toContain('agentCounty: chosenCandidate.county,');
    expect(ADMIN_VIEW).toContain('agentAdministrativeUnitId: chosenCandidate.administrativeUnitId,');
  });

  it('asks for the cross-county confirmation and sends it only when ticked', () => {
    expect(ADMIN_VIEW).toContain('id="review-geography-ack"');
    expect(ADMIN_VIEW).toMatch(
      /geographyAcknowledged:\s*agentChanged && reviewAssignedAgentId && reviewGeographyAck \? true : undefined,/,
    );
    // A confirmation given for one hub must not travel to another.
    const selectOnChange = ADMIN_VIEW.slice(
      ADMIN_VIEW.indexOf('id="review-assigned-agent"'),
      ADMIN_VIEW.indexOf('</Select>', ADMIN_VIEW.indexOf('id="review-assigned-agent"')),
    );
    expect(selectOnChange).toContain('setReviewGeographyAck(false);');
    // Nor from one item to the next.
    expect(ADMIN_VIEW).toMatch(
      /setReviewAssignedAgentId\(item\.assigned_agent_id \|\| ''\);\r?\n[\s\S]{0,600}?setReviewGeographyAck\(false\);/,
    );
  });
});
