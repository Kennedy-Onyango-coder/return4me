import { db as drizzleDb } from "./index.ts";
import {
  categories as categoriesTable,
  agents as agentsTable,
  items as itemsTable,
  claims as claimsTable,
  disputes as disputesTable,
  dispute_evidence as disputeEvidenceTable,
  ledger as ledgerTable,
  audit_log as auditLogTable,
  phone_reputations as phoneReputationsTable,
  claim_payment_strikes as claimPaymentStrikesTable,
  admin_users as adminUsersTable,
  otp_codes as otpCodesTable,
  claim_otps as claimOtpsTable,
  claim_pickup_codes as claimPickupCodesTable,
  claim_payment_auth as claimPaymentAuthTable,
  platform_settings as platformSettingsTable,
  social_publications as socialPublicationsTable,
  item_verification_changes as itemVerificationChangesTable,
} from "./schema.ts";
import { eq, and, or, isNull, inArray } from "drizzle-orm";
import { getSignedPhotoUrl } from "../services/storage.ts";

// Local copy of the phone-masking helper (also defined in services/auth.ts
// as maskPhoneForLog) — duplicated rather than imported to avoid a
// circular import, since auth.ts itself imports `db` from this file. Keep
// both in sync if the masking format ever changes.
function maskPhoneForLog(phone: string | null | undefined): string {
  if (!phone) return '(no phone)';
  const clean = phone.toString().replace(/\s+/g, '');
  if (clean.length < 7) return '***';
  return clean.slice(0, -6) + '***' + clean.slice(-3);
}

// --- DATA TYPES & SCHEMAS ---

export interface Category {
  id: string;
  name_en: string;
  name_sw: string;
  total_fee: number;
  finder_share: number;
  agent_share: number;
  platform_share: number;
  // NOTE FOR FUTURE AUTO-POSTING SYSTEM (Facebook/Telegram): 
  // Whenever the auto-posting module is built:
  // - Sensitive items (is_sensitive_document = true) MUST get the masked teaser post template.
  // - Non-sensitive items (is_sensitive_document = false) MUST get the full photo and description in the post.
  is_sensitive_document: boolean;
  is_admin_modified: boolean;
  // Recovery Fee Engine config — see src/services/feeEngine.ts. Ignored when
  // is_admin_modified is true (flat total_fee/finder_share/etc. win instead).
  base_fee: number;
  complexity_fee: number;
  delay_fee: number;
  ceiling_percent: number;
  finder_pct: number;
  agent_pct: number;
  platform_pct: number;
  finder_reward_cap: number | null;
  // Forces every item in this category through admin manual review before
  // it becomes publicly searchable — see feeEngine/schema.ts comments.
  elevated_review: boolean;
  public_clue_style: string;
}

export interface Agent {
  id: string;
  business_name: string;
  contact_phone: string;
  location_address: string;
  latitude: number | null;
  longitude: number | null;
  mpesa_till_or_paybill: string;
  payout_method_type: string;
  status: "pending" | "active" | "suspended";
  refundable_deposit: number;
  national_id_hash: string;
  rating: number;
  rating_count: number;
  needs_manual_geocoding: boolean;
  contact_email?: string | null;
  shop_photo_url?: string | null;
  id_document_photo_url?: string | null;
  warning_count?: number;
  last_warning_reason?: string | null;
  last_warning_at?: string | Date | null;
  terms_accepted_at?: string | null;
  created_at: string;
}

export interface FoundItem {
  id: string; // Drop-off code like "7K2-941"
  category_id: string;
  photo_url: string;
  ocr_extracted_number: string | null;
  ocr_extracted_name: string | null;
  document_number_hash: string | null; // Salted SHA-256 for secure privacy-masked matching
  document_name_fuzzy: string | null; // Masked for search
  location_description: string;
  latitude: number | null;
  longitude: number | null;
  finder_phone: string; // Securely stored, never shown
  // Nullable: an item can be awaiting MANUAL agent assignment (see
  // needs_manual_agent_reassignment) when confident automatic matching
  // wasn't possible. Never populate this with an arbitrary/fallback
  // agent just to keep it non-null — see AgentMatchingService.
  assigned_agent_id: string | null;
  // suspected_stolen: owner-facing claim flow is blocked pending admin/legal
  // review; the platform does not adjudicate the accusation itself.
  // legal_hold: item is frozen entirely (no claim, no payment, no handover)
  // pending police/legal process — see docs on the stolen-property workflow.
  status: "awaiting_dropoff" | "at_agent" | "claimed" | "expired" | "rejected" | "suspected_stolen" | "legal_hold";
  flaggedForReview: boolean;
  isDescriptionOnly: boolean;
  description: string | null;
  is_sensitive_document: boolean;
  rejection_reason: string | null;
  agent_assignment_method?: string | null;
  agent_assignment_distance_km?: number | null;
  needs_manual_agent_reassignment?: boolean;
  finder_email?: string | null;
  created_at: string;
  locked_total_fee?: number | null;
  locked_finder_share?: number | null;
  locked_agent_share?: number | null;
  locked_platform_share?: number | null;
  declared_value?: number | null;
  fee_ceiling_applied?: boolean;
  // Agent-verified fields — see the schema.ts comment on these columns.
  // Never populated by the Finder; only ever written by
  // db.recordItemVerification(). Falls back to the original Finder field
  // (ocr_extracted_name, ocr_extracted_number, description,
  // location_description) when the Agent hasn't corrected that
  // particular field — see resolveVerifiedItemFields in
  // publicRecognition.ts, which is the ONLY place that should read these
  // with fallback logic; everywhere else, null here genuinely means "not
  // yet verified."
  verified_category_id?: string | null;
  verified_name?: string | null;
  verified_document_number?: string | null;
  verified_description?: string | null;
  verified_found_area?: string | null;
  verification_status?: "pending" | "confirmed_as_reported" | "corrected" | "rejected";
  physically_verified_at?: string | null;
}

export interface ItemVerificationChange {
  id: string;
  item_id: string;
  agent_id: string;
  field_name: string;
  original_value: string | null;
  verified_value: string | null;
  reason: string;
  reason_detail: string | null;
  created_at: string;
}

export interface Claim {
  id: string; // Handover/release code
  item_id: string;
  owner_phone: string;
  security_answers: {
    lastDigits: string;
    color: string;
    lostDetails: string;
  };
  verification_tier: 1 | 2 | 3;
  // pending_settlement: item has been physically handed over (pickup code +
  // handover photo verified) and the payout split is booked in the ledger as
  // 'pending', but the real M-Pesa disbursement has not been sent yet — it
  // waits for settle_at (the dispute window) so a late-arriving dispute can
  // still freeze the claim before money actually moves. 'releasing' is now
  // used only for the brief window while the settlement sweep (or an admin
  // override) is actively sending that disbursement.
  status: "pending_verification" | "pending_payment" | "escrow_held" | "pending_settlement" | "releasing" | "released" | "disputed" | "rejected" | "awaiting_agent_confirmation" | "payment_window_expired" | "refunding" | "refunded";
  owner_id_proof_url: string | null;
  payment_reference: string | null; // Daraja M-Pesa receipt code
  owner_identifying_details: string | null;
  owner_email?: string | null;
  agent_confirmed_at?: string | null;
  handover_photo_url?: string | null;
  settle_at?: string | null;
  // Set the first (and only) time POST /api/claims/:id/rate succeeds for
  // this claim — see the comment on that route. Without this, the same
  // guessable claim ID could be POSTed to repeatedly to arbitrarily
  // inflate or tank an agent's rating average, since rateAgent() is a
  // simple running average with no built-in dedup.
  agent_rated_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Dispute {
  id: string;
  item_id: string;
  claimant_1_claim_id: string;
  claimant_2_claim_id: string;
  claimant_1_id_proof_url: string;
  claimant_2_id_proof_url: string;
  resolved_by: string | null;
  resolved_claim_id: string | null;
  resolved_at: string | null;
  admin_notes: string | null;
  created_at: string;
}

export interface DisputeEvidence {
  id: string;
  dispute_id: string;
  claim_id: string;
  submitted_by_phone: string;
  evidence_text: string | null;
  evidence_photo_url: string | null;
  created_at: string;
}

export interface LedgerEntry {
  id: string;
  claim_id: string | null;
  item_id: string | null;
  type: "payment_received" | "finder_payout" | "agent_payout" | "platform_fee" | "goodwill_payout" | "refund";
  amount: number;
  phone_or_till: string;
  status: "pending" | "completed" | "failed";
  provider_batch_id?: string | null;
  provider_transaction_id?: string | null;
  failure_reason?: string | null;
  created_at: string;
}

export interface AuditLog {
  id: string;
  admin_user: string;
  action: string;
  details: string;
  created_at: string;
}

export interface AdminUser {
  id: string;
  username: string;
  password_hash: string;
  full_name: string;
  is_active: boolean;
  created_at: string;
  last_login_at: string | null;
  totp_secret: string | null;
  totp_enabled: boolean;
}

// --- PARSERS FOR TYPE-SAFETY ---

function parseAdminUser(row: any): AdminUser {
  return {
    id: row.id,
    username: row.username,
    password_hash: row.password_hash,
    full_name: row.full_name,
    is_active: !!row.is_active,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
    last_login_at: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
    totp_secret: row.totp_secret ?? null,
    totp_enabled: !!row.totp_enabled,
  };
}

function parseCategory(row: any): Category {
  return {
    id: row.id,
    name_en: row.name_en,
    name_sw: row.name_sw,
    total_fee: parseFloat(row.total_fee),
    finder_share: parseFloat(row.finder_share),
    agent_share: parseFloat(row.agent_share),
    platform_share: parseFloat(row.platform_share),
    is_sensitive_document: row.is_sensitive_document ?? true,
    is_admin_modified: !!row.is_admin_modified,
    base_fee: row.base_fee !== undefined && row.base_fee !== null ? parseFloat(row.base_fee) : 0,
    complexity_fee: row.complexity_fee !== undefined && row.complexity_fee !== null ? parseFloat(row.complexity_fee) : 0,
    delay_fee: row.delay_fee !== undefined && row.delay_fee !== null ? parseFloat(row.delay_fee) : 0,
    ceiling_percent: row.ceiling_percent !== undefined && row.ceiling_percent !== null ? parseFloat(row.ceiling_percent) : 12,
    finder_pct: row.finder_pct !== undefined && row.finder_pct !== null ? parseFloat(row.finder_pct) : 25,
    agent_pct: row.agent_pct !== undefined && row.agent_pct !== null ? parseFloat(row.agent_pct) : 35,
    platform_pct: row.platform_pct !== undefined && row.platform_pct !== null ? parseFloat(row.platform_pct) : 40,
    finder_reward_cap: row.finder_reward_cap !== undefined && row.finder_reward_cap !== null ? parseFloat(row.finder_reward_cap) : null,
    elevated_review: !!row.elevated_review,
    public_clue_style: row.public_clue_style || "generic",
  };
}

function parseAgent(row: any): Agent {
  return {
    id: row.id,
    business_name: row.business_name,
    contact_phone: row.contact_phone,
    location_address: row.location_address,
    latitude: row.latitude ? parseFloat(row.latitude) : null,
    longitude: row.longitude ? parseFloat(row.longitude) : null,
    mpesa_till_or_paybill: row.mpesa_till_or_paybill,
    payout_method_type: row.payout_method_type || "Till Number",
    status: row.status as any,
    refundable_deposit: parseFloat(row.refundable_deposit),
    national_id_hash: row.national_id_hash,
    rating: row.rating ? parseFloat(row.rating) : 5.0,
    rating_count: row.rating_count || 0,
    needs_manual_geocoding: row.needs_manual_geocoding ?? false,
    contact_email: row.contact_email || null,
    shop_photo_url: row.shop_photo_url || null,
    id_document_photo_url: row.id_document_photo_url || null,
    warning_count: row.warning_count ? parseInt(row.warning_count, 10) : 0,
    last_warning_reason: row.last_warning_reason || null,
    last_warning_at: row.last_warning_at ? new Date(row.last_warning_at).toISOString() : null,
    terms_accepted_at: row.terms_accepted_at ? new Date(row.terms_accepted_at).toISOString() : null,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
  };
}

function parseFoundItem(row: any): FoundItem {
  return {
    id: row.id,
    category_id: row.category_id || "",
    photo_url: row.photo_url || "",
    ocr_extracted_number: row.ocr_extracted_number,
    ocr_extracted_name: row.ocr_extracted_name,
    document_number_hash: row.document_number_hash,
    document_name_fuzzy: row.document_name_fuzzy,
    location_description: row.location_description || "",
    latitude: row.latitude ? parseFloat(row.latitude) : null,
    longitude: row.longitude ? parseFloat(row.longitude) : null,
    finder_phone: row.finder_phone || "",
    assigned_agent_id: row.assigned_agent_id ?? null,
    status: row.status as any,
    flaggedForReview: row.flaggedForReview ?? false,
    isDescriptionOnly: row.isDescriptionOnly ?? false,
    description: row.description || null,
    is_sensitive_document: row.is_sensitive_document ?? true,
    rejection_reason: row.rejection_reason || null,
    agent_assignment_method: row.agent_assignment_method || null,
    agent_assignment_distance_km: row.agent_assignment_distance_km ? parseFloat(row.agent_assignment_distance_km) : null,
    needs_manual_agent_reassignment: row.needs_manual_agent_reassignment ?? false,
    finder_email: row.finder_email || null,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
    locked_total_fee: row.locked_total_fee ? parseFloat(row.locked_total_fee) : null,
    locked_finder_share: row.locked_finder_share ? parseFloat(row.locked_finder_share) : null,
    locked_agent_share: row.locked_agent_share ? parseFloat(row.locked_agent_share) : null,
    locked_platform_share: row.locked_platform_share ? parseFloat(row.locked_platform_share) : null,
    declared_value: row.declared_value ? parseFloat(row.declared_value) : null,
    fee_ceiling_applied: row.fee_ceiling_applied ?? false,
    verified_category_id: row.verified_category_id ?? null,
    verified_name: row.verified_name ?? null,
    verified_document_number: row.verified_document_number ?? null,
    verified_description: row.verified_description ?? null,
    verified_found_area: row.verified_found_area ?? null,
    verification_status: row.verification_status ?? "pending",
    physically_verified_at: row.physically_verified_at ? new Date(row.physically_verified_at).toISOString() : null,
  };
}

function parseItemVerificationChange(row: any): ItemVerificationChange {
  return {
    id: row.id,
    item_id: row.item_id,
    agent_id: row.agent_id,
    field_name: row.field_name,
    original_value: row.original_value ?? null,
    verified_value: row.verified_value ?? null,
    reason: row.reason,
    reason_detail: row.reason_detail ?? null,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
  };
}

function parseClaim(row: any): Claim {
  return {
    id: row.id,
    item_id: row.item_id || "",
    owner_phone: row.owner_phone || "",
    security_answers: row.security_answers as any,
    verification_tier: row.verification_tier as any,
    status: row.status as any,
    owner_id_proof_url: row.owner_id_proof_url,
    payment_reference: row.payment_reference,
    owner_identifying_details: row.owner_identifying_details || null,
    owner_email: row.owner_email || null,
    agent_confirmed_at: row.agent_confirmed_at ? new Date(row.agent_confirmed_at).toISOString() : null,
    handover_photo_url: row.handover_photo_url || null,
    settle_at: row.settle_at ? new Date(row.settle_at).toISOString() : null,
    agent_rated_at: row.agent_rated_at ? new Date(row.agent_rated_at).toISOString() : null,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
  };
}

function parseDispute(row: any): Dispute {
  return {
    id: row.id,
    item_id: row.item_id || "",
    claimant_1_claim_id: row.claimant_1_claim_id || "",
    claimant_2_claim_id: row.claimant_2_claim_id || "",
    claimant_1_id_proof_url: row.claimant_1_id_proof_url || "",
    claimant_2_id_proof_url: row.claimant_2_id_proof_url || "",
    resolved_by: row.resolved_by,
    resolved_claim_id: row.resolved_claim_id,
    resolved_at: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
    admin_notes: row.admin_notes,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
  };
}

function parseDisputeEvidence(row: any): DisputeEvidence {
  return {
    id: row.id,
    dispute_id: row.dispute_id || "",
    claim_id: row.claim_id || "",
    submitted_by_phone: row.submitted_by_phone,
    evidence_text: row.evidence_text,
    evidence_photo_url: row.evidence_photo_url,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
  };
}

function parseLedgerEntry(row: any): LedgerEntry {
  return {
    id: row.id,
    claim_id: row.claim_id,
    item_id: row.item_id,
    type: row.type as any,
    amount: parseFloat(row.amount),
    phone_or_till: row.phone_or_till || "",
    status: row.status as any,
    provider_batch_id: row.provider_batch_id || null,
    provider_transaction_id: row.provider_transaction_id || null,
    failure_reason: row.failure_reason || null,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
  };
}

function parseAuditLog(row: any): AuditLog {
  return {
    id: row.id,
    admin_user: row.admin_user || "",
    action: row.action || "",
    details: row.details || "",
    created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
  };
}

async function signFoundItem(item: FoundItem): Promise<FoundItem> {
  if (item && item.photo_url) {
    const signedUrl = await getSignedPhotoUrl(item.photo_url);
    return { ...item, photo_url: signedUrl };
  }
  return item;
}

async function signClaim(claim: Claim): Promise<Claim> {
  if (claim && claim.owner_id_proof_url) {
    const signedUrl = await getSignedPhotoUrl(claim.owner_id_proof_url);
    return { ...claim, owner_id_proof_url: signedUrl };
  }
  return claim;
}

async function signDispute(dispute: Dispute): Promise<Dispute> {
  if (!dispute) return dispute;
  let updated = { ...dispute };
  if (dispute.claimant_1_id_proof_url) {
    updated.claimant_1_id_proof_url = await getSignedPhotoUrl(dispute.claimant_1_id_proof_url);
  }
  if (dispute.claimant_2_id_proof_url) {
    updated.claimant_2_id_proof_url = await getSignedPhotoUrl(dispute.claimant_2_id_proof_url);
  }
  return updated;
}

class DatabaseEngine {
  constructor() {}

