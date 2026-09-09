import { describe, it, expect } from 'vitest';
import { db } from '../database';
import { testRunId } from './ensureTestCategory';
import { isAgentActionable } from '../../services/auth';

// WORKFLOW REGRESSION TEST — agent application: signup(pending) -> admin
// retrieval -> approval(active) -> active-agent authorization.
//
// Background (production-audit P1): a manually-observed issue reported that a
// freshly registered agent was told "your application is waiting for approval"
// while the Admin Dashboard showed no pending application. A live HTTP
// reproduction proved the application workflow itself is correct in a single
// running instance (the agent IS returned by /api/admin/dashboard with
// status='pending'); the visible discrepancy was instead local in-memory-sandbox
// state that is lost when the Node process restarts, plus an AdminView that did
// not re-fetch on tab entry. This test pins down the actual application state
// machine so that a regression in the registration->admin->approval->active
// chain (e.g. createAgent writing the wrong status, getAgents filtering out
// pending agents, approveAgent not persisting 'active', or an approved agent no
// longer being actionable) fails loudly instead of silently breaking the
// workflow.
//
// Why this level (DB + authorization-service) and not a live HTTP test: server.ts
// deliberately does not export its Express app separately from startServer()'s
// bootstrap (DB migrations, cron sweeps, listen) and the test env disables the
// OTP mock bypass, so booting the real HTTP server in a vitest worker is not the
// supported test pattern in this repo (see activeAgentAuthorization.test.ts and
// the static route-audit tests). Every function exercised here is exactly the
// one the real HTTP path uses: /api/auth/verify-otp calls db.createAgent(...,
// status:'pending'), /api/admin/dashboard calls db.getAgents() and counts
// status==='pending', /api/admin/agents/:id/approve calls db.approveAgent, and
// requireActiveAgent gates every agent operational route on
// isAgentActionable(getAgent(...)) where isAgentActionable(agent) ===
// agent.status === 'active'.

function makeAgentFields(id: string, phoneSuffix: string, status: 'pending' | 'active') {
  return {
    id,
    business_name: `Workflow Hub ${id}`,
    contact_phone: `+254${testRunId}${phoneSuffix}`,
    location_address: 'Workflow Test Location',
    latitude: null,
    longitude: null,
    mpesa_till_or_paybill: '000000',
    payout_method_type: 'Till Number',
    status,
    refundable_deposit: 0,
    national_id_hash: 'test-hash-workflow',
    needs_manual_geocoding: false,
  } as const;
}

describe('Agent application workflow: signup(pending) -> admin -> approval -> active', () => {
  it('a pending application survives registration and is returned to the admin (unfiltered), then approval transitions it to active and actionable', async () => {
    const pendingId = `TEST-AGENT-WORKFLOW-${testRunId}-PENDING`;
    const activeId = `TEST-AGENT-WORKFLOW-${testRunId}-ACTIVE`;

    // 1) REGISTRATION — same db.createAgent({ status: 'pending' }) call the
    //    real signup route (/api/auth/verify-otp) makes.
    await db.createAgent(makeAgentFields(pendingId, '31', 'pending') as any);
    await db.createAgent(makeAgentFields(activeId, '32', 'active') as any);

    // 2) The created row carries status 'pending' (a wrong status here would
    //    mean the admin's pending filter can never find it).
    const registered = await db.getAgent(pendingId);
    expect(registered).toBeDefined();
    expect(registered?.status).toBe('pending');

    // 3) ADMIN RETRIEVAL — /api/admin/dashboard reads db.getAgents() with NO
    //    status filter. Both the pending and the active agent must be present;
    //    if getAgents ever filtered pending agents out (the exact "admin can't
    //    see the application" failure), this assertion fails.
    const allAgents = await db.getAgents();
    const ids = allAgents.map((a) => a.id);
    expect(ids).toContain(pendingId);
    expect(ids).toContain(activeId);
    const pendingFromAdmin = allAgents.find((a) => a.id === pendingId);
    expect(pendingFromAdmin?.status).toBe('pending');

    // 4) Admin pending-count derivation (dashboard stats.pendingAgentsCount is
    //    agents.filter(a => a.status === 'pending').length) must include it.
    const pendingCount = allAgents.filter((a) => a.status === 'pending').length;
    expect(pendingCount).toBeGreaterThanOrEqual(1);

    // 5) A pending agent must NOT be actionable (cannot reach active-agent
    //    functionality before approval).
    expect(isAgentActionable(registered)).toBe(false);

    // 6) APPROVAL — the admin approve route calls db.approveAgent.
    await db.approveAgent(pendingId, 'audit-admin-workflow');

    // 7) Approval persisted: the authoritative row is now 'active'.
    const approved = await db.getAgent(pendingId);
    expect(approved).toBeDefined();
    expect(approved?.status).toBe('active');

    // 8) A now-active agent IS actionable — i.e. after approval it can
    //    authenticate and hit active-agent routes (requireActiveAgent gate).
    expect(isAgentActionable(approved)).toBe(true);

    // 9) The approved agent no longer counts as a pending application for the
    //    admin dashboard.
    const afterApproval = await db.getAgents();
    const pendingIdsAfter = afterApproval.filter((a) => a.status === 'pending').map((a) => a.id);
    expect(pendingIdsAfter).not.toContain(pendingId);
  });

  it('approving or suspending a non-existent agent rejects (no silent false success)', async () => {
    // db.approveAgent/db.suspendAgent now verify the target exists and throw
    // for an id that matches no row, so the admin route can never report
    // success for an agent that isn't there.
    const missingId = `TEST-AGENT-WORKFLOW-${testRunId}-NEVER-EXISTS`;
    await expect(db.approveAgent(missingId, 'audit-admin-workflow')).rejects.toThrow();
    await expect(db.suspendAgent(missingId, 'audit-admin-workflow')).rejects.toThrow();
    expect(await db.getAgent(missingId)).toBeUndefined();
  });
});
