import React, { useState, useEffect, useRef, useMemo } from 'react';
import { translations } from '../types';
// PART C — the category form previews the finder/agent/platform split with the
// SAME authoritative engine the server uses, so the numbers an admin sees in
// the console are the numbers the claim will actually be priced from.
import { computeRecoveryFee } from '../services/feeEngine';
import { ShieldCheck, BarChart2, Users, FileCheck, Coins, HelpCircle, Loader2, ArrowRight, AlertTriangle, RefreshCw, CheckCircle, ShieldAlert, Copy, Package, ClipboardList, FileSearch, X } from 'lucide-react';
// BATCH 1 (shared admin visual language) — the console reuses the SAME design
// system every other surface uses. These are presentation primitives only:
// they hold no data, make no requests and change no behaviour.
import Button from './ui/Button';
import Badge from './ui/Badge';
import Banner from './ui/Banner';
import EmptyState from './ui/EmptyState';
import Spinner from './ui/Spinner';
import Textarea from './ui/Textarea';
import Select from './ui/Select';
import Input from './ui/Input';
import StatCard from './ui/StatCard';
// UX-15A/B — the UX-01 icon ladder, exported from the shared foundation, so the
// authenticated states and the console chrome size every icon from one place.
import { ICON_SIZE } from './ui';
// P1-01: the refund reconciliation confirmation uses the SHARED modal, which
// already provides focus trapping, Escape-to-cancel, focus restoration and
// aria-modal semantics. No second dialog component was introduced.
import Modal from './ui/Modal';
// UX-15H — the image lightbox keeps its own specialized presentation (see the
// audit comment above the viewer itself), but it adopts the SAME overlay
// mechanism the shared `Modal` uses — a portal to `document.body` — and the
// SAME focus-trap util (`utils/modalFocus.ts`), so the codebase still has
// exactly one portal target and exactly one focus trap.
import { createPortal } from 'react-dom';
import { trapModalFocus } from '../utils/modalFocus';
// Phase 6F — Claims Administration lives in its own module so this view stays
// integration/navigation only. The Claims surface is read-only and talks to the
// 6E API through that module; it never imports the database or the DTO layer.
import ClaimsAdministration from './admin/claims/ClaimsAdministration';
// PHASE 11A: read-only lost-report visibility for administrators.
import LostReportsAdministration from './admin/lostReports/LostReportsAdministration';
// §10 — the console states who is signed in, using ONLY the claims the
// authenticated session actually carries. The helper decodes a display label and
// never returns the token itself (see src/services/adminSession.ts).
import { readAdminSessionIdentity, adminIdentityLabel } from '../services/adminSession';
// P14A (P14-05) — the ONE authoritative vocabulary for a category's
// public-recognition masking style. The console offers exactly these values (it
// never re-types the list), and the admin category routes validate against it.
import { PUBLIC_CLUE_STYLES } from '../services/publicRecognition';
// BATCH 2 (2FA enrollment UX) — the QR code is generated LOCALLY in the browser
// from the `otpauthUrl` the server already returned. `qrcode.react` renders a
// React SVG into the existing tree: no canvas, no `dangerouslySetInnerHTML`, no
// external request, no tracking — so the provisioning secret never leaves this
// component's memory.
import { QRCodeSVG } from 'qrcode.react';

// P14A (P14-05) — human-readable labels for the canonical masking styles. Keyed
// by the values in PUBLIC_CLUE_STYLES (the single source); an unmapped value
// falls back to its raw enum name, so a style added to the service can never
// silently vanish from this select.
const PUBLIC_CLUE_STYLE_LABELS: Record<string, string> = {
  none: 'None — never publish a document-number clue',
  national_id: 'National ID — first 2 characters (e.g. 12******)',
  passport: 'Passport — first character only (e.g. A*******)',
  driving_licence: 'Driving licence — first character only (e.g. K*******)',
  card: 'Card — last 4 digits only (e.g. •••• 4821)',
  generic: 'Generic — first character only (e.g. X********)',
};

// BATCH 2 (2FA enrollment UX) — the QR presentation values. Kept OUT of the JSX
// so the code size is a named value rather than a magic literal, and the margin
// is the QR specification's own 4-module quiet zone. Colours stay at the
// library defaults (black on white): maximum scanner contrast in BOTH themes,
// and no palette literal is introduced into the console source.
const TWO_FA_QR_SIZE = 192;
const TWO_FA_QR_MARGIN = 4;

interface AdminViewProps {
  token: string | null;
  setToken: (token: string | null) => void;
  /**
   * PHASE 16.1 BATCH 1A — invoked AFTER a category lifecycle mutation actually
   * succeeds (create, update, activate/deactivate, delete).
   *
   * WHY: the public/reference category list lives in App (it feeds the homepage
   * explorer and the Finder/Owner selects) and App fetches it once per mount.
   * Without this callback an administrator could create a category, return to
   * the homepage, and still see the pre-creation list until a full page reload.
   *
   * The console keeps its OWN local category state (needed for admin item
   * correction) and continues to refresh that directly; this callback exists only
   * to synchronise the App-level list, so no global store is introduced. It is
   * fired only on a successful mutation — never on a failed one — and is never
   * fired for an unrelated admin operation.
   */
  onCategoriesChanged?: () => void;
}

