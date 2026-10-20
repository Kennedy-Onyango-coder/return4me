// =============================================================================
// BATCH 2 TARGETED REMEDIATION — regression tests for MEDIUM-1, MEDIUM-2,
// MEDIUM-3 and LOW-6.
//
// WHAT IS PROVEN AT RUNTIME, AND WHAT IS NOT
// ------------------------------------------
// These tests exercise the REAL route handlers, the REAL database layer and the
// REAL policy module against the project's in-memory test double (mock mode).
// That double does NOT implement ORDER BY or LIMIT — it returns every row
// matching the WHERE clause — so:
//
//   * status filtering, page slicing, `has_more` boundaries and the masked HTTP
//     projection ARE runtime assertions (the double's returned set makes the
//     slice meaningful);
//   * the SQL ORDER BY / bounded LIMIT of the admin list is pinned by ONE
//     clearly-labelled static assertion, because no runtime observation through
//     this harness can distinguish "ordered in SQL" from "insertion order".
//
// Concurrency is simulated by injecting the interleaving at the public database
// method boundary (a spy that performs the competing write). That proves what
// the HANDLER does with a conflicting persisted state; it is not a PostgreSQL
// transaction test and is not described as one.
//
// NOTHING HERE CONTACTS A PROVIDER OR MOVES MONEY.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import type { Server } from 'http';
import { eq } from 'drizzle-orm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { db as drizzleDb } from '../db/index.ts';
import {
  agents as agentsTable,
  agent_payout_destination_changes as changesTable,
} from '../db/schema.ts';
import { db } from '../db/database.ts';
import { generateToken } from '../services/auth.ts';
import { registerAgentPayoutSettingsRoutes } from '../routes/agentPayoutSettings.ts';
import {
  AGENT_PAYOUT_CHANGE_TTL_MS,
  resolveAgentPayoutChangeState,
  resolveAgentPayoutOutcomeNotice,
  toAgentPayoutChangeView,
} from '../config/agentPayoutVerification.ts';
import { PayoutChangeOutcomePanel } from '../components/agent/PayoutSettingsCard.tsx';

const RUN = Math.floor(100000 + Math.random() * 899999).toString(36).toUpperCase();
const ADMIN_USER = 'remediation-reviewer-' + RUN;
/** PHASE 2 — the administrator who records the phone-call attestation. */
const ATTESTER = 'remediation-attester-' + RUN;

const CURRENT = '254712000111';
const PROPOSED = '254733000222';
const PROPOSED_ALT = '254733000333';

/** Bulk-history fixture for MEDIUM-3. No other test creates `expired` rows. */
const BULK_COUNT = 250;
const PAGED_AGENT = 'RM-B2-PAGES-' + RUN;
const BULK_DESTINATIONS = Array.from({ length: BULK_COUNT }, (_, i) => '2547' + String(10000000 + i));

function randomPhone(seed: number): string {
  return '+2547' + String(10000000 + seed).slice(-8);
}

let phoneSeed = 100;
const tokenFor = (agentId: string) =>
  generateToken({
    userId: agentId,
    phone: randomPhone(phoneSeed++),
    role: 'agent',
    agentId,
  });

const adminToken = generateToken({
  userId: 'RM-ADM-' + RUN,
  phone: randomPhone(900),
  role: 'admin',
  username: ADMIN_USER,
  tokenVersion: 1,
});

async function seedAgent(id: string) {
  await drizzleDb.insert(agentsTable).values({
    id,
    business_name: 'Remediation Agent ' + id,
    contact_phone: randomPhone(Math.floor(Math.random() * 80000000)),
    location_address: 'Kimathi Street, Nairobi',
    mpesa_till_or_paybill: CURRENT,
    payout_method_type: 'Personal M-Pesa',
    status: 'active',
    national_id_hash: 'b'.repeat(64),
    refundable_deposit: '0.00',
  } as any);
}

async function seedChange(params: { id: string; agentId: string; destination?: string }) {
  const created = await db.createAgentPayoutDestinationChange({
    id: params.id,
    agentId: params.agentId,
    proposedDestination: params.destination ?? PROPOSED,
    proposedPayoutMethod: 'Personal M-Pesa',
    destinationFormatEligible: true,
    expiresAt: new Date(Date.now() + AGENT_PAYOUT_CHANGE_TTL_MS),
  });
  expect(created).toBeTruthy();
  return created;
}

