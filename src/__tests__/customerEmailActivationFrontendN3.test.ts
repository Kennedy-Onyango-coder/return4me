import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parsePublicRoute, activateEmailPath, isSafeReturnPath } from '../utils/publicRoutes';
import { buildCustomerActivationUrl } from '../services/customerAuth';

// =============================================================================
// N3 (FRONTEND) — customer email-activation UI
// =============================================================================
// The N3 backend was already complete and green; what was missing was the
// FRONTEND half, and the gap was not cosmetic: CustomerAccountView still
// posted a registration body with no email field and then advanced to an SMS
// code step that called POST /api/customer/register/verify — an endpoint N3
// deliberately removed. Registration was therefore pointed at a 404, and
// nothing in the product could consume the activation email the backend sends.
//
// These tests cover the integration boundary that was missing, following this
// repository's established convention: there is no jsdom/React harness here, so
// behavioural contracts are asserted against the shipped source, and the PURE
// routing functions are exercised directly.
//
// WHAT IS ASSERTED ABOUT THE TOKEN
//   That it is read once, sent to the real endpoint, and then never again:
//   not stored, not rendered, not logged, not put in any route or history
//   state. A test that only checked "it calls the API" would still pass if the
//   page had also written the credential to localStorage, so the negative
//   assertions below are the load-bearing ones.

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const activationView = read('src/components/CustomerActivationView.tsx');
const activationCode = stripComments(activationView);
const gate = read('src/components/CustomerAccountView.tsx');
const gateCode = stripComments(gate);
const appTsx = read('src/App.tsx');
const routesTs = read('src/utils/publicRoutes.ts');

const RAW_TOKEN = 'a'.repeat(64);

describe('N3-F: the activation route is public and carries no token', () => {
  it('is addressable at the path the emailed link actually uses', () => {
    // The one source of truth for the path is the backend's own URL builder —
    // the page and the email can therefore never drift apart.
    expect(activateEmailPath()).toBe('/activate-email');
    expect(buildCustomerActivationUrl(RAW_TOKEN)).toContain('/activate-email?token=');
    expect(parsePublicRoute('/activate-email')).toEqual({ kind: 'activateEmail', hasToken: false });
    expect(parsePublicRoute('/activate-email/')).toEqual({ kind: 'activateEmail', hasToken: false });
  });

  it('records only token PRESENCE, never the value', () => {
    const route = parsePublicRoute('/activate-email', `?token=${RAW_TOKEN}`);
    expect(route).toEqual({ kind: 'activateEmail', hasToken: true });
    // The credential is nowhere in the parsed route, so it cannot reach React
    // state, a history entry or anything else that re-serialises the route.
    expect(JSON.stringify(route)).not.toContain(RAW_TOKEN);
    // A blank token is treated as absent, so the page explains the link is
    // incomplete instead of firing a request that can only 400.
    expect(parsePublicRoute('/activate-email', '?token=')).toEqual({ kind: 'activateEmail', hasToken: false });
    expect(parsePublicRoute('/activate-email', '?token=%20%20')).toEqual({ kind: 'activateEmail', hasToken: false });
    expect(parsePublicRoute('/activate-email', '?other=1')).toEqual({ kind: 'activateEmail', hasToken: false });
  });

  it('needs no customer session to be reachable', () => {
    // It renders in the PUBLIC shell, outside the dashboard boundary: the person
    // following the emailed link has no session by definition.
    expect(appTsx).toContain("route.kind === 'activateEmail'");
    expect(appTsx).toContain('hasToken={route.hasToken}');
    // It is not a post-authentication return destination: it is an entry point,
    // not somewhere a signed-in visitor should be sent.
    expect(isSafeReturnPath('/activate-email')).toBe(false);
    // The sign-in hand-off is the EXISTING /account surface.
    expect(appTsx).toContain('onSignIn={() => navigate(accountPath(),');
  });

  it('does not appear in the public navigation', () => {
    // The link is reached from an email, not from the navbar. It is deliberately
    // absent from VIEW_PATHS, the app's only public-destination list.
    expect(routesTs).not.toMatch(/VIEW_PATHS[\s\S]{0,600}activateEmail/);
  });
});

