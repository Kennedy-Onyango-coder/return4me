// =============================================================================
// ADMIN CONSOLE — ONE-TIME SECOND-ADMIN PROVISIONING UI (Administrator
// Management panel) — SOURCE-CONTRACT SUITE
// =============================================================================
// Frontend only: the backend endpoint (POST /api/admin/provision-admin,
// db.provisionSecondAdmin) was committed in 6af77c2 and is covered by
// src/db/__tests__/adminProvisioning.test.ts. This suite pins the CONSOLE's
// half of the contract. There is no jsdom / React harness in this repository,
// so — exactly as every UX-* suite does — the contract is asserted against
// the shipped source of the new panel, its API client and its two-line
// integration in AdminView.tsx. All network behaviour is pinned by the mocked
// tests in src/services/__tests__/adminProvisionAdminApi.test.ts; no request
// in this suite (or that one) can reach a real server, and no administrator
// account is ever created.
//
// What these tripwires pin:
//   * the panel renders ONLY in the authenticated Admin Console (token gate)
//     and appears exactly once, in the Overview tab's Security area;
//   * it collects exactly the fields the verified API contract requires,
//     with password confirmation and validation that mirrors the server;
//   * it talks to the backend ONLY through the shared API client (no
//     hand-built fetch, no invented status endpoint);
//   * a double-click cannot fire a second submission (state + ref guard +
//     disabled button);
//   * success clears every entered value, shows a safe confirmation, and
//     explicitly tells the operator the new administrator signs in with
//     their OWN credentials — the panel mints no session;
//   * the server's 409 closure codes disable the form PERMANENTLY, while a
//     duplicate-username conflict stays retryable — closure is never inferred
//     from an unrelated network error;
//   * no password or raw exception can reach the console's logs, storage or
//     URL; and the panel stays clear of the payout-approval safeguards.
// =============================================================================

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const PANEL_TSX = read('src/components/admin/security/AdministratorManagementPanel.tsx');
const ADMIN_VIEW_TSX = read('src/components/AdminView.tsx');
const CLIENT_TS = read('src/services/adminProvisionAdminApi.ts');

/** The panel's CODE, comments removed (for whole-file invariants). */
const PANEL_CODE = stripComments(PANEL_TSX);
const CLIENT_CODE = stripComments(CLIENT_TS);
/** The AdminView integration point: the panel sits in the Overview tab's
 *  Security area, between the 2FA card and the audit timeline. */
const INTEGRATION = stripComments(
  (() => {
    const start = ADMIN_VIEW_TSX.indexOf('{/* Admin 2FA / Security */}');
    const end = ADMIN_VIEW_TSX.indexOf('{/* Audit logs timeline */}');
    if (start === -1 || end === -1 || end < start) throw new Error('AdminView Security-area markers moved');
    return ADMIN_VIEW_TSX.slice(start, end);
  })(),
);

