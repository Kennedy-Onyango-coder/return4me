import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// UX-10 — THE PUBLIC "BECOME AN AGENT" PAGE (BecomeAgentView.tsx)
// =============================================================================
// "Agent Portal" sits in the public navigation as a primary destination, so the
// page behind it has to do two jobs at once: explain a job to somebody who has
// never done it, and get the willing ones into the existing agent surface. It
// was doing neither. It explained the role in flat prose, then sent a
// first-time visitor to a staff-facing sign-in screen; its two buttons carried
// identical weight; and nothing on it said what the job actually is, what the
// application asks for, or what happens after it is submitted.
//
// UX-10 makes the page an argument, in six ordered sections: the hero (the role,
// and the ONE action), why the role exists, the three responsibilities, the
// requirements, the three REAL approval stages, and the closing action. Agents
// still enter the product through the SAME existing /agent_portal surface.
//
// UX-10 IS PRESENTATION ONLY. It deliberately changes none of:
//   * the route: the primary action still calls `onContinueToAgentPortal` (the
//     existing /agent_portal view) and the secondary action still calls the
//     existing Sign In chooser. No second registration flow is created;
//   * the data layer: the page fetches nothing, stores nothing and holds no
//     state of its own — it is a static explanation of an existing process;
//   * the vocabulary it reports: the requirements are the fields AgentView's
//     registration already collects, and the approval stages are the ones
//     AgentView already shows a pending applicant, in the same order;
//   * the economics: a share of the recovery fee, as the fee engine implements
//     it. No amount, percentage or time-to-payout is invented.
// What it changes is the section order and hierarchy, the copy in both
// languages, the single dominant action, and the type / colour / icon / radius
// vocabulary — all of it by adopting primitives and tokens that already exist
// (`Button`, `SectionHeading`, `Stepper`, `ICON_SIZE`, the `--appearance-*`
// tokens, and the type and radius ladders).
//
// This repository has no jsdom/React harness, so — exactly as the UX-06, UX-07,
// UX-08 and UX-09 batches do — the contract is asserted against the shipped
// source, with the same comment stripper and the same `sliceBetween` helper.

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
/** The same comment stripper the N3, UX-06, UX-07, UX-08 and UX-09 suites use. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** Raw: the block comments that introduce each section act as stable delimiters. */
const VIEW_TSX = read('src/components/BecomeAgentView.tsx');
const VIEW = stripComments(VIEW_TSX);
/** The agent surface this page leads to: the stages and fields it reports. */
const AGENT_VIEW = read('src/components/AgentView.tsx');
const INDEX_CSS = read('src/index.css');
const DESIGN_SYSTEM = read('docs/design-system.md');

const count = (source: string, pattern: RegExp) => (source.match(pattern) || []).length;

function sliceBetween(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = start === -1 ? -1 : source.indexOf(to, start + from.length);
  if (start === -1 || end === -1) throw new Error(`UX-10 marker not found: ${from} -> ${to}`);
  return source.slice(start, end);
}

/**
 * One rendered section, sliced out of the RAW source and then stripped, so a
 * comment can never be mistaken for rendered copy. The closing band is the last
 * section in the file, so it is sliced against the container's closing tag
 * instead of the next `<section`.
 */
const section = (id: string, to = '\n      <section') =>
  stripComments(sliceBetween(VIEW_TSX, `aria-labelledby="${id}"`, to));

const HERO = section('agent-hero-heading');
const WHY = section('agent-why-heading');
const RESPONSIBILITIES = section('agent-responsibilities-heading');
const REQUIREMENTS = section('agent-requirements-heading');
const APPROVAL = section('agent-approval-heading');
const CTA = section('agent-cta-heading', '\n    </div>');

const SECTION_IDS = [
  'agent-hero-heading',
  'agent-why-heading',
  'agent-responsibilities-heading',
  'agent-requirements-heading',
  'agent-approval-heading',
  'agent-cta-heading',
] as const;

