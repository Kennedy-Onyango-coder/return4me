import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { agentClaimBadge } from '../components/claimStatus';
import { agentClaimBadge as agentClaimBadgeViaView } from '../components/AgentView';
import { getClaimStatusDisplay } from '../components/claimStatus';

// ===========================================================================
// PHASE 16.1 BATCH 4 — AGENT HUB STRUCTURAL EXTRACTION CONTRACT
// ===========================================================================
// App -> AgentView -> AgentHub -> shared utilities. No reverse edge
// AgentHub -> AgentView. `expectedDropoffs` (drop-offs) is canonical;
// `expectedDropups` was a report typo and must not become a prop.
// Batch 3 behaviour (agentClaimBadge truthfulness) is preserved via the
// neutral ./claimStatus home, re-exported by AgentView for compatibility.
//
// Two source views are used deliberately:
//   * RAW      — for the Hub's own section markers, which are JSX comments
//                ({/* Drop-offs Queue */}); stripping comments would erase the
//                very evidence the single-copy audit looks for.
//   * STRIPPED — for code assertions, because this batch's explanatory comments
//                name the identifiers being asserted about.
// No line-number assertions are used anywhere.
// ===========================================================================

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const AGENTVIEW_RAW = read('src/components/AgentView.tsx');
const AGENTHUB_RAW = read('src/components/agent/AgentHub.tsx');
const AGENT_OPERATIONS = stripComments(read('src/hooks/useAgentOperations.ts'));
const AGENTVIEW = stripComments(AGENTVIEW_RAW);
const AGENTHUB = stripComments(AGENTHUB_RAW);
/** The composed surface an agent actually sees — the Hub split across two files. */
// BATCH B: the verification and rejection panel markup moved into two
// presentation-only children. Behavioural contracts that assert on rendered
// markup must read the COMPOSED Hub surface (parent + both children), exactly
// as Step 2 composed AgentView + useAgentOperations.
const AGENT_PANELS = stripComments(
  read('src/components/agent/AgentVerificationPanel.tsx') +
  '\n' +
  read('src/components/agent/AgentRejectionPanel.tsx')
);
/** Parent + both Batch B children: the markup an agent actually sees. */
const HUB_RENDER = `${AGENTHUB}\n${AGENT_PANELS}`;
const HUB_SURFACE = `${AGENTVIEW}\n${HUB_RENDER}`;

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
/** Every Hub section header, in render order. */
const HUB_SECTION_MARKERS = [
  '{/* Hub Profile Banner */}',
  '{/* Total Earnings Card',
  '{/* Processing Queues */}',
  '{/* Drop-offs Queue */}',
  '{/* Handover / Pickups Queue */}',
];
const staticIds = (source: string) => [...source.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);

