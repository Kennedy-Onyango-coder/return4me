-- ==========================================
-- Return4me (Kenya) — Database Schema (PostgreSQL 14+)
-- Designed by Return4me Dev Team, Nairobi
-- ==========================================

-- Enable pgcrypto extension for UUIDs and secure hashing
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. CONFIGURABLE ITEM CATEGORIES
CREATE TABLE categories (
    id VARCHAR(50) PRIMARY KEY,
    name_en VARCHAR(100) NOT NULL,
    name_sw VARCHAR(100) NOT NULL,
    total_fee NUMERIC(10, 2) NOT NULL CHECK (total_fee >= 0),
    finder_share NUMERIC(10, 2) NOT NULL CHECK (finder_share >= 0),
    agent_share NUMERIC(10, 2) NOT NULL CHECK (agent_share >= 0),
    platform_share NUMERIC(10, 2) NOT NULL CHECK (platform_share >= 0),
    is_sensitive_document BOOLEAN NOT NULL DEFAULT TRUE,
    is_admin_modified BOOLEAN NOT NULL DEFAULT FALSE,
    -- RECOVERY FEE ENGINE CONFIG (src/services/feeEngine.ts). Ignored when
    -- is_admin_modified is TRUE, in which case total_fee/finder_share/
    -- agent_share/platform_share above are used as a flat override.
    base_fee NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (base_fee >= 0),
    complexity_fee NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (complexity_fee >= 0),
    delay_fee NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (delay_fee >= 0),
    ceiling_percent NUMERIC(5, 2) NOT NULL DEFAULT 12.00 CHECK (ceiling_percent >= 0),
    finder_pct NUMERIC(5, 2) NOT NULL DEFAULT 25.00 CHECK (finder_pct >= 0),
    agent_pct NUMERIC(5, 2) NOT NULL DEFAULT 35.00 CHECK (agent_pct >= 0),
    platform_pct NUMERIC(5, 2) NOT NULL DEFAULT 40.00 CHECK (platform_pct >= 0),
    finder_reward_cap NUMERIC(10, 2) CHECK (finder_reward_cap IS NULL OR finder_reward_cap >= 0),
    -- Forces the admin manual-review gate for every item in this category —
    -- see the matching comment in src/db/schema.ts.
    elevated_review BOOLEAN NOT NULL DEFAULT FALSE,
    -- Public-recognition document-number masking policy — see matching
    -- comment in src/db/schema.ts.
    public_clue_style VARCHAR(30) NOT NULL DEFAULT 'generic',
    -- CANONICAL DISPLAY ORDER (Phase 16.1 Batch 1 — CAT-03). Assigned from the
    -- canonical seed's array position by syncDefaultCategories() ("highest + 1"
    -- for an admin-created category) and enforced by ORDER BY in getCategories().
    -- NOT NULL DEFAULT 0 so pre-existing rows receive a valid value without a
    -- NULL window; the boot sync then writes each seeded category's position.
    -- Not admin-editable; there is no reorder endpoint in this batch.
    sort_order INTEGER NOT NULL DEFAULT 0,
    -- LIFECYCLE STATE (Phase 16.1 Batch 2 — CAT-04). Not a visibility flag: an
    -- inactive category is not selectable for NEW work (it is absent from the
    -- public category list and refused by the report/verification boundaries)
    -- while historical items and lost reports referencing it stay fully valid
    -- and searchable. Deactivating is the safe alternative to deleting a
    -- canonical category (CAT-06).
    -- DEFAULT TRUE so every pre-existing row stays active through the upgrade.
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT chk_fee_shares_sum CHECK (total_fee = finder_share + agent_share + platform_share)
);

-- 2. VETTED PHYSICAL AGENT POINTS (Return4me Agents)
CREATE TABLE agents (
    id VARCHAR(50) PRIMARY KEY,
    business_name VARCHAR(150) NOT NULL,
    contact_phone VARCHAR(15) NOT NULL UNIQUE, -- Safaricom format (+254...)
    location_address TEXT NOT NULL,
    county VARCHAR(50),
    administrative_unit_id VARCHAR(50),
    location_accuracy NUMERIC(10, 2),
    latitude NUMERIC(9, 6),
    longitude NUMERIC(9, 6),
    mpesa_till_or_paybill VARCHAR(20) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
    refundable_deposit NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    national_id_hash VARCHAR(64) NOT NULL, -- SHA-256 hash for privacy
    rating NUMERIC(3, 2) DEFAULT 5.00 CHECK (rating BETWEEN 1.00 AND 5.00),
    rating_count INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    payout_method_type VARCHAR(50) NOT NULL DEFAULT 'Till Number',
    terms_accepted_at TIMESTAMP WITH TIME ZONE,
    needs_manual_geocoding BOOLEAN NOT NULL DEFAULT FALSE,
    -- N4: agent EMAIL ACTIVATION. `status` above is the BUSINESS APPROVAL axis
    -- and is unchanged by N4. This nullable column is the independent EMAIL
    -- axis: NULL = unverified, timestamp = verified.
    email_verified_at TIMESTAMP WITH TIME ZONE,
    -- Required for NEW registrations, normalized (trim + lowercase) by the
    -- single writer, and nullable so pre-N4 agents are grandfathered.
    contact_email VARCHAR(255),
    shop_photo_url TEXT,
    id_document_photo_url TEXT,
    warning_count INT DEFAULT 0,
    last_warning_reason TEXT,
    last_warning_at TIMESTAMP WITH TIME ZONE
);
-- Partial unique index, mirroring uq_customers_email: two agents may never
-- share a non-null email, while any number of grandfathered NULL-email agents
-- remain valid.
CREATE UNIQUE INDEX uq_agents_email ON agents(contact_email) WHERE contact_email IS NOT NULL;

