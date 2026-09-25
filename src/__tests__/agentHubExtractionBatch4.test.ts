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
const AGENTVIEW = stripComments(AGENTVIEW_RAW);
const AGENTHUB = stripComments(AGENTHUB_RAW);
/** The composed surface an agent actually sees — the Hub split across two files. */
const HUB_SURFACE = `${AGENTVIEW}\n${AGENTHUB}`;

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

  it('no element id is duplicated across the composed Hub surface', () => {
    const ids = [...staticIds(AGENTVIEW), ...staticIds(AGENTHUB)];
    expect(ids.length).toBeGreaterThanOrEqual(20);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    // The verification panel's ids now live only in AgentHub…
    expect(staticIds(AGENTHUB)).toContain('agent-verify-exact-place');
    expect(staticIds(AGENTVIEW)).not.toContain('agent-verify-exact-place');
    // …and the auth/form/modal ids stayed in AgentView.
    expect(staticIds(AGENTVIEW)).toContain('agent-phone');
    expect(staticIds(AGENTHUB)).not.toContain('agent-phone');
  });

  it('AgentHub is presentational: AgentView alone owns every hook', () => {
    expect(AGENTHUB).not.toMatch(/use(?:State|Effect|Ref|Callback|Memo|Reducer|Context|LayoutEffect)\(/);
    expect(AGENTHUB).toContain("import React from 'react';");
    expect(AGENTVIEW).toContain("const [expectedDropoffs, setExpectedDropoffs] = useState<any[]>([]);");
    expect(AGENTVIEW).toContain("const [holdingPickups, setHoldingPickups] = useState<any[]>([]);");
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
  /** The prop names declared by the extracted Hub contract. */
  const declaredProps = (() => {
    const start = AGENTHUB.indexOf('export interface AgentHubProps {');
    expect(start).toBeGreaterThan(-1);
    const body = AGENTHUB.slice(start, AGENTHUB.indexOf('\n}', start));
    return [...body.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*)(\?)?:/gm)].map((m) => ({
      name: m[1],
      optional: Boolean(m[2]),
    }));
  })();

  const invocation = (() => {
    const start = AGENTVIEW.indexOf('<AgentHub');
    return AGENTVIEW.slice(start, AGENTVIEW.indexOf('/>', start) + 2);
  })();

  it('parses the full contract (guards against a vacuous loop)', () => {
    expect(declaredProps.length).toBeGreaterThanOrEqual(48);
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
    // Only the categories refresher is optional; everything else is required.
    expect(declaredProps.filter((p) => p.optional).map((p) => p.name)).toEqual(['refreshCategories']);
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
});

describe('B4-structure: Batch 3 badge contract preserved via neutral home', () => {
  it('neutral helper keeps Batch 3 wording', () => {
    expect(agentClaimBadge('awaiting_agent_confirmation', 'en').label).toBe('Awaiting Verification');
    expect(agentClaimBadge('escrow_held', 'en').label).toBe('Escrow Held (Ready)');
    // PHASE 16.1 BATCH 4B-1 (B2) - the no-claim fallback wording changed on
    // purpose: an absent associatedClaim cannot prove that no claim exists, so it
    // now reports the missing information instead of asserting an absence. The
    // two actionable labels above are untouched, and the no-claim badge keeps its
    // neutral (non-payment) styling.
    expect(agentClaimBadge(undefined, 'en').label).toBe('No Claim Information');
    expect(agentClaimBadge(null, 'sw').label).toBe('Hakuna Taarifa ya Dai');
    expect(agentClaimBadge(undefined, 'sw').label).toBe('Hakuna Taarifa ya Dai');
    expect(agentClaimBadge(undefined, 'en').className).toBe('bg-stone-100 text-stone-800');
    expect(agentClaimBadge('disputed', 'en').label).toBe(getClaimStatusDisplay('disputed', 'en').label);
    expect(agentClaimBadge('released', 'en').label).toBe(getClaimStatusDisplay('released', 'en').label);
  });

  it('AgentView re-export matches the neutral helper', () => {
    expect(agentClaimBadgeViaView('disputed', 'en')).toEqual(agentClaimBadge('disputed', 'en'));
    expect(agentClaimBadgeViaView('released', 'sw')).toEqual(agentClaimBadge('released', 'sw'));
  });

  it('Batch 3 reliability suite still targets the live contracts', () => {
    expect(AGENTVIEW).toContain('const [operationError, setOperationError]');
    expect(AGENTVIEW).toContain('refreshCategories?.()');
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
