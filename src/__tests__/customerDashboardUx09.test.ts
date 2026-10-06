import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// UX-09 — THE GUIDED CLAIM / RECOVERY JOURNEY (OwnerView.tsx)
// =============================================================================
// The claim journey (search → confidence gate → ownership tiers → payment →
// handover) already had a progress rail, but a rail is not guidance: it says
// WHICH stage the claimant is on and nothing about what happens now or who
// moves next. The five screens underneath it each kept their own idea of the
// journey, offered several equally-weighted actions, and two Kiswahili strings
// were misspelled ("Wea nambari" — "Wea" is not a word; "Weka nambari" is
// "enter the number").
//
// UX-09 IS PRESENTATION ONLY. It deliberately changes none of:
//   * the customer/claim endpoints, their order, their methods or their bodies
//     (the 16 `fetch(` call sites are pinned below, in source order);
//   * the handlers, the state, or the `setVerificationStep` machine they drive;
//   * the lifecycle, the status vocabulary, the polling or the privacy
//     boundary (claim internals still never reach the browser);
//   * which component owns which read (VerificationForm still owns Tier-1, the
//     PickupDetailsPanel still owns the hub-detail request).
// What it changes is ONE derived stage index that feeds BOTH the shared
// `Stepper` rail and a new guide card, the copy that answers "what happens now
// / who acts next", one dominant action per stage on the shared `Button`, and
// the vocabulary of the new surface — all of it by adopting primitives and
// tokens that already exist (`Stepper`, `Button`, the type/radius ladders).
//
// This repository has no jsdom/React harness, so — exactly as the UX-06,
// UX-07 and UX-08 batches do — the contract is asserted against the shipped
// source, with the same comment stripper and the same `sliceBetween` helper.

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
/** The same comment stripper the N3, UX-06, UX-07 and UX-08 suites use. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** Raw: the block comments that introduce each stage act as stable delimiters. */
const OWNER_VIEW_TSX = read('src/components/OwnerView.tsx');
const OWNER_VIEW = stripComments(OWNER_VIEW_TSX);
const INDEX_CSS = read('src/index.css');
const TYPES = read('src/types.ts');
const DESIGN_SYSTEM = read('docs/design-system.md');

const count = (source: string, pattern: RegExp) => (source.match(pattern) || []).length;

function sliceBetween(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = start === -1 ? -1 : source.indexOf(to, start + from.length);
  if (start === -1 || end === -1) throw new Error(`UX-09 marker not found: ${from} -> ${to}`);
  return source.slice(start, end);
}

/**
 * One claim stage, sliced out of the raw source and then stripped, so a comment
 * can never be mistaken for rendered copy.
 */
const stage = (from: string, to: string) => stripComments(sliceBetween(OWNER_VIEW_TSX, from, to));

/**
 * The new UX-09 surface: the shared Stepper rail plus the guide card that
 * answers the two questions — everything between the comment that introduces
 * the guided journey and the one that opens the first stage.
 */
const RAIL_AND_GUIDE = stage(
  '{/* The guided claim journey (Phase 8.2, refined in UX-09)',
  '{/* Confidence Gate Step */}',
);

/** The three typed bilingual tables the rail and the guide are driven by. */
const STEPS = sliceBetween(OWNER_VIEW_TSX, 'const CLAIM_STEPS', 'const CLAIM_STEP_INDEX');
const STEP_INDEX = sliceBetween(
  OWNER_VIEW_TSX,
  'const CLAIM_STEP_INDEX',
  'const CLAIM_STAGE_GUIDE',
);
const GUIDE = stripComments(
  sliceBetween(OWNER_VIEW_TSX, 'const CLAIM_STAGE_GUIDE', 'interface OwnerViewProps'),
);

const confidenceGate = stage(
  "{verificationStep === 'confidence_gate' && selectedItem && (",
  '{/* Tier 1 Security verification',
);
const tier1 = stage(
  "{verificationStep === 'tier1_security' && selectedItem && (",
  '{/* Tier 2 OTP validation */}',
);
const tier2Otp = stage("{verificationStep === 'tier2_otp' && (", '{/* Payment step */}');
const payment = stage(
  "{verificationStep === 'payment' && (",
  '{/* Payment Polling confirmation screen */}',
);
const paymentPolling = stage(
  "{verificationStep === 'payment_polling' && (",
  '{/* Physical pickup handover success */}',
);
const handover = stage(
  "{verificationStep === 'handover_success' && (",
  '{/* Awaiting agent in-person verification step */}',
);
const awaiting = stage(
  "{verificationStep === 'awaiting_agent_confirmation' && (",
  '{/* Payment window expired step */}',
);
const expired = stage(
  "{verificationStep === 'payment_window_expired' && (",
  '{/* TRACK MY CLAIM MODAL',
);

