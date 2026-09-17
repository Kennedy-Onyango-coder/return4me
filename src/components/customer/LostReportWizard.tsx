import React, { useMemo, useState } from 'react';
import { AlertCircle, Check, MapPin, Package } from 'lucide-react';
import { Banner, Button, Input, Select, Stepper, Textarea } from '../ui';
import { countiesByUxGroup } from '../../config/kenyaCounties';
import {
  LOST_REPORT_FIELD_LIMITS,
  LOST_REPORT_FIELD_MINIMUMS,
  LOST_REPORT_IDENTIFIER_CLASSES,
  LOST_REPORT_MAX_WINDOW_DAYS,
  LOST_REPORT_WIZARD_STEPS,
  identifierClassForCategory,
} from '../../config/lostReportPresentation';
import {
  createLostReport,
  type LostReportCreatePayload,
  type LostReportsApiErrorKind,
} from '../../services/lostReportsApi';

// ===========================================================================
// LOST-REPORT WIZARD (Phase 9C)
// ===========================================================================
// Four bounded steps that mirror the server contract in routes/lostReports.ts:
//  1. What was lost   — category (+ an optional identifier, hashed server-side)
//  2. Describe it     — brand / model / colour / material / notes
//  3. Where and when  — county, area, landmark, and a lost TIME WINDOW
//  4. Review          — a plain summary, then submit
//
// WHAT THIS FORM DOES NOT DO
//  * It never sends a customer id or any contact detail. The report is bound to
//    the authenticated session server-side, and the account's own verified
//    number is the contact.
//  * It never claims a field is required that the server treats as optional,
//    and it never invents a requirement the server does not have. Only the
//    fields the server rejects when empty (category, county, area, lost-from)
//    are required here.
//  * It never states a recovery outcome. Submitting a report starts a search
//    for possible matches; it does not guarantee anything.
//
// The server remains the ONLY authority on validation. The `maxLength` values
// and the local checks below exist so a customer is not made to submit a form
// the server will simply reject; every rule is re-checked server-side.
//
// NO INLINE DOCUMENT NUMBER IS EVER ECHOED BACK, including in the review step:
// the summary shows that an identifier was added and its class, never the value.

interface Props {
  lang: 'en' | 'sw';
  categories: any[];
  categoriesLoading: boolean;
  onCancel: () => void;
  /** Fired with the new public reference after a successful submission. */
  onCreated: (reference: string) => void;
}

interface FormState {
  categoryId: string;
  documentType: string;
  documentNumber: string;
  brand: string;
  model: string;
  colour: string;
  material: string;
  description: string;
  distinctiveMarks: string;
  county: string;
  locationArea: string;
  locationLandmark: string;
  lostAtFrom: string;
  lostAtTo: string;
}

const EMPTY_FORM: FormState = {
  categoryId: '',
  documentType: '',
  documentNumber: '',
  brand: '',
  model: '',
  colour: '',
  material: '',
  description: '',
  distinctiveMarks: '',
  county: '',
  locationArea: '',
  locationLandmark: '',
  lostAtFrom: '',
  lostAtTo: '',
};

/** `YYYY-MM-DDTHH:mm` in the customer's own timezone, for <input type="datetime-local">. */
function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Converts a datetime-local value to the ISO instant the API expects.
 * A local value with no offset is parsed as LOCAL time by `new Date`, so the
 * instant the customer picked is the instant that is sent — no silent UTC
 * reinterpretation.
 */
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date.toISOString();
}

/** The server's own past limit (five years), mirrored as an input `min`. */
const MIN_LOST_AT = (() => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 5);
  return d;
})();

/**
 * Per-step validation, mirroring the SERVER's required fields exactly:
 * category, county, area and lost-from are required there; everything else in
 * this form is optional there and therefore optional here. Returns a bilingual
 * message, or null when the step may advance.
 */
