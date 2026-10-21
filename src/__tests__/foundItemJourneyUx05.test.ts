// =============================================================================
// RETURN4ME UX-05 — REPORT-A-FOUND-ITEM JOURNEY: FIVE GUIDED STAGES, THE SAME
// BUSINESS LOGIC, ONE-LANGUAGE COPY AND TOUCH ERGONOMICS
// =============================================================================
// Source-level tripwires, matching this repository's other UX batches
// (lostReportWizardUx04, homepageUx03Hierarchy, publicChromeUx02): there is no
// jsdom / React Testing Library harness here, so every contract below is
// asserted against the source that actually ships — with comments removed, so
// prose can neither satisfy a "must exist" pin nor defeat a "must never come
// back" tripwire.
//
// WHAT THIS SUITE PINS (and what a later change would trip):
//   * the journey is a FIVE-stage machine with ONE deliberate submit path: one
//     POST, one submit control, the same payload keys, and an implicit
//     submission (Enter inside a text field) refused on every earlier stage;
//   * UX-05 moved presentation and form ergonomics ONLY: every field, every
//     validation rule and the wording of every message survive, and the
//     photo/scan, GPS, location and contact data paths are untouched;
//   * a stage change moves focus to that stage's own heading exactly once — the
//     heading exists once per render, is script-reachable while staying out of
//     the tab order, and names the stage region it sits in;
//   * the review stage recaps every recorded value, with one edit affordance per
//     group, and adds no claim the backend cannot keep;
//   * the chrome UX-05 authored sits on the UX-01 ladders (type, radius, icon,
//     appearance) and on the shared primitives, and every control the Finder
//     presses clears the 44px target floor;
//   * every new visible string exists once, in the shipped English copy (the
//     application ships ONE language, so a string is pinned by its own literal
//     rather than by a two-argument translate call).
//
// SCOPE: presentation contracts only. The payload/validation/endpoint contract
// is pinned by publicExperience, countySelectorExactPlace, p14aUiBoundary,
// categoryArchitectureBatch1/2 and lifecycleHttpE2E; this suite deliberately
// does not restate them, so the two cannot contradict each other.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

/**
 * Source with comments removed and line endings normalised, so an assertion can
 * quote a two-line JSX block without depending on the file's CRLF/LF style.
 *
 * The block-comment pass deliberately only accepts an opener that stands at the
 * start of a line or follows whitespace / an opening bracket: a bare pair of
 * those two characters inside a plain attribute value (an upload `accept` list,
 * say) is NOT a comment, and a pattern that cannot tell the difference swallows
 * everything up to the next closing marker — which is exactly how a whole
 * section of a component can stop being inspected without anyone noticing.
 */
