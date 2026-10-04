import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// UX-12 — THE AGENT REGISTRATION EXPERIENCE (AgentView.tsx, signed-out card)
// =============================================================================
// Agent registration used to be a wall of seventeen fields rendered at once
// inside the sign-in card: `text-xs` headings over raw `<input>`/`<select>`
// controls with `bg-white`/`stone-*` colours that never flipped in dark
// appearance, a 2-column grid that squeezed on a phone, and no answer at any
// point to "where am I / what happens next / what do I have to fix?".
//
// UX-12 turns the SAME fields into a guided five-step application — Account,
// Location, Verification, Payout, Review — on the shared `Stepper` rail, with one
// dominant action per step and a review that gathers the values and offers a way
// back to each group.
//
// UX-12 IS PRESENTATION ONLY. It deliberately changes none of:
//   * the registration transport — the same TWO endpoints in the same order
//     (`/api/auth/request-otp` with the phone, then `/api/auth/verify-otp` with
//     the same 17-field payload), the same single submit and the same handlers;
//   * the validation — every existing `required` attribute, the N4 email guard
//     (blank AND malformed) and the 5MB photograph limits are untouched;
//   * the business rules — agent approval, eligibility, verification, commission
//     and payout semantics are the server's and are not restated here;
//   * the data sources — `countiesByUxGroup()`, `administrativeUnitsForCounty()`
//     and the M-Pesa payout option VALUES are byte-identical;
//   * the `AgentView` prop contract, the `currentView` navigation model and the
//     `agent_token` session owned by App.tsx.
// What it changes is hierarchy, progression, control semantics, the type/colour/
// radius vocabulary (all by adopting primitives and tokens that already exist)
// and the copy in both languages.
//
// This repository has no jsdom/React harness, so — exactly as the UX-06 .. UX-11
// suites do — the contract is asserted against the shipped source, with the same
// comment stripper and the same `sliceBetween` helper. No snapshots and no
// line-number assertions are used anywhere.

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
/** The same comment stripper the N3, UX-06 .. UX-11 and Batch 4 suites use. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const VIEW_TSX = read('src/components/AgentView.tsx');
const VIEW = stripComments(VIEW_TSX);
const DESIGN_SYSTEM = read('docs/design-system.md');
const INDEX_CSS = read('src/index.css');

const count = (source: string, pattern: RegExp) => (source.match(pattern) || []).length;

function sliceBetween(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = start === -1 ? -1 : source.indexOf(to, start + from.length);
  if (start === -1 || end === -1) throw new Error(`UX-12 marker not found: ${from} -> ${to}`);
  return source.slice(start, end);
}

/** The five steps, declared once, in order. */
const STEPS_DECL = sliceBetween(VIEW_TSX, 'const AGENT_REGISTRATION_STEPS = [', '] as const;');

/** The guided panel. Declared above the card, so its steps render inside the
 *  same single form the registration fields always belonged to. */
const PANEL = stripComments(sliceBetween(VIEW_TSX, 'const registrationPanel = (', '  return ('));

/** The signed-out card, and the registration form inside it. */
const CARD_RAW = sliceBetween(VIEW_TSX, '{/* 1. AGENT SIGN-IN CARD', '{/* 2. QUEUE LOADING');
const FORM = stripComments(sliceBetween(CARD_RAW, ') : (', '{!showOtp && !isRegistering && ('));

/** The request handler that advances the steps, and finally submits. */
const REQUEST = stripComments(
  sliceBetween(VIEW_TSX, 'const handleAuthRequest = async', 'const countyGroups = countiesByUxGroup();'),
);

/** The registration transport — the two calls the backend already served. */
const REQUEST_CALL = sliceBetween(VIEW, "fetch('/api/auth/request-otp'", '});');
const VERIFY_CALL = sliceBetween(VIEW, "fetch('/api/auth/verify-otp'", 'idDocumentPhotoBase64,');

