import React, { useState, useRef, useEffect } from 'react';
import { translations } from '../types';
// REQUEST 09 — the canonical Kenyan county list (all 47, ISO 3166-2:KE
// spellings) lives in one place: src/config/kenyaCounties.ts.
// PHASE 9D — the Finder states the county explicitly through a REQUIRED County
// selector, whose value the server canonicalizes with `resolveCountyName()` and
// stores in items.found_county. The Finder must state the county explicitly
// rather than have it guessed from the free text — see the Phase 9D note on
// that column in src/db/schema.ts.
// P14A (P14-13) — the county list is deliberately NOT used as a `datalist` on
// the exact-location field any more: that field describes the actual place, and
// offering county names there invited people to type a county where a place was
// expected. The exact-location field stays free text.
import { countiesByUxGroup } from '../config/kenyaCounties';
import { administrativeUnitsForCounty } from '../config/kenyaAdministrativeUnits';
import { detectBrowserLocation, hasGeographyConflict, type DetectedLocation } from '../services/browserLocation';
import { Camera, Upload, AlertCircle, AlertTriangle, MapPin, CheckCircle, Shield, ArrowRight, Loader2, RefreshCw, X, type LucideIcon } from 'lucide-react';
// UX-05 — the guided five-stage journey is assembled from the shared UI
// foundation (Stepper + the Input/Select/Button primitives) instead of
// hand-rolled controls, so the step rail, the field chrome and the button
// ladder are the same ones the rest of the app already uses.
import { Button, ICON_SIZE, Input, Select, Stepper } from './ui';

// Computed once at module scope: the 47 counties, grouped by the UX-only
// former-province labels, exactly as the lost-report wizard presents them. The
// grouping is presentational only and never stored or matched (see
// config/kenyaCounties.ts).
const COUNTY_GROUPS = countiesByUxGroup();

// ===========================================================================
// UX-05 — THE FIVE-STAGE GUIDED JOURNEY
// ===========================================================================
// The found-item report used to be ONE long single-screen form. It is answered
// as five bounded stages, each asking one question:
//
//   1. What      — the photograph (camera or file) and the closest category
//   2. Identify  — the document/name the scan pre-filled, or the item's own
//                  title and description
//   3. Where     — county, sub-county, the exact place in the Finder's words,
//                  plus the optional device coordinates
//   4. Contact   — the payout phone number, an optional email, an optional
//                  Return4me Finder account
//   5. Review    — a plain recap with one edit affordance per group, then the
//                  single submit action
//
// UX-05 IS PRESENTATION AND FORM ERGONOMICS ONLY. Every state value, every
// validation rule and the exact wording of every message, the camera/upload/
// scan handlers, the GPS handling and the single POST to /api/items/report with
// its payload keys untouched all behave exactly as they did on the single
// screen. What changed:
//   * a stage shows only the fields it asks about, so a phone user is not made
//     to scroll past questions the journey has not reached yet;
//   * a validation failure is still announced through the one assertive alert
//     channel (id="finder-error") and scrolled into view, and the journey does
//     not advance past the stage that failed;
//   * a stage change moves focus to that stage's own heading, so a keyboard or
//     screen-reader user is told where the journey went;
//   * the step rail, the fields, the buttons and the review chrome come from the
//     shared UI foundation (Stepper, Input, Select, Button) and the UX-01
//     ladders instead of hand-rolled controls.
//
// The server remains the ONLY authority on validation. Each rule below exists
// so a Finder is not made to submit a report the API would reject.
//
// DELIBERATE CARVE-OUTS (until UX-16 finishes the component migration):
//   * the category <select> stays a raw control, because its disabled styling
//     (`disabled:text-stone-400`) is pinned by publicExperience.test.ts as
//     evidence that meaningful dark-surface shades were not flattened;
//   * the photograph controls (camera, upload, retake, remove) and the two GPS
//     boxes keep their existing markup, because their exact bilingual strings
//     and assistive wiring are pinned by that same suite.
const FINDER_STEPS: { en: string }[] = [
  { en: 'What' },
  { en: 'Identify' },
  { en: 'Where' },
  { en: 'Contact' },
  { en: 'Review & Submit' },
];

/**
 * The id shared by the one visible stage heading and the <section> that names
 * itself with it. Only one stage renders at a time, so a single constant can
 * never collide, and it gives assistive tech a stable "current stage" landmark
 * to announce after Continue or Back.
 */
const STEP_HEADING_ID = 'finder-step-heading';

/**
 * UX-05 — the upload inputs' `accept` value.
 *
 * Written from parts ON PURPOSE. The repository's source-scanning tripwires
 * (publicExperience, countySelectorExactPlace, p14aUiBoundary and this batch's
 * own suite) delete comments with a slash-star regular expression that cannot
 * tell a real comment opener from the same two characters sitting inside a
 * plain accept attribute. A stray opener like that makes the pattern swallow
 * everything up to the next closing marker — tens of thousands of characters of
 * real markup — so the pinned copy in the GPS, phone and submit sections
 * silently stops being checked. Building the value here keeps the attribute's
 * runtime value byte-identical and keeps the accidental opener out of this
 * file.
 */
const IMAGE_ACCEPT = 'image' + '/' + '*';


interface FinderViewProps {
  categories: any[];
  categoriesLoading?: boolean;
  categoriesError?: boolean;
}

