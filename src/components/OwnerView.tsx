import React, { useState, useEffect, useRef } from 'react';
import { translations } from '../types';
import { Search, AlertCircle, ShieldAlert, CheckCircle, Smartphone, ArrowRight, Loader2, Coins, MapPin, Star, Lock, Eye, Clock, XCircle, AlertTriangle } from 'lucide-react';

interface OwnerViewProps {
  lang: 'en' | 'sw';
  categories: any[];
  categoriesLoading?: boolean;
  categoriesError?: boolean;
}

// The "Track My Claim" status badge previously always rendered in the same
// green/success color and the same raw snake_case string for every status,
// including 'disputed', 'rejected', 'refunding', and 'refunded' — an owner
// whose claim was rejected or who lost a dispute (even one who'd already
// been refunded) saw the exact same green "SUCCESS-LOOKING" badge as
// someone whose item was ready for pickup. Maps each claim status to a
// bilingual label and a color that actually matches the outcome.
function getClaimStatusDisplay(status: string, lang: 'en' | 'sw'): { label: string; className: string } {
  const map: Record<string, { en: string; sw: string; className: string }> = {
    pending_verification: { en: 'Pending Verification', sw: 'Inasubiri Uthibitisho', className: 'bg-amber-100 text-amber-800' },
    awaiting_agent_confirmation: { en: 'Awaiting Agent Confirmation', sw: 'Inasubiri Uthibitisho wa Wakala', className: 'bg-amber-100 text-amber-800' },
    pending_payment: { en: 'Payment Pending', sw: 'Malipo Yanasubiri', className: 'bg-amber-100 text-amber-800' },
    payment_window_expired: { en: 'Payment Window Expired', sw: 'Muda wa Malipo Umeisha', className: 'bg-red-100 text-red-800' },
    escrow_held: { en: 'Payment Confirmed', sw: 'Malipo Yamethibitishwa', className: 'bg-emerald-100 text-emerald-800' },
    released: { en: 'Item Collected', sw: 'Bidhaa Imechukuliwa', className: 'bg-emerald-100 text-emerald-800' },
    disputed: { en: 'Under Dispute Review', sw: 'Inakaguliwa (Mzozo)', className: 'bg-orange-100 text-orange-800' },
    rejected: { en: 'Claim Rejected', sw: 'Ombi Limekataliwa', className: 'bg-red-100 text-red-800' },
    refunding: { en: 'Refund In Progress', sw: 'Urejeshaji Unaendelea', className: 'bg-amber-100 text-amber-800' },
    refunded: { en: 'Refunded to M-Pesa', sw: 'Umerejeshewa kwa M-Pesa', className: 'bg-sky-100 text-sky-800' },
  };
  const entry = map[status];
  if (!entry) return { label: status, className: 'bg-stone-100 text-stone-800' };
  return { label: lang === 'sw' ? entry.sw : entry.en, className: entry.className };
}

