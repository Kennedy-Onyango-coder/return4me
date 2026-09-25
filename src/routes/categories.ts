// Public + admin category routes: the public category list and the admin
// category-creation action.
//
// WHY THIS IS A SEPARATE MODULE (Phase 16.1 Batch 1A)
// These two routes lived inline inside server.ts's startServer(). server.ts
// constructs the whole application and calls startServer() at import time
// (Vite middleware, background sweeps, listeners) and exports nothing, so its
// inline routes cannot be mounted by a test. The Batch 1A forensic audit found
// that an administrator-created category was not propagating to the public
// surfaces, and proving that chain REQUIRES a real HTTP round-trip
// (create → GET /api/categories). routes/adminDisputes.ts was extracted for
// exactly this reason, and this follows the same pattern: the caller passes the
// REAL middleware and the REAL error helper in, so an integration test can mount
// an Express app around the REAL handlers.
//
// The handler bodies are moved VERBATIM. Nothing about either route's behaviour,
// validation, authorization, DTO or ordering changes — the only edit is the
// `is_admin_modified` create-asymmetry fix documented in
// registerAdminCategoryRoutes below.
import type { Express } from 'express';
import { db } from '../db/database.ts';
import { isDatabaseConnectionError } from '../db/index.ts';
import { authenticateJWT } from '../services/auth.ts';
import { toPublicCategoryView } from '../services/categoryPublicView.ts';
import { validateCategoryIdFormat, parseCategoryNumber } from '../services/categoryValidation.ts';
import { isPublicClueStyle, PUBLIC_CLUE_STYLES } from '../services/publicRecognition.ts';

export interface PublicCategoryRouteDeps {
  /** The real sendServerError helper from server.ts. */
  sendServerError: (res: any, error: any, context: string) => void;
}

export interface AdminCategoryRouteDeps {
  /** The real requireCurrentAdminSession from server.ts (not importable — it is
   *  defined inside that module, which boots the app on import). */
  requireCurrentAdminSession: (req: any, res: any, next: any) => void;
  /** The real sendServerError helper from server.ts. */
  sendServerError: (res: any, error: any, context: string) => void;
}

export function registerPublicCategoryRoutes(app: Express, deps: PublicCategoryRouteDeps): void {
  const { sendServerError } = deps;

  app.get('/api/categories', async (req, res) => {
    try {
      // PHASE 16.1 BATCH 2 (CAT-04 + CAT-09) — PUBLIC CATEGORY LIST.
      //
      // Two things happen here and nothing else:
      //   1. ACTIVE ONLY. A deactivated category must not be offered for new
      //      work, so it is absent from this list — which is the single source
      //      every selector in the app reads (Finder, Owner, lost-report wizard,
      //      Agent verification, homepage explorer). Historical records that
      //      reference it are unaffected: they are resolved through
      //      `db.getCategories()` on the server and remain searchable.
      //   2. PUBLIC DTO. The raw configuration row is NOT serialized; see
      //      services/categoryPublicView.ts for the field-by-field rationale.
      //      The admin console reads GET /api/admin/categories instead, which
      //      still returns the complete record.
      const categories = await db.getActiveCategories();
      res.json(categories.map(toPublicCategoryView).filter(Boolean));
    } catch (e: any) {
      console.error('[API CATEGORIES ENGINE] Failed to fetch categories from database:', e);
      if (isDatabaseConnectionError(e)) {
        return res.status(503).json({
          error: "Huduma haipatikani kwa sasa. Tafadhali jaribu tena baadaye. / Service temporarily unavailable. Please try again shortly."
        });
      }
      sendServerError(res, e, 'CATEGORIES_FETCH_ERROR');
    }
  });
}