  // --- QUERY & WRITE FUNCTIONS ---
  
  // IMPROVEMENT: This startup sync runs on every boot and will upsert the 15 default
  // categories below, unless they have been modified by an admin (indicated by is_admin_modified = true).
  // This preserves any manual edits to pricing or names made by administrators across restarts.
  // Genuinely corrupted or missing default categories will still be self-healed.
  // FUTURE ENHANCEMENT: A "reset to default" feature could be built in the future to allow
  // admins to manually trigger a restore of the original hardcoded settings.
  public async syncDefaultCategories(): Promise<void> {
    const list = [
      {
        id: "national-id",
        name_en: "National ID Card",
        name_sw: "Kitambulisho cha Kitaifa",
        total_fee: 400,
        finder_share: 160,
        agent_share: 128,
        platform_share: 112,
        is_sensitive_document: true,
      },
      {
        id: "passport",
        name_en: "Travelling Passport",
        name_sw: "Pasipoti ya Kusafiria",
        total_fee: 2500,
        finder_share: 1000,
        agent_share: 800,
        platform_share: 700,
        is_sensitive_document: true,
      },
      {
        id: "student-id",
        name_en: "Student ID",
        name_sw: "Kitambulisho cha Mwanafunzi",
        total_fee: 250,
        finder_share: 100,
        agent_share: 80,
        platform_share: 70,
        is_sensitive_document: true,
        // Student IDs are disproportionately likely to belong to a minor —
        // route every one through admin review before it's publicly
        // searchable, on top of the standard sensitive-document masking.
        elevated_review: true,
      },
      {
        id: "cash-money",
        name_en: "Cash / Money Found",
        name_sw: "Pesa Taslimu Iliyopatikana",
        total_fee: 300,
        finder_share: 120,
        agent_share: 96,
        platform_share: 84,
        // Sensitive so the photo is never shown publicly, and requires
        // admin review before listing — a publicly-known amount is itself
        // an obvious fraud target ("KSh 47,000 found"), so the actual sum
        // is only ever recorded privately (via the finder's optional
        // declared-value field) and verified by the agent, never published.
        is_sensitive_document: true,
        elevated_review: true,
      },
      {
        id: "driving-licence",
        name_en: "Kenya Driving Licence (Smart DL)",
        name_sw: "Leseni ya Udereva (Smart DL)",
        total_fee: 1000,
        finder_share: 400,
        agent_share: 320,
        platform_share: 280,
        is_sensitive_document: true,
      },
      {
        id: "atm-credit-card",
        name_en: "ATM / Credit Card",
        name_sw: "Kadi ya ATM / Credit",
        total_fee: 400,
        finder_share: 160,
        agent_share: 128,
        platform_share: 112,
        is_sensitive_document: true,
      },
      {
        id: "kra-nhif-nssf",
        name_en: "KRA PIN / NHIF (SHA) / NSSF Card",
        name_sw: "Kadi ya KRA PIN / NHIF (SHA) / NSSF",
        total_fee: 200,
        finder_share: 80,
        agent_share: 64,
        platform_share: 56,
        is_sensitive_document: true,
      },
      {
        id: "vehicle-logbook",
        name_en: "Vehicle Logbook",
        name_sw: "Kitabu cha Gari (Logbook)",
        total_fee: 1800,
        finder_share: 720,
        agent_share: 576,
        platform_share: 504,
        is_sensitive_document: true,
      },
      {
        id: "number-plate",
        name_en: "Number Plate (Single/Pair)",
        name_sw: "Bamba la Nambari ya Gari",
        total_fee: 700,
        finder_share: 280,
        agent_share: 224,
        platform_share: 196,
        is_sensitive_document: true,
      },
      {
        id: "birth-certificate",
        name_en: "Birth Certificate",
        name_sw: "Cheti cha Kuzaliwa",
        total_fee: 300,
        finder_share: 120,
        agent_share: 96,
        platform_share: 84,
        is_sensitive_document: true,
      },
      {
        id: "academic-certificate",
        name_en: "Job Portfolio / Academic Certificate",
        name_sw: "Cheti cha Kazi / Vyeti vya Masomo",
        total_fee: 800,
        finder_share: 320,
        agent_share: 256,
        platform_share: 224,
        is_sensitive_document: true,
      },
      {
        id: "title-deed",
        name_en: "Title Deed / Land Document",
        name_sw: "Hati ya Kumiliki Ardhi",
        total_fee: 2500,
        finder_share: 1000,
        agent_share: 800,
        platform_share: 700,
        is_sensitive_document: true,
      },
      {
        id: "wallet-with-contents",
        name_en: "Wallet with Contents (cards/IDs inside)",
        name_sw: "Pochi yenye Vitu Ndani (kadi/vitambulisho)",
        total_fee: 700,
        finder_share: 280,
        agent_share: 224,
        platform_share: 196,
        is_sensitive_document: true,
      },
      {
        id: "bag-with-documents",
        name_en: "Bag/Backpack (with documents inside)",
        name_sw: "Mfuko/Begi (lenye hati ndani)",
        total_fee: 600,
        finder_share: 240,
        agent_share: 192,
        platform_share: 168,
        is_sensitive_document: true,
      },
      {
        id: "id-lanyard-badge",
        name_en: "ID Lanyard & Corporate Badge",
        name_sw: "Kamba ya Kitambulisho na Beji ya Kazi",
        total_fee: 150,
        finder_share: 60,
        agent_share: 48,
        platform_share: 42,
        is_sensitive_document: true,
      },
      {
        id: "work-permit-visa",
        name_en: "Work Permit / Alien ID / Visa Document",
        name_sw: "Kibali cha Kazi / Kitambulisho cha Mgeni / Visa",
        total_fee: 2000,
        finder_share: 800,
        agent_share: 640,
        platform_share: 560,
        is_sensitive_document: true,
      },
      {
        id: "insurance-document",
        name_en: "Insurance Document / Cover Note",
        name_sw: "Hati ya Bima",
        total_fee: 500,
        finder_share: 200,
        agent_share: 160,
        platform_share: 140,
        is_sensitive_document: true,
      },
      {
        id: "other-document",
        name_en: "Other (describe it) — Sensitive Document",
        name_sw: "Nyingine (ieleze) — Hati Nyeti",
        total_fee: 300,
        finder_share: 120,
        agent_share: 96,
        platform_share: 84,
        is_sensitive_document: true,
      },
      {
        id: "smartphone",
        name_en: "Smart Phone",
        name_sw: "Simu Janja (Smartphone)",
        total_fee: 2000,
        finder_share: 800,
        agent_share: 640,
        platform_share: 560,
        is_sensitive_document: false,
      },
      {
        id: "feature-phone",
        name_en: "Mulika Mwizi Phone",
        name_sw: "Simu ya Mulika Mwizi",
        total_fee: 500,
        finder_share: 200,
        agent_share: 160,
        platform_share: 140,
        is_sensitive_document: false,
      },
      {
        id: "tablet",
        name_en: "Tablet",
        name_sw: "Kishikwambi (Tablet)",
        total_fee: 2500,
        finder_share: 1000,
        agent_share: 800,
        platform_share: 700,
        is_sensitive_document: false,
      },
      {
        id: "laptop",
        name_en: "Laptop",
        name_sw: "Kompyuta Mpakato (Laptop)",
        total_fee: 4000,
        finder_share: 1600,
        agent_share: 1280,
        platform_share: 1120,
        is_sensitive_document: false,
      },
      {
        id: "smartwatch",
        name_en: "Watch / Smartwatch",
        name_sw: "Saa ya Mkono / Smartwatch",
        total_fee: 1000,
        finder_share: 400,
        agent_share: 320,
        platform_share: 280,
        is_sensitive_document: false,
      },
      {
        id: "wireless-earphones",
        name_en: "Wireless Earphones / AirPods",
        name_sw: "Vipokea Sauti visivyo na Waya",
        total_fee: 600,
        finder_share: 240,
        agent_share: 192,
        platform_share: 168,
        is_sensitive_document: false,
      },
      {
        id: "headphones",
        name_en: "Headphones",
        name_sw: "Vipokea Sauti (Headphones)",
        total_fee: 500,
        finder_share: 200,
        agent_share: 160,
        platform_share: 140,
        is_sensitive_document: false,
      },
      {
        id: "usb-cable",
        name_en: "USB Cable",
        name_sw: "Kamba ya USB",
        total_fee: 200,
        finder_share: 80,
        agent_share: 64,
        platform_share: 56,
        is_sensitive_document: false,
      },
      {
        id: "phone-charger",
        name_en: "Smartphone Charger",
        name_sw: "Chaja ya Simu",
        total_fee: 300,
        finder_share: 120,
        agent_share: 96,
        platform_share: 84,
        is_sensitive_document: false,
      },
      {
        id: "powerbank",
        name_en: "Powerbank",
        name_sw: "Powerbank",
        total_fee: 500,
        finder_share: 200,
        agent_share: 160,
        platform_share: 140,
        is_sensitive_document: false,
      },
      {
        id: "flash-drive-hdd",
        name_en: "USB Flash Drive / External Hard Drive",
        name_sw: "Flash Drive / Hard Drive ya Nje",
        total_fee: 600,
        finder_share: 240,
        agent_share: 192,
        platform_share: 168,
        is_sensitive_document: false,
      },
      {
        id: "camera",
        name_en: "Camera (standalone)",
        name_sw: "Kamera",
        total_fee: 1500,
        finder_share: 600,
        agent_share: 480,
        platform_share: 420,
        is_sensitive_document: false,
      },
      {
        id: "gaming-console",
        name_en: "Gaming Console / Controller",
        name_sw: "Kifaa cha Michezo (Gaming Console)",
        total_fee: 1500,
        finder_share: 600,
        agent_share: 480,
        platform_share: 420,
        is_sensitive_document: false,
      },
      {
        id: "memory-card",
        name_en: "Memory Card / SD Card",
        name_sw: "Kadi ya Kumbukumbu (Memory/SD Card)",
        total_fee: 250,
        finder_share: 100,
        agent_share: 80,
        platform_share: 70,
        is_sensitive_document: false,
      },
      {
        id: "empty-wallet",
        name_en: "Empty Wallet",
        name_sw: "Pochi Tupu",
        total_fee: 300,
        finder_share: 120,
        agent_share: 96,
        platform_share: 84,
        is_sensitive_document: false,
      },
      {
        id: "bunch-of-keys",
        name_en: "Bunch of Keys",
        name_sw: "Mfungu wa Funguo",
        total_fee: 500,
        finder_share: 200,
        agent_share: 160,
        platform_share: 140,
        is_sensitive_document: false,
      },
      {
        id: "single-key",
        name_en: "Single Key",
        name_sw: "Ufunguo Mmoja",
        total_fee: 200,
        finder_share: 80,
        agent_share: 64,
        platform_share: 56,
        is_sensitive_document: false,
      },
      {
        id: "padlock",
        name_en: "Padlock",
        name_sw: "Kufuli",
        total_fee: 200,
        finder_share: 80,
        agent_share: 64,
        platform_share: 56,
        is_sensitive_document: false,
      },
      {
        id: "optical-sunglasses",
        name_en: "Optical Glasses & Sunglasses",
        name_sw: "Miwani ya Macho na Jua",
        total_fee: 800,
        finder_share: 320,
        agent_share: 256,
        platform_share: 224,
        is_sensitive_document: false,
      },
      {
        id: "umbrella",
        name_en: "Umbrella",
        name_sw: "Mwavuli",
        total_fee: 200,
        finder_share: 80,
        agent_share: 64,
        platform_share: 56,
        is_sensitive_document: false,
      },
      {
        id: "jewelry",
        name_en: "Jewelry (rings, necklaces, bracelets)",
        name_sw: "Vito (pete, mikufu, bangili)",
        total_fee: 1500,
        finder_share: 600,
        agent_share: 480,
        platform_share: 420,
        is_sensitive_document: false,
      },
      {
        id: "bicycle",
        name_en: "Bicycle / Scooter",
        name_sw: "Baiskeli / Skuta",
        total_fee: 2500,
        finder_share: 1000,
        agent_share: 800,
        platform_share: 700,
        is_sensitive_document: false,
      },
      {
        id: "bag-no-docs",
        name_en: "Bag (without documents)",
        name_sw: "Mfuko/Mkoba (bila hati)",
        total_fee: 200,
        finder_share: 80,
        agent_share: 64,
        platform_share: 56,
        is_sensitive_document: false,
      },
      {
        id: "bible",
        name_en: "Bible",
        name_sw: "Biblia",
        total_fee: 300,
        finder_share: 120,
        agent_share: 96,
        platform_share: 84,
        is_sensitive_document: false,
      },
      {
        id: "school-book",
        name_en: "School Test Book / Exercise Book",
        name_sw: "Kitabu cha Mazoezi/Shule",
        total_fee: 150,
        finder_share: 60,
        agent_share: 48,
        platform_share: 42,
        is_sensitive_document: false,
      },
      {
        id: "novel",
        name_en: "Novel",
        name_sw: "Riwaya",
        total_fee: 250,
        finder_share: 100,
        agent_share: 80,
        platform_share: 70,
        is_sensitive_document: false,
      },
      {
        id: "notebook-diary",
        name_en: "Notebook / Diary / Planner",
        name_sw: "Daftari / Shajara / Planner",
        total_fee: 350,
        finder_share: 140,
        agent_share: 112,
        platform_share: 98,
        is_sensitive_document: false,
      },
      {
        id: "other-item",
        name_en: "Other (describe it) — Non-Document Item",
        name_sw: "Nyingine (ieleze) — Kitu Kisicho Hati",
        total_fee: 500,
        finder_share: 200,
        agent_share: 160,
        platform_share: 140,
        is_sensitive_document: false,
      },
    ];

    // Derives Recovery Fee Engine inputs (base/complexity/delay) from each
    // category's existing total_fee, so rawFee === total_fee exactly — the
    // fee a finder/owner sees is unchanged unless a declared value triggers
    // the ceiling. Split: complexity gets a larger share of total_fee for
    // sensitive documents (they require more careful agent verification —
    // matching a name/ID number against a physical document — than a
    // generic electronics item does); delay absorbs the rounding remainder
    // so base + complexity + delay always sums back to total_fee exactly.
    // finder/agent/platform percentages move to the 25/35/40 split, and
    // finder_share/agent_share/platform_share are recomputed from total_fee
    // under that split so the DB's total_fee = finder+agent+platform
    // constraint keeps holding for the flat admin-override fallback too.
    function deriveFeeEngineFields(totalFee: number, isSensitive: boolean) {
      const complexityRatio = isSensitive ? 0.25 : 0.18;
      const complexity_fee = Math.round(totalFee * complexityRatio);
      const base_fee = Math.round(totalFee * 0.7);
      const delay_fee = Math.max(0, totalFee - base_fee - complexity_fee);

      const finder_pct = 25;
      const agent_pct = 35;
      const platform_pct = 40;
      const finder_share = Math.round((totalFee * finder_pct) / 100);
      const agent_share = Math.round((totalFee * agent_pct) / 100);
      const platform_share = totalFee - finder_share - agent_share; // residual keeps the sum exact

      return {
        base_fee, complexity_fee, delay_fee,
        ceiling_percent: 12, // mid-point of the recommended 10-15% ceiling band; configurable per category
        finder_pct, agent_pct, platform_pct,
        finder_reward_cap: null as number | null, // no cap by default — set one per high-value category in the admin panel
        finder_share, agent_share, platform_share,
      };
    }

    // Derives a sensible default public-recognition masking style per
    // category — see the schema.ts comment on public_clue_style. Admins
    // can override this per category afterward; this only sets an
    // opinionated starting point so sensitive categories don't launch
    // with an inappropriate generic mask.
    function derivePublicClueStyle(categoryId: string): string {
      if (categoryId === 'national-id') return 'national_id';
      if (categoryId === 'passport') return 'passport';
      if (categoryId === 'driving-licence') return 'driving_licence';
      if (categoryId === 'atm-credit-card') return 'card';
      if (categoryId === 'cash-money') return 'none'; // no document number applies to cash at all
      return 'generic';
    }

    const errors: any[] = [];
    for (const cat of list) {
      try {
        // Check if category exists and is admin-modified
        const existing = await drizzleDb.select().from(categoriesTable).where(eq(categoriesTable.id, cat.id)).limit(1);
        if (existing.length > 0 && existing[0].is_admin_modified) {
          console.log(`[CATEGORY SYNC] Skipping '${cat.id}' — admin-modified, preserving current values.`);
          continue;
        }

        const engineFields = deriveFeeEngineFields(cat.total_fee, cat.is_sensitive_document);
        const publicClueStyle = derivePublicClueStyle(cat.id);

        await drizzleDb.insert(categoriesTable)
          .values({
            id: cat.id,
            name_en: cat.name_en,
            name_sw: cat.name_sw,
            total_fee: String(cat.total_fee),
            finder_share: String(engineFields.finder_share),
            agent_share: String(engineFields.agent_share),
            platform_share: String(engineFields.platform_share),
            is_sensitive_document: cat.is_sensitive_document,
            is_admin_modified: false,
            base_fee: String(engineFields.base_fee),
            complexity_fee: String(engineFields.complexity_fee),
            delay_fee: String(engineFields.delay_fee),
            ceiling_percent: String(engineFields.ceiling_percent),
            finder_pct: String(engineFields.finder_pct),
            agent_pct: String(engineFields.agent_pct),
            platform_pct: String(engineFields.platform_pct),
            finder_reward_cap: engineFields.finder_reward_cap !== null ? String(engineFields.finder_reward_cap) : null,
            elevated_review: !!(cat as any).elevated_review,
            public_clue_style: publicClueStyle,
          })
          .onConflictDoUpdate({
            target: categoriesTable.id,
            set: {
              name_en: cat.name_en,
              name_sw: cat.name_sw,
              total_fee: String(cat.total_fee),
              finder_share: String(engineFields.finder_share),
              agent_share: String(engineFields.agent_share),
              platform_share: String(engineFields.platform_share),
              is_sensitive_document: cat.is_sensitive_document,
              base_fee: String(engineFields.base_fee),
              complexity_fee: String(engineFields.complexity_fee),
              delay_fee: String(engineFields.delay_fee),
              ceiling_percent: String(engineFields.ceiling_percent),
              finder_pct: String(engineFields.finder_pct),
              agent_pct: String(engineFields.agent_pct),
              platform_pct: String(engineFields.platform_pct),
              finder_reward_cap: engineFields.finder_reward_cap !== null ? String(engineFields.finder_reward_cap) : null,
              elevated_review: !!(cat as any).elevated_review,
              public_clue_style: publicClueStyle,
            },
          });
      } catch (err) {
        console.error(`Failed to sync category ${cat.id}:`, err);
        errors.push(err);
      }
    }
    if (errors.length > 0) {
      throw new Error(`Failed to sync default categories. Total errors: ${errors.length}. See logs above for details.`);
    }
    console.log('[DATABASE ENGINE] Categories list synced successfully with NTSA/Huduma 2026 Kenyan replacement cost guidelines.');
  }

