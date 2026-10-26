// =============================================================================
// BATCH B — MOBILE-FIRST AGENT DASHBOARD (the two inline Agent panels)
// =============================================================================
// The repository has no DOM/browser harness (vitest environment: 'node'), so —
// like every other UI suite here (agentDashboardUx13, agentHubUx*, UX-06 … UX-15H,
// responsiveUxBatchC) — this asserts the SHIPPED SOURCE against the rules the
// batch actually fixed, and proves each guard is LIVE with a mutation check.
//
// It exists because docs/design-system.md names these two files as the only
// un-migrated part of the agent workspace ("leaving only the Batch-B
// verification/rejection panels"), and because they carried three real defects
// that a comment-stripping source read alone does not catch:
//
//   1. THE CONTROL FLOOR. Every field was `p-2` + `text-xs` (≈30px tall) — below
//      the 44px touch-target floor `Button`/`Input` already enforce — on the two
//      surfaces an agent operates one-handed at a hub counter.
//   2. LIGHT-ONLY LITERALS. `bg-brand-beige/60`, `border-stone-200`, `bg-white`,
//      `bg-red-50/50`, `bg-white/70` and `text-red-800` bypass the appearance
//      roles. In the dark theme the rejection reason was white-on-white.
//   3. SOURCE PROSE RENDERED AS UI. The verification panel's Batch-1 rationale
//      was written as raw `//` lines INSIDE the JSX body. JSX renders bare text,
//      so the panel displayed a paragraph beginning "// BATCH 1 (UX-01): …".
//      `stripComments` cannot see this (it deletes the evidence), so this suite
//      scans the JSX BODY specifically.
//
// No value, validation rule, id, label association, live region, handler,
// endpoint or authorization rule may change here: every one of those is
// re-pinned at the end, so a future "mobile" pass cannot trade a contract for a
// class name.
// =============================================================================
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
/** The same comment stripper the UX-01 … UX-15H / Batch C suites use. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const VERIFY_PATH = 'src/components/agent/AgentVerificationPanel.tsx';
const REJECT_PATH = 'src/components/agent/AgentRejectionPanel.tsx';
const STYLES_PATH = 'src/components/agent/agentPanelFieldStyles.ts';

const VERIFY = stripComments(read(VERIFY_PATH));
const REJECT = stripComments(read(REJECT_PATH));
const STYLES = stripComments(read(STYLES_PATH));

/** Controls that are NOT text fields (the inspection checkbox owns its size). */
const TEXT_FIELD_IDS = [
  'agent-verify-category',
  'agent-verify-doc-name',
  'agent-verify-doc-number',
  'agent-verify-description',
  'agent-verify-exact-place',
  'agent-verify-reason',
  'agent-verify-reason-detail',
];

/**
 * The literals the panels may not reintroduce. Written as ONE expression so the
 * mutation check below can prove the guard actually trips.
 *
 * `bg-white` is banned in BOTH spellings here (including `bg-white/70`), unlike
 * the Hub's guard which exempts the deliberate `bg-white/10` overlay on the
 * green partner banner: these panels sit on the muted surface, so any white
 * tint is the light-only defect this batch removed.
 */
const LEGACY_LITERAL =
  /bg-brand-beige|bg-white|text-stone-|border-stone-|bg-red-|text-red-|rounded-(?:lg|xl|2xl|3xl)(?![\w-])|text-xs(?![\w-])|text-\[(?:9|10|11)px\]/;

const count = (src: string, needle: RegExp) => (src.match(needle) || []).length;

/** The slice of a file that runs from its first JSX element to the end. */
const jsxBody = (source: string) => {
  const start = source.indexOf('<div');
  return start === -1 ? '' : source.slice(start);
};

// -----------------------------------------------------------------------------
// 1. ONE FIELD LANGUAGE  (the shared module)
// -----------------------------------------------------------------------------
describe('Batch B: both panels read ONE field language', () => {
  it('imports the shared module instead of re-typing field classes', () => {
    expect(read(VERIFY_PATH)).toContain("from './agentPanelFieldStyles'");
    expect(read(REJECT_PATH)).toContain("from './agentPanelFieldStyles'");
    expect(read(REJECT_PATH)).toMatch(/import \{ FIELD_CLASS \} from '\.\/agentPanelFieldStyles'/);
  });

  it('states the 44px floor, the 16px field size and token-only colours', () => {
    expect(STYLES).toContain('min-h-11');
    expect(STYLES).toContain('text-body');
    expect(STYLES).toContain('rounded-standard');
    expect(STYLES).toContain('border-[var(--appearance-border)]');
    expect(STYLES).toContain('bg-[var(--appearance-surface)]');
    expect(STYLES).not.toMatch(LEGACY_LITERAL);
  });

  it('keeps the finder notes wrappable so a long value cannot widen the panel', () => {
    expect(STYLES).toContain('break-words');
    expect(STYLES).toContain('min-w-0');
  });
});

