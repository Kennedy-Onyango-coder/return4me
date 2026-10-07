export interface Category {
  id: string;
  name_en: string;
  name_sw: string;
  total_fee: number;
  finder_share: number;
  agent_share: number;
  platform_share: number;
  is_sensitive_document?: boolean;
  is_admin_modified?: boolean;
}

export interface Agent {
  id: string;
  business_name: string;
  contact_phone: string;
  location_address: string;
  latitude: number;
  longitude: number;
  mpesa_till_or_paybill: string;
  payout_method_type?: string;
  status: 'pending' | 'active' | 'suspended';
  refundable_deposit: number;
  national_id_hash: string;
  rating: number;
  rating_count: number;
  needs_manual_geocoding?: boolean;
  contact_email?: string | null;
  shop_photo_url?: string | null;
  id_document_photo_url?: string | null;
  warning_count?: number;
  last_warning_reason?: string | null;
  last_warning_at?: string | Date | null;
  terms_accepted_at?: string | Date | null;
  created_at?: string | Date;
}

export interface MaskedItem {
  id: string;
  category_id: string;
  photo_url: string;
  document_name_fuzzy: string;
  location_description: string;
  created_at: string;
  status: 'awaiting_dropoff' | 'at_agent' | 'claimed' | 'expired';
  agent?: Agent;
}

export interface FoundItem {
  id: string;
  category_id: string;
  photo_url: string;
  ocr_extracted_number: string | null;
  ocr_extracted_name: string | null;
  document_number_hash: string | null;
  document_name_fuzzy: string | null;
  location_description: string;
  latitude: number | null;
  longitude: number | null;
  // PHASE 9D — the Finder's explicitly chosen canonical Kenyan county for the
  // found item, or null when unknown (legacy rows predating the field). This
  // is user-declared geographic data used for internal matching consistency;
  // it is NOT part of any public DTO.
  found_county?: string | null;
  finder_phone: string;
  assigned_agent_id: string;
  status: "awaiting_dropoff" | "at_agent" | "claimed" | "expired" | "rejected";
  flaggedForReview: boolean;
  isDescriptionOnly: boolean;
  description: string | null;
  is_sensitive_document: boolean;
  rejection_reason: string | null;
  created_at: string;
  locked_total_fee?: number | null;
  locked_finder_share?: number | null;
  locked_agent_share?: number | null;
  locked_platform_share?: number | null;
}

