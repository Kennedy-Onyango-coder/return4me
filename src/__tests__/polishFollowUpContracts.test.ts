// =============================================================================
// WP1–WP4 review follow-ups — the fixes must be WIRED, not merely written.
// =============================================================================
//
// M1 — the Terms deep link is consumed exactly once. `src/utils/termsAnchor.ts`
//      proves the one-shot rule in isolation (see its own test file); this suite
//      proves App owns the state, hands the anchor to the lazy view, and drops it
//      when the view reports back.
// L1 — the active-agent count is rendered only for a real number.
//      `src/utils/agentCountLabel.ts` proves the formatting rules; this suite
//      proves the trust strip actually calls it and that the old inline
//      `!== null` guard is gone.
//
// WHY SOURCE-LEVEL: as documented in focusContract.test.ts and
// publicChromeUx02.test.ts, this repository has no DOM/React harness. Comments
// are stripped so an assertion can never be satisfied by prose.
// =============================================================================
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Slice precisely, and fail loudly if an anchor disappears (never vacuous). */
function bound(source: string, from: string, to: string, name: string): string {
  const start = source.indexOf(from);
  expect(start, `${name}: anchor "${from}" must exist`).toBeGreaterThan(-1);
  const end = source.indexOf(to, start);
  expect(end, `${name}: end anchor "${to}" must exist after "${from}"`).toBeGreaterThan(start);
  const slice = source.slice(start, end);
  expect(slice.length, `${name}: slice must not be empty`).toBeGreaterThan(0);
  return slice;
}

const app = stripComments(read('src/App.tsx'));
const termsViewRaw = read('src/components/TermsView.tsx');
const termsView = stripComments(termsViewRaw);
const homeView = stripComments(read('src/components/HomeView.tsx'));

describe('M1 — the pending Terms anchor is cleared after it is applied', () => {
  it('App keeps the anchor nullable and clears it through a STABLE callback', () => {
    // Still `string | null`: `null` is the "nothing pending" state.
    expect(app).toContain('const [termsAnchor, setTermsAnchor] = useState<string | null>(null);');

    // The clear is a `useCallback` with no dependencies, so its identity is
    // stable. That matters: it is an effect dependency in TermsView, and App
    // re-renders on the 45s stats/discovery poll. A fresh closure each render
    // would re-run the scroll effect for no reason.
    expect(app).toContain('const clearTermsAnchor = useCallback(() => setTermsAnchor(null), []);');

    // ...and it is actually handed to the view.
    expect(app).toContain('onAnchorApplied={clearTermsAnchor}');
  });

  it('App writes the anchor once and clears it once — no effect resets it on view change', () => {
    // Exactly two calls: the intent from the footer button, and the clear.
    // A third (for example `useEffect(() => setTermsAnchor(null), [currentView])`)
    // would drop a deep link that is still waiting for the lazy view to mount.
    const writes = app.match(/setTermsAnchor\(/g) || [];
    expect(writes, 'only the footer intent and the clear may touch the anchor').toHaveLength(2);

    // The only deep-link write is the fee-schedule one.
    expect(app).toContain("setTermsAnchor('fee-schedule');");

    // App keeps exactly ONE scroll path of its own: the "already on Terms"
    // shortcut, where the view does not remount. The mount path belongs to
    // TermsView; a second App-side scroll would reintroduce the double jump.
    const appScrolls = app.match(/getElementById\('fee-schedule'\)/g) || [];
    expect(appScrolls).toHaveLength(1);
  });

  it('the footer button still opens Terms, and still scrolls directly when already there', () => {
    const handler = bound(
      app,
      "if (currentView === 'terms' && typeof document !== 'undefined')",
      'Fee Schedule',
      'fee-schedule footer button',
    );
    expect(handler).toContain("document.getElementById('fee-schedule')?.scrollIntoView({ block: 'start' });");
    expect(handler).toContain("setTermsAnchor('fee-schedule');");
    expect(handler).toContain("setView('terms');");
  });

  it('TermsView applies the anchor through the shared helper and reports it spent', () => {
    expect(termsView).toContain('applyPendingTermsAnchor({');
    expect(termsView).toContain('onApplied: onAnchorApplied,');
    // Both dependencies are what the effect re-runs on: a new anchor request, or
    // a new callback identity (stable by construction above).
    expect(termsView).toContain('}, [anchor, onAnchorApplied]);');
    // Server rendering must not touch the DOM.
    expect(termsView).toContain("typeof document === 'undefined' ? null : document");
    // ONE scroll implementation: the component must not re-grow an inline copy.
    expect(termsView, 'the scroll belongs to applyPendingTermsAnchor').not.toContain('scrollIntoView');
  });

  it('the deep link still has a target to land on', () => {
    expect(termsViewRaw).toContain('id="fee-schedule" className="space-y-3 scroll-mt-24"');
    expect(termsViewRaw).toContain('Fee Schedule and Settlement');
  });
});

describe('L1 — the active-agent count is rendered only for a real number', () => {
  it('routes the trust-strip label through the guarded formatter', () => {
    expect(homeView).toContain("import { formatActiveAgentCount } from '../utils/agentCountLabel';");

    const strip = bound(homeView, "{'Vetted Agents Only'}", 'M-Pesa Supported', 'trust strip');
    expect(strip).toContain('{formatActiveAgentCount(activeAgentsCount)}');
  });

  it('no longer admits nullish or junk input through an inline null check', () => {
    const strip = bound(homeView, "{'Vetted Agents Only'}", 'M-Pesa Supported', 'trust strip');

    // The old guard — the one `undefined` walked straight through.
    expect(strip).not.toContain('!== null');
    // No inline interpolation of the raw API value either.
    expect(strip).not.toMatch(/\$\{activeAgentsCount\}/);
  });

  it('keeps a single copy of the fallback copy — in the helper only', () => {
    // After comment stripping, HomeView contains no copy of the fallback label:
    // it can only be produced by `formatActiveAgentCount`. This is what stops a
    // second, differently-worded fallback from creeping back into the JSX.
    expect(homeView).not.toContain('Agent network in Kenya');
    // And the old marketing claim never returns.
    expect(homeView).not.toContain('Growing Agent Network');
    expect(homeView).not.toContain('Active Agents');
  });
});
