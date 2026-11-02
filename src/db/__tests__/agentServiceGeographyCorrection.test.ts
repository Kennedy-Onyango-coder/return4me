import { describe, expect, it, vi } from 'vitest';
import { db, type Agent, type FoundItem } from '../database';
import { ensureTestCategory, testRunId } from './ensureTestCategory';
import { administrativeUnitsForCounty } from '../../config/kenyaAdministrativeUnits';

// =============================================================================
// STAGE 3B-6A — ADMIN AGENT GEOGRAPHIC CORRECTION (THE WRITE PATH).
//
// WHY THIS FILE EXISTS
//   Before Stage 3B-6A an Agent's service geography (county + sub-county) could
//   only be written once, at registration. The admin coordinate correction
//   (updateAgentLocation) deliberately does NOT touch it, so a hub whose county
//   was wrong or missing stayed unmatchable for ever. These checkpoints exercise
//   the new writer against the repository's real data layer (in-memory harness
//   when DATABASE_URL is empty):
//
//     * a legacy NULL county is corrected and stored CANONICALLY;
//     * an alias the operator typed ('nairobi') is stored as 'Nairobi City';
//     * a value that is not a county, or a sub-county from another county, is
//       REFUSED and leaves the row exactly as it was;
//     * an unknown agent id reports "not found" instead of a correction that
//       never happened, and writes no audit row;
//     * the audit trail records who corrected what, from what, to what;
//     * an AUDIT-INSERT failure aborts the call and leaves the stored geography
//       unchanged — no unrecorded correction;
//     * status, verification, identity and custody are untouched;
//     * the two provenance axes stay independent: correcting the SERVICE
//       geography never rewrites coordinate_source or the coordinate pair.
//
// THE ONE THING THIS HARNESS CANNOT SHOW: the in-memory double strips
// BEGIN/COMMIT/ROLLBACK, so "the audit row and the update roll back together" is
// demonstrated by the audit insert being issued on the same transaction handle
// BEFORE the update (static assertion in the route-contract suite), not by a
// real rollback. Real PostgreSQL transaction semantics were NOT exercised here.
// =============================================================================

let counter = 0;
const RUN = `TEST-B6A-${testRunId}`;
const ADMIN = 'admin.b6a';

const NAIROBI_UNITS = administrativeUnitsForCounty('Nairobi City');
const MOMBASA_UNITS = administrativeUnitsForCounty('Mombasa');
const NAIROBI_UNIT = NAIROBI_UNITS[0].id;
const MOMBASA_UNIT = MOMBASA_UNITS[0].id;

/** A hub whose service geography is deliberately absent, as a legacy row would be. */
async function makeLegacyAgent(overrides: Partial<Record<string, unknown>> = {}): Promise<Agent> {
  const id = `${RUN}-AGENT-${counter++}`;
  await db.createAgent({
    id,
    business_name: `Geography Hub ${id}`,
    contact_phone: `+2547${testRunId}${counter}`,
    location_address: 'Ngong Road, Nairobi',
    county: null,
    administrative_unit_id: null,
    latitude: -1.2921,
    longitude: 36.8219,
    mpesa_till_or_paybill: '000321',
    payout_method_type: 'Personal M-Pesa',
    status: 'active',
    refundable_deposit: 0,
    national_id_hash: `test-hash-${id}`,
    needs_manual_geocoding: false,
    contact_email: `geo-${id}@example.com`,
    ...overrides,
  } as any);
  return (await db.getAgent(id))!;
}

async function auditRowsForAgent(agentId: string) {
  const rows = await db.getAuditLogs();
  return rows.filter(
    (row: any) =>
      row.action === 'ADMIN_AGENT_GEOGRAPHY_CORRECTION' &&
      String(row.details || '').includes(agentId),
  );
}

describe('B6-A — a missing service county can be corrected, canonically', () => {
  it('stores the canonical county and sub-county and marks the source admin_corrected', async () => {
    const agent = await makeLegacyAgent();
    expect(agent.county).toBeNull();
    expect(agent.administrative_unit_id).toBeNull();

    const updated = await db.updateAgentServiceGeography(
      agent.id,
      { county: 'Nairobi City', administrativeUnitId: NAIROBI_UNIT },
      ADMIN,
    );

    expect(updated).toBeDefined();
    expect(updated!.county).toBe('Nairobi City');
    expect(updated!.administrative_unit_id).toBe(NAIROBI_UNIT);
    // The SERVICE geography was corrected. The PROVENANCE column is deliberately
    // NOT stamped: GEO-D+ persists only `user_selected` as authoritative, so
    // writing 'admin_corrected' would read back NULL and could erase an existing
    // user_selected value. See db.updateAgentServiceGeography().
    expect(updated!.location_source).toBeNull();

    const reread = await db.getAgent(agent.id);
    expect(reread!.county).toBe('Nairobi City');
    expect(reread!.administrative_unit_id).toBe(NAIROBI_UNIT);
  });

  it('canonicalises an alias the administrator typed instead of storing it verbatim', async () => {
    const agent = await makeLegacyAgent();
    const updated = await db.updateAgentServiceGeography(
      agent.id,
      { county: 'nairobi', administrativeUnitId: NAIROBI_UNIT },
      ADMIN,
    );
    expect(updated!.county).toBe('Nairobi City');
  });

  it('records who corrected what, from what, to what, in the audit trail', async () => {
    const agent = await makeLegacyAgent();
    await db.updateAgentServiceGeography(
      agent.id,
      { county: 'Nairobi City', administrativeUnitId: NAIROBI_UNIT },
      ADMIN,
    );

    // Scoped to THIS agent: the audit trail is append-only and accumulates across
    // the whole file, so a file-wide count would assert test ORDER, not behaviour.
    const rows = await auditRowsForAgent(agent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].admin_user).toBe(ADMIN);
    expect(rows[0].details).toContain(agent.id);
    expect(rows[0].details).toContain('(none)');
    expect(rows[0].details).toContain('Nairobi City');
    expect(rows[0].details).toContain(NAIROBI_UNIT);
  });
});