export default function FinderView({ categories, categoriesLoading = false, categoriesError = false }: FinderViewProps) {
  const t = translations.en;
  const errorBannerRef = useRef<HTMLDivElement | null>(null);

  /**
   * UX-05 — one bilingual literal, written the way this component writes all of
   * its copy, so the new stage strings stay inline instead of adding keys to the
   * shared bundle for sentences only this journey shows.
   */


  // UX-05 — the guided journey's own state, and the single focus target a stage
  // change moves to.
  const [step, setStep] = useState(0);
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const previousStepRef = useRef(0);

  // A stage change moves focus to the new stage heading — never on first render,
  // and nowhere else in the journey.
  useEffect(() => {
    if (previousStepRef.current === step) return;
    previousStepRef.current = step;
    stepHeadingRef.current?.focus();
  }, [step]);

  // Camera & Upload state
  const [useCamera, setUseCamera] = useState(false);
  const [photoBase64, setPhotoBase64] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisStatus, setAnalysisStatus] = useState<string>('');

  // Form Fields
  const [categoryId, setCategoryId] = useState('');
  const [categoryManuallySet, setCategoryManuallySet] = useState(false);
  const [extractedNumber, setExtractedNumber] = useState('');
  const [extractedName, setExtractedName] = useState('');
  const [description, setDescription] = useState('');
  const [locationDescription, setLocationDescription] = useState('');
  // PHASE 9D — the Finder's EXPLICIT county. Required, and kept separate from
  // both `locationDescription` (their own wording, preserved verbatim) and the
  // optional device coordinates. The server re-validates and canonicalizes it;
  // this state holds exactly what the user chose so the select stays truthful.
  const [foundCounty, setFoundCounty] = useState('');
  const [foundAdministrativeUnit, setFoundAdministrativeUnit] = useState('');
  const foundAdministrativeUnits = administrativeUnitsForCounty(foundCounty);
  const [latitude, setLatitude] = useState<number | null>(null);
  const [longitude, setLongitude] = useState<number | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [detectedLocation, setDetectedLocation] = useState<DetectedLocation | null>(null);
  const [gpsMessage, setGpsMessage] = useState('');
  const [finderPhone, setFinderPhone] = useState('');
  const [finderEmail, setFinderEmail] = useState('');
  // REQUEST 10 — the "Estimated Replacement Value, KES (Optional)" field was
  // REMOVED from this form. It fed declared_value, which the fee engine used
  // only as an optional CEILING on the recovery fee. With it gone the server
  // receives no declaredValue, which is an explicitly supported input
  // (server.ts: `if (declaredValue !== undefined && ...)`), and the locked fee
  // becomes the category's admin-configured raw fee (base + complexity + delay).
  // That is a bounded, per-category amount — so removing the field cannot
  // produce an unbounded or inflated fee. See the Phase 9 report for the full
  // consumer trace (feeEngine.ts, schema.sql, items.declared_value, tests).
  const [createAccount, setCreateAccount] = useState(false);
  const [agreedTerms, setAgreedTerms] = useState(false);

  // Submission results
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [dropoffResult, setDropoffResult] = useState<any | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  /**
   * CAT-11 (Phase 16.1 Batch 1) — is the SELECTED category a sensitive document?
   *
   * The single rule for all three call sites in this component. It reads
   * `is_sensitive_document` off the live category record and nothing else.
   *
   * WHAT WAS WRONG: each site also compared the id against a literal 'other',
   * e.g. `categoryId !== 'other' && isSensitive`. There is no canonical category
   * called 'other' — the canonical generic categories are 'other-item' and
   * 'other-document' (src/db/database.ts) — so that comparison was ALWAYS true
   * and the "don't document-scan a generic, non-document item" behaviour it was
   * written for never actually applied. No replacement sentinel is needed:
   * `is_sensitive_document` already draws exactly that line ('other-item' false ->
   * no scan, 'other-document' true -> scan), and an unrecognised or not-yet-chosen
   * category still fails closed to sensitive so the scan is offered rather than
   * silently skipped.
   */
  const isSelectedCategorySensitive = (): boolean => {
    const selectedCat = categories.find((c: any) => c.id === categoryId);
    return selectedCat ? (selectedCat.is_sensitive_document !== false) : true;
  };

  // Stop camera stream when leaving
  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, []);

  // The error banner renders once, right below the page title — but this
  // is a long single-screen form (camera/upload, category, GPS, phone,
  // email, terms, then Submit at the very bottom). On a phone, a
  // validation error triggered by pressing Submit at the bottom left the
  // person staring at an unchanged screen with the actual explanation
  // scrolled off the top, with no toast or indicator near the button
  // itself. Scroll the banner into view whenever a new error appears, at
  // both the top-of-form validation errors and the post-submit ones.
  useEffect(() => {
    if (errorMsg && errorBannerRef.current) {
      errorBannerRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [errorMsg]);

  // Launch camera stream
  const startCamera = async () => {
    setErrorMsg('');
    setUseCamera(true);
    setPhotoBase64(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
    } catch (e) {
      console.error('Camera access denied:', e);
      setErrorMsg('Could not access camera. Please use file upload instead.');
      setUseCamera(false);
    }
  };

  const stopCamera = () => {
    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach(track => track.stop());
      videoRef.current.srcObject = null;
    }
    setUseCamera(false);
  };

  // Capture frame from live video
  const captureFrame = () => {
    if (videoRef.current && canvasRef.current) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg');
        setPhotoBase64(dataUrl);
        stopCamera();
        setCategoryManuallySet(false);
        
        // Auto trigger analysis when the selected category is a sensitive
        // document — CAT-11: the "is it generic?" question is answered by the
        // live category's own `is_sensitive_document`, never by an id literal.
        if (isSelectedCategorySensitive()) {
          analyzePhoto(dataUrl);
        }
      }
    }
  };

  // Handle manual file upload
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result as string;
        setPhotoBase64(result);
        setCategoryManuallySet(false);
        
        // Auto trigger analysis when the selected category is a sensitive
        // document — CAT-11: same single rule as the camera path above.
        if (isSelectedCategorySensitive()) {
          analyzePhoto(result);
        }
      };
      reader.readAsDataURL(file);
    }
  };

  // Run the item-scanning pipeline (provider-agnostic on purpose — the
  // person reporting an item should never see which backend service reads
  // it, only that Return4me is handling it).
  const analyzePhoto = async (base64Data: string) => {
    setIsAnalyzing(true);
    setAnalysisStatus('Return4me is preparing to scan your item...');
    setErrorMsg('');

    try {
      // Simulate real-time progress steps for a gorgeous UX
      setTimeout(() => setAnalysisStatus('Reading document layout...'), 800);
      setTimeout(() => setAnalysisStatus('Extracting identity details...'), 1600);

      const response = await fetch('/api/items/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photoBase64: base64Data }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Item analysis failed');
      }

      // Pre-fill form
      if (!categoryManuallySet) {
        setCategoryId(data.documentType || 'national-id');
      }
      setExtractedNumber(data.documentNumber || '');
      setExtractedName(data.fullName || '');
    } catch (e: any) {
      console.error(e);
      setErrorMsg('We couldn\'t scan that automatically. Please enter the details manually below.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const getCoordinates = async () => {
    setGpsLoading(true);
    setErrorMsg('');
    setGpsMessage('');
    const result = await detectBrowserLocation();
    if (result.status === 'error') {
      setGpsMessage(result.message);
    } else {
      setLatitude(result.location.latitude);
      setLongitude(result.location.longitude);
      setGpsAccuracy(result.location.accuracy);
      setDetectedLocation(result.location);
      // DETECTION NEVER APPLIES GEOGRAPHY BY ITSELF — it only captures the
      // coordinates and offers a suggestion the Finder must confirm below. The
      // wording distinguishes a strong fix from a coarse one and never claims
      // the area is verified.
      setGpsMessage(
        result.location.county
          ? (result.location.accuracyTier === 'strong'
              ? 'Location detected. Review the suggested area below, then confirm it or keep your own selection.'
              : 'Location detected, but the reading is not highly precise. Review the suggested area below before using it.')
          : 'GPS coordinates captured. We could not reliably determine your county or sub-county; enter them manually.',
      );
    }
    setGpsLoading(false);
  };

  const useDetectedLocation = () => {
    if (!detectedLocation?.county) return;
    // The ONLY path that may change the Finder's geography — an explicit tap on
    // "Use this location". Detection itself never mutates a selection, and the
    // server re-validates the county/sub-county pairing regardless.
    setFoundCounty(detectedLocation.county);
    setFoundAdministrativeUnit(detectedLocation.subCountyId ?? '');
    if (detectedLocation.place && !locationDescription.trim()) setLocationDescription(detectedLocation.place);
    setGpsMessage(detectedLocation.subCountyId ? 'Suggested area applied. You can still edit any field.' : 'We detected your county but could not reliably determine your sub-county. Please select it manually.');
  };

  // =========================================================================
  // UX-05 — the per-stage gate
  // =========================================================================
  /**
   * The message that stops a stage from advancing, or null when that stage is
   * complete. The RULES, their order inside a stage and the wording of every
   * message are the ones this form already enforced on its single screen —
   * those checks now live here, so the same rule can gate "Continue" and can be
   * re-checked when the report is finally sent.
   *
   * Only the category, the county, the sub-county, the exact place and the
   * payout phone have a message of their own; the remaining required fields
   * shared the one "please fill out all required fields" sentence, and that
   * sentence is kept VERBATIM for the stage that asks for the photograph and
   * the category.
   */
  const stepErrorFor = (target: number): string | null => {
    if (target === 0) {
      if (!categoryId || !photoBase64) {
        return 'Please fill out all required fields and upload/capture a photo.';
      }
      return null;
    }

    const isSensitive = isSelectedCategorySensitive();

    if (target === 1) {
      if (!isSensitive && (!description || !extractedName)) {
        return 'Please provide a title and description.';
      }
      return null;
    }

    // PHASE 9D — county and sub-county are required geographic fields. This is
    // a UX guard only: the server re-validates both against the canonical
    // 47-county list with `resolveCountyName()` and is the authority. A
    // client-side check never substitutes for that.
    if (target === 2) {
      if (!foundCounty) {
        return 'Please choose the county where you found the item.';
      }
      if (!foundAdministrativeUnit) {
        return 'Please choose the sub-county where you found the item.';
      }
      if (!locationDescription) {
        return 'Please enter the exact place where you found the item.';
      }
      return null;
    }

    if (target === 3) {
      if (!finderPhone) {
        return 'Please enter the phone number for your M-Pesa payout.';
      }
      if (createAccount && !agreedTerms) {
        return 'You must agree to the Terms of Service and Privacy Policy to create an account.';
      }
      if (finderEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(finderEmail)) {
        return 'Please enter a valid email address.';
      }
      return null;
    }

    return null;
  };

  const totalSteps = FINDER_STEPS.length;
  const isLastStep = step === totalSteps - 1;

  /** Advance one stage, but only when the current one is complete. */
  const goNext = () => {
    const message = stepErrorFor(step);
    if (message) {
      setErrorMsg(message);
      return;
    }
    setErrorMsg('');
    setStep((s) => Math.min(s + 1, totalSteps - 1));
  };

  const goBack = () => {
    setErrorMsg('');
    setStep((s) => Math.max(s - 1, 0));
  };

  /** Presentation-only shortcut used by the review stage's edit affordances. */
  const goToStep = (target: number) => {
    setErrorMsg('');
    setStep(Math.max(0, Math.min(target, totalSteps - 1)));
  };

  // Review-stage values, read from the live category list and the canonical
  // county datasets exactly as the fields themselves read them.
  const selectedCategory = categories.find((c: any) => c.id === categoryId);
  const selectedCategoryLabel = selectedCategory
    ? ((selectedCategory.name_en) || selectedCategory.name_en || categoryId)
    : '';
  const isSensitiveCategory = isSelectedCategorySensitive();
  const foundAdministrativeUnitName = foundAdministrativeUnits.find((unit) => unit.id === foundAdministrativeUnit)?.name ?? '';
  const stepperSteps = FINDER_STEPS.map((s) => ({ label: s.en }));
  const currentStepLabel = stepperSteps[Math.max(0, Math.min(step, stepperSteps.length - 1))].label;

  // Submit complete found item report
  const submitFoundReport = async (e: React.FormEvent) => {
    e.preventDefault();
    // Defence in depth against a duplicate POST: the submit button is already
    // disabled while a submission is in flight, but the form itself is not
    // disabled, so an implicit submission (Enter inside a text field) must not
    // be able to fire a second report.
    if (isSubmitting) return;
    // CAT-11: sensitivity comes from the live category record alone.
    const isSensitive = isSelectedCategorySensitive();

    // UX-05 — re-validate EVERY stage before sending: the Finder may have gone
    // back and changed an earlier answer. The rules, their order and their
    // wording are the ones this form always enforced; they now live in
    // stepErrorFor() so the same rule can gate "Continue" and be re-checked
    // here. The journey jumps to the first incomplete stage and reports it
    // through the one alert channel.
    for (let s = 0; s < FINDER_STEPS.length - 1; s++) {
      const message = stepErrorFor(s);
      if (message) {
        setStep(s);
        setErrorMsg(message);
        return;
      }
    }

    // UX-05 — the workflow has exactly ONE deliberate submit path: the review
    // stage's own button. A stage change is not a submission, so an implicit
    // submission (Enter inside a text field on an earlier stage) is refused
    // here, in addition to the duplicate-POST guard above.
    if (step !== FINDER_STEPS.length - 1) return;

    // PHASE 9D — county (and the sub-county) is a required geographic field,
    // and PHASE 9D's reasoning is unchanged: the server re-validates both
    // against the canonical list with `resolveCountyName()` and is the
    // authority, so a client-side check never substitutes for it. UX-05 moved
    // WHERE that check runs (into stepErrorFor above, so it gates the "Where"
    // stage and is re-checked before the report is sent) without changing what
    // it requires. The remaining per-field rules live there too: the exact
    // place, the payout phone, the account terms and the email format.

    setIsSubmitting(true);
    setErrorMsg('');

    // PHASE 8.4 — a failed submit must never render raw exception text.
    // The API's own `error` string is a user-facing message by contract (see
    // the errorDisclosure suite); a browser/network failure is not — its raw
    // text ("Failed to fetch", "Unexpected token < in JSON…") is
    // implementation detail and must not reach a public user.
    const submitErrorMessage =
      'We could not submit your report. Please check your connection and try again.';

    try {
      const response = await fetch('/api/items/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          categoryId,
          photoBase64,
          extractedNumber: isSensitive ? extractedNumber : undefined,
          extractedName,
          locationDescription,
          foundCounty,
          administrativeUnitId: foundAdministrativeUnit,
          latitude,
          longitude,
          finderPhone,
          finderEmail,
          createAccount,
          termsAccepted: agreedTerms,
          description: !isSensitive ? description : undefined,
        }),
      });

      const data = await response.json().catch(() => null);
      if (!response.ok || !data) {
        const apiMessage = typeof data?.error === 'string' ? data.error.trim() : '';
        setErrorMsg(apiMessage || submitErrorMessage);
        return;
      }

      setDropoffResult(data.item);
    } catch (e: any) {
      console.error(e);
      setErrorMsg(submitErrorMessage);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 fade-in">
      {/* Title */}
      <div className="text-center mb-8">
        <h1 className="text-3xl font-extrabold text-primary-green mb-2">{t.finderTitle}</h1>
        <p className="text-ink-muted text-sm max-w-xl mx-auto">{t.finderSubtitle}</p>
      </div>

      {/* Validation and submission failures are announced assertively, and the
          form points at this id via aria-describedby (Phase 8.5). */}
      {errorMsg && (
        <div
          id="finder-error"
          ref={errorBannerRef}
          role="alert"
          className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-2xl flex items-center space-x-2.5 mb-6 text-sm"
        >
          <AlertCircle size={18} className="shrink-0" aria-hidden="true" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* Success View / Handover instructions */}
      {dropoffResult ? (
        <div className="bg-white rounded-2xl border border-line-subtle p-6 md:p-8 shadow-sm text-center space-y-6">
          <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto text-emerald-600">
            <CheckCircle size={36} />
          </div>
          <div role="status" aria-live="polite">
            <h2 className="text-2xl font-extrabold text-primary-green mb-1">{t.successReport}</h2>
            <p className="text-ink-muted text-sm">{t.dropoffInstructions}</p>
          </div>

          {/* Assigned Agent Details — or, if manual assignment is still
              pending, an honest "we're finding the right agent" message.
              assignedAgent is null whenever automatic matching couldn't
              confidently pick one — see AgentMatchingService.
              assignNearestAgent — so this must never assume it's always
              present. */}
          {dropoffResult.assignedAgent ? (
            <div className="bg-brand-beige p-5 rounded-2xl text-left border border-line-subtle space-y-3">
              <h3 className="text-xs font-extrabold text-ink-muted uppercase tracking-widest">{t.agentDetails}</h3>
              <div>
                <h4 className="text-lg font-bold text-primary-green">{dropoffResult.assignedAgent.business_name}</h4>
                <p className="text-ink-muted text-sm font-medium">{dropoffResult.assignedAgent.location_address}</p>
                <p className="text-ink-muted text-xs mt-1">{'Phone'}: {dropoffResult.assignedAgent.contact_phone}</p>
              </div>
            </div>
          ) : (
            <div className="bg-amber-50 p-5 rounded-2xl text-left border border-amber-200 space-y-2">
              <h3 className="text-xs font-extrabold text-amber-700 uppercase tracking-widest">
                {'Finding Your Agent'}
              </h3>
              <p className="text-amber-900 text-sm font-medium">
                {"We couldn't confidently match a nearby Return4me agent automatically. Our team is finding the right one for your location and will notify you with drop-off details shortly."}
              </p>
            </div>
          )}

          {/* Drop-off Code */}
          <div className="bg-primary-green text-white p-6 rounded-2xl space-y-2">
            <span className="text-xs font-bold uppercase tracking-widest text-stone-300">{t.dropoffCode}</span>
            <div className="text-3xl font-mono font-extrabold tracking-wider text-accent-orange">
              {dropoffResult.id}
            </div>
            <p className="text-caption text-stone-300">
              {dropoffResult.assignedAgent
                ? t.directionNote
                : ('Keep this code — you\'ll need it once an agent is assigned.')}
            </p>
          </div>

          {/* Save-this-code warning */}
          <div className="bg-amber-50 border border-amber-300 text-amber-900 p-4 rounded-2xl text-left flex items-start space-x-3">
            <AlertTriangle size={20} className="shrink-0 mt-0.5 text-amber-600" />
            <div className="text-xs space-y-1">
              <p className="font-extrabold">
                {'IMPORTANT: Write down or screenshot this code now.'}
              </p>
              <p className="text-amber-800">
                {"You will need to give this exact code to the Return4me agent when you physically drop off the item. If you lose it, contact support with your phone number to recover it."}
              </p>
            </div>
          </div>

          <button
            onClick={() => {
              setDropoffResult(null);
              setPhotoBase64(null);
              setCategoryId('');
              setCategoryManuallySet(false);
              setExtractedNumber('');
              setExtractedName('');
              setDescription('');
              setFoundCounty('');
              setFoundAdministrativeUnit('');
              setLocationDescription('');
              setFinderPhone('');
              setCreateAccount(false);
              setAgreedTerms(false);
            }}
            className="w-full bg-accent-strong hover:bg-accent-strong-hover text-white py-3.5 rounded-2xl font-bold transition flex items-center justify-center space-x-2 shadow-lg shadow-orange-500/10"
          >
            <span>{'Report Another Item'}</span>
            <ArrowRight size={18} />
          </button>
        </div>
      ) : (
        /* Form View */
        <form
          onSubmit={submitFoundReport}
          aria-describedby={errorMsg ? 'finder-error' : undefined}
          className="bg-white rounded-2xl border border-line-subtle p-6 md:p-8 shadow-sm space-y-6"
        >
          
          <Stepper
            steps={stepperSteps}
            currentStep={step}
            label={'Report a found item progress'}
          />

          {/* One polite announcement per stage change, for screen readers that do
              not track the rail's aria-current. */}
          <p className="sr-only" role="status" aria-live="polite">
            {'Step'} {step + 1} {'of'} {FINDER_STEPS.length}: {currentStepLabel}
          </p>

          {/* ---------------- STAGE 1 — WHAT DID YOU FIND? ---------------- */}
          {step === 0 && (
            <section aria-labelledby={STEP_HEADING_ID} className="space-y-5">
              <StepIntro
                headingRef={stepHeadingRef}
                title={'What did you find?'}
                description={'Start with a photograph and the closest category. Both are how your report is lined up with a lost item of the same kind.'}
              />


              {/* Photo Capture Section */}
              <div className="space-y-3">
                {/* A group heading, not a form label: it names the photo step for
                    the whole control group (camera, upload, retake, remove) rather
                    than one input, so a <label> without a control was misleading
                    to assistive tech. */}
                <p className="block text-sm font-extrabold text-primary-green">{t.capturePhoto} *</p>
            
                {useCamera ? (
                  <div className="relative bg-black rounded-2xl overflow-hidden aspect-video">
                    <video ref={videoRef} className="w-full h-full object-cover" />
                    <div className="absolute bottom-4 left-0 right-0 flex justify-center space-x-4">
                      <button
                        type="button"
                        onClick={captureFrame}
                        className="bg-accent-orange text-white px-5 py-2.5 rounded-xl font-bold text-sm shadow-lg transition hover:bg-accent-hover"
                      >
                        {'Capture'}
                      </button>
                      <button
                        type="button"
                        onClick={stopCamera}
                        className="bg-stone-800 text-white px-5 py-2.5 rounded-xl font-bold text-sm transition hover:bg-stone-700"
                      >
                        {'Cancel'}
                      </button>
                    </div>
                  </div>
                ) : photoBase64 ? (
                  <div className="relative rounded-2xl overflow-hidden border border-line-subtle bg-brand-beige aspect-video">
                    <img
                      src={photoBase64}
                      alt={
                        `Photo of the ${categories.find(c => c.id === categoryId)?.name_en || 'found item'} you are reporting`
                      }
                      className="w-full h-full object-contain"
                    />
                    {/* Controls */}
                  <div className="flex items-center justify-center gap-2 pb-3">
                    <button
                        type="button"
                        onClick={startCamera}
                        className="bg-white text-primary-green p-2.5 rounded-full hover:bg-stone-100 shadow-md transition"
                        title={'Retake photo'}
                        aria-label={'Retake photo'}
                      >
                        <Camera size={18} />
                      </button>
                      <label className="bg-white text-primary-green p-2.5 rounded-full hover:bg-stone-100 shadow-md transition cursor-pointer" aria-label={'Upload a photo'}>
                        <Upload size={18} />
                        <input
                          type="file"
                          accept={IMAGE_ACCEPT}
                          onChange={handleFileUpload}
                          className="hidden"
                          aria-label={'Upload a photo'}
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => { setPhotoBase64(null); setExtractedName(''); setExtractedNumber(''); }}
                        className="bg-red-50 text-red-600 p-2.5 rounded-full hover:bg-red-100 shadow-md transition"
                        title={'Remove photo'}
                        aria-label={'Remove photo'}
                      >
                        <X size={18} />
                      </button>
                    </div>
                  </div>
                ) : (
                  /* Capture placeholder state */
                  <div className="border-2 border-dashed border-line-subtle rounded-2xl p-8 text-center bg-brand-beige hover:border-accent-orange transition space-y-4">
                    <div className="w-12 h-12 bg-emerald-50 rounded-full flex items-center justify-center mx-auto text-primary-green">
                      <Camera size={24} />
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm font-bold text-ink-muted">{'Take a photo or upload file'}</p>
                      <p className="text-xs text-ink-muted">{'A clear photo helps match your report with lost items owned by others.'}</p>
                    </div>
                    <div className="flex items-center justify-center space-x-3">
                      <button
                        type="button"
                        onClick={startCamera}
                        className="bg-primary-green hover:bg-primary-hover text-white px-4 py-2 rounded-xl text-xs font-bold transition flex items-center space-x-1.5"
                      >
                        <Camera size={14} />
                        <span>{t.takeSnap}</span>
                      </button>
                      <label className="bg-white border border-stone-300 hover:bg-stone-50 text-ink-muted px-4 py-2 rounded-xl text-xs font-bold transition flex items-center space-x-1.5 cursor-pointer">
                        <Upload size={14} />
                        <span>{t.uploadFile}</span>
                        <input type="file" accept={IMAGE_ACCEPT} onChange={handleFileUpload} className="hidden" />
                      </label>
                    </div>

                  </div>
                )}
                <canvas ref={canvasRef} className="hidden" />
              </div>

              {/* OCR Loading Overlay — a live region so the multi-phase scan status
                  reaches screen readers as it changes (Phase 8.5). */}
              {isAnalyzing && (
                <div
                  className="bg-brand-beige p-6 rounded-2xl text-center border border-emerald-100 flex flex-col items-center justify-center space-y-3"
                  role="status"
                  aria-live="polite"
                >
                  <Loader2 className="animate-spin text-accent-orange" size={28} />
                  <div>
                    <p className="text-sm font-bold text-primary-green">{t.analyzing}</p>
                    <p className="text-xs text-ink-muted font-medium">{analysisStatus}</p>
                  </div>
                </div>
              )}

              {/* Form Fields: Category Selector */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label htmlFor="finder-category" className="block text-xs font-extrabold text-primary-green uppercase tracking-wider">{t.categoryLabel} *</label>
                  <select
                    id="finder-category"
                    value={categoryId}
                    onChange={(e) => {
                      setCategoryId(e.target.value);
                      setCategoryManuallySet(true);
                    }}
                    className="w-full border border-line-subtle rounded-xl px-3 py-2.5 text-sm bg-white focus:border-accent-orange focus:outline-none disabled:bg-stone-50 disabled:text-stone-400"
                    required
                    disabled={categoriesLoading || categoriesError}
                  >
                    {categoriesLoading ? (
                      <option value="">{'Loading categories...'}</option>
                    ) : categoriesError ? (
                      <option value="">{'Categories unavailable — please refresh'}</option>
                    ) : (
                      (() => {
                        const validCategories = categories.filter(cat => cat.name_en && cat.name_sw);
                        const invalidCount = categories.length - validCategories.length;
                        if (invalidCount > 0) {
                          console.warn(`[FinderView] Filtered out ${invalidCount} incomplete categories from rendering.`);
                        }
                        return [
                          <option key="select-category" value="">{'-- Select Category --'}</option>,
                          ...validCategories.map(cat => (
                            <option key={cat.id} value={cat.id}>
                              {cat.name_en} (Fee: KES {cat.total_fee})
                            </option>
                          ))
                        ];
                      })()
                    )}
                  </select>
                </div>
              </div>
            </section>
          )}

          {/* ---------------- STAGE 2 — IDENTIFY IT ---------------- */}
          {step === 1 && (
            <section aria-labelledby={STEP_HEADING_ID} className="space-y-5">
              <StepIntro
                headingRef={stepHeadingRef}
                title={'Identify the item'}
                description={'Add the identifying details, or correct anything the scan filled in. These are the details that make an exact match possible.'}
              />

              {(() => {
                // CAT-11: the sensitivity decision comes from the live category
                // record alone — see isSelectedCategorySensitive() above.
                const isSensitive = isSelectedCategorySensitive();
                if (isSensitive) {
                  // CAT-11: the former inner `if (categoryId !== 'other')` wrapper
                  // was removed. 'other' is not a canonical category id, so the
                  // test was always true and its `else` branch was unreachable
                  // dead code. The reachable behaviour is unchanged: a sensitive
                  // document asks for its document number.
                  return (
                      <Input
                        id="finder-doc-number"
                        label={t.docNumberLabel}
                        type="text"
                        value={extractedNumber}
                        onChange={(e) => setExtractedNumber(e.target.value)}
                        placeholder={'e.g. 32904812'}
                      />
                    );
                } else {
                  return (
                    <Input
                      id="finder-description"
                      label={'Item Description'}
                      type="text"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder={'e.g. Black leather with silver ring'}
                      required
                    />
                  );
                }
              })()}

              {(() => {
                // CAT-11: sensitivity comes from the live category record alone.
                const isSensitive = isSelectedCategorySensitive();
                if (!isSensitive) {
                  return (
                    <Input
                      id="finder-item-name"
                      label={'Item Title (e.g. Keychain, Phone)'}
                      type="text"
                      value={extractedName}
                      onChange={(e) => setExtractedName(e.target.value)}
                      placeholder={'e.g. Black Keychain'}
                      required
                    />
                  );
                } else {
                  return (
                    <Input
                      id="finder-item-name"
                      label={t.docNameLabel}
                      type="text"
                      value={extractedName}
                      onChange={(e) => setExtractedName(e.target.value)}
                      placeholder={'e.g. MWANGI KAMAU'}
                      className="uppercase"
                    />
                  );
                }
              })()}

              {/* Analysis results are pre-fill suggestions the finder can correct.
                  The scan reads the image; it does not verify ownership, identity
                  or authenticity — so the person reporting must review it. */}
              {photoBase64 && !isAnalyzing && (extractedNumber || extractedName) && (
                <p className="text-caption text-ink-muted leading-normal">
                  {'Please check the details above and correct anything the scan got wrong.'}
                </p>
              )}

            </section>
          )}

          {/* ---------------- STAGE 3 — WHERE DID YOU FIND IT? ---------------- */}
          {step === 2 && (
            <section aria-labelledby={STEP_HEADING_ID} className="space-y-5">
              <StepIntro
                headingRef={stepHeadingRef}
                title={'Where did you find it?'}
                description={'The county is what your report is compared against. The exact place is your own description of where the item was found.'}
              />


              {/* Location Details & GPS Prompt */}
              <div className="space-y-3">
                {/* PHASE 9D — REQUIRED COUNTY. Deliberately the FIRST geographic
                    question, and a select rather than free text: the value is the
                    authoritative found-side county the matcher compares against
                    the lost report's county, and it must be one of the canonical
                    47 rather than something a person typed and the server then has
                    to interpret. Asking here is what removes the old
                    "Mombasa Road -> Mombasa County" style of guess.
                    Requirement is mirrored by the browser's `required` attribute
                    AND re-validated server-side, which is the authority. */}
                <Select
                  id="finder-county"
                  label={'County where you found it'}
                  value={foundCounty}
                  onChange={(e) => {
                    setFoundCounty(e.target.value);
                    setFoundAdministrativeUnit('');
                  }}
                  required
                  disabled={isSubmitting}
                  hint={'We use this to compare your report with items lost in the same county.'}
                >
                  <option value="">{'Select a county'}</option>
                  {COUNTY_GROUPS.map((group) => (
                    <optgroup key={group.group} label={group.group}>
                      {group.counties.map((county) => (
                        <option key={county.code} value={county.name}>
                          {county.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </Select>

                <Select
                  id="finder-administrative-unit"
                  label={'Sub-county where you found it'}
                  value={foundAdministrativeUnit}
                  onChange={(e) => setFoundAdministrativeUnit(e.target.value)}
                  required
                  disabled={isSubmitting || !foundCounty}
                  hint={'This structured selection is separate from the exact place you enter below.'}
                >
                  <option value="">{foundCounty ? ('Select a sub-county') : ('Select county first')}</option>
                  {foundAdministrativeUnits.map((unit) => (
                    <option key={unit.id} value={unit.id}>{unit.name}</option>
                  ))}
                </Select>

                {/* P14A (P14-13) — FREE TEXT, with no suggestions attached. The
                    county is chosen in the required selector above; this field
                    describes the actual place (e.g. "Near Sarit Centre, Ring Road
                    Parklands"), so offering county names here was misleading. No
                    sub-county/city dataset exists and none is invented here. */}
            
                {/* GPS prompt — an OPTIONAL aid to agent matching, never a promise of one */}
                {latitude === null || longitude === null ? (
                  <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 space-y-3">
                    <div className="flex gap-2.5">
                      <MapPin className="text-accent-orange shrink-0 mt-0.5" size={18} />
                      <div className="space-y-1">
                        <h4 className="text-xs font-bold text-ink leading-none">
                          {'Help Us Match an Agent'}
                        </h4>
                        <p className="text-caption text-ink-muted leading-normal">
                          {'Turning on your location helps us match your report to a nearby available Return4me Agent hub for your drop-off. This is where you are now, and it may not be where you found the item. The county, sub-county and exact place you set are what describe where you found it. If no Agent can be matched, our team will assign one for you.'}
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={getCoordinates}
                      disabled={gpsLoading}
                      className="w-full bg-accent-strong hover:bg-accent-strong-hover text-white text-xs font-bold py-2.5 px-4 rounded-xl transition flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                    >
                      {gpsLoading ? (
                        <>
                          <Loader2 className="animate-spin" size={14} />
                          <span>{'Getting your location...'}</span>
                        </>
                      ) : (
                        <>
                          <MapPin size={14} />
                          <span>{'Turn Location On'}</span>
                        </>
                      )}
                    </button>
                  </div>

                ) : (
                  <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-4 flex gap-3 items-center">
                    <div className="bg-emerald-100 p-2 rounded-xl text-emerald-600 shrink-0">
                      <MapPin size={18} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="text-xs font-bold text-emerald-900">
                        {'Agent Matching Location Captured'}
                      </h4>
                      <p className="text-caption text-emerald-700 mt-0.5">
                        {'We saved your current location to help match your report to a nearby available Return4me Agent hub. This is where you are now, not necessarily where you found the item. The county, sub-county and exact place you set are what describe where you found it. If no Agent can be matched, our team will assign one for you.'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={getCoordinates}
                      className="text-caption font-bold text-emerald-800 hover:underline shrink-0"
                    >
                      {'Update'}
                    </button>
                  </div>
                )}

                <Input
                  id="finder-location"
                  label={t.locLabel}
                  type="text"
                  value={locationDescription}
                  onChange={(e) => setLocationDescription(e.target.value)}
                  placeholder={'e.g. Near Sarit Centre, Westlands'}
                  required
                  aria-describedby="finder-location-hint"
                />
                {/* P14C-3A — the exact place is the Finder's OWN words, stored
                    verbatim in items.location_description. The hint says what to
                    type; it promises nothing about automatic identification,
                    matching, speed or payout, and it invents no vocabulary. */}
                <span id="finder-location-hint" className="text-caption text-ink-muted block leading-tight">
                  {'Enter the street, estate, building, landmark or nearby place you know.'}
                </span>
              </div>
                {gpsMessage && <p className="text-caption text-ink-muted" role="status">{gpsMessage}</p>}
                {detectedLocation && (
                  <div className="rounded-xl border border-emerald-200 bg-white p-3 text-xs text-ink space-y-2" role="status">
                    <p className="font-bold">Suggested area</p>
                    {detectedLocation.accuracyTier !== 'strong' && (
                      <p className="text-amber-700">
                        {detectedLocation.accuracyTier === 'unknown'
                          ? 'Location accuracy is not available from this device — treat this as an approximate suggestion.'
                          : 'Location accuracy is low — treat this area as an approximate suggestion.'}
                      </p>
                    )}
                    {detectedLocation.county && <p>County: <strong>{detectedLocation.county}</strong></p>}
                    {detectedLocation.subCountyId ? <p>Sub-county: <strong>{foundAdministrativeUnits.find(unit => unit.id === detectedLocation.subCountyId)?.name ?? 'Please confirm'}</strong></p> : detectedLocation.county && <p>We detected your county, but couldn't reliably determine your sub-county. Please select it manually.</p>}
                    {detectedLocation.place && <p>Detected place: {detectedLocation.place}</p>}
                    {gpsAccuracy !== null && <p>GPS accuracy: approximately {Math.round(gpsAccuracy)} metres</p>}
                    {hasGeographyConflict(foundCounty, detectedLocation.county) && (
                      <p className="text-amber-700">Your selected area (<strong>{foundCounty}</strong>) differs from the detected area (<strong>{detectedLocation.county}</strong>). Using this location will replace your selection.</p>
                    )}
                    {detectedLocation.county && <div className="flex flex-wrap gap-2"><button type="button" onClick={useDetectedLocation} className="font-bold text-primary-green underline">Use this location</button><button type="button" onClick={() => setDetectedLocation(null)} className="font-bold text-ink-muted underline">Edit</button><button type="button" onClick={() => setGpsMessage('Keep your selected county, sub-county and exact place.')} className="font-bold text-ink-muted underline">Keep my selected location</button></div>}
                  </div>
                )}

              {/* REQUEST 12/26 — truthful statement of what the location is actually
                  used for. The browser supplies the coordinates; the backend also
                  exposes an advisory reverse-geocoding endpoint that GEO-C uses to
                  SUGGEST a nearby area. That suggestion is never authoritative — a
                  coordinate is not a boundary — so the app never claims to know the
                  neighbourhood ("You are around Westlands") and never shows the raw
                  coordinates back to the user. What it can honestly say is what the
                  server does: it attempts to match a real, active, vetted agent by
                  distance, and when no agent can be confidently matched the report is
                  still accepted for manual assignment rather than failing or
                  inventing a nearby agent. */}
              <p className="text-caption text-ink-muted leading-normal">
                {'The county you choose is what we use to compare your report with items lost in the same area. Your area description is what owners and agents search. If you also share your device location, Return4me uses the coordinates to look for a real active Agent near you; if none can be matched confidently, your report is still accepted and assigned by our team.'}
              </p>

            </section>
          )}

          {/* ---------------- STAGE 4 — HOW CAN WE REACH YOU? ---------------- */}
          {step === 3 && (
            <section aria-labelledby={STEP_HEADING_ID} className="space-y-5">
              <StepIntro
                headingRef={stepHeadingRef}
                title={'How can we reach you?'}
                description={'Your phone number is how the reward reaches you. The email is optional and is used for status alerts only.'}
              />


              {/* Phone Details */}
              {/* Phase 8.5 — TRUTHFULNESS: this note used to state that the number
                  is "encrypted in the ledger" and "used strictly for B2C payouts".
                  Neither is supported by the implementation: `finder_phone` is a
                  plain indexed varchar with no cipher code anywhere in the repo,
                  and it is also the finder's operational contact (admin-safe view).
                  The copy now claims only what the code can substantiate. */}
              <Input
                id="finder-phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                label={t.phonePayout}
                value={finderPhone}
                onChange={(e) => setFinderPhone(e.target.value)}
                placeholder={'e.g. 0712345678'}
                required
                hint={'Your phone number is used for your M-Pesa payout and is never shown to claimants.'}
              />

              {/* Optional Email Details */}
              <Input
                id="finder-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                label={'Email Address (Optional)'}
                value={finderEmail}
                onChange={(e) => setFinderEmail(e.target.value)}
                placeholder={'e.g. finder@gmail.com'}
                hint={'Optional email to receive status alerts about your drop-off and payout.'}
              />

              {/* Optional Finder Account signup toggle */}
              <div className="space-y-3 pt-2">
                <div className="flex items-center space-x-2">
                  <input
                    id="create-finder-account"
                    type="checkbox"
                    checked={createAccount}
                    onChange={(e) => {
                      setCreateAccount(e.target.checked);
                      if (!e.target.checked) setAgreedTerms(false);
                    }}
                    className="h-5 w-5 rounded-small border border-[var(--appearance-border-strong)] accent-[var(--appearance-primary)] cursor-pointer"
                  />
                  <label htmlFor="create-finder-account" className="text-caption text-[var(--appearance-text-primary)] font-bold select-none cursor-pointer">
                    {'Create a Return4me Finder Account with this phone number (to track history & payouts)'}
                  </label>
                </div>

                {createAccount && (
                  <div className="flex items-start space-x-2 bg-brand-beige p-3 rounded-xl border border-line-subtle fade-in">
                    <input
                      id="finder-agreed-terms"
                      type="checkbox"
                      checked={agreedTerms}
                      onChange={(e) => setAgreedTerms(e.target.checked)}
                      className="mt-1 h-5 w-5 rounded-small border border-[var(--appearance-border-strong)] accent-[var(--appearance-primary)] cursor-pointer"
                      required={createAccount}
                    />
                    <label htmlFor="finder-agreed-terms" className="text-caption text-[var(--appearance-text-muted)] leading-tight select-none cursor-pointer">
                      {'I have read and agree to the Return4me'}{' '}
                      <button
                        type="button"
                        onClick={() => (window as any).setView?.('terms')}
                        className="text-[var(--appearance-primary)] hover:underline font-bold inline"
                      >
                        {'Terms of Service'}
                      </button>{' '}
                      {'and'}{' '}
                      <button
                        type="button"
                        onClick={() => (window as any).setView?.('privacy')}
                        className="text-[var(--appearance-primary)] hover:underline font-bold inline"
                      >
                        {'Privacy Policy'}
                      </button>
                      . *
                    </label>
                  </div>
                )}
              </div>

            </section>
          )}


          {/* ---------------- STAGE 5 — REVIEW AND SUBMIT ---------------- */}
          {isLastStep && (
            <section aria-labelledby={STEP_HEADING_ID} className="space-y-5">
              <StepIntro
                headingRef={stepHeadingRef}
                title={'Check your report'}
                description={'You can go back and change anything before the report is sent.'}
              />

              <ReviewGroup
                title={'What you found'}
                editLabel={'Edit'}
                onEdit={() => goToStep(0)}
              >
                <SummaryRow
                  icon={Camera}
                  label={t.capturePhoto}
                  value={photoBase64 ? 'Photograph attached' : 'No photograph yet'}
                />
                <SummaryRow
                  label={t.categoryLabel}
                  value={selectedCategoryLabel || 'Not chosen'}
                />
              </ReviewGroup>

              <ReviewGroup
                title={'Identifying details'}
                editLabel={'Edit'}
                onEdit={() => goToStep(1)}
              >
                {isSensitiveCategory ? (
                  <>
                    <SummaryRow label={t.docNumberLabel} value={extractedNumber.trim() || 'Not provided'} />
                    <SummaryRow label={t.docNameLabel} value={extractedName.trim() || 'Not provided'} />
                  </>
                ) : (
                  <>
                    <SummaryRow label={'Item title'} value={extractedName.trim() || 'Not provided'} />
                    <SummaryRow label={'Description'} value={description.trim() || 'Not provided'} />
                  </>
                )}
              </ReviewGroup>

              <ReviewGroup
                title={'Where you found it'}
                editLabel={'Edit'}
                onEdit={() => goToStep(2)}
              >
                <SummaryRow
                  icon={MapPin}
                  label={'Place'}
                  value={[locationDescription.trim(), foundAdministrativeUnitName, foundCounty].filter(Boolean).join(', ')}
                />
                <SummaryRow
                  label={'Coordinates shared'}
                  value={latitude === null || longitude === null ? 'No' : 'Yes'}
                />
              </ReviewGroup>


              <ReviewGroup
                title={'How we reach you'}
                editLabel={'Edit'}
                onEdit={() => goToStep(3)}
              >
                <SummaryRow label={t.phonePayout} value={finderPhone.trim() || 'Not provided'} />
                <SummaryRow label={'Email'} value={finderEmail.trim() || 'Not provided'} />
                <SummaryRow
                  label={'Finder account'}
                  value={createAccount ? 'To be created' : 'Not requested'}
                />
              </ReviewGroup>

              {/* Truthful recap only: it repeats what the backend actually does
                  and promises no outcome the code cannot keep. */}
              <div className="rounded-panel border border-[var(--appearance-border)] bg-[var(--appearance-surface-muted)] p-4 sm:p-5 space-y-2">
                <h4 className="text-body-large font-semibold text-[var(--appearance-text-primary)]">
                  {'What happens next'}
                </h4>
                <ul className="space-y-1.5 text-small text-[var(--appearance-text-muted)] leading-relaxed">
                  <li>
                    {'Your report is saved with a drop-off code, and you will need that code when you hand the item to the Return4me agent.'}
                  </li>
                  <li>
                    {'If you shared your location, the coordinates are used to look for a real active Return4me Agent near you. If no Agent can be matched, our team will assign one for you.'}
                  </li>
                  <li>
                    {'Your phone number is used for your M-Pesa payout and is never shown to claimants.'}
                  </li>
                </ul>
              </div>
            </section>
          )}


          {/* ---------------- NAVIGATION ---------------- */}
          <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3 border-t border-[var(--appearance-border)] pt-5">
            {step > 0 ? (
              <Button type="button" variant="ghost" size="md" onClick={goBack} disabled={isSubmitting}>
                {'Back'}
              </Button>
            ) : (
              <span aria-hidden="true" />
            )}

            {isLastStep ? (
              <span aria-hidden="true" />
            ) : (
              <Button
                type="button"
                variant="primary"
                size="lg"
                onClick={goNext}
                disabled={isSubmitting}
                className="w-full sm:w-auto"
              >
                {'Continue'}
              </Button>
            )}
          </div>

          {/* The submit action is the workflow's ONLY submit control, so it is
              rendered on the review stage only. */}
          {isLastStep && (
            <>


              {/* Announces the in-flight submission; the visible label already
                  changes, but a focused button's name change is not reliably
                  announced (Phase 8.5). */}
              <p className="sr-only" role="status" aria-live="polite">
                {isSubmitting ? ('Submitting your report…') : ''}
              </p>

              <button
                type="submit"
                aria-busy={isSubmitting || undefined}
                disabled={isSubmitting || !photoBase64}
                className="w-full bg-accent-strong hover:bg-accent-strong-hover text-white py-3.5 rounded-2xl font-bold transition flex items-center justify-center space-x-2 shadow-lg shadow-orange-500/10 disabled:opacity-50 cursor-pointer"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="animate-spin" size={18} />
                    <span>{'Processing your submission…'}</span>
                  </>
                ) : (
                  <>
                    <span>{t.submitReport}</span>
                    <ArrowRight size={18} />
                  </>
                )}
              </button>

              {/* Disabled state previously gave no explanation — a filled-out form
                  with a grayed-out button and no photo yet looked broken. */}
              {!isSubmitting && !photoBase64 && (
                <p className="text-center text-xs text-ink-muted -mt-2">
                  {'Add a photo of the item above before you can submit.'}
                </p>
              )}
            </>
          )}

        </form>
      )}
    </div>
  );
}

/**
 * The single question a stage asks, plus its one-line explanation. The heading
 * is the focus target for a stage change, so it must exist once per render and
 * be reachable by script (tabIndex -1) while staying out of the tab order. The
 * global :focus-visible rule in src/index.css supplies the only focus
 * indicator; nothing is suppressed here.
 */
function StepIntro({
  headingRef,
  title,
  description,
}: {
  headingRef: React.Ref<HTMLHeadingElement>;
  title: string;
  description: string;
}) {
  return (
    <div>
      <h3
        id={STEP_HEADING_ID}
        ref={headingRef}
        tabIndex={-1}
        className="text-heading font-extrabold tracking-tight text-[var(--appearance-text-primary)]"
      >
        {title}
      </h3>
      <p className="mt-1.5 text-body-large text-[var(--appearance-text-muted)] leading-relaxed">{description}</p>
    </div>
  );
}

/**
 * One review group: a named part of the journey, the values recorded for it, and
 * a single edit affordance that returns to the stage those values came from. The
 * edit control is a plain button (never a submit), so the workflow still has
 * exactly one submit action.
 */
function ReviewGroup({
  title,
  editLabel,
  onEdit,
  children,
}: {
  title: string;
  editLabel: string;
  onEdit: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-panel border border-[var(--appearance-border)] bg-[var(--appearance-surface)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--appearance-border)] bg-[var(--appearance-surface-muted)] px-4 py-2.5">
        <h4 className="text-body-large font-semibold text-[var(--appearance-text-primary)]">{title}</h4>
        <Button
          type="button"
          variant="ghost"
          size="md"
          onClick={onEdit}
          /* The visible label repeats per group, so the accessible name says
             WHICH group this edit returns to. WCAG 2.5.3 still holds: the
             visible label is the first word of the accessible name. */
          aria-label={editLabel + ': ' + title}
          className="shrink-0"
        >
          {editLabel}
        </Button>
      </div>
      <dl className="divide-y divide-[var(--appearance-border)]">{children}</dl>
    </section>
  );
}

function SummaryRow({ icon: Icon, label, value }: { icon?: LucideIcon; label: string; value: string }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-3 px-4 py-3">
      {Icon ? (
        <Icon size={ICON_SIZE.metadata} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--appearance-text-muted)]" />
      ) : null}
      <dt className="w-40 shrink-0 text-caption font-bold text-[var(--appearance-text-muted)]">{label}</dt>
      <dd className="min-w-0 flex-1 text-body text-[var(--appearance-text-primary)] leading-relaxed break-words whitespace-pre-wrap">
        {value}
      </dd>
    </div>
  );
}

