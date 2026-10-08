import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { db } from '../db/database';
import { testRunId } from '../db/__tests__/ensureTestCategory';
import { administrativeUnitsForCounty } from '../config/kenyaAdministrativeUnits';
import { resolveCountyName } from '../config/kenyaCounties';
import { registerFinderReportRoutes } from '../routes/finderReport';
import { registerClaimPaymentRoutes } from '../routes/claimPayments';
import {
  PRICING_MODE_FLAT_ADMIN_OVERRIDE,
  PRICING_MODE_RECOVERY_FEE_ENGINE,
  resolveCategoryPricingMode,
  resolveItemLockedPricing,
  type FeeEngineCategoryInput,
} from '../services/feeEngine';

// =============================================================================
// ISSUE A — ADMIN CATEGORY PRICE CHANGE MUST CONTROL THE PRICE OF NEW ITEMS
// =============================================================================
// THE PRODUCTION OBSERVATION
//   An administrator changed a USB cable category price from KES 200 to KES 100
//   in the Admin Dashboard. The save succeeded and the live admin list showed the
//   new price. A NEW USB cable was then reported, a claim was created, and the
//   claimant's M-Pesa payment was for KES 200.
//
// WHY IT HAPPENED
//   The category was in the RECOVERY FEE ENGINE mode (is_admin_modified === false).
//   In that mode the four flat fields (total_fee / finder_share / agent_share /
//   platform_share) are stored but are NOT what prices anything: the Finder report
//   route prices each new item with computeRecoveryFee(base + complexity + delay).
//   The administrator had edited the one field that mode ignores — and because the
//   console presented that flat Total Fee as if it were authoritative, nothing
//   said so.
//
// WHAT THESE TESTS PIN
//   The two modes are explicit, testable and non-overlapping; the mode is stated
//   to the administrator; the server refuses an ambiguous request; and a change to
//   an already-locked fee is impossible.
//
// These are REAL HTTP tests: the Finder report route and the claim payment-session
// route are mounted as the real handlers around the real middleware, so the item's
// locked values and the payment session amount are produced by the production code
// path — not by the test re-implementing it.
// =============================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
const SERVER_RAW = read('src/server.ts');
const ADMIN_VIEW = read('src/components/AdminView.tsx');
const FINDER_REPORT = read('src/routes/finderReport.ts');

const RUN = testRunId;
const COUNTY = resolveCountyName('Nairobi') ?? 'Nairobi City';
const ADMIN_UNIT = administrativeUnitsForCounty(COUNTY)[0]?.id ?? '';
// A real PNG header + minimal payload: passes isValidImageSignature() because the
// magic bytes are genuinely present (image validation is not weakened for tests).
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let server: any;
let base = '';
let phoneCounter = 0;
const nextFinderPhone = () => `+2547${String(710000000 + RUN.length * 1000 + (phoneCounter += 1)).slice(-8)}`;

const http = async (pathname: string, body: any) => {
  const res = await fetch(base + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text: text.slice(0, 400) };
};

const passThrough = (_req: any, _res: any, next: any) => next();

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const sendServerError = (res: any, error: any, _context: string) =>
    res.status(500).json({ error: error?.message || String(error) });

  registerFinderReportRoutes(app, {
    sendServerError,
    pauseSettingKey: (scope: string) => `pause_${scope}`,
    isPlatformOperationPaused: async () => false,
    PAUSED_MESSAGES: { reports: 'Reports are paused.' },
    // The SAME limiter objects server.ts shares. Pass-through here because a rate
    // limiter is not this suite's subject, and one shared bucket across tests
    // would make the assertions order-dependent.
    reportLimiter: passThrough,
    ocrAnalyzeLimiter: passThrough,
  });

  registerClaimPaymentRoutes(app, {
    sendServerError,
    // Injected exactly as server.ts injects them (both are inline in server.ts and
    // cannot be imported). This suite's subject is the FEE, so claimability is
    // allowed and expiry is a no-op — neither can manufacture the amount.
    canCreateClaim: async () => ({ allowed: true }),
    claimabilityErrorMessage: (reason: string) => `not claimable: ${reason}`,
    checkClaimExpiry: async (claim: any) => claim,
    isPlatformOperationPaused: async () => false,
    pauseSettingKey: (scope: string) => `pause_${scope}`,
    PAUSED_MESSAGES: { payments: 'Payments are paused.' },
    claimGuessLimiter: passThrough,
    paymentSessionStatusLimiter: passThrough,
    claimStatusPollLimiter: passThrough,
    processClaimPaymentConfirmed: async () => null,
  });

  server = await new Promise<any>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// Fixtures. The engine configuration is held CONSTANT across the mode tests, so a
