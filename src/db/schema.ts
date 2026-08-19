import { pgTable, varchar, text, numeric, integer, timestamp, jsonb, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => {
  return {
    idx_items_doc_hash: index("idx_items_doc_hash").on(table.document_number_hash),
    idx_items_agent: index("idx_items_agent").on(table.assigned_agent_id),
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
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => {
  return {
    idx_claims_item: index("idx_claims_item").on(table.item_id),
    // Belt-and-braces against the check-then-insert race in the claim
    // submission route: two nearly-simultaneous requests could both read
    // "no active claim exists yet" before either commits. The application
    // check (src/server.ts /api/claims/submit) is the primary UX path — this
    // partial unique index is the actual guarantee. It allows at most one
    // "active" (not disputed/rejected/refunded/expired) claim per item at
    // the database level; a racing second insert fails the constraint and
    // is caught server-side and converted into the same disputed-claim
    // response the application-level check already produces.
    uq_claims_one_active_per_item: uniqueIndex("uq_claims_one_active_per_item")
      .on(table.item_id)
      .where(sql`${table.status} NOT IN ('disputed', 'rejected', 'refunded', 'payment_window_expired')`),
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
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
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
