import React, { useState, useEffect, useRef } from 'react';
import { translations } from '../types';
import ClaimVerificationEvidence from './ClaimVerificationEvidence';
import { getClaimStatusDisplay, agentClaimBadge } from './claimStatus';
import AgentHub from './agent/AgentHub';
import { ShieldCheck, Plus, CheckCircle, PackageOpen, HelpCircle, Loader2, ArrowRight, AlertCircle, Phone, Lock, Eye, Camera, Upload, MapPin, Mail } from 'lucide-react';
import { countiesByUxGroup } from '../config/kenyaCounties';
import { administrativeUnitsForCounty } from '../config/kenyaAdministrativeUnits';
import { detectBrowserLocation, type DetectedLocation } from '../services/browserLocation';
import { useAgentOperations } from '../hooks/useAgentOperations';

interface AgentViewProps {
  lang: 'en' | 'sw';
  token: string | null;
  setToken: (token: string | null) => void;
  /**
   * PHASE 16.1 BATCH 3 (H-1 / M-6) — THE APP-LEVEL CATEGORY SOURCE.
   *
   * AgentView used to keep a SECOND, private copy of the category list: its own
   * mount-only `fetch('/api/categories')` (built in the Phase 9 verification
   * work, before App owned one). That made two independent owners of the same
   * data, and the private copy was never refreshed — so a category an
   * administrator had just created was missing from the verification panel's
   * selector, and one they had just deactivated stayed selectable, until a full
   * page reload.
   *
   * App.fetchCategories (Phase 16.1 Batch 1A) is the single category source:
   * same endpoint, same 4-attempt retry, same loading/error handling, and it is
   * already re-run after every successful admin category mutation via
   * AdminView's `onCategoriesChanged`. AgentView now READS that state instead of
   * fetching its own, so the agent sees exactly the list the rest of the app
   * sees. `/api/categories` remains the only category endpoint — nothing is
   * cached and no second list is introduced.
   */
  categories: any[];
  /**
   * The same App-level refresh callback AdminView receives as
   * `onCategoriesChanged` (NOT a new endpoint or a second fetch definition).
   * AgentView calls it when the Agent opens an item for review, so the
   * selector reflects the catalogue at the moment of use rather than whenever
   * the app last happened to load it. Optional so the component still renders
   * for any caller that only has data to pass.
   */
  refreshCategories?: () => void;
}

/**
 * PHASE 16.1 BATCH 3 (F-4) — TRUTHFUL AGENT-SIDE CLAIM BADGE.
 * Implementation lives in ./claimStatus (neutral module) so the extracted
 * AgentHub can share it without importing this view. Re-exported here so
 * existing import sites keep working.
 */
export { agentClaimBadge } from './claimStatus';