export default function OwnerView({ lang, categories, categoriesLoading = false, categoriesError = false }: OwnerViewProps) {
  const t = translations[lang];

  // Search States
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCat, setSelectedCat] = useState('');
  const [selectedArea, setSelectedArea] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [testModeEnabled, setTestModeEnabled] = useState(false);
  const [simulatedPickupCode, setSimulatedPickupCode] = useState<string | null>(null);

  // Regions Dynamic List
  const [regions, setRegions] = useState<string[]>([]);
  const [regionsLoading, setRegionsLoading] = useState<boolean>(true);
  const [regionsError, setRegionsError] = useState<boolean>(false);

  useEffect(() => {
    const fetchRegions = async () => {
      try {
        setRegionsLoading(true);
        setRegionsError(false);
        const res = await fetch('/api/regions');
        if (!res.ok) throw new Error('Failed to fetch regions');
        const data = await res.json();
        setRegions(data);
      } catch (err) {
        console.error('Failed to load regions:', err);
        setRegionsError(true);
      } finally {
        setRegionsLoading(false);
      }
    };
    fetchRegions();

    // Check whether dev/test conveniences (like a payment simulator) are
    // available — only ever true off-production with mock OTP bypass on.
    fetch('/api/dev/test-mode')
      .then(res => res.json())
      .then(data => setTestModeEnabled(!!data.testModeEnabled))
      .catch(() => setTestModeEnabled(false));
  }, []);

  // Active claim/verification flow
  const [selectedItem, setSelectedItem] = useState<any | null>(null);
  const [verificationStep, setVerificationStep] = useState<
    'search' | 'confidence_gate' | 'tier1_security' | 'tier2_otp' | 'tier3_id' | 'payment' | 'payment_polling' | 'handover_success' | 'awaiting_agent_confirmation' | 'payment_window_expired'
  >('search');

  // Verification Form states
  const [lastDigits, setLastDigits] = useState('');
  const [colorDetail, setColorDetail] = useState('');
  const [lostDetails, setLostDetails] = useState('');
  const [lastNameOnDoc, setLastNameOnDoc] = useState('');
  const [whereLost, setWhereLost] = useState('');
  const [plateNumber, setPlateNumber] = useState('');
  const [ownerPhone, setOwnerPhone] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [otpCode, setOtpCode] = useState('');

  // Track My Claim modal states
  const [showTrackModal, setShowTrackModal] = useState(false);
  const [trackClaimId, setTrackClaimId] = useState('');
  const [trackPhone, setTrackPhone] = useState('');
  const [trackLoading, setTrackLoading] = useState(false);
  const [trackError, setTrackError] = useState('');
  const [trackResult, setTrackResult] = useState<any | null>(null);

  const [idProofBase64, setIdProofBase64] = useState<string | null>(null);
  const [idUploadConsent, setIdUploadConsent] = useState(false);
  const [agreedTerms, setAgreedTerms] = useState(false);

  // Confidence Gate states
  const [ownerIdentifyingDetails, setOwnerIdentifyingDetails] = useState('');
  const [isConfident, setIsConfident] = useState(false);

  // Payment states
  const [isPaying, setIsPaying] = useState(false);
  const [paidClaim, setPaidClaim] = useState<any | null>(null);
  const [strikeWarning, setStrikeWarning] = useState<string | null>(null);
  const [pollingStatus, setPollingStatus] = useState<'pending' | 'success' | 'failed' | 'timeout'>('pending');
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const pollingIntervalRef = useRef<any>(null);

  useEffect(() => {
    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (verificationStep === 'payment' && paidClaim?.agent_confirmed_at) {
      const confirmedTime = new Date(paidClaim.agent_confirmed_at).getTime();
      const calculateTimeLeft = () => {
        const diff = confirmedTime + 15 * 60 * 1000 - Date.now();
        if (diff <= 0) {
          setTimeLeft(0);
          setVerificationStep('payment_window_expired');
        } else {
          setTimeLeft(Math.floor(diff / 1000));
        }
      };
      
      calculateTimeLeft();
      const timer = setInterval(calculateTimeLeft, 1000);
      return () => clearInterval(timer);
    }
  }, [verificationStep, paidClaim?.agent_confirmed_at]);

  // Agent Rating
  const [userRating, setUserRating] = useState<number | null>(null);
  const [ratingSubmitted, setRatingSubmitted] = useState(false);

  // Trigger search
  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setSearchLoading(true);
    setErrorMsg('');
    setHasSearched(true);

    try {
      const params = new URLSearchParams();
      if (searchQuery) params.append('q', searchQuery);
      if (selectedCat) params.append('categoryId', selectedCat);
      if (selectedArea) params.append('area', selectedArea);

      const response = await fetch(`/api/items/search?${params.toString()}`);
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Search failed');
      }

      setSearchResults(data);
    } catch (e: any) {
      console.error(e);
      setErrorMsg(e.message);
    } finally {
      setSearchLoading(false);
    }
  };

  // Perform public area-browsing directly on mounting to draw attention to existing items
  useEffect(() => {
    handleSearch();
  }, []);

  const isInitialMount = useRef(true);

  // Auto-trigger search when category or area filter changes
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    handleSearch();
  }, [selectedCat, selectedArea]);

  // Submit Tier 1 Security answers
  const handleTier1Submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setSearchLoading(true);

    if (!agreedTerms) {
      setErrorMsg('Ni lazima ukubali Vigezo na Masharti yetu kabla ya kuendelea (You must agree to our Terms of Service and Privacy Policy to continue).');
      setSearchLoading(false);
      return;
    }

    if (idProofBase64 && !idUploadConsent) {
      setErrorMsg('Ni lazima ukubali usindikaji wa kitambulisho chako ili kuendelea (You must consent to ID processing).');
      setSearchLoading(false);
      return;
    }

    if (ownerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
      setErrorMsg('Tafadhali weka barua pepe sahihi (Please enter a valid email address).');
      setSearchLoading(false);
      return;
    }

    try {
      const response = await fetch('/api/claims/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          itemId: selectedItem.id,
          ownerPhone: ownerPhone || '0700000000', // Safe default fallback for sandbox
          securityAnswers: {
            lastDigits,
            color: colorDetail,
            lostDetails,
            lastNameOnDoc,
            whereLost,
            plateNumber,
          },
          verificationTier: idProofBase64 ? 3 : 2,
          idProofBase64,
          termsAccepted: agreedTerms,
          ownerIdentifyingDetails,
          ownerEmail,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Verification failed');
      }

      // Move to Tier 2 OTP validation using the newly submitted claim
      setPaidClaim(data.claim);
      if (data.warning) {
        setStrikeWarning(data.warning);
      } else {
        setStrikeWarning(null);
      }
      triggerOtpRequest(data.claim.id);
    } catch (e: any) {
      console.error(e);
      setErrorMsg(e.message);
    } finally {
      setSearchLoading(false);
    }
  };

  // Request fresh SMS OTP for Owner validation (Tier 2 OTP)
  const triggerOtpRequest = async (claimId: string) => {
    setErrorMsg('');
    try {
      const response = await fetch(`/api/claims/${claimId}/request-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: ownerPhone }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to request OTP');
      }


      setVerificationStep('tier2_otp');
    } catch (e: any) {
      setErrorMsg(e.message);
    }
  };

  // Verify OTP via Server Endpoint (Tier 2 OTP validation)
  const handleOtpVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setSearchLoading(true);
    try {
      const response = await fetch(`/api/claims/${paidClaim.id}/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: otpCode }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Msimbo si sahihi au umepitwa na wakati.');
      }
      setVerificationStep('awaiting_agent_confirmation');
      startAwaitingAgentPolling(paidClaim.id);
    } catch (e: any) {
      setErrorMsg(e.message);
    } finally {
      setSearchLoading(false);
    }
  };

  const startAwaitingAgentPolling = (claimId: string) => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
    }
    const interval = setInterval(async () => {
      try {
        const response = await fetch(`/api/claims/${claimId}/status`);
        if (response.ok) {
          const data = await response.json();
          if (data.status === 'pending_payment') {
            clearInterval(interval);
            setPaidClaim(data.claim);
            if (data.agent) {
              setSelectedItem(prev => prev ? { ...prev, agent: data.agent } : null);
            }
            setVerificationStep('payment');
          } else if (data.status === 'payment_window_expired') {
            clearInterval(interval);
            setPaidClaim(data.claim);
            setVerificationStep('payment_window_expired');
          } else if (data.status === 'escrow_held' || data.status === 'released') {
            clearInterval(interval);
            setPaidClaim(data.claim);
            setVerificationStep('handover_success');
          }
        }
      } catch (e) {
        console.error('Polling status error:', e);
      }
    }, 3000);
    pollingIntervalRef.current = interval;
  };

  const startPollingPaymentStatus = (claimId: string) => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
    }
    setPollingStatus('pending');
    setErrorMsg('');

    let secondsPassed = 0;
    const interval = setInterval(async () => {
      secondsPassed += 3;
      if (secondsPassed > 90) {
        clearInterval(interval);
        setPollingStatus('timeout');
        setErrorMsg(lang === 'en' 
          ? 'Payment confirmation timed out. If you entered your M-Pesa PIN, please try refreshing or checking with the agent.' 
          : 'Uthibitisho wa malipo umechukua muda mrefu. Ikiwa umeweka PIN ya M-Pesa, tafadhali pakia upya au uwasiliane nasi.');
        return;
      }

      try {
        const response = await fetch(`/api/claims/${claimId}/status`);
        if (response.ok) {
          const data = await response.json();
          if (data.status === 'escrow_held' || data.status === 'released') {
            clearInterval(interval);
            setPaidClaim(data.claim);
            if (data.agent) {
              setSelectedItem(prev => prev ? { ...prev, agent: data.agent } : null);
            }
            setPollingStatus('success');
            setVerificationStep('handover_success');
          }
        }
      } catch (e) {
        console.error('Polling payment status error:', e);
      }
    }, 3000);

    pollingIntervalRef.current = interval;
  };

  // Simulated/Real STK Push escrow checkout
  const triggerEscrowPayment = async () => {
    setIsPaying(true);
    setErrorMsg('');

    try {
      // Short-lived, single-purpose payment authorization: proves we know
      // the claim's registered phone number (right before paying, not once
      // at claim submission) and gets a token that /pay now requires. See
      // the matching comment on /api/claims/:id/payment-auth in server.ts.
      const authResponse = await fetch(`/api/claims/${paidClaim.id}/payment-auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: ownerPhone }),
      });
      const authData = await authResponse.json();
      if (!authResponse.ok) {
        throw new Error(authData.error || 'Payment authorization failed');
      }

      const response = await fetch(`/api/claims/${paidClaim.id}/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: ownerPhone, paymentAuthToken: authData.paymentAuthToken }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Payment trigger failed');
      }

      setPaidClaim(data.claim);
      if (data.agent) {
        setSelectedItem(prev => prev ? { ...prev, agent: data.agent } : null);
      }
      setVerificationStep('payment_polling');
      startPollingPaymentStatus(data.claim.id);
    } catch (e: any) {
      console.error(e);
      setErrorMsg(e.message);
    } finally {
      setIsPaying(false);
    }
  };

  // TEST-MODE ONLY: lets a local tester complete a payment without a real
  // M-Pesa phone. The button that calls this only ever renders when the
  // backend confirms test mode is active (never in production).
  const simulatePaymentSuccess = async () => {
    if (!paidClaim?.id) return;
    setIsPaying(true);
    setErrorMsg('');
    try {
      const response = await fetch(`/api/dev/simulate-payment/${paidClaim.id}`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Simulate payment failed');
      }
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
      setPaidClaim(data.claim);
      setSimulatedPickupCode(data.pickupCode || null);
      setPollingStatus('success');
      setVerificationStep('handover_success');
    } catch (e: any) {
      setErrorMsg(e.message);
    } finally {
      setIsPaying(false);
    }
  };

  // Submit Rating
  const submitRating = async (score: number) => {
    setUserRating(score);
    try {
      await fetch(`/api/claims/${paidClaim.id}/rate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userRating: score }),
      });
      setRatingSubmitted(true);
    } catch (e) {
      console.error('Rating submission failed:', e);
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 fade-in">
      
      {/* Search & Listing View */}
      {verificationStep === 'search' && (
        <div className="space-y-8">
          
          {/* Headline & Track Claim Action */}
          <div className="text-center space-y-3">
            <h1 className="text-3xl font-extrabold text-primary-green mb-2">{t.ownerTitle}</h1>
            <p className="text-stone-600 text-sm max-w-xl mx-auto">{t.ownerSubtitle}</p>
            <button
              type="button"
              onClick={() => {
                setShowTrackModal(true);
                setTrackError('');
                setTrackResult(null);
              }}
              className="inline-flex items-center space-x-2 bg-emerald-50 hover:bg-emerald-100 text-primary-green border border-emerald-200 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer"
            >
              <Clock size={14} className="text-accent-orange" />
              <span>{lang === 'sw' ? 'Track My Existing Claim (Fuatilia Ombi Lako)' : 'Track My Existing Claim'}</span>
            </button>
          </div>

          {errorMsg && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-2xl flex items-center space-x-2.5 text-sm">
              <AlertCircle size={18} className="shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Search Box / Filters */}
          <form onSubmit={handleSearch} className="bg-white rounded-3xl border border-stone-100 p-6 shadow-xl space-y-4">
            <div className="flex flex-col md:flex-row gap-3">
              <div className="flex-1 relative">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t.searchPlaceholder}
                  aria-label={t.searchPlaceholder}
                  className="w-full border border-stone-200 rounded-2xl pl-10 pr-4 py-3 text-sm focus:border-accent-orange focus:outline-none bg-brand-beige"
                />
                <Search className="absolute left-3.5 top-3.5 text-stone-400" size={18} />
              </div>

              {/* Category Filter */}
              <select
                value={selectedCat}
                onChange={(e) => setSelectedCat(e.target.value)}
                className="border border-stone-200 rounded-2xl px-3 py-3 text-sm bg-white focus:outline-none focus:border-accent-orange disabled:bg-stone-50 disabled:text-stone-400"
                disabled={categoriesLoading || categoriesError}
              >
                {categoriesLoading ? (
                  <option value="">{lang === 'en' ? 'Loading categories...' : 'Inapakia kategoria...'}</option>
                ) : categoriesError ? (
                  <option value="">{lang === 'en' ? 'Categories unavailable — please refresh' : 'Kategoria hazipatikani - tafadhali pakia upya'}</option>
                ) : (
                  (() => {
                    const validCategories = categories.filter(cat => cat.name_en && cat.name_sw);
                    const invalidCount = categories.length - validCategories.length;
                    if (invalidCount > 0) {
                      console.warn(`[OwnerView] Filtered out ${invalidCount} incomplete categories from rendering.`);
                    }
                    return [
                      <option key="all-categories" value="">{lang === 'en' ? '-- All Categories --' : '-- Kategoria Zote --'}</option>,
                      ...validCategories.map(cat => (
                        <option key={cat.id} value={cat.id}>
                          {lang === 'en' ? cat.name_en : cat.name_sw}
                        </option>
                      ))
                    ];
                  })()
                )}
              </select>

              {/* Area Quick Selector */}
              <select
                value={selectedArea}
                onChange={(e) => setSelectedArea(e.target.value)}
                className="border border-stone-200 rounded-2xl px-3 py-3 text-sm bg-white focus:outline-none focus:border-accent-orange disabled:bg-stone-50 disabled:text-stone-400"
                disabled={regionsLoading || regionsError}
              >
                {regionsLoading ? (
                  <option value="">{lang === 'en' ? 'Loading regions...' : 'Inapakia maeneo...'}</option>
                ) : regionsError ? (
                  <option value="">{lang === 'en' ? 'Regions unavailable — please refresh' : 'Maeneo hayapatikani - tafadhali pakia upya'}</option>
                ) : (
                  [
                    <option key="all-regions" value="">{lang === 'en' ? '-- All Regions --' : '-- Maeneo Yote --'}</option>,
                    ...regions.map(r => (
                      <option key={r} value={r}>{r}</option>
                    ))
                  ]
                )}
              </select>

              <button
                type="submit"
                disabled={searchLoading}
                className="bg-accent-orange hover:bg-accent-hover text-white px-8 py-3 rounded-2xl font-bold transition flex items-center justify-center space-x-2 shadow-lg shadow-orange-500/10 cursor-pointer disabled:opacity-50"
              >
                {searchLoading ? (
                  <Loader2 className="animate-spin" size={18} />
                ) : (
                  <span>Search</span>
                )}
              </button>
            </div>
          </form>

          {/* Privacy masking badge info */}
          <div className="bg-emerald-50 border border-emerald-100 rounded-2xl p-4 flex items-start space-x-3 text-xs text-primary-green">
            <ShieldAlert size={18} className="text-accent-orange shrink-0 mt-0.5" />
            <div>
              <span className="font-bold block mb-0.5">Kenyan Privacy Shield Activated</span>
              To safeguard owners, we never reveal exact document numbers, full names, or finder details in search. Exact matches require entering correct search queries (salted-hash matching).
            </div>
          </div>

          {/* Results Grid */}
          <div className="space-y-4">
            <h2 className="text-lg font-bold text-primary-green">
              {searchLoading ? (
                <span>{lang === 'en' ? 'Searching secure registry...' : 'Kutafuta rejesta salama...'}</span>
              ) : (
                <span>
                  {searchResults.length} {searchResults.length === 1 ? (lang === 'en' ? 'found item' : 'bidhaa iliyopatikana') : (lang === 'en' ? 'found items' : 'vitu vilivyopatikana')} matching:
                </span>
              )}
            </h2>

            {searchLoading ? (
              <div className="bg-white border border-stone-100 rounded-2xl p-12 text-center text-stone-500 flex flex-col items-center justify-center space-y-3 shadow-sm">
                <Loader2 className="animate-spin text-accent-orange" size={32} />
                <span className="text-sm font-medium">{lang === 'en' ? 'Searching the secure registry...' : 'Kutafuta kwenye rejesta salama...'}</span>
              </div>
            ) : errorMsg ? (
              <div className="bg-red-50 border border-red-200 text-red-700 px-6 py-8 rounded-2xl text-center text-sm space-y-2">
                <AlertCircle size={28} className="mx-auto text-red-500" />
                <p className="font-bold">{lang === 'en' ? 'Search Failed' : 'Utafutaji Umeshindwa'}</p>
                <p className="text-xs text-red-600">{errorMsg}</p>
              </div>
            ) : searchResults.length === 0 ? (
              <div className="bg-white border border-stone-100 rounded-2xl p-12 text-center text-stone-500 text-sm space-y-3">
                <p className="font-bold text-base text-primary-green">{lang === 'en' ? 'No Items Found' : 'Hakuna Bidhaa Zilizopatikana'}</p>
                <p className="max-w-md mx-auto text-stone-500 leading-relaxed">{t.noResults}</p>
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery('');
                      setSelectedCat('');
                      setSelectedArea('');
                      if (selectedCat === '' && selectedArea === '') {
                        handleSearch();
                      }
                    }}
                    className="text-xs font-black text-accent-orange hover:underline cursor-pointer"
                  >
                    {lang === 'en' ? 'Clear Filters & Show All' : 'Futa Vichungi & Onyesha Zote'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {searchResults.map(item => {
                  const cat = categories.find(c => c.id === item.category_id);
                  return (
                    <div key={item.id} className="bg-white rounded-3xl border border-stone-100 p-5 shadow-md flex items-start space-x-4">
                      {/* Document photo */}
                      <div className="w-20 h-20 bg-brand-beige rounded-2xl overflow-hidden shrink-0 border border-stone-200 flex items-center justify-center">
                        {item.is_sensitive_document ? (
                          <div className="flex flex-col items-center justify-center p-2 text-center h-full w-full bg-stone-100 text-stone-500">
                            <Lock size={18} className="text-stone-400 mb-1 shrink-0" />
                            <span className="text-[10px] font-bold leading-tight text-stone-500">Photo hidden for privacy</span>
                          </div>
                        ) : (
                          <img src={item.photo_url} alt="Found item" className="w-full h-full object-cover" />
                        )}
                      </div>

                      {/* Info block */}
                      <div className="flex-1 space-y-1.5 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className="bg-emerald-50 text-emerald-800 text-[10px] font-extrabold px-2.5 py-1 rounded-full uppercase">
                            {lang === 'en' ? cat?.name_en : cat?.name_sw}
                          </span>
                          <span className="text-[10px] text-stone-400 font-mono font-medium">
                            {new Date(item.created_at).toLocaleDateString()}
                          </span>
                        </div>

                        <h3 className="font-extrabold text-primary-green truncate">
                          {item.document_name_fuzzy}
                        </h3>

                        <p className="text-stone-500 text-xs line-clamp-2">
                          <MapPin size={10} className="inline mr-1 text-accent-orange" />
                          {item.location_description}
                        </p>

                        <div className="pt-2 border-t border-stone-100 flex items-center justify-between">
                          <span className="text-[10px] font-extrabold text-stone-400 uppercase tracking-widest">
                            Hub: {item.agent?.business_name.split(' ')[0]}
                          </span>
                          <button
                            onClick={() => {
                              setSelectedItem(item);
                              setVerificationStep('confidence_gate');
                            }}
                            className="bg-accent-orange hover:bg-accent-hover text-white text-xs font-bold px-4 py-1.5 rounded-xl transition"
                          >
                            {t.claimBtn}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Confidence Gate Step */}
      {verificationStep === 'confidence_gate' && selectedItem && (
        <div className="bg-white rounded-3xl border border-stone-100 p-6 md:p-8 shadow-xl max-w-xl mx-auto space-y-6 fade-in">
          <div className="text-center space-y-2">
            <h2 className="text-2xl font-extrabold text-primary-green">Thibitisha Umiliki (Confirm Confidence)</h2>
            <p className="text-stone-500 text-xs">Please review the item details and confirm you are the rightful owner before proceeding to the verification step.</p>
          </div>

          <div className="border border-stone-100 rounded-2xl p-4 bg-brand-beige space-y-3">
            <h3 className="font-extrabold text-sm text-stone-900 border-b border-stone-200/50 pb-2">Item Information</h3>
            <div className="flex gap-4">
              <div className="w-16 h-16 rounded-xl bg-stone-50 border border-stone-200 overflow-hidden shrink-0 flex items-center justify-center">
                {selectedItem.is_sensitive_document ? (
                  <div className="flex flex-col items-center justify-center p-1 text-center h-full w-full bg-stone-100 text-stone-500">
                    <Lock size={14} className="text-stone-400 mb-0.5 shrink-0" />
                    <span className="text-[7px] font-bold leading-tight text-stone-500">Photo hidden for privacy</span>
                  </div>
                ) : (
                  <img
                    src={selectedItem.photo_url}
                    alt="Thumbnail"
                    className="w-full h-full object-contain"
                    referrerPolicy="no-referrer"
                  />
                )}
              </div>
              <div className="space-y-1">
                <p className="text-xs font-extrabold text-stone-800">{selectedItem.document_name_fuzzy}</p>
                <p className="text-[11px] text-stone-500">{selectedItem.location_description}</p>
                <p className="text-[10px] text-stone-400 font-mono">Found Hub: {selectedItem.agent?.business_name}</p>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="owner-identifying-details" className="block text-xs font-extrabold text-primary-green uppercase tracking-wider">
                Maelezo ya Utambulisho (Provide 1-2 identifying details) *
              </label>
              <textarea
                id="owner-identifying-details"
                value={ownerIdentifyingDetails}
                onChange={(e) => setOwnerIdentifyingDetails(e.target.value)}
                placeholder="E.g. What is the full name, ID number, birth date, or unique physical characteristics of this document/item?"
                className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-xs focus:outline-none focus:border-accent-orange"
                rows={3}
                required
              />
              <p className="text-[10px] text-stone-400">These details are kept strictly private and used solely by the Hub Agent to verify you before handing over.</p>
            </div>

            <div className="flex items-start space-x-2 pt-2 pb-1 bg-amber-50/50 p-3 rounded-xl border border-amber-100">
              <input
                id="confidence-checkbox"
                type="checkbox"
                checked={isConfident}
                onChange={(e) => setIsConfident(e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-stone-300 text-primary-green focus:ring-primary-green cursor-pointer"
                required
              />
              <label htmlFor="confidence-checkbox" className="text-xs text-stone-700 leading-tight select-none cursor-pointer">
                Nathibitisha kwa uaminifu kuwa mimi ndiye mmiliki halali wa hati hii (I am reasonably confident this is my item and I am not making a fraudulent claim). *
              </label>
            </div>
          </div>

          <div className="flex space-x-3 pt-3">
            <button
              type="button"
              onClick={() => setVerificationStep('search')}
              className="flex-1 bg-stone-100 hover:bg-stone-200 text-stone-700 py-3 rounded-xl font-bold transition text-xs"
            >
              Back
            </button>
            <button
              type="button"
              disabled={!isConfident || !ownerIdentifyingDetails.trim()}
              onClick={() => setVerificationStep('tier1_security')}
              className="flex-1 bg-accent-orange hover:bg-accent-hover text-white py-3 rounded-xl font-bold transition text-xs disabled:opacity-50 cursor-pointer"
            >
              Proceed to Claim
            </button>
          </div>
        </div>
      )}

      {/* Tier 1 Security verification */}
      {verificationStep === 'tier1_security' && (
        <div className="bg-white rounded-3xl border border-stone-100 p-6 md:p-8 shadow-xl max-w-xl mx-auto space-y-6 fade-in">
          <div className="text-center">
            <h2 className="text-2xl font-extrabold text-primary-green mb-1">{t.verifyTitle}</h2>
            <p className="text-stone-500 text-xs">{t.verifySubtitle}</p>
          </div>

          {errorMsg && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-xs flex items-center space-x-2">
              <AlertCircle size={16} />
              <span>{errorMsg}</span>
            </div>
          )}

          <form onSubmit={handleTier1Submit} className="space-y-4">
            
            {selectedItem.is_sensitive_document !== false ? (
              <>
                {/* Last 4 digits security check */}
                <div className="space-y-1">
                  <label htmlFor="owner-last-digits" className="block text-xs font-extrabold text-primary-green uppercase tracking-wider">{t.lastDigitsQuest} *</label>
                  <input
                    id="owner-last-digits"
                    type="text"
                    value={lastDigits}
                    onChange={(e) => setLastDigits(e.target.value)}
                    maxLength={4}
                    className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm bg-brand-beige font-mono focus:outline-none focus:border-accent-orange"
                    placeholder="e.g. 4812"
                    required
                  />
                </div>

                {/* Last Name on Document */}
                <div className="space-y-1">
                  <label htmlFor="owner-last-name-doc" className="block text-xs font-extrabold text-primary-green uppercase tracking-wider">
                    {lang === 'sw' ? 'Jina la Mwisho Kwenye Hati *' : 'Last Name on Document *'}
                  </label>
                  <input
                    id="owner-last-name-doc"
                    type="text"
                    value={lastNameOnDoc}
                    onChange={(e) => setLastNameOnDoc(e.target.value)}
                    className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm bg-brand-beige focus:outline-none focus:border-accent-orange uppercase"
                    placeholder="e.g. KAMAU"
                    required
                  />
                </div>

                {/* Where Lost */}
                <div className="space-y-1">
                  <label htmlFor="owner-where-lost" className="block text-xs font-extrabold text-primary-green uppercase tracking-wider">
                    {lang === 'sw' ? 'Mahali au Gari/Matatu Ilipopotea *' : 'Where Lost (Specific Location/Bus/Matatu) *'}
                  </label>
                  <input
                    id="owner-where-lost"
                    type="text"
                    value={whereLost}
                    onChange={(e) => setWhereLost(e.target.value)}
                    className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm bg-brand-beige focus:outline-none focus:border-accent-orange"
                    placeholder="e.g. Super Metro matatu from CBD to Westlands"
                    required
                  />
                </div>

                {/* Full Plate Number (if applicable) */}
                <div className="space-y-1">
                  <label htmlFor="owner-plate-number" className="block text-xs font-extrabold text-primary-green uppercase tracking-wider">
                    {lang === 'sw' ? 'Bamba la Nambari la Chombo (Ikiwa Inahusika)' : 'Full Vehicle Plate Number (If Applicable)'}
                  </label>
                  <input
                    id="owner-plate-number"
                    type="text"
                    value={plateNumber}
                    onChange={(e) => setPlateNumber(e.target.value)}
                    className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm bg-brand-beige font-mono focus:outline-none focus:border-accent-orange uppercase"
                    placeholder="e.g. KDG 123A"
                  />
                </div>

                {/* Color detail */}
                <div className="space-y-1">
                  <label htmlFor="owner-color-detail" className="block text-xs font-extrabold text-primary-green uppercase tracking-wider">{t.colorQuest} *</label>
                  <input
                    id="owner-color-detail"
                    type="text"
                    value={colorDetail}
                    onChange={(e) => setColorDetail(e.target.value)}
                    className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm bg-brand-beige focus:outline-none focus:border-accent-orange"
                    placeholder="e.g. blue plastic wallet, black casing"
                    required
                  />
                </div>

                {/* Extra details */}
                <div className="space-y-1">
                  <label htmlFor="owner-lost-details" className="block text-xs font-extrabold text-primary-green uppercase tracking-wider">{t.extraQuest}</label>
                  <textarea
                    id="owner-lost-details"
                    value={lostDetails}
                    onChange={(e) => setLostDetails(e.target.value)}
                    rows={2}
                    className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm bg-brand-beige focus:outline-none focus:border-accent-orange"
                    placeholder="e.g. lost inside a Super Metro matatu going to Westlands"
                  />
                </div>

                {/* Optional ID Proof upload (Tier 3) */}
                <div className="space-y-1">
                  <label htmlFor="owner-id-proof-upload" className="block text-xs font-extrabold text-primary-green uppercase tracking-wider">
                    Upload National ID/Passport (For Tier 3 verification)
                  </label>
                  <input
                    id="owner-id-proof-upload"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        const reader = new FileReader();
                        reader.onloadend = () => {
                          setIdProofBase64(reader.result as string);
                        };
                        reader.readAsDataURL(file);
                      }
                    }}
                    className="block w-full text-xs text-stone-500 file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-xs file:font-bold file:bg-orange-50 file:text-accent-orange hover:file:bg-orange-100 cursor-pointer"
                  />
                  {idProofBase64 && (
                    <div className="space-y-2">
                      <p className="text-[11px] text-emerald-600 font-semibold flex items-center space-x-1">
                        <span>✓ Kitambulisho kimepakiwa na kitahifadhiwa salama (Tier 3 Activated)</span>
                      </p>
                      <div className="flex items-start space-x-2 bg-stone-50 p-2.5 rounded-lg border border-stone-200">
                        <input
                          id="id-upload-consent"
                          type="checkbox"
                          checked={idUploadConsent}
                          onChange={(e) => setIdUploadConsent(e.target.checked)}
                          className="mt-0.5 h-3.5 w-3.5 rounded border-stone-300 text-primary-green focus:ring-primary-green cursor-pointer"
                          required
                        />
                        <label htmlFor="id-upload-consent" className="text-[10px] text-stone-600 leading-tight select-none cursor-pointer">
                          I explicitly consent to the processing and secure storage of my government identity card/passport for physical owner verification in accordance with ODPC standards. *
                        </label>
                      </div>
                    </div>
                  )}
                </div>
              </>
            ) : null}

            {/* Contact Phone for OTP */}
            <div className="space-y-1 border-t border-stone-200 pt-4">
              <label htmlFor="owner-phone" className="block text-xs font-extrabold text-primary-green uppercase tracking-wider">Your Phone Number (For SMS OTP) *</label>
              <input
                id="owner-phone"
                type="tel"
                value={ownerPhone}
                onChange={(e) => setOwnerPhone(e.target.value)}
                className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm bg-brand-beige font-mono focus:outline-none focus:border-accent-orange"
                placeholder="e.g. 0712345678"
                required
              />
            </div>

            {/* Optional Owner Email */}
            <div className="space-y-1">
              <label htmlFor="owner-email" className="block text-xs font-extrabold text-primary-green uppercase tracking-wider">
                Email Address (Optional / Barua Pepe - Sio Lazima)
              </label>
              <input
                id="owner-email"
                type="email"
                value={ownerEmail}
                onChange={(e) => setOwnerEmail(e.target.value)}
                className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm bg-brand-beige font-sans focus:outline-none focus:border-accent-orange"
                placeholder="e.g. claimant@gmail.com"
              />
              <span className="text-[10px] text-stone-400 block leading-tight">
                Provide an email address if you wish to receive billing receipts and collection notices.
              </span>
            </div>

            {/* General Terms/Privacy consent */}
            <div className="flex items-start space-x-2 pt-2 pb-1 bg-brand-beige p-3 rounded-xl border border-stone-100">
              <input
                id="owner-agreed-terms"
                type="checkbox"
                checked={agreedTerms}
                onChange={(e) => setAgreedTerms(e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-stone-300 text-primary-green focus:ring-primary-green accent-primary-green cursor-pointer"
                required
              />
              <label htmlFor="owner-agreed-terms" className="text-xs text-stone-600 leading-tight select-none cursor-pointer">
                I have read and agree to the Return4me{' '}
                <button
                  type="button"
                  onClick={() => (window as any).setView?.('terms')}
                  className="text-primary-green hover:underline font-bold inline focus:outline-none"
                >
                  Terms of Service
                </button>{' '}
                and{' '}
                <button
                  type="button"
                  onClick={() => (window as any).setView?.('privacy')}
                  className="text-primary-green hover:underline font-bold inline focus:outline-none"
                >
                  Privacy Policy
                </button>
                . *
              </label>
            </div>

            <div className="flex space-x-3 pt-3">
              <button
                type="button"
                onClick={() => setVerificationStep('confidence_gate')}
                className="flex-1 bg-stone-100 hover:bg-stone-200 text-stone-700 py-3 rounded-xl font-bold transition text-xs"
              >
                Back
              </button>
              <button
                type="submit"
                disabled={searchLoading}
                className="flex-1 bg-accent-orange hover:bg-accent-hover text-white py-3 rounded-xl font-bold transition text-xs cursor-pointer flex items-center justify-center space-x-2 disabled:opacity-50"
              >
                {searchLoading ? (
                  <Loader2 className="animate-spin" size={16} />
                ) : (
                  <span>Verify & Send OTP</span>
                )}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Tier 2 OTP validation */}
      {verificationStep === 'tier2_otp' && (
        <div className="bg-white rounded-3xl border border-stone-100 p-6 md:p-8 shadow-xl max-w-xl mx-auto space-y-6 text-center fade-in">
          <div className="w-12 h-12 bg-orange-50 text-accent-orange rounded-full flex items-center justify-center mx-auto">
            <Smartphone size={24} />
          </div>
          <div>
            <h2 className="text-xl font-extrabold text-primary-green mb-1">Verify SMS OTP Code</h2>
            <p className="text-stone-500 text-xs">Enter the 4-digit code dispatched to {ownerPhone}.</p>
          </div>

          {errorMsg && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2.5 rounded-xl text-xs flex items-center justify-center space-x-2">
              <AlertCircle size={16} />
              <span>{errorMsg}</span>
            </div>
          )}



          <form onSubmit={handleOtpVerify} className="space-y-4 max-w-xs mx-auto">
            <input
              type="text"
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value)}
              maxLength={4}
              className="w-full border-2 border-stone-200 rounded-xl text-center py-3 text-xl font-mono tracking-widest focus:outline-none focus:border-accent-orange"
              placeholder="••••"
              aria-label={lang === 'sw' ? 'Msimbo wa OTP wa tarakimu 4' : '4-digit OTP code'}
              required
            />

            <button
              type="submit"
              disabled={searchLoading}
              className="w-full bg-primary-green hover:bg-primary-hover text-white py-3 rounded-xl font-bold transition text-xs flex items-center justify-center space-x-2 disabled:opacity-50"
            >
              {searchLoading ? (
                <Loader2 className="animate-spin" size={14} />
              ) : (
                <>
                  <span>Verify Code</span>
                  <ArrowRight size={14} />
                </>
              )}
            </button>
          </form>
        </div>
      )}

      {/* Payment step */}
      {verificationStep === 'payment' && (
        <div className="bg-white rounded-3xl border border-stone-100 p-6 md:p-8 shadow-xl max-w-xl mx-auto space-y-6 text-center fade-in">
          <div className="w-14 h-14 bg-emerald-50 text-emerald-600 rounded-full flex items-center justify-center mx-auto">
            <Coins size={28} />
          </div>
          <div>
            <h2 className="text-xl font-extrabold text-primary-green mb-1">{t.paymentTitle}</h2>
            <p className="text-stone-500 text-xs">{t.paymentSubtitle}</p>
          </div>

          {strikeWarning && (
            <div className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-2xl text-xs text-left flex items-start space-x-2">
              <AlertTriangle size={18} className="shrink-0 mt-0.5" />
              <span>{strikeWarning}</span>
            </div>
          )}

          {timeLeft !== null && (
            <div className={`p-4 rounded-2xl border text-xs text-left flex items-start space-x-3 ${timeLeft < 180 ? 'bg-red-50 border-red-100 text-red-700 font-bold animate-pulse' : 'bg-amber-50 border-amber-100 text-amber-800'}`}>
              <Clock size={18} className="shrink-0 mt-0.5 text-accent-orange" />
              <div>
                <span className="font-bold block mb-0.5 text-primary-green">
                  {lang === 'en' ? 'Payment Window Expiry Countdown' : 'Muda wa Kulipa Unayoyoma'}
                </span>
                <p className="text-stone-600 mb-1 font-medium">
                  {lang === 'en' 
                    ? 'You must complete the payment within 15 minutes of in-person verification. If you do not pay, the item will be unlocked for other claimants and a strike will be registered on your phone number.' 
                    : 'Lazima ukamilishe malipo ndani ya dakika 15 baada ya kuthibitisha kuona bidhaa. Usipolipa, bidhaa itafunguliwa kwa wadai wengine na utapata adhabu ya strike kwenye nambari yako ya simu.'}
                </p>
                <div className="font-mono text-base font-extrabold text-accent-orange">
                  {Math.floor(timeLeft / 60)}m {timeLeft % 60}s
                </div>
              </div>
            </div>
          )}

          {/* Official Comparison Info Card */}
          {(() => {
            const catId = selectedItem?.category_id;
            let noteEn = '';
            let noteSw = '';
            
            if (catId === 'national-id') {
              noteEn = 'Skip the 2-4 week wait and police station visit — get it back today. (Official replacement is free under government waiver but takes weeks of waiting).';
              noteSw = 'Epuka kusubiri wiki 2-4 na kwenda kituo cha polisi — rejesha kitambulisho chako leo. (Ubadilishaji rasmi ni bure chini ya msamaha lakini huchukua wiki kadhaa za kusubiri).';
            } else if (catId === 'birth-certificate') {
              noteEn = 'Cheaper and faster than official Huduma replacement (which costs KES 250 plus travel and queuing time).';
              noteSw = 'Nafuu na haraka kuliko ubadilishaji rasmi wa Huduma (ambao hugharimu KES 250 pamoja na muda wa kusafiri na foleni).';
            } else if (catId === 'driving-licence') {
              noteEn = 'Official NTSA replacement is KES 3,050 plus a police abstract and biometrics appointment (7-14 days). Save KES 2,550+ and get it back today!';
              noteSw = 'Ubadilishaji rasmi wa NTSA ni KES 3,050 pamoja na ripoti ya polisi na uteuzi wa biometriski (siku 7-14). Okoa KES 2,550+ na upate leo!';
            } else if (catId === 'vehicle-logbook') {
              noteEn = 'Official NTSA replacement is KES 2,550 plus police abstract, DCI tape-lift report, and sworn affidavit (painful multi-week process). Save KES 1,750+ and massive hassle.';
              noteSw = 'Ubadilishaji rasmi wa NTSA ni KES 2,550 pamoja na ripoti ya polisi, ripoti ya DCI, na kiapo cha mahakama (mchakato mrefu wa wiki kadhaa). Okoa KES 1,750+ na usumbufu mkubwa.';
            } else if (catId === 'number-plate') {
              noteEn = 'Official NTSA replacement is KES 3,000 single / KES 3,600 pair, plus police abstract and DCI tape-lift report. Save KES 2,300+ to KES 2,900+ and get road-legal today!';
              noteSw = 'Ubadilishaji rasmi wa NTSA ni KES 3,000 kwa moja / KES 3,600 kwa mbili, pamoja na ripoti ya polisi na DCI tape-lift. Okoa KES 2,300+ hadi KES 2,900+ leo!';
            }

            if (!noteEn) return null;

            return (
              <div className="bg-emerald-50 border border-emerald-100 rounded-2xl p-4 text-left text-xs flex items-start space-x-3 text-primary-green">
                <AlertCircle size={18} className="text-accent-orange shrink-0 mt-0.5" />
                <div>
                  <span className="font-bold block mb-1">
                    {lang === 'en' ? 'Recovery Benefit' : 'Faida ya Kurejesha'}
                  </span>
                  <p className="font-medium text-stone-600">
                    {lang === 'en' ? noteEn : noteSw}
                  </p>
                </div>
              </div>
            );
          })()}

          {/* Escrow Fee breakdown details */}
          {(() => {
            const catRecord = categories.find(c => c.id === selectedItem?.category_id);
            const totalFee = catRecord ? Math.round(Number(catRecord.total_fee)) : 0;
            const finderShare = catRecord ? Math.round(Number(catRecord.finder_share)) : 0;
            const agentShare = catRecord ? Math.round(Number(catRecord.agent_share)) : 0;
            const platformShare = catRecord ? Math.round(Number(catRecord.platform_share)) : 0;

            return (
              <div className="bg-brand-beige rounded-2xl border border-stone-200 p-5 text-left space-y-3">
                <div className="flex justify-between items-center text-xs font-bold text-stone-400 uppercase tracking-wider">
                  <span>Fee breakdown</span>
                  <span>Amount</span>
                </div>
                <div className="h-px bg-stone-200" />
                <div className="flex justify-between text-sm">
                  <span className="text-stone-600 font-medium">Finder Honorarium (Reward)</span>
                  <span className="font-mono font-bold text-stone-700">KES {finderShare}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-stone-600 font-medium">Physical Agent Hub Handling</span>
                  <span className="font-mono font-bold text-stone-700">KES {agentShare}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-stone-600 font-medium">Return4me Escrow & Platform</span>
                  <span className="font-mono font-bold text-stone-700">KES {platformShare}</span>
                </div>
                <div className="h-px bg-stone-200" />
                <div className="flex justify-between text-base font-extrabold text-primary-green">
                  <span>{t.releaseFee}</span>
                  <span className="font-mono text-accent-orange">KES {totalFee}</span>
                </div>
              </div>
            );
          })()}

          {/* Checkout triggers */}
          <div className="space-y-3">
            <span className="text-xs text-stone-400 block font-medium">Secured M-Pesa Payment</span>
            <button
              onClick={triggerEscrowPayment}
              disabled={isPaying}
              className="w-full bg-accent-orange hover:bg-accent-hover text-white py-3.5 rounded-2xl font-bold transition flex items-center justify-center space-x-2 shadow-lg shadow-orange-500/10 cursor-pointer disabled:opacity-50"
            >
              {isPaying ? (
                <>
                  <Loader2 className="animate-spin" size={18} />
                  <span>Invoking STK Push callback...</span>
                </>
              ) : (
                <>
                  <span>{t.stkBtn}</span>
                  <ArrowRight size={18} />
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* Payment Polling confirmation screen */}
      {verificationStep === 'payment_polling' && (
        <div className="bg-white rounded-3xl border border-stone-100 p-6 md:p-8 shadow-xl max-w-xl mx-auto text-center space-y-6 fade-in">
          <div className="w-14 h-14 bg-orange-50 text-accent-orange rounded-full flex items-center justify-center mx-auto">
            <Loader2 className="animate-spin text-accent-orange" size={28} />
          </div>
          <div>
            <h2 className="text-xl font-extrabold text-primary-green mb-1">
              {lang === 'en' ? 'Waiting for M-Pesa Confirmation' : 'Inasubiri Uthibitisho wa M-Pesa'}
            </h2>
            <p className="text-stone-500 text-xs">
              {lang === 'en' 
                ? 'We have sent an M-Pesa STK Push to your phone. Please enter your PIN to complete the escrow payment.' 
                : 'Tumetuma ombi la M-Pesa (STK Push) kwa simu yako. Tafadhali weka PIN yako ili kukamilisha malipo.'}
            </p>
          </div>

          <div className="bg-brand-beige border border-stone-200 rounded-2xl p-5 text-left text-xs space-y-3 font-medium text-stone-600">
            <div className="flex items-center space-x-2 text-emerald-600">
              <CheckCircle size={16} />
              <span>{lang === 'en' ? 'STK Push sent successfully' : 'Ombi la malipo limetumwa kwa ufanisi'}</span>
            </div>
            <div className="flex items-center space-x-2 text-stone-500">
              <Loader2 className="animate-spin text-accent-orange shrink-0" size={14} />
              <span>{lang === 'en' ? 'Waiting for PIN and payment authorization...' : 'Inasubiri kuweka PIN na idhini ya malipo...'}</span>
            </div>
            <div className="flex items-center space-x-2 text-stone-400">
              <Lock size={14} className="opacity-40 shrink-0" />
              <span>{lang === 'en' ? 'Secure Escrow receipt' : 'Kipokezi salama cha Escrow'}</span>
            </div>
          </div>

          {errorMsg && (
            <div className="bg-red-50 border border-red-100 text-red-700 text-xs rounded-2xl p-4 flex items-start space-x-2 text-left">
              <AlertCircle size={16} className="shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          <div className="space-y-3 pt-2">
            <button
              onClick={triggerEscrowPayment}
              disabled={isPaying}
              className="w-full bg-stone-100 hover:bg-stone-200 text-stone-700 py-3 rounded-2xl font-bold text-xs transition cursor-pointer disabled:opacity-50"
            >
              {isPaying ? (
                <div className="flex items-center justify-center space-x-2">
                  <Loader2 className="animate-spin" size={14} />
                  <span>{lang === 'en' ? 'Sending prompt...' : 'Inatuma ombi la malipo...'}</span>
                </div>
              ) : (
                <span>{lang === 'en' ? "Didn't get the prompt? Resend" : 'Hukupokea ujumbe? Tuma tena'}</span>
              )}
            </button>

            {testModeEnabled && (
              <button
                onClick={simulatePaymentSuccess}
                disabled={isPaying}
                className="w-full bg-amber-100 hover:bg-amber-200 text-amber-800 py-3 rounded-2xl font-bold text-xs transition cursor-pointer disabled:opacity-50 border border-dashed border-amber-300"
              >
                {lang === 'en' ? '🧪 Simulate Payment Success (test mode only)' : '🧪 Iga Malipo Yaliyofaulu (hali ya majaribio)'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Physical pickup handover success */}
      {verificationStep === 'handover_success' && (
        <div className="bg-white rounded-3xl border border-stone-100 p-6 md:p-8 shadow-xl max-w-xl mx-auto text-center space-y-6 fade-in">
          <div className="w-16 h-16 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto">
            <CheckCircle size={36} />
          </div>
          <div>
            <h2 className="text-2xl font-extrabold text-primary-green mb-1">{t.paymentSuccess}</h2>
            <p className="text-stone-500 text-xs">{t.collectionInstructions}</p>
          </div>

          {/* Collection Agent Coordinates card */}
          <div className="bg-brand-beige p-5 rounded-2xl text-left border border-stone-200 space-y-2">
            <h3 className="text-[10px] font-extrabold text-stone-400 uppercase tracking-widest">Pickup physical agent point</h3>
            <div>
              <h4 className="text-base font-bold text-primary-green">{selectedItem.agent?.business_name}</h4>
              <p className="text-stone-600 text-xs font-medium">{selectedItem.agent?.location_address}</p>
              {selectedItem.agent?.contact_phone && (
                <p className="text-stone-700 text-xs font-semibold mt-1">
                  Mwasiliano / Phone: <span className="font-mono">{selectedItem.agent.contact_phone}</span>
                </p>
              )}
              {selectedItem.agent?.latitude !== undefined && selectedItem.agent?.latitude !== null && (
                <a
                  href={`https://www.google.com/maps/dir/?api=1&destination=${selectedItem.agent.latitude},${selectedItem.agent.longitude}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary-green text-xs font-bold mt-2 underline underline-offset-2 hover:text-accent-orange transition"
                >
                  <MapPin size={13} />
                  {lang === 'sw' ? 'Fungua Maelekezo kwenye Google Maps' : 'Open Directions in Google Maps'}
                </a>
              )}
            </div>
          </div>

          {/* Claim reference — this identifies your claim if you need to look
              it up again, but it is NOT the secret code the agent asks for. */}
          <div className="bg-stone-100 text-stone-600 p-4 rounded-2xl space-y-1">
            <span className="text-[10px] font-bold uppercase tracking-widest text-stone-400">
              {lang === 'sw' ? 'Nambari ya Rejea ya Dai (si msimbo wa siri)' : 'Claim Reference (not a secret code)'}
            </span>
            <div className="text-lg font-mono font-bold tracking-wider text-stone-700">
              {paidClaim.id}
            </div>
            <p className="text-[10px] text-stone-400">
              {lang === 'sw' ? 'Tumia hii ukitafuta hali ya dai lako baadaye.' : 'Use this if you need to look up your claim status later.'}
            </p>
          </div>

          {/* The actual secret pickup code — this is what the agent needs */}
          <div className="bg-primary-green text-white p-5 rounded-2xl space-y-1">
            <span className="text-[10px] font-bold uppercase tracking-widest text-stone-300">{t.collectionCode}</span>
            {simulatedPickupCode ? (
              <div className="text-2xl font-mono font-extrabold tracking-wider text-accent-orange">
                {simulatedPickupCode}
              </div>
            ) : (
              <p className="text-sm text-stone-100 font-semibold">
                {lang === 'sw'
                  ? 'Tumekutumia msimbo wa siri wa nambari 6 kwa SMS na barua pepe. Tafuta ujumbe kutoka Return4me.'
                  : 'We\'ve sent a secret 6-digit code to your phone (SMS) and email. Look for a message from Return4me.'}
              </p>
            )}
            <p className="text-[10px] text-stone-300">
              {lang === 'sw' ? 'Toa msimbo huu wa siri kwa Agent PEKEE wakati wa kuchukua bidhaa yako.' : 'Give this secret code to the Agent ONLY when collecting your item.'}
            </p>
          </div>

          {simulatedPickupCode && (
            <div className="bg-amber-50 border border-dashed border-amber-300 text-amber-800 p-3 rounded-xl text-[11px] font-bold">
              🧪 {lang === 'sw' ? 'Hali ya majaribio: msimbo huu umeonyeshwa hapa kwa sababu SMS/barua pepe halisi haitumwi wakati wa majaribio ya ndani.' : 'Test mode: this code is shown here because real SMS/email isn\'t sent during local testing.'}
            </div>
          )}

          {/* Save-this-code warning */}
          <div className="bg-amber-50 border border-amber-300 text-amber-900 p-4 rounded-2xl text-left flex items-start space-x-3">
            <AlertTriangle size={20} className="shrink-0 mt-0.5 text-amber-600" />
            <div className="text-xs space-y-1">
              <p className="font-extrabold">
                {lang === 'sw' ? 'MUHIMU: Andika au piga picha ya msimbo huu sasa.' : 'IMPORTANT: Write down or screenshot this code now.'}
              </p>
              <p className="text-amber-800">
                {lang === 'sw'
                  ? 'Lazima umpe wakala msimbo huu wa siri ili kuchukua bidhaa yako physically. Kuupoteza kunaweza kuchelewesha kuchukua kwako — angalia SMS/barua pepe yako tena ikiwa unahitaji kuupata tena.'
                  : 'You must give this exact secret code to the agent in person to collect your item. Losing it may delay your pickup — check your SMS/email again if you need to retrieve it.'}
              </p>
            </div>
          </div>

          {/* Post Pickup Rating flow */}
          <div className="border-t border-stone-100 pt-5 space-y-3">
            <h4 className="text-xs font-extrabold text-primary-green uppercase tracking-wider">{t.rateAgentLabel}</h4>
            {ratingSubmitted ? (
              <span className="text-xs text-emerald-600 font-bold block">✓ Thank you for supporting community trust in Kenya!</span>
            ) : (
              <div className="flex items-center justify-center space-x-2">
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    type="button"
                    onClick={() => submitRating(star)}
                    className="text-stone-300 hover:text-accent-orange transition"
                  >
                    <Star size={24} className={userRating && userRating >= star ? "fill-accent-orange text-accent-orange" : ""} />
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            onClick={() => {
              setVerificationStep('search');
              setSelectedItem(null);
              setPaidClaim(null);
              setLastDigits('');
              setColorDetail('');
              setLostDetails('');
              setOwnerPhone('');
              setOtpCode('');
              setRatingSubmitted(false);
              setUserRating(null);
              setOwnerIdentifyingDetails('');
              setIsConfident(false);
              handleSearch(); // Refresh lists
            }}
            className="w-full bg-stone-100 hover:bg-stone-200 text-stone-700 py-3 rounded-2xl font-bold transition text-xs"
          >
            Go Back to Search
          </button>
        </div>
      )}

      {/* Awaiting agent in-person verification step */}
      {verificationStep === 'awaiting_agent_confirmation' && (
        <div className="bg-white rounded-3xl border border-stone-100 p-6 md:p-8 shadow-xl max-w-xl mx-auto space-y-6 text-center fade-in">
          <div className="w-14 h-14 bg-amber-50 text-amber-500 rounded-full flex items-center justify-center mx-auto animate-pulse">
            <Eye size={28} />
          </div>
          <div>
            <h2 className="text-xl font-extrabold text-primary-green mb-1">
              {lang === 'en' ? 'Physical Viewing Verification Required' : 'Uthibitisho wa Kuona Bidhaa Unahitajika'}
            </h2>
            <p className="text-stone-500 text-xs">
              {lang === 'en' 
                ? 'Your ownership claim code is approved! Now, you must visit the agent physical hub to visually inspect your item. The agent will confirm you have viewed and verified the item before payment is requested.' 
                : 'Msimbo wako wa kudai umethibitishwa! Sasa, lazima utembelee kituo cha wakala ili ukague bidhaa yako physically. Wakala atathibitisha kuwa umeona na kukagua bidhaa kabla ya malipo kuombwa.'}
            </p>
          </div>

          {/* Render strike warning if present */}
          {strikeWarning && (
            <div className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-2xl text-xs text-left flex items-start space-x-2">
              <AlertTriangle size={18} className="shrink-0 mt-0.5" />
              <span>{strikeWarning}</span>
            </div>
          )}

          {selectedItem?.agent ? (
            <div className="bg-brand-beige rounded-2xl border border-stone-200 p-5 text-left space-y-3">
              <span className="text-[10px] font-extrabold text-stone-400 uppercase tracking-widest block">
                {lang === 'en' ? 'Hub Location / Mahali pa Wakala' : 'Mahali pa Wakala'}
              </span>
              <div>
                <h4 className="text-base font-bold text-primary-green">{selectedItem.agent.business_name}</h4>
                <p className="text-stone-600 text-xs font-medium">{selectedItem.agent.location_address}</p>
                {selectedItem.agent.contact_phone && (
                  <p className="text-stone-500 text-[11px] mt-1 font-medium">
                    Contact: <span className="font-mono">{selectedItem.agent.contact_phone}</span>
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="text-stone-400 text-xs py-4 italic">
              {lang === 'en' ? 'Fetching physical agent location details...' : 'Inapakia maelezo ya mahali pa wakala...'}
            </div>
          )}

          <div className="bg-emerald-50 border border-emerald-100 rounded-2xl p-4 text-xs text-left text-primary-green flex items-start space-x-2">
            <Loader2 className="animate-spin text-primary-green shrink-0 mt-0.5" size={16} />
            <p className="font-medium text-stone-600">
              {lang === 'en' 
                ? 'Waiting for the agent to visually verify you have inspected the item... Keep this page open.' 
                : 'Tunasubiri wakala athibitishe kuwa umekagua bidhaa physically... Tafadhali weka ukurasa huu wazi.'}
            </p>
          </div>
        </div>
      )}

      {/* Payment window expired step */}
      {verificationStep === 'payment_window_expired' && (
        <div className="bg-white rounded-3xl border border-stone-100 p-6 md:p-8 shadow-xl max-w-xl mx-auto space-y-6 text-center fade-in">
          <div className="w-14 h-14 bg-red-50 text-red-500 rounded-full flex items-center justify-center mx-auto">
            <XCircle size={28} />
          </div>
          <div>
            <h2 className="text-xl font-extrabold text-red-600 mb-1">
              {lang === 'en' ? 'Payment Window Expired' : 'Muda wa Kulipa Umeisha'}
            </h2>
            <p className="text-stone-500 text-xs">
              {lang === 'en' 
                ? 'Your 15-minute payment window has expired. For security and fairness, the item has been unlocked for other potential claimants, and a strike has been recorded against your phone number. Repeated strikes will restrict you from making future claims.' 
                : 'Muda wako wa dakika 15 wa kulipa umeisha. Kwa usalama na usawa, bidhaa hii imefunguliwa kwa wadai wengine na nambari yako imerekodiwa strike. Strikes zikizidi utazuiwa kufanya madai zaidi.'}
            </p>
          </div>

          <button
            onClick={() => {
              setVerificationStep('search');
              setSelectedItem(null);
              setPaidClaim(null);
              setLastDigits('');
              setColorDetail('');
              setLostDetails('');
              setOwnerPhone('');
              setOtpCode('');
              setRatingSubmitted(false);
              setUserRating(null);
              setOwnerIdentifyingDetails('');
              setIsConfident(false);
            }}
            className="w-full bg-stone-100 hover:bg-stone-200 text-stone-700 py-3 rounded-xl font-bold transition text-xs"
          >
            {lang === 'en' ? 'Back to Search' : 'Rudi kwenye Kutafuta'}
          </button>
        </div>
      )}

      {/* TRACK MY CLAIM MODAL */}
      {showTrackModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 fade-in">
          <div className="bg-white rounded-3xl p-6 md:p-8 max-w-lg w-full space-y-5 shadow-2xl relative border border-stone-100">
            <div className="flex items-center justify-between border-b border-stone-100 pb-3">
              <h3 className="text-xl font-extrabold text-primary-green flex items-center gap-2">
                <Clock size={20} className="text-accent-orange" />
                <span>{lang === 'sw' ? 'Fuatilia Ombi Lako (Track My Claim)' : 'Track My Claim'}</span>
              </h3>
              <button
                type="button"
                onClick={() => setShowTrackModal(false)}
                className="text-stone-400 hover:text-stone-600 font-bold text-lg cursor-pointer px-2"
              >
                ✕
              </button>
            </div>

            {trackError && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-xs flex items-center gap-2">
                <AlertCircle size={16} className="shrink-0" />
                <span>{trackError}</span>
              </div>
            )}

            <form onSubmit={async (e) => {
              e.preventDefault();
              setTrackError('');
              setTrackResult(null);
              setTrackLoading(true);
              try {
                const res = await fetch('/api/claims/lookup', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ claimId: trackClaimId, phone: trackPhone }),
                });
                const data = await res.json();
                if (!res.ok) {
                  throw new Error(data.error || 'Claim lookup failed');
                }
                setTrackResult(data);
              } catch (err: any) {
                setTrackError(err.message);
              } finally {
                setTrackLoading(false);
              }
            }} className="space-y-4">
              
              <div className="space-y-1">
                <label htmlFor="track-claim-id" className="block text-xs font-bold text-primary-green uppercase tracking-wider">
                  Claim ID / Msimbo wa Ombi *
                </label>
                <input
                  id="track-claim-id"
                  type="text"
                  value={trackClaimId}
                  onChange={(e) => setTrackClaimId(e.target.value)}
                  placeholder="e.g. R4M-CLM-A1B2C3"
                  className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm font-mono uppercase bg-brand-beige"
                  required
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="track-phone" className="block text-xs font-bold text-primary-green uppercase tracking-wider">
                  Phone Number Used / Nambari ya Simu *
                </label>
                <input
                  id="track-phone"
                  type="tel"
                  value={trackPhone}
                  onChange={(e) => setTrackPhone(e.target.value)}
                  placeholder="e.g. 0712345678"
                  className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm font-mono bg-brand-beige"
                  required
                />
              </div>

              <button
                type="submit"
                disabled={trackLoading}
                className="w-full bg-accent-orange hover:bg-accent-hover text-white py-3 rounded-xl font-bold text-sm transition flex items-center justify-center space-x-2 cursor-pointer disabled:opacity-50"
              >
                {trackLoading ? (
                  <Loader2 className="animate-spin" size={18} />
                ) : (
                  <span>{lang === 'sw' ? 'Tafuta Taarifa za Ombi' : 'Look Up Claim Status'}</span>
                )}
              </button>
            </form>

            {/* Render Lookup Result */}
            {trackResult && (
              <div className="mt-4 bg-stone-50 border border-stone-200 p-4 rounded-2xl space-y-3 fade-in text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-extrabold text-stone-700">Status:</span>
                  <span className={`${getClaimStatusDisplay(trackResult.claim.status, lang).className} px-2.5 py-1 rounded-full font-bold uppercase tracking-wider text-[10px]`}>
                    {getClaimStatusDisplay(trackResult.claim.status, lang).label}
                  </span>
                </div>

                {trackResult.item && (
                  <div className="space-y-1 border-t border-stone-200 pt-2">
                    <p className="font-bold text-primary-green text-sm">{trackResult.item.document_name_fuzzy || 'Found Item'}</p>
                    <p className="text-stone-600">📍 Location: {trackResult.item.location_description}</p>
                  </div>
                )}

                {trackResult.agent && (
                  <div className="bg-white p-3 rounded-xl border border-stone-200 space-y-1">
                    <p className="font-bold text-stone-800">🏢 Assigned Agent Hub:</p>
                    <p className="text-primary-green font-extrabold">{trackResult.agent.business_name}</p>
                    <p className="text-stone-500">{trackResult.agent.location_address}</p>
                    <p className="text-stone-500 font-mono">📞 {trackResult.agent.contact_phone}</p>
                  </div>
                )}

                {trackResult.claim.collection_code && (
                  <div className="bg-emerald-100 border border-emerald-200 p-3 rounded-xl text-center">
                    <p className="text-[10px] text-emerald-800 uppercase font-bold tracking-widest">Collection Verification Code</p>
                    <p className="text-2xl font-mono font-black text-primary-green tracking-widest mt-0.5">{trackResult.claim.collection_code}</p>
                  </div>
                )}

                {/* Resume into the real flow based on actual claim status — this is the
                    action step; the panel above is informational only. */}
                {['awaiting_agent_confirmation', 'pending_payment', 'payment_window_expired', 'escrow_held', 'released'].includes(trackResult.claim.status) ? (
                  <button
                    type="button"
                    onClick={() => {
                      const resumedItem = trackResult.item
                        ? { ...trackResult.item, agent: trackResult.agent || undefined }
                        : null;
                      setSelectedItem(resumedItem);
                      setPaidClaim(trackResult.claim);

                      if (trackResult.claim.status === 'awaiting_agent_confirmation') {
                        setVerificationStep('awaiting_agent_confirmation');
                        startAwaitingAgentPolling(trackResult.claim.id);
                      } else if (trackResult.claim.status === 'pending_payment') {
                        setVerificationStep('payment');
                      } else if (trackResult.claim.status === 'payment_window_expired') {
                        setVerificationStep('payment_window_expired');
                      } else if (trackResult.claim.status === 'escrow_held' || trackResult.claim.status === 'released') {
                        setVerificationStep('handover_success');
                      }
                      setShowTrackModal(false);
                    }}
                    className="w-full bg-primary-green hover:bg-primary-green-dark text-white py-3 rounded-xl font-bold text-sm transition flex items-center justify-center space-x-2 cursor-pointer"
                  >
                    <span>
                      {trackResult.claim.status === 'pending_payment'
                        ? (lang === 'sw' ? 'Endelea Kulipa Sasa' : 'Continue to Payment')
                        : (lang === 'sw' ? 'Endelea na Ombi Hili' : 'Continue to My Claim')}
                    </span>
                    <ArrowRight size={16} />
                  </button>
                ) : (
                  <p className="text-stone-500 italic text-center pt-1">
                    {trackResult.claim.status === 'refunded'
                      ? (lang === 'sw'
                          ? 'Umepoteza mzozo huu, lakini fedha yako ya awali imerejeshwa kikamilifu kwa M-Pesa yako. Angalia ujumbe wa M-Pesa kwa uthibitisho.'
                          : 'You lost this dispute, but your original payment has been fully refunded to your M-Pesa. Check your M-Pesa messages for confirmation.')
                      : trackResult.claim.status === 'refunding'
                      ? (lang === 'sw'
                          ? 'Uamuzi wa mzozo umefanywa na urejeshaji wa fedha yako unaendelea kwa sasa. Utapokea ujumbe wa M-Pesa hivi karibuni.'
                          : 'The dispute has been decided and your refund is currently being processed. You will receive an M-Pesa confirmation shortly.')
                      : trackResult.claim.status === 'disputed'
                      ? (lang === 'sw'
                          ? 'Mtu mwingine pia amedai bidhaa hii. Wasimamizi wanakagua ushahidi na watawasiliana nawe hivi karibuni.'
                          : 'Another person has also claimed this item. Our admin team is reviewing the evidence and will be in touch soon.')
                      : trackResult.claim.status === 'rejected'
                      ? (lang === 'sw'
                          ? 'Ombi hili halikuthibitishwa. Ikiwa unaamini hii ni kosa, wasiliana na usaidizi.'
                          : 'This claim was not approved. If you believe this is a mistake, please contact support.')
                      : (lang === 'sw'
                          ? 'Ombi hili haliwezi kuendelezwa hapa kwa sasa. Wasiliana na msaada ikiwa unahitaji msaada zaidi.'
                          : 'This claim cannot be resumed here right now. Contact support if you need further help.')}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