// Presentational panel for ONE claimant in a dispute.
//
// Everything rendered here comes from the API: the claimant's claim id, phone,
// claim status and whether escrow was actually paid. There is no hard-coded
// sample data anywhere in this panel, and no evidence is ever invented — when
// the on-demand evidence endpoint has not been called, returns nothing, or
// fails, this panel says exactly that.
//
// Evidence is matched to the claimant by claim_id (never by array position).
function DisputeClaimantPanel({
  claimant,
  evidenceState,
  roleLabel,
  isWinner,
  onViewPhoto,
}: {
  claimant: { role: string; claim_id: string; owner_phone: string | null; claim_status: string | null; has_paid_escrow: boolean };
  evidenceState?: { loading: boolean; error: string | null; items: any[] | null };
  roleLabel: string;
  isWinner: boolean;
  onViewPhoto: (url: string) => void;
}) {

  const ownEvidence = Array.isArray(evidenceState?.items)
    ? evidenceState!.items.filter((ev: any) => ev?.claim_id === claimant.claim_id)
    : [];

  return (
    <div className={`border rounded-2xl p-4 space-y-2 ${isWinner ? 'border-status-success-border bg-status-success-surface/40' : 'border-[var(--appearance-border)] bg-[var(--appearance-surface-muted)]'}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-caption font-extrabold text-[var(--appearance-text-muted)] uppercase tracking-widest">{roleLabel}</span>
        {isWinner && (
          <Badge variant="success">
            {'Awarded'}
          </Badge>
        )}
      </div>

      <div className="text-caption text-[var(--appearance-text-muted)] space-y-0.5">
        <p>
          <span className="text-[var(--appearance-text-muted)]">{'Phone'}:</span>{' '}
          <b className="text-[var(--appearance-text-primary)]">{claimant.owner_phone || ('not recorded')}</b>
        </p>
        <p>
          <span className="text-[var(--appearance-text-muted)]">Claim:</span>{' '}
          <span className="font-mono font-bold text-[var(--appearance-text-primary)]">{claimant.claim_id || ('not recorded')}</span>
        </p>
        <p>
          <span className="text-[var(--appearance-text-muted)]">{'Claim status'}:</span>{' '}
          <b className="text-[var(--appearance-text-primary)]">{claimant.claim_status || ('unknown')}</b>
        </p>
        <p>
          <span className="text-[var(--appearance-text-muted)]">{'Escrow paid'}:</span>{' '}
          <b className="text-[var(--appearance-text-primary)]">{claimant.has_paid_escrow ? ('Yes') : ('No')}</b>
        </p>
      </div>

      <div className="border-t border-[var(--appearance-border)] pt-2 space-y-1">
        <span className="text-caption font-extrabold text-[var(--appearance-text-muted)] uppercase tracking-widest block">
          {'Submitted evidence'}
        </span>
        {!evidenceState ? (
          <p className="text-caption text-[var(--appearance-text-muted)]">{'Not loaded yet.'}</p>
        ) : evidenceState.loading ? (
          <p className="text-caption text-[var(--appearance-text-muted)]" aria-busy="true">{'Loading evidence…'}</p>
        ) : evidenceState.error ? (
          <p className="text-caption text-status-danger">
            {'Evidence could not be loaded: '}{evidenceState.error}
          </p>
        ) : ownEvidence.length === 0 ? (
          <p className="text-caption text-[var(--appearance-text-muted)]">{'No evidence available.'}</p>
        ) : (
          <ul className="space-y-2">
            {ownEvidence.map((ev: any) => (
              <li key={ev.id} className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-xl p-2 space-y-1">
                <p className="text-caption text-[var(--appearance-text-muted)]">
                  {ev.created_at ? new Date(ev.created_at).toLocaleString() : ''}
                </p>
                {ev.evidence_text && (
                  <p className="text-caption text-[var(--appearance-text-primary)] whitespace-pre-wrap break-words">{ev.evidence_text}</p>
                )}
                {ev.evidence_photo_url && (
                  // The opener is a real button, exactly like the console's other
                  // three photo openers (the shop-photo and ID-document
                  // disclosures and the item thumbnail): a pointer target that an
                  // admin can also reach with Tab and fire with Enter or Space.
                  // Until the UX-15 closure audit this was the one lightbox
                  // trigger with no keyboard route at all — the image was the
                  // click target and nothing else.
                  <div
                    onClick={() => onViewPhoto(ev.evidence_photo_url)}
                    className="cursor-zoom-in"
                    role="button"
                    tabIndex={0}
                    aria-label={'View evidence photograph full-size'}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onViewPhoto(ev.evidence_photo_url);
                      }
                    }}
                  >
                    <img
                      src={ev.evidence_photo_url}
                      alt={'Evidence photograph submitted with this claim'}
                      referrerPolicy="no-referrer"
                      className="w-full max-h-40 object-contain rounded-lg border border-[var(--appearance-border)]"
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}


// Console section metadata, keyed by the EXISTING activeTab union. This is the
// ONE place the console's page-level <h1> and its supporting description come
// from; nothing about a section's data, permissions or behaviour is derived
// from it. Kept as one table rather than twenty literals so the heading, the
// description and the navigation label for a section cannot drift apart.
type ConsoleSectionKey =
  | 'stats' | 'agents' | 'found_items' | 'disputes' | 'claims'
  | 'lost_reports' | 'ledger' | 'review' | 'categories' | 'strikes';
interface ConsoleSectionCopy { title: string; description: string }
const CONSOLE_SECTIONS: Record<ConsoleSectionKey, ConsoleSectionCopy> = {
  stats: { title: 'Overview', description: 'Monitor platform activity, recovery performance, and operational health.' },
  agents: { title: 'Agents Hub', description: 'Review agent activity, verification, and operational status.' },
  found_items: { title: 'Found Items', description: 'Review recovered items and their current recovery state.' },
  disputes: { title: 'Disputes', description: 'Investigate claims requiring administrative resolution.' },
  claims: { title: 'Claims', description: 'Monitor and administer active and completed recovery claims.' },
  lost_reports: { title: 'Lost Reports', description: 'Review submitted lost-item reports and their discovery status.' },
  ledger: { title: 'Ledger', description: 'Review settlement and financial ledger activity.' },
  review: { title: 'Manual Review', description: 'Review operational items requiring administrative attention.' },
  categories: { title: 'Categories & Fees', description: 'Configure recovery categories, fees, and finder/agent/platform allocation.' },
  strikes: { title: 'Payment Strikes', description: 'Review agent strikes and enforcement history.' },
};

export default function AdminView({ token, setToken, onCategoriesChanged }: AdminViewProps) {
  const t = translations.en;
  // BATCH 2 — the file's own bilingual shorthand (see DisputeClaimantPanel),
  // used by the 2FA enrollment UX below so its long English/Swahili strings stay
  // readable in JSX.


  // §10 — the active administrator, derived from the session on every render so
  // it follows a login, a refresh and a sign-out. Display-only: it makes no
  // authorisation decision (the server does that on every request).
  const adminIdentity = readAdminSessionIdentity(token);
  const adminLabel = adminIdentityLabel(adminIdentity);

  // Passcode verification states
  const [username, setUsername] = useState('');
  const [passcode, setPasscode] = useState('');
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  // Dashboard Stats & Lists states
  const [activeTab, setActiveTab] = useState<'stats' | 'agents' | 'disputes' | 'ledger' | 'review' | 'categories' | 'strikes' | 'found_items' | 'claims' | 'lost_reports'>('stats');
  const [dashboardData, setDashboardData] = useState<any | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  // Guards against duplicate concurrent /api/admin/dashboard fetches (e.g. the
  // login-time fetch overlapping a refetch triggered by entering the Agents tab
  // while a request is already in flight). fetchDashboardData() returns early if
  // a fetch is already running; the flag is cleared in its finally block.
  const dashboardFetchInFlightRef = useRef(false);
  const [dataError, setDataError] = useState('');
  const [actionSuccess, setActionSuccess] = useState('');
  const [actionWarning, setActionWarning] = useState('');

  // Emergency pause controls: reports/claims/payments/payouts/handovers,
  // alongside the pre-existing social-publishing pause above. Fetched
  // separately from dashboardData since it's its own small, fast,
  // admin-only endpoint (GET /api/admin/settings/pause-status) rather than
  // folded into the heavier dashboard payload.
  const [pauseStatuses, setPauseStatuses] = useState<Record<string, boolean> | null>(null);

  // Refund reconciliation (A1 unknown-outcome workflow): claims locked in
  // 'refunding' whose provider outcome is UNKNOWN. Safe (never auto-retried)
  // but must be manually reconciled by an admin against the provider.
  const [refundReconcileItems, setRefundReconcileItems] = useState<any[] | null>(null);
  const [refundReconcileLoading, setRefundReconcileLoading] = useState(false);
  const [refundReconcileProcessing, setRefundReconcileProcessing] = useState<string | null>(null);

  // On-demand dispute evidence, keyed by dispute id.
  //
  // Evidence (free-text statements and photos submitted by either claimant) is
  // deliberately NOT part of the bulk dashboard payload — it is fetched from
  // the admin-only GET /api/admin/disputes/:id/evidence endpoint only for the
  // disputes an administrator actually opens. Nothing here is ever fabricated:
  // an empty array means "no evidence was submitted", a null value with a
  // non-null error means "we do not know", and the UI states exactly that.
  const [disputeEvidence, setDisputeEvidence] = useState<Record<string, { loading: boolean; error: string | null; items: any[] | null }>>({});

  // Admin 2FA enrollment (Security section, stats tab)
  const [twoFaSetupData, setTwoFaSetupData] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [twoFaConfirmCode, setTwoFaConfirmCode] = useState('');
  // Password re-entry required to BEGIN 2FA enrollment (server verified). Kept
  // separate from the disable password so the two flows never share a value.
  const [twoFaStartPassword, setTwoFaStartPassword] = useState('');
  const [twoFaDisablePassword, setTwoFaDisablePassword] = useState('');
  const [twoFaShowDisableForm, setTwoFaShowDisableForm] = useState(false);
  const [twoFaProcessing, setTwoFaProcessing] = useState(false);
  const [twoFaMessage, setTwoFaMessage] = useState('');
  const [twoFaError, setTwoFaError] = useState('');
  const [adminTotpEnabled, setAdminTotpEnabled] = useState(false);
  // BATCH 2 — whether the password re-entry step is revealed. ONE flag serves
  // both first-time enablement and replacement enrollment; the copy differs, the
  // behaviour does not, and the server is what actually re-verifies the password.
  const [twoFaShowEnrollForm, setTwoFaShowEnrollForm] = useState(false);
  // BATCH 2 — the one-time recovery codes returned by /confirm. They live ONLY
  // in this component's memory, and only until the administrator acknowledges
  // them. `null` means "no enrollment is awaiting acknowledgement".
  const [twoFaRecoveryCodes, setTwoFaRecoveryCodes] = useState<string[] | null>(null);
  // BATCH 2 — which clipboard action last succeeded ('secret' | 'codes' | '').
  // Only one confirmation shows at a time, and a clipboard FAILURE is tracked in
  // its own state so it can never be mistaken for a success.
  const [twoFaCopied, setTwoFaCopied] = useState('');
  const [twoFaCopyError, setTwoFaCopyError] = useState('');
  const [paymentStrikes, setPaymentStrikes] = useState<any[]>([]);
  const [paymentStrikesLoading, setPaymentStrikesLoading] = useState(false);

  // New States for Agents Directory & Found Items Tabs
  const [agentSearch, setAgentSearch] = useState('');
  const [agentStatusFilter, setAgentStatusFilter] = useState('all');
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);

  // Agent verification photographs (shop front + national ID document) are
  // sensitive vetting evidence and are deliberately NOT part of the bulk
  // /api/admin/dashboard payload. They are fetched on demand for one agent at
  // a time, when that agent's row is expanded.
  const [agentDocs, setAgentDocs] = useState<{ id: string; business_name: string; shop_photo_url: string | null; id_document_photo_url: string | null } | null>(null);
  const [agentDocsLoading, setAgentDocsLoading] = useState<string | null>(null);
  const [agentDocsError, setAgentDocsError] = useState<string | null>(null);

  const [itemSearch, setItemSearch] = useState('');
  const [itemStatusFilter, setItemStatusFilter] = useState('all');
  const [itemCategoryFilter, setItemCategoryFilter] = useState('all');
  const [itemFlagFilter, setItemFlagFilter] = useState('all');
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const lightboxCloseRef = useRef<HTMLDivElement | null>(null);

  // The lightbox previously only closed via a mouse click on the backdrop —
  // no Escape key, and nothing to receive that keypress anyway since focus
  // never moved into the dialog when it opened. Moving focus onto the
  // backdrop here means Escape (wired via onKeyDown on that div below)
  // actually reaches a listener, and a keyboard-only admin isn't stuck
  // once they've opened a full-size photo.
  //
  // UX-15H finished that work, in the shared primitive's own order: the opener
  // is remembered so closing the viewer puts focus back on the thumbnail (or
  // evidence photo) it was opened from, and body scroll is locked with
  // scrollbar compensation while it is open (the veil is opaque and full
  // screen, so an unlocked page would only drift invisibly behind the photo
  // and the console would have jumped by the time the viewer closed). This is
  // the `Modal`'s lifecycle, not a second focus system: the Tab trap itself is
  // the shared `trapModalFocus` util, wired to this same container.
  useEffect(() => {
    if (!lightboxImage) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    lightboxCloseRef.current?.focus();

    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    const previousOverflow = document.body.style.overflow;
    const previousPaddingRight = document.body.style.paddingRight;
    document.body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) document.body.style.paddingRight = `${scrollbarWidth}px`;

    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.style.paddingRight = previousPaddingRight;
      previouslyFocused?.focus?.();
    };
  }, [lightboxImage]);


  // Categories loading for admin corrections
  const [categories, setCategories] = useState<any[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState<boolean>(true);

  // Admin Categories List & Form states
  const [adminCategories, setAdminCategories] = useState<any[]>([]);
  const [adminCategoriesLoading, setAdminCategoriesLoading] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<any | null>(null);
  const [showCategoryForm, setShowCategoryForm] = useState<'create' | 'edit' | null>(null);

  const [catFormId, setCatFormId] = useState('');
  const [catFormNameEn, setCatFormNameEn] = useState('');
  const [catFormNameSw, setCatFormNameSw] = useState('');
  const [catFormTotalFee, setCatFormTotalFee] = useState(0);
  const [catFormFinderShare, setCatFormFinderShare] = useState(0);
  const [catFormAgentShare, setCatFormAgentShare] = useState(0);
  const [catFormPlatformShare, setCatFormPlatformShare] = useState(0);
  const [catFormIsSensitive, setCatFormIsSensitive] = useState(true);
  const [catSaving, setCatSaving] = useState(false);
  // Recovery Fee Engine config (src/services/feeEngine.ts) — ignored by the
  // engine when is_admin_modified is true, in which case the flat total_fee/
  // finder_share/agent_share/platform_share above are used verbatim instead.
  const [catFormBaseFee, setCatFormBaseFee] = useState(0);
  const [catFormComplexityFee, setCatFormComplexityFee] = useState(0);
  const [catFormDelayFee, setCatFormDelayFee] = useState(0);
  const [catFormCeilingPercent, setCatFormCeilingPercent] = useState(12);
  const [catFormFinderPct, setCatFormFinderPct] = useState(25);
  const [catFormAgentPct, setCatFormAgentPct] = useState(35);
  const [catFormPlatformPct, setCatFormPlatformPct] = useState(40);
  const [catFormFinderRewardCap, setCatFormFinderRewardCap] = useState<string>('');
  const [catFormElevatedReview, setCatFormElevatedReview] = useState(false);
  const [catFormIsAdminModified, setCatFormIsAdminModified] = useState(false);
  // P14A (P14-05) — public-recognition masking style (canonical enum value).
  // 'generic' is the DB column's own default.
  const [catFormPublicClueStyle, setCatFormPublicClueStyle] = useState<string>('generic');

  const resetCategoryForm = (mode: 'create' | 'edit', cat?: any) => {
    setShowCategoryForm(mode);
    if (mode === 'create') {
      setCatFormId('');
      setCatFormNameEn('');
      setCatFormNameSw('');
      setCatFormTotalFee(0);
      setCatFormFinderShare(0);
      setCatFormAgentShare(0);
      setCatFormPlatformShare(0);
      setCatFormIsSensitive(true);
      setCatFormBaseFee(0);
      setCatFormComplexityFee(0);
      setCatFormDelayFee(0);
      setCatFormCeilingPercent(12);
      setCatFormFinderPct(25);
      setCatFormAgentPct(35);
      setCatFormPlatformPct(40);
      setCatFormFinderRewardCap('');
      setCatFormElevatedReview(false);
      setCatFormIsAdminModified(false);
      setCatFormPublicClueStyle('generic');
      setSelectedCategory(null);
    } else if (mode === 'edit' && cat) {
      setCatFormId(cat.id);
      setCatFormNameEn(cat.name_en);
      setCatFormNameSw(cat.name_sw);
      setCatFormTotalFee(typeof cat.total_fee === 'string' ? parseFloat(cat.total_fee) : cat.total_fee);
      setCatFormFinderShare(typeof cat.finder_share === 'string' ? parseFloat(cat.finder_share) : cat.finder_share);
      setCatFormAgentShare(typeof cat.agent_share === 'string' ? parseFloat(cat.agent_share) : cat.agent_share);
      setCatFormPlatformShare(typeof cat.platform_share === 'string' ? parseFloat(cat.platform_share) : cat.platform_share);
      setCatFormIsSensitive(cat.is_sensitive_document || false);
      setCatFormBaseFee(cat.base_fee !== undefined && cat.base_fee !== null ? Number(cat.base_fee) : 0);
      setCatFormComplexityFee(cat.complexity_fee !== undefined && cat.complexity_fee !== null ? Number(cat.complexity_fee) : 0);
      setCatFormDelayFee(cat.delay_fee !== undefined && cat.delay_fee !== null ? Number(cat.delay_fee) : 0);
      setCatFormCeilingPercent(cat.ceiling_percent !== undefined && cat.ceiling_percent !== null ? Number(cat.ceiling_percent) : 12);
      setCatFormFinderPct(cat.finder_pct !== undefined && cat.finder_pct !== null ? Number(cat.finder_pct) : 25);
      setCatFormAgentPct(cat.agent_pct !== undefined && cat.agent_pct !== null ? Number(cat.agent_pct) : 35);
      setCatFormPlatformPct(cat.platform_pct !== undefined && cat.platform_pct !== null ? Number(cat.platform_pct) : 40);
      setCatFormFinderRewardCap(cat.finder_reward_cap !== undefined && cat.finder_reward_cap !== null ? String(cat.finder_reward_cap) : '');
      setCatFormElevatedReview(cat.elevated_review || false);
      setCatFormIsAdminModified(cat.is_admin_modified || false);
      setCatFormPublicClueStyle(cat.public_clue_style || 'generic');
      setSelectedCategory(cat);
    }
  };

  // Manual Review Form states
  const [selectedReviewItem, setSelectedReviewItem] = useState<any | null>(null);
  const [reviewCategoryId, setReviewCategoryId] = useState('national-id');
  const [reviewOcrNumber, setReviewOcrNumber] = useState('');
  const [reviewOcrName, setReviewOcrName] = useState('');
  const [reviewIsDescriptionOnly, setReviewIsDescriptionOnly] = useState(false);
  const [reviewDescription, setReviewDescription] = useState('');
  const [reviewAssignedAgentId, setReviewAssignedAgentId] = useState('');
  const [reviewSaving, setReviewSaving] = useState(false);
  const [adminActionProcessing, setAdminActionProcessing] = useState(false);

  // Confirmation Modal State
  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);

  // ---------------------------------------------------------------------------
  // UX-15G — THE CONFIRMATION DIALOG IS THE SHARED ui/Modal.
  //
  // WHY THIS EXISTS
  //   The overlay every confirmation flow shared was hand-built JSX: no dialog
  //   semantics, no focus management, no Escape handling, and a scrim that could
  //   not be dismissed at all. It is now the SAME shared ui/Modal the refund
  //   reconciliation (P1-01), the item-review reason step (UX-15E) and the
  //   agent-warning reason step (UX-15F) use, so the dialog structure, the focus
  //   trap, focus restoration, Escape and the scrim all come from one primitive.
  //
  // WHAT DID NOT CHANGE
  //   Everything the flows DO. `confirmModal` still stores exactly the title, the
  //   message and the callback each flow already built; no endpoint, method,
  //   payload, authorization, success/error handling, refresh or processing flag
  //   was touched; the confirm control still runs the callback and then dismisses
  //   in that same order; and dismissal still only clears the pending request, so
  //   a cancelled confirmation can never run the callback.
  // ---------------------------------------------------------------------------
  /** The ONE dismissal path. Cancel, the header close control, Escape and the
   *  scrim all route here, and it can only clear the pending request — it never
   *  reaches the stored callback, so no dismissal can confirm anything. */
  const closeConfirmModal = () => setConfirmModal(null);

  /** The ONE confirmation path. It runs the stored callback and then dismisses —
   *  the same two statements in the same order the hand-built overlay used, so
   *  every flow keeps its own loading, refresh and banner handling. */
  const confirmPendingAction = () => {
    if (!confirmModal) return;
    confirmModal.onConfirm();
    setConfirmModal(null);
  };

  // ---------------------------------------------------------------------------
  // PROD BATCH 3 / P1-01 — refund reconciliation confirmation.
  //
  // WHY THIS EXISTS
  //   Both refund-reconciliation outcomes were previously guarded by
  //   `window.confirm(...)`. A browser-native dialog is unstyled, cannot be
  //   translated, blocks the main thread, is not focus-managed, and — most
  //   seriously for a financial action — cannot show a loading state, so an
  //   operator could not tell a finished reconciliation from a stalled one.
  //
  //   It is now the SHARED ui/Modal, which already provides focus trapping,
  //   Escape-to-cancel, focus restoration, `role="dialog"` + `aria-modal`, a
  //   scrollable body and a footer action row. No second modal component was
  //   introduced.
  //
  // WHAT DID NOT CHANGE
  //   The endpoint, the Authorization bearer, the request bodies, the
  //   `refundReconcileProcessing` guard that disables the originating row, the
  //   authoritative refreshes after success, and every server-side rule. Only
  //   HOW the operator confirms changed. No refund business logic was touched.
  // ---------------------------------------------------------------------------
  const [refundConfirm, setRefundConfirm] = useState<null | {
    kind: 'finalize' | 'revert';
    claimId: string;
  }>(null);

  const startReview = (item: any) => {
    setSelectedReviewItem(item);
    setReviewCategoryId(item.category_id || 'national-id');
    setReviewOcrNumber(item.ocr_extracted_number || '');
    setReviewOcrName(item.ocr_extracted_name || '');
    setReviewIsDescriptionOnly(item.isDescriptionOnly || false);
    setReviewDescription(item.description || '');
    setReviewAssignedAgentId(item.assigned_agent_id || '');
  };

  const handleSaveReview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedReviewItem) return;
    setReviewSaving(true);
    setActionSuccess('');
    setActionWarning('');
    setDataError('');

    try {
      const response = await fetch(`/api/admin/items/${selectedReviewItem.id}/review`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          categoryId: reviewCategoryId,
          ocrExtractedNumber: reviewIsDescriptionOnly ? null : reviewOcrNumber,
          ocrExtractedName: reviewIsDescriptionOnly ? null : reviewOcrName,
          isDescriptionOnly: reviewIsDescriptionOnly,
          description: reviewDescription,
          assignedAgentId: reviewAssignedAgentId || undefined,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Review save failed');
      }

      setActionSuccess('Item manual review saved successfully and is now searchable.');
      setSelectedReviewItem(null);
      fetchDashboardData();
    } catch (e: any) {
      setDataError(e.message);
    } finally {
      setReviewSaving(false);
    }
  };

  const fetchDashboardData = async () => {
    if (!token) return;
    // Avoid a duplicate concurrent request (e.g. login fetch + a tab-entry
    // refetch overlapping). The one already in flight is authoritative enough.
    if (dashboardFetchInFlightRef.current) return;
    dashboardFetchInFlightRef.current = true;
    setDataError('');
    setDashboardLoading(true);
    try {
      const response = await fetch('/api/admin/dashboard', {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.status === 401 || response.status === 403) {
        setToken(null);
        setAuthError('Your administrator session has expired or is invalid. Please log in again.'
        );
        return;
      }

      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        throw new Error('The system returned an invalid response. Please try again shortly.'
        );
      }

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch admin statistics.');
      }
      setDashboardData(data);
      setAdminTotpEnabled(!!data.currentAdminTotpEnabled);
    } catch (e: any) {
      setDataError(e.message);
    } finally {
      dashboardFetchInFlightRef.current = false;
      setDashboardLoading(false);
    }
  };

  const fetchPauseStatuses = async () => {
    if (!token) return;
    try {
      const response = await fetch('/api/admin/settings/pause-status', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (response.ok && data.statuses) {
        setPauseStatuses(data.statuses);
      }
    } catch {
      // Non-critical — the dedicated pause toggle buttons below re-fetch
      // this after every successful toggle, and the social-publishing
      // toggle (which already has its own state in dashboardData) is
      // unaffected by this call failing.
    }
  };

  const handleTogglePause = async (scope: string, paused: boolean) => {
    setActionSuccess('');
    setActionWarning('');
    setDataError('');
    setItemActionProcessing('pause:' + scope);
    try {
      const response = await fetch('/api/admin/settings/pause', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ scope, paused }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || `Failed to update ${scope} pause setting`);
      }
      setActionSuccess(data.message || 'Setting updated.');
      fetchPauseStatuses();
    } catch (e: any) {
      setDataError(e.message);
    } finally {
      setItemActionProcessing(null);
    }
  };

  const fetchAdminCategories = async () => {
    if (!token) return;
    setAdminCategoriesLoading(true);
    try {
      const response = await fetch('/api/admin/categories', {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.status === 401 || response.status === 403) {
        setToken(null);
        setAuthError('Your administrator session has expired or is invalid. Please log in again.'
        );
        return;
      }

      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        throw new Error('The system returned an invalid response. Please try again shortly.'
        );
      }

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch admin categories.');
      }
      setAdminCategories(data);
    } catch (e: any) {
      setDataError(e.message);
    } finally {
      setAdminCategoriesLoading(false);
    }
  };

  const handleSaveCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionSuccess('');
    setActionWarning('');
    setDataError('');

    // ID validation for create mode
    if (showCategoryForm === 'create') {
      if (!catFormId || !/^[a-z0-9-]+$/.test(catFormId)) {
        setDataError('ID must be lowercase-kebab-case (e.g., national-id) and cannot be empty.');
        return;
      }
    }

    if (!catFormNameEn.trim() || !catFormNameSw.trim()) {
      setDataError('Both English and Swahili names are required.');
      return;
    }

    const total = parseFloat(Number(catFormTotalFee).toFixed(2));
    const sharesSum = parseFloat((Number(catFormFinderShare) + Number(catFormAgentShare) + Number(catFormPlatformShare)).toFixed(2));

    if (total !== sharesSum) {
      setDataError(`Validation Error: The shares (Finder: KES ${catFormFinderShare} + Agent: KES ${catFormAgentShare} + Platform: KES ${catFormPlatformShare} = KES ${sharesSum}) must exactly equal the Total Fee: KES ${catFormTotalFee}.`);
      return;
    }
    // -------------------------------------------------------------------------
    // PRICING-AUTHORITY GUARD (Issue A) — AN ADMIN MUST NOT "SUCCESSFULLY" EDIT A
    // FLAT PRICE THE NEW-ITEM PRICING PATH IGNORES.
    //
    // THE PRODUCTION SCENARIO THIS BLOCKS: a USB cable category was in RECOVERY
    // FEE ENGINE mode (is_admin_modified = false). Its visible Total Fee was
    // changed from KES 200 to KES 100, the save returned 200 OK, and the admin
    // list showed the new price — yet the next reported item still locked KES
    // 200, because in engine mode the flat Total Fee is not what prices anything.
    // Nothing failed; the admin was simply editing a field that had no effect.
    //
    // The server contract is deliberately unchanged and explicit: is_admin_modified
    // selects the mode, and MODE 2 prices from the engine. So this guard does not
    // flip any state behind the admin's back — it refuses the ambiguous save and
    // says exactly what to do instead (tick the override, or edit the engine
    // fields). The server independently refuses a request that changes the flat
    // prices without stating a mode at all.
    //
    // It only ever fires when the FLAT values actually differ from the values the
    // category was loaded with, so an ordinary edit (name, engine field, masking
    // style) is never blocked.
    // -------------------------------------------------------------------------
    if (showCategoryForm === 'edit' && selectedCategory && !catFormIsAdminModified) {
      const loadedTotal = Number(selectedCategory.total_fee);
      const loadedFinder = Number(selectedCategory.finder_share);
      const loadedAgent = Number(selectedCategory.agent_share);
      const loadedPlatform = Number(selectedCategory.platform_share);
      const flatPricesEdited =
        total !== loadedTotal ||
        parseFloat(Number(catFormFinderShare).toFixed(2)) !== loadedFinder ||
        parseFloat(Number(catFormAgentShare).toFixed(2)) !== loadedAgent ||
        parseFloat(Number(catFormPlatformShare).toFixed(2)) !== loadedPlatform;
      if (flatPricesEdited) {
        setDataError(
          'Save blocked: you changed the flat pricing values (Total / Finder / Agent / Platform) while this category is in MODE 2 — RECOVERY FEE ENGINE, where those flat values are NOT used to price a new item. ' +
          'Tick "Use flat fee override" above to make them authoritative (MODE 1), or undo the flat-value changes and configure the fee with Base / Complexity / Delay instead. ' +
          '/ Uhifadhi umesimamishwa: umebadilisha ada ya kawaida wakati kategoria hii iko kwenye mtindo wa Recovery Fee Engine, ambapo thamani hizo HAZITUMIKI kupanga bei ya bidhaa mpya.'
        );
        return;
      }
    }



    setCatSaving(true);
    try {
      const url = showCategoryForm === 'create'
        ? '/api/admin/categories'
        : `/api/admin/categories/${catFormId}`;
      const method = showCategoryForm === 'create' ? 'POST' : 'PUT';

      const bodyData = {
        id: catFormId,
        name_en: catFormNameEn,
        name_sw: catFormNameSw,
        total_fee: catFormTotalFee,
        finder_share: catFormFinderShare,
        agent_share: catFormAgentShare,
        platform_share: catFormPlatformShare,
        is_sensitive_document: catFormIsSensitive,
        base_fee: catFormBaseFee,
        complexity_fee: catFormComplexityFee,
        delay_fee: catFormDelayFee,
        ceiling_percent: catFormCeilingPercent,
        finder_pct: catFormFinderPct,
        agent_pct: catFormAgentPct,
        platform_pct: catFormPlatformPct,
        finder_reward_cap: catFormFinderRewardCap.trim() === '' ? null : parseFloat(catFormFinderRewardCap),
        elevated_review: catFormElevatedReview,
        is_admin_modified: catFormIsAdminModified,
        public_clue_style: catFormPublicClueStyle,
      };

      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(bodyData),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to save category');
      }

      setActionSuccess(showCategoryForm === 'create'
        ? 'Category created successfully!'
        : 'Category updated successfully!'
      );
      setShowCategoryForm(null);
      fetchAdminCategories();
      // Also sync user categories lists
      const catRes = await fetch('/api/categories');
      const catData = await catRes.json();
      setCategories(catData);
      // PHASE 16.1 BATCH 1A — create OR update succeeded, so the App-level
      // (public/reference) list is now stale: refresh it. Fired only here, after
      // the server confirmed the mutation, so a failed save never triggers it.
      onCategoriesChanged?.();
    } catch (e: any) {
      setDataError(e.message);
    } finally {
      setCatSaving(false);
    }
  };

  const handleDeleteCategory = (id: string, nameEn: string) => {
    setActionSuccess('');
    setActionWarning('');
    setDataError('');

    setConfirmModal({
      title: 'Delete Category',
      message: `Are you sure you want to delete the category "${nameEn}"? This action cannot be undone.`,
      onConfirm: async () => {
        try {
          const res = await fetch(`/api/admin/categories/${id}`, {
            method: 'DELETE',
            headers: {
              Authorization: `Bearer ${token}`,
            },
          });

          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.error || 'Failed to delete category.');
          }

          setActionSuccess('Category deleted successfully!');
          fetchAdminCategories();
          // Also sync user categories lists
          const catRes = await fetch('/api/categories');
          const catData = await catRes.json();
          setCategories(catData);
          // PHASE 16.1 BATCH 1A — the delete succeeded; the App-level list must
          // drop the removed category. Only reached after res.ok.
          onCategoriesChanged?.();
        } catch (e: any) {
          setDataError(e.message);
        }
      }
    });
  };

  /**
   * CAT-04 (Phase 16.1 Batch 2) — activate / deactivate a category.
   *
   * A one-click LIFECYCLE action against
   * PUT /api/admin/categories/:id/active. The SERVER is the authority — this
   * never hides anything client-side — and the endpoint writes exactly one
   * column, so deactivating a category can never disturb its names, fees or any
   * other setting an admin has configured.
   *
   * The public category list is refreshed afterwards because it is active-only:
   * a deactivated category disappears from every "choose a category" surface
   * (Finder, Owner, lost reports, Agent verification) while every historical
   * record that references it stays exactly as it is.
   */
  const handleToggleCategoryActive = async (id: string, nameEn: string, nextActive: boolean) => {
    setActionSuccess('');
    setActionWarning('');
    setDataError('');
    setCatSaving(true);
    try {
      const res = await fetch(`/api/admin/categories/${id}/active`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ is_active: nextActive }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update the category lifecycle state.');
      }

      setActionSuccess(nextActive
        ? (`"${nameEn}" is now active.`)
        : (`"${nameEn}" is now inactive — it can no longer be chosen for new reports. Existing records are unaffected.`));

      fetchAdminCategories();
      // Keep the (active-only) public list in step.
      const catRes = await fetch('/api/categories');
      const catData = await catRes.json();
      setCategories(catData);
      // PHASE 16.1 BATCH 1A — deactivation/reactivation changed which categories
      // are actually selectable, so the App-level list must be refreshed too;
      // otherwise a deactivated category would keep appearing in the homepage
      // explorer and the Finder/Owner selects until a reload. Only reached after
      // res.ok.
      onCategoriesChanged?.();
    } catch (e: any) {
      setDataError(e.message);
    } finally {
      setCatSaving(false);
    }
  };

  useEffect(() => {
    if (token) {
      fetchDashboardData();
      fetchAdminCategories();
      fetchPauseStatuses();
    }
  }, [token]);

  useEffect(() => {
    if (activeTab === 'categories' && token) {
      fetchAdminCategories();
    }
  }, [activeTab]);

  // Keep the Agents directory authoritative. /api/admin/dashboard is fetched on
  // login and after admin mutations, so if a new agent registers (or is
  // approved/suspended) while this admin is ALREADY authenticated, the list can
  // otherwise go stale the moment the admin returns to the Agents tab. Re-pull
  // on tab entry instead of showing a stale/no-longer-accurate agent list.
  // Deps intentionally [activeTab] only (matching the categories effect above):
  // fetch-on-login already covers token changes, and including token here would
  // double-fetch when a login happens while already on the Agents tab.
  useEffect(() => {
    if (activeTab === 'agents' && token) {
      fetchDashboardData();
    }
  }, [activeTab]);

  // Load refund-reconciliation claims when the admin opens the Disputes tab
  // (where these are surfaced) and whenever the admin session changes.
  useEffect(() => {
    if (activeTab === 'disputes' && token) {
      fetchRefundReconciliation();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, token]);

  useEffect(() => {
    const fetchCategories = async () => {
      try {
        setCategoriesLoading(true);
        const res = await fetch('/api/categories');
        const data = await res.json();
        setCategories(data);
      } catch (e) {
        console.error("Failed to fetch categories in AdminView:", e);
      } finally {
        setCategoriesLoading(false);
      }
    };
    fetchCategories();
  }, []);

  const fetchPaymentStrikes = async () => {
    if (!token) return;
    setPaymentStrikesLoading(true);
    setDataError('');
    try {
      const response = await fetch('/api/admin/payment-strikes', {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.status === 401 || response.status === 403) {
        setToken(null);
        setAuthError('Your administrator session has expired or is invalid. Please log in again.'
        );
        return;
      }

      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        throw new Error('The system returned an invalid response. Please try again shortly.'
        );
      }

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch payment strikes.');
      }
      setPaymentStrikes(data.strikes || []);
    } catch (e: any) {
      setDataError(e.message);
    } finally {
      setPaymentStrikesLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'strikes' && token) {
      fetchPaymentStrikes();
    }
  }, [activeTab, token]);

  const handleClearStrikes = (phone: string) => {
    setActionSuccess('');
    setActionWarning('');
    setDataError('');

    setConfirmModal({
      title: 'Clear Payment Strikes',
      message: `Are you sure you want to clear all payment strikes for ${phone}?`,
      onConfirm: async () => {
        setAdminActionProcessing(true);
        try {
          const response = await fetch(`/api/admin/payment-strikes/${phone}/clear`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
          });
          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.error || 'Failed to clear strikes');
          }
          setActionSuccess(data.message || `Cleared payment strikes for ${phone}`);
          fetchPaymentStrikes(); // Reload list
        } catch (e: any) {
          setDataError(e.message);
        } finally {
          setAdminActionProcessing(false);
        }
      }
    });
  };

  // Admin authenticate
  const [pendingTwoFactorToken, setPendingTwoFactorToken] = useState<string | null>(null);
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [twoFactorLoading, setTwoFactorLoading] = useState(false);

  const handleAdminAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    setAuthLoading(true);

    try {
      const response = await fetch('/api/auth/admin-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, passcode }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Incorrect password');
      }

      // Password verified, but this account has 2FA enrolled — the server
      // deliberately withheld the real session token and issued a
      // short-lived pending one instead. Show the code-entry step rather
      // than logging in.
      if (data.requiresTwoFactor) {
        setPendingTwoFactorToken(data.pendingToken);
        return;
      }

      setToken(data.token);
      setAdminTotpEnabled(!!data.profile?.totpEnabled);
    } catch (e: any) {
      setAuthError(e.message);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleTwoFactorVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    setTwoFactorLoading(true);

    try {
      const response = await fetch('/api/auth/admin-login/verify-2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pendingToken: pendingTwoFactorToken, code: twoFactorCode }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Incorrect 2FA code');
      }

      setToken(data.token);
      setAdminTotpEnabled(!!data.profile?.totpEnabled);
      setPendingTwoFactorToken(null);
      setTwoFactorCode('');
    } catch (e: any) {
      setAuthError(e.message);
    } finally {
      setTwoFactorLoading(false);
    }
  };

  // ===========================================================================
  // BATCH 2 — ADMIN 2FA ENROLLMENT UX (QR code + one-time recovery codes)
  // ===========================================================================
  // A status-first translation of a failed 2FA request into copy the
  // administrator can act on. The server's HTTP status is the stable contract;
  // its `error` string (already bilingual, and free of any secret) is used only
  // for the plain 4xx cases. A raw status code, internal identifier or stack
  // trace is never shown.
  const twoFaFailureMessage = (response: Response, fallback: string) => {
    if (response.status === 429) {
      return 'Too many attempts. Please wait a few minutes and try again.';
    }
    if (response.status === 401) {
      return 'That password is not correct.';
    }
    if (response.status === 403) {
      return 'Your administrator session is no longer valid. Please sign in again.';
    }
    if (response.status >= 500) {
      return 'The server could not complete that request. Please try again shortly.';
    }
    return fallback;
  };

  // A stale enrollment is one whose staged secret /confirm can no longer match:
  // the server answers 409 when a concurrent setup or disable replaced it, or
  // 400 with "start again" when no valid pending secret is left. Either way the
  // local provisioning state is discarded, so the console can never keep showing
  // a QR code that corresponds to nothing.
  const isStaleTwoFaEnrollment = (status: number, message: string) =>
    status === 409 || /start (2fa setup first|again)/i.test(message);

  // Every byte of provisioning material is dropped here. Nothing was ever
  // written to storage, a query string, a log or the DOM outside the panel.
  const discardTwoFaProvisioning = () => {
    setTwoFaSetupData(null);
    setTwoFaConfirmCode('');
    setTwoFaStartPassword('');
  };

  // Reveal the password re-entry step. Nothing is requested and no secret exists
  // yet: the server issues one only after the password is re-verified inside
  // handleTwoFaStartSetup below.
  const openTwoFaEnrollForm = () => {
    setTwoFaError('');
    setTwoFaMessage('');
    setTwoFaShowDisableForm(false);
    setTwoFaShowEnrollForm(true);
  };

  // Abandon enrollment: provisioning state, the re-entry password and every
  // clipboard message are cleared.
  const cancelTwoFaEnrollForm = () => {
    setTwoFaShowEnrollForm(false);
    setTwoFaError('');
    setTwoFaCopyError('');
    setTwoFaCopied('');
    discardTwoFaProvisioning();
  };

  // Begin 2FA enrollment: fetch a fresh secret/QR from the server. Nothing
  // is enabled yet — that only happens once handleTwoFaConfirm below
  // succeeds with a real code from the admin's authenticator app.
  const handleTwoFaStartSetup = async () => {
    setTwoFaError('');
    setTwoFaMessage('');
    setTwoFaCopyError('');
    setTwoFaCopied('');
    setTwoFaProcessing(true);
    try {
      const response = await fetch('/api/auth/admin-2fa/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        // Password re-entry: the server requires the current password to begin
        // (re-)enrollment, so a stolen session token alone cannot replace 2FA.
        body: JSON.stringify({ password: twoFaStartPassword }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const serverMessage = typeof data?.error === 'string' ? data.error : '';
        throw new Error(
          twoFaFailureMessage(
            response,
            serverMessage || ('Could not start 2FA setup.')
          )
        );
      }
      // Component state ONLY: never localStorage / sessionStorage / IndexedDB,
      // never a query string, never a log.
      setTwoFaSetupData({ secret: data.secret, otpauthUrl: data.otpauthUrl });
      setTwoFaRecoveryCodes(null);
      setTwoFaStartPassword('');
      setTwoFaShowEnrollForm(false);
    } catch (e: any) {
      // An incorrect password keeps the form open so it can simply be retyped.
      setTwoFaError(e.message);
    } finally {
      setTwoFaProcessing(false);
    }
  };

  const handleTwoFaConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setTwoFaError('');
    setTwoFaMessage('');
    setTwoFaCopyError('');
    setTwoFaCopied('');
    setTwoFaProcessing(true);
    try {
      const response = await fetch('/api/auth/admin-2fa/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ code: twoFaConfirmCode }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const serverMessage = typeof data?.error === 'string' ? data.error : '';
        // A stale / replaced enrollment cannot be recovered by retrying: drop the
        // provisioning state and send the administrator back to step one. The
        // code is never retried automatically.
        if (isStaleTwoFaEnrollment(response.status, serverMessage)) {
          discardTwoFaProvisioning();
          setTwoFaError(
            'This setup is no longer valid. Please start 2FA setup again.'
          );
        } else {
          setTwoFaError(
            twoFaFailureMessage(response, serverMessage || ('Incorrect code.'))
          );
        }
        return;
      }
      setAdminTotpEnabled(true);
      setTwoFaMessage(typeof data?.message === 'string' ? data.message : '');
      setTwoFaSetupData(null);
      setTwoFaConfirmCode('');
      setTwoFaStartPassword('');
      setTwoFaShowEnrollForm(false);
      // The one-time recovery codes are shown ONCE, here, and nowhere else. They
      // stay in component memory only until the administrator acknowledges them.
      const codes = Array.isArray(data?.recoveryCodes) ? data.recoveryCodes : [];
      setTwoFaRecoveryCodes(codes.length > 0 ? codes : null);
    } catch (e: any) {
      setTwoFaError(e.message);
    } finally {
      setTwoFaProcessing(false);
    }
  };

  // The recovery codes have been acknowledged. Clearing them (with all other
  // provisioning state) is the ONLY route back to the normal enabled state, so a
  // code can never linger in memory after the screen is left.
  const finishTwoFaEnrollment = () => {
    setTwoFaRecoveryCodes(null);
    setTwoFaCopied('');
    setTwoFaCopyError('');
    discardTwoFaProvisioning();
  };

  // Digits only: the field filters keystrokes rather than mapping arbitrary
  // characters onto a code, and it can never exceed six digits.
  const handleTwoFaCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTwoFaConfirmCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6));
  };

  // Copy a value to the clipboard. A missing or blocked Clipboard API is
  // reported to the administrator with a manual instruction instead of failing
  // silently; the copied text itself is NEVER logged or persisted.
  const copyTwoFaValue = async (value: string, what: 'secret' | 'codes') => {
    setTwoFaCopyError('');
    setTwoFaCopied('');
    try {
      const clipboard = navigator.clipboard;
      if (!clipboard || typeof clipboard.writeText !== 'function') {
        throw new Error('clipboard-unavailable');
      }
      await clipboard.writeText(value);
      setTwoFaCopied(what);
    } catch {
      setTwoFaCopyError(
        'Copying is not available in this browser. Please select the text and copy it manually.'
      );
    }
  };

  const copyTwoFaSecret = () => {
    if (!twoFaSetupData?.secret) return;
    void copyTwoFaValue(twoFaSetupData.secret, 'secret');
  };

  const copyTwoFaRecoveryCodes = () => {
    if (!twoFaRecoveryCodes || twoFaRecoveryCodes.length === 0) return;
    // ONLY the codes themselves — never explanatory copy that could carry a
    // value the administrator did not intend to share.
    void copyTwoFaValue(twoFaRecoveryCodes.join('\n'), 'codes');
  };

  const handleTwoFaDisable = async (e: React.FormEvent) => {
    e.preventDefault();
    setTwoFaError('');
    setTwoFaMessage('');
    setTwoFaProcessing(true);
    try {
      const response = await fetch('/api/auth/admin-2fa/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ password: twoFaDisablePassword }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const serverMessage = typeof data?.error === 'string' ? data.error : '';
        throw new Error(
          twoFaFailureMessage(response, serverMessage || ('Incorrect password.'))
        );
      }
      setTwoFaMessage(typeof data?.message === 'string' ? data.message : '');
      setTwoFaShowDisableForm(false);
      setTwoFaDisablePassword('');
      setAdminTotpEnabled(false);
      // Disabling tears the enrollment down, so any recovery codes still on
      // screen for this account are no longer valid and are dropped too.
      setTwoFaRecoveryCodes(null);
      discardTwoFaProvisioning();
    } catch (e: any) {
      setTwoFaError(e.message);
    } finally {
      setTwoFaProcessing(false);
    }
  };

  // Fetch the expanded agent's vetting photographs on demand. The bulk
  // dashboard intentionally no longer carries these URLs (see
  // services/adminSafeViews.ts), so the console asks for them only when an
  // administrator actually opens one agent's row.
  //
  // RACE GUARD (6G/N5): expanding agent A then quickly agent B must never let
  // A's slow response land after B's and overwrite B's panel with A's
  // documents. Two mechanisms, mirroring the ClaimsAdministration pattern:
  //   1. AbortController — the in-flight request for the previous row is
  //      aborted the moment a new expansion starts.
  //   2. A sequence counter — a late response that slipped past the abort
  //      (e.g. resolved in the same tick) is discarded unless it is still the
  //      latest issued request.
  const agentDocsAbortRef = useRef<AbortController | null>(null);
  const agentDocsSeqRef = useRef(0);
  const fetchAgentDocuments = async (agentId: string) => {
    agentDocsAbortRef.current?.abort();
    const controller = new AbortController();
    agentDocsAbortRef.current = controller;
    const seq = ++agentDocsSeqRef.current;
    setAgentDocsError(null);
    setAgentDocsLoading(agentId);
    try {
      const response = await fetch(`/api/admin/agents/${encodeURIComponent(agentId)}/documents`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (seq !== agentDocsSeqRef.current) return; // stale response — a newer row was opened
      if (!response.ok) throw new Error(data.error || 'Could not load verification photographs.');
      setAgentDocs(data.documents || null);
    } catch (e: any) {
      if (e?.name === 'AbortError' || seq !== agentDocsSeqRef.current) return; // superseded, not an error
      setAgentDocs(null);
      setAgentDocsError(e.message);
    } finally {
      if (seq === agentDocsSeqRef.current) setAgentDocsLoading(null);
    }
  };

  useEffect(() => {
    if (!expandedAgentId || !token) return;
    fetchAgentDocuments(expandedAgentId);
    // Deps intentionally [expandedAgentId, token]: the fetch should fire once
    // per row expansion / session change, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedAgentId, token]);

  // Abort any in-flight document fetch when the row is collapsed or the
  // console unmounts, so a late response can never write into a closed panel.
  useEffect(() => {
    if (expandedAgentId) return;
    agentDocsAbortRef.current?.abort();
    agentDocsAbortRef.current = null;
    agentDocsSeqRef.current++;
    return () => {
      agentDocsAbortRef.current?.abort();
    };
  }, [expandedAgentId]);

  // Approve Agent
  const [locationFormAgentId, setLocationFormAgentId] = useState<string | null>(null);
  const [locationFormLat, setLocationFormLat] = useState('');
  const [locationFormLon, setLocationFormLon] = useState('');

  const handleSetAgentLocation = async (id: string) => {
    setActionSuccess('');
    setActionWarning('');
    setDataError('');
    if (!locationFormLat || !locationFormLon) {
      setDataError('Enter both latitude and longitude.');
      return;
    }
    setAdminActionProcessing(true);
    try {
      const response = await fetch(`/api/admin/agents/${id}/location`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ latitude: locationFormLat, longitude: locationFormLon }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to update agent location');
      }
      setActionSuccess(data.message);
      setLocationFormAgentId(null);
      setLocationFormLat('');
      setLocationFormLon('');
      fetchDashboardData(); // Reload
    } catch (e: any) {
      setDataError(e.message);
    } finally {
      setAdminActionProcessing(false);
    }
  };

  const handleApproveAgent = (id: string) => {
    setActionSuccess('');
    setActionWarning('');
    setDataError('');

    setConfirmModal({
      title: 'Approve Agent',
      message: "Are you sure you want to approve this agent? They will gain access to handle sensitive documents and receive payouts.",
      onConfirm: async () => {
        setAdminActionProcessing(true);
        try {
          const response = await fetch(`/api/admin/agents/${id}/approve`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
          });
          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.error || 'Failed to approve agent');
          }
          setActionSuccess(data.message);
          fetchDashboardData(); // Reload
        } catch (e: any) {
          setDataError(e.message);
        } finally {
          setAdminActionProcessing(false);
        }
      }
    });
  };

  // Suspend Agent
  const handleSuspendAgent = (id: string) => {
    setActionSuccess('');
    setActionWarning('');
    setDataError('');

    setConfirmModal({
      title: 'Suspend Agent',
      message: "Are you sure you want to suspend this agent? They will no longer be able to accept drop-offs or process handovers.",
      onConfirm: async () => {
        setAdminActionProcessing(true);
        try {
          const response = await fetch(`/api/admin/agents/${id}/suspend`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
          });
          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.error || 'Failed to suspend agent');
          }
          setActionSuccess(data.message);
          fetchDashboardData(); // Reload
        } catch (e: any) {
          setDataError(e.message);
        } finally {
          setAdminActionProcessing(false);
        }
      }
    });
  };

  // Issue Official Warning to Agent
  // UX-15F — THE REASON STEP IS THE SHARED ui/Modal, NOT window.prompt().
  //
  // WHY THIS EXISTS
  //   The "Issue Warning" action collected its audit-logged reason with a native
  //   `prompt()`. A browser prompt is unstyled, cannot be translated, cannot
  //   render a validation message, is not focus-managed and blocks the main
  //   thread — so it read as a different product bolted onto this console. It is
  //   now the SAME shared ui/Modal the refund reconciliation adopted in P1-01 and
  //   the item-review reason step adopted in UX-15E. No second dialog component
  //   was introduced, and the bespoke confirm modal keeps its own later scope.
  //
  // WHAT DID NOT CHANGE
  //   The warning TARGET, the endpoint, the Authorization bearer, the
  //   `{ reason }` body, the EXACT blank-reason guard the prompt used
  //   (`!reason || reason.trim() === ''` — a missing, empty or whitespace-only
  //   reason issues no warning at all), the UNTRIMMED reason that is sent, the
  //   success / error banners, the `adminActionProcessing` guard and the
  //   dashboard refresh. Only HOW the reason is collected changed.
  /** The UNCHANGED warning mutation: same endpoint, same authorization, same
   *  `{ reason }` payload, same success / error handling, same refresh. */
  const handleWarnAgent = (id: string, reason: string) => {
    setActionSuccess('');
    setActionWarning('');
    setDataError('');
    setAdminActionProcessing(true);

    fetch(`/api/admin/agents/${id}/warn`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ reason }),
    })
      .then(async res => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to warn agent');
        setActionSuccess(data.message);
        fetchDashboardData();
      })
      .catch(err => setDataError(err.message))
      .finally(() => setAdminActionProcessing(false));
  };

  // --- UX-15F dialog state: the target agent, the typed reason and its
  // validation message — nothing else, and no change to the agent shape. ---
  const [agentWarnPrompt, setAgentWarnPrompt] = useState<{ agentId: string } | null>(null);
  const [agentWarnReason, setAgentWarnReason] = useState('');
  const [agentWarnReasonError, setAgentWarnReasonError] = useState('');

  /** Cancel / dismiss: closes the dialog with no request, no mutation and no
   *  console state change — exactly what cancelling the old prompt did. */
  const closeAgentWarnDialog = () => {
    setAgentWarnPrompt(null);
    setAgentWarnReason('');
    setAgentWarnReasonError('');
  };

  /** Opens the shared dialog for ONE agent. Records the target only: no request
   *  and no mutation yet, exactly like the prompt it replaces, which also did
   *  nothing until the administrator submitted. */
  const openAgentWarnDialog = (id: string) => {
    setAgentWarnReason('');
    setAgentWarnReasonError('');
    setAgentWarnPrompt({ agentId: id });
  };

  /**
   * Submits the collected reason. The blank-reason rule is the SAME guard the
   * prompt enforced: a missing or whitespace-only reason issued no warning at
   * all, so it is now rejected IN PLACE — where the administrator is looking,
   * instead of failing silently — the mutation is never reached, and the dialog
   * stays open so the reason can be filled in. On a valid reason the dialog
   * closes exactly as the prompt did, and the reason reaches the mutation
   * UNTRIMMED, exactly as before.
   */
  const confirmAgentWarn = () => {
    if (!agentWarnPrompt) return;
    const { agentId } = agentWarnPrompt;
    const reason = agentWarnReason;
    if (!reason || reason.trim() === '') {
      setAgentWarnReasonError('A reason is required.');
      return;
    }
    closeAgentWarnDialog();
    handleWarnAgent(agentId, reason);
  };

  // Refund reconciliation (A1): fetch claims awaiting manual refund reconciliation.
  const fetchRefundReconciliation = async () => {
    if (!token) return;
    setRefundReconcileLoading(true);
    try {
      const response = await fetch('/api/admin/refund-reconciliation', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch refund reconciliation.');
      }
      setRefundReconcileItems(Array.isArray(data.items) ? data.items : []);
    } catch (e: any) {
      setRefundReconcileItems((prev) => prev ?? []);
    } finally {
      setRefundReconcileLoading(false);
    }
  };

  // Admin has verified with the provider that the refund WAS executed.
  // P1-01: the browser-native confirm() is replaced by the shared ui/Modal. The
  // request below is UNCHANGED — same endpoint, same auth, same refreshes.
  /** Opens the confirmation dialog (P1-01). No request is made until confirmed. */
  const handleRefundFinalize = (claimId: string) => setRefundConfirm({ kind: 'finalize', claimId });

  /** Opens the confirmation dialog (P1-01). No request is made until confirmed. */
  const handleRefundRevert = (claimId: string) => setRefundConfirm({ kind: 'revert', claimId });

  const executeRefundOutcome = async (kind: 'finalize' | 'revert', claimId: string) => {
    setRefundReconcileProcessing(claimId);
    try {
      const url = `/api/admin/refund-reconciliation/${encodeURIComponent(claimId)}/${kind}`;
      const res = await fetch(url, {
        method: 'POST',
        headers:
          kind === 'revert'
            ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
            : { Authorization: `Bearer ${token}` },
        ...(kind === 'revert'
          ? { body: JSON.stringify({ reason: 'Admin confirmed with the provider that the refund was NOT executed.' }) }
          : {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || (kind === 'finalize' ? 'Finalize failed.' : 'Revert failed.'));
      if (kind === 'finalize') setActionSuccess(data.message);
      else setActionWarning(data.message);
      fetchRefundReconciliation();
      fetchDashboardData();
    } finally {
      setRefundReconcileProcessing(null);
    }
  };

  /**
   * P1-01: one confirmation surface for both reconciliation outcomes.
   *
   * The dialog STAYS OPEN while the request is in flight and the confirm button
   * is disabled + `aria-busy`, so a slow call cannot be fired twice and the
   * operator can see that work is happening. It closes ONLY when the server has
   * answered successfully; on failure it stays open and the authoritative
   * `dataError` (rendered inside the dialog) is shown, so the operator can read
   * what went wrong and retry without re-deciding from scratch.
   *
   * This does not change the request itself — only when the dialog dismisses.
   */
  const [refundConfirmBusy, setRefundConfirmBusy] = useState(false);

  const confirmRefundOutcome = async () => {
    if (!refundConfirm || refundConfirmBusy) return;
    const { kind, claimId } = refundConfirm;
    setRefundConfirmBusy(true);
    setDataError('');
    setActionWarning('');
    setActionSuccess('');
    try {
      // Throws on a non-2xx so a failure never reports success.
      await executeRefundOutcome(kind, claimId);
      setRefundConfirm(null);
    } catch (err: any) {
      setDataError(err?.message || 'Action failed.');
    } finally {
      setRefundConfirmBusy(false);
    }
  };

  // Load the on-demand evidence for one dispute. Cached per dispute id; the
  // administrator triggers it explicitly, so opening the tab does not fan out
  // one request per dispute.
  const fetchDisputeEvidence = async (disputeId: string) => {
    setDisputeEvidence((prev) => ({
      ...prev,
      [disputeId]: { loading: true, error: null, items: prev[disputeId]?.items ?? null },
    }));
    try {
      const response = await fetch(`/api/admin/disputes/${encodeURIComponent(disputeId)}/evidence`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not load dispute evidence.');
      setDisputeEvidence((prev) => ({
        ...prev,
        [disputeId]: { loading: false, error: null, items: Array.isArray(data.evidence) ? data.evidence : [] },
      }));
    } catch (e: any) {
      setDisputeEvidence((prev) => ({
        ...prev,
        [disputeId]: { loading: false, error: e.message || 'Could not load dispute evidence.', items: null },
      }));
    }
  };

  // Resolve Dispute.
  //
  // The winning claim id comes from the claimant summary the API actually
  // returned for THIS dispute, and is validated before anything is sent. The
  // previous version read two field names that never existed on the API
  // response, so it submitted `undefined` and every attempt failed.
  const handleResolveDispute = (dispute: any, claimant: any) => {
    setActionSuccess('');
    setActionWarning('');
    setDataError('');

    const winningClaimId = typeof claimant?.claim_id === 'string' ? claimant.claim_id.trim() : '';
    const participatingClaimIds = Array.isArray(dispute?.claimants)
      ? dispute.claimants.map((c: any) => (typeof c?.claim_id === 'string' ? c.claim_id : '')).filter(Boolean)
      : [];

    // Never submit an incomplete decision. If the API has not supplied a real
    // participating claim id, say so rather than firing a request that cannot
    // succeed.
    if (!winningClaimId) {
      setDataError(
        'This dispute has no usable claim ID for that claimant, so it cannot be resolved from the console. Reload the dashboard; if it persists, the dispute record is incomplete.'
      );
      return;
    }
    if (!participatingClaimIds.includes(winningClaimId)) {
      setDataError(
        'That claim is not one of the two claimants in this dispute. Nothing was submitted.'
      );
      return;
    }

    const roleLabel = claimant.role === 'original'
      ? ('Claimant A — original claim')
      : ('Claimant B — contesting claim');

    // D-B1 FIX — the consequence must describe the LOSER's actual outcome.
    // The previous version keyed the sentence off `claimant.has_paid_escrow`,
    // i.e. the WINNER (the person being awarded), while the wording described
    // the OPPOSING side — so it could tell an admin that a refund would be
    // queued when the loser had never paid, or that the loser would merely be
    // rejected when they had in fact paid. The refund decision is made from
    // the LOSER's payment state, so the confirmation must read the opposing
    // claimant's flag.
    const opponents = (Array.isArray(dispute?.claimants) ? dispute.claimants : [])
      .filter((c: any) => c && c.claim_id && c.claim_id !== winningClaimId);
    const opponent = opponents[0] || null;
    const winnerPaid = !!claimant.has_paid_escrow;
    const loserPaid = !!opponent?.has_paid_escrow;

    const winnerOutcome = winnerPaid
      ? ('Winning claim stays paid — the money is held while the item is handed over, then released.')
      : ('Winning claim is NOT paid — it goes back to PENDING VERIFICATION and must complete verification and payment normally.');
    const loserOutcome = loserPaid
      ? ('Losing claim HAS paid — it will be locked to REFUNDING and a real M-Pesa refund will be attempted.')
      : ('Losing claim has NOT paid — no refund is owed and it will simply be REJECTED.');
    const opponentLabel = opponent
      ? `${opponent.role === 'original' ? ('Claimant A') : ('Claimant B')} (${opponent.owner_phone || ('no phone recorded')}, ${'claim'} ${opponent.claim_id})`
      : ('the opposing claimant');

    setConfirmModal({
      title: 'Resolve Dispute',
      message:
        `${'Award'} ${dispute.id} (${'item'} ${dispute.item_id}) ` +
        `${'to'} ${roleLabel} — ${'phone'} ${claimant.owner_phone || ('no phone recorded')}, ` +
        `${'claim'} ${winningClaimId}.\n\n` +
        `${'Outcome for the winning claim'}: ${winnerOutcome}\n` +
        `${'Outcome for'} ${opponentLabel}: ${loserOutcome}\n\n` +
        ('This decision is final and cannot be undone.'),
      onConfirm: async () => {
        setAdminActionProcessing(true);
        try {
          const response = await fetch('/api/admin/disputes/resolve', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              disputeId: dispute.id,
              winningClaimId,
              // Record only what actually happened. The previous note asserted
              // that the administrator had reviewed "official government-issued
              // ID proofs" — which the console does not display — writing a
              // fabricated justification into the audit trail.
              adminNotes: `Resolved from the admin console in favour of the ${claimant.role} claimant (claim ${winningClaimId}).`,
            }),
          });

          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.error || 'Dispute resolution failed');
          }

          // A refund-transfer failure is reported with success:true (the
          // dispute itself WAS resolved — that decision doesn't get rolled
          // back) plus a refundFailed flag, so it lands here rather than
          // the catch block below. It needs to stand out from a routine
          // success message: it means real M-Pesa money is stuck and
          // needs manual admin follow-up, not just an FYI.
          if (data.refundFailed) {
            setActionWarning(data.message);
          } else {
            setActionSuccess(data.message);
          }
          fetchDashboardData(); // Reload
        } catch (e: any) {
          setDataError(e.message);
        } finally {
          setAdminActionProcessing(false);
        }
      }
    });
  };

  const handleRejectAsSpam = async (itemId: string) => {
    setActionSuccess('');
    setActionWarning('');
    setDataError('');
    setReviewSaving(true);
    try {
      const response = await fetch(`/api/admin/items/${itemId}/reject`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ reason: 'Admin manual-review queue rejection (Spam)' }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to reject as spam');
      }

      setActionSuccess('Item manual review: Item rejected as spam and removed from queue.');
      setSelectedReviewItem(null);
      fetchDashboardData();
    } catch (e: any) {
      setDataError(e.message);
    } finally {
      setReviewSaving(false);
    }
  };

  // --- Stolen-property state machine & settlement release actions ---
  // The platform never adjudicates the underlying accusation — these calls
  // only ever change an item's claimability, and every reason given here is
  // recorded server-side in the audit log against the acting admin.
  const [itemActionProcessing, setItemActionProcessing] = useState<string | null>(null);

  const handleItemReviewStatusChange = async (itemId: string, action: 'flag-stolen' | 'legal-hold' | 'clear-hold', reason: string) => {
    setActionSuccess('');
    setActionWarning('');
    setDataError('');
    setItemActionProcessing(itemId + action);
    try {
      const response = await fetch(`/api/admin/items/${itemId}/${action}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ reason }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || `Failed to ${action.replace('-', ' ')}`);
      }
      setActionSuccess(data.message || 'Item status updated.');
      fetchDashboardData();
    } catch (e: any) {
      setDataError(e.message);
    } finally {
      setItemActionProcessing(null);
    }
  };

  // ---------------------------------------------------------------------------
  // UX-15E — THE ITEM-REVIEW REASON STEP IS THE SHARED ui/Modal, NOT window.prompt().
  //
  // WHY THIS EXISTS
  //   The three stolen-property / legal-hold transitions each require an
  //   operator-entered reason, and that reason was collected with a native
  //   `window.prompt()`. A browser prompt is unstyled, cannot be translated,
  //   cannot render a validation message, is not focus-managed, and blocks the
  //   main thread — so it read as a different product bolted onto this console.
  //
  //   It is now the SAME shared ui/Modal the refund reconciliation adopted in
  //   P1-01 (focus trap, Escape-to-cancel, focus restoration, role="dialog" +
  //   aria-modal, scrollable body, footer action row). No second dialog
  //   component was introduced, and the bespoke confirm modal below is left
  //   untouched — it keeps its own dedicated scope.
  //
  // WHAT DID NOT CHANGE
  //   The endpoint, the Authorization bearer, the `{ reason }` body, the
  //   required/optional rule per action, the exact 'A reason is required.'
  //   message, the `.trim()` applied to whatever the operator types, the
  //   `itemActionProcessing` guard that disables the originating row, and every
  //   server-side rule. Only HOW the reason is collected changed.
  // ---------------------------------------------------------------------------
  const [itemReviewPrompt, setItemReviewPrompt] = useState<null | {
    itemId: string;
    action: 'flag-stolen' | 'legal-hold' | 'clear-hold';
    promptLabel: string;
  }>(null);
  const [itemReviewReason, setItemReviewReason] = useState('');
  const [itemReviewReasonError, setItemReviewReasonError] = useState('');

  /** Cancel / dismiss: closes the dialog with no mutation, no request and no
   *  state transition — exactly what cancelling the old prompt did. */
  const closeItemReviewPrompt = () => {
    setItemReviewPrompt(null);
    setItemReviewReason('');
    setItemReviewReasonError('');
  };

  /** Opens the shared dialog. No request and no mutation yet, exactly like the
   *  prompt it replaces, which also did nothing until the operator submitted. */
  const promptItemReviewStatusChange = (itemId: string, action: 'flag-stolen' | 'legal-hold' | 'clear-hold', promptLabel: string) => {
    setItemReviewReason('');
    setItemReviewReasonError('');
    setItemReviewPrompt({ itemId, action, promptLabel });
  };

  /**
   * Submits the collected reason. The required-reason rule is IDENTICAL to the
   * one the prompt enforced — a blank or whitespace-only reason for
   * `flag-stolen` / `legal-hold` is rejected with the same
   * 'A reason is required.' message and the mutation is never called; only the
   * PLACE that message appears changed (inside the dialog, where the operator is
   * looking, instead of the console-level error banner). `clear-hold` stays
   * optional. The dialog closes on submit exactly as the prompt did, and the
   * mutation receives `reason.trim()`.
   */
  const confirmItemReviewStatusChange = () => {
    if (!itemReviewPrompt) return;
    const { itemId, action } = itemReviewPrompt;
    const reason = itemReviewReason;
    if ((action === 'flag-stolen' || action === 'legal-hold') && !reason.trim()) {
      setItemReviewReasonError('A reason is required.');
      return;
    }
    closeItemReviewPrompt();
    handleItemReviewStatusChange(itemId, action, reason.trim());
  };

  const handleReleaseSettlementNow = async (claimId: string) => {
    setActionSuccess('');
    setActionWarning('');
    setDataError('');
    setItemActionProcessing('settlement:' + claimId);
    try {
      const response = await fetch(`/api/admin/claims/${claimId}/release-settlement`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to release settlement');
      }
      setActionSuccess(data.message || 'Settlement released.');
      fetchDashboardData();
    } catch (e: any) {
      setDataError(e.message);
    } finally {
      setItemActionProcessing(null);
    }
  };

  const handleToggleSocialPause = async (paused: boolean) => {
    setActionSuccess('');
    setActionWarning('');
    setDataError('');
    setItemActionProcessing('social-pause');
    try {
      const response = await fetch('/api/admin/settings/social-publishing-pause', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ paused }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to update social publishing setting');
      }
      setActionSuccess(data.message || 'Setting updated.');
      fetchDashboardData();
    } catch (e: any) {
      setDataError(e.message);
    } finally {
      setItemActionProcessing(null);
    }
  };

  const handleClearReputation = (phone: string) => {
    setActionSuccess('');
    setActionWarning('');
    setDataError('');

    setConfirmModal({
      title: 'Clear Reputation Flag',
      message: "Are you sure you want to clear this phone number's reputation flag?",
      onConfirm: async () => {
        setAdminActionProcessing(true);
        try {
          const response = await fetch(`/api/admin/reputations/${phone}/clear`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
            }
          });

          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.error || 'Failed to clear phone reputation');
          }

          setActionSuccess(`Reputation flag manually cleared for finder ${phone}.`);
          fetchDashboardData();
        } catch (e: any) {
          setDataError(e.message);
        } finally {
          setAdminActionProcessing(false);
        }
      }
    });
  };

  const splitsMatch = parseFloat((Number(catFormFinderShare) + Number(catFormAgentShare) + Number(catFormPlatformShare)).toFixed(2)) === parseFloat(Number(catFormTotalFee).toFixed(2));

  // ---------------------------------------------------------------------------
  // PART C — LIVE FEE SPLIT PREVIEW FOR THE CATEGORY FORM
  //
  // The form already asked for an amount (Base + Complexity + Delay) and for the
  // three split percentages, but it never showed what the split actually pays
  // out. An admin had to do the arithmetic by hand to know whether a KES 1,000
  // claim pays the finder KES 250 or KES 500.
  //
  // This preview calls the SAME `computeRecoveryFee()` the server uses to price a
  // real claim — it is a preview of the authoritative calculation, not a second
  // implementation of it. If this preview and the server ever disagreed, the
  // server is still the authority (the browser is never trusted for money), but
  // because there is only one function they cannot drift.
  //
  // Declared value is deliberately passed as `null`: the admin is configuring the
  // fee itself, and with no declared value the engine prices at exactly rawFee.
  // Passing a declared value here would show a ceiling-capped number the admin
  // is not actually configuring.
  // ---------------------------------------------------------------------------
  const enginePreview = useMemo(
    () =>
      computeRecoveryFee(
        {
          base_fee: Number(catFormBaseFee) || 0,
          complexity_fee: Number(catFormComplexityFee) || 0,
          delay_fee: Number(catFormDelayFee) || 0,
          ceiling_percent: Number(catFormCeilingPercent) || 0,
          finder_pct: Number(catFormFinderPct) || 0,
          agent_pct: Number(catFormAgentPct) || 0,
          platform_pct: Number(catFormPlatformPct) || 0,
          finder_reward_cap:
            catFormFinderRewardCap.trim() === '' ? null : Number(catFormFinderRewardCap),
        },
        null,
      ),
    [
      catFormBaseFee,
      catFormComplexityFee,
      catFormDelayFee,
      catFormCeilingPercent,
      catFormFinderPct,
      catFormAgentPct,
      catFormPlatformPct,
      catFormFinderRewardCap,
    ],
  );

  // The three engine shares always reconcile to the fee by construction (the
  // platform share is the residual), so this is a display of that guarantee.
  const enginePreviewSplitTotal = parseFloat(
    (enginePreview.finderAmount + enginePreview.agentAmount + enginePreview.platformAmount).toFixed(2),
  );
  const kes = (n: number) => `KES ${(Number(n) || 0).toFixed(2)}`;

  // Is an amount actually configured yet? Base + Complexity + Delay is the fee
  // the admin is pricing. Until at least one is non-zero the engine would report
  // KES 0.00 for every share, and printing "KES 0.00" as though it were a
  // computed fee would be a FABRICATED financial value. So the preview says it is
  // not yet calculable instead — it never dresses up an unconfigured form as a
  // real split.
  const catFormAmountEntered =
    (Number(catFormBaseFee) || 0) + (Number(catFormComplexityFee) || 0) + (Number(catFormDelayFee) || 0) > 0;

  // The single page-level heading + description for whichever section is open.
  const sectionCopy = CONSOLE_SECTIONS[activeTab];

  // UX-14 — the admin authentication gate's single "a request is in flight"
  // flag. The credential step and the 2FA step are mutually exclusive, so the
  // submit control, the form's aria-busy state and the disabled state all read
  // this one derived value instead of repeating the same ternary three times.
  // Presentation only: both underlying flags (`authLoading`, `twoFactorLoading`)
  // already existed and remain the only thing that gates the two network calls.
  const isAuthBusy = pendingTwoFactorToken ? twoFactorLoading : authLoading;

  return (
    <div className="w-full fade-in">
      
      {/* 1. SECURE ADMIN AUTHENTICATION GATE — restyled in UX-14.
          This is the ONLY unauthenticated surface in this file. Everything below
          it is gated on `token` (the Admin Console) and belongs to UX-15: it is
          deliberately untouched by this batch.

          UX-14 IS PRESENTATION ONLY. It changes none of:
            * the authentication protocol — the same two endpoints are called in
              the same order with byte-identical bodies (`/api/auth/admin-login`
              with { username, passcode }; `/api/auth/admin-login/verify-2fa`
              with { pendingToken, code });
            * the security model — the same bearer token the server returns is
              handed to the same `setToken` (localStorage `admin_token` in
              App.tsx). No second storage mechanism, no second credential field,
              no client-side authorisation, and no change to the 2FA branch, the
              rate limiting, the session expiry or the server-side role checks;
            * the route architecture — this remains the `/console` gate, shown
              only while there is no admin token (see src/App.tsx).

          What it changes is hierarchy, control semantics, the type/colour/
          radius/elevation vocabulary and the copy in both languages — entirely
          by adopting primitives and tokens that already exist (`Button`,
          `Input`, `Banner`, the `--appearance-*` tokens, the type/radius/
          elevation ladders), exactly as UX-07 did for customer authentication
          and UX-11 did for agent sign-in.

          The OFFICIAL Return4me wordmark stays the brand mark (never replaced by
          text pretending to be a logo, and never by the generic shield), and
          this heading stays the ONE <h1> on the page while no token exists. */}
      {!token && (
        <div className="mx-auto w-full max-w-md space-y-6 rounded-panel border border-[var(--appearance-border)] bg-[var(--appearance-surface)] p-6 shadow-raised sm:p-8">
          {/* UX-14 · A — identity, then what this page is, then who may use it.
              No slogan, no reassurance, no security claim the system cannot back
              up: the sentence in the middle is the existing one, verbatim. */}
          <div className="space-y-3 text-center">
            <img
              src="/assets/logo_wordmark_transparent.png"
              alt="Return4me"
              className="mx-auto h-12 w-auto max-w-full object-contain sm:h-14"
              referrerPolicy="no-referrer"
            />
            <p className="text-caption font-extrabold uppercase tracking-widest text-[var(--appearance-text-muted)]">
              {'Return4me administration'}
            </p>
            <h1 className="text-section font-extrabold tracking-tight text-[var(--appearance-text-primary)]">
              {'Admin Authentication'}
            </h1>
            <p className="mx-auto max-w-sm text-body leading-relaxed text-[var(--appearance-text-muted)]">
              {'Access restricted strictly to platform executives and vetted managers.'}
            </p>
          </div>

          {/* UX-14 · C — authentication feedback in ONE live region. `Banner
              kind="error"` supplies role="alert" + aria-live="assertive" and the
              appearance tokens, exactly as UX-11 uses it on the agent sign-in.
              It stays a FORM-level banner and never a per-field error: the
              existing semantics never say WHICH credential was wrong, and UX-14
              adds no such disclosure. No native alert()/prompt()/confirm() is
              used anywhere in this gate. */}
          {authError && (
            <Banner kind="error">
              <span>{authError}</span>
            </Banner>
          )}

          {/* UX-14 · B — the credential step, then the existing 2FA code step.
              Same two branches, same handlers, same endpoints, byte-identical
              bodies and the same required/maxLength/autoFocus semantics as
              before — only the controls move onto the shared `Input` primitive
              (44px control, real label→control association, autofill semantics,
              tokenised focus and error surfaces). */}
          <form
            onSubmit={pendingTwoFactorToken ? handleTwoFactorVerify : handleAdminAuth}
            className="space-y-4"
            aria-busy={isAuthBusy || undefined}
          >
            {!pendingTwoFactorToken ? (
              <>
                <Input
                  id="admin-username"
                  label={'Admin Username'}
                  type="text"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="admin"
                  required
                  disabled={authLoading}
                  autoFocus
                />

                <Input
                  id="admin-passcode"
                  label={'Access Password'}
                  type="password"
                  autoComplete="current-password"
                  value={passcode}
                  onChange={(e) => setPasscode(e.target.value)}
                  placeholder="••••••••"
                  required
                  disabled={authLoading}
                />
              </>
            ) : (
              <div className="space-y-2">
                <Input
                  id="admin-2fa-code"
                  label={
                    '6-Digit Authenticator Code'
                  }
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  maxLength={6}
                  value={twoFactorCode}
                  onChange={(e) => setTwoFactorCode(e.target.value)}
                  placeholder="123456"
                  required
                  disabled={twoFactorLoading}
                />
                {/* The same escape hatch the gate already had, now on the shared
                    Button so it keeps a 44px target and a tokenised hover/focus
                    state. It is a tertiary action (ghost), not a second CTA. */}
                <Button
                  type="button"
                  variant="ghost"
                  size="md"
                  className="w-full"
                  onClick={() => { setPendingTwoFactorToken(null); setTwoFactorCode(''); setAuthError(''); }}
                >
                  {'Back to password'}
                </Button>
              </div>
            )}

            {/* UX-14 · D — ONE dominant action. It is the same single submit the
                gate already had: same handler, same endpoints, same payloads.
                `loading` disables the control, so an accidental double submission
                is impossible, and the spinner + label keep the button's height
                and width fixed (size="lg" = 52px), so nothing jumps. */}
            <Button
              type="submit"
              variant="primary"
              size="lg"
              loading={isAuthBusy}
              className="w-full"
            >
              {pendingTwoFactorToken
                ? (twoFactorLoading
                    ? ('Verifying…')
                    : ('Verify Code'))
                : (authLoading
                    ? ('Signing in…')
                    : ('Unlock System Console'))}
            </Button>
          </form>
        </div>
      )}

      {/* 2. DISTINCT LOADING / ERROR / EMPTY STATES
          UX-15A — the three authenticated dashboard states now sit on the
          shared primitives and the appearance tokens. Presentation only: the
          same conditions, the same loader, the same copy and the same retry
          handler (fetchDashboardData) as before — no new state, no new request
          and no change to the dashboard data contract. */}
      {token && dashboardLoading && !dashboardData && (
        <div className="flex flex-col items-center justify-center py-20 space-y-4">
          <Spinner
            size={ICON_SIZE.feature}
            label="Fetching console dashboard statistics..."
            className="text-[var(--appearance-primary)]"
          />
          <p className="text-caption font-semibold uppercase tracking-wider animate-pulse text-[var(--appearance-text-muted)]">
            Fetching console dashboard statistics...
          </p>
        </div>
      )}

      {token && !dashboardData && dataError && (
        <div className="max-w-md mx-auto my-8 space-y-4">
          <Banner kind="error">
            <h2 className="text-heading">Failed to Load Dashboard</h2>
            <p className="mt-1">{dataError}</p>
          </Banner>
          <Button
            variant="primary"
            size="md"
            onClick={fetchDashboardData}
            className="w-full"
          >
            Retry Connection
          </Button>
        </div>
      )}

      {token && !dashboardLoading && !dashboardData && !dataError && (
        <div className="max-w-md mx-auto my-8">
          <EmptyState
            icon={HelpCircle}
            title="No Dashboard Data Available"
            description="The console returned no statistical or audit record metrics at this time."
            action={
              <Button variant="primary" size="md" onClick={fetchDashboardData}>
                Retry Fetching
              </Button>
            }
          />
        </div>
      )}

      {/* 3. ADMIN DASHBOARD WORKSPACE */}
      {token && dashboardData && (
        <div className="space-y-6 fade-in">
          
          {/* The console's page-level heading is the section title band further
              down (inside the sidebar shell). The old standalone 3xl title
              living here was removed in Batch 1 so there is exactly ONE <h1>
              on the page and it names the section actually open. */}
          {/* §10 — "Signed in as". Only what the authenticated session actually
              carries is shown: the username claim from the admin token, or the
              generic word "Administrator" when the session carries none. No
              name, email, avatar, last-login or location is invented, and the
              token itself is never rendered. Sign out clears the session
              exactly as the navbar logout does (setToken(null)); the server-side
              revocation path is unchanged. */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-panel border border-[var(--appearance-border)] bg-[var(--appearance-surface)] px-4 py-3.5 shadow-sm">
            <div className="flex items-center gap-3 min-w-0">
              <span className="w-10 h-10 rounded-standard bg-[var(--appearance-primary)] text-[var(--appearance-primary-foreground)] flex items-center justify-center shrink-0">
                <ShieldCheck size={ICON_SIZE.emphasis} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="text-caption font-extrabold uppercase tracking-widest text-[var(--appearance-text-muted)]">Administrator</p>
                <p className="text-heading font-extrabold text-[var(--appearance-text-primary)] truncate">{adminLabel}</p>
                <p className="text-caption text-[var(--appearance-text-muted)]">
                  {adminIdentity.role ? `Signed in · role ${adminIdentity.role}` : 'Signed in · active console session'}
                </p>
              </div>
            </div>
            {/* UX-15B — the hand-built control is now the shared Button. Same
                action (setToken(null)), same session semantics, and size="md"
                (44px) so it meets the interaction floor. */}
            <Button
              variant="outline"
              size="md"
              onClick={() => setToken(null)}
              className="self-start sm:self-auto shrink-0"
            >
              {'Sign out'}
            </Button>
          </div>

          {actionSuccess && <Banner kind="success">{actionSuccess}</Banner>}

          {/* Social media publishing emergency stop — global, server-enforced,
              deliberately visible on every tab rather than tucked into
              settings. See isSocialPublishingPaused() in server.ts: every
              broadcast call site checks this before posting, and a failed
              check fails safe (treated as paused). */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--appearance-border)] bg-[var(--appearance-surface)] px-4 py-3 shadow-sm">
            <span className="flex items-center gap-2.5 min-w-0">
              <ShieldAlert size={ICON_SIZE.ui} aria-hidden="true" className="shrink-0 text-[var(--appearance-text-muted)]" />
              <span className="text-body font-bold text-[var(--appearance-text-primary)]">Social Media Publishing</span>
              <Badge variant={dashboardData.socialPublishingPaused ? 'danger' : 'success'}>
                {dashboardData.socialPublishingPaused ? 'Paused — no new posts' : 'Active'}
              </Badge>
            </span>
            <Button
              variant={dashboardData.socialPublishingPaused ? 'secondary' : 'danger'}
              size="sm"
              loading={itemActionProcessing === 'social-pause'}
              onClick={() => handleToggleSocialPause(!dashboardData.socialPublishingPaused)}
            >
              {dashboardData.socialPublishingPaused ? 'Resume Publishing' : 'Pause All Publishing'}
            </Button>
          </div>

          {/* The other five emergency pause scopes — reports, claims,
              payments, payouts, handovers. Same server-enforced, fail-safe
              pattern as the social-publishing stop above (see
              PAUSABLE_SCOPES / isPlatformOperationPaused in server.ts), just
              rendered as a compact grid since there are five of them. */}
          {pauseStatuses && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {([
                ['reports', 'New Reports'],
                ['claims', 'New Claims'],
                ['payments', 'Payments'],
                ['payouts', 'Payouts'],
                ['handovers', 'Handovers'],
              ] as const).map(([scope, label]) => {
                const isPaused = !!pauseStatuses[scope];
                const isBusy = itemActionProcessing === 'pause:' + scope;
                return (
                  <div
                    key={scope}
                    className="flex items-center justify-between gap-2 rounded-xl border border-[var(--appearance-border)] bg-[var(--appearance-surface)] px-3.5 py-2.5 shadow-sm"
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <ShieldAlert size={ICON_SIZE.metadata} aria-hidden="true" className="shrink-0 text-[var(--appearance-text-muted)]" />
                      <span className="text-caption font-bold text-[var(--appearance-text-primary)]">{label}</span>
                      <Badge variant={isPaused ? 'danger' : 'success'}>{isPaused ? 'Paused' : 'Active'}</Badge>
                    </span>
                    <Button
                      variant={isPaused ? 'secondary' : 'danger'}
                      size="sm"
                      loading={isBusy}
                      onClick={() => handleTogglePause(scope, !isPaused)}
                      className="shrink-0"
                    >
                      {isPaused ? 'Resume' : 'Pause'}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}

          {actionWarning && <Banner kind="warning">{actionWarning}</Banner>}

          {dataError && <Banner kind="error">{dataError}</Banner>}

          {/* REQUEST 05 / SECTION 11 - ADMIN SIDEBAR SHELL
              The sections below are exactly the sections that already existed.
              Each one maps to a real admin endpoint; nothing was invented for
              the sidebar, and no section was added for a feature the backend
              does not have. Desktop (lg+): a persistent, sticky left sidebar.
              Below lg the same list stays a horizontally scrollable strip, so a
              phone never gets a cramped fixed sidebar. The layout rules live in
              .r4m-admin-nav (src/index.css). */}
          <div className="lg:grid lg:grid-cols-[236px_minmax(0,1fr)] lg:gap-8 lg:items-start">
          <nav
            className="r4m-admin-nav flex border-b border-[var(--appearance-border)] overflow-x-auto scrollbar-none"
            aria-label={'Admin sections'}
          >
            <button
              onClick={() => setActiveTab('stats')}
              aria-current={activeTab === 'stats' ? 'page' : undefined}
              className={`py-3 px-6 text-caption font-bold transition border-b-2 -mb-px flex items-center space-x-1.5 shrink-0 ${
                activeTab === 'stats' ? 'border-[var(--appearance-primary)] text-[var(--appearance-text-primary)] font-extrabold' : 'border-transparent text-[var(--appearance-text-muted)] hover:text-[var(--appearance-text-primary)]'
              }`}
            >
              <BarChart2 size={ICON_SIZE.metadata} aria-hidden="true" />
              <span>{t.statsTab}</span>
            </button>
            <button
              onClick={() => setActiveTab('agents')}
              aria-current={activeTab === 'agents' ? 'page' : undefined}
              className={`py-3 px-6 text-caption font-bold transition border-b-2 -mb-px flex items-center space-x-1.5 shrink-0 ${
                activeTab === 'agents' ? 'border-[var(--appearance-primary)] text-[var(--appearance-text-primary)] font-extrabold' : 'border-transparent text-[var(--appearance-text-muted)] hover:text-[var(--appearance-text-primary)]'
              }`}
            >
              <Users size={ICON_SIZE.metadata} aria-hidden="true" />
              <span>{'Agents Hub'}</span>
            </button>
            <button
              onClick={() => setActiveTab('found_items')}
              aria-current={activeTab === 'found_items' ? 'page' : undefined}
              className={`py-3 px-6 text-caption font-bold transition border-b-2 -mb-px flex items-center space-x-1.5 shrink-0 ${
                activeTab === 'found_items' ? 'border-[var(--appearance-primary)] text-[var(--appearance-text-primary)] font-extrabold' : 'border-transparent text-[var(--appearance-text-muted)] hover:text-[var(--appearance-text-primary)]'
              }`}
            >
              <Package size={ICON_SIZE.metadata} aria-hidden="true" />
              <span>{'Found Items'}</span>
            </button>
            <button
              onClick={() => setActiveTab('disputes')}
              aria-current={activeTab === 'disputes' ? 'page' : undefined}
              className={`py-3 px-6 text-caption font-bold transition border-b-2 -mb-px flex items-center space-x-1.5 shrink-0 ${
                activeTab === 'disputes' ? 'border-[var(--appearance-primary)] text-[var(--appearance-text-primary)] font-extrabold' : 'border-transparent text-[var(--appearance-text-muted)] hover:text-[var(--appearance-text-primary)]'
              }`}
            >
              <HelpCircle size={ICON_SIZE.metadata} aria-hidden="true" />
              <span>{t.disputesTab}</span>
            </button>
            {/* Phase 6F — Claims Administration. Read-only; the surface itself
                enforces nothing (the server does) and exposes no mutation. */}
            <button
              onClick={() => setActiveTab('claims')}
              aria-current={activeTab === 'claims' ? 'page' : undefined}
              className={`py-3 px-6 text-caption font-bold transition border-b-2 -mb-px flex items-center space-x-1.5 shrink-0 ${
                activeTab === 'claims' ? 'border-[var(--appearance-primary)] text-[var(--appearance-text-primary)] font-extrabold' : 'border-transparent text-[var(--appearance-text-muted)] hover:text-[var(--appearance-text-primary)]'
              }`}
            >
              <ClipboardList size={ICON_SIZE.metadata} aria-hidden="true" />
              <span>{'Claims'}</span>
            </button>
            <button
              onClick={() => setActiveTab('lost_reports')}
              aria-current={activeTab === 'lost_reports' ? 'page' : undefined}
              className={`py-3 px-6 text-caption font-bold transition border-b-2 -mb-px flex items-center space-x-1.5 shrink-0 ${
                activeTab === 'lost_reports' ? 'border-[var(--appearance-primary)] text-[var(--appearance-text-primary)] font-extrabold' : 'border-transparent text-[var(--appearance-text-muted)] hover:text-[var(--appearance-text-primary)]'
              }`}
            >
              <FileSearch size={ICON_SIZE.metadata} aria-hidden="true" />
              <span>{'Lost Reports'}</span>
            </button>
            <button
              onClick={() => setActiveTab('ledger')}
              aria-current={activeTab === 'ledger' ? 'page' : undefined}
              className={`py-3 px-6 text-caption font-bold transition border-b-2 -mb-px flex items-center space-x-1.5 shrink-0 ${
                activeTab === 'ledger' ? 'border-[var(--appearance-primary)] text-[var(--appearance-text-primary)] font-extrabold' : 'border-transparent text-[var(--appearance-text-muted)] hover:text-[var(--appearance-text-primary)]'
              }`}
            >
              <Coins size={ICON_SIZE.metadata} aria-hidden="true" />
              <span>{t.ledgerTab}</span>
            </button>
            <button
              onClick={() => setActiveTab('review')}
              aria-current={activeTab === 'review' ? 'page' : undefined}
              className={`py-3 px-6 text-caption font-bold transition border-b-2 -mb-px flex items-center space-x-1.5 shrink-0 ${
                activeTab === 'review' ? 'border-[var(--appearance-primary)] text-[var(--appearance-text-primary)] font-extrabold' : 'border-transparent text-[var(--appearance-text-muted)] hover:text-[var(--appearance-text-primary)]'
              }`}
            >
              <FileCheck size={ICON_SIZE.metadata} aria-hidden="true" />
              <span>Manual Review</span>
            </button>
            <button
              onClick={() => setActiveTab('categories')}
              aria-current={activeTab === 'categories' ? 'page' : undefined}
              className={`py-3 px-6 text-caption font-bold transition border-b-2 -mb-px flex items-center space-x-1.5 shrink-0 ${
                activeTab === 'categories' ? 'border-[var(--appearance-primary)] text-[var(--appearance-text-primary)] font-extrabold' : 'border-transparent text-[var(--appearance-text-muted)] hover:text-[var(--appearance-text-primary)]'
              }`}
            >
              <Coins size={ICON_SIZE.metadata} aria-hidden="true" />
              <span>{t.categoriesTab}</span>
            </button>
            <button
              onClick={() => setActiveTab('strikes')}
              aria-current={activeTab === 'strikes' ? 'page' : undefined}
              className={`py-3 px-6 text-caption font-bold transition border-b-2 -mb-px flex items-center space-x-1.5 shrink-0 ${
                activeTab === 'strikes' ? 'border-[var(--appearance-primary)] text-[var(--appearance-text-primary)] font-extrabold' : 'border-transparent text-[var(--appearance-text-muted)] hover:text-[var(--appearance-text-primary)]'
              }`}
            >
              <ShieldAlert size={ICON_SIZE.metadata} aria-hidden="true" />
              <span>Payment Strikes</span>
            </button>
          </nav>
          <div className="space-y-6 min-w-0">

          {/* PAGE TITLE — the console's ONE page-level <h1>. The old 3xl title
              above the sidebar was removed, so this band is the single heading
              owner; its title and description come from the shared
              CONSOLE_SECTIONS table and change with the active section. The
              dashboard refresh control lives here because it refreshes the
              whole console payload, not any one section. */}
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 pb-3 border-b border-[var(--appearance-border)]">
            <div className="space-y-1 min-w-0">
              {/* UX-15B — the heading's approved semantic contract: the type
                  ladder's subsection step on small screens and its section step
                  from sm up (20/28 → 24/32) — exactly the text-xl → text-2xl
                  pair it replaces, now on the UX-01 ladder. This is still the
                  console's ONE page-level <h1>. */}
              <h1 className="text-subsection sm:text-section font-extrabold tracking-tight text-[var(--appearance-text-primary)]">
                {sectionCopy.title}
              </h1>
              <p className="text-body text-[var(--appearance-text-muted)] leading-relaxed max-w-2xl">{sectionCopy.description}</p>
            </div>
            <Button
              variant="outline"
              size="md"
              onClick={fetchDashboardData}
              title="Refresh Audit Data"
              aria-label="Refresh Audit Data"
              className="shrink-0 self-start"
            >
              <RefreshCw size={ICON_SIZE.metadata} aria-hidden="true" />
              <span>{'Refresh'}</span>
            </Button>
          </div>

          {/* ==================================================================
              UX-15C / UX-15D — THE SECTION PANELS NOW SPEAK THE DESIGN SYSTEM.

              The nine authenticated panels below (stats, agents, found items,
              disputes, claims, lost reports, ledger, review, categories,
              strikes) were the last surface in the product still mixing the
              pre-UX-01 vocabulary: `stone-*` / `red-*` palettes, literal
              `bg-white` cards, `brand-*` / `canvas-*` surfaces that never flipped
              in the dark theme, off-ladder `text-[9px]` / `[10px]` / `[11px]`
              captions, and icons sized by magic numbers.

              EVERYTHING BELOW IS PRESENTATION ONLY. Not one section, key,
              filter, condition, loop, table column, handler, API call, payload
              or permission changed. What moved:
                * type       -> the UX-01 ladder (text-caption / text-body /
                                text-body-large / text-heading / text-section,
                                every step size-preserving versus the class it
                                replaced);
                * surface    -> --appearance-surface / -surface-muted;
                * text       -> --appearance-text-primary / -secondary / -muted;
                * rule       -> --appearance-border;
                * status     -> --appearance-danger / -warning / -success;
                * actions    -> the shared Button where the element is a true
                                action (navigation tabs, disclosure controls and
                                filter chips deliberately stay native buttons);
                * icons      -> ICON_SIZE, so no icon is sized by a literal;
                * dark mode  -> every migrated surface now flips with
                                html[data-theme='dark'].
              ================================================================== */}

          {/* TAB CONTENT 1: STATS WORKSPACE */}
          {activeTab === 'stats' && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3 sm:gap-4">
                <StatCard
                  icon={Package}
                  label={'Active Holding Items'}
                  value={dashboardData.stats.itemsAtAgentCount}
                />
                <StatCard
                  icon={Users}
                  label={'Pending Agents'}
                  value={dashboardData.stats.pendingAgentsCount}
                />
                {/* PHASE 10 (F-2): this card previously rendered
                    `stats.escrowHeldCount` — a COUNT of claims — under the label
                    "Escrow Funds Held", immediately to the left of a genuine
                    `KES {totalRevenue}` card, so the figure read as money. It now
                    shows the authoritative monetary total (SUM of the
                    escrow-held claims' locked_total_fee, computed server-side),
                    and the count has its own card under a label that says what it
                    is. The misleading presentation is gone from both the value
                    and the label. */}
                {/* These two cards are deliberately NOT <StatCard>: their exact
                    rendered label/value markup is pinned by adminEscrowMetric.test.ts
                    (the financial-truthfulness guard that stops a claim COUNT
                    being shown as money). They are styled to the same visual
                    language as StatCard so the grid still reads as one set. */}
                <div className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-2xl p-4 sm:p-5 shadow-sm">
                  <span className="block text-caption font-extrabold uppercase tracking-widest text-[var(--appearance-text-muted)]">Escrow Funds Held</span>
                  <span className="block mt-1 text-section font-extrabold text-[var(--appearance-primary)] tabular-nums tracking-tight leading-tight">KES {dashboardData.stats.escrowHeldAmount}</span>
                </div>
                <div className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-2xl p-4 sm:p-5 shadow-sm">
                  <span className="block text-caption font-extrabold uppercase tracking-widest text-[var(--appearance-text-muted)]">Claims in Escrow</span>
                  <span className="block mt-1 text-section font-extrabold text-[var(--appearance-primary)] tabular-nums tracking-tight leading-tight">{dashboardData.stats.escrowHeldCount}</span>
                </div>
                <StatCard
                  icon={Coins}
                  label={t.totalRev}
                  value={`KES ${dashboardData.stats.totalRevenue}`}
                />
              </div>

              {/* Admin 2FA / Security */}
              <div className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-2xl p-6 shadow-sm space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-extrabold text-caption text-[var(--appearance-text-muted)] uppercase tracking-widest flex items-center gap-2">
                    <ShieldCheck size={ICON_SIZE.ui} aria-hidden="true" />
                    {'Two-factor authentication (2FA)'}
                  </h3>
                  <Badge variant={adminTotpEnabled ? 'success' : 'neutral'}>
                    {adminTotpEnabled ? ('Enabled') : ('Not enabled')}
                  </Badge>
                </div>

                {twoFaError && <Banner kind="error">{twoFaError}</Banner>}
                {twoFaMessage && <Banner kind="success">{twoFaMessage}</Banner>}

                {/* Idle state — nothing staged and no codes awaiting
                    acknowledgement. This is also where the two entry points
                    (enable, or re-enroll) and the disable control live. */}
                {!twoFaSetupData && !twoFaRecoveryCodes && !twoFaShowEnrollForm && (
                  <div className="space-y-3">
                    <p className="text-body text-[var(--appearance-text-muted)]">
                      {adminTotpEnabled
                        ? ('Your administrator account is protected by an authenticator app. You can configure a replacement authenticator at any time — the current one keeps working until the new one is confirmed.')
                        : ('This admin account does not have 2FA enabled. Given this account controls dispute resolution, agent approval, and the full financial ledger, we strongly recommend enabling it.')}
                    </p>

                    {!twoFaShowDisableForm && (
                      <div className="flex flex-wrap items-center gap-4">
                        {adminTotpEnabled ? (
                          <>
                            <Button type="button" variant="secondary" onClick={openTwoFaEnrollForm}>
                              {'Re-enroll authenticator'}
                            </Button>
                            <button
                              type="button"
                              onClick={() => {
                                setTwoFaError('');
                                setTwoFaMessage('');
                                setTwoFaShowDisableForm(true);
                              }}
                              className="self-start text-caption font-bold text-status-danger underline hover:no-underline cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-orange/40 rounded"
                            >
                              {'Disable 2FA'}
                            </button>
                          </>
                        ) : (
                          <Button type="button" variant="primary" onClick={openTwoFaEnrollForm} className="self-start">
                            {'Enable 2FA'}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Enrollment / re-enrollment. The staged secret exists ONLY in
                    component state (`twoFaSetupData`) for exactly as long as this
                    panel is on screen: never logged, never stored, never in the
                    URL. */}
                {twoFaSetupData && (
                  <div className="space-y-4 bg-[var(--appearance-surface-muted)] border border-[var(--appearance-border)] rounded-2xl p-4">
                    <h4 className="text-heading font-extrabold text-[var(--appearance-text-primary)]">
                      {adminTotpEnabled
                        ? ('Set up your replacement authenticator')
                        : ('Set up two-factor authentication')}
                    </h4>
                    {adminTotpEnabled && (
                      <Banner kind="info">
                        {'Your current authenticator stays active until you confirm a code from the new one — nothing is switched off while you set this up.'}
                      </Banner>
                    )}
                    <div className="space-y-2">
                      <p className="text-body font-bold text-[var(--appearance-text-primary)]">
                        {'1. Scan this QR code with your authenticator app'}
                      </p>
                      <div className="inline-block rounded-2xl border border-[var(--appearance-border)] bg-[var(--appearance-surface)] p-3">
                        <QRCodeSVG
                          value={twoFaSetupData.otpauthUrl}
                          size={TWO_FA_QR_SIZE}
                          marginSize={TWO_FA_QR_MARGIN}
                          level="M"
                          role="img"
                          aria-label={'QR code that adds this Return4me administrator account to an authenticator app'}
                          title={'Two-factor authentication setup QR code'}
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <p className="text-body font-bold text-[var(--appearance-text-primary)]">
                        {'2. Or enter this setup key manually'}
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="font-mono text-caption bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-lg px-3 py-2 break-all select-all text-[var(--appearance-text-primary)]">
                          {twoFaSetupData.secret}
                        </code>
                        <Button type="button" variant="secondary" size="sm" onClick={copyTwoFaSecret}>
                          <Copy size={ICON_SIZE.metadata} aria-hidden="true" />
                          {'Copy setup key'}
                        </Button>
                      </div>
                      {twoFaCopied === 'secret' && (
                        <p role="status" className="text-caption font-bold text-status-success">
                          {'Setup key copied.'}
                        </p>
                      )}
                      {twoFaCopyError && (
                        <p role="alert" className="text-caption font-bold text-status-danger">{twoFaCopyError}</p>
                      )}
                    </div>
                    <form onSubmit={handleTwoFaConfirm} className="space-y-2">
                      <p className="text-body font-bold text-[var(--appearance-text-primary)]">
                        {'3. Enter the 6-digit code your app shows'}
                      </p>
                      <div className="flex flex-wrap gap-2 items-end">
                        <div className="space-y-1">
                          <label htmlFor="twofa-confirm-code" className="block text-caption font-bold text-[var(--appearance-text-primary)]">
                            {'Verification code'}
                          </label>
                          <input
                            id="twofa-confirm-code"
                            type="text"
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            maxLength={6}
                            value={twoFaConfirmCode}
                            onChange={handleTwoFaCodeChange}
                            placeholder="123456"
                            className="w-full h-11 border border-[var(--appearance-border)] rounded-xl px-3 text-body font-mono text-center tracking-widest focus:outline-none focus:border-accent-orange focus:ring-2 focus:ring-accent-orange/30"
                            required
                          />
                        </div>
                        <Button type="submit" variant="primary" loading={twoFaProcessing} disabled={twoFaConfirmCode.length !== 6}>
                          {adminTotpEnabled
                            ? ('Confirm and replace')
                            : ('Confirm and enable')}
                        </Button>
                      </div>
                    </form>
                    <button
                      type="button"
                      onClick={cancelTwoFaEnrollForm}
                      className="text-caption font-bold text-[var(--appearance-text-muted)] underline hover:no-underline cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-orange/40 rounded"
                    >
                      {'Cancel setup'}
                    </button>
                  </div>
                )}

                {/* Password re-entry: the server verifies the current password
                    before it issues a secret, so a stolen session token alone
                    cannot (re)enroll an authenticator. */}
                {!twoFaSetupData && !twoFaRecoveryCodes && twoFaShowEnrollForm && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void handleTwoFaStartSetup();
                    }}
                    className="space-y-2 bg-[var(--appearance-surface-muted)] border border-[var(--appearance-border)] rounded-2xl p-4"
                  >
                    <p className="text-body text-[var(--appearance-text-muted)]">
                      {adminTotpEnabled
                        ? ('Confirm your password to stage a replacement authenticator. Your current authenticator stays active until you confirm a code from the new one.')
                        : ('Confirm your password to begin. A stolen session on its own can never turn 2FA on or replace it.')}
                    </p>
                    <div className="space-y-1">
                      <label htmlFor="twofa-start-password" className="block text-caption font-bold text-[var(--appearance-text-primary)]">
                        {'Confirm your password'}
                      </label>
                      <input
                        id="twofa-start-password"
                        type="password"
                        autoComplete="current-password"
                        value={twoFaStartPassword}
                        onChange={(e) => setTwoFaStartPassword(e.target.value)}
                        className="w-full h-11 border border-[var(--appearance-border)] rounded-xl px-3 text-body focus:outline-none focus:border-accent-orange focus:ring-2 focus:ring-accent-orange/30"
                        required
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button type="submit" variant="primary" loading={twoFaProcessing} disabled={!twoFaStartPassword}>
                        {adminTotpEnabled
                          ? ('Generate new QR code')
                          : ('Continue')}
                      </Button>
                      <Button type="button" variant="ghost" onClick={cancelTwoFaEnrollForm}>
                        {'Cancel'}
                      </Button>
                    </div>
                  </form>
                )}

                {/* Recovery codes — shown ONCE, immediately after a successful
                    /confirm, and never hidden behind a timer. The list lives in
                    component state only and is cleared when acknowledged. */}
                {twoFaRecoveryCodes && (
                  <div className="space-y-4 bg-[var(--appearance-surface-muted)] border border-[var(--appearance-border)] rounded-2xl p-4">
                    <h4 className="text-heading font-extrabold text-[var(--appearance-text-primary)] flex items-center gap-2">
                      <ShieldAlert size={ICON_SIZE.ui} aria-hidden="true" />
                      {'Save your recovery codes'}
                    </h4>
                    <Banner kind="warning">
                      {'These codes are your backup way in. Each one works a single time, and none of them will be shown again. Save them somewhere safe before you leave this screen.'}
                    </Banner>
                    <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {twoFaRecoveryCodes.map((code) => (
                        <li
                          key={code}
                          className="font-mono text-body tracking-widest text-center break-all bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-lg px-3 py-2 text-[var(--appearance-text-primary)] select-all"
                        >
                          {code}
                        </li>
                      ))}
                    </ul>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button type="button" variant="secondary" size="sm" onClick={copyTwoFaRecoveryCodes}>
                        <Copy size={ICON_SIZE.metadata} aria-hidden="true" />
                        {'Copy all codes'}
                      </Button>
                      <Button type="button" variant="primary" onClick={finishTwoFaEnrollment}>
                        {'Done, I have saved them'}
                      </Button>
                    </div>
                    {twoFaCopied === 'codes' && (
                      <p role="status" className="text-caption font-bold text-status-success">
                        {'Recovery codes copied.'}
                      </p>
                    )}
                    {twoFaCopyError && (
                      <p role="alert" className="text-caption font-bold text-status-danger">{twoFaCopyError}</p>
                    )}
                  </div>
                )}

                {adminTotpEnabled && twoFaShowDisableForm && (
                  <form
                    onSubmit={handleTwoFaDisable}
                    className="flex flex-wrap gap-2 items-end bg-status-danger-surface border border-status-danger-border rounded-2xl p-4"
                  >
                    <div className="flex-1 space-y-1">
                      <label htmlFor="twofa-disable-password" className="block text-caption font-bold text-status-danger">
                        {'Confirm password to disable 2FA'}
                      </label>
                      <input
                        id="twofa-disable-password"
                        type="password"
                        autoComplete="current-password"
                        value={twoFaDisablePassword}
                        onChange={(e) => setTwoFaDisablePassword(e.target.value)}
                        className="w-full h-11 border border-[var(--appearance-border)] rounded-xl px-3 text-body focus:outline-none focus:border-accent-orange focus:ring-2 focus:ring-accent-orange/30"
                        required
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button type="submit" variant="danger" loading={twoFaProcessing}>
                        {'Disable'}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => {
                          setTwoFaDisablePassword('');
                          setTwoFaShowDisableForm(false);
                          setTwoFaError('');
                        }}
                      >
                        {'Cancel'}
                      </Button>
                    </div>
                  </form>
                )}
              </div>

              {/* Audit logs timeline */}
              <div className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-2xl p-6 shadow-sm space-y-4">
                <h3 className="font-extrabold text-caption text-[var(--appearance-text-muted)] uppercase tracking-widest">Real-time Platform Audit Logs</h3>
                {dashboardData.auditLogs.length === 0 ? (
                  <EmptyState
                    icon={ClipboardList}
                    title={'No audit activity yet'}
                    description={'Platform actions appear here as they are recorded.'}
                  />
                ) : (
                  <div className="h-60 overflow-y-auto border border-[var(--appearance-border)] rounded-xl font-mono text-caption p-4 bg-[var(--appearance-surface-muted)] space-y-2 leading-relaxed">
                    {dashboardData.auditLogs.map((log: any) => (
                      <div key={log.id} className="text-[var(--appearance-text-muted)] border-b border-[var(--appearance-border)]/60 pb-1.5 flex justify-between items-start gap-3">
                        <div className="min-w-0">
                          <span className="text-[var(--appearance-primary)] font-bold mr-2">[{log.action.toUpperCase()}]</span>
                          <span>{log.details}</span>
                        </div>
                        <span className="text-[var(--appearance-text-muted)] shrink-0 ml-3">{new Date(log.created_at).toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB CONTENT 2: AGENTS VETTING & DIRECTORY */}
          {activeTab === 'agents' && (
            <div className="space-y-6">
              {/* Search & Filters */}
              <div className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-2xl p-4 shadow-sm flex flex-col sm:flex-row gap-3 sm:items-end">
                <Input
                  label={'Search agents'}
                  hideLabel
                  type="text"
                  value={agentSearch}
                  onChange={(e) => setAgentSearch(e.target.value)}
                  placeholder={'Search by business name, phone, email, till...'}
                  className="flex-1"
                />
                <Select
                  label={'Filter by agent status'}
                  hideLabel
                  value={agentStatusFilter}
                  onChange={(e) => setAgentStatusFilter(e.target.value)}
                  className="sm:w-60"
                >
                  <option value="all">{'All Statuses'}</option>
                  <option value="pending">{'Pending Approval'}</option>
                  <option value="active">{'Active Hubs'}</option>
                  <option value="suspended">{'Suspended Hubs'}</option>
                </Select>
              </div>

              {/* Agent List */}
              {(() => {
                const filteredAgents = dashboardData.agents.filter((a: any) => {
                  const query = agentSearch.toLowerCase().trim();
                  const matchesSearch = !query || 
                    (a.business_name && a.business_name.toLowerCase().includes(query)) ||
                    (a.contact_phone && a.contact_phone.toLowerCase().includes(query)) ||
                    (a.contact_email && a.contact_email.toLowerCase().includes(query)) ||
                    (a.mpesa_till_or_paybill && a.mpesa_till_or_paybill.toLowerCase().includes(query)) ||
                    (a.location_address && a.location_address.toLowerCase().includes(query)) ||
                    (a.id && a.id.toLowerCase().includes(query));
                  
                  const matchesFilter = agentStatusFilter === 'all' || a.status === agentStatusFilter;
                  return matchesSearch && matchesFilter;
                });

                if (filteredAgents.length === 0) {
                  return (
                    <EmptyState
                      icon={Users}
                      title={'No agents found'}
                      description={'No registered agents match the current search or status filter.'}
                    />
                  );
                }

                return (
                  <div className="space-y-3">
                    {filteredAgents.map((agent: any) => {
                      const isExpanded = expandedAgentId === agent.id;
                      return (
                        <div 
                          key={agent.id} 
                          className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-2xl shadow-sm hover:shadow-md transition overflow-hidden"
                        >
                          {/* Core Row Header */}
                          <div 
                            onClick={() => setExpandedAgentId(isExpanded ? null : agent.id)}
                            className="p-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 cursor-pointer hover:bg-[var(--appearance-surface-muted)] transition"
                            role="button"
                            tabIndex={0}
                            aria-expanded={isExpanded}
                            aria-label={`${isExpanded ? 'Collapse' : 'Expand'} details for ${agent.business_name}`}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                setExpandedAgentId(isExpanded ? null : agent.id);
                              }
                            }}
                          >
                            <div className="space-y-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <Badge variant={agent.status === 'active' ? 'success' : agent.status === 'pending' ? 'warning' : 'danger'}>
                                  {agent.status}
                                </Badge>
                                {agent.needs_manual_geocoding && (
                                  <Badge variant="danger">Needs Geocoding</Badge>
                                )}
                                <Badge variant="code">ID: {agent.id}</Badge>
                              </div>
                              <h3 className="text-heading font-extrabold text-[var(--appearance-text-primary)]">{agent.business_name}</h3>
                              <p className="text-[var(--appearance-text-muted)] text-caption line-clamp-1">{agent.location_address}</p>
                            </div>

                            <div className="flex items-center gap-3 self-stretch md:self-auto justify-between md:justify-end">
                              <div className="text-right hidden md:block">
                                <div className="text-caption font-bold text-status-success">KES {(agent.total_earned || 0).toLocaleString()} {'earned'}</div>
                                <div className="text-caption text-[var(--appearance-text-muted)] font-mono">{agent.contact_phone} · Till: {agent.mpesa_till_or_paybill}</div>
                              </div>
                              <div className="flex items-center gap-2">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setExpandedAgentId(isExpanded ? null : agent.id);
                                  }}
                                >
                                  {isExpanded ? ('Hide Details') : ('View Details')}
                                </Button>
                              </div>
                            </div>
                          </div>

                          {/* Expanded Details Body */}
                          {isExpanded && (
                            <div className="border-t border-[var(--appearance-border)] bg-[var(--appearance-surface-muted)]/60 p-5 space-y-4 fade-in text-caption text-[var(--appearance-text-muted)]">
                              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                                {/* Column 1: Verification / Details */}
                                <div className="space-y-2">
                                  <span className="text-caption font-extrabold text-[var(--appearance-text-muted)] uppercase tracking-wider block">Agent Contact Details</span>
                                  <p><b>Business Name:</b> {agent.business_name}</p>
                                  <p><b>Contact Phone:</b> {agent.contact_phone}</p>
                                  <p><b>Contact Email:</b> {agent.contact_email || 'Not Provided'}</p>
                                  <p className="pt-1">
                                    <b>Total Earned:</b>{' '}
                                    <span className="text-[var(--appearance-success)] font-extrabold">KES {(agent.total_earned || 0).toLocaleString()}</span>
                                    {' '}<span className="text-[var(--appearance-text-muted)]">({agent.completed_payouts_count || 0} completed handovers)</span>
                                  </p>
                                </div>

                                {/* Column 2: Location and Map */}
                                <div className="space-y-2">
                                  <span className="text-caption font-extrabold text-[var(--appearance-text-muted)] uppercase tracking-wider block">Physical Coordinates</span>
                                  <p><b>Full Address:</b> {agent.location_address}</p>
                                  {agent.latitude && agent.longitude ? (
                                    <>
                                      <p><b>Latitude:</b> {parseFloat(agent.latitude).toFixed(6)}</p>
                                      <p><b>Longitude:</b> {parseFloat(agent.longitude).toFixed(6)}</p>
                                      <a 
                                        href={`https://www.google.com/maps/search/?api=1&query=${agent.latitude},${agent.longitude}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-[var(--appearance-primary)] hover:underline font-bold inline-flex items-center space-x-1"
                                      >
                                        <span>View on Google Maps</span>
                                      </a>
                                    </>
                                  ) : (
                                    <div className="space-y-2">
                                      <p className="text-[var(--appearance-danger)] font-bold">GPS coordinates unavailable — this agent cannot receive GPS-matched items until fixed</p>
                                      {locationFormAgentId === agent.id ? (
                                        <div className="flex flex-wrap items-end gap-2 p-2 bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-xl">
                                          <div>
                                            <label htmlFor={`agent-lat-${agent.id}`} className="text-caption font-bold text-[var(--appearance-text-muted)] block">Latitude</label>
                                            <input
                                              id={`agent-lat-${agent.id}`}
                                              type="text"
                                              value={locationFormLat}
                                              onChange={(e) => setLocationFormLat(e.target.value)}
                                              placeholder="-1.286389"
                                              className="w-28 border border-[var(--appearance-border)] rounded-lg px-2 py-1 text-caption font-mono"
                                            />
                                          </div>
                                          <div>
                                            <label htmlFor={`agent-lon-${agent.id}`} className="text-caption font-bold text-[var(--appearance-text-muted)] block">Longitude</label>
                                            <input
                                              id={`agent-lon-${agent.id}`}
                                              type="text"
                                              value={locationFormLon}
                                              onChange={(e) => setLocationFormLon(e.target.value)}
                                              placeholder="36.817223"
                                              className="w-28 border border-[var(--appearance-border)] rounded-lg px-2 py-1 text-caption font-mono"
                                            />
                                          </div>
                                          <Button variant="primary" size="sm" disabled={adminActionProcessing} onClick={() => handleSetAgentLocation(agent.id)}>Save</Button>
                                          <Button variant="secondary" size="sm" onClick={() => setLocationFormAgentId(null)}>Cancel</Button>
                                          <a
                                            href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(agent.location_address)}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-[var(--appearance-primary)] hover:underline text-caption font-bold"
                                          >
                                            Look up on Google Maps
                                          </a>
                                        </div>
                                      ) : (
                                        <Button variant="outline" size="sm" onClick={() => { setLocationFormAgentId(agent.id); setLocationFormLat(''); setLocationFormLon(''); }}>Set Coordinates Manually</Button>
                                      )}
                                    </div>
                                  )}
                                  <p><b>Date Registered:</b> {new Date(agent.created_at).toLocaleDateString()} {new Date(agent.created_at).toLocaleTimeString()}</p>
                                </div>

                                {/* Column 3: Performance, Finance & Warnings */}
                                <div className="space-y-2">
                                  <span className="text-caption font-extrabold text-[var(--appearance-text-muted)] uppercase tracking-wider block">Financials, Rating & Warnings</span>
                                  <p><b>Payout Method:</b> {agent.payout_method_type || 'Till Number'}</p>
                                  <p><b>M-Pesa Target:</b> {agent.mpesa_till_or_paybill}</p>
                                  <p><b>Refundable Security Deposit:</b> KES {parseFloat(agent.refundable_deposit || '0').toLocaleString()}</p>
                                  <p className="flex items-center gap-1.5">
                                    <b>Rating Score:</b> 
                                    <span className="bg-[var(--appearance-surface-muted)] text-[var(--appearance-warning)] font-extrabold px-2 py-0.5 rounded border border-[var(--appearance-warning)] flex items-center gap-0.5">
                                      {parseFloat(agent.rating || '5.0').toFixed(1)}
                                    </span>
                                    <span>({agent.rating_count || 0} reviews)</span>
                                  </p>
                                  <div className="bg-[var(--appearance-surface-muted)] border border-[var(--appearance-danger)] p-2 rounded-xl space-y-1 mt-1">
                                    <p className="font-bold text-[var(--appearance-danger)] text-caption">Warnings: {agent.warning_count || 0}</p>
                                    {agent.last_warning_reason && (
                                      <p className="text-caption text-[var(--appearance-danger)] italic">"Last: {agent.last_warning_reason}"</p>
                                    )}
                                  </div>
                                </div>
                              </div>

                              {/* Shop Front & ID Photos Viewer.
                                  These two artefacts are sensitive vetting
                                  evidence and are no longer part of the bulk
                                  dashboard payload — they are fetched on demand
                                  for this agent only, when the row is expanded
                                  (GET /api/admin/agents/:id/documents). */}
                              {agentDocsLoading === agent.id ? (
                                <div className="border-t border-[var(--appearance-border)] pt-3 space-y-2">
                                  <span className="text-caption font-extrabold text-[var(--appearance-text-muted)] uppercase tracking-wider block">Agent Verification Photographs</span>
                                  <p className="text-caption text-[var(--appearance-text-muted)] flex items-center gap-1.5" aria-busy="true">
                                    <Loader2 className="animate-spin" size={ICON_SIZE.metadata} aria-hidden="true" /> Loading verification photographs…
                                  </p>
                                </div>
                              ) : agentDocs && agentDocs.id === agent.id ? (
                                (agentDocs.shop_photo_url || agentDocs.id_document_photo_url) ? (
                                  <div className="border-t border-[var(--appearance-border)] pt-3 space-y-2">
                                    <span className="text-caption font-extrabold text-[var(--appearance-text-muted)] uppercase tracking-wider block">Agent Verification Photographs</span>
                                    <div className="flex flex-wrap gap-4">
                                      {agentDocs.shop_photo_url && (
                                        <div
                                          onClick={() => setLightboxImage(agentDocs.shop_photo_url)}
                                          className="cursor-pointer space-y-1 group"
                                          role="button"
                                          tabIndex={0}
                                          aria-label="View shop / business location photo full-size"
                                          onKeyDown={(e) => {
                                            if (e.key === 'Enter' || e.key === ' ') {
                                              e.preventDefault();
                                              setLightboxImage(agentDocs.shop_photo_url);
                                            }
                                          }}
                                        >
                                          <p className="text-caption font-bold text-[var(--appearance-text-primary)]">Shop / Business Location Front</p>
                                          <div className="w-32 h-24 rounded-xl border border-[var(--appearance-border)] overflow-hidden bg-[var(--appearance-surface-muted)] relative">
                                            <img src={agentDocs.shop_photo_url} alt="Shop Front" className="w-full h-full object-cover group-hover:scale-105 transition" />
                                          </div>
                                        </div>
                                      )}
                                      {agentDocs.id_document_photo_url && (
                                        <div
                                          onClick={() => setLightboxImage(agentDocs.id_document_photo_url)}
                                          className="cursor-pointer space-y-1 group"
                                          role="button"
                                          tabIndex={0}
                                          aria-label="View national ID document photo full-size"
                                          onKeyDown={(e) => {
                                            if (e.key === 'Enter' || e.key === ' ') {
                                              e.preventDefault();
                                              setLightboxImage(agentDocs.id_document_photo_url);
                                            }
                                          }}
                                        >
                                          <p className="text-caption font-bold text-[var(--appearance-text-primary)]">National ID Document Photo</p>
                                          <div className="w-32 h-24 rounded-xl border border-[var(--appearance-border)] overflow-hidden bg-[var(--appearance-surface-muted)] relative">
                                            <img src={agentDocs.id_document_photo_url} alt="ID Document" className="w-full h-full object-cover group-hover:scale-105 transition" />
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                ) : (
                                  <div className="border-t border-[var(--appearance-border)] pt-3">
                                    <span className="text-caption font-extrabold text-[var(--appearance-text-muted)] uppercase tracking-wider block">Agent Verification Photographs</span>
                                    <p className="text-caption text-[var(--appearance-text-muted)] pt-1">No verification photographs on file for this agent.</p>
                                  </div>
                                )
                              ) : agentDocsError && expandedAgentId === agent.id ? (
                                <div className="border-t border-[var(--appearance-border)] pt-3">
                                  <span className="text-caption font-extrabold text-[var(--appearance-text-muted)] uppercase tracking-wider block">Agent Verification Photographs</span>
                                  <p className="text-caption text-status-danger pt-1">{agentDocsError}</p>
                                </div>
                              ) : null}

                              {/* Actions on this Agent */}
                              <div className="border-t border-[var(--appearance-border)] pt-4 flex flex-wrap justify-end gap-2">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={adminActionProcessing}
                                  onClick={() => openAgentWarnDialog(agent.id)}
                                >
                                  Issue Warning
                                </Button>
                                {agent.status === 'pending' && (
                                  <Button
                                    variant="primary"
                                    size="sm"
                                    disabled={adminActionProcessing}
                                    onClick={() => handleApproveAgent(agent.id)}
                                  >
                                    {t.approveBtn}
                                  </Button>
                                )}

                                {agent.status === 'active' && (
                                  <Button
                                    variant="danger"
                                    size="sm"
                                    disabled={adminActionProcessing}
                                    onClick={() => handleSuspendAgent(agent.id)}
                                  >
                                    Suspend Agent
                                  </Button>
                                )}

                                {agent.status === 'suspended' && (
                                  <Button
                                    variant="secondary"
                                    size="sm"
                                    disabled={adminActionProcessing}
                                    onClick={() => handleApproveAgent(agent.id)}
                                  >
                                    Re-Activate Agent
                                  </Button>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          )}

          {/* TAB CONTENT: ALL FOUND ITEMS REAL-TIME DIRECTORY */}
          {activeTab === 'found_items' && (
            <div className="space-y-6">
              {/* Filters Panel */}
              <div className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-2xl p-5 shadow-sm space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  {/* Search bar */}
                  <Input
                    label="Search Items"
                    id="item-search"
                    type="text"
                    value={itemSearch}
                    onChange={(e) => setItemSearch(e.target.value)}
                    placeholder="Search by Code, OCR info, Location, Phone..."
                    className="md:col-span-2"
                  />

                  {/* Status filter */}
                  <Select
                    label="Hali / Status"
                    id="item-status-filter"
                    value={itemStatusFilter}
                    onChange={(e) => setItemStatusFilter(e.target.value)}
                  >
                    <option value="all">All Statuses</option>
                    <option value="awaiting_dropoff">Awaiting Drop-off</option>
                    <option value="at_agent">At Agent Station</option>
                    <option value="claimed">Claimed & Handed Over</option>
                    <option value="expired">Expired</option>
                    <option value="suspected_stolen">Suspected Stolen</option>
                    <option value="legal_hold">Legal Hold</option>
                  </Select>

                  {/* Flagged filter */}
                  <Select
                    label="Review Flag"
                    id="item-flag-filter"
                    value={itemFlagFilter}
                    onChange={(e) => setItemFlagFilter(e.target.value)}
                  >
                    <option value="all">All Items</option>
                    <option value="flagged">Flagged for Review</option>
                    <option value="normal">Normal / Approved</option>
                  </Select>
                </div>

                <div className="flex flex-wrap gap-2 pt-2 border-t border-[var(--appearance-border)]">
                  <span className="text-caption font-bold text-[var(--appearance-text-muted)] self-center uppercase tracking-wider mr-1">Quick Categories:</span>
                  <button
                    onClick={() => setItemCategoryFilter('all')}
                    aria-pressed={itemCategoryFilter === 'all'}
                    className={`min-h-11 px-3 py-1.5 text-caption font-bold rounded-full border transition cursor-pointer ${
                      itemCategoryFilter === 'all'
                        ? 'bg-[var(--appearance-primary)] text-[var(--appearance-primary-foreground)] border-[var(--appearance-primary)]'
                        : 'bg-[var(--appearance-surface)] text-[var(--appearance-text-primary)] border-[var(--appearance-border)] hover:border-[var(--appearance-primary)]'
                    }`}
                  >
                    All Categories
                  </button>
                  {categories.map((cat: any) => (
                    <button
                      key={cat.id}
                      onClick={() => setItemCategoryFilter(cat.id)}
                      aria-pressed={itemCategoryFilter === cat.id}
                      className={`min-h-11 px-3 py-1.5 text-caption font-bold rounded-full border transition cursor-pointer ${
                        itemCategoryFilter === cat.id
                          ? 'bg-[var(--appearance-primary)] text-[var(--appearance-primary-foreground)] border-[var(--appearance-primary)]'
                          : 'bg-[var(--appearance-surface)] text-[var(--appearance-text-primary)] border-[var(--appearance-border)] hover:border-[var(--appearance-primary)]'
                      }`}
                    >
                      {cat.name_en}
                    </button>
                  ))}
                </div>
              </div>

              {/* Items Render Grid */}
              {(() => {
                const filteredItems = dashboardData.items.filter((item: any) => {
                  const query = itemSearch.toLowerCase().trim();
                  const matchesSearch = !query ||
                    (item.id && item.id.toLowerCase().includes(query)) ||
                    (item.ocr_extracted_number && item.ocr_extracted_number.toLowerCase().includes(query)) ||
                    (item.ocr_extracted_name && item.ocr_extracted_name.toLowerCase().includes(query)) ||
                    (item.verified_document_number && item.verified_document_number.toLowerCase().includes(query)) ||
                    (item.verified_name && item.verified_name.toLowerCase().includes(query)) ||
                    (item.location_description && item.location_description.toLowerCase().includes(query)) ||
                    (item.finder_phone && item.finder_phone.toLowerCase().includes(query)) ||
                    (item.description && item.description.toLowerCase().includes(query));

                  const matchesStatus = itemStatusFilter === 'all' || item.status === itemStatusFilter;
                  const matchesCategory = itemCategoryFilter === 'all' || item.category_id === itemCategoryFilter;
                  const matchesFlag = itemFlagFilter === 'all' || 
                    (itemFlagFilter === 'flagged' && item.flaggedForReview) ||
                    (itemFlagFilter === 'normal' && !item.flaggedForReview);

                  return matchesSearch && matchesStatus && matchesCategory && matchesFlag;
                });

                if (filteredItems.length === 0) {
                  return (
                    <EmptyState
                      icon={Package}
                      title={'No found items match your filters'}
                      description={'Adjust the search, status, category or review-flag filters to see recovered items.'}
                    />
                  );
                }

                return (
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    {filteredItems.map((item: any) => {
                      // Lookup agent
                      const agentObj = dashboardData.agents.find((a: any) => a.id === item.assigned_agent_id);
                      return (
                        <div key={item.id} className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-2xl p-5 shadow-sm hover:shadow-md transition flex flex-col md:flex-row gap-5">
                          {/* Image Thumbnail with zoom trigger */}
                          <div 
                            onClick={() => setLightboxImage(item.photo_url)}
                            className="w-full md:w-36 h-36 rounded-2xl bg-[var(--appearance-surface-muted)] border border-[var(--appearance-border)] overflow-hidden shrink-0 flex items-center justify-center cursor-zoom-in relative group"
                            role="button"
                            tabIndex={0}
                            aria-label="View item photo full-size"
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                setLightboxImage(item.photo_url);
                              }
                            }}
                          >
                            <img
                              src={item.photo_url}
                              alt="Item Photograph"
                              className="w-full h-full object-contain group-hover:scale-105 transition duration-300"
                              referrerPolicy="no-referrer"
                            />
                            <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition flex items-center justify-center">
                              <span className="text-white text-caption font-black bg-black/70 px-2 py-1 rounded-md uppercase tracking-wider">Zoom View</span>
                            </div>
                          </div>

                          {/* Item Details Column */}
                          <div className="flex-1 flex flex-col justify-between space-y-3 min-w-0">
                            <div className="space-y-1.5">
                              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--appearance-border)] pb-2">
                                <div className="flex items-center gap-1.5">
                                  <Badge variant="code">CODE: {item.id}</Badge>
                                  {item.flaggedForReview && (
                                    <Badge variant="danger">Flagged</Badge>
                                  )}
                                </div>
                                <Badge
                                  variant={
                                    item.status === 'claimed' ? 'success'
                                      : item.status === 'at_agent' ? 'info'
                                        : item.status === 'awaiting_dropoff' ? 'warning'
                                          : item.status === 'suspected_stolen' || item.status === 'legal_hold' ? 'danger'
                                            : 'neutral'
                                  }
                                >
                                  {item.status === 'awaiting_dropoff' ? 'awaiting drop-off' : item.status === 'suspected_stolen' ? 'suspected stolen' : item.status === 'legal_hold' ? 'legal hold' : item.status}
                                </Badge>
                              </div>

                              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-caption">
                                <div>
                                  <span className="text-caption text-[var(--appearance-text-muted)] block">Category</span>
                                  <span className="font-bold text-[var(--appearance-text-primary)]">
                                    {categories.find((c: any) => c.id === item.category_id)?.name_en || item.category_id}
                                  </span>
                                </div>
                                <div>
                                  <span className="text-caption text-[var(--appearance-text-muted)] block">Date Reported</span>
                                  <span className="font-medium text-[var(--appearance-text-primary)]">
                                    {new Date(item.created_at).toLocaleDateString()}
                                  </span>
                                </div>
                                
                                {/* OCR / Description Details */}
                                <div className="col-span-2 pt-1 border-t border-[var(--appearance-border)]">
                                  {item.is_description_only || item.isDescriptionOnly ? (
                                    <div>
                                      <span className="text-caption text-[var(--appearance-text-muted)] block">Description</span>
                                      <p className="text-[var(--appearance-text-secondary)] text-caption leading-normal italic font-medium">"{item.description}"</p>
                                    </div>
                                  ) : (
                                    <>
                                    {/* PI-1 / B3 — show the CURRENT operational identity, not just OCR.
                                        When an Agent corrected a field, the verified value is the
                                        operative name/number; the original OCR is retained below
                                        with an unambiguous label so the correction is visible and
                                        auditable, never silently overwritten. */}
                                    <div className="grid grid-cols-2 gap-2">
                                      <div>
                                        <span className="text-caption text-[var(--appearance-text-muted)] block">
                                          {item.verified_document_number ? 'Verified Number' : 'Extracted Number'}
                                        </span>
                                        <span className="font-mono font-bold text-[var(--appearance-text-primary)] break-all">
                                          {item.verified_document_number || item.ocr_extracted_number || 'None'}
                                        </span>
                                        {item.verified_document_number && item.ocr_extracted_number && item.verified_document_number !== item.ocr_extracted_number && (
                                          <span className="text-caption text-[var(--appearance-text-muted)] block truncate">
                                            Original OCR: {item.ocr_extracted_number}
                                          </span>
                                        )}
                                      </div>
                                      <div>
                                        <span className="text-caption text-[var(--appearance-text-muted)] block">
                                          {item.verified_name ? 'Verified Name' : 'Extracted Name'}
                                        </span>
                                        <span className="font-sans font-extrabold text-[var(--appearance-text-primary)] uppercase line-clamp-1">
                                          {item.verified_name || item.ocr_extracted_name || 'None'}
                                        </span>
                                        {item.verified_name && item.ocr_extracted_name && item.verified_name !== item.ocr_extracted_name && (
                                          <span className="text-caption text-[var(--appearance-text-muted)] block truncate">
                                            Original OCR: {item.ocr_extracted_name}
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                    </>
                                  )}
                                </div>

                                {/* Matching Stats & Location details */}
                                <div className="col-span-2 pt-1 border-t border-[var(--appearance-border)] text-caption">
                                  <p className="text-[var(--appearance-text-muted)]">
                                    <b>Location:</b> {item.location_description}
                                  </p>
                                  {item.latitude && item.longitude && (
                                    <p className="text-[var(--appearance-text-muted)] font-mono text-caption mt-0.5">
                                      GPS: {parseFloat(item.latitude).toFixed(4)}, {parseFloat(item.longitude).toFixed(4)}
                                    </p>
                                  )}
                                </div>

                                {/* Finder phone and reputation */}
                                <div className="col-span-2 pt-1.5 border-t border-[var(--appearance-border)] bg-[var(--appearance-surface-muted)] p-2 rounded-xl text-caption">
                                  <p className="font-bold text-[var(--appearance-text-secondary)]">Finder Information:</p>
                                  <div className="flex justify-between mt-1 text-[var(--appearance-text-secondary)]">
                                    <span>Phone: <b>{item.finder_phone}</b></span>
                                    {item.reputation && (
                                      <span>Reputation: <b>{item.reputation.rejected_reports}/{item.reputation.total_reports} rejected</b></span>
                                    )}
                                  </div>
                                </div>

                                {/* Assigned Agent Hub details */}
                                <div className="col-span-2 pt-1.5 border-t border-[var(--appearance-border)] text-caption">
                                  <span className="text-caption text-[var(--appearance-text-muted)] block">Assigned Physical Agent Station</span>
                                  {agentObj ? (
                                    <div className="mt-0.5 flex justify-between items-center bg-[var(--appearance-surface-muted)] p-2 rounded-xl border border-[var(--appearance-border)]">
                                      <div>
                                        <p className="font-extrabold text-[var(--appearance-text-primary)]">{agentObj.business_name}</p>
                                        <p className="text-caption text-[var(--appearance-text-muted)] line-clamp-1">{agentObj.location_address}</p>
                                      </div>
                                      {item.agent_assignment_distance_km !== null && (
                                        <span className="bg-[var(--appearance-surface-muted)] text-[var(--appearance-text-secondary)] font-mono text-caption px-2 py-0.5 rounded-md font-bold shrink-0">
                                          {parseFloat(item.agent_assignment_distance_km).toFixed(1)} km
                                        </span>
                                      )}
                                    </div>
                                  ) : (
                                    <span className="text-[var(--appearance-danger)] font-bold block">No Assigned Agent (Error)</span>
                                  )}
                                </div>
                              </div>
                            </div>

                            {/* Action to correct / review */}
                            {item.flaggedForReview && (
                              <div className="pt-2 border-t border-[var(--appearance-border)] flex justify-end">
                                <Button
                                  variant="primary"
                                  size="sm"
                                  onClick={() => {
                                    setActiveTab('review');
                                    startReview(item);
                                  }}
                                >
                                  Fix Details / Reassign Hub
                                </Button>
                              </div>
                            )}

                            {/* Stolen-property state machine controls — the platform
                                never publishes an accusation; this only ever changes
                                claimability, and a reason is required and audit-logged
                                for every transition. */}
                            <div className="pt-2 border-t border-[var(--appearance-border)] flex flex-wrap justify-end gap-2">
                              {(item.status === 'suspected_stolen' || item.status === 'legal_hold') ? (
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  disabled={itemActionProcessing === item.id + 'clear-hold'}
                                  onClick={() => promptItemReviewStatusChange(item.id, 'clear-hold', 'Reason for clearing this hold (optional):')}
                                >
                                  Clear Hold
                                </Button>
                              ) : (
                                <>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={itemActionProcessing === item.id + 'flag-stolen'}
                                    onClick={() => promptItemReviewStatusChange(item.id, 'flag-stolen', 'Reason for flagging this item as suspected stolen (required, audit-logged):')}
                                  >
                                    Flag Suspected Stolen
                                  </Button>
                                  <Button
                                    variant="danger"
                                    size="sm"
                                    disabled={itemActionProcessing === item.id + 'legal-hold'}
                                    onClick={() => promptItemReviewStatusChange(item.id, 'legal-hold', 'Reason for placing this item under legal hold (required, audit-logged):')}
                                  >
                                    Place Legal Hold
                                  </Button>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          )}

          {/* TAB CONTENT: CLAIMS ADMINISTRATION (PHASE 6F) */}
          {/* Read-only. Mounting is what triggers the fetch, so entering the tab
              always shows current data (the same freshness guarantee the Agents
              tab gets from its activeTab effect) and leaving it aborts any
              in-flight request. */}
          {activeTab === 'claims' && (
            <ClaimsAdministration token={token} />
          )}

          {/* TAB CONTENT: LOST REPORTS (PHASE 11A) */}
          {/* Read-only operational visibility. Mounting is what triggers the
              fetch, so entering the tab always shows current data, and leaving
              it aborts any in-flight request. There is no admin action here:
              reports are visible, not editable. */}
          {activeTab === 'lost_reports' && (
            <LostReportsAdministration token={token} />
          )}

          {/* TAB CONTENT 3: OPEN DISPUTES CHECKOUT */}
          {activeTab === 'disputes' && (
            <div className="space-y-4">
              {/* REFUNDS REQUIRING RECONCILIATION (A1 unknown-outcome workflow) */}
              <div className="bg-[var(--appearance-surface)] border border-status-warning-border rounded-2xl p-5 shadow-sm">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <h3 className="font-extrabold text-caption text-status-warning uppercase tracking-widest">Refunds Requiring Reconciliation</h3>
                    <p className="text-caption text-[var(--appearance-text-muted)] mt-1">
                      Claims locked in <span className="font-mono">refunding</span> — a real refund was attempted but the provider outcome is UNKNOWN (network/timeout). No automatic retry is ever issued. Verify the outcome with the payment provider (IntaSend) before choosing an action. Neither action sends money.
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    loading={refundReconcileLoading}
                    onClick={fetchRefundReconciliation}
                    className="shrink-0"
                  >
                    Refresh
                  </Button>
                </div>

                {refundReconcileLoading ? (
                  <p className="text-caption text-[var(--appearance-text-muted)] py-3" aria-busy="true">Loading&hellip;</p>
                ) : !refundReconcileItems || refundReconcileItems.length === 0 ? (
                  <p className="text-caption text-[var(--appearance-text-muted)] py-2">No refunds currently require reconciliation.</p>
                ) : (
                  <div className="space-y-2">
                    {refundReconcileItems.map((item: any) => (
                      <div key={item.claimId} className="border border-[var(--appearance-border)] rounded-xl p-3 space-y-2">
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption">
                          <Badge variant="code">Claim: {item.claimId}</Badge>
                          <span className="text-[var(--appearance-text-muted)]">Item: {item.itemId || '\u2014'}</span>
                          <span className="text-[var(--appearance-text-muted)]">Recipient: {item.ownerPhone}</span>
                          <span className="text-[var(--appearance-text-muted)]">Amount: KES {item.refundAmount}</span>
                          <span className="text-[var(--appearance-text-muted)]">Waiting since: {item.waitingSince ? new Date(item.waitingSince).toLocaleString() : '\u2014'}</span>
                          <Badge variant="warning">Outcome UNKNOWN</Badge>
                        </div>
                        <div className="flex flex-wrap gap-2 pt-1">
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={refundReconcileProcessing === item.claimId}
                            onClick={() => handleRefundFinalize(item.claimId)}
                          >
                            Confirm refund EXECUTED
                          </Button>
                          <Button
                            variant="danger"
                            size="sm"
                            disabled={refundReconcileProcessing === item.claimId}
                            onClick={() => handleRefundRevert(item.claimId)}
                          >
                            Confirm refund NOT executed
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {dashboardData.disputes.length === 0 ? (
                <EmptyState
                  icon={AlertTriangle}
                  title={'No disputes to adjudicate'}
                  description={'No ownership disputes have been raised.'}
                />
              ) : (
                <div className="space-y-4">
                  {dashboardData.disputes.map((dispute: any) => {
                    const claimants: any[] = Array.isArray(dispute.claimants) ? dispute.claimants : [];
                    const isResolved = !!dispute.resolved_at || !!dispute.resolved_by;
                    const evidenceState = disputeEvidence[dispute.id];
                    const roleLabel = (role: string) => role === 'original'
                      ? ('Claimant A — original claim')
                      : ('Claimant B — contesting claim');
                    const roleShort = (role: string) => role === 'original'
                      ? ('Claimant A')
                      : ('Claimant B');
                    return (
                    <div key={dispute.id} className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-2xl p-5 shadow-sm space-y-4">
                      <div className="flex flex-wrap justify-between items-center gap-2 pb-3 border-b border-[var(--appearance-border)]">
                        <div>
                          <span className="text-caption font-mono font-bold text-status-danger">DISPUTE: {dispute.id}</span>
                          <p className="text-caption text-[var(--appearance-text-muted)]">
                            {'Raised on'}{' '}
                            {dispute.created_at ? new Date(dispute.created_at).toLocaleString() : '—'}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-caption font-bold text-[var(--appearance-text-muted)]">
                            {'Item'}: {dispute.item_id || '—'}
                          </span>
                          <Badge variant={isResolved ? 'neutral' : 'warning'}>
                            {isResolved ? ('Resolved') : ('Open')}
                          </Badge>
                        </div>
                      </div>

                      {claimants.length === 0 ? (
                        <p className="text-caption text-status-danger">
                          {'No claimant details were returned for this dispute, so it cannot be adjudicated from here.'}
                        </p>
                      ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          {claimants.map((claimant: any) => (
                            <DisputeClaimantPanel
                              key={claimant.role + ':' + claimant.claim_id}
                              claimant={claimant}
                              evidenceState={evidenceState}
                              roleLabel={roleLabel(claimant.role)}
                              isWinner={isResolved && !!claimant.claim_id && dispute.resolved_claim_id === claimant.claim_id}
                              onViewPhoto={setLightboxImage}
                            />
                          ))}
                        </div>
                      )}

                      {/* Evidence is loaded on demand — one request per dispute the
                          administrator actually inspects, never for the whole list. */}
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          loading={!!evidenceState?.loading}
                          onClick={() => fetchDisputeEvidence(dispute.id)}
                        >
                          {'Load evidence'}
                        </Button>
                      </div>

                      {/* Resolution actions. Only offered on an OPEN dispute whose
                          claimant claim IDs actually came back from the API — a
                          resolved dispute is reported as resolved rather than
                          offering buttons that can only fail. */}
                      {isResolved ? (
                        <p className="text-caption text-[var(--appearance-text-muted)] border-t border-[var(--appearance-border)] pt-3">
                          {'Resolved'}
                          {dispute.resolved_at ? ` ${new Date(dispute.resolved_at).toLocaleString()}` : ''}
                          {dispute.resolved_claim_id
                            ? ` — ${'awarded to claim'} ${dispute.resolved_claim_id}`
                            : ''}
                          {dispute.resolved_by ? ` (${dispute.resolved_by})` : ''}
                        </p>
                      ) : claimants.length === 0 ? (
                        <p className="text-caption text-status-danger border-t border-[var(--appearance-border)] pt-3">
                          {'Resolution is unavailable: the two claimant claim IDs were not returned for this dispute.'}
                        </p>
                      ) : (
                        <div className="flex flex-wrap justify-end gap-2 pt-2 border-t border-[var(--appearance-border)]">
                          {claimants.map((claimant: any) => (
                            <Button
                              key={'award:' + claimant.role}
                              variant={claimant.role === 'original' ? 'primary' : 'accent'}
                              size="sm"
                              disabled={adminActionProcessing || !claimant.claim_id}
                              title={!claimant.claim_id
                                ? ('No claim ID is available for this claimant')
                                : undefined}
                              onClick={() => handleResolveDispute(dispute, claimant)}
                            >
                              {`Award ${roleShort(claimant.role)}`}
                            </Button>
                          ))}
                        </div>
                      )}
                    </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* TAB CONTENT 4: FINANCIAL IMMUTABLE LEDGER */}
          {activeTab === 'ledger' && (
            <div className="space-y-4">
              {/* Pending Settlements — claims that have physically handed over
                  the item but whose real M-Pesa payout is still inside the
                  dispute window. Released automatically once settleAt passes,
                  or immediately here via admin override (audit-logged). */}
              <div className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-2xl shadow-sm p-5 space-y-3">
                <div>
                  <h3 className="text-heading font-extrabold text-[var(--appearance-text-primary)]">Pending Settlements</h3>
                  <p className="text-caption text-[var(--appearance-text-muted)]">
                    Handover confirmed, payout booked, dispute window still open. Settles automatically, or release now to override.
                  </p>
                </div>
                {(!dashboardData.pendingSettlements || dashboardData.pendingSettlements.length === 0) ? (
                  <p className="text-center text-[var(--appearance-text-muted)] text-caption py-4">No claims currently in the dispute window.</p>
                ) : (
                  <div className="space-y-2">
                    {dashboardData.pendingSettlements.map((ps: any) => {
                      const settleAtDate = ps.settleAt ? new Date(ps.settleAt) : null;
                      const isDue = settleAtDate ? settleAtDate.getTime() <= Date.now() : false;
                      return (
                        <div key={ps.claimId} className="flex flex-wrap items-center justify-between gap-2 border border-[var(--appearance-border)] rounded-xl p-3 bg-[var(--appearance-surface-muted)]/40">
                          <div className="text-caption">
                            <span className="font-mono font-bold text-[var(--appearance-text-primary)]">{ps.claimId}</span>
                            <span className="text-[var(--appearance-text-muted)]/60 mx-1.5">·</span>
                            <span className="text-[var(--appearance-text-muted)]">Item {ps.itemId}</span>
                            <span className="text-[var(--appearance-text-muted)]/60 mx-1.5">·</span>
                            <span className={`font-bold ${isDue ? 'text-status-success' : 'text-status-warning'}`}>
                              {settleAtDate ? (isDue ? 'Due now' : `Settles ${settleAtDate.toLocaleString()}`) : 'No settle time set'}
                            </span>
                            {ps.lockedTotalFee !== null && (
                              <span className="text-[var(--appearance-text-muted)]"> · KES {ps.lockedTotalFee}</span>
                            )}
                          </div>
                          <Button
                            variant="secondary"
                            size="sm"
                            loading={itemActionProcessing === 'settlement:' + ps.claimId}
                            onClick={() => handleReleaseSettlementNow(ps.claimId)}
                          >
                            Release Now
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-2xl shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-[var(--appearance-surface-muted)] text-caption font-extrabold text-[var(--appearance-text-muted)] uppercase tracking-widest border-b border-[var(--appearance-border)]">
                        <th className="px-5 py-3 font-bold">Transaction Reference</th>
                        <th className="px-5 py-3 font-bold">Type</th>
                        <th className="px-5 py-3 font-bold">Amount</th>
                        <th className="px-5 py-3 font-bold">Claim</th>
                        <th className="px-5 py-3 font-bold">Status</th>
                        <th className="px-5 py-3 font-bold">Date</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--appearance-border)] text-caption text-[var(--appearance-text-muted)] font-mono">
                      {dashboardData.ledger.map((entry: any) => (
                        <tr key={entry.id} className="hover:bg-[var(--appearance-surface-muted)]/50 transition">
                          <td className="px-5 py-3.5 font-bold text-[var(--appearance-text-primary)]">{entry.id}</td>
                          <td className="px-5 py-3.5">
                            {/* Transaction TYPE label — a classification, not a
                                lifecycle status — so each type keeps its own
                                distinct design-system variant instead of raw
                                palette classes. Values are unchanged. */}
                            <Badge
                              variant={
                                entry.type === 'payment_received' ? 'info' :
                                  entry.type === 'finder_payout' ? 'success' :
                                    entry.type === 'agent_payout' ? 'warning' : 'neutral'
                              }
                            >
                              {entry.type.replace('_', ' ')}
                            </Badge>
                          </td>
                          <td className="px-5 py-3.5 font-bold text-[var(--appearance-text-primary)]">KES {entry.amount}</td>
                          <td className="px-5 py-3.5">{entry.claim_id || '—'}</td>
                          <td className="px-5 py-3.5">
                            <Badge
                              variant={
                                entry.status === 'completed' ? 'success'
                                  : entry.status === 'failed' ? 'danger' : 'warning'
                              }
                            >
                              {entry.status.toUpperCase()}
                            </Badge>
                          </td>
                          <td className="px-5 py-3.5 text-[var(--appearance-text-muted)] text-caption whitespace-nowrap">
                            {entry.created_at ? new Date(entry.created_at).toLocaleString() : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* TAB CONTENT 5: MANUAL REVIEW QUEUE */}
          {activeTab === 'review' && (
            <div className="space-y-6">
              {/* Supporting context for the review queue. The page-level h1 and
                  section description come from the console title band
                  (CONSOLE_SECTIONS), so this is deliberately NOT a heading. */}
              <p className="text-caption text-[var(--appearance-text-muted)] max-w-2xl">
                These items have low OCR confidence, missing details, or require administrator correction.
              </p>

              {selectedReviewItem ? (
                <div className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-2xl p-6 md:p-8 shadow-sm space-y-6 max-w-2xl mx-auto">
                  <div className="flex justify-between items-center border-b border-[var(--appearance-border)] pb-3">
                    <h3 className="text-heading font-extrabold text-[var(--appearance-text-primary)]">Reviewing Item: {selectedReviewItem.id}</h3>
                    <Button variant="ghost" size="sm" onClick={() => setSelectedReviewItem(null)}>
                      Back to list
                    </Button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* Left: Finder Photo */}
                    <div className="space-y-2">
                      <span className="text-caption font-extrabold text-[var(--appearance-text-muted)] uppercase tracking-widest block">Uploaded Photo</span>
                      <div className="border border-[var(--appearance-border)] rounded-2xl overflow-hidden bg-[var(--appearance-surface-muted)] aspect-[4/3] flex items-center justify-center">
                        <img
                          src={selectedReviewItem.photo_url}
                          alt="Document to review"
                          className="w-full h-full object-contain fade-in"
                          referrerPolicy="no-referrer"
                        />
                      </div>
                    </div>

                    {/* Right: Correction Form */}
                    <form onSubmit={handleSaveReview} className="space-y-4">
                      <Select
                        label="Item Category"
                        id="review-category"
                        value={reviewCategoryId}
                        onChange={(e) => setReviewCategoryId(e.target.value)}
                        disabled={adminCategoriesLoading}
                      >
                          {adminCategoriesLoading ? (
                            <option value="">Loading categories...</option>
                          ) : (
                            (() => {
                              // CAT-04 / F-5 — this selector must be driven by the ADMIN
                              // category dataset (every category, active or inactive), not
                              // by the public active-only list. The review endpoint
                              // deliberately accepts an inactive category so a legacy item
                              // can be preserved, and the panel must be able to show that
                              // category. Sourcing it from the public list left an inactive
                              // current category with no matching <option>: the browser then
                              // rendered the control blank while the form still submitted
                              // the (correct) state value — a display/state mismatch.
                              const selectable = adminCategories.filter(cat => cat.name_en && cat.name_sw);
                              const invalidCount = adminCategories.length - selectable.length;
                              if (invalidCount > 0) {
                                console.warn(`[AdminView] Filtered out ${invalidCount} incomplete categories from rendering.`);
                              }
                              // Belt and braces: if the item's current category is not in
                              // the fetched list at all, still render it so the control can
                              // never misrepresent what is about to be submitted.
                              const currentMissing = reviewCategoryId
                                && !selectable.some((cat: any) => cat.id === reviewCategoryId);
                              return (
                                <>
                                  {currentMissing && (
                                    <option key={reviewCategoryId} value={reviewCategoryId}>
                                      {`${reviewCategoryId} — not in the category list`}
                                    </option>
                                  )}
                                  {selectable.map(cat => (
                                    <option key={cat.id} value={cat.id}>
                                      {cat.is_active === false ? `${cat.name_en} — Inactive` : cat.name_en}
                                    </option>
                                  ))}
                                </>
                              );
                            })()
                          )}
                      </Select>

                      {/* Reassign Agent Dropdown */}
                      <Select
                        label="Assigned Agent Hub"
                        id="review-assigned-agent"
                        value={reviewAssignedAgentId}
                        onChange={(e) => setReviewAssignedAgentId(e.target.value)}
                      >
                          <option value="">-- Select Agent Hub --</option>
                          {dashboardData.agents && dashboardData.agents
                            .filter((agent: any) => agent.status === 'active')
                            .map((agent: any) => (
                              <option key={agent.id} value={agent.id}>
                                {agent.business_name} ({agent.location_address})
                              </option>
                            ))
                          }
                      </Select>

                      {/* Assignment Metadata Info */}
                      {selectedReviewItem.agent_assignment_method && (
                        <div className="p-2.5 bg-[var(--appearance-surface-muted)] border border-[var(--appearance-border)] rounded-xl text-caption font-mono text-[var(--appearance-text-muted)] space-y-1">
                          <p className="font-sans font-bold text-[var(--appearance-text-primary)]">Assignment Metadata:</p>
                          <p>Method: <span className="font-bold text-[var(--appearance-text-primary)]">{selectedReviewItem.agent_assignment_method}</span></p>
                          {/* GEO-E1 — the routing-evidence confidence tier, DERIVED server-side
                              from the assignment method and exposed only on the admin DTO.
                              "high" = coordinate-based, "medium" = forward-geocoded,
                              "manual" = human review. It never implies verified geography. */}
                          {selectedReviewItem.agent_assignment_confidence && (
                            <p>Evidence Confidence: <span className="font-bold text-[var(--appearance-text-primary)]">{selectedReviewItem.agent_assignment_confidence}</span></p>
                          )}
                          {selectedReviewItem.agent_assignment_distance_km !== null && (
                            <p>Calculated Distance: <span className="font-bold text-[var(--appearance-text-primary)]">{parseFloat(selectedReviewItem.agent_assignment_distance_km).toFixed(2)} km</span></p>
                          )}
                          {selectedReviewItem.needs_manual_agent_reassignment ? (
                            <p className="text-status-danger font-sans font-extrabold uppercase animate-pulse">Reassigned to Default Backup Agent (Needs Manual Correction)</p>
                          ) : (
                            <p className="text-status-success font-sans font-extrabold uppercase">Successfully Auto-Assigned</p>
                          )}
                        </div>
                      )}

                      <div className="flex items-center space-x-2 py-1">
                        <input
                          type="checkbox"
                          id="reviewIsDescriptionOnly"
                          checked={reviewIsDescriptionOnly}
                          onChange={(e) => setReviewIsDescriptionOnly(e.target.checked)}
                          className="rounded text-[var(--appearance-primary)] focus:ring-[var(--appearance-primary)] h-4 w-4"
                        />
                        <label htmlFor="reviewIsDescriptionOnly" className="text-caption font-bold text-[var(--appearance-text-primary)]">
                          Mark as Description-Only Item (e.g. keys, bags)
                        </label>
                      </div>

                      {reviewIsDescriptionOnly ? (
                        <Textarea
                          label="Free-text Description"
                          id="review-description"
                          value={reviewDescription}
                          onChange={(e) => setReviewDescription(e.target.value)}
                          placeholder="Write a clear, searchable description of the item (e.g. 'Key ring with a black fob and 3 keys')"
                          required
                        />
                      ) : (
                        <>
                          <Input
                            label="Document / ID Number"
                            id="review-ocr-number"
                            type="text"
                            value={reviewOcrNumber}
                            onChange={(e) => setReviewOcrNumber(e.target.value)}
                            placeholder="e.g. 3841920"
                            required
                          />
                          <p className="text-caption text-[var(--appearance-text-muted)]">Original OCR: {selectedReviewItem.ocr_extracted_number || 'None'}</p>

                          <Input
                            label="Full Name on Document"
                            id="review-ocr-name"
                            type="text"
                            value={reviewOcrName}
                            onChange={(e) => setReviewOcrName(e.target.value)}
                            placeholder="e.g. JOHN DOE"
                            required
                          />
                          <p className="text-caption text-[var(--appearance-text-muted)]">Original OCR: {selectedReviewItem.ocr_extracted_name || 'None'}</p>
                        </>
                      )}

                      <div className="flex gap-2">
                        <Button type="submit" variant="primary" loading={reviewSaving} className="flex-1">
                          <span>Save Correction</span>
                          <ArrowRight size={ICON_SIZE.ui} aria-hidden="true" />
                        </Button>
                        <Button
                          type="button"
                          variant="danger"
                          disabled={reviewSaving}
                          onClick={() => handleRejectAsSpam(selectedReviewItem.id)}
                        >
                          Reject as Spam
                        </Button>
                      </div>
                    </form>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {dashboardData.items.filter((item: any) => item.flaggedForReview).length === 0 ? (
                    <EmptyState
                      icon={CheckCircle}
                      title="All reported items have been reviewed!"
                      description="Review queue is empty."
                    />
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {dashboardData.items
                        .filter((item: any) => item.flaggedForReview)
                        .sort((a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
                        .map((item: any) => (
                          <div key={item.id} className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-2xl p-5 shadow-sm flex flex-col justify-between gap-4">
                            <div className="flex gap-4">
                              <div className="w-16 h-16 rounded-xl bg-[var(--appearance-surface-muted)] border border-[var(--appearance-border)] overflow-hidden shrink-0 flex items-center justify-center">
                                <img
                                  src={item.photo_url}
                                  alt="Thumbnail"
                                  className="w-full h-full object-contain"
                                  referrerPolicy="no-referrer"
                                />
                              </div>
                              <div className="space-y-1">
                                <Badge variant="danger">Flagged</Badge>
                                <h3 className="text-heading font-extrabold text-[var(--appearance-text-primary)]">Code: {item.id}</h3>
                                <p className="text-[var(--appearance-text-muted)] text-caption leading-snug">{item.location_description}</p>
                                <p className="text-[var(--appearance-text-muted)] text-caption font-mono">Date: {new Date(item.created_at).toLocaleDateString()}</p>
                                {item.agent_assignment_method && (
                                  <div className="mt-1.5 p-1.5 bg-[var(--appearance-surface-muted)] rounded-lg text-caption font-mono text-[var(--appearance-text-muted)]">
                                    <p>Assignment: <span className="font-bold">{item.agent_assignment_method}</span></p>
                                    {item.agent_assignment_distance_km !== null && (
                                      <p>Distance: <span className="font-bold">{parseFloat(item.agent_assignment_distance_km).toFixed(2)} km</span></p>
                                    )}
                                    {item.needs_manual_agent_reassignment && (
                                      <p className="text-status-danger font-bold uppercase animate-pulse">Needs Manual Reassignment</p>
                                    )}
                                  </div>
                                )}
                                {item.reputation && (
                                  <div className="mt-1.5 space-y-1">
                                    <p className="text-caption text-[var(--appearance-text-primary)] font-bold">
                                      Finder: {item.finder_phone}
                                    </p>
                                    <p className="text-caption text-[var(--appearance-text-muted)]">
                                      Reputation: {item.reputation.rejected_reports} rejected / {item.reputation.total_reports} total
                                    </p>
                                    {item.reputation.autoFlag && (
                                      <div className="flex flex-col gap-1 mt-1 items-start">
                                        <Badge variant="danger">Poor Reputation Block</Badge>
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="sm"
                                          disabled={adminActionProcessing}
                                          loading={adminActionProcessing}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleClearReputation(item.finder_phone);
                                          }}
                                        >
                                          <span>Clear Reputation Block</span>
                                        </Button>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                            <Button variant="outline" onClick={() => startReview(item)} className="w-full">
                              Review Item details
                            </Button>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* TAB CONTENT 6: CATEGORIES & PRICING MANAGEMENT */}
          {activeTab === 'categories' && (
            <div className="space-y-6">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-[var(--appearance-border)] pb-4">
                <p className="text-caption text-[var(--appearance-text-muted)] max-w-2xl">
                  Dhibiti kategoria za bidhaa, bei, na migao ya malipo. / Manage document categories, fees, and disbursement splits.
                </p>
                {!showCategoryForm && (
                  <Button variant="primary" size="sm" onClick={() => resetCategoryForm('create')} className="shrink-0">
                    Add new category / Ongeza kategoria
                  </Button>
                )}
              </div>

              {showCategoryForm ? (
                <div className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-2xl p-5 sm:p-6 md:p-8 shadow-sm space-y-6 max-w-3xl mx-auto">
                  <div className="flex justify-between items-center gap-3 border-b border-[var(--appearance-border)] pb-3">
                    <h3 className="text-heading font-extrabold text-[var(--appearance-text-primary)]">
                      {showCategoryForm === 'create' ? 'Create New Category' : `Editing Category: ${catFormId}`}
                    </h3>
                    <Button variant="ghost" size="sm" onClick={() => setShowCategoryForm(null)}>
                      Cancel / Ghairi
                    </Button>
                  </div>

                  {/* ============================================================
                      PHASE 16 — THE CATEGORY EDITOR IS NOW SECTIONS.
                      It previously presented every field as one undifferentiated
                      2-column grid: identity, both names, privacy, moderation and
                      six fee inputs all at the same visual weight, with the
                      save/cancel pair sitting immediately after the fee preview.
                      An admin could not see where "basic information" ended and
                      the pricing model began.

                      Only PRESENTATION changed. Every control keeps its id, its
                      binding, its validation and its submit handler; no payload
                      key moved; no category or fee calculation was touched. The
                      five sections are exactly the model this form already had.
                      ============================================================ */}
                  <form onSubmit={handleSaveCategory} className="space-y-8">
                    {/* SECTION 1 — BASIC CATEGORY INFORMATION */}
                    <section className="space-y-4" aria-labelledby="cat-section-basic">
                      <div className="border-b border-[var(--appearance-border)] pb-2">
                        <h4 id="cat-section-basic" className="text-heading font-extrabold text-[var(--appearance-text-primary)]">
                          Basic category information / Taarifa za msingi
                        </h4>
                        <p className="mt-1 text-caption text-[var(--appearance-text-muted)]">
                          How this category is identified internally and shown to customers in both languages.
                        </p>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {/* ID (only editable in create mode) */}
                      <Input
                        label="ID / Msimbo (lowercase-kebab-case)"
                        id="cat-form-id"
                        type="text"
                        value={catFormId}
                        onChange={(e) => setCatFormId(e.target.value)}
                        placeholder="e.g. driving-license"
                        className="font-mono"
                        disabled={showCategoryForm === 'edit'}
                        hint={showCategoryForm === 'create' ? 'Must be unique, letters, numbers and hyphens only.' : undefined}
                        required
                      />

                      {/* Name EN */}
                      <Input
                        label="Name (English) / Jina la Kiingereza"
                        id="cat-form-name-en"
                        type="text"
                        value={catFormNameEn}
                        onChange={(e) => setCatFormNameEn(e.target.value)}
                        placeholder="e.g. Driving License"
                        required
                      />

                      {/* Name SW */}
                      <Input
                        label="Name (Swahili) / Jina la Kiswahili"
                        id="cat-form-name-sw"
                        type="text"
                        value={catFormNameSw}
                        onChange={(e) => setCatFormNameSw(e.target.value)}
                        placeholder="e.g. Leseni ya Udereva"
                        required
                      />
                      </div>
                    </section>

                    {/* SECTION 2 — RECOGNITION & PRIVACY.
                        The two settings that decide what the PUBLIC may be told
                        about this category: how a document-number clue is masked
                        in public/social recognition posts, and whether the owner's
                        identity document is required before release. */}
                    <section className="space-y-4" aria-labelledby="cat-section-privacy">
                      <div className="border-b border-[var(--appearance-border)] pb-2">
                        <h4 id="cat-section-privacy" className="text-heading font-extrabold text-[var(--appearance-text-primary)]">
                          Recognition &amp; privacy / Utambuzi na faragha
                        </h4>
                        <p className="mt-1 text-caption text-[var(--appearance-text-muted)]">
                          What a public post may reveal about items in this category.
                        </p>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* P14A (P14-05) — public-recognition masking style. Drives how this
                            category's document-number clue is masked in public posts (see
                            services/publicRecognition.ts). The option VALUES are the canonical
                            enum values the server validates against; only the labels differ. */}
                        <Select
                          className="md:col-span-2"
                          label="Public recognition — document-number clue style"
                          id="catFormPublicClueStyle"
                          value={catFormPublicClueStyle}
                          onChange={(e) => setCatFormPublicClueStyle(e.target.value)}
                          hint={'Applies to public/social recognition posts only. "None" never publishes a document-number clue for this category.'}
                        >
                          {PUBLIC_CLUE_STYLES.map((style) => (
                            <option key={style} value={style}>
                              {PUBLIC_CLUE_STYLE_LABELS[style] ?? style}
                            </option>
                          ))}
                        </Select>

                        {/* Sensitive document — a labelled card, not a bare 16px
                            checkbox, so the whole row is the target (≥44px) and the
                            consequence is stated in words rather than implied. */}
                        <label
                          htmlFor="catFormIsSensitive"
                          className="flex items-start gap-3 min-h-11 rounded-xl border border-[var(--appearance-border)] bg-[var(--appearance-surface)] px-3 py-2.5 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            id="catFormIsSensitive"
                            checked={catFormIsSensitive}
                            onChange={(e) => setCatFormIsSensitive(e.target.checked)}
                            className="mt-0.5 h-5 w-5 shrink-0 rounded border-[var(--appearance-border)] text-[var(--appearance-primary)] focus:ring-2 focus:ring-accent-orange/30 cursor-pointer"
                          />
                          <span className="text-body text-[var(--appearance-text-primary)]">
                            <span className="font-bold">Sensitive document / Hati nyeti</span>
                            <span className="mt-0.5 block text-caption text-[var(--appearance-text-muted)]">
                              Requires the owner's identity proof (OCR / ID) before release.
                            </span>
                          </span>
                        </label>
                      </div>
                    </section>

                    {/* SECTION 3 — REVIEW CONTROLS.
                        Categories that must never go public without an
                        administrator looking at the item first. */}
                    <section className="space-y-4" aria-labelledby="cat-section-review">
                      <div className="border-b border-[var(--appearance-border)] pb-2">
                        <h4 id="cat-section-review" className="text-heading font-extrabold text-[var(--appearance-text-primary)]">
                          Review controls / Udhibiti wa ukaguzi
                        </h4>
                        <p className="mt-1 text-caption text-[var(--appearance-text-muted)]">
                          Whether items in this category need an administrator's approval before they go public.
                        </p>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* Elevated Review (cash, children's-property style categories) */}
                        <label
                          htmlFor="catFormElevatedReview"
                          className="flex items-start gap-3 min-h-11 rounded-xl border border-status-danger-border bg-status-danger-surface/50 px-3 py-2.5 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            id="catFormElevatedReview"
                            checked={catFormElevatedReview}
                            onChange={(e) => setCatFormElevatedReview(e.target.checked)}
                            className="mt-0.5 h-5 w-5 shrink-0 rounded border-[var(--appearance-border)] text-status-danger focus:ring-2 focus:ring-status-danger/30 cursor-pointer"
                          />
                          <span className="text-body text-[var(--appearance-text-primary)]">
                            <span className="font-bold">Elevated review / Ukaguzi wa hali ya juu</span>
                            <span className="mt-0.5 block text-caption text-[var(--appearance-text-muted)]">
                              Forces admin approval before this category's items go public.
                            </span>
                          </span>
                        </label>
                      </div>
                    </section>

                    {/* SECTION 4 — FEE CONFIGURATION.
                        Two mutually exclusive pricing models, exactly as before: a
                        flat admin-set override, or the Recovery Fee Engine. Nothing
                        about either calculation changed in this phase. */}
                    <section className="space-y-4" aria-labelledby="cat-section-fee">
                      <div className="border-b border-[var(--appearance-border)] pb-2">
                        <h4 id="cat-section-fee" className="text-heading font-extrabold text-[var(--appearance-text-primary)]">
                          Fee configuration / Mipangilio ya ada
                        </h4>
                        <p className="mt-1 text-caption text-[var(--appearance-text-muted)]">
                          Choose one model: a flat override, or the Recovery Fee Engine that prices every item at report time.
                        </p>
                      </div>
                      {/* ------------------------------------------------------------------
                          PRICING AUTHORITY (Issue A) — WHICH MODEL IS ACTUALLY IN CHARGE.

                          An administrator could previously edit the visible flat Total
                          Fee (e.g. KES 200 -> KES 100) while this category was in
                          RECOVERY FEE ENGINE mode. The save succeeded, the live admin
                          list showed the new price, and the next reported item still
                          locked KES 200 — because in engine mode the flat Total Fee is
                          not what prices anything. This block states the active mode in
                          words, and states what a NEW item will lock as a result, so a
                          flat price can never again be mistaken for the authoritative one.

                          These are the SAME two modes the server implements
                          (src/services/feeEngine.ts, resolveItemLockedPricing):
                            MODE 1 FLAT   -> a new item locks the flat fields verbatim
                            MODE 2 ENGINE -> a new item is priced at Base + Complexity + Delay
                          No second pricing model is introduced: the preview below is still
                          the ONE computeRecoveryFee() the server itself prices with.
                          ------------------------------------------------------------------ */}
                      <div
                        id="cat-pricing-mode-banner"
                        data-pricing-mode={catFormIsAdminModified ? 'flat_admin_override' : 'recovery_fee_engine'}
                        className="rounded-xl border border-[var(--appearance-border)] bg-[var(--appearance-surface-muted)] p-4 space-y-2"
                      >
                        <p className="text-caption font-extrabold uppercase tracking-wider text-[var(--appearance-text-muted)]">
                          {'Pricing model in force for NEW items'}
                        </p>
                        <p className="text-body font-extrabold text-[var(--appearance-text-primary)]">
                          {catFormIsAdminModified
                            ? 'MODE 1 — FLAT / ADMIN OVERRIDE is in force'
                            : 'MODE 2 — RECOVERY FEE ENGINE is in force'}
                        </p>
                        <p className="text-caption text-[var(--appearance-text-muted)] leading-tight">
                          {catFormIsAdminModified
                            ? 'Every new item locks the flat Total / Finder / Agent / Platform amounts exactly as entered below. The Recovery Fee Engine configuration is ignored entirely.'
                            : 'Every new item is priced by the Recovery Fee Engine from Base + Complexity + Delay (capped only by the Ceiling % and the finder cap). The flat Total / Finder / Agent / Platform fields below are stored but are NOT used to price anything, so editing them will not change what a new item is charged.'}
                        </p>
                        <p className="text-caption font-bold text-[var(--appearance-text-primary)]">
                          <span id="cat-pricing-mode-authoritative-price">
                            {catFormIsAdminModified
                              ? `A new item would lock: KES ${Number(catFormTotalFee) || 0} total — Finder KES ${Number(catFormFinderShare) || 0}, Agent KES ${Number(catFormAgentShare) || 0}, Platform KES ${Number(catFormPlatformShare) || 0}.`
                              : `A new item would be priced at Base + Complexity + Delay = KES ${enginePreview.totalFee} (before any declared-value ceiling), split Finder KES ${enginePreview.finderAmount} / Agent KES ${enginePreview.agentAmount} / Platform KES ${enginePreview.platformAmount}.`}
                          </span>
                        </p>
                        {!catFormIsAdminModified && (
                          <button
                            type="button"
                            id="cat-pricing-mode-switch-to-flat"
                            onClick={() => setCatFormIsAdminModified(true)}
                            className="rounded-standard border border-[var(--appearance-border)] bg-[var(--appearance-surface)] px-3 py-2 text-caption font-extrabold text-[var(--appearance-text-primary)] hover:border-[var(--appearance-primary)]"
                          >
                            {'Make the flat prices authoritative (switch to MODE 1)'}
                          </button>
                        )}
                      </div>



                      {/* Flat fee override toggle — decides whether total_fee/finder_share/
                          agent_share/platform_share below win outright (ignoring the Recovery
                          Fee Engine section further down), or whether the engine computes the
                          fee fresh from base/complexity/delay/ceiling every time. Previously
                          this was silently forced on by every save from this form, which meant
                          editing the engine fields below had no effect the moment you saved —
                          it's now an explicit choice. */}
                      <label
                        htmlFor="catFormIsAdminModified"
                        className="flex items-start gap-3 min-h-11 rounded-xl border border-status-warning-border bg-status-warning-surface/60 px-3 py-2.5 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          id="catFormIsAdminModified"
                          checked={catFormIsAdminModified}
                          onChange={(e) => setCatFormIsAdminModified(e.target.checked)}
                          className="mt-0.5 h-5 w-5 shrink-0 rounded border-[var(--appearance-border)] text-status-warning focus:ring-2 focus:ring-status-warning/30 cursor-pointer"
                        />
                        <span className="text-body text-[var(--appearance-text-primary)]">
                          <span className="font-bold">Use flat fee override / Tumia ada isiyobadilika</span>
                          <span className="mt-0.5 block text-caption text-[var(--appearance-text-muted)]">
                            When ticked (MODE 1): Total / Finder / Agent / Platform below are authoritative — every new item locks them exactly — and the Recovery Fee Engine config is ignored entirely.
                            When unticked (MODE 2): the Recovery Fee Engine prices every new item, and these four flat values are NOT used for pricing, so changing them here has no effect on what a new item is charged.
                          </span>
                        </span>
                      </label>

                      {/* Is the flat price below actually the price a new item pays?
                          Stated on the block itself, so the answer travels with the
                          fields rather than depending on the admin remembering which
                          toggle is set. MODE 1 = authoritative, MODE 2 = stored preview
                          only (the engine prices new items). */}
                      <p
                        id="cat-flat-price-authority"
                        className={`text-caption font-extrabold uppercase tracking-wider ${catFormIsAdminModified ? 'text-status-success' : 'text-status-warning'}`}
                      >
                        {catFormIsAdminModified
                          ? 'These flat prices ARE authoritative (MODE 1) — new items lock them.'
                          : 'These flat prices are NOT authoritative (MODE 2) — the engine prices new items; these values are stored but ignored.'}
                      </p>


                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {/* Total Fee */}
                      <Input
                        label="Total Fee (KES) / Ada ya Jumla"
                        id="cat-form-total-fee"
                        type="number"
                        step="0.01"
                        min="0"
                        value={catFormTotalFee}
                        onChange={(e) => setCatFormTotalFee(parseFloat(e.target.value) || 0)}
                        required
                      />

                      {/* Finder Share */}
                      <Input
                        label="Finder Reward (KES) / Mgao wa Aliyepata"
                        id="cat-form-finder-share"
                        type="number"
                        step="0.01"
                        min="0"
                        value={catFormFinderShare}
                        onChange={(e) => setCatFormFinderShare(parseFloat(e.target.value) || 0)}
                        required
                      />

                      {/* Agent Share */}
                      <Input
                        label="Agent Commission (KES) / Mgao wa Wakala"
                        id="cat-form-agent-share"
                        type="number"
                        step="0.01"
                        min="0"
                        value={catFormAgentShare}
                        onChange={(e) => setCatFormAgentShare(parseFloat(e.target.value) || 0)}
                        required
                      />

                      {/* Platform Share */}
                      <Input
                        label="Platform Fee (KES) / Mgao wa Return4me"
                        id="cat-form-platform-share"
                        type="number"
                        step="0.01"
                        min="0"
                        value={catFormPlatformShare}
                        onChange={(e) => setCatFormPlatformShare(parseFloat(e.target.value) || 0)}
                        required
                      />
                    </div>

                    {/* Math verification helper */}
                    {(() => {
                      const totalSum = parseFloat((Number(catFormFinderShare) + Number(catFormAgentShare) + Number(catFormPlatformShare)).toFixed(2));
                      const difference = parseFloat((catFormTotalFee - totalSum).toFixed(2));
                      const isMatch = totalSum === parseFloat(Number(catFormTotalFee).toFixed(2));
                      return (
                        <Banner kind={isMatch ? 'success' : 'error'} className="font-bold">
                          <div className="flex justify-between items-center gap-3 flex-wrap">
                            <span>Splits Sum / Jumla ya Mgao: KES {totalSum}</span>
                            <span>Target / Lengo: KES {catFormTotalFee}</span>
                          </div>
                          <div className="text-caption mt-1 font-semibold">
                            {isMatch ? (
                              <span className="flex items-center space-x-1">
                                <span>Perfect match! Payout split equations balance successfully.</span>
                              </span>
                            ) : (
                              <span>
                                Discrepancy: Difference of KES {difference}. Split sum (Finder + Agent + Platform) must sum to the Total Fee exactly.
                              </span>
                            )}
                          </div>
                        </Banner>
                      );
                    })()}

                    {/* Recovery Fee Engine config — see src/services/feeEngine.ts.
                        Ignored by the engine whenever this category has a flat
                        admin-set total_fee/finder_share/etc. above (is_admin_modified);
                        that flat override always wins. Otherwise the finder/agent/
                        platform shares above are just a preview of what the engine
                        would compute with no declared value — the real fee for an
                        item is computed fresh at report time from these inputs. */}
                    <div className={`border rounded-xl p-4 space-y-3 ${catFormIsAdminModified ? 'border-[var(--appearance-border)] bg-[var(--appearance-surface-muted)] opacity-60' : 'border-[var(--appearance-border)] bg-[var(--appearance-surface-muted)]'}`}>
                      <p className="text-caption font-extrabold text-[var(--appearance-text-muted)] uppercase tracking-wider">
                        Recovery Fee Engine Config
                      </p>
                      {catFormIsAdminModified && (
                        <Banner kind="warning">
                          Inactive — "Use flat fee override" is checked above, so this category ignores everything below and uses the flat Total/Finder/Agent/Platform fee instead.
                        </Banner>
                      )}
                      <p className="text-caption text-[var(--appearance-text-muted)] leading-tight">
                        rawFee = Base + Complexity + Delay. If a finder gives a declared value, the fee is capped at Ceiling % of that value (never raised above rawFee). Split % applies to the resulting fee, not the item's value.
                      </p>
                      <div className="grid grid-cols-3 gap-3">
                        <Input
                          label="Base Fee (KES)"
                          id="cat-form-base-fee"
                          type="number" step="0.01" min="0"
                          value={catFormBaseFee}
                          onChange={(e) => setCatFormBaseFee(parseFloat(e.target.value) || 0)}
                        />
                        <Input
                          label="Complexity Fee (KES)"
                          id="cat-form-complexity-fee"
                          type="number" step="0.01" min="0"
                          value={catFormComplexityFee}
                          onChange={(e) => setCatFormComplexityFee(parseFloat(e.target.value) || 0)}
                        />
                        <Input
                          label="Delay Fee (KES)"
                          id="cat-form-delay-fee"
                          type="number" step="0.01" min="0"
                          value={catFormDelayFee}
                          onChange={(e) => setCatFormDelayFee(parseFloat(e.target.value) || 0)}
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <Input
                          label="Ceiling % of Declared Value"
                          id="cat-form-ceiling-pct"
                          type="number" step="0.5" min="0" max="100"
                          value={catFormCeilingPercent}
                          onChange={(e) => setCatFormCeilingPercent(parseFloat(e.target.value) || 0)}
                        />
                        <Input
                          label="Finder Reward Cap (KES, optional)"
                          id="cat-form-finder-cap"
                          type="number" step="0.01" min="0"
                          value={catFormFinderRewardCap}
                          onChange={(e) => setCatFormFinderRewardCap(e.target.value)}
                          placeholder="No cap"
                        />
                      </div>
                      <div className="grid grid-cols-3 gap-3">
                        <Input
                          label="Finder %"
                          id="cat-form-finder-pct"
                          type="number" step="0.5" min="0" max="100"
                          value={catFormFinderPct}
                          onChange={(e) => setCatFormFinderPct(parseFloat(e.target.value) || 0)}
                        />
                        <Input
                          label="Agent %"
                          id="cat-form-agent-pct"
                          type="number" step="0.5" min="0" max="100"
                          value={catFormAgentPct}
                          onChange={(e) => setCatFormAgentPct(parseFloat(e.target.value) || 0)}
                        />
                        <Input
                          label="Platform %"
                          id="cat-form-platform-pct"
                          type="number" step="0.5" min="0" max="100"
                          value={catFormPlatformPct}
                          onChange={(e) => setCatFormPlatformPct(parseFloat(e.target.value) || 0)}
                        />
                      </div>
                      {parseFloat((Number(catFormFinderPct) + Number(catFormAgentPct) + Number(catFormPlatformPct)).toFixed(2)) !== 100 && (
                        <p className="text-caption font-bold text-status-danger">
                          Finder % + Agent % + Platform % = {(Number(catFormFinderPct) + Number(catFormAgentPct) + Number(catFormPlatformPct)).toFixed(2)}%, not 100%. The platform share absorbs the difference at settlement time, but percentages should sum to 100 for clarity.
                        </p>
                      )}

                      {/* PART C — THE CALCULATED SPLIT.
                          The admin enters the amount and the percentages; this
                          shows what those percentages actually pay out. Computed
                          by the SAME `computeRecoveryFee()` the server prices a
                          real claim with, so the preview cannot drift from the
                          authoritative calculation. The platform share is the
                          engine's RESIDUAL, so the three rows always reconcile
                          to the claim fee. */}
                      <div className="rounded-xl border border-[var(--appearance-border)] bg-[var(--appearance-surface)] p-3 space-y-2">
                        {catFormAmountEntered ? (
                        <>
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <span className="text-caption font-extrabold text-[var(--appearance-text-muted)] uppercase tracking-wider">
                            Calculated split
                          </span>
                          <span className="text-caption text-[var(--appearance-text-muted)]">
                            Claim fee{' '}
                            <span className="font-extrabold text-[var(--appearance-text-primary)]">{kes(enginePreview.totalFee)}</span>
                          </span>
                        </div>

                        <table className="w-full text-caption">
                          <thead>
                            <tr className="text-[var(--appearance-text-muted)] uppercase tracking-wider">
                              <th scope="col" className="text-left font-extrabold py-1">Share</th>
                              <th scope="col" className="text-right font-extrabold py-1">Rate</th>
                              <th scope="col" className="text-right font-extrabold py-1">Amount</th>
                            </tr>
                          </thead>
                          <tbody className="text-[var(--appearance-text-primary)]">
                            <tr className="border-t border-[var(--appearance-border)]">
                              <th scope="row" className="text-left font-semibold py-1">Finder</th>
                              <td className="text-right py-1">{Number(catFormFinderPct) || 0}%</td>
                              <td className="text-right py-1 font-bold">{kes(enginePreview.finderAmount)}</td>
                            </tr>
                            <tr className="border-t border-[var(--appearance-border)]">
                              <th scope="row" className="text-left font-semibold py-1">Agent</th>
                              <td className="text-right py-1">{Number(catFormAgentPct) || 0}%</td>
                              <td className="text-right py-1 font-bold">{kes(enginePreview.agentAmount)}</td>
                            </tr>
                            <tr className="border-t border-[var(--appearance-border)]">
                              <th scope="row" className="text-left font-semibold py-1">Platform</th>
                              <td className="text-right py-1">{Number(catFormPlatformPct) || 0}%</td>
                              <td className="text-right py-1 font-bold">{kes(enginePreview.platformAmount)}</td>
                            </tr>
                          </tbody>
                          <tfoot>
                            <tr className="border-t border-[var(--appearance-border)] text-[var(--appearance-text-primary)]">
                              <th scope="row" className="text-left font-extrabold py-1">Total</th>
                              <td />
                              <td className="text-right py-1 font-extrabold">{kes(enginePreviewSplitTotal)}</td>
                            </tr>
                          </tfoot>
                        </table>

                        {enginePreview.finderCapApplied && (
                          <p className="text-caption font-bold text-status-warning bg-status-warning-surface border border-status-warning-border rounded-lg px-2 py-1">
                            Finder reward cap applied — the finder share was trimmed to the cap and the platform share absorbed the difference.
                          </p>
                        )}
                        {enginePreviewSplitTotal !== enginePreview.totalFee && (
                          <p className="text-caption font-bold text-status-danger">
                            The three shares do not reconcile to the claim fee — check the configured percentages before saving.
                          </p>
                        )}
                        {catFormIsAdminModified && (
                          <p className="text-caption font-bold text-status-warning bg-status-warning-surface border border-status-warning-border rounded-lg px-2 py-1 leading-tight">
                            Informational only — the "Use flat fee override" option is checked above, so these engine values are NOT what will be saved. Saving this category persists the flat Total/Finder/Agent/Platform fee instead.
                          </p>
                        )}
                        <p className="text-caption text-[var(--appearance-text-muted)] leading-tight">
                          Preview only, with no declared value — so it prices at Base + Complexity + Delay. A finder's declared replacement value can only pull the fee DOWN at the Ceiling % above, never up. The server recomputes this for every real claim; the browser is never the financial authority.
                        </p>
                        </>
                        ) : (
                          <p className="text-caption text-[var(--appearance-text-muted)] leading-tight">
                            Enter an amount (Base, Complexity or Delay fee) to see the calculated split — not yet calculable at KES 0.
                          </p>
                        )}
                      </div>
                    </div>

                    </section>

                    {/* SECTION 5 — ACTIONS.
                        Save is the ONLY submit control in this form (see
                        adminConsoleSectionChrome.test.ts) and Cancel is a real
                        button rather than a link — nothing about the handler,
                        the payload or the disabled rule (`splitsMatch`) moved. */}
                    <section className="space-y-3 border-t border-[var(--appearance-border)] pt-4" aria-labelledby="cat-section-actions">
                      <div>
                        <h4 id="cat-section-actions" className="text-heading font-extrabold text-[var(--appearance-text-primary)]">
                          Actions / Vitendo
                        </h4>
                        <p className="mt-1 text-caption text-[var(--appearance-text-muted)]">
                          Saving writes this category immediately and is recorded against your admin session.
                        </p>
                      </div>
                      <div className="flex flex-col sm:flex-row gap-2">
                      <Button
                        type="submit"
                        variant="primary"
                        disabled={!splitsMatch}
                        loading={catSaving}
                        className="sm:flex-1"
                      >
                        <span>Save Category / Hifadhi</span>
                        <ArrowRight size={ICON_SIZE.ui} aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => setShowCategoryForm(null)}
                      >
                        Cancel / Ghairi
                      </Button>
                      </div>
                    </section>
                  </form>
                </div>
              ) : (
                <div className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-2xl overflow-hidden shadow-sm">
                  {adminCategoriesLoading ? (
                    <div className="flex flex-col items-center justify-center py-12 space-y-2">
                      <Loader2
                        className="animate-spin text-[var(--appearance-primary)]"
                        size={ICON_SIZE.feature}
                        aria-hidden="true"
                      />
                      <p className="text-[var(--appearance-text-muted)] text-caption font-bold uppercase tracking-wider">Loading categories...</p>
                    </div>
                  ) : adminCategories.length === 0 ? (
                    <div className="p-4">
                      <EmptyState icon={Package} title="No categories found on the server." />
                    </div>
                  ) : (
                    <div className="overflow-x-auto font-sans">
                      <table className="w-full text-left border-collapse text-caption">
                        <thead>
                          <tr className="bg-[var(--appearance-surface-muted)] border-b border-[var(--appearance-border)] text-[var(--appearance-text-muted)] uppercase tracking-wider font-extrabold text-caption">
                            <th className="py-3.5 px-4 font-bold">ID</th>
                            <th className="py-3.5 px-4 font-bold">Name (English / Kiswahili)</th>
                            <th className="py-3.5 px-4 text-right font-bold">Total Fee</th>
                            <th className="py-3.5 px-4 text-right font-bold">Finder Share</th>
                            <th className="py-3.5 px-4 text-right font-bold">Agent Share</th>
                            <th className="py-3.5 px-4 text-right font-bold">Platform Share</th>
                            <th className="py-3.5 px-4 text-center font-bold">Sensitive</th>
                            <th className="py-3.5 px-4 text-center font-bold">Items Count</th>
                            <th className="py-3.5 px-4 text-center font-bold">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--appearance-border)] font-sans">
                          {adminCategories.map((cat) => (
                            <tr key={cat.id} className="hover:bg-[var(--appearance-surface-muted)]/50 transition">
                              <td className="py-3 px-4 font-mono font-bold text-[var(--appearance-text-primary)]">{cat.id}</td>
                              <td className="py-3 px-4">
                                <div className="flex items-center flex-wrap gap-1.5">
                                  <p className="font-extrabold text-[var(--appearance-text-primary)]">{cat.name_en}</p>
                                  {cat.is_admin_modified && (
                                    <Badge variant="warning">Customized</Badge>
                                  )}
                                  {/* CAT-04 — an administrator must be able to IDENTIFY a
                                      deactivated category at a glance. */}
                                  {!cat.is_active && (
                                    <Badge variant="neutral">{'Inactive'}</Badge>
                                  )}
                                </div>
                                <p className="text-[var(--appearance-text-muted)] text-caption">{cat.name_sw}</p>
                              </td>
                              <td className="py-3 px-4 text-right font-bold text-[var(--appearance-text-primary)]">KES {cat.total_fee}</td>
                              <td className="py-3 px-4 text-right text-[var(--appearance-text-muted)]">KES {cat.finder_share}</td>
                              <td className="py-3 px-4 text-right text-[var(--appearance-text-muted)]">KES {cat.agent_share}</td>
                              <td className="py-3 px-4 text-right text-[var(--appearance-text-muted)]">KES {cat.platform_share}</td>
                              <td className="py-3 px-4 text-center">
                                <Badge variant={cat.is_sensitive_document ? 'danger' : 'neutral'}>
                                  {cat.is_sensitive_document ? 'Yes' : 'No'}
                                </Badge>
                              </td>
                              <td className="py-3 px-4 text-center">
                                <Badge variant={cat.item_count > 0 ? 'success' : 'neutral'}>
                                  {cat.item_count} items
                                </Badge>
                              </td>
                              <td className="py-3 px-4 whitespace-nowrap">
                                <div className="flex items-center justify-center gap-1.5">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => resetCategoryForm('edit', cat)}
                                  >
                                    Edit / Hariri
                                  </Button>
                                  {/* CAT-06 — the lifecycle action depends on the kind of
                                      category. A canonical seeded category can never be
                                      physically deleted (the server refuses it with a 409),
                                      so the console offers the action that is actually
                                      legal for it: deactivate/reactivate. A custom
                                      category keeps the existing delete, still guarded by
                                      the server's reference check. */}
                                  {cat.is_canonical ? (
                                    <Button
                                      variant={cat.is_active ? 'outline' : 'primary'}
                                      size="sm"
                                      disabled={catSaving}
                                      onClick={() => handleToggleCategoryActive(cat.id, cat.name_en, !cat.is_active)}
                                      title={cat.is_active
                                        ? 'Canonical category — it can be deactivated but never deleted. Deactivating keeps every existing record valid while removing it from all new-report selectors.'
                                        : 'Reactivate this canonical category so it can be chosen for new reports again.'}
                                    >
                                      {cat.is_active ? 'Deactivate / Zima' : 'Reactivate / Washa'}
                                    </Button>
                                  ) : (
                                    <Button
                                      variant="danger"
                                      size="sm"
                                      disabled={cat.item_count > 0}
                                      onClick={() => handleDeleteCategory(cat.id, cat.name_en)}
                                      title={cat.item_count > 0 ? `Cannot delete category because ${cat.item_count} item(s) are currently categorized under it.` : 'Delete Category'}
                                    >
                                      Delete / Futa
                                    </Button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {activeTab === 'strikes' && (
            <div className="space-y-6">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <p className="text-caption text-[var(--appearance-text-muted)] max-w-2xl">
                  Manage users who failed to pay within the 15-minute viewing verification window.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  loading={paymentStrikesLoading}
                  onClick={fetchPaymentStrikes}
                  className="shrink-0"
                >
                  {!paymentStrikesLoading && <RefreshCw size={ICON_SIZE.metadata} aria-hidden="true" />}
                  <span>Reload list</span>
                </Button>
              </div>

              <div className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-2xl overflow-hidden shadow-sm">
                {paymentStrikesLoading ? (
                  <div className="flex flex-col items-center justify-center py-12 space-y-2">
                    <Loader2
                      className="animate-spin text-[var(--appearance-primary)]"
                      size={ICON_SIZE.feature}
                      aria-hidden="true"
                    />
                    <p className="text-[var(--appearance-text-muted)] text-caption font-bold uppercase tracking-wider">Loading strikes...</p>
                  </div>
                ) : paymentStrikes.length === 0 ? (
                  <div className="p-4">
                    <EmptyState icon={ShieldCheck} title="No active payment strikes recorded on the platform." />
                  </div>
                ) : (
                  <div className="overflow-x-auto font-sans">
                    <table className="w-full text-left border-collapse text-caption">
                      <thead>
                        <tr className="bg-[var(--appearance-surface-muted)] border-b border-[var(--appearance-border)] text-[var(--appearance-text-muted)] uppercase tracking-wider font-extrabold text-caption">
                          <th className="py-3.5 px-4 font-bold">User Phone Number</th>
                          <th className="py-3.5 px-4 text-center font-bold">Active Strikes Count</th>
                          <th className="py-3.5 px-4 text-center font-bold">Status Limit</th>
                          <th className="py-3.5 px-4 text-center font-bold">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--appearance-border)] font-sans">
                        {paymentStrikes.map((strike) => (
                          <tr key={strike.phone} className="hover:bg-[var(--appearance-surface-muted)]/50 transition">
                            <td className="py-3.5 px-4 font-mono font-bold text-[var(--appearance-text-primary)]">{strike.phone}</td>
                            <td className="py-3.5 px-4 text-center">
                              {/* The 3-strike escalation thresholds are unchanged
                                  (>=3 blocked, >=2 escalated); only the palette
                                  moved to the shared semantic status variants. */}
                              <Badge
                                variant={
                                  strike.count >= 3 ? 'danger' :
                                    strike.count >= 2 ? 'warning' : 'neutral'
                                }
                              >
                                {strike.count} Strike(s)
                              </Badge>
                            </td>
                            <td className="py-3.5 px-4 text-center">
                              {strike.count >= 3 ? (
                                <Badge variant="danger">Blocked from claims</Badge>
                              ) : strike.count > 0 ? (
                                <Badge variant="warning">Warning active</Badge>
                              ) : (
                                <Badge variant="neutral">Clear</Badge>
                              )}
                            </td>
                            <td className="py-3.5 px-4 text-center whitespace-nowrap">
                              <Button
                                variant="secondary"
                                size="sm"
                                loading={adminActionProcessing}
                                onClick={() => handleClearStrikes(strike.phone)}
                              >
                                <span>Clear Strikes</span>
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          </div>
          </div>
        </div>
      )}

      {/* P1-01 — refund reconciliation confirmation (shared ui/Modal).
          Replaces the two browser-native window.confirm() calls. Focus is
          trapped, Escape cancels, and the confirm button is disabled while the
          request is in flight so the financial action cannot be double-fired. */}
      <Modal
        open={refundConfirm !== null}
        onClose={() => {
          if (!refundConfirmBusy) setRefundConfirm(null);
        }}
        title={
          refundConfirm?.kind === 'revert'
            ? 'Confirm refund NOT executed'
            : 'Confirm refund executed'
        }
        closeLabel={'Close'}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setRefundConfirm(null)} disabled={refundConfirmBusy}>
              {'Cancel'}
            </Button>
            <Button
              variant={refundConfirm?.kind === 'revert' ? 'danger' : 'primary'}
              size="sm"
              loading={refundConfirmBusy}
              loadingLabel={'Saving…'}
              onClick={confirmRefundOutcome}
            >
              {refundConfirm?.kind === 'revert'
                ? 'Confirm not executed'
                : 'Confirm executed'}
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <p className="text-[var(--appearance-text-secondary)]">
            {refundConfirm?.kind === 'revert'
              ? 'Have you verified directly with the payment provider (IntaSend) that this refund was NOT sent? Confirming rejects the losing claim and flags the money it was holding for a manual refund. It will NOT send any money.'
              : 'Have you verified directly with the payment provider (IntaSend) that this refund actually reached the claimant? Confirming records the claim as refunded and closes it. It will NOT send any money.'}
          </p>
          <p className="font-mono text-caption text-[var(--appearance-text-muted)]">
            {'Claim: '}{refundConfirm?.claimId}
          </p>
          {/* Authoritative server failure stays inside the dialog, so a rejected
              action is never mistaken for a completed one. */}
          {dataError && (
            <p role="alert" className="rounded-lg border border-[var(--appearance-danger)] bg-[var(--appearance-surface-muted)] px-3 py-2 text-caption font-semibold text-[var(--appearance-danger)]">
              {dataError}
            </p>
          )}
        </div>
      </Modal>

      {/* UX-15E — the item-review reason step (shared ui/Modal).
          Opened by the same three controls as before. Cancel / Escape / scrim
          click close it with no request, no mutation and no state transition; a
          blank or whitespace-only reason for flag-stolen / legal-hold is rejected
          IN PLACE with the original 'A reason is required.' message and never
          calls handleItemReviewStatusChange; clear-hold stays optional; and the
          submitted reason is trimmed before it reaches the mutation. */}
      <Modal
        open={itemReviewPrompt !== null}
        onClose={closeItemReviewPrompt}
        title={itemReviewPrompt?.promptLabel ?? ''}
        closeLabel={'Close'}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={closeItemReviewPrompt}>
              {'Cancel'}
            </Button>
            <Button
              variant={itemReviewPrompt?.action === 'legal-hold' ? 'danger' : 'primary'}
              size="sm"
              onClick={confirmItemReviewStatusChange}
            >
              {itemReviewPrompt?.action === 'clear-hold'
                ? ('Clear hold')
                : itemReviewPrompt?.action === 'legal-hold'
                  ? ('Place Legal Hold')
                  : ('Flag Suspected Stolen')}
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          {itemReviewReasonError && <Banner kind="error">{itemReviewReasonError}</Banner>}
          <Textarea
            label={'Reason (recorded in the audit log)'}
            id="item-review-reason"
            rows={3}
            value={itemReviewReason}
            onChange={(e) => {
              setItemReviewReason(e.target.value);
              if (itemReviewReasonError) setItemReviewReasonError('');
            }}
            required={itemReviewPrompt?.action !== 'clear-hold'}
            hint={itemReviewPrompt?.action === 'clear-hold'
              ? ('Optional — clearing a hold only restores claimability.')
              : ('Required — recorded against your administrator session.')}
          />
        </div>
      </Modal>

      {/* UX-15F — the agent-warning reason step (shared ui/Modal).
          Opened by the SAME "Issue Warning" control as before, which now records
          the target instead of calling a browser prompt. Cancel / Escape / scrim
          click close it with no request, no mutation and no console state change.
          A missing or whitespace-only reason is rejected IN PLACE with the shared
          Banner (the old prompt issued no warning for one either) and never calls
          handleWarnAgent; on a valid reason the dialog closes and the UNTRIMMED
          reason reaches the unchanged mutation. */}
      <Modal
        open={agentWarnPrompt !== null}
        onClose={closeAgentWarnDialog}
        title={'Issue agent warning'}
        closeLabel={'Close'}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={closeAgentWarnDialog}>
              {'Cancel'}
            </Button>
            <Button variant="danger" size="sm" onClick={confirmAgentWarn}>
              {'Issue Warning'}
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          {agentWarnReasonError && <Banner kind="error">{agentWarnReasonError}</Banner>}
          <p className="text-[var(--appearance-text-secondary)]">
            {'This issues an official warning against this agent. The reason you give is recorded in the platform audit log against your administrator session.'}
          </p>
          <Textarea
            label={'Reason (recorded in the audit log)'}
            id="agent-warn-reason"
            rows={3}
            value={agentWarnReason}
            onChange={(e) => {
              setAgentWarnReason(e.target.value);
              if (agentWarnReasonError) setAgentWarnReasonError('');
            }}
            required
            hint={'Required — a warning is never recorded without one.'}
          />
        </div>
      </Modal>

      {/* Custom Confirmation Modal */}
      {/* UX-15G — this confirmation overlay is the SHARED ui/Modal, not bespoke
          markup: the primitive owns the dialog semantics, the focus trap, focus
          restoration, Escape and the scrim. The six flows that still store their
          title / message / callback in `confirmModal` (delete category, clear
          payment strikes, approve agent, suspend agent, resolve dispute, clear
          reputation flag) render here unchanged. Cancel, the header close
          control, Escape and the scrim all route through closeConfirmModal and
          can only clear the pending request; only Confirm runs the stored
          callback — and it then dismisses at once, so each flow keeps its
          existing close-then-run behaviour. */}
      <Modal
        open={confirmModal !== null}
        onClose={closeConfirmModal}
        title={confirmModal?.title ?? ''}
        closeLabel={'Close'}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={closeConfirmModal}>
              {'Cancel'}
            </Button>
            <Button variant="primary" size="sm" onClick={confirmPendingAction}>
              {'Confirm'}
            </Button>
          </div>
        }
      >
        {confirmModal && (
          <div className="flex items-start gap-3">
            <ShieldAlert
              size={ICON_SIZE.emphasis}
              aria-hidden="true"
              className="shrink-0 mt-0.5 text-[var(--appearance-warning)]"
            />
            <p className="text-[var(--appearance-text-secondary)]">{confirmModal.message}</p>
          </div>
        )}
      </Modal>

      {/* Lightbox Image Zoom Portal */}
      {lightboxImage && (
        // =====================================================================
        // UX-15H — WHY THIS REMAINS A SPECIALIZED OVERLAY, NOT THE SHARED MODAL
        // =====================================================================
        // The shared `Modal` is a CARD dialog: on phones it docks to the bottom
        // of the screen; on desktop it is a bordered, rounded
        // `--appearance-surface` panel capped at `sm:max-w-lg` (32rem / 512px)
        // with a header bar (heading + close control), a padded scrollable body
        // and an optional footer action row. Every one of those is wrong for
        // this surface. The viewer exists so an admin can inspect a document or
        // item photograph BIGGER than any card: the image is contained to
        // `max-w-4xl` / `max-h-[80vh]` and laid directly on a near-opaque black
        // veil — no card, no header, no footer, no padding around the photo and
        // no bottom-sheet behaviour on a phone. Representing that through the
        // primitive would mean `hideTitle` (leaving behind a visible empty
        // header bar, whose border and padding live inside the primitive and
        // cannot be removed from outside), plus a class-order-dependent
        // `sm:max-w-*` override — fighting the primitive at every level, and
        // shrinking the photograph while doing it. So the specialized overlay is
        // KEPT, and only what could be brought into line without touching that
        // contract has changed:
        //
        //   1. It IS a portal now, which is what the marker above has always
        //      claimed. The veil is `fixed inset-0`, and its parent is the
        //      `.fade-in` console root — whose `forwards` entrance animation
        //      leaves `transform: translateY(0)` applied, and a transformed
        //      ancestor is the containing block for `fixed` descendants. The
        //      "full screen" veil was therefore sized to the console rather than
        //      to the viewport (and only for admins whose OS does not request
        //      reduced motion, since that animation is disabled there).
        //      `document.body` carries no transform, so the viewer is now
        //      genuinely viewport-anchored — the same target the shared `Modal`
        //      portals to.
        //   2. Tab is trapped through the EXISTING `utils/modalFocus.ts`, the
        //      very util the primitive uses, so focus can no longer walk out of
        //      the viewer into the console dimmed behind it.
        //   3. A real close control gives that trapped focus somewhere to land,
        //      and gives pointer and screen-reader users an explicit dismissal
        //      beside the pre-existing "click anywhere" and Escape.
        // Deliberately UNCHANGED, because these are not design-system defects:
        //   * `bg-black/90` and the hint's `bg-black/70` — fixed photographic
        //     presentation, not themed surfaces. The `--appearance-scrim` role is
        //     0.6 opaque in the light theme, which would let the console show
        //     through and compete with the photograph under investigation.
        //   * `z-[120]` — above the sticky app header (z-40), the mobile drawer
        //     and the shared dialogs (z-50), whichever page the admin is on.
        //   * `fade-in` — the stylesheet's one sanctioned entrance, already
        //     neutralised under `prefers-reduced-motion`, and 400ms, the top of
        //     the documented deliberate-transition band.
        //   * the hint's `uppercase tracking-wider` pill, which is the console's
        //     accepted eyebrow idiom (the item thumbnail's "Zoom View" pill and
        //     the escrow stat labels use the same one), not a button label.
        //   * the copy: the alt text and the "click anywhere / press Escape"
        //     sentence are preserved verbatim.
        createPortal(
          <div 
            onClick={() => setLightboxImage(null)}
            className="fixed inset-0 z-[120] bg-black/90 flex items-center justify-center p-4 cursor-zoom-out fade-in"
            role="dialog"
            aria-modal="true"
            aria-label="Zoomed photograph"
            tabIndex={-1}
            ref={lightboxCloseRef}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setLightboxImage(null);
                return;
              }
              // The same trap the shared `Modal` wires: Tab stays in the viewer.
              if (lightboxCloseRef.current) trapModalFocus(e.nativeEvent, lightboxCloseRef.current);
            }}
          >
            {/* Close control — a 44px target over the photograph (the same
                fixed-imagery overlay idiom as the hero carousel controls) with
                the same X at `ICON_SIZE.emphasis` the shared `Modal` uses. */}
            <button
              type="button"
              onClick={() => setLightboxImage(null)}
              aria-label={'Close full screen view'}
              className="absolute top-4 right-4 z-10 h-11 w-11 rounded-full bg-black/30 hover:bg-black/50 text-white flex items-center justify-center cursor-pointer transition-colors motion-reduce:transition-none"
            >
              <X size={ICON_SIZE.emphasis} aria-hidden="true" />
            </button>
            <div className="relative max-w-4xl max-h-[90vh] w-full h-full flex flex-col items-center justify-center">
              <img
                src={lightboxImage}
                alt="Zoomed Photograph"
                className="max-w-full max-h-[80vh] object-contain rounded-panel"
                referrerPolicy="no-referrer"
              />
              {/* White on the fixed black pill, not a theme text role: the
                  appearance text roles flip with the theme and resolve to a
                  mid-grey in the light theme, which reads well under 3:1 on a
                  black veil. White over the photograph's own overlay is the
                  existing, theme-independent treatment (the item thumbnail's
                  "Zoom View" pill paints exactly this way). */}
              <p className="text-white text-caption mt-4 font-bold bg-black/70 px-4 py-2 rounded-full uppercase tracking-wider">
                Click anywhere, or press Escape, to close full screen view
              </p>
            </div>
          </div>,
          document.body,
        )
      )}

    </div>
  );
}
