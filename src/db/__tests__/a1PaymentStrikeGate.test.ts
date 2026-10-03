import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  PAYMENT_STRIKE_ACTIVE_WINDOW_MS,
  PAYMENT_STRIKE_RESTRICTION_THRESHOLD,
  paymentStrikeExpiresAt,
  toE164Kenyan,
} from '../../config/paymentStrikePolicy';
import { db } from '../../db/database.ts';
// The Drizzle handle is exported as `db` from src/db/index.ts - a DIFFERENT
// binding from the data-access class above. Aliased so both stay readable.
import { db as drizzleDb } from '../../db/index.ts';
import {
  claim_payment_strikes as strikesTable,
  claim_payment_strike_records as recordsTable,
} from '../../db/schema.ts';

// A1 - PAYMENT-STRIKE GATE: legacy aggregate component + individual records.
//
// Real database rows, not mocks. The property under test IS a query: which rows
// the active count selects. A stub would verify the arithmetic but not the
// filtering, which is exactly where the legacy-transition and double-counting
// bugs live.
//
// TIME HANDLING, which is subtle here and worth stating:
//   - seedStrike()/seedLegacy() take an explicit createdAt, so tests that need a
//     strike in the past seed one directly and assert with an injected `now`.
//   - recordPaymentStrike() stamps createdAt from the WALL CLOCK, so any test
//     calling it must assert at a wall-clock `now`. Mixing an injected past
//     `now` with a wall-clock strike would place the strike outside its own
//     window and mis-report it as expired.

const DAY = 24 * 60 * 60 * 1000;
const PHONE = '+254700000001';
const restricted = (n: number) => n >= PAYMENT_STRIKE_RESTRICTION_THRESHOLD;

let seq = 0;
const nextId = () => `PSR-T-${String(++seq).padStart(6, '0')}`;

async function seedLegacy(
  phone: string,
  strikeCount: number,
  lastStrikeAt: Date | null,
  opts: {
    cleared?: boolean;
    legacyCount?: number | null;
    legacyAt?: Date | null;
    legacyClearedAt?: Date | null;
  } = {},
) {
  await drizzleDb.insert(strikesTable).values({
    phone_number: phone,
    strike_count: strikeCount,
    last_strike_at: lastStrikeAt,
    is_cleared_by_admin: opts.cleared ?? false,
    legacy_strike_count: opts.legacyCount ?? null,
    legacy_last_strike_at: opts.legacyAt ?? null,
    legacy_cleared_at: opts.legacyClearedAt ?? null,
  });
}

async function seedStrike(opts: {
  phone?: string;
  createdAt: Date;
  expiresAt?: Date | null;
  cleared?: boolean;
  clearedAt?: Date | null;
  clearedBy?: string | null;
}) {
  await drizzleDb.insert(recordsTable).values({
    id: nextId(),
    phone_number: opts.phone ?? PHONE,
    created_at: opts.createdAt,
    expires_at: opts.expiresAt === undefined ? paymentStrikeExpiresAt(opts.createdAt) : opts.expiresAt,
    is_cleared_by_admin: opts.cleared ?? false,
    cleared_at: opts.clearedAt ?? null,
    cleared_by_admin: opts.clearedBy ?? null,
    source_claim_id: null,
  });
}

const recordsFor = (phone: string) =>
  drizzleDb.select().from(recordsTable).where(eq(recordsTable.phone_number, phone));

const aggregateFor = async (phone: string) => {
  const rows = await drizzleDb.select().from(strikesTable).where(eq(strikesTable.phone_number, phone));
  return rows[0] ?? null;
};

/** Count at an explicit instant. */
const activeAt = (phone: string, now: Date) => db.getActivePaymentStrikeCount(phone, now);

/** Count at the wall clock - for rows created via recordPaymentStrike(). */
const activeNow = (phone: string) => db.getActivePaymentStrikeCount(phone);

beforeEach(async () => {
  await drizzleDb.delete(recordsTable);
  await drizzleDb.delete(strikesTable);
  seq = 0;
});

afterEach(async () => {
  await drizzleDb.delete(recordsTable);
  await drizzleDb.delete(strikesTable);
});

