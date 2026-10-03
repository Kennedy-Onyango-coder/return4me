// AGENTHUB UX MODERNIZATION BATCH 3 — queue legibility and orientation.
//
//   UX-07  the profile/earnings block rendered BEFORE the operational queues, so
//          the agent's actual work was not the visual starting point.
//   UX-08  queue counts.
//   UX-05  a truthful "refreshing" signal for the manual refresh.
//
// IMPORTANT — two of the three findings were found ALREADY SATISFIED on
// inspection (counts at the queue headings, and a `queueLoading`-driven polite
// status line beside the refresh control). This batch therefore re-orders
// presentation for UX-07 and LOCKS the two existing behaviours in with
// regression assertions, rather than adding a second count or a second,
// fabricated freshness indicator.
//
// SOURCE-CONTRACT tests, matching the strategy used by the structural,
// reliability and UX suites in this area. There is no DOM/React harness here,
// so nothing below claims runtime rendering.

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { translations } from '../types';

const root = path.resolve(import.meta.dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.resolve(root, relative), 'utf8');
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const at = (src: string, needle: string) => src.indexOf(needle);

const HUB = read('src/components/agent/AgentHub.tsx');
const HUB_CODE = stripComments(HUB);
const VIEW = read('src/components/AgentView.tsx');
const OPS = read('src/hooks/useAgentOperations.ts');

// Positional anchors, in RENDER order.
const A_SUCCESS = at(HUB_CODE, 'props.actionSuccessMsg && (');
const A_OPERATION_ERROR = at(HUB_CODE, 'props.operationError && (');
const A_QUEUE_ERROR = at(HUB_CODE, 'props.queueError && (');
const A_LOOKUP = at(HUB_CODE, 'props.handleLookupDropoff}');
const A_QUEUES = at(HUB_CODE, 't.agentQueue}');
const A_RECEIVE = at(HUB_CODE, 't.expectedDropoffs}');
const A_RELEASE = at(HUB_CODE, 't.holdingPickups}');
const A_RECEIVE_LIST = at(HUB_CODE, 'props.expectedDropoffs.map');
const A_RELEASE_LIST = at(HUB_CODE, 'props.holdingPickups.map');
const A_PROFILE = at(HUB_CODE, 'props.agentProfile.business_name');
const A_EARNINGS = at(HUB_CODE, 'props.agentEarnings.totalEarned');

describe('AgentHub UX Batch 3 — UX-07 operational queues lead the page', () => {
  it('renders both queues before the profile/earnings block', () => {
    for (const anchor of [A_RECEIVE, A_RELEASE, A_PROFILE, A_EARNINGS]) {
      expect(anchor, 'every section anchor must be locatable').toBeGreaterThan(-1);
    }
    expect(A_PROFILE).toBeGreaterThan(A_RELEASE_LIST);
    expect(A_EARNINGS).toBeGreaterThan(A_RELEASE_LIST);
  });

  it('preserves the established Receive-before-Release workflow order', () => {
    expect(A_RECEIVE).toBeGreaterThan(A_QUEUES);
    expect(A_RELEASE).toBeGreaterThan(A_RECEIVE);
    // The Receive column is rendered whole before the Release column begins, so
    // the two queues are compared heading-to-heading and list-to-list.
    expect(A_RELEASE_LIST).toBeGreaterThan(A_RECEIVE_LIST);
  });

  it('keeps the queues ahead of the drop-off lookup, and the transient banners on top', () => {
    // The lookup helper is supporting information, so it sits ahead of the
    // queues; the three feedback banners stay first so an agent reads a failure
    // or a success immediately, and they render only when set.
    expect(A_LOOKUP).toBeGreaterThan(-1);
    expect(A_QUEUES).toBeGreaterThan(A_LOOKUP);
    expect(A_SUCCESS).toBeLessThan(A_OPERATION_ERROR);
    expect(A_OPERATION_ERROR).toBeLessThan(A_QUEUE_ERROR);
    expect(A_QUEUE_ERROR).toBeLessThan(A_LOOKUP);
  });

  it('reordered presentation only: no section added, removed, or re-authored', () => {
    // Exactly one profile banner and one earnings card remain.
    expect((HUB.match(/props\.agentProfile\.business_name/g) ?? []).length).toBe(1);
    expect((HUB.match(/props\.agentEarnings\.totalEarned/g) ?? []).length).toBe(1);
    expect((HUB.match(/props\.agentEarnings\.completedPayoutsCount/g) ?? []).length).toBe(1);
    // Their data inputs are untouched: no new prop is read to render them.
    expect(HUB_CODE).toContain('props.agentProfile.payout_method_type');
    expect(HUB_CODE).toContain('props.agentProfile.mpesa_till_or_paybill');
    expect(HUB_CODE).toContain('props.agentProfile.location_address');
  });
});

