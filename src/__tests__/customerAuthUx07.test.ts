import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// UX-07 — CUSTOMER AUTHENTICATION EXPERIENCE
// =============================================================================
// The three customer authentication surfaces were the last customer screens
// still written against the pre-UX-01 vocabulary: hand-styled cards
// (`bg-white`, `border-brand-border`, `rounded-2xl`), off-ladder icon sizes,
// `text-[11px]` captions, and a register/sign-in switch that only *looked* like
// a tablist — it announced none of its semantics and left one of its two modes
// unreachable from the keyboard once focus moved on.
//
// UX-07 IS PRESENTATION ONLY. It deliberately changes none of:
//   * the authentication protocol — the same customer endpoints are called in
//     the same order with the same bodies;
//   * the security properties — the activation token is still read once, sent
//     once, and never stored, rendered or logged;
//   * agent/admin authentication, which is a different audience.
// What it changes is hierarchy, control semantics, keyboard behaviour and the
// colour/type vocabulary — all of it by adopting primitives and tokens that
// already exist (`SectionHeading`, `Banner`, `Spinner`, `ICON_SIZE`, the
// `--appearance-*` tokens, the type/radius/elevation ladders).
//
// This repository has no jsdom/React harness, so — exactly as the UX-06 and N3
// batches do — the behavioural contract is asserted against the shipped source.

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
/** The same comment stripper the N3 and UX-06 suites use. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const GATE_TSX = read('src/components/CustomerAccountView.tsx');
const GATE = stripComments(GATE_TSX);
const CHOOSER_TSX = read('src/components/SignInView.tsx');
const CHOOSER = stripComments(CHOOSER_TSX);
const ACTIVATION_TSX = read('src/components/CustomerActivationView.tsx');
const ACTIVATION = stripComments(ACTIVATION_TSX);
const INDEX_CSS = read('src/index.css');

/**
 * Every `t('english', 'kiswahili')` pair in a stripped source string. Either
 * quote style is accepted, and the trailing comma a few call sites carry is
 * optional here — the pair is the contract, not the punctuation.
 */
function bilingualPairs(source: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  // Either quote style, an optional trailing comma, any argument layout: all
  // that matters is that both languages are present, in order.
  const re =
    /\bt\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*,\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*,?\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    pairs.push([match[1] || match[2], match[3] || match[4]]);
  }
  return pairs;
}

/**
 * Colour vocabulary that predates UX-01. None of it may appear on a customer
 * authentication surface any more: the literals do not flip in dark mode, and
 * the semantic names are the ones the design-system tokens replaced.
 */
const LEGACY_COLOUR_LITERALS = [
  'bg-white',
  'text-black',
  'border-brand-border',
  'text-brand-dark-text',
  'text-brand-muted-text',
  'bg-brand-light-gray',
  'bg-brand-beige',
  'bg-canvas',
  'border-line-subtle',
  'text-ink',
  'text-status-',
  'text-primary-green',
  'text-primary-dark',
  'accent-orange',
  'accent-teal',
  'accent-red',
] as const;

/**
 * The three customer authentication surfaces, each as its comment-stripped
 * source. Behaviour is asserted against the code the browser runs: prose may
 * describe ANOTHER surface's mechanism (the agent portal's bearer token, say)
 * without this surface acquiring one.
 */
const SURFACES: Array<[string, string]> = [
  ['account gate', GATE],
  ['sign-in chooser', CHOOSER],
  ['activation landing', ACTIVATION],
];

// -----------------------------------------------------------------------------
// The authentication contract is untouched
// -----------------------------------------------------------------------------