// MODE 2 category prices at exactly KES 200 (200 + 0 + 0) whatever the flat fields
// say — which is what makes "flat 100 vs locked 200" a genuine discrimination
// rather than an accident of column defaults.
// ---------------------------------------------------------------------------
const engineConfig = (): FeeEngineCategoryInput => ({
  base_fee: 200,
  complexity_fee: 0,
  delay_fee: 0,
  ceiling_percent: 12,
  finder_pct: 25,
  agent_pct: 35,
  platform_pct: 40,
  finder_reward_cap: null,
});

async function createCategory(
  id: string, total: number, finder: number, agent: number, platform: number, isAdminModified: boolean,
) {
  await db.createCategory({
    id,
    name_en: `Pricing Authority ${id}`,
    name_sw: `Mamlaka ya Bei ${id}`,
    total_fee: total,
    finder_share: finder,
    agent_share: agent,
    platform_share: platform,
    is_sensitive_document: false,
    is_admin_modified: isAdminModified,
    ...engineConfig(),
  });
}

/** The same persistence call the admin PUT route makes, carrying the same mode flag. */
async function updateCategory(
  id: string, total: number, finder: number, agent: number, platform: number, isAdminModified: boolean,
) {
  await db.updateCategory(id, {
    name_en: `Pricing Authority ${id}`,
    name_sw: `Mamlaka ya Bei ${id}`,
    total_fee: total,
    finder_share: finder,
    agent_share: agent,
    platform_share: platform,
    is_sensitive_document: false,
    is_admin_modified: isAdminModified,
  });
}

/** Reports a found item through the REAL route and returns the persisted item. */
async function reportItem(categoryId: string) {
  const finderPhone = nextFinderPhone();
  const r = await http('/api/items/report', {
    categoryId,
    photoBase64: PNG_B64,
    locationDescription: 'Kenyatta Avenue, Nairobi',
    foundCounty: 'Nairobi',
    administrativeUnitId: ADMIN_UNIT,
    finderPhone,
    description: 'Item reported by the pricing-authority suite',
    termsAccepted: true,
  });
  expect(r.status, `report failed: ${r.text}`).toBe(200);
  const itemId = String(r.json?.item?.id || '');
  expect(itemId).toBeTruthy();
  const item = await db.getItem(itemId);
  expect(item, 'the reported item must be persisted').toBeTruthy();
  return { item: item!, finderPhone };
}