  public async getCategories(): Promise<Category[]> {
    try {
      const rows = await drizzleDb.select().from(categoriesTable);
      return rows.map(parseCategory);
    } catch (error) {
      console.error("Database query failed:", error);
      throw new Error("Failed to query categories.", { cause: error });
    }
  }

  public async getCategory(id: string): Promise<Category | undefined> {
    try {
      const rows = await drizzleDb.select().from(categoriesTable).where(eq(categoriesTable.id, id));
      return rows.length > 0 ? parseCategory(rows[0]) : undefined;
    } catch (error) {
      console.error("Database query failed:", error);
      throw new Error("Failed to query category.", { cause: error });
    }
  }

  public async getAgents(): Promise<Agent[]> {
    try {
      const rows = await drizzleDb.select().from(agentsTable);
      return rows.map(parseAgent);
    } catch (error) {
      console.error("Database query failed:", error);
      throw new Error("Failed to query agents.", { cause: error });
    }
  }

  public async getAgent(id: string): Promise<Agent | undefined> {
    try {
      const rows = await drizzleDb.select().from(agentsTable).where(eq(agentsTable.id, id));
      return rows.length > 0 ? parseAgent(rows[0]) : undefined;
    } catch (error) {
      console.error("Database query failed:", error);
      throw new Error("Failed to query agent.", { cause: error });
    }
  }

  // Manually set/correct an agent's GPS coordinates. Needed because agent
  // signup only ever geocodes a free-text address via a third-party service
  // (Nominatim) — if that fails or returns the wrong location, there was
  // previously no way for an admin to fix it, permanently excluding that
  // agent from GPS-nearest-agent matching.
  public async updateAgentLocation(agentId: string, latitude: number, longitude: number): Promise<Agent | undefined> {
    try {
      const rows = await drizzleDb
        .update(agentsTable)
        .set({ latitude: String(latitude), longitude: String(longitude), needs_manual_geocoding: false })
        .where(eq(agentsTable.id, agentId))
        .returning();
      return rows.length > 0 ? parseAgent(rows[0]) : undefined;
    } catch (error) {
      console.error("Database query failed:", error);
      throw new Error("Failed to update agent location.", { cause: error });
    }
  }

  public async getItems(): Promise<FoundItem[]> {
    try {
      const rows = await drizzleDb.select().from(itemsTable);
      const items = rows.map(parseFoundItem);
      return Promise.all(items.map(signFoundItem));
    } catch (error) {
      console.error("Database query failed:", error);
      throw new Error("Failed to query items.", { cause: error });
    }
  }

  // PERFORMANCE: getItems() above does an unconditional, unfiltered
  // `SELECT * FROM items` — every status, every historical row, no LIMIT.
  // The public search route (GET /api/items/search, the highest-traffic,
  // anonymously-hit endpoint in this app) used to call getItems() and then
  // filter down to the tiny fraction of rows that are actually claimable
  // ('at_agent') in application code, meaning every search request loaded
  // the ENTIRE items table — including every long-since claimed, expired,
  // rejected, or still-awaiting-dropoff item ever created — into memory
  // and ran the (cryptographic) signFoundItem() step on every single one
  // of them, only to discard almost all of it. This pushes the same
  // filter into the WHERE clause instead, so the query only ever returns
  // and signs the rows that can actually be candidates.
  public async getItemsByStatus(status: FoundItem["status"]): Promise<FoundItem[]> {
    try {
      const rows = await drizzleDb.select().from(itemsTable).where(eq(itemsTable.status, status));
      const items = rows.map(parseFoundItem);
      return Promise.all(items.map(signFoundItem));
    } catch (error) {
      console.error("Database query failed:", error);
      throw new Error("Failed to query items by status.", { cause: error });
    }
  }

  // PERFORMANCE: the agent dashboard's "items assigned to me" view used to
  // call getItems() (the full unfiltered table) and filter by
  // assigned_agent_id in application code — despite idx_items_agent
  // already existing on exactly this column and sitting unused for this
  // query. Pushes the filter into the WHERE clause so it actually uses
  // that index instead of scanning every item in the system for every
  // agent's dashboard load.
  public async getItemsByAgent(agentId: string): Promise<FoundItem[]> {
    try {
      const rows = await drizzleDb.select().from(itemsTable).where(eq(itemsTable.assigned_agent_id, agentId));
      const items = rows.map(parseFoundItem);
      return Promise.all(items.map(signFoundItem));
    } catch (error) {
      console.error("Database query failed:", error);
      throw new Error("Failed to query items by agent.", { cause: error });
    }
  }

  public async getItem(id: string): Promise<FoundItem | undefined> {
    try {
      const rows = await drizzleDb.select().from(itemsTable).where(eq(itemsTable.id, id));
      if (rows.length === 0) return undefined;
      const item = parseFoundItem(rows[0]);
      return signFoundItem(item);
    } catch (error) {
      console.error("Database query failed:", error);
      throw new Error("Failed to query item.", { cause: error });
    }
  }

  public async getClaims(): Promise<Claim[]> {
    try {
      const rows = await drizzleDb.select().from(claimsTable);
      const claims = rows.map(parseClaim);
      return Promise.all(claims.map(signClaim));
    } catch (error) {
      console.error("Database query failed:", error);
      throw new Error("Failed to query claims.", { cause: error });
    }
  }

  public async getClaim(id: string): Promise<Claim | undefined> {
    try {
      const rows = await drizzleDb.select().from(claimsTable).where(eq(claimsTable.id, id));
      if (rows.length === 0) return undefined;
      const claim = parseClaim(rows[0]);
      return signClaim(claim);
    } catch (error) {
      console.error("Database query failed:", error);
      throw new Error("Failed to query claim.", { cause: error });
    }
  }

  public async getDisputes(): Promise<Dispute[]> {
    try {
      const rows = await drizzleDb.select().from(disputesTable);
      const disputes = rows.map(parseDispute);
      return Promise.all(disputes.map(signDispute));
    } catch (error) {
      console.error("Database query failed:", error);
      throw new Error("Failed to query disputes.", { cause: error });
    }
  }

  public async getDispute(id: string): Promise<Dispute | undefined> {
    try {
      const rows = await drizzleDb.select().from(disputesTable).where(eq(disputesTable.id, id));
      if (rows.length === 0) return undefined;
      return await signDispute(parseDispute(rows[0]));
    } catch (error) {
      console.error("Database query failed:", error);
      throw new Error("Failed to query dispute.", { cause: error });
    }
  }

  // Used by the central claimability rule (canCreateClaim in server.ts) to
  // check for an unresolved ownership dispute before allowing any new claim
  // — deliberately a targeted query rather than filtering getDisputes(),
  // since this runs on every claim-submission attempt.
  public async getDisputesByItem(itemId: string): Promise<Dispute[]> {
    try {
      const rows = await drizzleDb.select().from(disputesTable).where(eq(disputesTable.item_id, itemId));
      const disputes = rows.map(parseDispute);
      return Promise.all(disputes.map(signDispute));
    } catch (error) {
      console.error("Database query failed:", error);
      throw new Error("Failed to query disputes for item.", { cause: error });
    }
  }

  // PERFORMANCE: batched sibling of getDisputesByItem, for callers (like the
  // public search route's canCreateClaim() check over every result item)
  // that would otherwise fire one getDisputesByItem query per item in a
  // Promise.all — an N+1 query pattern that scales with result-set size on
  // every single search request. One query for the whole candidate set,
  // grouped by item_id, instead of N round trips. Returns an empty map for
  // an empty itemIds array without querying at all.
  public async getDisputesByItemIds(itemIds: string[]): Promise<Map<string, Dispute[]>> {
    const byItem = new Map<string, Dispute[]>();
    if (itemIds.length === 0) return byItem;
    try {
      const rows = await drizzleDb.select().from(disputesTable).where(inArray(disputesTable.item_id, itemIds));
      const disputes = await Promise.all(rows.map(parseDispute).map(signDispute));
      for (const dispute of disputes) {
        const existing = byItem.get(dispute.item_id);
        if (existing) {
          existing.push(dispute);
        } else {
          byItem.set(dispute.item_id, [dispute]);
        }
      }
      return byItem;
    } catch (error) {
      console.error("Database query failed:", error);
      throw new Error("Failed to batch-query disputes for items.", { cause: error });
    }
  }

  public async getLedger(): Promise<LedgerEntry[]> {
    try {
      const rows = await drizzleDb.select().from(ledgerTable);
      return rows.map(parseLedgerEntry);
    } catch (error) {
      console.error("Database query failed:", error);
      throw new Error("Failed to query ledger.", { cause: error });
    }
  }

  // Used by executeClaimSettlement to find which finder/agent payout rows
  // for this claim are still outstanding — the actual mechanism that makes
  // a settlement retry safe. Only rows still 'pending' get included in the
  // next payout attempt; a row already 'completed' is never re-sent to,
  // even if its sibling row for the same claim failed and needs a retry.
  public async getLedgerEntriesForClaim(claimId: string): Promise<LedgerEntry[]> {
    try {
      const rows = await drizzleDb.select().from(ledgerTable).where(eq(ledgerTable.claim_id, claimId));
      return rows.map(parseLedgerEntry);
    } catch (error) {
      console.error("Database query failed:", error);
      throw new Error("Failed to query ledger entries for claim.", { cause: error });
    }
  }