function validateStep(step: number, form: FormState, t: (en: string, sw: string) => string): string | null {
  if (step === 0) {
    if (!form.categoryId) {
      return t('Please choose what was lost.', 'Tafadhali chagua kilichopotea.');
    }
    return null;
  }

  // Step 1 is entirely optional, exactly as the server treats it. Requiring
  // something here would be inventing a rule the API does not have.
  if (step === 1) return null;

  if (step === 2) {
    if (!form.county) {
      return t('Please choose the county where you lost it.', 'Tafadhali chagua kaunti ulipopoteza.');
    }
    const area = form.locationArea.trim();
    if (area.length < LOST_REPORT_FIELD_MINIMUMS.locationArea) {
      return t('Please enter the town or area where you lost it.', 'Tafadhali weka mji au eneo ulipopoteza.');
    }
    if (area.length > LOST_REPORT_FIELD_LIMITS.locationArea) {
      return t(
        `Please shorten the town or area to ${LOST_REPORT_FIELD_LIMITS.locationArea} characters or fewer.`,
        `Tafadhali fupisha mji au eneo hadi herufi ${LOST_REPORT_FIELD_LIMITS.locationArea} au chini.`
      );
    }

    if (!form.lostAtFrom) {
      return t('Please tell us roughly when you lost it.', 'Tafadhali tuambie takriban ulipoteza lini.');
    }
    const fromIso = localInputToIso(form.lostAtFrom);
    if (!fromIso) {
      return t('That date and time is not valid.', 'Tarehe na saa hiyo si sahihi.');
    }
    const now = Date.now();
    const from = new Date(fromIso).getTime();
    if (from > now) {
      return t('The time you lost it cannot be in the future.', 'Muda uliopoteza hauwezi kuwa baadaye.');
    }

    if (form.lostAtTo) {
      const toIso = localInputToIso(form.lostAtTo);
      if (!toIso) {
        return t('That end time is not valid.', 'Muda wa mwisho si sahihi.');
      }
      const to = new Date(toIso).getTime();
      if (to < from) {
        return t(
          'The end of the window has to come after the start.',
          'Mwisho wa kipindi lazima uwe baada ya mwanzo.'
        );
      }
      if (to > now) {
        return t('The end of the window cannot be in the future.', 'Mwisho wa kipindi hauwezi kuwa baadaye.');
      }
      if (to - from > LOST_REPORT_MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
        // Plain, non-technical: no engine tolerance is disclosed.
        return t(
          'Please choose a window of about a month or less — for example, between 2pm and 5pm on the same day.',
          'Tafadhali chagua kipindi cha takriban mwezi mmoja au chini — kwa mfano, kati ya saa 8 na saa 11 jioni siku hiyo hiyo.'
        );
      }
    }
    return null;
  }

  return null;
}

/** Maps a submission failure to restrained, non-technical copy. */
function submitErrorCopy(
  kind: LostReportsApiErrorKind | undefined,
  serverMessage: string | undefined,
  t: (en: string, sw: string) => string,
): string {
  switch (kind) {
    case 'auth':
      return t(
        'Your session has ended. Please sign in again, then submit your report.',
        'Kipindi chako kimeisha. Tafadhali ingia tena, kisha tuma ripoti yako.'
      );
    case 'forbidden':
      return t(
        'This account cannot submit a report right now. Please contact support.',
        'Akaunti hii haiwezi kutuma ripoti kwa sasa. Tafadhali wasiliana na usaidizi.'
      );
    case 'rate_limited':
      return t(
        'You have submitted several reports recently. Please wait a few minutes and try again.',
        'Umetuma ripoti kadhaa hivi karibuni. Tafadhali subiri dakika chache kisha ujaribu tena.'
      );
    case 'validation':
      // The server's own bilingual explanation is already customer-safe
      // (routes/lostReports.ts never returns an internal error).
      return serverMessage || t(
        'Some details were not accepted. Please check them and try again.',
        'Baadhi ya maelezo hayakukubaliwa. Tafadhali yahakiki kisha ujaribu tena.'
      );
    default:
      return t(
        'We could not submit your report. Please try again.',
        'Imeshindwa kutuma ripoti yako. Tafadhali jaribu tena.'
      );
  }
}

