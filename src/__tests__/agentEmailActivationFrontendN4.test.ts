// N4 — AGENT EMAIL ACTIVATION FRONTEND.
//
// The frontend half of the N4 contract. The backend suite
// (agentEmailActivationN4.test.ts) owns the security properties; this file owns
// the ones only the client can get wrong:
//
//   * the activation link the backend emails resolves to a page this app serves;
//   * the token never reaches app state, storage, the document title or a log;
//   * the success page distinguishes VERIFIED from OPERATIONAL, which is the
//     distinction the whole N4 architecture exists to make.
//
// The N3 customer page (customerEmailActivationFrontendN3.test.ts) asserts the
// same properties for /activate-email. They are asserted separately rather than
// parameterised because the two pages are separate components with genuinely
// different success semantics, and a shared assertion would let one page's
// contract quietly regress while the other's stayed green.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parsePublicRoute, activateAgentEmailPath, activateEmailPath, isSafeReturnPath } from '../utils/publicRoutes';
import { buildAgentActivationUrl, buildCustomerActivationUrl } from '../services/customerAuth';

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

/**
 * Strips comments. Every NEGATIVE assertion below ("this sink is never used",
 * "this symbol never appears") must run against code, not prose: the file
 * documents its own guarantees in comments, and those comments legitimately
 * NAME the very things being forbidden. Asserting on raw source would fail on a
 * file that documents its own security properties perfectly correctly — which
 * is why the N3 suites strip comments for the same reason.
 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const appTsx = read('App.tsx');
const routesTs = read('utils/publicRoutes.ts');
const viewTs = read('components/AgentActivationView.tsx');
// Comment-stripped twins, for the negative assertions only.
const viewCode = stripComments(viewTs);
const agentViewCode = stripComments(read('components/AgentView.tsx'));
const appCode = stripComments(appTsx);
const routesCode = stripComments(routesTs);
const typesTs = read('types.ts');
const authTs = read('services/auth.ts');

const RAW_TOKEN = 'b'.repeat(64);

describe('N4-FE-1 — the emailed link resolves to a page this app serves', () => {
  it('the path constant and the URL builder agree', () => {
    // The single most important frontend invariant: the page the backend links
    // to and the page the app serves must be the same path, or every activation
    // email in production is a dead link.
    expect(activateAgentEmailPath()).toBe('/activate-agent-email');
    expect(buildAgentActivationUrl(RAW_TOKEN)).toContain('/activate-agent-email?token=');
  });

  it('the route parses in every shape a link can arrive in', () => {
    expect(parsePublicRoute('/activate-agent-email')).toEqual({ kind: 'activateAgentEmail', hasToken: false });
    expect(parsePublicRoute('/activate-agent-email/')).toEqual({ kind: 'activateAgentEmail', hasToken: false });
    expect(parsePublicRoute('/ACTIVATE-AGENT-EMAIL')).toEqual({ kind: 'activateAgentEmail', hasToken: false });
  });

  it('is a DISTINCT route kind from the customer activation page', () => {
    // Sharing a kind would force both pages to ask "am I a customer or an
    // agent?" on the success path, where the wrong answer is most costly.
    expect(parsePublicRoute('/activate-email')).toEqual({ kind: 'activateEmail', hasToken: false });
    expect(activateEmailPath()).toBe('/activate-email');
    expect(buildCustomerActivationUrl(RAW_TOKEN)).toContain('/activate-email?token=');
    expect(buildCustomerActivationUrl(RAW_TOKEN)).not.toContain('/activate-agent-email');
  });

  it('records only token PRESENCE, never the value', () => {
    const route = parsePublicRoute('/activate-agent-email', `?token=${RAW_TOKEN}`);
    expect(route).toEqual({ kind: 'activateAgentEmail', hasToken: true });
    // The credential is nowhere in the parsed route, so it cannot reach React
    // state, a history entry, or anything that re-serialises the route.
    expect(JSON.stringify(route)).not.toContain(RAW_TOKEN);
  });

  it('treats a blank or absent token as absent', () => {
    // So the page explains an incomplete link instead of firing a request that
    // can only 400.
    expect(parsePublicRoute('/activate-agent-email', '?token=')).toEqual({ kind: 'activateAgentEmail', hasToken: false });
    expect(parsePublicRoute('/activate-agent-email', '?token=%20%20')).toEqual({ kind: 'activateAgentEmail', hasToken: false });
    expect(parsePublicRoute('/activate-agent-email', '?other=1')).toEqual({ kind: 'activateAgentEmail', hasToken: false });
  });

  it('is rendered in App, in the PUBLIC shell, from the route alone', () => {
    expect(appTsx).toContain("route.kind === 'activateAgentEmail'");
    expect(appTsx).toContain('hasToken={route.hasToken}');
    expect(appTsx).toContain('<AgentActivationView');
  });

  it('is NOT a public destination in the navbar (reached from an email only)', () => {
    expect(routesCode).not.toMatch(/VIEW_PATHS[\s\S]{0,600}activateAgentEmail/);
  });

  it('has no return-destination parameter to abuse', () => {
    // There is no authenticated surface to return to, so there is nothing a
    // redirect parameter could legitimately point at — and no open-redirect
    // surface at all.
    expect(routesCode).not.toMatch(/activateAgentEmail[\s\S]{0,300}isSafeReturnPath/);
    expect(isSafeReturnPath('/activate-agent-email')).toBe(false);
  });
});

describe('N4-FE-2 — the token never leaves the request lifecycle', () => {
  it('is read from window.location at the moment of the request, and not stored', () => {
    expect(viewTs).toContain("new URLSearchParams(window.location.search).get('token')");
    // Read inside the request effect and posted straight to the backend.
    expect(viewTs).toContain("fetch('/api/agents/activate'");
    expect(viewTs).toContain('JSON.stringify({ token: rawToken })');
  });

  it('is held in NO React state variable', () => {
    // The component's state records the OUTCOME only. A `useState` holding the
    // credential would put it in every snapshot, devtools panel and re-render.
    expect(viewCode).not.toMatch(/useState[^;]*\btoken\b/i);
    expect(viewCode).toMatch(/const \[state, setState\] = useState<ActivationState>/);
  });

  it('is written to NO browser storage', () => {
    for (const sink of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'document.title']) {
      expect(viewCode, sink).not.toContain(sink);
    }
  });

  it('is never logged and never sent to analytics', () => {
    expect(viewCode).not.toMatch(/console\.(log|warn|error|info|debug)/);
    expect(viewCode).not.toMatch(/gtag|dataLayer|analytics|track\(/i);
  });

  it('is never rendered, so it cannot appear in the page or a screenshot', () => {
    expect(viewCode).not.toMatch(/\{rawToken\}/);
    expect(viewCode).not.toMatch(/\{token\}/);
  });

  it('App does not read the token value for this route', () => {
    // App may know a token is PRESENT; it must never hold one.
    expect(appCode).not.toMatch(/activateAgentEmail[\s\S]{0,400}URLSearchParams/);
  });
});

describe('N4-FE-3 — redemption happens exactly once, even under StrictMode', () => {
  it('uses the same ref guard as the N3 customer page', () => {
    // React StrictMode runs effects twice in development. The token is
    // single-use server-side, so a second redemption would be reported to the
    // user who legitimately just succeeded.
    expect(viewTs).toContain('const attempted = useRef(false)');
    expect(viewTs).toContain('if (attempted.current) return;');
    expect(viewTs).toContain('attempted.current = true;');
  });

  it('never retries the redemption on a generic failure', () => {
    // Only a 400 (a genuinely unusable token) is final. A network or server
    // fault must not be reported as success.
    expect(viewTs).toContain('if (res.status === 400)');
    expect(viewTs).toContain("setState('unavailable')");
    // 'Try again' is a full page reload that re-reads the URL, never an
    // in-component second POST.
    expect(viewTs).toContain('window.location.reload()');
  });

  it('collapses every backend failure into ONE message (no token oracle)', () => {
    // Unknown, expired, consumed, wrong type and wrong purpose are all a single
    // 400 from the backend. Splitting them here would re-open the oracle it
    // deliberately closed.
    //
    // The proof is STRUCTURAL, not lexical: exactly ONE copy branch renders the
    // unusable-token state. A page that gave "expired" and "already used" their
    // own banners would need a second branch, and there is none.
    expect(viewCode).toContain("setState('invalid')");
    const invalidBranches = viewCode.match(/kind="error"/g) || [];
    expect(invalidBranches).toHaveLength(1);
    // Every unusable-token outcome funnels into that single state: a missing
    // token in the URL, an empty one, and the backend's generic 400.
    expect(viewCode.match(/setState\('invalid'\)/g) || []).toHaveLength(3);
    expect(viewCode).toMatch(/res\.status === 400\)[\s\S]{0,120}setState\('invalid'\)/);
  });
});

describe('N4-FE-4 — the success page tells the truth about approval', () => {
  it('distinguishes VERIFIED from OPERATIONAL', () => {
    // The whole point of N4. Collapsing these into one "success" would tell an
    // unapproved applicant they are done and send them to a hub that 403s.
    expect(viewTs).toContain('verifiedAndOperational');
    expect(viewTs).toContain('verifiedPending');
    expect(viewTs).toContain("body.operational === true ? 'verifiedAndOperational' : 'verifiedPending'");
  });

  it('takes the operational verdict from the SERVER, never infers it', () => {
    expect(viewTs).toContain('body.operational === true');
  });

  it('states on the pending screen that verifying is not approving', () => {
    expect(viewTs.toLowerCase()).toContain('does not approve your application');
    expect(viewTs).toContain('awaiting administrator approval');
  });

  it('offers no resend control, because no resend endpoint exists', () => {
    // A resend button that silently does nothing is worse than no button.
    expect(viewCode.toLowerCase()).not.toContain('resend');
  });

  it('uses the shared primitives and appearance tokens, and stays bilingual', () => {
    expect(viewTs).toContain("import { Button, Banner, Spinner } from './ui'");
    for (const token of ['brand-border', 'brand-muted-text', 'brand-dark-text', 'primary-green']) {
      expect(viewTs, token).toContain(token);
    }
    // Every user-facing string has a Swahili counterpart, as elsewhere.
    expect(viewTs).toContain('const t = (en: string, swText: string) => (sw ? swText : en)');
    expect(viewTs).toContain('Wakala wa Return4me');
  });

  it('keeps the accessibility contract: every state is announced, never colour alone', () => {
    // The shared Banner primitives carry the ARIA roles (success/info are polite
    // status; error/warning are assertive alerts), and they each pair a distinct
    // icon with distinct wording — so no outcome depends on colour perception.
    expect(viewTs).toContain('<Banner kind="success"');
    expect(viewTs).toContain('<Banner kind="error"');
    expect(viewTs).toContain('<Banner kind="warning"');
    expect(viewTs).toContain('<Banner kind="info"');
    // One heading per state, so the accessible name changes with the outcome.
    const headings = viewCode.match(/<h1/g) || [];
    expect(headings).toHaveLength(1);
    expect(viewCode).toContain('aria-labelledby');
    // Every state carries a Swahili counterpart, so the outcome is never
    // communicated by colour alone (or by English alone).
    expect(viewTs).toContain('Hatukuweza kuthibitisha barua pepe yako');
    expect(viewTs).toContain('Kiungo hiki cha kuamilisha hikiwezi kutumika');
  });

  it('the document title is generic and never carries the token', () => {
    expect(appTsx).toContain('Agent Email Verification | Return4me');
    expect(appCode).not.toMatch(/document\.title[^\n]*token/i);
  });
});

describe('N4-FE-5 — agent registration requires the email and explains why', () => {
  it('the field is required, not optional', () => {
    expect(agentViewCode).toContain('Email Address (Required / Barua Pepe - Inahitajika)');
    expect(agentViewCode).not.toContain('Email Address (Optional');
    expect(agentViewCode).toMatch(/id="agent-contact-email"[\s\S]{0,400}required/);
  });

  it('the blank case is checked, not just the malformed case', () => {
    // The pre-N4 guard was `contactEmail && !regex` — it skipped a blank value
    // entirely, which was correct when the field was optional and is a hole now.
    expect(agentViewCode).toContain('if (!trimmedEmail) {');
    expect(agentViewCode).not.toContain('isRegistering && contactEmail && !');
  });

  it('explains why the address is required, in both languages', () => {
    expect(agentViewCode).toContain('t.agentEmailHelp');
    expect(typesTs).toContain('agentEmailHelp');
    // One English and one Swahili entry.
    expect(typesTs.match(/agentEmailHelp:/g)).toHaveLength(2);
  });

  it('shows a post-registration "verify your email" state', () => {
    expect(agentViewCode).toContain('awaitingEmailVerification');
    expect(agentViewCode).toContain('data?.profile?.activationRequired === true');
    // It does not render alongside the approval-only screen, which would give
    // the applicant two contradictory panels.
    expect(agentViewCode).toMatch(/!awaitingEmailVerification && \(/);
  });

  it('that state explains BOTH steps, so no one is promised early access', () => {
    expect(agentViewCode).toContain('Verify your email using the link we sent you');
    expect(agentViewCode).toContain('An administrator approves your application before you can start work');
  });

  it('does NOT create a second agent registration UI', () => {
    // The only agent registration surface is the existing AgentView.
    expect(fs.existsSync(path.resolve(__dirname, '../components/AgentRegistrationView.tsx'))).toBe(false);
    expect(agentViewCode).toContain("role: 'agent'");
  });
});

describe('N4-FE-6 — the authorization predicate stays the server\'s', () => {
  it('the client never decides what is "active"', () => {
    // The frontend may display a state; it may not compute one.
    // isAgentActionable is imported only by the server.
    expect(viewCode).not.toContain('isAgentActionable');
    expect(agentViewCode).not.toContain('isAgentActionable');
  });

  it('isAgentActionable remains a server-side decision combining both axes', () => {
    expect(authTs).toContain('export function isAgentActionable');
    expect(authTs).toContain("if (agent.status !== 'active') return false;");
    expect(authTs).toContain('if (agent.email_verified_at) return true;');
    expect(authTs).toContain('return !agent.contact_email;');
  });
});