const stripComments = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/(^|[\s{(,;=[])\/\*[\s\S]*?\*\//g, '$1')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/\r\n/g, '\n');

const FINDER_TSX = read('src/components/FinderView.tsx');
const FINDER = stripComments(FINDER_TSX);
const STEPPER_TSX = read('src/components/ui/Stepper.tsx');
const BUTTON_TSX = read('src/components/ui/Button.tsx');

/** One English copy literal, written the way this component writes its copy. */
const copy = (en: string) => `'${en}'`;

/* The four data-entry stages as ONE slice, cut on RENDERED anchors rather than
   on comment markers (comment stripping removes those): from the first stage
   heading to the review heading. A rule asserted here can therefore never be
   satisfied by markup belonging to the review stage or the footer. */
const STAGES = FINDER.slice(
  FINDER.indexOf("title={'What did you find?'}"),
  FINDER.indexOf("title={'Check your report'}"),
);
/* The review stage: its heading to the navigation footer that follows it. */
const REVIEW = FINDER.slice(
  FINDER.indexOf("title={'Check your report'}"),
  FINDER.indexOf('flex flex-col-reverse sm:flex-row'),
);
/* The footer itself (back / continue), plus the submit block below it. */
const FOOTER = FINDER.slice(FINDER.indexOf('flex flex-col-reverse sm:flex-row'));
/* The review's own primitives (StepIntro / ReviewGroup / SummaryRow) are
   declared BELOW the component in this file. */
const PRIMITIVES = FINDER.slice(FINDER.indexOf('function StepIntro'));
/* Everything UX-05 authored that carries no previously-pinned legacy markup. */
const AUTHORED = REVIEW + PRIMITIVES;
/* The report request itself, sliced from its own URL. */
const PAYLOAD = FINDER.slice(
  FINDER.indexOf("fetch('/api/items/report'"),
  FINDER.indexOf('setDropoffResult('),
);

/* The two legacy stone-* shades publicExperience pins as evidence that
   meaningful dark-surface colour was not flattened. Nothing else may use the
   raw stone palette, and these two must survive until UX-16 migrates them. */
const LEGACY_STONE_LITERALS = ['bg-stone-800 text-white', 'disabled:text-stone-400'];

describe('UX-05 the slices this suite asserts against are real', () => {
  it('cuts every slice on a rendered anchor, in order and non-empty', () => {
    for (const [name, slice] of Object.entries({ STAGES, REVIEW, FOOTER, PRIMITIVES, PAYLOAD })) {
      expect(slice, `${name} slice is empty — an anchor moved`).not.toBe('');
    }
    expect(STAGES.length).toBeGreaterThan(1000);
    expect(REVIEW.length).toBeGreaterThan(1000);
    expect(PRIMITIVES.length).toBeGreaterThan(1000);
  });
});

describe('UX-05 the found-item report is a five-stage machine', () => {
  it('declares the five stages once, in the order the journey asks them', () => {
    expect(FINDER).toContain('const FINDER_STEPS: { en: string }[] = [');
    expect((FINDER.match(/\{\s*en: '[^']+'\s*\}/g) || []).length).toBe(5);
    const declared = FINDER.slice(FINDER.indexOf('const FINDER_STEPS'), FINDER.indexOf('const STEP_HEADING_ID'));
    for (const label of ['What', 'Identify', 'Where', 'Contact', 'Review & Submit']) {
      expect(declared, `stage ${label} is missing`).toContain(`en: '${label}'`);
    }
    // ONE label per stage, declared once: the rail and the polite announcement
    // both read this list, so a stage can never be named in one place and
    // numbered in another.
  });

  it('renders exactly one bounded stage per entry, and the review last', () => {
    expect(FINDER).toContain('const [step, setStep] = useState(0);');
    // The four data-entry stages are keyed on their own index…
    for (let i = 0; i < 4; i++) {
      expect(FINDER, `stage ${i} is no longer rendered`).toContain(`{step === ${i} && (`);
    }
    // …and the review stage is keyed off the LAST index, so stage 4 and the
    // review can never drift apart. Its own action block is gated the same way.
    expect(FINDER).toContain('const totalSteps = FINDER_STEPS.length;');
    expect(FINDER).toContain('const isLastStep = step === totalSteps - 1;');
    expect((FINDER.match(/\{isLastStep && \(/g) || []).length).toBe(2);
  });

  it('drives the shared Stepper from the stage list', () => {
    expect(FINDER).toContain('const stepperSteps = FINDER_STEPS.map((s) => ({ label: s.en }));');
    expect(FINDER).toContain('const currentStepLabel = stepperSteps');
    expect(FINDER).toContain('<Stepper');
    expect(FINDER).toContain('steps={stepperSteps}');
    expect(FINDER).toContain('currentStep={step}');
    expect(FINDER).toContain("label={'Report a found item progress'}");
    // The rail keeps marking the current stage for assistive tech.
    expect(STEPPER_TSX).toContain("aria-current={isCurrent ? 'step' : undefined}");
  });

  it('keeps ONE deliberate submit path: one POST, one submit control', () => {
    expect((FINDER.match(/fetch\('\/api\/items\/report'/g) || []).length).toBe(1);
    expect((FINDER.match(/type="submit"/g) || []).length).toBe(1);
    expect(FINDER).toContain('onSubmit={submitFoundReport}');
    expect(FINDER).toContain('e.preventDefault();');
    // Duplicate-POST defence, unchanged…
    expect(FINDER).toContain('if (isSubmitting) return;');
    // …plus the stage guard: Enter in a text field on an earlier stage is not a
    // submission.
    expect(FINDER).toContain('if (step !== FINDER_STEPS.length - 1) return;');
    // Continue and every review edit are plain buttons, never submitters.
    expect(FOOTER).toContain('type="button"');
    expect(PRIMITIVES).toContain('type="button"');
    expect(FINDER).toContain('disabled={isSubmitting || !photoBase64}');
    expect(FINDER).toContain('aria-busy={isSubmitting || undefined}');
  });
});

describe('UX-05 the workflow enforces exactly the rules it always enforced', () => {
  it('keeps every validation message verbatim, in the one shipped language', () => {
    for (const message of [
      'Please fill out all required fields and upload/capture a photo.',
      'Please provide a title and description.',
      'Please choose the county where you found the item.',
      'Please choose the sub-county where you found the item.',
      'Please enter the exact place where you found the item.',
      'Please enter the phone number for your M-Pesa payout.',
      'You must agree to the Terms of Service and Privacy Policy to create an account.',
      'Please enter a valid email address.',
    ]) {
      expect(FINDER_TSX, `missing message: ${message}`).toContain(message);
    }
  });

  it('evaluates those rules stage by stage, from one shared gate', () => {
    expect(FINDER).toContain('const stepErrorFor = (target: number): string | null => {');
    for (const branch of ['if (target === 0) {', 'if (target === 1) {', 'if (target === 2) {', 'if (target === 3) {']) {
      expect(FINDER, `missing stage branch ${branch}`).toContain(branch);
    }
    // The stage rules still read the same state the single screen validated.
    expect(FINDER).toContain('if (!categoryId || !photoBase64) {');
    expect(FINDER).toContain('if (!isSensitive && (!description || !extractedName)) {');
    expect(FINDER).toContain('if (!foundCounty) {');
    expect(FINDER).toContain('if (!foundAdministrativeUnit) {');
    expect(FINDER).toContain('if (!locationDescription) {');
    expect(FINDER).toContain('if (!finderPhone) {');
    expect(FINDER).toContain('if (createAccount && !agreedTerms) {');
    expect(FINDER).toContain('if (finderEmail && !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(finderEmail)) {');
  });

  it('gates Continue on the current stage and nowhere else', () => {
    expect(FINDER).toContain('const goNext = () => {');
    expect(FINDER).toContain('const message = stepErrorFor(step);');
    expect(FINDER).toContain('setStep((s) => Math.min(s + 1, totalSteps - 1));');
    expect(FOOTER).toContain('onClick={goNext}');
    // Back only clears the message and steps back; a review edit jumps to the
    // stage that owns the values and never submits.
    expect(FINDER).toContain('const goBack = () => {');
    expect(FINDER).toContain('const goToStep = (target: number) => {');
    expect(FOOTER).toContain('onClick={goBack}');
  });

  it('re-checks every stage, in order, before the report is sent', () => {
    expect(FINDER).toContain('for (let s = 0; s < FINDER_STEPS.length - 1; s++) {');
    expect(FINDER).toContain('const message = stepErrorFor(s);');
    expect(FINDER).toContain('setStep(s);');
    expect(FINDER).toContain('setErrorMsg(message);');
    // A stage gate is not a second validation authority: the server still is.
    expect(FINDER_TSX).toContain('The server remains the ONLY authority');
  });

  it('keeps the one assertive alert channel and the polite announcers', () => {
    expect(FINDER).toContain('id="finder-error"');
    expect(FINDER).toContain('role="alert"');
    expect(FINDER).toContain("aria-describedby={errorMsg ? 'finder-error' : undefined}");
    expect(FINDER).toContain('className="sr-only" role="status" aria-live="polite"');
    // The stage announcement adds exactly one polite region: the existing
    // budget (analysis, in-flight submission, success) must stay inside it.
    const live = FINDER_TSX.match(/aria-live=/g) || [];
    expect(live.length).toBeGreaterThanOrEqual(3);
    expect(live.length).toBeLessThanOrEqual(5);
  });
});

describe('UX-05 the report data path is untouched', () => {
  it('keeps the camera, the upload and the scan pipeline', () => {
    expect(FINDER).toContain('const startCamera = () => {');
    expect(FINDER).toContain('const captureFrame = () => {');
    expect(FINDER).toContain('const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {');
    expect(FINDER).toContain("fetch('/api/items/analyze'");
    // The scan is still offered exactly when the live category is sensitive,
    // from the one rule, on both the camera and the upload path.
    expect((FINDER.match(/if \(isSelectedCategorySensitive\(\)\) \{/g) || []).length).toBe(1);
    expect(FINDER).toContain('setCategoryManuallySet(false);');
    // The pre-fill stays a suggestion the Finder reviews, never a verification.
    expect(FINDER_TSX).toContain('correct anything the scan got wrong');
  });

  it('keeps the location handling, the explicit null GPS check and the canonical sources', () => {
    expect(FINDER).toContain('latitude === null || longitude === null');
    expect(FINDER).toContain('const getCoordinates = async () => {');
    expect(FINDER).toContain('const useDetectedLocation = () => {');
    expect(FINDER).toContain('COUNTY_GROUPS.map((group) => (');
    expect(FINDER).toContain('administrativeUnitsForCounty(foundCounty)');
    // The exact place is still the Finder's own words, required and free text.
    expect(FINDER).toContain('id="finder-location"');
    expect(FINDER).toContain('value={locationDescription}');
    expect(FINDER).toContain("onChange={(e) => setLocationDescription(e.target.value)}");
    expect(FINDER).toContain('aria-describedby="finder-location-hint"');
    expect(FINDER).toContain('id="finder-location-hint"');
  });

  it('sends the same payload keys, in the same shape', () => {
    for (const key of [
      'categoryId,',
      'photoBase64,',
      'extractedNumber: isSensitive ? extractedNumber : undefined,',
      'extractedName,',
      'locationDescription,',
      'foundCounty,',
      'administrativeUnitId: foundAdministrativeUnit,',
      'finderPhone,',
      'finderEmail,',
      'createAccount,',
      'termsAccepted: agreedTerms,',
      'description: !isSensitive ? description : undefined,',
    ]) {
      expect(PAYLOAD, `payload key ${key} is missing`).toContain(key);
    }
    expect(PAYLOAD).toMatch(/latitude,\s*\n\s*longitude,/);
    // The endpoint, the method and the honest failure copy are unchanged.
    expect(PAYLOAD).toContain("method: 'POST'");
    expect(PAYLOAD).toContain("headers: { 'Content-Type': 'application/json' }");
    expect(PAYLOAD).toContain('body: JSON.stringify({');
    expect(PAYLOAD).toContain('apiMessage || submitErrorMessage');
  });
});

describe('UX-05 the review stage recaps the report and promises nothing', () => {
  it('groups the recap and gives every group one edit affordance back to its stage', () => {
    expect((REVIEW.match(/<ReviewGroup/g) || []).length).toBe(4);
    for (const target of [0, 1, 2, 3]) {
      expect(REVIEW, `no edit affordance for stage ${target}`).toContain(`onEdit={() => goToStep(${target})}`);
    }
    for (const title of [
      copy('What you found'),
      copy('Identifying details'),
      copy('Where you found it'),
      copy('How we reach you'),
    ]) {
      expect(REVIEW, `missing review group ${title}`).toContain(title);
    }
    expect((REVIEW.match(/editLabel=\{'Edit'\}/g) || []).length).toBe(4);
  });

  it('reads every value from the live report, not from a fixed template', () => {
    for (const live of [
      'photoBase64 ?',
      'selectedCategoryLabel ||',
      'extractedNumber.trim() ||',
      'extractedName.trim() ||',
      'description.trim() ||',
      'locationDescription.trim()',
      'foundAdministrativeUnitName',
      'foundCounty',
      'latitude === null || longitude === null',
      'finderPhone.trim() ||',
      'finderEmail.trim() ||',
      'createAccount ?',
    ]) {
      expect(REVIEW, `the recap no longer reads ${live}`).toContain(live);
    }
    // The recap names the live category from its canonical English name.
    expect(FINDER).toContain('const selectedCategoryLabel = selectedCategory');
    expect(FINDER).toContain('selectedCategory.name_en || categoryId');
    // The sensitivity split is the same single rule the fields use.
    expect(FINDER).toContain('const isSensitiveCategory = isSelectedCategorySensitive();');
    expect(REVIEW).toContain('{isSensitiveCategory ? (');
  });

  it('states what happens next with only what the backend actually does', () => {
    expect(REVIEW).toContain(copy('What happens next'));
    expect(REVIEW).toContain('Your report is saved with a drop-off code');
    expect(REVIEW).toContain('the coordinates are used to look for a real active Return4me Agent near you');
    expect(REVIEW).toContain('our team will assign one for you.');
    expect(REVIEW).toContain('Your phone number is used for your M-Pesa payout and is never shown to claimants.');
    // No claim the code cannot keep.
    for (const claim of ['guarantee', 'verified', 'AI-', 'automatically', 'faster', 'closest', 'instantly']) {
      expect(REVIEW, `overclaim in the recap: ${claim}`).not.toContain(claim);
    }
  });
});

describe('UX-05 focus moves once per stage change and nowhere else', () => {
  it('moves focus to the stage heading on a stage CHANGE only', () => {
    expect(FINDER).toContain('stepHeadingRef.current?.focus();');
    expect(FINDER).toContain('if (previousStepRef.current === step) return;');
    expect(FINDER).toContain('}, [step]);');
    // Exactly one focus movement in the whole workflow.
    expect((FINDER.match(/\.focus\(\)/g) || []).length).toBe(1);
    expect(FINDER).not.toContain('autoFocus');
  });

  it('focuses a heading that exists once, is script-reachable and names its stage', () => {
    expect(FINDER).toContain("const STEP_HEADING_ID = 'finder-step-heading';");
    expect((PRIMITIVES.match(/<h3/g) || []).length).toBe(1);
    expect(PRIMITIVES).toContain('id={STEP_HEADING_ID}');
    expect(PRIMITIVES).toContain('tabIndex={-1}');
    expect(PRIMITIVES).toContain('ref={headingRef}');
    expect((FINDER.match(/aria-labelledby=\{STEP_HEADING_ID\}/g) || []).length).toBe(5);
  });

  it('announces the stage change politely as well as moving focus', () => {
    expect(FINDER).toContain('className="sr-only" role="status" aria-live="polite"');
    expect(FINDER).toContain("{'Step'} {step + 1} {'of'} {FINDER_STEPS.length}: {currentStepLabel}");
  });
});

describe('UX-05 the copy is ONE language, pinned by its own literal', () => {
  it('ships no second language and keeps the stage labels single-sourced', () => {
    // The application ships ONE language. The retired two-argument translate
    // call, the `lang` switch it read and the `name_sw` column it fell back to
    // must not come back: a string is pinned by the literal that renders, so a
    // translated copy can never drift away from the English one beside it.
    expect(FINDER).not.toMatch(/\btr\(/);
    expect(FINDER).not.toContain('name_sw');
    expect(FINDER).not.toMatch(/\blang\b/);
    // The rail and the polite announcement both read the ONE stage list, so a
    // stage can never be named in one place and numbered in another.
    expect(FINDER).toContain('const stepperSteps = FINDER_STEPS.map((s) => ({ label: s.en }));');
    expect(FINDER).toContain('const currentStepLabel = stepperSteps');
  });

  it('names every authored heading and action in the shipped English copy', () => {
    for (const literal of [
      "title={'What did you find?'}",
      "title={'Identify the item'}",
      "title={'Where did you find it?'}",
      "title={'How can we reach you?'}",
    ]) {
      expect(STAGES, `missing stage copy ${literal}`).toContain(literal);
    }
    for (const literal of [
      "title={'Check your report'}",
      "title={'What you found'}",
      "title={'Identifying details'}",
      "title={'Where you found it'}",
      "title={'How we reach you'}",
      "editLabel={'Edit'}",
    ]) {
      expect(REVIEW, `missing review copy ${literal}`).toContain(literal);
    }
    // The primitives take their copy through props, never from a literal…
    expect(PRIMITIVES).not.toMatch(/\b(?:label|editLabel|title)=(?:"|')/);
    // …and no Swahili string survives anywhere in the component, comment or
    // markup: the retired copy is asserted against the RAW source on purpose.
    expect(FINDER_TSX).not.toMatch(
      /'(?:Ulipata|Hakiki|Maendeleo|Tafadhali|Hatua|Badilisha|Rudi|Endelea|Kinachofuata)[^']*'/,
    );
  });

  it('names every stage, group, row, value and action in the shipped English copy', () => {
    const strings = [
      // Stage headings.
      'What did you find?',
      'Identify the item',
      'Where did you find it?',
      'How can we reach you?',
      'Check your report',
      // Progress rail and the polite announcement.
      'Report a found item progress',
      'Step',
      'of',
      // Review groups, rows and their values.
      'What you found',
      'Identifying details',
      'Where you found it',
      'How we reach you',
      'Photograph attached',
      'No photograph yet',
      'Not chosen',
      'Item title',
      'Description',
      'Not provided',
      'Place',
      'Coordinates shared',
      'No',
      'Yes',
      'Email',
      'Finder account',
      'To be created',
      'Not requested',
      'What happens next',
      // Actions.
      'Continue',
      'Back',
      'Edit',
    ];
    expect(strings.length).toBeGreaterThan(25);
    for (const literal of strings) {
      expect(FINDER, `missing copy: ${literal}`).toContain(copy(literal));
    }
  });
});

describe('UX-05 the chrome sits on the UX-01 ladders and the shared primitives', () => {
  it('builds on the shared foundation instead of forking new controls', () => {
    expect(FINDER).toContain("import { Button, ICON_SIZE, Input, Select, Stepper, LocationFirstField } from './ui';");
    for (const primitive of ['<Stepper', '<Input', '<Select', '<Button']) {
      expect(FINDER, `missing ${primitive}`).toContain(primitive);
    }
    // The review recap reads as a description list.
    expect(PRIMITIVES).toContain('<dl className="divide-y divide-[var(--appearance-border)]">{children}</dl>');
    // Icons are decorative and sized from the shared ladder.
    expect(PRIMITIVES).toContain('size={ICON_SIZE.metadata}');
    expect(PRIMITIVES).toContain('aria-hidden="true"');
  });

  it('uses the type, radius and appearance ladders', () => {
    expect(AUTHORED).toContain('text-heading font-extrabold tracking-tight');
    expect(AUTHORED).toContain('text-body-large font-semibold');
    expect(AUTHORED).toContain('text-caption font-bold');
    expect(AUTHORED).toContain('text-body text-[var(--appearance-text-primary)]');
    expect(AUTHORED).toContain('text-small text-[var(--appearance-text-muted)]');
    expect(AUTHORED).toContain('rounded-panel');
    for (const token of [
      '--appearance-text-primary',
      '--appearance-text-muted',
      '--appearance-surface',
      '--appearance-surface-muted',
      '--appearance-border',
    ]) {
      expect(AUTHORED, `missing appearance token ${token}`).toContain(token);
    }
  });

  it('adds no off-ladder type, no arbitrary pixel size and no focus suppression', () => {
    expect(AUTHORED).not.toMatch(/text-\[\d+px\]/);
    expect(AUTHORED).not.toContain('outline-none');
    expect(AUTHORED).not.toContain('focus:ring');
    expect(AUTHORED).not.toContain('focus-visible:');
  });

  it('takes every colour of the authored chrome from an appearance token', () => {
    expect(AUTHORED).not.toMatch(
      /\b(?:bg|text|border|ring)-(?:white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?\b/,
    );
  });

  it('every control the Finder presses clears the 44px target floor', () => {
    // Continue / Back and the review edits use the shared Button ladder…
    expect(FOOTER).toContain('size="lg"');
    expect(FOOTER).toContain('size="md"');
    expect(PRIMITIVES).toContain('size="md"');
    expect(FOOTER).not.toContain('size="sm"');
    expect(PRIMITIVES).not.toContain('size="sm"');
    // …whose md and lg heights are 44px and 52px, measured by the primitive.
    expect(BUTTON_TSX).toContain("md: 'h-11 px-5 text-body rounded-standard'");
    expect(BUTTON_TSX).toContain("lg: 'h-13 px-6 text-body-large rounded-standard'");
  });

  it('keeps the two documented legacy carve-outs pinned by publicExperience', () => {
    for (const literal of LEGACY_STONE_LITERALS) {
      expect(FINDER, `pinned shade ${literal} disappeared`).toContain(literal);
    }
    // The photograph group heading and its icon-only upload control stay as
    // publicExperience pins them, so the photo stage was moved, not restyled.
    expect(FINDER_TSX).toContain('<p className="block text-sm font-extrabold text-primary-green">{t.capturePhoto} *</p>');
    expect(FINDER_TSX).toContain("aria-label={'Upload a photo'}");
  });
});