  // Records the outcome of one payout attempt against a specific ledger
  // row. 'success' marks it 'completed' (money genuinely confirmed sent —
  // never set this from a bare HTTP 200, only from an actual provider
  // confirmation); 'failed' marks it 'failed' with a reason for admin
  // visibility; 'pending'/'unknown' leave the row 'pending' so the next
  // settlement sweep attempt picks it up again, but now carrying the
  // provider's batch/transaction id for reconciliation.
  public async recordPayoutAttempt(
    ledgerEntryId: string,
    result: { status: 'success' | 'pending' | 'failed' | 'unknown'; providerBatchId: string | null; providerTransactionId: string | null; failureReason?: string | null }
  ): Promise<void> {
    try {
      const newStatus = result.status === 'success' ? 'completed' : result.status === 'failed' ? 'failed' : 'pending';
      await drizzleDb
        .update(ledgerTable)
        .set({
          status: newStatus,
          provider_batch_id: result.providerBatchId,
          provider_transaction_id: result.providerTransactionId,
          failure_reason: result.failureReason ?? null,
        })
        .where(eq(ledgerTable.id, ledgerEntryId));
    } catch (error) {
      console.error("Database update failed:", error);
      throw new Error("Failed to record payout attempt.", { cause: error });
    }
  }

  // Total earned by a specific agent: sum of completed agent_payout ledger
  // entries for items assigned to them. Done as two simple queries plus an
  // in-app filter/sum, rather than a SQL join, since it's small enough data
  // to be trivial either way and this keeps it safe against limited join
  // support in the local sandbox/mock database mode used for testing.
  public async getAgentEarnings(agentId: string): Promise<{ totalEarned: number; completedPayoutsCount: number }> {
    try {
      const items = await this.getItems();
      const agentItemIds = new Set(items.filter(i => i.assigned_agent_id === agentId).map(i => i.id));
      if (agentItemIds.size === 0) {
        return { totalEarned: 0, completedPayoutsCount: 0 };
      }
      const ledgerEntries = await this.getLedger();
      const agentPayouts = ledgerEntries.filter(
        l => l.type === 'agent_payout' && l.status === 'completed' && l.item_id && agentItemIds.has(l.item_id)
      );
      const totalEarned = agentPayouts.reduce((sum, l) => sum + (typeof l.amount === 'string' ? parseFloat(l.amount) : l.amount), 0);
      return { totalEarned, completedPayoutsCount: agentPayouts.length };
    } catch (error) {
      console.error("Failed to compute agent earnings:", error);
      throw new Error("Failed to compute agent earnings.", { cause: error });
    }
  }

  public async getAuditLogs(): Promise<AuditLog[]> {
    try {
      const rows = await drizzleDb.select().from(auditLogTable);
      return rows.map(parseAuditLog);
    } catch (error) {
      console.error("Database query failed:", error);
      throw new Error("Failed to query audit logs.", { cause: error });
    }
  }

  // Save new found item
  public async createItem(item: Omit<FoundItem, "created_at">): Promise<FoundItem> {
    try {
      const rows = await drizzleDb
        .insert(itemsTable)
        .values({
          id: item.id,
          category_id: item.category_id,
          photo_url: item.photo_url,
          ocr_extracted_number: item.ocr_extracted_number,
          ocr_extracted_name: item.ocr_extracted_name,
          document_number_hash: item.document_number_hash,
          document_name_fuzzy: item.document_name_fuzzy,
          location_description: item.location_description,
          latitude: item.latitude ? String(item.latitude) : null,
          longitude: item.longitude ? String(item.longitude) : null,
          finder_phone: item.finder_phone,
          assigned_agent_id: item.assigned_agent_id,
          status: item.status,
          flaggedForReview: item.flaggedForReview || false,
          isDescriptionOnly: item.isDescriptionOnly || false,
          description: item.description,
          is_sensitive_document: item.is_sensitive_document,
          rejection_reason: item.rejection_reason || null,
          locked_total_fee: item.locked_total_fee !== undefined && item.locked_total_fee !== null ? String(item.locked_total_fee) : null,
          locked_finder_share: item.locked_finder_share !== undefined && item.locked_finder_share !== null ? String(item.locked_finder_share) : null,
          locked_agent_share: item.locked_agent_share !== undefined && item.locked_agent_share !== null ? String(item.locked_agent_share) : null,
          locked_platform_share: item.locked_platform_share !== undefined && item.locked_platform_share !== null ? String(item.locked_platform_share) : null,
          agent_assignment_method: item.agent_assignment_method,
          agent_assignment_distance_km: item.agent_assignment_distance_km !== undefined && item.agent_assignment_distance_km !== null ? String(item.agent_assignment_distance_km) : null,
          needs_manual_agent_reassignment: item.needs_manual_agent_reassignment || false,
          finder_email: item.finder_email || null,
          declared_value: item.declared_value !== undefined && item.declared_value !== null ? String(item.declared_value) : null,
          fee_ceiling_applied: item.fee_ceiling_applied || false,
        })
        .returning();

      await this.logAudit(
        "SYSTEM",
        "CREATE_ITEM",
        `Finder reported found ${item.category_id} (Code: ${item.id}) assigned to agent ${item.assigned_agent_id}`
      );

      return parseFoundItem(rows[0]);
    } catch (error) {
      console.error("Database write failed:", error);
      throw new Error("Failed to save found item.", { cause: error });
    }
  }

  // Update item status
  public async updateItemStatus(id: string, status: FoundItem["status"]): Promise<void> {
    try {
      await drizzleDb.update(itemsTable).set({ status }).where(eq(itemsTable.id, id));
      await this.logAudit("SYSTEM", "UPDATE_ITEM_STATUS", `Item ${id} status changed to ${status}`);
    } catch (error) {
      console.error("Database update failed:", error);
      throw new Error("Failed to update item status.", { cause: error });
    }
  }

  // Update item status with rejection reason
  public async rejectItem(id: string, reason: string): Promise<void> {
    try {
      await drizzleDb
        .update(itemsTable)
        .set({ status: "rejected", rejection_reason: reason })
        .where(eq(itemsTable.id, id));
      await this.logAudit("SYSTEM", "REJECT_ITEM", `Item ${id} was rejected. Reason: ${reason}`);
    } catch (error) {
      console.error("Database reject failed:", error);
      throw new Error("Failed to reject item.", { cause: error });
    }
  }

  // Moves an item into (or back out of) the stolen-property review states.
  // The platform never adjudicates the underlying accusation — this only
  // ever changes the item's visibility/claimability, never publishes a
  // named accusation, and every transition is logged with who did it and
  // why for later audit.
  public async setItemReviewStatus(id: string, status: "suspected_stolen" | "legal_hold" | "at_agent", reason: string, adminUser: string): Promise<void> {
    try {
      await drizzleDb.update(itemsTable).set({ status }).where(eq(itemsTable.id, id));
      await this.logAudit(adminUser, `ITEM_REVIEW_STATUS_${status.toUpperCase()}`, `Item ${id}: ${reason}`);
    } catch (error) {
      console.error("Database update failed:", error);
      throw new Error("Failed to update item review status.", { cause: error });
    }
  }

  // Check if a phone number has been manually cleared by admin
  public async isPhoneCleared(phoneNumber: string): Promise<boolean> {
    try {
      const rows = await drizzleDb
        .select()
        .from(phoneReputationsTable)
        .where(eq(phoneReputationsTable.phone_number, phoneNumber));
      return rows.length > 0 ? rows[0].is_cleared : false;
    } catch (error) {
      console.error("Failed to check if phone is cleared:", error);
      return false;
    }
  }

  // Manually clear/reset a phone number's reputation block
  public async clearPhoneReputation(phoneNumber: string): Promise<void> {
    try {
      const rows = await drizzleDb
        .select()
        .from(phoneReputationsTable)
        .where(eq(phoneReputationsTable.phone_number, phoneNumber));
      
      if (rows.length > 0) {
        await drizzleDb
          .update(phoneReputationsTable)
          .set({ is_cleared: true, updated_at: new Date() })
          .where(eq(phoneReputationsTable.phone_number, phoneNumber));
      } else {
        await drizzleDb
          .insert(phoneReputationsTable)
          .values({
            phone_number: phoneNumber,
            is_cleared: true,
          });
      }
      await this.logAudit("ADMIN", "CLEAR_PHONE_REPUTATION", `Reputation flag manually cleared for phone ${phoneNumber}`);
    } catch (error) {
      console.error("Failed to clear phone reputation:", error);
      throw new Error("Failed to clear phone reputation.", { cause: error });
    }
  }

  // Get lightweight reputation metrics per phone number
  public async getPhoneReputation(phoneNumber: string): Promise<{ total_reports: number; rejected_reports: number; autoFlag: boolean }> {
    try {
      const allItems = await this.getItems();
      const phoneItems = allItems.filter(i => i.finder_phone === phoneNumber);
      const total_reports = phoneItems.length;
      const rejected_reports = phoneItems.filter(i => i.status === "rejected").length;

      const isCleared = await this.isPhoneCleared(phoneNumber);

      let autoFlag = false;
      if (total_reports >= 3) {
        const ratio = rejected_reports / total_reports;
        if (ratio > 0.3) {
          autoFlag = !isCleared;
        }
      }

      return { total_reports, rejected_reports, autoFlag };
    } catch (error) {
      console.error("Failed to get phone reputation:", error);
      return { total_reports: 0, rejected_reports: 0, autoFlag: false };
    }
  }

  // Admin manually updates reviewed item details
  public async adminUpdateItem(
    id: string,
    updates: {
      category_id: string;
      ocr_extracted_number: string | null;
      ocr_extracted_name: string | null;
      document_number_hash: string | null;
      document_name_fuzzy: string | null;
      description: string | null;
      isDescriptionOnly: boolean;
      flaggedForReview: boolean;
      assigned_agent_id?: string;
      agent_assignment_method?: string;
      agent_assignment_distance_km?: string | number | null;
      needs_manual_agent_reassignment?: boolean;
    }
  ): Promise<void> {
    try {
      await drizzleDb
        .update(itemsTable)
        .set({
          category_id: updates.category_id,
          ocr_extracted_number: updates.ocr_extracted_number,
          ocr_extracted_name: updates.ocr_extracted_name,
          document_number_hash: updates.document_number_hash,
          document_name_fuzzy: updates.document_name_fuzzy,
          description: updates.description,
          isDescriptionOnly: updates.isDescriptionOnly,
          flaggedForReview: updates.flaggedForReview,
          ...(updates.assigned_agent_id !== undefined && { assigned_agent_id: updates.assigned_agent_id }),
          ...(updates.agent_assignment_method !== undefined && { agent_assignment_method: updates.agent_assignment_method }),
          ...(updates.agent_assignment_distance_km !== undefined && {
            agent_assignment_distance_km: updates.agent_assignment_distance_km !== undefined && updates.agent_assignment_distance_km !== null
              ? updates.agent_assignment_distance_km.toString()
              : null
          }),
          ...(updates.needs_manual_agent_reassignment !== undefined && { needs_manual_agent_reassignment: updates.needs_manual_agent_reassignment }),
        })
        .where(eq(itemsTable.id, id));

      await this.logAudit("ADMIN", "ADMIN_UPDATE_ITEM", `Item ${id} was manually updated by admin.`);
    } catch (error) {
      console.error("Database update failed:", error);
      throw new Error("Failed to update item by admin.", { cause: error });
    }
  }

  // Create new claim
  public async createClaim(claim: Omit<Claim, "created_at" | "updated_at">): Promise<Claim> {
    try {
      const rows = await drizzleDb
        .insert(claimsTable)
        .values({
          id: claim.id,
          item_id: claim.item_id,
          owner_phone: claim.owner_phone,
          security_answers: claim.security_answers,
          verification_tier: claim.verification_tier,
          status: claim.status,
          owner_id_proof_url: claim.owner_id_proof_url,
          payment_reference: claim.payment_reference,
          owner_identifying_details: claim.owner_identifying_details,
          owner_email: claim.owner_email || null,
          agent_confirmed_at: claim.agent_confirmed_at ? new Date(claim.agent_confirmed_at) : null,
        })
        .returning();

      await this.logAudit(
        "SYSTEM",
        "CREATE_CLAIM",
        `Claim submitted for item ${claim.item_id} (Claim: ${claim.id}) by owner phone ${claim.owner_phone}`
      );

      return parseClaim(rows[0]);
    } catch (error) {
      console.error("Database write failed:", error);
      throw new Error("Failed to create claim.", { cause: error });
    }
  }

  // Update claim status
  public async updateClaimStatus(id: string, status: Claim["status"], paymentRef?: string, agentConfirmedAt?: Date | null): Promise<void> {
    try {
      const updateData: any = {
        status,
        updated_at: new Date(),
      };
      if (paymentRef !== undefined) {
        updateData.payment_reference = paymentRef || null;
      }
      if (agentConfirmedAt !== undefined) {
        updateData.agent_confirmed_at = agentConfirmedAt;
      }

      await drizzleDb
        .update(claimsTable)
        .set(updateData)
        .where(eq(claimsTable.id, id));

      await this.logAudit(
        "SYSTEM",
        "UPDATE_CLAIM_STATUS",
        `Claim ${id} status changed to ${status}${paymentRef ? " with M-Pesa Ref " + paymentRef : ""}`
      );
    } catch (error) {
      console.error("Database update failed:", error);
      throw new Error("Failed to update claim status.", { cause: error });
    }
  }

  // POST /api/claims/:id/rate is unauthenticated (owners aren't logged in)
  // and only takes a claim ID from a guessable, low-entropy space — see the
  // route comment. Without a dedup mechanism, the same claim ID could be
  // POSTed to repeatedly to skew an agent's rating average arbitrarily.
  // Atomic conditional UPDATE (WHERE agent_rated_at IS NULL), same pattern
  // as attemptClaimEscrowHold/attemptSettlementRelease elsewhere in this
  // file, so two concurrent rating attempts for the same claim can't both
  // win the race between an application-level read-check and the write.
  // Returns true only for the caller that actually claimed the rating slot.
  public async markClaimRatedIfNotAlready(claimId: string): Promise<boolean> {
    try {
      const rows = await drizzleDb
        .update(claimsTable)
        .set({ agent_rated_at: new Date() })
        .where(and(eq(claimsTable.id, claimId), isNull(claimsTable.agent_rated_at)))
        .returning({ id: claimsTable.id });
      return rows.length > 0;
    } catch (error) {
      console.error("Database update failed:", error);
      throw new Error("Failed to mark claim as rated.", { cause: error });
    }
  }

  // Create Agent Application
  public async createAgent(agent: Omit<Agent, "created_at" | "rating" | "rating_count">): Promise<Agent> {
    try {
      const rows = await drizzleDb
        .insert(agentsTable)
        .values({
          id: agent.id,
          business_name: agent.business_name,
          contact_phone: agent.contact_phone,
          location_address: agent.location_address,
          latitude: agent.latitude ? String(agent.latitude) : null,
          longitude: agent.longitude ? String(agent.longitude) : null,
          mpesa_till_or_paybill: agent.mpesa_till_or_paybill,
          payout_method_type: agent.payout_method_type || "Till Number",
          status: agent.status,
          refundable_deposit: String(agent.refundable_deposit),
          national_id_hash: agent.national_id_hash,
          rating: "5.00",
          rating_count: 0,
          needs_manual_geocoding: agent.needs_manual_geocoding ?? false,
          contact_email: agent.contact_email || null,
          shop_photo_url: agent.shop_photo_url || null,
          id_document_photo_url: agent.id_document_photo_url || null,
          warning_count: agent.warning_count ?? 0,
          last_warning_reason: agent.last_warning_reason || null,
          last_warning_at: agent.last_warning_at ? new Date(agent.last_warning_at) : null,
          terms_accepted_at: agent.terms_accepted_at ? new Date(agent.terms_accepted_at) : null,
        })
        .returning();

      await this.logAudit(
        "SYSTEM",
        "CREATE_AGENT_APPLICATION",
        `Agent application submitted for ${agent.business_name} (Phone: ${agent.contact_phone})`
      );

      return parseAgent(rows[0]);
    } catch (error) {
      console.error("Database write failed:", error);
      throw new Error("Failed to register agent.", { cause: error });
    }
  }