/** The stages that carry a customer action, with the ONE emphasis each may use. */
const ACTION_STAGES: Array<{ name: string; src: string; dominant: string; size: string }> = [
  { name: 'the confidence gate', src: confidenceGate, dominant: 'accent', size: 'md' },
  { name: 'the SMS code stage', src: tier2Otp, dominant: 'primary', size: 'lg' },
  { name: 'the pay stage', src: payment, dominant: 'accent', size: 'lg' },
  { name: 'the waiting-for-M-Pesa stage', src: paymentPolling, dominant: 'accent', size: 'lg' },
];

/**
 * Vocabulary that predates UX-01 and that the guide surface must not adopt: the
 * fixed light-mode literals, the old brand-* names, the panel radius/elevation
 * pair and the off-ladder type sizes. (`text-ink`, `text-ink-muted`,
 * `bg-canvas-muted` and `border-line-subtle` are deliberately NOT in this list:
 * index.css declares them as the current names, and the shared Stepper uses
 * them too.)
 */
const LEGACY_LITERALS = [
  'bg-white',
  'text-black',
  'text-white',
  'bg-brand-beige',
  'bg-brand-light-gray',
  'border-brand-border',
  'text-brand-dark-text',
  'text-brand-muted-text',
  'text-primary-green',
  'text-primary-dark',
  'accent-orange',
  'stone-',
  'rounded-2xl',
  'rounded-xl',
  'rounded-lg',
  'rounded-md',
  'rounded-full',
  'shadow-sm',
  'shadow-md',
  'shadow-lg',
  'text-xs',
  'text-sm',
  'text-base',
  'text-lg',
  'text-xl',
  'text-2xl',
  'focus:ring',
  'focus-visible:ring',
] as const;

/** True when `token` appears as a whole utility, not as part of a longer one. */
const hasToken = (source: string, token: string) => {
  const escaped = token.replace(/-/g, '\\-');
  // A token that ends in a hyphen is a PREFIX (`stone-`), so it may be followed
  // by anything; every other token must end where the class name ends.
  const boundary = token.endsWith('-') ? '' : '(?![\\w-])';
  return new RegExp(`(?:^|[\\s"'\`])${escaped}${boundary}`).test(source);
};

// -----------------------------------------------------------------------------
// The journey's behaviour is untouched
// -----------------------------------------------------------------------------

