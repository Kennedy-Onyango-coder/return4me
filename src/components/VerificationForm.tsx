/**
 * CATEGORY-SPECIFIC VERIFICATION FORM
 * =====================================
 *
 * Renders verification fields based on the item's category using the
 * declarative configuration in src/config/verificationProfiles.ts.
 *
 * Each category shows only the fields relevant to verifying ownership
 * of that specific item type. An ID claim will NOT ask for vehicle
 * plate number; a vehicle claim WILL.
 *
 * SECURITY: All verification answers are private and never exposed
 * in public listings, social media, or non-essential API responses.
 */

import React, { useState } from 'react';
import { translations } from '../types';
import { getVerificationFields } from '../config/verificationProfiles';
import { verificationTranslation } from '../config/verificationTranslations';
import { AlertCircle, Lock, ShieldCheck } from 'lucide-react';

interface VerificationFormProps {
  lang: 'en' | 'sw';
  categoryId: string;
  isSensitiveDocument: boolean;
  onSubmit: (answers: Record<string, string>, idProofBase64: string | null) => void;
  onBack: () => void;
  isConfident: boolean;
  setIsConfident: (val: boolean) => void;
  ownerIdentifyingDetails: string;
  setOwnerIdentifyingDetails: (val: string) => void;
  errorMsg: string;
  isVerifyingClaim: boolean;
}