// ---------------------------------------------------------------------------
// INDIVIDUAL RECORDS (post-migration)
// ---------------------------------------------------------------------------
describe('A1 individual payment strike records', () => {
  const now = new Date();

  it('1. a strike is stored as its own row', async () => {
    await db.recordPaymentStrike(PHONE, 'CLM-1');
    expect(await recordsFor(PHONE)).toHaveLength(1);
  });

  it('2. two strikes produce two rows, not one aggregated row', async () => {
    await db.recordPaymentStrike(PHONE, 'CLM-1');
    await db.recordPaymentStrike(PHONE, 'CLM-2');
    expect(await recordsFor(PHONE)).toHaveLength(2);
  });

  it('3. recordPaymentStrike creates exactly ONE individual record', async () => {
    await db.recordPaymentStrike(PHONE, 'CLM-1');
    const rows = await recordsFor(PHONE);
    expect(rows).toHaveLength(1);
    expect(rows[0].source_claim_id).toBe('CLM-1');
  });

  it('4. a fresh strike is active before expiry', async () => {
    await db.recordPaymentStrike(PHONE, 'CLM-1');
    expect(await activeNow(PHONE)).toBe(1);
  });

  it('5. an unexpired strike is active at an injected now', async () => {
    await seedStrike({ createdAt: now });
    expect(await activeAt(PHONE, now)).toBe(1);
  });

  it('6. an EXPIRED strike does not count', async () => {
    await seedStrike({ createdAt: new Date(now.getTime() - 6 * DAY) });
    expect(await activeAt(PHONE, now)).toBe(0);
  });

  it('7. a strike exactly at the 5-day boundary is no longer active', async () => {
    // The window is exclusive: active means expires_at > now.
    await seedStrike({ createdAt: new Date(now.getTime() - PAYMENT_STRIKE_ACTIVE_WINDOW_MS) });
    expect(await activeAt(PHONE, now)).toBe(0);
  });

  it('8. an EXPIRED strike remains stored', async () => {
    await seedStrike({ createdAt: new Date(now.getTime() - 6 * DAY) });
    expect(await recordsFor(PHONE)).toHaveLength(1);
  });

  it('9. an admin-cleared strike is excluded from the count', async () => {
    await seedStrike({ createdAt: now, cleared: true, clearedAt: now, clearedBy: 'admin-x' });
    expect(await activeAt(PHONE, now)).toBe(0);
  });

  it('10. an admin-cleared strike remains stored, with attribution', async () => {
    await seedStrike({ createdAt: now, cleared: true, clearedAt: now, clearedBy: 'admin-x' });
    const rows = await recordsFor(PHONE);
    expect(rows).toHaveLength(1);
    expect(rows[0].cleared_by_admin).toBe('admin-x');
    expect(rows[0].cleared_at).not.toBeNull();
  });

  it('11. expires_at is exactly 5 days after created_at', async () => {
    await db.recordPaymentStrike(PHONE, 'CLM-1');
    const r = (await recordsFor(PHONE))[0];
    const delta = new Date(r.expires_at!).getTime() - new Date(r.created_at).getTime();
    expect(delta).toBe(PAYMENT_STRIKE_ACTIVE_WINDOW_MS);
  });

  it('12. each strike expires on ITS OWN anchor, not a phone-wide watermark', async () => {
    // A single shared watermark would either keep the old strike alive or expire
    // the new one; per-strike anchors must keep the new one active on its own.
    await seedStrike({ createdAt: new Date(now.getTime() - 4 * DAY) });
    await seedStrike({ createdAt: now });
    expect(await activeAt(PHONE, now)).toBe(2);
  });

  it('13. a brand-new phone starts with a ZERO legacy baseline', async () => {
    // No pre-migration history must not acquire invented legacy strikes: its
    // baseline is a genuine zero, not null.
    await db.recordPaymentStrike(PHONE, 'CLM-1');
    const agg = await aggregateFor(PHONE);
    expect(agg!.legacy_strike_count).toBe(0);
    expect(await activeNow(PHONE)).toBe(1); // only the individual strike counts
  });
});