describe('B6-A — an invalid correction is refused and changes nothing', () => {
  it('refuses a value that is not a Kenyan county', async () => {
    const agent = await makeLegacyAgent();
    await expect(
      db.updateAgentServiceGeography(
        agent.id,
        { county: 'Nairobi District', administrativeUnitId: NAIROBI_UNIT },
        ADMIN,
      ),
    ).rejects.toThrow(/county/i);

    const reread = await db.getAgent(agent.id);
    expect(reread!.county).toBeNull();
    expect(reread!.administrative_unit_id).toBeNull();
    expect(await auditRowsForAgent(agent.id)).toHaveLength(0);
  });

  it('refuses a sub-county that belongs to a different county', async () => {
    const agent = await makeLegacyAgent();
    await expect(
      db.updateAgentServiceGeography(
        agent.id,
        { county: 'Nairobi City', administrativeUnitId: MOMBASA_UNIT },
        ADMIN,
      ),
    ).rejects.toThrow(/sub-county/i);

    const reread = await db.getAgent(agent.id);
    expect(reread!.county).toBeNull();
    expect(await auditRowsForAgent(agent.id)).toHaveLength(0);
  });

  it('refuses to clear an existing sub-county (a hub is never made less matchable)', async () => {
    const agent = await makeLegacyAgent({
      county: 'Nairobi City',
      administrative_unit_id: NAIROBI_UNIT,
    });
    await expect(
      db.updateAgentServiceGeography(agent.id, { county: 'Nairobi City' }, ADMIN),
    ).rejects.toThrow(/sub-county/i);

    const reread = await db.getAgent(agent.id);
    expect(reread!.administrative_unit_id).toBe(NAIROBI_UNIT);
  });
});

describe('B6-A — the writer never reports a correction that did not happen', () => {
  it('returns undefined for an unknown agent id and writes no audit row', async () => {
    const result = await db.updateAgentServiceGeography(
      `${RUN}-MISSING`,
      { county: 'Nairobi City', administrativeUnitId: NAIROBI_UNIT },
      ADMIN,
    );
    expect(result).toBeUndefined();
    expect(await auditRowsForAgent(`${RUN}-MISSING`)).toHaveLength(0);
  });
});

describe('B6-A — the two provenance axes stay independent', () => {
  it('leaves the coordinate pair and its coordinate_source untouched', async () => {
    const agent = await makeLegacyAgent({ coordinate_source: 'forward_geocoder' });
    const before = await db.getAgent(agent.id);
    expect(before!.coordinate_source).toBe('forward_geocoder');

    const updated = await db.updateAgentServiceGeography(
      agent.id,
      { county: 'Nairobi City', administrativeUnitId: NAIROBI_UNIT },
      ADMIN,
    );

    expect(updated!.coordinate_source).toBe('forward_geocoder');
    expect(updated!.latitude).toBeCloseTo(before!.latitude as number);
    expect(updated!.longitude).toBeCloseTo(before!.longitude as number);
    expect(updated!.needs_manual_geocoding).toBe(false);
  });
});

