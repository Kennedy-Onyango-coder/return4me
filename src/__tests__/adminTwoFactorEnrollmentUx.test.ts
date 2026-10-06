import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// BATCH 2 — ADMIN 2FA ENROLLMENT UX (QR CODE + ONE-TIME RECOVERY CODES)
// =============================================================================
// Batch 1 hardened the admin 2FA BACKEND and left the console rendering the raw
// `otpauthUrl` as a wall of text. This batch is the enrollment / re-enrollment
// experience on top of that backend, and it adds NO backend behaviour: the same
// four endpoints, the same password re-entry, the same state machine, the same
// recovery-code issuance.
//
// What these tripwires pin (there is no jsdom / React harness in this repository,
// so — exactly as every UX-* suite does — the contract is asserted against the
// shipped source):
//   * the QR is generated LOCALLY from the server-returned `otpauthUrl` by
//     `qrcode.react` (a React SVG), never by hand, never by an external service;
//   * provisioning material (secret, otpauth URL, OTP) lives in component state
//     only: never in storage, a query string, a log or the DOM;
//   * the recovery codes are shown exactly once, in full, and are cleared when
//     the administrator acknowledges them — with no fake "download" that would
//     persist them;
//   * re-enrollment never claims the current authenticator has been switched off;
//   * every failure mode (password, OTP, stale enrollment, rate limit, session,
//     server) renders ONE safe, actionable, bilingual message and never a raw
//     status code or stack trace.
// =============================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const ADMIN_VIEW_TSX = read('src/components/AdminView.tsx');
const PACKAGE_JSON = JSON.parse(read('package.json')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const count = (source: string, pattern: RegExp) => (source.match(pattern) || []).length;

function sliceBetween(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = start === -1 ? -1 : source.indexOf(to, start + from.length);
  if (start === -1 || end === -1) throw new Error(`BATCH 2 marker not found: ${from} -> ${to}`);
  return source.slice(start, end);
}

/** The whole file, comments removed (for whole-file invariants). */
const CODE = stripComments(ADMIN_VIEW_TSX);
/** The Admin 2FA / Security card. */
const CARD = sliceBetween(ADMIN_VIEW_TSX, '{/* Admin 2FA / Security */}', '{/* Audit logs timeline */}');
const CARD_CODE = stripComments(CARD);
/** The batch's handlers + helpers, from their banner to the next unrelated one. */
const ENROLL = sliceBetween(ADMIN_VIEW_TSX, 'ADMIN 2FA ENROLLMENT UX (QR code', '// Fetch the expanded agent');
const ENROLL_CODE = stripComments(ENROLL);

/* The shared guards the UX-15C/D/E/F/G/H suites use, so this batch is held to the
 * SAME presentation contract as every other console panel. */
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
// A. The QR code is generated locally, from the URL the server already returned.
// -----------------------------------------------------------------------------

describe('the QR code is a locally generated React component, not a picture of a link', () => {
  it('uses a real, already-declared dependency instead of a hand-rolled encoder', () => {
    // The batch brief: prefer the smallest mature client-side solution, and never
    // implement QR generation by hand.
    expect(PACKAGE_JSON.dependencies?.['qrcode.react']).toBeDefined();
    expect(ADMIN_VIEW_TSX).toContain("import { QRCodeSVG } from 'qrcode.react';");
    // It is a RENDER dependency, not a build-tooling one.
    expect(PACKAGE_JSON.devDependencies?.['qrcode.react']).toBeUndefined();
  });

  it('encodes the otpauth URL returned by /setup — exactly once, as the QR value', () => {
    expect(CARD).toContain('<QRCodeSVG');
    expect(CARD).toContain('value={twoFaSetupData.otpauthUrl}');
    // The provisioning URL is never rendered to the screen as text, so the only
    // place it can appear is the QR's `value`.
    expect(count(ADMIN_VIEW_TSX, /twoFaSetupData\.otpauthUrl/g)).toBe(1);
  });

  it('never leaves the browser to make the QR: no external URL, image or request', () => {
    expect(CARD_CODE).not.toMatch(/https?:\/\//);
    expect(CARD_CODE).not.toMatch(/new Image|XMLHttpRequest|fetch\(|src="http/);
  });

  it('renders it safely — a React element, never interpolated HTML', () => {
    expect(CARD_CODE).not.toContain('dangerouslySetInnerHTML');
    expect(CARD_CODE).not.toContain('innerHTML');
  });

  it('presents it accessibly, at a real size, from named values', () => {
    expect(CARD).toContain('role="img"');
    expect(CARD).toContain('aria-label={en');
    expect(ADMIN_VIEW_TSX).toContain('const TWO_FA_QR_SIZE = 192;');
    expect(ADMIN_VIEW_TSX).toContain('const TWO_FA_QR_MARGIN = 4;');
    expect(CARD).toContain('size={TWO_FA_QR_SIZE}');
    expect(CARD).toContain('marginSize={TWO_FA_QR_MARGIN}');
    // …and the size is never a magic number in the JSX.
    expect(magicIconSize(CARD_CODE)).toEqual([]);
  });

  it('keeps a manual setup key as the fallback for a device that cannot scan', () => {
    expect(CARD).toContain('{twoFaSetupData.secret}');
    expect(CARD).toContain("en ? 'Copy setup key' : 'Nakili kitufe'");
    expect(CARD).toContain('select-all');
  });
});

// -----------------------------------------------------------------------------
// B. Provisioning material never leaves component state.
// -----------------------------------------------------------------------------

describe('the provisioning secret is shown only inside the enrollment panel', () => {
  it('displays the staged secret exactly once, inside the enrollment card', () => {
    // Exactly two references in the whole file, and nowhere else: the ONE render
    // of the manual key, and the clipboard read that copies that very same value.
    expect(count(ADMIN_VIEW_TSX, /twoFaSetupData\.secret/g)).toBe(2);
    expect(CARD).toContain('{twoFaSetupData.secret}');
    expect(ENROLL).toContain("void copyTwoFaValue(twoFaSetupData.secret, 'secret');");
  });

  it('runs the enrollment panel only while a secret is actually staged', () => {
    expect(CARD).toContain('{twoFaSetupData && (');
    // The panel is driven by the staged-secret state alone, so none of it can
    // render on the enabled / idle screen, and the raw URL is never a text node:
    // its single appearance is the QR's `value={…}` prop.
    expect(CARD).toContain('value={twoFaSetupData.otpauthUrl}');
    expect(CARD_CODE).not.toMatch(/[^=]\{twoFaSetupData\.otpauthUrl\}/);
  });

  it('never persists it: no storage, cookie, URL or history entry', () => {
    for (const surface of [ENROLL_CODE, CARD_CODE]) {
      expect(surface).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
      expect(surface).not.toMatch(/URLSearchParams|searchParams|history\.(?:pushState|replaceState)/);
    }
  });

  it('never logs it: no console call and no audit write from the UX layer', () => {
    expect(ENROLL_CODE).not.toMatch(/console\./);
    expect(CARD_CODE).not.toMatch(/console\./);
  });

  it('drops every byte of provisioning state when the flow is abandoned', () => {
    const discard = sliceBetween(ENROLL, 'const discardTwoFaProvisioning = () => {', '};');
    expect(discard).toContain('setTwoFaSetupData(null)');
    expect(discard).toContain("setTwoFaConfirmCode('')");
    expect(discard).toContain("setTwoFaStartPassword('')");

    const cancel = sliceBetween(ENROLL, 'const cancelTwoFaEnrollForm = () => {', '};');
    expect(cancel).toContain('setTwoFaShowEnrollForm(false)');
    expect(cancel).toContain('discardTwoFaProvisioning()');
    expect(cancel).toContain("setTwoFaCopyError('')");
    expect(cancel).toContain("setTwoFaCopied('')");
    // …and the UI really offers it.
    expect(CARD).toContain('onClick={cancelTwoFaEnrollForm}');
  });
});

// -----------------------------------------------------------------------------
// C. The enrollment flow: enable -> password re-entry -> QR -> confirm.
// -----------------------------------------------------------------------------

describe('enrollment opens from the disabled state, behind password re-entry', () => {
  it('offers a single explicit entry point when 2FA is off', () => {
    expect(CARD).toContain("en ? 'Enable 2FA' : 'Washa 2FA'");
    expect(count(CARD, /onClick=\{openTwoFaEnrollForm\}/g)).toBe(2);
    // The reveal performs no request at all — it only opens the form.
    const open = sliceBetween(ENROLL, 'const openTwoFaEnrollForm = () => {', '};');
    expect(open).not.toContain('fetch(');
    expect(open).toContain('setTwoFaShowEnrollForm(true)');
  });

  it('requires the current password before /setup is ever called', () => {
    expect(CARD).toContain('id="twofa-start-password"');
    expect(CARD).toContain('type="password"');
    expect(CARD).toContain('autoComplete="current-password"');
    expect(CARD).toContain('disabled={!twoFaStartPassword}');
    expect(CARD).toContain('void handleTwoFaStartSetup();');
    expect(ENROLL_CODE).toContain("fetch('/api/auth/admin-2fa/setup'");
    expect(ENROLL_CODE).toContain('body: JSON.stringify({ password: twoFaStartPassword })');
    // The password is sent in the POST body only — never in the URL.
    expect(ENROLL_CODE).not.toMatch(/admin-2fa\/setup\?/);
  });

  it('turns the /setup response into component state, and nothing else', () => {
    expect(ENROLL_CODE).toContain('setTwoFaSetupData({ secret: data.secret, otpauthUrl: data.otpauthUrl })');
    expect(ENROLL_CODE).toContain('setTwoFaStartPassword(\'\');');
  });

  it('posts the entered code to /confirm and never retries it automatically', () => {
    expect(ENROLL_CODE).toContain("fetch('/api/auth/admin-2fa/confirm'");
    expect(ENROLL_CODE).toContain('body: JSON.stringify({ code: twoFaConfirmCode })');
    // ONE confirm request per submit: the handler is called from the form's
    // onSubmit and from nowhere else.
    expect(count(ENROLL_CODE, /admin-2fa\/confirm/g)).toBe(1);
    expect(ENROLL_CODE).not.toMatch(/setTimeout|setInterval/);
  });

  it('keeps the OTP field numeric, six digits, and impossible to submit early', () => {
    expect(CARD).toContain('id="twofa-confirm-code"');
    expect(CARD).toContain('inputMode="numeric"');
    expect(CARD).toContain('maxLength={6}');
    expect(CARD).toContain('autoComplete="one-time-code"');
    expect(CARD).toContain('onChange={handleTwoFaCodeChange}');
    // Digits are FILTERED, never mapped from arbitrary characters.
    expect(ENROLL_CODE).toContain("setTwoFaConfirmCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6));");
    expect(CARD).toContain('disabled={twoFaConfirmCode.length !== 6}');
    expect(CARD).toContain('loading={twoFaProcessing}');
  });
});

// -----------------------------------------------------------------------------
// D. Recovery codes: shown once, in full, and cleared on acknowledgement.
// -----------------------------------------------------------------------------

describe('the recovery codes are a one-time, in-memory presentation', () => {
  it('captures the codes returned by /confirm', () => {
    expect(ENROLL_CODE).toContain('Array.isArray(data?.recoveryCodes)');
    expect(ENROLL_CODE).toContain('setTwoFaRecoveryCodes(codes.length > 0 ? codes : null)');
  });

  it('renders EVERY code, monospace and un-truncated, in a responsive grid', () => {
    expect(CARD).toContain('{twoFaRecoveryCodes.map((code) => (');
    expect(CARD).toContain('key={code}');
    expect(CARD).toContain('font-mono');
    expect(CARD).toContain('break-all');
    expect(CARD).toContain('select-all');
    expect(CARD).toContain('grid-cols-1 sm:grid-cols-2');
  });

  it('explains that each code is single-use and will not be shown again', () => {
    expect(CARD).toMatch(/Each one works a single time/);
    expect(CARD).toMatch(/none of them will be shown again/);
    expect(CARD).toMatch(/Kila mmoja hutumika mara moja tu/);
  });

  it('copies ONLY the codes', () => {
    expect(ENROLL_CODE).toContain("twoFaRecoveryCodes.join('\\n')");
    // The copy handler never carries explanatory copy or the enrollment message.
    const copyCodes = sliceBetween(ENROLL, 'const copyTwoFaRecoveryCodes = () => {', '};');
    expect(copyCodes).not.toContain('twoFaMessage');
    expect(copyCodes).not.toContain('otpauthUrl');
  });

  it('is cleared only by an explicit acknowledgement — never by a timer', () => {
    expect(CARD).toContain('onClick={finishTwoFaEnrollment}');
    expect(CARD).toContain("en ? 'Done, I have saved them' : 'Nimemaliza, nimezihifadhi'");
    const finish = sliceBetween(ENROLL, 'const finishTwoFaEnrollment = () => {', '};');
    expect(finish).toContain('setTwoFaRecoveryCodes(null)');
    expect(finish).toContain('discardTwoFaProvisioning()');
    expect(CARD_CODE).not.toMatch(/setTimeout|setInterval/);
    expect(ENROLL_CODE).not.toMatch(/setTimeout|setInterval/);
  });

  it('offers no fake persistence of the codes', () => {
    // No download attribute, no blob, no storage — the administrator is asked to
    // save them, and the app deliberately does not do it for them.
    expect(CARD_CODE).not.toContain('download=');
    expect(CARD_CODE).not.toMatch(/Blob|createObjectURL/);
    expect(count(CARD_CODE, /Copy/g)).toBeGreaterThan(2);
  });

  it('clears the codes when 2FA is disabled, because that enrollment ends', () => {
    const disable = sliceBetween(ENROLL, 'const handleTwoFaDisable = async', '};');
    expect(disable).toContain('setTwoFaRecoveryCodes(null)');
    expect(disable).toContain('discardTwoFaProvisioning()');
  });
});

// -----------------------------------------------------------------------------
// E. Re-enrollment: the current authenticator stays live until the new one works.
// -----------------------------------------------------------------------------

describe('re-enrollment never implies the live authenticator was switched off', () => {
  it('offers re-enrollment AND disable once 2FA is enabled', () => {
    expect(CARD).toContain("en ? 'Re-enroll authenticator' : 'Weka kifaa kipya cha uthibitishaji'");
    expect(CARD).toContain("en ? 'Disable 2FA' : 'Zima 2FA'");
    expect(CARD).toContain("en ? 'Enabled' : 'Imewashwa'");
    expect(CARD).toContain('id="twofa-disable-password"');
  });

  it('says the current authenticator keeps working while a replacement is staged', () => {
    expect(CARD).toMatch(/current one keeps working until the new one is confirmed/);
    expect(CARD).toMatch(/Your current authenticator stays active until you confirm a code from the new one/);
    expect(CARD).toMatch(/kinaendelea kufanya kazi hadi/);
  });

  it('never claims the old authenticator is already gone', () => {
    expect(CARD_CODE).not.toMatch(/authenticator (?:has|is) (?:been )?disabled/i);
    expect(CARD_CODE).not.toMatch(/no longer works/i);
    expect(CARD_CODE).not.toMatch(/has already been (?:disabled|removed)/i);
  });

  it('words the replacement action as a replacement, not a first-time enable', () => {
    expect(CARD).toContain("en ? 'Set up your replacement authenticator'");
    expect(CARD).toContain("en ? 'Set up two-factor authentication'");
    expect(CARD).toContain("en ? 'Confirm and replace'");
    expect(CARD).toContain("en ? 'Confirm and enable'");
    expect(CARD).toContain("en ? 'Generate new QR code' : 'Tengeneza msimbo mpya wa QR'");
  });

  it('uses the SAME password-gated /setup for a replacement', () => {
    expect(count(ENROLL_CODE, /admin-2fa\/setup/g)).toBe(1);
    expect(ENROLL_CODE).toContain('body: JSON.stringify({ password: twoFaStartPassword })');
  });
});

// -----------------------------------------------------------------------------
// F. Failure handling: every mode is distinguished, nothing is leaked.
// -----------------------------------------------------------------------------

describe('every backend failure has its own safe, actionable message', () => {
  it('distinguishes rate limiting and tells the administrator to wait', () => {
    expect(ENROLL_CODE).toContain('response.status === 429');
    expect(ENROLL_CODE).toMatch(/Too many attempts\. Please wait a few minutes and try again\./);
    expect(ENROLL_CODE).toMatch(/Majaribio mengi mno/);
  });

  it('distinguishes an invalid password', () => {
    expect(ENROLL_CODE).toContain('response.status === 401');
    expect(ENROLL_CODE).toMatch(/en \? 'That password is not correct\.'/);
  });

  it('distinguishes a dead administrator session', () => {
    expect(ENROLL_CODE).toContain('response.status === 403');
    expect(ENROLL_CODE).toMatch(/administrator session is no longer valid/);
  });

  it('distinguishes a server failure', () => {
    expect(ENROLL_CODE).toContain('response.status >= 500');
    expect(ENROLL_CODE).toMatch(/The server could not complete that request/);
  });

  it('treats a stale / replaced enrollment as unrecoverable and restarts the flow', () => {
    expect(ENROLL_CODE).toContain('status === 409');
    expect(ENROLL_CODE).toContain('isStaleTwoFaEnrollment(response.status, serverMessage)');
    const stale = sliceBetween(ENROLL, 'if (isStaleTwoFaEnrollment(response.status, serverMessage)) {', '} else {');
    expect(stale).toContain('discardTwoFaProvisioning()');
    expect(stale).toMatch(/start 2FA setup again/);
    // The local staged secret is dropped, so a dead enrollment cannot keep
    // rendering a QR code for a secret the server no longer holds.
    expect(stale).not.toContain('setTwoFaSetupData({');
  });

  it('renders no raw status code, stack trace or internal identifier', () => {
    expect(ENROLL_CODE).not.toContain('.stack');
    expect(ENROLL_CODE).not.toMatch(/response\.status\}/);
    expect(ENROLL_CODE).not.toMatch(/\$\{response\.status/);
    // Server text is consumed only when it actually IS a string.
    expect(ENROLL_CODE).toContain("typeof data?.error === 'string'");
  });

  it('announces request errors through the shared live-region banner', () => {
    expect(CARD).toContain('{twoFaError && <Banner kind="error">{twoFaError}</Banner>}');
    expect(CARD).toContain('{twoFaMessage && <Banner kind="success">{twoFaMessage}</Banner>}');
  });
});

// -----------------------------------------------------------------------------
// G. Clipboard: a success indication, and a graceful, announced failure.
// -----------------------------------------------------------------------------

describe('copy works, and fails gracefully when the Clipboard API is unavailable', () => {
  it('writes through the Clipboard API', () => {
    expect(ENROLL_CODE).toContain('navigator.clipboard');
    expect(ENROLL_CODE).toContain('clipboard.writeText(value)');
  });

  it('reports a blocked or missing clipboard instead of failing silently', () => {
    expect(ENROLL_CODE).toContain("typeof clipboard.writeText !== 'function'");
    expect(ENROLL_CODE).toMatch(/Copying is not available in this browser/);
    expect(ENROLL_CODE).toMatch(/Kunakili hakupatikani kwenye kivinjari hiki/);
    // Both outcomes are surfaced: success on a polite live region, failure as an
    // assertive alert — never as a colour-only change.
    expect(CARD).toContain('role="status"');
    expect(CARD).toContain('role="alert"');
    expect(CARD).toContain('text-status-success');
    expect(CARD).toContain('text-status-danger');
  });

  it('never lets a stale confirmation sit next to a fresh error', () => {
    const copy = sliceBetween(ENROLL, 'const copyTwoFaValue = async', '};');
    expect(copy).toContain("setTwoFaCopyError('')");
    expect(copy).toContain("setTwoFaCopied('')");
    expect(copy.indexOf("setTwoFaCopyError('')")).toBeLessThan(copy.indexOf("setTwoFaCopied('')"));
  });
});

// -----------------------------------------------------------------------------
// H. The batch stays on the console's design system and inside its scope.
// -----------------------------------------------------------------------------

describe('the new UI is held to the same design system as every other panel', () => {
  it('uses the UX-01 type ladder, the appearance tokens and the icon ladder', () => {
    expect(offLadderType(CARD_CODE)).toEqual([]);
    expect(legacyColour(CARD_CODE)).toEqual([]);
    expect(magicIconSize(CARD_CODE)).toEqual([]);
    expect(CARD_CODE).toContain('text-[var(--appearance-text-primary)]');
    expect(CARD_CODE).toContain('text-[var(--appearance-text-muted)]');
    expect(CARD_CODE).toContain('bg-[var(--appearance-surface-muted)]');
    expect(CARD_CODE).toContain('border-[var(--appearance-border)]');
  });

  it('starts no browser dialog and no second dialog component', () => {
    expect(browserDialog(CARD_CODE)).toEqual([]);
    // The whole-file invariants the UX-15 suites own must be untouched: this
    // batch added no <Modal>, no role="button" container, no zoom affordance,
    // no confirmation flow and no second unauthenticated branch.
    expect(count(CODE, /<Modal/g)).toBe(4);
    expect(count(CODE, /role="button"/g)).toBe(5);
    expect(count(CODE, /cursor-zoom-in/g)).toBe(2);
    expect(count(CODE, /setConfirmModal\(\{/g)).toBe(6);
    expect(count(CODE, /\{!token && \(/g)).toBe(1);
  });

  it('labels every input and gives every control a visible text name', () => {
    for (const id of ['twofa-start-password', 'twofa-confirm-code', 'twofa-disable-password']) {
      expect(CARD, `${id} needs a label`).toContain(`htmlFor="${id}"`);
      expect(CARD, `${id} needs the control it labels`).toContain(`id="${id}"`);
    }
    // The icon-bearing buttons keep their text label, so nothing is icon-only.
    expect(CARD).toContain("en ? 'Copy setup key' : 'Nakili kitufe'");
    expect(CARD).toContain("en ? 'Copy all codes' : 'Nakili misimbo yote'");
  });

  it('touches no SMS, no GEO/location and no catalogue surface', () => {
    expect(CARD_CODE).not.toMatch(/\bsms\b|africastalking/i);
    expect(CARD_CODE).not.toMatch(/county|geo(?:code|location)?|latitude|longitude/i);
    expect(CARD_CODE).not.toMatch(/categor(?:y|ies)/i);
    // The signed-out gate and its login-time 2FA step are untouched.
    expect(ADMIN_VIEW_TSX).toContain('id="admin-2fa-code"');
    expect(ADMIN_VIEW_TSX).toContain('onSubmit={pendingTwoFactorToken ? handleTwoFactorVerify : handleAdminAuth}');
  });

  it('follows the console bilingual convention for every new string', () => {
    // New chrome is bilingual (English/Swahili), and the batch adds a long list of
    // `en ? … : …` pairs rather than any new translation mechanism.
    expect(count(CARD, /(?<![A-Za-z])en\s*\?/g)).toBeGreaterThan(20);
    expect(CARD).toContain("'Uthibitishaji wa hatua mbili (2FA)'");
    expect(CARD).toContain("'Washa 2FA'");
    expect(CARD).toContain("'Hifadhi misimbo yako ya urejeshaji'");
    expect(CARD).toContain("'Nakili misimbo yote'");
    expect(ADMIN_VIEW_TSX).toContain("const en = lang === 'en';");
  });
});

// -----------------------------------------------------------------------------
// I. The guards are live, not decorative.
// -----------------------------------------------------------------------------

describe('the guards are live, not decorative (mutation checks)', () => {
  it('detects a reintroduced off-ladder type size', () => {
    expect(offLadderType(`${CARD_CODE} text-xs`)).not.toEqual([]);
    expect(offLadderType(`${CARD_CODE} text-[11px]`)).not.toEqual([]);
  });

  it('detects a reintroduced legacy colour literal', () => {
    expect(legacyColour(`${CARD_CODE} bg-white`)).not.toEqual([]);
    expect(legacyColour(`${CARD_CODE} text-stone-500`)).not.toEqual([]);
  });

  it('detects a reintroduced magic icon size', () => {
    expect(magicIconSize(`${CARD_CODE} size={16}`)).not.toEqual([]);
    expect(magicIconSize(`${CARD_CODE} <Loader2 className="w-6 h-6" />`)).not.toEqual([]);
  });

  it('detects a reintroduced browser dialog', () => {
    expect(browserDialog(`${CARD_CODE} window.confirm('really?')`)).not.toEqual([]);
  });
});