describe('UX-07 keeps every customer authentication path exactly as it was', () => {
  it('calls the same customer endpoints, in the same order', () => {
    // A restyle is only safe if the request sequence is provably unchanged, and
    // the sequence is the first thing a UI rewrite is tempted to reorder.
    const endpoints = (GATE.match(/'\/api\/customer\/[a-z/]+'/g) || []).map((s) => s.slice(1, -1));
    expect(endpoints).toEqual([
      '/api/customer/me',
      '/api/customer/register',
      '/api/customer/login',
      '/api/customer/login/verify',
      '/api/customer/logout',
    ]);
  });

  it('sends the same request bodies, including the email N3 requires', () => {
    // N3 made registration email-first. The register body must still carry
    // fullName, phone and email, and the login/OTP step must still send the
    // code the server expects — a "cosmetic" pass must not rename a field.
    expect(GATE).toContain(
      '? { fullName: fullName.trim(), phone: normalized, email: email.trim() }',
    );
    expect(GATE).toContain(': { phone: normalized };');
    expect(GATE).toContain('body: JSON.stringify(body)');
    expect(GATE).toContain('body: JSON.stringify({ phone, code: code.trim() })');
  });

  it('still refuses to sign anyone in off the registration step', () => {
    // Registration ends in the pending-activation state, NOT in a session: the
    // account is inactive until the emailed link is used. Exactly one place may
    // establish a session, and it is the OTP verification step.
    expect(GATE).toContain("setStep('pendingActivation')");
    expect(GATE).toContain('setCustomer(data.customer)');
    expect((GATE.match(/onAuthenticated\?\.\(\)/g) || []).length).toBe(1);
  });

  it('adds no second credential store and no second auth mechanism', () => {
    for (const [name, code] of SURFACES) {
      expect(code, name).not.toMatch(/bearer/i);
      expect(code, name).not.toMatch(/customer_token|admin_token|agent_token/);
      // The customer session is the server's HTTP cookie, sent and read by the
      // browser: nothing on these surfaces may keep a second copy of it.
      expect(code, name).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB/);
    }
  });
});

// -----------------------------------------------------------------------------
// The register/sign-in switch behaves like the tablist it now claims to be
// -----------------------------------------------------------------------------

