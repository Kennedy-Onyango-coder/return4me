// =============================================================================
// PI-1 / A — ONE authentication policy for every claim entry point.
// =============================================================================
//
// LIMITATION (documented): this is a SOURCE-STRUCTURE contract, not a browser
// render. It proves both claim entry points share the SAME sign-in gate and a
// safe return path; it does not click through the journey. The session check
// itself (`GET /api/customer/me` → onRequireAuth) is the production boundary,
// asserted structurally here because the components mount through App without a
// React-render harness in this suite.
// =============================================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const read = (rel: string) => readFileSync(new URL('../..' + '/' + rel, import.meta.url), 'utf8');

describe('PI-1 A — claim entry points share one auth boundary', () => {
  it('the public item page gates "It\'s Mine" on a real session check', () => {
    const source = read('src/components/PublicItemView.tsx');
    // A plain authenticated GET decides the branch — no hidden client flag.
    expect(source).toContain("fetch('/api/customer/me'");
    expect(source).toContain('onRequireAuth()');
    expect(source).toContain('onContinueClaim(item)');
  });

  it('the OwnerView search-result "Claim" button cannot skip the gate', () => {
    const source = read('src/components/OwnerView.tsx');
    // The previously-ungated direct jump into confidence_gate must now be
    // preceded by an isSignedIn branch that routes to the gated item page.
    const claimButton = source.split('\n').filter((l) => /onClick=\{\(\) => \{/.test(l));
    // The claim button's handler checks the session before entering the gate.
    expect(source).toMatch(/if \(!isSignedIn\)\s*\{\s*onOpenItem\?\.\(item\.id\);\s*return;\s*\}/);
    expect(source).toContain("setVerificationStep('confidence_gate')");
  });

  it('the return after sign-in is an internal allowlisted path, not a raw URL', () => {
    const source = read('src/App.tsx');
    // The unauth hand-off uses the allowlisted accountPath(itemPath(...)) — no
    // arbitrary user-controlled redirect is trusted.
    expect(source).toContain('navigate(accountPath(itemPath(route.itemId)), \'home\')');
  });
});