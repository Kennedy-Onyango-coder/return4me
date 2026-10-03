// =============================================================================
// RETURN4ME UX-04 — REPORT-A-LOST-ITEM JOURNEY: STEP FOCUS, FIELD-LEVEL ERRORS,
// GROUPED REVIEW, BILINGUAL COPY AND TOUCH ERGONOMICS
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
//   * every customer-visible string in this component is bilingual;
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

/** The review's item value: the live bilingual category name, falling back to the id. */
const categoryNameCall = 'categoryName(categories, form.categoryId, sw) || form.categoryId';

const WIZARD_TSX = read('src/components/customer/LostReportWizard.tsx');
const WIZARD = stripComments(WIZARD_TSX);
const SECTION = stripComments(read('src/components/customer/LostReportsSection.tsx'));
const STEPPER_TSX = read('src/components/ui/Stepper.tsx');

/** One bilingual literal, written the way the component writes it. */
const copy = (en: string, sw: string) => `t('${en}', '${sw}')`;

/* The three data-entry steps as ONE slice, cut on RENDERED anchors rather than
   on comment markers (comment stripping removes those): from the first step
   heading to the review heading. A rule asserted here can therefore never be
   satisfied by markup belonging to the review step or the footer. */
const QUESTIONS = WIZARD.slice(
  WIZARD.indexOf(copy('What did you lose?', 'Ulipoteza nini?')),
  WIZARD.indexOf(copy('Check your report', 'Hakiki ripoti yako')),
);
/* The review step: its heading to the navigation footer that follows it. */
const REVIEW = WIZARD.slice(
  WIZARD.indexOf(copy('Check your report', 'Hakiki ripoti yako')),
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

  it('still derives the progress rail from the shared step list, bilingually', () => {
    expect(WIZARD).toContain(
      'const stepperSteps = LOST_REPORT_WIZARD_STEPS.map((s) => ({ label: sw ? s.sw : s.en }));',
    );
    expect(WIZARD).toContain(copy('Report a lost item progress', 'Maendeleo ya kuripoti kitu kilichopotea'));
  });

  it('keeps ONE submit path: re-validate every step, then one API call', () => {
    expect((WIZARD.match(/await createLostReport\(payload\)/g) || []).length).toBe(1);
    // Re-validated from step 0 before sending, because the customer may have
    // gone back and changed an earlier answer.
    expect(WIZARD).toContain('for (let s = 0; s <= 2; s++) {');
    expect(WIZARD).toContain('const error = validateStep(s, form, t);');
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
    // One ref per validated field, each attached to the Input/Select itself.
    expect((WIZARD.match(/ref=\{setFieldRef</g) || []).length).toBe(6);
    expect(WIZARD).toContain("ref={setFieldRef<HTMLSelectElement>('categoryId')}");
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
    expect((WIZARD.match(/error=\{fieldError\('/g) || []).length).toBe(6);
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
    // category, county, sub-county, exact place, lost-from — the five fields the
    // API refuses when empty. Marking anything else required here would invent a
    // rule the server does not have.
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
    expect(REVIEW).toContain(copy('What you lost', 'Ulipoteza nini'));
    expect(REVIEW).toContain(copy('Identifying details', 'Maelezo ya kutambua'));
    expect(REVIEW).toContain(copy('Where you lost it', 'Palipopotea'));
    expect(REVIEW).toContain(copy('When you lost it', 'Ilipotea lini'));
    expect(REVIEW).toContain(copy('What happens next', 'Kinachofuata'));
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
    expect((REVIEW.match(/editLabel=\{t\('Edit', 'Badilisha'\)\}/g) || []).length).toBe(4);
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
    expect(REVIEW).toContain(copy('Item', 'Kitu'));
    expect(REVIEW).toContain(copy('Place', 'Mahali'));
    expect(REVIEW).toContain(copy('Time window', 'Kipindi cha muda'));
    expect(REVIEW).toContain('formatWindow(form.lostAtFrom, form.lostAtTo, sw)');
    expect(REVIEW).toContain(categoryNameCall);
  });

  it('shows that an identifier was recorded WITHOUT echoing the number', () => {
    expect(REVIEW).toContain('identifierClassLabel(form.documentType, sw)');
    expect(REVIEW).toContain("form.documentNumber.trim() ? ` · ${t('recorded', 'imewekwa')}` : ''");
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

describe('UX-04 every identifier class has a bilingual, non-technical label', () => {
  it('labels each class in both languages and never shows the raw value', () => {
    expect(LOST_REPORT_IDENTIFIER_CLASSES.length).toBeGreaterThan(1);
    for (const entry of LOST_REPORT_IDENTIFIER_CLASSES) {
      expect(identifierClassLabel(entry.value, false), entry.value).toBe(entry.en);
      expect(identifierClassLabel(entry.value, true), entry.value).toBe(entry.sw);
      // A real translation, and never the stored token.
      expect(entry.sw, `${entry.value} is untranslated`).not.toBe(entry.en);
      expect(identifierClassLabel(entry.value, false)).not.toBe(entry.value);
    }
  });

  it('falls back to the stored value for a class it does not know', () => {
    expect(identifierClassLabel('not-a-real-class', false)).toBe('not-a-real-class');
    expect(identifierClassLabel('', true)).toBe('');
  });
});

describe('UX-04 one submit action, and nothing that can submit early', () => {
  it('keeps exactly one submit control in the whole component', () => {
    expect((WIZARD.match(/type="submit"/g) || []).length).toBe(1);
    expect((WIZARD.match(/variant="accent"/g) || []).length).toBe(1);
    expect(FOOTER).toContain(copy('Submit lost report', 'Tuma ripoti ya kitu kilichopotea'));
    expect(FOOTER).toContain(copy('Submitting…', 'Inatuma…'));
  });

  it('makes Continue and every review edit a plain button', () => {
    expect((WIZARD.match(/type="button"/g) || []).length).toBe(3);
    expect(FOOTER).toContain(copy('Continue', 'Endelea'));
    expect(FOOTER).toContain('onClick={goNext}');
    expect(PRIMITIVES).toContain('type="button"');
  });

  it('swaps the action on the last step and keeps a way back on every step', () => {
    expect(FOOTER).toContain('{isLastStep ? (');
    expect(FOOTER).toContain(
      `{step === 0 ? ${copy('Cancel', 'Ghairi')} : ${copy('Back', 'Rudi')}}`,
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
      `{${copy('Step', 'Hatua')}} {step + 1} {${copy('of', 'kati ya')}} {LOST_REPORT_WIZARD_STEPS.length}: {currentStepLabel}`,
    );
  });
});

describe('UX-04 every customer-visible string in the wizard is bilingual', () => {
  it('passes two inline source strings to every translate call', () => {
    const calls = (WIZARD.match(/\bt\(/g) || []).length;
    const quoted = (WIZARD.match(/\bt\(\s*'/g) || []).length;
    const interpolated = (WIZARD.match(/\bt\(\s*`/g) || []).length;
    expect(calls).toBeGreaterThan(80);
    // Every call is `t('<en>', '<sw>')` plus the single interpolated limit
    // message. A copy string that existed in one language only would break this.
    expect(quoted + interpolated).toBe(calls);
    expect(interpolated).toBe(1);
    expect(WIZARD).toContain("const sw = lang === 'sw';");
    expect(WIZARD).toContain('const t = (en: string, swText: string) => (sw ? swText : en);');
  });

  it('has no hard-coded English in a copy-bearing attribute', () => {
    // label / hint / placeholder / aria-label / title are always expressions.
    // (Comments are stripped first, so prose in a comment cannot hide a miss.)
    expect(WIZARD).not.toMatch(/\b(?:label|hint|placeholder|aria-label|title)=(?:"|')/);
  });

  it('names every step, group, field and action in both languages', () => {
    const pairs: Array<[string, string]> = [
      // Steps.
      ['What did you lose?', 'Ulipoteza nini?'],
      ['Describe the item', 'Eleza kitu'],
      ['Where and when did you lose it?', 'Ulipopoteza na lini?'],
      ['Check your report', 'Hakiki ripoti yako'],
      // Group headings.
      ['Item details', 'Maelezo ya kitu'],
      ['Notes', 'Maelezo ya ziada'],
      ['Where you lost it', 'Palipopotea'],
      ['When you lost it', 'Ilipotea lini'],
      ['What happens next', 'Kinachofuata'],
      // Field labels.
      ['Item category', 'Aina ya kitu'],
      ['Identifying number (optional)', 'Namba ya utambulisho (si lazima)'],
      ['What kind of number is it?', 'Ni namba ya aina gani?'],
      ['The number', 'Namba yenyewe'],
      ['Brand (optional)', 'Chapa (si lazima)'],
      ['Model (optional)', 'Modeli (si lazima)'],
      ['Colour (optional)', 'Rangi (si lazima)'],
      ['Material (optional)', 'Nyenzo (si lazima)'],
      ['Description (optional)', 'Maelezo (si lazima)'],
      ['Distinctive marks (optional)', 'Alama za kipekee (si lazima)'],
      ['County', 'Kaunti'],
      ['Sub-county', 'Kaunti ndogo'],
      ['Exact place', 'Mahali halisi'],
      ['Landmark (optional)', 'Alama ya eneo (si lazima)'],
      ['Lost from', 'Ilipotea kuanzia'],
      ['Lost until (optional)', 'Ilipotea hadi (si lazima)'],
      // Review rows and their group titles.
      ['What you lost', 'Ulipoteza nini'],
      ['Identifying details', 'Maelezo ya kutambua'],
      ['Item', 'Kitu'],
      ['Identifying number', 'Namba ya utambulisho'],
      ['Brand, model, colour, material', 'Chapa, modeli, rangi, nyenzo'],
      ['Description', 'Maelezo'],
      ['Distinctive marks', 'Alama za kipekee'],
      ['Place', 'Mahali'],
      ['Time window', 'Kipindi cha muda'],
      // Actions.
      ['Continue', 'Endelea'],
      ['Back', 'Rudi'],
      ['Cancel', 'Ghairi'],
      ['Edit', 'Badilisha'],
      ['Submit lost report', 'Tuma ripoti ya kitu kilichopotea'],
      ['Submitting…', 'Inatuma…'],
    ];
    expect(pairs.length).toBeGreaterThan(35);
    for (const [en, sw] of pairs) {
      expect(WIZARD, `missing copy: ${en}`).toContain(copy(en, sw));
      // A real translation, never the English string reused as its own Swahili.
      expect(sw, `untranslated: ${en}`).not.toBe(en);
      expect(en).not.toBe('');
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
    // Every sized control clears 44px; the compact size UX-04 removed is gone.
    expect(WIZARD).not.toMatch(/size="(?:xs|sm)"/);
    expect((WIZARD.match(/size="(?:md|lg)"/g) || []).length).toBe(4);
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
  it('is still mounted by the lost-reports section with the same five props', () => {
    expect(SECTION).toContain('<LostReportWizard');
    expect(SECTION).toContain('lang={lang}');
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
    expect(WIZARD).toContain("import { Banner, Button, Input, Select, Stepper, Textarea } from '../ui';");
    // The progress rail keeps marking the current step for assistive tech.
    expect(STEPPER_TSX).toContain("aria-current={isCurrent ? 'step' : undefined}");
    for (const raw of ['<button', '<input', '<select', '<textarea']) {
      expect(WIZARD, `raw ${raw} control in the wizard`).not.toContain(raw);
    }
  });
});
