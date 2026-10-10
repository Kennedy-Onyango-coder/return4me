import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// BATCH 2 — ADMIN UNRESOLVED-PAYOUTS UI BOUNDARY
// =============================================================================
// Static, file-text audit — the established pattern for frontend behaviour in
// this repository (no jsdom / React Testing Library exists here; see
// adminLostReportsUi.test.ts and claimsAdminUiBoundary.test.ts).
//
// The two things that matter most about this surface:
//
//   1. IT IS READ-ONLY. A payout whose provider outcome is unresolved may
//      already have moved money, so the console must have no way to resend,
//      refund or "mark paid" — the only correct action is a manual provider
//      check, which happens outside this platform.
//   2. IT IS DISCLOSED, NOT ALWAYS-ON. The overview already states the COUNT.
//      The rows behind it are read only when an operator asks to see them, so
//      an ordinary visit to this tab still costs exactly what it always did.
//
// (What the rows actually RENDER — masking, "missing is never zero", the
// fail-closed outcome labels — is pinned cell by cell in
// src/components/admin/payouts/__tests__/payoutReconciliationRendering.test.ts.)

const ROOT = path.resolve(__dirname, '../..');
const SRC = (p: string) => fs.readFileSync(path.resolve(ROOT, p), 'utf8');

const ADMIN_VIEW = 'src/components/AdminView.tsx';
const PANEL = 'src/components/admin/payouts/PayoutReconciliationPanel.tsx';
const TABLE = 'src/components/admin/payouts/PayoutReconciliationTable.tsx';
const CLIENT = 'src/services/adminPayoutReconciliationApi.ts';

