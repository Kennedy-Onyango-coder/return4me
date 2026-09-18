import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Phase 8.2 — public claim-experience tripwires.
//
// Source-level for the same reason as the rest of this repository's UI tests:
// no DOM harness exists, and these assertions are about the shipped markup.
// Each one fails if a later change reintroduces the exact defect Phase 8.2
// fixed.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

/**
 * Source with comments removed. Assertions about *rendered copy* must not fire
 * on a maintenance comment that quotes a claim this phase deliberately removed
 * (that is documentation, not something a user can see).
 */
const withoutComments = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const stepperTsx = read('src/components/ui/Stepper.tsx');
const ownerViewTsx = read('src/components/OwnerView.tsx');
const homeViewTsx = read('src/components/HomeView.tsx');
const finderViewTsx = read('src/components/FinderView.tsx');
const publicItemTsx = read('src/components/PublicItemView.tsx');

describe('claim progress (Phase 8.2)', () => {
  it('the shared Stepper primitive is actually used by the claim journey', () => {
    expect(ownerViewTsx).toContain("import Stepper from './ui/Stepper';");
    expect(ownerViewTsx).toContain('<Stepper');
    // Wired to the EXISTING step state — presentation only.
    expect(ownerViewTsx).toContain('CLAIM_STEP_INDEX[verificationStep]');
    expect(ownerViewTsx).toMatch(/label=\{lang === 'en' \? 'Claim progress'/);
    // Hidden on the search screen and on the terminal expired state.
    expect(ownerViewTsx).toContain("verificationStep !== 'search' && verificationStep !== 'payment_window_expired'");
  });

  it('the Stepper honours the 12px text floor', () => {
    expect(stepperTsx).not.toMatch(/text-\[\d+px\]/);
    expect(stepperTsx).toContain('text-caption');
  });

  it('the progress model invents no statuses and leaves the lifecycle vocabulary alone', () => {
    const start = ownerViewTsx.indexOf('const CLAIM_STEP_INDEX');
    expect(start).toBeGreaterThan(-1);
    const model = ownerViewTsx.slice(start, start + 400);
    for (const key of [
      'confidence_gate', 'tier1_security', 'tier2_otp', 'tier3_id',
      'awaiting_agent_confirmation', 'payment', 'payment_polling', 'handover_success',
    ]) {
      expect(model, `progress model must map ${key}`).toContain(key);
    }
    for (const status of ['pending_verification', 'escrow_held', 'pending_settlement', 'releasing', 'refunded', 'refunding']) {
      expect(model, `progress model must not define ${status}`).not.toContain(status);
    }
  });
});

describe('dynamic claim status is announced (Phase 8.2)', () => {
  it('both polling status cards are polite live regions', () => {
    expect(ownerViewTsx).toContain(
      'bg-emerald-50 border border-emerald-100 rounded-2xl p-4 text-xs text-left text-primary-green flex items-start space-x-2" role="status" aria-live="polite"'
    );
    // The payment-status card is identified by its surface/typography rather
    // than by one border token, so token migrations cannot silently drop the
    // live region (its border moved to border-line-subtle in Phase 8.3).
    expect(ownerViewTsx).toMatch(
      /bg-brand-beige border border-[\w-]+ rounded-2xl p-5 text-left text-xs space-y-3 font-medium text-stone-600" role="status" aria-live="polite"/
    );
  });

  it('announcements stay targeted rather than noisy', () => {
    const live = ownerViewTsx.match(/aria-live=/g) || [];
    expect(live.length).toBeGreaterThanOrEqual(2);
    expect(live.length).toBeLessThanOrEqual(4);
  });
});

describe('mobile form semantics (Phase 8.2)', () => {
  it('phone inputs declare inputMode and autoComplete', () => {
    expect(ownerViewTsx).toMatch(/id="owner-phone"\s*\r?\n\s*type="tel"\s*\r?\n\s*inputMode="tel"\s*\r?\n\s*autoComplete="tel"/);
    expect(ownerViewTsx).toMatch(/id="track-phone"\s*\r?\n\s*type="tel"\s*\r?\n\s*inputMode="tel"\s*\r?\n\s*autoComplete="tel"/);
  });

  it('the OTP input declares one-time-code semantics', () => {
    expect(ownerViewTsx).toMatch(/inputMode="numeric"\s*\r?\n\s*autoComplete="one-time-code"/);
  });

  it('the claim-id input opts out of autofill and autocorrect', () => {
    expect(ownerViewTsx).toMatch(/id="track-claim-id"\s*\r?\n\s*type="text"\s*\r?\n\s*autoComplete="off"/);
  });

  it('validation behaviour is unchanged', () => {
    // The OTP field keeps its 4-digit limit and the phone field stays required.
    expect(ownerViewTsx).toContain('maxLength={4}');
    expect(ownerViewTsx).toMatch(/maxLength=\{4\}[\s\S]{0,400}required/);
  });
});

describe('contrast remediation (Phase 8.2)', () => {
  it('orange is no longer used as light-surface text where it failed AA', () => {
    // Measured 2.78:1 (orange on white) / 2.63:1 (on beige) — both below 4.5:1.
    expect(ownerViewTsx).not.toContain('text-xs font-black text-accent-orange hover:underline');
    expect(ownerViewTsx).not.toContain('font-mono text-base font-extrabold text-accent-orange');
    expect(ownerViewTsx).not.toContain('font-mono text-accent-orange">KES');
    expect(homeViewTsx).not.toContain('text-[11px] font-extrabold uppercase tracking-widest text-accent-orange');
  });

  it('the homepage eyebrow uses the caption token and a passing colour', () => {
    expect(homeViewTsx).toContain('text-caption font-extrabold uppercase tracking-widest text-ink-muted mb-3');
  });

  it('the pickup code keeps its brand accent because it sits on dark green (4.89:1)', () => {
    expect(ownerViewTsx).toContain('bg-primary-green text-white p-5 rounded-2xl');
    expect(ownerViewTsx).toContain('text-2xl font-mono font-extrabold tracking-wider text-accent-orange');
  });
});

describe('image handling (Phase 8.2)', () => {
  it('the large homepage photograph is lazy-loaded and decoded off the main thread', () => {
    const idx = homeViewTsx.indexOf('/assets/return4me-earn-and-return.webp');
    expect(idx).toBeGreaterThan(-1);
    const img = homeViewTsx.slice(idx, idx + 500);
    expect(img).toContain('loading="lazy"');
    expect(img).toContain('decoding="async"');
  });
});

describe('OwnerView design-system migration (Phase 8.3)', () => {
  it('owner surfaces and text now use the semantic tokens', () => {
    expect(ownerViewTsx).toContain('text-ink-muted');
    expect(ownerViewTsx).toContain('text-ink');
    expect(ownerViewTsx).toContain('border-line-subtle');
    expect(ownerViewTsx).toContain('bg-canvas-muted');
    expect(ownerViewTsx).toContain('bg-line-subtle');
  });

  it('the arbitrary caption sizes are gone except the documented micro-badge', () => {
    const arbitrary = ownerViewTsx.match(/text-\[\d+px\]/g) || [];
    expect(arbitrary.length).toBeLessThanOrEqual(1);
    expect(ownerViewTsx).toMatch(/w-5 h-5 rounded-full[\s\S]{0,90}text-\[\d+px\]/);
  });

  it('keeps the shades that carry meaning instead of flattening them', () => {
    // Light greys on the dark green pickup-code card (measured 8.6:1).
    expect(ownerViewTsx).toContain('text-caption font-bold uppercase tracking-widest text-stone-300');
    expect(ownerViewTsx).toContain('text-stone-100 font-semibold');
    // The payment progress card encodes done / in-progress / pending with three
    // different shades plus an opacity treatment — not redundant duplication.
    expect(ownerViewTsx).toContain('flex items-center space-x-2 text-stone-500');
    expect(ownerViewTsx).toContain('flex items-center space-x-2 text-stone-400');
  });

  it('adopts the shared Button primitive for the pickup retry action', () => {
    expect(ownerViewTsx).toContain("import Button from './ui/Button';");
    expect(ownerViewTsx).toMatch(/<Button[\s\S]{0,160}onClick=\{onRetry\}/);
    expect(ownerViewTsx).toContain('variant="outline"');
    expect(ownerViewTsx).toContain('size="sm"');
    expect(ownerViewTsx).not.toContain('Button.tsx');
  });

  it('restyling did not touch the claim lifecycle or the 8.2 input semantics', () => {
    for (const s of [
      'confidence_gate', 'tier1_security', 'tier2_otp', 'tier3_id',
      'awaiting_agent_confirmation', 'payment', 'payment_polling',
      'handover_success', 'payment_window_expired',
    ]) {
      expect(ownerViewTsx, `state ${s} must survive the restyle`).toContain(`'${s}'`);
    }
    expect(ownerViewTsx).toMatch(/inputMode="tel"/);
    expect(ownerViewTsx).toMatch(/inputMode="numeric"/);
    expect(ownerViewTsx).toMatch(/autoComplete="one-time-code"/);
  });
});

describe('public discovery surfaces (Phase 8.4)', () => {
  it('no public journey file uses a sub-12px arbitrary text size', () => {
    for (const [name, src] of [
      ['FinderView', finderViewTsx],
      ['PublicItemView', publicItemTsx],
      ['HomeView', homeViewTsx],
    ] as const) {
      expect(src, `${name} must stay on the caption scale`).not.toMatch(/text-\[\d+px\]/);
    }
  });

  it('the finder report surfaces use the semantic tokens', () => {
    expect(finderViewTsx).toContain('text-ink-muted');
    expect(finderViewTsx).toContain('border-line-subtle');
    // Shades that carry meaning on dark surfaces are not flattened.
    expect(finderViewTsx).toContain('bg-stone-800 text-white');
    expect(finderViewTsx).toContain('disabled:text-stone-400');
  });

  it('a failed report submit never renders raw exception text', () => {
    // Phase 8.4: the previous implementation rendered `e.message`, which for a
    // network/parse failure is browser text ("Failed to fetch", "Unexpected
    // token < in JSON…") — implementation detail shown to a public user.
    expect(finderViewTsx).not.toMatch(/setErrorMsg\(\s*e\.message\s*\)/);
    expect(finderViewTsx).not.toMatch(/setErrorMsg\(\s*err\.message\s*\)/);
    expect(finderViewTsx).toContain('submitErrorMessage');
    // The API's own user-facing error string is still honoured.
    expect(finderViewTsx).toMatch(/apiMessage \|\| submitErrorMessage/);
  });

  it('the finder report flow is bilingual throughout', () => {
    // These three were rendered as plain JSX text (always English) until 8.4.
    expect(finderViewTsx).toMatch(/lang === 'en' \? 'Report Another Item' : 'Ripoti Kitu Kingine'/);
    expect(finderViewTsx).toMatch(/lang === 'en' \? 'Take a photo or upload file' : 'Piga picha au weka faili ya picha'/);
    expect(finderViewTsx).toMatch(/lang === 'en' \? 'Phone' : 'Simu'/);
  });
});

describe('claim entry from the public item page (Phase 8.4)', () => {
  it("renders \"It's Mine\" only on the ready item and wires it to the session gate", () => {
    expect(publicItemTsx).toContain('{state === \'ready\' && item && (');
    expect(publicItemTsx).toContain('{t("It\'s Mine", \'Ni Yangu\')}');
    expect(publicItemTsx).toContain('onClick={handleClaimClick}');
  });

  it('proves the session before entering the claim journey and fails closed', () => {
    // The button never enters the claim flow directly: it checks the
    // authenticated session and otherwise hands off to the auth surface.
    expect(publicItemTsx).toMatch(/fetch\('\/api\/customer\/me'/);
    expect(publicItemTsx).toMatch(/if \(res\.ok\) \{\s*\r?\n\s*onContinueClaim\(item\)/);
    expect(publicItemTsx).toMatch(/catch \{[\s\S]{0,220}onRequireAuth\(\)/);
  });

  it('never creates a claim, a payment or a pickup request from the public page', () => {
    expect(publicItemTsx).not.toMatch(/\/api\/claims\/[^'`]*\/(pay|request-otp|pickup-details)/);
    expect(publicItemTsx).not.toMatch(/method:\s*'POST'/);
    // Its only data source is the masked public read model.
    expect(publicItemTsx).toMatch(/\/api\/items\/\$\{encodeURIComponent\(itemId\)\}\/public/);
  });

  it('never references a private field name', () => {
    for (const field of [
      'contact_phone',
      'finder_phone',
      'document_number',
      'document_number_hash',
      'latitude',
      'longitude',
      'extracted_name',
      'collection_code',
    ]) {
      expect(publicItemTsx, `public page must not read ${field}`).not.toContain(field);
    }
  });

  it('the item page keeps exactly one polite live region', () => {
    expect((publicItemTsx.match(/aria-live=/g) || []).length).toBe(1);
    expect(publicItemTsx).toContain('role="status"');
    expect(publicItemTsx).toContain('role="alert"');
  });
});

describe('homepage found-item discovery (Phase 8.4)', () => {
  it('renders an explicit loading, error and empty state', () => {
    expect(homeViewTsx).toContain('recentItemsLoading ? (');
    expect(homeViewTsx).toContain('recentItemsError ? (');
    expect(homeViewTsx).toContain('recentItems.length === 0 ? (');
    // Loading is skeleton-based (not a bare spinner) and the two empty
    // branches use the shared EmptyState primitive with bilingual copy.
    expect(homeViewTsx).toContain('<Skeleton shape="rect"');
    expect((homeViewTsx.match(/<EmptyState/g) || []).length).toBe(2);
  });

  it('the empty state offers only the capability that actually exists', () => {
    // There is no lost-item reporting backend, so the empty discovery state
    // must not promise lost-report matching — it points at reporting a FOUND
    // item, which is the real backend capability.
    expect(homeViewTsx).toMatch(/setView\('finder'\)/);
    expect(homeViewTsx).not.toMatch(/report (a )?lost item/i);
  });

  it('a discovery card exposes only masked public fields', () => {
    // The card links to the public item route and renders category, masked
    // description, date and the short reference — never a private field.
    expect(homeViewTsx).toContain('onOpenItem(item.id)');
    expect(homeViewTsx).toContain('is_sensitive_document');
    expect(homeViewTsx).not.toContain('document_number');
    expect(homeViewTsx).not.toContain('contact_phone');
    expect(homeViewTsx).not.toContain('finder_phone');
  });
});

describe('finder report flow (Phase 8.5)', () => {
  it('renders no English-only user-facing string', () => {
    // These were hard-coded English text nodes until 8.5, including the two
    // camera-overlay actions, the terms sentence and the privacy note.
    expect(finderViewTsx).toMatch(/lang === 'en' \? 'Capture' : 'Piga Picha'/);
    expect(finderViewTsx).toMatch(/lang === 'en' \? 'Cancel' : 'Ghairi'/);
    expect(finderViewTsx).toMatch(/lang === 'en' \? 'Terms of Service' : 'Vigezo na Masharti'/);
    expect(finderViewTsx).toMatch(/lang === 'en' \? 'Privacy Policy' : 'Sera ya Faragha'/);
    expect(finderViewTsx).toMatch(/'I have read and agree to the Return4me' : 'Nimesoma na nakubali'/);
    expect(finderViewTsx).toContain('Fungua Akaunti ya Msingi wa Return4me');
    // No bare English text nodes survive as JSX children.
    expect(finderViewTsx).not.toMatch(/\n\s+Capture\n/);
    expect(finderViewTsx).not.toMatch(/\n\s+Cancel\n/);
    expect(finderViewTsx).not.toContain('Privacy Assurance');
  });

  it('makes only privacy claims the implementation can support', () => {
    // The previous note asserted the phone was "encrypted in the ledger" and
    // "used strictly for B2C payouts"; finder_phone is a plain indexed varchar
    // with no cipher code in the repo and is also the admin contact channel.
    // Assert against rendered copy, not against the comment that documents it.
    const copy = withoutComments(finderViewTsx);
    expect(copy).not.toMatch(/encrypted in the ledger/i);
    expect(copy).not.toMatch(/\bB2C\b/);
    expect(copy).toMatch(/Your phone number is used for your M-Pesa payout and is never shown to claimants\./);
  });

  it('never implies the scan verified identity, ownership or authenticity', () => {
    const copy = withoutComments(finderViewTsx);
    for (const claim of ['AI-powered', 'AI powered', 'automatically verified', 'ownership verified', 'guaranteed']) {
      expect(copy, `must not claim: ${claim}`).not.toMatch(new RegExp(claim, 'i'));
    }
    // The scan result is presented as a suggestion the finder must review.
    expect(copy).toMatch(/correct anything the scan got wrong/);
  });

  it('announces analysis, submission, failure and success state changes', () => {
    // Analysis overlay.
    expect(finderViewTsx).toMatch(/role="status"[\s\S]{0,80}aria-live="polite"/);
    // Failures (validation + submission) are assertive and wired to the form.
    expect(finderViewTsx).toContain('id="finder-error"');
    expect(finderViewTsx).toContain('role="alert"');
    expect(finderViewTsx).toMatch(/aria-describedby=\{errorMsg \? 'finder-error' : undefined\}/);
    // In-flight submission announcement + busy semantics.
    expect(finderViewTsx).toMatch(/aria-busy=\{isSubmitting \|\| undefined\}/);
    expect(finderViewTsx).toMatch(/Submitting your report…/);
    // Announcements stay targeted, never wholesale.
    const live = finderViewTsx.match(/aria-live=/g) || [];
    expect(live.length).toBeGreaterThanOrEqual(3);
    expect(live.length).toBeLessThanOrEqual(5);
  });

  it('declares mobile input semantics on the payout phone and email', () => {
    expect(finderViewTsx).toMatch(/id="finder-phone"\s*\r?\n\s*type="tel"\s*\r?\n\s*inputMode="tel"\s*\r?\n\s*autoComplete="tel"/);
    expect(finderViewTsx).toMatch(/id="finder-email"\s*\r?\n\s*type="email"\s*\r?\n\s*inputMode="email"\s*\r?\n\s*autoComplete="email"/);
  });

  it('cannot fire a duplicate report while one is in flight', () => {
    expect(finderViewTsx).toMatch(/if \(isSubmitting\) return;/);
    expect(finderViewTsx).toContain('disabled={isSubmitting || !photoBase64}');
  });

  it('labels the photo controls and the preview image meaningfully', () => {
    // A <label> with no associated control was replaced by a group heading.
    expect(finderViewTsx).not.toMatch(/<label className="block text-sm font-extrabold text-primary-green">\{t\.capturePhoto\}/);
    expect(finderViewTsx).toMatch(/<p className="block text-sm font-extrabold text-primary-green">\{t\.capturePhoto\} \*<\/p>/);
    // The icon-only upload control names its file input, and the preview alt is
    // bilingual and item-typed instead of the hard-coded "Found item document".
    expect(finderViewTsx).toMatch(/aria-label=\{lang === 'sw' \? 'Pakia picha' : 'Upload a photo'\}/);
    expect(finderViewTsx).not.toContain('alt="Found item document"');
    expect(finderViewTsx).toMatch(/Photo of the \$\{categories\.find/);
  });

  it('renders no raw exception text anywhere in the file', () => {
    for (const pattern of [
      /setErrorMsg\(\s*e\.message\s*\)/,
      /setErrorMsg\(\s*err\.message\s*\)/,
      /response\.text\(\)/,
      /statusText/,
      /error\.toString\(\)/,
      /JSON\.stringify\(\s*e\w*\s*\)/,
    ]) {
      expect(finderViewTsx, String(pattern)).not.toMatch(pattern);
    }
  });

  it('keeps the GPS copy tied to the capability the backend actually implements', () => {
    // services/AgentMatchingService.assignNearestAgent(lat, lon, area) is what
    // runs server-side, and the payload really carries the coordinates.
    expect(finderViewTsx).toMatch(/latitude,\s*\r?\n\s*longitude,/);

    // P14A (P14-16) — the copy used to promise "the closest Return4me Agent hub"
    // and a FASTER payout ("securing your payout faster"). services/agent.ts only
    // ever considers agents whose status is 'active', and returns
    // { method: 'manual_required' } when none are available, so the strongest
    // honest claim is a NEARBY AVAILABLE hub — plus the manual fallback, which
    // the old copy never mentioned. Both languages must say so.
    const gpsCopy = withoutComments(finderViewTsx);
    expect(gpsCopy).toMatch(/nearby available Return4me Agent hub/);
    expect(gpsCopy).toMatch(/If no Agent can be matched, our team will assign one for you\./);
    expect(gpsCopy).toMatch(/timu yetu itakupangia mmoja\./);
    expect(gpsCopy).not.toMatch(/closest Return4me Agent hub/);
    expect(gpsCopy).not.toMatch(/securing your payout faster/);
    expect(gpsCopy).not.toMatch(/Precise Agent Match Enabled/);
  });
});