// ===========================================================================
// THE MODE CONTRACT — one definition of the mode, one definition of the price
// ===========================================================================
describe('the pricing-mode contract has exactly two modes', () => {
  it('is_admin_modified === true is MODE 1, and nothing else ever is', () => {
    expect(resolveCategoryPricingMode({ is_admin_modified: true })).toBe(PRICING_MODE_FLAT_ADMIN_OVERRIDE);
    for (const value of [false, undefined, null] as const) {
      expect(resolveCategoryPricingMode({ is_admin_modified: value }))
        .toBe(PRICING_MODE_RECOVERY_FEE_ENGINE);
    }
    // A missing category can never be treated as a flat override.
    expect(resolveCategoryPricingMode(undefined)).toBe(PRICING_MODE_RECOVERY_FEE_ENGINE);
  });

  it('MODE 1 locks the flat fields verbatim and ignores the engine config entirely', () => {
    const locked = resolveItemLockedPricing({
      ...engineConfig(),
      is_admin_modified: true,
      total_fee: 100, finder_share: 25, agent_share: 35, platform_share: 40,
    }, null);
    expect(locked.mode).toBe(PRICING_MODE_FLAT_ADMIN_OVERRIDE);
    expect(locked.totalFee).toBe(100);
    expect(locked.finderShare).toBe(25);
    expect(locked.agentShare).toBe(35);
    expect(locked.platformShare).toBe(40);
    // The flat override has no ceiling concept: declared value cannot move it.
    expect(resolveItemLockedPricing({
      ...engineConfig(),
      is_admin_modified: true,
      total_fee: 100, finder_share: 25, agent_share: 35, platform_share: 40,
    }, 10).totalFee).toBe(100);
  });

  it('MODE 2 prices from the engine and ignores the flat fields', () => {
    const locked = resolveItemLockedPricing({
      ...engineConfig(),
      is_admin_modified: false,
      total_fee: 100, finder_share: 25, agent_share: 35, platform_share: 40,
    }, null);
    expect(locked.mode).toBe(PRICING_MODE_RECOVERY_FEE_ENGINE);
    expect(locked.totalFee).toBe(200);   // 200 + 0 + 0, NOT the flat 100
    expect(locked.finderShare).toBe(50); // 25% of 200 — from finder_pct, not finder_share
    expect(locked.agentShare).toBe(70);
    expect(locked.platformShare).toBe(80);
  });

  it('the Finder report route prices new items through this ONE resolver', () => {
    expect(FINDER_REPORT).toContain('resolveItemLockedPricing(cat, parsedDeclaredValue)');
    expect(FINDER_REPORT).toContain("from '../services/feeEngine.ts'");
  });
});

// ===========================================================================
// TEST 1 — a FLAT price change controls the price of NEW items
// ===========================================================================
describe('TEST 1 — changing the flat price changes what a new item is charged', () => {
  const CATEGORY = `TEST-PRICE-FLAT-${RUN}`;
  const OWNER_PHONE = `+2547${String(720000000 + RUN.length).slice(-8)}`;

  it('the category starts in MODE 1 at 200, and a new item locks 200 / 50 / 70 / 80', async () => {
    await createCategory(CATEGORY, 200, 50, 70, 80, true);
    expect(resolveCategoryPricingMode(await db.getCategory(CATEGORY))).toBe(PRICING_MODE_FLAT_ADMIN_OVERRIDE);

    const { item } = await reportItem(CATEGORY);
    expect(item.locked_total_fee).toBe(200);
    expect(item.locked_finder_share).toBe(50);
    expect(item.locked_agent_share).toBe(70);
    expect(item.locked_platform_share).toBe(80);
  });

  it('after the admin re-prices it to 100 / 25 / 35 / 40, the NEW item locks exactly that', async () => {
    await updateCategory(CATEGORY, 100, 25, 35, 40, true);

    const stored = await db.getCategory(CATEGORY);
    expect(stored?.total_fee).toBe(100);
    expect(resolveCategoryPricingMode(stored)).toBe(PRICING_MODE_FLAT_ADMIN_OVERRIDE);

    const { item } = await reportItem(CATEGORY);
    expect(item.locked_total_fee, 'the flat change must control the new item price').toBe(100);
    expect(item.locked_finder_share).toBe(25);
    expect(item.locked_agent_share).toBe(35);
    expect(item.locked_platform_share).toBe(40);
  });

  it('the payment session for a claim on that item is created for the locked 100, and no client amount can change it', async () => {
    const { item } = await reportItem(CATEGORY);
    const claimId = `TEST-PRICE-CLAIM-${RUN}-1`;
    await db.createClaim({
      id: claimId,
      item_id: item.id,
      owner_phone: OWNER_PHONE,
      security_answers: { lastDigits: '0000', colour: 'black', lostDetails: 'pricing-authority fixture' },
      verification_tier: 1,
      status: 'pending_payment',
      owner_id_proof_url: null,
      payment_reference: null,
      owner_identifying_details: null,
    } as any);

    // `amount` is deliberately included to prove the route ignores it: the client
    // cannot name its own price, and the figure it names is nowhere in the result.
    const r = await http(`/api/claims/${claimId}/payment-session`, {
      phone: OWNER_PHONE,
      amount: 9999,
      total_fee: 9999,
    });
    expect(r.status, `payment-session failed: ${r.text}`).toBe(200);
    expect(r.json?.paymentSession?.amount).toBe(100);

    const sessionId = String(r.json?.paymentSession?.id || '');
    expect(sessionId).toBeTruthy();
    const persisted = await db.getPaymentSessionById(sessionId);
    expect(persisted?.amount, 'the STORED payment session amount is the locked 100').toBe(100);
    expect(persisted?.claim_id).toBe(claimId);
    expect(JSON.stringify(persisted)).not.toContain('9999');
  });
});