describe('UX-07 the register/sign-in switch is a real, keyboard-operable tablist', () => {
  it('announces the switch as a tablist and each mode as a tab', () => {
    // The two modes are a segmented control over ONE panel. Presenting them as
    // plain buttons left a screen reader with two unrelated controls and no
    // statement of which mode was showing.
    expect(GATE).toContain('role="tablist"');
    expect(GATE).toContain("aria-label={t('Account access', 'Ufikiaji wa akaunti')}");
    expect((GATE.match(/role="tab"/g) || []).length).toBe(2);
    expect(GATE).toContain("aria-selected={mode === 'register'}");
    expect(GATE).toContain("aria-selected={mode === 'login'}");
  });

  it('points both tabs at the single panel they control', () => {
    // One panel, labelled by whichever tab is selected, so the announced mode
    // can never disagree with the fields on screen.
    expect((GATE.match(/aria-controls="customer-mode-panel"/g) || []).length).toBe(2);
    expect(GATE).toContain('id="customer-mode-panel"');
    expect(GATE).toContain('role="tabpanel"');
    expect(GATE).toContain(
      "aria-labelledby={mode === 'register' ? 'customer-mode-register' : 'customer-mode-login'}",
    );
    expect(GATE).toContain('id="customer-mode-register"');
    expect(GATE).toContain('id="customer-mode-login"');
  });

  it('keeps both modes reachable from the keyboard (roving tabindex)', () => {
    // A tablist keeps only the selected tab in the tab order — which is exactly
    // why the OTHER tab must be reachable by arrow key. Without that rule the
    // unselected mode became unreachable the moment focus left the tablist:
    // the accessibility defect UX-07 fixes.
    expect(GATE).toContain("tabIndex={mode === 'register' ? 0 : -1}");
    expect(GATE).toContain("tabIndex={mode === 'login' ? 0 : -1}");
    expect(GATE).toContain('onKeyDown={(e) => onModeTabKeyDown(e, 0)}');
    expect(GATE).toContain('onKeyDown={(e) => onModeTabKeyDown(e, 1)}');
    expect(GATE).toContain("if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;");
    expect(GATE).toContain('const next = (index + offset) % MODES.length;');
    expect(GATE).toContain('modeTabRefs.current[next]?.focus();');
  });

  it('moves the selection through the existing switchMode(), not a second path', () => {
    // The keyboard route resets the step and the pending code exactly as a click
    // does, because it IS the click handler's function. A parallel
    // keyboard-only branch is how the two paths drift apart.
    expect(GATE).toContain('switchMode(MODES[next]);');
    expect((GATE.match(/switchMode\(/g) || []).length).toBe(3);
    // The list the arrow keys walk is the list the tabs render from, in the same
    // order, so a future third mode is a one-line change in both places.
    expect(GATE).toContain("const MODES: Mode[] = ['register', 'login'];");
  });

  it('does not fake the switch with a clickable div or a styled anchor', () => {
    for (const [name, code] of SURFACES) {
      expect(code, name).not.toMatch(/<div[^>]*onClick=/);
    }
    expect(GATE).toMatch(/<button[\s\S]{0,200}?type="button"[\s\S]{0,200}?role="tab"/);
    expect(GATE).not.toMatch(/<a[\s\S]{0,200}?role="tab"/);
  });
});

// -----------------------------------------------------------------------------
// The forms are real, labelled forms
// -----------------------------------------------------------------------------

describe('UX-07 the account forms are real, labelled forms', () => {
  it('labels every field and marks the required ones', () => {
    // A placeholder is not a label: it disappears as soon as the field has a
    // value and is never announced by a screen reader as the field's name.
    for (const id of ['customer-name', 'customer-phone', 'customer-email', 'customer-code']) {
      expect(GATE).toContain(`id="${id}"`);
      // The field's name comes from a real `label` prop, not a placeholder.
      expect(GATE).toMatch(new RegExp(`id="${id}"[\\s\\S]{0,240}?label=\\{t\\(`));
    }
    // Four field labels, plus the one status label on the session-check Spinner.
    expect((GATE.match(/(?:^|\r?\n)\s*label=\{t\(/g) || []).length).toBe(5);
    // The tablist is named too, but through `aria-label` — not a field label.
    expect((GATE.match(/aria-label=\{t\(/g) || []).length).toBe(1);
    // One `required` per field: name, phone, email, code.
    expect((GATE.match(/(?:^|\r?\n)\s*required\r?\n/g) || []).length).toBe(4);
    // Both steps are real submit forms, so Enter submits from any field.
    expect((GATE.match(/<form onSubmit=\{/g) || []).length).toBe(2);
    expect((GATE.match(/<Button type="submit"/g) || []).length).toBe(2);
  });

  it('says what each phone number is actually for', () => {
    // N3 made registration email-first, so the register hint must NOT promise an
    // SMS code that registration no longer sends; E1 then moved sign-in delivery
    // to email too (the number identifies the account, the code is emailed to the
    // verified address). Both hints are bilingual.
    // The two-line call is matched as a pattern so the check does not depend on
    // the file's line endings (the sources are checked out with CRLF).
    expect(GATE).toMatch(
      /t\(\r?\n\s*'You will sign in with this number after activating your account\.',\r?\n\s*'Utaingia kwa nambari hii baada ya kuiwasha akaunti yako\.'\r?\n\s*\)/,
    );
    // BATCH 13 (E1) finished the move: the sign-in hint names the EMAIL
    // destination and keeps the number only as the locator for "which account".
    // The retired wording promised delivery to the phone, so it must be gone.
    expect(GATE).toContain(
      "t('We emailed the code to the verified address on the account for', 'Tulituma msimbo kwa barua pepe iliyothibitishwa ya akaunti ya')",
    );
    expect(GATE).not.toContain('We sent it to');
    expect(GATE).not.toContain('Tuliituma kwa');
    expect(GATE).toContain(
      "\"We'll email a one-time verification code to the verified email address on your account.\"",
    );
  });

  it('keeps the code field accessible, with its platform one-time-code autofill and its hint', () => {
    // UX-07 deliberately keeps the labelled single-field control here instead of
    // the shared OTPInput primitive: OTPInput renders one box per digit with
    // hardcoded English `Digit n of m` labels and no hint slot, so adopting it
    // would cost both the platform one-time-code autofill below (the boxes
    // deliberately set `autocomplete="off"`) and the "we emailed the code to
    // 07XX…" association that Input wires through aria-describedby. The
    // primitive gap is recorded in docs/design-system.md.
    expect(GATE).toContain('autoComplete="one-time-code"');
    expect(GATE).toContain('inputMode="numeric"');
    expect(GATE).toContain('maxLength={6}');
    // BATCH 13 (E1): the hint states the EMAIL delivery and keeps the number as
    // the account locator, instead of promising a code on the phone.
    expect(GATE).toContain(
      "hint={t('We emailed the code to the verified address on the account for', 'Tulituma msimbo kwa barua pepe iliyothibitishwa ya akaunti ya') + ' ' + formatPhoneForDisplay(phone)}",
    );
    expect(GATE).toContain("onChange={(e) => setCode(e.target.value.replace(/\\D/g, ''))}");
  });

  it('guards against double submission and announces the busy state', () => {
    // `aria-busy` on the form plus a loading Button: the request cannot be fired
    // twice from the same field set, and the wait is announced rather than
    // merely animated.
    expect((GATE.match(/aria-busy=\{busy \|\| undefined\}/g) || []).length).toBe(2);
    expect((GATE.match(/disabled=\{busy\}/g) || []).length).toBe(4);
    expect((GATE.match(/loading=\{busy\}/g) || []).length).toBe(2);
  });

  it('never hands validation over to the browser', () => {
    // `noValidate` keeps the product's own bilingual messages authoritative; the
    // native bubble is English-only and unstyleable.
    expect((GATE.match(/\bnoValidate\b/g) || []).length).toBe(2);
  });
});

// -----------------------------------------------------------------------------
// The activation landing page keeps its meaning
// -----------------------------------------------------------------------------

describe('UX-07 the activation landing page keeps its meaning', () => {
  it('keeps exactly one h1 and one outcome Banner per state', () => {
    expect((ACTIVATION.match(/<h1/g) || []).length).toBe(1);
    expect((ACTIVATION.match(/<Banner kind="success"/g) || []).length).toBe(1);
    expect((ACTIVATION.match(/<Banner kind="error"/g) || []).length).toBe(1);
    expect((ACTIVATION.match(/<Banner kind="warning"/g) || []).length).toBe(1);
    // The heading is the outcome, so the page says what happened before it says
    // what to do — and it is on the ladder, not a hardcoded size.
    expect(ACTIVATION).toMatch(/<h1[^>]*text-subsection[^>]*text-\[var\(--appearance-text-primary\)\]/);
  });

  it('never claims a failure succeeded, and announces the wait', () => {
    const successBranch = ACTIVATION.slice(
      ACTIVATION.indexOf("setState('activated')"),
      ACTIVATION.indexOf("if (res.status === 400)"),
    );
    expect(successBranch).not.toMatch(/catch|status === 4|status === 5/);
    expect(ACTIVATION).toContain('Your account has not been activated yet.');
    // The working state is announced through the shared Spinner (role="status").
    expect(ACTIVATION).toMatch(/<Spinner[\s\S]{0,200}?label=\{t\(/);
  });

  it('offers a retry only where retrying can actually help', () => {
    // 'unavailable' is the only retry-safe state; on the other two a reload can
    // only waste another single-use attempt or repeat the same failure.
    expect(ACTIVATION).toContain("const retryable = state === 'unavailable';");
    expect((ACTIVATION.match(/window\.location\.reload\(\)/g) || []).length).toBe(1);
    expect(ACTIVATION).toMatch(/\{retryable && \(/);
    // Every exit is a real button, so a keyboard user is never stranded.
    // `type="button"` rather than `<Button type="button"` so the count holds for
    // a multi-line element too: the attribute is the contract, not the layout.
    expect((ACTIVATION.match(/type="button"/g) || []).length).toBe(3);
  });

  it('still reads the single-use token once, and never stores or shows it', () => {
    expect(ACTIVATION).toContain('if (attempted.current) return;');
    expect(ACTIVATION).toContain('attempted.current = true;');
    expect(ACTIVATION).toContain("new URLSearchParams(window.location.search).get('token')");
    expect(ACTIVATION_TSX).not.toMatch(/value=\{rawToken\}/);
    expect(ACTIVATION).not.toMatch(/console\.(log|info|warn|error|debug)/);
  });
});

// -----------------------------------------------------------------------------
// The three surfaces speak the shared appearance vocabulary
// -----------------------------------------------------------------------------

describe('UX-07 the customer authentication surfaces speak the shared vocabulary', () => {
  it('drops every pre-UX-01 colour literal for a theme-aware token', () => {
    // The literals below are the vocabulary UX-01 replaced: fixed colours that
    // do not flip in dark mode, and semantic names the token layer has since
    // renamed. None of them may reappear on a customer authentication surface.
    for (const [name, code] of SURFACES) {
      const leftovers = LEGACY_COLOUR_LITERALS.filter((literal) => code.includes(literal));
      expect(leftovers, name).toEqual([]);
      // …and what replaced them is the token layer, not another fixed value: a
      // raw hex would not flip either, so the surfaces carry none.
      expect(code, name).toContain('var(--appearance-');
      expect(code.match(/#[0-9a-fA-F]{3,8}\b/g), name).toEqual(null);
    }
  });

  it('consumes only tokens the stylesheet actually declares', () => {
    // A typo in a token name fails silently in CSS — the element simply renders
    // unstyled — so every `var(--…)` on these surfaces is checked against the
    // stylesheet that is supposed to define it.
    for (const [name, code] of SURFACES) {
      const tokens = Array.from(new Set(code.match(/var\(--[a-z0-9-]+\)/g) || []));
      expect(tokens.length, name).toBeGreaterThan(0);
      for (const token of tokens) {
        expect(INDEX_CSS, `${name} ${token}`).toContain(`${token.slice(4, -1)}:`);
      }
    }
  });

  it('walks the type, radius and elevation ladders instead of hardcoding them', () => {
    for (const [name, code] of SURFACES) {
      // No off-ladder caption size survives (the pre-UX-01 `text-[11px]` class).
      expect(code.match(/text-\[1[0-9]px\]/g), name).toEqual(null);
      // The panel radius and the raised elevation are the shared ladder steps
      // the rest of the site already renders with, not one-off values.
      expect(code, name).toMatch(/\brounded-(panel|standard)\b/);
      expect(code, name).toMatch(/\bshadow-raised\b/);
    }
  });

  it('sizes every icon from the ICON_SIZE ladder', () => {
    for (const [name, code] of SURFACES) {
      expect(code, name).toMatch(/size=\{ICON_SIZE\.[a-z]+\}/);
      // A raw pixel size would step off the ladder the icons are drawn on.
      expect(code.match(/size=\{\d+\}/g), name).toEqual(null);
    }
  });

  it('keeps every visible string bilingual, with neither side left identical', () => {
    for (const [name, code] of SURFACES) {
      const pairs = bilingualPairs(code);
      expect(pairs.length, name).toBeGreaterThan(0);
      // Every `t(` call site is a pair, so a one-argument English-only call —
      // a string a translator never sees — cannot slip in unnoticed.
      expect((code.match(/\bt\(/g) || []).length, name).toBe(pairs.length);
      for (const [en, sw] of pairs) {
        expect(en.trim(), name).not.toBe('');
        expect(sw.trim(), name).not.toBe('');
        // An untranslated string is the commonest bilingual regression: the
        // English side pasted into the Kiswahili slot.
        expect(sw, `${name}: ${en}`).not.toBe(en);
      }
    }
  });
});