-- 3. FOUND ITEMS
CREATE TABLE items (
    id VARCHAR(50) PRIMARY KEY, -- Generates human-friendly drop-off codes, e.g. "7K2-941"
    category_id VARCHAR(50) REFERENCES categories(id),
    photo_url TEXT NOT NULL, -- Secure bucket path
    ocr_extracted_number VARCHAR(100), -- Plaintext for admin review queue
    ocr_extracted_name VARCHAR(150),   -- Plaintext for admin review queue
    document_number_hash VARCHAR(64),  -- Salted SHA-256 for secure privacy-masked matching
    document_name_fuzzy VARCHAR(150),  -- Limited fuzzy searchable representation
    location_description TEXT NOT NULL,
    latitude NUMERIC(9, 6),
    longitude NUMERIC(9, 6),
    -- PHASE 9D: the county the FINDER explicitly selected for where the item
    -- was found, stored as a CANONICAL name from config/kenyaCounties.ts (one
    -- of the 47, identical to lost_reports.county). Validated/canonicalized at
    -- the API boundary by resolveCountyName(); never inferred from
    -- location_description, never derived from latitude/longitude, and never
    -- produced by a geocoder.
    --
    -- NULLABLE BY DESIGN: every pre-Phase-9D row has no county and must stay
    -- readable with its county UNKNOWN. There is deliberately no backfill —
    -- see the longer rationale on this column in src/db/schema.ts and the
    -- matching comment in src/services/lostReportMatching.ts.
    found_county VARCHAR(50),
    -- Structured supplied-baseline second-level geography; exact place remains separate.
    administrative_unit_id VARCHAR(50),
    finder_phone VARCHAR(15) NOT NULL, -- Finder payout target (never shown to owners)
    assigned_agent_id VARCHAR(50) REFERENCES agents(id),
    -- suspected_stolen: claim flow blocked pending admin/legal review.
    -- legal_hold: item fully frozen (no claim, payment, or handover).
    status VARCHAR(30) NOT NULL DEFAULT 'awaiting_dropoff' CHECK (status IN ('awaiting_dropoff', 'at_agent', 'claimed', 'expired', 'rejected', 'suspected_stolen', 'legal_hold')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    flagged_for_review BOOLEAN NOT NULL DEFAULT FALSE,
    is_description_only BOOLEAN NOT NULL DEFAULT FALSE,
    description TEXT,
    is_sensitive_document BOOLEAN NOT NULL DEFAULT TRUE,
    rejection_reason TEXT,
    locked_total_fee NUMERIC(10,2),
    locked_finder_share NUMERIC(10,2),
    locked_agent_share NUMERIC(10,2),
    locked_platform_share NUMERIC(10,2),
    agent_assignment_method VARCHAR(30),
    agent_assignment_distance_km NUMERIC(8,2),
    needs_manual_agent_reassignment BOOLEAN NOT NULL DEFAULT FALSE,
    finder_email VARCHAR(255),
    -- Optional, unverified finder-supplied replacement-value estimate — used
    -- only as an input to the Recovery Fee Engine's ceiling calculation.
    declared_value NUMERIC(12, 2) CHECK (declared_value IS NULL OR declared_value >= 0),
    fee_ceiling_applied BOOLEAN NOT NULL DEFAULT FALSE,
    -- Agent-verified fields — see matching comment in schema.ts. The
    -- original Finder submission (ocr_extracted_name, ocr_extracted_number,
    -- description, location_description above) is never overwritten.
    verified_category_id VARCHAR(50) REFERENCES categories(id),
    verified_name VARCHAR(150),
    verified_document_number VARCHAR(100),
    verified_description TEXT,
    verified_found_area VARCHAR(200),
    verification_status VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'confirmed_as_reported', 'corrected', 'rejected')),
    physically_verified_at TIMESTAMP WITH TIME ZONE,
    -- B0 / B13: found-item withdrawal audit fields. Foundation only.
    -- B13 requires controlled WITHDRAWAL ("not deletion") with a recorded
    -- reason, where the item stops matching where appropriate. `status` is a
    -- custody lifecycle whose values mean something specific, and updated_at
    -- records neither actor nor reason.
    -- NO NEW status VALUE: B13 splits withdrawal into cases (before
    -- verification vs after a claim exists) that map onto different existing
    -- statuses or an admin/agent decision. Choosing the vocabulary now would
    -- pre-empt that workflow and would require widening items_status_check in
    -- three synchronised places. That belongs to the batch that implements
    -- withdrawal, with its transition rules decided first.
    -- Same shape as B12 on lost_reports: timestamp+actor+reason, never a broad
    -- `deleted` flag. NULL on every historical row, which is correct because
    -- those items were never withdrawn. The row and all verification/claim
    -- history are untouched — this is not an erasure.
    withdrawn_at TIMESTAMP WITH TIME ZONE,
    withdrawn_by VARCHAR(100),
    withdrawal_reason TEXT
);

