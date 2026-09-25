import { db } from '../database';

/**
 * Per-test-file random suffix, used to make fixture primary keys unique
 * across repeated runs against a PERSISTENT database (e.g. a developer's
 * local Postgres from .env). The in-memory mock resets every run, so CI
 * never collides; a real Postgres persists, so deterministic IDs like
 * `TEST-ITEM-RETENTION-1` would hit `items_pkey` on the second run. Suffixing
 * every fixture ID with this value makes each run's rows distinct without
 * changing any assertion.
 */
export const testRunId = Math.floor(100000 + Math.random() * 900000).toString();

/**
 * Idempotently ensure a category exists before a test fixture inserts an item
 * that references it.
 *
 * WHY THIS EXISTS: BOTH databases start with an EMPTY `categories` table —
 * `sql/schema.sql` seeds no rows, and the in-memory mock used in CI (no
 * DATABASE_URL) is initialised with `categories: []` (src/db/index.ts). The
 * mock additionally does NOT enforce foreign keys, so a fixture that inserted an
 * item with an unknown `category_id` passed in CI while violating
 * `items_category_id_fkey` against real Postgres — masking real schema semantics
 * from CI (production-audit finding B-2). Calling this helper before createItem
 * makes the fixture valid in both environments.
 *
 * ON THE `'phone'` / `'laptop'` IDS USED BY CALLERS: these fixtures deliberately
 * use a SHORT, ARBITRARY synthetic id rather than a canonical seed id such as
 * `smartphone`. They are testing category-AGNOSTIC behaviour (custody, fees,
 * disputes, retention sweeps), so they must not depend on the 46-category
 * baseline seed existing, changing, or carrying particular pricing — a
 * dependency that would make unrelated tests fail whenever the seed is edited.
 * This helper is therefore a TEST FIXTURE, not a second category dataset: it
 * creates the one id a test asks for, with explicit fee values, and holds no
 * list of its own.
 *
 * Uses getCategories() + conditional createCategory() rather than an upsert
 * because db.createCategory() has no ON CONFLICT support; the read-then-write
 * keeps it idempotent across repeated runs against the same database.
 *
 * Fee fields respect the platform's fixed 25/35/40 settlement split
 * (500 total -> 125/175/200) and are arbitrary otherwise: these categories
 * exist only so FK references resolve; individual tests that assert on fee
 * behaviour create their own categories with explicit values.
 */
export async function ensureTestCategory(id: string): Promise<void> {
  const existing = await db.getCategories();
  if (existing.some((c) => c.id === id)) return;
  await db.createCategory({
    id,
    name_en: `Test ${id}`,
    name_sw: `Jaribio ${id}`,
    total_fee: 500,
    finder_share: 125,
    agent_share: 175,
    platform_share: 200,
    is_sensitive_document: id === 'national-id',
  });
}
