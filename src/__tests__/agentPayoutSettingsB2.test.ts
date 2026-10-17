import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import type { Server } from 'http';
import { eq } from 'drizzle-orm';
import { db as drizzleDb } from '../db/index.ts';
import {
  agents as agentsTable,
  agent_payout_destination_changes as changesTable,
  audit_log as auditLogTable,
} from '../db/schema.ts';
import { db } from '../db/database.ts';
import { generateToken } from '../services/auth.ts';
import { registerAgentPayoutSettingsRoutes } from '../routes/agentPayoutSettings.ts';
import {
  AGENT_PAYOUT_CHANGE_TTL_MS,
  evaluateAgentPayoutActivation,
  resolveAgentPayoutChangeState,
  resolveAgentPayoutProposal,
  resolveAgentPayoutVerificationStatus,
  toAgentPayoutChangeView,
} from '../config/agentPayoutVerification.ts';

// =============================================================================
// AGENT DASHBOARD BATCH 2 — payout destination settings.
//
// The tests below are deliberately of three kinds:
//   1. PURE policy (no database): the state machine and the verification
//      availability rule, because those are the decisions that must never be
//      softened.
//   2. DB/HTTP against REAL Express handlers and REAL rows in the project's
//      database layer (the in-memory double in mock mode), because ownership
//      scoping, the single-live-request guarantee and the activation CAS are
//      properties of WHERE clauses and unique indexes, not of comments.
//   3. STATIC integrity checks for facts that cannot be observed at runtime
//      (the executor still reads `agents.mpesa_till_or_paybill`, agentOps.ts
//      still registers exactly six routes, all three schema sources agree).
//
// NOTHING HERE CONTACTS A PROVIDER. No SMS/WhatsApp adapter exists, and these
// tests pin that the product says so instead of pretending.
// =============================================================================

const RUN = Math.floor(100000 + Math.random() * 899999).toString(36).toUpperCase();
const AGENT_A = 'TEST-B2-APDC-A-' + RUN;
const AGENT_B = 'TEST-B2-APDC-B-' + RUN;
const ADMIN_USER = 'reviewer-' + RUN;

const CURRENT_A = '254712345678';
const CURRENT_B = '254798765432';
const PROPOSED_A = '254733111222';
const PROPOSED_A_ALT = '254733999888';

function randomPhone(seed: number): string {
  return '+2547' + String(10000000 + seed).slice(-8);
}

async function seedAgent(id: string, overrides: Record<string, any> = {}) {
  await drizzleDb.insert(agentsTable).values({
    id,
    business_name: 'Batch Two Agent ' + id,
    contact_phone: randomPhone(Math.floor(Math.random() * 80000000)),
    location_address: 'Kimathi Street, Nairobi',
    mpesa_till_or_paybill: CURRENT_A,
    payout_method_type: 'Personal M-Pesa',
    status: 'active',
    national_id_hash: 'a'.repeat(64),
    refundable_deposit: '0.00',
    ...overrides,
  } as any);
}

async function seedPendingChange(params: {
  id: string;
  agentId: string;
  destination?: string;
  expiresAt?: Date;
}) {
  return db.createAgentPayoutDestinationChange({
    id: params.id,
    agentId: params.agentId,
    proposedDestination: params.destination ?? PROPOSED_A,
    proposedPayoutMethod: 'Personal M-Pesa',
    destinationFormatEligible: true,
    expiresAt: params.expiresAt ?? new Date(Date.now() + AGENT_PAYOUT_CHANGE_TTL_MS),
  });
}

let server: Server;
let baseUrl = '';
const tokenA = generateToken({ userId: AGENT_A, phone: randomPhone(1), role: 'agent', agentId: AGENT_A });
const tokenB = generateToken({ userId: AGENT_B, phone: randomPhone(2), role: 'agent', agentId: AGENT_B });
const adminToken = generateToken({
  userId: 'ADM-' + RUN,
  phone: randomPhone(3),
  role: 'admin',
  username: ADMIN_USER,
  tokenVersion: 1,
});