// ---------------------------------------------------------------------------
// THE LEGACY COMPONENT
// ---------------------------------------------------------------------------
describe('A1 legacy component: one aggregate, not N reconstructed strikes', () => {
  const now = new Date();

  it('14. an untouched legacy row is still authoritative', async () => {
    // NULL baseline = never touched post-migration, so strike_count IS the legacy
    // snapshot. This is what makes the additive change migration-safe.
    await seedLegacy(PHONE, 3, now);
    expect(await activeAt(PHONE, now)).toBe(3);
  });

  it('15. an untouched legacy row respects its OWN 5-day window', async () => {
    await seedLegacy(PHONE, 3, new Date(now.getTime() - 6 * DAY));
    expect(await activeAt(PHONE, now)).toBe(0);
  });

  it('16. a legacy row inside its window counts', async () => {
    await seedLegacy(PHONE, 3, new Date(now.getTime() - 4 * DAY));
    expect(await activeAt(PHONE, now)).toBe(3);
  });

  it('17. a zero-count legacy row contributes nothing', async () => {
    await seedLegacy(PHONE, 0, now);
    expect(await activeAt(PHONE, now)).toBe(0);
  });

  it('18. an admin-cleared legacy row contributes nothing', async () => {
    await seedLegacy(PHONE, 3, now, { cleared: true });
    expect(await activeAt(PHONE, now)).toBe(0);
  });

  it('19. a legacy row with a NULL last_strike_at contributes nothing', async () => {
    // No anchor means no window; it must not be treated as permanently active.
    await seedLegacy(PHONE, 3, null);
    expect(await activeAt(PHONE, now)).toBe(0);
  });

  it('19b. a frozen baseline of 3 counts even when strike_count has moved on', async () => {
    // The live counter reads 9, but only 3 of those are legacy. The frozen
    // snapshot is what keeps this honest.
    await seedLegacy(PHONE, 9, now, { legacyCount: 3, legacyAt: now });
    expect(await activeAt(PHONE, now)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// MIXED: legacy component + individual records
// ---------------------------------------------------------------------------
describe('A1 mixed legacy and individual strikes', () => {
  const now = new Date();

  const freshLegacy = () => seedLegacy(PHONE, 3, now);
  const staleLegacy = () => seedLegacy(PHONE, 3, new Date(now.getTime() - 6 * DAY));

  async function addNew(count: number) {
    for (let i = 0; i < count; i++) await db.recordPaymentStrike(PHONE, `CLM-${i}`);
  }

  it('20. legacy 3 + 1 new = 4 (the legacy component MUST NOT vanish)', async () => {
    // The regression the earlier XOR implementation failed: adding one new strike
    // used to drop the count from 3 to 1 and un-restrict the user.
    await freshLegacy();
    await addNew(1);
    const n = await activeAt(PHONE, now);
    expect(n).toBe(4);
    expect(restricted(n)).toBe(true);
  });

  it('21. legacy 3 + 2 new = 5', async () => {
    await freshLegacy();
    await addNew(2);
    expect(await activeAt(PHONE, now)).toBe(5);
  });

  it('22. legacy 3 + 3 new = 6', async () => {
    await freshLegacy();
    await addNew(3);
    expect(await activeAt(PHONE, now)).toBe(6);
  });

  it('23. legacy EXPIRED + 2 new active = 2', async () => {
    await staleLegacy();
    await addNew(2);
    const n = await activeAt(PHONE, now);
    expect(n).toBe(2);
    expect(restricted(n)).toBe(false);
  });

  it('24. legacy EXPIRED + 3 new active = 3 -> restricted', async () => {
    await staleLegacy();
    await addNew(3);
    const n = await activeAt(PHONE, now);
    expect(n).toBe(3);
    expect(restricted(n)).toBe(true);
  });

  it('25. legacy 3 + a new strike that later expires returns to 3', async () => {
    await freshLegacy();
    await seedStrike({ createdAt: new Date(now.getTime() - 6 * DAY) }); // expired
    const n = await activeAt(PHONE, now);
    expect(n).toBe(3);
    expect(restricted(n)).toBe(true);
  });

  it('26. legacy 3 + an admin-cleared new strike returns to 3', async () => {
    await freshLegacy();
    await seedStrike({ createdAt: now, cleared: true, clearedAt: now, clearedBy: 'a' });
    const n = await activeAt(PHONE, now);
    expect(n).toBe(3);
    expect(restricted(n)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// NO DOUBLE COUNTING
// ---------------------------------------------------------------------------
describe('A1 the additive count never double-counts', () => {
  const now = new Date();

  it('27. a post-migration strike is counted ONCE, not via aggregate AND record', async () => {
    await db.recordPaymentStrike(PHONE, 'CLM-1');
    const agg = await aggregateFor(PHONE);
    expect(agg!.strike_count).toBe(1); // the aggregate DID increment
    expect(await activeNow(PHONE)).toBe(1); // ...but the gate counts it once
  });

  it('28. three post-migration strikes on a fresh phone count as 3, not 6', async () => {
    for (let i = 0; i < 3; i++) await db.recordPaymentStrike(PHONE, `CLM-${i}`);
    expect((await aggregateFor(PHONE))!.strike_count).toBe(3);
    expect(await activeNow(PHONE)).toBe(3);
  });

  it('29. the aggregate keeps growing for reporting without skewing the count', async () => {
    await seedLegacy(PHONE, 3, now);
    await db.recordPaymentStrike(PHONE, 'CLM-1'); // aggregate -> 4
    expect((await aggregateFor(PHONE))!.strike_count).toBe(4); // reporting continuity
    expect(await activeNow(PHONE)).toBe(4); // 3 legacy + 1 new, not 5
  });

  it('30. the frozen baseline captures the PRE-increment count, once', async () => {
    await seedLegacy(PHONE, 3, now);
    await db.recordPaymentStrike(PHONE, 'CLM-1');
    const agg = (await aggregateFor(PHONE))!;
    expect(agg.legacy_strike_count).toBe(3); // captured BEFORE the increment
    expect(agg.legacy_last_strike_at).toEqual(now);
    expect(await activeNow(PHONE)).toBe(4);
  });

  it('31. the baseline is write-ONCE: later strikes do not change it', async () => {
    await seedLegacy(PHONE, 3, now);
    await db.recordPaymentStrike(PHONE, 'CLM-1');
    await db.recordPaymentStrike(PHONE, 'CLM-2');
    const agg = (await aggregateFor(PHONE))!;
    expect(agg.legacy_strike_count).toBe(3); // still 3, not 5
    expect(agg.strike_count).toBe(5); // the raw counter reports every event
    expect(await activeNow(PHONE)).toBe(5); // 3 legacy + 2 new
  });

  it('32. the legacy window uses the FROZEN anchor, not last_strike_at', async () => {
    await seedLegacy(PHONE, 3, new Date(now.getTime() - 4 * DAY));
    await db.recordPaymentStrike(PHONE, 'CLM-1');
    const agg = (await aggregateFor(PHONE))!;
    expect(agg.last_strike_at!.getTime()).toBeGreaterThan(now.getTime() - 60_000); // moved
    expect(agg.legacy_last_strike_at!.getTime()).toBe(now.getTime() - 4 * DAY); // frozen
    expect(await activeNow(PHONE)).toBe(4);
  });

  it('33. the legacy component expires on its own anchor even after new strikes', async () => {
    await seedLegacy(PHONE, 3, new Date(now.getTime() - 4 * DAY));
    await db.recordPaymentStrike(PHONE, 'CLM-1');
    const later = new Date(now.getTime() + 2 * DAY); // the legacy window has closed
    expect(await activeAt(PHONE, later)).toBe(1); // only the new strike remains
  });
});

// ---------------------------------------------------------------------------
// THRESHOLD SEMANTICS
// ---------------------------------------------------------------------------
describe('A1 the >=3 restriction threshold', () => {
  const now = new Date();

  it('34. two active strikes do NOT restrict', async () => {
    await seedStrike({ createdAt: now });
    await seedStrike({ createdAt: now });
    expect(restricted(await activeAt(PHONE, now))).toBe(false);
  });

  it('35. exactly three active strikes DO restrict', async () => {
    for (let i = 0; i < 3; i++) await seedStrike({ createdAt: now });
    expect(restricted(await activeAt(PHONE, now))).toBe(true);
  });

  it('36. the threshold is exactly PAYMENT_STRIKE_RESTRICTION_THRESHOLD', async () => {
    expect(PAYMENT_STRIKE_RESTRICTION_THRESHOLD).toBe(3);
  });

  it('37. expired and cleared strikes do not push a phone over the threshold', async () => {
    await seedStrike({ createdAt: now });
    await seedStrike({ createdAt: now });
    await seedStrike({ createdAt: new Date(now.getTime() - 6 * DAY) }); // expired
    await seedStrike({ createdAt: now, cleared: true, clearedAt: now, clearedBy: 'a' });
    expect(restricted(await activeAt(PHONE, now))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ADMIN CLEARING
// ---------------------------------------------------------------------------
describe('A1 clearPaymentStrikes', () => {
  const now = new Date();

  it('38. clearing suppresses every active strike', async () => {
    for (let i = 0; i < 3; i++) await seedStrike({ createdAt: now });
    await db.clearPaymentStrikes(PHONE, 'admin-z');
    expect(await activeNow(PHONE)).toBe(0);
  });

  it('39. clearPaymentStrikes retains every individual row and attributes the clear', async () => {
    await db.recordPaymentStrike(PHONE, 'CLM-1');
    await db.clearPaymentStrikes(PHONE, 'admin-z');
    const rows = await recordsFor(PHONE);
    expect(rows).toHaveLength(1);
    expect(rows[0].is_cleared_by_admin).toBe(true);
    expect(rows[0].cleared_by_admin).toBe('admin-z');
    expect(rows[0].cleared_at).not.toBeNull();
  });

  it('40. clearing preserves the legacy aggregate row with existing semantics', async () => {
    await seedLegacy(PHONE, 3, now);
    await db.clearPaymentStrikes(PHONE, 'admin-z');
    const agg = (await aggregateFor(PHONE))!;
    expect(agg.strike_count).toBe(0);
    expect(agg.is_cleared_by_admin).toBe(true);
  });

  it('41. clearing never deletes strike history', async () => {
    await seedLegacy(PHONE, 3, now);
    await db.recordPaymentStrike(PHONE, 'CLM-1');
    await db.clearPaymentStrikes(PHONE, 'admin-z');
    expect(await recordsFor(PHONE)).toHaveLength(1);
  });

  // THE REGRESSION THE DURABLE MARKER EXISTS FOR. recordPaymentStrike() resets
  // is_cleared_by_admin to false, which reactivated the frozen legacy baseline and
  // silently undid the administrator's decision.
  it('42. a later strike must NOT reactivate an admin-cleared legacy baseline', async () => {
    await seedLegacy(PHONE, 3, now, { legacyCount: 3, legacyAt: now });
    await db.clearPaymentStrikes(PHONE, 'admin-z');
    await db.recordPaymentStrike(PHONE, 'CLM-1'); // the customer's next strike

    const n = await activeNow(PHONE);
    expect(n).toBe(1); // ONLY the new individual strike is active
    expect(restricted(n)).toBe(false); // so the phone is not re-restricted

    const agg = (await aggregateFor(PHONE))!;
    expect(agg.legacy_cleared_at).not.toBeNull(); // the clear is durable
  });

  it('43. the durable clear survives many later strikes', async () => {
    await seedLegacy(PHONE, 3, now, { legacyCount: 3, legacyAt: now });
    await db.clearPaymentStrikes(PHONE, 'admin-z');
    await db.recordPaymentStrike(PHONE, 'CLM-1');
    await db.recordPaymentStrike(PHONE, 'CLM-2');
    expect(await activeNow(PHONE)).toBe(2); // never 3 legacy + anything
  });
});

// ---------------------------------------------------------------------------
// CONCURRENCY
// ---------------------------------------------------------------------------
describe('A1 concurrent strikes on one phone', () => {
  it('44. concurrent strikes for DIFFERENT claims all survive', async () => {
    // Two claims on one phone expiring at once. Each strike must produce its own
    // individual record; if any were lost the user would be under-counted and
    // wrongly allowed to keep creating claims.
    await Promise.all([
      db.recordPaymentStrike(PHONE, 'CLM-1'),
      db.recordPaymentStrike(PHONE, 'CLM-2'),
      db.recordPaymentStrike(PHONE, 'CLM-3'),
    ]);
    expect(await recordsFor(PHONE)).toHaveLength(3);
    expect(restricted(await activeNow(PHONE))).toBe(true);
  });

  // SCOPE NOTE, read this before trusting this test. What it asserts is the
  // customer-safety property: no strike EVENT is lost under concurrency. It
  // deliberately does NOT assert the aggregate counter's exact value here,
  // because that cannot be verified in the in-memory test sandbox.
  //
  // The sandbox does not enforce the claim_payment_strikes primary key, so four
  // concurrent "row does not exist yet" branches each insert successfully instead
  // of three conflicting and retrying. The result is four aggregate rows of 1
  // rather than one row of 4. On real PostgreSQL the primary key holds, the
  // conflicting inserts are rejected, and the retry loop converges on a single
  // row. Asserting "4" here would therefore be asserting sandbox behaviour that
  // is wrong, and asserting nothing would leave the real race unguarded.
  //
  // The exact counter is covered sequentially by test 28 (three strikes on a
  // fresh phone count as 3), and the retry loop itself is exercised by test 46,
  // where the legacy row already exists so every caller takes the CAS branch.
  it('45. no strike event is lost to the reporting layer under concurrency', async () => {
    await Promise.all([
      db.recordPaymentStrike(PHONE, 'CLM-1'),
      db.recordPaymentStrike(PHONE, 'CLM-2'),
      db.recordPaymentStrike(PHONE, 'CLM-3'),
      db.recordPaymentStrike(PHONE, 'CLM-4'),
    ]);
    // Every strike left its own durable individual record.
    expect(await recordsFor(PHONE)).toHaveLength(4);
    // And every strike's source claim is accounted for, so a lost event would
    // show up as a missing attribution rather than a missing row.
    const claims = (await recordsFor(PHONE)).map((r) => r.source_claim_id).sort();
    expect(claims).toEqual(['CLM-1', 'CLM-2', 'CLM-3', 'CLM-4']);
  });

  it('46. the legacy baseline is frozen to ONE value under concurrency', async () => {
    // The write-once snapshot must not be captured from two different
    // pre-increment states, which would freeze a count that never existed.
    await seedLegacy(PHONE, 3, new Date(new Date().getTime() - 4 * DAY));
    await Promise.all([
      db.recordPaymentStrike(PHONE, 'CLM-1'),
      db.recordPaymentStrike(PHONE, 'CLM-2'),
      db.recordPaymentStrike(PHONE, 'CLM-3'),
    ]);
    const agg = (await aggregateFor(PHONE))!;
    expect(agg.legacy_strike_count).toBe(3); // never 4, 5, or 6
    expect(await activeNow(PHONE)).toBe(6); // 3 legacy + 3 new
  });
});

// ---------------------------------------------------------------------------
// PHONE IDENTITY
// ---------------------------------------------------------------------------
describe('A1 phone identity uses the canonical normalization', () => {
  const LOCAL = '0712345678';
  const now = new Date();

  it('47. equivalent representations resolve to ONE strike identity', async () => {
    const canonical = toE164Kenyan(LOCAL);
    await db.recordPaymentStrike(LOCAL, 'CLM-1');
    await db.recordPaymentStrike(canonical, 'CLM-2');
    const rows = await recordsFor(canonical);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.phone_number).toBe(canonical);
  });

  it('48. a legacy row keyed canonically is found via a local-format number', async () => {
    const canonical = toE164Kenyan(LOCAL);
    await seedLegacy(canonical, 3, now);
    expect(await activeAt(LOCAL, now)).toBe(3);
  });

  it('49. clear via a local-format number clears the canonical row', async () => {
    const canonical = toE164Kenyan(LOCAL);
    await seedLegacy(canonical, 3, now);
    await db.clearPaymentStrikes(LOCAL, 'admin-z');
    expect((await aggregateFor(canonical))!.is_cleared_by_admin).toBe(true);
    expect(await activeAt(canonical, now)).toBe(0);
  });
});