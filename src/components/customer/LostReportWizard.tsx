import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, MapPin, Package, Pencil, type LucideIcon } from 'lucide-react';
import { Banner, Button, Input, Select, Stepper, Textarea } from '../ui';
import { ICON_SIZE } from '../ui/iconSize';
import { countiesByUxGroup } from '../../config/kenyaCounties';
import { administrativeUnitsForCounty } from '../../config/kenyaAdministrativeUnits';
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
// LOST-REPORT WIZARD (Phase 9C · UX-04 presentation pass)
// ===========================================================================
// Four bounded steps that mirror the server contract in routes/lostReports.ts:
//  1. What was lost   — category (+ an optional identifier, hashed server-side)
//  2. Describe it     — brand / model / colour / material / notes
//  3. Where and when  — county, area, landmark, and a lost TIME WINDOW
//  4. Review          — a plain summary, then submit
//
// UX-04 changed PRESENTATION AND FORM ERGONOMICS ONLY:
//  * the four steps, their order, the field set, every validation rule, the
//    payload and the single submit handler are unchanged (this batch is not
//    allowed to move the workflow's state machine or its business logic);
//  * each step now answers ONE question — a single step heading (18/26), one
//    short explanation, only the fields that belong to that step, one primary
//    action and one back action;
//  * the step heading is the programmatic focus target for a step change, so a
//    keyboard or screen-reader user is told where the journey moved to;
//  * a validation failure is reported AT THE FIELD it belongs to (the shared
//    Input/Select error channel, which already carries aria-invalid,
//    aria-describedby and role="alert"), and focus moves to that field. There
//    is therefore no duplicate "summary" message above the form;
//  * the review step is grouped (what / where / when / identifying details) and
//    every group offers an edit affordance that jumps back to its step;
//  * type, radius, spacing, surface, border and focus now come from the UX-01
//    ladders (src/index.css) instead of raw light-only values, so the workflow
//    is legible in both light and dark appearance.
//
// WHAT THIS FORM STILL DOES NOT DO
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
  administrativeUnitId: string;
  locationArea: string;
  locationLandmark: string;
  lostAtFrom: string;
  lostAtTo: string;
}

/** A field the wizard validates before it will let a step advance. */
type WizardField = keyof FormState;

