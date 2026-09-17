import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// F8 — OwnerView pickup-details state machine (Phase 7C.5).
//
// WHY SOURCE-LEVEL: this repository ships no DOM / React Testing Library
// harness (no jsdom in package.json), and this phase deliberately does not add
// one. The same constraint is already documented in
// claimStatusPollingRateLimit.test.ts, which pins the 429 poller behaviour the
// same way. What is asserted here are the structural properties that make the
// old defect impossible to reintroduce:
//
//   * the fetch result is discriminated, so four different outcomes can no
//     longer collapse into `null` and be rendered as one placeholder;
//   * 409 / 429 / 5xx / network failure each map to an explicit state;
//   * the awaiting-agent step actually starts the request (it previously
//     rendered a placeholder while making no request at all);
//   * no stale response may update the UI, and no agent may be merged onto an
//     item the server did not attribute the claim to (F7 guard).
//
// The server-side contract these states consume is exercised for real over
// HTTP in publicItemJourney.test.ts.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(__dirname, '../..');
const ownerViewTsx = fs.readFileSync(path.resolve(repoRoot, 'src/components/OwnerView.tsx'), 'utf8');
// Phase 7C.7 (R3): the server-side phone comparison remains the final authority
// for the pickup-details request, so the handoff below is asserted alongside it.
const publicItemsTs = fs.readFileSync(path.resolve(repoRoot, 'src/routes/publicItems.ts'), 'utf8');

// Everything from the low-level request through the retry affordance: the whole
// pickup-details mechanism, and nothing else in the component.
const pickupMechanism = ownerViewTsx.slice(
  ownerViewTsx.indexOf('const requestPickupDetails'),
  ownerViewTsx.indexOf('const retryPickupDetails')
);

describe('F8 — pickup-details result is discriminated', () => {
  it('declares three explicit result kinds instead of `agent | null`', () => {
    expect(pickupMechanism.length).toBeGreaterThan(500);
    expect(ownerViewTsx).toMatch(/type PickupDetailsResult =/);
    expect(ownerViewTsx).toContain("{ kind: 'ok'; itemId: string | null; agent: any | null }");
    expect(ownerViewTsx).toContain("{ kind: 'ineligible' }");
    expect(ownerViewTsx).toMatch(/\{ kind: 'error'; retryable: boolean; status\?: number \}/);
  });

  it('never collapses a failed response into null', () => {
    // The two exact shapes the old helper used.
    expect(ownerViewTsx).not.toMatch(/if \(!res\.ok\) return null/);
    expect(ownerViewTsx).not.toMatch(/return data\?\.agent \|\| null/);
    // ...and the mechanism has no `return null` at all.
    expect(pickupMechanism).not.toMatch(/return null/);
  });
});