// The shared guards the other UX-* suites use, so this batch is held to the
// SAME presentation contract as every other console panel.
const offLadderType = (source: string): string[] => [
  ...(source.match(/text-\[\d+px\]/g) || []),
  ...(source.match(/\btext-(?:xs|sm|base|lg|xl|2xl|3xl|4xl|5xl)(?![\w-])/g) || []),
];
const legacyColour = (source: string): string[] => [
  ...(source.match(/#[0-9a-fA-F]{3,8}\b/g) || []),
  ...(source.match(/\b(?:bg|text|border)-(?:stone|slate|gray|zinc|emerald|amber|sky|red)-/g) || []),
  ...(source.match(/\bbg-white\b/g) || []),
];
const magicIconSize = (source: string): string[] => [
  ...(source.match(/size=\{\d+\}/g) || []),
  ...(source.match(/(?:^|[\s"])w-6 h-6(?![\w-])/g) || []),
];
const browserDialog = (source: string): string[] =>
  source.match(/\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/g) || [];

// -----------------------------------------------------------------------------
// A. Authorized context: the panel exists only inside the signed-in console.
// -----------------------------------------------------------------------------

describe('the panel appears only in the authorized Admin Console context', () => {
  it('is mounted exactly once, in the Overview tab Security area, with the session token', () => {
    expect(ADMIN_VIEW_TSX).toContain("import AdministratorManagementPanel from './admin/security/AdministratorManagementPanel';");
    const mounts = ADMIN_VIEW_TSX.match(/<AdministratorManagementPanel\b/g) || [];
    expect(mounts).toHaveLength(1);
    expect(INTEGRATION).toContain('<AdministratorManagementPanel token={token} />');
  });

  it('renders nothing at all without a session token', () => {
    expect(PANEL_CODE).toContain('if (!token) return null');
  });

  it('keeps the console chrome conventions (type ladder, colour ladder, icon ladder, no dialogs)', () => {
    expect(offLadderType(PANEL_CODE)).toEqual([]);
    expect(legacyColour(PANEL_CODE)).toEqual([]);
    expect(magicIconSize(PANEL_CODE)).toEqual([]);
    expect(browserDialog(PANEL_CODE)).toEqual([]);
    expect(PANEL_CODE).not.toContain('dangerouslySetInnerHTML');
    expect(PANEL_CODE).not.toContain('innerHTML');
  });
});

// -----------------------------------------------------------------------------
// B. The exact backend contract, through the existing authenticated pattern.
// -----------------------------------------------------------------------------

describe('the request uses the shared API client and the verified backend contract', () => {
  it('the panel NEVER builds a request itself — all traffic goes through the client', () => {
    expect(PANEL_CODE).not.toMatch(/fetch\s*\(/);
    expect(PANEL_CODE).toContain('provisionSecondAdmin(token, {');
    // …and it passes exactly the fields the route destructures.
    expect(PANEL_CODE).toContain('fullName: fullName.trim()');
    expect(PANEL_CODE).toContain('username: username.trim()');
    expect(PANEL_CODE).toContain('password,');
  });

  it('the client targets the exact endpoint with the console bearer token', () => {
    expect(CLIENT_CODE).toContain("export const ADMIN_PROVISION_ADMIN_PATH = '/api/admin/provision-admin';");
    expect(CLIENT_CODE).toContain("Authorization: `Bearer ${token}`");
    expect(CLIENT_CODE).toContain("method: 'POST'");
    // camelCase `fullName` is the ROUTE'S wire name; snake_case full_name is
    // response-only. Sending the response spelling would fail validation.
    const bodyBlock = (CLIENT_CODE.match(/JSON\.stringify\(\{[^}]*\}\)/) || [''])[0];
    expect(bodyBlock).toContain('fullName: request.fullName');
    expect(bodyBlock).not.toContain('full_name');
    expect(bodyBlock).not.toContain('confirmPassword');
  });

  it('there is NO invented provisioning-status endpoint anywhere in the new code', () => {
    // The one-time gate has no safe pre-flight: the server's answer to the
    // submission is the only authority, and the copy says so.
    expect(CLIENT_CODE + PANEL_CODE).not.toMatch(/provision-admin\/|provision-admin\?|provision-admin-status/);
    expect(PANEL_CODE).toContain('There is no availability check');
  });
});

// -----------------------------------------------------------------------------
// C. Validation, confirmation, and a double-click that cannot double-submit.
// -----------------------------------------------------------------------------

describe('the form validates like the server and refuses duplicate submissions', () => {
  it('collects the required fields with the server’s own ceilings and a confirmation', () => {
    expect(PANEL_CODE).toContain('validateProvisionAdminForm({ fullName, username, password, confirmPassword })');
    expect(PANEL_CODE).toContain('maxLength={PROVISION_ADMIN_LIMITS.fullName}');
    expect(PANEL_CODE).toContain('maxLength={PROVISION_ADMIN_LIMITS.username}');
    expect(PANEL_CODE).toContain('maxLength={PROVISION_ADMIN_LIMITS.password}');
    // The confirmation is a client-only field; it must never reach the wire
    // (the client body test pins that half).
    expect(PANEL_CODE).toContain('confirmPassword');
  });

  it('password fields are masked and never auto-filled from the browser password store', () => {
    const passwordInputs = PANEL_CODE.match(/type="password"/g) || [];
    expect(passwordInputs).toHaveLength(2); // initial + confirmation
    const new_pw = PANEL_CODE.match(/autoComplete="new-password"/g) || [];
    expect(new_pw).toHaveLength(2);
    expect(PANEL_CODE).not.toContain('autoComplete="current-password"');
  });

  it('validation failures are announced accessibly and never touch the network', () => {
    expect(PANEL_CODE).toContain('setFieldErrors(errors)');
    // Validation short-circuits BEFORE any state that could trigger a call:
    expect(PANEL_CODE).toContain('if (errors.fullName || errors.username || errors.password || errors.confirmPassword) {');
    // Field errors render through the shared Input, which wires role="alert"
    // + aria-invalid + aria-describedby (components/ui/Input.tsx).
    expect(PANEL_CODE).toContain('error={fieldErrors.fullName}');
    expect(PANEL_CODE).toContain('error={fieldErrors.username}');
    expect(PANEL_CODE).toContain('error={fieldErrors.password}');
    expect(PANEL_CODE).toContain('error={fieldErrors.confirmPassword}');
  });

  it('a second click while the request is in flight cannot start a second request', () => {
    // Guard #1 — a synchronous ref, flipped before the await: the second half
    // of a double-click returns before validation or fetch.
    expect(PANEL_CODE).toContain('const submittingRef = useRef(false)');
    expect(PANEL_CODE).toContain('if (!token || submittingRef.current) return;');
    expect(PANEL_CODE).toContain('submittingRef.current = true');
    // Guard #2 — the button is disabled (and shows the loading state) for the
    // whole flight, so a keyboard re-submit is refused too.
    expect(PANEL_CODE).toContain('disabled={submitting}');
    expect(PANEL_CODE).toContain('loading={submitting}');
    // Guard #3 — the gate is spent after success, so the form cannot reappear.
    expect(PANEL_CODE).toContain('const gateSpent = closed || createdAdmin !== null');
    expect(PANEL_CODE).toContain('{!gateSpent && (');
  });
});

// -----------------------------------------------------------------------------
// D. Success: sensitive fields cleared, safe confirmation, NO session for the
//    new administrator.
// -----------------------------------------------------------------------------

describe('a successful creation clears sensitive values and mints no session', () => {
  /** The success branch, from the awaited call to the catch clause. */
  const successBranch = (() => {
    const from = 'const admin = await provisionSecondAdmin(token, {';
    const start = PANEL_TSX.indexOf(from);
    if (start === -1) throw new Error('provisioning call site not found');
    const end = PANEL_TSX.indexOf('} catch (error)', start);
    if (end === -1) throw new Error('catch clause not found');
    return stripComments(PANEL_TSX.slice(start, end));
  })();

  it('clears every entered value — including both passwords — on success', () => {
    expect(successBranch).toContain("setFullName('')");
    expect(successBranch).toContain("setUsername('')");
    expect(successBranch).toContain("setPassword('')");
    expect(successBranch).toContain("setConfirmPassword('')");
  });

  it('keeps only the server’s credential-free confirmation and renders it safely', () => {
    expect(successBranch).toContain('setCreatedAdmin(admin)');
    expect(PANEL_CODE).toContain('${createdAdmin.username}');
    // The success banner shows username ONLY — never a password or token.
    expect(PANEL_CODE).not.toMatch(/createdAdmin\s*\.\s*(password|token)/);
  });

  it('tells the operator the new administrator signs in with their OWN credentials', () => {
    expect(PANEL_CODE).toContain('They must sign in with their OWN username and the initial password you set for them');
    expect(PANEL_CODE).toContain('this console does not sign them in, and no session was created for that account');
  });

  it('the panel contains no mechanism to create, store or forward a session', () => {
    expect(PANEL_CODE).not.toMatch(/\/api\/auth/);           // no login/mint endpoint
    expect(PANEL_CODE).not.toMatch(/setToken|generateToken|jwt|jsonwebtoken/);
    expect(PANEL_CODE).not.toMatch(/localStorage|sessionStorage|indexedDB/i); // in CODE, not comments
  });
});

// -----------------------------------------------------------------------------
// E. One-time closure vs retryable conflict — only the server can declare it.
// -----------------------------------------------------------------------------

describe('the server’s closure answer disables the form; unrelated errors never do', () => {
  it('a 409 closure code permanently disables the form and explains why', () => {
    expect(PANEL_CODE).toContain("if (error.kind === 'closed')");
    expect(PANEL_CODE).toContain('setClosed(true)');
    expect(PANEL_CODE).toContain('{closed && (');
    expect(PANEL_CODE).toContain('this one-time action is no longer available. It can never be repeated.');
    // On closure the half-typed credentials are wiped too.
    const closedBranch = PANEL_CODE.slice(PANEL_CODE.indexOf("if (error.kind === 'closed')"), PANEL_CODE.indexOf("if (error.kind === 'conflict')"));
    expect(closedBranch).toContain("setPassword('')");
    expect(closedBranch).toContain("setConfirmPassword('')");
  });

  it('a duplicate username is a retryable field error, NOT a closure', () => {
    expect(PANEL_CODE).toContain("if (error.kind === 'conflict')");
    expect(PANEL_CODE).toContain('setFieldErrors({ username: error.message })');
    // The form stays mounted for a corrected username:
    expect(PANEL_CODE).not.toContain("if (error.kind === 'conflict') setClosed");
  });

  it('a network or unexpected failure NEVER closes the form and never shows a raw exception', () => {
    // Only the typed 'closed' branch may set closed; nothing else does.
    const setClosedCalls = PANEL_CODE.match(/setClosed\(true\)/g) || [];
    expect(setClosedCalls).toHaveLength(1);
    // Fixed fallback for an exception the client did not produce — the raw
    // value is never stringified onto the screen.
    expect(PANEL_CODE).toContain('Something unexpected went wrong. Nothing was created');
    expect(PANEL_CODE).not.toMatch(/String\(error\)|error\.stack|\$\{error\}/);
    expect(PANEL_CODE).not.toMatch(/console\./);
  });
});

// -----------------------------------------------------------------------------
// F. The panel stays inside its own lane — payout safeguards untouched.
// -----------------------------------------------------------------------------

describe('the provisioning UI cannot interact with the payout safeguards', () => {
  it('references no settlement, approval, attestation or payout endpoints', () => {
    const code = PANEL_CODE + CLIENT_CODE;
    expect(code).not.toMatch(/settlement|approve-and-pay|release-settlement|attestation|payout-destination/i);
    // …and never imports the database or the server module.
    expect(code).not.toMatch(/from ['"].*db\/(database|index)/);
  });

  it('the pre-existing safeguard surfaces are still wired in the console', () => {
    // Existence + wiring, so this batch cannot quietly remove them; their
    // BEHAVIOUR is proven by the untouched settlement/attestation suites,
    // which run green in the same validation batch as this file.
    expect(ADMIN_VIEW_TSX).toContain('<SettlementApproveAndPayConfirmation');
    expect(ADMIN_VIEW_TSX).toContain('settlementApproveAndPayActionKey');
    expect(fs.existsSync(path.resolve(repoRoot, 'src/__tests__/adminRouteAudit.test.ts'))).toBe(true);
    expect(fs.existsSync(path.resolve(repoRoot, 'src/db/__tests__/adminProvisioning.test.ts'))).toBe(true);
  });
});