async function api(method: string, route: string, token?: string, body?: any) {
  const response = await fetch(baseUrl + route, {
    method,
    headers: {
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, body: json, text };
}

beforeAll(async () => {
  await seedAgent(AGENT_A);
  await seedAgent(AGENT_B, { mpesa_till_or_paybill: CURRENT_B });

  const app = express();
  app.use(express.json());
  registerAgentPayoutSettingsRoutes(app, {
    // These two middleware are defined in server.ts (which cannot be imported
    // by a test). The stubs mirror their documented behaviour EXACTLY: identity
    // comes from the verified token, and the live agent record must be active.
    requireActiveAgent: (async (req: any, res: any, next: any) => {
      if (req.user?.role !== 'agent' || !req.user.agentId) {
        return res.status(403).json({ code: 'AGENT_NOT_APPROVED', error: 'Access denied.' });
      }
      const agent = await db.getAgent(req.user.agentId);
      if (!agent || agent.status !== 'active') {
        return res.status(403).json({ code: 'AGENT_NOT_ACTIVE', error: 'Access denied.' });
      }
      req.activeAgent = agent;
      return next();
    }) as any,
    requireCurrentAdminSession: ((req: any, _res: any, next: any) => next()) as any,
    sendServerError: (res: any, error: any, context: string) => {
      console.error('[' + context + ']', error);
      return res.status(500).json({ error: 'A server error occurred.' });
    },
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = 'http://127.0.0.1:' + port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// 1. VERIFICATION AVAILABILITY — must be false and must never claim a send
// ---------------------------------------------------------------------------
describe('B2 payout verification availability', () => {
  it('reports unavailable when no channel is configured', () => {
    const status = resolveAgentPayoutVerificationStatus({});
    expect(status.verification_available).toBe(false);
    expect(status.channel).toBe('none');
    expect(status.reason).toBe('no_delivery_channel_configured');
  });

  it('still reports unavailable when a channel is named but no adapter exists', () => {
    const status = resolveAgentPayoutVerificationStatus({
      AGENT_PAYOUT_PHONE_VERIFICATION_CHANNEL: 'sms',
      SMS_ENABLED: 'true',
    });
    // The adapter boundary is intentionally false in this build: naming a
    // channel must never be enough to claim a code can be delivered.
    expect(status.verification_available).toBe(false);
    expect(status.reason).toBe('delivery_adapter_not_implemented');
  });

  it('never says a code was sent', () => {
    const status = resolveAgentPayoutVerificationStatus({});
    expect(status.message).toMatch(/No verification code has been sent/i);
    expect(status.message).not.toMatch(/code (was )?sent successfully/i);
  });
});

// ---------------------------------------------------------------------------
// 2. PROPOSAL VALIDATION — format only, one supported method
// ---------------------------------------------------------------------------
describe('B2 payout destination proposal validation', () => {
  it('accepts national, international and 01x shapes', () => {
    const cases: Array<[string, string]> = [
      ['0712345678', '254712345678'],
      ['+254 712 345 678', '254712345678'],
      ['0110000000', '254110000000'],
    ];
    for (const [input, canonical] of cases) {
      const result = resolveAgentPayoutProposal({ destination: input });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.canonicalDestination).toBe(canonical);
        expect(result.maskedDestination).not.toBe(canonical);
      }
    }
  });

  it('rejects a missing destination', () => {
    const result = resolveAgentPayoutProposal({ destination: '   ' });
    expect(result).toMatchObject({ ok: false, code: 'destination_missing' });
  });

  it('rejects non-phone values', () => {
    for (const value of ['123456', 'E2E-TILL', '+255712345678', 'not-a-number']) {
      const result = resolveAgentPayoutProposal({ destination: value });
      expect(result, value).toMatchObject({
        ok: false,
        code: 'destination_not_a_personal_mpesa_phone',
      });
    }
  });

  it('rejects Till, Paybill and Pochi methods even with a phone-shaped destination', () => {
    for (const method of ['Till Number', 'Paybill Number', 'Pochi la Biashara']) {
      const result = resolveAgentPayoutProposal({
        destination: '0712345678',
        payoutMethodType: method,
      });
      expect(result, method).toMatchObject({ ok: false, code: 'unsupported_payout_method' });
    }
  });

  it('never returns the canonical destination in the masked field', () => {
    const result = resolveAgentPayoutProposal({ destination: '0712345678' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.maskedDestination).not.toContain('712345678');
  });
});

// ---------------------------------------------------------------------------
// 3. STATE MACHINE — three independent facts, two required to activate
// ---------------------------------------------------------------------------
describe('B2 payout destination change state machine', () => {
  const future = new Date(Date.now() + 60_000);
  const base = {
    id: 'APDC-TEST',
    agent_id: AGENT_A,
    proposed_destination: PROPOSED_A,
    proposed_payout_method: 'Personal M-Pesa',
    destination_format_eligible: true,
    expires_at: future,
    created_at: new Date(),
  };

  it('starts pending verification', () => {
    expect(resolveAgentPayoutChangeState(base)).toBe('pending_verification');
  });

  it('verification alone moves to pending admin approval, never to active', () => {
    const change = { ...base, phone_verified_at: new Date() };
    expect(resolveAgentPayoutChangeState(change)).toBe('pending_admin_approval');
    expect(evaluateAgentPayoutActivation(change).allowed).toBe(false);
    expect(evaluateAgentPayoutActivation(change).reason).toBe('admin_approval_required');
  });

  it('admin approval alone stays pending verification, never active', () => {
    const change = { ...base, admin_approved_at: new Date() };
    expect(resolveAgentPayoutChangeState(change)).toBe('pending_verification');
    expect(evaluateAgentPayoutActivation(change).allowed).toBe(false);
    expect(evaluateAgentPayoutActivation(change).reason).toBe('phone_verification_required');
  });

  it('verification AND approval is the only combination that may activate', () => {
    const change = { ...base, phone_verified_at: new Date(), admin_approved_at: new Date() };
    expect(resolveAgentPayoutChangeState(change)).toBe('ready_to_activate');
    expect(evaluateAgentPayoutActivation(change)).toEqual({
      allowed: true,
      reason: null,
      blockers: [],
    });
  });

  it('expiry blocks activation and is derived from the clock', () => {
    const change = {
      ...base,
      expires_at: new Date(Date.now() - 1000),
      phone_verified_at: new Date(),
      admin_approved_at: new Date(),
    };
    expect(resolveAgentPayoutChangeState(change)).toBe('expired');
    const decision = evaluateAgentPayoutActivation(change);
    expect(decision.allowed).toBe(false);
    expect(decision.blockers).toContain('expired');
  });

  it('a rejection is terminal and is not reported as merely expired', () => {
    const change = {
      ...base,
      expires_at: new Date(Date.now() - 1000),
      admin_rejected_at: new Date(),
    };
    expect(resolveAgentPayoutChangeState(change)).toBe('rejected');
    expect(evaluateAgentPayoutActivation(change).reason).toBe('rejected');
  });

  it('a format-ineligible row can never activate, even with both proofs', () => {
    const change = {
      ...base,
      destination_format_eligible: false,
      phone_verified_at: new Date(),
      admin_approved_at: new Date(),
    };
    expect(evaluateAgentPayoutActivation(change).blockers).toContain('destination_not_eligible');
  });

  it('the safe projection masks the destination and keeps the facts separate', () => {
    const view = toAgentPayoutChangeView({
      ...base,
      id: 'APDC-VIEW',
      phone_verified_at: null,
      admin_approved_at: new Date(),
    });
    expect(view.masked_proposed_destination).not.toBe(PROPOSED_A);
    expect(view.masked_proposed_destination).toContain('***');
    expect(view.destination_format_eligible).toBe(true);
    expect(view.phone_verification).toBe('not_verified');
    expect(view.admin_approval).toBe('approved');
    expect(view.can_activate).toBe(false);
    expect(view.activation_blockers).toContain('phone_verification_required');
    // No raw destination field exists at all.
    expect(Object.keys(view)).not.toContain('proposed_destination');
    expect(JSON.stringify(view)).not.toContain(PROPOSED_A);
  });
});

// ---------------------------------------------------------------------------
// 4. PERSISTENCE — single live request, scoping, and the activation gates
// ---------------------------------------------------------------------------
describe('B2 payout destination change persistence and activation', () => {
  it('allows exactly ONE live request per agent and frees the slot on rejection', async () => {
    const agentId = 'TEST-B2-APDC-C-' + RUN;
    await seedAgent(agentId);

    const first = await seedPendingChange({ id: 'APDC-C1-' + RUN, agentId });
    expect(first).toBeTruthy();

    const second = await seedPendingChange({
      id: 'APDC-C2-' + RUN,
      agentId,
      destination: PROPOSED_A_ALT,
    });
    expect(second).toBeNull();

    const rejected = await db.recordAgentPayoutDestinationAdminDecision({
      id: 'APDC-C1-' + RUN,
      decision: 'reject',
      actor: ADMIN_USER,
      reason: 'Number belongs to a third party',
    });
    expect(rejected.ok).toBe(true);
    expect(rejected.code).toBe('REJECTED');

    const afterRejection = await seedPendingChange({
      id: 'APDC-C3-' + RUN,
      agentId,
      destination: PROPOSED_A_ALT,
    });
    expect(afterRejection).toBeTruthy();
  });

  it('handles two simultaneous submissions deterministically (one live row)', async () => {
    const agentId = 'TEST-B2-APDC-D-' + RUN;
    await seedAgent(agentId);

    const [one, two] = await Promise.all([
      seedPendingChange({ id: 'APDC-D1-' + RUN, agentId }),
      seedPendingChange({ id: 'APDC-D2-' + RUN, agentId, destination: PROPOSED_A_ALT }),
    ]);

    // This exercises the REAL insert path and the unique `live_key` index in the
    // database layer. Exactly one wins; the other resolves to NULL and the route
    // turns that into either an idempotent duplicate (same number) or a 409.
    expect([one, two].filter(Boolean)).toHaveLength(1);
    const live = await db.getLiveAgentPayoutDestinationChange(agentId);
    expect(live).toBeTruthy();
  });

  it('scopes reads to the owning agent', async () => {
    const agentId = 'TEST-B2-APDC-E-' + RUN;
    const otherId = 'TEST-B2-APDC-F-' + RUN;
    await seedAgent(agentId);
    await seedAgent(otherId);
    await seedPendingChange({ id: 'APDC-E1-' + RUN, agentId });

    expect(await db.getAgentPayoutDestinationChangeById('APDC-E1-' + RUN, agentId)).toBeTruthy();
    expect(await db.getAgentPayoutDestinationChangeById('APDC-E1-' + RUN, otherId)).toBeUndefined();
    expect(await db.getAgentPayoutDestinationChangeById('APDC-NOPE-' + RUN, agentId)).toBeUndefined();
  });

  it('leaves the ACTIVE destination unchanged while a request is pending', async () => {
    const agentId = 'TEST-B2-APDC-G-' + RUN;
    await seedAgent(agentId);
    await seedPendingChange({ id: 'APDC-G1-' + RUN, agentId });

    const agent = await db.getAgent(agentId);
    expect(agent!.mpesa_till_or_paybill).toBe(CURRENT_A);
    expect(agent!.payout_method_type).toBe('Personal M-Pesa');
  });

  it('cannot activate on admin approval alone', async () => {
    const agentId = 'TEST-B2-APDC-H-' + RUN;
    await seedAgent(agentId);
    await seedPendingChange({ id: 'APDC-H1-' + RUN, agentId });

    const approval = await db.recordAgentPayoutDestinationAdminDecision({
      id: 'APDC-H1-' + RUN,
      decision: 'approve',
      actor: ADMIN_USER,
    });
    expect(approval.ok).toBe(true);

    const activation = await db.activateAgentPayoutDestinationChange({
      id: 'APDC-H1-' + RUN,
      actor: ADMIN_USER,
    });
    expect(activation.activated).toBe(false);
    expect(activation.code).toBe('NOT_VERIFIED');

    const agent = await db.getAgent(agentId);
    expect(agent!.mpesa_till_or_paybill).toBe(CURRENT_A);
  });

  it('cannot activate on phone verification alone', async () => {
    const agentId = 'TEST-B2-APDC-I-' + RUN;
    await seedAgent(agentId);
    await seedPendingChange({ id: 'APDC-I1-' + RUN, agentId });

    const verified = await db.recordAgentPayoutDestinationPhoneVerification({
      id: 'APDC-I1-' + RUN,
      providerRef: 'provider-attestation-' + RUN,
    });
    expect(verified.ok).toBe(true);

    const activation = await db.activateAgentPayoutDestinationChange({
      id: 'APDC-I1-' + RUN,
      actor: ADMIN_USER,
    });
    expect(activation.activated).toBe(false);
    expect(activation.code).toBe('NOT_APPROVED');

    const agent = await db.getAgent(agentId);
    expect(agent!.mpesa_till_or_paybill).toBe(CURRENT_A);
  });

  it('requires a provider reference for a phone attestation', async () => {
    const agentId = 'TEST-B2-APDC-J-' + RUN;
    await seedAgent(agentId);
    await seedPendingChange({ id: 'APDC-J1-' + RUN, agentId });

    const result = await db.recordAgentPayoutDestinationPhoneVerification({
      id: 'APDC-J1-' + RUN,
      providerRef: '   ',
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_ATTESTATION');

    const row = await db.getAgentPayoutDestinationChangeById('APDC-J1-' + RUN, agentId);
    expect(row.phone_verified_at).toBeNull();
  });

  it('activates ONLY with real verification AND approval, and audits a masked destination', async () => {
    const agentId = 'TEST-B2-APDC-K-' + RUN;
    const proposed = '254733444555';
    const changeId = 'APDC-K1-' + RUN;
    await seedAgent(agentId);
    await seedPendingChange({ id: changeId, agentId, destination: proposed });

    const verified = await db.recordAgentPayoutDestinationPhoneVerification({
      id: changeId,
      providerRef: 'provider-attestation-' + RUN,
    });
    expect(verified.ok).toBe(true);

    const approval = await db.recordAgentPayoutDestinationAdminDecision({
      id: changeId,
      decision: 'approve',
      actor: ADMIN_USER,
    });
    expect(approval.ok).toBe(true);

    const activation = await db.activateAgentPayoutDestinationChange({
      id: changeId,
      actor: ADMIN_USER,
    });
    expect(activation.activated).toBe(true);
    expect(activation.code).toBe('ACTIVATED');

    // The authoritative row moved, and only now.
    const agent = await db.getAgent(agentId);
    expect(agent!.mpesa_till_or_paybill).toBe(proposed);
    expect(agent!.payout_method_type).toBe('Personal M-Pesa');

    // Evidence for the CURRENT destination is the activated change.
    const evidence = await db.getActivatedAgentPayoutDestinationChangeFor(agentId, proposed);
    expect(evidence?.phone_verified_at).toBeTruthy();

    // The audit row exists and contains NO raw destination.
    const auditRows = await drizzleDb.select().from(auditLogTable);
    const activationRows = auditRows.filter(
      (row: any) =>
        row.action === 'AGENT_PAYOUT_DESTINATION_ACTIVATED' &&
        String(row.details).includes(agentId),
    );
    expect(activationRows).toHaveLength(1);
    expect(String(activationRows[0].details)).not.toContain(proposed);
    expect(String(activationRows[0].details)).toContain('***');
  });

  it('an EXPIRED request can never be verified or activated', async () => {
    const agentId = 'TEST-B2-APDC-L-' + RUN;
    const changeId = 'APDC-L1-' + RUN;
    await seedAgent(agentId);
    await seedPendingChange({
      id: changeId,
      agentId,
      expiresAt: new Date(Date.now() - 1000),
    });

    const verified = await db.recordAgentPayoutDestinationPhoneVerification({
      id: changeId,
      providerRef: 'provider-attestation-' + RUN,
    });
    expect(verified.ok).toBe(false);
    expect(verified.code).toBe('EXPIRED');

    const activation = await db.activateAgentPayoutDestinationChange({
      id: changeId,
      actor: ADMIN_USER,
    });
    expect(activation.activated).toBe(false);
    expect(activation.code).toBe('EXPIRED');

    const agent = await db.getAgent(agentId);
    expect(agent!.mpesa_till_or_paybill).toBe(CURRENT_A);
    // The expired row released the single live slot.
    expect(await db.getLiveAgentPayoutDestinationChange(agentId)).toBeUndefined();
  });

  it('a REJECTED request can never be activated and keeps the active destination', async () => {
    const agentId = 'TEST-B2-APDC-M-' + RUN;
    const changeId = 'APDC-M1-' + RUN;
    await seedAgent(agentId);
    await seedPendingChange({ id: changeId, agentId });

    const rejected = await db.recordAgentPayoutDestinationAdminDecision({
      id: changeId,
      decision: 'reject',
      actor: ADMIN_USER,
      reason: 'Could not confirm the number belongs to this hub',
    });
    expect(rejected.ok).toBe(true);

    const activation = await db.activateAgentPayoutDestinationChange({
      id: changeId,
      actor: ADMIN_USER,
    });
    expect(activation.activated).toBe(false);
    expect(activation.code).toBe('REJECTED');

    const agent = await db.getAgent(agentId);
    expect(agent!.mpesa_till_or_paybill).toBe(CURRENT_A);
  });
});

// ---------------------------------------------------------------------------
// 5. HTTP — authentication, ownership, validation, and masked responses
// ---------------------------------------------------------------------------
describe('B2 payout settings HTTP authorization and privacy', () => {
  it('requires authentication', async () => {
    const response = await api('GET', '/api/agents/payout-settings');
    expect(response.status).toBe(401);
  });

  it('returns the current destination MASKED, with format separated from verification', async () => {
    const response = await api('GET', '/api/agents/payout-settings', tokenA);
    expect(response.status).toBe(200);
    expect(response.body.payout.masked_destination).toContain('***');
    expect(response.body.payout.masked_destination).not.toBe(CURRENT_A);
    expect(response.body.payout.eligible).toBe(true);
    expect(response.body.payout.format_check_only).toBe(true);
    // No proof exists for the grandfathered number, so it is NOT labelled verified.
    expect(response.body.payout.phone_ownership_verified).toBe(false);
    expect(response.body.verification.verification_available).toBe(false);
    expect(response.body.pending_request).toBeNull();
    // The full number never appears anywhere in the payload.
    expect(response.text).not.toContain(CURRENT_A);
  });

  it('refuses a request that names a different agent', async () => {
    const response = await api('POST', '/api/agents/payout-settings/change-request', tokenA, {
      agentId: AGENT_B,
      destination: '0712345678',
    });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('AGENT_SCOPE_VIOLATION');
  });

  it('rejects a malformed destination', async () => {
    const response = await api('POST', '/api/agents/payout-settings/change-request', tokenA, {
      destination: 'E2E-TILL-123',
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('destination_not_a_personal_mpesa_phone');
  });

  it('rejects Till / Paybill / Pochi method changes', async () => {
    for (const method of ['Till Number', 'Paybill Number', 'Pochi la Biashara']) {
      const response = await api('POST', '/api/agents/payout-settings/change-request', tokenA, {
        destination: '0712345678',
        payoutMethodType: method,
      });
      expect(response.status, method).toBe(422);
      expect(response.body.code, method).toBe('unsupported_payout_method');
    }
  });

  it('records a valid request, does NOT activate it, and never claims a code was sent', async () => {
    const response = await api('POST', '/api/agents/payout-settings/change-request', tokenA, {
      destination: '0733 111 222',
    });
    expect(response.status).toBe(201);
    expect(response.body.created).toBe(true);
    expect(response.body.request.masked_proposed_destination).toContain('***');
    expect(response.body.request.status).toBe('pending_verification');
    expect(response.body.request.phone_verification).toBe('not_verified');
    expect(response.body.request.admin_approval).toBe('not_requested');
    expect(response.body.request.can_activate).toBe(false);
    expect(response.body.verification.verification_available).toBe(false);
    expect(response.text).not.toContain(PROPOSED_A);
    expect(response.body.message).toMatch(/NOT active/i);

    // The authoritative destination is untouched.
    const agent = await db.getAgent(AGENT_A);
    expect(agent!.mpesa_till_or_paybill).toBe(CURRENT_A);
  });

  it('treats a duplicate submission for the same number as idempotent', async () => {
    const first = await api('GET', '/api/agents/payout-settings', tokenA);
    const changeId = first.body.pending_request.id;

    const response = await api('POST', '/api/agents/payout-settings/change-request', tokenA, {
      destination: '0733111222',
    });
    expect(response.status).toBe(200);
    expect(response.body.duplicate).toBe(true);
    expect(response.body.created).toBe(false);
    expect(response.body.request.id).toBe(changeId);

    const rows = await drizzleDb
      .select()
      .from(changesTable)
      .where(eq(changesTable.agent_id, AGENT_A));
    expect(rows).toHaveLength(1);
  });

  it('refuses a DIFFERENT number while a request is live', async () => {
    const response = await api('POST', '/api/agents/payout-settings/change-request', tokenA, {
      destination: PROPOSED_A_ALT,
    });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('change_request_already_pending');
  });

  it('never resolves another agent’s change id', async () => {
    const mine = await api('GET', '/api/agents/payout-settings/change-request/APDC-NOT-MINE', tokenA);
    expect(mine.status).toBe(404);

    const aView = await api('GET', '/api/agents/payout-settings', tokenA);
    const changeId = aView.body.pending_request.id;
    const bView = await api('GET', '/api/agents/payout-settings/change-request/' + changeId, tokenB);
    expect(bView.status).toBe(404);
  });
});

describe('B2 payout settings verification and admin review', () => {
  it('refuses to start phone verification and never claims a code was sent', async () => {
    const view = await api('GET', '/api/agents/payout-settings', tokenA);
    const changeId = view.body.pending_request.id;

    const response = await api(
      'POST',
      '/api/agents/payout-settings/change-request/' + changeId + '/verify-phone',
      tokenA,
    );
    expect(response.status).toBe(503);
    expect(response.body.verification_available).toBe(false);
    expect(response.body.code_sent).toBe(false);
    expect(response.body.destination_verified).toBe(false);

    const row = await db.getAgentPayoutDestinationChangeById(changeId, AGENT_A);
    expect(row.phone_verified_at).toBeNull();
  });

  it('keeps admin endpoints out of reach for an agent token', async () => {
    const response = await api('GET', '/api/admin/agent-payout-destination-changes', tokenA);
    expect(response.status).toBe(403);
  });

  it('lists requests for an administrator with MASKED destinations only', async () => {
    const response = await api('GET', '/api/admin/agent-payout-destination-changes', adminToken);
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.requests)).toBe(true);
    const mine = response.body.requests.find((row: any) => row.agent_id === AGENT_A);
    expect(mine).toBeTruthy();
    expect(mine.masked_proposed_destination).toContain('***');
    expect(response.text).not.toContain(PROPOSED_A);
    expect(response.text).not.toContain(CURRENT_A);
  });

  it('admin approval alone does NOT activate and does not change the destination', async () => {
    const view = await api('GET', '/api/agents/payout-settings', tokenA);
    const changeId = view.body.pending_request.id;

    const response = await api(
      'POST',
      '/api/admin/agent-payout-destination-changes/' + changeId + '/approve',
      adminToken,
    );
    expect(response.status).toBe(200);
    expect(response.body.approved).toBe(true);
    expect(response.body.activated).toBe(false);
    expect(response.body.activation_code).toBe('NOT_VERIFIED');
    expect(response.body.request.admin_approval).toBe('approved');
    expect(response.body.request.phone_verification).toBe('not_verified');

    const agent = await db.getAgent(AGENT_A);
    expect(agent!.mpesa_till_or_paybill).toBe(CURRENT_A);
  });

  it('requires a reason to reject, then rejects and frees the live slot', async () => {
    const view = await api('GET', '/api/agents/payout-settings', tokenA);
    const changeId = view.body.pending_request.id;

    const missingReason = await api(
      'POST',
      '/api/admin/agent-payout-destination-changes/' + changeId + '/reject',
      adminToken,
      {},
    );
    expect(missingReason.status).toBe(400);
    expect(missingReason.body.code).toBe('rejection_reason_required');

    const rejected = await api(
      'POST',
      '/api/admin/agent-payout-destination-changes/' + changeId + '/reject',
      adminToken,
      { reason: 'Number does not belong to this hub' },
    );
    expect(rejected.status).toBe(200);
    expect(rejected.body.rejected).toBe(true);
    expect(rejected.body.request.status).toBe('rejected');

    const after = await api('GET', '/api/agents/payout-settings', tokenA);
    expect(after.body.pending_request).toBeNull();
    const agent = await db.getAgent(AGENT_A);
    expect(agent!.mpesa_till_or_paybill).toBe(CURRENT_A);

    // A later, different request is now allowed.
    const next = await api('POST', '/api/agents/payout-settings/change-request', tokenA, {
      destination: PROPOSED_A_ALT,
    });
    expect(next.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// 6. GRANDFATHERING — eligibility survives, verification labels do not appear
// ---------------------------------------------------------------------------
describe('B2 grandfathering and legacy methods', () => {
  it('keeps a grandfathered Personal M-Pesa agent eligible without a false verification label', async () => {
    const agentId = 'TEST-B2-APDC-GRANDFATHERED-' + RUN;
    await seedAgent(agentId, {
      mpesa_till_or_paybill: '254711000111',
      payout_method_type: 'Personal M-Pesa',
    });
    const token = generateToken({
      userId: agentId,
      phone: randomPhone(4),
      role: 'agent',
      agentId,
    });

    const response = await api('GET', '/api/agents/payout-settings', token);
    expect(response.status).toBe(200);
    expect(response.body.payout.eligible).toBe(true);
    expect(response.body.payout.risk_class).toBe('eligible');
    // The number is eligible by FORMAT, but no proof of ownership was ever
    // recorded, so the label must stay false.
    expect(response.body.payout.phone_ownership_verified).toBe(false);
    expect(response.body.payout.phone_ownership_verified_at).toBeNull();
    expect(response.text).not.toContain('254711000111');
  });

  it('keeps a legacy unsupported method ineligible and does not convert it', async () => {
    const agentId = 'TEST-B2-APDC-LEGACY-TILL-' + RUN;
    await seedAgent(agentId, {
      mpesa_till_or_paybill: '254711000222',
      payout_method_type: 'Till Number',
    });
    const token = generateToken({
      userId: agentId,
      phone: randomPhone(5),
      role: 'agent',
      agentId,
    });

    const response = await api('GET', '/api/agents/payout-settings', token);
    expect(response.status).toBe(200);
    expect(response.body.payout.eligible).toBe(false);
    expect(response.body.payout.risk_class).toBe('refused_unsupported_payout_method');

    // Reading settings never mutates the stored method.
    const agent = await db.getAgent(agentId);
    expect(agent!.payout_method_type).toBe('Till Number');
  });
});

// ---------------------------------------------------------------------------
// 7. STATIC INTEGRITY — protected registrations, schema lockstep, executor
// ---------------------------------------------------------------------------
describe('B2 static integrity', () => {
  const ROOT = path.resolve(__dirname, '..');
  const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
  const count = (source: string, needle: string | RegExp) => source.split(needle).length - 1;

  const agentOpsTs = read('routes/agentOps.ts');
  const serverTs = read('server.ts');
  const schemaTs = read('db/schema.ts');
  const dbIndexTs = read('db/index.ts');
  const schemaSql = fs.readFileSync(path.resolve(ROOT, '../sql/schema.sql'), 'utf8');
  const routeTs = read('routes/agentPayoutSettings.ts');
  const hubTs = read('components/agent/AgentHub.tsx');
  const cardTs = read('components/agent/PayoutSettingsCard.tsx');

  it('leaves agentOps.ts with exactly its six registrations', () => {
    const registrations = agentOpsTs.match(/app\.(get|post|put|delete)\(/g) || [];
    expect(registrations).toHaveLength(6);
    expect(agentOpsTs).not.toContain('/api/agents/payout-settings');
  });

  it('registers the new module exactly once from server.ts', () => {
    expect(count(serverTs, 'registerAgentPayoutSettingsRoutes(app, {')).toBe(1);
  });

  it('the route module holds four agent and three admin registrations', () => {
    expect(routeTs.match(/app\.(get|post|put|delete)\(/g) || []).toHaveLength(7);
    expect(count(routeTs, "'/api/agents/payout-settings'")).toBe(1);
    // Four agent route mounts plus the one deps destructuring.
    expect(count(routeTs, 'requireActiveAgent,')).toBe(5);
    expect(count(routeTs, 'authenticateJWT, requireActiveAgent,')).toBe(1);
    // Three admin route mounts plus the one deps destructuring.
    expect(count(routeTs, 'requireCurrentAdminSession,')).toBe(4);
  });

  it('the route module never boots or imports the server and never writes agents directly', () => {
    expect(routeTs).not.toContain('startServer(');
    expect(routeTs).not.toMatch(/from\s+['"].*server['"]/);
    expect(routeTs).not.toContain('agentsTable');
    expect(routeTs).not.toContain('mpesa_till_or_paybill =');
  });

  it('the new table exists in ALL THREE schema representations', () => {
    expect(schemaTs).toContain('export const agent_payout_destination_changes = pgTable');
    expect(schemaSql).toContain('CREATE TABLE agent_payout_destination_changes');
    expect(dbIndexTs).toContain('CREATE TABLE IF NOT EXISTS agent_payout_destination_changes');
  });

  it('the schema ships NO OTP code or hash column (no challenge it cannot deliver)', () => {
    const start = schemaTs.indexOf('export const agent_payout_destination_changes = pgTable');
    const end = schemaTs.indexOf('// 3. ITEMS TABLE', start);
    const block = schemaTs.slice(start, end);
    expect(block).not.toContain('code_hash');
    expect(block).not.toContain('otp');
    expect(block).toContain('phone_verified_at');
    expect(block).toContain('admin_approved_at');
    expect(block).toContain('destination_format_eligible');
  });

  it('the payout executor is untouched: it still reads the authoritative agents row', () => {
    expect(serverTs).toContain('destination: agent.mpesa_till_or_paybill,');
    expect(serverTs).toContain("payoutMethodType: agent.payout_method_type || 'Till Number'");
    // All-or-nothing settlement and its CAS remain in place.
    expect(serverTs).toContain('resolvePayoutBatchEligibility(');
    expect(serverTs).toContain('db.finalizeSettlement(claimId)');
  });

  it('AgentHub stays hook-free, fetch-free and unaware of this feature', () => {
    expect(hubTs).not.toMatch(/\buse(State|Effect|Memo|Callback|Ref|Reducer)\s*\(/);
    expect(hubTs).not.toMatch(/\bfetch\s*\(|\bagentApi\b/);
    expect(hubTs).not.toContain('PayoutSettingsCard');
  });

  it('the card never claims a code was sent and loads through the established API client', () => {
    expect(cardTs).toContain('No verification code was sent');
    expect(cardTs).toContain('agentApi.getPayoutSettings');
    expect(cardTs).not.toMatch(/\bfetch\s*\(/);
    expect(cardTs).not.toMatch(/code sent successfully|code has been sent/i);
  });
});
