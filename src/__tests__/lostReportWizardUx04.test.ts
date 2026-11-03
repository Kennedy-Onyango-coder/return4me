// =============================================================================
// RETURN4ME UX-04 — REPORT-A-LOST-ITEM JOURNEY: STEP FOCUS, FIELD-LEVEL ERRORS,
// GROUPED REVIEW, INLINE COPY AND TOUCH ERGONOMICS
// =============================================================================
// Source-level tripwires, matching this repository's other UX batches
// (homepageUx03Hierarchy, publicChromeUx02, designSystemPrimitives): there is no
// jsdom / React Testing Library harness here, so every contract below is
// asserted against the source that actually ships — with comments removed, so
// prose can neither satisfy a "must exist" pin nor defeat a "must never come
// back" tripwire.
//
// WHAT THIS SUITE PINS (and what a later change would trip):
//   * the journey is STILL the same four-step machine with the same single
//     submit path: UX-04 moved presentation and form ergonomics only;
//   * focus moves deliberately exactly TWICE in the whole workflow — to the new
//     step heading on a step change, and to the failing field on a validation
//     failure — and the heading it moves to exists once per render, is
//     script-reachable (tabIndex -1) while staying out of the tab order, and
//     names the step region it sits in;
//   * a failure is reported AT the field it belongs to, through the shared
//     Input/Select error channel — never as a second form-level summary;
//   * there is exactly ONE submit action, and both "Continue" and the review's
//     edit affordances are plain buttons, so pressing Enter in a text field can
//     never submit a half-finished report;
//   * every customer-visible string is plain English and written inline in this
//     component: the Swahili half of the UI was removed product-wide after UX-04,
//     and the journey still owns every string it shows rather than inheriting one;
//   * the journey sits on the UX-01 ladders (type, icon, radius, appearance) in
//     BOTH themes, every control clears the 44px target floor, nothing
//     suppresses the global focus indicator, and no raw palette survives;
//   * no private field, no overclaim and no matching logic — the deeper boundary
//     pins live in components/customer/__tests__/lostReportUxBoundary.test.ts.
//
// SCOPE: presentation contracts only. The payload, the validation rules and the
// endpoint stay pinned by accountGateAndWizard.test.ts and lostReportRoutes.test.ts;
// this suite deliberately does not restate them, so the two cannot contradict
// each other.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { identifierClassLabel } from '../components/customer/LostReportWizard';
import {
  LOST_REPORT_IDENTIFIER_CLASSES,
  LOST_REPORT_WIZARD_STEPS,
} from '../config/lostReportPresentation';

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

/**
 * Source with comments removed (see the note above) and line endings
 * normalised, so an assertion can quote a two-line JSX block without depending
 * on the file's CRLF/LF style.
 */
const stripComments = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/\r\n/g, '\n');

/** The review's item value: the live category name, falling back to the id. */
const categoryNameCall = 'categoryName(categories, form.categoryId) || form.categoryId';

const WIZARD_TSX = read('src/components/customer/LostReportWizard.tsx');
const WIZARD = stripComments(WIZARD_TSX);
const SECTION = stripComments(read('src/components/customer/LostReportsSection.tsx'));
const STEPPER_TSX = read('src/components/ui/Stepper.tsx');

/** One copy literal, written the way the component writes it. */
const copy = (en: string) => `'${en}'`;

/* The three data-entry steps as ONE slice, cut on RENDERED anchors rather than
   on comment markers (comment stripping removes those): from the first step
   heading to the review heading. A rule asserted here can therefore never be
   satisfied by markup belonging to the review step or the footer.
   The anchors are the `title={...}` the shared StepIntro actually renders, so
   the slice follows the component's own step headings. */
const QUESTIONS = WIZARD.slice(
  WIZARD.indexOf(`title={${copy('What did you lose?')}}`),
  WIZARD.indexOf(`title={${copy('Check your report')}}`),
);
/* The review step: its heading to the navigation footer that follows it. */
const REVIEW = WIZARD.slice(
  WIZARD.indexOf(`title={${copy('Check your report')}}`),
  WIZARD.indexOf('flex flex-col-reverse sm:flex-row'),
);
/* The footer itself (back / continue / submit). */
const FOOTER = WIZARD.slice(WIZARD.indexOf('flex flex-col-reverse sm:flex-row'));
/* The review's own primitives (ReviewGroup / SummaryRow) are declared BELOW the
   component in this file, so the footer separates them from the step markup. */
