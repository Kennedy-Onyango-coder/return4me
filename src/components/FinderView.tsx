import React, { useState, useRef, useEffect } from 'react';
import { translations } from '../types';
import { Camera, Upload, AlertCircle, AlertTriangle, MapPin, CheckCircle, Shield, ArrowRight, Loader2, RefreshCw } from 'lucide-react';

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
  const [latitude, setLatitude] = useState<number | null>(null);
  const [longitude, setLongitude] = useState<number | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [finderPhone, setFinderPhone] = useState('');
  const [finderEmail, setFinderEmail] = useState('');
  const [declaredValue, setDeclaredValue] = useState('');
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
    const selectedCat = categories.find(c => c.id === categoryId);
    const isSensitive = selectedCat ? (selectedCat.is_sensitive_document !== false) : (categoryId !== 'other');

    if (!categoryId || !photoBase64 || !locationDescription || !finderPhone) {
      setErrorMsg(lang === 'en' ? 'Please fill out all required fields and upload/capture a photo.' : 'Tafadhali jaza sehemu zote na uweke picha.');
      return;
    }

    if (!isSensitive && (!description || !extractedName)) {
      setErrorMsg(lang === 'en' ? 'Please provide a title and description.' : 'Tafadhali weka kichwa cha habari na maelezo.');
      return;
    }

    if (categoryId === 'other' && !description) {
      setErrorMsg(lang === 'en' ? 'Please provide a description.' : 'Tafadhali weka maelezo.');
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
          latitude,
          longitude,
          finderPhone,
          finderEmail,
          createAccount,
          termsAccepted: agreedTerms,
          description: (categoryId === 'other' || !isSensitive) ? description : undefined,
          declaredValue: declaredValue ? declaredValue : undefined,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to submit report');
      }

      setDropoffResult(data.item);
    } catch (e: any) {
      console.error(e);
      setErrorMsg(e.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Pre-loaded realistic sample document images for easy AI-assist playground testing
  return (
    <div className="max-w-3xl mx-auto px-4 py-8 fade-in">
      {/* Title */}
      <div className="text-center mb-8">
        <h1 className="text-3xl font-extrabold text-primary-green mb-2">{t.finderTitle}</h1>
        <p className="text-stone-600 text-sm max-w-xl mx-auto">{t.finderSubtitle}</p>
      </div>

      {errorMsg && (
        <div ref={errorBannerRef} className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-2xl flex items-center space-x-2.5 mb-6 text-sm">
          <AlertCircle size={18} className="shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* Success View / Handover instructions */}
      {dropoffResult ? (
        <div className="bg-white rounded-3xl border border-stone-100 p-6 md:p-8 shadow-xl text-center space-y-6">
          <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto text-emerald-600">
            <CheckCircle size={36} />
          </div>
          <div>
            <h2 className="text-2xl font-extrabold text-primary-green mb-1">{t.successReport}</h2>
            <p className="text-stone-500 text-sm">{t.dropoffInstructions}</p>
          </div>

          {/* Assigned Agent Details — or, if manual assignment is still
              pending, an honest "we're finding the right agent" message.
              assignedAgent is null whenever automatic matching couldn't
              confidently pick one — see AgentMatchingService.
              assignNearestAgent — so this must never assume it's always
              present. */}
          {dropoffResult.assignedAgent ? (
            <div className="bg-brand-beige p-5 rounded-2xl text-left border border-stone-200 space-y-3">
              <h3 className="text-xs font-extrabold text-stone-400 uppercase tracking-widest">{t.agentDetails}</h3>
              <div>
                <h4 className="text-lg font-bold text-primary-green">{dropoffResult.assignedAgent.business_name}</h4>
                <p className="text-stone-600 text-sm font-medium">{dropoffResult.assignedAgent.location_address}</p>
                <p className="text-stone-500 text-xs mt-1">Phone: {dropoffResult.assignedAgent.contact_phone}</p>
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
            <p className="text-[11px] text-stone-300">
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
            className="w-full bg-accent-orange hover:bg-accent-hover text-white py-3.5 rounded-2xl font-bold transition flex items-center justify-center space-x-2 shadow-lg shadow-orange-500/10"
          >
            <span>Report Another Item</span>
            <ArrowRight size={18} />
          </button>
        </div>
      ) : (
        /* Form View */
        <form onSubmit={submitFoundReport} className="bg-white rounded-3xl border border-stone-100 p-6 md:p-8 shadow-xl space-y-6">
          
          {/* Photo Capture Section */}
          <div className="space-y-3">
            <label className="block text-sm font-extrabold text-primary-green">{t.capturePhoto} *</label>
            
            {useCamera ? (
              <div className="relative bg-black rounded-2xl overflow-hidden aspect-video">
                <video ref={videoRef} className="w-full h-full object-cover" />
                <div className="absolute bottom-4 left-0 right-0 flex justify-center space-x-4">
                  <button
                    type="button"
                    onClick={captureFrame}
                    className="bg-accent-orange text-white px-5 py-2.5 rounded-xl font-bold text-sm shadow-lg transition hover:bg-accent-hover"
                  >
                    Capture
                  </button>
                  <button
                    type="button"
                    onClick={stopCamera}
                    className="bg-stone-800 text-white px-5 py-2.5 rounded-xl font-bold text-sm transition hover:bg-stone-700"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : photoBase64 ? (
              <div className="relative rounded-2xl overflow-hidden border border-stone-200 bg-brand-beige group aspect-video">
                <img src={photoBase64} alt="Found item document" className="w-full h-full object-contain" />
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition space-x-3">
                  <button
                    type="button"
                    onClick={startCamera}
                    className="bg-white text-primary-green p-3 rounded-full hover:bg-stone-100 shadow-md transition"
                    title="Retake camera snap"
                    aria-label="Retake camera snap"
                  >
                    <Camera size={20} />
                  </button>
                  <label className="bg-white text-primary-green p-3 rounded-full hover:bg-stone-100 shadow-md transition cursor-pointer" aria-label="Upload a photo file instead">
                    <Upload size={20} />
                    <input type="file" accept="image/*" onChange={handleFileUpload} className="hidden" />
                  </label>
                </div>
              </div>
            ) : (
              /* Capture placeholder state */
              <div className="border-2 border-dashed border-stone-200 rounded-2xl p-8 text-center bg-brand-beige hover:border-accent-orange transition space-y-4">
                <div className="w-12 h-12 bg-emerald-50 rounded-full flex items-center justify-center mx-auto text-primary-green">
                  <Camera size={24} />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-bold text-stone-700">Take a photo or upload file</p>
                  <p className="text-xs text-stone-400">Capture the ID/passport face cleanly to enable smart document detail suggestions.</p>
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
                  <label className="bg-white border border-stone-300 hover:bg-stone-50 text-stone-700 px-4 py-2 rounded-xl text-xs font-bold transition flex items-center space-x-1.5 cursor-pointer">
                    <Upload size={14} />
                    <span>{t.uploadFile}</span>
                    <input type="file" accept="image/*" onChange={handleFileUpload} className="hidden" />
                  </label>
                </div>

              </div>
            )}
            <canvas ref={canvasRef} className="hidden" />
          </div>

          {/* OCR Loading Overlay */}
          {isAnalyzing && (
            <div className="bg-brand-beige p-6 rounded-2xl text-center border border-emerald-100 flex flex-col items-center justify-center space-y-3">
              <Loader2 className="animate-spin text-accent-orange" size={28} />
              <div>
                <p className="text-sm font-bold text-primary-green">{t.analyzing}</p>
                <p className="text-xs text-stone-400 font-medium">{analysisStatus}</p>
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
                  if (e.target.value === 'other') {
                    setExtractedNumber('');
                    setExtractedName('');
                  }
                }}
                className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm bg-white focus:border-accent-orange focus:outline-none disabled:bg-stone-50 disabled:text-stone-400"
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
                        className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm bg-white font-mono focus:border-accent-orange focus:outline-none"
                        placeholder="e.g. 32904812"
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
                        className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm bg-white focus:border-accent-orange focus:outline-none"
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
                      className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm bg-white focus:border-accent-orange focus:outline-none"
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
                    className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm bg-white focus:border-accent-orange focus:outline-none"
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
                    className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm bg-white uppercase focus:border-accent-orange focus:outline-none"
                    placeholder="e.g. MWANGI KAMAU"
                  />
                </div>
              );
            }
            return null;
          })()}

          {/* Location Details & Precise GPS Matching Prompt */}
          <div className="space-y-3">
            <label htmlFor="finder-location" className="block text-xs font-extrabold text-primary-green uppercase tracking-wider">{t.locLabel} *</label>
            
            {/* GPS Precise Match Card Prompt */}
            {!latitude || !longitude ? (
              <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 space-y-3">
                <div className="flex gap-2.5">
                  <MapPin className="text-accent-orange shrink-0 mt-0.5" size={18} />
                  <div className="space-y-1">
                    <h4 className="text-xs font-bold text-stone-900 leading-none">
                      {lang === 'en' ? '📍 Enable Location for Nearest Agent Link' : '📍 Ruhusu Mahali Ulipo ili Kupata Wakala wa Karibu'}
                    </h4>
                    <p className="text-[11px] text-stone-600 leading-normal">
                      {lang === 'en' 
                        ? 'Please turn on your GPS location. This automatically matches you to the closest Return4me Agent hub for your physical drop-off, securing your payout faster.' 
                        : 'Tafadhali washa huduma ya GPS. Hii inakuunganisha moja kwa moja na Wakala wa karibu zaidi wa Return4me ili kuwasilisha hati na kupata malipo yako haraka.'}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={getCoordinates}
                  disabled={gpsLoading}
                  className="w-full bg-accent-orange hover:bg-accent-hover text-white text-xs font-bold py-2.5 px-4 rounded-xl transition flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  {gpsLoading ? (
                    <>
                      <Loader2 className="animate-spin" size={14} />
                      <span>{lang === 'en' ? 'Accessing GPS Coordinates...' : 'Tunatafuta GPS Mahali Ulipo...'}</span>
                    </>
                  ) : (
                    <>
                      <MapPin size={14} />
                      <span>{lang === 'en' ? 'Turn Location On & Link Agent' : 'Washa Mahali Ulipo na Unganisha Wakala'}</span>
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
                    {lang === 'en' ? '✓ Precise Agent Match Enabled!' : '✓ Unganisho Sahihi wa Wakala Umewashwa!'}
                  </h4>
                  <p className="text-[10px] text-emerald-700 font-mono mt-0.5 truncate">
                    GPS: {latitude.toFixed(5)}, {longitude.toFixed(5)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={getCoordinates}
                  className="text-[10px] font-bold text-emerald-800 hover:underline shrink-0"
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
                className="flex-1 border border-stone-200 rounded-xl px-3 py-2.5 text-sm bg-white focus:border-accent-orange focus:outline-none"
                placeholder={lang === 'en' ? "e.g. Near Yaya Centre, Kilimani" : "Mfano: Karibu na Yaya Centre, Kilimani"}
                required
              />
            </div>
          </div>

          {/* Phone Details */}
          <div className="space-y-2">
            <label htmlFor="finder-phone" className="block text-xs font-extrabold text-primary-green uppercase tracking-wider">{t.phonePayout} *</label>
            <input
              id="finder-phone"
              type="tel"
              value={finderPhone}
              onChange={(e) => setFinderPhone(e.target.value)}
              className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm bg-white font-mono focus:border-accent-orange focus:outline-none"
              placeholder="e.g. 0712345678"
              required
            />
            <span className="text-[10px] text-stone-400 block leading-tight">
              🔒 Privacy Assurance: Your phone number is encrypted in the ledger, used strictly for B2C payouts, and is NEVER displayed to claimants.
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
              value={finderEmail}
              onChange={(e) => setFinderEmail(e.target.value)}
              className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm bg-white font-sans focus:border-accent-orange focus:outline-none"
              placeholder="e.g. finder@gmail.com"
            />
            <span className="text-[10px] text-stone-400 block leading-tight">
              {lang === 'en' 
                ? 'Optional email to receive status alerts about your drop-off and payout.' 
                : 'Barua pepe ya hiari ili kupokea arifa za hali ya uwasilishaji na malipo yako.'}
            </span>
          </div>

          {/* Optional declared value — used only to cap the recovery fee in the owner's favour */}
          <div className="space-y-2">
            <label htmlFor="declared-value" className="block text-xs font-extrabold text-primary-green uppercase tracking-wider">
              {lang === 'en' ? 'Estimated Replacement Value, KES (Optional)' : 'Thamani ya Kubadilisha, KES (Sio Lazima)'}
            </label>
            <input
              id="declared-value"
              type="number"
              min="0"
              step="1"
              value={declaredValue}
              onChange={(e) => setDeclaredValue(e.target.value)}
              className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm bg-white font-mono focus:border-accent-orange focus:outline-none"
              placeholder="e.g. 30000"
            />
            <span className="text-[10px] text-stone-400 block leading-tight">
              {lang === 'en'
                ? "Your best guess at what this item would cost to replace. It's never verified or shown to the owner — it's only used to make sure the recovery fee never exceeds a small percentage of that value."
                : 'Makadirio yako ya gharama ya kubadilisha kitu hiki. Haitathibitishwa wala kuonyeshwa kwa mmiliki — inatumika tu kuhakikisha ada ya urejeshaji haizidi asilimia ndogo ya thamani hiyo.'}
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
              <label htmlFor="create-finder-account" className="text-xs text-stone-700 font-bold select-none cursor-pointer">
                Create a Return4me Finder Account with this phone number (to track history & payouts)
              </label>
            </div>

            {createAccount && (
              <div className="flex items-start space-x-2 bg-brand-beige p-3 rounded-xl border border-stone-100 fade-in">
                <input
                  id="finder-agreed-terms"
                  type="checkbox"
                  checked={agreedTerms}
                  onChange={(e) => setAgreedTerms(e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-stone-300 text-primary-green focus:ring-primary-green accent-primary-green cursor-pointer"
                  required={createAccount}
                />
                <label htmlFor="finder-agreed-terms" className="text-xs text-stone-600 leading-tight select-none cursor-pointer">
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
            )}
          </div>

          <button
            type="submit"
            disabled={isSubmitting || !photoBase64}
            className="w-full bg-accent-orange hover:bg-accent-hover text-white py-3.5 rounded-2xl font-bold transition flex items-center justify-center space-x-2 shadow-lg shadow-orange-500/10 disabled:opacity-50 cursor-pointer"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="animate-spin" size={18} />
                <span>Processing your submission...</span>
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
            <p className="text-center text-xs text-stone-400 -mt-2">
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
