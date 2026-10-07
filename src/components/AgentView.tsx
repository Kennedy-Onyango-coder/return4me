import React, { useState, useEffect, useRef } from 'react';
import { translations } from '../types';
import ClaimVerificationEvidence from './ClaimVerificationEvidence';
import { getClaimStatusDisplay, agentClaimBadge } from './claimStatus';
import AgentHub from './agent/AgentHub';
import { ShieldCheck, Plus, CheckCircle, PackageOpen, HelpCircle, Loader2, AlertCircle, Lock, Eye, Camera, Upload, MapPin, Mail } from 'lucide-react';
import { countiesByUxGroup } from '../config/kenyaCounties';
import { administrativeUnitsForCounty } from '../config/kenyaAdministrativeUnits';
import { detectBrowserLocation, hasGeographyConflict, type DetectedLocation } from '../services/browserLocation';
import { useAgentOperations } from '../hooks/useAgentOperations';
import { Banner, Button, ICON_SIZE, Input } from './ui';
import Skeleton from './ui/Skeleton';

// UX-12 imports the two shared primitives the registration steps need, by the
// same direct path AdminView, OwnerView and BecomeAgentView already use.
import Select from './ui/Select';
import Stepper from './ui/Stepper';

interface AgentViewProps {
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

/**
 * UX-12 — THE AGENT APPLICATION, AS A GUIDED SEQUENCE.
 *
 * The five steps of an agent application, in the order the applicant works
 * through them, in both languages. `description` is used by nothing here; the
 * rail renders a short label per step and the panel explains the current one.
 *
 * This is PRESENTATION data. It changes neither what is collected nor what is
 * sent: each step renders fields the single submit already carried, and the
 * same request still carries them.
 */
const AGENT_REGISTRATION_STEPS = [
  { en: 'Account' },
  { en: 'Location' },
  { en: 'Verification' },
  { en: 'Payout' },
  { en: 'Review' },
] as const;

export default function AgentView({ token, setToken, categories, refreshCategories }: AgentViewProps) {
  const t = translations.en;

  /**
   * UX-11 — the agent sign-in copy, in both languages. The same `t(en, sw)`
   * shape the Sign In chooser (UX-07) and the public agent page (UX-10) use, so
   * a string introduced by the sign-in refinement can never ship English-only.
   */


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
  // UX-12 — which step of the guided application is open. Presentation state
  // only: it selects which of the SAME registration fields are rendered, and it
  // never influences what is sent, when, or to which endpoint.
  const [registrationStep, setRegistrationStep] = useState(0);

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
  } = useAgentOperations({ token, refreshCategories });

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

    // UX-12 — THE GUIDED STEPS.
    //
    // While the applicant is still working through the application, this same
    // form submit advances one step and returns WITHOUT touching the network.
    // Only Review falls through to the request below, so the request itself is
    // unchanged: the same endpoint, the same body, the same OTP sequencing, the
    // same failures. No second submission path exists, and the submit button's
    // loading guard still prevents a duplicate dispatch in flight.
    if (isRegistering && registrationStep < AGENT_REGISTRATION_STEPS.length - 1) {
      setRegistrationStep((step) => Math.min(step + 1, AGENT_REGISTRATION_STEPS.length - 1));
      return;
    }

    setAuthLoading(true);

