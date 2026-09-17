import { pgTable, varchar, text, numeric, integer, timestamp, jsonb, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
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
});

// 2. AGENTS TABLE
export const agents = pgTable("agents", {
  id: varchar("id", { length: 50 }).primaryKey(),
  business_name: varchar("business_name", { length: 150 }).notNull(),
  contact_phone: varchar("contact_phone", { length: 15 }).notNull().unique(),
  location_address: text("location_address").notNull(),
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
  finder_phone: varchar("finder_phone", { length: 15 }).notNull(),
  assigned_agent_id: varchar("assigned_agent_id", { length: 50 }).references(() => agents.id),
  status: varchar("status", { length: 30 }).default("awaiting_dropoff").notNull(),
  flaggedForReview: boolean("flagged_for_review").default(false).notNull(),
  isDescriptionOnly: boolean("is_description_only").default(false).notNull(),
  description: text("description"),
  is_sensitive_document: boolean("is_sensitive_document").default(true).notNull(),
  rejection_reason: text("rejection_reason"),
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
  // the CURRENT agent-confirmed value (defaulting to the Finder's original
  // value when the Agent confirms as-reported rather than correcting it),
  // and are the only source PublicRecognitionService may read from — never
  // the raw Finder fields directly. See database.ts recordItemVerification.
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
  totp_secret: varchar("totp_secret", { length: 255 }),
  totp_enabled: boolean("totp_enabled").default(false).notNull(),
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
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => {
  return {
    uq_customers_phone: uniqueIndex("uq_customers_phone").on(table.phone),
    idx_customers_status: index("idx_customers_status").on(table.status),
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
  last_seen_at: timestamp("last_seen_at", { withTimezone: true }),
  revoked_at: timestamp("revoked_at", { withTimezone: true }),
}, (table) => {
  return {
    idx_customer_sessions_token: index("idx_customer_sessions_token").on(table.token_hash),
    idx_customer_sessions_customer: index("idx_customer_sessions_customer").on(table.customer_id),
    idx_customer_sessions_expires: index("idx_customer_sessions_expires").on(table.expires_at),
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
//                           town/estate free text; `location_landmark` is an
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