export function registerAdminCategoryRoutes(app: Express, deps: AdminCategoryRouteDeps): void {
  const { requireCurrentAdminSession, sendServerError } = deps;

  app.post('/api/admin/categories', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa hii ni ya Wasimamizi (Admins) tu.' });
      }

      const {
        id, name_en, name_sw, total_fee, finder_share, agent_share, platform_share, is_sensitive_document,
        base_fee, complexity_fee, delay_fee, ceiling_percent, finder_pct, agent_pct, platform_pct, finder_reward_cap,
        elevated_review, is_admin_modified, public_clue_style, is_active,
      } = req.body;

      // PHASE 16.1 BATCH 1 (CAT-19) — the id FORMAT and the VARCHAR(50) length are
      // now both enforced at the boundary. A 51+ character id previously passed
      // this regex and reached the database, where the column rejected it as a
      // 500. Format unchanged; only the storage limit was added.
      const idFormat = validateCategoryIdFormat(id);
      if (!idFormat.ok) {
        return res.status(400).json({ error: idFormat.error });
      }

      // P14A (P14-05) — allow-listed public-recognition masking style. An
      // OMITTED field keeps the existing default ('generic', applied by the DB
      // column); a supplied but unsupported value is rejected outright rather
      // than silently coerced.
      if (public_clue_style !== undefined && public_clue_style !== null && public_clue_style !== '') {
        if (!isPublicClueStyle(public_clue_style)) {
          return res.status(400).json({
            error: `public_clue_style lazima iwe mojawapo ya: ${PUBLIC_CLUE_STYLES.join(', ')}. / public_clue_style must be one of: ${PUBLIC_CLUE_STYLES.join(', ')}.`
          });
        }
      }

      if (!name_en || typeof name_en !== 'string' || name_en.trim() === '' || !name_sw || typeof name_sw !== 'string' || name_sw.trim() === '') {
        return res.status(400).json({ error: 'Majina ya kategoria (English & Swahili) lazima yajazwe.' });
      }

      const existing = await db.getCategory(id);
      if (existing) {
        return res.status(400).json({ error: 'ID hii ya kategoria tayari ipo. Tafadhali tumia nyingine.' });
      }

      const numTotal = Number(total_fee);
      const numFinder = Number(finder_share);
      const numAgent = Number(agent_share);
      const numPlatform = Number(platform_share);

      if (isNaN(numTotal) || numTotal < 0 || isNaN(numFinder) || numFinder < 0 || isNaN(numAgent) || numAgent < 0 || isNaN(numPlatform) || numPlatform < 0) {
        return res.status(400).json({ error: 'Ada na migao yote lazima iwe nambari inayozidi au sawa na sifuri.' });
      }

      // CHECK sum exactly to 2 decimal places to avoid standard JS float issues
      const total = parseFloat(numTotal.toFixed(2));
      const sumShares = parseFloat((numFinder + numAgent + numPlatform).toFixed(2));
      if (total !== sumShares) {
        return res.status(400).json({
          error: 'Mgao (finder + agent + platform) lazima uwe sawa na jumla ya ada. / Split shares (finder + agent + platform) must sum to total fee exactly.'
        });
      }

      // -----------------------------------------------------------------------
      // PHASE 16.1 BATCH 1 (CAT-19) — Recovery Fee Engine fields are validated too.
      // -----------------------------------------------------------------------
      // Only the four flat share fields were checked above; these eight were cast
      // with a bare `Number()`, so "abc" became NaN, Infinity stayed Infinity and
      // a negative amount reached a Postgres CHECK constraint — all reported to
      // the admin as a 500. Amounts are now `>= 0` (matching the column CHECKs)
      // and percentages are `0 - 100`. An omitted field is still omitted, so the
      // database defaults keep applying exactly as before.
      const engineFeeFields: Array<[string, unknown, { min: number; max?: number }]> = [
        ['base_fee', base_fee, { min: 0 }],
        ['complexity_fee', complexity_fee, { min: 0 }],
        ['delay_fee', delay_fee, { min: 0 }],
        ['ceiling_percent', ceiling_percent, { min: 0, max: 100 }],
        ['finder_pct', finder_pct, { min: 0, max: 100 }],
        ['agent_pct', agent_pct, { min: 0, max: 100 }],
        ['platform_pct', platform_pct, { min: 0, max: 100 }],
        ['finder_reward_cap', finder_reward_cap, { min: 0 }],
      ];
      const engineFees: Record<string, number | undefined> = {};
      for (const [field, rawValue, rule] of engineFeeFields) {
        const parsed = parseCategoryNumber(rawValue, field, rule);
        if (!parsed.ok) {
          return res.status(400).json({ error: parsed.error });
        }
        if (parsed.supplied) engineFees[field] = parsed.value as number;
      }

      const newCat = await db.createCategory({
        id,
        name_en: name_en.trim(),
        name_sw: name_sw.trim(),
        total_fee: numTotal,
        finder_share: numFinder,
        agent_share: numAgent,
        platform_share: numPlatform,
        is_sensitive_document: is_sensitive_document !== false,
        // PHASE 16.1 BATCH 1A — the fee-flag asymmetry fix.
        //
        // The console's create form has always sent `is_admin_modified`
        // (AdminView.tsx), but this route never forwarded it and
        // db.createCategory had no parameter for it, so an administrator who
        // created a category with "use the flat fee verbatim" ticked silently got
        // the Recovery Fee Engine instead (the column landed on its `false`
        // default). The PUT path has always honoured it. The same convention is
        // applied here: a real boolean is honoured, and anything else is treated
        // as "not supplied" so the existing column default still applies — i.e.
        // omitting the field keeps today's behaviour exactly. No fee formula,
        // split or default is changed by this.
        is_admin_modified: typeof is_admin_modified === 'boolean' ? is_admin_modified : undefined,
        base_fee: engineFees.base_fee,
        complexity_fee: engineFees.complexity_fee,
        delay_fee: engineFees.delay_fee,
        ceiling_percent: engineFees.ceiling_percent,
        finder_pct: engineFees.finder_pct,
        agent_pct: engineFees.agent_pct,
        platform_pct: engineFees.platform_pct,
        finder_reward_cap: engineFees.finder_reward_cap === undefined ? null : engineFees.finder_reward_cap,
        elevated_review: !!elevated_review,
        // CAT-04 (Phase 16.1 Batch 2) — a new category is ACTIVE unless the
        // administrator explicitly says otherwise. Only a real boolean counts
        // (the same rule the `is_admin_modified` field already follows); anything
        // else is treated as "not supplied" so the column default applies.
        is_active: typeof is_active === 'boolean' ? is_active : undefined,
        // Omitted → undefined, so the column's own 'generic' default applies.
        public_clue_style: public_clue_style === undefined || public_clue_style === null || public_clue_style === ''
          ? undefined
          : public_clue_style,
      });

      const adminUser = req.user?.username || req.user?.userId || 'admin';
      await db.logAudit(
        adminUser,
        'CATEGORY_CREATED',
        `Admin created category: id=${id}, name=${name_en}, total_fee=${total_fee}, public_clue_style=${newCat?.public_clue_style ?? 'generic'}`
      );

      res.json({ success: true, category: newCat });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });
}