const PRIMITIVES = WIZARD.slice(WIZARD.indexOf('function ReviewGroup'));

describe('UX-04 the journey is still the same four-step machine', () => {
  it('renders one bounded step per LOST_REPORT_WIZARD_STEPS entry', () => {
    expect(LOST_REPORT_WIZARD_STEPS).toHaveLength(4);
    expect(WIZARD).toContain('const [step, setStep] = useState(0);');
    for (let i = 0; i < 4; i++) {
      expect(WIZARD, `step ${i} is no longer rendered`).toContain(`{step === ${i} && (`);
    }
  });

  it('still derives the progress rail from the shared step list', () => {
    expect(WIZARD).toContain(
      'const stepperSteps = LOST_REPORT_WIZARD_STEPS.map((s) => ({ label: s.en }));',
    );
    // The rail is labelled from the same shared list, and the live status line
    // reads the current label out of it rather than keeping a second copy.
    expect(WIZARD).toContain(copy('Report a lost item progress'));
    expect(WIZARD).toContain('const currentStepLabel = stepperSteps[Math.max(0, Math.min(step, stepperSteps.length - 1))].label;');
  });

  it('keeps ONE submit path: re-validate every step, then one API call', () => {
    expect((WIZARD.match(/await createLostReport\(payload\)/g) || []).length).toBe(1);
    // Re-validated from step 0 before sending, because the customer may have
    // gone back and changed an earlier answer.
    expect(WIZARD).toContain('for (let s = 0; s <= 2; s++) {');
    expect(WIZARD).toContain('const error = validateStep(s, form);');
    expect(WIZARD).toContain('if (error) { setStep(s); setStepError(error); return; }');
    expect(WIZARD).toContain('e.preventDefault();');
    // The browser's own validation UI can never interrupt a step.
    expect(WIZARD).toContain('<form onSubmit={handleSubmit} noValidate');
    // ...and the form reports itself busy for the whole submission.
    expect(WIZARD).toContain('aria-busy={submitting}');
  });

  it('hands the new reference to its host instead of navigating itself', () => {
    expect(WIZARD).toContain('onCreated(result.data.reference);');
    expect(WIZARD).not.toContain('navigate(');
    expect(WIZARD).not.toContain('localStorage');
  });
});