/** One validation failure: the message AND the field it belongs to. */
interface StepError {
  field: WizardField;
  message: string;
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
  administrativeUnitId: '',
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
 * this form is optional there and therefore optional here.
 *
 * It returns the failing field TOGETHER WITH its bilingual message, so the
 * message can be rendered at that field (and focus moved to it) instead of
 * being dumped into one form-level box. The rules, their order and their
 * wording are unchanged from the original per-step check.
 */
function validateStep(step: number, form: FormState): StepError | null {
  if (step === 0) {
    if (!form.categoryId) {
      return { field: 'categoryId', message: 'Please choose what was lost.' };
    }
    return null;
  }

  // Step 1 is entirely optional, exactly as the server treats it. Requiring
  // something here would be inventing a rule the API does not have.
  if (step === 1) return null;

  if (step === 2) {
    if (!form.county) {
      return {
        field: 'county',
        message: 'Please choose the county where you lost it.',
      };
    }
    if (!form.administrativeUnitId) {
      return {
        field: 'administrativeUnitId',
        message: 'Please choose the sub-county where you lost it.',
      };
    }
    const area = form.locationArea.trim();
    if (area.length < LOST_REPORT_FIELD_MINIMUMS.locationArea) {
      return {
        field: 'locationArea',
        message: 'Please enter the exact place where you lost it.',
      };
    }
    if (area.length > LOST_REPORT_FIELD_LIMITS.locationArea) {
      return {
        field: 'locationArea',
        message: `Please shorten the exact place to ${LOST_REPORT_FIELD_LIMITS.locationArea} characters or fewer.`,
      };
    }

    if (!form.lostAtFrom) {
      return {
        field: 'lostAtFrom',
        message: 'Please tell us roughly when you lost it.',
      };
    }
    const fromIso = localInputToIso(form.lostAtFrom);
    if (!fromIso) {
      return { field: 'lostAtFrom', message: 'That date and time is not valid.' };
    }
    const now = Date.now();
    const from = new Date(fromIso).getTime();
    if (from > now) {
      return {
        field: 'lostAtFrom',
        message: 'The time you lost it cannot be in the future.',
      };
    }

    if (form.lostAtTo) {
      const toIso = localInputToIso(form.lostAtTo);
      if (!toIso) {
        return { field: 'lostAtTo', message: 'That end time is not valid.' };
      }
      const to = new Date(toIso).getTime();
      if (to < from) {
        return {
          field: 'lostAtTo',
          message: 'The end of the window has to come after the start.',
        };
      }
      if (to > now) {
        return {
          field: 'lostAtTo',
          message: 'The end of the window cannot be in the future.',
        };
      }
      if (to - from > LOST_REPORT_MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
        // Plain, non-technical: no engine tolerance is disclosed.
        return {
          field: 'lostAtTo',
          message: 'Please choose a window of about a month or less — for example, between 2pm and 5pm on the same day.',
        };
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
): string {
  switch (kind) {
    case 'auth':
      return 'Your session has ended. Please sign in again, then submit your report.';
    case 'forbidden':
      return 'This account cannot submit a report right now. Please contact support.';
    case 'rate_limited':
      return 'You have submitted several reports recently. Please wait a few minutes and try again.';
    case 'validation':
      // The server's own bilingual explanation is already customer-safe
      // (routes/lostReports.ts never returns an internal error).
      return serverMessage || 'Some details were not accepted. Please check them and try again.';
    default:
      return 'We could not submit your report. Please try again.';
  }
}

/**
 * The id shared by the one visible step heading and the <section> that names
 * itself with it. Only one step renders at a time, so a single constant id can
 * never collide, and it gives assistive tech a stable "current step" landmark
 * to announce after Next/Back.
 */
const STEP_HEADING_ID = 'lost-report-step-heading';

export default function LostReportWizard({
  categories, categoriesLoading, onCancel, onCreated,
}: Props) {



  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [stepError, setStepError] = useState<StepError | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /**
   * Focus contract (UX-04): a step change moves focus to the new step heading,
   * a validation failure moves focus to the field that failed. Both are
   * predictable, single-purpose movements — nothing else in this workflow takes
   * focus away from the customer.
   */
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const fieldRefs = useRef<Partial<Record<WizardField, HTMLElement | null>>>({});
  const setFieldRef = <T extends HTMLElement>(field: WizardField) => (node: T | null) => {
    fieldRefs.current[field] = node;
  };

  const previousStepRef = useRef(step);
  useEffect(() => {
    if (previousStepRef.current === step) return;
    previousStepRef.current = step;
    stepHeadingRef.current?.focus();
  }, [step]);

  useEffect(() => {
    if (!stepError) return;
    fieldRefs.current[stepError.field]?.focus();
  }, [stepError]);

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

  /** The message for one field, or undefined when that field is fine. */
  const fieldError = (field: WizardField) =>
    stepError && stepError.field === field ? stepError.message : undefined;

  const goNext = () => {
    const error = validateStep(step, form);
    if (error) { setStepError(error); return; }
    setStepError(null);
    setStep((s) => Math.min(s + 1, LOST_REPORT_WIZARD_STEPS.length - 1));
  };

  const goBack = () => {
    setStepError(null);
    if (step === 0) { onCancel(); return; }
    setStep((s) => Math.max(s - 1, 0));
  };

  /** Presentation-only shortcut used by the review step's edit affordances. */
  const goToStep = (target: number) => {
    setStepError(null);
    setSubmitError(null);
    setStep(Math.max(0, Math.min(target, LOST_REPORT_WIZARD_STEPS.length - 1)));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    // Re-validate every step before sending: the customer may have gone back.
    for (let s = 0; s <= 2; s++) {
      const error = validateStep(s, form);
      if (error) { setStep(s); setStepError(error); return; }
    }

    // Only non-empty optionals are sent; the server treats omitted and empty
    // identically and stores NULL either way.
    const payload: LostReportCreatePayload = {
      categoryId: form.categoryId,
      county: form.county,
      administrativeUnitId: form.administrativeUnitId,
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
    setSubmitError(submitErrorCopy(result.error?.kind, result.error?.message));
  };

  const stepperSteps = LOST_REPORT_WIZARD_STEPS.map((s) => ({ label: s.en }));
  const nowLocal = toLocalInputValue(new Date());
  const minLocal = toLocalInputValue(MIN_LOST_AT);
  const administrativeUnits = administrativeUnitsForCounty(form.county);
  const isLastStep = step === LOST_REPORT_WIZARD_STEPS.length - 1;
  const currentStepLabel = stepperSteps[Math.max(0, Math.min(step, stepperSteps.length - 1))].label;

  return (
    <form onSubmit={handleSubmit} noValidate className="mx-auto w-full max-w-2xl space-y-6" aria-busy={submitting}>
      <Stepper
        steps={stepperSteps}
        currentStep={step}
        label={'Report a lost item progress'}
      />

      {/* One polite announcement per step change, for screen readers that do not
          track the progress rail's aria-current. */}
      <p className="sr-only" role="status" aria-live="polite">
        {'Step'} {step + 1} {'of'} {LOST_REPORT_WIZARD_STEPS.length}: {currentStepLabel}
      </p>

      {submitError && <Banner kind="error">{submitError}</Banner>}

      {/* ---------------- STEP 1 — WHAT WAS LOST ---------------- */}
      {step === 0 && (
        <section aria-labelledby={STEP_HEADING_ID} className="space-y-5">
          <StepIntro
            headingRef={stepHeadingRef}
            title={'What did you lose?'}
            description={'Choose the closest match. It is how we compare your report with found items of the same kind.'}
          />

          <Select
            label={'Item category'}
            required
            value={form.categoryId}
            onChange={(e) => handleCategoryChange(e.target.value)}
            disabled={categoriesLoading || submitting}
            error={fieldError('categoryId')}
            ref={setFieldRef<HTMLSelectElement>('categoryId')}
          >
            <option value="">
              {categoriesLoading
                ? 'Loading categories…'
                : 'Select a category'}
            </option>
            {(categories || []).map((c: any) => (
              <option key={c.id} value={c.id}>
                {(c.name_en) || c.name_en || c.id}
              </option>
            ))}
          </Select>

          {/* Revealed only once a category exists, because an identifier class is
              only meaningful for a chosen kind of item. No new rule is added: the
              whole cluster is optional on the server. */}
          {form.categoryId && (
            <fieldset className="space-y-4 rounded-standard border border-[var(--appearance-border)] bg-[var(--appearance-surface-muted)] p-4 sm:p-5">
              <legend className="px-1 text-body-large font-semibold text-[var(--appearance-text-primary)]">
                {'Identifying number (optional)'}
              </legend>
              <p className="text-small text-[var(--appearance-text-muted)] leading-relaxed">
                {'If the item has a document, card or serial number, adding it makes an exact match far more likely.'}
              </p>

              <Select
                label={'What kind of number is it?'}
                value={form.documentType}
                onChange={(e) => set('documentType', e.target.value)}
                disabled={submitting}
              >
                <option value="">{'Not sure / prefer not to say'}</option>
                {LOST_REPORT_IDENTIFIER_CLASSES.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.en}
                  </option>
                ))}
              </Select>

              <Input
                label={'The number'}
                type="text"
                inputMode="text"
                autoComplete="off"
                maxLength={LOST_REPORT_FIELD_LIMITS.documentNumber}
                value={form.documentNumber}
                onChange={(e) => set('documentNumber', e.target.value)}
                disabled={submitting}
                placeholder={'e.g. 12345678'}
                hint={'Stored only as a one-way fingerprint. It is never shown back to you, to a finder, or to an agent.'}
              />
            </fieldset>
          )}
        </section>
      )}

      {/* ---------------- STEP 2 — DESCRIBE IT ---------------- */}
      {step === 1 && (
        <section aria-labelledby={STEP_HEADING_ID} className="space-y-5">
          <StepIntro
            headingRef={stepHeadingRef}
            title={'Describe the item'}
            description={'Everything here is optional. The more detail you give, the easier it is to tell your item apart from similar ones.'}
          />

          {/* Named clusters so the step reads as groups of related questions.
              The fields, their order, their labels and their validation are
              unchanged — only the grouping labels are new. */}
          <h4 className="text-body-large font-semibold text-[var(--appearance-text-primary)]">
            {'Item details'}
          </h4>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label={'Brand (optional)'}
              value={form.brand}
              onChange={(e) => set('brand', e.target.value)}
              maxLength={LOST_REPORT_FIELD_LIMITS.brand}
              disabled={submitting}
              placeholder={'e.g. Samsung'}
            />
            <Input
              label={'Model (optional)'}
              value={form.model}
              onChange={(e) => set('model', e.target.value)}
              maxLength={LOST_REPORT_FIELD_LIMITS.model}
              disabled={submitting}
              placeholder={'e.g. Galaxy A54'}
            />
            <Input
              label={'Colour (optional)'}
              value={form.colour}
              onChange={(e) => set('colour', e.target.value)}
              maxLength={LOST_REPORT_FIELD_LIMITS.colour}
              disabled={submitting}
              placeholder={'e.g. Black'}
            />
            <Input
              label={'Material (optional)'}
              value={form.material}
              onChange={(e) => set('material', e.target.value)}
              maxLength={LOST_REPORT_FIELD_LIMITS.material}
              disabled={submitting}
              placeholder={'e.g. Leather'}
            />
          </div>

          <h4 className="text-body-large font-semibold text-[var(--appearance-text-primary)]">
            {'Notes'}
          </h4>

          <Textarea
            label={'Description (optional)'}
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            maxLength={LOST_REPORT_FIELD_LIMITS.description}
            disabled={submitting}
            placeholder={'e.g. Brown leather wallet, worn on one corner, contains a bank card'}
            hint={'You do not need to include passwords, PINs or account numbers.'}
          />

          <Textarea
            label={'Distinctive marks (optional)'}
            value={form.distinctiveMarks}
            onChange={(e) => set('distinctiveMarks', e.target.value)}
            maxLength={LOST_REPORT_FIELD_LIMITS.distinctiveMarks}
            disabled={submitting}
            placeholder={'e.g. A lion sticker on the front pocket'}
            hint={'Details most people would not notice help us avoid incorrect matches.'}
          />
        </section>
      )}

      {/* ---------------- STEP 3 — WHERE AND WHEN ---------------- */}
      {step === 2 && (
        <section aria-labelledby={STEP_HEADING_ID} className="space-y-5">
          <StepIntro
            headingRef={stepHeadingRef}
            title={'Where and when did you lose it?'}
            description={'A rough answer is fine. This is used to compare your report with items found in the same area and around the same time.'}
          />

          {/* The two halves of this step are named as two groups, so the customer
              reads them as "where" and "when" rather than as one long form. */}
          <h4 className="text-body-large font-semibold text-[var(--appearance-text-primary)]">
            {'Where you lost it'}
          </h4>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Select
              label={'County'}
              required
              value={form.county}
              onChange={(e) => {
                set('county', e.target.value);
                set('administrativeUnitId', '');
              }}
              disabled={submitting}
              error={fieldError('county')}
              ref={setFieldRef<HTMLSelectElement>('county')}
            >
              <option value="">{'Select a county'}</option>
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

            <Select
              label={'Sub-county'}
              required
              value={form.administrativeUnitId}
              onChange={(e) => set('administrativeUnitId', e.target.value)}
              disabled={submitting || !form.county}
              hint={'Select county first, then choose its sub-county.'}
              error={fieldError('administrativeUnitId')}
              ref={setFieldRef<HTMLSelectElement>('administrativeUnitId')}
            >
              <option value="">{form.county ? 'Select a sub-county' : 'Select county first'}</option>
              {administrativeUnits.map((unit) => (
                <option key={unit.id} value={unit.id}>{unit.name}</option>
              ))}
            </Select>
          </div>

          {/* P14C-3A — the reporter's own description of where the item was lost,
              so the label says "Exact place". The field is UNCHANGED in the data
              model: still free text, still posted as `locationArea` →
              lost_reports.location_area, still the same validator. The hint
              deliberately omits "landmark" because the optional Landmark field
              directly below already covers that, and repeating it invited the
              same words to be typed twice. */}
          <Input
            label={'Exact place'}
            required
            value={form.locationArea}
            onChange={(e) => set('locationArea', e.target.value)}
            maxLength={LOST_REPORT_FIELD_LIMITS.locationArea}
            disabled={submitting}
            error={fieldError('locationArea')}
            ref={setFieldRef<HTMLInputElement>('locationArea')}
            placeholder={'e.g. Near Sarit Centre, Westlands'}
            hint={'Enter the street, estate, building or nearby place you know.'}
          />

          <Input
            label={'Landmark (optional)'}
            value={form.locationLandmark}
            onChange={(e) => set('locationLandmark', e.target.value)}
            maxLength={LOST_REPORT_FIELD_LIMITS.locationLandmark}
            disabled={submitting}
            placeholder={'e.g. near Sarit Centre'}
          />

          <h4 className="pt-1 text-body-large font-semibold text-[var(--appearance-text-primary)]">
            {'When you lost it'}
          </h4>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label={'Lost from'}
              required
              type="datetime-local"
              value={form.lostAtFrom}
              min={minLocal}
              max={nowLocal}
              onChange={(e) => set('lostAtFrom', e.target.value)}
              disabled={submitting}
              error={fieldError('lostAtFrom')}
              ref={setFieldRef<HTMLInputElement>('lostAtFrom')}
              hint={'Roughly when you last had it.'}
            />
            <Input
              label={'Lost until (optional)'}
              type="datetime-local"
              value={form.lostAtTo}
              min={form.lostAtFrom || minLocal}
              max={nowLocal}
              onChange={(e) => set('lostAtTo', e.target.value)}
              disabled={submitting}
              error={fieldError('lostAtTo')}
              ref={setFieldRef<HTMLInputElement>('lostAtTo')}
              hint={'Leave blank if you are not sure.'}
            />
          </div>

          <p className="text-small text-[var(--appearance-text-muted)] leading-relaxed">
            {'Example: if you lost it sometime between 2pm and 5pm, put 2pm as "Lost from" and 5pm as "Lost until".'}
          </p>
        </section>
      )}

      {/* ---------------- STEP 4 — REVIEW ---------------- */}
      {step === 3 && (
        <section aria-labelledby={STEP_HEADING_ID} className="space-y-5">
          <StepIntro
            headingRef={stepHeadingRef}
            title={'Check your report'}
            description={'You can go back and change anything before submitting.'}
          />

          {/* Grouped, not one flat list: each group names the part of the journey
              it came from and offers an edit affordance that jumps straight back
              to that step, so nothing requires restarting the report. */}
          <ReviewGroup
            title={'What you lost'}
            editLabel={'Edit'}
            onEdit={() => goToStep(0)}
          >
            <SummaryRow
              icon={Package}
              label={'Item'}
              value={categoryName(categories, form.categoryId) || form.categoryId}
            />
            {form.documentType && (
              <SummaryRow
                label={'Identifying number'}
                // The CLASS is shown; the number itself is never echoed back —
                // not even here — so it cannot end up in a screenshot.
                value={`${identifierClassLabel(form.documentType)}${
                  form.documentNumber.trim() ? ` · ${'recorded'}` : ''
                }`}
              />
            )}
          </ReviewGroup>

          {[form.brand, form.model, form.colour, form.material, form.description, form.distinctiveMarks].some((v) => v.trim()) && (
            <ReviewGroup
              title={'Identifying details'}
              editLabel={'Edit'}
              onEdit={() => goToStep(1)}
            >
              {[form.brand, form.model, form.colour, form.material].some((v) => v.trim()) && (
                <SummaryRow
                  label={'Brand, model, colour, material'}
                  value={[form.brand, form.model, form.colour, form.material]
                    .map((v) => v.trim())
                    .filter(Boolean)
                    .join(' · ')}
                />
              )}
              {form.description.trim() && (
                <SummaryRow label={'Description'} value={form.description.trim()} />
              )}
              {form.distinctiveMarks.trim() && (
                <SummaryRow
                  label={'Distinctive marks'}
                  value={form.distinctiveMarks.trim()}
                />
              )}
            </ReviewGroup>
          )}

          <ReviewGroup
            title={'Where you lost it'}
            editLabel={'Edit'}
            onEdit={() => goToStep(2)}
          >
            <SummaryRow
              icon={MapPin}
              label={'Place'}
              value={[form.locationArea.trim(), form.locationLandmark.trim(), administrativeUnits.find((unit) => unit.id === form.administrativeUnitId)?.name, form.county]
                .filter(Boolean)
                .join(', ')}
            />
          </ReviewGroup>

          <ReviewGroup
            title={'When you lost it'}
            editLabel={'Edit'}
            onEdit={() => goToStep(2)}
          >
            <SummaryRow
              label={'Time window'}
              value={formatWindow(form.lostAtFrom, form.lostAtTo)}
            />
          </ReviewGroup>

          <div className="rounded-panel border border-[var(--appearance-border)] bg-[var(--appearance-surface-muted)] p-4 sm:p-5 space-y-2">
            <h4 className="text-body-large font-semibold text-[var(--appearance-text-primary)]">
              {'What happens next'}
            </h4>
            <ul className="space-y-1.5 text-small text-[var(--appearance-text-muted)] leading-relaxed">
              {[
                'We will use these details to look for found items that may correspond to what you described.',
                'Submitting a report does not guarantee that your item will be recovered.',
                'Your details stay private. A finder is never given your contact information, and you are never given theirs.',
              ].map((line) => (
                <li key={line} className="flex items-start gap-2">
                  <Check size={ICON_SIZE.metadata} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--appearance-success)]" />
                  <span>{line}</span>
                </li>
              ))}
              <li className="flex items-start gap-2">
                <AlertCircle size={ICON_SIZE.metadata} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--appearance-warning)]" />
                <span>
                  {'A possible match is not proof of ownership. Claiming something still requires the normal verification.'}
                </span>
              </li>
            </ul>
          </div>
        </section>
      )}

      {/* ---------------- NAVIGATION ---------------- */}
      <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3 border-t border-[var(--appearance-border)] pt-5">
        <Button type="button" variant="ghost" size="md" onClick={goBack} disabled={submitting}>
          {step === 0 ? 'Cancel' : 'Back'}
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
              ? 'Submitting…'
              : 'Submit lost report'}
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
            {'Continue'}
          </Button>
        )}
      </div>
    </form>
  );
}

