import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ADMIN_SECTION_IDS } from '../components/admin/shell/adminNavRegistry';
import { OVERVIEW_OPTIONAL_STATS_FIELDS } from '../components/admin/dashboard/adminOverviewMetrics';
import {
  AUDIT_LOG_WINDOW_DEFAULT,
  AUDIT_LOG_WINDOW_MAX,
  AUDIT_LOG_WINDOW_OPTIONS,
  isAuditActionFilter,
  readAuditLogWindowRequest,
} from '../config/auditLogWindow';
import {
  buildAuditLogRequestPath,
  failureMessageForStatus,
  mapAuditLogWindow,
  safeAuditDetailsText,
} from '../services/adminAuditLogApi';
import { toAdminSafeAuditLog, toAdminSafeAuditLogWindow } from '../services/adminSafeViews';

// =============================================================================
// PROGRAMME 1 — THE TWO CONSOLE SECTIONS, PINNED AT THE SURFACES THAT CARRY RISK
// =============================================================================
// This batch added two sections to the authenticated admin console:
//   * Payout Integrity (WS1 / WS2 / WS5) — can this hub be paid at all, and what
//     is still owed to it;
//   * Audit Log (WS4) — a bounded, newest-first READ of the administrative trail.
//
// The section-set tripwires (adminConsoleShell.test.ts) and the presentation ones
// (adminConsoleUx15.test.ts) already pin the sidebar and the chrome. What is
// pinned HERE is what those do not cover: that each section reads the payload it
// claims to read, that nothing in either can write, and — the reason this file
// exists at all — that the audit client reads the field names the server actually
// sends. Static file-text and executed-function assertions, like the rest of this
// repository's node-only suite.
// =============================================================================

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

const adminView = read('src/components/AdminView.tsx');
const serverTs = read('src/server.ts');
const databaseTs = read('src/db/database.ts');
const safeViewsSource = read('src/services/adminSafeViews.ts');
const presentation = read('src/components/admin/payouts/payoutIntegrityPresentation.ts');