describe('N3-F: registration ends in activation-pending, not a session', () => {
  it('sends the email the activation link is delivered to', () => {
    expect(gateCode).toContain('? { fullName: fullName.trim(), phone: normalized, email: email.trim() }');
    // The removed SMS registration challenge is gone entirely.
    expect(gateCode).not.toContain('/api/customer/register/verify');
  });

  it('moves to a terminal activation-pending state on success', () => {
    expect(gateCode).toContain("setStep('pendingActivation')");
    expect(gate).toContain('What happens next');
    expect(gate).toContain('activation email');
    // It states plainly that the visitor is not signed in yet.
    expect(gate).toContain('You are not signed in yet');
  });

  it('does NOT assume an authenticated state after registering', () => {
    // The registration branch must not set a customer, and the authenticated
    // callback must fire only from the login verification path.
    const registerBranch = gateCode.slice(
      gateCode.indexOf("setStep('pendingActivation')"),
      gateCode.indexOf('const verifyCode'),
    );
    const loginBranch = gateCode.slice(gateCode.indexOf('const verifyCode'));
    expect(registerBranch).not.toContain('setCustomer(');
    expect(registerBranch).not.toContain('onAuthenticated');
    // The session-establishing call sites are the login/verify response and the
    // page's own session probe on load — both unchanged by N3, and neither
    // reachable from the registration path.
    expect(loginBranch).toContain('setCustomer(data.customer)');
    expect(loginBranch).toContain('onAuthenticated?.()');
    expect((gateCode.match(/onAuthenticated\?\.\(\)/g) || []).length).toBe(1);
  });

  it('no longer tells a registering visitor that a code was texted', () => {
    // The phone hint is mode-dependent: login still gets the SMS promise,
    // registration gets the truth (this number is how you will sign in).
    expect(gate).toContain('You will sign in with this number after activating your account.');
    // E1: sign-in no longer texts this number either — the code is emailed to the
    // verified address on the account, so the hint must not promise an SMS.
    expect(gate).toContain("We'll email a one-time verification code to the verified email address on your account.");
    expect(gate).toContain("We'll email you a link to activate your account.");
  });

  it('offers no fake resend control (no such backend endpoint exists)', () => {
    // The N3 audit found no resend endpoint. A resend button would be a control
    // that silently does nothing, so neither surface may contain one. Asserted
    // against the comment-stripped source so the explanatory comments that
    // document this decision do not themselves trip the check.
    expect(gateCode).not.toMatch(/resend/i);
    expect(activationCode).not.toMatch(/resend/i);
  });
});

