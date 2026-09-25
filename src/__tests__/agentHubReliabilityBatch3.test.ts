import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { agentClaimBadge } from '../components/claimStatus';
import { getClaimStatusDisplay, CLAIM_STATUS_VALUES } from '../components/claimStatus';

// =============================================================================
// PHASE 16.1 BATCH 3 — AGENT HUB RELIABILITY + ACCESSIBILITY REGRESSION
// =============================================================================
// Batch 2 (forensic audit) established the defects this batch remediates:
//   F-1 operational failures wrote to `authError`, rendered ONLY in the
//       signed-out branch, so a signed-in agent saw nothing when an action failed
//   F-5/H-3 any failed queue request set agentStatus='pending' ("Vetting Pending")
//   F-2 `handoverCodeInput` was dead state backed by a dead input
//   F-3 `handleAuthRequest` built a registration payload it never sent
//   F-4 `disputed` / `released` claims both rendered as "Awaiting Payment"
//   F-6 the confirm modal closed before its async action resolved
//   H-1/M-6 AgentView kept a second, never-refreshed /api/categories copy
//   A-1/A-2/A-6/A-7/A-8 missing live regions, unassociated labels, no aria-busy,
//       unnamed <video>, and modals with no dialog semantics
//
// This repository has NO DOM harness (vitest.config.ts runs `environment:
// 'node'`; Batch 1C confirmed jsdom/RTL is not installed and must not be added
// for one batch), so — following the same convention as
// phase9PublicSurface.test.ts, publicNavigation.test.ts and Batch 1C's
// categoryExplorerDisclosure.test.ts — the contract is pinned two ways:
//   1. BEHAVIOURALLY, where a pure function was factored out for the purpose
//      (agentClaimBadge, and the shared claim-status map it delegates to);
//   2. SOURCE-LEVEL, against the real component and the real server that ship.
// No brittle line-number assertions are used anywhere.
// =============================================================================

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

