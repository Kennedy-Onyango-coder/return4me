import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Phase 8.1 — public navigation + design-foundation regression tripwires.
//
// WHY SOURCE-LEVEL: this repository has no DOM test harness, and its views are
// plain TSX files, so the public information architecture is asserted against
// the real source the same way claimStatusPrivacy / ownerPickupDetailsState do.
// These are deliberately tripwires: each fails if a later change reintroduces
// the exact defect the Phase 8 audit found.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

// The "new code must not introduce X" tripwires below must judge the CODE, not
// the prose: these files document the very defects they fix (they name stone-*,
// localStorage, tokens and the internal portal in comments), so comments are
// stripped before those assertions rather than weakening the documentation.
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const navbarTsx = read('src/components/Navbar.tsx');
const appTsx = read('src/App.tsx');
const typesTs = read('src/types.ts');
const publicRoutesTs = read('src/utils/publicRoutes.ts');
const signInTsx = read('src/components/SignInView.tsx');
const becomeAgentTsx = read('src/components/BecomeAgentView.tsx');
const ownerViewTsx = read('src/components/OwnerView.tsx');
const homeViewTsx = read('src/components/HomeView.tsx');
const indexCss = read('src/index.css');
// Code-only views of the two new screens (see stripComments).
const signInCode = stripComments(signInTsx);
const becomeAgentCode = stripComments(becomeAgentTsx);