  // Issue Warning to Agent
  public async warnAgent(agentId: string, reason: string, adminUser: string): Promise<Agent> {
    try {
      const agent = await this.getAgent(agentId);
      if (!agent) {
        throw new Error("Agent not found.");
      }

      const newWarningCount = (agent.warning_count || 0) + 1;
      const now = new Date();

      const rows = await drizzleDb
        .update(agentsTable)
        .set({
          warning_count: newWarningCount,
          last_warning_reason: reason,
          last_warning_at: now,
        })
        .where(eq(agentsTable.id, agentId))
        .returning();

      await this.logAudit(
        adminUser,
        "WARN_AGENT",
        `Agent ${agentId} (${agent.business_name}) issued warning #${newWarningCount}. Reason: ${reason}`
      );

      return parseAgent(rows[0]);
    } catch (error) {
      console.error("Database warnAgent failed:", error);
      throw new Error("Failed to issue warning to agent.", { cause: error });
    }
  }

  // Approve Agent
  public async approveAgent(agentId: string, adminUser: string): Promise<void> {
    try {
      await drizzleDb.update(agentsTable).set({ status: "active" }).where(eq(agentsTable.id, agentId));
      await this.logAudit(
        adminUser,
        "APPROVE_AGENT",
        `Agent ${agentId} approved to serve as physical drop-off point.`
      );
    } catch (error) {
      console.error("Database update failed:", error);
      throw new Error("Failed to approve agent.", { cause: error });
    }
  }

  // Suspend Agent
  public async suspendAgent(agentId: string, adminUser: string): Promise<void> {
    try {
      await drizzleDb.update(agentsTable).set({ status: "suspended" }).where(eq(agentsTable.id, agentId));
      await this.logAudit(
        adminUser,
        "SUSPEND_AGENT",
        `Agent ${agentId} suspended due to quality or verification issues.`
      );
    } catch (error) {
      console.error("Database update failed:", error);
      throw new Error("Failed to suspend agent.", { cause: error });
    }
  }

  // Submit Dispute
  public async createDispute(dispute: Omit<Dispute, "created_at">): Promise<Dispute> {
    try {
      return await drizzleDb.transaction(async (tx) => {
        const rows = await tx
          .insert(disputesTable)
          .values({
            id: dispute.id,
            item_id: dispute.item_id,
            claimant_1_claim_id: dispute.claimant_1_claim_id,
            claimant_2_claim_id: dispute.claimant_2_claim_id,
            claimant_1_id_proof_url: dispute.claimant_1_id_proof_url,
            claimant_2_id_proof_url: dispute.claimant_2_id_proof_url,
          })
          .returning();

        // NOTE: this deliberately does NOT touch items.status. A dispute is
        // about OWNERSHIP, not physical custody, and items.status already
        // correctly represents custody (at_agent / claimed / etc.) on its
        // own — canCreateClaim() in server.ts freezes new claims and public
        // visibility for a disputed item by checking getDisputesByItem()
        // directly, not by inspecting item.status. This used to also set
        // status to 'at_agent' unconditionally, which — had this function
        // ever been called on an item that had already been physically
        // handed over (status='claimed') — would have falsely reverted the
        // record to "physically at the agent hub" and corrupted custody
        // history. Every current call site only reaches createDispute()
        // after canCreateClaim() has already confirmed the item is
        // 'at_agent', so removing this was a pure correctness fix, not a
        // behavior change for any code path that exists today.
        await tx.update(claimsTable).set({ status: "disputed" }).where(eq(claimsTable.id, dispute.claimant_1_claim_id));
        await tx.update(claimsTable).set({ status: "disputed" }).where(eq(claimsTable.id, dispute.claimant_2_claim_id));

        const auditId = "AUD-" + Math.random().toString(36).substr(2, 9).toUpperCase();
        await tx.insert(auditLogTable).values({
          id: auditId,
          admin_user: "SYSTEM",
          action: "CREATE_DISPUTE",
          details: `Dispute flagged on item ${dispute.item_id} between Claim ${dispute.claimant_1_claim_id} and Claim ${dispute.claimant_2_claim_id}`,
        });

        return parseDispute(rows[0]);
      });
    } catch (error) {
      console.error("Dispute creation transaction failed:", error);
      throw new Error("Failed to file dispute.", { cause: error });
    }
  }

  // Lets either claimant in an active dispute submit supporting evidence
  // (free text and/or a photo) for the admin to review alongside the
  // dispute during resolution. Multiple submissions per claim are allowed
  // (e.g. adding a follow-up photo) — all of them are shown to the admin,
  // nothing is overwritten.
  public async createDisputeEvidence(evidence: Omit<DisputeEvidence, "created_at">): Promise<DisputeEvidence> {
    try {
      const rows = await drizzleDb
        .insert(disputeEvidenceTable)
        .values({
          id: evidence.id,
          dispute_id: evidence.dispute_id,
          claim_id: evidence.claim_id,
          submitted_by_phone: evidence.submitted_by_phone,
          evidence_text: evidence.evidence_text,
          evidence_photo_url: evidence.evidence_photo_url,
        })
        .returning();
      return parseDisputeEvidence(rows[0]);
    } catch (error) {
      console.error("Failed to create dispute evidence:", error);
      throw new Error("Failed to submit dispute evidence.", { cause: error });
    }
  }

  public async getDisputeEvidenceForDispute(disputeId: string): Promise<DisputeEvidence[]> {
    try {
      const rows = await drizzleDb
        .select()
        .from(disputeEvidenceTable)
        .where(eq(disputeEvidenceTable.dispute_id, disputeId));
      return rows.map(parseDisputeEvidence);
    } catch (error) {
      console.error("Failed to get dispute evidence:", error);
      return [];
    }
  }

  // Resolve Dispute
  // Resolves a dispute in favor of one claimant. If the losing claimant had
  // already paid into escrow before the dispute was raised, their money is
  // real and sitting with the platform — they are locked into 'refunding'
  // here so server.ts can trigger an actual M-Pesa refund via IntaSend and
  // finalize/revert the lock based on whether that real transfer succeeds.
  // A losing claimant who never actually paid is simply reopened for
  // re-verification instead — no refund is fabricated for money that was
  // never collected. See the payment_reference-based check inside for why
  // this can't rely on claim `status` (createDispute above overwrites both
  // claims' status to 'disputed' unconditionally, so status alone can't
  // tell us who had actually paid).
  public async resolveDispute(
    disputeId: string,
    winningClaimId: string,
    adminUser: string,
    adminNotes: string
  ): Promise<{ refundNeededForClaimId: string | null; refundAmount: string | null; refundPhone: string | null }> {
    try {
      return await drizzleDb.transaction(async (tx) => {
        const disputeRows = await tx.select().from(disputesTable).where(eq(disputesTable.id, disputeId));
        if (disputeRows.length === 0) throw new Error("Dispute not found.");
        const dispute = disputeRows[0];

        // Idempotency guard: a dispute can only be resolved once. Without
        // this, re-submitting an already-resolved dispute (a double-click,
        // a retry, two admin tabs open) would re-run the refund branch
        // below on a claim that was already refunded — payment_reference
        // is never cleared by a refund, so the "was this actually paid"
        // check would still say yes, and a second real M-Pesa refund could
        // be triggered for money that was already returned once.
        if (dispute.resolved_by || dispute.resolved_at) {
          throw new Error("This dispute has already been resolved.");
        }

        // Validate winningClaimId genuinely belongs to this dispute. Without
        // this, passing an arbitrary/unrelated claim ID would still update
        // that claim's status, then the losingClaimId computation below
        // (which just checks "is this claimant_1?") would default to
        // treating the dispute's actual claimant_1 as the loser — silently
        // refunding/rejecting the wrong person's legitimate claim.
        if (winningClaimId !== dispute.claimant_1_claim_id && winningClaimId !== dispute.claimant_2_claim_id) {
          throw new Error("winningClaimId does not belong to this dispute.");
        }

        // Atomic CAS on resolved_at IS NULL — the earlier read-then-check
        // above is a genuine race with two admins resolving the same
        // dispute concurrently (both could read resolved_at=null before
        // either commits). This UPDATE...WHERE is the real guarantee: only
        // one concurrent resolution can ever match this condition.
        const resolvedRows = await tx
          .update(disputesTable)
          .set({
            resolved_by: adminUser,
            resolved_claim_id: winningClaimId,
            resolved_at: new Date(),
            admin_notes: adminNotes,
          })
          .where(and(eq(disputesTable.id, disputeId), isNull(disputesTable.resolved_at)))
          .returning();
        if (resolvedRows.length === 0) {
          throw new Error("This dispute was just resolved by another admin — refresh and try again.");
        }

        // BUGFIX: this used to unconditionally set the winning claim to
        // 'escrow_held' — which is only true if that claim actually has
        // money in escrow. Disputes are now auto-created at claim
        // SUBMISSION time (see the multi-claimant check in server.ts
        // /api/claims/submit), before either claimant has necessarily paid
        // anything, so the common case here is an admin picking a winner
        // between two claims that are both still unpaid. Blindly marking
        // the winner 'escrow_held' would have skipped OTP verification and
        // payment entirely, and later code (settlement, handover) treats
        // 'escrow_held' as a hard guarantee that a real M-Pesa payment is
        // already sitting in escrow — a guarantee that would be false here.
        // Use the same payment_reference signal already used correctly for
        // the losing claim below: only promote to escrow_held if the
        // winner genuinely already paid; otherwise send it back through
        // normal verification like any other claim.
        const winningClaimRows = await tx.select().from(claimsTable).where(eq(claimsTable.id, winningClaimId));
        const winningClaim = winningClaimRows[0];
        const winnerAlreadyPaid = !!(winningClaim && winningClaim.payment_reference);
        await tx
          .update(claimsTable)
          .set({ status: winnerAlreadyPaid ? "escrow_held" : "pending_verification", updated_at: new Date() })
          .where(eq(claimsTable.id, winningClaimId));

        const losingClaimId =
          dispute.claimant_1_claim_id === winningClaimId
            ? dispute.claimant_2_claim_id
            : dispute.claimant_1_claim_id;

        let refundNeededForClaimId: string | null = null;
        let refundAmount: string | null = null;
        let refundPhone: string | null = null;

        if (losingClaimId) {
          const losingClaimRows = await tx.select().from(claimsTable).where(eq(claimsTable.id, losingClaimId));
          const losingClaim = losingClaimRows[0];

          // BUGFIX (found while building the dispute-evidence feature):
          // createDispute() above unconditionally overwrites BOTH claims'
          // status to 'disputed' the moment a dispute is filed — including
          // a pre-existing claim that had already reached 'escrow_held'
          // (a second claimant can file against an item whose first claim
          // is anywhere in its lifecycle, paid or not). That means by the
          // time a dispute reaches resolution, the losing claim's `status`
          // column has ALWAYS already been overwritten to 'disputed' —
          // checking `status === 'escrow_held'` here can never be true,
          // making the refund path below permanently unreachable dead code
          // despite looking correct. `payment_reference` is the right
          // signal instead: it's set once, exactly when a real M-Pesa
          // payment is confirmed (attemptClaimEscrowHold), and is never
          // cleared by any later status transition — confirmed by tracing
          // every updateClaimStatus call site in server.ts. It survives
          // being overwritten to 'disputed' where `status` does not.
          const actuallyPaid = !!(losingClaim && losingClaim.payment_reference);

          if (losingClaim && actuallyPaid) {
            // Lock the claim into 'refunding' inside this same transaction —
            // no other request can act on it (pay, release, re-dispute)
            // while the real M-Pesa refund is in flight.
            await tx.update(claimsTable).set({ status: "refunding", updated_at: new Date() }).where(eq(claimsTable.id, losingClaimId));

            const item = losingClaim.item_id ? (await tx.select().from(itemsTable).where(eq(itemsTable.id, losingClaim.item_id)))[0] : null;
            const category = item?.category_id ? (await tx.select().from(categoriesTable).where(eq(categoriesTable.id, item.category_id)))[0] : null;
            let fee = category ? parseFloat(String(category.total_fee)) : 0;
            if (item && item.locked_total_fee !== undefined && item.locked_total_fee !== null) {
              const locked = typeof item.locked_total_fee === 'string' ? parseFloat(item.locked_total_fee) : item.locked_total_fee;
              if (!isNaN(locked) && locked > 0) fee = locked;
            }

            refundNeededForClaimId = losingClaimId;
            refundAmount = String(fee);
            refundPhone = losingClaim.owner_phone;
          } else {
            await tx.update(claimsTable).set({ status: "pending_verification" }).where(eq(claimsTable.id, losingClaimId));
          }
        }

        const auditId = "AUD-" + Math.random().toString(36).substr(2, 9).toUpperCase();
        await tx.insert(auditLogTable).values({
          id: auditId,
          admin_user: adminUser,
          action: "RESOLVE_DISPUTE",
          details: `Dispute ${disputeId} resolved. Claim ${winningClaimId} won. ${refundNeededForClaimId ? `Losing claim ${refundNeededForClaimId} had already paid — refund queued.` : ''} Notes: ${adminNotes}`,
        });

        return { refundNeededForClaimId, refundAmount, refundPhone };
      });
    } catch (error) {
      console.error("Dispute resolution transaction failed:", error);
      throw new Error("Failed to resolve dispute.", { cause: error });
    }
  }

  // Finalizes a refund after the real M-Pesa transfer has actually
  // succeeded via IntaSend. Only ever called post-transfer — never marks a
  // ledger entry 'completed' for money that hasn't actually moved.
  public async finalizeClaimRefund(claimId: string, amount: string, phone: string): Promise<void> {
    try {
      await drizzleDb.transaction(async (tx) => {
        const claimRows = await tx.select().from(claimsTable).where(eq(claimsTable.id, claimId));
        const claim = claimRows[0];
        await tx.update(claimsTable).set({ status: "refunded", updated_at: new Date() }).where(eq(claimsTable.id, claimId));
        if (claim?.item_id) {
          await tx.update(itemsTable).set({ status: "at_agent" }).where(eq(itemsTable.id, claim.item_id));
        }
        const refundId = "TXN-" + Math.random().toString(36).substr(2, 9).toUpperCase();
        await tx.insert(ledgerTable).values({
          id: refundId,
          claim_id: claimId,
          item_id: claim?.item_id || null,
          type: "refund",
          amount,
          phone_or_till: phone,
          status: "completed",
        });
        const auditId = "AUD-" + Math.random().toString(36).substr(2, 9).toUpperCase();
        await tx.insert(auditLogTable).values({
          id: auditId,
          admin_user: "SYSTEM",
          action: "REFUND_ESCROW",
          details: `Refunded ${amount} KES to owner ${phone} for claim ${claimId} after real M-Pesa disbursement succeeded.`,
        });
      });
    } catch (error) {
      console.error("Failed to finalize claim refund:", error);
      throw new Error("Failed to finalize claim refund.", { cause: error });
    }
  }

  // Reverts a claim out of the 'refunding' lock if the real M-Pesa transfer
  // failed, so it doesn't get stranded — flags it for manual admin
  // reconciliation via the ledger/audit log rather than silently retrying.
  public async revertClaimRefundLock(claimId: string, reason: string): Promise<void> {
    try {
      await drizzleDb
        .update(claimsTable)
        .set({ status: "escrow_held", updated_at: new Date() })
        .where(and(eq(claimsTable.id, claimId), eq(claimsTable.status, "refunding")));
      await this.logAudit("SYSTEM", "REFUND_FAILED_REVERTED", `Refund attempt for claim ${claimId} failed and was reverted to escrow_held: ${reason}. Requires manual admin review.`);
    } catch (error) {
      console.error("Failed to revert claim refund lock:", error);
    }
  }