describe('B4-structure: AgentView owns state, AgentHub renders the Hub once', () => {
  it('AgentView imports the extracted AgentHub', () => {
    expect(AGENTVIEW).toContain("import AgentHub from './agent/AgentHub'");
  });

  it('AgentView renders exactly one <AgentHub invocation, inside the active-agent branch', () => {
    expect(count(AGENTVIEW, '<AgentHub')).toBe(1);
    const branch = AGENTVIEW.indexOf("{token && agentStatus === 'active' && agentProfile && (");
    expect(branch).toBeGreaterThan(-1);
    expect(AGENTVIEW.indexOf('<AgentHub')).toBeGreaterThan(branch);
  });

  it('each Hub section exists exactly once, and only in AgentHub', () => {
    for (const marker of HUB_SECTION_MARKERS) {
      expect(count(AGENTHUB_RAW, marker), `AgentHub is missing ${marker}`).toBe(1);
      expect(count(AGENTVIEW_RAW, marker), `AgentView still hosts ${marker}`).toBe(0);
    }
    // The single Hub root wrapper moved with it.
    expect(count(AGENTHUB, 'space-y-8 fade-in')).toBe(1);
    expect(count(AGENTVIEW, 'space-y-8 fade-in')).toBe(0);
    // Hub-unique copy cannot exist twice on the composed surface.
    for (const copy of [
      'Hub Handover Golden Rule:',
      'Verified Return4me Partner Point',
      'Total Earned (your commission share)',
    ]) {
      expect(count(HUB_SURFACE, copy), `duplicated copy: ${copy}`).toBe(1);
    }
    expect(count(HUB_SURFACE, 't.agentDropoffsEmpty')).toBe(1);
    expect(count(HUB_SURFACE, 't.agentHandoversEmpty')).toBe(1);
    // The Hub reads its data from props, never from a lingering local.
    expect(AGENTHUB).toContain('props.agentProfile.business_name');
    expect(count(HUB_SURFACE, 'agentProfile.business_name')).toBe(1);
    expect(count(HUB_SURFACE, 'expectedDropoffs.map(')).toBe(1);
    expect(count(HUB_SURFACE, 'holdingPickups.map(')).toBe(1);
  });

  it('Batch B extracted the verification and rejection panels into presentation-only children', () => {
    const readIf = (rel: string) => fs.existsSync(path.resolve(repoRoot, rel)) ? read(rel) : '';
    const ver = readIf('src/components/agent/AgentVerificationPanel.tsx');
    const rej = readIf('src/components/agent/AgentRejectionPanel.tsx');

    // Both children exist and export a default component.
    expect(ver, 'AgentVerificationPanel.tsx must exist').not.toBe('');
    expect(rej, 'AgentRejectionPanel.tsx must exist').not.toBe('');
    expect(ver).toMatch(/export default function AgentVerificationPanel\(/);
    expect(rej).toMatch(/export default function AgentRejectionPanel\(/);

    // The inline panel markup is GONE from the parent, and the parent renders
    // the children instead — a real extraction, not a copy.
    expect(AGENTHUB).not.toContain('bg-brand-beige/60');
    expect(AGENTHUB).not.toContain('bg-red-50/50');
    expect(AGENTHUB).toMatch(/<AgentVerificationPanel/);
    expect(AGENTHUB).toMatch(/<AgentRejectionPanel/);

    // The parent keeps BOTH render gates: extraction must not change when the
    // panels appear.
    expect(AGENTHUB).toMatch(/\{props\.verifyingItemId === item\.id && \(\s*<AgentVerificationPanel/);
    expect(AGENTHUB).toMatch(/\{props\.rejectingItemId === item\.id && \(\s*<AgentRejectionPanel/);
  });

  it('Batch B wires the children explicitly and never via a props spread', () => {
    const verCall = AGENTHUB.slice(AGENTHUB.indexOf('<AgentVerificationPanel'), AGENTHUB.indexOf('/>', AGENTHUB.indexOf('<AgentVerificationPanel')) + 2);
    const rejCall = AGENTHUB.slice(AGENTHUB.indexOf('<AgentRejectionPanel'), AGENTHUB.indexOf('/>', AGENTHUB.indexOf('<AgentRejectionPanel')) + 2);

    // Explicit wiring, so the boundary stays auditable in source.
    expect(verCall).not.toMatch(/\{\.\.\./);
    expect(rejCall).not.toMatch(/\{\.\.\./);

    // Every verification member the panel actually consumes is passed.
    for (const member of [
      'item', 'lang', 'categories',
      'verifyCategoryId', 'setVerifyCategoryId',
      'verifyName', 'setVerifyName',
      'verifyDocNumber', 'setVerifyDocNumber',
      'verifyDescription', 'setVerifyDescription',
      'verifyFoundArea', 'setVerifyFoundArea',
      'verifyPhysicallyChecked', 'setVerifyPhysicallyChecked',
      'verifyReason', 'setVerifyReason',
      'verifyReasonDetail', 'setVerifyReasonDetail',
      'verifyError', 'setVerifyingItemId',
      'hasCorrections', 'handleSubmitVerification', 'isItemBusy',
    ]) {
      expect(verCall, `AgentVerificationPanel must receive ${member}`).toMatch(new RegExp(`\\b${member}=`));
    }

    // Every rejection member the panel actually consumes is passed.
    for (const member of [
      'item', 'rejectionReason', 'setRejectionReason',
      'rejectionCustomText', 'setRejectionCustomText',
      'setRejectingItemId', 'handleRejectDropoff', 'isItemBusy',
    ]) {
      expect(rejCall, `AgentRejectionPanel must receive ${member}`).toMatch(new RegExp(`\\b${member}=`));
    }
  });

  it('Batch B children own no state, effects, or transport', () => {
    const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const readIf = (rel: string) => fs.existsSync(path.resolve(repoRoot, rel)) ? code(read(rel)) : '';
    for (const rel of [
      'src/components/agent/AgentVerificationPanel.tsx',
      'src/components/agent/AgentRejectionPanel.tsx',
    ]) {
      const src = readIf(rel);
      expect(src, `${rel} must exist`).not.toBe('');
      // Operational ownership must NOT have migrated into a presentation child.
      expect(src, `${rel} must not hold state`).not.toMatch(/\buse(State|Effect|Reducer|Ref|Memo|Callback)\s*\(/);
      expect(src, `${rel} must not call transport`).not.toMatch(/\bfetch\s*\(/);
      expect(src, `${rel} must not import agentApi`).not.toMatch(/agentApi/);
      expect(src, `${rel} must not import the operations hook`).not.toMatch(/useAgentOperations/);
      // …and no child may import the parent, which would be a cycle.
      expect(src, `${rel} must not import AgentHub`).not.toMatch(/from\s+['"][^'"]*AgentHub/);
    }
  });

  it('no element id is duplicated across the composed Hub surface', () => {
    const ids = [...staticIds(AGENTVIEW), ...staticIds(HUB_RENDER)];
    expect(ids.length).toBeGreaterThanOrEqual(20);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    // The verification panel's ids now live only in the Batch B child…
    expect(staticIds(HUB_RENDER)).toContain('agent-verify-exact-place');
    expect(staticIds(AGENTVIEW)).not.toContain('agent-verify-exact-place');
    // …and the auth/form/modal ids stayed in AgentView.
    expect(staticIds(AGENTVIEW)).toContain('agent-phone');
    expect(staticIds(HUB_RENDER)).not.toContain('agent-phone');
  });

  it('AgentHub is presentational: the Agent surface (view + operations hook) owns every hook', () => {
    expect(AGENTHUB).not.toMatch(/use(?:State|Effect|Ref|Callback|Memo|Reducer|Context|LayoutEffect)\(/);
    expect(AGENTHUB).toContain("import React from 'react';");
    // Operational state moved to the feature-local useAgentOperations hook in
    // Step 2; the Hub still receives everything as props.
    expect(AGENT_OPERATIONS).toContain("const [expectedDropoffs, setExpectedDropoffs] = useState<any[]>([]);");
    expect(AGENT_OPERATIONS).toContain("const [holdingPickups, setHoldingPickups] = useState<any[]>([]);");
  });

  it('AgentHub carries no cp1252 round-trip damage (mojibake) in its copy', () => {
    // The extraction wrote this file from a UTF-8 source. A cp1252 round trip
    // turns each UTF-8 multi-byte character into two or three cp1252 glyphs
    // (U+2014 becomes U+00E2 U+20AC U+201D, U+2026 becomes U+00E2 U+20AC U+00A6,
    // U+00D7 becomes U+00C3 U+2014). The pattern below matches exactly those
    // leading/trailing pairs, so single, correct characters never trip it.
    const MOJIBAKE = /[\u00c2\u00c3\u00e2][\u0080-\u00bf\u2018-\u201d\u20ac\u0160\u0152\u0153\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2020\u2021\u2026\u2030\u2039\u203a]/;
    for (const [name, source] of [
      ['AgentHub.tsx', AGENTHUB_RAW],
      ['AgentView.tsx', AGENTVIEW_RAW],
      ['claimStatus.ts', read('src/components/claimStatus.ts')],
    ] as const) {
      expect(MOJIBAKE.test(source), `${name} contains cp1252 mojibake`).toBe(false);
    }
  });
});

describe('B4-structure: dependency direction has no reverse edge', () => {
  it('AgentHub does NOT import AgentView', () => {
    expect(AGENTHUB).not.toContain("from '../AgentView'");
    expect(AGENTHUB).not.toContain('from "../AgentView"');
    expect(AGENTHUB).not.toMatch(/import[^\n]*AgentView/);
  });

  it('AgentHub consumes the neutral shared badge helper', () => {
    expect(AGENTHUB).toContain("from '../claimStatus'");
    expect(AGENTHUB).toContain('agentClaimBadge(');
  });

  it('the neutral module depends on neither view', () => {
    const neutral = read('src/components/claimStatus.ts');
    // The doc comment names the views on purpose (it records the move); the
    // code must not reference them, in an import or anywhere else.
    expect(stripComments(neutral)).not.toContain('AgentView');
    expect(stripComments(neutral)).not.toContain('AgentHub');
    expect(neutral).not.toMatch(/import[\s\S]*?from\s+['"][^'"]*Agent(?:View|Hub)['"]/);
  });

  it('AgentView is the ONE module that imports AgentHub (App keeps its lazy AgentView entry)', () => {
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
          walk(full);
        } else if (/\.tsx?$/.test(entry.name)) {
          const specifier = /from\s+['"]([^'"]*agent\/AgentHub)['"]/;
          if (specifier.test(read(path.relative(repoRoot, full).split(path.sep).join('/')))) {
            importers.push(path.relative(repoRoot, full).split(path.sep).join('/'));
          }
        }
      }
    };
    walk(path.resolve(repoRoot, 'src'));
    expect(importers).toEqual(['src/components/AgentView.tsx']);
    // App mounts the view, not the Hub.
    expect(read('src/App.tsx')).not.toContain('AgentHub');
    expect(read('src/App.tsx')).toContain("lazy(() => import('./components/AgentView'))");
  });
});

describe('B4-structure: expectedDropoffs is the canonical prop name', () => {
  it('AgentHub declares and renders expectedDropoffs', () => {
    expect(AGENTHUB).toContain('expectedDropoffs: any[];');
    expect(AGENTHUB).toContain('props.expectedDropoffs');
    expect(AGENTHUB).toContain('props.expectedDropoffs.map((item) =>');
  });

  it('expectedDropups is not a production prop (report typo only)', () => {
    expect(AGENTHUB).not.toContain('expectedDropups');
    expect(AGENTVIEW).not.toContain('expectedDropups');
    expect(read('src/components/claimStatus.ts')).not.toContain('expectedDropups');
  });

  it('AgentView passes the canonical prop through', () => {
    expect(AGENTVIEW).toContain('expectedDropoffs={expectedDropoffs}');
  });
});

describe('B4-structure: AgentHubProps is fully wired from AgentView', () => {
  /**
   * The prop names declared by the extracted Hub contract.
   *
   * Batch A composed `AgentHubProps` from four domain contracts plus the
   * application-level props, so the contract must be traversed across those
   * interfaces rather than read from one flat block. The INTENT is unchanged:
   * enumerate every prop the Hub actually declares, so the wiring test below
   * can prove none is left unwired.
   */
  const declaredProps = (() => {
    const interfaceBody = (name: string) => {
      const start = AGENTHUB.indexOf(`export interface ${name}`);
      expect(start).toBeGreaterThan(-1);
      return AGENTHUB.slice(start, AGENTHUB.indexOf('\n}', start));
    };
    const bodies = [
      interfaceBody('AgentHubQueueProps'),
      interfaceBody('AgentHubVerificationProps'),
      interfaceBody('AgentHubRejectionProps'),
      interfaceBody('AgentHubFeedbackProps'),
      // The composed contract itself declares only `lang` and `t`; the rest
      // arrive through `extends`. Reading its own body is therefore correct.
      interfaceBody('AgentHubProps'),
    ].join('\n');
    return [...bodies.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*)(\?)?:/gm)].map((m) => ({
      name: m[1],
      optional: Boolean(m[2]),
    }));
  })();

  const invocation = (() => {
    const start = AGENTVIEW.indexOf('<AgentHub');
    return AGENTVIEW.slice(start, AGENTVIEW.indexOf('/>', start) + 2);
  })();

  it('parses the full contract (guards against a vacuous loop)', () => {
    // 46 domain props + `lang` + `t`. The dead `refreshCategories` prop was
    // removed in Batch A, so the contract is one smaller than before.
    expect(declaredProps.length).toBeGreaterThanOrEqual(47);
    for (const required of [
      'lang',
      't',
      'agentProfile',
      'agentEarnings',
      'operationError',
      'queueError',
      'retryQueue',
      'expectedDropoffs',
      'holdingPickups',
      'handleRejectDropoff',
      'handleConfirmHandover',
      'handleConfirmViewing',
      'categories',
    ]) {
      expect(declaredProps.map((p) => p.name)).toContain(required);
    }
    // Batch A removed the only optional prop, so the Hub contract is now
    // entirely required. Grouping must not have silently made anything optional.
    expect(declaredProps.filter((p) => p.optional).map((p) => p.name)).toEqual([]);
    // The dead prop must not reappear through any of the four domains.
    expect(declaredProps.map((p) => p.name)).not.toContain('refreshCategories');
  });

  it('composes AgentHubProps from the four domain contracts plus lang and t', () => {
    // Batch A is PURE PROP GROUPING: the compiler, not a comment, enforces
    // which workflow owns which prop.
    expect(AGENTHUB).toMatch(/export interface AgentHubQueueProps\s*\{/);
    expect(AGENTHUB).toMatch(/export interface AgentHubVerificationProps\s*\{/);
    expect(AGENTHUB).toMatch(/export interface AgentHubRejectionProps\s*\{/);
    expect(AGENTHUB).toMatch(/export interface AgentHubFeedbackProps\s*\{/);
    expect(AGENTHUB).toMatch(
      /export interface AgentHubProps\s*\n?\s*extends AgentHubQueueProps,\s*\n?\s*AgentHubVerificationProps,\s*\n?\s*AgentHubRejectionProps,\s*\n?\s*AgentHubFeedbackProps\s*\{/
    );
    const composed = AGENTHUB.slice(
      AGENTHUB.indexOf('export interface AgentHubProps'),
      AGENTHUB.indexOf('\n}', AGENTHUB.indexOf('export interface AgentHubProps'))
    );
    // The composed contract adds ONLY the application-level props App owns.
    expect(composed).toMatch(/lang: 'en' \| 'sw';/);
    expect(composed).toMatch(/t: any;/);
  });

  it('AgentView passes every declared prop, so no Hub feature is unwired', () => {
    for (const { name } of declaredProps) {
      expect(invocation, `AgentView does not pass ${name}`).toContain(`${name}={`);
    }
    expect(count(invocation, '=')).toBeGreaterThanOrEqual(declaredProps.length);
  });

  it('AgentHubProps keeps `t` loosely typed for the nested verify labels', () => {
    expect(AGENTHUB).toContain('t: any;');
  });

  it('places every expected member in its owning domain contract', () => {
    const block = (name: string) => {
      const start = AGENTHUB.indexOf(`export interface ${name}`);
      expect(start).toBeGreaterThan(-1);
      return AGENTHUB.slice(start, AGENTHUB.indexOf('\n}', start));
    };

    const queue = block('AgentHubQueueProps');
    for (const member of [
      'agentProfile', 'agentEarnings', 'expectedDropoffs', 'holdingPickups',
      'queueError', 'queueLoading', 'retryQueue', 'dropoffCodeInput',
      'setDropoffCodeInput', 'handleLookupDropoff',
    ]) {
      expect(queue, `${member} must be declared on AgentHubQueueProps`).toMatch(new RegExp(`\\b${member}\\b`));
    }

    const verification = block('AgentHubVerificationProps');
    for (const member of [
      'verifyingItemId', 'setVerifyingItemId', 'openVerificationPanel',
      'verifyCategoryId', 'setVerifyCategoryId', 'verifyName', 'setVerifyName',
      'verifyDocNumber', 'setVerifyDocNumber', 'verifyDescription', 'setVerifyDescription',
      'verifyFoundArea', 'setVerifyFoundArea', 'verifyPhysicallyChecked',
      'setVerifyPhysicallyChecked', 'verifyReason', 'setVerifyReason',
      'verifyReasonDetail', 'setVerifyReasonDetail', 'verifyError',
      'hasCorrections', 'handleSubmitVerification', 'categories',
    ]) {
      expect(verification, `${member} must be declared on AgentHubVerificationProps`).toMatch(new RegExp(`\\b${member}\\b`));
    }

    const rejection = block('AgentHubRejectionProps');
    for (const member of [
      'rejectingItemId', 'setRejectingItemId', 'rejectionReason',
      'setRejectionReason', 'rejectionCustomText', 'setRejectionCustomText',
      'handleRejectDropoff',
    ]) {
      expect(rejection, `${member} must be declared on AgentHubRejectionProps`).toMatch(new RegExp(`\\b${member}\\b`));
    }

    const feedback = block('AgentHubFeedbackProps');
    for (const member of [
      'actionSuccessMsg', 'operationError', 'setOperationError',
      'actionProcessing', 'processingItemId', 'handleConfirmViewing',
      'handleConfirmHandover',
    ]) {
      expect(feedback, `${member} must be declared on AgentHubFeedbackProps`).toMatch(new RegExp(`\\b${member}\\b`));
    }
  });

  it('keeps `categories` in verification, not in a generic config group', () => {
    // categories' ONLY consumer in the Hub is the verification category
    // <select>, so it must be declared on the verification contract.
    expect(
      AGENTHUB.slice(
        AGENTHUB.indexOf('export interface AgentHubVerificationProps'),
        AGENTHUB.indexOf('export interface AgentHubRejectionProps')
      )
    ).toMatch(/\bcategories: any\[\];/);
  });

  it('no longer passes the dead refreshCategories prop into AgentHub', () => {
    // It was declared on AgentHubProps and passed at the call site but never
    // read here. Eliminating the crossing is Batch A's only edit to the
    // behavioural surface; useAgentOperations still owns and calls it.
    expect(AGENTVIEW).not.toMatch(/<AgentHub[\s\S]*?refreshCategories=/);
    // ...and it must still exist where operational logic genuinely needs it.
    expect(AGENT_OPERATIONS).toMatch(/refreshCategories\?\.\(\);/);
    expect(AGENTVIEW).toMatch(/useAgentOperations\(\{ token, lang, refreshCategories \}\)/);
  });
});

describe('B4-structure: Batch 3 badge contract preserved via neutral home', () => {
  it('neutral helper keeps Batch 3 wording', () => {
    expect(agentClaimBadge('awaiting_agent_confirmation').label).toBe('Awaiting Verification');
    expect(agentClaimBadge('escrow_held').label).toBe('Escrow Held (Ready)');
    // PHASE 16.1 BATCH 4B-1 (B2) - the no-claim fallback wording changed on
    // purpose: an absent associatedClaim cannot prove that no claim exists, so it
    // now reports the missing information instead of asserting an absence. The
    // two actionable labels above are untouched, and the no-claim badge keeps its
    // neutral (non-payment) styling.
    expect(agentClaimBadge(undefined).label).toBe('No Claim Information');
    expect(agentClaimBadge(null).label).toBe('Hakuna Taarifa ya Dai');
    expect(agentClaimBadge(undefined).label).toBe('Hakuna Taarifa ya Dai');
    expect(agentClaimBadge(undefined).className).toBe('bg-stone-100 text-stone-800');
    expect(agentClaimBadge('disputed').label).toBe(getClaimStatusDisplay('disputed').label);
    expect(agentClaimBadge('released').label).toBe(getClaimStatusDisplay('released').label);
  });

  it('AgentView re-export matches the neutral helper', () => {
    expect(agentClaimBadgeViaView('disputed')).toEqual(agentClaimBadge('disputed'));
    expect(agentClaimBadgeViaView('released')).toEqual(agentClaimBadge('released'));
  });

  it('Batch 3 reliability suite still targets the live contracts', () => {
    expect(AGENT_OPERATIONS).toContain('const [operationError, setOperationError]');
    expect(AGENT_OPERATIONS).toContain('refreshCategories?.()');
  });

  it('the Batch 3 suite reads the badge from the neutral home, not from a view', () => {
    const batch3 = read('src/__tests__/agentHubReliabilityBatch3.test.ts');
    expect(batch3).toContain("import { agentClaimBadge } from '../components/claimStatus';");
    expect(batch3).not.toContain("agentClaimBadge } from '../components/AgentView'");
  });

  it('the Hub still renders the Batch 3 badge, the alert and the F-4 disclosures', () => {
    // Where the badge is called moved with the markup — the contract did not.
    expect(AGENTHUB).toContain('agentClaimBadge(item.associatedClaim?.status,');
    expect(AGENTHUB).toContain('role="alert"');
    expect(AGENTHUB).toContain('aria-live="assertive"');
    // F-4: the disputed and released states inform, they never offer an action.
    expect(AGENTHUB).toContain("item.associatedClaim?.status === 'disputed'");
    expect(AGENTHUB).toContain("item.associatedClaim?.status === 'released'");
    expect(AGENTHUB).toContain('Do NOT release the item');
    expect(AGENTHUB).toContain('USITOE bidhaa');
    expect(AGENTHUB).toContain('This claim is complete');
    expect(AGENTHUB).toContain('Dai hili limekamilika');
    // The batch 3 busy/aria contract spans both halves of the composed surface.
    expect(count(HUB_SURFACE, 'aria-busy={')).toBeGreaterThanOrEqual(9);
    expect(count(AGENTVIEW, 'aria-busy={')).toBeGreaterThanOrEqual(3);
  });
});