// English copy strings. The product is English-only: there is no bilingual
// dictionary and no per-language lookup.
export const translations = {
  en: {
    appName: 'Return4me',
    tagline: 'Find your way back.',
    motto: 'Trusted lost-and-found hub in Kenya connecting Finders, Owners, and Agents.',
    finderBtn: 'I Found Something',
    ownerBtn: 'I Lost Something',
    agentBtn: 'Agent Portal',
    adminBtn: 'Admin Console',
    // Phase 8.1 — public navigation labels. "Become an Agent" is the public
    // entry to the agent journey (it leads to the marketing surface, which in
    // turn opens /agent_portal); "Sign In" is the single public authentication
    // entry that offers the Owner/Claimant and Agent paths. The internal label
    // above ('Agent Portal') is retained for non-navigation use only.
    becomeAgentBtn: 'Become an Agent',
    signInBtn: 'Sign In',
    appearanceLabel: 'Appearance',
    appearanceLight: 'Light',
    appearanceDark: 'Dark',
    appearanceSystem: 'System',
    logout: 'Logout',
    
    // Verification Field Labels
    verify: {
      lastDigits: 'Last 4 digits of document',
      lastDigitsPlaceholder: 'e.g. 4521',
      lastDigitsHelp: 'This helps us confirm you are the rightful owner without exposing your full ID number.',
      passportDigitsPlaceholder: 'e.g. 7890',
      cardDigitsPlaceholder: 'e.g. 3456',
      cardDigitsHelp: 'The last 4 digits printed on the card.',
      fullName: 'Full name on document',
      fullNamePlaceholder: 'e.g. John Kamau Mwangi',
      plateNumber: 'Vehicle registration plate number',
      plateNumberPlaceholder: 'e.g. KDG 123A',
      manufacturer: 'Manufacturer / Brand',
      manufacturerPlaceholder: 'e.g. Samsung, Apple, Toyota',
      color: 'Colour of the item',
      colorPlaceholder: 'e.g. Blue, Silver, Black',
      distinctiveMarks: 'Distinctive marks, scratches, or stickers',
      distinctiveMarksPlaceholder: 'e.g. Screen crack on bottom right, "Return if found" sticker on back',
      lostLocation: 'Approximate location lost',
      lostLocationPlaceholder: 'e.g. Near Yaya Centre, along Uhuru Highway',
      lostDate: 'Approximate date lost',
      lostDatePlaceholder: 'e.g. Last Tuesday afternoon',
      nationality: 'Nationality',
      nationalityPlaceholder: 'e.g. Kenyan',
      bankName: 'Bank name',
      bankNamePlaceholder: 'e.g. Equity Bank, KCB',
      brand: 'Brand (if known)',
      brandPlaceholder: 'e.g. Gucci, Louis Vuitton',
      keyCount: 'Number of keys on the keyring',
      keyCountPlaceholder: 'e.g. 5 keys',
      institution: 'Institution name',
      institutionPlaceholder: 'e.g. University of Nairobi',
      description: 'Describe the item',
      descriptionPlaceholder: 'Provide as much detail as possible to help verify ownership',
      extraDetails: 'Additional details (when/where lost)',
      extraDetailsPlaceholder: 'e.g. Lost inside a Super Metro matatu going to Westlands',
      colorDetail: 'Colour/cover description',
      colorDetailPlaceholder: 'e.g. blue plastic wallet, black casing',
    },

    // Finder Journey
    finderTitle: 'Report a Found Item',
    finderSubtitle: 'Your honesty reunites families with their documents. Handover happens safely through certified agents, and you receive an M-Pesa reward.',
    capturePhoto: 'Capture/Upload Photo of Item',
    takeSnap: 'Take Photo',
    useCamera: 'Use Camera',
    uploadFile: 'Upload Image File',
    analyzing: 'Return4me is scanning your item...',
    ocrSuccess: 'We\'ve pre-filled some details below — please verify or correct them.',
    ocrNone: 'We could not auto-read text. Please enter details manually below.',
    categoryLabel: 'Item Category',
    docNumberLabel: 'Document/Serial Number (if visible)',
    docNameLabel: 'Full Name on Document (if visible)',
    // P14C-3A — this label used to read "Rough Location Found (e.g. Near Yaya
    // Centre)", which described the field as approximate. It is the Finder's own
    // exact description of where the item was found, so it now says so. Only
    // FinderView consumes this key.
    locLabel: 'Exact place',
    gpsLabel: 'Share GPS Coordinates (Optional for best agent assignment)',
    gpsSuccess: 'GPS Location Captured!',
    phonePayout: 'Your M-Pesa Phone Number (For automatic reward payout)',
    submitReport: 'Submit Report & Assign Agent',
    successReport: 'Report Saved Successfully!',
    dropoffInstructions: 'Please physical drop-off this item within 48-72 hours to the assigned agent:',
    dropoffCode: 'Physical Drop-Off Code',
    directionNote: 'Present this code to the agent during physical drop-off. Keep it secure.',
    agentDetails: 'Assigned Return4me Agent Hub',

    // Owner Journey
    ownerTitle: 'Find My Lost Item',
    ownerSubtitle: 'Search available found items by name, identifying number, plate number, or other details. Results are masked to protect privacy.',
    searchPlaceholder: 'Search by name, ID number, plate number, or item details...',
    noResults: 'No matches found yet. Try searching for partial names, or check back later!',
    maskedName: 'Holder Name',
    foundAt: 'Found Near',
    reported: 'Reported',
    claimBtn: 'This is Mine',
    verifyTitle: 'Verify Your Ownership',
    verifySubtitle: 'Step 1 of 3: Answer security questions to prevent fraudulent claims.',
    lastDigitsQuest: 'What are the last 4 digits of this document number?',
    colorQuest: 'What is the color or cover detail of this item?',
    extraQuest: 'Provide any other detail or when/where you lost it:',
    verifySubmit: 'Verify & Proceed to Escrow Payment',
    paymentTitle: 'Payment Held in Escrow',
    paymentSubtitle: 'A delivery fee is required. This is held in escrow and only released to the agent/finder once you physically collect your item.',
    releaseFee: 'Release Fee',
    mpesaPhoneLabel: 'M-Pesa Phone Number for STK Push',
    stkBtn: 'Trigger M-Pesa STK Push (Simulated)',
    paymentSuccess: 'Payment Received! Your item is ready for collection.',
    collectionCode: 'Physical Collection Handover Code',
    collectionInstructions: 'Go to the agent, show your handover code and national ID, and receive your item!',

    // Agent Portal
    agentTitle: 'Return4me Agent Hub',
    agentSubtitle: 'Receive physical drop-offs and process verified owner collections. Earn commissions safely.',
    // N4 — why the business email is now required. Stated in the UI because an
    // applicant who is not told will simply treat "required" as arbitrary, and
    // an unverified agent is blocked from every agent operation.
    agentEmailHelp: 'We send a verification link to this address. You must confirm it before you can use the Agent Hub.',
    applyBtn: 'Register as a New Return4me Agent',
    businessName: 'Business / Cyber Café Name',
    mpesaTill: 'M-Pesa Till or Paybill Number (Payout Target)',
    nationalId: 'Your Personal National ID Number (KYC)',
    registerSubmit: 'Submit Agent Application',
    pendingApproval: 'Your agent application is pending admin approval. We will notify you shortly.',
    agentQueue: 'Your Physical Processing Queues',
    expectedDropoffs: 'Pending Drop-offs (Expected from Finders)',
    holdingPickups: 'Awaiting Pickup (Expect Owners)',
    confirmDropBtn: 'Confirm Physical Drop-off',
    confirmPickBtn: 'Confirm Owner Handover',
    enterDropCode: 'Enter Finder Drop-off Code (e.g., R4M-...)',
    rateAgentLabel: 'How did you rate the handover experience?',
    // PHASE 16.1 BATCH 4B-1 (B1 / B2 / B5 / B6) - Agent Hub queue
    // comprehension copy. Every string the batch adds lives here, in both
    // languages, rather than as an inline English literal in the Hub.
    agentPendingPaymentNote: 'Payment is pending. This item cannot be handed over until the owner completes payment.',
    agentNoClaimInfoNote: 'No claim information is attached to this item. If a claim exists, it is not at a stage shown in this queue.',
    agentQueueRefresh: 'Refresh Queue',
    agentQueueRefreshing: 'Refreshing your queue...',
    // PHASE 16.1 BATCH 4B-2 — compact, truthful per-item context.
    agentItemContextItem: 'Item',
    agentItemContextCategory: 'Category',
    agentItemContextLocation: 'Location',
    agentItemContextReported: 'Reported',
    agentItemContextUnavailable: 'Location not provided',
    agentDropoffQueueRole: 'Drop-off expected',
    agentHandoverQueueRole: 'Pickup / handover',
    agentDropoffsEmpty: 'No physical drop-offs are pending now.',
    agentHandoversEmpty: 'No handovers are pending now.',
    // UX-13 - the authenticated Agent workspace header, operational summary and
    // empty-state explanations. Bilingual like every other Agent Hub string,
    // because a new visible label may never ship English-only.
    agentWorkspaceEyebrow: 'Return4me agent workspace',
    agentWorkspaceTitle: 'Operations',
    agentWorkspaceIntro: 'Everything waiting on you, in one place. Receive drop-offs, verify items and complete handovers here.',
    agentNeedsAttention: 'Needs your action',
    agentNeedsAttentionHint: 'Drop-offs to receive, and claims to verify or hand over.',
    agentInCustody: 'In your custody',
    agentInCustodyHint: 'Items currently held at your station.',
    agentWaitingOnOwner: 'Waiting on the owner',
    agentWaitingOnOwnerHint: 'Held until the owner completes payment.',
    agentDropoffQueueEmptyExplain: 'A drop-off appears here as soon as a finder hands an item in at your station.',
    agentHandoverQueueEmptyExplain: 'Items you are holding for an owner stay here until the handover is complete.',
    agentWorkflowLabel: 'Next step',
    agentDropoffWorkflow: 'Review the item when it arrives.',
    agentReview: 'Review',
    agentReject: 'Reject',
    // AGENTHUB UX BATCH 4 — verification action hierarchy. The panel submits ONE
    // action whose outcome depends on two independent facts: whether the agent
    // corrected the Finder's report, and whether the item was physically
    // inspected. These keys replace four compound English-only labels that
    // bundled two consequences behind an "&". They state only what the existing
    // workflow does (record verification, and approve when physically checked)
    // and imply nothing about payment, refund, payout, or notification.
    agentVerifyConfirmReported: 'Confirm As Reported',
    agentVerifySaveCorrections: 'Save Corrections',
    agentVerifyApprovesToo: 'This also approves the drop-off.',
    agentVerifySavesOnly: 'This saves your work. Inspect the item physically, then approve it.',
    agentVerifySubmitHint: 'Verification',
    // AGENTHUB UX BATCH 2 (UX-03) — the consequence statement shown beside the
    // rejection action. It states only what the server actually enforces in
    // POST /api/agents/reject-dropoff (src/server.ts): the item is rejected and
    // removed from Return4me, and the decision is attributed to the acting
    // Agent rather than to the system. It deliberately promises nothing about
    // refunds, finder notification, or any other outcome the server does not
    // decide on this route.
    agentRejectConsequence: 'Rejecting removes this item from Return4me permanently. The decision is recorded against your Agent account and cannot be undone from this screen.',
    agentCancel: 'Cancel',

    // Admin Console
    adminTitle: 'System Administrator Console',
    adminSubtitle: 'Approve physical agents, manage OCR reviews, audit transaction ledgers, and resolve owner disputes.',
    statsTab: 'Overview Stats',
    agentsTab: 'Vetting Queue',
    disputesTab: 'Open Disputes',
    ledgerTab: 'Immutable Ledger',
    approveBtn: 'Approve Agent',
    suspendBtn: 'Suspend',
    resolveDisputeBtn: 'Resolve Dispute',
    openDisputes: 'Open Claims Disputes (Requires ID Proof Check)',
    disputeDesc: 'Two claimants are disputing the same found item. Examine uploaded IDs to make the final resolution.',
    ledgerTitle: 'Financial Transaction Log (Audit Trail)',
    totalRev: 'Platform Earnings (Your Share)',
    categoriesTab: 'Categories & Pricing',
  },
};