export default function LostReportWizard({
  lang, categories, categoriesLoading, onCancel, onCreated,
}: Props) {
  const sw = lang === 'sw';
  const t = (en: string, swText: string) => (sw ? swText : en);

  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [stepError, setStepError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const countyGroups = useMemo(() => countiesByUxGroup(), []);

  /**
   * Choosing a category also preselects the matching identifier class when the
   * category IS one (a lost national ID is identified by a national-ID number).
   * It never overwrites a class the customer already chose by hand.
   */
  const handleCategoryChange = (categoryId: string) => {
    setForm((prev) => {
      const preset = identifierClassForCategory(categoryId);
      const choseByHand = prev.documentType && prev.documentType !== identifierClassForCategory(prev.categoryId);
      return { ...prev, categoryId, documentType: choseByHand ? prev.documentType : (preset || '') };
    });
  };

  const goNext = () => {
    const error = validateStep(step, form, t);
    if (error) { setStepError(error); return; }
    setStepError(null);
    setStep((s) => Math.min(s + 1, LOST_REPORT_WIZARD_STEPS.length - 1));
  };

  const goBack = () => {
    setStepError(null);
    if (step === 0) { onCancel(); return; }
    setStep((s) => Math.max(s - 1, 0));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    // Re-validate every step before sending: the customer may have gone back.
    for (let s = 0; s <= 2; s++) {
      const error = validateStep(s, form, t);
      if (error) { setStep(s); setStepError(error); return; }
    }

    // Only non-empty optionals are sent; the server treats omitted and empty
    // identically and stores NULL either way.
    const payload: LostReportCreatePayload = {
      categoryId: form.categoryId,
      county: form.county,
      locationArea: form.locationArea.trim(),
      locationLandmark: form.locationLandmark.trim() || null,
      lostAtFrom: localInputToIso(form.lostAtFrom) as string,
      lostAtTo: localInputToIso(form.lostAtTo),
      brand: form.brand.trim() || null,
      model: form.model.trim() || null,
      colour: form.colour.trim() || null,
      material: form.material.trim() || null,
      description: form.description.trim() || null,
      distinctiveMarks: form.distinctiveMarks.trim() || null,
      documentType: form.documentType || null,
      documentNumber: form.documentNumber.trim() || null,
    };

    setSubmitting(true);
    const result = await createLostReport(payload);
    setSubmitting(false);

    if (result.ok && result.data) {
      onCreated(result.data.reference);
      return;
    }
    setSubmitError(submitErrorCopy(result.error?.kind, result.error?.message, t));
  };

  const stepperSteps = LOST_REPORT_WIZARD_STEPS.map((s) => ({ label: sw ? s.sw : s.en }));
  const nowLocal = toLocalInputValue(new Date());
  const minLocal = toLocalInputValue(MIN_LOST_AT);
  const isLastStep = step === LOST_REPORT_WIZARD_STEPS.length - 1;

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-6">
      <Stepper
        steps={stepperSteps}
        currentStep={step}
        label={t('Report a lost item progress', 'Maendeleo ya kuripoti kitu kilichopotea')}
      />

      {stepError && <Banner kind="error">{stepError}</Banner>}
      {submitError && <Banner kind="error">{submitError}</Banner>}

      {/* ---------------- STEP 1 — WHAT WAS LOST ---------------- */}
      {step === 0 && (
        <div className="space-y-5">
          <div>
            <h3 className="text-sm font-extrabold text-brand-dark-text">
              {t('What did you lose?', 'Ulipoteza nini?')}
            </h3>
            <p className="mt-1 text-xs text-brand-muted-text leading-relaxed">
              {t(
                'Choose the closest match. It is how we compare your report with found items of the same kind.',
                'Chagua kinachokaribiana zaidi. Ni jinsi tunavyolinganisha ripoti yako na vitu vilivyopatikana vya aina hiyo.'
              )}
            </p>
          </div>

          <Select
            label={t('Item category', 'Aina ya kitu')}
            required
            value={form.categoryId}
            onChange={(e) => handleCategoryChange(e.target.value)}
            disabled={categoriesLoading || submitting}
          >
            <option value="">
              {categoriesLoading
                ? t('Loading categories…', 'Inapakia aina…')
                : t('Select a category', 'Chagua aina')}
            </option>
            {(categories || []).map((c: any) => (
              <option key={c.id} value={c.id}>
                {(sw ? c.name_sw : c.name_en) || c.name_en || c.id}
              </option>
            ))}
          </Select>

          {form.categoryId && (
            <fieldset className="space-y-4 rounded-xl border border-brand-border p-4">
              <legend className="px-1 text-xs font-extrabold uppercase tracking-widest text-brand-muted-text">
                {t('Identifying number (optional)', 'Namba ya utambulisho (si lazima)')}
              </legend>
              <p className="text-xs text-brand-muted-text leading-relaxed">
                {t(
                  'If the item has a document, card or serial number, adding it makes an exact match far more likely.',
                  'Kama kitu kina namba ya hati, kadi au serial, kuiweka huongeza sana uwezekano wa mechi kamili.'
                )}
              </p>

              <Select
                label={t('What kind of number is it?', 'Ni namba ya aina gani?')}
                value={form.documentType}
                onChange={(e) => set('documentType', e.target.value)}
                disabled={submitting}
              >
                <option value="">{t('Not sure / prefer not to say', 'Sijui / sipendi kusema')}</option>
                {LOST_REPORT_IDENTIFIER_CLASSES.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {sw ? entry.sw : entry.en}
                  </option>
                ))}
              </Select>

              <Input
                label={t('The number', 'Namba yenyewe')}
                type="text"
                inputMode="text"
                autoComplete="off"
                maxLength={LOST_REPORT_FIELD_LIMITS.documentNumber}
                value={form.documentNumber}
                onChange={(e) => set('documentNumber', e.target.value)}
                disabled={submitting}
                placeholder={t('e.g. 12345678', 'mfano 12345678')}
                hint={t(
                  'Stored only as a one-way fingerprint. It is never shown back to you, to a finder, or to an agent.',
                  'Huhifadhiwa kama alama ya njia moja pekee. Haionyeshwi kwako, kwa aliyekipata, wala kwa wakala.'
                )}
              />
            </fieldset>
          )}
        </div>
      )}

      {/* ---------------- STEP 2 — DESCRIBE IT ---------------- */}
      {step === 1 && (
        <div className="space-y-5">
          <div>
            <h3 className="text-sm font-extrabold text-brand-dark-text">
              {t('Describe the item', 'Eleza kitu')}
            </h3>
            <p className="mt-1 text-xs text-brand-muted-text leading-relaxed">
              {t(
                'Everything here is optional. The more detail you give, the easier it is to tell your item apart from similar ones.',
                'Kila kitu hapa si lazima. Ukitoa maelezo zaidi, ni rahisi kutofautisha kitu chako na vingine vinavyofanana.'
              )}
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label={t('Brand (optional)', 'Chapa (si lazima)')}
              value={form.brand}
              onChange={(e) => set('brand', e.target.value)}
              maxLength={LOST_REPORT_FIELD_LIMITS.brand}
              disabled={submitting}
              placeholder={t('e.g. Samsung', 'mfano Samsung')}
            />
            <Input
              label={t('Model (optional)', 'Modeli (si lazima)')}
              value={form.model}
              onChange={(e) => set('model', e.target.value)}
              maxLength={LOST_REPORT_FIELD_LIMITS.model}
              disabled={submitting}
              placeholder={t('e.g. Galaxy A54', 'mfano Galaxy A54')}
            />
            <Input
              label={t('Colour (optional)', 'Rangi (si lazima)')}
              value={form.colour}
              onChange={(e) => set('colour', e.target.value)}
              maxLength={LOST_REPORT_FIELD_LIMITS.colour}
              disabled={submitting}
              placeholder={t('e.g. Black', 'mfano Nyeusi')}
            />
            <Input
              label={t('Material (optional)', 'Nyenzo (si lazima)')}
              value={form.material}
              onChange={(e) => set('material', e.target.value)}
              maxLength={LOST_REPORT_FIELD_LIMITS.material}
              disabled={submitting}
              placeholder={t('e.g. Leather', 'mfano Ngozi')}
            />
          </div>

          <Textarea
            label={t('Description (optional)', 'Maelezo (si lazima)')}
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            maxLength={LOST_REPORT_FIELD_LIMITS.description}
            disabled={submitting}
            placeholder={t(
              'e.g. Brown leather wallet, worn on one corner, contains a bank card',
              'mfano Pochi ya ngozi ya kahawia, imechakaa kona moja, ina kadi ya benki'
            )}
            hint={t(
              'You do not need to include passwords, PINs or account numbers.',
              'Hakuna haja ya kuweka nywila, PIN au namba za akaunti.'
            )}
          />

          <Textarea
            label={t('Distinctive marks (optional)', 'Alama za kipekee (si lazima)')}
            value={form.distinctiveMarks}
            onChange={(e) => set('distinctiveMarks', e.target.value)}
            maxLength={LOST_REPORT_FIELD_LIMITS.distinctiveMarks}
            disabled={submitting}
            placeholder={t('e.g. A lion sticker on the front pocket', 'mfano Stika ya simba mbele ya mfuko')}
            hint={t(
              'Details most people would not notice help us avoid incorrect matches.',
              'Maelezo ambayo watu wengi hawangetambua husaidia kuepuka mechi zisizo sahihi.'
            )}
          />
        </div>
      )}

      {/* ---------------- STEP 3 — WHERE AND WHEN ---------------- */}
      {step === 2 && (
        <div className="space-y-5">
          <div>
            <h3 className="text-sm font-extrabold text-brand-dark-text">
              {t('Where and when did you lose it?', 'Ulipopoteza na lini?')}
            </h3>
            <p className="mt-1 text-xs text-brand-muted-text leading-relaxed">
              {t(
                'A rough answer is fine. This is used to compare your report with items found in the same area and around the same time.',
                'Jibu la kukisia linatosha. Hili hutumika kulinganisha ripoti yako na vitu vilivyopatikana eneo moja na wakati huo huo.'
              )}
            </p>
          </div>

          <Select
            label={t('County', 'Kaunti')}
            required
            value={form.county}
            onChange={(e) => set('county', e.target.value)}
            disabled={submitting}
          >
            <option value="">{t('Select a county', 'Chagua kaunti')}</option>
            {countyGroups.map((group) => (
              <optgroup key={group.group} label={group.group}>
                {group.counties.map((county) => (
                  <option key={county.code} value={county.name}>
                    {county.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>

          <Input
            label={t('Town, area or estate', 'Mji, eneo au mtaa')}
            required
            value={form.locationArea}
            onChange={(e) => set('locationArea', e.target.value)}
            maxLength={LOST_REPORT_FIELD_LIMITS.locationArea}
            disabled={submitting}
            placeholder={t('e.g. Westlands', 'mfano Westlands')}
          />

          <Input
            label={t('Landmark (optional)', 'Alama ya eneo (si lazima)')}
            value={form.locationLandmark}
            onChange={(e) => set('locationLandmark', e.target.value)}
            maxLength={LOST_REPORT_FIELD_LIMITS.locationLandmark}
            disabled={submitting}
            placeholder={t('e.g. near Sarit Centre', 'mfano karibu na Sarit Centre')}
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label={t('Lost from', 'Ilipotea kuanzia')}
              required
              type="datetime-local"
              value={form.lostAtFrom}
              min={minLocal}
              max={nowLocal}
              onChange={(e) => set('lostAtFrom', e.target.value)}
              disabled={submitting}
              hint={t(
                'Roughly when you last had it.',
                'Takriban wakati wa mwisho ulipokuwa nayo.'
              )}
            />
            <Input
              label={t('Lost until (optional)', 'Ilipotea hadi (si lazima)')}
              type="datetime-local"
              value={form.lostAtTo}
              min={form.lostAtFrom || minLocal}
              max={nowLocal}
              onChange={(e) => set('lostAtTo', e.target.value)}
              disabled={submitting}
              hint={t(
                'Leave blank if you are not sure.',
                'Acha wazi kama huna uhakika.'
              )}
            />
          </div>

          <p className="text-xs text-brand-muted-text leading-relaxed">
            {t(
              'Example: if you lost it sometime between 2pm and 5pm, put 2pm as "Lost from" and 5pm as "Lost until".',
              'Mfano: kama ulipoteza wakati fulani kati ya saa 8 na saa 11 jioni, weka saa 8 kwenye "Ilipotea kuanzia" na saa 11 kwenye "Ilipotea hadi".'
            )}
          </p>
        </div>
      )}

      {/* ---------------- STEP 4 — REVIEW ---------------- */}
      {step === 3 && (
        <div className="space-y-5">
          <div>
            <h3 className="text-sm font-extrabold text-brand-dark-text">
              {t('Check your report', 'Hakiki ripoti yako')}
            </h3>
            <p className="mt-1 text-xs text-brand-muted-text leading-relaxed">
              {t(
                'You can go back and change anything before submitting.',
                'Unaweza kurudi nyuma na kubadilisha chochote kabla ya kutuma.'
              )}
            </p>
          </div>

          <dl className="divide-y divide-brand-border rounded-xl border border-brand-border">
            <SummaryRow
              icon={Package}
              label={t('Item', 'Kitu')}
              value={categoryName(categories, form.categoryId, sw) || form.categoryId}
            />
            {form.documentType && (
              <SummaryRow
                label={t('Identifying number', 'Namba ya utambulisho')}
                // The CLASS is shown; the number itself is never echoed back —
                // not even here — so it cannot end up in a screenshot.
                value={`${identifierClassLabel(form.documentType, sw)}${
                  form.documentNumber.trim() ? ` · ${t('recorded', 'imewekwa')}` : ''
                }`}
              />
            )}
            {[form.brand, form.model, form.colour, form.material].some((v) => v.trim()) && (
              <SummaryRow
                label={t('Brand, model, colour, material', 'Chapa, modeli, rangi, nyenzo')}
                value={[form.brand, form.model, form.colour, form.material]
                  .map((v) => v.trim())
                  .filter(Boolean)
                  .join(' · ')}
              />
            )}
            {form.description.trim() && (
              <SummaryRow label={t('Description', 'Maelezo')} value={form.description.trim()} />
            )}
            {form.distinctiveMarks.trim() && (
              <SummaryRow
                label={t('Distinctive marks', 'Alama za kipekee')}
                value={form.distinctiveMarks.trim()}
              />
            )}
            <SummaryRow
              icon={MapPin}
              label={t('Where you lost it', 'Palipopotea')}
              value={[form.locationArea.trim(), form.locationLandmark.trim(), form.county]
                .filter(Boolean)
                .join(', ')}
            />
            <SummaryRow
              label={t('When you lost it', 'Ilipotea lini')}
              value={formatWindow(form.lostAtFrom, form.lostAtTo, sw)}
            />
          </dl>

          <div className="rounded-xl border border-brand-border bg-brand-light-gray/50 p-4 space-y-2">
            <p className="text-xs font-extrabold text-brand-dark-text">
              {t('What happens next', 'Kinachofuata')}
            </p>
            <ul className="space-y-1.5 text-xs text-brand-muted-text leading-relaxed">
              {[
                t(
                  'We will use these details to look for found items that may correspond to what you described.',
                  'Tutatumia maelezo haya kutafuta vitu vilivyopatikana vinavyoweza kufanana na uliyoeleza.'
                ),
                t(
                  'Submitting a report does not guarantee that your item will be recovered.',
                  'Kutuma ripoti hakuhakikishi kuwa kitu chako kitapatikana.'
                ),
                t(
                  'Your details stay private. A finder is never given your contact information, and you are never given theirs.',
                  'Maelezo yako hubaki faragha. Aliyekipata hapewi mawasiliano yako, na wewe hupewi yake.'
                ),
              ].map((line) => (
                <li key={line} className="flex items-start gap-2">
                  <Check size={13} aria-hidden="true" className="mt-0.5 shrink-0 text-primary-green" />
                  <span>{line}</span>
                </li>
              ))}
              <li className="flex items-start gap-2">
                <AlertCircle size={13} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-orange" />
                <span>
                  {t(
                    'A possible match is not proof of ownership. Claiming something still requires the normal verification.',
                    'Mechi inayowezekana si uthibitisho wa umiliki. Kudai kitu bado kunahitaji uthibitisho wa kawaida.'
                  )}
                </span>
              </li>
            </ul>
          </div>
        </div>
      )}

      {/* ---------------- NAVIGATION ---------------- */}
      <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3 border-t border-brand-border pt-5">
        <Button type="button" variant="ghost" onClick={goBack} disabled={submitting}>
          {step === 0 ? t('Cancel', 'Ghairi') : t('Back', 'Rudi')}
        </Button>

        {isLastStep ? (
          <Button
            type="submit"
            variant="accent"
            size="lg"
            loading={submitting}
            className="w-full sm:w-auto"
          >
            {submitting
              ? t('Submitting…', 'Inatuma…')
              : t('Submit lost report', 'Tuma ripoti ya kitu kilichopotea')}
          </Button>
        ) : (
          <Button
            type="button"
            variant="primary"
            size="lg"
            onClick={goNext}
            disabled={submitting}
            className="w-full sm:w-auto"
          >
            {t('Continue', 'Endelea')}
          </Button>
        )}
      </div>
    </form>
  );
}

function SummaryRow({ icon: Icon, label, value }: { icon?: any; label: string; value: string }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-3 px-4 py-3">
      {Icon && <Icon size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-orange" />}
      <dt className="w-40 shrink-0 text-xs font-bold text-brand-muted-text">{label}</dt>
      <dd className="min-w-0 flex-1 text-xs text-brand-dark-text leading-relaxed break-words whitespace-pre-wrap">
        {value}
      </dd>
    </div>
  );
}

/** Category name from the live list (bilingual), or '' when it is not loaded. */
export function categoryName(categories: any[], categoryId: string, sw: boolean): string {
  const match = (categories || []).find((c: any) => c && c.id === categoryId);
  if (!match) return '';
  return (sw ? match.name_sw : match.name_en) || match.name_en || '';
}

/** Bilingual label for one identifier class. */
export function identifierClassLabel(value: string, sw: boolean): string {
  const entry = LOST_REPORT_IDENTIFIER_CLASSES.find((candidate) => candidate.value === value);
  if (!entry) return value;
  return sw ? entry.sw : entry.en;
}

/** Human-readable window for the review step, e.g. "16 Sep, 14:00 — 16 Sep, 17:00". */
function formatWindow(fromLocal: string, toLocal: string, sw: boolean): string {
  const fmt = (value: string) => {
    const d = new Date(value);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString(sw ? 'sw-KE' : 'en-GB', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  };
  const from = fmt(fromLocal);
  const to = fmt(toLocal);
  if (!from) return '';
  return to ? `${from} — ${to}` : from;
}