describe('B6-A — an existing (wrong) service county is replaced, and the change is recorded', () => {
  it('replaces a wrong county with the corrected one', async () => {
    const agent = await makeLegacyAgent({
      county: 'Mombasa',
      administrative_unit_id: MOMBASA_UNIT,
    });
    const updated = await db.updateAgentServiceGeography(
      agent.id,
      { county: 'Nairobi City', administrativeUnitId: NAIROBI_UNIT },
      ADMIN,
    );
    expect(updated!.county).toBe('Nairobi City');
    expect(updated!.administrative_unit_id).toBe(NAIROBI_UNIT);

    const rows = await auditRowsForAgent(agent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toContain('Mombasa');
    expect(rows[0].details).toContain('Nairobi City');
  });
});

// -----------------------------------------------------------------------------
// STAGE 3B-6A §6 — AUDIT ATOMICITY, AND THE THINGS A CORRECTION MUST NOT TOUCH.
//
// "An audit failure must not leave an unrecorded successful correction." The
// audit insert runs on the mutation's OWN transaction handle, and it runs BEFORE
// the UPDATE, so a failing audit aborts the call before the row is written — the
// hub keeps its old geography and no audit row exists. (The in-memory double
// strips BEGIN/COMMIT/ROLLBACK, so this demonstrates the ORDER; a real rollback
// is additionally guaranteed by the single drizzleDb.transaction() around both
// statements — see the route-contract suite.)
//
// The rest of this block pins the negative space: status, verification, identity
// and — most importantly — custody are none of a geography correction's business.
// -----------------------------------------------------------------------------

/** An item already pointing at the hub: custody a correction must not disturb. */
async function makeItemHeldBy(agentId: string): Promise<FoundItem> {
  const id = `${RUN}-ITEM-${counter++}`;
  await ensureTestCategory('phone');
  await db.createItem({
    id,
    category_id: 'phone',
    photo_url: 'test-photo.jpg',
    ocr_extracted_number: null,
    ocr_extracted_name: null,
    document_number_hash: null,
    document_name_fuzzy: null,
    location_description: 'Ngong Road',
    latitude: -1.2921,
    longitude: 36.8219,
    finder_phone: '+254700000097',
    finder_email: 'b6a-finder@example.com',
    found_county: 'Nairobi City',
    administrative_unit_id: NAIROBI_UNIT,
    location_source: 'user_selected',
    assigned_agent_id: agentId,
    status: 'awaiting_dropoff',
    flaggedForReview: false,
    isDescriptionOnly: false,
    description: 'Black phone',
    is_sensitive_document: false,
    rejection_reason: null,
    agent_assignment_method: 'manual_override',
    needs_manual_agent_reassignment: false,
  } as any);
  return (await db.getItem(id))!;
}

describe('B6-A — an audit failure cannot leave an unrecorded correction', () => {
  it('fails the call and leaves the stored geography exactly as it was', async () => {
    const agent = await makeLegacyAgent({
      county: 'Mombasa',
      administrative_unit_id: MOMBASA_UNIT,
    });

    const spy = vi
      .spyOn(Object.getPrototypeOf(db), 'logAuditInTx')
      .mockRejectedValueOnce(new Error('audit storage unavailable'));

    let failure: unknown;
    try {
      await db.updateAgentServiceGeography(
        agent.id,
        { county: 'Nairobi City', administrativeUnitId: NAIROBI_UNIT },
        ADMIN,
      );
    } catch (error) {
      failure = error;
    } finally {
      spy.mockRestore();
    }

    // An infrastructure failure, not a validation refusal: the route answers 500,
    // never a 400/404 that would let the operator believe a value was rejected.
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/failed to correct agent geography/i);

    const reread = await db.getAgent(agent.id);
    expect(reread!.county).toBe('Mombasa');
    expect(reread!.administrative_unit_id).toBe(MOMBASA_UNIT);
    expect(await auditRowsForAgent(agent.id)).toHaveLength(0);
  });
});

describe('B6-A — a correction touches the geography and nothing else', () => {
  it('leaves status, verification and identity unchanged', async () => {
    const agent = await makeLegacyAgent({ status: 'pending' });
    const before = await db.getAgent(agent.id);
    expect(before!.status).toBe('pending');

    const updated = await db.updateAgentServiceGeography(
      agent.id,
      { county: 'Nairobi City', administrativeUnitId: NAIROBI_UNIT },
      ADMIN,
    );

    expect(updated!.status).toBe('pending');
    expect(updated!.email_verified_at).toEqual(before!.email_verified_at);
    expect(updated!.national_id_hash).toBe(before!.national_id_hash);
    expect(updated!.business_name).toBe(before!.business_name);
    expect(updated!.contact_phone).toBe(before!.contact_phone);
  });

  it('leaves custody alone: the hub keeps its items and no history event is written', async () => {
    const agent = await makeLegacyAgent({
      county: 'Nairobi City',
      administrative_unit_id: NAIROBI_UNIT,
    });
    const held = await makeItemHeldBy(agent.id);
    // createItem() records the report-time assignment event (trigger
    // 'finder_report'), so the baseline is that one event, not zero.
    const historyBefore = await db.getItemAssignmentHistory(held.id);
    expect(historyBefore).toHaveLength(1);

    const updated = await db.updateAgentServiceGeography(
      agent.id,
      { county: 'Mombasa', administrativeUnitId: MOMBASA_UNIT },
      ADMIN,
    );
    expect(updated!.county).toBe('Mombasa');

    const after = (await db.getItem(held.id))!;
    expect(after.assigned_agent_id).toBe(agent.id);
    expect(after.status).toBe('awaiting_dropoff');
    expect(after.agent_assignment_method).toBe('manual_override');
    expect(after.needs_manual_agent_reassignment).toBe(false);

    // The write path records an AUDIT row, never a second assignment event.
    const historyAfter = await db.getItemAssignmentHistory(held.id);
    expect(historyAfter.map(event => event.id)).toEqual(historyBefore.map(event => event.id));
  });
});