/** The console's declared section ids, in sidebar order. */
const declaredSections = (source: string) =>
  [...source.matchAll(/aria-current=\{activeTab === '([a-z_]+)'/g)].map((m) => m[1]);

/** Everything between two markers of the console's own source. */
function sliceBetween(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  if (start === -1 || end === -1) throw new Error(`marker not found: ${from} -> ${to}`);
  return source.slice(start, end);
}

describe('the two sections exist, and the sidebar agrees with the registry', () => {
  it('renders a panel for both new sections', () => {
    expect(adminView).toContain("{activeTab === 'payouts' && (");
    expect(adminView).toContain("{activeTab === 'audit' && (");
  });

  it('declares exactly the registry\u2019s section ids, in the registry\u2019s order', () => {
    // One source of truth for what a console section IS. A future batch that adds
    // a registry item without a sidebar button (or the reverse) fails here.
    expect(ADMIN_SECTION_IDS).toEqual([
      'stats', 'claims', 'ledger', 'disputes', 'payouts',
      'agents', 'found_items', 'lost_reports', 'review',
      'categories', 'strikes', 'audit',
    ]);
    expect(declaredSections(adminView)).toEqual([...ADMIN_SECTION_IDS]);
  });

  it('gives each new section the nav label and the state key it renders', () => {
    expect(adminView).toContain("onClick={() => setActiveTab('payouts')}");
    expect(adminView).toContain("aria-current={activeTab === 'payouts' ? 'page' : undefined}");
    expect(adminView).toContain('<span>Payout Integrity</span>');
    expect(adminView).toContain("onClick={() => setActiveTab('audit')}");
    expect(adminView).toContain("aria-current={activeTab === 'audit' ? 'page' : undefined}");
    expect(adminView).toContain('<span>Audit Log</span>');
  });
});

describe('WS1/WS2/WS5 — Payout Integrity reads the payload in hand, and writes nothing', () => {
  const section = sliceBetween(adminView, "{activeTab === 'payouts' && (", "{activeTab === 'audit' && (");

  it('renders the per-hub verdict table from the dashboard rows already loaded', () => {
    expect(adminView).toContain("import PayoutIntegrityHubsTable from './admin/payouts/PayoutIntegrityHubsTable'");
    expect(adminView).toContain('const payoutIntegrityRows = readPayoutIntegrityHubs(dashboardData?.agents);');
    expect(section).toContain('<PayoutIntegrityHubsTable rows={payoutIntegrityRows} />');
  });

  it('states the section\u2019s own counts from the rows it rendered', () => {
    // The counts sentence is built from the summary of the rows the table was
    // given, so a figure above the table cannot disagree with the table below it.
    expect(adminView).toContain('describePayoutIntegritySourceSentence(');
    expect(section).toContain('{payoutIntegritySentence}');
    expect(adminView).toContain('const payoutIntegritySource = readPayoutIntegritySourceState(dashboardData?.agents);');
    expect(adminView).toContain('const payoutIntegritySummary = summarizePayoutIntegrity(payoutIntegrityRows);');
  });

  it('prints NO count at all when the agent list itself was not read (F3)', () => {
    // The F3 defect this remediation removes: an absent `agents` list produced zero
    // rows and the section printed "0 hub row(s) read", claiming an empty payload
    // had been observed. The sentence is now chosen from the list's own state, and
    // the unavailable wording carries no figure.
    expect(section).toContain('{payoutIntegritySentence}');
    expect(presentation).toContain("if (state === 'unreadable') return PAYOUT_INTEGRITY_SOURCE_UNREADABLE_TEXT;");
    // The unavailable statement states unknown rather than a zero count.
    expect(presentation).toContain('Read this as unknown, not as zero');
    // ...and the pure mapper reports the two list states distinctly.
    expect(presentation).toContain("return Array.isArray(agents) ? 'read' : 'unreadable';");
  });

  it('states the age of the verdicts it shows, including a failed refresh (F6)', () => {
    // Every verdict below is read from the dashboard payload in hand, so its age is
    // the payload's age. A reading whose refresh failed stays on screen but must be
    // labelled as older, and an unrecorded reading time must be said to be unknown
    // rather than a timestamp being implied. No new request: this reuses the
    // Overview's own dashboardLoadedAt / dashboardStale.
    expect(section).toContain('dashboardStale');
    expect(section).toContain('dashboardLoadedAt');
    expect(section).toContain('the latest refresh failed, so these are an older reading');
    expect(section).toContain('Treat their age as unknown rather than as current');
    expect(section).not.toContain('fetch(');
    expect(section).not.toContain('setInterval');
  });

  it('adds no request of its own: the section issues no fetch', () => {
    expect(section).not.toContain('fetch(');
    expect(section).not.toContain('await ');
  });

  it('names no mutation anywhere in the section', () => {
    for (const verb of [
      'retryPayout', 'resubmitPayout', 'refundPayout',
      'markPayoutPaid', 'sendPayout', 'executeClaimSettlement',
    ]) {
      expect(section, `the section must not name ${verb}`).not.toContain(verb);
    }
    expect(section).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/);
  });
});

describe('WS2/WS5 — a figure the payload did not carry is never rendered as 0', () => {
  it('publishes the launch-policy figure as an OPTIONAL overview statistic', () => {
    expect([...OVERVIEW_OPTIONAL_STATS_FIELDS]).toContain('payoutIneligibleAgentsCount');
    // The Overview card reads it through the shared read-out module, so an
    // unreported figure is the em dash and a genuine 0 still reads as 0.
    expect(adminView).toContain('formatMetricCount(dashboardData.stats?.payoutIneligibleAgentsCount).text');
  });

  it('no longer turns an absent earnings figure into "KES 0 earned"', () => {
    // The WS5 defect this batch removes: `|| 0` on a money figure is a claim the
    // server never made. The read-out module states the missing marker instead.
    expect(adminView).not.toContain('(agent.total_earned || 0)');
    expect(adminView).not.toMatch(/total_earned \?\? 0/);
    expect(adminView).not.toMatch(/pending_earnings \|\| 0/);
    expect(adminView).toContain('Earnings not recorded');
    expect(adminView).toContain('Owed total not recorded');
  });

  it('shows the launch-policy verdict and the owed share on every hub row', () => {
    expect(adminView).toContain('const payoutVerdict = readPayoutIntegrityHubRow(agent);');
    expect(adminView).toContain('{payoutVerdict.riskLabel}');
    expect(adminView).toContain('{payoutVerdict?.pendingEarningsReported');
  });
});