// -----------------------------------------------------------------------------
// 2. THE CONTROL FLOOR — every text field, per id
// -----------------------------------------------------------------------------
describe('Batch B: every field in both panels meets the touch-target floor', () => {
  it('attaches FIELD_CLASS to each of the seven verification controls', () => {
    for (const id of TEXT_FIELD_IDS) {
      const at = VERIFY.indexOf(`id="${id}"`);
      expect(at, `${id} must still be rendered`).toBeGreaterThan(-1);
      const tag = VERIFY.slice(at, at + 400);
      expect(tag, `${id} must use the shared field class`).toContain('FIELD_CLASS');
    }
  });

  it('attaches FIELD_CLASS to the rejection select and its custom-reason input', () => {
    expect(REJECT).toMatch(/id=\{`reject-reason-\$\{item\.id\}`\}[\s\S]{0,120}className=\{FIELD_CLASS\}/);
    expect(REJECT).toMatch(/aria-label="Custom rejection reason"[\s\S]{0,160}className=\{FIELD_CLASS\}/);
  });

  it('makes the physical-inspection row itself the 44px target', () => {
    expect(VERIFY).toMatch(/<label className="flex min-h-11 items-center gap-3/);
    // The box inside it is a real 20px control, not the 13px default.
    expect(VERIFY).toMatch(/type="checkbox"[\s\S]{0,200}className="h-5 w-5 shrink-0/);
  });

  it('leaves no field on the old ≈30px treatment', () => {
    for (const [name, source] of [
      ['verification', VERIFY],
      ['rejection', REJECT],
    ] as const) {
      expect(source, `${name} must not use bare p-2 fields`).not.toMatch(/className="[^"]*\bp-2\b[^"]*"/);
      expect(source, `${name} must not use text-xs controls`).not.toMatch(/\btext-xs\b/);
    }
  });
});

// -----------------------------------------------------------------------------
// 3. THEMES — appearance roles only
// -----------------------------------------------------------------------------
describe('Batch B: the panels are correct in both themes', () => {
  it('removes every light-only surface, border and status literal', () => {
    for (const [name, source] of [
      ['verification', VERIFY],
      ['rejection', REJECT],
    ] as const) {
      expect(source, `${name} still carries a legacy literal`).not.toMatch(LEGACY_LITERAL);
    }
  });

  it('the guard is live: a reintroduced literal would be caught', () => {
    // Proves the expression is not decorative — each shape must trip it.
    for (const legacy of [
      'bg-brand-beige/60 p-4 rounded-xl',
      'border border-stone-200 rounded-lg',
      'bg-white/70 px-3',
      'bg-red-50/50',
      'text-red-800',
      'text-xs font-bold',
    ]) {
      expect(LEGACY_LITERAL.test(legacy), `${legacy} must trip the guard`).toBe(true);
    }
  });

  it('keeps the rejection consequence readable on a dark surface', () => {
    expect(REJECT).toContain('border-[var(--appearance-danger)]');
    expect(REJECT).toContain('bg-[var(--appearance-surface)]');
    expect(REJECT).toContain('text-[var(--appearance-danger)]');
  });
});

// -----------------------------------------------------------------------------
// 4. MOBILE ACTION LAYOUT
// -----------------------------------------------------------------------------
describe('Batch B: the actions stack on a phone', () => {
  it('gives the verification actions their own full-width rows below sm', () => {
    // The wrapper is the Batch-1 suite's boundary marker, so it must survive.
    expect(VERIFY).toContain('<div className="flex flex-wrap gap-2 justify-end pt-1">');
    expect(count(VERIFY, /className="w-full sm:w-auto"/g)).toBe(2);
  });

  it('stacks the rejection actions with the destructive one on top below sm', () => {
    expect(REJECT).toContain('flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end');
    expect(count(REJECT, /className="w-full sm:w-auto"/g)).toBe(2);
    // Visual order is flipped by CSS only; DOM order (Cancel first) is unchanged.
    expect(REJECT.indexOf('Cancel')).toBeLessThan(REJECT.indexOf('Submit Rejection'));
  });

  it('keeps the panel surface single-column and padded for a 320px viewport', () => {
    const PANEL_SURFACE =
      'className="space-y-4 rounded-panel border border-[var(--appearance-border)] bg-[var(--appearance-surface-muted)] p-4 shadow-raised sm:p-5"';
    expect(VERIFY).toContain(PANEL_SURFACE);
    expect(REJECT).toContain(PANEL_SURFACE);
    expect(VERIFY).toContain('text-heading font-extrabold');
  });
});

// -----------------------------------------------------------------------------
// 5. NO SOURCE PROSE REACHES THE DOM
// -----------------------------------------------------------------------------
describe('Batch B: rationale lives in the source, never on the screen', () => {
  /** `//` lines between the root element's opening and the end of the file. */
  const jsxLineComments = (source: string) => jsxBody(source).match(/^[ \t]*\/\/[ \t]/gm) ?? [];

  it('renders no `//` comment text inside either panel', () => {
    expect(jsxLineComments(read(VERIFY_PATH))).toEqual([]);
    expect(jsxLineComments(read(REJECT_PATH))).toEqual([]);
  });

  it('the detector is live: the pre-fix shape is caught', () => {
    const regressed = `${read(VERIFY_PATH)}
  // BATCH 1 (UX-01): the verification failure is a dynamic, actionable
  {verifyError && (<p role="alert" />)}`;
    expect(jsxLineComments(regressed).length).toBe(1);
  });

  it('keeps the rationale as real JSX comments instead of deleting it', () => {
    // Raw source: `stripComments` deletes the comment body, which is exactly why
    // the original defect was invisible to every comment-stripping suite.
    expect(read(VERIFY_PATH)).toContain('{/* MOBILE-FIRST BATCH B');
    expect(read(VERIFY_PATH)).toContain('physical-inspection');
    expect(read(REJECT_PATH)).toContain('{/* MOBILE-FIRST BATCH B');
  });
});

// -----------------------------------------------------------------------------
// 6. THE CONTRACTS THIS BATCH MUST NOT TRADE AWAY
// -----------------------------------------------------------------------------
describe('Batch B: every pre-existing panel contract is re-pinned', () => {
  it('keeps the seven ids and their label associations', () => {
    for (const id of TEXT_FIELD_IDS) {
      expect(VERIFY).toContain(`id="${id}"`);
      expect(VERIFY).toContain(`htmlFor="${id}"`);
    }
    expect(REJECT).toContain('htmlFor={`reject-reason-${item.id}`}');
  });

  it('keeps exactly one alert and no stacked live region', () => {
    expect(count(VERIFY, /role="alert"/g)).toBe(1);
    expect(VERIFY).not.toMatch(/role="alert"[^>]*aria-live/);
    expect(VERIFY).not.toMatch(/aria-invalid/);
  });

  it('keeps the per-item busy pair adjacent and the shared handlers', () => {
    expect(VERIFY).toMatch(/disabled=\{isItemBusy\(item\.id\)\}[\s\S]{0,100}aria-busy=\{isItemBusy\(item\.id\)\}/);
    expect(VERIFY).toContain('handleSubmitVerification');
    expect(VERIFY).toContain("hasCorrections(item) ? 'corrected' : 'confirmed'");
    expect(REJECT).toContain('rejectionCustomText.trim() === ""');
    expect(REJECT).toMatch(/variant="danger"/);
  });

  it('keeps the focus contract for both panels', () => {
    expect(VERIFY).toContain("ref={panelFocusRef(item.id, 'verify')}");
    expect(VERIFY).toContain('tabIndex={-1}');
    expect(REJECT).toContain("ref={panelFocusRef(item.id, 'reject')}");
    expect(REJECT).toContain('tabIndex={-1}');
  });

  it('keeps the conditional finder-note description wired to the same id', () => {
    expect(VERIFY).toContain("'agent-verify-exact-place-finder-note'");
    expect(VERIFY).toContain('id="agent-verify-exact-place-finder-note"');
  });

  it('keeps both panels and the styles module presentation-only', () => {
    const surface = `${VERIFY}\n${REJECT}\n${STYLES}`;
    expect(surface).not.toMatch(/\buse(?:State|Effect|Memo|Callback|Reducer|Ref)\s*\(/);
    expect(surface).not.toMatch(/\bfetch\s*\(/);
    expect(surface).not.toMatch(/agentApi|useAgentOperations/);
  });

  it('adds no second category map (the select stays the only one)', () => {
    expect(count(VERIFY, /categories\.map\(/g)).toBe(1);
  });
});