/** One step's own markup: from its gate to the next gate. */
function regionOf(source: string, n: number): string {
  const from = `{registrationStep === ${n} && (`;
  const to = n < 4 ? `{registrationStep === ${n + 1} && (` : '{registrationStep > 0 && (';
  return sliceBetween(source, from, to);
}
const STEP = (n: number) => regionOf(PANEL, n);

/** Which of the five steps render a given element id. */
const stepsRendering = (source: string, id: string) =>
  [0, 1, 2, 3, 4].filter((n) => regionOf(source, n).includes(`id="${id}"`));

/** The five step names, in declaration order, as pairs. */
const steps = (source = STEPS_DECL) =>
  [...source.matchAll(/\{\s*en:\s*'([^']+)',\s*sw:\s*'([^']+)'\s*\}/g)].map(
    (m) => [m[1], m[2]] as const,
  );

/** Every `tr('english', 'kiswahili')` pair in a stripped source string. */
function bilingualPairs(source: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const re =
    /\btr\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*,\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*,?\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    pairs.push([match[1] ?? match[2], match[3] ?? match[4]]);
  }
  return pairs;
}

/* ---------------------------------------------------------------------------
 * The guards the mutation checks at the bottom re-run against deliberately
 * broken copies, so the checks cannot silently rot.
 * ------------------------------------------------------------------------- */
