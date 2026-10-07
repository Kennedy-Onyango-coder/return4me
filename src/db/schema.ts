import { pgTable, varchar, text, numeric, integer, timestamp, jsonb, boolean, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { CLAIM_SLOT_EXCLUDED_SQL_LIST } from "../config/claimStatuses";

// 1. CATEGORIES TABLE
export const categories = pgTable("categories", {
  id: varchar("id", { length: 50 }).primaryKey(),
  name_en: varchar("name_en", { length: 100 }).notNull(),
  name_sw: varchar("name_sw", { length: 100 }).notNull(),
  total_fee: numeric("total_fee", { precision: 10, scale: 2 }).notNull(),
  finder_share: numeric("finder_share", { precision: 10, scale: 2 }).notNull(),
  agent_share: numeric("agent_share", { precision: 10, scale: 2 }).notNull(),
  platform_share: numeric("platform_share", { precision: 10, scale: 2 }).notNull(),
  is_sensitive_document: boolean("is_sensitive_document").default(true).notNull(),
  is_admin_modified: boolean("is_admin_modified").default(false).notNull(),
  // --- RECOVERY FEE ENGINE CONFIG ---
  // When is_admin_modified is true, total_fee/finder_share/agent_share/platform_share
  // above are used verbatim as a flat admin override (unchanged legacy behaviour).
  // Otherwise the fee engine (src/services/feeEngine.ts) computes the fee from these
  // inputs at report time: base_fee + complexity_fee + delay_fee, capped at
  // ceiling_percent of the finder's declared replacement value (if one was given),
  // then split finder_pct / agent_pct / platform_pct. finder_reward_cap is an
  // absolute KES ceiling on the finder's cut, independent of item value, so a
  // high-value item can never create an outsized incentive to "find" a stolen one.
  base_fee: numeric("base_fee", { precision: 10, scale: 2 }).default("0.00").notNull(),
  complexity_fee: numeric("complexity_fee", { precision: 10, scale: 2 }).default("0.00").notNull(),
  delay_fee: numeric("delay_fee", { precision: 10, scale: 2 }).default("0.00").notNull(),
  ceiling_percent: numeric("ceiling_percent", { precision: 5, scale: 2 }).default("12.00").notNull(),
  finder_pct: numeric("finder_pct", { precision: 5, scale: 2 }).default("25.00").notNull(),
  agent_pct: numeric("agent_pct", { precision: 5, scale: 2 }).default("35.00").notNull(),
  platform_pct: numeric("platform_pct", { precision: 5, scale: 2 }).default("40.00").notNull(),
  finder_reward_cap: numeric("finder_reward_cap", { precision: 10, scale: 2 }),
  // When true, every item reported in this category is forced through the
  // existing admin manual-review gate (flaggedForReview) before it becomes
  // publicly searchable — regardless of OCR confidence or reputation score.
  // Used for categories carrying either extra financial risk (cash — a
  // publicly-known amount is itself a fraud target) or extra child-safety
  // sensitivity (school IDs, children's documents), matching the doc's
  // "if uncertain, escalate to human review" fail-safe principle.
  elevated_review: boolean("elevated_review").default(false).notNull(),
  // Public-recognition masking policy for this category's document-number
  // clue in social posts — see src/services/publicRecognition.ts. Admin-
  // configurable per category rather than hardcoded, since new document
  // types get added over time and different ones warrant different
  // levels of exposure (e.g. a card's last-4 vs a passport's first
  // character only). 'none' means never show a document-number clue at
  // all for this category, regardless of what was extracted.
  public_clue_style: varchar("public_clue_style", { length: 30 }).default("generic").notNull(),
  // CANONICAL DISPLAY ORDER (Phase 16.1 Batch 1 — CAT-03).
  //
  // Before this column, `getCategories()` had no ORDER BY at all, so every
  // consumer (the Finder's category select, the Owner lost-report selector,
  // the Agent verification select, the admin category list, the public
  // enumeration) inherited whatever row order the driver happened to return —
  // unspecified on Postgres, and able to change after an update. The seed
  // below has always had an intentional sequence; this column makes that
  // sequence explicit and enforceable in one place.
  //
  // Values are assigned from the canonical seed's array position (1-based) by
  // syncDefaultCategories(), and "highest + 1" for an admin-created category.
  // It is NOT exposed in the admin console and there is no reorder endpoint in
  // this batch, so no consumer may treat it as user-editable.
  //
  // DEFAULT 0 exists so an already-running database picks the column up
  // without NULLs (the ALTER TABLE in src/db/index.ts adds it as NOT NULL
  // DEFAULT 0); the boot sync then writes the real position for every seeded
  // category. `id` breaks ties deterministically.
  sort_order: integer("sort_order").default(0).notNull(),
  // LIFECYCLE STATE (Phase 16.1 Batch 2 — CAT-04).
  //
  // A first-class lifecycle state, NOT a frontend visibility flag: it decides
  // whether a category may be SELECTED for new work. An inactive category:
  //   - is not offered by the public `GET /api/categories` (so it disappears
  //     from the Finder, Owner, lost-report and Agent selectors at once);
  //   - cannot be chosen for a new found-item report, a new lost report or a
  //     new Agent verification (those boundaries validate against the ACTIVE
  //     list, so a client cannot bypass the UI);
  //   - STILL resolves for historical records — `items.category_id` and
  //     `lost_reports.category_id` keep pointing at it, `getCategories()`
  //     keeps returning it, public search keeps matching it, and the admin
  //     console keeps listing it so it can be reactivated.
  //
  // DEFAULT true: every pre-existing category stays active through the schema
  // upgrade (the ALTER TABLE in src/db/index.ts adds it NOT NULL DEFAULT true),
  // so this is purely additive and hides nothing that was previously visible.
  // Deactivation is therefore also the SAFE replacement for deleting a
  // canonical seeded category (CAT-06).
  is_active: boolean("is_active").default(true).notNull(),
});

// 2. AGENTS TABLE
export const agents = pgTable("agents", {
  id: varchar("id", { length: 50 }).primaryKey(),
  business_name: varchar("business_name", { length: 150 }).notNull(),
  contact_phone: varchar("contact_phone", { length: 15 }).notNull().unique(),
  location_address: text("location_address").notNull(),
  // Confirmed service geography. Nullable for historical agents; coordinates alone
  // never establish county/sub-county service eligibility.
  county: varchar("county", { length: 50 }),
  administrative_unit_id: varchar("administrative_unit_id", { length: 50 }),
  location_accuracy: numeric("location_accuracy", { precision: 10, scale: 2 }),
  // --- GEO-D+ LOCATION PROVENANCE (foundation only) -------------------------
  // TWO INDEPENDENT AXES, deliberately NOT interchangeable (see
  // services/locationProvenance.ts for the vocabulary + guards):
  //   location_source   = HOW the SERVICE geography (county / administrative
  //                       unit) was established. Written as 'user_selected'
  //                       because an agent chooses a sub-county of a chosen
  //                       county at signup and the server re-validates it.
  //   coordinate_source = HOW the stored latitude/longitude PAIR was
  //                       established (the operational hub coordinate): one of
  //                       'browser_gps' | 'forward_geocoder' | 'admin_corrected'.
  //                       It is NOT a statement about geography.
  // Both are nullable with NO default: every pre-GEO-D+ agent row keeps NULL,
  // which is the honest "origin unknown" value. No backfill, no inference.
  location_source: varchar("location_source", { length: 30 }),
  coordinate_source: varchar("coordinate_source", { length: 30 }),
  latitude: numeric("latitude", { precision: 9, scale: 6 }),
  longitude: numeric("longitude", { precision: 9, scale: 6 }),
  mpesa_till_or_paybill: varchar("mpesa_till_or_paybill", { length: 20 }).notNull(),
  payout_method_type: varchar("payout_method_type", { length: 50 }).default("Till Number").notNull(),
  status: varchar("status", { length: 20 }).default("pending").notNull(),
  refundable_deposit: numeric("refundable_deposit", { precision: 10, scale: 2 }).default("0.00").notNull(),
  national_id_hash: varchar("national_id_hash", { length: 64 }).notNull(),
  rating: numeric("rating", { precision: 3, scale: 2 }).default("5.00"),
  rating_count: integer("rating_count").default(0),
  needs_manual_geocoding: boolean("needs_manual_geocoding").default(false).notNull(),
  // N4 — agent EMAIL ACTIVATION, the second axis alongside `status`.
  //
  // `status` remains the BUSINESS APPROVAL axis and is untouched by N4:
  // 'pending' = awaiting admin approval, 'active' = approved, 'suspended' =
  // revoked. `email_verified_at` records the independent EMAIL axis, using the
  // same shape N3 gave customers: NULL = unverified, timestamp = verified.
  //
  // A timestamp rather than a boolean, for the reason the customers column uses:
  // exactly ONE source of truth, and it also records WHEN. It is deliberately
  // nullable and defaults to NULL — a NULL here means "not verified", which is
  // the correct default for an unproven claim of ownership.
  email_verified_at: timestamp("email_verified_at", { withTimezone: true }),
  // N4 — an agent's contact address. Now REQUIRED for new registrations and
  // normalized (trim + lowercase) by the single writer, db.createAgent(), so
  // every stored value is comparable. Nullable because pre-N4 agents
  // legitimately have none; the grandfather rule in isAgentActionable() keys on
  // exactly that. Uniqueness is a PARTIAL unique index
  // (uq_agents_email, WHERE contact_email IS NOT NULL) rather than a column
  // constraint, so any number of grandfathered NULL rows coexist while two
  // non-null addresses can never collide — the identical pattern N2/N3 used for
  // customers.email.
  contact_email: varchar("contact_email", { length: 255 }),
  shop_photo_url: text("shop_photo_url"),
  id_document_photo_url: text("id_document_photo_url"),
  warning_count: integer("warning_count").default(0).notNull(),
  last_warning_reason: text("last_warning_reason"),
  last_warning_at: timestamp("last_warning_at", { withTimezone: true }),
  terms_accepted_at: timestamp("terms_accepted_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// 3. ITEMS TABLE
export const items = pgTable("items", {
  id: varchar("id", { length: 50 }).primaryKey(),
  category_id: varchar("category_id", { length: 50 }).references(() => categories.id),
  photo_url: text("photo_url").notNull(),
  ocr_extracted_number: varchar("ocr_extracted_number", { length: 100 }),
  ocr_extracted_name: varchar("ocr_extracted_name", { length: 150 }),
  document_number_hash: varchar("document_number_hash", { length: 64 }),
  document_name_fuzzy: varchar("document_name_fuzzy", { length: 150 }),
  location_description: text("location_description").notNull(),
  latitude: numeric("latitude", { precision: 9, scale: 6 }),
  longitude: numeric("longitude", { precision: 9, scale: 6 }),
  // --- PHASE 9D: EXPLICIT FOUND-ITEM COUNTY --------------------------------
  // The county the FINDER explicitly chose for where the item was found,
  // stored as a CANONICAL name from config/kenyaCounties.ts (one of the 47,
  // exactly as `lost_reports.county` already is). Validation and
  // canonicalization happen at the API boundary in server.ts via the existing
  // `resolveCountyName()`; this column only ever holds a value that function
  // produced.
  //
  // WHY IT EXISTS: the lost side has had a canonical county since Phase 9A,
  // while the found side had only free text. The matcher therefore had to
  // GUESS a found county by scanning the location text for county names, which
  // produced a real false positive — "Mombasa Road" (a Nairobi street, and
  // also the A109) read as Mombasa County, and "Kiambu Road" read as Kiambu
  // County — and could then wrongly ELIMINATE a correct candidate. An explicit
  // user-chosen county removes the guess entirely.
  //
  // NULLABLE ON PURPOSE — three separate reasons:
  //   1. HISTORICAL ROWS. Every item reported before Phase 9D has no county.
  //      They must remain readable, and their county must stay UNKNOWN. There
  //      is deliberately NO backfill and no provider call against historical
  //      records: an unknown county is honest, a guessed one is not.
  //   2. The matcher already treats a missing/blank county as "no county
  //      evidence", so a legacy item simply cannot be eliminated (or created)
  //      on county grounds — the same safe behaviour as before this phase.
  //   3. `verified_found_area` / agent verification may legitimately correct
  //      the AREA without the platform ever asserting a county.
  //
  // NOT an inferred value: nothing in the codebase derives this from
  // `location_description`, from `latitude`/`longitude`, or from a geocoder.
  found_county: varchar("found_county", { length: 50 }),
  // Structured second-level geography, kept separate from exact-place text and nullable for history.
  administrative_unit_id: varchar("administrative_unit_id", { length: 50 }),
  // --- GEO-D+ LOCATION PROVENANCE (foundation only) -------------------------
  // HOW the canonical found county/sub-county above was established. New
  // records that passed the required, server-validated county + sub-county
  // selection are written as 'user_selected'. Deliberately NO coordinate axis
  // here: items.latitude/longitude are an optional device/routing position,
  // NOT the found-item location, so they must never carry a coordinate
  // provenance. Nullable, default-less, never backfilled — every pre-GEO-D+
  // row stays NULL ("origin unknown").
  location_source: varchar("location_source", { length: 30 }),
  finder_phone: varchar("finder_phone", { length: 15 }).notNull(),
  assigned_agent_id: varchar("assigned_agent_id", { length: 50 }).references(() => agents.id),
  status: varchar("status", { length: 30 }).default("awaiting_dropoff").notNull(),
  flaggedForReview: boolean("flagged_for_review").default(false).notNull(),
  isDescriptionOnly: boolean("is_description_only").default(false).notNull(),
  description: text("description"),
  is_sensitive_document: boolean("is_sensitive_document").default(true).notNull(),
  rejection_reason: text("rejection_reason"),
  // --- LOCKED FINANCIAL VALUES (Recovery Fee Engine) ---
  //
  // These four columns are the item's AUTHORITATIVE money figures, written
  // ONCE by POST /api/items/report at report time (from the fee engine, or
  // verbatim from a category whose fee an admin hand-set). Every money path
  // prefers them: resolveAuthoritativePaymentFee() / the /pay path take
  // locked_total_fee, and resolvePayoutSplit() takes the three locked shares.
  //
  // THE MODERN vs LEGACY DISTINCTION IS IMPLICIT, EXPRESSED ONLY BY NULL.
  // There is no generation/version marker column, and none is added here.
  //   - MODERN items (created by the report route as it stands today) always
  //     have all four values populated — the route validates the category
  //     before it writes, so a locked fee is always computable.
  //   - LEGACY / UNLOCKED items are simply those where these columns are
  //     NULL (they were reported before the locking existed). They are still
  //     fully usable: the money paths fall back to the shares/fee of the
  //     item's CURRENT category (`items.category_id`) at settlement, refund
  //     and reconciliation time.
  // This comment documents an existing convention. It is NOT a constraint
  // (the columns stay nullable), NOT a migration, NOT a new column, and it
  // does not change any fallback semantics — `locked_total_fee IS NULL`
  // merely remains the way the code recognises the legacy path.
  locked_total_fee: numeric("locked_total_fee", { precision: 10, scale: 2 }),
  locked_finder_share: numeric("locked_finder_share", { precision: 10, scale: 2 }),
  locked_agent_share: numeric("locked_agent_share", { precision: 10, scale: 2 }),
  locked_platform_share: numeric("locked_platform_share", { precision: 10, scale: 2 }),
  agent_assignment_method: varchar("agent_assignment_method", { length: 30 }),
  agent_assignment_distance_km: numeric("agent_assignment_distance_km", { precision: 8, scale: 2 }),
  needs_manual_agent_reassignment: boolean("needs_manual_agent_reassignment").default(false).notNull(),
  finder_email: varchar("finder_email", { length: 255 }),
  // Optional replacement-value estimate the finder can supply at report time.
  // Used only as an input to the Recovery Fee Engine's ceiling calculation
  // (fee never exceeds ceiling_percent of this figure) — never treated as a
  // verified valuation, and never shown to the owner as a claim of fact.
  declared_value: numeric("declared_value", { precision: 12, scale: 2 }),
  fee_ceiling_applied: boolean("fee_ceiling_applied").default(false).notNull(),
  // --- AGENT VERIFICATION (kept fully separate from the Finder's original
  // submission above — ocr_extracted_name/ocr_extracted_number/description/
  // location_description are NEVER overwritten by an Agent correction, so
  // the original Finder data always remains intact for audit purposes).
  // Every individual field-level change is additionally recorded in
  // item_verification_changes with a reason. These verified_* fields hold
  // the CURRENT agent-confirmed value, and db.recordItemVerification()
  // populates ALL of them on every successful verification (a field the
  // Agent did not correct keeps the Finder's value; a genuinely absent value
  // is stored as null, which is the final answer, not a "not yet verified"
  // signal — `verification_status` is what says whether verification ran).
  //
  // WHICH CONSUMER READS WHICH COLUMN (there is no shared resolver helper):
  //   - verified_name / verified_document_number / verified_found_area /
  //     verified_description are consumed by PublicRecognitionService
  //     (services/publicRecognition.ts, buildSafePublicClues). It reads them
  //     WITHOUT falling back to the raw Finder fields: it refuses to run at
  //     all unless verification_status is 'confirmed_as_reported' or
  //     'corrected'.
  //   - verified_category_id is NOT read by PublicRecognitionService at all.
  //     Its only production consumer is the lost-report matcher
  //     (services/lostReportMatching.ts, effectiveItemCategoryId), which
  //     prefers it over `category_id` for the category-match gate and the
  //     document-type corroboration signal.
  //   - the lost-report matcher additionally reads verified_found_area /
  //     verified_description / verified_name, each preferring the verified
  //     value and falling back to the Finder field when it is null.
  // See database.ts recordItemVerification and the comment on the FoundItem
  // type's verified_* fields.
  verified_category_id: varchar("verified_category_id", { length: 50 }).references(() => categories.id),
  verified_name: varchar("verified_name", { length: 150 }),
  verified_document_number: varchar("verified_document_number", { length: 100 }),
  verified_description: text("verified_description"),
  verified_found_area: varchar("verified_found_area", { length: 200 }),
  // pending: Agent hasn't reviewed yet. confirmed_as_reported: Agent
  // reviewed and the Finder's data was accurate as-is. corrected: Agent
  // changed one or more fields (see item_verification_changes for which).
  // Physical verification and approval are separate, later steps — see
  // physically_verified_at / status='at_agent' below.
  verification_status: varchar("verification_status", { length: 30 }).default("pending").notNull(),
  physically_verified_at: timestamp("physically_verified_at", { withTimezone: true }),
  // --- B13: FOUND-ITEM WITHDRAWAL FOUNDATION --------------------------------
  // Batch 0 adds the audit fields only. No workflow reads them yet.
  //
  // WHY THESE EXIST: locked decision B13 requires that a Finder be able to
  // WITHDRAW a reported item under control — explicitly "withdrawal, not
  // deletion" — that the reason be recorded simply, that matching stop "where
  // appropriate", and that affected parties be notified where material. None of
  // that is expressible today: `status` is a custody lifecycle whose CHECK
  // constraint means nothing here, and `updated_at` records neither actor nor
  // reason.
  //
  // WHY NO NEW `status` VALUE: B13 deliberately splits withdrawal into cases
  // (before verification vs after a claim exists), and those cases map onto
  // DIFFERENT existing statuses or onto an admin/agent decision. Choosing the
  // vocabulary now would pre-empt that workflow and would require widening the
  // `items_status_check` constraint in three synchronised places. The audit
  // fields below are sufficient for the workflow to be built on without
  // touching that constraint — that change belongs to the batch that actually
  // implements withdrawal, with its transition rules decided first.
  //
  // Same shape and same reasoning as B12 on `lost_reports`: timestamp + actor +
  // reason, never a broad `deleted` flag. NULL on every historical row, which is
  // correct because those items were never withdrawn. The row and all
  // verification/claim history are untouched — this is not an erasure.
  withdrawn_at: timestamp("withdrawn_at", { withTimezone: true }),
  withdrawn_by: varchar("withdrawn_by", { length: 100 }),
  withdrawal_reason: text("withdrawal_reason"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => {
  return {
    idx_items_doc_hash: index("idx_items_doc_hash").on(table.document_number_hash),
    idx_items_agent: index("idx_items_agent").on(table.assigned_agent_id),
    // Added alongside getItemsByStatus() in database.ts — the public
    // search route now runs `WHERE status = 'at_agent'` on every request,
    // and without an index this is a full table scan on exactly the
    // column the highest-traffic query in the app filters on.
    idx_items_status: index("idx_items_status").on(table.status),
    // Added alongside getItemsByFinderPhone() in database.ts — called on
    // every item report submission (POST /api/items/report) to compute
    // phone reputation, and without an index this is a full table scan on
    // exactly the column that query filters on.
    idx_items_finder_phone: index("idx_items_finder_phone").on(table.finder_phone),
  };
});

// 4. CLAIMS TABLE
export const claims = pgTable("claims", {
  id: varchar("id", { length: 50 }).primaryKey(),
  item_id: varchar("item_id", { length: 50 }).references(() => items.id, { onDelete: "cascade" }),
  owner_phone: varchar("owner_phone", { length: 15 }).notNull(),
  security_answers: jsonb("security_answers").notNull(),
  verification_tier: integer("verification_tier").default(1).notNull(),
  status: varchar("status", { length: 30 }).default("pending_verification").notNull(),
  owner_id_proof_url: text("owner_id_proof_url"),
  // ---------------------------------------------------------------------
  // PAYMENT TRUTH (SC-4 / SC-6 remediation)
  // ---------------------------------------------------------------------
  // `payment_reference` carries the PROVIDER's reference for a transfer
  // (Daraja/M-Pesa receipt, or the provider invoice id). It is NOT, and must
  // never be treated as, proof that money was received: it is written on
  // payment INITIATION by the legacy /pay route and was previously also
  // written with a non-payment rejection MESSAGE by the auto-reject loop.
  //
  // `paid_at` is the authoritative "money was actually received" marker:
  //   NULL     = no authoritative confirmation (never attempted, abandoned,
  //              still in flight, failed, or ambiguous provider outcome)
  //   non-NULL = the claim's payment was confirmed by the SINGLE guarded
  //              confirmation point — attemptClaimEscrowHold()'s
  //              UPDATE ... WHERE status = 'pending_payment' CAS
  //
  // Set ONLY inside that CAS. Never set on initiation, on failure, on
  // abandonment, on an unknown/ambiguous outcome, or from any client input.
  // See resolveDispute()/adminSafeViews.ts, which read this (never
  // payment_reference) to decide refund obligations.
  paid_at: timestamp("paid_at", { withTimezone: true }),
  payment_reference: varchar("payment_reference", { length: 50 }),
  owner_identifying_details: text("owner_identifying_details"),
  owner_email: varchar("owner_email", { length: 255 }),
  agent_confirmed_at: timestamp("agent_confirmed_at", { withTimezone: true }),
  // Evidentiary photo taken by the agent at the moment of physical handover
  // (the claimant holding the item alongside their own ID, or similar) —
  // this is the platform's main defense against agent/claimant collusion:
  // it creates a permanent, timestamped record tying a specific person to a
  // specific handover, which a colluding agent has to actively fabricate or
  // skip, rather than simply clicking a button with nothing on record.
  handover_photo_url: varchar("handover_photo_url", { length: 500 }),
  // Set the moment the claim enters 'pending_settlement' (handover physically
  // confirmed, escrow not yet paid out). The settlement sweep only releases
  // funds once now() >= settle_at, giving a dispute window during which a
  // second claimant or an admin can freeze the payout before money moves.
  settle_at: timestamp("settle_at", { withTimezone: true }),
  // Set the first time POST /api/claims/:id/rate succeeds for this claim —
  // see the comment on the Claim interface field of the same name in
  // database.ts.
  agent_rated_at: timestamp("agent_rated_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => {
  return {
    idx_claims_item: index("idx_claims_item").on(table.item_id),
    // Belt-and-braces against the check-then-insert race in the claim
    // submission route: two nearly-simultaneous requests could both read
    // "no active claim exists yet" before either commits. The application
    // check (src/server.ts /api/claims/submit) is the primary UX path — this
    // partial unique index is the actual guarantee.
    //
    // SC-7: the predicate is now GENERATED from the single canonical export
    // (CLAIM_SLOT_EXCLUDED_STATUSES in config/claimStatuses.ts) instead of
    // being hand-copied here, in sql/schema.sql and in db/index.ts. Those three
    // copies had no source of truth, so adding a status could silently drift
    // them apart. `disputed` and `refunding` are excluded because a dispute
    // legitimately puts TWO claims on one item and a refunding loser coexists
    // with the winner; forcing this set to equal INACTIVE_CLAIM_STATUSES would
    // break filing a dispute outright. A test pins all three declarations to
    // the config export.
    uq_claims_one_active_per_item: uniqueIndex("uq_claims_one_active_per_item")
      .on(table.item_id)
      .where(sql`${table.status} NOT IN (${sql.raw(CLAIM_SLOT_EXCLUDED_SQL_LIST)})`),
  };
});

// 5. DISPUTES TABLE
export const disputes = pgTable("disputes", {
  id: varchar("id", { length: 50 }).primaryKey(),
  item_id: varchar("item_id", { length: 50 }).references(() => items.id, { onDelete: "cascade" }),
  claimant_1_claim_id: varchar("claimant_1_claim_id", { length: 50 }).references(() => claims.id),
  claimant_2_claim_id: varchar("claimant_2_claim_id", { length: 50 }).references(() => claims.id),
  claimant_1_id_proof_url: text("claimant_1_id_proof_url").notNull(),
  claimant_2_id_proof_url: text("claimant_2_id_proof_url").notNull(),
  resolved_by: varchar("resolved_by", { length: 50 }),
  resolved_claim_id: varchar("resolved_claim_id", { length: 50 }).references(() => claims.id),
  resolved_at: timestamp("resolved_at", { withTimezone: true }),
  admin_notes: text("admin_notes"),
  // ---------------------------------------------------------------------
  // DISPUTE SNAPSHOT (SC-3 remediation)
  // ---------------------------------------------------------------------
  // createDispute() unconditionally overwrites BOTH participants' status to
  // 'disputed'. That erased their prior lifecycle position, forcing
  // resolveDispute() to reconstruct "had this claimant actually paid?" from
  // the claim row AFTER it had been overwritten — which is exactly how the
  // SC-4 payment_reference overload became a money-safety bug.
  //
  // These columns capture each participant's state as it was immediately
  // BEFORE the dispute was filed, so resolution can decide the winner's
  // target state and the loser's refund obligation from the historical truth
  // rather than by inference. Semantics are unchanged and deliberate:
  //   claimant_1 = the original/pre-existing claim
  //   claimant_2 = the contesting/new claim
  claimant_1_status_at_dispute: varchar("claimant_1_status_at_dispute", { length: 30 }),
  claimant_2_status_at_dispute: varchar("claimant_2_status_at_dispute", { length: 30 }),
  claimant_1_paid_at_dispute: timestamp("claimant_1_paid_at_dispute", { withTimezone: true }),
  claimant_2_paid_at_dispute: timestamp("claimant_2_paid_at_dispute", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => {
  return {
    // Application-level checks (canCreateClaim's getDisputesByItem query)
    // narrow the window but can't close it entirely — two nearly-
    // simultaneous claim submissions could both pass that check before
    // either commits. This partial unique index is the actual guarantee:
    // at most one row per item_id where resolved_at IS NULL, enforced by
    // Postgres itself.
    uq_disputes_one_unresolved_per_item: uniqueIndex("uq_disputes_one_unresolved_per_item")
      .on(table.item_id)
      .where(sql`${table.resolved_at} IS NULL`),
  };
});

// 5b. DISPUTE EVIDENCE TABLE
// Lets either claimant in a dispute submit their own supporting evidence
// (a photo, a text explanation, or both) for the admin to weigh during
// resolution — previously the admin had only the claim data itself and
// their own notes field to go on.
export const dispute_evidence = pgTable("dispute_evidence", {
  id: varchar("id", { length: 40 }).primaryKey(),
  dispute_id: varchar("dispute_id", { length: 40 }).references(() => disputes.id),
  claim_id: varchar("claim_id", { length: 50 }).references(() => claims.id),
  submitted_by_phone: varchar("submitted_by_phone", { length: 20 }).notNull(),
  evidence_text: text("evidence_text"),
  evidence_photo_url: text("evidence_photo_url"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// 6. LEDGER TABLE
export const ledger = pgTable("ledger", {
  id: varchar("id", { length: 50 }).primaryKey(),
  claim_id: varchar("claim_id", { length: 50 }).references(() => claims.id),
  item_id: varchar("item_id", { length: 50 }).references(() => items.id),
  type: varchar("type", { length: 30 }).notNull(),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  phone_or_till: varchar("phone_or_till", { length: 30 }).notNull(),
  status: varchar("status", { length: 20 }).default("pending").notNull(),
  // Per-transaction provider reconciliation. A batch payout API call
  // (IntaSend send-money) can partially succeed — one recipient's transfer
  // going through while another fails — so each ledger row needs its own
  // provider identity and status, not just the internal 'status' above
  // driven by the batch HTTP response. provider_batch_id groups rows sent
  // in the same API call; provider_transaction_id is that specific
  // recipient's own transaction reference, used to reconcile a later
  // webhook/status callback back to the correct ledger row.
  provider_batch_id: varchar("provider_batch_id", { length: 100 }),
  provider_transaction_id: varchar("provider_transaction_id", { length: 100 }),
  failure_reason: text("failure_reason"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// 7. AUDIT LOG TABLE
export const audit_log = pgTable("audit_log", {
  id: varchar("id", { length: 50 }).primaryKey(),
  admin_user: varchar("admin_user", { length: 100 }).notNull(),
  action: varchar("action", { length: 150 }).notNull(),
  details: text("details").notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// 8. PHONE REPUTATION STATE
export const phone_reputations = pgTable("phone_reputations", {
  phone_number: varchar("phone_number", { length: 15 }).primaryKey(),
  is_cleared: boolean("is_cleared").default(false).notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// 9. CLAIM PAYMENT STRIKES
export const claim_payment_strikes = pgTable("claim_payment_strikes", {
  phone_number: varchar("phone_number", { length: 15 }).primaryKey(),
  strike_count: integer("strike_count").default(0).notNull(),
  last_strike_at: timestamp("last_strike_at", { withTimezone: true }),
  is_cleared_by_admin: boolean("is_cleared_by_admin").default(false).notNull(),
  // --- A1 LEGACY BASELINE (Batch 0A remediation) ------------------------------
  //
  // WHY THIS EXISTS — the double-counting problem, stated precisely:
  //   `strike_count` and `last_strike_at` are BOTH overwritten by every new
  //   strike. So after one post-migration strike, `strike_count` no longer tells
  //   you how many strikes were PRE-migration, and `last_strike_at` no longer
  //   marks when the legacy ones happened. Adding `strike_count` to the count of
  //   active individual records would therefore count that one strike twice.
  //   And simply ignoring the aggregate once any individual record exists (the
  //   earlier XOR attempt) was worse: it made 3 legacy strikes VANISH the moment
  //   a single new strike was added, which contradicts the locked decision that
  //   the legacy component survives for its own 5-day window.
  //
  // THE SOLUTION — freeze the legacy state once, then leave it alone:
  //   On the FIRST post-migration strike for a phone, the pre-increment
  //   `strike_count` and the pre-write `last_strike_at` are copied here. These
  //   two columns are written exactly ONCE per phone and are never touched again,
  //   so they are an immutable snapshot of the legacy/transition component. The
  //   active gate then computes:
  //
  //       active = legacyComponent + activeIndividualRecords
  //
  //   where legacyComponent is derived from THIS snapshot (never from the
  //   moving `strike_count`), which makes double-counting impossible rather
  //   than merely unlikely.
  //
  // NULL MEANS "this row was never touched post-migration" — i.e. it is pure
  // legacy, and `strike_count`/`last_strike_at` are themselves still the
  // authoritative snapshot. Both states therefore produce a correct legacy
  // component, so no backfill is required and no historical value is invented.
  legacy_strike_count: integer("legacy_strike_count"),
  // Frozen copy of last_strike_at as it stood at the first post-migration
  // strike. The legacy 5-day window is measured from THIS, never from
  // `last_strike_at`, which keeps moving as new strikes arrive.
  legacy_last_strike_at: timestamp("legacy_last_strike_at", { withTimezone: true }),
  // A1 REMEDIATION — durable legacy-clear marker.
  //
  // WHY A NEW COLUMN: `is_cleared_by_admin` alone cannot record that the LEGACY
  // component was cleared. recordPaymentStrike() must keep that column FALSE for
  // a phone with no history (so a genuinely-cleared phone is not re-restricted),
  // but it also needs the aggregate row to stay marked as cleared after an admin
  // clears a legacy phone and the user later strikes again. Resetting the flag
  // on every strike silently REACTIVATED a frozen legacy baseline — an admin
  // clear would be undone by the customer's next strike.
  //
  // So the clear is recorded HERE, permanently, separately from the legacy
  // baseline itself. The baseline columns are frozen and never rewritten; this
  // marker suppresses them once, forever, and no later strike can clear it.
  // NULL = never administratively cleared (the normal case).
  legacy_cleared_at: timestamp("legacy_cleared_at", { withTimezone: true }),
});

// 9b. CLAIM PAYMENT STRIKE RECORDS (individual, per-strike) — A1
//
// WHY THIS TABLE EXISTS
//   Locked decision A1 requires that each payment strike expire INDIVIDUALLY
//   five days after it was recorded, that historical strikes remain available
//   for audit, and that the >=3 restriction eventually count only
//   active/non-expired strikes.
//
//   `claim_payment_strikes` (above) cannot express that. It is an AGGREGATE:
//   one row per phone holding a running counter plus a single `last_strike_at`.
//   A counter plus one timestamp cannot tell you WHEN any individual strike
//   occurred, so it can neither expire strikes one at a time nor answer an
//   audit question about a specific strike. Decrementing `strike_count` on
//   expiry would destroy exactly the history A1 requires us to keep.
//
// WHAT THIS TABLE IS
//   The normalized form: one row per strike, each with its own `created_at`
//   and its own `expires_at`. Rows are never deleted on expiry — expiry is a
//   property of `expires_at`, so an expired strike is still a full audit
//   record. Administrator override is representable per strike via
//   `is_cleared_by_admin`.
//
//   THIS TABLE IS ADDITIVE AND UNUSED BY BUSINESS LOGIC IN THIS BATCH.
//   `recordPaymentStrike()`, `getPaymentStrikeCount()`, `clearPaymentStrikes()`
//   and the >=3 gate in routes/claims.ts are all UNCHANGED and still read the
//   aggregate table, so no existing behaviour moves. A later batch wires the
//   new records in once the gate can count active strikes correctly.
//
// HISTORICAL DATA / BACKFILL LIMITATION (documented deliberately)
//   There is NO backfill from the aggregate table, and that is intentional.
//   For a legacy row with `strike_count = 3` and `last_strike_at = T`, the
//   individual timestamps of those three strikes are NOT recoverable: the
//   aggregate never stored them. Manufacturing three rows — all stamped T, or
//   spread backwards on an invented cadence — would fabricate audit data and
//   would silently reinterpret history. Instead:
//     * the aggregate row is left untouched and remains the record of every
//       strike that predates this table;
//     * this table starts empty and holds only strikes recorded after the
//       migration, each with a genuine `created_at`;
//     * a later batch must therefore treat pre-migration strikes as
//       "legacy aggregate" and decide explicitly how they interact with the
//       5-day rolling window. That decision is a product call, not a schema
//       call, and is deliberately NOT pre-empted here.
export const claim_payment_strike_records = pgTable("claim_payment_strike_records", {
  id: varchar("id", { length: 50 }).primaryKey(),
  phone_number: varchar("phone_number", { length: 15 }).notNull(),
  // Genuine per-strike creation time. NEVER backfilled or invented.
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  // A1: individual 5-day expiry, INDEPENDENT of every other strike on the same
  // phone. NULL means "no automatic expiry" and is used only for rows that
  // predate the decision or are deliberately exempted. Distinct from
  // `claim_payment_strikes.last_strike_at` (an aggregate watermark) and from
  // anything in the payment/claim lifecycle.
  expires_at: timestamp("expires_at", { withTimezone: true }),
  // A1: Administrator override, per strike rather than per phone.
  is_cleared_by_admin: boolean("is_cleared_by_admin").default(false).notNull(),
  cleared_at: timestamp("cleared_at", { withTimezone: true }),
  cleared_by_admin: varchar("cleared_by_admin", { length: 100 }),
  // Provenance: the claim whose payment-window expiry produced this strike,
  // when known. Nullable — a strike recorded by a sweep that raced another
  // instance may not resolve one.
  source_claim_id: varchar("source_claim_id", { length: 50 }),
}, (table) => {
  return {
    // The active-strike count for the >=3 gate will read every unexpired,
    // uncleared row for one phone, so both columns are indexed.
    idx_strike_records_phone: index("idx_claim_strike_records_phone").on(table.phone_number),
    idx_strike_records_expires: index("idx_claim_strike_records_expires").on(table.expires_at),
  };
});

// 10. ADMIN USERS TABLE
export const admin_users = pgTable("admin_users", {
  id: varchar("id", { length: 40 }).primaryKey(),
  username: varchar("username", { length: 50 }).notNull().unique(),
  password_hash: varchar("password_hash", { length: 255 }).notNull(),
  full_name: varchar("full_name", { length: 100 }).notNull(),
  is_active: boolean("is_active").default(true).notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  last_login_at: timestamp("last_login_at", { withTimezone: true }),
  // Admin 2FA (TOTP). totp_secret is null until the admin completes
  // enrollment; totp_enabled stays false until they've confirmed a real
  // code against it, so a half-finished enrollment can never accidentally
  // lock an admin out. Existing admin accounts are unaffected (both
  // columns default to "not enrolled") — 2FA is additive, not retroactively
  // enforced, so this can't lock anyone out of an account that already
  // exists today.
  //
  // totp_secret holds the ACTIVE enrolled secret, encrypted at rest with
  // AES-256-GCM (see src/services/totpCrypto.ts). It is the only secret used to
  // verify codes at login, and it changes only when a NEW enrollment is
  // confirmed.
  totp_secret: varchar("totp_secret", { length: 255 }),
  totp_enabled: boolean("totp_enabled").default(false).notNull(),
  // STAGED ENROLLMENT SECRET. A freshly generated secret lives here — encrypted
  // exactly like totp_secret — between /setup and /confirm. It is deliberately a
  // SEPARATE column from totp_secret so that:
  //   * an already-ENABLED account starting a re-enrollment keeps its active
  //     secret (and totp_enabled = true) untouched until the new secret is
  //     confirmed — a stolen session can never silently downgrade or replace
  //     live 2FA just by calling /setup;
  //   * the active secret can never be mistaken for an unconfirmed one.
  // totp_pending_created_at lets an abandoned setup be recognised (and safely
  // superseded by a later /setup) without affecting the active secret. Both are
  // NULL unless an enrollment is in flight.
  totp_pending_secret: varchar("totp_pending_secret", { length: 255 }),
  totp_pending_created_at: timestamp("totp_pending_created_at", { withTimezone: true }),
  // Session-revocation mechanism (P0): a JWT proves it was validly signed
  // and hasn't expired, but says nothing about whether the account it
  // names should still be trusted *right now*. Every admin JWT embeds the
  // token_version that was current at issuance time; every admin route
  // re-checks it against the account's current value on each request (see
  // requireCurrentAdminSession in server.ts). Bumping this value (e.g. on
  // 2FA being disabled, or any other future "something security-sensitive
  // changed" event) immediately invalidates every previously-issued token
  // for this account, even ones that haven't expired yet — deliberately a
  // version counter rather than a boolean, so that later re-enabling
  // whatever triggered the bump does NOT retroactively revalidate old
  // tokens; only a fresh login (which reads the current version) does.
  token_version: integer("token_version").default(1).notNull(),
});

// 10b. ADMIN 2FA RECOVERY CODES
// A fixed set of single-use codes issued when an administrator confirms 2FA
// enrollment, so losing the authenticator device is never a permanent lockout.
// Only a bcrypt hash of each code is stored (never plaintext); the plaintext is
// returned to the administrator exactly once, on the confirmation response. Each
// row is consumed at most once — redemption is an atomic compare-and-swap on
// used_at (see db.consumeAdminRecoveryCode), so a code can never be replayed even
// under concurrent requests. A fresh enrollment replaces the whole set, and
// disabling 2FA deletes it (admin_id FK), so stale codes can never outlive the
// enrollment they were issued for.
export const admin_recovery_codes = pgTable("admin_recovery_codes", {
  id: varchar("id", { length: 40 }).primaryKey(),
  admin_id: varchar("admin_id", { length: 40 }).notNull().references(() => admin_users.id, { onDelete: "cascade" }),
  code_hash: varchar("code_hash", { length: 255 }).notNull(),
  // NULL = unused and still redeemable. Timestamp = consumed at that moment.
  used_at: timestamp("used_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => {
  return {
    idx_admin_recovery_codes_admin: index("idx_admin_recovery_codes_admin").on(table.admin_id),
  };
});

// 11. OTP CODES TABLE
// Persisted (not in-memory) so OTPs survive server restarts/redeploys and the
// app can safely run more than one server process. Only a salted HMAC hash of
// the code is stored, never the plaintext code itself.
export const otp_codes = pgTable("otp_codes", {
  phone_number: varchar("phone_number", { length: 20 }).primaryKey(),
  code_hash: varchar("code_hash", { length: 64 }).notNull(),
  expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
  attempts: integer("attempts").default(0).notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// 13. CLAIM OTPS TABLE
// Second-factor OTP tied to a specific claim (Tier 2 verification), kept
// separate from phone-level login OTPs. Was previously an in-memory Map —
// moved to the database for the same reason as otp_codes: survive restarts
// and support more than one server instance.
export const claim_otps = pgTable("claim_otps", {
  claim_id: varchar("claim_id", { length: 50 }).primaryKey().references(() => claims.id, { onDelete: "cascade" }),
  code_hash: varchar("code_hash", { length: 64 }).notNull(),
  expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
  attempts: integer("attempts").default(0).notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
});
// A genuinely secret, single-use code generated once a claim's payment is
// confirmed (escrow_held), sent privately to the owner via SMS/email, and
// required from the agent at /api/agents/confirm-handover before payout is
// released. This is distinct from the item's drop-off code (its public ID,
// which is also broadcast on social media) — that code proves nothing about
// who is standing in front of the agent, so it cannot be used as a handover
// check. Only the hash is stored.
export const claim_pickup_codes = pgTable("claim_pickup_codes", {
  claim_id: varchar("claim_id", { length: 50 }).primaryKey().references(() => claims.id, { onDelete: "cascade" }),
  code_hash: varchar("code_hash", { length: 64 }).notNull(),
  verified_at: timestamp("verified_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// A short-lived, single-use authorization token minted the moment an agent
// physically confirms the owner in person (POST /api/agents/claims/:id/
// confirm-viewing, the transition into 'pending_payment') and required by
// POST /api/claims/:id/pay before it will trigger a real M-Pesa STK push.
// Before this table existed, /pay's only gate was the claim's `status`
// column plus a claim-ID rate limiter — meaning anyone who obtained/
// guessed a claim ID sitting in 'pending_payment' could initiate a
// payment prompt for it with no proof they were the person the agent had
// just verified in person. Kept in its own table (not a column on
// `claims`) for the same reason claim_otps/claim_pickup_codes are:
// `claims` rows flow through several `res.json({ claim })` response
// paths across the codebase, and a secret hash has no business being on
// an object that gets serialized that broadly. Only the hash is stored;
// the raw token is returned once, directly to the agent-confirm response,
// and is expected to be carried forward by the frontend (the owner is
// physically at the agent's terminal at this point in the resumable-
// session flow) into the payment step.
export const claim_payment_auth = pgTable("claim_payment_auth", {
  claim_id: varchar("claim_id", { length: 50 }).primaryKey().references(() => claims.id, { onDelete: "cascade" }),
  token_hash: varchar("token_hash", { length: 64 }).notNull(),
  expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// 6b. PAYMENT SESSIONS TABLE
// See the narrative on the payment-session endpoints in server.ts. A single
// claim may have at most one active (non-terminal) session at a time.
export const payment_sessions = pgTable("payment_sessions", {
  id: varchar("id", { length: 64 }).primaryKey(),
  claim_id: varchar("claim_id", { length: 50 }).references(() => claims.id, { onDelete: "cascade" }),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  currency: varchar("currency", { length: 3 }).default("KES").notNull(),
  payer_phone: varchar("payer_phone", { length: 20 }),
  method: varchar("method", { length: 20 }).default("mpesa_stk").notNull(),
  status: varchar("status", { length: 30 }).default("created").notNull(),
  provider_invoice_id: varchar("provider_invoice_id", { length: 100 }),
  provider_reference: varchar("provider_reference", { length: 100 }),
  failure_reason: text("failure_reason"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
  confirmed_at: timestamp("confirmed_at", { withTimezone: true }),
}, (table) => {
  return {
    idx_payment_sessions_claim: index("idx_payment_sessions_claim").on(table.claim_id),
    uq_payment_sessions_provider_invoice: uniqueIndex("uq_payment_sessions_provider_invoice")
      .on(table.provider_invoice_id)
      .where(sql`provider_invoice_id IS NOT NULL`),
  };
});

// Small generic key/value store for platform-wide toggles that need to
// persist across server restarts and be flippable at runtime by an admin —
// currently just the social-media publishing emergency stop
// (SOCIAL_PUBLISHING_PAUSED). Deliberately a plain key/value table rather
// than a dedicated boolean column somewhere, since this is exactly the kind
// of rarely-added, admin-toggleable flag that doesn't warrant its own
// migration every time a new one is needed.
export const platform_settings = pgTable("platform_settings", {
  key: varchar("key", { length: 100 }).primaryKey(),
  value: text("value").notNull(),
  updated_by: varchar("updated_by", { length: 100 }),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// Durable, idempotent tracking for social media publication. The actual
// guarantee this provides: at most ONE row ever exists per (item_id,
// platform, publication_type) — enforced by the unique index below, not
// just an application-level check — so a retry, a duplicate request, or a
// server restart mid-broadcast can never produce a duplicate post. The
// first caller to successfully insert a row "claims" the right to attempt
// that specific post; every other caller (including a genuine concurrent
// race) gets a constraint violation and skips, because the claim already
// exists. See claimSocialPublicationSlot / recordSocialPublicationResult
// in database.ts.
export const social_publications = pgTable("social_publications", {
  id: varchar("id", { length: 50 }).primaryKey(),
  item_id: varchar("item_id", { length: 50 }).notNull().references(() => items.id, { onDelete: "cascade" }),
  platform: varchar("platform", { length: 20 }).notNull(),
  publication_type: varchar("publication_type", { length: 30 }).notNull(),
  status: varchar("status", { length: 20 }).default("pending").notNull(),
  provider_post_id: varchar("provider_post_id", { length: 200 }),
  last_error: text("last_error"),
  attempt_count: integer("attempt_count").default(1).notNull(),
  next_attempt_at: timestamp("next_attempt_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  completed_at: timestamp("completed_at", { withTimezone: true }),
}, (table) => {
  return {
    uq_social_pub_item_platform_type: uniqueIndex("uq_social_pub_item_platform_type")
      .on(table.item_id, table.platform, table.publication_type),
  };
});

// Field-level audit trail for every Agent correction to a Finder's
// original submission. One row per changed field, not per verification
// event — so "what did the Agent change, on which field, and why" is
// individually reconstructable later, not just "something changed."
// Confirming as-reported with no changes creates zero rows here (nothing
// to audit) but still sets items.verification_status =
// 'confirmed_as_reported'.
export const item_verification_changes = pgTable("item_verification_changes", {
  id: varchar("id", { length: 50 }).primaryKey(),
  item_id: varchar("item_id", { length: 50 }).notNull().references(() => items.id, { onDelete: "cascade" }),
  agent_id: varchar("agent_id", { length: 50 }).notNull().references(() => agents.id),
  field_name: varchar("field_name", { length: 50 }).notNull(),
  original_value: text("original_value"),
  verified_value: text("verified_value"),
  reason: varchar("reason", { length: 100 }).notNull(),
  reason_detail: text("reason_detail"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => {
  return {
    idx_item_verification_changes_item: index("idx_item_verification_changes_item").on(table.item_id),
  };
});

// 7. CUSTOMER ACCOUNT FOUNDATION
// A customer account establishes persistent identity/session, separate from
// claim-level ownership evidence (owner_phone, owner_id_proof_url, etc.).
// Registration is phone+name → OTP → verify → active customer. Login is
// phone → OTP → verify → session. National ID is NOT stored here — it remains
// claim-level evidence where the claim process requires it.
export const customers = pgTable("customers", {
  id: varchar("id", { length: 50 }).primaryKey(),
  full_name: text("full_name").notNull(),
  phone: varchar("phone", { length: 20 }).notNull(),
  status: varchar("status", { length: 20 }).default("active").notNull(),
  // N2 — email is NULLABLE AT THE PHYSICAL LEVEL ON PURPOSE: every customer
  // created before this batch came through the SMS-only registration flow and
  // has no email. A NOT NULL column would fail the migration or force a
  // fabricated value into live identity data. Grandfathered rows keep NULL and
  // stay active; the "new registrations must supply an email" rule is an
  // APPLICATION-level check in the N3 registration handler, not a constraint.
  // Normalization contract: the application stores a trimmed, lower-cased
  // address, which makes the partial unique index below case-insensitive in
  // practice. See sql/schema.sql and ensureSchemaUpToDate() for the DDL.
  email: varchar("email", { length: 255 }),
  // NULL = never verified. Timestamp = verified at that moment. A nullable
  // timestamp is used rather than a boolean so there is exactly ONE source of
  // truth and it also records WHEN.
  email_verified_at: timestamp("email_verified_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => {
  return {
    uq_customers_phone: uniqueIndex("uq_customers_phone").on(table.phone),
    idx_customers_status: index("idx_customers_status").on(table.status),
    // PARTIAL unique: two accounts may never share a non-null email, while any
    // number of grandfathered NULL-email accounts remain valid.
    uq_customers_email: uniqueIndex("uq_customers_email")
      .on(table.email)
      .where(sql`${table.email} IS NOT NULL`),
  };
});

// Customer OTP challenges — dedicated table, NOT shared with claim OTPs.
// Stores only a SHA-256 hash of the code, never the plaintext. Purpose-bound
// (registration|login), one-time use, max 5 attempts, 5-minute expiry.
export const customer_otps = pgTable("customer_otps", {
  id: varchar("id", { length: 50 }).primaryKey(),
  customer_id: varchar("customer_id", { length: 50 }).references(() => customers.id, { onDelete: "cascade" }),
  phone: varchar("phone", { length: 20 }).notNull(),
  purpose: varchar("purpose", { length: 20 }).notNull(),
  code_hash: varchar("code_hash", { length: 64 }).notNull(),
  expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
  attempt_count: integer("attempt_count").default(0).notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  used_at: timestamp("used_at", { withTimezone: true }),
}, (table) => {
  return {
    idx_customer_otps_phone_purpose: index("idx_customer_otps_phone_purpose").on(table.phone, table.purpose),
    idx_customer_otps_expires: index("idx_customer_otps_expires").on(table.expires_at),
  };
});

// Customer sessions — only the HASH of the session token is stored.
// Raw token is returned once to the client and never persisted.
export const customer_sessions = pgTable("customer_sessions", {
  id: varchar("id", { length: 50 }).primaryKey(),
  customer_id: varchar("customer_id", { length: 50 }).notNull().references(() => customers.id, { onDelete: "cascade" }),
  token_hash: varchar("token_hash", { length: 64 }).notNull(),
  expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  // Pre-existing inactivity clock. H10 (inactivity timeout) will build on this
  // column; it is NOT new in Batch 0 and its semantics are unchanged.
  last_seen_at: timestamp("last_seen_at", { withTimezone: true }),
  // Pre-existing per-session revocation marker. H9 (individual revoke / sign
  // out all others) will build on this; NULL means "still valid". Revocation
  // sets the timestamp rather than deleting the row, so the session's audit
  // trail survives.
  revoked_at: timestamp("revoked_at", { withTimezone: true }),
  // --- H9 / H10: SESSION DEVICE + ACTIVITY CONTEXT -------------------------
  // Batch 0 foundation for the later session-management work (device/session
  // visibility, last-activity tracking, inactivity timeout, individual
  // revocation, sign-out-all-other-sessions).
  //
  // `last_seen_at` and `revoked_at` ALREADY EXIST above and are what the future
  // features will actually build on: `last_seen_at` is the inactivity clock and
  // `revoked_at` is per-session revocation that leaves the row (and therefore
  // its audit trail) intact. Neither is added or altered here.
  //
  // WHAT IS MISSING TODAY, and why it needs one new column:
  //   A customer-facing "your active sessions" view has to tell the customer
  //   WHICH device a session belongs to. Without any stored request context,
  //   the only honest options are to show nothing, or to guess. Neither is
  //   acceptable, so the raw User-Agent is captured at sign-in.
  //
  // PRIVACY CONSTRAINTS (deliberate, and the reason for the shape below):
  //   - The RAW User-Agent is stored, not a pre-derived "device name". A
  //     derived label would need a device-parsing table and would be wrong for
  //     unusual clients; the customer-facing label is derived at READ time in
  //     the later batch. Storing the raw string keeps that decision reversible.
  //   - NO IP ADDRESS IS STORED, and no column is reserved for one. The
  //     codebase already established the rule it wants to keep: rate-limit
  //     identities are a salted hash precisely so a table does not become a
  //     record of who connected from where. Session rows get the same
  //     treatment. If a later decision genuinely needs coarse geography, it
  //     must arrive as its own decision with its own justification — it is not
  //     pre-empted by an empty column here.
  //   - Truncated to 512 chars: long enough for any real client string, short
  //     enough that the column cannot become an arbitrary payload store.
  // Nullable because sessions created before this column have none. Existing
  // authentication semantics are untouched: token hashing, `expires_at`,
  // `last_seen_at` and `revoked_at` all behave exactly as they did.
  user_agent: varchar("user_agent", { length: 512 }),
}, (table) => {
  return {
    idx_customer_sessions_token: index("idx_customer_sessions_token").on(table.token_hash),
    idx_customer_sessions_customer: index("idx_customer_sessions_customer").on(table.customer_id),
    idx_customer_sessions_expires: index("idx_customer_sessions_expires").on(table.expires_at),
    // H10 inactivity timeout and H9 "revoke every other session" both need
    // "which of this customer's sessions are still live, and how stale is each".
    // (customer_id, last_seen_at) serves both without a partial index.
    idx_customer_sessions_activity: index("idx_customer_sessions_activity").on(table.customer_id, table.last_seen_at),
  };
});

// 8. CUSTOMER ↔ CLAIM LINKS
// An EXPLICIT, per-claim link between an authenticated customer account and a
// claim. Deliberately a join table rather than `claims.customer_id`, so claim
// ownership evidence (owner_phone, security_answers, owner_id_proof_url) stays
// where it is and account identity stays separable from it — the two can be
// created and revoked independently.
//
// A link is NEVER created automatically: not on registration, not on login,
// not because customer.phone happens to equal claim.owner_phone, and never in
// bulk for historical claims. It is created only by an authenticated customer
// who separately proves control of the claim through the existing claim OTP
// plus the claim's stored security answers (see
// POST /api/customer/claims/link/* in server.ts).
//
// TWO database-level invariants, because the application check alone cannot
// survive concurrent requests:
//   uq_customer_claim_links_pair  — the same claim can never be linked to the
//                                   same customer twice (idempotency).
//   uq_customer_claim_links_claim — a claim can belong to AT MOST ONE customer
//                                   account, ever. Without this, two racing
//                                   link requests from two different customers
//                                   (or one customer linking another's claim)
//                                   could both commit.
export const customer_claim_links = pgTable("customer_claim_links", {
  id: varchar("id", { length: 50 }).primaryKey(),
  customer_id: varchar("customer_id", { length: 50 }).notNull().references(() => customers.id, { onDelete: "cascade" }),
  claim_id: varchar("claim_id", { length: 50 }).notNull().references(() => claims.id, { onDelete: "cascade" }),
  linked_at: timestamp("linked_at", { withTimezone: true }).defaultNow(),
  // How the link was proven, for audit/debugging. Currently always
  // 'claim_otp+security_answers'.
  linked_via: varchar("linked_via", { length: 40 }).default("claim_otp").notNull(),
}, (table) => {
  return {
    uq_customer_claim_links_pair: uniqueIndex("uq_customer_claim_links_pair").on(table.customer_id, table.claim_id),
    // The one-customer-per-claim invariant. Also serves reverse lookups.
    uq_customer_claim_links_claim: uniqueIndex("uq_customer_claim_links_claim").on(table.claim_id),
  };
});

// N2. EMAIL ACTIVATION TOKENS (shared by customer and agent accounts).
//
// ONE table, not two: the columns that make a token valid are identical for
// every account kind, and the account_type discriminator is what keeps token
// ownership unambiguous. A polymorphic account_id deliberately has NO foreign
// key — it cannot be one, and a wrong FK would be worse than an
// application-verified reference.
//
// SECURITY: only a SHA-256 hash is persisted. The plaintext exists solely in
// the activation email, so a database leak cannot be replayed into a takeover.
//
// Single-use is enforced at redemption by an atomic compare-and-swap UPDATE
// (consumed_at IS NULL AND expires_at > now()); a "check then update" pair is
// NOT sufficient, because two concurrent redemptions would both pass the check.

// =============================================================================
// BATCH 2 — CUSTOMER IDENTITY CHANGES (G3).
//
// WHY A TABLE RATHER THAN TWO COLUMNS ON `customers`
//   An email or phone change must NOT become authoritative until the customer has
//   proved control of the NEW value. That requires somewhere to hold the claimed
//   value and its unproven state while the old identifier is still fully
//   authoritative — a genuinely new need, not a convenience.
//
//   Storing it on `customers` (pending_email, pending_phone, …) was rejected: it
//   spreads an unverified second identity across the row every read touches, and
//   it makes "is this account verified?" a question with two answers depending on
//   which column a query happened to look at. A separate row per requested change
//   keeps the unproven value out of the authoritative record entirely.
//
// SECURITY
//   `code_hash` holds a SHA-256 hash, never the code itself, mirroring
//   customer_otps and account_activation_tokens. A leaked database cannot be used
//   to complete an identity change.
//
// SINGLE USE AND TIME BOUNDED
//   Redemption is a compare-and-swap on (id, customer_id, consumed_at IS NULL,
//   expires_at > now) for the same reason account_activation_tokens uses one:
//   a check-then-update pair lets two concurrent redemptions both pass.
// =============================================================================
export const customer_identity_changes = pgTable(
  "customer_identity_changes",
  {
    id: varchar("id", { length: 50 }).primaryKey(),
    customer_id: varchar("customer_id", { length: 50 })
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    // Which identifier this change is for. Mirrored by a CHECK below.
    kind: varchar("kind", { length: 10 }).notNull(),
    // The CLAIMED value, stored lower-cased (email) or E.164 (phone) so the
    // uniqueness check is not defeated by casing or formatting.
    target_value: varchar("target_value", { length: 255 }).notNull(),
    // SHA-256 of the one-time code. NEVER the plaintext.
    code_hash: varchar("code_hash", { length: 64 }).notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    // NULL = not yet verified. Set once, atomically, at redemption.
    consumed_at: timestamp("consumed_at", { withTimezone: true }),
    // How many WRONG codes have been presented. Bounded: at
    // IDENTITY_CHANGE_MAX_VERIFICATION_ATTEMPTS the change is burned, so a
    // six-digit space cannot be walked inside the TTL. Bumped atomically.
    attempt_count: integer("attempt_count").notNull().default(0),

    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => {
    return {
      idx_customer_identity_changes_customer: index(
        "idx_customer_identity_changes_customer"
      ).on(table.customer_id, table.kind),
      // Only live rows matter, and they are a small fraction of the table.
      idx_customer_identity_changes_expiry: index("idx_customer_identity_changes_expiry").on(
        table.expires_at
      ),
      customer_identity_changes_kind_check: check(
        "customer_identity_changes_kind_check",
        sql`${table.kind} IN ('email', 'phone')`
      ),
    };
  }
);

export const account_activation_tokens = pgTable("account_activation_tokens", {
  id: varchar("id", { length: 50 }).primaryKey(),
  account_type: varchar("account_type", { length: 20 }).notNull(),
  account_id: varchar("account_id", { length: 50 }).notNull(),
  purpose: varchar("purpose", { length: 32 }).notNull(),
  token_hash: varchar("token_hash", { length: 64 }).notNull(),
  expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumed_at: timestamp("consumed_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => {
  return {
    // The lookup path: given a presented token, find its hash.
    idx_account_activation_tokens_hash: index("idx_account_activation_tokens_hash").on(table.token_hash),
    // "invalidate every outstanding token for this account".
    idx_account_activation_tokens_account: index("idx_account_activation_tokens_account")
      .on(table.account_type, table.account_id, table.purpose),
    // Expiry sweeps.
    idx_account_activation_tokens_expires: index("idx_account_activation_tokens_expires").on(table.expires_at),
    // These two whitelists are declared identically in sql/schema.sql and in
    // ensureSchemaUpToDate(), so Postgres enforces them no matter which path
    // created the database. They stop a token being filed under an undefined
    // account type or purpose and later redeemed as something it was never
    // issued for.
    account_activation_tokens_purpose_check: check(
      "account_activation_tokens_purpose_check",
      sql`${table.purpose} = 'email_activation'`
    ),
    account_activation_tokens_account_type_check: check(
      "account_activation_tokens_account_type_check",
      sql`${table.account_type} IN ('customer', 'agent')`
    ),
  };
});

// N2. NOTIFICATION EVENTS (durable idempotency + delivery audit).
//
// One row per LOGICAL notification, not per provider attempt: a retry reuses
// the row and bumps attempt_count, which is what distinguishes "same event,
// retried" from "new event".
//
// uq_notification_events_idempotency is the load-bearing constraint. Two
// concurrent dispatches of one logical notification race to insert; exactly
// one wins and the other receives a 23505 unique violation it can handle. An
// application-level check alone cannot survive that race, and an in-memory Map
// cannot survive a process restart.
//
// NEVER stores an OTP, pickup code, activation token, payment secret or session
// token. recipient_reference holds an opaque handle (masked address or hash),
// never a credential.
//
// sent_at records PROVIDER ACCEPTANCE, not handset/inbox delivery — those are
// different facts, and conflating them is exactly the false-success this
// architecture exists to prevent.
export const notification_events = pgTable("notification_events", {
  id: varchar("id", { length: 50 }).primaryKey(),
  event_type: varchar("event_type", { length: 64 }).notNull(),
  channel: varchar("channel", { length: 20 }).notNull(),
  provider: varchar("provider", { length: 40 }),
  idempotency_key: varchar("idempotency_key", { length: 255 }).notNull(),
  recipient_reference: varchar("recipient_reference", { length: 255 }).notNull(),
  status: varchar("status", { length: 32 }).default("pending").notNull(),
  provider_message_id: varchar("provider_message_id", { length: 128 }),
  attempt_count: integer("attempt_count").default(0).notNull(),
  last_error: text("last_error"),
  // ---------------------------------------------------------------------------
  // N10-D AUDIT: RESERVED, NOT DEAD CODE — DO NOT DELETE WITHOUT A DECISION.
  //
  // EVIDENCE (audited repo-wide): this column is declared here, in
  // sql/schema.sql and in ensureSchemaUpToDate(), and it is written and read
  // ONLY by src/db/__tests__/notificationSchemaN2.test.ts, which inserts a row
  // directly and reads the self-reference back. NO production writer sets it and
  // NO production reader consumes it.
  //
  // WHY IT IS RETAINED RATHER THAN REMOVED:
  //   1. It is part of the N2 schema CONTRACT: a self-referencing FK to
  //      notification_events(id), declared identically in all three schema
  //      representations. Removing it is a DDL migration, not a cleanup.
  //   2. It is asserted by an existing, passing N2 schema test. Deleting the
  //      column would break that test rather than remove dead code.
  //   3. It is coherent with the status vocabulary this table already admits
  //      ('fallback_available', 'fallback_requested', 'fallback_sent'): it is
  //      the link that would tie a fallback notification back to the delivery
  //      it replaced. The fallback lifecycle is PARTLY implemented, not
  //      abandoned.
  //
  // IT IS NOT THE SAME COLUMN AS `created_via_fallback` on customer_notifications,
  // which IS live (written by recordCustomerNotification, read when rendering).
  // Do not conflate the two when auditing either one.
  // ---------------------------------------------------------------------------
  fallback_of: varchar("fallback_of", { length: 50 }),
  // ---------------------------------------------------------------------------
  // N9. NOTIFICATION FAILURE RECOVERY.
  //
  // Additive and nullable so every historical row stays valid and NOTHING is
  // backfilled or resent. `attempt_count` above is deliberately NOT repurposed:
  // it has always meant "successful provider acceptances" (it is only incremented
  // by markNotificationEventAccepted), and silently redefining it would make
  // historical values ambiguous.
  // ---------------------------------------------------------------------------
  /**
   * The durable domain identifier this notification was created from — a claim
   * id, an item id, a customer id or an agent id.
   *
   * INTERNAL NON-SENSITIVE: these are already primary keys elsewhere in this
   * database. It is NOT a recipient and NOT a credential, and it exists so a
   * retry can re-resolve BOTH the recipient and the content from the
   * authoritative domain record instead of storing either one here. That is what
   * lets N9 retry without ever persisting a plaintext address or a rendered
   * body. NULL for historical rows, which therefore simply are not retryable.
   */
  business_reference: varchar("business_reference", { length: 64 }),
  /**
   * Retry eligibility, decided by policy in config/notificationEvents.ts and
   * frozen onto the row at creation.
   *
   * 'reconstructable' means every field the template needs can be re-derived
   * from domain records. 'not_retryable' means the notification carries a
   * one-time secret (an OTP, a pickup code, an activation token) that is only
   * ever stored as a hash, so re-sending it is impossible and re-minting it
   * would invalidate a code the user may be mid-way through typing.
   */
  retry_class: varchar("retry_class", { length: 32 }),
  /**
   * N9 retry attempts. Counts RETRIES, which is a different fact from
   * `attempt_count` (successful acceptances). Retries are a separate operation
   * from the original dispatch, so they get their own counter rather than
   * overloading the historical one.
   */
  retry_attempt_count: integer("retry_attempt_count").default(0).notNull(),
  /**
   * When a retryable_failure becomes eligible for another attempt. NULL means
   * "not scheduled": never failed, terminal, or a historical row — and the
   * sweep only ever selects rows where this is due, so NULL is what makes
   * legacy rows permanently safe from automatic dispatch.
   */
  next_attempt_at: timestamp("next_attempt_at", { withTimezone: true }),
  /**
   * E1 — ACTIVE-NOTIFICATION EXPIRY. Added by Batch 0 as a data foundation
   * only; nothing reads or writes it yet.
   *
   * WHAT IT IS: the locked 5-day window after which a notification stops being
   * "active" (i.e. no longer something a user-facing Notification History would
   * show as current).
   *
   * WHAT IT IS **NOT**, and must never be conflated with:
   *   - `next_attempt_at` — RETRY SCHEDULING. That is about when a worker may
   *     attempt a redelivery. A notification can have a future
   *     `next_attempt_at` and still be long past its 5-day active window, and
   *     vice versa. Independent facts, independent reasons to exist.
   *   - `sent_at` / `status` — DELIVERY OUTCOME. Provider acceptance is not
   *     receipt, and neither says anything about how long a record stays
   *     relevant to a user.
   *   - `updated_at` — row bookkeeping, changed by the retry sweep.
   *
   * NULL means "no expiry recorded", which is correct for every row that
   * predates this column. Such rows are never expired by any future sweep,
   * which is the safe default: an absent value must not be guessed into a
   * 5-day lookback that could hide an old record.
   *
   * EXPIRY DOES NOT DELETE. A later batch uses this to move a notification out
   * of the ACTIVE view; the row and its `business_reference` remain as the
   * audit record required by the retention decision.
   */
  expires_at: timestamp("expires_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  sent_at: timestamp("sent_at", { withTimezone: true }),
}, (table) => {
  return {
    uq_notification_events_idempotency: uniqueIndex("uq_notification_events_idempotency").on(table.idempotency_key),
    idx_notification_events_type: index("idx_notification_events_type").on(table.event_type),
    idx_notification_events_recipient: index("idx_notification_events_recipient").on(table.recipient_reference),
    idx_notification_events_status: index("idx_notification_events_status").on(table.status),
    idx_notification_events_created: index("idx_notification_events_created").on(table.created_at),
    // N9: the sweep's only access path. A partial index would be smaller, but this
    // table is tiny and a plain composite index keeps the predicate obvious.
    idx_notification_events_retry: index("idx_notification_events_retry").on(table.status, table.next_attempt_at),
    // Declared identically in sql/schema.sql and ensureSchemaUpToDate() so an
    // unknown channel or an undefined lifecycle state can never be recorded.
    notification_events_channel_check: check(
      "notification_events_channel_check",
      sql`${table.channel} IN ('sms', 'email')`
    ),
    // N9 EXTENDED this lifecycle. 'failed' is RETAINED so every historical row
    // stays valid — it means "failed before N9 existed" and is treated as
    // terminal. The N9 states are additive:
    //   sending            — a worker claimed it and is dispatching right now
    //   retryable_failure  — definite failure, reconstructable, due for retry
    //   permanent_failure  — definite failure that will never succeed
    //   unknown            — outcome undeterminable; NEVER auto-retried
    // The pre-existing fallback_* states are retained for backward compatibility
    // and remain unused (no provider or channel fallback exists).
    notification_events_status_check: check(
      "notification_events_status_check",
      sql`${table.status} IN ('pending', 'sending', 'sent', 'failed', 'retryable_failure', 'permanent_failure', 'unknown', 'cancelled', 'fallback_available', 'fallback_requested', 'fallback_sent')`
    ),
  };
});

// =============================================================================
// BATCH 1 — CUSTOMER NOTIFICATION USER LAYER.
//
// WHY THIS IS NOT `notification_events`
//   notification_events is a DELIVERY LEDGER. It has no customer id (only a
//   masked `recipient_reference`), its channel CHECK admits only sms/email, and
//   its rows carry provider names, error strings and retry counters. A customer
//   facing view needs the opposite of all three: customer-keyed rows, an in-app
//   channel, and no delivery internals. Extending the ledger would have meant
//   adding a customer column to it, widening a CHECK that N7/N8 depend on, and
//   projecting around most of every row — so the user layer gets its own tables.
//   The two are related by (event_type, business_reference) and never duplicate
//   delivery state.
//
// EXPIRY: `expires_at` here means exactly what the column Batch 0 added to
//   notification_events means — an ACTIVE-WINDOW boundary, never a retry
//   schedule. Nothing in this layer reads next_attempt_at.
// =============================================================================

/**
 * The customer-visible notification.
 *
 * PERSISTENT BY CONSTRUCTION (requirement 3): read state is a column here, not
 * React state or browser storage, so it survives a new session and a new device.
 *
 * `title` / `body` are plain-language, pre-rendered customer copy. Storing the
 * finished sentence is deliberate: history must still read correctly after the
 * underlying record moves on, and re-deriving wording later could leak a status
 * token into the UI. What is NEVER stored is a provider name, a payload, an
 * error string or an infrastructure identifier — the ledger keeps those.
 */
export const customer_notifications = pgTable(
  "customer_notifications",
  {
    id: varchar("id", { length: 50 }).primaryKey(),
    // NOT NULL, and the basis of every read in this layer: a notification is
    // reachable only through its owner's id, so isolation is enforced by the
    // query shape rather than by hiding a control in the UI.
    customer_id: varchar("customer_id", { length: 50 })
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    // The vocabulary from config/customerNotifications.ts, closed by a CHECK.
    category: varchar("category", { length: 40 }).notNull(),
    title: varchar("title", { length: 160 }).notNull(),
    body: text("body"),
    // STABLE EXISTING reference (a claim id, an item id, a report id) — the same
    // opaque domain id notification_events.business_reference already uses. It is
    // what history shows as the customer's reference and what grouping keys on.
    // It is never rendered as a raw internal identifier.
    business_reference: varchar("business_reference", { length: 64 }),
    // NULL = unread. A timestamp rather than a boolean, so there is one source
    // of truth and it also records WHEN it was read.
    read_at: timestamp("read_at", { withTimezone: true }),
    // ACTIVE-WINDOW boundary. Moves the row out of the active list; does NOT
    // delete it. Explicitly NOT a retry field.
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    // True when this row was written because a DELIVERY fell back to in-app,
    // so the UI can be honest that the message arrived here rather than by text
    // WITHOUT ever surfacing why the other channel failed.
    created_via_fallback: boolean("created_via_fallback").default(false).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => {
    return {
      // The active list is always "this customer, unexpired, newest first".
      idx_customer_notifications_active: index("idx_customer_notifications_active").on(
        table.customer_id,
        table.expires_at
      ),
      idx_customer_notifications_created: index("idx_customer_notifications_created").on(
        table.customer_id,
        table.created_at
      ),
      // Unread counting. Partial, so it holds only unread rows and shrinks to
      // nothing as a customer works through their list.
      idx_customer_notifications_unread: index("idx_customer_notifications_unread")
        .on(table.customer_id, table.created_at)
        .where(sql`${table.read_at} IS NULL`),
      // Mirrored from the closed vocabulary in config/customerNotifications.ts,
      // so an undefined category cannot be recorded by any path.
      customer_notifications_category_check: check(
        "customer_notifications_category_check",
        sql`${table.category} IN ('claim_status', 'payment_status', 'document_verification', 'lost_report', 'found_item_report', 'account_security', 'terms_service')`
      ),
    };
  }
);

/**
 * Per-category, per-channel opt-out (requirement 7).
 *
 * One row per (customer, category, channel). ABSENT ROW = that channel is
 * enabled, which is the safe default: a customer who has never touched
 * preferences must receive everything, and an essential notification can never
 * be lost because a row failed to insert.
 *
 * An explicit DISABLED row is only ever written for an OPTIONAL category. The
 * service refuses to create one for an essential category, and a unique index
 * makes a disabled row unique per customer+category+channel so a concurrent
 * double-submit cannot produce contradictory state.
 */
export const customer_notification_prefs = pgTable(
  "customer_notification_prefs",
  {
    id: varchar("id", { length: 50 }).primaryKey(),
    customer_id: varchar("customer_id", { length: 50 })
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    category: varchar("category", { length: 40 }).notNull(),
    channel: varchar("channel", { length: 20 }).notNull(),
    // The only stored preference is the opt-out. false means enabled.
    disabled: boolean("disabled").default(false).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => {
    return {
      uq_customer_notification_pref: uniqueIndex("uq_customer_notification_pref").on(
        table.customer_id,
        table.category,
        table.channel
      ),
      // Only channels that actually exist. None is offered that the system
      // cannot deliver on.
      customer_notification_prefs_channel_check: check(
        "customer_notification_prefs_channel_check",
        sql`${table.channel} IN ('sms', 'email', 'in_app')`
      ),
      customer_notification_prefs_category_check: check(
        "customer_notification_prefs_category_check",
        sql`${table.category} IN ('claim_status', 'payment_status', 'document_verification', 'lost_report', 'found_item_report', 'account_security', 'terms_service')`
      ),
    };
  }
);

/**
 * Append-only audit of preference changes (requirements 7 and 8).
 *
 * A separate table rather than a column on the pref row, because a pref row is
 * UPDATED in place: overwriting it would erase what the customer had chosen
 * before, which is exactly the history an audit must keep. Every change inserts
 * a row here; none is ever updated or deleted.
 */
export const customer_notification_pref_audit = pgTable(
  "customer_notification_pref_audit",
  {
    id: varchar("id", { length: 50 }).primaryKey(),
    customer_id: varchar("customer_id", { length: 50 })
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    category: varchar("category", { length: 40 }).notNull(),
    channel: varchar("channel", { length: 20 }).notNull(),
    // The value AFTER the change, plus what it was, so the delta is explicit.
    previous_disabled: boolean("previous_disabled"),
    new_disabled: boolean("new_disabled").notNull(),
    // False when the request asked for something not permitted (e.g. disabling an
    // essential channel) and was refused. Recording refusals is what makes the
    // audit meaningful — a silent ignore is indistinguishable from a no-op.
    applied: boolean("applied").default(true).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => {
    return {
      idx_customer_notification_pref_audit: index("idx_customer_notification_pref_audit").on(
        table.customer_id,
        table.created_at
      ),
    };
  }
);
// N6. SMS RATE-LIMIT BUCKETS (durable, true rolling window).
//
// WHY A TABLE RATHER THAN express-rate-limit'S DEFAULT STORE
//   Every limiter in server.ts uses the library's default MemoryStore, which is
//   a process-local Map. That is fine for generic abuse throttling, but it is
//   NOT a production guarantee for SMS: a restart empties it, and N instances
//   behind a load balancer each hold a private counter, so the effective limit
//   is 3 x N and a rolling restart buys an attacker a fresh budget. N6 requires
//   a limit that survives both, so the counter has to be durable and shared.
//
// WHY THREE TIMESTAMP COLUMNS RATHER THAN A COUNTER
//   The requirement is a TRUE ROLLING window — "at most 3 in any 10 minutes" —
//   not a fixed bucket that resets on a clock boundary. A single `count` reset
//   when `window_start + 10min` passes is a tumbling window: a caller can send 3
//   at 10:00:01 and 3 more at 10:10:01, i.e. 6 in two seconds. Storing each
//   hit's own timestamp makes the window genuinely rolling, because a slot frees
//   the instant its own timestamp ages out, independently of any other hit.
//
// WHY THE ADMISSION IS A GUARDED UPDATE AND NOT CHECK-THEN-INSERT
//   `SELECT count() ... if (count < 3) INSERT` is a textbook race: N concurrent
//   requests all read 2 and all insert. The admission decision here is made by
//   ONE statement — an UPDATE whose WHERE clause names the free/stale slot and
//   whose RETURNING tells the caller whether it won. The database, not the
//   application, resolves the race, which is the only property that holds across
//   multiple application instances.
//
// bucket_key is a keyed HASH of the identity, never the raw IP, user id or phone
// number (see buildSmsRateLimitBucketKey). A row therefore supports abuse
// investigation without turning the table into a log of who visited from where.
export const sms_rate_limit_buckets = pgTable("sms_rate_limit_buckets", {
  bucket_key: varchar("bucket_key", { length: 64 }).primaryKey(),
  slot_1_at: timestamp("slot_1_at", { withTimezone: true }),
  slot_2_at: timestamp("slot_2_at", { withTimezone: true }),
  slot_3_at: timestamp("slot_3_at", { withTimezone: true }),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// 9A. LOST-ITEM REPORTS (Phase 9A)
// ================================
// The complement of a found item: a person reports something THEY lost. This is
// its OWN domain object — it is NOT a claim (a claim proves ownership of a
// specific found item and drives the payment/handover lifecycle) and it does
// NOT make any found item visible to the reporter or expose the reporter to a
// finder. It exists so a future matcher (Phase 9B) has a real, safe data set to
// compare found items against.
//
// Defined AFTER `customers` because it references that table.
//
// WHY EACH FIELD EXISTS (nothing speculative is stored here):
//   id                      public reference AND primary key (see
//                           services/lostReportReference.ts — crypto-random,
//                           non-sequential, 'LR-XXXXXX').
//   customer_id             the authenticated reporter. NOT NULL: anonymous
//                           reporting is deliberately NOT supported in Phase 9A,
//                           so there is always a verified account to contact.
//   category_id             references the EXISTING priced category taxonomy —
//                           no duplicate category name is stored.
//   status                  the lost-report lifecycle (config/lostReportStatuses.ts),
//                           a vocabulary provably disjoint from claim AND item
//                           statuses.
//   county / location_area /
//   location_landmark       generalised lost location. `county` is constrained
//                           to the canonical 47 Kenyan counties at the API
//                           boundary (config/kenyaCounties.ts) and stored as
//                           the canonical name; `location_area` is the
//                           reporter's EXACT PLACE — the lost-report "Exact
//                           place" field, free text in the user's own words and
//                           stored verbatim, never parsed into a sub-county,
//                           city, town or ward; `location_landmark` is an
//                           optional free-text landmark. NO GPS coordinates —
//                           the existing product does not require them for a
//                           lost report, and precise location would be
//                           over-collection.
//   lost_at_from /
//   lost_at_to              a TIME WINDOW, not a false-precision timestamp:
//                           "I lost it sometime between 2pm and 5pm" is
//                           lost_at_from=14:00, lost_at_to=17:00.
//   brand / model / colour /
//   material                optional structured identifying attributes. Short,
//                           bounded, non-sensitive; deliberately NOT a generic
//                           JSON blob that could become an uncontrolled bucket.
//   description /
//   distinctive_marks       PRIVATE free text. Returned only to the
//                           authenticated owner; never in any public/finder DTO.
//   document_type           optional non-sensitive classification of a document
//                           or identifier held in the item (e.g. 'national-id',
//                           'passport', 'imei'). A short label only.
//   document_number_hash    the PROTECTED identifier. Hashed with the SAME
//                           services/documentHash.ts primitive (and the same
//                           DOC_HASH_SALT) that found items use, so a future
//                           matcher can compare by exact hash. The plaintext is
//                           NEVER stored and the hash never leaves the server.
export const lost_reports = pgTable("lost_reports", {
  id: varchar("id", { length: 50 }).primaryKey(),
  customer_id: varchar("customer_id", { length: 50 }).notNull().references(() => customers.id, { onDelete: "cascade" }),
  category_id: varchar("category_id", { length: 50 }).notNull().references(() => categories.id),
  status: varchar("status", { length: 30 }).default("active").notNull(),
  county: varchar("county", { length: 50 }).notNull(),
  // Structured second-level geography; nullable so historical reports remain unchanged.
  administrative_unit_id: varchar("administrative_unit_id", { length: 50 }),
  // --- GEO-D+ LOCATION PROVENANCE (foundation only) -------------------------
  // HOW the required county/sub-county above was established. New reports that
  // passed validation are written as 'user_selected'. Nullable and default-less
  // so every pre-GEO-D+ report keeps NULL ("origin unknown"); no backfill.
  location_source: varchar("location_source", { length: 30 }),
  location_area: varchar("location_area", { length: 120 }).notNull(),
  location_landmark: varchar("location_landmark", { length: 160 }),
  lost_at_from: timestamp("lost_at_from", { withTimezone: true }).notNull(),
  lost_at_to: timestamp("lost_at_to", { withTimezone: true }),
  brand: varchar("brand", { length: 100 }),
  model: varchar("model", { length: 100 }),
  colour: varchar("colour", { length: 60 }),
  material: varchar("material", { length: 60 }),
  description: text("description"),
  distinctive_marks: text("distinctive_marks"),
  document_type: varchar("document_type", { length: 50 }),
  document_number_hash: varchar("document_number_hash", { length: 64 }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  // --- B12: LOST-REPORT WITHDRAWAL FOUNDATION --------------------------------
  // Batch 0 adds the audit fields only. No workflow reads them yet.
  //
  // WHY THESE EXIST: locked decision B12 requires that a lost-item report can be
  // CLOSED/WITHDRAWN by its owner, that the operation be reversible in the
  // sense that the record SURVIVES (B12 "preserve history"), and that it leave
  // an audit trail. `status` already carries the business lifecycle, and the
  // existing `updated_at` already records that something changed — neither can
  // record WHO withdrew it, WHEN they were allowed to, or WHY.
  //
  // `withdrawn_at` / `withdrawn_by` are deliberately timestamp-and-actor, NOT a
  // broad `deleted` boolean:
  //   - a boolean would lose the when and the who, which is the whole point;
  //   - it would also imply the row can be erased, and B12 forbids that. The
  //     report stays; it stops being a live report.
  //
  // `withdrawal_reason` is free text because B12 asks for a "simple reason" and
  // specifying an enum here would pre-empt the workflow that consumes it.
  //
  // NULL on every historical row, which is correct: those reports were never
  // withdrawn, they simply pre-date the capability. Existing rows are untouched
  // and remain fully readable and matchable.
  withdrawn_at: timestamp("withdrawn_at", { withTimezone: true }),
  withdrawn_by: varchar("withdrawn_by", { length: 100 }),
  withdrawal_reason: text("withdrawal_reason"),
}, (table) => {
  return {
    // Every owner-scoped read (the only read path that exists) filters on this.
    idx_lost_reports_customer: index("idx_lost_reports_customer").on(table.customer_id),
    // Phase 9B will filter candidates by category first.
    idx_lost_reports_category: index("idx_lost_reports_category").on(table.category_id),
    // Phase 9B will restrict matching to reports still `active`.
    idx_lost_reports_status: index("idx_lost_reports_status").on(table.status),
    // Exact protected-identifier comparison in Phase 9B (mirrors
    // idx_items_doc_hash on found items).
    idx_lost_reports_document_hash: index("idx_lost_reports_document_hash").on(table.document_number_hash),
    // Generalised-location matching in a later phase.
    idx_lost_reports_county: index("idx_lost_reports_county").on(table.county),
  };
});