// ===========================================================================
// TEST 2 — MODE 2 stays MODE 2: editing a flat field is NOT a mode switch
// ===========================================================================
describe('TEST 2 — ENGINE mode remains ENGINE mode (the Recovery Fee Engine is not destroyed)', () => {
  const CATEGORY = `TEST-PRICE-ENGINE-${RUN}`;

  it('changing only the flat total_fee leaves the category in MODE 2 and the engine pricing intact', async () => {
    await createCategory(CATEGORY, 200, 50, 70, 80, false);
    expect(resolveCategoryPricingMode(await db.getCategory(CATEGORY))).toBe(PRICING_MODE_RECOVERY_FEE_ENGINE);

    // The admin edits ONLY the flat pricing values (200 -> 100) and does NOT
    // switch mode. Editing a flat field must never turn an engine category into
    // a flat-override one.
    await updateCategory(CATEGORY, 100, 25, 35, 40, false);

    const stored = await db.getCategory(CATEGORY);
    expect(stored?.is_admin_modified, 'an engine category must not be flipped to flat mode').toBe(false);
    expect(stored?.total_fee, 'the flat value is still stored').toBe(100);
    expect(stored?.base_fee, 'the engine configuration is untouched').toBe(200);
    expect(resolveCategoryPricingMode(stored)).toBe(PRICING_MODE_RECOVERY_FEE_ENGINE);

    // Documented MODE 2 behaviour: the ENGINE prices the new item (200 + 0 + 0)
    // and the flat 100 is not what it locks.
    const { item } = await reportItem(CATEGORY);
    expect(item.locked_total_fee, 'the engine still prices new items in MODE 2').toBe(200);
    expect(item.locked_finder_share).toBe(50);
    expect(item.locked_agent_share).toBe(70);
    expect(item.locked_platform_share).toBe(80);
  });

  it('an engine-only edit also leaves the mode alone, and the new engine fee prices new items', async () => {
    await db.updateCategory(CATEGORY, {
      name_en: `Pricing Authority ${CATEGORY}`,
      name_sw: `Mamlaka ya Bei ${CATEGORY}`,
      total_fee: 100,
      finder_share: 25,
      agent_share: 35,
      platform_share: 40,
      is_sensitive_document: false,
      is_admin_modified: false,
      base_fee: 300, // engine configuration change, not a flat-price change
    });
    expect((await db.getCategory(CATEGORY))?.is_admin_modified).toBe(false);

    const { item } = await reportItem(CATEGORY);
    expect(item.locked_total_fee, 'the new engine base fee prices new items').toBe(300);
  });
});

