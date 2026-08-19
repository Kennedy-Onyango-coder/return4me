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

// Translation bundles for English & Kiswahili
export const translations = {
  en: {
    appName: 'Return4me',
    tagline: 'Find your way back.',
    motto: 'Trusted lost-and-found hub in Kenya connecting Finders, Owners, and Agents.',
    finderBtn: 'I Found Something',
    ownerBtn: 'I Lost Something',
    agentBtn: 'Agent Portal',
    adminBtn: 'Admin Console',
    langToggle: 'Swahili (Kiswahili)',
    logout: 'Logout',
    
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
    locLabel: 'Rough Location Found (e.g. Near Yaya Centre)',
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
    ownerTitle: 'Search for Your Lost Document',
    ownerSubtitle: 'Enter your document number or name. Results are masked to preserve your privacy.',
    searchPlaceholder: 'Search by ID Number, Plate Number, or Name...',
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
  sw: {
    appName: 'Return4me',
    tagline: 'Tafuta njia ya kurudi.',
    motto: 'Kituo cha kuaminika cha lost-and-found nchini Kenya kinachounganisha Waliopata, Wamiliki, na Mawakala.',
    finderBtn: 'Nimepata Kitu',
    ownerBtn: 'Nimepoteza Kitu',
    agentBtn: 'Kituo cha Mawakala',
    adminBtn: 'Usimamizi',
    langToggle: 'English',
    logout: 'Toka',

    // Finder Journey
    finderTitle: 'Ripoti Kitu Kilichopatikana',
    finderSubtitle: 'Uaminifu wako unawaunganisha watu na hati zao. Uwasilishaji unafanyika salama kupitia mawakala walioidhinishwa, na utapokea zawadi ya M-Pesa.',
    capturePhoto: 'Piga/Weka Picha ya Kitu',
    takeSnap: 'Piga Picha',
    useCamera: 'Tumia Kamera',
    uploadFile: 'Weka Faili ya Picha',
    analyzing: 'Return4me inachanganua bidhaa yako...',
    ocrSuccess: 'Tumejaza maelezo hapa chini — tafadhali thibitisha au usahihishe.',
    ocrNone: 'Hatukuweza kusoma maandishi kiotomatiki. Tafadhali weka maelezo kwa mkono hapa chini.',
    categoryLabel: 'Kategoria ya Bidhaa',
    docNumberLabel: 'Nambari ya Hati/Seriali (ikiwa inaonekana)',
    docNameLabel: 'Majina Kamili kwenye Hati (ikiwa yanaonekana)',
    locLabel: 'Mahali Takriban Ulipopata (Mfano Karibu na Yaya Centre)',
    gpsLabel: 'Shiriki Vipimo vya GPS (Hiari, kwa ugawaji bora wa wakala)',
    gpsSuccess: 'Eneo la GPS Limepatikana!',
    phonePayout: 'Nambari yako ya M-Pesa ya Kupokelea Zawadi',
    submitReport: 'Wasilisha Ripoti na Upangiwe Wakala',
    successReport: 'Ripoti Imelindwa Kikamilifu!',
    dropoffInstructions: 'Tafadhali peleka bidhaa hii ndani ya saa 48-72 kwa wakala aliyepangiwa:',
    dropoffCode: 'Msimbo wa Kuwasilisha Bidhaa',
    directionNote: 'Wasilisha msimbo huu kwa wakala wakati wa kuwasilisha bidhaa. Ulinde salama.',
    agentDetails: 'Wakala wa Return4me Aliyepangiwa',

    // Owner Journey
    ownerTitle: 'Tafuta Hati Yako Iliyopotea',
    ownerSubtitle: 'Weka nambari ya hati yako au jina. Matokeo yamefichwa kulinda faragha yako.',
    searchPlaceholder: 'Tafuta kwa Nambari ya ID, Bamba la Nambari, au Jina...',
    noResults: 'Hakuna kulingana kulikopatikana bado. Jaribu kutafuta kwa jina fupi au uangalie baadaye!',
    maskedName: 'Jina la Mmiliki',
    foundAt: 'Kupatikana Karibu na',
    reported: 'Imeripotiwa',
    claimBtn: 'Hii ni Yangu',
    verifyTitle: 'Thibitisha Umiliki Wako',
    verifySubtitle: 'Hatua ya 1 ya 3: Jibu maswali ya usalama ili kuzuia madai ya ulaghai.',
    lastDigitsQuest: 'Nambari 4 za mwisho za hati hii ni gani?',
    colorQuest: 'Rangi au maelezo ya jalada la kitu hiki ni gani?',
    extraQuest: 'Toa maelezo yoyote ya ziada au lini/wapi ulipoteza:',
    verifySubmit: 'Thibitisha na Uendelee na Malipo',
    paymentTitle: 'Malipo ya Escrow Yaliyozuiliwa',
    paymentSubtitle: 'Ada ya uwasilishaji inahitajika. Hii inashikiliwa kwa escrow na inatolewa tu kwa wakala/mtafutaji mara tu unapochukua bidhaa yako physically.',
    releaseFee: 'Ada ya Uwasilishaji',
    mpesaPhoneLabel: 'Nambari ya M-Pesa kwa STK Push',
    stkBtn: 'Lipia kupitia M-Pesa STK Push (Simulated)',
    paymentSuccess: 'Malipo Imepokelewa! Bidhaa yako ipo tayari kuchukuliwa.',
    collectionCode: 'Msimbo wa Kuchukulia Bidhaa',
    collectionInstructions: 'Nenda kwa wakala, onyesha msimbo wako wa kuchukulia na Kitambulisho chako cha Kitaifa upokee bidhaa yako!',

    // Agent Portal
    agentTitle: 'Kituo cha Mawakala wa Return4me',
    agentSubtitle: 'Pokea bidhaa na usimamie uchukuaji uliothibitishwa na wamiliki. Pata kamisheni kwa usalama.',
    applyBtn: 'Jisajili kama Wakala Mpya wa Return4me',
    businessName: 'Jina la Biashara / Cyber Café',
    mpesaTill: 'Nambari ya M-Pesa Till au Paybill (Payout Target)',
    nationalId: 'Nambari yako ya Kitambulisho cha Kitaifa (KYC)',
    registerSubmit: 'Wasilisha Maombi ya Wakala',
    pendingApproval: 'Maombi yako yanangojea kuidhinishwa na msimamizi. Tutakuarifu hivi karibuni.',
    agentQueue: 'Orodha zako za Kazi za Physical Processing',
    expectedDropoffs: 'Mizigo Inayotarajiwa kutoka kwa Waliopata',
    holdingPickups: 'Mizigo Tayari Kuchukuliwa na Wamiliki',
    confirmDropBtn: 'Thibitisha Kupokea Kitu physically',
    confirmPickBtn: 'Thibitisha Kuwasilisha kwa Mmiliki',
    enterDropCode: 'Weka Msimbo wa Finder kuwasilisha (Mfano R4M-...)',
    rateAgentLabel: 'Je, ulionaje uzoefu wa uwasilishaji huu?',

    // Admin Console
    adminTitle: 'Kituo cha Usimamizi Mkuu',
    adminSubtitle: 'Idhinisha mawakala, dhibiti mapitio ya OCR, kagua vitabu vya kifedha na utatue migogoro ya wamiliki.',
    statsTab: 'Takwimu Kuu',
    agentsTab: 'Mawakala wapya',
    disputesTab: 'Migogoro Wazi',
    ledgerTab: 'Kitabu cha Fedha',
    approveBtn: 'Idhinisha Wakala',
    suspendBtn: 'Sitisha',
    resolveDisputeBtn: 'Tatua Mgogoro',
    openDisputes: 'Migogoro ya Claims Wazi (Inahitaji Ukaguzi wa ID)',
    disputeDesc: 'Watu wawili wanadai kitu kimoja kilichopatikana. Kagua nakala za vitambulisho vilivyowekwa kufanya uamuzi wa mwisho.',
    ledgerTitle: 'Kumbukumbu za Kifedha zisizobadilika (Audit Trail)',
    totalRev: 'Mapato ya Jumla',
    categoriesTab: 'Kategoria na Bei',
  },
};