/**
 * Comments are stripped before every structural assertion: this batch's own
 * explanatory comments name the very identifiers being asserted about
 * (operationError, handoverCodeInput, authError, …), so judging the CODE
 * requires removing the prose. Same technique and rationale as
 * publicNavigation.test.ts / claimTrackingDisclosure.test.ts.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const AGENTVIEW = stripComments(read('src/components/AgentView.tsx'));
const AGENTHUB = stripComments(read('src/components/agent/AgentHub.tsx'));
const APP = stripComments(read('src/App.tsx'));
const SERVER = read('src/server.ts');
// BATCH 4: the live Hub JSX moved to AgentHub; these suites read the composed
// AgentView+AgentHub surface so Batch 3 contracts follow the code.
const HUB = AGENTVIEW + '\n' + AGENTHUB;

// ---------------------------------------------------------------------------
// Test 1 — F-1: operational errors have their own channel AND their own render
// ---------------------------------------------------------------------------
describe('B3-F1: operational failures are separated from authentication failures', () => {
  it('declares a dedicated operational error state and renders it in the Hub', () => {
    expect(AGENTVIEW).toContain("const [operationError, setOperationError] = useState('');");

    // The Hub renders it with an assertive live region (A-1).
    const opBlock = HUB.slice(HUB.indexOf('{operationError && ('));
    expect(opBlock).toContain('role="alert"');
    expect(opBlock).toContain('aria-live="assertive"');
  });

  it('routes EVERY operational failure to the operational channel, not to authError', () => {
    // The four client-generated operational messages the audit named.
    const operationalSinks = [
      'setOperationError(lang === ' + "'en' ? 'No pending item found with that drop-off code.'",
      'setOperationError(lang === ' + "'en' ? 'Ask the owner for their secret pickup code first.'",
      'setOperationError(lang === ' + "'en' ? 'Take a photo of the claimant with the item",
      'setOperationError(lang === ' + "'en' ? 'Could not access camera.",
    ];
    for (const sink of operationalSinks) {
      expect(AGENTVIEW, `missing operational sink: ${sink}`).toContain(sink);
    }
    // The network/API failure catches for reject, handover and confirm-viewing.
    expect((AGENTVIEW.match(/setOperationError\(e\.message\)/g) ?? []).length).toBe(3);
  });

  it('authError is written ONLY by authentication/registration code paths', () => {
    const authWrites = [
      "setAuthError('');",
      "setAuthError('Tafadhali weka barua pepe sahihi",
      'setAuthError(e.message);',
      "setAuthError('Picha ya duka ni kubwa mno.",
      "setAuthError('Picha ya kitambulisho ni kubwa mno.",
    ];
    for (const write of authWrites) {
      expect(AGENTVIEW, `expected auth-path write missing: ${write}`).toContain(write);
    }
    // Exactly two survive: handleAuthRequest and handleOtpVerify. A third would
    // mean an operational path regressed back onto the auth channel.
    expect((AGENTVIEW.match(/setAuthError\(e\.message\)/g) ?? []).length).toBe(2);
    // And authError is TEXTUALLY rendered in exactly one place: the signed-out card.
    expect((AGENTVIEW.match(/\{authError && \(/g) ?? []).length).toBe(1);
    expect(AGENTVIEW).toContain('<span>{authError}</span>');
  });

  it('the handover dialog shows the operational message where the agent is looking', () => {
    // Inside the pickup-code dialog the same text is placed visually, WITHOUT a
    // second live region (A-1: announced once, not twice).
    const modalStart = HUB.indexOf('pickupCodeModal && (');
    expect(modalStart).toBeGreaterThan(-1);
    const modal = HUB.slice(modalStart);
    expect(modal).toContain('{operationError && (');
    expect(modal).toContain('<p className="text-red-600 text-xs font-semibold">{operationError}</p>');
    expect(modal).not.toContain('{authError && (');
  });
});

// ---------------------------------------------------------------------------
// Test 2 — F-5 / H-3: a failed queue request is NOT a vetting-status change
// ---------------------------------------------------------------------------
describe('B3-F5: queue failure never asserts an agent status change', () => {
  it('agentStatus is set to "active" on success and NEVER set to "pending" by a failure', () => {
    expect(AGENTVIEW).toContain("const [agentStatus, setAgentStatus] = useState<string>('pending');");
    expect(AGENTVIEW).toContain("setAgentStatus('active');");
    // The defect was literally this statement inside the !response.ok branch.
    expect(AGENTVIEW).not.toContain("setAgentStatus('pending');");
  });

  it('every failure path writes queueError, and queueError is rendered', () => {
    expect(AGENTVIEW).toContain("const [queueError, setQueueError] = useState('');");
    expect(AGENTVIEW).toContain("const [queueLoading, setQueueLoading] = useState(false);");
    // non-OK response + thrown fetch
    expect((AGENTVIEW.match(/setQueueError\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // the error surfaces: AgentView keeps the standalone panel…
    expect(AGENTVIEW).toContain('{token && !queueLoading && queueError && !agentProfile && (');
    // …and the Hub renders the same failure inline when the Hub is already
    // open. BATCH 4 moved that JSX into AgentHub, so it is asserted there and
    // it reaches the state through props.
    expect((AGENTHUB.match(/\{props\.queueError && \(/g) ?? []).length).toBe(1);
  });

  it('the queue response body is read defensively before the failure branch', () => {
    // A non-JSON body (proxy error page) must not throw past the failure handling.
    expect(AGENTVIEW).toContain('data = await response.json();');
    expect(AGENTVIEW).toContain('data = null;');
  });

  it('the vetting-pending screen is no longer reachable from a failed request', () => {
    expect(AGENTVIEW).toContain("{token && agentStatus === 'pending' && !queueError && !queueLoading && (");
    // …and there is a dedicated pre-answer loading state instead.
    expect(AGENTVIEW).toContain('{token && queueLoading && !agentProfile && !queueError && (');
    expect(AGENTVIEW).toContain('const retryQueue = () => {');
  });
});

// ---------------------------------------------------------------------------
// Test 3 — F-2 / F-3: dead state and dead construction are gone
// ---------------------------------------------------------------------------
describe('B3-F2/F3: dead handover input and dead registration payload removed', () => {
  it('handoverCodeInput no longer exists as a binding or a rendered control', () => {
    expect(AGENTVIEW).not.toMatch(/const \[handoverCodeInput/);
    expect(AGENTVIEW).not.toContain('setHandoverCodeInput');
    expect(AGENTVIEW).not.toContain('Enter Handover Code (CLM-');
    // …while the REAL handover action and its pickup-code dialog are untouched.
    expect(AGENTVIEW).toContain("fetch('/api/agents/confirm-handover'");
    expect(AGENTVIEW).toContain('const [pickupCodeModal, setPickupCodeModal] = useState<{');
    expect(AGENTVIEW).toContain('handleConfirmHandover');
  });

  it('handleAuthRequest no longer builds an unused registration payload', () => {
    expect(AGENTVIEW).not.toContain('const payload: any = { phone };');
    expect(AGENTVIEW).not.toContain('payload.businessName');
    // The OTP request still sends exactly what it always did…
    expect(AGENTVIEW).toContain("body: JSON.stringify({ phone }),");
    // …and registration data still travels with OTP verification, unchanged.
    expect(AGENTVIEW).toContain("fetch('/api/auth/verify-otp'");
    expect(AGENTVIEW).toContain('businessName,');
    expect(AGENTVIEW).toContain('termsAccepted: agreedTerms,');
    expect(AGENTVIEW).toContain('shopPhotoBase64,');
    expect(AGENTVIEW).toContain('idDocumentPhotoBase64,');
  });
});

// ---------------------------------------------------------------------------
// Test 4 — F-4: truthful claim status display (behavioural)
// ---------------------------------------------------------------------------
describe('B3-F4: the agent-side claim badge is truthful for every delivered status', () => {
  it('disputed and released are NOT labelled "Awaiting Payment"', () => {
    expect(agentClaimBadge('disputed', 'en').label).not.toBe('Awaiting Payment');
    expect(agentClaimBadge('released', 'en').label).not.toBe('Awaiting Payment');
    // …they carry the SHARED map's own wording, not a second invented vocabulary.
    expect(agentClaimBadge('disputed', 'en').label).toBe(getClaimStatusDisplay('disputed', 'en').label);
    expect(agentClaimBadge('released', 'en').label).toBe(getClaimStatusDisplay('released', 'en').label);
  });

  it('every status the queue endpoint can attach is labelled, in both languages', () => {
    // These five are exactly the statuses GET /api/agents/queue will attach an
    // associatedClaim for (see server.ts's filter).
    const delivered = ['awaiting_agent_confirmation', 'escrow_held', 'pending_payment', 'released', 'disputed'];
    for (const status of delivered) {
      for (const lang of ['en', 'sw'] as const) {
        const badge = agentClaimBadge(status, lang);
        expect(badge.label, `${status}/${lang} has no label`).toBeTruthy();
        expect(badge.className, `${status}/${lang} has no styling`).toBeTruthy();
      }
    }
    // The two actionable statuses keep agent-specific wording.
    expect(agentClaimBadge('awaiting_agent_confirmation', 'en').label).toBe('Awaiting Verification');
    expect(agentClaimBadge('escrow_held', 'en').label).toBe('Escrow Held (Ready)');
  });

  it('an unknown status degrades to a neutral label rather than a payment claim', () => {
    const unknown = agentClaimBadge('some_future_status', 'en');
    expect(unknown.label).toBe(getClaimStatusDisplay('some_future_status', 'en').label);
    expect(unknown.label).not.toBe('Awaiting Payment');
    // custody with no claim at all is not "awaiting payment" either
    //
    // PHASE 16.1 BATCH 4B-1 (B2) - the fallback wording CHANGED deliberately.
    // An absent `associatedClaim` is not proof that no claim exists: GET
    // /api/agents/queue attaches it for five statuses only, so a claim in
    // pending_verification / payment_window_expired / rejected / refunded arrives
    // with no claim attached. "No Claim Yet" asserted that absence; the label now
    // reports only the missing information. The five delivered-status labels and
    // the neutral styling are unchanged.
    expect(agentClaimBadge(undefined, 'en').label).toBe('No Claim Information');
    expect(agentClaimBadge(null, 'sw').label).toBe('Hakuna Taarifa ya Dai');
    expect(agentClaimBadge(undefined, 'en').label).not.toBe('No Claim Yet');
    expect(agentClaimBadge(undefined, 'en').className).toBe('bg-stone-100 text-stone-800');
  });

  it('the shared status map still covers the whole lifecycle vocabulary', () => {
    for (const status of CLAIM_STATUS_VALUES) {
      const en = getClaimStatusDisplay(status, 'en');
      const sw = getClaimStatusDisplay(status, 'sw');
      expect(en.label, `${status} missing EN label`).toBeTruthy();
      expect(sw.label, `${status} missing SW label`).toBeTruthy();
      // A raw snake_case token means the shared map lost an entry.
      expect(en.label).not.toBe(status);
    }
  });

  it('the old blanket "Awaiting Payment" fallback is gone from the Hub surface', () => {
    expect(HUB).not.toContain('Awaiting Payment');
    expect(HUB).toContain('agentClaimBadge(item.associatedClaim?.status,');
    // Informational (action-less) explanation exists for the two non-actionable
    // delivered statuses — no invented action, no invented endpoint.
    expect(HUB).toContain("item.associatedClaim?.status === 'disputed'");
    expect(HUB).toContain("item.associatedClaim?.status === 'released'");
  });
});

// ---------------------------------------------------------------------------
// Test 5 — F-6: the confirmation modal awaits its action
// ---------------------------------------------------------------------------
describe('B3-F6: the confirm modal resolves before it closes', () => {
  it('onConfirm resolves to a boolean, so success and failure are distinguishable', () => {
    expect(AGENTVIEW).toContain('onConfirm: () => Promise<boolean>;');
    expect(AGENTVIEW).toContain('return true;');
    expect(AGENTVIEW).toContain('return false;');
  });

  it('the dialog awaits the action and closes ONLY on success', () => {
    expect(AGENTVIEW).toContain('const ok = await confirmModal.onConfirm();');
    expect(AGENTVIEW).toContain('if (ok) setConfirmModal(null);');
    // The old shape: fire, then close unconditionally on the very next line.
    expect(AGENTVIEW).not.toContain('confirmModal.onConfirm();\n                  setConfirmModal(null);');
  });

  it('duplicate submission is guarded in the UI while the SERVER stays authoritative', () => {
    expect(AGENTVIEW).toContain('const [modalBusy, setModalBusy] = useState(false);');
    expect(AGENTVIEW).toContain('if (modalBusy) return;');
    expect(AGENTVIEW).toContain('aria-busy={modalBusy}');
    // The real protections are untouched in server.ts — see Test 9.
    expect(SERVER).toContain("return res.status(409).json({ error: settlement.message ||");
  });
});

// ---------------------------------------------------------------------------
// Test 6 — H-1 / M-6: one category source, no private fetch
// ---------------------------------------------------------------------------
describe('B3-H1: AgentView reads the App-level category source', () => {
  it('AgentView no longer owns a category list or fetches /api/categories', () => {
    expect(AGENTVIEW).not.toMatch(/const \[categories, setCategories\]/);
    expect(AGENTVIEW).not.toContain("fetch('/api/categories')");
    expect(AGENTVIEW).not.toContain('setCategories(');
  });

  it('AgentView receives the categories and the EXISTING refresh callback as props', () => {
    expect(AGENTVIEW).toContain('categories: any[];');
    expect(AGENTVIEW).toContain('refreshCategories?: () => void;');
    expect(AGENTVIEW).toContain('categories, refreshCategories }');
    // The refresh is the App-level mechanism, not a new one.
    expect(AGENTVIEW).toContain('refreshCategories?.();');
  });

  it('App supplies BOTH props at BOTH AgentView render sites', () => {
    const sites = APP.match(/<AgentView[\s\S]*?\/>/g) ?? [];
    expect(sites).toHaveLength(2);
    for (const site of sites) {
      expect(site).toContain('categories={categories}');
      expect(site).toContain('refreshCategories={fetchCategories}');
    }
  });

  it('App still owns the single fetch, with its retry, and AgentView did not add one', () => {
    expect(APP).toContain("const [categories, setCategories] = useState<any[]>([]);");
    expect(APP).toContain('const fetchCategories = useCallback(async (attempt = 1) => {');
    expect(APP).toContain("fetch('/api/categories')");
    expect(APP).toContain('setTimeout(() => fetchCategories(attempt + 1), 3000);');
    // The admin refresh path introduced by Batch 1A is intact.
    expect(APP).toContain('onCategoriesChanged={fetchCategories}');
    // Exactly two /api/categories call sites in App (the one fetch definition and
    // …it is one). AgentView contributing a second is what this batch removed.
    expect((APP.match(/fetch\('\/api\/categories'\)/g) ?? []).length).toBe(1);
  });

  it('the public category endpoint itself is unchanged (active-only, public DTO)', () => {
    const routes = read('src/routes/categories.ts');
    expect(routes).toContain("app.get('/api/categories'");
    expect(routes).toContain('await db.getActiveCategories()');
    expect(routes).toContain('toPublicCategoryView');
  });
});

// ---------------------------------------------------------------------------
// Test 7 — A-2: programmatic label association in the verification panel
// ---------------------------------------------------------------------------
describe('B3-A2: verification controls are programmatically labelled', () => {
  const pairs: Array<[string, string]> = [
    ['agent-verify-category', 'Category'],
    ['agent-verify-description', 'Description'],
    ['agent-verify-reason', 'Reason for correction'],
    ['agent-verify-reason-detail', 'Correction reason detail'],
    ['agent-verify-doc-name', 'Name on document'],
    ['agent-verify-doc-number', 'Document number'],
  ];

  it('every named control has an htmlFor pointing at its own id', () => {
    for (const [id, label] of pairs) {
      expect(HUB, `${label} label missing htmlFor`).toContain(`htmlFor="${id}"`);
      expect(HUB, `${id} control missing id`).toContain(`id="${id}"`);
    }
  });

  it('the pre-existing exact-place field keeps its P14C-5B association intact', () => {
    expect(HUB).toContain('htmlFor="agent-verify-exact-place"');
    expect(HUB).toContain('id="agent-verify-exact-place"');
    expect(HUB).toContain("'agent-verify-exact-place-finder-note'");
  });

  it('no verification label is left as a bare proximity label', () => {
    // The four defect labels had NO htmlFor at all.
    expect(HUB).not.toContain('<label className="text-[10px] font-bold text-stone-500 uppercase block">Category</label>');
    expect(HUB).not.toContain('<label className="text-[10px] font-bold text-stone-500 uppercase block">Description</label>');
    expect(HUB).not.toContain('<label className="text-[10px] font-bold text-stone-500 uppercase block">Reason for correction</label>');
  });
});

// ---------------------------------------------------------------------------
// Test 8 — A-6 / A-7 / A-8
// ---------------------------------------------------------------------------
describe('B3-A6/A7/A8: busy state, media name, dialog semantics', () => {
  it('A-6: asynchronous action controls expose aria-busy, not every button', () => {
    const busy = HUB.match(/aria-busy=\{/g) ?? [];
    // lookup, verify submit, reject submit, confirm-viewing, handover, modal confirm,
    // plus the two retry controls.
    expect(busy.length).toBeGreaterThanOrEqual(7);
    for (const anchor of ['aria-busy={actionProcessing}', 'aria-busy={modalBusy}']) {
      expect(HUB).toContain(anchor);
    }
    // Spinners inside those controls are decorative.
    expect(AGENTVIEW).toContain('aria-hidden={true}');
  });

  it('A-7: the camera preview has an accessible name', () => {
    const video = HUB.slice(HUB.indexOf('<video'));
    expect(video.slice(0, 400)).toContain('aria-label=');
    expect(AGENTVIEW).toContain("? 'Live camera preview of the claimant with the item'");
    // capture still works exactly as before
    expect(AGENTVIEW).toContain('const captureHandoverFrame = () => {');
    expect(AGENTVIEW).toContain("canvas.toDataURL('image/jpeg')");
  });

  it('A-8: both modals are real dialogs with a name and a focusable container', () => {
    expect((AGENTVIEW.match(/role="dialog"/g) ?? []).length).toBe(2);
    expect((AGENTVIEW.match(/aria-modal="true"/g) ?? []).length).toBe(2);
    expect((AGENTVIEW.match(/aria-labelledby=/g) ?? []).length).toBe(2);
    expect(AGENTVIEW).toContain('aria-labelledby="agent-confirm-modal-title"');
    expect(AGENTVIEW).toContain('aria-labelledby="agent-handover-modal-title"');
    expect(AGENTVIEW).toContain('id="agent-confirm-modal-title"');
    expect(AGENTVIEW).toContain('id="agent-handover-modal-title"');
    expect((AGENTVIEW.match(/tabIndex=\{-1\}/g) ?? []).length).toBe(2);
    expect((AGENTVIEW.match(/ref=\{dialogRef\}/g) ?? []).length).toBe(2);
  });

  it('A-8: Escape dismisses, and focus is captured then restored', () => {
    expect(AGENTVIEW).toContain("const dialogRef = useRef<HTMLDivElement | null>(null);");
    expect(AGENTVIEW).toContain('const previouslyFocusedRef = useRef<HTMLElement | null>(null);');
    expect(AGENTVIEW).toContain("if (event.key === 'Escape')");
    expect(AGENTVIEW).toContain('document.addEventListener(\'keydown\', onKeyDown);');
    expect(AGENTVIEW).toContain('document.removeEventListener(\'keydown\', onKeyDown);');
    expect(AGENTVIEW).toContain('previouslyFocusedRef.current?.focus?.();');
    expect(AGENTVIEW).toContain('dialogRef.current?.focus();');
    // Escape must not bypass an in-flight action.
    expect(AGENTVIEW).toContain('if (modalBusy) return;');
    // …and no THIRD modal primitive was introduced.
    expect((AGENTVIEW.match(/fixed inset-0 z-\[100\]/g) ?? []).length).toBe(2);
  });

  it('A-1: the operational channel announces, the success channel announces politely', () => {
    expect(AGENTVIEW).toContain('role="alert"');
    expect(AGENTVIEW).toContain('aria-live="assertive"');
    expect(AGENTVIEW).toContain('role="status"');
    expect(AGENTVIEW).toContain('aria-live="polite"');
  });
});

// ---------------------------------------------------------------------------
// Test 9 — the server invariants this batch must not have touched
// ---------------------------------------------------------------------------
describe('B3-invariants: server authorization, ordering and projection are intact', () => {
  const SERVER_CODE = stripComments(SERVER);

  it('every /api/agents route still mounts authenticateJWT + requireActiveAgent', () => {
    const guarded = SERVER.match(
      /app\.(?:get|post)\('\/api\/agents[^']*',\s*authenticateJWT,\s*requireActiveAgent/g
    ) ?? [];
    expect(guarded).toHaveLength(6);
    // The middleware still re-loads the agent and requires it to be actionable.
    expect(SERVER).toContain('function requireActiveAgent(req: Request, res: Response, next: NextFunction) {');
    expect(SERVER).toContain("if (req.user?.role !== 'agent' || !req.user.agentId) {");
    expect(SERVER).toContain('if (!isAgentActionable(agent)) {');
    // The client is never the trust boundary for identity.
    const view = read('src/components/AgentView.tsx');
    expect(view).not.toContain('agentId');
  });

  it('per-route ownership is still enforced against the token, not the request body', () => {
    const ownership = SERVER.match(/item\.assigned_agent_id !== req\.user\.agentId/g) ?? [];
    expect(ownership.length).toBeGreaterThanOrEqual(4);
    expect(SERVER).toContain('req.user.agentId');
  });

  it('verify-before-approve ordering is still enforced server-side', () => {
    expect(SERVER).toContain("if (item.verification_status === 'pending') {");
    expect(SERVER).toContain('if (!item.physically_verified_at) {');
    // …and the verification route still validates the category against the ACTIVE list.
    expect(SERVER).toContain('const resolvedCategory = resolveCategoryId(categoryId, await db.getActiveCategories());');
    // The category guard runs BEFORE the write.
    expect(SERVER.indexOf('const resolvedCategory = resolveCategoryId')).toBeLessThan(
      SERVER.indexOf('await db.recordItemVerification(')
    );
  });

  it('handover still verifies the pickup code BEFORE uploading any photo, and settles via CAS', () => {
    const codeCheck = SERVER.indexOf('timingSafeEqualHex(hashCode(pickupCode.trim()), pickupRecord.code_hash)');
    const upload = SERVER.indexOf("await uploadBase64Image(handoverPhotoBase64, 'handover-evidence')");
    const settle = SERVER.indexOf('await db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS)');
    expect(codeCheck).toBeGreaterThan(-1);
    expect(upload).toBeGreaterThan(codeCheck);
    expect(settle).toBeGreaterThan(upload);
    // The handover photo is still mandatory.
    expect(SERVER).toContain("if (!handoverPhotoBase64 || typeof handoverPhotoBase64 !== 'string' || handoverPhotoBase64.trim() === '') {");
    // The dispute / stolen / legal-hold fail-safe survives.
    expect(SERVER).toContain("claimability.reason === 'suspected_stolen'");
    expect(SERVER).toContain("claimability.reason === 'legal_hold'");
    expect(SERVER).toContain("claimability.reason === 'unresolved_dispute'");
    // The platform pause gate survives.
    expect(SERVER).toContain("isPlatformOperationPaused(pauseSettingKey('handovers'))");
  });

  it('confirm-viewing still uses the atomic CAS and returns a PROJECTED claim', () => {
    expect(SERVER).toContain("expected: ['awaiting_agent_confirmation'],");
    expect(SERVER).toContain("return res.status(viewingTransition.code === 'NOT_FOUND' ? 404 : 409).json({");

    // The projection check must be scoped to THIS route's body. `owner_phone`,
    // `paid_at` and friends are legitimately used by OTHER routes (the owner
    // and customer claim views, /lookup, /pay), so scanning all of server.ts
    // for them would be a false positive — which is exactly what an earlier
    // version of this assertion hit.
    const marker = "app.post('/api/agents/claims/:claimId/confirm-viewing'";
    const start = SERVER_CODE.indexOf(marker);
    expect(start, 'confirm-viewing route not found').toBeGreaterThan(-1);
    const nextRoute = SERVER_CODE.indexOf('app.post(', start + marker.length);
    const body = SERVER_CODE.slice(start, nextRoute > -1 ? nextRoute : undefined);
    expect(body.length).toBeGreaterThan(100);

    // Projected, never the raw row: an explicit object, never `claim: updatedClaim,`.
    expect(body).toContain('claim: updatedClaim');
    expect(body).not.toContain('claim: updatedClaim,');
    expect(body).toContain('id: updatedClaim.id,');
    for (const forbidden of ['owner_id_proof_url', 'owner_phone', 'owner_email', 'payment_reference', 'paid_at']) {
      expect(body, `confirm-viewing leak: ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('the agent queue still projects associatedClaim field-by-field, category-filtered', () => {
    expect(SERVER).toContain('security_answers: toAgentVerificationEvidence(item.category_id');
    expect(SERVER).toContain('owner_identifying_details: associatedClaim.owner_identifying_details || null,');
    // The claim-status filter the UI depends on is unchanged.
    for (const status of ["'escrow_held'", "'released'", "'disputed'", "'awaiting_agent_confirmation'", "'pending_payment'"]) {
      expect(SERVER).toContain(status);
    }
  });

  it('financial semantics are untouched: no payout happens at handover time', () => {
    expect(SERVER).toContain('the actual M-Pesa split disbursement does NOT happen here');
    expect(SERVER).toContain('db.setHandoverPhoto(claimId, handoverPhotoUrl);');
    // The earnings aggregate is still the only earnings surface for the agent.
    expect(SERVER).toContain('const earnings = await db.getAgentEarnings(agentId);');
    const view = read('src/components/AgentView.tsx');
    expect(view).not.toContain('payout_request');
    expect(view).not.toContain('/api/agents/payout');
  });
});