describe('WS4 — the Audit Log section mounts one read-only panel', () => {
  const section = sliceBetween(adminView, "{activeTab === 'audit' && (", '{/* Custom Confirmation Modal */}');

  it('mounts the panel exactly once, from the audit section\u2019s own component', () => {
    expect(adminView).toContain("import AuditLogPanel from './admin/audit/AuditLogPanel'");
    expect(adminView.match(/<AuditLogPanel/g)?.length).toBe(1);
    expect(section).toContain('<AuditLogPanel token={token} />');
  });

  it('adds no request and no mutation of its own', () => {
    expect(section).not.toContain('fetch(');
    expect(section).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/);
    for (const verb of ['deleteAuditLog', 'updateAuditLog', 'createAuditLog', 'purgeAuditLog']) {
      expect(section, `the section must not name ${verb}`).not.toContain(verb);
    }
  });
});

describe('WS4 — the client reads the field names the server actually sends', () => {
  const rawLog = {
    id: 'audit-1',
    action: 'PAYOUT_INITIATED',
    admin_user: 'admin-1',
    created_at: '2026-01-01T00:00:00.000Z',
    details: 'First line\nsecond\u0000line',
  };

  it('renders the actor and the time the window carried — not "Not recorded"', () => {
    const envelope = toAdminSafeAuditLogWindow({ limit: 100, action: null }, [rawLog]);
    const window = mapAuditLogWindow(envelope);

    expect(window.limit).toBe(100);
    expect(window.action).toBeNull();
    expect(window.count).toBe(1);
    expect(window.rows).toHaveLength(1);
    // The regression this file exists for: reading `adminUser`/`createdAt` left
    // every row looking as though the server had recorded neither actor nor time.
    expect(window.rows[0].adminUserLabel).toBe('admin-1');
    expect(window.rows[0].recordedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(window.rows[0].ageLabel).not.toBe('unknown');
    expect(window.rows[0].actionLabel).toBe('PAYOUT_INITIATED');
  });

  it('proves the assertion above is live: camelCase is NOT what the server sends', () => {
    const wrong = mapAuditLogWindow({
      limit: 100,
      action: null,
      count: 1,
      items: [
        {
          id: 'x',
          action: 'PAYOUT_INITIATED',
          adminUser: 'admin-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          details: '',
        },
      ],
    });
    expect(wrong.rows[0].adminUserLabel).toBe('Not recorded');
    expect(wrong.rows[0].recordedAt).toBeNull();
  });

  it('redacts PII in the stored details, and makes the text renderable', () => {
    // The server DTO's job is the PII: the phone number and the email in the
    // stored free text never leave the server verbatim (sanitizeAuditDetails).
    const safe = toAdminSafeAuditLog({
      ...rawLog,
      details: 'Paid 254712345678 and mailed ops@example.com',
    });
    expect(safe.details).toContain('[phone]');
    expect(safe.details).toContain('[email]');
    expect(safe.details).not.toContain('254712345678');

    // The CLIENT's job is making the value safe to render: control characters —
    // including the newlines a stored message may contain — collapse to spaces,
    // and a blob is capped. Neither layer can restructure the row.
    const collapsed = mapAuditLogWindow({ items: [rawLog] }).rows[0].detailsText;
    expect(collapsed).not.toContain('\n');
    expect(collapsed).not.toContain('\u0000');
    const long = mapAuditLogWindow({ items: [{ ...rawLog, details: 'x'.repeat(900) }] });
    expect(long.rows[0].detailsText).toHaveLength(501); // capped + the ellipsis
    expect(safeAuditDetailsText('a'.repeat(500))).toHaveLength(500);
    expect(safeAuditDetailsText(null)).toBe('');
  });

  it('redacts EVERY Kenyan mobile representation a payout destination may carry', () => {
    // REVIEW FIX (F2). `config/payoutDestinations.ts` accepts all of these as
    // payable destinations, and the audit window makes 500 such rows readable at
    // once. Every form below is a real handset number, so every form must be
    // redacted before it is serialised — the `01x` Safaricom range, the
    // international form with no `+`, and the separated forms that defeated the
    // previous `\+?2547\d{8}` / `07\d{8}` patterns.
    const PAYABLE_REPRESENTATIONS: [string, string][] = [
      ['national, leading zero', '0712345678'],
      ['the 01x Safaricom range', '0110000000'],
      ['01x, spaced', '011 000 0000'],
      ['international, no plus', '254712345678'],
      ['international 01x, no plus', '254110000000'],
      ['E.164', '+254712345678'],
      ['E.164, spaced', '+254 712 345 678'],
      ['E.164, hyphenated', '+254-712-345-678'],
      ['national, hyphenated', '0712-345-678'],
      ['national, spaced', '0712 345 678'],
      ['international, spaced', '254 712 345 678'],
    ];

    for (const [label, representation] of PAYABLE_REPRESENTATIONS) {
      const safe = toAdminSafeAuditLog({
        ...rawLog,
        details: `destination was ${representation}`,
      });
      expect(
        safe.details,
        `${label} (${representation}) must not survive sanitisation`,
      ).toContain('[phone]');
      expect(
        safe.details,
        `${label} (${representation}) must not survive sanitisation`,
      ).not.toContain(representation);
      // Nothing of the number is left behind either: no digit run at all.
      expect(safe.details.replace(/[^0-9]/g, ''), `${label} must leave no digits`).toBe('');
    }

    // Several numbers in one stored line are each redacted, and the surrounding
    // prose survives — redaction is not a blanking of the whole message.
    const many = toAdminSafeAuditLog({
      ...rawLog,
      details: 'settled 0712345678 then 0110000000 for claim C-42',
    });
    expect(many.details).toBe('settled [phone] then [phone] for claim C-42');

    // The email behaviour the previous pattern set already had is PRESERVED.
    const email = toAdminSafeAuditLog({ ...rawLog, details: 'notify ops@example.com' });
    expect(email.details).toBe('notify [email]');
  });

  it('does NOT redact ordinary numeric identifiers that are not Kenyan mobiles', () => {
    // The F2 regex matches a SHAPE and then validates the number, so it is not an
    // indiscriminate digit-eater: redacting a claim id or a ledger reference would
    // make the audit trail less useful without protecting anything.
    const NOT_PHONES = [
      'claim 7712345678 approved', // 10 digits, no 254/0 prefix: not a destination shape
      'reference 254700000000123', // 15 digits: a longer id, not a handset
      'amount 01234567890 owed', // 11 digits after the zero: too long to be a destination
      'batch 7, 25471234567', // 11 digits: a truncated number, not a destination
      'code 0254700000', // 254 + 7 digits: a landline shape, not a personal mobile
      'ledger 100000000001', // a 12-digit id that is not a mobile range
    ];

    for (const details of NOT_PHONES) {
      const safe = toAdminSafeAuditLog({ ...rawLog, details });
      expect(
        safe.details,
        `"${details}" is not a Kenyan mobile and must survive verbatim`,
      ).toBe(details);
      expect(safe.details).not.toContain('[phone]');
    }

    // The boundary is the digits: a number that merely BEGINS like a handset and
    // continues is left whole, rather than being mangled into a partial redaction.
    expect(toAdminSafeAuditLog({ ...rawLog, details: 'id 2547123456789' }).details).toBe(
      'id 2547123456789',
    );
  });

  it('treats a body it cannot read as a failure, not as an empty trail', () => {
    for (const body of [{}, { items: null }, { items: 'rows' }, null]) {
      expect(() => mapAuditLogWindow(body)).toThrow(/could not be read/);
    }
    // ...while an empty items array IS a successful read of an empty window.
    expect(mapAuditLogWindow({ limit: 50, action: 'PAYOUT_INITIATED', count: 0, items: [] }).rows).toEqual([]);
  });
});

describe('WS4 — the window is the server\u2019s decision: bounded, refused, never clamped', () => {
  it('applies the documented default when no window is asked for', () => {
    expect(readAuditLogWindowRequest({})).toEqual({
      ok: true,
      limit: AUDIT_LOG_WINDOW_DEFAULT,
      action: null,
    });
    expect(readAuditLogWindowRequest({ limit: '   ' }).limit).toBe(AUDIT_LOG_WINDOW_DEFAULT);
  });

  it('accepts a canonical window inside the bound and refuses every other shape', () => {
    expect(readAuditLogWindowRequest({ limit: '1' })).toEqual({ ok: true, limit: 1, action: null });
    expect(readAuditLogWindowRequest({ limit: '500' })).toEqual({
      ok: true,
      limit: AUDIT_LOG_WINDOW_MAX,
      action: null,
    });

    for (const refused of ['0', '-5', '501', '100000', '1e2', '10.0', '100.5', 'abc', '100 0']) {
      const request = readAuditLogWindowRequest({ limit: refused });
      expect(request.ok, `limit=${refused} must be refused`).toBe(false);
      expect(request.reason).toBeTruthy();
    }
  });

  it('never clamps: a refused request does not quietly return the maximum', () => {
    const refused = readAuditLogWindowRequest({ limit: '5000' });
    expect(refused.ok).toBe(false);
    expect(refused.limit).toBe(AUDIT_LOG_WINDOW_DEFAULT);
  });

  it('refuses a filter typo rather than answering "no entries with this action"', () => {
    expect(readAuditLogWindowRequest({ action: 'PAYOUT_INITIATED' }).action).toBe('PAYOUT_INITIATED');
    for (const typo of ['payout_initiated', 'PAYOUT-INITIATED', 'PAYOUT INITIATED', 'P', 'A B']) {
      expect(readAuditLogWindowRequest({ action: typo }).ok, `action=${typo} must be refused`).toBe(false);
      expect(isAuditActionFilter(typo)).toBe(false);
    }
  });

  it('offers only window sizes the server will accept', () => {
    expect(AUDIT_LOG_WINDOW_OPTIONS.length).toBeGreaterThan(0);
    for (const size of AUDIT_LOG_WINDOW_OPTIONS) {
      expect(Number.isInteger(size)).toBe(true);
      expect(size).toBeGreaterThan(0);
      expect(size).toBeLessThanOrEqual(AUDIT_LOG_WINDOW_MAX);
      expect(readAuditLogWindowRequest({ limit: String(size) }).ok).toBe(true);
    }
  });

  it('builds the request path without ever substituting its own bound', () => {
    expect(buildAuditLogRequestPath()).toBe('/api/admin/audit-logs');
    expect(buildAuditLogRequestPath(50, null)).toBe('/api/admin/audit-logs?limit=50');
    expect(buildAuditLogRequestPath(50, 'PAYOUT_INITIATED')).toBe(
      '/api/admin/audit-logs?limit=50&action=PAYOUT_INITIATED',
    );
    // A limit the client cannot vouch for is left out, so the SERVER decides.
    expect(buildAuditLogRequestPath(50.5, '  ')).toBe('/api/admin/audit-logs');
  });

  it('states each failure in fixed words, echoing nothing from the request', () => {
    expect(failureMessageForStatus(401)).toContain('session has expired');
    expect(failureMessageForStatus(403)).toContain('not an administrator');
    expect(failureMessageForStatus(400)).toContain('window is not one the API accepts');
    expect(failureMessageForStatus(500)).toContain('Nothing was changed by this read.');
  });
});

describe('WS4 — the endpoint and its query are read-only, bounded and attributed', () => {
  it('is an authenticated admin GET, and refuses a non-administrator', () => {
    expect(serverTs).toContain("app.get('/api/admin/audit-logs', authenticateJWT, requireCurrentAdminSession");
    expect(serverTs).toContain("if (req.user?.role !== 'admin')");
    expect(serverTs).toContain('res.status(403)');
    expect(serverTs).toContain('readAuditLogWindowRequest(req.query)');
    expect(serverTs).toContain('res.status(400)');
  });

  it('reads a bounded, deterministically ordered window', () => {
    expect(serverTs).toContain('db.getAuditLogsWindow(requested.limit, requested.action)');
    expect(databaseTs).toContain('orderBy(desc(auditLogTable.created_at), desc(auditLogTable.id))');
    expect(databaseTs).toMatch(/getAuditLogsWindow[\s\S]{0,700}\.limit\(limit\)/);
  });

  it('has no route that writes, edits or deletes an audit entry', () => {
    expect(serverTs).not.toMatch(/app\.(post|put|patch|delete)\('\/api\/admin\/audit-logs/);
  });

  it('maps every row through the same sanitising DTO the dashboard list uses', () => {
    expect(serverTs).toContain(
      'toAdminSafeAuditLogWindow({ limit: requested.limit, action: requested.action }, logs)',
    );
    expect(safeViewsSource).toContain('items: rows.map(toAdminSafeAuditLog)');
  });
});