export default function VerificationForm({
  lang,
  categoryId,
  isSensitiveDocument,
  onSubmit,
  onBack,
  isConfident,
  setIsConfident,
  ownerIdentifyingDetails,
  setOwnerIdentifyingDetails,
  errorMsg,
  isVerifyingClaim,
}: VerificationFormProps) {
  const t = translations[lang];
  const fields = getVerificationFields(categoryId);

  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [idProofBase64, setIdProofBase64] = useState<string | null>(null);
  const [idUploadConsent, setIdUploadConsent] = useState(false);

  const handleFieldChange = (key: string, value: string) => {
    setAnswers(prev => ({ ...prev, [key]: value }));
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      setIdProofBase64(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(answers, idProofBase64);
  };

  // Check that every required field has a non-empty value
  const requiredFieldsFilled = fields.every(field => {
    if (!field.required) return true;
    return (answers[field.key] || '').trim() !== '';
  });

  // An uploaded ID proof must not be submitted without explicit ODPC consent
  const consentRequiredWhenUploaded = idProofBase64 ? idUploadConsent : true;

  const baseInputClass = "w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm bg-brand-beige focus:outline-none focus:border-accent-orange";
  const sensitiveInputClass = `${baseInputClass} font-mono`;

  return (
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

      <form onSubmit={handleSubmit} className="space-y-4">
        {fields.map(field => {
          const label = verificationTranslation(lang, field.labelKey);
          const placeholder = verificationTranslation(lang, field.placeholderKey);
          const helpText = verificationTranslation(lang, field.helpTextKey);
          const value = answers[field.key] || '';
          const inputClass = field.sensitive ? sensitiveInputClass : baseInputClass;

          return (
            <div key={field.key} className="space-y-1">
              <label
                htmlFor={`verify-${field.key}`}
                className="block text-xs font-extrabold text-primary-green uppercase tracking-wider"
              >
                {label}{field.required ? ' *' : ''}
                {field.sensitive && (
                  <Lock size={10} className="inline ml-1 text-accent-orange" />
                )}
              </label>
              {field.type === 'textarea' ? (
                <textarea
                  id={`verify-${field.key}`}
                  value={value}
                  onChange={(e) => handleFieldChange(field.key, e.target.value)}
                  className={inputClass}
                  placeholder={placeholder}
                  rows={3}
                  required={field.required}
                  maxLength={field.maxLength}
                />
              ) : field.type === 'file' ? (
                <input
                  id={`verify-${field.key}`}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handleFileChange}
                  className="block w-full text-xs text-stone-500 file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-xs file:font-bold file:bg-orange-50 file:text-accent-orange hover:file:bg-orange-100 cursor-pointer"
                />
              ) : (
                <input
                  id={`verify-${field.key}`}
                  type={field.type === 'tel' ? 'tel' : field.type === 'email' ? 'email' : 'text'}
                  value={value}
                  onChange={(e) => handleFieldChange(field.key, e.target.value)}
                  className={inputClass}
                  placeholder={placeholder}
                  required={field.required}
                  maxLength={field.maxLength}
                />
              )}
              {helpText && (
                <p className="text-[10px] text-stone-400">{helpText}</p>
              )}
            </div>
          );
        })}

        {/* Universal identifying details — kept private, only shown to Agent at handover */}
        <div className="space-y-1.5">
          <label htmlFor="owner-identifying-details" className="block text-xs font-extrabold text-primary-green uppercase tracking-wider">
            {lang === 'sw' ? 'Maelezo ya Utambulisho (Toa 1-2)' : 'Identifying Details (Provide 1-2) *'}
          </label>
          <textarea
            id="owner-identifying-details"
            value={ownerIdentifyingDetails}
            onChange={(e) => setOwnerIdentifyingDetails(e.target.value)}
            placeholder={lang === 'sw' ? 'mfano Jina kamili, nambari ya ID, alama za kipekee' : 'E.g. Full name, ID number, or unique physical characteristics'}
            className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-xs focus:outline-none focus:border-accent-orange"
            rows={3}
            required
          />
          <p className="text-[10px] text-stone-400">
            {lang === 'sw'
              ? 'Maelezo haya yanabakiwa faragha na hutumiwa tu na Wakala kuthibitisha wewe.'
              : 'These details are kept strictly private and used solely by the Hub Agent to verify you.'}
          </p>
        </div>

        {/* Optional ID Proof upload (Tier 3) — only for sensitive documents */}
        {isSensitiveDocument && (
          <div className="space-y-1">
            <label htmlFor="owner-id-proof-upload" className="block text-xs font-extrabold text-primary-green uppercase tracking-wider">
              {lang === 'sw' ? 'Pakia Picha ya Kitambulisho (Stadi la Tier 3)' : 'Upload ID Proof Photo (Tier 3)'}
            </label>
            <input
              id="owner-id-proof-upload"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={handleFileChange}
              className="block w-full text-xs text-stone-500 file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-xs file:font-bold file:bg-orange-50 file:text-accent-orange hover:file:bg-orange-100 cursor-pointer"
            />
            {idProofBase64 && (
              <div className="space-y-2">
                <p className="text-[10px] text-emerald-600 font-semibold flex items-center space-x-1">
                  <span>✓ {lang === 'sw' ? 'Picha imepakiawa na Imehifadhiwa salama' : 'Photo uploaded and stored securely'}</span>
                </p>
                <div className="flex items-start space-x-2 bg-stone-50 p-2.5 rounded-lg border border-stone-200">
                  <input
                    id="verify-id-consent"
                    type="checkbox"
                    checked={idUploadConsent}
                    onChange={(e) => setIdUploadConsent(e.target.checked)}
                    className="mt-0.5 h-3.5 w-3.5 rounded border-stone-300 text-primary-green focus:ring-primary-green cursor-pointer"
                    required
                  />
                  <label htmlFor="verify-id-consent" className="text-[10px] text-stone-600 leading-tight select-none cursor-pointer">
                    {lang === 'sw'
                      ? 'Ninayana kwa maelezo ya kitambulisho cha kitaifa au pasipoti inachapishwa na kuhifadhiwa salama kwa kuthibitisho cha mmiliki. *'
                      : 'I explicitly consent to the processing and secure storage of my government identity card/passport for physical owner verification in accordance with ODPC standards. *'}
                  </label>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Confidence checkbox */}
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
            {lang === 'sw'
              ? 'Nathibitisha kwa uaminifu kuwa mimi ndiye mmiliki halali. *'
              : 'I am reasonably confident this is my item and not a fraudulent claim. *'}
          </label>
        </div>

        {/* Privacy notice */}
        <div className="flex items-start space-x-2 bg-sky-50/50 p-3 rounded-xl border border-sky-100">
          <ShieldCheck size={14} className="text-sky-600 mt-0.5 shrink-0" />
          <p className="text-[10px] text-sky-700">
            {lang === 'sw'
              ? 'Majibu yako ya uthibitisho ni ya faragha kamili.'
              : 'Your verification answers are completely private.'}
          </p>
        </div>

        <div className="flex space-x-3 pt-3">
          <button
            type="button"
            onClick={onBack}
            className="flex-1 bg-stone-100 hover:bg-stone-200 text-stone-700 py-3 rounded-xl font-bold transition text-xs"
          >
            {lang === 'sw' ? 'Rudi' : 'Back'}
          </button>
          <button
            type="submit"
            disabled={!isConfident || !ownerIdentifyingDetails.trim() || !requiredFieldsFilled || !consentRequiredWhenUploaded || isVerifyingClaim}
            className="flex-1 bg-accent-orange hover:bg-accent-hover text-white py-3 rounded-xl font-bold transition text-xs disabled:opacity-50 cursor-pointer flex items-center justify-center space-x-2"
          >
            {isVerifyingClaim ? (
              <span>{lang === 'sw' ? 'Inafanywa...' : 'Submitting...'}</span>
            ) : (
              <span>{t.verifySubmit}</span>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}