// ===========================================================================
// TEST 3 — an existing item's locked fee is immutable
// ===========================================================================
describe('TEST 3 — a category re-price never rewrites an existing item', () => {
  const CATEGORY = `TEST-PRICE-IMMUTABLE-${RUN}`;

  it('an item reported at 200 keeps 200 after the category drops to 100', async () => {
    await createCategory(CATEGORY, 200, 50, 70, 80, true);
    const { item: first } = await reportItem(CATEGORY);
    expect(first.locked_total_fee).toBe(200);

    await updateCategory(CATEGORY, 100, 25, 35, 40, true);

    // Re-read the ORIGINAL item: it must still be exactly what it locked.
    const reread = await db.getItem(first.id);
    expect(reread?.locked_total_fee, 'history must not be recalculated').toBe(200);
    expect(reread?.locked_finder_share).toBe(50);
    expect(reread?.locked_agent_share).toBe(70);
    expect(reread?.locked_platform_share).toBe(80);

    // ...while a NEW item reported after the change uses the new flat price.
    const { item: second } = await reportItem(CATEGORY);
    expect(second.id).not.toBe(first.id);
    expect(second.locked_total_fee).toBe(100);
    expect(second.locked_finder_share).toBe(25);
    expect(second.locked_agent_share).toBe(35);
    expect(second.locked_platform_share).toBe(40);
  });
});