  // Rating an agent
  public async rateAgent(agentId: string, userRating: number): Promise<void> {
    try {
      await drizzleDb.transaction(async (tx) => {
        const rows = await tx.select().from(agentsTable).where(eq(agentsTable.id, agentId));
        if (rows.length === 0) return;
        const agent = rows[0];

        const rating = agent.rating ? parseFloat(agent.rating) : 5.0;
        const count = agent.rating_count || 0;
        const newRating = parseFloat(((rating * count + userRating) / (count + 1)).toFixed(2));

        await tx
          .update(agentsTable)
          .set({
            rating: String(newRating),
            rating_count: count + 1,
          })
          .where(eq(agentsTable.id, agentId));
      });
    } catch (error) {
      console.error("Agent rating transaction failed:", error);
      throw new Error("Failed to update agent rating.", { cause: error });
    }
  }

  // Create financial ledger entry
  public async logTransaction(entry: Omit<LedgerEntry, "id" | "created_at">): Promise<LedgerEntry> {
    try {
      const newId = "TXN-" + Math.random().toString(36).substr(2, 9).toUpperCase();
      const rows = await drizzleDb
        .insert(ledgerTable)
        .values({
          id: newId,
          claim_id: entry.claim_id,
          item_id: entry.item_id,
          type: entry.type,
          amount: String(entry.amount),
          phone_or_till: entry.phone_or_till,
          status: entry.status,
        })
        .returning();

      return parseLedgerEntry(rows[0]);
    } catch (error) {
      console.error("Database write failed:", error);
      throw new Error("Failed to write ledger transaction.", { cause: error });
    }
  }

  // Create audit log
  public async logAudit(adminUser: string, action: string, details: string): Promise<void> {
    try {
      const newId = "AUD-" + Math.random().toString(36).substr(2, 9).toUpperCase();
      await drizzleDb.insert(auditLogTable).values({
        id: newId,
        admin_user: adminUser,
        action,
        details,
      });
    } catch (error) {
      console.error("Database write failed:", error);
      throw new Error("Failed to write audit log.", { cause: error });
    }
  }

  // --- AGENT VERIFICATION / CORRECTION WORKFLOW ---

