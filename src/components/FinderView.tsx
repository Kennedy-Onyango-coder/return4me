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
import { Camera, Upload, AlertCircle, AlertTriangle, MapPin, CheckCircle, Shield, ArrowRight, Loader2, RefreshCw, X } from 'lucide-react';

// Computed once at module scope: the 47 counties, grouped by the UX-only
// former-province labels, exactly as the lost-report wizard presents them. The
// grouping is presentational only and never stored or matched (see
// config/kenyaCounties.ts).
const COUNTY_GROUPS = countiesByUxGroup();

interface FinderViewProps {
  lang: 'en' | 'sw';
  categories: any[];
  categoriesLoading?: boolean;
  categoriesError?: boolean;
}

export default function FinderView({ lang, categories, categoriesLoading = false, categoriesError = false }: FinderViewProps) {
  const t = translations[lang];
  const errorBannerRef = useRef<HTMLDivElement | null>(null);

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
  const [latitude, setLatitude] = useState<number | null>(null);
  const [longitude, setLongitude] = useState<number | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);
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
      setErrorMsg(lang === 'en' ? 'Could not access camera. Please use file upload instead.' : 'Imeshindwa kufungua kamera. Tafadhali weka picha ya faili badala yake.');
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
        
        // Auto trigger analysis if not "other" category and sensitive
        const selectedCat = categories.find(c => c.id === categoryId);
        const isSensitive = selectedCat ? (selectedCat.is_sensitive_document !== false) : (categoryId !== 'other');
        if (categoryId !== 'other' && isSensitive) {
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
        
        // Auto trigger analysis if not "other" category and sensitive
        const selectedCat = categories.find(c => c.id === categoryId);
        const isSensitive = selectedCat ? (selectedCat.is_sensitive_document !== false) : (categoryId !== 'other');
        if (categoryId !== 'other' && isSensitive) {
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
    setAnalysisStatus(lang === 'en' ? 'Return4me is preparing to scan your item...' : 'Return4me inajiandaa kuchanganua bidhaa yako...');
    setErrorMsg('');

    try {
      // Simulate real-time progress steps for a gorgeous UX
      setTimeout(() => setAnalysisStatus(lang === 'en' ? 'Reading document layout...' : 'Kusoma muundo wa hati...'), 800);
      setTimeout(() => setAnalysisStatus(lang === 'en' ? 'Extracting identity details...' : 'Kuchambua maelezo ya utambulisho...'), 1600);

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
      setErrorMsg(lang === 'en' ? 'We couldn\'t scan that automatically. Please enter the details manually below.' : 'Hatukuweza kuchanganua kiotomatiki. Tafadhali weka maelezo kwa mkono hapa chini.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Retrieve GPS Coordinates
  const getCoordinates = () => {
    setGpsLoading(true);
    setErrorMsg('');
    if (!navigator.geolocation) {
      setErrorMsg('Geolocation not supported by your browser.');
      setGpsLoading(false);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLatitude(pos.coords.latitude);
        setLongitude(pos.coords.longitude);
        setGpsLoading(false);
      },
      (err) => {
        console.error(err);
        setErrorMsg(lang === 'en' ? 'GPS permission denied. Falling back to area search.' : 'Ufikiaji wa GPS umekataliwa. Tutatumia maelezo ya eneo.');
        setGpsLoading(false);
      },
      { timeout: 10000 }
    );
  };

  // Submit complete found item report
  const submitFoundReport = async (e: React.FormEvent) => {
    e.preventDefault();
    // Defence in depth against a duplicate POST: the submit button is already
    // disabled while a submission is in flight, but the form itself is not
    // disabled, so an implicit submission (Enter inside a text field) must not
    // be able to fire a second report.
    if (isSubmitting) return;
    const selectedCat = categories.find(c => c.id === categoryId);
    const isSensitive = selectedCat ? (selectedCat.is_sensitive_document !== false) : (categoryId !== 'other');

    if (!categoryId || !photoBase64 || !locationDescription || !finderPhone) {
      setErrorMsg(lang === 'en' ? 'Please fill out all required fields and upload/capture a photo.' : 'Tafadhali jaza sehemu zote na uweke picha.');
      return;
    }

    // PHASE 9D — county is a required geographic field. This is a UX guard
    // only: the server re-validates it against the canonical 47-county list
    // with `resolveCountyName()` and is the authority. A client-side check
    // never substitutes for that.
    if (!foundCounty) {
      setErrorMsg(lang === 'en' ? 'Please choose the county where you found the item.' : 'Tafadhali chagua kaunti ulipopata kitu.');
      return;
    }

    if (!isSensitive && (!description || !extractedName)) {
      setErrorMsg(lang === 'en' ? 'Please provide a title and description.' : 'Tafadhali weka kichwa cha habari na maelezo.');
      return;
    }

    if (createAccount && !agreedTerms) {
      setErrorMsg(lang === 'en' ? 'You must agree to the Terms of Service and Privacy Policy to create an account.' : 'Ni lazima ukubali Vigezo na Masharti ili kufungua akaunti.');
      return;
    }

    if (finderEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(finderEmail)) {
      setErrorMsg(lang === 'en' ? 'Please enter a valid email address.' : 'Tafadhali weka barua pepe sahihi.');
      return;
    }

    setIsSubmitting(true);
    setErrorMsg('');

    // PHASE 8.4 — a failed submit must never render raw exception text.
    // The API's own `error` string is a user-facing message by contract (see
    // the errorDisclosure suite); a browser/network failure is not — its raw
    // text ("Failed to fetch", "Unexpected token < in JSON…") is
    // implementation detail and must not reach a public user.
    const submitErrorMessage =
      lang === 'en'
        ? 'We could not submit your report. Please check your connection and try again.'
        : 'Hatukuweza kuwasilisha ripoti yako. Tafadhali angalia muunganisho wako na ujaribu tena.';

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
                <p className="text-ink-muted text-xs mt-1">{lang === 'en' ? 'Phone' : 'Simu'}: {dropoffResult.assignedAgent.contact_phone}</p>
              </div>
            </div>
          ) : (
            <div className="bg-amber-50 p-5 rounded-2xl text-left border border-amber-200 space-y-2">
              <h3 className="text-xs font-extrabold text-amber-700 uppercase tracking-widest">
                {lang === 'en' ? 'Finding Your Agent' : 'Tunatafuta Agent Wako'}
              </h3>
              <p className="text-amber-900 text-sm font-medium">
                {lang === 'en'
                  ? "We couldn't confidently match a nearby Return4me agent automatically. Our team is finding the right one for your location and will notify you with drop-off details shortly."
                  : 'Hatukuweza kuchagua Agent wa karibu kiotomatiki kwa uhakika. Timu yetu inatafuta anayefaa eneo lako na utajulishwa maelezo ya kuwasilisha hivi karibuni.'}
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
                : (lang === 'en' ? 'Keep this code — you\'ll need it once an agent is assigned.' : 'Hifadhi msimbo huu — utahitajika mara Agent atakapopangwa.')}
            </p>
          </div>

          {/* Save-this-code warning */}
          <div className="bg-amber-50 border border-amber-300 text-amber-900 p-4 rounded-2xl text-left flex items-start space-x-3">
            <AlertTriangle size={20} className="shrink-0 mt-0.5 text-amber-600" />
            <div className="text-xs space-y-1">
              <p className="font-extrabold">
                {lang === 'sw' ? 'MUHIMU: Andika au piga picha ya msimbo huu sasa.' : 'IMPORTANT: Write down or screenshot this code now.'}
              </p>
              <p className="text-amber-800">
                {lang === 'sw'
                  ? 'Utahitaji kuutoa msimbo huu kwa wakala wa Return4me utakapopeleka bidhaa physically. Ukiupoteza, wasiliana na msaada ukitumia nambari yako ya simu ili kuurejesha.'
                  : "You will need to give this exact code to the Return4me agent when you physically drop off the item. If you lose it, contact support with your phone number to recover it."}
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
              setLocationDescription('');
              setFinderPhone('');
              setCreateAccount(false);
              setAgreedTerms(false);
            }}
            className="w-full bg-accent-strong hover:bg-accent-strong-hover text-white py-3.5 rounded-2xl font-bold transition flex items-center justify-center space-x-2 shadow-lg shadow-orange-500/10"
          >
            <span>{lang === 'en' ? 'Report Another Item' : 'Ripoti Kitu Kingine'}</span>
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
                    {lang === 'en' ? 'Capture' : 'Piga Picha'}
                  </button>
                  <button
                    type="button"
                    onClick={stopCamera}
                    className="bg-stone-800 text-white px-5 py-2.5 rounded-xl font-bold text-sm transition hover:bg-stone-700"
                  >
                    {lang === 'en' ? 'Cancel' : 'Ghairi'}
                  </button>
                </div>
              </div>
            ) : photoBase64 ? (
              <div className="relative rounded-2xl overflow-hidden border border-line-subtle bg-brand-beige aspect-video">
                <img
                  src={photoBase64}
                  alt={
                    lang === 'en'
                      ? `Photo of the ${categories.find(c => c.id === categoryId)?.name_en || 'found item'} you are reporting`
                      : `Picha ya ${categories.find(c => c.id === categoryId)?.name_sw || 'bidhaa iliyopatikana'} unayoripoti`
                  }
                  className="w-full h-full object-contain"
                />
                {/* Controls */}
              <div className="flex items-center justify-center gap-2 pb-3">
                <button
                    type="button"
                    onClick={startCamera}
                    className="bg-white text-primary-green p-2.5 rounded-full hover:bg-stone-100 shadow-md transition"
                    title={lang === 'sw' ? 'Piga picha tena' : 'Retake photo'}
                    aria-label={lang === 'sw' ? 'Piga picha tena' : 'Retake photo'}
                  >
                    <Camera size={18} />
                  </button>
                  <label className="bg-white text-primary-green p-2.5 rounded-full hover:bg-stone-100 shadow-md transition cursor-pointer" aria-label={lang === 'sw' ? 'Pakia picha' : 'Upload a photo'}>
                    <Upload size={18} />
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleFileUpload}
                      className="hidden"
                      aria-label={lang === 'sw' ? 'Pakia picha' : 'Upload a photo'}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => { setPhotoBase64(null); setExtractedName(''); setExtractedNumber(''); }}
                    className="bg-red-50 text-red-600 p-2.5 rounded-full hover:bg-red-100 shadow-md transition"
                    title={lang === 'sw' ? 'Ondoa picha' : 'Remove photo'}
                    aria-label={lang === 'sw' ? 'Ondoa picha' : 'Remove photo'}
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
                  <p className="text-sm font-bold text-ink-muted">{lang === 'en' ? 'Take a photo or upload file' : 'Piga picha au weka faili ya picha'}</p>
                  <p className="text-xs text-ink-muted">{lang === 'sw' ? 'Picha itasaidia kulinganisha ripoti yako na bidhaa zilizopotezwa na wamiliki.' : 'A clear photo helps match your report with lost items owned by others.'}</p>
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
                    <input type="file" accept="image/*" onChange={handleFileUpload} className="hidden" />
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
                  <option value="">{lang === 'en' ? 'Loading categories...' : 'Inapakia kategoria...'}</option>
                ) : categoriesError ? (
                  <option value="">{lang === 'en' ? 'Categories unavailable — please refresh' : 'Kategoria hazipatikani - tafadhali pakia upya'}</option>
                ) : (
                  (() => {
                    const validCategories = categories.filter(cat => cat.name_en && cat.name_sw);
                    const invalidCount = categories.length - validCategories.length;
                    if (invalidCount > 0) {
                      console.warn(`[FinderView] Filtered out ${invalidCount} incomplete categories from rendering.`);
                    }
                    return [
                      <option key="select-category" value="">{lang === 'en' ? '-- Select Category --' : '-- Chagua Kategoria --'}</option>,
                      ...validCategories.map(cat => (
                        <option key={cat.id} value={cat.id}>
                          {lang === 'en' ? cat.name_en : cat.name_sw} (Fee: KES {cat.total_fee})
                        </option>
                      ))
                    ];
                  })()
                )}
              </select>
            </div>

            {(() => {
              const selectedCat = categories.find(c => c.id === categoryId);
              const isSensitive = selectedCat ? (selectedCat.is_sensitive_document !== false) : (categoryId !== 'other');
              if (isSensitive) {
                if (categoryId !== 'other') {
                  return (
                    <div className="space-y-2">
                      <label htmlFor="finder-doc-number" className="block text-xs font-extrabold text-primary-green uppercase tracking-wider">{t.docNumberLabel}</label>
                      <input
                        id="finder-doc-number"
                        type="text"
                        value={extractedNumber}
                        onChange={(e) => setExtractedNumber(e.target.value)}
                        className="w-full border border-line-subtle rounded-xl px-3 py-2.5 text-sm bg-white font-mono focus:border-accent-orange focus:outline-none"
                        placeholder={lang === 'en' ? 'e.g. 32904812' : 'Mfano: 32904812'}
                      />
                    </div>
                  );
                } else {
                  return (
                    <div className="space-y-2">
                      <label htmlFor="finder-description" className="block text-xs font-extrabold text-primary-green uppercase tracking-wider">
                        {lang === 'en' ? 'Item Description *' : 'Maelezo ya Bidhaa *'}
                      </label>
                      <input
                        id="finder-description"
                        type="text"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        className="w-full border border-line-subtle rounded-xl px-3 py-2.5 text-sm bg-white focus:border-accent-orange focus:outline-none"
                        placeholder={lang === 'en' ? 'What it is, distinguishing features' : 'Ni nini, sifa zake maalum'}
                        required
                      />
                    </div>
                  );
                }
              } else {
                return (
                  <div className="space-y-2">
                    <label htmlFor="finder-description" className="block text-xs font-extrabold text-primary-green uppercase tracking-wider">
                      {lang === 'en' ? 'Item Description *' : 'Maelezo ya Bidhaa *'}
                    </label>
                    <input
                      id="finder-description"
                      type="text"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      className="w-full border border-line-subtle rounded-xl px-3 py-2.5 text-sm bg-white focus:border-accent-orange focus:outline-none"
                      placeholder={lang === 'en' ? 'e.g. Black leather with silver ring' : 'Mfano: Ngozi nyeusi yenye pete ya fedha'}
                      required
                    />
                  </div>
                );
              }
            })()}
          </div>

          {(() => {
            const selectedCat = categories.find(c => c.id === categoryId);
            const isSensitive = selectedCat ? (selectedCat.is_sensitive_document !== false) : (categoryId !== 'other');
            if (!isSensitive) {
              return (
                <div className="space-y-2">
                  <label htmlFor="finder-item-name" className="block text-xs font-extrabold text-primary-green uppercase tracking-wider">
                    {lang === 'en' ? 'Item Title (e.g. Keychain, Phone) *' : 'Kichwa cha Bidhaa *'}
                  </label>
                  <input
                    id="finder-item-name"
                    type="text"
                    value={extractedName}
                    onChange={(e) => setExtractedName(e.target.value)}
                    className="w-full border border-line-subtle rounded-xl px-3 py-2.5 text-sm bg-white focus:border-accent-orange focus:outline-none"
                    placeholder={lang === 'en' ? 'e.g. Black Keychain' : 'Mfano: Mnyororo mweusi wa funguo'}
                    required
                  />
                </div>
              );
            } else if (categoryId !== 'other') {
              return (
                <div className="space-y-2">
                  <label htmlFor="finder-item-name" className="block text-xs font-extrabold text-primary-green uppercase tracking-wider">{t.docNameLabel}</label>
                  <input
                    id="finder-item-name"
                    type="text"
                    value={extractedName}
                    onChange={(e) => setExtractedName(e.target.value)}
                    className="w-full border border-line-subtle rounded-xl px-3 py-2.5 text-sm bg-white uppercase focus:border-accent-orange focus:outline-none"
                    placeholder={lang === 'en' ? 'e.g. MWANGI KAMAU' : 'Mfano: MWANGI KAMAU'}
                  />
                </div>
              );
            }
            return null;
          })()}

          {/* Analysis results are pre-fill suggestions the finder can correct.
              The scan reads the image; it does not verify ownership, identity
              or authenticity — so the person reporting must review it. */}
          {photoBase64 && !isAnalyzing && (extractedNumber || extractedName) && (
            <p className="text-caption text-ink-muted leading-normal">
              {lang === 'en'
                ? 'Please check the details above and correct anything the scan got wrong.'
                : 'Tafadhali angalia maelezo hapo juu na urekebishe yoyote ambayo uchanganuzi ulikosea.'}
            </p>
          )}

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
            <div className="space-y-1.5">
              <label htmlFor="finder-county" className="block text-xs font-extrabold text-primary-green uppercase tracking-wider">
                {lang === 'en' ? 'County where you found it' : 'Kaunti ulipopata kitu'} *
              </label>
              <select
                id="finder-county"
                value={foundCounty}
                onChange={(e) => setFoundCounty(e.target.value)}
                className="w-full border border-line-subtle rounded-xl px-3 py-2.5 text-sm bg-white focus:border-accent-orange focus:outline-none"
                required
                disabled={isSubmitting}
                aria-describedby="finder-county-hint"
              >
                <option value="">{lang === 'en' ? 'Select a county' : 'Chagua kaunti'}</option>
                {COUNTY_GROUPS.map((group) => (
                  <optgroup key={group.group} label={group.group}>
                    {group.counties.map((county) => (
                      <option key={county.code} value={county.name}>
                        {county.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <span id="finder-county-hint" className="text-caption text-ink-muted block leading-tight">
                {lang === 'en'
                  ? 'We use this to compare your report with items lost in the same county.'
                  : 'Tunatumia hii kulinganisha ripoti yako na vitu vilivyopotea katika kaunti moja.'}
              </span>
            </div>

            <label htmlFor="finder-location" className="block text-xs font-extrabold text-primary-green uppercase tracking-wider">{t.locLabel} *</label>
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
                      {lang === 'en' ? 'Help Us Match an Agent' : 'Tusaidie Kupata Wakala'}
                    </h4>
                    <p className="text-caption text-ink-muted leading-normal">
                      {lang === 'en'
                        ? 'Turning on your location can help us match your report to a nearby available Return4me Agent hub for your drop-off. If no Agent can be matched, our team will assign one for you.'
                        : 'Kuwasha mahali ulipo kunaweza kutusaidia kulinganisha ripoti yako na Wakala wa Return4me aliye karibu na anayepatikana kwa kuwasilisha. Iwapo Wakala hapatikani, timu yetu itakupangia mmoja.'}
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
                      <span>{lang === 'en' ? 'Accessing GPS Coordinates...' : 'Tunatafuta GPS Mahali Ulipo...'}</span>
                    </>
                  ) : (
                    <>
                      <MapPin size={14} />
                      <span>{lang === 'en' ? 'Turn Location On' : 'Washa Mahali Ulipo'}</span>
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
                    {lang === 'en' ? 'Location Captured' : 'Mahali Pamehifadhiwa'}
                  </h4>
                  <p className="text-caption text-emerald-700 mt-0.5">
                    {lang === 'en'
                      ? 'Your location has been captured and can help us match your report to a nearby available Return4me Agent hub. If no Agent can be matched, our team will assign one for you.'
                      : 'Mahali ulipo pamehifadhiwa na kunaweza kutusaidia kulinganisha ripoti yako na Wakala wa Return4me aliye karibu na anayepatikana. Iwapo Wakala hapatikani, timu yetu itakupangia mmoja.'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={getCoordinates}
                  className="text-caption font-bold text-emerald-800 hover:underline shrink-0"
                >
                  {lang === 'en' ? 'Update' : 'Sasisha'}
                </button>
              </div>
            )}

            <div className="flex gap-2">
              <input
                id="finder-location"
                type="text"
                value={locationDescription}
                onChange={(e) => setLocationDescription(e.target.value)}
                className="flex-1 border border-line-subtle rounded-xl px-3 py-2.5 text-sm bg-white focus:border-accent-orange focus:outline-none"
                placeholder={lang === 'en' ? 'e.g. Near Sarit Centre, Westlands' : 'Mfano: Karibu na Sarit Centre, Westlands'}
                required
                aria-describedby="finder-location-hint"
              />
            </div>
            {/* P14C-3A — the exact place is the Finder's OWN words, stored
                verbatim in items.location_description. The hint says what to
                type; it promises nothing about automatic identification,
                matching, speed or payout, and it invents no vocabulary. */}
            <span id="finder-location-hint" className="text-caption text-ink-muted block leading-tight">
              {lang === 'en'
                ? 'Enter the street, estate, building, landmark or nearby place you know.'
                : 'Weka barabara, mtaa, jengo, alama ya eneo au mahali pengine unapojua.'}
            </span>
          </div>

          {/* REQUEST 12/26 — truthful statement of what the location is actually
              used for. The browser supplies coordinates only; there is no
              reverse geocoding in this backend, so the app never claims to know
              the neighbourhood ("You are around Westlands") and never shows the
              raw coordinates back to the user. What it can honestly say is what
              the server does: it attempts to match a real, active, vetted agent
              by distance, and when no agent can be confidently matched the
              report is still accepted for manual assignment rather than failing
              or inventing a nearby agent. */}
          <p className="text-caption text-ink-muted leading-normal">
            {lang === 'en'
              ? 'The county you choose is what we use to compare your report with items lost in the same area. Your area description is what owners and agents search. If you also share your device location, Return4me uses the coordinates to look for a real active Agent near you; if none can be matched confidently, your report is still accepted and assigned by our team.'
              : 'Kaunti unayochagua ndiyo tunayotumia kulinganisha ripoti yako na vitu vilivyopotea eneo moja. Maelezo ya eneo lako ndiyo yanayotafutwa na wamiliki na mawakala. Ukishiriki pia mahali ulipo kwenye kifaa, Return4me hutumia viwianishi kutafuta Wakala halisi aliye karibu nawe; ikiwa hakuna anayeweza kulinganishwa kwa uhakika, ripoti yako bado inakubaliwa na kupangwa na timu yetu.'}
          </p>

          {/* Phone Details */}
          <div className="space-y-2">
            <label htmlFor="finder-phone" className="block text-xs font-extrabold text-primary-green uppercase tracking-wider">{t.phonePayout} *</label>
            <input
              id="finder-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={finderPhone}
              onChange={(e) => setFinderPhone(e.target.value)}
              className="w-full border border-line-subtle rounded-xl px-3 py-2.5 text-sm bg-white font-mono focus:border-accent-orange focus:outline-none"
              placeholder={lang === 'en' ? 'e.g. 0712345678' : 'Mfano: 0712345678'}
              required
            />
            {/* Phase 8.5 — TRUTHFULNESS: this note used to state that the number
                is "encrypted in the ledger" and "used strictly for B2C payouts".
                Neither is supported by the implementation: `finder_phone` is a
                plain indexed varchar with no cipher code anywhere in the repo,
                and it is also the finder's operational contact (admin-safe view).
                The copy now claims only what the code can substantiate. */}
            <span className="text-caption text-ink-muted block leading-tight">
              {lang === 'en'
                ? 'Your phone number is used for your M-Pesa payout and is never shown to claimants.'
                : 'Nambari yako ya simu inatumika kwa malipo yako ya M-Pesa na haionyeshwi kwa wadai.'}
            </span>
          </div>

          {/* Optional Email Details */}
          <div className="space-y-2">
            <label htmlFor="finder-email" className="block text-xs font-extrabold text-primary-green uppercase tracking-wider">
              {lang === 'en' ? 'Email Address (Optional)' : 'Barua Pepe (Sio Lazima)'}
            </label>
            <input
              id="finder-email"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={finderEmail}
              onChange={(e) => setFinderEmail(e.target.value)}
              className="w-full border border-line-subtle rounded-xl px-3 py-2.5 text-sm bg-white font-sans focus:border-accent-orange focus:outline-none"
              placeholder={lang === 'en' ? 'e.g. finder@gmail.com' : 'Mfano: finder@gmail.com'}
            />
            <span className="text-caption text-ink-muted block leading-tight">
              {lang === 'en' 
                ? 'Optional email to receive status alerts about your drop-off and payout.' 
                : 'Barua pepe ya hiari ili kupokea arifa za hali ya uwasilishaji na malipo yako.'}
            </span>
          </div>

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
                className="h-4 w-4 rounded border-stone-300 text-primary-green focus:ring-primary-green accent-primary-green cursor-pointer"
              />
              <label htmlFor="create-finder-account" className="text-xs text-ink-muted font-bold select-none cursor-pointer">
                {lang === 'en'
                  ? 'Create a Return4me Finder Account with this phone number (to track history & payouts)'
                  : 'Fungua Akaunti ya Msingi wa Return4me kwa nambari hii ya simu (kufuatilia historia na malipo)'}
              </label>
            </div>

            {createAccount && (
              <div className="flex items-start space-x-2 bg-brand-beige p-3 rounded-xl border border-line-subtle fade-in">
                <input
                  id="finder-agreed-terms"
                  type="checkbox"
                  checked={agreedTerms}
                  onChange={(e) => setAgreedTerms(e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-stone-300 text-primary-green focus:ring-primary-green accent-primary-green cursor-pointer"
                  required={createAccount}
                />
                <label htmlFor="finder-agreed-terms" className="text-xs text-ink-muted leading-tight select-none cursor-pointer">
                  {lang === 'en' ? 'I have read and agree to the Return4me' : 'Nimesoma na nakubali'}{' '}
                  <button
                    type="button"
                    onClick={() => (window as any).setView?.('terms')}
                    className="text-primary-green hover:underline font-bold inline focus:outline-none"
                  >
                    {lang === 'en' ? 'Terms of Service' : 'Vigezo na Masharti'}
                  </button>{' '}
                  {lang === 'en' ? 'and' : 'na'}{' '}
                  <button
                    type="button"
                    onClick={() => (window as any).setView?.('privacy')}
                    className="text-primary-green hover:underline font-bold inline focus:outline-none"
                  >
                    {lang === 'en' ? 'Privacy Policy' : 'Sera ya Faragha'}
                  </button>
                  . *
                </label>
              </div>
            )}
          </div>

          {/* Announces the in-flight submission; the visible label already
              changes, but a focused button's name change is not reliably
              announced (Phase 8.5). */}
          <p className="sr-only" role="status" aria-live="polite">
            {isSubmitting ? (lang === 'en' ? 'Submitting your report…' : 'Inawasilisha ripoti yako…') : ''}
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
                <span>{lang === 'en' ? 'Processing your submission…' : 'Inashughulikia uwasilishaji wako…'}</span>
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
              {lang === 'sw'
                ? 'Weka picha ya bidhaa hapo juu ili uweze kuwasilisha.'
                : 'Add a photo of the item above before you can submit.'}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
