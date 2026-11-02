import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// STAGE 3B-3 — THE ADMIN CONSOLE SIDE OF A MANUAL ASSIGNMENT DECISION.
//
// WHY SOURCE ASSERTIONS. AdminView is a large component that cannot be mounted
// here (this repository has no DOM test harness; its UI contracts are pinned by
// reading the source, exactly as adminAuthUx14.test.ts, adminConsoleShell.test.ts
// and the other admin-console tests do). What is asserted is the CONTRACT the
// component owes the server, not its rendering:
//
//   * a reason field exists, is labelled, and is validated with the SAME policy
//     module the server uses;
//   * an assignment/reassignment cannot be submitted without a valid reason;
//   * the selected target agent survives a validation failure;
//   * the server's own refusal is displayed where the operator is looking;
//   * a double submit cannot produce two assignments;
//   * a plain correction no longer sends an agent id it did not change (which
//     used to demand a reason for a description fix);
//   * removal is its own explicit action against the removal endpoint, never a
//     side effect of clearing the dropdown.
// =============================================================================

const repoRoot = path.resolve(__dirname, '../..');
const ADMIN_VIEW = fs.readFileSync(path.resolve(repoRoot, 'src/components/AdminView.tsx'), 'utf8');

describe('3B-3 — the review panel collects a validated reason', () => {
  it('renders a labelled reason field wired to the shared policy', () => {
    expect(ADMIN_VIEW).toContain(
      "import { validateAdminAssignmentReason } from '../config/adminAssignmentReasonPolicy'",
    );
    expect(ADMIN_VIEW).toContain('id="review-assignment-reason"');
    expect(ADMIN_VIEW).toContain('label="Reason for the assignment decision"');
    expect(ADMIN_VIEW).toContain('reviewAssignmentReason');
    // The operator is told WHY it is required and what must not go in it.
    expect(ADMIN_VIEW).toMatch(/Required when you assign, reassign or remove an Agent/);
    expect(ADMIN_VIEW).toMatch(/Do not include the claimant/);
  });

  it('validates before submitting, using the same rules as the server', () => {
    const start = ADMIN_VIEW.indexOf('const handleSaveReview = async');
    expect(start).toBeGreaterThan(-1);
    const body = ADMIN_VIEW.slice(start, ADMIN_VIEW.indexOf('const handleRemoveAssignedAgent', start));

    expect(body).toContain('validateAdminAssignmentReason(reviewAssignmentReason)');
    // On failure: show the message, keep the typed text and the chosen hub, and
    // return WITHOUT issuing the request.
    expect(body).toContain('setReviewReasonError(validated.error);');
    expect(body).toContain('return;');
    expect(body).not.toContain('setReviewAssignedAgentId');
  });

  it('sends the agent and the reason only when the holder actually changes', () => {
    const start = ADMIN_VIEW.indexOf('const handleSaveReview = async');
    const body = ADMIN_VIEW.slice(start, ADMIN_VIEW.indexOf('const handleRemoveAssignedAgent', start));

    expect(body).toContain('const agentChanged = reviewAssignedAgentId !== currentAgentId;');
    // Both fields are gated on the change, so a plain correction of an item that
    // already has an agent no longer trips the server's assignment-reason rule.
    expect(body).toContain(
      'assignedAgentId: agentChanged && reviewAssignedAgentId ? reviewAssignedAgentId : undefined',
    );
    expect(body).toContain('reason: agentChanged && reviewAssignedAgentId ? assignmentReason : undefined');
  });

  it('cannot be double-submitted', () => {
    const start = ADMIN_VIEW.indexOf('const handleSaveReview = async');
    const body = ADMIN_VIEW.slice(start, ADMIN_VIEW.indexOf('const handleRemoveAssignedAgent', start));

    // Guarded at the top of the handler...
    expect(body).toContain('if (reviewSaving) return;');
    // ...and the submit control is disabled while a save is in flight.
    expect(ADMIN_VIEW).toMatch(/type="submit"[^>]*loading=\{reviewSaving\}[^>]*disabled=\{reviewSaving\}/);
  });

  it('shows the server refusal inline, not only in the page banner', () => {
    const start = ADMIN_VIEW.indexOf('const handleSaveReview = async');
    const body = ADMIN_VIEW.slice(start, ADMIN_VIEW.indexOf('const handleRemoveAssignedAgent', start));
    // The catch block routes the server's message to the reason field's error slot.
    expect(body).toContain('setReviewReasonError(e.message)');
    expect(ADMIN_VIEW).toContain('error={reviewReasonError || undefined}');
  });

  it('clears the previous reason when a different item is opened', () => {
    const start = ADMIN_VIEW.indexOf('const startReview =');
    const body = ADMIN_VIEW.slice(start, ADMIN_VIEW.indexOf('const handleSaveReview', start));
    expect(body).toContain("setReviewAssignmentReason('')");
    expect(body).toContain("setReviewReasonError('')");
  });
});


describe('3B-3 — removal is an explicit action, not a cleared dropdown', () => {
  it('posts the same validated reason to the removal endpoint', () => {
    const start = ADMIN_VIEW.indexOf('const handleRemoveAssignedAgent = async');
    expect(start).toBeGreaterThan(-1);
    const body = ADMIN_VIEW.slice(start, ADMIN_VIEW.indexOf('const fetchDashboardData', start));

    expect(body).toContain('/unassign`');
    expect(body).toContain('body: JSON.stringify({ reason: validated.reason })');
    expect(body).toContain('validateAdminAssignmentReason(reviewAssignmentReason)');
    expect(body).toContain('if (reviewSaving) return;');
    expect(body).toContain('setReviewReasonError(e.message)');
  });

  it('offers the action only for an item that actually has an agent', () => {
    expect(ADMIN_VIEW).toContain('{selectedReviewItem.assigned_agent_id && (');
    expect(ADMIN_VIEW).toContain('Remove Assigned Agent');
  });
});