describe('public navigation IA (Phase 8.1)', () => {
  it('exposes exactly the five public destinations on desktop', () => {
    // Home · I Lost Something · I Found Something · Become an Agent · Sign In
    expect(navbarTsx).toContain("handleNavClick('home')");
    expect(navbarTsx).toContain('t.ownerBtn');
    expect(navbarTsx).toContain('t.finderBtn');
    expect(navbarTsx).toContain('t.becomeAgentBtn');
    expect(navbarTsx).toContain('t.signInBtn');
  });

  it('no longer exposes the Agent Portal as a public navigation destination', () => {
    // The label is rendered from t.agentBtn, so removing that binding makes the
    // string unreachable in every public surface (desktop, drawer, tab bar).
    expect(navbarTsx).not.toMatch(/t\.agentBtn/);
    expect(navbarTsx).not.toMatch(/>\s*Agent Portal\s*</);
    // ...and the internal label is intentionally still available for
    // non-navigation use, which is what the brief allows.
    expect(typesTs).toContain("agentBtn: 'Agent Portal'");
    // The homepage hero must not deep-link the portal either: every public
    // agent entry point now flows through the 'becomeAgent' journey.
    expect(homeViewTsx).not.toMatch(/view: 'agent'/);
  });

  it('the mobile drawer and tab bar carry the same public IA, not a divergent one', () => {
    // Bottom tab bar: no Agent tab; Sign In sits in its place.
    expect(navbarTsx).not.toMatch(/handleNavClick\('agent'\)/);
    // All three surfaces route Sign In through the one chooser view.
    const signInBindings = navbarTsx.match(/handleNavClick\('signin'\)/g) || [];
    expect(signInBindings.length).toBeGreaterThanOrEqual(3);
    // ...and all three route the public agent journey through 'becomeAgent'.
    const becomeAgentBindings = navbarTsx.match(/handleNavClick\('becomeAgent'\)/g) || [];
    expect(becomeAgentBindings.length).toBeGreaterThanOrEqual(2);
  });

  it('the unauthenticated drawer no longer offers "Account"/"My Account" as a destination', () => {
    // The drawer entry adapts: Sign In in public mode, My Account only inside
    // the account surface.
    expect(navbarTsx).toMatch(/isAccountView \? \(lang === 'en' \? 'My Account'/);
    // The contradictory "Guest Account" placeholder is gone.
    expect(navbarTsx).not.toContain('Guest Account');
    expect(navbarTsx).not.toContain('Akaunti ya Mgeni');
  });

  it('the public navigation labels exist in BOTH languages', () => {
    for (const key of ['becomeAgentBtn', 'signInBtn']) {
      expect(typesTs.match(new RegExp(`${key}:`, 'g'))?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
    expect(typesTs).toContain("becomeAgentBtn: 'Become an Agent'");
    expect(typesTs).toContain("signInBtn: 'Sign In'");
  });
});

describe('agent access is preserved, not removed (Phase 8.1)', () => {
  it('/agent_portal is still the agent destination used by the public journey', () => {
    expect(appTsx).toContain("navigate('/agent_portal', 'agent')");
    expect(publicRoutesTs).toContain("const AGENT_PATH = '/agent_portal';");
  });

  it('the Sign In chooser presents both paths and delegates to existing auth surfaces', () => {
    expect(signInCode).toContain('Continue as Owner / Claimant');
    expect(signInCode).toContain('Continue as Agent');
    // Presentation only: no auth machinery of its own (no network call, no
    // session/token handling, no storage).
    expect(signInCode).not.toMatch(/fetch\(/);
    expect(signInCode).not.toMatch(/localStorage/);
    expect(signInCode).not.toMatch(/token/);
  });

  it('the public agent journey does not invent a second registration flow or numbers', () => {
    expect(becomeAgentCode).toContain('Continue to agent registration');
    expect(becomeAgentCode).not.toMatch(/fetch\(/);
    expect(becomeAgentCode).not.toMatch(/api\//);
    // No invented economics: the only economic claim made is "a share of the
    // recovery fee" (which the fee engine implements) — never an amount.
    expect(becomeAgentCode).not.toMatch(/KES|Ksh|\/=|shillings|%|per item/i);
  });

  it('AgentView itself was not modified by this phase (its auth flow is untouched)', () => {
    const agentViewTsx = read('src/components/AgentView.tsx');
    expect(agentViewTsx).toContain('Agent Login');
    expect(agentViewTsx).toContain('Apply to be Agent');
  });
});

describe('design foundation (Phase 8.1)', () => {
  it('defines the five-step typography scale with a 12px floor', () => {
    for (const step of ['caption', 'small', 'body', 'heading', 'display']) {
      expect(indexCss).toContain(`--text-${step}:`);
    }
    // 0.75rem === 12px: nothing smaller is approved for UI text.
    expect(indexCss).toMatch(/--text-caption:\s*0\.75rem;/);
  });

  it('adds semantic surface/text aliases that reuse the existing brand values', () => {
    for (const token of ['--color-ink:', '--color-ink-muted:', '--color-canvas-muted:', '--color-canvas-sunken:', '--color-line-subtle:']) {
      expect(indexCss).toContain(token);
    }
    // The aliases must reuse existing brand colours, not introduce new ones.
    for (const value of ['#003820', '#605B50', '#F4EFE6', '#FDF8EE', '#E8E1D3']) {
      expect(indexCss).toContain(value);
    }
  });

  it('newly written UI introduces NO arbitrary text sizes and NO stone-* palette', () => {
    for (const [name, code] of [['SignInView', signInCode], ['BecomeAgentView', becomeAgentCode]] as const) {
      expect(code, `${name} must not use text-[Npx]`).not.toMatch(/text-\[\d+px\]/);
      expect(code, `${name} must not use the stone-* palette`).not.toMatch(/stone-/);
      // Raw status palettes are banned; the semantic tokens exist for this.
      expect(code, `${name} must not use raw status palettes`).not.toMatch(/\b(bg|text|border)-(emerald|amber|sky|red|green)-\d/);
    }
  });

  it('the corrected claim microcopy stays corrected', () => {
    // P0-A: the Swahili copy that leaked the internal component name into
    // customer-facing text. (The component itself is untouched and still
    // imported — only the leaked sentence had to go.)
    expect(ownerViewTsx).not.toContain('katika VerificationForm');
    expect(ownerViewTsx).not.toMatch(/Hatua ya mwacha/);
    expect(ownerViewTsx).toContain("from './VerificationForm'");
    // P0-B: the claim-id placeholder matches the real CLM-###### format.
    expect(ownerViewTsx).toContain('CLM-482913');
    expect(ownerViewTsx).not.toContain('R4M-CLM-A1B2C3');
    // P0-C: no hardcoded bilingual heading (Swahili forced into English mode).
    expect(ownerViewTsx).not.toContain('Thibitisha Umiliki (Confirm Confidence)');
    // The sub-12px label in the same step is gone.
    expect(ownerViewTsx).not.toContain('text-[7px]');
  });

  it('no emoji anywhere in UI source', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(tsx|ts)$/.test(entry.name)) files.push(full);
      }
    };
    walk(path.resolve(repoRoot, 'src'));
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
    const offenders = files.filter((f) => emoji.test(fs.readFileSync(f, 'utf8')));
    expect(offenders, `emoji found in: ${offenders.join(', ')}`).toEqual([]);
  });
});

describe('accessibility + addressability of the new public screens (Phase 8.1)', () => {
  it('primary CTAs meet the 44px touch-target floor (Button size="lg" is 48px)', () => {
    for (const [name, code] of [['SignInView', signInCode], ['BecomeAgentView', becomeAgentCode]] as const) {
      expect(code, `${name} must use the shared Button primitive`).toContain("from './ui/Button'");
      const largeButtons = code.match(/size="lg"/g) || [];
      expect(largeButtons.length, `${name} primary CTAs must be large`).toBeGreaterThanOrEqual(2);
    }
    // ...and the mobile drawer's Sign In entry was raised to the same floor.
    expect(navbarTsx).toContain('min-h-[44px]');
  });

  it('the new screens are restorable public views (Back/refresh do not dead-end)', () => {
    expect(publicRoutesTs).toMatch(/RESTORABLE_VIEWS[^=]*=\s*\[[^\]]*'signin'/);
    expect(publicRoutesTs).toMatch(/RESTORABLE_VIEWS[^=]*=\s*\[[^\]]*'becomeAgent'/);
    // ...while the authentication-gated surfaces stay excluded, exactly as before.
    expect(publicRoutesTs).not.toMatch(/RESTORABLE_VIEWS[^=]*=\s*\[[^\]]*'admin'/);
    expect(publicRoutesTs).not.toMatch(/RESTORABLE_VIEWS[^=]*=\s*\[[^\]]*'agent'/);
  });

  it('the new screens use semantic headings and real buttons (no div-onClick navigation)', () => {
    for (const [name, code] of [['SignInView', signInCode], ['BecomeAgentView', becomeAgentCode]] as const) {
      expect(code, `${name} must use a section element`).toContain('<section');
      expect(code, `${name} must use a heading element`).toContain('<h2');
      expect(code, `${name} must not use div-onClick`).not.toMatch(/<div[^>]*onClick=/);
      expect(code, `${name} must not fake a button`).not.toMatch(/role="button"/);
    }
  });

  it('each new screen has a per-view document title (screen-reader route announcement)', () => {
    expect(appTsx).toMatch(/signin: \{ en: '[^']+', sw: '[^']+' \}/);
    expect(appTsx).toMatch(/becomeAgent: \{ en: '[^']+', sw: '[^']+' \}/);
  });
});
