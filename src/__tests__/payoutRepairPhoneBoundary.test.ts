import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { db } from '../db/database';
import { db as drizzle } from '../db/index';
import {
  agents as agentsTable,
  agent_payout_destination_changes as changesTable,
} from '../db/schema';
import {
  AGENT_PAYOUT_PHONE_VERIFICATION_ADAPTER_IMPLEMENTED,
  evaluateAgentPayoutActivation,
} from '../config/agentPayoutVerification';

// =============================================================================
// PHASE 1 — THE PHONE-ATTESTATION BOUNDARY (D4)
// =============================================================================
// The requirement is NEGATIVE: an email address or mailbox OTP must never be able
// to establish control of a mobile number, and a phone-call attestation must
// belong to exactly ONE payout-destination change request and destination.
//
// There is no SMS/WhatsApp adapter in this build, so the boundary is enforced by
// three structural facts, each pinned here:
//   1. `phone_verified_at` does not exist on `agents` at all — verification can
//      only live on a request row;
//   2. the ONLY writer takes a request id + a provider reference (never a
//      destination, never an email), is guarded by `phone_verified_at IS NULL`,
//      and is unreachable from any route while the adapter flag is false;
//   3. nothing else in the repository writes `phone_verified_at`, so no email
//      flow can set it by accident.

const RUN = `pb-${Date.now().toString(36)}`;
let seq = 0;

async function seedAgent(): Promise<string> {
  seq += 1;
  const agentId = `AGT-${RUN}-${seq}`;
  await drizzle.insert(agentsTable).values({
    id: agentId,
    business_name: `Boundary Test Agent ${seq}`,
    contact_phone: `+2547${String(10000000 + seq).slice(-8)}`,
    location_address: 'Test Street',
  } as any);
  return agentId;
}

async function seedChange(agentId: string, destination: string, live = true): Promise<string> {
  seq += 1;
  const id = `APC-${RUN}-${seq}`;
  await drizzle.insert(changesTable).values({
    id,
    agent_id: agentId,
    // NULL once terminal; the mock enforces the one-live-request index on this
    // column exactly as PostgreSQL does, so only the first row is live.
    live_key: live ? agentId : null,
    proposed_destination: destination,
    proposed_payout_method: 'Personal M-Pesa',
    destination_format_eligible: true,
    status: 'pending_verification',
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  } as any);
  return id;
}

async function readChange(id: string): Promise<any> {
  const rows: any[] = await drizzle.select().from(changesTable);
  return rows.find((r) => r.id === id);
}

describe('phone verification boundary — structure', () => {
  it('`agents` has NO phone_verified_at column (verification is per-request, not per-agent)', () => {
    const agentColumns = Object.keys(agentsTable as any);
    expect(agentColumns).not.toContain('phone_verified_at');
    expect(agentColumns).not.toContain('phone_verification_provider_ref');
    // `agents` still holds the payout METHOD; the point is that the PROOF does
    // not live here.
    expect(agentColumns).toContain('payout_method_type');
  });

  it('the destination-change request carries the proof, bound to that one row', () => {
    const changeColumns = Object.keys(changesTable as any);
    expect(changeColumns).toContain('phone_verified_at');
    expect(changeColumns).toContain('phone_verification_provider_ref');
    expect(changeColumns).toContain('proposed_destination');
  });

  it('the delivery adapter is explicitly NOT implemented', () => {
    expect(AGENT_PAYOUT_PHONE_VERIFICATION_ADAPTER_IMPLEMENTED).toBe(false);
  });
});

