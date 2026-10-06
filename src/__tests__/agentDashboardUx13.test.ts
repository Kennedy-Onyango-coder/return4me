import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// UX-13 — THE AUTHENTICATED AGENT WORKSPACE (Agent dashboard / Agent Hub)
// =============================================================================
// UX-11 refined AGENT SIGN IN; UX-12 refined AGENT REGISTRATION. UX-13 owns the
// third surface of the same authenticated area: what a signed-in Agent sees
// once they are actually working — the operational workspace that has to answer
// "what do I need to do?" without turning into a generic SaaS dashboard.
//
// UX-13 IS PRESENTATION ONLY. It adds a workspace header, a three-tile
// operational summary derived from the two EXISTING queues, deliberate empty
// states on the shared EmptyState, a reserved-layout loading skeleton, and
// appearance-token surfaces. It deliberately changes none of:
//   * the auth/session model — AgentView still receives the same `token`;
//   * the operational API — the same six endpoints with the same payloads;
//   * the Agent state model — the same two queues and the same claim statuses
//     the queue endpoint already attaches (no new business state is invented);
//   * Agent permissions, ownership scoping, custody rules or claim transitions;
//   * UX-11's sign-in card or UX-12's five-step registration panel.
//
// This repository has no jsdom/React harness, so — exactly as the UX-06 … UX-12
// and Agent Hub suites do — the contract is asserted against the shipped source
// with comments stripped, so prose that DESCRIBES a guarantee can never satisfy
// an assertion ABOUT it. No snapshots and no line-number assertions are used.

const root = path.resolve(import.meta.dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(root, rel), 'utf8');
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const HUB_RAW = read('src/components/agent/AgentHub.tsx');
const HUB = stripComments(HUB_RAW);
const VIEW_RAW = read('src/components/AgentView.tsx');
const VIEW = stripComments(VIEW_RAW);
const VERIFICATION = stripComments(read('src/components/agent/AgentVerificationPanel.tsx'));
const REJECTION = stripComments(read('src/components/agent/AgentRejectionPanel.tsx'));
const OPS = stripComments(read('src/hooks/useAgentOperations.ts'));
const AGENT_API = read('src/services/agentApi.ts');
const TYPES = read('src/types.ts');
const DESIGN_SYSTEM = read('docs/design-system.md');

const count = (src: string, needle: string | RegExp) => src.split(needle).length - 1;
const at = (src: string, needle: string) => src.indexOf(needle);

/** 9/10/11px are below the UX-01 floor and must never be visible UI. */
const offLadderType = (src: string) => src.match(/text-\[(?:9|10|11)px\]/g) ?? [];

/**
 * Light-mode literals the workspace may not reintroduce. The negative
 * lookaheads keep the deliberate brand overlays (`bg-white/10` on the green
 * partner banner) out of the net — only a real off-token SURFACE trips it.
 */
const LEGACY_SURFACE = /bg-white(?![/\w-])|rounded-(?:xl|2xl|3xl)(?![\w-])|shadow-(?:sm|md|lg)(?![\w-])/;

/** Every visible string UX-13 introduces, in both bundles. */
const NEW_KEYS = [
  'agentWorkspaceEyebrow',
  'agentWorkspaceTitle',
  'agentWorkspaceIntro',
  'agentNeedsAttention',
  'agentNeedsAttentionHint',
  'agentInCustody',
  'agentInCustodyHint',
  'agentWaitingOnOwner',
  'agentWaitingOnOwnerHint',
  'agentDropoffQueueEmptyExplain',
  'agentHandoverQueueEmptyExplain',
];

// -----------------------------------------------------------------------------
// Workspace header + operational summary
// -----------------------------------------------------------------------------