-- Field-level Agent-correction audit trail — see matching comment in schema.ts.
CREATE TABLE item_verification_changes (
    id VARCHAR(50) PRIMARY KEY,
    item_id VARCHAR(50) NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    agent_id VARCHAR(50) NOT NULL REFERENCES agents(id),
    field_name VARCHAR(50) NOT NULL,
    original_value TEXT,
    verified_value TEXT,
    reason VARCHAR(100) NOT NULL,
    reason_detail TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_item_verification_changes_item ON item_verification_changes(item_id);

-- Create indexes for performance
CREATE INDEX idx_items_doc_hash ON items(document_number_hash);
CREATE INDEX idx_items_agent ON items(assigned_agent_id);

-- 4. CLAIMS PLACED BY OWNERS ON FOUND ITEMS
CREATE TABLE claims (
    id VARCHAR(50) PRIMARY KEY, -- Generates human-friendly handover code
    item_id VARCHAR(50) REFERENCES items(id) ON DELETE CASCADE,
    owner_phone VARCHAR(15) NOT NULL, -- Verified via OTP
    security_answers JSONB NOT NULL, -- Encoded hidden answers
    verification_tier INT NOT NULL DEFAULT 1 CHECK (verification_tier IN (1, 2, 3)),
    -- pending_settlement: handover physically confirmed, payout booked in the
    -- ledger as 'pending', real M-Pesa disbursement withheld until settle_at
    -- (the dispute window) passes with no dispute raised. 'releasing' is the
    -- brief in-flight window while a disbursement is actively being sent.
    status VARCHAR(30) NOT NULL DEFAULT 'pending_verification' CHECK (status IN ('pending_verification', 'awaiting_agent_confirmation', 'pending_payment', 'payment_window_expired', 'escrow_held', 'pending_settlement', 'releasing', 'released', 'disputed', 'rejected', 'refunding', 'refunded')),
    owner_id_proof_url TEXT, -- Secure storage path
    -- AUTHORITATIVE PAYMENT TRUTH. NULL = no confirmed payment; non-NULL = the
    -- payment was confirmed by attemptClaimEscrowHold()'s guarded CAS. Never
    -- set on initiation/failure/abandonment/unknown outcome. Never inferred
    -- from payment_reference. See config/claimStatuses.ts + database.ts.
    paid_at TIMESTAMP WITH TIME ZONE,
    payment_reference VARCHAR(50), -- Provider reference (Daraja receipt / invoice id). NOT proof of payment.
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    owner_identifying_details TEXT,
    owner_email VARCHAR(255),
    agent_confirmed_at TIMESTAMP WITH TIME ZONE,
    handover_photo_url TEXT,
    -- Set when the claim enters 'pending_settlement'; the settlement sweep
    -- only disburses once now() >= settle_at.
    settle_at TIMESTAMP WITH TIME ZONE,
    -- Set the first time POST /api/claims/:id/rate succeeds for this claim —
    -- dedup guard so the same claim can't be rated twice. Mirrors
    -- src/db/schema.ts (agent_rated_at) and the matching ALTER statement in
    -- src/db/index.ts; previously missing from this file, which left a fresh
    -- database bootstrapped from schema.sql unable to run createClaim().
    agent_rated_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_claims_item ON claims(item_id);
-- At most one "active" claim per item at the DB level — see the matching
-- comment in src/db/schema.ts for why this exists alongside the
-- application-level duplicate-claim check, and why `disputed`/`refunding`
-- MUST be excluded (a dispute puts two claims on one item, and a refunding
-- loser coexists with the winner).
-- SC-7: the predicate below MUST match CLAIM_SLOT_EXCLUDED_STATUSES in
-- src/config/claimStatuses.ts — a test asserts this file, src/db/schema.ts and
-- src/db/index.ts all declare the identical set.
CREATE UNIQUE INDEX uq_claims_one_active_per_item ON claims(item_id)
    WHERE status NOT IN ('disputed', 'rejected', 'refunding', 'refunded', 'payment_window_expired');

-- 5. DISPUTES
CREATE TABLE disputes (
    id VARCHAR(50) PRIMARY KEY,
    item_id VARCHAR(50) REFERENCES items(id) ON DELETE CASCADE,
    claimant_1_claim_id VARCHAR(50) REFERENCES claims(id),
    claimant_2_claim_id VARCHAR(50) REFERENCES claims(id),
    claimant_1_id_proof_url TEXT NOT NULL,
    claimant_2_id_proof_url TEXT NOT NULL,
    resolved_by VARCHAR(50), -- Admin username
    resolved_claim_id VARCHAR(50) REFERENCES claims(id),
    resolved_at TIMESTAMP WITH TIME ZONE,
    admin_notes TEXT,
    -- DISPUTE SNAPSHOT (SC-3): each participant's status and authoritative
    -- payment truth as they were IMMEDIATELY BEFORE this dispute was filed.
    -- createDispute() overwrites both claims' status to 'disputed', which
    -- otherwise destroys the historical truth resolveDispute() needs to decide
    -- the winner's target state and the loser's refund obligation.
    -- claimant_1 = original/pre-existing claim; claimant_2 = contesting claim.
    claimant_1_status_at_dispute VARCHAR(30),
    claimant_2_status_at_dispute VARCHAR(30),
    claimant_1_paid_at_dispute TIMESTAMP WITH TIME ZONE,
    claimant_2_paid_at_dispute TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
-- At most one unresolved dispute per item — see matching comment in schema.ts.
CREATE UNIQUE INDEX uq_disputes_one_unresolved_per_item ON disputes(item_id)
    WHERE resolved_at IS NULL;

-- 6. IMMUTABLE FINANCIAL TRANSACTIONS LEDGER
CREATE TABLE ledger (
    id VARCHAR(50) PRIMARY KEY,
    claim_id VARCHAR(50) REFERENCES claims(id),
    item_id VARCHAR(50) REFERENCES items(id),
    type VARCHAR(30) NOT NULL CHECK (type IN ('payment_received', 'finder_payout', 'agent_payout', 'platform_fee', 'goodwill_payout', 'refund')),
    amount NUMERIC(10, 2) NOT NULL CHECK (amount >= 0),
    phone_or_till VARCHAR(30) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
    -- Per-transaction provider reconciliation — see matching comment in schema.ts.
    provider_batch_id VARCHAR(100),
    provider_transaction_id VARCHAR(100),
    failure_reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 7. AUDIT LOG OF SENSITIVE ACTIONS
CREATE TABLE audit_log (
    id VARCHAR(50) PRIMARY KEY,
    admin_user VARCHAR(100) NOT NULL,
    action VARCHAR(150) NOT NULL,
    details TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 8. PHONE REPUTATIONS (Banned/Cleared devices & contacts)
CREATE TABLE phone_reputations (
    phone_number VARCHAR(15) PRIMARY KEY,
    is_cleared BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 9. ADMIN USERS (Credentialed back-office admins)
CREATE TABLE admin_users (
    id VARCHAR(40) PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP WITH TIME ZONE
);

-- 10. CLAIM PAYMENT STRIKES (For fraud detection and locking persistent non-payers)
CREATE TABLE claim_payment_strikes (
    phone_number VARCHAR(15) PRIMARY KEY,
    strike_count INT NOT NULL DEFAULT 0,
    last_strike_at TIMESTAMP WITH TIME ZONE,
    is_cleared_by_admin BOOLEAN NOT NULL DEFAULT FALSE,
    -- B0A / A1: FROZEN LEGACY BASELINE. strike_count and last_strike_at are both
    -- overwritten by every new strike, so they cannot distinguish pre-migration
    -- strikes from post-migration ones. These two columns are written ONCE, on
    -- the first post-migration strike for this phone, copying the PRE-increment
    -- values, and are never touched again. The active gate derives the legacy
    -- component from THIS snapshot and ADDS the active individual records, which
    -- makes double-counting impossible.
    -- NULL means the row was never touched post-migration (pure legacy), in which
    -- case strike_count/last_strike_at are themselves still authoritative. No
    -- backfill is required and no historical value is invented.
    legacy_strike_count INTEGER,
    legacy_last_strike_at TIMESTAMP WITH TIME ZONE,
    -- Durable record that an administrator cleared this phone's LEGACY component.
    -- Separate from is_cleared_by_admin so that a later strike can never silently
    -- reactivate a frozen legacy baseline. NULL = never administratively cleared.
    legacy_cleared_at TIMESTAMP WITH TIME ZONE
);

-- 10b. CLAIM PAYMENT STRIKE RECORDS (individual, per-strike) — B0 / A1
--
-- The aggregate above cannot express A1's individual 5-day expiry: a counter
-- plus one timestamp does not say WHEN any individual strike happened, so it
-- can neither expire strikes one at a time nor answer an audit question about
-- a specific strike. Decrementing strike_count on expiry would destroy exactly
-- the history A1 requires us to keep.
--
-- This table is the normalized form and is ADDITIVE AND UNUSED BY BUSINESS
-- LOGIC IN THIS BATCH: recordPaymentStrike/getPaymentStrikeCount/
-- clearPaymentStrikes and the >=3 gate in routes/claims.ts are unchanged and
-- still read the aggregate table, so no existing behaviour moves.
--
-- BACKFILL: NONE, deliberately. For a legacy row with strike_count = 3 and
-- last_strike_at = T, the three individual timestamps are NOT recoverable. Three
-- rows all stamped T — or spread backwards on an invented cadence — would
-- fabricate audit data. The aggregate row is left untouched and remains the
-- record of every pre-migration strike; this table holds only strikes recorded
-- after the migration, each with a genuine created_at. A later batch must
-- decide explicitly how legacy aggregate strikes interact with the 5-day
-- window; that is a product call, not a schema call.
CREATE TABLE claim_payment_strike_records (
    id VARCHAR(50) PRIMARY KEY,
    phone_number VARCHAR(15) NOT NULL,
    -- Genuine per-strike creation time. NEVER backfilled or invented.
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- A1: individual 5-day expiry, INDEPENDENT of every other strike on the
    -- same phone. NULL means "no automatic expiry".
    expires_at TIMESTAMP WITH TIME ZONE,
    -- A1: Administrator override, per strike rather than per phone.
    is_cleared_by_admin BOOLEAN NOT NULL DEFAULT FALSE,
    cleared_at TIMESTAMP WITH TIME ZONE,
    cleared_by_admin VARCHAR(100),
    -- Provenance: the claim whose payment-window expiry produced this strike,
    -- when known. Nullable.
    source_claim_id VARCHAR(50)
);

CREATE INDEX idx_claim_strike_records_phone ON claim_payment_strike_records(phone_number);
CREATE INDEX idx_claim_strike_records_expires ON claim_payment_strike_records(expires_at);

-- 11. PLATFORM SETTINGS (generic admin-toggleable key/value store, e.g. the
-- social-media publishing emergency stop). See schema.ts comment.
CREATE TABLE platform_settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT NOT NULL,
    updated_by VARCHAR(100),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 12. SOCIAL PUBLICATION TRACKING (idempotent — see schema.ts comment)
CREATE TABLE social_publications (
    id VARCHAR(50) PRIMARY KEY,
    item_id VARCHAR(50) NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    platform VARCHAR(20) NOT NULL,
    publication_type VARCHAR(30) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'failed')),
    provider_post_id VARCHAR(200),
    last_error TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 1,
    next_attempt_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT uq_social_pub_item_platform_type UNIQUE (item_id, platform, publication_type)
);

-- 13. CUSTOMER ACCOUNT FOUNDATION (see schema.ts comment)
CREATE TABLE customers (
    id VARCHAR(50) PRIMARY KEY,
    full_name TEXT NOT NULL,
    phone VARCHAR(20) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    -- N2 (notification architecture foundation).
    --
    -- `email` is NULLABLE AT THE PHYSICAL LEVEL ON PURPOSE. Every customer
    -- account that exists today was created through the SMS-only registration
    -- flow and has no email address at all. A NOT NULL column would either
    -- fail the migration or force a fabricated value into live identity data,
    -- and neither is acceptable. So:
    --
    --   * existing (grandfathered) rows keep email = NULL, stay active, and are
    --     NOT pushed through email activation;
    --   * the REQUIREMENT that every NEW customer supplies an email is an
    --     APPLICATION-level rule enforced at registration time, not a column
    --     constraint.
    --
    -- Normalization contract: the application stores a trimmed, lower-cased
    -- address here, so uniqueness is case-insensitive in practice. The
    -- uniqueness rule itself is PARTIAL (below) so that any number of
    -- grandfathered NULL rows can coexist.
    email VARCHAR(255),
    -- NULL = this account's email has never been verified.
    -- A timestamp = the email was verified at that moment.
    -- An explicit boolean is deliberately NOT used: a nullable timestamp
    -- records WHEN, carries no second source of truth, and cannot disagree
    -- with itself.
    email_verified_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX uq_customers_phone ON customers(phone);
CREATE INDEX idx_customers_status ON customers(status);
-- Partial unique index: two accounts may never share a non-null email, while
-- any number of grandfathered NULL-email accounts remain valid.
CREATE UNIQUE INDEX uq_customers_email ON customers(email) WHERE email IS NOT NULL;

CREATE TABLE customer_otps (
    id VARCHAR(50) PRIMARY KEY,
    customer_id VARCHAR(50) REFERENCES customers(id) ON DELETE CASCADE,
    phone VARCHAR(20) NOT NULL,
    purpose VARCHAR(20) NOT NULL,
    code_hash VARCHAR(64) NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    used_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX idx_customer_otps_phone_purpose ON customer_otps(phone, purpose);
CREATE INDEX idx_customer_otps_expires ON customer_otps(expires_at);

CREATE TABLE customer_sessions (
    id VARCHAR(50) PRIMARY KEY,
    customer_id VARCHAR(50) NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP WITH TIME ZONE,
    revoked_at TIMESTAMP WITH TIME ZONE,
    -- B0 / H9 / H10: device + activity context. last_seen_at (inactivity clock)
    -- and revoked_at (per-session revocation that preserves the row) already
    -- existed and are unchanged; this adds only the request context a future
    -- "your active sessions" view needs to identify WHICH device a session
    -- belongs to. Raw User-Agent rather than a pre-derived device name, so the
    -- customer-facing label can be derived at read time later.
    -- NO IP ADDRESS COLUMN: the codebase already stores rate-limit identities as
    -- salted hashes precisely so a table does not become a record of who
    -- connected from where, and session rows follow the same rule. Coarse
    -- geography, if ever needed, must arrive as its own decision.
    user_agent VARCHAR(512),
    CONSTRAINT customer_sessions_user_agent_len CHECK (user_agent IS NULL OR length(user_agent) <= 512)
);
CREATE INDEX idx_customer_sessions_token ON customer_sessions(token_hash);
CREATE INDEX idx_customer_sessions_customer ON customer_sessions(customer_id);
CREATE INDEX idx_customer_sessions_expires ON customer_sessions(expires_at);

CREATE TABLE customer_claim_links (
    id VARCHAR(50) PRIMARY KEY,
    customer_id VARCHAR(50) NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    claim_id VARCHAR(50) NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    linked_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    linked_via VARCHAR(40) NOT NULL DEFAULT 'claim_otp'
);
CREATE UNIQUE INDEX uq_customer_claim_links_pair ON customer_claim_links(customer_id, claim_id);
CREATE UNIQUE INDEX uq_customer_claim_links_claim ON customer_claim_links(claim_id);

-- N2 — EMAIL ACTIVATION TOKENS (shared by customer and agent accounts).
--
-- ONE table, not two. The columns that make a token valid are identical for
-- every account kind, and the `account_type` discriminator is what keeps
-- ownership unambiguous: a token always names exactly one (account_type,
-- account_id) pair and one purpose.
--
-- SECURITY: only a SHA-256 hash of the token is ever persisted. The plaintext
-- exists only in the activation email and is unrecoverable from this table, so
-- a database leak cannot be replayed into an account takeover.
--
-- `expires_at` and `consumed_at` together give the two independent conditions
-- the validator must check. Single-use is enforced at redemption time by a
-- compare-and-swap UPDATE (consumed_at IS NULL AND expires_at > now()), which
-- is atomic — a plain application-level "check then update" would let two
-- concurrent redemptions of the same token both succeed.
CREATE TABLE account_activation_tokens (
    id VARCHAR(50) PRIMARY KEY,
    -- 'customer' | 'agent'. Constrained by the CHECK below.
    account_type VARCHAR(20) NOT NULL,
    -- The id in customers.id or agents.id depending on account_type. There is
    -- deliberately NO foreign key: a polymorphic reference cannot be a real FK,
    -- and a wrong FK would be worse than an application-verified reference.
    account_id VARCHAR(50) NOT NULL,
    -- 'email_activation' today. Constrained below so a token can never be
    -- filed under an undefined purpose and later redeemed as something it was
    -- never issued for.
    purpose VARCHAR(32) NOT NULL,
    -- SHA-256 hex of the raw token. Never the raw token.
    token_hash VARCHAR(64) NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    -- Set when the token is redeemed. NULL = still redeemable.
    consumed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT account_activation_tokens_purpose_check
        CHECK (purpose = 'email_activation'),
    CONSTRAINT account_activation_tokens_account_type_check
        CHECK (account_type IN ('customer', 'agent'))
);
-- The lookup path: given a presented token, find its hash.
CREATE INDEX idx_account_activation_tokens_hash ON account_activation_tokens(token_hash);
-- "invalidate every outstanding token for this account" (one-active-token model).
CREATE INDEX idx_account_activation_tokens_account ON account_activation_tokens(account_type, account_id, purpose);
-- Expiry sweeps.
CREATE INDEX idx_account_activation_tokens_expires ON account_activation_tokens(expires_at);

-- N2 — NOTIFICATION EVENTS (durable idempotency + delivery audit).
--
-- One row per LOGICAL notification, not per provider attempt. A retry reuses
-- the same row and bumps attempt_count, which is what makes "same event,
-- retried" distinguishable from "new event".
--
-- idempotency_key is the database-level guarantee behind the whole cost-control
-- requirement. Two concurrent requests for the same logical notification race
-- to insert it; exactly one wins and the other gets a 23505 unique violation
-- it can handle. An application-level check alone cannot survive that race.
-- It is UNIQUE (not partial, not nullable) because a notification with no
-- idempotency key has no defined identity and must not be storable.
--
-- NEVER stored here: OTP plaintext, pickup-code plaintext, activation tokens,
-- payment secrets, or session tokens. `recipient_reference` holds an opaque
-- reference (e.g. a masked address or a hash) — never a credential.
CREATE TABLE notification_events (
    id VARCHAR(50) PRIMARY KEY,
    -- The logical event, e.g. CLAIM_OTP, ACCOUNT_ACTIVATION, PICKUP_CODE.
    event_type VARCHAR(64) NOT NULL,
    -- 'sms' | 'email'. Constrained so an unknown channel cannot be recorded.
    channel VARCHAR(20) NOT NULL,
    -- 'africas_talking' | 'resend' | NULL (not yet routed to a provider).
    provider VARCHAR(40),
    -- Deterministic per logical event. NEVER regenerated on retry.
    idempotency_key VARCHAR(255) NOT NULL,
    -- Opaque recipient handle (masked phone / masked email / hash).
    recipient_reference VARCHAR(255) NOT NULL,
    -- 'pending' | 'sending' | 'sent' | 'failed' | 'fallback_available' |
    -- 'fallback_requested' | 'fallback_sent' | 'cancelled'.
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    -- The provider's own handle for traceability; not a secret.
    provider_message_id VARCHAR(128),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    -- Set when this row exists only because a previous channel failed
    -- (e.g. an operator-requested email after an SMS failure).
    fallback_of VARCHAR(50) REFERENCES notification_events(id),
    -- N9 failure recovery. Additive and nullable; nothing is backfilled, so no
    -- historical notification is ever resent as a result of this migration.
    -- business_reference is a domain primary key (claim/item/customer/agent id),
    -- never a recipient and never a credential: a retry re-resolves the recipient
    -- and the content from the authoritative domain record instead of storing
    -- either here. retry_attempt_count is separate from attempt_count, which keeps
    -- its historical meaning of "successful provider acceptances".
    business_reference VARCHAR(64),
    retry_class VARCHAR(32),
    retry_attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMP WITH TIME ZONE,
    -- B0 / E1: ACTIVE-NOTIFICATION EXPIRY (locked 5-day window). Foundation
    -- only; nothing reads it yet. NOT the same thing as next_attempt_at, which
    -- is RETRY SCHEDULING: a row can be due for a retry and already past its
    -- active window, or vice versa. Also unrelated to sent_at/status, which are
    -- DELIVERY OUTCOME. NULL on every historical row, and a future sweep must
    -- treat NULL as "never expires" rather than infer a date. Expiry moves a
    -- row out of an active view; it never deletes it.
    expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    -- When the provider ACCEPTED the message. This is NOT proof the recipient
    -- received it — provider acceptance and handset/inbox delivery are
    -- different facts, so the column is deliberately `sent_at` (accepted)
    -- rather than `delivered_at`.
    sent_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT notification_events_channel_check
        CHECK (channel IN ('sms', 'email')),
    CONSTRAINT notification_events_status_check
        -- 'failed' is RETAINED: it means "failed before N9 existed" and every such
        -- historical row stays valid and terminal. N9 adds 'retryable_failure',
        -- 'permanent_failure' and 'unknown'; 'sending' was already permitted and
        -- is now actually written. 'unknown' is NEVER automatically retried.
        CHECK (status IN ('pending', 'sending', 'sent', 'failed',
                          'retryable_failure', 'permanent_failure', 'unknown',
                          'cancelled', 'fallback_available',
                          'fallback_requested', 'fallback_sent'))
);
CREATE UNIQUE INDEX uq_notification_events_idempotency ON notification_events(idempotency_key);
CREATE INDEX idx_notification_events_type ON notification_events(event_type);
CREATE INDEX idx_notification_events_recipient ON notification_events(recipient_reference);
CREATE INDEX idx_notification_events_status ON notification_events(status);
CREATE INDEX idx_notification_events_created ON notification_events(created_at);
-- N9's new columns and the extended status CHECK are part of this CREATE TABLE
-- above. The matching ADD COLUMN / DROP-ADD CONSTRAINT statements that upgrade an
-- ALREADY-running database live in ensureSchemaUpToDate() in src/db/index.ts,
-- which is this repository's established incremental-migration mechanism.
-- =============================================================================
-- BATCH 1 - CUSTOMER NOTIFICATION USER LAYER.
--
-- WHY THIS IS NOT notification_events
--   notification_events (above) is a DELIVERY LEDGER: it has no customer id
--   (only a masked recipient_reference), its channel CHECK admits only
--   sms/email, and its rows carry provider names, error strings and retry
--   counters. A customer-facing layer needs customer-keyed rows, an in_app
--   channel, and none of those internals - so it gets its own tables. The two
--   layers are related by (event_type, business_reference) only, and this layer
--   never copies provider state.
--
-- expires_at BELOW has the same meaning as the column added to
-- notification_events by Batch 0: the ACTIVE-NOTIFICATION WINDOW. It is NOT
-- notification_events.next_attempt_at, which is RETRY SCHEDULING. No constraint,
-- index or query in this layer couples the two.
-- =============================================================================

CREATE TABLE customer_notifications (
    id VARCHAR(50) PRIMARY KEY,
    -- NOT NULL, and the basis of every read here: a notification is reachable
    -- only through its owner's id, so customer isolation is enforced by the
    -- query shape rather than by hiding a control in the UI.
    customer_id VARCHAR(50) NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    -- Closed vocabulary, defined in src/config/customerNotifications.ts and
    -- mirrored by the CHECK below so the two cannot drift.
    category VARCHAR(40) NOT NULL
        CHECK (category IN ('claim_status', 'payment_status',
                            'document_verification', 'lost_report',
                            'found_item_report', 'account_security',
                            'terms_service')),
    -- Plain-language customer copy, stored rendered so History still reads
    -- correctly after the underlying record moves on. Never a provider name,
    -- payload, error string or infrastructure identifier.
    title VARCHAR(160) NOT NULL,
    body TEXT,
    -- STABLE EXISTING reference (claim id, item id, report id): the same opaque
    -- domain id notification_events.business_reference already uses, and what
    -- grouping keys on. Never rendered as a raw internal identifier.
    business_reference VARCHAR(64),
    -- NULL = UNREAD. A timestamp rather than a boolean, so there is one source
    -- of truth and it also records WHEN. Persisted server-side, so read state
    -- survives a new session and a new device.
    read_at TIMESTAMP WITH TIME ZONE,
    -- ACTIVE-WINDOW boundary (5 days, set by the service). Moves the row out of
    -- the active list; never deletes it, and never rewrites read_at.
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    -- True when the row was written because a DELIVERY fell back to in-app, so
    -- the UI can be honest that it arrived here rather than by text WITHOUT
    -- surfacing why the other channel failed.
    created_via_fallback BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_customer_notifications_active ON customer_notifications(customer_id, expires_at);
CREATE INDEX idx_customer_notifications_created ON customer_notifications(customer_id, created_at);
-- Partial: holds only unread rows, and empties as the customer works through the list.
CREATE INDEX idx_customer_notifications_unread ON customer_notifications(customer_id, created_at) WHERE read_at IS NULL;

-- Preferences. ABSENT ROW = ENABLED is the safe default, so a new customer
-- receives everything without a seeded row per category, and an essential
-- notification can never be lost because a row failed to insert.
CREATE TABLE customer_notification_prefs (
    id VARCHAR(50) PRIMARY KEY,
    customer_id VARCHAR(50) NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    category VARCHAR(40) NOT NULL
        CHECK (category IN ('claim_status', 'payment_status',
                            'document_verification', 'lost_report',
                            'found_item_report', 'account_security',
                            'terms_service')),
    -- Only channels the system can actually deliver on. No fake channel.
    channel VARCHAR(20) NOT NULL CHECK (channel IN ('sms', 'email', 'in_app')),
    -- The only stored preference is the opt-out.
    disabled BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- One row per customer+category+channel, so a concurrent double-submit cannot
-- leave contradictory preferences behind.
CREATE UNIQUE INDEX uq_customer_notification_pref ON customer_notification_prefs(customer_id, category, channel);

-- Append-only audit of preference changes. Separate from the table above because
-- that one is updated in place and would therefore lose the customer's previous
-- choice - which is exactly the history an audit must keep. applied = FALSE
-- records a REFUSED change (e.g. disabling an essential channel), so a refusal is
-- distinguishable from a silent no-op.
CREATE TABLE customer_notification_pref_audit (
    id VARCHAR(50) PRIMARY KEY,
    customer_id VARCHAR(50) NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    category VARCHAR(40) NOT NULL,
    channel VARCHAR(20) NOT NULL,
    previous_disabled BOOLEAN,
    new_disabled BOOLEAN NOT NULL,
    applied BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_customer_notification_pref_audit ON customer_notification_pref_audit(customer_id, created_at);

-- The matching ADD COLUMN / CREATE TABLE IF NOT EXISTS statements that upgrade an
-- ALREADY-running database live in ensureSchemaUpToDate() in src/db/index.ts,
-- which is this repository's established incremental-migration mechanism. Every
-- statement there is idempotent, so booting twice is a no-op.

-- BATCH 2 - CUSTOMER IDENTITY CHANGES (G3).
--
-- An email or phone change must not become authoritative until the customer has
-- proved control of the NEW value. This table holds that claimed-but-unproven
-- value so the unverified identity is kept entirely OUT of the authoritative
-- `customers` row, rather than as pending_* columns every read would have to
-- remember to ignore.
--
-- `code_hash` is a SHA-256 hash, never the code, mirroring customer_otps and
-- account_activation_tokens. Redemption is a compare-and-swap on consumed_at.
CREATE TABLE customer_identity_changes (
    id VARCHAR(50) PRIMARY KEY,
    customer_id VARCHAR(50) NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    kind VARCHAR(10) NOT NULL CHECK (kind IN ('email', 'phone')),
    -- Stored normalized (lower-cased email / E.164 phone) so uniqueness is not
    -- defeated by casing or formatting.
    target_value VARCHAR(255) NOT NULL,
    code_hash VARCHAR(64) NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    consumed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_customer_identity_changes_customer ON customer_identity_changes(customer_id, kind);
CREATE INDEX idx_customer_identity_changes_expiry ON customer_identity_changes(expires_at);

-- The matching CREATE TABLE IF NOT EXISTS statement that upgrades an
-- ALREADY-running database lives in ensureSchemaUpToDate() in src/db/index.ts,
-- which is this repository's established incremental-migration mechanism, and is
-- idempotent so booting twice is a no-op.

-- 14. LOST-ITEM REPORTS (Phase 9A — see schema.ts comment)
-- A lost report is its OWN domain object: not a claim, and it never exposes the
-- reporter to a finder. `status` vocabulary lives in src/config/lostReportStatuses.ts
-- and is deliberately DISJOINT from both the claim-status and item-status
-- vocabularies, so a lost-report state can never be confused with either.
CREATE TABLE lost_reports (
    id VARCHAR(50) PRIMARY KEY, -- public reference, e.g. 'LR-7QF2KM'
    customer_id VARCHAR(50) NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    category_id VARCHAR(50) NOT NULL REFERENCES categories(id),
    status VARCHAR(30) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'match_review', 'resolved', 'cancelled', 'lapsed')),
    county VARCHAR(50) NOT NULL,
    -- Nullable for historical reports; exact place is not stored here.
    administrative_unit_id VARCHAR(50),
    location_area VARCHAR(120) NOT NULL,
    location_landmark VARCHAR(160),
    lost_at_from TIMESTAMP WITH TIME ZONE NOT NULL,
    lost_at_to TIMESTAMP WITH TIME ZONE,
    brand VARCHAR(100),
    model VARCHAR(100),
    colour VARCHAR(60),
    material VARCHAR(60),
    description TEXT,
    distinctive_marks TEXT,
    document_type VARCHAR(50),
    document_number_hash VARCHAR(64),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- B0 / B12: lost-report withdrawal audit fields. Foundation only.
    -- `status` already carries the business lifecycle (it already includes
    -- 'cancelled'), and updated_at records that something changed, but neither
    -- records WHO, WHEN they were allowed to, or WHY. Deliberately
    -- timestamp+actor+reason rather than a broad `deleted` boolean: a boolean
    -- would lose the when and the who, and would imply the row can be erased,
    -- which B12 forbids. The report survives; it stops being a live report.
    -- NULL on every historical row, which is correct because those reports were
    -- never withdrawn.
    withdrawn_at TIMESTAMP WITH TIME ZONE,
    withdrawn_by VARCHAR(100),
    withdrawal_reason TEXT,
);
CREATE INDEX idx_lost_reports_customer ON lost_reports(customer_id);
CREATE INDEX idx_lost_reports_category ON lost_reports(category_id);
CREATE INDEX idx_lost_reports_status ON lost_reports(status);
CREATE INDEX idx_lost_reports_document_hash ON lost_reports(document_number_hash);
CREATE INDEX idx_lost_reports_county ON lost_reports(county);
