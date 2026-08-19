import React, { useState, useEffect, useRef } from 'react';
import { translations } from '../types';
import { ShieldCheck, Plus, CheckCircle, PackageOpen, HelpCircle, Loader2, ArrowRight, AlertCircle, Phone, Lock, Eye, Camera, Upload } from 'lucide-react';

interface AgentViewProps {
  lang: 'en' | 'sw';
  token: string | null;
  setToken: (token: string | null) => void;
}

export default function AgentView({ lang, token, setToken }: AgentViewProps) {
  const t = translations[lang];

  // Auth States
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [showOtp, setShowOtp] = useState(false);

  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  // Application/Registration form states
  const [isRegistering, setIsRegistering] = useState(false);
  const [businessName, setBusinessName] = useState('');
  const [locationAddress, setLocationAddress] = useState('');
  const [payoutMethodType, setPayoutMethodType] = useState('Till Number');
  const [tillNumber, setTillNumber] = useState('');
  const [nationalId, setNationalId] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [shopPhotoBase64, setShopPhotoBase64] = useState<string | null>(null);
  const [idDocumentPhotoBase64, setIdDocumentPhotoBase64] = useState<string | null>(null);
  const [agreedTerms, setAgreedTerms] = useState(false);

  // Agent Queue States
  const [agentStatus, setAgentStatus] = useState<string>('pending');
  const [expectedDropoffs, setExpectedDropoffs] = useState<any[]>([]);
  const [holdingPickups, setHoldingPickups] = useState<any[]>([]);
  const [agentProfile, setAgentProfile] = useState<any | null>(null);
  const [agentEarnings, setAgentEarnings] = useState<{ totalEarned: number; completedPayoutsCount: number } | null>(null);

  // Modal / Inputs
  const [dropoffCodeInput, setDropoffCodeInput] = useState('');
  const [handoverCodeInput, setHandoverCodeInput] = useState('');
  const [actionSuccessMsg, setActionSuccessMsg] = useState('');

  // Rejection States
  const [rejectingItemId, setRejectingItemId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState<string>("Not a real item");
  const [rejectionCustomText, setRejectionCustomText] = useState<string>("");

  // Action Loading State
  const [actionProcessing, setActionProcessing] = useState(false);

  // Confirmation Modal State
  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);

  // Handover Pickup Code Modal State — collects the owner's secret pickup
  // code and a handover evidence photo before /api/agents/confirm-handover
  // is called.
  const [pickupCodeModal, setPickupCodeModal] = useState<{
    claimId: string;
    code: string;
    photoBase64: string | null;
  } | null>(null);
  const handoverPhotoInputRef = useRef<HTMLInputElement>(null);
  const [useHandoverCamera, setUseHandoverCamera] = useState(false);
  const handoverVideoRef = useRef<HTMLVideoElement | null>(null);
  const handoverCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Fetch Agent Queues on Token availability
  const fetchQueues = async () => {
    if (!token) return;
    try {
      const response = await fetch('/api/agents/queue', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (!response.ok) {
        // If forbidden or pending
        setAgentStatus('pending');
        return;
      }
      setAgentStatus('active');
      setAgentProfile(data.agent);
      setAgentEarnings(data.earnings || null);
      setExpectedDropoffs(data.pendingDropoffs);
      setHoldingPickups(data.holdingItems);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    fetchQueues();
  }, [token]);

  // Request login/onboarding OTP
  const handleAuthRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');

    if (isRegistering && contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
      setAuthError('Tafadhali weka barua pepe sahihi (Please enter a valid email address).');
      return;
    }

    setAuthLoading(true);

    try {
      const payload: any = { phone };
      if (isRegistering) {
        payload.role = 'agent';
        payload.businessName = businessName;
        payload.locationAddress = locationAddress;
        payload.tillNumber = tillNumber;
        payload.nationalId = nationalId;
      }

      const response = await fetch('/api/auth/request-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to dispatch OTP');
      }


      setShowOtp(true);
    } catch (e: any) {
      setAuthError(e.message);
    } finally {
      setAuthLoading(false);
    }
  };

  // Verify OTP & save token
  const handleOtpVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    setAuthLoading(true);

    try {
      const response = await fetch('/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone,
          code: otp,
          role: 'agent',
          businessName,
          locationAddress,
          payoutMethodType,
          tillNumber,
          nationalId,
          termsAccepted: agreedTerms,
          contactEmail,
          shopPhotoBase64,
          idDocumentPhotoBase64,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'OTP Verification failed');
      }

      setToken(data.token);
    } catch (e: any) {
      setAuthError(e.message);
    } finally {
      setAuthLoading(false);
    }
  };

  // Confirm Physical Drop-off from Finder
  const handleConfirmDropoff = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionSuccessMsg('');
    setAuthError('');
    setActionProcessing(true);

    try {
      const response = await fetch('/api/agents/confirm-dropoff', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ dropoffCode: dropoffCodeInput }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Confirm drop-off failed');
      }

      setActionSuccessMsg(data.message);
      setDropoffCodeInput('');
      fetchQueues(); // Reload queues
    } catch (e: any) {
      setAuthError(e.message);
    } finally {
      setActionProcessing(false);
    }
  };

  const handleRejectDropoff = async (dropoffCode: string) => {
    setActionSuccessMsg('');
    setAuthError('');
    setActionProcessing(true);

    const finalReason = rejectionReason === "Other" ? `Other: ${rejectionCustomText}` : rejectionReason;

    try {
      const response = await fetch('/api/agents/reject-dropoff', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ dropoffCode, reason: finalReason }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Reject drop-off failed');
      }

      setActionSuccessMsg(data.message);
      setRejectingItemId(null);
      fetchQueues(); // Reload queues
    } catch (e: any) {
      setAuthError(e.message);
    } finally {
      setActionProcessing(false);
    }
  };

  // Confirm visual check of owner ID and physical handover — requires the
  // owner's secret pickup code (sent to them privately via SMS/email once
  // payment was confirmed), so a separate dedicated modal collects it here
  // rather than reusing the generic yes/no confirmModal.
  const handleConfirmHandover = (claimId: string) => {
    setActionSuccessMsg('');
    setAuthError('');
    setPickupCodeModal({ claimId, code: '', photoBase64: null });
  };

  const handleHandoverPhotoCapture = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !pickupCodeModal) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      setPickupCodeModal({ ...pickupCodeModal, photoBase64: reader.result as string });
    };
    reader.readAsDataURL(file);
  };

  const startHandoverCamera = async () => {
    setAuthError('');
    setUseHandoverCamera(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      if (handoverVideoRef.current) {
        handoverVideoRef.current.srcObject = stream;
        handoverVideoRef.current.play();
      }
    } catch (e) {
      console.error('Camera access denied:', e);
      setAuthError(lang === 'en' ? 'Could not access camera. Please use file upload instead.' : 'Imeshindwa kufungua kamera. Tafadhali weka picha ya faili badala yake.');
      setUseHandoverCamera(false);
    }
  };

  const stopHandoverCamera = () => {
    if (handoverVideoRef.current && handoverVideoRef.current.srcObject) {
      const stream = handoverVideoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach(track => track.stop());
      handoverVideoRef.current.srcObject = null;
    }
    setUseHandoverCamera(false);
  };

  const captureHandoverFrame = () => {
    if (handoverVideoRef.current && handoverCanvasRef.current && pickupCodeModal) {
      const video = handoverVideoRef.current;
      const canvas = handoverCanvasRef.current;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg');
        setPickupCodeModal({ ...pickupCodeModal, photoBase64: dataUrl });
        stopHandoverCamera();
      }
    }
  };

  const submitConfirmHandover = async () => {
    if (!pickupCodeModal) return;
    const { claimId, code, photoBase64 } = pickupCodeModal;
    if (!code || code.trim() === '') {
      setAuthError(lang === 'en' ? 'Ask the owner for their secret pickup code first.' : 'Muulize mmiliki msimbo wake wa siri kwanza.');
      return;
    }
    if (!photoBase64) {
      setAuthError(lang === 'en' ? 'Take a photo of the claimant with the item before confirming handover — this protects both of you if a dispute comes up later.' : 'Piga picha ya mdai akiwa na bidhaa kabla ya kuthibitisha — hii inawalinda nyote wawili endapo mzozo utatokea baadaye.');
      return;
    }
    setActionProcessing(true);
    try {
      const response = await fetch('/api/agents/confirm-handover', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ claimId, pickupCode: code.trim(), handoverPhotoBase64: photoBase64 }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Confirm handover failed');
      }

      setActionSuccessMsg(data.message);
      setPickupCodeModal(null);
      fetchQueues(); // Reload queues
    } catch (e: any) {
      setAuthError(e.message);
    } finally {
      setActionProcessing(false);
    }
  };

  // Confirm owner viewed and verified the item physically
  const handleConfirmViewing = (claimId: string) => {
    setActionSuccessMsg('');
    setAuthError('');

    setConfirmModal({
      title: lang === 'en' ? 'Confirm Viewing' : 'Thibitisha Ukaguzi',
      message: lang === 'en'
        ? "Are you sure you want to confirm that the owner has visually inspected and verified this item? This will trigger the 15-minute payment window and cannot be undone."
        : "Je, una uhakika unataka kuthibitisha kwamba mmiliki amekagua na kuthibitisha bidhaa hii kwa macho? Hii itaanzisha muda wa dakika 15 wa malipo na kitendo hiki hakiwezi kubatilishwa.",
      onConfirm: async () => {
        setActionProcessing(true);
        try {
          const response = await fetch(`/api/agents/claims/${claimId}/confirm-viewing`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
          });

          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.error || 'Confirm viewing failed');
          }

          setActionSuccessMsg(data.message);
          fetchQueues(); // Reload queues
        } catch (e: any) {
          setAuthError(e.message);
        } finally {
          setActionProcessing(false);
        }
      }
    });
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 fade-in">
      
      {/* 1. NOT LOGGED IN / ONBOARDING VIEW */}
      {!token && (
        <div className="bg-white rounded-3xl border border-stone-100 p-6 md:p-8 shadow-xl max-w-lg mx-auto space-y-6">
          <div className="text-center space-y-2">
            <h1 className="text-3xl font-extrabold text-primary-green">{t.agentTitle}</h1>
            <p className="text-stone-500 text-xs max-w-sm mx-auto">{t.agentSubtitle}</p>
          </div>

          {authError && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2.5 rounded-2xl flex items-center space-x-2 text-xs">
              <AlertCircle size={16} />
              <span>{authError}</span>
            </div>
          )}

          {/* OTP verify form */}
          {showOtp ? (
            <form onSubmit={handleOtpVerify} className="space-y-4">

              <div className="space-y-1">
                <label htmlFor="agent-otp" className="block text-xs font-bold text-primary-green uppercase tracking-wider">SMS OTP Verification Code</label>
                <input
                  id="agent-otp"
                  type="text"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                  maxLength={4}
                  placeholder="••••"
                  className="w-full border-2 border-stone-200 rounded-xl py-3 text-center text-xl font-mono tracking-widest focus:outline-none focus:border-accent-orange"
                  required
                />
              </div>
              <button
                type="submit"
                disabled={authLoading}
                className="w-full bg-accent-orange hover:bg-accent-hover text-white py-3.5 rounded-2xl font-bold transition flex items-center justify-center space-x-2"
              >
                <span>Verify OTP & Open Dashboard</span>
                <ArrowRight size={18} />
              </button>
            </form>
          ) : (
            /* Request OTP / Register form */
            <form onSubmit={handleAuthRequest} className="space-y-4">
              
              {/* Toggle new agent registration vs login */}
              <div className="grid grid-cols-2 bg-brand-beige p-1 rounded-xl gap-1">
                <button
                  type="button"
                  onClick={() => setIsRegistering(false)}
                  className={`py-2 rounded-lg text-xs font-bold transition ${!isRegistering ? 'bg-white text-primary-green shadow' : 'text-stone-500'}`}
                >
                  Agent Login
                </button>
                <button
                  type="button"
                  onClick={() => setIsRegistering(true)}
                  className={`py-2 rounded-lg text-xs font-bold transition ${isRegistering ? 'bg-white text-primary-green shadow' : 'text-stone-500'}`}
                >
                  Apply to be Agent
                </button>
              </div>

              {/* Registration Specific Fields */}
              {isRegistering && (
                <div className="space-y-4 fade-in">
                  <div className="space-y-1">
                    <label htmlFor="agent-business-name" className="block text-xs font-bold text-primary-green uppercase tracking-wider">{t.businessName} *</label>
                    <input
                      id="agent-business-name"
                      type="text"
                      value={businessName}
                      onChange={(e) => setBusinessName(e.target.value)}
                      placeholder="e.g. Hurlingham Cyber Café"
                      className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm"
                      required
                    />
                  </div>

                  <div className="space-y-1">
                    <label htmlFor="agent-location" className="block text-xs font-bold text-primary-green uppercase tracking-wider">Physical Street/Building Location *</label>
                    <input
                      id="agent-location"
                      type="text"
                      value={locationAddress}
                      onChange={(e) => setLocationAddress(e.target.value)}
                      placeholder="e.g. Argwings Kodhek Rd, prestige plaza"
                      className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm"
                      required
                    />
                  </div>

                  <div className="space-y-4">
                    <div className="space-y-1">
                      <label htmlFor="agent-payout-method" className="block text-xs font-bold text-primary-green uppercase tracking-wider">Payout Method *</label>
                      <select
                        id="agent-payout-method"
                        value={payoutMethodType}
                        onChange={(e) => setPayoutMethodType(e.target.value)}
                        className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm bg-white"
                        required
                      >
                        <option value="Till Number">Till Number (M-Pesa Buy Goods)</option>
                        <option value="Paybill Number">Paybill Number</option>
                        <option value="Pochi la Biashara">Pochi la Biashara</option>
                        <option value="Personal M-Pesa">Personal M-Pesa (Send Money)</option>
                      </select>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label htmlFor="agent-till-number" className="block text-xs font-bold text-primary-green uppercase tracking-wider">Payout Code / Number *</label>
                        <input
                          id="agent-till-number"
                          type="text"
                          value={tillNumber}
                          onChange={(e) => setTillNumber(e.target.value)}
                          placeholder="Till / Paybill / Phone"
                          className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm font-mono"
                          required
                        />
                      </div>
                      <div className="space-y-1">
                        <label htmlFor="agent-national-id" className="block text-xs font-bold text-primary-green uppercase tracking-wider">{t.nationalId} *</label>
                        <input
                          id="agent-national-id"
                          type="text"
                          value={nationalId}
                          onChange={(e) => setNationalId(e.target.value)}
                          placeholder="e.g. 32019482"
                          className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm font-mono"
                          required
                        />
                      </div>
                    </div>

                    <div className="space-y-1">
                      <label htmlFor="agent-contact-email" className="block text-xs font-bold text-primary-green uppercase tracking-wider">
                        Email Address (Optional / Barua Pepe - Sio Lazima)
                      </label>
                      <input
                        id="agent-contact-email"
                        type="email"
                        value={contactEmail}
                        onChange={(e) => setContactEmail(e.target.value)}
                        placeholder="e.g. agent@return4me.co.ke"
                        className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm font-sans"
                      />
                    </div>

                    {/* Shop Photo Upload */}
                    <div className="space-y-1">
                      <label htmlFor="agent-shop-photo" className="block text-xs font-bold text-primary-green uppercase tracking-wider">
                        Business / Shop Front Photo (Picha ya Duka/Biashara)
                      </label>
                      <input
                        id="agent-shop-photo"
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/heic"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) {
                            if (file.size > 5 * 1024 * 1024) {
                              setAuthError('Picha ya duka ni kubwa mno. Tafadhali chagua picha chini ya 5MB.');
                              return;
                            }
                            const reader = new FileReader();
                            reader.onloadend = () => setShopPhotoBase64(reader.result as string);
                            reader.readAsDataURL(file);
                          }
                        }}
                        className="block w-full text-xs text-stone-500 file:mr-3 file:py-2 file:px-3 file:rounded-xl file:border-0 file:text-xs file:font-bold file:bg-emerald-50 file:text-primary-green hover:file:bg-emerald-100 cursor-pointer"
                      />
                      {shopPhotoBase64 && (
                        <p className="text-[11px] text-emerald-600 font-semibold">✓ Picha ya duka imepakiwa (Shop photo selected)</p>
                      )}
                    </div>

                    {/* ID Document Photo Upload */}
                    <div className="space-y-1">
                      <label htmlFor="agent-id-document-photo" className="block text-xs font-bold text-primary-green uppercase tracking-wider">
                        Agent ID Document Photo (Picha ya Kitambulisho cha Wakala)
                      </label>
                      <input
                        id="agent-id-document-photo"
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/heic"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) {
                            if (file.size > 5 * 1024 * 1024) {
                              setAuthError('Picha ya kitambulisho ni kubwa mno. Tafadhali chagua picha chini ya 5MB.');
                              return;
                            }
                            const reader = new FileReader();
                            reader.onloadend = () => setIdDocumentPhotoBase64(reader.result as string);
                            reader.readAsDataURL(file);
                          }
                        }}
                        className="block w-full text-xs text-stone-500 file:mr-3 file:py-2 file:px-3 file:rounded-xl file:border-0 file:text-xs file:font-bold file:bg-orange-50 file:text-accent-orange hover:file:bg-orange-100 cursor-pointer"
                      />
                      {idDocumentPhotoBase64 && (
                        <p className="text-[11px] text-emerald-600 font-semibold">✓ Picha ya kitambulisho imepakiwa (ID photo selected)</p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* General phone */}
              <div className="space-y-1">
                <label htmlFor="agent-phone" className="block text-xs font-bold text-primary-green uppercase tracking-wider">Phone Number *</label>
                <div className="relative">
                  <input
                    id="agent-phone"
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="0712345678"
                    className="w-full border border-stone-200 rounded-xl pl-10 pr-3 py-2.5 text-sm font-mono"
                    required
                  />
                  <Phone size={14} className="absolute left-3 top-3.5 text-stone-400" />
                </div>
              </div>

              {isRegistering && (
                <div className="flex items-start space-x-2 pt-2 pb-1 bg-brand-beige p-3 rounded-xl border border-stone-100">
                  <input
                    id="agreed-terms"
                    type="checkbox"
                    checked={agreedTerms}
                    onChange={(e) => setAgreedTerms(e.target.checked)}
                    className="mt-1 h-4 w-4 rounded border-stone-300 text-primary-green focus:ring-primary-green accent-primary-green cursor-pointer"
                    required
                  />
                  <label htmlFor="agreed-terms" className="text-xs text-stone-600 leading-tight select-none cursor-pointer">
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
                    .
                  </label>
                </div>
              )}

              <button
                type="submit"
                disabled={authLoading}
                className="w-full bg-primary-green hover:bg-primary-hover text-white py-3.5 rounded-2xl font-bold transition flex items-center justify-center space-x-2"
              >
                {authLoading ? (
                  <Loader2 className="animate-spin" size={18} />
                ) : (
                  <>
                    <span>Request Login OTP</span>
                    <ArrowRight size={18} />
                  </>
                )}
              </button>
            </form>
          )}
        </div>
      )}

      {/* 2. PENDING APPROVAL VIEW */}
      {token && agentStatus === 'pending' && (
        <div className="bg-white rounded-3xl border border-stone-100 p-8 shadow-xl max-w-md mx-auto text-center space-y-5 fade-in">
          <div className="w-16 h-16 bg-orange-100 text-accent-orange rounded-full flex items-center justify-center mx-auto">
            <Lock size={32} />
          </div>
          <div>
            <h2 className="text-2xl font-extrabold text-primary-green">Vetting Pending</h2>
            <p className="text-stone-600 text-sm mt-1 font-semibold">
              {lang === 'sw'
                ? 'Taarifa zako zitakaguliwa na utaarifiwa kuhusu maombi yako.'
                : 'Their details will be checked and they\'ll be notified of their application.'}
            </p>
          </div>
          <div className="bg-brand-beige border border-stone-200 p-4 rounded-xl text-left text-xs text-stone-600 space-y-1.5 leading-tight">
            {lang === 'sw' ? (
              <>
                <span className="font-bold block mb-1">Mchakato wa Kuidhinisha:</span>
                <span>1. Uhakiki wa maelezo ya biashara na mahali ilipo</span>
                <span>2. Uhakiki salama wa Kitambulisho cha Kitaifa (KYC)</span>
                <span>3. Utapokea ujumbe wa SMS au barua pepe maombi yako yakishaidhinishwa!</span>
              </>
            ) : (
              <>
                <span className="font-bold block mb-1">Onboarding Process:</span>
                <span>1. Verification of Business Details & Location</span>
                <span>2. Secure KYC & National ID Hash Review</span>
                <span>3. SMS or Email notification dispatch upon activation!</span>
              </>
            )}
          </div>
        </div>
      )}

      {/* 3. ACTIVE AGENT HUB VIEW */}
      {token && agentStatus === 'active' && agentProfile && (
        <div className="space-y-8 fade-in">
          
          {/* Hub Profile Banner */}
          <div className="bg-primary-green text-white p-6 rounded-3xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div>
              <span className="bg-emerald-800 text-accent-orange border border-emerald-700 text-[10px] font-extrabold px-3 py-1 rounded-full uppercase tracking-wider inline-block mb-2">
                Verified Return4me Partner Point
              </span>
              <h1 className="text-2xl font-extrabold">{agentProfile.business_name}</h1>
              <p className="text-stone-300 text-xs mt-0.5">{agentProfile.location_address}</p>
            </div>
            <div className="bg-white/10 p-4 rounded-2xl border border-white/5 text-right font-mono">
              <span className="text-[10px] text-stone-300 block uppercase font-sans font-bold">Payout via {agentProfile.payout_method_type || "Till Number"}</span>
              <span className="text-lg font-extrabold text-accent-orange">{agentProfile.mpesa_till_or_paybill}</span>
            </div>
          </div>

          {/* Total Earnings Card — your commission share after each escrow release */}
          {agentEarnings && (
            <div className="bg-white border border-stone-100 rounded-3xl p-6 shadow-sm flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
              <div>
                <span className="text-stone-400 text-[10px] font-extrabold uppercase tracking-widest block">
                  {lang === 'en' ? 'Total Earned (your commission share)' : 'Jumla Uliyopata (sehemu yako ya kamisheni)'}
                </span>
                <span className="text-3xl font-black text-primary-green block mt-1">
                  KES {agentEarnings.totalEarned.toLocaleString()}
                </span>
              </div>
              <div className="bg-emerald-50 text-emerald-700 border border-emerald-100 rounded-2xl px-4 py-2 text-xs font-bold">
                {agentEarnings.completedPayoutsCount} {lang === 'en' ? 'completed handovers paid out' : 'kukabidhi zilizolipwa'}
              </div>
            </div>
          )}

          {actionSuccessMsg && (
            <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-3 rounded-2xl flex items-center space-x-2 text-sm font-semibold">
              <CheckCircle size={18} className="shrink-0" />
              <span>{actionSuccessMsg}</span>
            </div>
          )}

          {/* Quick Confirmation Actions */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            
            {/* Confirm finder dropoff */}
            <div className="bg-white rounded-3xl border border-stone-100 p-5 shadow-lg space-y-4">
              <div className="flex items-center space-x-2 text-primary-green">
                <ShieldCheck size={20} className="text-accent-orange" />
                <h3 className="font-extrabold text-sm uppercase tracking-wide">{t.confirmDropBtn}</h3>
              </div>
              <form onSubmit={handleConfirmDropoff} className="flex gap-2">
                <input
                  type="text"
                  value={dropoffCodeInput}
                  onChange={(e) => setDropoffCodeInput(e.target.value)}
                  placeholder={t.enterDropCode}
                  aria-label={t.enterDropCode}
                  className="flex-1 border border-stone-200 rounded-xl px-3 py-2 text-xs font-mono focus:outline-none focus:border-accent-orange"
                  required
                />
                <button
                  type="submit"
                  disabled={actionProcessing}
                  className="bg-accent-orange hover:bg-accent-hover text-white text-xs font-bold px-4 py-2 rounded-xl transition flex items-center justify-center space-x-1.5 disabled:opacity-50"
                >
                  {actionProcessing ? (
                    <Loader2 className="animate-spin" size={14} />
                  ) : (
                    <span>Verify</span>
                  )}
                </button>
              </form>
            </div>

            {/* Hub rules note */}
            <div className="bg-emerald-50 border border-emerald-100 text-primary-green p-5 rounded-3xl text-xs space-y-1">
              <span className="font-bold block">Hub Handover Golden Rule:</span>
              <span>Always visually match the name on the owner national ID against the document name on the system before typing collection codes! Incorrect handovers result in permanent agent suspension.</span>
            </div>
          </div>

          {/* Processing Queues */}
          <div className="space-y-6">
            <h2 className="text-xl font-extrabold text-primary-green">{t.agentQueue}</h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              
              {/* Drop-offs Queue */}
              <div className="space-y-3">
                <h3 className="font-bold text-sm text-stone-500 uppercase tracking-widest">{t.expectedDropoffs} ({expectedDropoffs.length})</h3>
                {expectedDropoffs.length === 0 ? (
                  <div className="bg-stone-50 border border-stone-200 rounded-2xl p-6 text-center text-xs text-stone-400">
                    No pending physical drops scheduled currently.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {expectedDropoffs.map((item) => (
                      <div key={item.id} className="bg-white border border-stone-100 rounded-2xl p-4 shadow-sm flex flex-col space-y-3">
                        <div className="flex items-center justify-between">
                          <div>
                            <span className="text-xs font-mono font-bold text-accent-orange">{item.id}</span>
                            <p className="text-stone-500 text-[10px] leading-tight">Reported on: {new Date(item.created_at).toLocaleDateString()}</p>
                          </div>
                          {rejectingItemId !== item.id && (
                            <div className="flex space-x-1.5">
                              <button
                                onClick={() => {
                                  setDropoffCodeInput(item.id);
                                }}
                                className="bg-primary-green text-white text-xs font-bold px-3 py-1.5 rounded-xl hover:bg-primary-hover transition"
                              >
                                Confirm
                              </button>
                              <button
                                onClick={() => {
                                  setRejectingItemId(item.id);
                                  setRejectionReason("Not a real item");
                                  setRejectionCustomText("");
                                }}
                                className="bg-red-50 text-red-600 hover:bg-red-100 text-xs font-bold px-3 py-1.5 rounded-xl transition"
                              >
                                Reject
                              </button>
                            </div>
                          )}
                        </div>

                        {rejectingItemId === item.id && (
                          <div className="bg-red-50/50 p-3 rounded-xl border border-red-100/50 space-y-3">
                            <label htmlFor={`reject-reason-${item.id}`} className="text-xs font-bold text-red-800 block">Reject Drop-off Reason:</label>
                            <div className="space-y-2">
                              <select
                                id={`reject-reason-${item.id}`}
                                value={rejectionReason}
                                onChange={(e) => setRejectionReason(e.target.value)}
                                className="w-full border border-stone-200 rounded-lg p-2 text-xs bg-white focus:outline-none focus:border-red-500"
                              >
                                <option value="Not a real item">Not a real item</option>
                                <option value="Item doesn't match description">Item doesn't match description</option>
                                <option value="Suspected test/spam">Suspected test/spam</option>
                                <option value="Other">Other (Please specify)</option>
                              </select>

                              {rejectionReason === "Other" && (
                                <input
                                  type="text"
                                  value={rejectionCustomText}
                                  onChange={(e) => setRejectionCustomText(e.target.value)}
                                  placeholder="Enter custom rejection reason..."
                                  aria-label="Custom rejection reason"
                                  className="w-full border border-stone-200 rounded-lg p-2 text-xs focus:outline-none focus:border-red-500"
                                  required
                                />
                              )}
                            </div>

                            <div className="flex space-x-2 justify-end">
                              <button
                                onClick={() => setRejectingItemId(null)}
                                className="text-stone-500 hover:text-stone-700 text-xs px-3 py-1 rounded-lg"
                              >
                                Cancel
                              </button>
                              <button
                                onClick={() => handleRejectDropoff(item.id)}
                                disabled={actionProcessing || (rejectionReason === "Other" && rejectionCustomText.trim() === "")}
                                className="bg-red-600 text-white hover:bg-red-700 text-xs font-bold px-3 py-1 rounded-lg transition flex items-center justify-center space-x-1 disabled:opacity-50"
                              >
                                {actionProcessing ? (
                                  <Loader2 className="animate-spin" size={12} />
                                ) : (
                                  <span>Submit Rejection</span>
                                )}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Handover / Pickups Queue */}
              <div className="space-y-3">
                <h3 className="font-bold text-sm text-stone-500 uppercase tracking-widest">{t.holdingPickups} ({holdingPickups.length})</h3>
                {holdingPickups.length === 0 ? (
                  <div className="bg-stone-50 border border-stone-200 rounded-2xl p-6 text-center text-xs text-stone-400">
                    Your physical inventory is currently empty.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {holdingPickups.map((item) => (
                      <div key={item.id} className="bg-white border border-stone-100 rounded-2xl p-4 shadow-sm space-y-3">
                        <div className="flex justify-between items-start">
                          <div>
                            <span className="text-xs font-mono font-extrabold text-primary-green">{item.id}</span>
                            <h4 className="text-xs font-bold text-stone-700 uppercase mt-0.5">{item.ocr_extracted_name || 'Masked Holder'}</h4>
                          </div>
                          <span className={`text-[9px] font-extrabold px-2.5 py-0.5 rounded-full uppercase ${
                            item.associatedClaim?.status === 'escrow_held' ? 'bg-emerald-100 text-emerald-800' :
                            item.associatedClaim?.status === 'awaiting_agent_confirmation' ? 'bg-amber-100 text-amber-800 animate-pulse' :
                            'bg-orange-100 text-orange-800'
                          }`}>
                            {item.associatedClaim?.status === 'escrow_held' ? 'Escrow Held (Ready)' :
                             item.associatedClaim?.status === 'awaiting_agent_confirmation' ? 'Awaiting Verification' :
                             'Awaiting Payment'}
                          </span>
                        </div>

                        {/* If claim is awaiting physical agent confirmation, show verification action button */}
                        {item.associatedClaim?.status === 'awaiting_agent_confirmation' && (
                          <div className="border-t border-stone-100 pt-3 space-y-2">
                            <p className="text-[11px] text-stone-500 font-medium text-left">
                              {lang === 'en' 
                                ? 'The owner must travel to your station and visually verify this item is theirs.' 
                                : 'Mwenye mali lazima afike kituoni kwako na athibitishe kwa macho kuwa bidhaa hii ni yake.'}
                            </p>

                            {/* What the claimant said before ever seeing this item — compare it
                                against what they say in person now. This is the agent's real
                                evidence for a non-document item; it was being collected but
                                never shown here before. */}
                            {(item.associatedClaim?.owner_identifying_details || item.associatedClaim?.security_answers?.lostDetails || item.associatedClaim?.security_answers?.color) && (
                              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-left space-y-1.5">
                                <p className="text-[9px] font-extrabold text-amber-700 uppercase tracking-widest">
                                  {lang === 'en' ? 'Claimant stated (before seeing item) — verify it matches:' : 'Alichosema mdai (kabla ya kuona bidhaa) — thibitisha inalingana:'}
                                </p>
                                {item.associatedClaim?.owner_identifying_details && (
                                  <p className="text-xs text-stone-700 font-medium">
                                    <span className="font-bold">{lang === 'en' ? 'Identifying detail: ' : 'Alama ya utambulisho: '}</span>
                                    {item.associatedClaim.owner_identifying_details}
                                  </p>
                                )}
                                {item.associatedClaim?.security_answers?.color && (
                                  <p className="text-xs text-stone-700 font-medium">
                                    <span className="font-bold">{lang === 'en' ? 'Color: ' : 'Rangi: '}</span>
                                    {item.associatedClaim.security_answers.color}
                                  </p>
                                )}
                                {item.associatedClaim?.security_answers?.lostDetails && (
                                  <p className="text-xs text-stone-700 font-medium">
                                    <span className="font-bold">{lang === 'en' ? 'Circumstances: ' : 'Mazingira: '}</span>
                                    {item.associatedClaim.security_answers.lostDetails}
                                  </p>
                                )}
                              </div>
                            )}

                            <button
                              onClick={() => handleConfirmViewing(item.associatedClaim.id)}
                              disabled={actionProcessing}
                              className="w-full bg-amber-500 text-white text-[11px] font-extrabold px-3 py-2 rounded-lg hover:bg-amber-600 flex items-center justify-center space-x-1.5 disabled:opacity-50 transition cursor-pointer"
                            >
                              {actionProcessing ? (
                                <Loader2 className="animate-spin" size={12} />
                              ) : (
                                <>
                                  <Eye size={14} />
                                  <span>{lang === 'en' ? 'Confirm Owner Viewed & Verified Item' : 'Thibitisha Mwenye Mali Ameiona & Kukagua'}</span>
                                </>
                              )}
                            </button>
                          </div>
                        )}

                        {/* If claim is ready, show collection actions */}
                        {item.associatedClaim?.status === 'escrow_held' && (
                          <div className="flex gap-2 border-t border-stone-100 pt-3">
                            <input
                              type="text"
                              value={handoverCodeInput}
                              onChange={(e) => setHandoverCodeInput(e.target.value)}
                              placeholder="Enter Handover Code (CLM-...)"
                              aria-label="Handover code"
                              className="flex-1 border border-stone-200 rounded-lg px-2.5 py-1.5 text-[11px] font-mono"
                            />
                            <button
                              onClick={() => handleConfirmHandover(item.associatedClaim.id)}
                              disabled={actionProcessing}
                              className="bg-accent-orange text-white text-[11px] font-extrabold px-3 py-1.5 rounded-lg hover:bg-accent-hover flex items-center justify-center space-x-1 disabled:opacity-50"
                            >
                              {actionProcessing ? (
                                <Loader2 className="animate-spin" size={12} />
                              ) : (
                                <span>Handover</span>
                              )}
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

            </div>
          </div>

        </div>
      )}

      {/* Custom Confirmation Modal */}
      {confirmModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-stone-900/60 backdrop-blur-sm animate-fade-in">
          <div className="bg-white border border-stone-200 rounded-3xl p-6 shadow-xl max-w-sm w-full space-y-4 animate-scale-up">
            <div className="flex items-start space-x-3 text-amber-600">
              <CheckCircle className="w-6 h-6 shrink-0 mt-0.5 animate-pulse" />
              <div className="space-y-1">
                <h3 className="font-extrabold text-sm text-stone-900 uppercase tracking-wider">
                  {confirmModal.title}
                </h3>
                <p className="text-stone-500 text-xs leading-relaxed font-semibold">
                  {confirmModal.message}
                </p>
              </div>
            </div>
            <div className="flex justify-end space-x-2 pt-2">
              <button
                onClick={() => setConfirmModal(null)}
                className="bg-stone-100 hover:bg-stone-200 text-stone-600 text-xs font-bold px-4 py-2 rounded-xl transition"
              >
                {lang === 'en' ? 'Cancel' : 'Ghairi'}
              </button>
              <button
                onClick={() => {
                  confirmModal.onConfirm();
                  setConfirmModal(null);
                }}
                className="bg-primary-green hover:bg-primary-hover text-white text-xs font-bold px-4 py-2 rounded-xl transition"
              >
                {lang === 'en' ? 'Confirm' : 'Thibitisha'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Handover Pickup Code Modal */}
      {pickupCodeModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-stone-900/60 backdrop-blur-sm animate-fade-in">
          <div className="bg-white border border-stone-200 rounded-3xl p-6 shadow-xl max-w-sm w-full space-y-4 animate-scale-up">
            <div className="flex items-start space-x-3 text-amber-600">
              <CheckCircle className="w-6 h-6 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <h3 className="font-extrabold text-sm text-stone-900 uppercase tracking-wider">
                  {lang === 'en' ? 'Confirm Handover' : 'Thibitisha Kukabidhi'}
                </h3>
                <p className="text-stone-500 text-xs leading-relaxed font-semibold">
                  {lang === 'en'
                    ? 'Ask the owner to read out their secret pickup code (sent to them by SMS/email when they paid). Enter it below to release payment. This cannot be undone.'
                    : 'Muulize mmiliki asome msimbo wake wa siri wa kuchukua (uliotumwa kwake kwa SMS/barua pepe alipolipa). Weka hapa chini kutoa malipo. Kitendo hiki hakiwezi kubatilishwa.'}
                </p>
              </div>
            </div>
            <input
              type="text"
              inputMode="numeric"
              autoFocus
              value={pickupCodeModal.code}
              onChange={(e) => setPickupCodeModal({ ...pickupCodeModal, code: e.target.value })}
              placeholder={lang === 'en' ? 'Enter owner\'s secret pickup code' : 'Weka msimbo wa siri wa mmiliki'}
              aria-label={lang === 'en' ? 'Owner\'s secret pickup code' : 'Msimbo wa siri wa mmiliki'}
              className="w-full border border-stone-300 rounded-xl px-4 py-3 text-center text-lg font-mono tracking-widest focus:outline-none focus:ring-2 focus:ring-primary-green"
            />

            <div className="space-y-2">
              <p className="text-[11px] font-bold text-stone-600">
                {lang === 'en' ? 'Photo of claimant with the item (required)' : 'Picha ya mdai akiwa na bidhaa (inahitajika)'}
              </p>
              <input
                ref={handoverPhotoInputRef}
                type="file"
                accept="image/*"
                onChange={handleHandoverPhotoCapture}
                aria-label={lang === 'en' ? 'Photo of claimant with the item' : 'Picha ya mdai akiwa na bidhaa'}
                className="hidden"
              />

              {useHandoverCamera ? (
                <div className="relative bg-black rounded-xl overflow-hidden aspect-video">
                  <video ref={handoverVideoRef} className="w-full h-full object-cover" />
                  <div className="absolute bottom-3 left-0 right-0 flex justify-center space-x-3">
                    <button
                      type="button"
                      onClick={captureHandoverFrame}
                      className="bg-accent-orange text-white px-4 py-2 rounded-lg font-bold text-xs shadow-lg transition hover:bg-accent-hover"
                    >
                      {lang === 'en' ? 'Capture' : 'Piga'}
                    </button>
                    <button
                      type="button"
                      onClick={stopHandoverCamera}
                      className="bg-stone-800 text-white px-4 py-2 rounded-lg font-bold text-xs transition hover:bg-stone-700"
                    >
                      {lang === 'en' ? 'Cancel' : 'Ghairi'}
                    </button>
                  </div>
                </div>
              ) : pickupCodeModal.photoBase64 ? (
                <div className="relative rounded-xl overflow-hidden border border-stone-200 group">
                  <img
                    src={pickupCodeModal.photoBase64}
                    alt="Handover evidence"
                    className="w-full h-40 object-cover"
                  />
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition space-x-3">
                    <button
                      type="button"
                      onClick={startHandoverCamera}
                      className="bg-white text-primary-green p-2.5 rounded-full hover:bg-stone-100 shadow-md transition"
                      title={lang === 'en' ? 'Retake with camera' : 'Piga tena kwa kamera'}
                    >
                      <Camera size={16} />
                    </button>
                    <button
                      type="button"
                      onClick={() => handoverPhotoInputRef.current?.click()}
                      className="bg-white text-primary-green p-2.5 rounded-full hover:bg-stone-100 shadow-md transition"
                      title={lang === 'en' ? 'Upload a different photo' : 'Pakia picha nyingine'}
                    >
                      <Upload size={16} />
                    </button>
                  </div>
                </div>
              ) : (
                <div className="border-2 border-dashed border-stone-300 rounded-xl py-5 text-center bg-stone-50 space-y-3">
                  <p className="text-stone-400 text-[10px]">
                    {lang === 'en' ? 'Take a photo now, or upload one from this device' : 'Piga picha sasa, au pakia moja kutoka kwa kifaa hiki'}
                  </p>
                  <div className="flex items-center justify-center gap-2.5">
                    <button
                      type="button"
                      onClick={startHandoverCamera}
                      className="bg-primary-green hover:bg-primary-hover text-white px-3.5 py-2 rounded-lg text-xs font-bold transition flex items-center gap-1.5"
                    >
                      <Camera size={13} />
                      <span>{lang === 'en' ? 'Take Photo' : 'Piga Picha'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handoverPhotoInputRef.current?.click()}
                      className="bg-white border border-stone-300 hover:bg-stone-50 text-stone-700 px-3.5 py-2 rounded-lg text-xs font-bold transition flex items-center gap-1.5"
                    >
                      <Upload size={13} />
                      <span>{lang === 'en' ? 'Upload File' : 'Pakia Faili'}</span>
                    </button>
                  </div>
                </div>
              )}
              <canvas ref={handoverCanvasRef} className="hidden" />
            </div>
            {authError && (
              <p className="text-red-600 text-xs font-semibold">{authError}</p>
            )}
            <div className="flex justify-end space-x-2 pt-2">
              <button
                onClick={() => { stopHandoverCamera(); setPickupCodeModal(null); setAuthError(''); }}
                className="bg-stone-100 hover:bg-stone-200 text-stone-600 text-xs font-bold px-4 py-2 rounded-xl transition"
              >
                {lang === 'en' ? 'Cancel' : 'Ghairi'}
              </button>
              <button
                onClick={submitConfirmHandover}
                disabled={actionProcessing}
                className="bg-primary-green hover:bg-primary-hover text-white text-xs font-bold px-4 py-2 rounded-xl transition disabled:opacity-50"
              >
                {actionProcessing
                  ? (lang === 'en' ? 'Confirming…' : 'Inathibitisha…')
                  : (lang === 'en' ? 'Confirm & Release Payment' : 'Thibitisha na Toa Malipo')}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