describe('phone verification boundary — the single writer', () => {
  it('refuses an attestation with no provider reference', async () => {
    const agentId = await seedAgent();
    const changeId = await seedChange(agentId, `+2547${String(20000000 + seq).slice(-8)}`);
    const result = await db.recordAgentPayoutDestinationPhoneVerification({
      id: changeId,
      providerRef: '   ',
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_ATTESTATION');
    // The mock omits never-written nullable columns; `?? null` reads them the
    // way PostgreSQL would (NULL), so this asserts the column was not set.
    expect((await readChange(changeId)).phone_verified_at ?? null).toBeNull();
  });

  it('binds the attestation to ONE request: a second request for the same agent is untouched', async () => {
    const agentId = await seedAgent();
    const firstId = await seedChange(agentId, '+254711111111');
    // A second request cannot normally coexist (one live per agent); the point
    // here is the BINDING — verification of row A must not leak to row B.
    const secondId = await seedChange(agentId, '+254722222222', false);

    const verified = await db.recordAgentPayoutDestinationPhoneVerification({
      id: firstId,
      providerRef: `CALL-REF-${firstId}`,
    });
    expect(verified.ok).toBe(true);
    expect(verified.code).toBe('VERIFIED');
    expect((await readChange(firstId)).phone_verified_at).toBeTruthy();
    expect((await readChange(firstId)).phone_verification_provider_ref).toBe(`CALL-REF-${firstId}`);

    // The OTHER request is still unverified — the attestation was for one number
    // on one request, not for the agent in general.
    expect((await readChange(secondId)).phone_verified_at ?? null).toBeNull();
  });

  it('cannot be re-run to change the reference or the time (single-use per request)', async () => {
    const agentId = await seedAgent();
    const changeId = await seedChange(agentId, '+254733333333');
    const first = await db.recordAgentPayoutDestinationPhoneVerification({
      id: changeId,
      providerRef: `CALL-REF-A-${changeId}`,
    });
    expect(first.ok).toBe(true);

    const second = await db.recordAgentPayoutDestinationPhoneVerification({
      id: changeId,
      providerRef: `CALL-REF-B-${changeId}`,
    });
    expect(second.code).toBe('ALREADY_VERIFIED');
    expect((await readChange(changeId)).phone_verification_provider_ref).toBe(`CALL-REF-A-${changeId}`);
  });

  it('a verified request does not make a DIFFERENT destination activatable', async () => {
    const agentId = await seedAgent();
    const verifiedId = await seedChange(agentId, '+254744444444');
    await db.recordAgentPayoutDestinationPhoneVerification({
      id: verifiedId,
      providerRef: `CALL-REF-${verifiedId}`,
    });

    const otherId = await seedChange(agentId, '+254755555555', false);
    const other = await readChange(otherId);
    const decision = evaluateAgentPayoutActivation(other);
    expect(decision.allowed).toBe(false);
    // The exact blocker the UI reports — the OTHER row has no proof of its own.
    expect(decision.blockers).toContain('phone_verification_required');
  });
});

describe('phone verification boundary — no email path can establish phone ownership', () => {
  // A SOURCE-LEVEL guarantee, because the risk is a FUTURE writer: an email OTP
  // flow that someone wires to `phone_verified_at` "just to unblock activation".
  const SRC = path.resolve(__dirname, '..');

  function allTsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...allTsFiles(full));
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('there is exactly ONE write site for `phone_verified_at`, and it is the data layer', () => {
    const writeSites: string[] = [];
    for (const file of allTsFiles(SRC)) {
      const text = fs.readFileSync(file, 'utf8');
      // The literal write shape: a column assignment with the verification time.
      if (/phone_verified_at:\s*now\b/.test(text)) writeSites.push(path.relative(SRC, file));
    }
    expect(writeSites).toEqual([path.join('db', 'database.ts')]);
  });

  it('no email module even references phone verification', () => {
    const emailFiles = allTsFiles(SRC).filter((f) => /email/i.test(path.basename(f)));
    expect(emailFiles.length).toBeGreaterThan(0);
    for (const file of emailFiles) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text).not.toMatch(/phone_verified_at/);
      expect(text).not.toMatch(/recordAgentPayoutDestinationPhoneVerification/);
    }
  });

  it('the attestation writer accepts no destination, no email and no OTP — only a request id and a provider reference', () => {
    const source = fs.readFileSync(path.join(SRC, 'db', 'database.ts'), 'utf8');
    const start = source.indexOf('public async recordAgentPayoutDestinationPhoneVerification');
    expect(start).toBeGreaterThan(-1);
    const paramsOpen = source.indexOf('params: {', start);
    const paramsClose = source.indexOf('}', paramsOpen);
    const paramsBlock = source.slice(paramsOpen, paramsClose + 1);
    expect(paramsBlock).toContain('id: string');
    expect(paramsBlock).toContain('providerRef: string');
    expect(paramsBlock).not.toMatch(/destination/i);
    expect(paramsBlock).not.toMatch(/email/i);
    expect(paramsBlock).not.toMatch(/otp/i);
  });
});