describe('UX-13 — workspace header and operational summary', () => {
  it('opens with a workspace header that adds context, not identity', () => {
    for (const key of ['agentWorkspaceEyebrow', 'agentWorkspaceTitle', 'agentWorkspaceIntro']) {
      expect(HUB).toContain(`t.${key}`);
    }
    // One page title, on the UX-01 ladder, in the semantic token colour.
    expect(HUB).toMatch(
      /<h1 className="text-section font-extrabold[^"]*text-\[var\(--appearance-text-primary\)\]">/,
    );
    // It repeats no signed-in identity — DashboardShell's header owns that.
    const header = HUB.slice(at(HUB, '<h1 className="text-section'), at(HUB, '{t.agentNeedsAttention}'));
    expect(header.length).toBeGreaterThan(0);
    expect(header).not.toContain('agentProfile.business_name');
    expect(header).not.toContain('mpesa_till_or_paybill');
  });

  it('answers "what needs me?" first, from the two real queues only', () => {
    expect(count(HUB, '<StatCard')).toBe(3);
    expect(HUB).toContain('value={actionQueueCount}');
    expect(HUB).toContain('value={props.holdingPickups.length}');
    expect(HUB).toContain('value={waitingOnOwnerCount}');
    // Every category is derived from the queues this Hub already renders...
    expect(HUB).toContain('props.expectedDropoffs.length +');
    // ...and only from claim states the queue endpoint actually attaches.
    const derived = [...HUB.matchAll(/countClaimsInStatus\('([a-z_]+)'\)/g)].map((m) => m[1]).sort();
    expect(derived).toEqual(['awaiting_agent_confirmation', 'escrow_held', 'pending_payment']);
  });

  it('manufactures no statistic: no new state, memo, fetch or invented counter', () => {
    expect(HUB).not.toMatch(/use(?:State|Effect|Memo|Reducer|Ref|Callback|Context)\s*\(/);
    expect(HUB).not.toMatch(/fetch\s*\(|\bagentApi\b|useAgentOperations/);
    expect(HUB).not.toMatch(/dropoffCount|pickupCount|queueCount|itemCount|totalCount/);
    // The counts are render-time derivations; the hook owns no such state.
    expect(OPS).not.toContain('actionQueueCount');
    expect(OPS).not.toContain('waitingOnOwnerCount');
  });

  it('adds no fabricated activity feed or freshness claim', () => {
    expect(HUB).not.toMatch(/lastUpdated|last_updated|activityFeed|recentActivity|As of|as of/);
    expect(HUB).not.toMatch(/setInterval\s*\(|setTimeout\s*\(/);
  });
});

// -----------------------------------------------------------------------------
// The action queue
// -----------------------------------------------------------------------------

describe('UX-13 — the action queue', () => {
  it('keeps the operational work ahead of the identity/earnings block', () => {
    const receive = at(HUB, 't.expectedDropoffs}');
    const release = at(HUB, 't.holdingPickups}');
    const releaseList = at(HUB, 'props.holdingPickups.map');
    expect(receive).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(receive);
    // Identity and compensation stay secondary, exactly as the queue-legibility
    // batch established: they are not what the agent came here to do.
    expect(at(HUB, 'props.agentProfile.business_name')).toBeGreaterThan(releaseList);
    expect(at(HUB, 'props.agentEarnings.totalEarned')).toBeGreaterThan(releaseList);
  });

  it('keeps one real next-step control per item, from the shared Button', () => {
    expect(HUB).toContain("id={panelTriggerId(item.id, 'verify')}");
    expect(HUB).toContain("id={panelTriggerId(item.id, 'reject')}");
    expect(HUB).toContain('props.openVerificationPanel(item)');
    expect(HUB).toContain('handleConfirmViewing(item.associatedClaim.id)');
    expect(HUB).toContain('handleConfirmHandover(item.associatedClaim.id)');
    // Both held-item actions moved onto the shared primitive rather than
    // hand-rolled buttons carrying local colours and a local focus ring.
    expect(HUB).toMatch(/<Button[\s\S]{0,400}handleConfirmViewing\(item\.associatedClaim\.id\)/);
    expect(HUB).toMatch(/<Button[\s\S]{0,400}handleConfirmHandover\(item\.associatedClaim\.id\)/);
  });

  it('keeps the per-item busy identity and the per-queue counts', () => {
    expect(HUB).toContain('props.processingItemId === id');
    expect(HUB).toContain('t.expectedDropoffs} ({props.expectedDropoffs.length})');
    expect(HUB).toContain('t.holdingPickups} ({props.holdingPickups.length})');
    expect(count(HUB, 'aria-busy={')).toBeGreaterThanOrEqual(4);
    // The queue-role copy the agent already knows is unchanged.
    expect(HUB).toContain('t.agentDropoffQueueRole');
    expect(HUB).toContain('t.agentHandoverQueueRole');
  });

  it('frames custody with the existing business states, never a new one', () => {
    // The held-item card still explains the three real, non-actionable states.
    expect(HUB).toContain('t.agentPendingPaymentNote');
    expect(HUB).toContain('t.agentNoClaimInfoNote');
    expect(HUB).toContain("item.associatedClaim?.status === 'disputed'");
    expect(HUB).toContain("item.associatedClaim?.status === 'released'");
  });
});

// -----------------------------------------------------------------------------
// Empty, loading and error states
// -----------------------------------------------------------------------------

describe('UX-13 — empty, loading and error states', () => {
  it('gives both queues a deliberate empty state on the shared primitive', () => {
    expect(count(HUB, '<EmptyState')).toBe(2);
    expect(HUB).toContain('title={t.agentDropoffsEmpty}');
    expect(HUB).toContain('description={t.agentDropoffQueueEmptyExplain}');
    expect(HUB).toContain('title={t.agentHandoversEmpty}');
    expect(HUB).toContain('description={t.agentHandoverQueueEmptyExplain}');
    // No hand-rolled "nothing here" surface survives.
    expect(HUB).not.toMatch(/Nothing here|No data|N\/A/);
  });

  it('reserves layout while the queue loads instead of a full-screen spinner', () => {
    const loading = VIEW.slice(
      at(VIEW, '{token && queueLoading && !agentProfile && !queueError && ('),
      at(VIEW, '{/* 2b. QUEUE REQUEST FAILURE'),
    );
    expect(loading.length).toBeGreaterThan(0);
    expect(loading).toContain('<Skeleton');
    expect(loading).toContain('shape="card"');
    expect(loading).toContain('role="status"');
    expect(loading).toContain('aria-live="polite"');
    // The pre-answer condition is byte-identical to the one that shipped.
    expect(VIEW).toContain('{token && queueLoading && !agentProfile && !queueError && (');
  });

  it('keeps every failure actionable, and never hides it behind a placeholder', () => {
    expect(HUB).toContain('{props.queueError && (');
    expect(HUB).toContain('{props.operationError && (');
    expect(HUB).toContain('{props.actionSuccessMsg && (');
    expect(HUB).toContain('onClick={props.retryQueue}');
    expect(VIEW).toContain('{token && !queueLoading && queueError && !agentProfile && (');
    expect(VIEW).toContain('onClick={retryQueue}');
    expect(VIEW).toMatch(/role="alert"[^>]*aria-live="assertive"/);
    // No browser dialog was introduced anywhere on the surface.
    for (const src of [HUB, VIEW]) {
      expect(src).not.toMatch(/\bwindow\.(?:alert|confirm|prompt)\s*\(/);
    }
  });

  it('places the operational error where the agent is looking, inside the dialog', () => {
    const dialog = VIEW.slice(at(VIEW, 'pickupCodeModal && ('));
    expect(dialog.length).toBeGreaterThan(0);
    expect(dialog).toContain('{operationError && (');
    expect(dialog).toContain('<p className="text-red-600 text-xs font-semibold">{operationError}</p>');
  });
});

// -----------------------------------------------------------------------------
// Bilingual, appearance and accessibility
// -----------------------------------------------------------------------------

describe('UX-13 — bilingual, appearance and accessibility', () => {
  it('adds every new visible string to BOTH translation bundles', () => {
    for (const key of NEW_KEYS) {
      expect(count(TYPES, `${key}: `), `translation bundle missing ${key}`).toBe(2);
      expect(HUB).toContain(`t.${key}`);
    }
  });

  it('uses the appearance tokens instead of light-mode surface literals', () => {
    for (const token of [
      '--appearance-surface',
      '--appearance-surface-muted',
      '--appearance-border',
      '--appearance-text-primary',
      '--appearance-text-secondary',
      '--appearance-text-muted',
      '--appearance-success',
      '--appearance-warning',
      '--appearance-danger',
    ]) {
      expect(HUB, `missing appearance token ${token}`).toContain(token);
    }
    // Radius and elevation sit on the UX-01 ladders, not on ad-hoc utilities.
    expect(HUB).toContain('rounded-panel');
    expect(HUB).toContain('rounded-standard');
    expect(HUB).toContain('shadow-raised');
    expect(HUB).not.toMatch(LEGACY_SURFACE);
    expect(offLadderType(`${HUB}\n${VIEW}`)).toEqual([]);
  });

  it('keeps the accessibility-critical roles and labels intact', () => {
    // Exactly two assertive alerts: the operational error and the refresh
    // failure. The success banner and the refresh indicator stay polite.
    expect(count(HUB, 'role="alert"')).toBe(2);
    expect(HUB).toContain('aria-live="assertive"');
    expect(HUB).toContain('role="status"');
    expect(HUB).toContain('aria-live="polite"');
    expect(HUB).toContain('aria-label={t.agentItemContextItem}');
    expect(HUB).toContain('focus-visible:ring-2');
    // The verification panel keeps its own live region and focus target.
    expect(VERIFICATION).toContain('role="alert"');
    expect(VERIFICATION).toContain("panelFocusRef(item.id, 'verify')");
    expect(REJECTION).toContain('agentRejectConsequence');
  });

  it('works across the breakpoints without horizontal overflow', () => {
    expect(HUB).toContain('sm:grid-cols-3');
    expect(HUB).toContain('md:grid-cols-2');
    expect(HUB).toContain('flex-wrap');
    expect(HUB).toContain('break-words');
    expect(HUB).toContain('break-all');
    expect(HUB).toContain('overflow-hidden');
    expect(HUB).toContain('h-11');
    expect(HUB).not.toMatch(/overflow-x-auto|w-\[1|min-w-\[8/);
  });
});

// -----------------------------------------------------------------------------
// No regression to UX-11 / UX-12, and the frozen operation contracts
// -----------------------------------------------------------------------------

describe('UX-13 — no regression to UX-11 / UX-12', () => {
  it('leaves the agent sign-in card exactly where UX-11 put it', () => {
    // Section markers are JSX comments, so they are read from the RAW source.
    expect(VIEW_RAW).toContain('{/* 1. AGENT SIGN-IN CARD');
    expect(VIEW_RAW).toContain('{/* 2. QUEUE LOADING');
    expect(count(VIEW, 'aria-pressed=')).toBeGreaterThanOrEqual(2);
    expect(VIEW).toContain("import { Banner, Button, ICON_SIZE, Input } from './ui';");
    expect(VIEW).toContain('<span>{authError}</span>');
  });

  it('leaves the UX-12 guided application intact', () => {
    expect(VIEW).toContain('const AGENT_REGISTRATION_STEPS = [');
    // Five step gates, each rendering exactly one step's controls.
    expect(count(VIEW, 'registrationStep === ')).toBeGreaterThanOrEqual(5);
    expect(VIEW).toContain('id="agent-phone"');
    expect(VIEW_RAW).toContain("import Stepper from './ui/Stepper';");
    expect(VIEW_RAW).toContain("import Select from './ui/Select';");
  });
});

describe('UX-13 — the Agent operation/API contracts are untouched', () => {
  it('keeps the same six agent endpoints', () => {
    for (const endpoint of [
      "'/api/agents/queue'",
      "'/api/agents/verify-item'",
      "'/api/agents/confirm-dropoff'",
      "'/api/agents/reject-dropoff'",
      '/api/agents/claims/${encodeURIComponent(claimId)}/confirm-viewing',
      "'/api/agents/confirm-handover'",
    ]) {
      expect(AGENT_API).toContain(endpoint);
    }
    expect(count(AGENT_API, 'request<')).toBeGreaterThanOrEqual(6);
    expect(AGENT_API).not.toContain('payments');
  });

  it('leaves the operations hook as the single owner of every request', () => {
    expect(OPS).toContain('agentApi.getQueue(token)');
    expect(OPS).toContain('useEffect(() => { void fetchQueues(); }, [token]);');
    expect(OPS).not.toMatch(/setInterval\s*\(|setTimeout\s*\(/);
  });
});

describe('UX-13 — the design-system reference records the batch', () => {
  it('documents the migrated workspace without disturbing UX-11 or UX-12', () => {
    expect(count(DESIGN_SYSTEM, /MIGRATED in UX-13/g)).toBeGreaterThanOrEqual(1);
    const row = DESIGN_SYSTEM.split('\n').find((line) => line.startsWith('| Agent dashboard'));
    expect(row, 'the design system must record the agent workspace').toBeDefined();
    expect(row as string).toContain('MIGRATED in UX-13');
    expect(count(DESIGN_SYSTEM, /MIGRATED in UX-11/g)).toBe(2);
    expect(count(DESIGN_SYSTEM, /MIGRATED in UX-12/g)).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// Mutation checks — the guards above must FAIL when UX-13 is undone.
// -----------------------------------------------------------------------------

describe('UX-13 guards are live, not decorative (mutation checks)', () => {
  it('detects a reintroduced light-mode surface literal', () => {
    expect(LEGACY_SURFACE.test(HUB)).toBe(false);
    expect(LEGACY_SURFACE.test(`${HUB}\n<div className="bg-white rounded-2xl shadow-sm" />`)).toBe(true);
  });

  it('detects a reintroduced off-ladder type size', () => {
    expect(offLadderType(HUB)).toEqual([]);
    expect(offLadderType(`${HUB}\n<p className="text-[11px]">off-ladder</p>`)).not.toEqual([]);
  });

  it('detects a lost workspace summary', () => {
    expect(count(HUB, '<StatCard')).toBe(3);
    expect(count(`${HUB}\n<StatCard value={1} />`, '<StatCard')).toBe(4);
  });

  it('detects a lost empty state', () => {
    expect(count(HUB, '<EmptyState')).toBe(2);
    expect(count(HUB.replace('<EmptyState', '<div'), '<EmptyState')).toBe(1);
  });

  it('detects a lost loading skeleton', () => {
    expect(count(VIEW, '<Skeleton')).toBeGreaterThanOrEqual(5);
    expect(count(VIEW.replace(/<Skeleton/g, '<div'), '<Skeleton')).toBe(0);
  });

  it('detects a stripped translation key', () => {
    expect(count(TYPES, 'agentWorkspaceTitle: ')).toBe(2);
    expect(
      count(TYPES.replace(/agentWorkspaceTitle: /g, 'agentWorkspaceTitleRenamed: '), 'agentWorkspaceTitle: '),
    ).toBe(0);
  });

  it('detects a fabricated state value entered into the summary', () => {
    expect(HUB).not.toMatch(/countClaimsInStatus\('in_transit'\)/);
    expect(HUB).not.toContain('englishOnlyFallback');
  });
});