// ===========================================================================
// THE ADMIN CONTRACT — the server states the mode and refuses ambiguity
// ===========================================================================
// PUT /api/admin/categories/:id is still inline in server.ts (it boots the
// listener at import time), so it cannot be mounted. These are the same
// source-level assertions the repo already uses for that route (see
// categoryArchitectureBatch1/2.test.ts), pinning exactly what this batch added.
const putRouteBody = (() => {
  const start = SERVER_RAW.indexOf("app.put('/api/admin/categories/:id'");
  expect(start, 'PUT /api/admin/categories/:id not found in server.ts').toBeGreaterThan(-1);
  const rest = SERVER_RAW.slice(start);
  const next = rest.slice(1).search(/\n {2}app\.[a-z]+\(/);
  const body = next === -1 ? rest : rest.slice(0, next + 1);
  return body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
})();

describe('the category save contract makes the pricing mode explicit and authoritative', () => {
  it('resolves the mode from the ONE shared contract rather than a second implementation', () => {
    expect(putRouteBody).toContain('resolveCategoryPricingMode(existing)');
    expect(putRouteBody).toContain('resolveItemLockedPricing(persisted, null)');
    expect(SERVER_RAW).toContain("} from './services/feeEngine';");
  });

  it('refuses a request that changes the flat prices without stating a mode', () => {
    expect(putRouteBody).toContain('const flatPricingFieldsChanged');
    expect(putRouteBody).toContain("const pricingModeWasStated = typeof is_admin_modified === 'boolean'");
    expect(putRouteBody).toContain('if (!pricingModeWasStated && flatPricingFieldsChanged)');
    expect(putRouteBody).toMatch(/res\.status\(400\)/);
  });

  it('persists the RESOLVED mode, not a re-read of the raw body field', () => {
    expect(putRouteBody).toContain('is_admin_modified: effectiveIsAdminModified');
    expect(putRouteBody).not.toMatch(/is_admin_modified: typeof is_admin_modified === 'boolean' \? is_admin_modified : existing\.is_admin_modified/);
  });

  it('verifies the PERSISTED mode before reporting success, failing closed otherwise', () => {
    expect(putRouteBody).toContain('const persisted = await db.getCategory(id)');
    expect(putRouteBody).toContain('persisted.is_admin_modified !== effectiveIsAdminModified');
    expect(putRouteBody).toMatch(/throw new Error\(/);
    // The shared error boundary answers, so the route still never answers 500 itself.
    expect(putRouteBody).not.toMatch(/res\.status\(500\)/);
  });

  it('reports the effective mode and the authoritative new-item price in the response', () => {
    expect(putRouteBody).toContain('pricingMode: authoritativePricing.mode');
    expect(putRouteBody).toContain('authoritativePricing,');
  });

  it('makes the CATEGORY_UPDATED audit entry state the pricing mode', () => {
    const auditIdx = putRouteBody.indexOf("'CATEGORY_UPDATED'");
    expect(auditIdx, 'CATEGORY_UPDATED audit must still be written').toBeGreaterThan(-1);
    const auditCall = putRouteBody.slice(auditIdx, auditIdx + 1400);
    expect(auditCall).toContain('pricing_mode=${authoritativePricing.mode}');
    expect(auditCall).toContain('previous_pricing_mode=${oldPricingMode}');
    expect(auditCall).toContain('new_item_locks_total_fee=${authoritativePricing.totalFee}');
  });

  it('keeps the existing share-total validation intact', () => {
    expect(putRouteBody).toContain('const total = parseFloat(numTotal.toFixed(2))');
    expect(putRouteBody).toContain('if (total !== sumShares)');
    expect(putRouteBody).toContain('must sum to total fee exactly');
  });
});

describe('the admin console states the mode and refuses to save an ignored flat price', () => {
  it('states which model is in force and what a new item would lock', () => {
    expect(ADMIN_VIEW).toContain('id="cat-pricing-mode-banner"');
    expect(ADMIN_VIEW).toContain('id="cat-pricing-mode-authoritative-price"');
    expect(ADMIN_VIEW).toContain('flat_admin_override');
    expect(ADMIN_VIEW).toContain('recovery_fee_engine');
    expect(ADMIN_VIEW).toContain('MODE 1 — FLAT / ADMIN OVERRIDE is in force');
    expect(ADMIN_VIEW).toContain('MODE 2 — RECOVERY FEE ENGINE is in force');
  });

  it('labels the flat price fields themselves as authoritative or not', () => {
    expect(ADMIN_VIEW).toContain('id="cat-flat-price-authority"');
    expect(ADMIN_VIEW).toContain('These flat prices ARE authoritative (MODE 1)');
    expect(ADMIN_VIEW).toContain('These flat prices are NOT authoritative (MODE 2)');
  });

  it('offers an explicit, visible switch to MODE 1 rather than flipping the mode silently', () => {
    expect(ADMIN_VIEW).toContain('id="cat-pricing-mode-switch-to-flat"');
    expect(ADMIN_VIEW).toContain('setCatFormIsAdminModified(true)');
  });

  it('refuses to "successfully" save a flat price change that MODE 2 would ignore', () => {
    expect(ADMIN_VIEW).toContain('const flatPricesEdited');
    expect(ADMIN_VIEW).toContain("if (showCategoryForm === 'edit' && selectedCategory && !catFormIsAdminModified)");
    expect(ADMIN_VIEW).toContain('Save blocked: you changed the flat pricing values');
    // The refusal must happen BEFORE the request is sent.
    const guardIdx = ADMIN_VIEW.indexOf('if (flatPricesEdited)');
    const fetchIdx = ADMIN_VIEW.indexOf('const res = await fetch(url, {');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(fetchIdx, 'the guard must precede the save request').toBeGreaterThan(guardIdx);
  });

  it('preserves the existing checkbox id and its ≥44px labelled row', () => {
    for (const id of ['catFormIsAdminModified', 'cat-form-total-fee', 'cat-form-finder-share', 'cat-form-agent-share', 'cat-form-platform-share']) {
      expect(ADMIN_VIEW, `${id} must survive this batch`).toContain(id);
    }
    expect(ADMIN_VIEW).toContain('htmlFor="catFormIsAdminModified"');
    expect(ADMIN_VIEW).toContain('Use flat fee override / Tumia ada isiyobadilika');
  });
});