  /**
   * Records an Agent's verification/correction pass over a Finder's
   * original item submission. This is the ONLY way verified_* fields on
   * an item are ever written the API surface here (a fixed set of
   * physically-observable fields) structurally prevents an Agent from
   * touching anything financial or identity-related (Finder phone,
   * payout percentages, owner identity, dispute/legal-hold decisions):
   * those fields simply do not exist as parameters this function accepts.
   *
   * verifiedFields must include a value for every correctable field
   * (even ones the Agent is not changing) verified_* columns become the
   * single source of truth once verification completes, so every one of
   * them must end up populated, not just the ones that actually differ
   * from the Finder's original. A field-level audit row is only created
   * for fields that genuinely changed value.
   *
   * Sensitive items (is_sensitive_document) require physicallyVerified to
   * be true before ANY correction to name or document_number is
   * accepted an Agent must never "correct" identity information from
   * memory or a Finder's say-so without having physically looked at the
   * item. This is enforced here, not just suggested in the UI.
   */
  public async recordItemVerification(
    itemId: string,
    agentId: string,
    verifiedFields: {
      category_id: string;
      name: string | null;
      document_number: string | null;
      description: string | null;
      found_area: string;
    },
    reason: string,
    reasonDetail: string | null,
    physicallyVerified: boolean
  ): Promise<{ success: boolean; message: string }> {
    try {
      return await drizzleDb.transaction(async (tx) => {
        const itemRows = await tx.select().from(itemsTable).where(eq(itemsTable.id, itemId));
        if (itemRows.length === 0) return { success: false, message: "Item not found." };
        const item = itemRows[0];

        const originalValues: Record<string, string | null> = {
          category_id: item.category_id,
          name: item.ocr_extracted_name,
          document_number: item.ocr_extracted_number,
          description: item.description,
          found_area: item.location_description,
        };

        const newValues: Record<string, string | null> = {
          category_id: verifiedFields.category_id,
          name: verifiedFields.name,
          document_number: verifiedFields.document_number,
          description: verifiedFields.description,
          found_area: verifiedFields.found_area,
        };

        const changedFields = Object.keys(newValues).filter(
          f => (originalValues[f] ?? null) !== (newValues[f] ?? null)
        );

        if (item.is_sensitive_document && !physicallyVerified) {
          const touchesIdentity = changedFields.includes('name') || changedFields.includes('document_number');
          if (touchesIdentity) {
            return {
              success: false,
              message: "Marekebisho ya jina/nambari ya hati nyeti yanahitaji uthibitisho wa kimwili wa Agent kabla ya kukubaliwa. / Corrections to a sensitive document's name/number require the Agent's physical verification before they can be accepted.",
            };
          }
        }

        if (changedFields.length > 0 && (!reason || !reason.trim())) {
          return { success: false, message: 'Toa sababu ya marekebisho. / A reason is required for any correction.' };
        }

        for (const field of changedFields) {
          await tx.insert(itemVerificationChangesTable).values({
            id: "IVC-" + Math.random().toString(36).substr(2, 9).toUpperCase(),
            item_id: itemId,
            agent_id: agentId,
            field_name: field,
            original_value: originalValues[field],
            verified_value: newValues[field],
            reason,
            reason_detail: reasonDetail,
          });
        }

        await tx.update(itemsTable).set({
          verified_category_id: newValues.category_id,
          verified_name: newValues.name,
          verified_document_number: newValues.document_number,
          verified_description: newValues.description,
          verified_found_area: newValues.found_area,
          verification_status: changedFields.length > 0 ? 'corrected' : 'confirmed_as_reported',
          physically_verified_at: physicallyVerified ? new Date() : item.physically_verified_at,
          category_id: newValues.category_id,
        }).where(eq(itemsTable.id, itemId));

        await tx.insert(auditLogTable).values({
          id: "AUD-" + Math.random().toString(36).substr(2, 9).toUpperCase(),
          admin_user: agentId,
          action: "ITEM_VERIFICATION_RECORDED",
          details: `Item ${itemId}: ${changedFields.length > 0 ? `corrected fields [${changedFields.join(', ')}]` : 'confirmed as reported'} by agent ${agentId}. Physically verified: ${physicallyVerified}. Reason: ${reason || '(none no changes)'}`,
        });

        return { success: true, message: changedFields.length > 0 ? 'Corrections saved.' : 'Confirmed as reported.' };
      });
    } catch (error) {
      console.error("Database write failed:", error);
      return { success: false, message: `Failed to record item verification: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  public async getItemVerificationChanges(itemId: string): Promise<ItemVerificationChange[]> {
    try {
      const rows = await drizzleDb.select().from(itemVerificationChangesTable).where(eq(itemVerificationChangesTable.item_id, itemId));
      return rows.map(parseItemVerificationChange);
    } catch (error) {
      console.error("Database query failed:", error);
      throw new Error("Failed to query item verification changes.", { cause: error });
    }
  }

  // --- PLATFORM SETTINGS (generic admin-toggleable key/value store) ---

  public async getSetting(key: string): Promise<string | null> {
    try {
      const rows = await drizzleDb.select().from(platformSettingsTable).where(eq(platformSettingsTable.key, key)).limit(1);
      return rows.length > 0 ? rows[0].value : null;
    } catch (error) {
      console.error("Database read failed:", error);
      // Fail safe: if we can't even read the setting, callers that gate a
      // risky action (like the social-publishing pause) should treat this
      // the same as "paused" rather than assuming "not paused" and
      // proceeding — see isSocialPublishingPaused() in server.ts.
      throw new Error("Failed to read platform setting.", { cause: error });
    }
  }

  public async setSetting(key: string, value: string, adminUser: string): Promise<void> {
    try {
      await drizzleDb
        .insert(platformSettingsTable)
        .values({ key, value, updated_by: adminUser, updated_at: new Date() })
        .onConflictDoUpdate({
          target: platformSettingsTable.key,
          set: { value, updated_by: adminUser, updated_at: new Date() },
        });
      await this.logAudit(adminUser, "SETTING_CHANGED", `Setting '${key}' set to '${value}'`);
    } catch (error) {
      console.error("Database write failed:", error);
      throw new Error("Failed to write platform setting.", { cause: error });
    }
  }

  // --- SOCIAL PUBLICATION IDEMPOTENCY ---
  // See the schema.ts comment on social_publications for the full
  // reasoning. The pattern: claim the slot BEFORE calling the provider
  // API, record the real result AFTER. If the claim fails (a row already
  // exists for this item+platform+type), the caller must not attempt the
  // post at all — someone already has, or is already attempting to.

  /**
   * Attempts to atomically claim the right to publish (item, platform,
   * publicationType). Returns true if this call won the claim (safe to
   * proceed and call the actual provider API) — false if a row already
   * exists (already published, already failed, or a concurrent request
   * already claimed it), meaning the caller must skip posting entirely.
   */
  public async claimSocialPublicationSlot(itemId: string, platform: string, publicationType: string): Promise<boolean> {
    try {
      const rows = await drizzleDb
        .insert(socialPublicationsTable)
        .values({
          id: "SPUB-" + Math.random().toString(36).substr(2, 9).toUpperCase(),
          item_id: itemId,
          platform,
          publication_type: publicationType,
          status: "pending",
          attempt_count: 1,
        })
        .onConflictDoNothing({ target: [socialPublicationsTable.item_id, socialPublicationsTable.platform, socialPublicationsTable.publication_type] })
        .returning();
      return rows.length > 0;
    } catch (error) {
      console.error("Failed to claim social publication slot:", error);
      // Fail safe: if we can't even determine whether a slot is claimed,
      // don't post — a missed post is recoverable (an admin can trigger a
      // fresh attempt later), a duplicate post is not.
      return false;
    }
  }

  /**
   * Records the actual outcome of a publication attempt against the slot
   * claimed above. Called exactly once per claimSocialPublicationSlot()
   * that returned true.
   */
  public async recordSocialPublicationResult(
    itemId: string,
    platform: string,
    publicationType: string,
    result: { status: 'published' | 'failed'; providerPostId?: string | null; lastError?: string | null }
  ): Promise<void> {
    try {
      await drizzleDb
        .update(socialPublicationsTable)
        .set({
          status: result.status,
          provider_post_id: result.providerPostId ?? null,
          last_error: result.lastError ?? null,
          completed_at: result.status === 'published' ? new Date() : null,
        })
        .where(and(
          eq(socialPublicationsTable.item_id, itemId),
          eq(socialPublicationsTable.platform, platform),
          eq(socialPublicationsTable.publication_type, publicationType)
        ));
    } catch (error) {
      console.error("Failed to record social publication result:", error);
    }
  }

  // --- CORE BUSINESS ESCROW LOGIC ---

  /**
   * Release Escrow: Triggered when both Owner collects the item from the Agent
   * splits: total_fee -> 40% Finder Share, 32% Agent Share, 28% Platform Share
   */
  // Atomically transitions a claim from 'escrow_held' to a transient
  // 'releasing' state, and only proceeds if THIS call is the one that
  // performed the transition. Using a WHERE-guarded UPDATE (rather than a
  // separate SELECT-then-UPDATE) closes a real race window: without this,
  // several concurrent /api/agents/confirm-handover requests for the same
  // claim could all read status='escrow_held' before any of them wrote back,
  // and all would then attempt to trigger a real M-Pesa payout — a double
  // (or N-times) disbursement of real money for a single handover.
  // Atomically transitions a claim from 'pending_payment' to 'escrow_held'.
  // Payment providers (IntaSend included) are free to redeliver the same
  // webhook event more than once — on their retry timeout, on a slow 2xx,
  // or just a duplicate send. Without this compare-and-swap, two overlapping
  // deliveries for the same claim can both read 'pending_payment' before
  // either write lands, and both run the full confirmation flow: a second
  // pickup code is generated (overwriting the first, so the owner's earlier
  // SMS code silently stops working) and duplicate emails/SMS go out. This
  // mirrors the attemptSettlementRelease() CAS pattern used for payout release.
  public async attemptClaimEscrowHold(claimId: string, paymentRef: string): Promise<boolean> {
    try {
      const rows = await drizzleDb
        .update(claimsTable)
        .set({ status: 'escrow_held', payment_reference: paymentRef || null, updated_at: new Date() })
        .where(and(eq(claimsTable.id, claimId), eq(claimsTable.status, 'pending_payment')))
        .returning();
      return rows.length > 0;
    } catch (error) {
      console.error("Failed to atomically hold claim in escrow:", error);
      return false;
    }
  }

  // Resolves the actual finder/agent/platform amounts to pay for a claim's
  // item, preferring the fee-engine amounts locked in at report time (so a
  // category edited after the item was reported never changes what's owed)
  // and falling back to the category's current flat shares only for items
  // reported before this locking existed.
  private resolvePayoutSplit(item: { locked_finder_share: string | number | null; locked_agent_share: string | number | null; locked_platform_share: string | number | null }, category: { finder_share: string | number; agent_share: string | number; platform_share: string | number }) {
    let finderShare = parseFloat(String(category.finder_share));
    let agentShare = parseFloat(String(category.agent_share));
    let platformShare = parseFloat(String(category.platform_share));

    if (
      item.locked_finder_share !== undefined && item.locked_finder_share !== null &&
      item.locked_agent_share !== undefined && item.locked_agent_share !== null &&
      item.locked_platform_share !== undefined && item.locked_platform_share !== null
    ) {
      const lockedFinder = typeof item.locked_finder_share === 'string' ? parseFloat(item.locked_finder_share) : item.locked_finder_share;
      const lockedAgent = typeof item.locked_agent_share === 'string' ? parseFloat(item.locked_agent_share) : item.locked_agent_share;
      const lockedPlatform = typeof item.locked_platform_share === 'string' ? parseFloat(item.locked_platform_share) : item.locked_platform_share;

      if (!isNaN(lockedFinder) && !isNaN(lockedAgent) && !isNaN(lockedPlatform) && lockedFinder >= 0 && lockedAgent >= 0 && lockedPlatform >= 0) {
        finderShare = lockedFinder;
        agentShare = lockedAgent;
        platformShare = lockedPlatform;
      }
    }
    return { finderShare, agentShare, platformShare };
  }

  /**
   * STAGE 1 of settlement: called right after the agent verifies the pickup
   * code and handover photo. The item has physically left custody at this
   * point, so its status becomes 'claimed' immediately — that's a real-world
   * fact and shouldn't wait on anything financial. The money itself does
   * NOT move yet: three ledger rows are booked with status 'pending' (the
   * split the claim will eventually pay out), and settle_at is set to
   * now + disputeWindowMs. Nothing disburses via M-Pesa until the settlement
   * sweep (or an admin override) calls attemptSettlementRelease once that
   * window has passed and no dispute has frozen the claim in the meantime.
   */
  public async enterPendingSettlement(claimId: string, disputeWindowMs: number): Promise<{ success: boolean; message: string; settleAt?: Date }> {
    try {
      return await drizzleDb.transaction(async (tx) => {
        const claimRows = await tx.select().from(claimsTable).where(eq(claimsTable.id, claimId));
        if (claimRows.length === 0) return { success: false, message: "Claim not found." };
        const claim = claimRows[0];
        if (claim.status !== "escrow_held") {
          return { success: false, message: `Cannot enter settlement. Claim is in status: ${claim.status}` };
        }

        const itemRows = await tx.select().from(itemsTable).where(eq(itemsTable.id, claim.item_id || ""));
        if (itemRows.length === 0) return { success: false, message: "Item not found." };
        const item = itemRows[0];

        const categoryRows = await tx.select().from(categoriesTable).where(eq(categoriesTable.id, item.category_id || ""));
        if (categoryRows.length === 0) return { success: false, message: "Category not found." };
        const category = categoryRows[0];

        const agentRows = await tx.select().from(agentsTable).where(eq(agentsTable.id, item.assigned_agent_id || ""));
        if (agentRows.length === 0) return { success: false, message: "Agent not found." };
        const agent = agentRows[0];

        const settleAt = new Date(Date.now() + disputeWindowMs);

        await tx
          .update(claimsTable)
          .set({ status: "pending_settlement", settle_at: settleAt, updated_at: new Date() })
          .where(eq(claimsTable.id, claimId));

        // The item is physically back with its owner now — this is a
        // physical-custody fact, independent of whether the money behind it
        // has actually settled yet.
        await tx.update(itemsTable).set({ status: "claimed" }).where(eq(itemsTable.id, item.id));

        const { finderShare, agentShare, platformShare } = this.resolvePayoutSplit(item, category);

        await tx.insert(ledgerTable).values({
          id: "TXN-" + Math.random().toString(36).substr(2, 9).toUpperCase(),
          claim_id: claimId,
          item_id: item.id,
          type: "finder_payout",
          amount: String(finderShare),
          phone_or_till: item.finder_phone,
          status: "pending",
        });
        await tx.insert(ledgerTable).values({
          id: "TXN-" + Math.random().toString(36).substr(2, 9).toUpperCase(),
          claim_id: claimId,
          item_id: item.id,
          type: "agent_payout",
          amount: String(agentShare),
          phone_or_till: agent.mpesa_till_or_paybill,
          status: "pending",
        });
        await tx.insert(ledgerTable).values({
          id: "TXN-" + Math.random().toString(36).substr(2, 9).toUpperCase(),
          claim_id: claimId,
          item_id: item.id,
          type: "platform_fee",
          amount: String(platformShare),
          phone_or_till: "Return4me Platform Paybill",
          status: "pending",
        });

        await tx.insert(auditLogTable).values({
          id: "AUD-" + Math.random().toString(36).substr(2, 9).toUpperCase(),
          admin_user: "SYSTEM",
          action: "ENTER_PENDING_SETTLEMENT",
          details: `Claim ${claimId}: handover confirmed, item marked claimed, payout booked as pending. Settles at ${settleAt.toISOString()} unless disputed or admin-frozen before then.`,
        });

        return { success: true, message: "Handover confirmed. Payout is booked and will settle after the dispute window.", settleAt };
      });
    } catch (error) {
      console.error("Enter pending settlement failed:", error);
      return {
        success: false,
        message: `Failed to enter pending settlement: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Returns claims whose dispute window has elapsed and are still sitting in
   * 'pending_settlement' (i.e. nobody disputed or froze them in the
   * meantime) — the settlement sweep's work queue.
   */
  public async getClaimsDueForSettlement(): Promise<Claim[]> {
    try {
      const rows = await drizzleDb.select().from(claimsTable).where(eq(claimsTable.status, "pending_settlement"));
      const now = Date.now();
      const due = rows.filter(r => r.settle_at && new Date(r.settle_at).getTime() <= now);
      return due.map(parseClaim);
    } catch (error) {
      console.error("Database query failed:", error);
      throw new Error("Failed to query claims due for settlement.", { cause: error });
    }
  }

  /**
   * STAGE 2 of settlement, part A: atomically claims the exclusive right to
   * actually disburse a claim's payout. force=true (admin override) skips
   * the settle_at check — used for a manual "release now" action — but
   * still requires the claim to genuinely be in 'pending_settlement', so it
   * can never be used to release something that's disputed, already
   * released, or never reached handover.
   */
  public async attemptSettlementRelease(claimId: string, force: boolean = false): Promise<boolean> {
    try {
      const claimRows = await drizzleDb.select().from(claimsTable).where(eq(claimsTable.id, claimId));
      if (claimRows.length === 0) return false;
      const claim = claimRows[0];
      if (claim.status !== "pending_settlement") return false;
      if (!force) {
        if (!claim.settle_at || new Date(claim.settle_at).getTime() > Date.now()) return false;
      }
      const rows = await drizzleDb
        .update(claimsTable)
        .set({ status: "releasing", updated_at: new Date() })
        .where(and(eq(claimsTable.id, claimId), eq(claimsTable.status, "pending_settlement")))
        .returning();
      return rows.length > 0;
    } catch (error) {
      console.error("Failed to atomically claim settlement release lock:", error);
      return false;
    }
  }

  // Rolls a claim back from 'releasing' to 'pending_settlement' if the real
  // M-Pesa disbursement attempt failed, so the next settlement sweep (or a
  // retried admin override) can safely try again with the same booked
  // pending ledger rows.
  public async revertSettlementRelease(claimId: string): Promise<void> {
    try {
      await drizzleDb
        .update(claimsTable)
        .set({ status: "pending_settlement", updated_at: new Date() })
        .where(and(eq(claimsTable.id, claimId), eq(claimsTable.status, "releasing")));
    } catch (error) {
      console.error("Failed to revert settlement release lock:", error);
    }
  }

  /**
   * STAGE 2 of settlement, part B: called only after the real M-Pesa payout
   * has actually succeeded. Flips the claim to 'released' and marks its
   * three pending ledger rows 'completed' — it does not insert new ledger
   * rows, since those were already booked back in enterPendingSettlement.
   */
  public async finalizeSettlement(claimId: string): Promise<{ success: boolean; message: string }> {
    try {
      return await drizzleDb.transaction(async (tx) => {
        const claimRows = await tx.select().from(claimsTable).where(eq(claimsTable.id, claimId));
        if (claimRows.length === 0) return { success: false, message: "Claim not found." };
        const claim = claimRows[0];
        if (claim.status !== "releasing") {
          return { success: false, message: `Cannot finalize settlement. Claim is in status: ${claim.status}` };
        }

        // Defensive guard, not just caller discipline: refuse to finalize
        // if any finder_payout/agent_payout row for this claim isn't
        // already genuinely 'completed' — i.e. confirmed by an actual
        // provider result via recordPayoutAttempt, not assumed. Without
        // this check, the bulk "mark everything pending as completed"
        // update below would silently launder a still-outstanding or
        // failed payout into looking settled.
        const claimLedgerRows = await tx.select().from(ledgerTable).where(eq(ledgerTable.claim_id, claimId));
        const outstandingPayout = claimLedgerRows.find(
          r => (r.type === 'finder_payout' || r.type === 'agent_payout') && r.status !== 'completed'
        );
        if (outstandingPayout) {
          return { success: false, message: `Cannot finalize settlement — ${outstandingPayout.type} is still '${outstandingPayout.status}', not confirmed completed.` };
        }

        await tx
          .update(claimsTable)
          .set({ status: "released", updated_at: new Date() })
          .where(eq(claimsTable.id, claimId));

        // Only the platform_fee row (which never goes through an external
        // payout provider — it's the platform's own retained share) should
        // still be 'pending' at this point; finder_payout/agent_payout
        // rows were already individually confirmed 'completed' above.
        await tx
          .update(ledgerTable)
          .set({ status: "completed" })
          .where(and(eq(ledgerTable.claim_id, claimId), eq(ledgerTable.status, "pending")));

        await tx.insert(auditLogTable).values({
          id: "AUD-" + Math.random().toString(36).substr(2, 9).toUpperCase(),
          admin_user: "SYSTEM",
          action: "FINALIZE_SETTLEMENT",
          details: `Claim ${claimId}: dispute window closed, M-Pesa payout succeeded, ledger entries marked completed.`,
        });

        return { success: true, message: "Settlement finalized and payouts executed successfully via M-Pesa!" };
      });
    } catch (error) {
      console.error("Finalize settlement failed:", error);
      return {
        success: false,
        message: `Finalize settlement transaction failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * NOTE: the old refundEscrow() here has been replaced by the
   * attemptClaimRefundLock/finalizeClaimRefund/revertClaimRefundLock flow
   * used from resolveDispute() below. The previous version marked a ledger
   * entry 'completed' with the message "Refund successfully processed to
   * the owner M-Pesa account!" purely by flipping DB rows — it never
   * actually called IntaSend, so it would have silently faked a real money
   * transfer the moment anything called it. It also had no caller anywhere
   * in the codebase, so this was dead code rather than an active bug, but
   * it's exactly the kind of trap that bites the first time someone wires
   * a "refund this claim" button up to it. See PaymentService in
   * services/payments.ts for the real IntaSend disbursement call.
   */

  public async getDistinctRegions(): Promise<string[]> {
    const fallbackRegions = [
      "Kilimani", "Westlands", "Nairobi CBD", "Kileleshwa", "Karen",
      "Ngong Road", "Mombasa", "Kisumu", "Nakuru", "Eldoret",
      "Kisii", "Thika", "Machakos", "Nyeri", "Kakamega",
      "Lavington", "Hurlingham", "South C", "South B", "Langata",
      "Runda", "Muthaiga", "Gigiri", "Parklands", "Madaraka",
      "Donholm", "Buruburu", "Eastleigh", "Embakasi", "Ruiru"
    ];

    try {
      const rows = await drizzleDb.select({
        location_description: itemsTable.location_description
      }).from(itemsTable);

      if (rows.length === 0) {
        return fallbackRegions;
      }

      // Group and count frequency of locations
      const counts: Record<string, number> = {};
      for (const row of rows) {
        if (row.location_description) {
          const loc = row.location_description.trim();
          if (loc) {
            counts[loc] = (counts[loc] || 0) + 1;
          }
        }
      }

      const sortedUnique = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);

      // Keep them unique and append fallbacks
      const resultSet = new Set<string>();
      for (const item of sortedUnique) {
        // Simple normalization: title case
        const normalized = item.charAt(0).toUpperCase() + item.slice(1);
        resultSet.add(normalized);
      }
      for (const r of fallbackRegions) {
        resultSet.add(r);
      }

      return Array.from(resultSet);
    } catch (error) {
      console.error("Failed to query distinct regions:", error);
      return fallbackRegions;
    }
  }

  public async getCategoriesWithUsage(): Promise<(Category & { item_count: number })[]> {
    try {
      const cats = await this.getCategories();
      const allItems = await drizzleDb.select().from(itemsTable);
      return cats.map(cat => {
        const count = allItems.filter(item => item.category_id === cat.id).length;
        return {
          ...cat,
          item_count: count
        };
      });
    } catch (error) {
      console.error("Database query failed:", error);
      throw new Error("Failed to query categories with usage.", { cause: error });
    }
  }

  public async getItemsCountForCategory(id: string): Promise<number> {
    try {
      const rows = await drizzleDb.select().from(itemsTable).where(eq(itemsTable.category_id, id));
      return rows.length;
    } catch (error) {
      console.error("Database query failed:", error);
      throw new Error("Failed to query item count for category.", { cause: error });
    }
  }

  public async createCategory(cat: {
    id: string;
    name_en: string;
    name_sw: string;
    total_fee: number;
    finder_share: number;
    agent_share: number;
    platform_share: number;
    is_sensitive_document: boolean;
    base_fee?: number;
    complexity_fee?: number;
    delay_fee?: number;
    ceiling_percent?: number;
    finder_pct?: number;
    agent_pct?: number;
    platform_pct?: number;
    finder_reward_cap?: number | null;
    elevated_review?: boolean;
    public_clue_style?: string;
  }): Promise<Category> {
    try {
      const rows = await drizzleDb.insert(categoriesTable).values({
        id: cat.id,
        name_en: cat.name_en,
        name_sw: cat.name_sw,
        total_fee: String(cat.total_fee),
        finder_share: String(cat.finder_share),
        agent_share: String(cat.agent_share),
        platform_share: String(cat.platform_share),
        is_sensitive_document: cat.is_sensitive_document,
        base_fee: String(cat.base_fee ?? cat.total_fee),
        complexity_fee: String(cat.complexity_fee ?? 0),
        delay_fee: String(cat.delay_fee ?? 0),
        ceiling_percent: String(cat.ceiling_percent ?? 12),
        finder_pct: String(cat.finder_pct ?? 25),
        agent_pct: String(cat.agent_pct ?? 35),
        platform_pct: String(cat.platform_pct ?? 40),
        finder_reward_cap: cat.finder_reward_cap !== undefined && cat.finder_reward_cap !== null ? String(cat.finder_reward_cap) : null,
        elevated_review: cat.elevated_review ?? false,
        public_clue_style: cat.public_clue_style ?? 'generic',
      }).returning();
      return parseCategory(rows[0]);
    } catch (error) {
      console.error("Database write failed:", error);
      throw new Error("Failed to create category.", { cause: error });
    }
  }

  public async updateCategory(
    id: string,
    cat: {
      name_en: string;
      name_sw: string;
      total_fee: number;
      finder_share: number;
      agent_share: number;
      platform_share: number;
      is_sensitive_document: boolean;
      is_admin_modified?: boolean;
      base_fee?: number;
      complexity_fee?: number;
      delay_fee?: number;
      ceiling_percent?: number;
      finder_pct?: number;
      agent_pct?: number;
      platform_pct?: number;
      finder_reward_cap?: number | null;
      elevated_review?: boolean;
      public_clue_style?: string;
    }
  ): Promise<Category> {
    try {
      const setData: Record<string, any> = {
        name_en: cat.name_en,
        name_sw: cat.name_sw,
        total_fee: String(cat.total_fee),
        finder_share: String(cat.finder_share),
        agent_share: String(cat.agent_share),
        platform_share: String(cat.platform_share),
        is_sensitive_document: cat.is_sensitive_document,
        is_admin_modified: cat.is_admin_modified,
      };
      if (cat.base_fee !== undefined) setData.base_fee = String(cat.base_fee);
      if (cat.complexity_fee !== undefined) setData.complexity_fee = String(cat.complexity_fee);
      if (cat.delay_fee !== undefined) setData.delay_fee = String(cat.delay_fee);
      if (cat.ceiling_percent !== undefined) setData.ceiling_percent = String(cat.ceiling_percent);
      if (cat.finder_pct !== undefined) setData.finder_pct = String(cat.finder_pct);
      if (cat.agent_pct !== undefined) setData.agent_pct = String(cat.agent_pct);
      if (cat.platform_pct !== undefined) setData.platform_pct = String(cat.platform_pct);
      if (cat.finder_reward_cap !== undefined) setData.finder_reward_cap = cat.finder_reward_cap !== null ? String(cat.finder_reward_cap) : null;
      if (cat.elevated_review !== undefined) setData.elevated_review = cat.elevated_review;
      if (cat.public_clue_style !== undefined) setData.public_clue_style = cat.public_clue_style;

      const rows = await drizzleDb.update(categoriesTable).set(setData).where(eq(categoriesTable.id, id)).returning();
      return parseCategory(rows[0]);
    } catch (error) {
      console.error("Database update failed:", error);
      throw new Error("Failed to update category.", { cause: error });
    }
  }

  public async deleteCategory(id: string): Promise<void> {
    try {
      await drizzleDb.delete(categoriesTable).where(eq(categoriesTable.id, id));
    } catch (error) {
      console.error("Database delete failed:", error);
      throw new Error("Failed to delete category.", { cause: error });
    }
  }

  // Record a payment strike for a phone number
  public async recordPaymentStrike(phone: string): Promise<void> {
    try {
      const existing = await drizzleDb
        .select()
        .from(claimPaymentStrikesTable)
        .where(eq(claimPaymentStrikesTable.phone_number, phone));

      if (existing.length > 0) {
        await drizzleDb
          .update(claimPaymentStrikesTable)
          .set({
            strike_count: existing[0].strike_count + 1,
            last_strike_at: new Date(),
            is_cleared_by_admin: false,
          })
          .where(eq(claimPaymentStrikesTable.phone_number, phone));
      } else {
        await drizzleDb
          .insert(claimPaymentStrikesTable)
          .values({
            phone_number: phone,
            strike_count: 1,
            last_strike_at: new Date(),
            is_cleared_by_admin: false,
          });
      }
    } catch (error) {
      console.error("Failed to record payment strike:", error);
      throw new Error("Failed to record payment strike.");
    }
  }

  // Get strike count for a phone number
  public async getPaymentStrikeCount(phone: string): Promise<number> {
    try {
      const rows = await drizzleDb
        .select()
        .from(claimPaymentStrikesTable)
        .where(eq(claimPaymentStrikesTable.phone_number, phone));

      if (rows.length === 0 || rows[0].is_cleared_by_admin) {
        return 0;
      }
      return rows[0].strike_count;
    } catch (error) {
      console.error("Failed to get payment strike count:", error);
      return 0; // Safe fallback
    }
  }

  // Clear payment strikes for a phone number
  public async clearPaymentStrikes(phone: string): Promise<void> {
    try {
      await drizzleDb
        .update(claimPaymentStrikesTable)
        .set({
          strike_count: 0,
          is_cleared_by_admin: true,
        })
        .where(eq(claimPaymentStrikesTable.phone_number, phone));
    } catch (error) {
      console.error("Failed to clear payment strikes:", error);
      throw new Error("Failed to clear payment strikes.");
    }
  }

  // Get all payment strikes for admin view
  public async getAllPaymentStrikes(): Promise<any[]> {
    try {
      const rows = await drizzleDb
        .select()
        .from(claimPaymentStrikesTable);
      return rows.filter(r => r.strike_count > 0);
    } catch (error) {
      console.error("Failed to get all payment strikes:", error);
      return [];
    }
  }

  // --- OTP PERSISTENCE (replaces old in-memory Map so OTPs survive restarts
  // and the app can run more than one server process) ---

  public async setOtp(phone: string, codeHash: string, expiresAt: Date): Promise<void> {
    try {
      const existing = await drizzleDb
        .select()
        .from(otpCodesTable)
        .where(eq(otpCodesTable.phone_number, phone));

      if (existing.length > 0) {
        await drizzleDb
          .update(otpCodesTable)
          .set({ code_hash: codeHash, expires_at: expiresAt, attempts: 0, created_at: new Date() })
          .where(eq(otpCodesTable.phone_number, phone));
      } else {
        await drizzleDb
          .insert(otpCodesTable)
          .values({ phone_number: phone, code_hash: codeHash, expires_at: expiresAt, attempts: 0 });
      }
    } catch (error) {
      console.error("Failed to set OTP:", error);
      throw new Error("Failed to persist OTP.");
    }
  }

  public async getOtp(phone: string): Promise<{ code_hash: string; expires_at: Date; attempts: number } | undefined> {
    try {
      const rows = await drizzleDb
        .select()
        .from(otpCodesTable)
        .where(eq(otpCodesTable.phone_number, phone));
      if (rows.length === 0) return undefined;
      return {
        code_hash: rows[0].code_hash,
        expires_at: new Date(rows[0].expires_at as any),
        attempts: rows[0].attempts,
      };
    } catch (error) {
      console.error("Failed to get OTP:", error);
      return undefined;
    }
  }

  public async incrementOtpAttempts(phone: string): Promise<number> {
    try {
      const rows = await drizzleDb
        .select()
        .from(otpCodesTable)
        .where(eq(otpCodesTable.phone_number, phone));
      if (rows.length === 0) return 0;
      const nextAttempts = rows[0].attempts + 1;
      await drizzleDb
        .update(otpCodesTable)
        .set({ attempts: nextAttempts })
        .where(eq(otpCodesTable.phone_number, phone));
      return nextAttempts;
    } catch (error) {
      console.error("Failed to increment OTP attempts:", error);
      return 0;
    }
  }

  public async deleteOtp(phone: string): Promise<void> {
    try {
      await drizzleDb.delete(otpCodesTable).where(eq(otpCodesTable.phone_number, phone));
    } catch (error) {
      console.error("Failed to delete OTP:", error);
    }
  }

  // --- CLAIM OTPS (Tier 2 per-claim verification, persisted) ---

  public async setClaimOtp(claimId: string, codeHash: string, expiresAt: Date): Promise<void> {
    try {
      const existing = await drizzleDb
        .select()
        .from(claimOtpsTable)
        .where(eq(claimOtpsTable.claim_id, claimId));

      if (existing.length > 0) {
        await drizzleDb
          .update(claimOtpsTable)
          .set({ code_hash: codeHash, expires_at: expiresAt, attempts: 0, created_at: new Date() })
          .where(eq(claimOtpsTable.claim_id, claimId));
      } else {
        await drizzleDb
          .insert(claimOtpsTable)
          .values({ claim_id: claimId, code_hash: codeHash, expires_at: expiresAt, attempts: 0 });
      }
    } catch (error) {
      console.error("Failed to set claim OTP:", error);
      throw new Error("Failed to persist claim OTP.");
    }
  }

  public async getClaimOtp(claimId: string): Promise<{ code_hash: string; expires_at: Date; attempts: number } | undefined> {
    try {
      const rows = await drizzleDb
        .select()
        .from(claimOtpsTable)
        .where(eq(claimOtpsTable.claim_id, claimId));
      if (rows.length === 0) return undefined;
      return {
        code_hash: rows[0].code_hash,
        expires_at: new Date(rows[0].expires_at as any),
        attempts: rows[0].attempts,
      };
    } catch (error) {
      console.error("Failed to get claim OTP:", error);
      return undefined;
    }
  }

  public async incrementClaimOtpAttempts(claimId: string): Promise<number> {
    try {
      const rows = await drizzleDb
        .select()
        .from(claimOtpsTable)
        .where(eq(claimOtpsTable.claim_id, claimId));
      if (rows.length === 0) return 0;
      const nextAttempts = rows[0].attempts + 1;
      await drizzleDb
        .update(claimOtpsTable)
        .set({ attempts: nextAttempts })
        .where(eq(claimOtpsTable.claim_id, claimId));
      return nextAttempts;
    } catch (error) {
      console.error("Failed to increment claim OTP attempts:", error);
      return 0;
    }
  }

  public async deleteClaimOtp(claimId: string): Promise<void> {
    try {
      await drizzleDb.delete(claimOtpsTable).where(eq(claimOtpsTable.claim_id, claimId));
    } catch (error) {
      console.error("Failed to delete claim OTP:", error);
    }
  }

  // --- CLAIM PAYMENT AUTHORIZATION (short-lived token gating /pay) ---
  // See the matching comment on claim_payment_auth in schema.ts. Minted by
  // POST /api/agents/claims/:id/confirm-viewing the moment an agent
  // physically confirms the owner in person; required by POST
  // /api/claims/:id/pay before a real M-Pesa STK push can be triggered.

  public async setClaimPaymentAuthToken(claimId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    try {
      const existing = await drizzleDb
        .select()
        .from(claimPaymentAuthTable)
        .where(eq(claimPaymentAuthTable.claim_id, claimId));

      if (existing.length > 0) {
        await drizzleDb
          .update(claimPaymentAuthTable)
          .set({ token_hash: tokenHash, expires_at: expiresAt, created_at: new Date() })
          .where(eq(claimPaymentAuthTable.claim_id, claimId));
      } else {
        await drizzleDb
          .insert(claimPaymentAuthTable)
          .values({ claim_id: claimId, token_hash: tokenHash, expires_at: expiresAt });
      }
    } catch (error) {
      console.error("Failed to set claim payment authorization token:", error);
      throw new Error("Failed to persist claim payment authorization token.");
    }
  }

  public async getClaimPaymentAuthToken(claimId: string): Promise<{ token_hash: string; expires_at: Date } | undefined> {
    try {
      const rows = await drizzleDb
        .select()
        .from(claimPaymentAuthTable)
        .where(eq(claimPaymentAuthTable.claim_id, claimId));
      if (rows.length === 0) return undefined;
      return {
        token_hash: rows[0].token_hash,
        expires_at: new Date(rows[0].expires_at as any),
      };
    } catch (error) {
      console.error("Failed to get claim payment authorization token:", error);
      return undefined;
    }
  }

  // --- CLAIM PICKUP CODES (real secret handover verification codes) ---

  public async createPickupCode(claimId: string, codeHash: string): Promise<void> {
    try {
      const existing = await drizzleDb
        .select()
        .from(claimPickupCodesTable)
        .where(eq(claimPickupCodesTable.claim_id, claimId));

      if (existing.length > 0) {
        await drizzleDb
          .update(claimPickupCodesTable)
          .set({ code_hash: codeHash, verified_at: null, created_at: new Date() })
          .where(eq(claimPickupCodesTable.claim_id, claimId));
      } else {
        await drizzleDb
          .insert(claimPickupCodesTable)
          .values({ claim_id: claimId, code_hash: codeHash });
      }
    } catch (error) {
      console.error("Failed to create pickup code:", error);
      throw new Error("Failed to create pickup code.");
    }
  }

  public async getPickupCode(claimId: string): Promise<{ code_hash: string; verified_at: Date | null } | undefined> {
    try {
      const rows = await drizzleDb
        .select()
        .from(claimPickupCodesTable)
        .where(eq(claimPickupCodesTable.claim_id, claimId));
      if (rows.length === 0) return undefined;
      return {
        code_hash: rows[0].code_hash,
        verified_at: rows[0].verified_at ? new Date(rows[0].verified_at as any) : null,
      };
    } catch (error) {
      console.error("Failed to get pickup code:", error);
      return undefined;
    }
  }

  public async markPickupCodeVerified(claimId: string): Promise<void> {
    try {
      await drizzleDb
        .update(claimPickupCodesTable)
        .set({ verified_at: new Date() })
        .where(eq(claimPickupCodesTable.claim_id, claimId));
    } catch (error) {
      console.error("Failed to mark pickup code verified:", error);
    }
  }

  public async setHandoverPhoto(claimId: string, photoUrl: string): Promise<void> {
    try {
      await drizzleDb
        .update(claimsTable)
        .set({ handover_photo_url: photoUrl })
        .where(eq(claimsTable.id, claimId));
    } catch (error) {
      console.error("Failed to set handover photo:", error);
      throw new Error("Failed to save handover evidence photo.");
    }
  }

  // Get admin user by username
  public async getAdminByUsername(username: string): Promise<AdminUser | null> {
    try {
      const rows = await drizzleDb
        .select()
        .from(adminUsersTable)
        .where(eq(adminUsersTable.username, username));
      if (rows.length === 0) {
        return null;
      }
      return parseAdminUser(rows[0]);
    } catch (error) {
      console.error("Failed to get admin by username:", error);
      return null;
    }
  }

  // Create an admin user
  public async createAdminUser(id: string, username: string, passwordHash: string, fullName: string): Promise<AdminUser> {
    try {
      const rows = await drizzleDb
        .insert(adminUsersTable)
        .values({
          id,
          username,
          password_hash: passwordHash,
          full_name: fullName,
          is_active: true,
        })
        .returning();
      return parseAdminUser(rows[0]);
    } catch (error) {
      console.error("Failed to create admin user:", error);
      throw new Error("Failed to create admin user.");
    }
  }

  // Update admin user's last login timestamp
  public async updateAdminLastLogin(id: string): Promise<void> {
    try {
      await drizzleDb
        .update(adminUsersTable)
        .set({ last_login_at: new Date() })
        .where(eq(adminUsersTable.id, id));
    } catch (error) {
      console.error("Failed to update admin last login:", error);
    }
  }

  // Stores a freshly-generated TOTP secret for an admin who has started
  // 2FA enrollment. Deliberately does NOT set totp_enabled — that only
  // happens in confirmAdminTotpEnrollment below, once the admin has proven
  // they can actually generate a valid code from it. Storing the secret
  // alone first (unconfirmed) means a half-finished enrollment can never
  // lock the admin out: login still only requires a code once enabled=true.
  public async setAdminTotpSecret(adminId: string, secret: string): Promise<void> {
    try {
      await drizzleDb
        .update(adminUsersTable)
        .set({ totp_secret: secret, totp_enabled: false })
        .where(eq(adminUsersTable.id, adminId));
    } catch (error) {
      console.error("Failed to set admin TOTP secret:", error);
      throw new Error("Failed to set admin TOTP secret.");
    }
  }

  public async confirmAdminTotpEnrollment(adminId: string): Promise<void> {
    try {
      await drizzleDb
        .update(adminUsersTable)
        .set({ totp_enabled: true })
        .where(eq(adminUsersTable.id, adminId));
    } catch (error) {
      console.error("Failed to confirm admin TOTP enrollment:", error);
      throw new Error("Failed to confirm admin TOTP enrollment.");
    }
  }

  // Lets an admin turn 2FA back off (e.g. lost device) — requires the
  // caller (server.ts route) to have already re-verified the admin's
  // password before calling this, same as any other sensitive account
  // change.
  public async disableAdminTotp(adminId: string): Promise<void> {
    try {
      await drizzleDb
        .update(adminUsersTable)
        .set({ totp_enabled: false, totp_secret: null })
        .where(eq(adminUsersTable.id, adminId));
    } catch (error) {
      console.error("Failed to disable admin TOTP:", error);
      throw new Error("Failed to disable admin TOTP.");
    }
  }

  // Check if any admin users exist in the database
  public async isAdminTableEmpty(): Promise<boolean> {
    try {
      const rows = await drizzleDb.select().from(adminUsersTable).limit(1);
      return rows.length === 0;
    } catch (error) {
      console.error("Failed to check if admin_users is empty:", error);
      return false; // Safe fallback to avoid seed collisions on connection issues
    }
  }

  // Kenya Data Protection Act 2019 Section 40 erasure process
  public async purgeUserData(phone: string): Promise<void> {
    try {
      // 1. Scrub claims reported by this phone (anonymize owner PII)
      await drizzleDb
        .update(claimsTable)
        .set({
          owner_phone: "[REDACTED-DPA-2019]",
          owner_email: null,
          owner_id_proof_url: null,
          owner_identifying_details: "Erasure completed per Section 40 of Kenya DPA 2019."
        })
        .where(eq(claimsTable.owner_phone, phone));

      // 2. Scrub finder personal details on items reported by this phone
      await drizzleDb
        .update(itemsTable)
        .set({
          finder_phone: "[REDACTED-DPA-2019]",
          finder_email: null,
          photo_url: "DELETED-PER-USER-ERASURE-REQUEST"
        })
        .where(eq(itemsTable.finder_phone, phone));

      // 3. Clear reputation entries for this phone
      await drizzleDb
        .delete(phoneReputationsTable)
        .where(eq(phoneReputationsTable.phone_number, phone));

      // 4. Clear strike entries for this phone
      await drizzleDb
        .delete(claimPaymentStrikesTable)
        .where(eq(claimPaymentStrikesTable.phone_number, phone));

      console.log(`[DPA ERASURE] Personal data associated with phone ${maskPhoneForLog(phone)} successfully purged.`);
    } catch (error) {
      console.error("[DPA ERASURE ERROR] Failed to purge user data:", error);
      throw new Error("Failed to execute data erasure request on database.");
    }
  }
}

export const db = new DatabaseEngine();