describe('AgentHub UX Batch 3 — UX-08 queue counts', () => {
  it('each queue heading already exposes the count of the array it renders', () => {
    expect(HUB_CODE).toContain('t.expectedDropoffs} ({props.expectedDropoffs.length})');
    expect(HUB_CODE).toContain('t.holdingPickups} ({props.holdingPickups.length})');
  });

  it('each count comes from that queue own rendered array, not a shared one', () => {
    const receiveHeading = HUB_CODE.slice(A_RECEIVE - 40, A_RECEIVE_LIST);
    const releaseHeading = HUB_CODE.slice(A_RELEASE - 40, A_RELEASE_LIST);
    expect(receiveHeading).toContain('props.expectedDropoffs.length');
    expect(receiveHeading).not.toContain('props.holdingPickups.length');
    expect(releaseHeading).toContain('props.holdingPickups.length');
    expect(releaseHeading).not.toContain('props.expectedDropoffs.length');
  });

  it('introduces no independent count state', () => {
    // No derived counter, memo, or reducer is introduced to hold a count.
    expect(HUB_CODE).not.toMatch(/dropoffCount|pickupCount|queueCount|itemCount|totalCount/);
    expect(HUB_CODE).not.toMatch(/useMemo|useReducer/);
    // The counts are digits beside an existing translated label, rendered as a
    // plain parenthesised expression — so no new translation key is needed in
    // either language, and there is exactly one per queue.
    expect((HUB.match(/\(\{props\.(?:expectedDropoffs|holdingPickups)\.length\}\)/g) ?? []).length).toBe(2);
  });

  it('cannot advertise a misleading zero while loading, because the Hub is not rendered then', () => {
    // AgentView owns a dedicated pre-answer loading screen, and the Hub renders
    // only once a profile exists — i.e. after a successful load. So any count on
    // screen is real data, and `queueLoading` inside the Hub is a REFRESH over
    // the last server truth, never an initial load.
    expect(VIEW).toContain('{token && queueLoading && !agentProfile && !queueError && (');
    expect(VIEW).toMatch(/token && agentStatus === 'active' && agentProfile && \(\s*<AgentHub/);
    // A refresh never blanks the queues or drops the count.
    expect(HUB_CODE).not.toMatch(/props\.queueLoading &&\s*\(\s*<div[^>]*>\s*\{props\.agentQueue/);
  });
});

describe('AgentHub UX Batch 3 — UX-05 truthful refreshing signal', () => {
  it('derives the indicator from the existing queueLoading state', () => {
    expect(HUB_CODE).toMatch(
      /props\.queueLoading &&[\s\S]{0,400}role="status"[\s\S]{0,200}aria-live="polite"[\s\S]{0,400}agentQueueRefreshing/,
    );
    // The refresh control is disabled and busy during the same state.
    expect(HUB_CODE).toMatch(
      /onClick=\{props\.retryQueue\}\s*disabled=\{props\.queueLoading\}\s*aria-busy=\{props\.queueLoading\}/,
    );
  });

  it('uses the existing bilingual wording and adds no new key', () => {
    for (const lang of ['en', 'sw'] as const) {
      expect(translations[lang].agentQueueRefreshing).toBeTruthy();
    }
    expect((read('src/types.ts').match(/agentQueueRefreshing:/g) ?? []).length).toBe(2);
  });

  it('invents no timestamp, timer, or polling', () => {
    // No fabricated freshness claim: the Hub shows no "last updated" time.
    expect(HUB_CODE).not.toMatch(/lastUpdated|last_updated|As of|as of/);
    // No animation timer and no background refresh loop.
    expect(HUB_CODE).not.toMatch(/setInterval\(|setTimeout\(/);
    // Refresh stays the single existing callback; no new fetch was added.
    expect((HUB_CODE.match(/props\.retryQueue/g) ?? []).length).toBe(2);
    expect(HUB_CODE).not.toMatch(/agentApi|fetch\(/);
    // The hook still owns the only fetch, keyed to the token alone.
    expect(OPS).toContain('useEffect(() => { void fetchQueues(); }, [token]);');
    expect(OPS).not.toMatch(/setInterval\(/);
  });

  it('does not hide queue content during a refresh, and stays a polite region', () => {
    expect(HUB_CODE.indexOf('agentQueueRefreshing')).toBeLessThan(A_RECEIVE_LIST);
    // A single polite live region, not an assertive alert.
    expect((HUB_CODE.match(/role="alert"/g) ?? []).length).toBe(2);
  });
});

describe('AgentHub UX Batch 3 — Batch 1 / Batch 2 regression', () => {
  it('keeps the Hub and both panels hook-free and transport-free', () => {
    const panels = ['AgentHub', 'AgentVerificationPanel', 'AgentRejectionPanel']
      .map((f) => stripComments(read(`src/components/agent/${f}.tsx`)))
      .join('\n');
    expect(panels).not.toMatch(/\buse(State|Effect|Memo|Callback|Ref|Reducer)\s*\(/);
    expect(panels).not.toMatch(/\bfetch\s*\(/);
    expect(panels).not.toMatch(/agentApi|useAgentOperations/);
  });

  it('keeps every Batch 1 and Batch 2 contract in place', () => {
    // Batch 1 — focus and live regions.
    expect(HUB_CODE).toContain("import { panelTriggerId } from './panelFocus'");
    expect(HUB_CODE).toContain("panelTriggerId(item.id, 'verify')");
    expect(HUB_CODE).toContain("panelTriggerId(item.id, 'reject')");
    expect((HUB_CODE.match(/role="alert"/g) ?? []).length).toBe(2);
    expect(HUB_CODE).toContain('role="status"');
    // Batch 2 — destructive treatment, consequence copy, action separation.
    expect(HUB_CODE).toMatch(/<Button variant="danger"/);
    expect(HUB_CODE).toContain('sm:border-l sm:border-stone-200 sm:pl-3');
    const reject = read('src/components/agent/AgentRejectionPanel.tsx');
    expect(reject).toContain('t.agentRejectConsequence');
    expect(reject).toMatch(/variant="danger"/);
    expect(reject).toContain('rejectionCustomText.trim() === ""');
  });

  it('keeps the three error/loading channels separate and retry intact', () => {
    expect(HUB_CODE).toContain('props.queueError && (');
    expect(HUB_CODE).toContain('props.operationError && (');
    expect(HUB_CODE).toContain('props.actionSuccessMsg && (');
    expect(HUB_CODE).toContain('onClick={props.retryQueue}');
    expect(HUB_CODE).toContain('props.setOperationError(\'\')');
    // Per-item busy identity is untouched.
    expect(HUB_CODE).toContain('props.processingItemId === id');
  });
});