describe('UX-04 focus moves deliberately, twice, and nowhere else', () => {
  it('moves focus to the step heading on a step CHANGE only', () => {
    expect(WIZARD).toContain('stepHeadingRef.current?.focus();');
    // Guarded, so mounting the wizard does not yank focus off the page.
    expect(WIZARD).toContain('if (previousStepRef.current === step) return;');
    expect(WIZARD).toContain('}, [step]);');
  });

  it('moves focus to the field that failed validation', () => {
    expect(WIZARD).toContain(
      'const fieldRefs = useRef<Partial<Record<WizardField, HTMLElement | null>>>({});',
    );
    expect(WIZARD).toContain('fieldRefs.current[stepError.field]?.focus();');
    expect(WIZARD).toContain('}, [stepError]);');
  });

  it('takes focus nowhere else in the whole workflow', () => {
    // Exactly two .focus() calls: the step heading and the failing field.
    expect((WIZARD.match(/\.focus\(\)/g) || []).length).toBe(2);
    // ...and no autoFocus attribute, which would fight them.
    expect(WIZARD).not.toContain('autoFocus');
  });

  it('focuses a heading that exists once, is script-reachable and names its step', () => {
    expect(WIZARD).toContain("const STEP_HEADING_ID = 'lost-report-step-heading';");
    // One heading per render (the shared StepIntro), so the id cannot collide.
    expect((WIZARD.match(/<h3/g) || []).length).toBe(1);
    expect(WIZARD).toContain('id={STEP_HEADING_ID}');
    expect(WIZARD).toContain('tabIndex={-1}');
    expect(WIZARD).toContain('ref={headingRef}');
    // Every step region is named by that same heading, so a step change lands
    // the customer inside a landmark that announces WHERE they now are.
    expect((WIZARD.match(/aria-labelledby=\{STEP_HEADING_ID\}/g) || []).length).toBe(4);
  });

  it('points its refs at real controls, not at wrappers', () => {
    // One ref per addressable field, each attached to the Input/Select itself:
    // the five validated fields plus the optional window end and the item name.
    expect((WIZARD.match(/ref=\{setFieldRef</g) || []).length).toBe(7);
    expect(WIZARD).toContain("ref={setFieldRef<HTMLSelectElement>('categoryId')}");
    expect(WIZARD).toContain("ref={setFieldRef<HTMLInputElement>('itemName')}");
    expect(WIZARD).toContain("ref={setFieldRef<HTMLSelectElement>('county')}");
    expect(WIZARD).toContain("ref={setFieldRef<HTMLSelectElement>('administrativeUnitId')}");
    expect(WIZARD).toContain("ref={setFieldRef<HTMLInputElement>('locationArea')}");
    expect(WIZARD).toContain("ref={setFieldRef<HTMLInputElement>('lostAtFrom')}");
    expect(WIZARD).toContain("ref={setFieldRef<HTMLInputElement>('lostAtTo')}");
  });
});

describe('UX-04 a failure is reported at the field it belongs to', () => {
  it('routes every validation message through the field error channel', () => {
    expect(WIZARD).toContain('const fieldError = (field: WizardField) =>');
    // PHASE 16.1 (BATCH 1): SEVEN fields now carry the inline error slot — the
    // item name joined the list (it is required) while the category kept its slot
    // (it is optional, so the slot renders nothing, but the field keeps the same
    // error/focus contract as the rest).
    expect((WIZARD.match(/error=\{fieldError\('/g) || []).length).toBe(7);
    expect(WIZARD).toContain("error={fieldError('itemName')}");
    expect(WIZARD).toContain("error={fieldError('categoryId')}");
    expect(WIZARD).toContain("error={fieldError('county')}");
    expect(WIZARD).toContain("error={fieldError('administrativeUnitId')}");
    expect(WIZARD).toContain("error={fieldError('locationArea')}");
    expect(WIZARD).toContain("error={fieldError('lostAtFrom')}");
    expect(WIZARD).toContain("error={fieldError('lostAtTo')}");
  });

  it('holds ONE failure at a time, together with the field it belongs to', () => {
    expect(WIZARD).toContain('interface StepError {\n  field: WizardField;\n  message: string;\n}');
    expect(WIZARD).toContain('const [stepError, setStepError] = useState<StepError | null>(null);');
    // The shared primitive owns the alert semantics; the wizard adds no second
    // live region and no error colour of its own.
    expect(WIZARD).not.toContain('role="alert"');
    expect(WIZARD).not.toMatch(/\b(?:text|bg|border)-(?:status|state)-[a-z]+/);
  });

  it('keeps the required set to what the server itself rejects', () => {
    // PHASE 16.1 (BATCH 1): the five fields the API refuses when empty are now
    // item name, county, sub-county, exact place and lost-from. The CATEGORY
    // moved OFF this list (an unclassified report is valid and is classified
    // later) and the ITEM NAME moved ON to it. Marking anything else required
    // here would invent a rule the server does not have.
    expect((QUESTIONS.match(/(?:^|\n)\s*required\n/g) || []).length).toBe(5);
  });

  it('clears a stale failure when the customer moves instead of stranding it', () => {
    // Advancing past a valid step clears the previous failure...
    expect(WIZARD).toContain('if (error) { setStepError(error); return; }\n    setStepError(null);');
    // ...and so do Back, the review's edit jumps, and a new submission.
    expect(WIZARD).toContain('setStepError(null);\n    if (step === 0) { onCancel(); return; }');
    expect(WIZARD).toContain('setStepError(null);\n    setSubmitError(null);');
    expect(WIZARD).toMatch(/setSubmitError\(null\);\s*for \(let s = 0; s <= 2; s\+\+\) \{/);
  });
});

describe('UX-04 the review step is grouped, editable and honest', () => {
  it('groups the summary by the part of the journey each value came from', () => {
    expect(REVIEW).toContain(copy('What you lost'));
    expect(REVIEW).toContain(copy('Identifying details'));
    expect(REVIEW).toContain(copy('Where you lost it'));
    expect(REVIEW).toContain(copy('When you lost it'));
    expect(REVIEW).toContain(copy('What happens next'));
    // Four groups. (Identifying details renders only once something was typed,
    // so the value list is driven by the form, never by a fixed template.)
    expect((REVIEW.match(/<ReviewGroup/g) || []).length).toBe(4);
    expect(REVIEW).toContain('[form.brand, form.model, form.colour, form.material, form.description, form.distinctiveMarks].some((v) => v.trim())');
  });

  it('offers exactly one edit per group, returning to that group\'s step', () => {
    const targets = (REVIEW.match(/onEdit=\{\(\) => goToStep\((\d)\)\}/g) || [])
      .map((call) => call.replace(/^.*goToStep\((\d)\)\}$/, '$1'));
    // What you lost -> step 1; identifying details -> step 2; where and when ->
    // step 3. Neither half of "where and when" can jump to the wrong half.
    expect(targets).toEqual(['0', '1', '2', '2']);
    // The control itself is the shared Button in "button" mode, never a submit.
    expect(PRIMITIVES).toContain('onClick={onEdit}');
  });

  it('gives every repeated edit control a distinct accessible name', () => {
    expect((REVIEW.match(/editLabel=\{'Edit'\}/g) || []).length).toBe(4);
    // The visible label is one word and repeats per group, so the accessible
    // name states WHICH group this edit returns to...
    expect(PRIMITIVES).toContain('aria-label={`${editLabel}: ${title}`}');
    // ...while the visible label stays the first word of that name, so WCAG
    // 2.5.3 (Label in Name) still holds for voice control.
    expect(PRIMITIVES).toContain('{editLabel}');
    expect(PRIMITIVES).toContain('type="button"');
  });

  it('reads the summary as a description list with the values the customer entered', () => {
    // The list semantics live in the review's own primitives...
    expect(PRIMITIVES).toContain('<dl className="divide-y divide-[var(--appearance-border)]">{children}</dl>');
    expect(PRIMITIVES).toContain('<dt className="w-40 shrink-0 text-caption font-bold text-[var(--appearance-text-muted)]">{label}</dt>');
    expect(PRIMITIVES).toContain('<dd className="min-w-0 flex-1 text-body text-[var(--appearance-text-primary)] leading-relaxed break-words whitespace-pre-wrap">');
    // ...and the values come from the live form, not from a fixed template.
    // PHASE 16.1 (BATCH 1): the review shows the item NAME and the item
    // CATEGORY as separate rows, so both labels are asserted and the category
    // value is still the live lookup (categoryNameCall, overwritten when the
    // report is deliberately submitted unclassified).
    expect(REVIEW).toContain(copy('Item name'));
    expect(REVIEW).toContain(copy('Item category'));
    expect(REVIEW).toContain(copy('Unclassified'));
    expect(REVIEW).toContain('form.itemName.trim()');
    expect(REVIEW).toContain(copy('Place'));
    expect(REVIEW).toContain(copy('Time window'));
    expect(REVIEW).toContain('formatWindow(form.lostAtFrom, form.lostAtTo)');
    expect(REVIEW).toContain(categoryNameCall);
  });

  it('shows that an identifier was recorded WITHOUT echoing the number', () => {
    expect(REVIEW).toContain('identifierClassLabel(form.documentType)');
    expect(REVIEW).toContain("form.documentNumber.trim() ? ` · ${'recorded'}` : ''");
    // The number itself never reaches the summary, the DOM or a screenshot.
    expect(REVIEW).not.toContain('${form.documentNumber}');
    expect(REVIEW).not.toContain('form.documentNumber}');
    expect(REVIEW).not.toContain('value={form.documentNumber');
  });

  it('states what happens next without promising recovery or leaking a detail', () => {
    expect(REVIEW).toContain('We will use these details to look for found items');
    expect(REVIEW).toContain('Submitting a report does not guarantee that your item will be recovered.');
    expect(REVIEW).toContain('A possible match is not proof of ownership.');
    expect(REVIEW).toContain('Your details stay private.');
    for (const line of ['We will use these details', 'does not guarantee', 'not proof of ownership', 'stay private']) {
      expect(REVIEW, `missing reassurance: ${line}`).toContain(line);
    }
  });
});

describe('UX-04 every identifier class has a plain, non-technical label', () => {
  it('labels each class and never shows the raw value', () => {
    expect(LOST_REPORT_IDENTIFIER_CLASSES.length).toBeGreaterThan(1);
    for (const entry of LOST_REPORT_IDENTIFIER_CLASSES) {
      expect(identifierClassLabel(entry.value), entry.value).toBe(entry.en);
      expect(identifierClassLabel(entry.value)).not.toBe(entry.value);
    }
  });

  it('falls back to the stored value for a class it does not know', () => {
    expect(identifierClassLabel('not-a-real-class')).toBe('not-a-real-class');
    expect(identifierClassLabel('')).toBe('');
  });
});

describe('UX-04 one submit action, and nothing that can submit early', () => {
  it('keeps exactly one submit control in the whole component', () => {
    expect((WIZARD.match(/type="submit"/g) || []).length).toBe(1);
    expect((WIZARD.match(/variant="accent"/g) || []).length).toBe(1);
    expect(FOOTER).toContain(copy('Submit lost report'));
    expect(FOOTER).toContain(copy('Submitting…'));
  });

  it('makes Continue and every review edit a plain button', () => {
    // Back, Continue, the review's edit button and the two compact controls in
    // the location-first affordance — never a second way to submit.
    expect((WIZARD.match(/type="button"/g) || []).length).toBe(5);
    expect(FOOTER).toContain(copy('Continue'));
    expect(FOOTER).toContain('onClick={goNext}');
    expect(PRIMITIVES).toContain('type="button"');
  });

  it('swaps the action on the last step and keeps a way back on every step', () => {
    expect(FOOTER).toContain('{isLastStep ? (');
    expect(FOOTER).toContain(
      `{step === 0 ? ${copy('Cancel')} : ${copy('Back')}}`,
    );
    expect(FOOTER).toContain('onClick={goBack}');
  });

  it('blocks the footer while a submission is in flight', () => {
    expect((FOOTER.match(/disabled=\{submitting\}/g) || []).length).toBe(2);
    expect(FOOTER).toContain('loading={submitting}');
    expect((FOOTER.match(/w-full sm:w-auto/g) || []).length).toBe(2);
  });

  it('announces the step change politely as well as moving focus', () => {
    expect(WIZARD).toContain('className="sr-only" role="status" aria-live="polite"');
    expect(WIZARD).toContain(
      `{'Step'} {step + 1} {'of'} {LOST_REPORT_WIZARD_STEPS.length}: {currentStepLabel}`,
    );
  });
});

describe('UX-04 every customer-visible string in the wizard is present and inline', () => {
  it('carries its copy as English literals, with no translator left over', () => {
    // UX-04 originally pinned a `t(en, sw)` helper because the product was
    // bilingual. The Swahili half of the UI has since been removed product-wide,
    // so the journey writes its copy inline in English — but it still OWNS every
    // string it shows: nothing is imported from a dictionary and no wording is
    // left to a primitive's default.
    expect(WIZARD).not.toContain('const t = (en: string, swText: string) =>');
    expect(WIZARD).not.toContain("const sw = lang === 'sw';");
    // Copy-bearing attributes are expressions rather than bare literals, so this
    // file is the single source of the wording the customer reads.
    expect((WIZARD.match(/\blabel=\{'/g) || []).length).toBeGreaterThan(10);
    expect((WIZARD.match(/\bplaceholder=\{'/g) || []).length).toBeGreaterThan(5);
  });

  it('has no hard-coded English in a copy-bearing attribute', () => {
    // label / hint / placeholder / aria-label / title are always expressions.
    // (Comments are stripped first, so prose in a comment cannot hide a miss.)
    expect(WIZARD).not.toMatch(/\b(?:label|hint|placeholder|aria-label|title)=(?:"|')/);
  });

  it('names every step, group, field and action in the copy it shows', () => {
    // The whole inventory of strings a customer can read in this journey. Kept as
    // a list so a string that is quietly dropped or reworded fails here, rather
    // than disappearing from the product unnoticed.
    const strings: string[] = [
      // The progress rail and the four step headings.
      'Report a lost item progress',
      'What did you lose?',
      'Describe the item',
      'Where and when did you lose it?',
      'Check your report',
      // Field and group labels for what was lost.
      'Item category',
      'Item name',
      'Identifying number (optional)',
      'What kind of number is it?',
      'The number',
      'Brand (optional)',
      'Model (optional)',
      'Colour (optional)',
      'Material (optional)',
      'Description (optional)',
      'Distinctive marks (optional)',
      'Notes',
      // Field labels for where and when it was lost.
      'County',
      'Sub-county',
      'Exact place',
      'Landmark (optional)',
      'Lost from',
      'Lost until (optional)',
      // Empty states and option copy.
      'Select a category',
      'Select a county',
      'Select county first',
      'Select a sub-county',
      'Not sure / prefer not to say',
      // Hints.
      'Stored only as a one-way fingerprint. It is never shown back to you, to a finder, or to an agent.',
      'Select county first, then choose its sub-county.',
      'Enter the street, estate, building or nearby place you know.',
      'Roughly when you last had it.',
      'Leave blank if you are not sure.',
      // Placeholders.
      'e.g. 12345678',
      'e.g. Samsung',
      'e.g. Galaxy A54',
      'e.g. Black',
      'e.g. Leather',
      // Group headings inside the steps and the review.
      'Where you lost it',
      'When you lost it',
      'What happens next',
      'What you lost',
      'Identifying details',
      // Review rows and their group titles.
      // PHASE 16.1 (BATCH 1): the single "Item" row became two explicit rows —
      // the item's NAME (now required) and its CATEGORY (now optional, so it has
      // to be able to say "Unclassified" instead of rendering a blank value).
      'Item name',
      'Item category',
      'Unclassified',
      'Classification',
      'Identifying number',
      'Brand, model, colour, material',
      'Description',
      'Distinctive marks',
      'Place',
      'Time window',
      // Actions, the live status line and the identifier marker.
      'Continue',
      'Cancel',
      'Back',
      'Edit',
      'Submit lost report',
      'Submitting…',
      'Step',
      'of',
      'recorded',
    ];
    expect(strings.length).toBeGreaterThan(45);
    for (const en of strings) {
      expect(en).not.toBe('');
      expect(WIZARD, `missing copy: ${en}`).toContain(copy(en));
    }
  });
});

describe('UX-04 the journey sits on the UX-01 ladders, in both themes', () => {
  it('uses the type ladder and never an off-ladder size or an arbitrary pixel value', () => {
    expect(WIZARD).toContain('text-heading font-extrabold tracking-tight');
    expect(WIZARD).toContain('text-body-large font-semibold');
    expect(WIZARD).toContain('text-caption font-bold');
    expect(WIZARD).toContain('text-body text-[var(--appearance-text-primary)]');
    expect(WIZARD).toContain('text-small text-[var(--appearance-text-muted)]');
    // Tailwind's default sizes and hand-picked pixels are both off the ladder.
    expect(WIZARD).not.toMatch(/\btext-(?:xs|sm|base|lg|xl|2xl|3xl|4xl)\b/);
    expect(WIZARD).not.toMatch(/text-\[\d+px\]/);
    expect(WIZARD).not.toMatch(/leading-\[/);
  });

  it('uses the radius ladder, the icon ladder and nothing below the touch floor', () => {
    expect(WIZARD).toContain('rounded-standard');
    expect(WIZARD).toContain('rounded-panel');
    expect(WIZARD).not.toMatch(/\brounded-(?:sm|md|lg|xl|2xl|3xl|full|none)\b/);
    // Four icons, all sized from the shared ladder, all decorative.
    expect((WIZARD.match(/size=\{ICON_SIZE\.[a-z]+\}/g) || []).length).toBe(4);
    expect(WIZARD).not.toMatch(/size=\{\d+\}/);
    expect((WIZARD.match(/<(?:AlertCircle|Check|MapPin|Package|Pencil|Icon)\b/g) || []).length).toBe(4);
    expect((WIZARD.match(/aria-hidden="true"/g) || []).length).toBe(4);
    // Every control the journey itself owns clears the 44px floor: submit is lg
    // (52px), Back/Continue and each review edit are md (44px). The compact size
    // UX-04 removed from those is gone.
    expect(WIZARD).not.toMatch(/size="xs"/);
    expect((WIZARD.match(/size="(?:md|lg)"/g) || []).length).toBe(4);
    // The only compact controls left are the two inside the location-first
    // affordance added after this batch (Button sm = 36px). They are pinned BY
    // COUNT rather than whitewashed, so a third compact control — or a compact
    // size on any journey control — still fails this test.
    expect((WIZARD.match(/size="sm"/g) || []).length).toBe(2);
    expect(WIZARD).toContain('size="sm" onClick={applyDetectedLocation}>Use this location</Button>');
  });

  it('takes every colour from an appearance token, so both themes keep working', () => {
    for (const token of [
      '--appearance-text-primary',
      '--appearance-text-muted',
      '--appearance-surface',
      '--appearance-surface-muted',
      '--appearance-border',
      '--appearance-success',
      '--appearance-warning',
    ]) {
      expect(WIZARD, `missing appearance token ${token}`).toContain(token);
    }
    // No raw palette, no status shorthand: a light-only colour would break dark mode.
    expect(WIZARD).not.toMatch(
      /\b(?:bg|text|border|ring|from|to|via)-(?:white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?\b/,
    );
    expect(WIZARD).not.toMatch(/\b(?:text|bg|border)-(?:status|state)-[a-z]+/);
    // The two one-off utilities earlier revisions leaned on must not come back.
    expect(WIZARD).not.toContain('accent-orange');
    expect(WIZARD).not.toContain('brand-dark-text');
  });

  it('leaves the global focus indicator alone', () => {
    for (const cls of ['outline-none', 'focus:outline', 'focus:ring', 'ring-2', 'focus-visible:']) {
      expect(WIZARD, `the wizard must not restyle focus with ${cls}`).not.toContain(cls);
    }
  });
});

describe('UX-04 the host contract and the shared primitives are unchanged', () => {
  it('is still mounted by the lost-reports section with the same four props', () => {
    expect(SECTION).toContain('<LostReportWizard');
    expect(SECTION).toContain('categories={categories}');
    expect(SECTION).toContain('categoriesLoading={categoriesLoading}');
    expect(SECTION).toContain('onCancel={() => setWizardOpen(false)}');
    expect(SECTION).toContain('onCreated={handleCreated}');
    // The customer entry point still opens the surface the wizard lives in.
    expect(read('src/components/ReportLostView.tsx')).toContain('startInWizard');
  });

  it('keeps the heading hierarchy it inherits from the host, skipping no level', () => {
    // The host names the surface (h2); the wizard's step headings are h3 and its
    // within-step groups h4. The wizard adds no h1/h2 of its own.
    expect(SECTION).toContain('<h2');
    expect(WIZARD).toContain('<h3');
    expect((WIZARD.match(/<h4/g) || []).length).toBe(6);
    expect(WIZARD).not.toMatch(/<h[12]/);
  });

  it('builds on the shared primitives instead of forking raw controls', () => {
    expect(WIZARD).toContain("import { Banner, Button, Input, Select, Stepper, Textarea, LocationFirstField } from '../ui';");
    // The progress rail keeps marking the current step for assistive tech.
    expect(STEPPER_TSX).toContain("aria-current={isCurrent ? 'step' : undefined}");
    for (const raw of ['<button', '<input', '<select', '<textarea']) {
      expect(WIZARD, `raw ${raw} control in the wizard`).not.toContain(raw);
    }
  });
});