describe('UX-09 keeps every claim behaviour exactly as it was', () => {
  it('calls the same sixteen endpoints, in the same order', () => {
    // A guidance pass is only safe if the request sequence is provably
    // unchanged, and the sequence is the first thing a UI rewrite is tempted to
    // reorder. Every target, in source order, including both `/status` polls.
    const targets = Array.from(OWNER_VIEW.matchAll(/fetch\((?:'([^']*)'|`([^`]*)`)/g)).map(
      (m) => m[1] ?? m[2],
    );
    expect(targets).toEqual([
      '/api/customer/claims/${encodeURIComponent(paidClaim.id)}/pickup-code/resend',
      '/api/dev/test-mode',
      '/api/claims/${claimId}/pickup-details',
      '/api/items/search?${params.toString()}',
      '/api/claims/submit',
      '/api/claims/${claimId}/request-otp',
      '/api/claims/${paidClaim.id}/verify-otp',
      '/api/claims/${claimId}/status',
      '/api/claims/${claimId}/status',
      '/api/claims/${paidClaim.id}/payment-auth',
      '/api/claims/${paidClaim.id}/payment-session',
      '/api/claims/${paidClaim.id}/payment-session/${sessionId}/initiate',
      '/api/claims/${paidClaim.id}/payment-session/${paymentSessionId}/status',
      '/api/dev/simulate-payment/${paidClaim.id}',
      '/api/claims/${paidClaim.id}/rate',
      '/api/claims/lookup',
    ]);
    expect(count(OWNER_VIEW, /fetch\(/g)).toBe(16);
  });

  it('sends the same methods, credential mode, and reads the outcome the same way', () => {
    expect(count(OWNER_VIEW, /method: 'POST'/g)).toBe(11);
    // Every authenticated read/write still rides the server's session cookie —
    // no second copy of the session anywhere on this surface.
    expect(count(OWNER_VIEW, /credentials: 'same-origin'/g)).toBe(3);
    expect(OWNER_VIEW).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB|bearer/i);
    // The screen never confirms a payment itself: it only reflects the server's
    // and the provider's own vocabulary.
    expect(OWNER_VIEW).toContain(
      "if (s?.status === 'confirmed' || claimStatus === 'escrow_held' || claimStatus === 'released')",
    );
  });

  it('keeps every handler the stages are wired to', () => {
    for (const handler of [
      'const requestPickupCodeResend = async () => {',
      'const requestPickupDetails = async (claimId: string, signal: AbortSignal): Promise<PickupDetailsResult> => {',
      'const retryPickupDetails = () => {',
      'const handleSearch = async (e?: React.FormEvent) => {',
      'const handleTier1Submit = async (answers: Record<string, string>, submittedIdProofBase64: string | null) => {',
      'const triggerOtpRequest = async (claimId: string) => {',
      'const handleOtpVerify = async (e: React.FormEvent) => {',
      'const startAwaitingAgentPolling = (claimId: string) => {',
      'const startPollingPaymentStatus = (claimId: string) => {',
      'const triggerEscrowPayment = async () => {',
      'const checkPaymentStatus = async () => {',
      'const simulatePaymentSuccess = async () => {',
      'const submitRating = async (score: number) => {',
    ]) {
      expect(OWNER_VIEW, `${handler} must still exist`).toContain(handler);
    }
  });

  it('keeps the step machine, transition for transition', () => {
    // The stage index UX-09 derives is a VIEW of this machine — so the machine
    // itself has to stay put, call for call. A new (or removed)
    // `setVerificationStep` site would mean UX-09 moved the journey rather than
    // narrating it.
    const transitions: Record<string, number> = {};
    for (const match of OWNER_VIEW.matchAll(/setVerificationStep\('([a-z0-9_]+)'\)/g)) {
      transitions[match[1]] = (transitions[match[1]] || 0) + 1;
    }
    expect(transitions).toEqual({
      confidence_gate: 3,
      tier1_security: 1,
      tier2_otp: 1,
      payment: 2,
      payment_polling: 1,
      handover_success: 5,
      awaiting_agent_confirmation: 2,
      payment_window_expired: 4,
      search: 3,
    });
    expect(count(OWNER_VIEW, /setVerificationStep\(/g)).toBe(22);
  });

  it('never lets a claim internal reach the browser', () => {
    // The guide is guidance copy: it may not carry, or ask for, a field the
    // customer-safe projection exists to withhold.
    expect(OWNER_VIEW).not.toMatch(
      /security_answers|payment_reference|provider_invoice|provider_reference/,
    );
  });
});

// -----------------------------------------------------------------------------
// The rail and the guide are driven by ONE stage map
// -----------------------------------------------------------------------------

describe('UX-09 drives the rail and the guide from ONE stage map', () => {
  it('maps every claim step onto exactly one of five user-facing stages', () => {
    // The five stages the rail shows, in order, in both languages.
    expect(STEPS).toContain("{ en: 'Confirm', sw: 'Thibitisha' }");
    expect(STEPS).toContain("{ en: 'Verify', sw: 'Thibitisha utambulisho' }");
    expect(STEPS).toContain("{ en: 'Visit hub', sw: 'Tembelea kituo' }");
    expect(STEPS).toContain("{ en: 'Pay', sw: 'Lipa' }");
    expect(STEPS).toContain("{ en: 'Collect', sw: 'Chukua' }");
    expect(count(STEPS, /en: '/g)).toBe(5);
    // Every state the machine can hold while a claim is live resolves to a
    // stage. `tier3_id` stays because an older session can still carry it.
    expect(STEP_INDEX).toContain('const CLAIM_STEP_INDEX: Record<string, number> = {');
    expect(count(STEP_INDEX, /^\s+[a-z0-9_]+: \d,/gm)).toBe(8);
    for (const mapping of [
      'confidence_gate: 0,',
      'tier1_security: 1,',
      'tier2_otp: 1,',
      'tier3_id: 1,',
      'awaiting_agent_confirmation: 2,',
      'payment: 3,',
      'payment_polling: 3,',
      'handover_success: 4,',
    ]) {
      expect(STEP_INDEX, `${mapping} must stay`).toContain(mapping);
    }
  });

  it('derives the index once, and hands the SAME value to the rail and the guide', () => {
    expect(OWNER_VIEW).toContain('const claimStageIndex = CLAIM_STEP_INDEX[verificationStep] ?? 0;');
    expect(OWNER_VIEW).toContain('const claimStageGuide = CLAIM_STAGE_GUIDE[claimStageIndex];');
    expect(count(OWNER_VIEW, /const claimStageIndex = /g)).toBe(1);
    expect(count(OWNER_VIEW, /const claimStageGuide = /g)).toBe(1);
    // Three reads inside the new surface: the rail's `currentStep`, the
    // "Stage n of m" counter and the guide row — all the same value, so the
    // rail and the guide cannot disagree about which stage this is.
    expect(count(RAIL_AND_GUIDE, /claimStageIndex/g)).toBe(3);
    expect(count(RAIL_AND_GUIDE, /claimStageGuide/g)).toBe(3);
    expect(count(RAIL_AND_GUIDE, /stageOf\(/g)).toBe(3);
  });

  it('treats an unknown step as the first stage instead of breaking', () => {
    // Presentation only: an unrecognised state must never blank the journey.
    expect(OWNER_VIEW).toContain('CLAIM_STEP_INDEX[verificationStep] ?? 0;');
    expect(OWNER_VIEW).not.toMatch(/CLAIM_STEP_INDEX\[verificationStep\]!/);
    expect(OWNER_VIEW).not.toMatch(/throw[^\n]{0,40}CLAIM_STEP_INDEX/);
  });

  it('renders the rail only where there is a stage to show', () => {
    // The search screen has not entered the journey, and the terminal expired
    // state has no next stage to point at — so neither gets a rail.
    expect(OWNER_VIEW).toContain(
      "{verificationStep !== 'search' && verificationStep !== 'payment_window_expired' && (",
    );
  });
});

// -----------------------------------------------------------------------------
// Every stage answers what-happens-now and who-acts-next
// -----------------------------------------------------------------------------

describe('UX-09 makes every stage answer what-now and who-next', () => {
  it('asks those two questions, in both languages', () => {
    expect(RAIL_AND_GUIDE).toContain(
      "aria-label={lang === 'en' ? 'What happens at this stage' : 'Kinachotokea katika hatua hii'}",
    );
    expect(RAIL_AND_GUIDE).toContain('`Stage ${claimStageIndex + 1} of ${CLAIM_STEPS.length}`');
    expect(RAIL_AND_GUIDE).toContain('`Hatua ${claimStageIndex + 1} ya ${CLAIM_STEPS.length}`');
    expect(RAIL_AND_GUIDE).toContain(
      "{lang === 'en' ? 'Who acts next' : 'Anayefanya hatua inayofuata'}: {stageOf(claimStageGuide.actor)}",
    );
    // One translator for the whole surface, not three inline ternaries.
    expect(OWNER_VIEW).toContain(
      "const stageOf = (v: { en: string; sw: string }) => (lang === 'en' ? v.en : v.sw);",
    );
    expect(count(OWNER_VIEW, /const stageOf = /g)).toBe(1);
  });

  it('carries one bilingual guide row per stage', () => {
    const rows: Array<[string, string, string, string]> = [
      [
        'Confirm the item is yours',
        'Thibitisha kuwa kitu hiki ni chako',
        'You',
        'Wewe',
      ],
      ['Prove ownership', 'Thibitisha umiliki', 'You', 'Wewe'],
      [
        'Visit the hub and inspect the item',
        'Tembelea kituo na ukague bidhaa',
        'You and the agent',
        'Wewe na wakala',
      ],
      ['Pay the collection fee', 'Lipa ada ya kuchukua', 'You, on M-Pesa', 'Wewe, kwenye M-Pesa'],
      ['Collect your item', 'Chukua bidhaa yako', 'You and the agent', 'Wewe na wakala'],
    ];
    for (const [titleEn, titleSw, actorEn, actorSw] of rows) {
      expect(GUIDE, `${titleEn} must have both titles`).toContain(
        `title: { en: '${titleEn}', sw: '${titleSw}' }`,
      );
      expect(GUIDE, `${titleEn} must name its actor`).toContain(
        `actor: { en: '${actorEn}', sw: '${actorSw}' }`,
      );
    }
    // Five rows, each with a title, an explanation and an actor — all bilingual.
    expect(count(GUIDE, /sw: '/g)).toBe(15);
    expect(count(GUIDE, /what: \{\r?\n\s+en: '/g)).toBe(5);
  });

  it('states a next actor on every stage, and every actor is a real one', () => {
    const actors = Array.from(GUIDE.matchAll(/actor: \{ en: '([^']*)', sw: '([^']*)' \}/g));
    expect(actors).toHaveLength(5);
    for (const [, en, sw] of actors) {
      expect(en.trim().length, 'missing English actor').toBeGreaterThan(0);
      expect(sw.trim().length, `missing Kiswahili actor for "${en}"`).toBeGreaterThan(0);
      expect(sw, `"${en}" was left untranslated`).not.toBe(en);
    }
    // The claimant can always tell when the move is theirs: twice it is the
    // claimant alone, twice it is claimant-and-agent, once it is on M-Pesa.
    expect(count(GUIDE, /actor: \{ en: 'You'/g)).toBe(2);
    expect(count(GUIDE, /actor: \{ en: 'You and the agent'/g)).toBe(2);
    expect(count(GUIDE, /actor: \{ en: 'You, on M-Pesa'/g)).toBe(1);
  });

  it('promises nothing: no number, no price, no lifecycle value, no outcome', () => {
    // Every figure an anxious claimant might latch onto — a countdown, an
    // amount, a fee — still comes from the server DTO, never from copy.
    expect(count(GUIDE, /\d/)).toBe(0);
    expect(GUIDE).not.toMatch(/KES|shilling|amount|price|fee is/i);
    for (const identifier of [
      'pending_payment',
      'escrow_held',
      'payment_window_expired',
      'awaiting_agent_confirmation',
      'handover_success',
      'confidence_gate',
      'tier1_security',
      'tier2_otp',
      'tier3_id',
      'released',
      'refunded',
      'refunding',
      'disputed',
      'rejected',
    ]) {
      expect(GUIDE, `${identifier} must not appear in guidance copy`).not.toContain(identifier);
    }
    expect(GUIDE).not.toMatch(/will be (?:refunded|released|approved)|guarantee/i);
  });
});

// -----------------------------------------------------------------------------
// One dominant action per stage, on the shared Button
// -----------------------------------------------------------------------------

describe('UX-09 gives every stage one dominant action, on the shared Button', () => {
  it('puts every journey action on the shared Button, and names its variant', () => {
    expect(count(OWNER_VIEW, /<Button/g)).toBe(12);
    // Every Button names a variant explicitly — no accidental default, and no
    // stage left to pick its own emphasis.
    expect(count(OWNER_VIEW, /variant="/g)).toBe(12);
    // Ten hand-built <button> elements remain in the whole file; the four the
    // journey keeps are enumerated below, control by control.
    expect(count(OWNER_VIEW, /<button/g)).toBe(10);
    expect(count(OWNER_VIEW, /<button/g) + count(OWNER_VIEW, /<Button/g)).toBe(22);
  });

  it('gives each action stage exactly one dominant control', () => {
    for (const s of ACTION_STAGES) {
      expect(s.src, `${s.name} must use the shared Button`).toContain('<Button');
      expect(
        count(s.src, /variant="(?:accent|primary)"/g),
        `${s.name} must have exactly one dominant action`,
      ).toBe(1);
      expect(s.src).toContain(`variant="${s.dominant}"`);
      expect(s.src).toContain(`size="${s.size}"`);
      // Everything else on the stage is a supporting action at `secondary`, so
      // no second control competes with the dominant one for the claimant's eye.
      const variants = Array.from(s.src.matchAll(/variant="([a-z]+)"/g)).map((m) => m[1]);
      expect(variants.filter((v) => v === 'secondary')).toHaveLength(variants.length - 1);
    }
  });

  it('labels each dominant action in both languages', () => {
    expect(confidenceGate).toContain("{lang === 'en' ? 'Proceed to Claim' : 'Endelea na Dai'}");
    expect(tier2Otp).toContain("{lang === 'en' ? 'Verify code' : 'Thibitisha msimbo'}");
    expect(payment).toContain("{lang === 'en' ? 'Send M-Pesa STK Push' : 'Tuma M-Pesa STK Push'}");
    expect(paymentPolling).toContain(
      "{lang === 'en' ? 'Check payment status' : 'Angalia hali ya malipo'}",
    );
  });

  it('keeps exactly four hand-built controls in the journey, each one deliberate', () => {
    // A legal link is not a Button, a test affordance is not a brand action,
    // and one rating element is not five buttons. Everything else moved.
    expect(count(confidenceGate, /<button/g)).toBe(2);
    expect(confidenceGate).toContain("(window as any).setView?.('terms')");
    expect(confidenceGate).toContain("(window as any).setView?.('privacy')");
    expect(paymentPolling).toContain('{testModeEnabled && (');
    expect(count(paymentPolling, /<button/g)).toBe(1);
    expect(handover).toContain('[1, 2, 3, 4, 5].map((star) => (');
    expect(count(handover, /<button/g)).toBe(1);
    for (const [name, src] of [
      ['the delegated Tier-1 form', tier1],
      ['the SMS code stage', tier2Otp],
      ['the pay stage', payment],
      ['the waiting state', awaiting],
      ['the expired state', expired],
    ] as Array<[string, string]>) {
      expect(count(src, /<button/g), `${name} must not hand-build a control`).toBe(0);
    }
  });

  it('leaves the terminal stage one low-emphasis exit, and no repair', () => {
    // The window is closed, the item is unlocked and the strike is recorded, so
    // the only thing left is to leave — the lowest-emphasis shared control, on
    // purpose, so nothing here reads as "try again".
    expect(expired).toContain('<Button');
    expect(expired).toContain('variant="ghost"');
    expect(expired).toContain('size="md"');
    expect(count(expired, /variant="(?:accent|primary|secondary|inverse)"/g)).toBe(0);
    expect(expired).toContain("{lang === 'en' ? 'Back to Search' : 'Rudi kwenye Kutafuta'}");
  });
});

// -----------------------------------------------------------------------------
// The waiting stage has nothing to press, on purpose
// -----------------------------------------------------------------------------

describe("UX-09 leaves the waiting stage actionless, because the move is the agent's", () => {
  it('offers the claimant no control while the agent confirms in person', () => {
    // There is genuinely nothing to click: the agent confirms in person, and
    // the stage says so while the hub details stay with PickupDetailsPanel —
    // the component that already owned that request.
    expect(count(awaiting, /<Button|<button/g)).toBe(0);
    expect(awaiting).toContain('Waiting for the agent to visually verify');
    expect(awaiting).toContain('<PickupDetailsPanel');
    expect(awaiting).toContain('onRetry={retryPickupDetails}');
  });
});

// -----------------------------------------------------------------------------
// The rail is the ONE shared progress rail
// -----------------------------------------------------------------------------

describe('UX-09 uses the ONE shared progress rail', () => {
  it('imports the shared Stepper and renders it once', () => {
    expect(count(OWNER_VIEW, /from '\.\/ui\/Stepper'/g)).toBe(1);
    expect(count(OWNER_VIEW, /<Stepper/g)).toBe(1);
    // No second rail was hand-rolled beside it.
    expect(count(OWNER_VIEW, /aria-current/g)).toBe(0);
  });

  it('feeds it the five stages, the one index and a bilingual label', () => {
    expect(RAIL_AND_GUIDE).toContain(
      "steps={CLAIM_STEPS.map((s) => ({ label: lang === 'en' ? s.en : s.sw }))}",
    );
    expect(RAIL_AND_GUIDE).toContain('currentStep={claimStageIndex}');
    expect(RAIL_AND_GUIDE).toContain(
      "label={lang === 'en' ? 'Claim progress' : 'Maendeleo ya dai'}",
    );
    expect(count(OWNER_VIEW, /CLAIM_STEPS\.map/g)).toBe(1);
  });

  it('adds no progress vocabulary of its own', () => {
    // The rail owns "Step n of m", the connectors and aria-current="step"; this
    // file must not grow a parallel copy of any of them.
    expect(count(OWNER_VIEW, /CLAIM_STEPS/g)).toBe(4);
    expect(OWNER_VIEW).not.toMatch(/aria-current|aria-valuenow|role="progressbar"/);
  });
});

// -----------------------------------------------------------------------------
// The rail and the guide are copy, not logic
// -----------------------------------------------------------------------------

describe('UX-09 answers "what now / who next" without touching the claim itself', () => {
  it('leaves the status vocabulary where it was, and still displays it twice', () => {
    expect(OWNER_VIEW).toContain("import { getClaimStatusDisplay } from './claimStatus';");
    expect(count(OWNER_VIEW, /getClaimStatusDisplay\(/g)).toBe(2);
    // The guide never restates a status label: statuses live in the one shared
    // map, and the guide talks about the stage, not about the status code.
    expect(count(GUIDE, /status/i)).toBe(0);
    expect(count(GUIDE, /getClaimStatusDisplay/g)).toBe(0);
  });

  it('adds no state, no effect, no timer and no request to the journey', () => {
    // The rail and the guide are pure functions of state the component already
    // had: they add no hook, no timer, no storage and no network call.
    const impure = [
      /useState/,
      /useEffect/,
      /useRef/,
      /useCallback/,
      /setInterval/,
      /setTimeout/,
      /fetch\(/,
      /await /,
      /localStorage/,
      /sessionStorage/,
    ];
    for (const pattern of impure) {
      expect(count(RAIL_AND_GUIDE, pattern), `RAIL_AND_GUIDE must not use ${pattern}`).toBe(0);
    }
    // The only thing it reads is the derived index and the typed tables.
    expect(RAIL_AND_GUIDE).toContain('claimStageIndex');
    expect(RAIL_AND_GUIDE).toContain('claimStageGuide');
    // And the whole component still declares exactly the state it declared
    // before: the UX-09 diff adds zero `useState` calls.
    expect(count(OWNER_VIEW, /useState[<(]/g)).toBe(37);
  });
});

// -----------------------------------------------------------------------------
// The new surface speaks the current vocabulary
// -----------------------------------------------------------------------------

describe('UX-09 puts the new surface on the tokens, not on literals', () => {
  it('dresses the rail and the guide in ladder type, radius and colour', () => {
    expect(RAIL_AND_GUIDE).toContain('rounded-standard');
    expect(RAIL_AND_GUIDE).toContain('border-line-subtle');
    expect(RAIL_AND_GUIDE).toContain('bg-canvas-muted');
    expect(RAIL_AND_GUIDE).toContain('text-caption');
    expect(RAIL_AND_GUIDE).toContain('text-small');
    expect(RAIL_AND_GUIDE).toContain('text-ink-muted');
    expect(hasToken(RAIL_AND_GUIDE, 'text-ink')).toBe(true);
    // The two rungs it uses are the ones the shared Stepper already uses, so the
    // card and the rail beside it cannot drift apart.
    expect(INDEX_CSS).toMatch(/--text-caption:\s*0\.75rem/);
    expect(INDEX_CSS).toMatch(/--text-small:\s*0\.8125rem/);
  });

  it('carries none of the pre-UX-01 literals on the new surface', () => {
    const offences = LEGACY_LITERALS.filter((token) => hasToken(RAIL_AND_GUIDE, token));
    expect(offences).toEqual([]);
  });

  it('adds exactly one panel, on the panel radius rung', () => {
    // The guide card is the single `rounded-standard` in the file, and UX-09
    // introduces no rounded-2xl / rounded-xl beside the ones that predate it.
    expect(count(OWNER_VIEW, /rounded-standard/g)).toBe(1);
    expect(count(OWNER_VIEW, /rounded-2xl/g)).toBe(44);
    expect(count(OWNER_VIEW, /rounded-xl/g)).toBe(20);
    expect(count(OWNER_VIEW, /rounded-small/g)).toBe(1);
    // No panel elevation was invented for it, either.
    expect(hasToken(RAIL_AND_GUIDE, 'shadow-sm')).toBe(false);
    expect(hasToken(RAIL_AND_GUIDE, 'shadow-md')).toBe(false);
  });

  it('leaves the documented residual exactly where it was', () => {
    // The dark thumbnail chip keeps its stone-* shades and the off-ladder
    // arbitrary size, and the file keeps its 18 bg-white panels: the design
    // system records those as residual rather than pretending they are gone,
    // and UX-09 does not quietly change the count either way.
    expect(count(OWNER_VIEW, /stone-/g)).toBe(9);
    expect(count(OWNER_VIEW, /text-\[/g)).toBe(1);
    expect(count(OWNER_VIEW, /bg-white/g)).toBe(18);
  });

  it('declares the current token names, and keeps focus on the shared ring', () => {
    for (const declaration of [
      '--color-canvas-muted',
      '--color-ink',
      '--color-ink-muted',
      '--color-line-subtle',
      '--radius-standard',
      '--radius-small',
    ]) {
      expect(INDEX_CSS, `index.css must declare ${declaration}`).toContain(declaration);
    }
    // UX-09 adds no local focus ring: the shared primitives own focus, so the
    // file still has zero of either suppression or hand-rolled ring.
    expect(count(OWNER_VIEW, /focus:outline-none/g)).toBe(0);
    expect(count(OWNER_VIEW, /focus-visible:ring/g)).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// The corrected Kiswahili, and the record of the batch
// -----------------------------------------------------------------------------

describe('UX-09 corrects the misspelled Kiswahili and records the batch', () => {
  it('says "Weka nambari" — "Wea" is not a word', () => {
    // The three payer-phone strings on the pay stage, all inside the one stage
    // the batch rewrote.
    expect(count(OWNER_VIEW, /Weka nambari/g)).toBe(3);
    expect(count(payment, /Weka nambari/g)).toBe(3);
    expect(OWNER_VIEW_TSX).not.toContain('Wea nambari');
    // Not one occurrence of the typo survives anywhere in the product source.
    expect(count(read('src/components/OwnerView.tsx'), /Wea /g)).toBe(0);
  });

  it('records OwnerView as migrated by this batch, and names what it left behind', () => {
    const ownerRow = DESIGN_SYSTEM.split(/\r?\n/).find((line) => line.startsWith('| OwnerView '));
    expect(ownerRow, 'the design system must keep an OwnerView row').toBeTruthy();
    expect(ownerRow as string).toContain('MIGRATED in UX-09 (customer claim / recovery journey)');
    expect(ownerRow as string).toContain('search → confidence gate → OTP → payment → handover');
    expect(ownerRow as string).toContain('one dominant action per stage');
    expect(ownerRow as string).toContain('the `Stepper` rail');
    // The residual is named rather than hidden — the Track-claim modal's own
    // button and the two stone-* shades on the dark thumbnail chip.
    expect(ownerRow as string).toContain("residual: the Track-claim modal's hand-built button");
    expect(ownerRow as string).toContain('the two `stone-*` shades');
    // Exactly one row claims UX-09, so the record cannot drift into two.
    expect(count(DESIGN_SYSTEM, /MIGRATED in UX-09/g)).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// Bilingual by construction, with no new i18n mechanism
// -----------------------------------------------------------------------------

describe('UX-09 keeps every new string bilingual, with no new i18n mechanism', () => {
  it('types the guide as a bilingual table, exactly like CLAIM_STEPS', () => {
    // Two typed tables, one shape: `{ en; sw }` rows, English first.
    expect(count(OWNER_VIEW_TSX, /const CLAIM_STEPS: \{ en: string; sw: string \}\[\]/g)).toBe(1);
    expect(count(OWNER_VIEW_TSX, /const CLAIM_STAGE_GUIDE: \{/g)).toBe(1);
    // One typed shape, declared once for CLAIM_STEPS and three times for the
    // guide's three columns (title / what / actor) — every one English-first.
    expect(count(OWNER_VIEW_TSX, /^\s+(?:title|what|actor): \{ en: string; sw: string \};\r?$/gm)).toBe(3);
    expect(count(OWNER_VIEW_TSX, /en: string; sw: string/g)).toBe(5);
  });

  it('answers "what happens now" and "who acts next" in both languages', () => {
    expect(GUIDE).toContain("what: {");
    expect(GUIDE).toContain("actor: {");
    expect(GUIDE).toContain(
      "en: 'Answer the security questions, then enter the code we send to your verified email address.',",
    );
    expect(GUIDE).toContain(
      "sw: 'Jibu maswali ya usalama, kisha weka msimbo tutakaotuma kwenye barua pepe yako iliyothibitishwa.',",
    );
    expect(count(GUIDE, /\{ en: 'You', sw: 'Wewe' \}/g)).toBe(2);
    expect(count(GUIDE, /actor: \{ en: 'You and the agent', sw: 'Wewe na wakala' \}/g)).toBe(2);
    expect(GUIDE).toContain("actor: { en: 'You, on M-Pesa', sw: 'Wewe, kwenye M-Pesa' }");
  });

  it('adds no translation key, dictionary or language mechanism', () => {
    // The file still reads its copy exactly the way it always did: one lookup
    // for the pre-existing `t` object, and inline ternaries for one-offs.
    expect(OWNER_VIEW).toContain('const t = translations[lang];');
    expect(count(OWNER_VIEW, /translations\[lang\]/g)).toBe(1);
    expect(count(OWNER_VIEW, /useTranslation|i18next|createContext/g)).toBe(0);
    // And the new copy is declared in the view that renders it, not smuggled
    // into the shared type or translation surface.
    expect(count(OWNER_VIEW_TSX, /Confirm the item is yours/g)).toBe(1);
    expect(TYPES).not.toContain('Confirm the item is yours');
    expect(TYPES).not.toContain('Who acts next');
  });
});