const adminView = SRC(ADMIN_VIEW);
const panel = SRC(PANEL);
const table = SRC(TABLE);
const client = SRC(CLIENT);

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** De-comment AND de-string, so a token in prose or a fixture cannot mask code. */
function codeOnly(file: string): string {
  let s = stripComments(SRC(file));
  s = s.replace(/`(?:[^`\\]|\\.|\$\{[^}]*\})*`/g, '""');
  s = s.replace(/(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, '""');
  return s;
}

describe('Batch 2 admin unresolved-payouts UI: the rows behind the figure are disclosed', () => {
  it('AdminView mounts the panel behind its own disclosure, not a new tab', () => {
    expect(adminView).toContain(
      "import PayoutReconciliationPanel, { PAYOUT_RECONCILIATION_PANEL_ID } from './admin/payouts/PayoutReconciliationPanel'",
    );
    expect(adminView).toContain('const [payoutReconciliationOpen, setPayoutReconciliationOpen] = useState(false);');
    expect(adminView).toContain('aria-expanded={payoutReconciliationOpen}');
    expect(adminView).toContain('aria-controls={PAYOUT_RECONCILIATION_PANEL_ID}');
    expect(adminView).toContain('onClick={() => setPayoutReconciliationOpen((open) => !open)}');
    // A real expanded/collapsed label, so the state is stated and not implied.
    expect(adminView).toContain("'View unresolved payout rows'");
    expect(adminView).toContain("'Hide unresolved payout rows'");
    // No second navigation surface: the disclosure adds no tab key.
    expect(adminView).not.toContain('payout_reconciliation');
  });

  it('the disclosure sits with the "Unresolved Payouts" figure it explains', () => {
    expect(adminView).toMatch(
      /label=\{'Unresolved Payouts'\}[\s\S]{0,1500}aria-expanded=\{payoutReconciliationOpen\}/,
    );
  });

  it('the flag is CLOSED by default and the panel is mounted ONLY while disclosed', () => {
    // Default false: the panel is the only reader of the endpoint, so a
    // collapsed disclosure must cost nothing at all.
    expect(adminView).toMatch(
      /const \[payoutReconciliationOpen, setPayoutReconciliationOpen\] = useState\(false\)/,
    );
    expect(adminView).toMatch(
      /\{payoutReconciliationOpen && \(\s*<PayoutReconciliationPanel token=\{token\} \/>/,
    );
    // Exactly one render site: nothing else can mount it unconditionally.
    expect(adminView.match(/<PayoutReconciliationPanel/g)?.length).toBe(1);
  });

  it('the panel carries the section id its disclosure points at', () => {
    expect(panel).toContain("export const PAYOUT_RECONCILIATION_PANEL_ID = 'payout-reconciliation-panel'");
    expect(panel).toContain('id={PAYOUT_RECONCILIATION_PANEL_ID}');
  });
});

describe('Batch 2 admin unresolved-payouts UI: the surface is read-only', () => {
  it('issues GET only, from a client with no mutation verb at all', () => {
    // De-commented but NOT de-stringed: the HTTP verb IS a string literal, so
    // codeOnly() would blank exactly what is being asserted.
    const raw = stripComments(SRC(CLIENT));
    expect(raw).toContain("method: 'GET'");
    expect(raw).not.toMatch(/'POST'|'PUT'|'PATCH'|'DELETE'/);
    // ONE network call in the whole client.
    expect(raw.match(/fetch\(/g)?.length).toBe(1);
  });

  it('the panel can only re-READ the list: one read, one Refresh control', () => {
    // A refresh bumps a token and re-reads; it never re-sends a payout.
    expect(panel.match(/fetchUnresolvedPayouts\(/g)?.length).toBe(1);
    expect(codeOnly(PANEL).match(/<Button/g)?.length).toBe(1);
    expect(panel).toContain("loadingLabel={'Reading unresolved payouts'}");
    expect(panel).toMatch(/const refresh = useCallback\(\(\) => setReloadToken\(\(n\) => n \+ 1\), \[\]\)/);
  });

  it('the table is inert: no control, no handler, no markup injection', () => {
    const code = codeOnly(TABLE);
    expect(code).not.toMatch(/<button|<input|<select|<form|onClick|onChange|onSubmit/);
    expect(code).not.toContain('dangerouslySetInnerHTML');
  });

  it('names no mutation, anywhere on the surface', () => {
    for (const file of [PANEL, TABLE, CLIENT]) {
      const code = codeOnly(file);
      for (const verb of [
        'retryPayout',
        'resubmitPayout',
        'refundPayout',
        'markPayoutPaid',
        'sendPayout',
        'executeClaimSettlement',
      ]) {
        expect(code, `${file} must not name ${verb}`).not.toContain(verb);
      }
    }
  });

  it('imports nothing from the database, the routes or the matching engine', () => {
    for (const file of [PANEL, TABLE, CLIENT]) {
      const sources = [...stripComments(SRC(file)).matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      const bad = sources.filter((s) => /db\/|routes\/|server|Matching|adminSafeViews/.test(s));
      expect(bad, `${file} must not import ${bad.join(', ')}`).toEqual([]);
    }
  });

  it('never logs, and never injects markup', () => {
    for (const file of [PANEL, TABLE, CLIENT]) {
      const code = codeOnly(file);
      expect(code, `${file} must not log`).not.toContain('console.log');
      expect(code, `${file} must not inject html`).not.toContain('dangerouslySetInnerHTML');
    }
  });
});

describe('Batch 2 admin unresolved-payouts UI: missing is never zero', () => {
  it('renders the server-masked recipient only, never the raw payload field', () => {
    expect(client).toContain('recipientMasked: maskRecipientForDisplay(item.recipient)');
    expect(table).toContain('row.recipientMasked ?? NOT_RECORDED_TEXT');
    // The ONLY recipient expression is the masked one, so no future edit can
    // print the API's `recipient` value straight onto the screen.
    expect(codeOnly(TABLE)).not.toMatch(/row\.recipient(?!Masked)/);
  });

  it('states "not recorded" rather than blank or 0 for an absent value', () => {
    expect(table).toContain("export const NOT_RECORDED_TEXT = 'Not recorded'");
    expect(table).toContain('row.amountLabel');
    expect(table).toContain('!row.amountReported');
    expect(table).toContain('Age unknown');
    // The table writes out each field; it never spreads a row and never dumps JSON.
    expect(table).not.toMatch(/\{\.\.\.row\}/);
    expect(table).not.toContain('JSON.stringify');
  });

  it('shows the empty state ONLY after a successful read that returned no rows', () => {
    // loading -> skeleton; rows -> the table; error with no rows -> NOTHING.
    expect(panel).toMatch(/loading && !hasRows \? \(/);
    expect(panel).toMatch(/\) : hasRows \? \(/);
    expect(panel).toMatch(/\) : error \? null : \(/);
    expect(panel).toContain("title={'No unresolved payouts'}");
  });

  it('a failed refresh keeps the last good rows and says they may be stale', () => {
    expect(panel).toContain("<Banner kind={hasRows ? 'warning' : 'error'}>");
    expect(panel).toContain('may be out of date');
    // A deliberately cancelled read is silent: it is not a failure.
    expect(panel).toMatch(/err\.isAbort\) return;/);
  });

  it('bounds its requests: no polling, abort on unmount, newest read wins', () => {
    expect(panel).toContain('AbortController');
    expect(panel).toMatch(/return \(\) => controller\.abort\(\)/);
    expect(panel).toMatch(/requestId !== requestIdRef\.current/);
    expect(panel).not.toContain('setInterval');
    expect(panel).not.toContain('setTimeout');
  });
});