describe('F8 — every outcome maps to its own state', () => {
  it('409 (claim no longer eligible) is a distinct product state, not an error', () => {
    expect(pickupMechanism).toMatch(/if \(res\.status === 409\) return \{ kind: 'ineligible' \};/);
    expect(pickupMechanism).toContain("{ status: 'ineligible' }");
    // ...and it is rendered as such.
    expect(ownerViewTsx).toMatch(/state\.status === 'ineligible'/);
    expect(ownerViewTsx).toContain('pickupIneligibleMessage');
  });

  it('429 is explicitly retryable and never silently swallowed', () => {
    expect(pickupMechanism).toMatch(/if \(res\.status === 429\) return \{ kind: 'error', retryable: true, status: 429 \};/);
  });

  it('5xx is retryable and other 4xx is not', () => {
    expect(pickupMechanism).toMatch(/if \(!res\.ok\) return \{ kind: 'error', retryable: res\.status >= 500, status: res\.status \};/);
  });

  it('a network failure (or a superseded abort) becomes an explicit retryable error', () => {
    expect(pickupMechanism).toMatch(/catch \(e: any\) \{/);
    expect(pickupMechanism).toMatch(/e\?\.name === 'AbortError'/);
    expect(pickupMechanism).toMatch(/result = \{ kind: 'error', retryable: true \};/);
    // No sensitive detail is logged or surfaced.
    expect(pickupMechanism).toMatch(/console\.error\('Failed to load pickup agent details\.'\)/);
    expect(pickupMechanism).not.toMatch(/console\.error\([^)]*phone/i);
  });

  it('200 with `agent: null` is a deliberate "no hub assigned yet" state', () => {
    expect(pickupMechanism).toMatch(/setPickupDetails\(\{ status: 'ready', agent: result\.agent \}\)/);
    expect(ownerViewTsx).toMatch(/if \(!state\.agent\)/);
    expect(ownerViewTsx).toContain('pickupNoHubMessage');
    // A successful null answer must not keep rendering older/coarse details.
    expect(pickupMechanism).toMatch(/\{ \.\.\.prev, agent: result\.agent \}/);
  });
});

describe('F8 — no unbounded "Fetching..." placeholder', () => {
  it('the old permanent placeholder copy is gone entirely', () => {
    expect(ownerViewTsx).not.toContain('Fetching physical agent location details');
    expect(ownerViewTsx).not.toContain('Inapakia maelezo ya mahali pa wakala');
  });

  it('the loading copy is rendered from an explicit in-flight state only', () => {
    expect(ownerViewTsx).toMatch(/state\.status === 'idle' \|\| state\.status === 'loading'/);
    expect(ownerViewTsx).toMatch(/pickupLoadingMessage\(lang\)/);
    // The loading copy is never emitted from an `agent == null` branch.
    expect(ownerViewTsx).not.toMatch(/selectedItem\?\.agent \? \(/);
  });

  it('both hub cards render from the explicit pickup-details state', () => {
    expect((ownerViewTsx.match(/state=\{pickupDetails\}/g) || []).length).toBe(2);
    expect(ownerViewTsx).toMatch(/showDirections/);
  });
});

describe('F8 — retry and staleness', () => {
  it('retryable failures expose a retry affordance wired to the claim', () => {
    expect(ownerViewTsx).toMatch(/state\.retryable &&/);
    expect(ownerViewTsx).toMatch(/onClick=\{onRetry\}/);
    expect(ownerViewTsx).toMatch(/const retryPickupDetails = \(\) => \{/);
  });

  it('a superseded request can never update the UI', () => {
    expect(ownerViewTsx).toMatch(/const seq = pickupRequestSeqRef\.current;/);
    expect(ownerViewTsx).toMatch(/if \(seq !== pickupRequestSeqRef\.current\)/);
    expect(ownerViewTsx).toContain('new AbortController()');
    expect(ownerViewTsx).toMatch(/pickupAbortRef\.current\.abort\(\)/);
  });

  it('the awaiting-agent and handover steps initiate the request themselves', () => {
    expect(ownerViewTsx).toMatch(/verificationStep !== 'awaiting_agent_confirmation' && verificationStep !== 'handover_success'/);
    expect(ownerViewTsx).toMatch(/void fetchAgentPickupDetails\(claimId\)/);
    // Asked-for-once guard: a re-render must not re-request.
    expect(ownerViewTsx).toMatch(/pickupRequestedForClaimRef\.current === claimId/);
  });
});

describe('F7 — identity assertion before any private-agent merge', () => {
  it('the response item id must match the item on screen before anything is displayed or merged', () => {
    expect(ownerViewTsx).toMatch(/const onScreenItemId = selectedItemRef\.current\?\.id \?\? null;/);
    expect(ownerViewTsx).toMatch(/if \(!result\.itemId \|\| !onScreenItemId \|\| result\.itemId !== onScreenItemId\)/);
  });

  it('the merge itself re-checks identity and fails closed', () => {
    expect(ownerViewTsx).toMatch(/setSelectedItem\(prev => \(prev && prev\.id === result\.itemId \? \{ \.\.\.prev, agent: result\.agent \} : prev\)\);/);
    // The unguarded form must not exist.
    expect(ownerViewTsx).not.toMatch(/setSelectedItem\(prev => prev \? \{ \.\.\.prev, agent: pickupAgent \} : null\)/);
  });
});

// ---------------------------------------------------------------------------
// R3 (Phase 7C.7) — Track-resume phone handoff.
//
// The Track My Claim modal proves ownership with `trackPhone`; the resumed
// claim's pickup-details request reads `ownerPhoneRef`, which mirrors the
// claim-form `ownerPhone`. The Phase 7C.6 audit found those were two SEPARATE
// states, so a Track-resumed claim sent `phone: ""` and its hub card could
// never load (a non-retryable 400). These assertions pin the handoff that
// closes that split, and pin that the server still re-verifies the value.
// ---------------------------------------------------------------------------
describe('R3 — the proven Track phone reaches the resumed claim\'s pickup-details request', () => {
  it('the resume action copies the Track phone into the single owner-phone source', () => {
    expect(ownerViewTsx).toMatch(/setOwnerPhone\(trackPhone\.trim\(\)\)/);
  });

  it('the handoff sits INSIDE the resume handler, not somewhere unrelated', () => {
    const resumeAnchor = ownerViewTsx.indexOf('setPaidClaim(trackResult.claim)');
    expect(resumeAnchor).toBeGreaterThan(-1);
    const handlerStart = ownerViewTsx.lastIndexOf('onClick={() => {', resumeAnchor);
    const handlerEnd = ownerViewTsx.indexOf('setShowTrackModal(false)', resumeAnchor);
    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerEnd).toBeGreaterThan(resumeAnchor);
    const resumeHandler = ownerViewTsx.slice(handlerStart, handlerEnd);
    expect(resumeHandler).toContain('setOwnerPhone(trackPhone.trim())');
    expect(resumeHandler).toContain('setVerificationStep(');
  });

  it('the phone the lookup proved is the phone carried over (not a placeholder)', () => {
    // The lookup request itself sends trackPhone, and the input the user typed
    // into is bound to the same state — so the copied value is exactly the one
    // the server already accepted as this claim's owner phone.
    expect(ownerViewTsx).toMatch(/body: JSON\.stringify\(\{ claimId: trackClaimId, phone: trackPhone \}\)/);
    expect(ownerViewTsx).toMatch(/value=\{trackPhone\}/);
  });

  it('pickup-details therefore reads a non-empty phone via the mirrored ref', () => {
    expect(ownerViewTsx).toMatch(/ownerPhoneRef\.current = ownerPhone/);
    expect(ownerViewTsx).toMatch(/body: JSON\.stringify\(\{ phone: ownerPhoneRef\.current \}\)/);
  });

  it('no second parallel phone state was introduced for the handoff', () => {
    // The pickup-details body must still read the ONE mirrored ref; a
    // trackPhone/other-state read there would reintroduce the split.
    const requestIdx = ownerViewTsx.indexOf('const requestPickupDetails');
    const requestBody = ownerViewTsx.slice(requestIdx, ownerViewTsx.indexOf('const fetchAgentPickupDetails', requestIdx));
    expect(requestBody.length).toBeGreaterThan(200);
    expect(requestBody).toContain('phone: ownerPhoneRef.current');
    expect(requestBody).not.toMatch(/phone:\s*trackPhone/);
  });

  it('the server-side phone comparison remains the final authority (the client is not trusted)', () => {
    expect(publicItemsTs).toMatch(/normalizedInput !== normalizedOwner/);
    expect(publicItemsTs).toMatch(/toE164Kenyan\(String\(phone\)\.replace/);
    // A Track-supplied phone is worth nothing until the server matches it.
    expect(publicItemsTs).toMatch(/res\.status\(404\)\.json\(\{ error: MESSAGES\.claimUnavailable \}\)/);
  });
});