    try {
      // PHASE 16.1 BATCH 3 (F-3) — the dead `payload` object was REMOVED here.
      //
      // It used to be built as `{ phone, role: 'agent', businessName,
      // locationAddress, tillNumber, nationalId }` for the registration case and
      // then never referenced: this call sent only `{ phone }` (the OTP request
      // only needs the number). Its presence implied registration data was
      // submitted at request time when it was not.
      //
      // E1 — NEW-AGENT ONBOARDING EMAIL. A BRAND-NEW agent's one-time code is
      // emailed to the business address typed on the onboarding step, so the
      // request must carry that address: the server resolves the OTP recipient
      // for onboarding from `req.body.email` (an existing agent's recipient is
      // always resolved server-side from the verified contact_email and a
      // request-supplied address can never override it). Sign-in therefore stays
      // phone-only, and the onboarding email is added ONLY for the registration
      // arm of this single, shared call — no second request path and no new
      // storage are introduced.
      //
      // The registration data's REAL submission point is unchanged and still
      // POST /api/auth/verify-otp (handleOtpVerify below), which sends
      // businessName / locationAddress / payoutMethodType / tillNumber /
      // nationalId / termsAccepted / contactEmail / the two base64 images
      // alongside the OTP. The registration API contract, OTP sequencing, rate
      // limiting, validation, pending-agent creation, terms handling and image
      // limits are ALL untouched by this change.
      const response = await fetch('/api/auth/request-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isRegistering ? { phone, email: contactEmail.trim() } : { phone }),
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
    setAgentLocationMessage(
      result.location.county
        ? 'Location detected. Confirm or edit the fields below.'
        : 'Coordinates captured, but the county could not be determined. Enter it manually.'
    );
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

  const registrationSteps = AGENT_REGISTRATION_STEPS.map((s) => ({ label: s.en }));
  const isRegistrationReview = registrationStep === AGENT_REGISTRATION_STEPS.length - 1;
  /** The sub-county NAME for the review; the id the select holds is not shown. */
  const agentAdministrativeUnitName =
    agentUnits.find((unit) => unit.id === agentAdministrativeUnitId)?.name ?? '';

  /**
   * One review row: the label the applicant filled in, and the value.
   *
   * Only what the applicant typed is echoed, and only where it is safe to echo.
   * The identifiers an administrator must see but a bystander must not (the
   * national ID, the payout code) are reported as provided or not provided
   * instead of being printed — the same rule the lost-report review already
   * follows on this platform.
   */
  const reviewRow = (label: string, value: string) => (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-caption font-bold text-[var(--appearance-text-muted)]">{label}</dt>
      <dd className="text-body font-bold text-right text-[var(--appearance-text-primary)]">{value || '—'}</dd>
    </div>
  );

  /** One review group, with the way back to the step it came from. */
  const reviewGroup = (title: string, step: number, rows: React.ReactNode) => (
    <div className="rounded-standard border border-[var(--appearance-border)] p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-body-large font-extrabold text-[var(--appearance-text-primary)]">{title}</h3>
        <Button type="button" variant="ghost" size="sm" onClick={() => setRegistrationStep(step)}>
          {'Change'}
        </Button>
      </div>
      <dl className="mt-3 space-y-2">{rows}</dl>
    </div>
  );

  /**
   * UX-12 — THE GUIDED APPLICATION PANEL.
   *
   * The registration fields used to arrive as one wall of inputs inside the
   * sign-in card. They are the SAME fields, inside the SAME single form, carried
   * by the SAME single submit: what changed is that only the open step's fields
   * are on screen, each step says what it needs and why, and Review gathers the
   * same values with a way back to every group.
   *
   * This panel owns no business logic. It calls no endpoint, decides nothing
   * about eligibility, approval, verification or payout, and renders no value
   * the applicant did not enter. The phone field belongs to the Account step and
   * stays in the form below it (it is shared with sign-in), so this panel is the
   * steps themselves.
   */
  const registrationPanel = (
    <div className="space-y-5 fade-in">
      <Stepper
        steps={registrationSteps}
        currentStep={registrationStep}
        label={'Agent application progress'}
      />

      {/* One polite announcement per step, for assistive tech that does not
          track the rail's aria-current. */}
      <p className="sr-only" role="status" aria-live="polite">
        {'Step'} {registrationStep + 1} {'of'}{' '}
        {AGENT_REGISTRATION_STEPS.length}: {registrationSteps[registrationStep].label}
      </p>

      {/* 1. ACCOUNT */}
      {registrationStep === 0 && (
        <section className="space-y-4">
          <h2 className="text-heading font-extrabold text-[var(--appearance-text-primary)]">
            {'Your account and your business'}
          </h2>
          <p className="text-body leading-relaxed text-[var(--appearance-text-muted)]">
            {'The account is opened in your business name. We email a verification link to the address you give below, and you must open that link before you can use the Agent Hub. The phone number is what identifies your account; no code is sent by text message.'}
          </p>
          <Input
            id="agent-business-name"
            label={t.businessName}
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            placeholder={'Enter your business or shop name'}
            required
          />
          <Input
            id="agent-contact-email"
            label="Email Address (Required / Barua Pepe - Inahitajika)"
            type="email"
            required
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            placeholder="agent@return4me.co.ke"
            hint={t.agentEmailHelp}
          />
        </section>
      )}
      {/* 2. LOCATION */}
      {registrationStep === 1 && (
        <section className="space-y-4">
          <h2 className="text-heading font-extrabold text-[var(--appearance-text-primary)]">
            {'Where you will work'}
          </h2>
          <p className="text-body leading-relaxed text-[var(--appearance-text-muted)]">
            {'Owners pick a county and sub-county when they hand an item in, so this is how your collection point is shown to the people nearest it.'}
          </p>
          <Select
            id="agent-county"
            label={'Service county'}
            required
            value={agentCounty}
            onChange={(e) => {
              setAgentCounty(e.target.value);
              setAgentAdministrativeUnitId('');
            }}
          >
            <option value="">{'Select county'}</option>
            {countyGroups.map((group) => (
              <optgroup key={group.group} label={group.group}>
                {group.counties.map((county) => (
                  <option key={county.code} value={county.name}>{county.name}</option>
                ))}
              </optgroup>
            ))}
          </Select>
          <Select
            id="agent-sub-county"
            label={'Service sub-county'}
            required
            value={agentAdministrativeUnitId}
            onChange={(e) => setAgentAdministrativeUnitId(e.target.value)}
            disabled={!agentCounty}
            hint={'Choose the county first.'}
          >
            <option value="">
              {agentCounty
                ? 'Select sub-county'
                : 'Select county first'}
            </option>
            {agentUnits.map((unit) => (
              <option key={unit.id} value={unit.id}>{unit.name}</option>
            ))}
          </Select>

          <div className="space-y-2">
            <Button type="button" variant="outline" size="md" className="w-full" onClick={detectAgentLocation}>
              <MapPin size={ICON_SIZE.ui} aria-hidden="true" />
              {'Use my current location'}
            </Button>
            {agentLocationMessage && (
              <p role="status" className="text-caption text-[var(--appearance-text-muted)]">{agentLocationMessage}</p>
            )}
            {agentDetectedLocation && (
              <div className="space-y-2 rounded-standard border border-[var(--appearance-border)] bg-[var(--appearance-surface-muted)] p-3">
                <p className="text-body font-bold text-[var(--appearance-text-primary)]">
                  {'Location detected'}
                </p>
                {agentDetectedLocation.county && (
                  <p className="text-caption text-[var(--appearance-text-secondary)]">
                    {'County'}: {agentDetectedLocation.county}
                  </p>
                )}
                {agentDetectedLocation.place && (
                  <p className="text-caption text-[var(--appearance-text-secondary)]">
                    {'Nearest place'}: {agentDetectedLocation.place}
                  </p>
                )}
                {agentDetectedLocation.accuracy !== null && (
                  <p className="text-caption text-[var(--appearance-text-secondary)]">
                    {'GPS accuracy'}: ±{Math.round(agentDetectedLocation.accuracy)} {'metres'}
                  </p>
                )}
                {agentDetectedLocation.accuracyTier !== 'strong' && (
                  <p className="text-caption text-[var(--appearance-text-secondary)]">
                    {agentDetectedLocation.accuracyTier === 'unknown'
                      ? 'Location accuracy is not available. Treat this as an approximate suggestion.'
                      : 'Location accuracy is low. Treat this as an approximate suggestion.'}
                  </p>
                )}
                {hasGeographyConflict(agentCounty, agentDetectedLocation.county) && (
                  <p className="text-caption text-[var(--appearance-text-secondary)]">
                    {'Your selected service area differs from the detected area. Using this location will replace your selection.'}{' '}
                    <strong>{agentCounty} → {agentDetectedLocation.county}</strong>
                  </p>
                )}
                <Button type="button" variant="secondary" size="md" className="w-full" onClick={applyDetectedAgentLocation}>
                  {'Use this location'}
                </Button>
              </div>
            )}
          </div>

          <Input
            id="agent-location"
            label={'Exact operational area'}
            value={locationAddress}
            onChange={(e) => setLocationAddress(e.target.value)}
            placeholder={'e.g. Near the main shopping centre'}
            required
            hint={'The spot an owner walks to. A landmark helps more than a street name.'}
          />
        </section>
      )}
      {/* 3. VERIFICATION */}
      {registrationStep === 2 && (
        <section className="space-y-4">
          <h2 className="text-heading font-extrabold text-[var(--appearance-text-primary)]">
            {'Prove who you are'}
          </h2>
          <p className="text-body leading-relaxed text-[var(--appearance-text-muted)]">
            {'An administrator checks these details before your application can be approved. Nothing you enter here is shown to owners or customers.'}
          </p>
          <Input
            id="agent-national-id"
            label={t.nationalId}
            value={nationalId}
            onChange={(e) => setNationalId(e.target.value)}
            placeholder={'e.g. Enter your national ID number'}
            required
          />

          <div className="space-y-2">
            <label htmlFor="agent-shop-photo" className="block text-caption font-bold text-[var(--appearance-text-primary)]">
              {'Business or shop front photo'}
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
              className="block min-h-11 w-full cursor-pointer text-caption text-[var(--appearance-text-muted)] file:mr-3 file:cursor-pointer file:rounded-small file:border-0 file:bg-[var(--appearance-surface-muted)] file:px-3 file:py-2 file:text-caption file:font-bold file:text-[var(--appearance-primary)]"
            />
            {shopPhotoBase64 && (
              <p role="status" className="text-caption font-bold text-[var(--appearance-success)]">
                {'Shop photo selected'}
              </p>
            )}
            <p className="text-caption text-[var(--appearance-text-muted)]">
              {'Optional. Up to 5MB.'}
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="agent-id-document-photo" className="block text-caption font-bold text-[var(--appearance-text-primary)]">
              {'Agent ID document photo'}
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
              className="block min-h-11 w-full cursor-pointer text-caption text-[var(--appearance-text-muted)] file:mr-3 file:cursor-pointer file:rounded-small file:border-0 file:bg-[var(--appearance-surface-muted)] file:px-3 file:py-2 file:text-caption file:font-bold file:text-[var(--appearance-primary)]"
            />
            {idDocumentPhotoBase64 && (
              <p role="status" className="text-caption font-bold text-[var(--appearance-success)]">
                {'ID photo selected'}
              </p>
            )}
            <p className="text-caption text-[var(--appearance-text-muted)]">
              {'Optional. Up to 5MB. Kept private.'}
            </p>
          </div>
        </section>
      )}
      {/* 4. PAYOUT */}
      {registrationStep === 3 && (
        <section className="space-y-4">
          <h2 className="text-heading font-extrabold text-[var(--appearance-text-primary)]">
            {'Where your share is sent'}
          </h2>
          <p className="text-body leading-relaxed text-[var(--appearance-text-muted)]">
            {'Your share of the service fee is paid to this M-Pesa account. Enter the details exactly as they appear in M-Pesa so the payment reaches you.'}
          </p>
          <Select
            id="agent-payout-method"
            label={'Payout method'}
            required
            value={payoutMethodType}
            onChange={(e) => setPayoutMethodType(e.target.value)}
          >
            <option value="Till Number">Till Number (M-Pesa Buy Goods)</option>
            <option value="Paybill Number">Paybill Number</option>
            <option value="Pochi la Biashara">Pochi la Biashara</option>
            <option value="Personal M-Pesa">Personal M-Pesa (Send Money)</option>
          </Select>
          <Input
            id="agent-till-number"
            label={'Payout code or number'}
            value={tillNumber}
            onChange={(e) => setTillNumber(e.target.value)}
            placeholder="Till / Paybill / Phone"
            required
            hint={'The number the money is sent to. Please check it twice.'}
          />
        </section>
      )}
      {/* 5. REVIEW */}
      {registrationStep === 4 && (
        <section className="space-y-4">
          <h2 className="text-heading font-extrabold text-[var(--appearance-text-primary)]">
            {'Check your application'}
          </h2>
          <p className="text-body leading-relaxed text-[var(--appearance-text-muted)]">
            {'This is what we received. Open any group to change it, then submit your application.'}
          </p>

          {reviewGroup('Account', 0, (
            <>
              {reviewRow(t.businessName, businessName)}
              {reviewRow('Phone number', phone)}
              {reviewRow('Email address', contactEmail)}
            </>
          ))}

          {reviewGroup('Location', 1, (
            <>
              {reviewRow('Service county', agentCounty)}
              {reviewRow('Service sub-county', agentAdministrativeUnitName)}
              {reviewRow('Exact operational area', locationAddress)}
            </>
          ))}

          {reviewGroup('Verification', 2, (
            <>
              {reviewRow(t.nationalId, nationalId ? 'Provided' : 'Not provided')}
              {reviewRow(
                'Business or shop front photo',
                shopPhotoBase64 ? 'Provided' : 'Not provided'
              )}
              {reviewRow(
                'Agent ID document photo',
                idDocumentPhotoBase64 ? 'Provided' : 'Not provided'
              )}
            </>
          ))}

          {reviewGroup('Payout', 3, (
            <>
              {reviewRow('Payout method', payoutMethodType)}
              {reviewRow(
                'Payout code or number',
                tillNumber ? 'Provided' : 'Not provided'
              )}
            </>
          ))}
        </section>
      )}

      {/* The secondary action of every step but the first. The dominant action is
          the form's single submit below the panel, so no step carries two. */}
      {registrationStep > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="lg"
          className="w-full"
          onClick={() => setRegistrationStep((step) => Math.max(0, step - 1))}
        >
          {'Back'}
        </Button>
      )}
    </div>
  );

  return (
    <div className="w-full fade-in">
      
      {/* 1. AGENT SIGN-IN CARD (refined in UX-11).
          One focused, single-column authentication surface: who it is for, the
          mode switch, the two credential steps, one dominant action, and the
          restrained route for somebody who is not an Agent yet.
          PRESENTATION ONLY — the endpoints, payloads, token handling, validation,
          rate limiting and error semantics below are untouched. */}
      {!token && (
        <div className="mx-auto w-full max-w-md space-y-6 rounded-panel border border-[var(--appearance-border)] bg-[var(--appearance-surface)] p-6 shadow-raised sm:p-8">
          {/* UX-11 · A — identity: this is the Agent door, said plainly. */}
          <div className="space-y-3 text-center">
            <span className="mx-auto inline-flex h-11 w-11 items-center justify-center rounded-standard bg-[var(--appearance-surface-muted)] text-[var(--appearance-primary)]">
              <ShieldCheck size={ICON_SIZE.heading} aria-hidden="true" />
            </span>
            <h1 className="text-section font-extrabold tracking-tight text-[var(--appearance-text-primary)] sm:text-page">
              {showOtp
                ? 'Confirm your code'
                : isRegistering
                  ? t.agentTitle
                  : 'Agent sign in'}
            </h1>
            <p className="mx-auto max-w-sm text-body leading-relaxed text-[var(--appearance-text-muted)]">
              {showOtp
                ? 'Enter the one-time code we sent to your verified email address.'
                : isRegistering
                  ? t.agentSubtitle
                  : 'This page is for approved Return4me Agents. Sign in with the phone number you registered with us.'}
            </p>
          </div>

          {/* UX-11 · D — authentication feedback. The existing error semantics in
              ONE live region: the message never says whether the number exists,
              whether a code was correct, or what internal state an account is in. */}
          {authError && (
            <Banner kind="error">
              <span>{authError}</span>
            </Banner>
          )}

          {/* UX-11 · B/C — the credential step, then the one-time-code step. */}
          {showOtp ? (
            <form onSubmit={handleOtpVerify} className="space-y-4" aria-busy={authLoading || undefined}>

              <Input
                id="agent-otp"
                label={'Verification code'}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                maxLength={4}
                placeholder="••••"
                required
                disabled={authLoading}
                hint={'The code is emailed to the verified email address on your account, not to this number.'}
              />
              <Button type="submit" variant="primary" size="lg" loading={authLoading} className="w-full">
                {authLoading
                  ? 'Verifying…'
                  : 'Verify and continue'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="md"
                className="w-full"
                onClick={() => { setShowOtp(false); setOtp(''); setAuthError(''); }}
              >
                {'Use a different number'}
              </Button>
            </form>
          ) : (
            /* Request OTP / Register form */
            <form onSubmit={handleAuthRequest} className="space-y-4" aria-busy={authLoading || undefined}>
              
              {/* UX-11 · B — the two access modes. Same two modes, same handlers
                  and the same literal labels as before; only the presentation and
                  the pressed-state semantics moved onto the shared tokens, and the
                  target is now 44px. */}
              <div
                role="group"
                aria-label={'Agent access'}
                className="grid grid-cols-2 gap-1 rounded-standard border border-[var(--appearance-border)] bg-[var(--appearance-surface-muted)] p-1"
              >
                <button
                  type="button"
                  aria-pressed={!isRegistering}
                  onClick={() => setIsRegistering(false)}
                  className={`min-h-11 rounded-small px-3 text-body font-bold transition-colors ${!isRegistering ? 'bg-[var(--appearance-surface)] text-[var(--appearance-primary)] shadow-raised' : 'text-[var(--appearance-text-muted)] hover:text-[var(--appearance-text-primary)]'}`}
                >
                  {'Agent Login'}
                </button>
                <button
                  type="button"
                  aria-pressed={isRegistering}
                  onClick={() => setIsRegistering(true)}
                  className={`min-h-11 rounded-small px-3 text-body font-bold transition-colors ${isRegistering ? 'bg-[var(--appearance-surface)] text-[var(--appearance-primary)] shadow-raised' : 'text-[var(--appearance-text-muted)] hover:text-[var(--appearance-text-primary)]'}`}
                >
                  {'Apply to be Agent'}
                </button>
              </div>

              {/* UX-12 — the guided application replaces this one wall of fields.
                  Same fields, same required attributes, same single submit; the
                  panel above the card renders only the open step's controls. */}
              {isRegistering && (
                registrationPanel
              )}

              {/* UX-12 · B — the phone field belongs to the Account step. It is the
                  shared credential: the same `Input`, the same state, the same
                  hint and the same payload field. It stays in the form (not in
                  the panel) because sign-in uses it too, and it is shown for the
                  Account step only, so a later step never shows a control that
                  belongs to an earlier one. */}
              {(!isRegistering || registrationStep === 0) && (
                <Input
                  id="agent-phone"
                  label={'Phone number'}
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="0712345678"
                  required
                  disabled={authLoading}
                  hint={isRegistering
                    ? 'This number identifies your account. The verification link is emailed to the address above.'
                    : 'Use the number you registered with us.'}
                />
              )}

              {/* UX-12 · C — consent belongs with the final review, so it is shown
                  there and nowhere else. Same checkbox, same state, same payload
                  field, same two existing navigation handles. */}
              {isRegistering && (
                isRegistrationReview ? (
                  <div className="flex items-start gap-3 rounded-standard border border-[var(--appearance-border)] bg-[var(--appearance-surface-muted)] p-3">
                    <input
                      id="agreed-terms"
                      type="checkbox"
                      checked={agreedTerms}
                      onChange={(e) => setAgreedTerms(e.target.checked)}
                      className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer rounded-compact border-[var(--appearance-border-strong)] accent-[var(--appearance-primary)]"
                      required
                    />
                    <label htmlFor="agreed-terms" className="cursor-pointer select-none text-body leading-relaxed text-[var(--appearance-text-secondary)]">
                      {'I have read and agree to the Return4me '}
                      <button
                        type="button"
                        onClick={() => (window as any).setView?.('terms')}
                        className="inline font-bold text-[var(--appearance-primary)] hover:underline"
                      >
                        {'Terms of Service'}
                      </button>{' '}
                      {'and the '}
                      <button
                        type="button"
                        onClick={() => (window as any).setView?.('privacy')}
                        className="inline font-bold text-[var(--appearance-primary)] hover:underline"
                      >
                        {'Privacy Policy'}
                      </button>
                    </label>
                  </div>
                ) : null
              )}

              {/* UX-12 · D — ONE dominant action for the whole application. It is
                  the same single submit the card already had: same handler, same
                  endpoint, same loading state. Before Review it advances a step
                  and makes no request; on Review it dispatches the one-time code
                  exactly as it always did. */}
              <Button type="submit" variant="primary" size="lg" loading={authLoading} className="w-full">
                {isRegistering
                  ? (isRegistrationReview
                      ? 'Submit application'
                      : 'Continue')
                  : 'Sign in'}
              </Button>
            </form>
          )}

          {/* UX-11 · E — somebody who is not an Agent yet. A restrained secondary
              route to the EXISTING public agent journey: the same 'becomeAgent'
              view name the public route table maps to /become-an-agent, reached
              through the same in-file navigation handle the registration Terms
              and Privacy links above already use. No second registration flow
              and nothing competing with Sign in. */}
          {!showOtp && !isRegistering && (
            <div className="space-y-3 border-t border-[var(--appearance-border)] pt-5 text-center">
              <p className="text-caption font-bold uppercase tracking-widest text-[var(--appearance-text-muted)]">
                {'Need to become an Agent?'}
              </p>
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="w-full"
                onClick={() => (window as any).setView?.('becomeAgent')}
              >
                {'Become an Agent'}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* 2. QUEUE LOADING — the pre-answer state.
          PHASE 16.1 BATCH 3 (F-5 / H-3): the very first paint must not claim a
          vetting state before the server has actually answered. */}
      {token && queueLoading && !agentProfile && !queueError && (
        <div className="bg-[var(--appearance-surface)] rounded-panel border border-[var(--appearance-border)] p-6 shadow-raised max-w-2xl mx-auto space-y-4 fade-in" aria-busy="true">
          <p className="text-caption font-extrabold uppercase tracking-widest text-[var(--appearance-text-muted)]" role="status" aria-live="polite">
            {'Loading your agent hub…'}
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Skeleton shape="card" />
            <Skeleton shape="card" />
            <Skeleton shape="card" />
          </div>
          <Skeleton shape="rect" className="h-11 w-full" />
          <Skeleton shape="text" />
          <Skeleton shape="text" className="w-2/3" />
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
        <div className="bg-[var(--appearance-surface)] rounded-panel border border-[var(--appearance-border)] p-8 shadow-raised max-w-md mx-auto text-center space-y-5 fade-in">
          <div className="w-16 h-16 bg-[var(--appearance-surface-muted)] text-[var(--appearance-danger)] rounded-full flex items-center justify-center mx-auto">
            <AlertCircle size={ICON_SIZE.feature} aria-hidden={true} />
          </div>
          <div className="space-y-2">
            <h2 className="text-heading font-extrabold text-[var(--appearance-text-primary)]">
              {'Agent Hub unavailable'}
            </h2>
            <p className="text-body text-[var(--appearance-text-secondary)] font-semibold" role="alert" aria-live="assertive">
              {queueError}
            </p>
          </div>
          <Button
            type="button"
            variant="primary"
            size="lg"
            className="w-full"
            onClick={retryQueue}
            disabled={queueLoading}
            aria-busy={queueLoading}
          >
            {queueLoading
              ? <Loader2 className="animate-spin" size={ICON_SIZE.emphasis} aria-hidden={true} />
              : <span>{'Try again'}</span>}
          </Button>
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
        <div className="bg-[var(--appearance-surface)] rounded-panel border border-[var(--appearance-border)] p-8 shadow-raised max-w-md mx-auto text-center space-y-5 fade-in">
          <div className="w-16 h-16 bg-[var(--appearance-surface-muted)] text-[var(--appearance-text-secondary)] rounded-full flex items-center justify-center mx-auto">
            <Mail size={ICON_SIZE.feature} aria-hidden={true} />
          </div>
          <div>
            <h2 className="text-heading font-extrabold text-[var(--appearance-text-primary)]">
              {'Verify Your Email'}
            </h2>
            <p className="text-body text-[var(--appearance-text-secondary)] mt-2 font-semibold leading-relaxed">
              {'We sent a verification link to the business email you provided. Open that email on this device and click the link in it.'}
            </p>
          </div>
          {/* role="status" announces the change of screen to assistive tech. The
              outcome is never signalled by the blue icon alone — the heading and
              the body text both change. */}
          <div role="status" className="bg-[var(--appearance-surface-muted)] border border-[var(--appearance-border)] p-4 rounded-standard text-left text-small text-[var(--appearance-text-secondary)] space-y-1.5 leading-tight">
            {(
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
        <div className="bg-[var(--appearance-surface)] rounded-panel border border-[var(--appearance-border)] p-8 shadow-raised max-w-md mx-auto text-center space-y-5 fade-in">
          <div className="w-16 h-16 bg-[var(--appearance-surface-muted)] text-[var(--appearance-accent)] rounded-full flex items-center justify-center mx-auto">
            <Lock size={ICON_SIZE.feature} aria-hidden={true} />
          </div>
          <div>
            <h2 className="text-heading font-extrabold text-[var(--appearance-text-primary)]">Vetting Pending</h2>
            <p className="text-body text-[var(--appearance-text-secondary)] mt-1 font-semibold">
              {'Their details will be checked and they\'ll be notified of their application.'}
            </p>
          </div>
          <div className="bg-[var(--appearance-surface-muted)] border border-[var(--appearance-border)] p-4 rounded-standard text-left text-small text-[var(--appearance-text-secondary)] space-y-1.5 leading-tight">
            {(
              <>
                <span className="font-bold block mb-1">Onboarding Process:</span>
                <span>1. Verification of Business Details & Location</span>
                <span>2. Secure KYC & National ID Hash Review</span>
                <span>3. Email notification dispatch upon activation!</span>
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
            className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-panel p-6 shadow-floating max-w-sm w-full space-y-4 fade-in outline-none"
          >
            <div className="flex items-start space-x-3 text-amber-600">
              <CheckCircle className="w-6 h-6 shrink-0 mt-0.5 animate-pulse" aria-hidden={true} />
              <div className="space-y-1">
                <h3 id="agent-confirm-modal-title" className="text-caption font-extrabold text-[var(--appearance-text-primary)] uppercase tracking-wider">
                  {confirmModal.title}
                </h3>
                <p className="text-small text-[var(--appearance-text-muted)] leading-relaxed font-semibold">
                  {confirmModal.message}
                </p>
              </div>
            </div>
            <div className="flex justify-end space-x-2 pt-2">
              <button
                onClick={() => setConfirmModal(null)}
                disabled={modalBusy}
                className="min-h-11 rounded-standard border border-[var(--appearance-border)] bg-[var(--appearance-surface-muted)] hover:opacity-90 px-4 text-body font-bold text-[var(--appearance-text-primary)] transition disabled:opacity-50"
              >
                {'Cancel'}
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
                className="min-h-11 rounded-standard bg-primary-green hover:bg-primary-hover px-4 text-body font-bold text-white transition flex items-center space-x-1.5 disabled:opacity-50"
              >
                {modalBusy ? <Loader2 className="animate-spin" size={12} aria-hidden={true} /> : null}
                <span>{'Confirm'}</span>
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
            className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-panel p-6 shadow-floating max-w-sm w-full space-y-4 fade-in outline-none"
          >
            <div className="flex items-start space-x-3 text-amber-600">
              <CheckCircle className="w-6 h-6 shrink-0 mt-0.5" aria-hidden={true} />
              <div className="space-y-1">
                <h3 id="agent-handover-modal-title" className="text-caption font-extrabold text-[var(--appearance-text-primary)] uppercase tracking-wider">
                  {'Confirm Handover'}
                </h3>
                <p className="text-small text-[var(--appearance-text-muted)] leading-relaxed font-semibold">
                  {'Ask the owner to read out their secret pickup code (emailed to them when they paid). Enter it below to release payment. This cannot be undone.'}
                </p>
              </div>
            </div>
            <input
              type="text"
              inputMode="numeric"
              autoFocus
              value={pickupCodeModal.code}
              onChange={(e) => setPickupCodeModal({ ...pickupCodeModal, code: e.target.value })}
              placeholder={'Enter owner\'s secret pickup code'}
              aria-label={'Owner\'s secret pickup code'}
              className="w-full min-h-11 rounded-standard border border-[var(--appearance-border-strong)] bg-[var(--appearance-surface)] px-4 py-3 text-center text-heading font-mono tracking-widest text-[var(--appearance-text-primary)] focus:outline-none focus:border-[var(--appearance-focus)]"
            />

            <div className="space-y-2">
              <p className="text-caption font-bold text-[var(--appearance-text-secondary)]">
                {'Photo of claimant with the item (required)'}
              </p>
              <input
                ref={handoverPhotoInputRef}
                type="file"
                accept="image/*"
                onChange={handleHandoverPhotoCapture}
                aria-label={'Photo of claimant with the item'}
                className="hidden"
              />

              {useHandoverCamera ? (
                <div className="relative bg-black rounded-standard overflow-hidden aspect-video">
                  {/* PHASE 16.1 BATCH 3 (A-7) — the live preview had no
                      accessible name, so assistive technology announced an
                      unnamed media element. Capture behaviour is unchanged; only
                      the name was added. */}
                  <video
                    ref={handoverVideoRef}
                    aria-label={'Live camera preview of the claimant with the item'}
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute bottom-3 left-0 right-0 flex justify-center space-x-3">
                    <button
                      type="button"
                      onClick={captureHandoverFrame}
                      className="rounded-standard bg-accent-orange px-4 py-2 text-caption font-bold text-white shadow-raised transition hover:bg-accent-hover"
                    >
                      {'Capture'}
                    </button>
                    <button
                      type="button"
                      onClick={stopHandoverCamera}
                      className="rounded-standard bg-stone-800 px-4 py-2 text-caption font-bold text-white transition hover:bg-stone-700"
                    >
                      {'Cancel'}
                    </button>
                  </div>
                </div>
              ) : pickupCodeModal.photoBase64 ? (
                <div className="relative rounded-standard overflow-hidden border border-[var(--appearance-border)] group">
                  <img
                    src={pickupCodeModal.photoBase64}
                    alt="Handover evidence"
                    className="w-full h-40 object-cover"
                  />
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition space-x-3">
                    <button
                      type="button"
                      onClick={startHandoverCamera}
                      className="rounded-full bg-[var(--appearance-surface)] p-2.5 text-[var(--appearance-primary)] hover:opacity-90 shadow-raised transition"
                      title={'Retake with camera'}
                      aria-label={'Retake with camera'}
                    >
                      <Camera size={ICON_SIZE.ui} aria-hidden={true} />
                    </button>
                    <button
                      type="button"
                      onClick={() => handoverPhotoInputRef.current?.click()}
                      className="rounded-full bg-[var(--appearance-surface)] p-2.5 text-[var(--appearance-primary)] hover:opacity-90 shadow-raised transition"
                      title={'Upload a different photo'}
                      aria-label={'Upload a different photo'}
                    >
                      <Upload size={ICON_SIZE.ui} aria-hidden={true} />
                    </button>
                  </div>
                </div>
              ) : (
                <div className="rounded-standard border-2 border-dashed border-[var(--appearance-border-strong)] bg-[var(--appearance-surface-muted)] py-5 text-center space-y-3">
                  <p className="text-caption text-[var(--appearance-text-muted)]">
                    {'Take a photo now, or upload one from this device'}
                  </p>
                  <div className="flex items-center justify-center gap-2.5">
                    <button
                      type="button"
                      onClick={startHandoverCamera}
                      className="min-h-11 rounded-standard bg-primary-green hover:bg-primary-hover px-3.5 text-caption font-bold text-white transition flex items-center gap-1.5"
                    >
                      <Camera size={ICON_SIZE.metadata} aria-hidden={true} />
                      <span>{'Take Photo'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handoverPhotoInputRef.current?.click()}
                      className="min-h-11 rounded-standard border border-[var(--appearance-border)] bg-[var(--appearance-surface)] hover:opacity-90 px-3.5 text-caption font-bold text-[var(--appearance-text-primary)] transition flex items-center gap-1.5"
                    >
                      <Upload size={ICON_SIZE.metadata} aria-hidden={true} />
                      <span>{'Upload File'}</span>
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
                className="min-h-11 rounded-standard border border-[var(--appearance-border)] bg-[var(--appearance-surface-muted)] hover:opacity-90 px-4 text-body font-bold text-[var(--appearance-text-primary)] transition disabled:opacity-50"
              >
                {'Cancel'}
              </button>
              <button
                onClick={submitConfirmHandover}
                disabled={actionProcessing}
                aria-busy={actionProcessing}
                className="min-h-11 rounded-standard bg-primary-green hover:bg-primary-hover px-4 text-body font-bold text-white transition disabled:opacity-50"
              >
                {actionProcessing
                  ? ('Confirming…')
                  : ('Confirm & Release Payment')}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