/**
 * Every `t('english', 'kiswahili')` pair in a stripped source string. Either
 * quote style is accepted, plus the backticks one call site needs for an
 * interpolated count; the trailing comma some call sites carry is optional, and
 * so is the argument layout. The pair is the contract, not the punctuation.
 */
function bilingualPairs(source: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const re =
    /\bt\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`)\s*,\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`)\s*,?\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    pairs.push([match[1] ?? match[2] ?? match[3], match[4] ?? match[5] ?? match[6]]);
  }
  return pairs;
}

// -----------------------------------------------------------------------------
// The page is an argument in six ordered sections.
// -----------------------------------------------------------------------------

describe('UX-10 explains the role in six ordered sections', () => {
  it('renders six labelled sections, in the order the argument runs', () => {
    const positions = SECTION_IDS.map((id) => VIEW_TSX.indexOf(`aria-labelledby="${id}"`));
    for (const [index, id] of SECTION_IDS.entries()) {
      expect(positions[index], `UX-10 section missing: ${id}`).toBeGreaterThan(-1);
    }
    expect(positions, 'the six sections must appear in argument order').toEqual(
      [...positions].sort((a, b) => a - b),
    );
    expect(count(VIEW, /aria-labelledby="agent-[a-z-]+-heading"/g)).toBe(6);
    // Six outer sections, plus the one card template the three responsibilities
    // are mapped through.
    expect(count(VIEW, /<section/g)).toBe(7);
  });

  it('gives the page one h1, one hand-written h2, and four primitive headings', () => {
    expect(count(VIEW, /<h1\b/g)).toBe(1);
    // The closing band owns the only literal h2; SectionHeading renders the rest.
    expect(count(VIEW, /<h2\b/g)).toBe(1);
    expect(count(VIEW, /<SectionHeading/g)).toBe(4);
    expect(count(VIEW, /titleId="agent-[a-z-]+-heading"/g)).toBe(4);
    // The mapped card titles sit one rung below their section heading.
    expect(count(VIEW, /<h3\b/g)).toBe(2);
    // Two headings are written by hand; every label points at a heading that
    // exists, and each of the six labels is used exactly once.
    expect(VIEW.match(/id="agent-[a-z-]+-heading"/g)).toEqual([
      'id="agent-hero-heading"',
      'id="agent-cta-heading"',
    ]);
    const labels = [...VIEW.matchAll(/aria-labelledby="(agent-[a-z-]+-heading)"/g)].map((m) => m[1]);
    expect(labels).toEqual([...SECTION_IDS]);
    for (const id of SECTION_IDS) {
      const rendered = VIEW.includes(`id="${id}"`) || VIEW.includes(`titleId="${id}"`);
      expect(rendered, `${id} must be rendered by a real heading`).toBe(true);
    }
  });

  it('opens with a hero that states the role and carries the page one dominant action', () => {
    expect(HERO).toContain('Become a Return4me agent');
    expect(HERO).toContain('Kuwa wakala wa Return4me');
    expect(HERO).toContain('<h1');
    expect(HERO).toContain('id="agent-hero-heading"');
    // One action, and it is the one the whole page exists to produce.
    expect(count(HERO, /<Button/g)).toBe(1);
    expect(HERO).toContain('variant="accent"');
    expect(HERO).toContain('size="lg"');
    expect(HERO).toContain('onClick={onContinueToAgentPortal}');
    expect(HERO).toContain('{applyLabel}');
    // ...and no competing route beside it inside the hero.
    expect(count(HERO, /onClick=\{onSignIn\}/g)).toBe(0);
  });

  it('repeats the SAME action in the closing band, worded from a single source', () => {
    // The label exists once in the file and is rendered twice, so the hero and
    // the closing band cannot drift apart.
    expect(count(VIEW, /const applyLabel = t\(/g)).toBe(1);
    expect(count(VIEW, /Continue to agent registration/g)).toBe(1);
    expect(count(VIEW, /Endelea kusajiliwa kama wakala/g)).toBe(1);
    expect(count(VIEW, /\{applyLabel\}/g)).toBe(2);
    expect(CTA).toContain('{applyLabel}');
    expect(CTA).toContain('onClick={onContinueToAgentPortal}');
  });

  it('offers exactly three actions on the whole page: one primary, two quiet routes', () => {
    expect(count(VIEW, /<Button/g)).toBe(3);
    expect(count(VIEW, /size="lg"/g)).toBe(3);
    // Only ONE accent: nothing competes with the apply action.
    expect(count(VIEW, /variant="accent"/g)).toBe(1);
    const variants = [...VIEW.matchAll(/variant="([a-z]+)"/g)].map((m) => m[1]);
    expect(variants).toEqual(['accent', 'secondary', 'inverse']);
    expect(CTA).toContain('variant="inverse"');
    expect(CTA).toContain('onClick={onSignIn}');
    expect(count(CTA, /variant="accent"/g)).toBe(0);
    // Three click handlers, and only the two existing destinations.
    const handlers = [...VIEW.matchAll(/onClick=\{([a-zA-Z]+)\}/g)].map((m) => m[1]);
    expect(handlers).toEqual([
      'onContinueToAgentPortal',
      'onContinueToAgentPortal',
      'onSignIn',
    ]);
  });

  it('answers the question why the role exists with a claim and three statements', () => {
    expect(WHY).toContain('Why it matters');
    expect(WHY).toContain('Kwa nini ni muhimu');
    expect(WHY).toContain('A found item has nowhere to go without someone holding it');
    expect(VIEW).toContain('const whyPoints: Array<{ title: string; body: string }> = [');
    const points = sliceBetween(VIEW_TSX, 'const whyPoints', 'const responsibilities');
    const titles = [...points.matchAll(/title: t\('([^']+)'/g)].map((m) => m[1]);
    expect(titles).toEqual([
      'You are the trusted third party',
      'Nothing moves on an unconfirmed identity',
      'Your premises become a recovery point',
    ]);
  });

  it('states the three responsibilities as equal, unranked cards', () => {
    expect(VIEW).toContain('const responsibilities: Array<{ icon: LucideIcon; title: string; body: string }> = [');
    expect(RESPONSIBILITIES).toContain('Three responsibilities');
    expect(RESPONSIBILITIES).toContain('Majukumu matatu');
    const cards = sliceBetween(VIEW_TSX, 'const responsibilities', 'const requirements');
    const titles = [...cards.matchAll(/title: t\('([^']+)'/g)].map((m) => m[1]);
    expect(titles).toEqual([
      'Receive and store items',
      'Verify owners in person',
      'Earn on completed handovers',
    ]);
    // Three equal cards on one rung, driven by the one table above them.
    expect(count(RESPONSIBILITIES, /<section key=\{item.title\}/g)).toBe(1);
    expect(count(RESPONSIBILITIES, /rounded-panel/g)).toBe(1);
    expect(count(RESPONSIBILITIES, /grid-cols-1 gap-5 md:grid-cols-3/g)).toBe(1);
    expect(RESPONSIBILITIES).toContain('text-body-large font-bold');
  });

  it('lists the requirements on a quiet sunken surface, without a brand fill', () => {
    expect(REQUIREMENTS).toContain('What you will need');
    expect(REQUIREMENTS).toContain('Utakachohitaji');
    // Reference material, not a claim: the sunken surface, and no brand colour.
    expect(REQUIREMENTS).toContain('bg-[var(--appearance-surface-muted)]');
    expect(count(REQUIREMENTS, /bg-primary-green/g)).toBe(0);
    expect(REQUIREMENTS).toContain('sm:grid-cols-2');
  });

  it('shows the three REAL approval stages on the shared Stepper rail', () => {
    expect(count(VIEW, /<Stepper/g)).toBe(1);
    expect(APPROVAL).toContain('steps={approvalSteps}');
    expect(APPROVAL).toContain('currentStep={0}');
    expect(APPROVAL).toContain("label={t('Agent application approval stages'");
    expect(VIEW).toContain('const approvalSteps = [');
    const steps = sliceBetween(VIEW_TSX, 'const approvalSteps = [', 'const approvalNotes');
    const labels = [...steps.matchAll(/label: t\('([^']+)'/g)].map((m) => m[1]);
    expect(labels).toEqual(['Details & location', 'Identity review', 'Activation notice']);
  });

  it('reports the stages the existing agent surface already states, in the same order', () => {
    expect(AGENT_VIEW).toContain('1. Verification of Business Details & Location');
    expect(AGENT_VIEW).toContain('2. Secure KYC & National ID Hash Review');
    // E1: activation notice is email-only (SMS_ENABLED=false), so the stage
    // AgentView states must match what the platform actually sends.
    expect(AGENT_VIEW).toContain('3. Email notification dispatch upon activation!');
    const steps = sliceBetween(VIEW_TSX, 'const approvalSteps = [', 'const approvalNotes');
    const labels = [...steps.matchAll(/label: t\('([^']+)'/g)].map((m) => m[1]);
    expect(labels[0]).toMatch(/location/i);
    expect(labels[1]).toMatch(/identity/i);
    expect(labels[2]).toMatch(/activation/i);
    // The two facts AgentView already tells an applicant, repeated here.
    expect(VIEW).toContain('An administrator approves your application before you can receive any item.');
    expect(VIEW).toContain('Msimamizi hukubali maombi yako kabla uweze kupokea kitu chochote.');
    expect(count(VIEW, /const approvalNotes: string\[\] = \[/g)).toBe(1);
    expect(count(VIEW, /approvalNotes.map/g)).toBe(1);
    // The rail describes the process: it is marked at its first stage, never at
    // a later one, because this page cannot know where an application is.
    expect(count(VIEW, /currentStep=\{(?!0\})/g)).toBe(0);
  });

  it('closes on the brand band with the fixed pairing the design system documents', () => {
    expect(CTA).toContain('bg-primary-green');
    expect(CTA).toContain('text-white');
    expect(CTA).toContain('bg-white hover:bg-brand-light-gray text-primary-green border-white');
    // The band is the brand in both themes: it must not follow data-theme.
    expect(count(CTA, /--appearance-/g)).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// The page explains an existing process: it creates no flow, calls no API, holds
// no state, and makes no promise the product does not already keep.
// -----------------------------------------------------------------------------

describe('UX-10 keeps the public agent journey honest', () => {
  it('creates no second registration flow, no network call and no storage', () => {
    expect(count(VIEW, /fetch\(/g)).toBe(0);
    expect(count(VIEW, /XMLHttpRequest|axios|apiFetch|await |async /g)).toBe(0);
    expect(count(VIEW, /localStorage|sessionStorage|document\.cookie/g)).toBe(0);
    expect(count(VIEW, /\/api\//g)).toBe(0);
    expect(count(VIEW, /method:\s*'(POST|PUT|PATCH)'/g)).toBe(0);
    expect(count(VIEW, /<form|<input|<textarea|<select/g)).toBe(0);
  });

  it('holds no state and derives nothing: it is a static explanation', () => {
    expect(count(VIEW, /useState|useEffect|useReducer|useRef|useMemo|useCallback|useContext/g)).toBe(0);
    // The only inputs are the three props the route already passes it.
    expect(VIEW).toContain(
      'export default function BecomeAgentView({ lang, onContinueToAgentPortal, onSignIn }: BecomeAgentViewProps)',
    );
    expect(VIEW).toContain("lang: 'en' | 'sw';");
    expect(VIEW).toContain('onContinueToAgentPortal: () => void;');
    expect(VIEW).toContain('onSignIn: () => void;');
  });

  it('states no invented economics: a share of the fee, never an amount', () => {
    const INVENTED = [
      /\bKES\b|\bKSh\b|\bshillings\b/i,
      /\/=/,
      /\d+(?:\.\d+)?\s*%/,
      /\bper (item|handover|month|week|day)\b/i,
      /guarantee/i,
      /\b\d+\s*(?:days?|hours?|weeks?|minutes?)\b/i,
    ];
    for (const pattern of INVENTED) {
      expect(VIEW, `invented economics: ${pattern}`).not.toMatch(pattern);
    }
    // The one economic statement is the one the fee engine implements.
    expect(VIEW).toContain('the agent receives a share of the recovery fee for that handover');
    expect(VIEW).toContain('wakala hupata mgao wa ada ya urejeshaji kwa ukabidhaji huo');
  });

  it('tells the applicant exactly what the application asks for', () => {
    expect(VIEW).toContain('const requirements: Array<{ icon: LucideIcon; text: string }> = [');
    const requirements = sliceBetween(VIEW_TSX, 'const requirements', 'const approvalSteps');
    expect(count(requirements, /icon: (Store|Smartphone|IdCard|Mail),/g)).toBe(4);
    for (const icon of ['Store', 'Smartphone', 'IdCard', 'Mail']) {
      expect(requirements, `requirement icon ${icon}`).toContain(`icon: ${icon}`);
    }
    for (const copy of [
      'A business or shop name and a fixed location open to the public',
      'An M-Pesa payout number',
      'A national ID for vetting, plus a photo of the ID document itself',
      'A business email address',
    ]) {
      expect(VIEW_TSX, `requirement copy: ${copy}`).toContain(copy);
    }
    expect(VIEW).toContain('These are exactly the details the agent application asks for');
  });

  it('carries no emoji and none of the AI/demo residue the sweep bans', () => {
    expect(VIEW_TSX).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u);
    for (const phrase of [
      'coming soon',
      'under construction',
      'lorem ipsum',
      'placeholder text',
      'this is a demo',
      'fake data',
      'sample data',
    ]) {
      expect(VIEW.toLowerCase(), `residue: ${phrase}`).not.toContain(phrase);
    }
  });
});

// -----------------------------------------------------------------------------
// Both languages, always: this is a public page, and the copy IS the product.
// -----------------------------------------------------------------------------

describe('UX-10 is bilingual, and no string ships untranslated', () => {
  it('renders every string through one t(en, sw) call', () => {
    expect(VIEW).toContain('const sw = lang === \'sw\';');
    expect(VIEW).toContain("const t = (en: string, swText: string) => (sw ? swText : en);");
    // The switch reads the prop it is given; it never sniffs a global.
    expect(count(VIEW, /window\.|navigator\.|document\./g)).toBe(0);
  });

  it('gives every one of the page strings a real Kiswahili counterpart', () => {
    const pairs = bilingualPairs(VIEW);
    expect(pairs.length, 'the page must have substantial copy').toBeGreaterThanOrEqual(40);
    for (const [en, sw] of pairs) {
      expect(en.trim().length, `empty EN string: "${en}"`).toBeGreaterThan(0);
      expect(sw.trim().length, `empty SW string for "${en}"`).toBeGreaterThan(0);
      // An "untranslated" string is a bug: the same text in both languages.
      expect(sw, `untranslated: "${en}"`).not.toBe(en);
    }
  });

  it('pairs each visible section heading in English and Kiswahili, in one call', () => {
    const HEADINGS: Array<[string, string]> = [
      ['Agent network', 'Mtandao wa mawakala'],
      ['Become a Return4me agent', 'Kuwa wakala wa Return4me'],
      ['Why it matters', 'Kwa nini ni muhimu'],
      ['What you do', 'Unachofanya'],
      ['Three responsibilities', 'Majukumu matatu'],
      ['Before you apply', 'Kabla kuomba'],
      ['What you will need', 'Utakachohitaji'],
      ['Approval', 'Uidhinishaji'],
      ['How your application is approved', 'Maombi yako hukaguliwa vipi'],
      ['Ready to apply?', 'Uko tayari kuomba?'],
    ];
    for (const [en, sw] of HEADINGS) {
      expect(VIEW, `missing EN copy: ${en}`).toContain(en);
      expect(VIEW, `missing SW copy: ${sw}`).toContain(sw);
      // Both halves come from ONE call, so they cannot drift apart.
      expect(VIEW, `not paired: ${en}`).toContain(`t('${en}', '${sw}')`);
    }
  });

  it('names every action and every stage in both languages', () => {
    for (const pair of [
      "t('Continue to agent registration', 'Endelea kusajiliwa kama wakala')",
      "t('Back to Sign In', 'Rudi kwenye kuingia')",
      "t('Details & location', 'Maelezo na eneo')",
      "t('Identity review', 'Uhakiki wa utambulisho')",
      "t('Activation notice', 'Taarifa ya kuwashwa')",
    ]) {
      expect(VIEW, `missing bilingual call: ${pair}`).toContain(pair);
    }
  });
});

// -----------------------------------------------------------------------------
// The page is built from the vocabulary that already exists.
// -----------------------------------------------------------------------------

describe('UX-10 is built from the shared design vocabulary', () => {
  it('uses only the locked type ladder, never an arbitrary or default size', () => {
    // The ladder steps the page is allowed to speak in come from index.css.
    for (const step of ['caption', 'body', 'body-large', 'section', 'page', 'display']) {
      expect(INDEX_CSS, `ladder step --text-${step}`).toContain(`--text-${step}:`);
      expect(VIEW, `the page must use text-${step}`).toContain(`text-${step}`);
    }
    // No 9px/10px/11px (or any px) text, and no Tailwind default scale.
    expect(VIEW).not.toMatch(/text-\[\d+px\]/);
    expect(VIEW).not.toMatch(/text-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl)(?![\w-])/);
  });

  it('uses only ladder radii, and every surface from the appearance tokens', () => {
    const radii = [...new Set([...VIEW.matchAll(/\brounded-([a-z]+)\b/g)].map((m) => m[1]))].sort();
    expect(radii, 'only the shared radius ladder').toEqual(['panel', 'small']);
    const tokens = [...new Set([...VIEW.matchAll(/var\((--appearance-[a-z-]+)\)/g)].map((m) => m[1]))].sort();
    expect(tokens, 'only tokens that exist, and only through var()').toEqual([
      '--appearance-border',
      '--appearance-surface',
      '--appearance-surface-muted',
      '--appearance-text-muted',
      '--appearance-text-primary',
    ]);
    // No literal colour escapes the theme: the appearance is chosen once.
    expect(VIEW).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(VIEW).not.toMatch(/\b(bg|text|border)-(stone|slate|gray|zinc|emerald|amber|sky|red)-\d/);
  });

  it('sizes every icon from the ICON_SIZE scale, never a magic number', () => {
    expect(VIEW).toContain("import { ICON_SIZE } from './ui';");
    expect(count(VIEW, /size=\{ICON_SIZE\.[a-z]+\}/g)).toBe(6);
    expect(count(VIEW, /size=\{\d+\}/g)).toBe(0);
    expect(count(VIEW, /<svg/g)).toBe(0);
  });

  it('composes the shared primitives instead of re-implementing them', () => {
    for (const primitive of [
      "import Button from './ui/Button';",
      "import SectionHeading from './ui/SectionHeading';",
      "import Stepper from './ui/Stepper';",
    ]) {
      expect(VIEW).toContain(primitive);
    }
    // Three primitives, and no hand-rolled equivalent of any of them.
    expect(count(VIEW, /<button/g)).toBe(0);
    expect(count(VIEW, /role="button"/g)).toBe(0);
    expect(count(VIEW, /<div[^>]*onClick=/g)).toBe(0);
    // The one shared entrance animation, for continuity with the other views.
    expect(VIEW).toContain('fade-in');
    expect(INDEX_CSS).toContain('.fade-in {');
  });

  it('records the batch in the design-system reference, exactly once', () => {
    expect(count(DESIGN_SYSTEM, /MIGRATED in UX-10/g)).toBe(1);
    const row = DESIGN_SYSTEM.split('\n').find((line) =>
      line.startsWith('| Public "Become an agent" page'),
    );
    expect(row, 'the design system must record the public agent page').toBeDefined();
    expect(row as string).toContain('MIGRATED in UX-10');
    expect(row as string).toContain('six ordered sections');
  });
});