describe('N3-F: the activation page redeems the token through the backend', () => {
  it('posts the token to the real activation endpoint, with cookies', () => {
    expect(activationCode).toContain("fetch('/api/customer/activate'");
    expect(activationCode).toContain("method: 'POST'");
    expect(activationCode).toContain("body: JSON.stringify({ token: rawToken })");
    // same-origin so the session cookie the backend sets is actually stored.
    // Without it the page would report success and the visitor would not be
    // signed in — the exact false-success this phase exists to prevent.
    expect(activationCode).toContain("credentials: 'same-origin'");
  });

  it('reads the token from the URL and keeps it out of component state', () => {
    expect(activationCode).toContain("window.location.search).get('token')");
    // The single `useState` in this component holds the OUTCOME, never the
    // credential; the token lives in a ref so it cannot trigger a re-render or
    // be read out of a snapshot.
    expect(activationCode).toContain('useRef(false)');
    expect(activationCode).not.toMatch(/useState[^)]*token/i);
  });

  it('NEVER persists, renders or logs the raw token', () => {
    // The load-bearing negative assertions of this whole phase.
    expect(activationCode).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB/);
    expect(activationCode).not.toMatch(/console\.(log|info|warn|error|debug)/);
    expect(activationCode).not.toMatch(/navigator\.sendBeacon|gtag|analytics|mixpanel/i);
    // The token is not echoed into any rendered value.
    expect(activationCode).not.toMatch(/\{rawToken\}/);
    expect(activationView).not.toMatch(/value=\{rawToken\}/);
  });

  it('does not attempt the same single-use token twice (StrictMode-safe)', () => {
    // The token is consumed server-side, so a second redemption would report a
    // legitimate success to the user as a failure.
    expect(activationCode).toContain('if (attempted.current) return;');
    expect(activationCode).toContain('attempted.current = true;');
  });

  it('handles every state the backend can actually return', () => {
    // Success.
    expect(activationCode).toContain("if (res.ok)");
    expect(activationCode).toContain("setState('activated')");
    // The backend's ONE generic 400 (unknown / wrong purpose / consumed /
    // expired) must render as ONE message, never as a token oracle.
    expect(activationCode).toContain('if (res.status === 400)');
    expect(activationCode).toContain("setState('invalid')");
    // Everything else (429, 5xx) and any transport error is retry-safe, and is
    // never reported as success.
    expect(activationCode).toContain("setState('unavailable')");
    // A missing token short-circuits BEFORE any request is made.
    expect(activationCode).toContain("if (!hasToken)");
  });

  it('never claims activation succeeded on a failure', () => {
    const successBranch = activationCode.slice(
      activationCode.indexOf("setState('activated')"),
      activationCode.indexOf("if (res.status === 400)"),
    );
    // Nothing in the success branch can be reached except through `res.ok`.
    expect(successBranch).not.toMatch(/catch|status === 4|status === 5/);
    // The copy for the two failure states says the account is NOT active.
    expect(activationView).toContain('Your account has not been activated yet.');
  });

  it('offers a keyboard-reachable path to sign in after success', () => {
    // A real <button> (not a div/anchor), wired to the existing /account surface.
    expect(activationCode).toContain('<Button type="button" variant="primary" size="lg" className="w-full" onClick={onSignIn}>');
    expect(activationView).toContain('Go to sign in');
  });

  it('is accessible: one heading, announced states, no colour-only signalling', () => {
    expect((activationCode.match(/<h1/g) || []).length).toBe(1);
    // Loading is announced through the shared Spinner (role="status").
    expect(activationCode).toContain('<Spinner');
    expect(activationCode).toContain('label={t(');
    // Outcomes are announced by the shared Banner, which sets role="alert" for
    // error/warning and role="status" for success, and always pairs colour with
    // an icon and distinct wording.
    expect(activationCode).toContain('<Banner kind="success"');
    expect(activationCode).toContain('<Banner kind="error"');
    expect(activationCode).toContain('<Banner kind="warning"');
    // No form, so no unlabelled control can exist on this surface.
    expect(activationCode).not.toMatch(/<form/);
  });

  it('follows the existing en/sw localisation convention', () => {
    // Same `t(en, sw)` helper every other localised surface uses, and every
    // user-visible string goes through it rather than being hard-coded English.
    expect(activationCode).toContain("const t = (en: string, swText: string) => (sw ? swText : en);");
    expect(activationView).toContain('Akaunti yako iko tayari');
    expect(activationView).toContain('Your account is ready');
  });

  it('reuses existing design tokens rather than inventing new ones', () => {
    expect(activationView).toContain('max-w-md');
    // UX-07 moved this page onto the shared appearance tokens, so the card is
    // the raised surface from docs/design-system.md section 5: its fill, border
    // and text colours are the same CSS variables every other migrated surface
    // uses, defined once, and they follow the selected appearance. The literals
    // this test used to pin here - a `border-brand-border` card with
    // `text-brand-dark-text` - were exactly what UX-07 replaced, because a
    // brand-* literal cannot follow the customer's theme choice.
    expect(activationView).toContain('bg-[var(--appearance-surface)]');
    expect(activationView).toContain('border-[var(--appearance-border)]');
    expect(activationView).toContain('text-[var(--appearance-text-primary)]');
    expect(activationView).toContain('rounded-panel');
    expect(activationView).toContain('shadow-raised');
    // Responsive at phone, tablet and desktop via the same padding scale the
    // account surface already uses.
    expect(activationView).toContain('px-4 py-8 sm:py-12');
    expect(activationView).toContain('p-5 sm:p-6');
  });

  it('introduces no second authentication mechanism', () => {
    expect(activationCode).not.toMatch(/bearer/i);
    expect(activationCode).not.toMatch(/customer_token|admin_token|agent_token/);
    // The page never mints a session; it only receives the one the backend set.
    expect(activationCode).not.toMatch(/setCustomerSession|createSession|document\.cookie\s*=/);
  });
});