/** A complete attestation by a DIFFERENT administrator than ADMIN_USER. */
async function attestAsDifferentAdmin(changeId: string) {
  const result = await db.recordAgentPayoutDestinationAttestation({
    id: changeId,
    actor: ATTESTER,
    note: 'Called the proposed number and confirmed the agent controls it.',
  });
  expect(result.ok, result.code).toBe(true);
}

let server: Server;
let baseUrl = '';

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
  // A single real agent row carries the 250 terminal history rows. `live_key`
  // is NULL on every one of them, exactly as an expired row is persisted, so
  // the real unique index would allow all of them; the fixture therefore does
  // not rely on the double's (absent) constraint modelling.
  await seedAgent(PAGED_AGENT);
  const base = Date.now() - BULK_COUNT * 1000;
  for (let i = 0; i < BULK_COUNT; i += 1) {
    await drizzleDb.insert(changesTable).values({
      id: 'RM-B2-BULK-' + RUN + '-' + String(i).padStart(3, '0'),
      agent_id: PAGED_AGENT,
      live_key: null,
      proposed_destination: BULK_DESTINATIONS[i],
      proposed_payout_method: 'Personal M-Pesa',
      destination_format_eligible: true,
      status: 'expired',
      phone_verified_at: null,
      phone_verification_provider_ref: null,
      attested_at: null,
      attested_by: null,
      attestation_method: null,
      attestation_note: null,
      admin_approved_at: null,
      admin_approved_by: null,
      admin_rejected_at: null,
      admin_rejected_by: null,
      rejection_reason: null,
      activated_at: null,
      expires_at: new Date(base + i * 1000 - AGENT_PAYOUT_CHANGE_TTL_MS),
      created_at: new Date(base + i * 1000),
      updated_at: new Date(base + i * 1000),
    } as any);
  }

  const app = express();
  app.use(express.json());
  registerAgentPayoutSettingsRoutes(app, {
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

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// MEDIUM-1 — the persisted status follows the recorded facts in BOTH orders
// ---------------------------------------------------------------------------
describe('MEDIUM-1 status transition after phone verification', () => {
  it('attest-then-approve records both facts and leaves the row ready to activate', async () => {
    const agentId = 'RM-B2-M1A-' + RUN;
    const changeId = 'RM-B2-M1A-C1-' + RUN;
    await seedAgent(agentId);
    await seedChange({ id: changeId, agentId });

    const attested = await db.recordAgentPayoutDestinationAttestation({
      id: changeId,
      actor: ATTESTER,
      note: 'Called the number and confirmed the agent controls it.',
    });
    expect(attested.ok, attested.code).toBe(true);

    const approved = await db.recordAgentPayoutDestinationAdminDecision({
      id: changeId,
      decision: 'approve',
      actor: ADMIN_USER,
    });
    expect(approved.ok).toBe(true);
    expect(approved.code).toBe('APPROVED');

    const row = await db.getAgentPayoutDestinationChangeById(changeId, agentId);
    expect(row.attested_at).toBeTruthy();
    expect(row.phone_verified_at ?? null).toBeNull();
    expect(row.admin_approved_at).toBeTruthy();
    expect(row.status).toBe('pending_admin_approval');
    expect(row.status).not.toBe('pending_verification');

    expect(resolveAgentPayoutChangeState(row)).toBe('ready_to_activate');
    const view = toAgentPayoutChangeView(row);
    expect(view.status).toBe('ready_to_activate');
    expect(view.can_activate).toBe(true);
    expect(view.activation_blockers).toEqual([]);
    expect(view.attestation).toBe('attested');
    expect(view.phone_verification).toBe('not_verified');
    expect(view.admin_approval).toBe('approved');
    expect(view.masked_proposed_destination).toContain('***');
    expect(view.masked_proposed_destination).not.toBe(PROPOSED);
  });

  it('verify-then-approve converges on the same persisted status and derived state', async () => {
    const agentId = 'RM-B2-M1B-' + RUN;
    const changeId = 'RM-B2-M1B-C1-' + RUN;
    await seedAgent(agentId);
    await seedChange({ id: changeId, agentId, destination: PROPOSED_ALT });

    const verified = await db.recordAgentPayoutDestinationPhoneVerification({
      id: changeId,
      providerRef: 'rm-attestation-' + RUN,
    });
    expect(verified.ok).toBe(true);

    const afterVerification = await db.getAgentPayoutDestinationChangeById(changeId, agentId);
    expect(afterVerification.status).toBe('pending_admin_approval');
    expect(resolveAgentPayoutChangeState(afterVerification)).toBe('pending_admin_approval');

    const approved = await db.recordAgentPayoutDestinationAdminDecision({
      id: changeId,
      decision: 'approve',
      actor: ADMIN_USER,
    });
    expect(approved.ok).toBe(true);

    const row = await db.getAgentPayoutDestinationChangeById(changeId, agentId);
    expect(row.status).toBe('pending_admin_approval');
    expect(resolveAgentPayoutChangeState(row)).toBe('ready_to_activate');
    expect(toAgentPayoutChangeView(row).can_activate).toBe(true);
  });

  it('admin status filtering finds attested-and-approved requests', async () => {
    const firstAgent = 'RM-B2-M1C-' + RUN;
    const firstId = 'RM-B2-M1C-C1-' + RUN;
    await seedAgent(firstAgent);
    await seedChange({ id: firstId, agentId: firstAgent });
    await attestAsDifferentAdmin(firstId);
    await db.recordAgentPayoutDestinationAdminDecision({
      id: firstId,
      decision: 'approve',
      actor: ADMIN_USER,
    });

    const secondAgent = 'RM-B2-M1D-' + RUN;
    const secondId = 'RM-B2-M1D-C1-' + RUN;
    await seedAgent(secondAgent);
    await seedChange({ id: secondId, agentId: secondAgent, destination: PROPOSED_ALT });
    await attestAsDifferentAdmin(secondId);
    await db.recordAgentPayoutDestinationAdminDecision({
      id: secondId,
      decision: 'approve',
      actor: ADMIN_USER,
    });

    const approvedPage = await db.listAdminAgentPayoutDestinationChanges({
      statuses: ['pending_admin_approval'],
      limit: 200,
      offset: 0,
    });
    const approvedIds = approvedPage.rows.map((row: any) => row.id);
    expect(approvedIds).toContain(firstId);
    expect(approvedIds).toContain(secondId);
    for (const row of approvedPage.rows) expect(row.status).toBe('pending_admin_approval');

    const unverifiedPage = await db.listAdminAgentPayoutDestinationChanges({
      statuses: ['pending_verification'],
      limit: 200,
      offset: 0,
    });
    const unverifiedIds = unverifiedPage.rows.map((row: any) => row.id);
    expect(unverifiedIds).not.toContain(firstId);
    expect(unverifiedIds).not.toContain(secondId);
  });

  it('neither fact alone activates, and each leaves an honest persisted status', async () => {
    const approvalOnlyAgent = 'RM-B2-M1E-' + RUN;
    const approvalOnlyId = 'RM-B2-M1E-C1-' + RUN;
    await seedAgent(approvalOnlyAgent);
    await seedChange({ id: approvalOnlyId, agentId: approvalOnlyAgent });
    await db.recordAgentPayoutDestinationAdminDecision({
      id: approvalOnlyId,
      decision: 'approve',
      actor: ADMIN_USER,
    });

    const approvalOnlyRow = await db.getAgentPayoutDestinationChangeById(
      approvalOnlyId,
      approvalOnlyAgent,
    );
    expect(approvalOnlyRow.status).toBe('pending_verification');
    expect(resolveAgentPayoutChangeState(approvalOnlyRow)).toBe('pending_verification');

    const approvalOnlyActivation = await db.activateAgentPayoutDestinationChange({
      id: approvalOnlyId,
      actor: ADMIN_USER,
    });
    expect(approvalOnlyActivation.activated).toBe(false);
    expect(approvalOnlyActivation.code).toBe('NOT_ATTESTED');
    expect((await db.getAgent(approvalOnlyAgent))!.mpesa_till_or_paybill).toBe(CURRENT);

    const verificationOnlyAgent = 'RM-B2-M1F-' + RUN;
    const verificationOnlyId = 'RM-B2-M1F-C1-' + RUN;
    await seedAgent(verificationOnlyAgent);
    await seedChange({ id: verificationOnlyId, agentId: verificationOnlyAgent });
    await db.recordAgentPayoutDestinationPhoneVerification({
      id: verificationOnlyId,
      providerRef: 'rm-attestation-' + RUN,
    });

    const verificationOnlyRow = await db.getAgentPayoutDestinationChangeById(
      verificationOnlyId,
      verificationOnlyAgent,
    );
    expect(verificationOnlyRow.status).toBe('pending_admin_approval');
    expect(resolveAgentPayoutChangeState(verificationOnlyRow)).toBe('pending_admin_approval');

    const verificationOnlyActivation = await db.activateAgentPayoutDestinationChange({
      id: verificationOnlyId,
      actor: ADMIN_USER,
    });
    expect(verificationOnlyActivation.activated).toBe(false);
    expect(verificationOnlyActivation.code).toBe('NOT_APPROVED');
    expect((await db.getAgent(verificationOnlyAgent))!.mpesa_till_or_paybill).toBe(CURRENT);
  });

  it('activates only after an attestation AND a different administrator approval, and only then moves the agents row', async () => {
    const agentId = 'RM-B2-M1G-' + RUN;
    const changeId = 'RM-B2-M1G-C1-' + RUN;
    const destination = '254733000444';
    await seedAgent(agentId);
    await seedChange({ id: changeId, agentId, destination });

    // Approval before attestation is refused; the row stays live.
    const premature = await db.recordAgentPayoutDestinationAdminDecision({
      id: changeId,
      decision: 'approve',
      actor: ADMIN_USER,
    });
    expect(premature.ok).toBe(false);
    expect(premature.code).toBe('ATTESTATION_REQUIRED');

    await attestAsDifferentAdmin(changeId);
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
    expect((await db.getAgent(agentId))!.mpesa_till_or_paybill).toBe(destination);
  });
});

// ---------------------------------------------------------------------------
// MEDIUM-2 — terminal outcomes are visible to the OWNING agent, masked
// ---------------------------------------------------------------------------
describe('MEDIUM-2 rejection visibility in the agent dashboard', () => {
  it('returns the rejected outcome, masked, with the administrator reason', async () => {
    const agentId = 'RM-B2-M2A-' + RUN;
    const changeId = 'RM-B2-M2A-C1-' + RUN;
    const reason = 'The number is registered to another person.';
    await seedAgent(agentId);
    await seedChange({ id: changeId, agentId });

    const rejected = await db.recordAgentPayoutDestinationAdminDecision({
      id: changeId,
      decision: 'reject',
      actor: ADMIN_USER,
      reason,
    });
    expect(rejected.ok).toBe(true);
    expect(rejected.code).toBe('REJECTED');

    const response = await api('GET', '/api/agents/payout-settings', tokenFor(agentId));
    expect(response.status).toBe(200);
    expect(response.body.pending_request).toBeNull();
    expect(response.body.latest_request).toBeTruthy();
    expect(response.body.latest_request.id).toBe(changeId);
    expect(response.body.latest_request.agent_id).toBe(agentId);
    expect(response.body.latest_request.status).toBe('rejected');
    expect(response.body.latest_request.admin_approval).toBe('rejected');
    expect(response.body.latest_request.rejection_reason).toBe(reason);
    expect(response.body.latest_request.masked_proposed_destination).toContain('***');
    // Privacy: the masked view never carries the canonical number or the
    // provider reference the attestation boundary stores.
    expect(response.text).not.toContain(PROPOSED);
    expect(response.text).not.toContain('phone_verification_provider_ref');
    expect(response.text).not.toContain('provider_ref');
  });

  it('keeps the latest outcome strictly scoped to the calling agent', async () => {
    const ownerAgent = 'RM-B2-M2B-' + RUN;
    const ownerChangeId = 'RM-B2-M2B-C1-' + RUN;
    await seedAgent(ownerAgent);
    await seedChange({ id: ownerChangeId, agentId: ownerAgent });
    await db.recordAgentPayoutDestinationAdminDecision({
      id: ownerChangeId,
      decision: 'reject',
      actor: ADMIN_USER,
      reason: 'Owner-only reason text',
    });

    const strangerAgent = 'RM-B2-M2C-' + RUN;
    await seedAgent(strangerAgent);

    const stranger = await api('GET', '/api/agents/payout-settings', tokenFor(strangerAgent));
    expect(stranger.status).toBe(200);
    expect(stranger.body.latest_request).toBeNull();
    expect(stranger.text).not.toContain(ownerChangeId);
    expect(stranger.text).not.toContain('Owner-only reason text');

    const owner = await api('GET', '/api/agents/payout-settings', tokenFor(ownerAgent));
    expect(owner.body.latest_request.id).toBe(ownerChangeId);
    expect(owner.body.latest_request.rejection_reason).toBe('Owner-only reason text');
  });

  it('the scoped single-request read refuses foreign and missing ids but serves the owner', async () => {
    const ownerAgent = 'RM-B2-M2D-' + RUN;
    const strangerAgent = 'RM-B2-M2E-' + RUN;
    const changeId = 'RM-B2-M2D-C1-' + RUN;
    const reason = 'Details did not match the hub records.';
    await seedAgent(ownerAgent);
    await seedAgent(strangerAgent);
    await seedChange({ id: changeId, agentId: ownerAgent });
    await db.recordAgentPayoutDestinationAdminDecision({
      id: changeId,
      decision: 'reject',
      actor: ADMIN_USER,
      reason,
    });

    const own = await api(
      'GET',
      '/api/agents/payout-settings/change-request/' + changeId,
      tokenFor(ownerAgent),
    );
    expect(own.status).toBe(200);
    expect(own.body.request.status).toBe('rejected');
    expect(own.body.request.rejection_reason).toBe(reason);
    expect(own.body.request.masked_proposed_destination).toContain('***');
    expect(own.text).not.toContain(PROPOSED);

    const foreign = await api(
      'GET',
      '/api/agents/payout-settings/change-request/' + changeId,
      tokenFor(strangerAgent),
    );
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe('NOT_FOUND');
    expect(foreign.text).not.toContain(reason);

    const missing = await api(
      'GET',
      '/api/agents/payout-settings/change-request/RM-B2-NOPE-' + RUN,
      tokenFor(ownerAgent),
    );
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('NOT_FOUND');
  });

  it('renders the reason and masked destination as real markup', async () => {
    const agentId = 'RM-B2-M2F-' + RUN;
    const changeId = 'RM-B2-M2F-C1-' + RUN;
    const reason = 'Use the number registered to the business owner.';
    await seedAgent(agentId);
    await seedChange({ id: changeId, agentId });
    await db.recordAgentPayoutDestinationAdminDecision({
      id: changeId,
      decision: 'reject',
      actor: ADMIN_USER,
      reason,
    });

    const row = await db.getAgentPayoutDestinationChangeById(changeId, agentId);
    const view = toAgentPayoutChangeView(row);
    const html = renderToStaticMarkup(
      React.createElement(PayoutChangeOutcomePanel, { request: view }),
    );

    expect(html).toContain('data-outcome="rejected"');
    expect(html).toContain('Change request rejected');
    expect(html).toContain('Reason given by the administrator:');
    expect(html).toContain(reason);
    expect(html).toContain(view.masked_proposed_destination);
    // The raw canonical number is not in the view, so it cannot be in the markup.
    expect(html).not.toContain(PROPOSED);
    expect(html).not.toContain('pending_verification');
  });

  it('distinguishes expired, activated and in-flight requests', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const base = {
      id: 'RM-B2-VIEW',
      agent_id: 'RM-B2-VIEW-AGENT',
      proposed_destination: PROPOSED,
      proposed_payout_method: 'Personal M-Pesa',
      destination_format_eligible: true,
    };

    const expiredHtml = renderToStaticMarkup(
      React.createElement(PayoutChangeOutcomePanel, {
        request: toAgentPayoutChangeView({
          ...base,
          status: 'expired',
          expires_at: new Date(Date.now() - 1000).toISOString(),
        }),
      }),
    );
    expect(expiredHtml).toContain('data-outcome="expired"');
    expect(expiredHtml).toContain('Change request expired');
    expect(expiredHtml).not.toContain('Reason given by the administrator');

    const activatedHtml = renderToStaticMarkup(
      React.createElement(PayoutChangeOutcomePanel, {
        request: toAgentPayoutChangeView({
          ...base,
          status: 'activated',
          activated_at: new Date().toISOString(),
          expires_at: future,
        }),
      }),
    );
    expect(activatedHtml).toContain('data-outcome="activated"');
    expect(activatedHtml).toContain('Change request activated');
    expect(activatedHtml).not.toContain('Reason given by the administrator');

    const liveHtml = renderToStaticMarkup(
      React.createElement(PayoutChangeOutcomePanel, {
        request: toAgentPayoutChangeView({
          ...base,
          status: 'pending_verification',
          expires_at: future,
        }),
      }),
    );
    expect(liveHtml).toBe('');
  });

  it('never invents a rejection reason', () => {
    const blank = resolveAgentPayoutOutcomeNotice({
      status: 'rejected',
      admin_rejected_at: new Date().toISOString(),
      rejection_reason: '   ',
    });
    expect(blank).toBeTruthy();
    expect(blank!.kind).toBe('rejected');
    expect(blank!.reason).toBeNull();

    const missing = resolveAgentPayoutOutcomeNotice({
      status: 'rejected',
      admin_rejected_at: new Date().toISOString(),
      rejection_reason: null,
    });
    expect(missing!.reason).toBeNull();

    // A live request has no terminal notice at all.
    expect(
      resolveAgentPayoutOutcomeNotice({
        status: 'pending_verification',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MEDIUM-3 — admin listing filters, orders and pages in the database layer
// ---------------------------------------------------------------------------
describe('MEDIUM-3 database-level admin pagination', () => {
  it('pages the whole large history once, with no gaps and no duplicates', async () => {
    const limit = 50;
    const seen = new Set<string>();
    let offset = 0;
    let pages = 0;
    let hasMore = true;

    while (hasMore && pages < 20) {
      const page = await db.listAdminAgentPayoutDestinationChanges({
        statuses: ['expired'],
        limit,
        offset,
      });
      expect(page.rows.length).toBeLessThanOrEqual(limit);
      for (const row of page.rows) {
        expect(row.status).toBe('expired');
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
      hasMore = page.hasMore;
      offset += limit;
      pages += 1;
    }

    expect(pages).toBe(BULK_COUNT / limit);
    expect(seen.size).toBe(BULK_COUNT);
  });

  it('reports has_more exactly at the page boundaries', async () => {
    const first = await db.listAdminAgentPayoutDestinationChanges({
      statuses: ['expired'],
      limit: 10,
      offset: 0,
    });
    expect(first.rows).toHaveLength(10);
    expect(first.hasMore).toBe(true);

    const middle = await db.listAdminAgentPayoutDestinationChanges({
      statuses: ['expired'],
      limit: 10,
      offset: 230,
    });
    expect(middle.rows).toHaveLength(10);
    expect(middle.hasMore).toBe(true);

    const last = await db.listAdminAgentPayoutDestinationChanges({
      statuses: ['expired'],
      limit: 10,
      offset: 240,
    });
    expect(last.rows).toHaveLength(10);
    expect(last.hasMore).toBe(false);

    const beyond = await db.listAdminAgentPayoutDestinationChanges({
      statuses: ['expired'],
      limit: 10,
      offset: BULK_COUNT,
    });
    expect(beyond.rows).toHaveLength(0);
    expect(beyond.hasMore).toBe(false);
  });

  it('filters by status and treats an empty filter list as "all statuses"', async () => {
    const rejected = await db.listAdminAgentPayoutDestinationChanges({
      statuses: ['rejected'],
      limit: 200,
      offset: 0,
    });
    for (const row of rejected.rows) expect(row.status).toBe('rejected');
    expect(rejected.rows.some((row: any) => row.status === 'expired')).toBe(false);

    const all = await db.listAdminAgentPayoutDestinationChanges({
      statuses: [],
      limit: 200,
      offset: 0,
    });
    expect(all.rows.length).toBeGreaterThan(0);
    expect(all.hasMore).toBe(true);
  });

  it('serves a bounded, masked, status-filtered page over HTTP', async () => {
    const page = await api(
      'GET',
      '/api/admin/agent-payout-destination-changes?status=expired&limit=50&offset=0',
      adminToken,
    );
    expect(page.status).toBe(200);
    expect(page.body.requests).toHaveLength(50);
    expect(page.body.has_more).toBe(true);
    for (const row of page.body.requests) {
      expect(row.status).toBe('expired');
      expect(row.masked_proposed_destination).toContain('***');
      expect(row).not.toHaveProperty('proposed_destination');
      expect(row).not.toHaveProperty('phone_verification_provider_ref');
    }
    // No seeded canonical destination appears in clear in the whole response.
    for (const destination of BULK_DESTINATIONS.slice(0, 5)) {
      expect(page.text).not.toContain(destination);
    }
    expect(page.text).not.toContain('provider_ref');

    const invalid = await api(
      'GET',
      '/api/admin/agent-payout-destination-changes?status=bogus',
      adminToken,
    );
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('invalid_status');
  });

  it('clamps an oversized limit and bounds malformed offsets', async () => {
    const oversized = await api(
      'GET',
      '/api/admin/agent-payout-destination-changes?status=expired&limit=100000',
      adminToken,
    );
    expect(oversized.status).toBe(200);
    expect(oversized.body.requests).toHaveLength(200);
    expect(oversized.body.has_more).toBe(true);

    const malformed = await api(
      'GET',
      '/api/admin/agent-payout-destination-changes?status=expired&limit=5&offset=not-a-number',
      adminToken,
    );
    expect(malformed.status).toBe(200);
    expect(malformed.body.requests).toHaveLength(5);

    const negative = await api(
      'GET',
      '/api/admin/agent-payout-destination-changes?status=expired&limit=0&offset=-10',
      adminToken,
    );
    expect(negative.status).toBe(200);
    expect(negative.body.requests).toHaveLength(1);
  });

  it('pushes ordering and the page window into SQL (static: the double ignores ORDER BY/LIMIT)', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../db/database.ts'), 'utf8');
    const start = source.indexOf('public async listAdminAgentPayoutDestinationChanges');
    const end = source.indexOf('public async recordAgentPayoutDestinationAdminDecision');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);

    expect(block).toContain('.orderBy(');
    expect(block).toContain('desc(agentPayoutDestinationChangesTable.created_at)');
    expect(block).toContain('desc(agentPayoutDestinationChangesTable.id)');
    expect(block).toMatch(/\.limit\(opts\.offset \+ opts\.limit \+ 1\)/);
    // The whole-table sort and unbounded select are gone.
    expect(block).not.toContain('[...rows].sort');
    expect(block).not.toContain('const sorted');
  });
});

// ---------------------------------------------------------------------------
// LOW-6 — the approval response describes the PERSISTED outcome
// ---------------------------------------------------------------------------
describe('LOW-6 approval / rejection race response accuracy', () => {
  it('never reports approval when the request is already rejected', async () => {
    const agentId = 'RM-B2-L6A-' + RUN;
    const changeId = 'RM-B2-L6A-C1-' + RUN;
    await seedAgent(agentId);
    await seedChange({ id: changeId, agentId });

    const rejected = await db.recordAgentPayoutDestinationAdminDecision({
      id: changeId,
      decision: 'reject',
      actor: ADMIN_USER,
      reason: 'Rejected before the approval arrived.',
    });
    expect(rejected.ok).toBe(true);

    const response = await api(
      'POST',
      '/api/admin/agent-payout-destination-changes/' + changeId + '/approve',
      adminToken,
    );
    expect(response.status).toBe(409);
    expect(response.body.approved).not.toBe(true);
    expect(response.body.request.status).toBe('rejected');
    expect(response.text).not.toContain('"approved":true');
    expect(String(response.body.error)).not.toMatch(/approved successfully/i);
  });

  it('reports a conflict when the approval compare-and-swap loses a concurrent rejection', async () => {
    const agentId = 'RM-B2-L6B-' + RUN;
    const changeId = 'RM-B2-L6B-C1-' + RUN;
    await seedAgent(agentId);
    await seedChange({ id: changeId, agentId });

    // PHASE 2 — a complete attestation must exist before an approval can be
    // recorded by a different administrator.
    await attestAsDifferentAdmin(changeId);

    const realRead = db.getAgentPayoutDestinationChangeByIdForAdmin.bind(db);
    let calls = 0;
    vi.spyOn(db, 'getAgentPayoutDestinationChangeByIdForAdmin').mockImplementation(
      (async (id: string) => {
        calls += 1;
        const snapshot = await realRead(id);
        if (calls === 1) {
          // The competing rejection lands AFTER the decision's snapshot read and
          // BEFORE its guarded UPDATE, so the UPDATE matches no row.
          await drizzleDb
            .update(changesTable)
            .set({
              status: 'rejected',
              live_key: null,
              admin_rejected_at: new Date(),
              admin_rejected_by: 'concurrent-admin',
              rejection_reason: 'Concurrent rejection',
            } as any)
            .where(eq(changesTable.id, id));
        }
        return snapshot;
      }) as any,
    );

    const response = await api(
      'POST',
      '/api/admin/agent-payout-destination-changes/' + changeId + '/approve',
      adminToken,
    );
    expect(response.status).toBe(409);
    expect(response.body.approved).not.toBe(true);
    expect(response.body.activation_code).toBeUndefined();
    expect(response.text).not.toContain('"approved":true');

    const row = await db.getAgentPayoutDestinationChangeByIdForAdmin(changeId);
    expect(row.status).toBe('rejected');
  });

  it('reports a conflict when a rejection lands after the approval CAS but before the response', async () => {
    const agentId = 'RM-B2-L6C-' + RUN;
    const changeId = 'RM-B2-L6C-C1-' + RUN;
    const reason = 'Rejected after approval was recorded.';
    await seedAgent(agentId);
    await seedChange({ id: changeId, agentId });
    await attestAsDifferentAdmin(changeId);

    vi.spyOn(db, 'activateAgentPayoutDestinationChange').mockImplementation(
      (async (params: any) => {
        // The approval CAS has already won; the rejection arrives immediately
        // afterwards, before the handler re-reads the persisted row.
        await drizzleDb
          .update(changesTable)
          .set({
            status: 'rejected',
            live_key: null,
            admin_rejected_at: new Date(),
            admin_rejected_by: 'concurrent-admin',
            rejection_reason: reason,
          } as any)
          .where(eq(changesTable.id, params.id));
        return { activated: false, code: 'NOT_VERIFIED' };
      }) as any,
    );

    const response = await api(
      'POST',
      '/api/admin/agent-payout-destination-changes/' + changeId + '/approve',
      adminToken,
    );
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('REJECTED');
    expect(response.body.approved).toBe(false);
    expect(response.body.activated).toBe(false);
    expect(response.body.request.status).toBe('rejected');
    expect(response.body.request.rejection_reason).toBe(reason);
    expect(response.text).not.toContain('"approved":true');
    expect(response.text).not.toContain(PROPOSED);

    const agent = await db.getAgent(agentId);
    expect(agent!.mpesa_till_or_paybill).toBe(CURRENT);
  });

  it('reports a conflict when activation itself loses its compare-and-swap', async () => {
    const agentId = 'RM-B2-L6D-' + RUN;
    const changeId = 'RM-B2-L6D-C1-' + RUN;
    await seedAgent(agentId);
    await seedChange({ id: changeId, agentId });
    await attestAsDifferentAdmin(changeId);

    vi.spyOn(db, 'activateAgentPayoutDestinationChange').mockImplementation(
      (async () => ({ activated: false, code: 'STATE_CONFLICT' })) as any,
    );

    const response = await api(
      'POST',
      '/api/admin/agent-payout-destination-changes/' + changeId + '/approve',
      adminToken,
    );
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('STATE_CONFLICT');
    expect(response.body.approved).toBe(false);
    expect(response.body.activated).toBe(false);
    expect(response.text).not.toContain('"approved":true');
  });

  it('records an approval but refuses activation when the SAME administrator attested the call', async () => {
    const agentId = 'RM-B2-L6E-' + RUN;
    const changeId = 'RM-B2-L6E-C1-' + RUN;
    await seedAgent(agentId);
    await seedChange({ id: changeId, agentId });

    // The approver and the attester are the same person: dual control fails.
    await db.recordAgentPayoutDestinationAttestation({
      id: changeId,
      actor: ADMIN_USER,
      note: 'Called the number myself and confirmed control.',
    });

    const response = await api(
      'POST',
      '/api/admin/agent-payout-destination-changes/' + changeId + '/approve',
      adminToken,
    );
    expect(response.status).toBe(409);
    expect(response.body.approved).toBe(false);
    expect(response.body.activated).toBe(false);
    expect(response.body.code).toBe('ATTESTER_APPROVER_CONFLICT');
    expect(response.body.request.status).toBe('pending_admin_approval');
    expect(response.body.request.masked_proposed_destination).toContain('***');
    expect(response.text).not.toContain(PROPOSED);
    // The note is administrator-only evidence. This response goes to an
    // administrator reviewing the refusal, so the evidence is present; the
    // agent projection never contains it.
    expect(response.text).toContain('Called the number myself');

    const agent = await db.getAgent(agentId);
    expect(agent!.mpesa_till_or_paybill).toBe(CURRENT);
  });
});