export default function AgentView({ lang, token, setToken, categories, refreshCategories }: AgentViewProps) {
  const t = translations[lang];

  // Auth States
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [showOtp, setShowOtp] = useState(false);

  // AUTHENTICATION errors only — rendered inside the signed-out card below.
  //
  // PHASE 16.1 BATCH 3 (F-1): this value used to be the sink for OPERATIONAL
  // failures too (reject drop-off, confirm viewing, confirm handover, camera
  // denial, and the drop-off code lookup). None of those are authentication
  // problems, and all of them happen while the agent is signed IN — where this
  // branch is not rendered at all, so the agent saw a spinner stop and nothing
  // else. Those failures now go to `operationError` below.
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  // OPERATIONAL (post-sign-in) error channel — see F-1 above.
  const [isRegistering, setIsRegistering] = useState(false);
  const [businessName, setBusinessName] = useState('');
  const [locationAddress, setLocationAddress] = useState('');
  const [agentCounty, setAgentCounty] = useState('');
  const [agentAdministrativeUnitId, setAgentAdministrativeUnitId] = useState('');
  const [agentLatitude, setAgentLatitude] = useState<number | null>(null);
  const [agentLongitude, setAgentLongitude] = useState<number | null>(null);
  const [agentLocationAccuracy, setAgentLocationAccuracy] = useState<number | null>(null);
  const [agentDetectedLocation, setAgentDetectedLocation] = useState<DetectedLocation | null>(null);
  const [agentLocationMessage, setAgentLocationMessage] = useState('');
  const [payoutMethodType, setPayoutMethodType] = useState('Till Number');
  const [tillNumber, setTillNumber] = useState('');
  const [nationalId, setNationalId] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [shopPhotoBase64, setShopPhotoBase64] = useState<string | null>(null);
  const [idDocumentPhotoBase64, setIdDocumentPhotoBase64] = useState<string | null>(null);
  const [agreedTerms, setAgreedTerms] = useState(false);
  // N4 — true only between a successful REGISTRATION and the applicant
  // confirming their email. It drives one informational panel and nothing else:
  // it is never consulted when authorizing anything, because the server does
  // that. Defaulting to false means every other entry path (an existing agent
  // signing in, a grandfathered pre-N4 agent) is unaffected.
  const [awaitingEmailVerification, setAwaitingEmailVerification] = useState(false);

  const {
    agentStatus, queueError, queueLoading, expectedDropoffs, holdingPickups, agentProfile, agentEarnings,
    dropoffCodeInput, setDropoffCodeInput, operationError, setOperationError, actionSuccessMsg,
    actionProcessing, processingItemId, verifyingItemId, setVerifyingItemId, verifyCategoryId,
    setVerifyCategoryId, verifyName, setVerifyName, verifyDocNumber, setVerifyDocNumber,
    verifyDescription, setVerifyDescription, verifyFoundArea, setVerifyFoundArea,
    verifyPhysicallyChecked, setVerifyPhysicallyChecked, verifyReason, setVerifyReason,
    verifyReasonDetail, setVerifyReasonDetail, verifyError, rejectingItemId, setRejectingItemId,
    rejectionReason, setRejectionReason, rejectionCustomText, setRejectionCustomText, confirmModal,
    setConfirmModal, modalBusy, setModalBusy, pickupCodeModal, setPickupCodeModal, useHandoverCamera,
    handoverPhotoInputRef, handoverVideoRef, handoverCanvasRef, dialogRef, retryQueue,
    openVerificationPanel, hasCorrections, handleSubmitVerification, handleLookupDropoff,
    handleRejectDropoff, handleConfirmHandover, handleHandoverPhotoCapture, startHandoverCamera,
    stopHandoverCamera, captureHandoverFrame, submitConfirmHandover, handleConfirmViewing,
  } = useAgentOperations({ token, lang, refreshCategories });

  // PHASE 16.1 BATCH 3 (H-1 / M-6) — the private category list and its
  // mount-only fetch were REMOVED here.
  //
  // They were:
  //   const [categories, setCategories] = useState<any[]>([]);
  //   useEffect(() => {
  //     fetch('/api/categories').then(r => r.json()).then(setCategories).catch(() => {});
  //   }, []);
  //
  // ...i.e. a second owner of data App already owns, fetched once and never
  // refreshed. `categories` now arrives as a PROP from App's single category
  // state, so the verification selector shows exactly the active list the rest
  // of the app uses, and it participates in the existing admin-refresh path
  // (AdminView.onCategoriesChanged → App.fetchCategories) instead of keeping a
  // frozen snapshot.

  // Request login/onboarding OTP
  const handleAuthRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');

    // N4 — the business email is now REQUIRED for a new agent registration, so
    // the guard can no longer be `contactEmail && ...`: that skipped a blank
    // value entirely, which was correct when the field was optional and is a
    // hole now. The trim happens here so "   " is caught by the required arm
    // rather than reaching the regex. This is a client-side convenience only —
    // the backend rejects a missing or malformed address independently, and it
    // is the backend that actually enforces the rule.
    if (isRegistering) {
      const trimmedEmail = contactEmail.trim();
      if (!trimmedEmail) {
        setAuthError('Tafadhali weka barua pepe ya biashara (Please enter your business email address).');
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
        setAuthError('Tafadhali weka barua pepe sahihi (Please enter a valid email address).');
        return;
      }
    }

    setAuthLoading(true);

    try {
      // PHASE 16.1 BATCH 3 (F-3) — the dead `payload` object was REMOVED here.
      //
      // It used to be built as `{ phone, role: 'agent', businessName,
      // locationAddress, tillNumber, nationalId }` for the registration case and
      // then never referenced: this call hard-codes `body: { phone }` below (the
      // OTP request only needs the number). Its presence implied registration
      // data was submitted at request time when it was not.
      //
      // The registration data's REAL submission point is unchanged and still
      // POST /api/auth/verify-otp (handleOtpVerify below), which sends
      // businessName / locationAddress / payoutMethodType / tillNumber /
      // nationalId / termsAccepted / contactEmail / the two base64 images
      // alongside the OTP. The registration API contract, OTP sequencing, rate
      // limiting, validation, pending-agent creation, terms handling and image
      // limits are ALL untouched by this removal.
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

  const countyGroups = countiesByUxGroup();
  const agentUnits = administrativeUnitsForCounty(agentCounty);

  const detectAgentLocation = async () => {
    setAgentLocationMessage('Detecting your location…');
    const result = await detectBrowserLocation();
    if (result.status === 'error') { setAgentLocationMessage(result.message); return; }
    setAgentDetectedLocation(result.location);
    setAgentLocationMessage(result.location.county ? 'Location detected. Confirm or edit the fields below.' : 'Coordinates captured, but the county could not be determined. Enter it manually.');
  };

  const applyDetectedAgentLocation = () => {
    if (!agentDetectedLocation) return;
    setAgentLatitude(agentDetectedLocation.latitude);
    setAgentLongitude(agentDetectedLocation.longitude);
    setAgentLocationAccuracy(agentDetectedLocation.accuracy);
    if (agentDetectedLocation.county) {
      setAgentCounty(agentDetectedLocation.county);
      setAgentAdministrativeUnitId(agentDetectedLocation.subCountyId ?? '');
      if (agentDetectedLocation.place && !locationAddress.trim()) setLocationAddress(agentDetectedLocation.place);
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
          county: agentCounty,
          administrativeUnitId: agentAdministrativeUnitId,
          latitude: agentLatitude,
          longitude: agentLongitude,
          locationAccuracy: agentLocationAccuracy,
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

      // N4 — the backend reports the EMAIL axis separately from the approval
      // axis. When a brand-new applicant still has to verify, we show that
      // state immediately instead of dropping them into the generic "Vetting
      // Pending" screen, which only ever spoke about approval and would leave
      // them with no idea an email was on its way — or that ignoring it leaves
      // them permanently blocked from the Hub.
      //
      // This is a DISPLAY decision only. It grants nothing: the token below is
      // the same phone-ownership proof as before, and every protected agent
      // route still refuses this account until BOTH axes are satisfied.
      setAwaitingEmailVerification(
        data?.profile?.role === 'agent' && data?.profile?.activationRequired === true
      );
      setToken(data.token);
    } catch (e: any) {
      setAuthError(e.message);
    } finally {
      setAuthLoading(false);
    }
  };

  return (
    <div className="w-full fade-in">
      
      {/* 1. NOT LOGGED IN / ONBOARDING VIEW */}
      {!token && (
        <div className="bg-white rounded-2xl border border-stone-100 p-6 md:p-8 shadow-sm max-w-lg mx-auto space-y-6">
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
                className="w-full bg-accent-strong hover:bg-accent-strong-hover text-white py-3.5 rounded-2xl font-bold transition flex items-center justify-center space-x-2"
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
                      placeholder="Enter your business or shop name"
                      className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm"
                      required
                    />
                  </div>

                  <div className="space-y-1">
                    <label htmlFor="agent-county" className="block text-xs font-bold text-primary-green uppercase tracking-wider">Service County *</label>
                    <select id="agent-county" value={agentCounty} onChange={e => { setAgentCounty(e.target.value); setAgentAdministrativeUnitId(''); }} className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm bg-white" required>
                      <option value="">Select county</option>
                      {countyGroups.map(group => <optgroup key={group.group} label={group.group}>{group.counties.map(county => <option key={county.code} value={county.name}>{county.name}</option>)}</optgroup>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="agent-sub-county" className="block text-xs font-bold text-primary-green uppercase tracking-wider">Service Sub-county *</label>
                    <select id="agent-sub-county" value={agentAdministrativeUnitId} onChange={e => setAgentAdministrativeUnitId(e.target.value)} disabled={!agentCounty} className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm bg-white disabled:bg-stone-100" required>
                      <option value="">{agentCounty ? 'Select sub-county' : 'Select county first'}</option>
                      {agentUnits.map(unit => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <button type="button" onClick={detectAgentLocation} className="w-full min-h-11 border border-primary-green rounded-xl px-3 py-2.5 text-sm font-bold text-primary-green inline-flex items-center justify-center gap-2"><MapPin size={16} aria-hidden="true" /> Use my current location</button>
                    {agentLocationMessage && <p className="text-caption text-stone-600" role="status">{agentLocationMessage}</p>}
                    {agentDetectedLocation && <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs space-y-2"><p className="font-bold">Location detected</p>{agentDetectedLocation.county && <p>County: {agentDetectedLocation.county}</p>}{agentDetectedLocation.place && <p>Detected place: {agentDetectedLocation.place}</p>}{agentDetectedLocation.accuracy !== null && <p>GPS accuracy: approximately {Math.round(agentDetectedLocation.accuracy)} metres</p>}<button type="button" onClick={applyDetectedAgentLocation} className="font-bold text-primary-green underline">Use this location</button></div>}
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="agent-location" className="block text-xs font-bold text-primary-green uppercase tracking-wider">Exact operational area *</label>
                    <input
                      id="agent-location"
                      type="text"
                      value={locationAddress}
                      onChange={(e) => setLocationAddress(e.target.value)}
                      placeholder="e.g. Near the main shopping centre"
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
                          placeholder="e.g. Enter your national ID number"
                          className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm font-mono"
                          required
                        />
                      </div>
                    </div>

                    <div className="space-y-1">
                      <label htmlFor="agent-contact-email" className="block text-xs font-bold text-primary-green uppercase tracking-wider">
                        Email Address (Required / Barua Pepe - Inahitajika)
                      </label>
                      <input
                        id="agent-contact-email"
                        type="email"
                        value={contactEmail}
                        onChange={(e) => setContactEmail(e.target.value)}
                        placeholder="e.g. agent@return4me.co.ke"
                        // N4 — required, and `required` is a real HTML constraint,
                        // not decoration: the browser blocks submission before
                        // any network call. The backend independently rejects a
                        // missing or malformed address, so this is a convenience
                        // for the applicant, never the enforcement point.
                        required
                        aria-describedby="agent-contact-email-help"
                        className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm font-sans"
                      />
                      {/* N4 — say WHY it is required. An applicant who does not
                          know the address will be emailed and verified cannot
                          act on the platform, so a bare "required" would read as
                          arbitrary. */}
                      <p id="agent-contact-email-help" className="text-[11px] text-stone-500 leading-relaxed">
                        {t.agentEmailHelp}
                      </p>
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
                        <p className="text-[11px] text-emerald-600 font-semibold">Picha ya duka imepakiwa (Shop photo selected)</p>
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
                        <p className="text-[11px] text-emerald-600 font-semibold">Picha ya kitambulisho imepakiwa (ID photo selected)</p>
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

      {/* 2. QUEUE LOADING — the pre-answer state.
          PHASE 16.1 BATCH 3 (F-5 / H-3): the very first paint must not claim a
          vetting state before the server has actually answered. */}
      {token && queueLoading && !agentProfile && !queueError && (
        <div className="bg-white rounded-2xl border border-stone-100 p-8 shadow-sm max-w-md mx-auto text-center space-y-4 fade-in">
          <Loader2 className="animate-spin text-primary-green mx-auto" size={28} aria-hidden={true} />
          <p className="text-stone-600 text-sm font-semibold" role="status" aria-live="polite">
            {lang === 'en' ? 'Loading your agent hub…' : 'Inapakia ukurasa wako wa wakala…'}
          </p>
        </div>
      )}

      {/* 2b. QUEUE REQUEST FAILURE — TRUTHFUL, AND NEVER A VETTING CLAIM.
          PHASE 16.1 BATCH 3 (F-5 / H-3). This replaces the old behaviour where
          ANY failed queue request rendered the "Vetting Pending" screen.

          The server's own explanation is shown when it supplied one: both guards
          on /api/agents/queue answer with deliberate, user-facing bilingual copy,
          so an agent whose application really is still under review reads that
          ("Akaunti yako ya Agent bado haijaidhinishwa au imesitishwa."), and an
          agent whose session merely expired reads THAT instead — rather than
          both being told their account status changed when it may not have.
          Nothing here asserts, grants or withholds any status: the server stays
          the sole authority. */}
      {token && !queueLoading && queueError && !agentProfile && (
        <div className="bg-white rounded-2xl border border-stone-100 p-8 shadow-sm max-w-md mx-auto text-center space-y-5 fade-in">
          <div className="w-16 h-16 bg-red-50 text-red-600 rounded-full flex items-center justify-center mx-auto">
            <AlertCircle size={32} aria-hidden={true} />
          </div>
          <div className="space-y-2">
            <h2 className="text-2xl font-extrabold text-primary-green">
              {lang === 'en' ? 'Agent Hub unavailable' : 'Ukurasa wa Wakala Haupatikani'}
            </h2>
            <p className="text-stone-600 text-sm font-semibold" role="alert" aria-live="assertive">
              {queueError}
            </p>
          </div>
          <button
            type="button"
            onClick={retryQueue}
            disabled={queueLoading}
            aria-busy={queueLoading}
            className="w-full bg-primary-green hover:bg-primary-hover text-white py-3 rounded-2xl font-bold transition flex items-center justify-center space-x-2 disabled:opacity-50"
          >
            {queueLoading
              ? <Loader2 className="animate-spin" size={18} aria-hidden={true} />
              : <span>{lang === 'en' ? 'Try again' : 'Jaribu tena'}</span>}
          </button>
        </div>
      )}

      {/* 3. PENDING EMAIL VERIFICATION (N4).
          Shown immediately after a successful registration, BEFORE the generic
          "Vetting Pending" panel, because the two states need different
          instructions: this one is resolved by the applicant (open the email,
          click the link) and that one is resolved by an administrator.

          It deliberately states BOTH requirements. An applicant who verifies
          their email but is still unapproved will be blocked from the Hub, and
          an applicant who is approved but never verified will be blocked too —
          so saying only one of the two would set an expectation the system
          cannot meet. It is informational only: no agent data is rendered and
          no action is offered, so there is nothing here to authorize. */}
      {token && awaitingEmailVerification && (
        <div className="bg-white rounded-2xl border border-stone-100 p-8 shadow-sm max-w-md mx-auto text-center space-y-5 fade-in">
          <div className="w-16 h-16 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center mx-auto">
            <Mail size={32} aria-hidden={true} />
          </div>
          <div>
            <h2 className="text-2xl font-extrabold text-primary-green">
              {lang === 'sw' ? 'Thibitisha Barua Pepe Yako' : 'Verify Your Email'}
            </h2>
            <p className="text-stone-600 text-sm mt-2 font-semibold leading-relaxed">
              {lang === 'sw'
                ? 'Tumetumia kiungo cha uthibitishaji kwenye barua pepe uliyoandika. Fungua barua pepe hiyo kwenye kifaa hiki na bonyeza kiungo kilichomo.'
                : 'We sent a verification link to the business email you provided. Open that email on this device and click the link in it.'}
            </p>
          </div>
          {/* role="status" announces the change of screen to assistive tech. The
              outcome is never signalled by the blue icon alone — the heading and
              the body text both change. */}
          <div role="status" className="bg-brand-beige border border-stone-200 p-4 rounded-xl text-left text-xs text-stone-600 space-y-1.5 leading-tight">
            {lang === 'sw' ? (
              <>
                <span className="font-bold block mb-1">Kuna hatua mbili:</span>
                <span>1. Thibitisha barua pepe yako kwa kiungo tuliotuma</span>
                <span>2. Msimamizi akapitisha maombi yako kabla ya kuanza kazi</span>
                <span className="block pt-1">Hutapewa taarifa kupitia barua pepe.</span>
              </>
            ) : (
              <>
                <span className="font-bold block mb-1">There are two separate steps:</span>
                <span>1. Verify your email using the link we sent you</span>
                <span>2. An administrator approves your application before you can start work</span>
                <span className="block pt-1">You will be notified by email once that is complete.</span>
              </>
            )}
          </div>
        </div>
      )}

      {/* 4. PENDING APPROVAL VIEW.
          Retained, but NO LONGER reachable by a failed request — only by the
          brief window before the server has answered, or by a future server
          response that states a non-active agent positively. */}
      {token && agentStatus === 'pending' && !queueError && !queueLoading && !awaitingEmailVerification && (
        <div className="bg-white rounded-2xl border border-stone-100 p-8 shadow-sm max-w-md mx-auto text-center space-y-5 fade-in">
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

      {/* 4. ACTIVE AGENT HUB VIEW — PHASE 16.1 BATCH 4 structural extraction.
          AgentView owns ALL hub state and callbacks; the Hub JSX itself lives
          in components/agent/AgentHub.tsx (single authoritative copy). */}
      {token && agentStatus === 'active' && agentProfile && (
        <AgentHub
          lang={lang}
          t={t}
          agentProfile={agentProfile}
          agentEarnings={agentEarnings}
          actionSuccessMsg={actionSuccessMsg}
          operationError={operationError}
          setOperationError={setOperationError}
          queueError={queueError}
          queueLoading={queueLoading}
          retryQueue={retryQueue}
          expectedDropoffs={expectedDropoffs}
          dropoffCodeInput={dropoffCodeInput}
          setDropoffCodeInput={setDropoffCodeInput}
          actionProcessing={actionProcessing}
          processingItemId={processingItemId}
          handleLookupDropoff={handleLookupDropoff}
          verifyingItemId={verifyingItemId}
          setVerifyingItemId={setVerifyingItemId}
          openVerificationPanel={openVerificationPanel}
          verifyCategoryId={verifyCategoryId}
          setVerifyCategoryId={setVerifyCategoryId}
          verifyName={verifyName}
          setVerifyName={setVerifyName}
          verifyDocNumber={verifyDocNumber}
          setVerifyDocNumber={setVerifyDocNumber}
          verifyDescription={verifyDescription}
          setVerifyDescription={setVerifyDescription}
          verifyFoundArea={verifyFoundArea}
          setVerifyFoundArea={setVerifyFoundArea}
          verifyPhysicallyChecked={verifyPhysicallyChecked}
          setVerifyPhysicallyChecked={setVerifyPhysicallyChecked}
          verifyReason={verifyReason}
          setVerifyReason={setVerifyReason}
          verifyReasonDetail={verifyReasonDetail}
          setVerifyReasonDetail={setVerifyReasonDetail}
          verifyError={verifyError}
          hasCorrections={hasCorrections}
          handleSubmitVerification={handleSubmitVerification}
          rejectingItemId={rejectingItemId}
          setRejectingItemId={setRejectingItemId}
          rejectionReason={rejectionReason}
          setRejectionReason={setRejectionReason}
          rejectionCustomText={rejectionCustomText}
          setRejectionCustomText={setRejectionCustomText}
          handleRejectDropoff={handleRejectDropoff}
          handleConfirmHandover={handleConfirmHandover}
          handleConfirmViewing={handleConfirmViewing}
          categories={categories}
          holdingPickups={holdingPickups}
        />
      )}

      {/* Custom Confirmation Modal.
          PHASE 16.1 BATCH 3 (A-8): real dialog semantics — role, aria-modal,
          an accessible name via aria-labelledby, a focusable container the
          shared effect focuses on open, and focus restoration on close. Escape
          handling lives in that same effect.
          PHASE 16.1 BATCH 3 (F-6): the Confirm button now AWAITS the action and
          closes the dialog only when it reports success, so a failure no longer
          makes the dialog disappear before the agent can read why. */}
      {confirmModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-stone-900/60 fade-in">
          <div
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="agent-confirm-modal-title"
            className="bg-white border border-stone-200 rounded-2xl p-6 shadow-sm max-w-sm w-full space-y-4 fade-in outline-none"
          >
            <div className="flex items-start space-x-3 text-amber-600">
              <CheckCircle className="w-6 h-6 shrink-0 mt-0.5 animate-pulse" aria-hidden={true} />
              <div className="space-y-1">
                <h3 id="agent-confirm-modal-title" className="font-extrabold text-sm text-stone-900 uppercase tracking-wider">
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
                disabled={modalBusy}
                className="bg-stone-100 hover:bg-stone-200 text-stone-600 text-xs font-bold px-4 py-2 rounded-xl transition disabled:opacity-50"
              >
                {lang === 'en' ? 'Cancel' : 'Ghairi'}
              </button>
              <button
                disabled={modalBusy}
                aria-busy={modalBusy}
                onClick={async () => {
                  // UX guard against a double-click. The AUTHORITATIVE
                  // duplicate-submission protection remains the server-side
                  // compare-and-swap in transitionClaimStatus (409 on a lost
                  // race) — this only stops the second click from being sent.
                  if (modalBusy) return;
                  setModalBusy(true);
                  try {
                    const ok = await confirmModal.onConfirm();
                    // Close ONLY on success. On failure the dialog stays open so
                    // the Hub's operational error channel can explain what
                    // happened while the agent still has the action in view.
                    if (ok) setConfirmModal(null);
                  } finally {
                    setModalBusy(false);
                  }
                }}
                className="bg-primary-green hover:bg-primary-hover text-white text-xs font-bold px-4 py-2 rounded-xl transition flex items-center space-x-1.5 disabled:opacity-50"
              >
                {modalBusy ? <Loader2 className="animate-spin" size={12} aria-hidden={true} /> : null}
                <span>{lang === 'en' ? 'Confirm' : 'Thibitisha'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Handover Pickup Code Modal.
          PHASE 16.1 BATCH 3 (A-8): dialog semantics + focus, via the same
          shared effect the confirmation modal uses (no third modal primitive). */}
      {pickupCodeModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-stone-900/60 fade-in">
          <div
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="agent-handover-modal-title"
            className="bg-white border border-stone-200 rounded-2xl p-6 shadow-sm max-w-sm w-full space-y-4 fade-in outline-none"
          >
            <div className="flex items-start space-x-3 text-amber-600">
              <CheckCircle className="w-6 h-6 shrink-0 mt-0.5" aria-hidden={true} />
              <div className="space-y-1">
                <h3 id="agent-handover-modal-title" className="font-extrabold text-sm text-stone-900 uppercase tracking-wider">
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
                  {/* PHASE 16.1 BATCH 3 (A-7) — the live preview had no
                      accessible name, so assistive technology announced an
                      unnamed media element. Capture behaviour is unchanged; only
                      the name was added. */}
                  <video
                    ref={handoverVideoRef}
                    aria-label={lang === 'en'
                      ? 'Live camera preview of the claimant with the item'
                      : 'Kamera ya moja kwa moja ya mdai akiwa na bidhaa'}
                    className="w-full h-full object-cover"
                  />
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
                      aria-label={lang === 'en' ? 'Retake with camera' : 'Piga tena kwa kamera'}
                    >
                      <Camera size={16} />
                    </button>
                    <button
                      type="button"
                      onClick={() => handoverPhotoInputRef.current?.click()}
                      className="bg-white text-primary-green p-2.5 rounded-full hover:bg-stone-100 shadow-md transition"
                      title={lang === 'en' ? 'Upload a different photo' : 'Pakia picha nyingine'}
                      aria-label={lang === 'en' ? 'Upload a different photo' : 'Pakia picha nyingine'}
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
            {/* PHASE 16.1 BATCH 3 (F-1) — the modal now shows OPERATIONAL
                failures (a wrong/absent owner pickup code, a missing photo, a
                failed upload), which is where the agent is actually looking when
                the action fails. This used to read `authError`, which no
                operational failure writes any more.

                Deliberately NOT a live region: the Hub's `role="alert"` channel
                above already announces this exact text, and two assertive
                regions carrying the same message would announce it twice. This
                is the visual placement, not a second announcement. */}
            {operationError && (
              <p className="text-red-600 text-xs font-semibold">{operationError}</p>
            )}
            <div className="flex justify-end space-x-2 pt-2">
              <button
                onClick={() => { stopHandoverCamera(); setPickupCodeModal(null); setOperationError(''); }}
                disabled={actionProcessing}
                className="bg-stone-100 hover:bg-stone-200 text-stone-600 text-xs font-bold px-4 py-2 rounded-xl transition disabled:opacity-50"
              >
                {lang === 'en' ? 'Cancel' : 'Ghairi'}
              </button>
              <button
                onClick={submitConfirmHandover}
                disabled={actionProcessing}
                aria-busy={actionProcessing}
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