/** Off-ladder / sub-12px type: the UX-01 ladder is the only scale allowed. */
const offLadderType = (source: string): string[] => [
  ...(source.match(/text-\[\d+px\]/g) || []),
  ...(source.match(/text-(?:xs|sm|base|lg|xl|2xl|3xl|4xl|5xl)(?![\w-])/g) || []),
];
/** Pre-UX-01 colour: raw hex, a fixed palette, or a literal white surface. */
const legacyColour = (source: string): string[] => [
  ...(source.match(/#[0-9a-fA-F]{3,8}\b/g) || []),
  ...(source.match(/\b(?:bg|text|border)-(?:stone|slate|gray|zinc|emerald|amber|sky)-/g) || []),
  ...(source.match(/\bbg-white\b/g) || []),
];
/** The number of competing primary actions in a slice. */
const primaryActions = (source: string): number => count(source, /variant="primary"/g);
/** The shared Button primitive, so its busy semantics can be asserted. */
const READ_BUTTON_PRIMITIVE = read('src/components/ui/Button.tsx');
/** How many times the registration endpoint is called in a source view. */
const requestCalls = (source: string): number =>
  count(source, /fetch\('\/api\/auth\/request-otp'/g);
/** Whether the step advance still happens BEFORE the one request is dispatched. */
const guardBeforeNetwork = (source: string): boolean => {
  const advance = source.indexOf('setRegistrationStep((step) => Math.min(step + 1');
  const network = source.indexOf("fetch('/api/auth/request-otp'");
  const returns =
    advance > -1 &&
    /setRegistrationStep\(\(step\) => Math\.min\([\s\S]{0,120}return;/.test(source);
  return returns && network > -1 && advance < network;
};
/** Whether every field of the existing registration payload is still sent. */
const verifyPayloadIntact = (source: string): boolean => {
  const call = sliceBetween(source, "fetch('/api/auth/verify-otp'", 'idDocumentPhotoBase64,');
  return VERIFY_FIELDS.every((field) => call.includes(field));
};
/** Whether a field's own markup still carries the HTML `required` constraint.
 *  Bounded to the field's own props, so a neighbour's `required` cannot pass. */
const requiredOn = (source: string, id: string): boolean => {
  const at = source.indexOf(`id="${id}"`);
  if (at === -1) return false;
  return /(^|\s)required(\s|\/?>|$)/.test(source.slice(at, at + 500));
};
/** Removes a field's own `required`, for the mutation check. */
const dropRequired = (source: string, id: string): string => {
  const at = source.indexOf(`id="${id}"`);
  const window = source.slice(at, at + 500);
  return source.slice(0, at) + window.replace(/\brequired\b/, 'not-required') + source.slice(at + 500);
};

/** The five steps the application must present, in this order. */
const EXPECTED_STEPS: Array<[string, string]> = [
  ['Account', 'Akaunti'],
  ['Location', 'Eneo'],
  ['Verification', 'Uthibitisho'],
  ['Payout', 'Malipo'],
  ['Review', 'Kagua'],
];

/** The field ids each step is allowed to render, so a collapsed form fails. */
const STEP_FIELDS: string[][] = [
  ['agent-business-name', 'agent-contact-email'],
  ['agent-county', 'agent-sub-county', 'agent-location'],
  ['agent-national-id', 'agent-shop-photo', 'agent-id-document-photo'],
  ['agent-payout-method', 'agent-till-number'],
  [],
];

/** Every field the server already required for a new agent, by element id. */
const REQUIRED_FIELDS = [
  'agent-business-name',
  'agent-contact-email',
  'agent-county',
  'agent-sub-county',
  'agent-location',
  'agent-national-id',
  'agent-payout-method',
  'agent-till-number',
  'agent-phone',
  'agreed-terms',
];

/** The 17 fields the registration verification has always carried. */
const VERIFY_FIELDS = [
  'phone,',
  'code: otp,',
  "role: 'agent',",
  'businessName,',
  'locationAddress,',
  'county: agentCounty,',
  'administrativeUnitId: agentAdministrativeUnitId,',
  'latitude: agentLatitude,',
  'longitude: agentLongitude,',
  'locationAccuracy: agentLocationAccuracy,',
  'payoutMethodType,',
  'tillNumber,',
  'nationalId,',
  'termsAccepted: agreedTerms,',
  'contactEmail,',
  'shopPhotoBase64,',
];

// -----------------------------------------------------------------------------
// A. Structure — five steps, in order, one step of controls at a time.
// -----------------------------------------------------------------------------

describe('UX-12 presents the agent application as five ordered steps', () => {
  it('declares the five existing stages, in order, each in both languages', () => {
    expect(steps()).toEqual(EXPECTED_STEPS);
    for (const [en, sw] of steps()) {
      expect(en.trim()).not.toBe('');
      expect(sw.trim()).not.toBe('');
      expect(sw, `untranslated step: ${en}`).not.toBe(en);
    }
  });

  it('puts the flow on the shared Stepper rail, with the current step and a live announcement', () => {
    expect(PANEL).toContain('<Stepper');
    expect(PANEL).toContain('steps={registrationSteps}');
    expect(PANEL).toContain('currentStep={registrationStep}');
    expect(PANEL).toContain(
      "label={tr('Agent application progress', 'Maendeleo ya maombi ya wakala')}",
    );
    // The rail is not the only progress signal: the current step is announced in
    // text, so progress is never conveyed by the rail's colour alone.
    expect(PANEL).toMatch(/role="status"/);
    expect(PANEL).toMatch(/aria-live="polite"/);
    expect(PANEL).toContain('AGENT_REGISTRATION_STEPS.length');
    expect(PANEL).toContain('registrationSteps[registrationStep].label');
  });

  it('renders each field in exactly the step that owns it', () => {
    for (const [n, fields] of STEP_FIELDS.entries()) {
      for (const id of fields) {
        expect(stepsRendering(PANEL, id), `${id} must render in step ${n} only`).toEqual([n]);
      }
    }
    // …and the panel renders no registration control outside the five steps.
    expect(count(PANEL, /id="agent-/g)).toBe(STEP_FIELDS.flat().length);
  });

  it('gives each step a real heading and its own explanation', () => {
    for (const n of [0, 1, 2, 3, 4]) {
      expect(STEP(n), `step ${n} must be a section`).toContain('<section');
      expect(STEP(n)).toContain('<h2');
      expect(count(STEP(n), /<section\b/g)).toBe(1);
      expect(count(STEP(n), /<h2\b/g)).toBe(1);
      expect(count(STEP(n), /<p className="text-body/g)).toBeGreaterThanOrEqual(1);
    }
    // The steps add NO ARIA of their own: the heading is a real <h2> inside its
    // own section, so progress is conveyed by the heading text and the live
    // region — and the two agent dialogs keep the only `aria-labelledby` uses
    // this file has (the Batch-3 reliability contract).
    expect(count(PANEL, /aria-labelledby/g)).toBe(0);
  });

  it('keeps the review a summary: no data-entry control and a way back to every group', () => {
    expect(STEP(4)).not.toMatch(/<input\b/);
    expect(STEP(4)).not.toContain('<Input');
    expect(STEP(4)).not.toContain('<Select');
    expect(count(STEP(4), /reviewGroup\(/g)).toBe(4);
    // Each group returns to the step it summarises.
    for (const n of [0, 1, 2, 3]) {
      expect(STEP(4), `review group for step ${n}`).toContain(`), ${n}, (`);
    }
    // The group's edit control is the shared helper that returns to its step.
    expect(VIEW).toContain('onClick={() => setRegistrationStep(step)}');
  });

  it('shows the phone field and the consent only where they belong', () => {
    // The phone is the Account step's credential, shared with sign-in…
    expect(FORM).toMatch(/\{\(!isRegistering \|\| registrationStep === 0\) && \(/);
    expect(FORM).toContain('id="agent-phone"');
    // …and consent belongs to the final review.
    expect(FORM).toMatch(/\{isRegistering && \(\s*isRegistrationReview \? \(/);
    expect(FORM).toContain('id="agreed-terms"');
  });
});

// -----------------------------------------------------------------------------
// B. Navigation — Continue advances, Back returns, and the network waits.
// -----------------------------------------------------------------------------

describe('UX-12 advances and returns through the same single submit', () => {
  it('advances one step per submit while the application is still being filled', () => {
    expect(REQUEST).toContain(
      'if (isRegistering && registrationStep < AGENT_REGISTRATION_STEPS.length - 1) {',
    );
    expect(REQUEST).toContain(
      'setRegistrationStep((step) => Math.min(step + 1, AGENT_REGISTRATION_STEPS.length - 1));',
    );
    // The advance RETURNS: no request is made until the review.
    expect(REQUEST.slice(REQUEST.indexOf('if (isRegistering && registrationStep <'))).toMatch(
      /setRegistrationStep\(\(step\) => Math\.min\([\s\S]{0,120}return;/,
    );
    expect(guardBeforeNetwork(REQUEST)).toBe(true);
  });

  it('offers Back as the secondary action of every step but the first', () => {
    expect(PANEL).toContain('{registrationStep > 0 && (');
    expect(count(PANEL, /Math\.max\(0, step - 1\)/g)).toBe(1);
    const BACK = sliceBetween(PANEL, '{registrationStep > 0 && (', '</Button>');
    expect(BACK).toContain('type="button"');
    expect(BACK).not.toContain('type="submit"');
    expect(BACK).toContain('variant="ghost"');
    expect(BACK).toContain("tr('Back', 'Rudi')");
  });

  it('labels the one dominant action by the step it is on', () => {
    expect(FORM).toContain("tr('Continue', 'Endelea')");
    expect(FORM).toMatch(
      /isRegistrationReview[\s\S]{0,120}tr\('Submit application', 'Tuma maombi'\)/,
    );
    // …and 'Review' is the last declared step, so the label cannot drift.
    expect(steps()[steps().length - 1]).toEqual(['Review', 'Kagua']);
  });

  it('gates every step as an explicit equality, so the flow cannot collapse', () => {
    for (const n of [0, 1, 2, 3, 4]) {
      expect(PANEL).toContain(`{registrationStep === ${n} && (`);
    }
    expect(count(PANEL, /registrationStep === /g)).toBe(5);
  });
});

// -----------------------------------------------------------------------------
// C. Submission — the existing transport, once, with the existing payload.
// -----------------------------------------------------------------------------

describe('UX-12 submits the application through the existing endpoints, exactly once', () => {
  it('keeps one request path and one verification path', () => {
    expect(requestCalls(VIEW)).toBe(1);
    expect(count(VIEW, /fetch\('\/api\/auth\/verify-otp'/g)).toBe(1);
    // The panel itself never touches the network or a storage mechanism…
    expect(PANEL).not.toMatch(/fetch\(/);
    expect(PANEL).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    // …nor does the form the field controls live in.
    expect(FORM).not.toMatch(/fetch\(/);
  });

  it('requests the one-time code with the same body as before', () => {
    expect(REQUEST_CALL).toContain("fetch('/api/auth/request-otp'");
    expect(REQUEST_CALL).toContain("method: 'POST'");
    expect(REQUEST_CALL).toContain("'Content-Type': 'application/json'");
    expect(REQUEST_CALL).toContain('body: JSON.stringify({ phone })');
    expect(REQUEST_CALL).not.toContain('role:');
  });

  it('verifies the code with the same 17-field registration payload', () => {
    for (const field of VERIFY_FIELDS) {
      expect(VERIFY_CALL, `verify-otp payload field ${field}`).toContain(field);
    }
    expect(VIEW).toContain('idDocumentPhotoBase64,');
    expect(verifyPayloadIntact(VIEW)).toBe(true);
  });

  it('has exactly one submission control, and it is the shared loading Button', () => {
    expect(primaryActions(FORM)).toBe(1);
    expect(count(FORM, /type="submit"/g)).toBe(1);
    expect(count(PANEL, /variant="primary"/g)).toBe(0);
    const SUBMIT = sliceBetween(FORM, '<Button type="submit"', '</Button>');
    expect(count(SUBMIT, /<Button/g)).toBe(1);
    expect(SUBMIT).toContain('loading={authLoading}');
    expect(SUBMIT).toContain('size="lg"');
    // The shared primitive owns the busy announcement.
    expect(READ_BUTTON_PRIMITIVE).toContain('aria-busy={loading || undefined}');
  });

  it('leaves no way to fire the request twice from the guided flow', () => {
    // One dispatch, one loading transition, and the controls that could fire it
    // are disabled while it is in flight.
    expect(count(REQUEST, /setAuthLoading\(true\)/g)).toBe(1);
    expect(FORM).toContain('disabled={authLoading}');
  });
});

// -----------------------------------------------------------------------------
// D. Validation — every existing rule is still enforced, and still visible.
// -----------------------------------------------------------------------------

describe('UX-12 preserves the registration validation and shows it in place', () => {
  it('keeps the HTML `required` constraint on every field that already had it', () => {
    for (const id of REQUIRED_FIELDS) {
      expect(requiredOn(VIEW_TSX, id), `${id} must still be required`).toBe(true);
    }
    // The photographs were optional before UX-12 and must not become mandatory.
    expect(requiredOn(PANEL, 'agent-shop-photo')).toBe(false);
    expect(requiredOn(PANEL, 'agent-id-document-photo')).toBe(false);
  });

  it('keeps the N4 business-email guard exactly as it was', () => {
    expect(REQUEST).toContain('if (!trimmedEmail) {');
    expect(REQUEST).toContain('!trimmedEmail');
    expect(REQUEST).toContain(
      'Tafadhali weka barua pepe ya biashara (Please enter your business email address).',
    );
    expect(REQUEST).toContain(
      'Tafadhali weka barua pepe sahihi (Please enter a valid email address).',
    );
    expect(REQUEST).not.toContain('isRegistering && contactEmail && !');
  });

  it('keeps the 5MB photograph guards and their preserved auth-channel messages', () => {
    expect(count(PANEL, /5 \* 1024 \* 1024/g)).toBe(2);
    expect(count(PANEL, /if \(file\.size > 5 \* 1024 \* 1024\) \{/g)).toBe(2);
    // Both guards keep the exact single-line Swahili literal they had before
    // UX-12 — the form pinned by agentHubReliabilityBatch3 — so an oversized
    // photograph is still rejected on the auth channel, not silently accepted
    // and not rewrapped as a bilingual `tr(...)` pair.
    expect(
      count(PANEL, /setAuthError\('Picha ya duka ni kubwa mno\. Tafadhali chagua picha chini ya 5MB\.'\);/g),
    ).toBe(1);
    expect(
      count(PANEL, /setAuthError\('Picha ya kitambulisho ni kubwa mno\. Tafadhali chagua picha chini ya 5MB\.'\);/g),
    ).toBe(1);
    expect(count(PANEL, /setAuthError\(\s*tr\(/g)).toBe(0);
  });

  it('submits through the form, so a step cannot advance past an empty required field', () => {
    expect(FORM).toContain('onSubmit={handleAuthRequest}');
    expect(FORM).toContain('aria-busy={authLoading || undefined}');
    // Native constraint validation runs before the handler: the advance branch
    // is only reachable once the open step's required fields are filled.
    expect(REQUEST.indexOf('if (isRegistering && registrationStep <')).toBeGreaterThan(
      REQUEST.indexOf("setAuthError('');"),
    );
  });

  it('announces failures in the existing live region, never a browser dialog', () => {
    const card = stripComments(CARD_RAW);
    expect(card).toContain('<Banner kind="error">');
    expect(card).toContain('<span>{authError}</span>');
    expect(card).not.toMatch(/\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/);
    // …and the in-step notifications are live regions, not colour alone.
    expect(count(PANEL, /role="status"/g)).toBeGreaterThanOrEqual(4);
    expect(PANEL).toContain('text-[var(--appearance-success)]');
  });
});

// -----------------------------------------------------------------------------
// E. Existing business behaviour — untouched, and provably still wired.
// -----------------------------------------------------------------------------

describe('UX-12 leaves the location, verification and payout behaviour intact', () => {
  it('keeps the county/sub-county model and its dependence', () => {
    expect(VIEW).toContain('countiesByUxGroup()');
    expect(VIEW).toContain('administrativeUnitsForCounty(agentCounty)');
    expect(PANEL).toMatch(
      /setAgentCounty\(e\.target\.value\);[\s\S]{0,80}setAgentAdministrativeUnitId\(''\);/,
    );
    expect(PANEL).toContain('disabled={!agentCounty}');
    // Both geography controls are the shared Select, in one visual family.
    expect(count(STEP(1), /<Select/g)).toBe(2);
  });

  it('keeps the optional GPS capture and its confirm-before-use step', () => {
    expect(PANEL).toContain('onClick={detectAgentLocation}');
    expect(PANEL).toContain('applyDetectedAgentLocation');
    expect(VIEW).toContain('detectBrowserLocation()');
    expect(VIEW).toContain('setAgentLatitude(agentDetectedLocation.latitude)');
    expect(VIEW).toContain('setAgentLongitude(agentDetectedLocation.longitude)');
    expect(VIEW).toContain('setAgentLocationAccuracy(agentDetectedLocation.accuracy)');
    expect(VIEW).toContain("setAgentAdministrativeUnitId(agentDetectedLocation.subCountyId ?? '')");
    // Detection never overwrites an address the applicant typed, as before.
    expect(VIEW).toContain(
      'if (agentDetectedLocation.place && !locationAddress.trim()) setLocationAddress(agentDetectedLocation.place);',
    );
  });

  it('keeps the payout method options, values included', () => {
    for (const value of ['Till Number', 'Paybill Number', 'Pochi la Biashara', 'Personal M-Pesa']) {
      expect(PANEL, `payout option ${value}`).toContain(`<option value="${value}">`);
    }
    expect(PANEL).toContain('value={payoutMethodType}');
    expect(PANEL).toContain('setPayoutMethodType(e.target.value)');
    expect(PANEL).toContain('value={tillNumber}');
  });

  it('keeps the document handling: a local file read into the same payload fields', () => {
    expect(count(PANEL, /reader\.readAsDataURL\(file\)/g)).toBe(2);
    expect(PANEL).toContain('setShopPhotoBase64(reader.result as string)');
    expect(PANEL).toContain('setIdDocumentPhotoBase64(reader.result as string)');
    // No upload endpoint is introduced: the images travel only in verify-otp.
    expect(count(VIEW, /fetch\(/g)).toBe(2);
  });

  it('never echoes the confidential identifiers the reviewer needs to see', () => {
    expect(STEP(4)).not.toContain('{nationalId}');
    expect(STEP(4)).not.toContain('{tillNumber}');
    expect(STEP(4)).not.toMatch(/\{shopPhotoBase64\}/);
    expect(STEP(4)).not.toMatch(/\{idDocumentPhotoBase64\}/);
    expect(STEP(4)).toContain("tr('Provided', 'Imetolewa')");
    expect(STEP(4)).toContain("tr('Not provided', 'Haitolewa')");
    // The applicant's own contact details are the ones worth confirming.
    expect(STEP(4)).toContain("tr('Phone number', 'Namba ya simu')");
    expect(STEP(4)).toContain("tr('Email address', 'Barua pepe')");
  });
});

// -----------------------------------------------------------------------------
// F. The shared vocabulary — type, colour, radius, tokens, both languages.
// -----------------------------------------------------------------------------

describe('UX-12 speaks the shared design-system vocabulary and nothing else', () => {
  it('introduces no off-ladder or sub-12px type', () => {
    expect(offLadderType(PANEL)).toEqual([]);
    expect(offLadderType(FORM)).toEqual([]);
    expect(PANEL).toContain('text-heading');
    expect(PANEL).toContain('text-body');
    expect(PANEL).toContain('text-caption');
  });

  it('drops every pre-UX-01 colour literal for a theme-aware token', () => {
    expect(legacyColour(PANEL)).toEqual([]);
    expect(legacyColour(FORM)).toEqual([]);
    const tokens = Array.from(new Set(PANEL.match(/var\(--[a-z0-9-]+\)/g) || []));
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      expect(INDEX_CSS, `undeclared token ${token}`).toContain(`${token.slice(4, -1)}:`);
      expect(
        (INDEX_CSS.match(new RegExp(`${token.slice(4, -1)}:`, 'g')) || []).length,
        `${token} must exist in both appearance scopes`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('walks the shared radius ladder and sizes icons from ICON_SIZE', () => {
    expect(PANEL).toMatch(/\brounded-(panel|standard|small|compact)\b/);
    expect(PANEL).not.toMatch(/\brounded-(xl|2xl|3xl|md|full)\b/);
    expect(count(PANEL, /size=\{\d+\}/g)).toBe(0);
    expect(PANEL).toContain('size={ICON_SIZE.ui}');
    // …and never suppresses the shared focus treatment.
    expect(PANEL).not.toContain('outline-none');
    expect(FORM).not.toContain('outline-none');
  });

  it('carries every new string in English AND Kiswahili', () => {
    for (const region of [PANEL, FORM]) {
      const pairs = bilingualPairs(region);
      expect(pairs.length).toBeGreaterThan(0);
      expect(count(region, /\btr\(/g)).toBe(pairs.length);
      for (const [en, sw] of pairs) {
        expect(en.trim()).not.toBe('');
        expect(sw.trim()).not.toBe('');
        expect(sw, `untranslated: "${en}"`).not.toBe(en);
      }
    }
  });

  it('records the batch in the design-system reference, exactly once', () => {
    expect(count(DESIGN_SYSTEM, /MIGRATED in UX-12/g)).toBe(1);
    const row = DESIGN_SYSTEM.split('\n').find((line) => line.startsWith('| Agent registration'));
    expect(row, 'the design system must record the agent registration surface').toBeDefined();
    expect(row as string).toContain('MIGRATED in UX-12');
    // The queue no longer claims the registration fields are still legacy…
    expect(DESIGN_SYSTEM).not.toContain('the registration fields, the hub and the panels remain');
    // …and the UX-11 record is left exactly as it was.
    expect(count(DESIGN_SYSTEM, /MIGRATED in UX-11/g)).toBe(2);
  });
});

// -----------------------------------------------------------------------------
// Mutation checks — the guards above must FAIL when UX-12 is undone.
// -----------------------------------------------------------------------------

describe('UX-12 guards are live, not decorative (mutation checks)', () => {
  it('detects a field rendered by more than one step (a collapsed form)', () => {
    expect(stepsRendering(PANEL, 'agent-national-id')).toEqual([2]);
    const collapsed = PANEL.replace(
      '{registrationStep === 0 && (',
      '{registrationStep === 0 && ( <input id="agent-national-id" />',
    );
    expect(stepsRendering(collapsed, 'agent-national-id')).not.toEqual([2]);
  });

  it('detects a step that stopped gating on its own index', () => {
    expect(count(PANEL, /registrationStep === /g)).toBe(5);
    const open = PANEL.replace('{registrationStep === 1 && (', '{isRegistering && (');
    expect(count(open, /registrationStep === /g)).toBe(4);
  });

  it('detects a second registration submission', () => {
    expect(requestCalls(VIEW)).toBe(1);
    expect(requestCalls(`${VIEW}\nfetch('/api/auth/request-otp', { method: 'POST' });`)).toBe(2);
  });

  it('detects a changed registration payload', () => {
    expect(verifyPayloadIntact(VIEW)).toBe(true);
    // The payload line itself, not the `nationalId` state declaration.
    expect(verifyPayloadIntact(VIEW.replace('\n          nationalId,', '\n'))).toBe(false);
    expect(verifyPayloadIntact(VIEW.replace('termsAccepted: agreedTerms,', ''))).toBe(false);
  });

  it('detects a submission that no longer waits for the review', () => {
    expect(guardBeforeNetwork(REQUEST)).toBe(true);
    const withoutAdvance = REQUEST.replace(
      'setRegistrationStep((step) => Math.min(step + 1, AGENT_REGISTRATION_STEPS.length - 1));',
      '',
    );
    expect(guardBeforeNetwork(withoutAdvance)).toBe(false);
  });

  it('detects a removed validation constraint', () => {
    expect(requiredOn(VIEW_TSX, 'agent-county')).toBe(true);
    expect(requiredOn(dropRequired(VIEW_TSX, 'agent-county'), 'agent-county')).toBe(false);
  });

  it('detects a reintroduced off-ladder type size', () => {
    expect(offLadderType(PANEL)).toEqual([]);
    expect(offLadderType(`${PANEL}\n<p className="text-[11px]">`)).not.toEqual([]);
    expect(offLadderType(`${PANEL}\n<p className="text-xs">`)).not.toEqual([]);
  });

  it('detects a reintroduced legacy colour literal', () => {
    expect(legacyColour(PANEL)).toEqual([]);
    expect(legacyColour(`${PANEL} bg-white`)).not.toEqual([]);
    expect(legacyColour(`${PANEL} text-stone-500`)).not.toEqual([]);
  });

  it('detects a second competing primary action', () => {
    expect(primaryActions(FORM)).toBe(1);
    expect(primaryActions(`${FORM}\n<Button variant="primary">Go</Button>`)).toBe(2);
  });

  it('detects an untranslated step string', () => {
    const pairs = bilingualPairs(PANEL);
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.every(([en, sw]) => sw !== en)).toBe(true);
    expect(bilingualPairs(PANEL.replace("'Akaunti'", "'Account'")).some(([en, sw]) => sw === en)).toBe(true);
  });
});

