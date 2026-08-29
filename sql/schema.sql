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
    CONSTRAINT chk_fee_shares_sum CHECK (total_fee = finder_share + agent_share + platform_share)
);

-- 2. VETTED PHYSICAL AGENT POINTS (Return4me Agents)
CREATE TABLE agents (
    id VARCHAR(50) PRIMARY KEY,
    business_name VARCHAR(150) NOT NULL,
    contact_phone VARCHAR(15) NOT NULL UNIQUE, -- Safaricom format (+254...)
    location_address TEXT NOT NULL,
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
    contact_email VARCHAR(255),
    shop_photo_url TEXT,
    id_document_photo_url TEXT,
    warning_count INT DEFAULT 0,
    last_warning_reason TEXT,
    last_warning_at TIMESTAMP WITH TIME ZONE
);

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
    physically_verified_at TIMESTAMP WITH TIME ZONE
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
    payment_reference VARCHAR(50), -- Daraja M-Pesa Receipt Code (e.g. QJK817XHS2)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    owner_identifying_details TEXT,
    owner_email VARCHAR(255),
    agent_confirmed_at TIMESTAMP WITH TIME ZONE,
    handover_photo_url TEXT,
    -- Set when the claim enters 'pending_settlement'; the settlement sweep
    -- only disburses once now() >= settle_at.
    settle_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_claims_item ON claims(item_id);
-- At most one "active" claim per item at the DB level — see the matching
-- comment in src/db/schema.ts for why this exists alongside the
-- application-level duplicate-claim check.
CREATE UNIQUE INDEX uq_claims_one_active_per_item ON claims(item_id)
    WHERE status NOT IN ('disputed', 'rejected', 'refunded', 'payment_window_expired');

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
    is_cleared_by_admin BOOLEAN NOT NULL DEFAULT FALSE
);

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