/**
 * The single question a step asks, plus its one-line explanation. The heading is
 * the focus target for a step change, so it must exist once per render and be
 * reachable by script (tabIndex -1) while staying out of the tab order. The
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
 * One review group: a named part of the journey, its recorded values, and a
 * single edit affordance that returns to the step those values came from. The
 * edit control is a plain button (never a submit), so the form still has exactly
 * one submit action.
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
          /* The visible label is one word and repeats per group, so the
             accessible name says WHICH group this edit returns to. WCAG 2.5.3
             still holds: the visible label is the first word of the name. */
          aria-label={`${editLabel}: ${title}`}
          className="shrink-0"
        >
          <Pencil size={ICON_SIZE.metadata} aria-hidden="true" />
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
      {Icon && <Icon size={ICON_SIZE.metadata} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--appearance-text-muted)]" />}
      <dt className="w-40 shrink-0 text-caption font-bold text-[var(--appearance-text-muted)]">{label}</dt>
      <dd className="min-w-0 flex-1 text-body text-[var(--appearance-text-primary)] leading-relaxed break-words whitespace-pre-wrap">
        {value}
      </dd>
    </div>
  );
}

/** Category name from the live list (bilingual), or '' when it is not loaded. */
export function categoryName(categories: any[], categoryId: string): string {
  const match = (categories || []).find((c: any) => c && c.id === categoryId);
  if (!match) return '';
  return (match.name_en) || match.name_en || '';
}

/** Bilingual label for one identifier class. */
export function identifierClassLabel(value: string): string {
  const entry = LOST_REPORT_IDENTIFIER_CLASSES.find((candidate) => candidate.value === value);
  if (!entry) return value;
  return entry.en;
}

/** Human-readable window for the review step, e.g. "16 Sep, 14:00 — 16 Sep, 17:00". */
function formatWindow(fromLocal: string, toLocal: string): string {
  const fmt = (value: string) => {
    const d = new Date(value);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('en-GB', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  };
  const from = fmt(fromLocal);
  const to = fmt(toLocal);
  if (!from) return '';
  return to ? `${from} — ${to}` : from;
}
