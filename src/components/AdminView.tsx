import React, { useState, useEffect, useRef, useMemo } from 'react';
import { translations } from '../types';
// PART C — the category form previews the finder/agent/platform split with the
// SAME authoritative engine the server uses, so the numbers an admin sees in
// the console are the numbers the claim will actually be priced from.
import { computeRecoveryFee } from '../services/feeEngine';
import { ShieldCheck, BarChart2, Users, FileCheck, Coins, HelpCircle, Loader2, ArrowRight, AlertCircle, AlertTriangle, RefreshCw, CheckCircle, ShieldAlert, Package, ClipboardList, FileSearch } from 'lucide-react';
// BATCH 1 (shared admin visual language) — the console reuses the SAME design
// system every other surface uses. These are presentation primitives only:
// they hold no data, make no requests and change no behaviour.
import Button from './ui/Button';
import Badge from './ui/Badge';
import Banner from './ui/Banner';
import EmptyState from './ui/EmptyState';
import Textarea from './ui/Textarea';
import Select from './ui/Select';
import Input from './ui/Input';
import StatCard from './ui/StatCard';
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

interface AdminViewProps {
  lang: 'en' | 'sw';
  token: string | null;
  setToken: (token: string | null) => void;
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
  lang,
  claimant,
  evidenceState,
  roleLabel,
  isWinner,
  onViewPhoto,
}: {
  lang: 'en' | 'sw';
  claimant: { role: string; claim_id: string; owner_phone: string | null; claim_status: string | null; has_paid_escrow: boolean };
  evidenceState?: { loading: boolean; error: string | null; items: any[] | null };
  roleLabel: string;
  isWinner: boolean;
  onViewPhoto: (url: string) => void;
}) {
  const en = lang === 'en';
  const ownEvidence = Array.isArray(evidenceState?.items)
    ? evidenceState!.items.filter((ev: any) => ev?.claim_id === claimant.claim_id)
    : [];

  return (
    <div className={`border rounded-2xl p-4 space-y-2 ${isWinner ? 'border-status-success-border bg-status-success-surface/40' : 'border-brand-border bg-canvas-sunken'}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-extrabold text-brand-muted-text uppercase tracking-widest">{roleLabel}</span>
        {isWinner && (
          <Badge variant="success">
            {en ? 'Awarded' : 'Ilipewa ushindi'}
          </Badge>
        )}
      </div>

      <div className="text-[11px] text-brand-muted-text space-y-0.5">
        <p>
          <span className="text-brand-muted-text">{en ? 'Phone' : 'Simu'}:</span>{' '}
          <b className="text-brand-dark-text">{claimant.owner_phone || (en ? 'not recorded' : 'haijarekodiwa')}</b>
        </p>
        <p>
          <span className="text-brand-muted-text">Claim:</span>{' '}
          <span className="font-mono font-bold text-brand-dark-text">{claimant.claim_id || (en ? 'not recorded' : 'haijarekodiwa')}</span>
        </p>
        <p>
          <span className="text-brand-muted-text">{en ? 'Claim status' : 'Hali ya claim'}:</span>{' '}
          <b className="text-brand-dark-text">{claimant.claim_status || (en ? 'unknown' : 'haijulikani')}</b>
        </p>
        <p>
          <span className="text-brand-muted-text">{en ? 'Escrow paid' : 'Amana imelipwa'}:</span>{' '}
          <b className="text-brand-dark-text">{claimant.has_paid_escrow ? (en ? 'Yes' : 'Ndiyo') : (en ? 'No' : 'Hapana')}</b>
        </p>
      </div>

      <div className="border-t border-brand-border pt-2 space-y-1">
        <span className="text-[11px] font-extrabold text-brand-muted-text uppercase tracking-widest block">
          {en ? 'Submitted evidence' : 'Ushahidi uliowasilishwa'}
        </span>
        {!evidenceState ? (
          <p className="text-[11px] text-brand-muted-text">{en ? 'Not loaded yet.' : 'Haijapakiwa bado.'}</p>
        ) : evidenceState.loading ? (
          <p className="text-[11px] text-brand-muted-text" aria-busy="true">{en ? 'Loading evidence…' : 'Inapakia ushahidi…'}</p>
        ) : evidenceState.error ? (
          <p className="text-[11px] text-status-danger">
            {en ? 'Evidence could not be loaded: ' : 'Ushahidi haukupakiwa: '}{evidenceState.error}
          </p>
        ) : ownEvidence.length === 0 ? (
          <p className="text-[11px] text-brand-muted-text">{en ? 'No evidence available.' : 'Hakuna ushahidi unaopatikana.'}</p>
        ) : (
          <ul className="space-y-2">
            {ownEvidence.map((ev: any) => (
              <li key={ev.id} className="bg-white border border-brand-border rounded-xl p-2 space-y-1">
                <p className="text-[11px] text-brand-muted-text">
                  {ev.created_at ? new Date(ev.created_at).toLocaleString() : ''}
                </p>
                {ev.evidence_text && (
                  <p className="text-[11px] text-brand-dark-text whitespace-pre-wrap break-words">{ev.evidence_text}</p>
                )}
                {ev.evidence_photo_url && (
                  <img
                    src={ev.evidence_photo_url}
                    alt={en ? 'Evidence photograph submitted with this claim' : 'Picha ya ushahidi iliyowasilishwa'}
                    referrerPolicy="no-referrer"
                    onClick={() => onViewPhoto(ev.evidence_photo_url)}
                    className="w-full max-h-40 object-contain rounded-lg border border-brand-border cursor-zoom-in"
                  />
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
const CONSOLE_SECTIONS: Record<ConsoleSectionKey, { en: ConsoleSectionCopy; sw: ConsoleSectionCopy }> = {
  stats: {
    en: { title: 'Overview', description: 'Monitor platform activity, recovery performance, and operational health.' },
    sw: { title: 'Muhtasari', description: 'Fuatilia shughuli za jukwaa, utendaji wa uokoaji, na afya ya uendeshaji.' },
  },
  agents: {
    en: { title: 'Agents Hub', description: 'Review agent activity, verification, and operational status.' },
    sw: { title: 'Mawakala', description: 'Kagua shughuli za mawakala, uthibitishaji, na hali ya uendeshaji.' },
  },
  found_items: {
    en: { title: 'Found Items', description: 'Review recovered items and their current recovery state.' },
    sw: { title: 'Vitu Vilivyopatikana', description: 'Kagua vitu vilivyookolewa na hali yao ya sasa ya uokoaji.' },
  },
  disputes: {
    en: { title: 'Disputes', description: 'Investigate claims requiring administrative resolution.' },
    sw: { title: 'Migogoro', description: 'Chunguza madai yanayohitaji usuluhishi wa kiutawala.' },
  },
  claims: {
    en: { title: 'Claims', description: 'Monitor and administer active and completed recovery claims.' },
    sw: { title: 'Madai', description: 'Fuatilia na simamia madai ya uokoaji yanayoendelea na yaliyokamilika.' },
  },
  lost_reports: {
    en: { title: 'Lost Reports', description: 'Review submitted lost-item reports and their discovery status.' },
    sw: { title: 'Ripoti za Vitu', description: 'Kagua ripoti za vitu vilivyopotea na hali ya ugunduzi.' },
  },
  ledger: {
    en: { title: 'Ledger', description: 'Review settlement and financial ledger activity.' },
    sw: { title: 'Leja', description: 'Kagua shughuli za malipo na leja ya kifedha.' },
  },
  review: {
    en: { title: 'Manual Review', description: 'Review operational items requiring administrative attention.' },
    sw: { title: 'Ukaguzi wa Mkono', description: 'Kagua vitu vinavyohitaji uangalizi wa kiutawala.' },
  },
  categories: {
    en: { title: 'Categories & Fees', description: 'Configure recovery categories, fees, and finder/agent/platform allocation.' },
    sw: { title: 'Aina na Ada', description: 'Sanidi aina za uokoaji, ada, na mgawanyo wa aliyepata/wakala/jukwaa.' },
  },
  strikes: {
    en: { title: 'Payment Strikes', description: 'Review agent strikes and enforcement history.' },
    sw: { title: 'Adhabu za Malipo', description: 'Kagua adhabu za mawakala na historia ya utekelezaji.' },
  },
};

export default function AdminView({ lang, token, setToken }: AdminViewProps) {
  const t = translations[lang];

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
  const [twoFaDisablePassword, setTwoFaDisablePassword] = useState('');
  const [twoFaShowDisableForm, setTwoFaShowDisableForm] = useState(false);
  const [twoFaProcessing, setTwoFaProcessing] = useState(false);
  const [twoFaMessage, setTwoFaMessage] = useState('');
  const [twoFaError, setTwoFaError] = useState('');
  const [adminTotpEnabled, setAdminTotpEnabled] = useState(false);
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
  // backdrop here means Escape (wired via onKeyDown on that div above)
  // actually reaches a listener, and a keyboard-only admin isn't stuck
  // once they've opened a full-size photo.
  useEffect(() => {
    if (lightboxImage && lightboxCloseRef.current) {
      lightboxCloseRef.current.focus();
    }
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
        setAuthError(lang === 'en' 
          ? 'Your administrator session has expired or is invalid. Please log in again.' 
          : 'Muda wako wa kuingia kama msimamizi umeisha au si sahihi. Tafadhali ingia tena.'
        );
        return;
      }

      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        throw new Error(lang === 'en'
          ? 'The system returned an invalid response. Please try again shortly.'
          : 'Mfumo ulirudisha jibu lisilo sahihi. Tafadhali jaribu tena baada ya muda mfupi.'
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
        setAuthError(lang === 'en' 
          ? 'Your administrator session has expired or is invalid. Please log in again.' 
          : 'Muda wako wa kuingia kama msimamizi umeisha au si sahihi. Tafadhali ingia tena.'
        );
        return;
      }

      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        throw new Error(lang === 'en'
          ? 'The system returned an invalid response. Please try again shortly.'
          : 'Mfumo ulirudisha jibu lisilo sahihi. Tafadhali jaribu tena baada ya muda mfupi.'
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
      title: lang === 'en' ? 'Delete Category' : 'Futa Kitengo',
      message: lang === 'en' 
        ? `Are you sure you want to delete the category "${nameEn}"? This action cannot be undone.` 
        : `Je, una uhakika unataka kufuta kitengo cha "${nameEn}"? Kitendo hiki hakiwezi kubatilishwa.`,
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
        } catch (e: any) {
          setDataError(e.message);
        }
      }
    });
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
        setAuthError(lang === 'en' 
          ? 'Your administrator session has expired or is invalid. Please log in again.' 
          : 'Muda wako wa kuingia kama msimamizi umeisha au si sahihi. Tafadhali ingia tena.'
        );
        return;
      }

      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        throw new Error(lang === 'en'
          ? 'The system returned an invalid response. Please try again shortly.'
          : 'Mfumo ulirudisha jibu lisilo sahihi. Tafadhali jaribu tena baada ya muda mfupi.'
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
      title: lang === 'en' ? 'Clear Payment Strikes' : 'Ondoa Vikwazo vya Malipo',
      message: lang === 'en'
        ? `Are you sure you want to clear all payment strikes for ${phone}?`
        : `Je, una uhakika unataka kuondoa vikwazo vyote vya malipo vya ${phone}?`,
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

  // Begin 2FA enrollment: fetch a fresh secret/QR from the server. Nothing
  // is enabled yet — that only happens once handleTwoFaConfirm below
  // succeeds with a real code from the admin's authenticator app.
  const handleTwoFaStartSetup = async () => {
    setTwoFaError('');
    setTwoFaMessage('');
    setTwoFaProcessing(true);
    try {
      const response = await fetch('/api/auth/admin-2fa/setup', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to start 2FA setup');
      setTwoFaSetupData({ secret: data.secret, otpauthUrl: data.otpauthUrl });
    } catch (e: any) {
      setTwoFaError(e.message);
    } finally {
      setTwoFaProcessing(false);
    }
  };

  const handleTwoFaConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setTwoFaError('');
    setTwoFaMessage('');
    setTwoFaProcessing(true);
    try {
      const response = await fetch('/api/auth/admin-2fa/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ code: twoFaConfirmCode }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Incorrect code');
      setTwoFaMessage(data.message);
      setTwoFaSetupData(null);
      setTwoFaConfirmCode('');
      setAdminTotpEnabled(true);
    } catch (e: any) {
      setTwoFaError(e.message);
    } finally {
      setTwoFaProcessing(false);
    }
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
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Incorrect password');
      setTwoFaMessage(data.message);
      setTwoFaShowDisableForm(false);
      setTwoFaDisablePassword('');
      setAdminTotpEnabled(false);
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
      setDataError(lang === 'en' ? 'Enter both latitude and longitude.' : 'Weka latitude na longitude.');
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
      title: lang === 'en' ? 'Approve Agent' : 'Muidhinishe Wakala',
      message: lang === 'en'
        ? "Are you sure you want to approve this agent? They will gain access to handle sensitive documents and receive payouts."
        : "Je, una uhakika unataka kumuidhinisha wakala huyu? Atapata uwezo wa kushughulikia nyaraka nyeti na kupokea malipo.",
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
      title: lang === 'en' ? 'Suspend Agent' : 'Msimamishe Wakala',
      message: lang === 'en'
        ? "Are you sure you want to suspend this agent? They will no longer be able to accept drop-offs or process handovers."
        : "Je, una uhakika unataka kumsimamisha wakala huyu? Hataweza tena kupokea bidhaa au kushughulikia makabidhiano.",
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
  const handleWarnAgent = (id: string) => {
    const reason = prompt(lang === 'en' ? 'Enter reason for issuing warning to this agent:' : 'Weka sababu ya kumpa wakala huyu onyo:');
    if (!reason || reason.trim() === '') return;

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
  const handleRefundFinalize = (claimId: string) => {
    if (window.confirm(
      'Confirm REFUND EXECUTED?\n\nHave you verified directly with the payment provider (IntaSend) that this refund actually reached the claimant? Selecting "OK" records the claim as refunded and closes it. It will NOT send any money.\n\nClaim: ' + claimId
    )) {
      setRefundReconcileProcessing(claimId);
      setDataError('');
      setActionWarning('');
      setActionSuccess('');
      fetch(`/api/admin/refund-reconciliation/${encodeURIComponent(claimId)}/finalize`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(async (res) => {
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Finalize failed.');
          setActionSuccess(data.message);
          fetchRefundReconciliation();
          fetchDashboardData();
        })
        .catch((err) => setDataError(err.message))
        .finally(() => setRefundReconcileProcessing(null));
    }
  };

  // Admin has verified with the provider that the refund was NOT executed.
  const handleRefundRevert = (claimId: string) => {
    if (window.confirm(
      'Confirm REFUND NOT EXECUTED?\n\nHave you verified directly with the payment provider (IntaSend) that this refund was NOT sent? Selecting "OK" rejects the losing claim and flags the held escrow for a manual refund. It will NOT send any money.\n\nClaim: ' + claimId
    )) {
      setRefundReconcileProcessing(claimId);
      setDataError('');
      setActionWarning('');
      setActionSuccess('');
      fetch(`/api/admin/refund-reconciliation/${encodeURIComponent(claimId)}/revert`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ reason: 'Admin confirmed with the provider that the refund was NOT executed.' }),
      })
        .then(async (res) => {
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Revert failed.');
          setActionWarning(data.message);
          fetchRefundReconciliation();
          fetchDashboardData();
        })
        .catch((err) => setDataError(err.message))
        .finally(() => setRefundReconcileProcessing(null));
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
        lang === 'en'
          ? 'This dispute has no usable claim ID for that claimant, so it cannot be resolved from the console. Reload the dashboard; if it persists, the dispute record is incomplete.'
          : 'Mzozo huu hauna kitambulisho cha claim kinachoweza kutumika kwa mdai huyu. Pakia upya dashibodi.'
      );
      return;
    }
    if (!participatingClaimIds.includes(winningClaimId)) {
      setDataError(
        lang === 'en'
          ? 'That claim is not one of the two claimants in this dispute. Nothing was submitted.'
          : 'Claim hiyo si mojawapo ya wadai wawili wa mzozo huu. Hakuna kilichotumwa.'
      );
      return;
    }

    const roleLabel = claimant.role === 'original'
      ? (lang === 'en' ? 'Claimant A — original claim' : 'Mdai A — claim ya awali')
      : (lang === 'en' ? 'Claimant B — contesting claim' : 'Mdai B — claim inayopinga');

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
      ? (lang === 'en'
        ? 'Winning claim stays paid — it will be held at ESCROW HELD and proceed to handover.'
        : 'Claim ya mshindi inabaki imelipwa — itawekwa kwenye AMANA na kuendelea hadi makabidhiano.')
      : (lang === 'en'
        ? 'Winning claim is NOT paid — it goes back to PENDING VERIFICATION and must complete verification and payment normally.'
        : 'Claim ya mshindi HAIJALIPWA — inarudi kwenye UTHIBITISHO na lazima ikamilishe uthibitisho na malipo kama kawaida.');
    const loserOutcome = loserPaid
      ? (lang === 'en'
        ? 'Losing claim HAS paid — it will be locked to REFUNDING and a real M-Pesa refund will be attempted.'
        : 'Claim iliyoshindwa IMELIPWA — itafungwa kwenye UREJESHAJI na urejeshaji halisi wa M-Pesa utajaribiwa.')
      : (lang === 'en'
        ? 'Losing claim has NOT paid — no refund is owed and it will simply be REJECTED.'
        : 'Claim iliyoshindwa HAIJALIPWA — hakuna urejeshaji unaodaiwa na itakataliwa tu.');
    const opponentLabel = opponent
      ? `${opponent.role === 'original' ? (lang === 'en' ? 'Claimant A' : 'Mdai A') : (lang === 'en' ? 'Claimant B' : 'Mdai B')} (${opponent.owner_phone || (lang === 'en' ? 'no phone recorded' : 'simu haijarekodiwa')}, ${lang === 'en' ? 'claim' : 'claim'} ${opponent.claim_id})`
      : (lang === 'en' ? 'the opposing claimant' : 'mdai mwingine');

    setConfirmModal({
      title: lang === 'en' ? 'Resolve Dispute' : 'Suluhisha Mzozo',
      message:
        `${lang === 'en' ? 'Award' : 'Mpa ushindi'} ${dispute.id} (${lang === 'en' ? 'item' : 'bidhaa'} ${dispute.item_id}) ` +
        `${lang === 'en' ? 'to' : 'kwa'} ${roleLabel} — ${lang === 'en' ? 'phone' : 'simu'} ${claimant.owner_phone || (lang === 'en' ? 'no phone recorded' : 'simu haijarekodiwa')}, ` +
        `${lang === 'en' ? 'claim' : 'claim'} ${winningClaimId}.\n\n` +
        `${lang === 'en' ? 'Outcome for the winning claim' : 'Matokeo kwa claim ya mshindi'}: ${winnerOutcome}\n` +
        `${lang === 'en' ? 'Outcome for' : 'Matokeo kwa'} ${opponentLabel}: ${loserOutcome}\n\n` +
        (lang === 'en' ? 'This decision is final and cannot be undone.' : 'Uamuzi huu ni wa mwisho.'),
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

  const promptItemReviewStatusChange = (itemId: string, action: 'flag-stolen' | 'legal-hold' | 'clear-hold', promptLabel: string) => {
    const reason = window.prompt(promptLabel);
    if (reason === null) return; // cancelled
    if ((action === 'flag-stolen' || action === 'legal-hold') && !reason.trim()) {
      setDataError('A reason is required.');
      return;
    }
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
      title: lang === 'en' ? 'Clear Reputation Flag' : 'Ondoa Bendera ya Sifa',
      message: lang === 'en'
        ? "Are you sure you want to clear this phone number's reputation flag?"
        : "Je, una uhakika unataka kuondoa bendera ya sifa mbaya kwenye nambari hii ya simu?",
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
  const sectionCopy = CONSOLE_SECTIONS[activeTab][lang];

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 fade-in">
      
      {/* 1. SECURE ADMIN PASSCODE LOGIN (No public signups allowed to prevent privilege-escalation) */}
      {!token && (
        <div className="bg-white rounded-2xl border border-stone-100 p-6 md:p-8 shadow-sm max-w-md mx-auto space-y-6">
          <div className="text-center space-y-2">
            <div className="w-12 h-12 bg-stone-900 text-white rounded-full flex items-center justify-center mx-auto">
              <ShieldCheck size={24} />
            </div>
            <h1 className="text-2xl font-extrabold text-stone-950">Admin Authentication</h1>
            <p className="text-stone-500 text-xs max-w-sm mx-auto">Access restricted strictly to platform executives and vetted managers.</p>
          </div>

          {authError && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2.5 rounded-2xl flex items-center space-x-2 text-xs">
              <AlertCircle size={16} />
              <span>{authError}</span>
            </div>
          )}

          <form onSubmit={pendingTwoFactorToken ? handleTwoFactorVerify : handleAdminAuth} className="space-y-4">
            {!pendingTwoFactorToken ? (
              <>
                <div className="space-y-1">
                  <label htmlFor="admin-username" className="block text-xs font-bold text-stone-700 uppercase tracking-wider">Admin Username</label>
                  <input
                    id="admin-username"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="admin"
                    className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm"
                    required
                  />
                </div>

                <div className="space-y-1">
                  <label htmlFor="admin-passcode" className="block text-xs font-bold text-stone-700 uppercase tracking-wider">Access Password</label>
                  <input
                    id="admin-passcode"
                    type="password"
                    value={passcode}
                    onChange={(e) => setPasscode(e.target.value)}
                    placeholder="••••••••"
                    className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm font-mono"
                    required
                  />
                </div>
              </>
            ) : (
              <div className="space-y-1">
                <label htmlFor="admin-2fa-code" className="block text-xs font-bold text-stone-700 uppercase tracking-wider">
                  6-Digit Authenticator Code
                </label>
                <input
                  id="admin-2fa-code"
                  type="text"
                  inputMode="numeric"
                  autoFocus
                  maxLength={6}
                  value={twoFactorCode}
                  onChange={(e) => setTwoFactorCode(e.target.value)}
                  placeholder="123456"
                  className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-lg font-mono text-center tracking-widest"
                  required
                />
                <button
                  type="button"
                  onClick={() => { setPendingTwoFactorToken(null); setTwoFactorCode(''); setAuthError(''); }}
                  className="text-[11px] text-stone-400 hover:text-stone-600 underline"
                >
                  Back to password
                </button>
              </div>
            )}

            <button
              type="submit"
              disabled={pendingTwoFactorToken ? twoFactorLoading : authLoading}
              className="w-full bg-stone-900 hover:bg-stone-800 text-white py-3.5 rounded-2xl font-bold transition flex items-center justify-center space-x-2 cursor-pointer"
            >
              {(pendingTwoFactorToken ? twoFactorLoading : authLoading) ? (
                <Loader2 className="animate-spin" size={18} />
              ) : (
                <>
                  <span>{pendingTwoFactorToken ? 'Verify Code' : 'Unlock System Console'}</span>
                  <ArrowRight size={18} />
                </>
              )}
            </button>
          </form>
        </div>
      )}

      {/* 2. DISTINCT LOADING / ERROR / EMPTY STATES */}
      {token && dashboardLoading && !dashboardData && (
        <div className="flex flex-col items-center justify-center py-20 space-y-4">
          <Loader2 className="animate-spin text-primary-green w-10 h-10" />
          <p className="text-stone-500 text-xs font-semibold uppercase tracking-wider animate-pulse">
            Fetching console dashboard statistics...
          </p>
        </div>
      )}

      {token && !dashboardData && dataError && (
        <div className="bg-red-50 border border-red-100 p-6 rounded-2xl max-w-md mx-auto text-center space-y-4 my-8">
          <AlertCircle className="w-12 h-12 text-red-500 mx-auto" />
          <h2 className="text-sm font-extrabold text-red-800">Failed to Load Dashboard</h2>
          <p className="text-xs text-red-600">{dataError}</p>
          <button onClick={fetchDashboardData} className="bg-red-600 hover:bg-red-700 text-white text-xs font-bold px-4 py-2 rounded-xl transition">
            Retry Connection
          </button>
        </div>
      )}

      {token && !dashboardLoading && !dashboardData && !dataError && (
        <div className="bg-white rounded-2xl border border-stone-100 p-8 text-center space-y-4 shadow-sm max-w-md mx-auto my-8">
          <HelpCircle className="w-12 h-12 text-stone-300 mx-auto" />
          <h2 className="text-lg font-bold text-stone-800">No Dashboard Data Available</h2>
          <p className="text-xs text-stone-500">The console returned no statistical or audit record metrics at this time.</p>
          <button onClick={fetchDashboardData} className="bg-stone-900 text-white text-xs font-bold px-4 py-2 rounded-xl transition">
            Retry Fetching
          </button>
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
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-2xl border border-brand-border bg-white px-4 py-3.5 shadow-sm">
            <div className="flex items-center gap-3 min-w-0">
              <span className="w-10 h-10 rounded-xl bg-primary-green text-white flex items-center justify-center shrink-0">
                <ShieldCheck size={18} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="text-caption font-extrabold uppercase tracking-widest text-brand-muted-text">Administrator</p>
                <p className="text-sm font-extrabold text-brand-dark-text truncate">{adminLabel}</p>
                <p className="text-caption text-brand-muted-text">
                  {adminIdentity.role ? `Signed in · role ${adminIdentity.role}` : 'Signed in · active console session'}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setToken(null)}
              className="border border-brand-border hover:border-primary-green text-brand-dark-text hover:text-primary-green text-xs font-bold px-4 py-2.5 rounded-xl transition self-start sm:self-auto cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-orange/40"
            >
              {lang === 'en' ? 'Sign out' : 'Toka'}
            </button>
          </div>

          {actionSuccess && <Banner kind="success">{actionSuccess}</Banner>}

          {/* Social media publishing emergency stop — global, server-enforced,
              deliberately visible on every tab rather than tucked into
              settings. See isSocialPublishingPaused() in server.ts: every
              broadcast call site checks this before posting, and a failed
              check fails safe (treated as paused). */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-brand-border bg-white px-4 py-3 shadow-sm">
            <span className="flex items-center gap-2.5 min-w-0">
              <ShieldAlert size={16} aria-hidden="true" className="shrink-0 text-brand-muted-text" />
              <span className="text-sm font-bold text-brand-dark-text">Social Media Publishing</span>
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
                    className="flex items-center justify-between gap-2 rounded-xl border border-brand-border bg-white px-3.5 py-2.5 shadow-sm"
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <ShieldAlert size={14} aria-hidden="true" className="shrink-0 text-brand-muted-text" />
                      <span className="text-xs font-bold text-brand-dark-text">{label}</span>
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
            className="r4m-admin-nav flex border-b border-stone-200 overflow-x-auto scrollbar-none"
            aria-label={lang === 'en' ? 'Admin sections' : 'Sehemu za msimamizi'}
          >
            <button
              onClick={() => setActiveTab('stats')}
              aria-current={activeTab === 'stats' ? 'page' : undefined}
              className={`py-3 px-6 text-xs font-bold transition border-b-2 -mb-px flex items-center space-x-1.5 shrink-0 ${
                activeTab === 'stats' ? 'border-primary-green text-brand-dark-text font-extrabold' : 'border-transparent text-brand-muted-text hover:text-brand-dark-text'
              }`}
            >
              <BarChart2 size={14} />
              <span>{t.statsTab}</span>
            </button>
            <button
              onClick={() => setActiveTab('agents')}
              aria-current={activeTab === 'agents' ? 'page' : undefined}
              className={`py-3 px-6 text-xs font-bold transition border-b-2 -mb-px flex items-center space-x-1.5 shrink-0 ${
                activeTab === 'agents' ? 'border-primary-green text-brand-dark-text font-extrabold' : 'border-transparent text-brand-muted-text hover:text-brand-dark-text'
              }`}
            >
              <Users size={14} />
              <span>{lang === 'en' ? 'Agents Hub' : 'Mawakala'}</span>
            </button>
            <button
              onClick={() => setActiveTab('found_items')}
              aria-current={activeTab === 'found_items' ? 'page' : undefined}
              className={`py-3 px-6 text-xs font-bold transition border-b-2 -mb-px flex items-center space-x-1.5 shrink-0 ${
                activeTab === 'found_items' ? 'border-primary-green text-brand-dark-text font-extrabold' : 'border-transparent text-brand-muted-text hover:text-brand-dark-text'
              }`}
            >
              <Package size={14} />
              <span>{lang === 'en' ? 'Found Items' : 'Vitu Vilivyopatikana'}</span>
            </button>
            <button
              onClick={() => setActiveTab('disputes')}
              aria-current={activeTab === 'disputes' ? 'page' : undefined}
              className={`py-3 px-6 text-xs font-bold transition border-b-2 -mb-px flex items-center space-x-1.5 shrink-0 ${
                activeTab === 'disputes' ? 'border-primary-green text-brand-dark-text font-extrabold' : 'border-transparent text-brand-muted-text hover:text-brand-dark-text'
              }`}
            >
              <HelpCircle size={14} />
              <span>{t.disputesTab}</span>
            </button>
            {/* Phase 6F — Claims Administration. Read-only; the surface itself
                enforces nothing (the server does) and exposes no mutation. */}
            <button
              onClick={() => setActiveTab('claims')}
              aria-current={activeTab === 'claims' ? 'page' : undefined}
              className={`py-3 px-6 text-xs font-bold transition border-b-2 -mb-px flex items-center space-x-1.5 shrink-0 ${
                activeTab === 'claims' ? 'border-primary-green text-brand-dark-text font-extrabold' : 'border-transparent text-brand-muted-text hover:text-brand-dark-text'
              }`}
            >
              <ClipboardList size={14} />
              <span>{lang === 'en' ? 'Claims' : 'Claims'}</span>
            </button>
            <button
              onClick={() => setActiveTab('lost_reports')}
              aria-current={activeTab === 'lost_reports' ? 'page' : undefined}
              className={`py-3 px-6 text-xs font-bold transition border-b-2 -mb-px flex items-center space-x-1.5 shrink-0 ${
                activeTab === 'lost_reports' ? 'border-primary-green text-brand-dark-text font-extrabold' : 'border-transparent text-brand-muted-text hover:text-brand-dark-text'
              }`}
            >
              <FileSearch size={14} />
              <span>{lang === 'en' ? 'Lost Reports' : 'Ripoti za Vitu'}</span>
            </button>
            <button
              onClick={() => setActiveTab('ledger')}
              aria-current={activeTab === 'ledger' ? 'page' : undefined}
              className={`py-3 px-6 text-xs font-bold transition border-b-2 -mb-px flex items-center space-x-1.5 shrink-0 ${
                activeTab === 'ledger' ? 'border-primary-green text-brand-dark-text font-extrabold' : 'border-transparent text-brand-muted-text hover:text-brand-dark-text'
              }`}
            >
              <Coins size={14} />
              <span>{t.ledgerTab}</span>
            </button>
            <button
              onClick={() => setActiveTab('review')}
              aria-current={activeTab === 'review' ? 'page' : undefined}
              className={`py-3 px-6 text-xs font-bold transition border-b-2 -mb-px flex items-center space-x-1.5 shrink-0 ${
                activeTab === 'review' ? 'border-primary-green text-brand-dark-text font-extrabold' : 'border-transparent text-brand-muted-text hover:text-brand-dark-text'
              }`}
            >
              <FileCheck size={14} />
              <span>Manual Review</span>
            </button>
            <button
              onClick={() => setActiveTab('categories')}
              aria-current={activeTab === 'categories' ? 'page' : undefined}
              className={`py-3 px-6 text-xs font-bold transition border-b-2 -mb-px flex items-center space-x-1.5 shrink-0 ${
                activeTab === 'categories' ? 'border-primary-green text-brand-dark-text font-extrabold' : 'border-transparent text-brand-muted-text hover:text-brand-dark-text'
              }`}
            >
              <Coins size={14} />
              <span>{t.categoriesTab}</span>
            </button>
            <button
              onClick={() => setActiveTab('strikes')}
              aria-current={activeTab === 'strikes' ? 'page' : undefined}
              className={`py-3 px-6 text-xs font-bold transition border-b-2 -mb-px flex items-center space-x-1.5 shrink-0 ${
                activeTab === 'strikes' ? 'border-primary-green text-brand-dark-text font-extrabold' : 'border-transparent text-brand-muted-text hover:text-brand-dark-text'
              }`}
            >
              <ShieldAlert size={14} />
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
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 pb-3 border-b border-brand-border">
            <div className="space-y-1 min-w-0">
              <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight text-brand-dark-text">
                {sectionCopy.title}
              </h1>
              <p className="text-sm text-brand-muted-text leading-relaxed max-w-2xl">{sectionCopy.description}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={fetchDashboardData}
              title="Refresh Audit Data"
              aria-label="Refresh Audit Data"
              className="shrink-0 self-start"
            >
              <RefreshCw size={14} aria-hidden="true" />
              <span>{lang === 'en' ? 'Refresh' : 'Huisha'}</span>
            </Button>
          </div>

          {/* TAB CONTENT 1: STATS WORKSPACE */}
          {activeTab === 'stats' && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3 sm:gap-4">
                <StatCard
                  icon={Package}
                  label={lang === 'en' ? 'Active Holding Items' : 'Vitu Vinavyoshikiliwa'}
                  value={dashboardData.stats.itemsAtAgentCount}
                />
                <StatCard
                  icon={Users}
                  label={lang === 'en' ? 'Pending Agents' : 'Mawakala Wanaosubiri'}
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
                <div className="bg-white border border-brand-border rounded-2xl p-4 sm:p-5 shadow-sm">
                  <span className="block text-[11px] font-extrabold uppercase tracking-widest text-brand-muted-text">Escrow Funds Held</span>
                  <span className="block mt-1 text-2xl font-extrabold text-primary-green tabular-nums tracking-tight leading-tight">KES {dashboardData.stats.escrowHeldAmount}</span>
                </div>
                <div className="bg-white border border-brand-border rounded-2xl p-4 sm:p-5 shadow-sm">
                  <span className="block text-[11px] font-extrabold uppercase tracking-widest text-brand-muted-text">Claims in Escrow</span>
                  <span className="block mt-1 text-2xl font-extrabold text-primary-green tabular-nums tracking-tight leading-tight">{dashboardData.stats.escrowHeldCount}</span>
                </div>
                <StatCard
                  icon={Coins}
                  label={t.totalRev}
                  value={`KES ${dashboardData.stats.totalRevenue}`}
                />
              </div>

              {/* Admin 2FA / Security */}
              <div className="bg-white border border-brand-border rounded-2xl p-6 shadow-sm space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-extrabold text-sm text-brand-muted-text uppercase tracking-widest flex items-center gap-2">
                    <ShieldCheck size={16} aria-hidden="true" />
                    Two-Factor Authentication (2FA)
                  </h3>
                  <Badge variant={adminTotpEnabled ? 'success' : 'neutral'}>
                    {adminTotpEnabled ? 'Enabled' : 'Not Enabled'}
                  </Badge>
                </div>

                {twoFaError && <Banner kind="error">{twoFaError}</Banner>}
                {twoFaMessage && <Banner kind="success">{twoFaMessage}</Banner>}

                {!adminTotpEnabled && !twoFaSetupData && (
                  <div className="space-y-2">
                    <p className="text-sm text-brand-muted-text">
                      This admin account does not have 2FA enabled. Given this account controls dispute resolution, agent approval, and the full financial ledger, we strongly recommend enabling it.
                    </p>
                    <Button variant="primary" loading={twoFaProcessing} onClick={handleTwoFaStartSetup} className="self-start">
                      Enable 2FA
                    </Button>
                  </div>
                )}

                {twoFaSetupData && (
                  <div className="space-y-3 bg-canvas-muted border border-brand-border rounded-2xl p-4">
                    <p className="text-sm text-brand-muted-text">
                      Add this account to Google Authenticator, Authy, or any TOTP app — either by scanning a QR code generated from the URL below, or by entering the secret manually.
                    </p>
                    <div className="text-[11px] font-mono bg-white border border-brand-border rounded-lg p-2 break-all">{twoFaSetupData.otpauthUrl}</div>
                    <div className="text-xs text-brand-dark-text">
                      <span className="font-bold">Manual entry secret:</span>{' '}
                      <span className="font-mono">{twoFaSetupData.secret}</span>
                    </div>
                    <form onSubmit={handleTwoFaConfirm} className="flex gap-2 items-end">
                      <div className="flex-1 space-y-1">
                        <label htmlFor="twofa-confirm-code" className="block text-xs font-bold text-brand-dark-text">Enter code to confirm</label>
                        <input
                          id="twofa-confirm-code"
                          type="text"
                          inputMode="numeric"
                          maxLength={6}
                          value={twoFaConfirmCode}
                          onChange={(e) => setTwoFaConfirmCode(e.target.value)}
                          placeholder="123456"
                          className="w-full h-11 border border-brand-border rounded-xl px-3 text-sm font-mono text-center focus:outline-none focus:border-accent-orange focus:ring-2 focus:ring-accent-orange/30"
                          required
                        />
                      </div>
                      <Button type="submit" variant="primary" loading={twoFaProcessing}>
                        Confirm &amp; Enable
                      </Button>
                    </form>
                  </div>
                )}

                {adminTotpEnabled && !twoFaShowDisableForm && (
                  <button
                    type="button"
                    onClick={() => setTwoFaShowDisableForm(true)}
                    className="self-start text-xs font-bold text-status-danger underline hover:no-underline cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-orange/40 rounded"
                  >
                    Disable 2FA
                  </button>
                )}

                {adminTotpEnabled && twoFaShowDisableForm && (
                  <form onSubmit={handleTwoFaDisable} className="flex gap-2 items-end bg-status-danger-surface border border-status-danger-border rounded-2xl p-4">
                    <div className="flex-1 space-y-1">
                      <label htmlFor="twofa-disable-password" className="block text-xs font-bold text-status-danger">Confirm password to disable 2FA</label>
                      <input
                        id="twofa-disable-password"
                        type="password"
                        value={twoFaDisablePassword}
                        onChange={(e) => setTwoFaDisablePassword(e.target.value)}
                        className="w-full h-11 border border-brand-border rounded-xl px-3 text-sm focus:outline-none focus:border-accent-orange focus:ring-2 focus:ring-accent-orange/30"
                        required
                      />
                    </div>
                    <Button type="submit" variant="danger" loading={twoFaProcessing}>
                      Disable
                    </Button>
                  </form>
                )}
              </div>

              {/* Audit logs timeline */}
              <div className="bg-white border border-brand-border rounded-2xl p-6 shadow-sm space-y-4">
                <h3 className="font-extrabold text-sm text-brand-muted-text uppercase tracking-widest">Real-time Platform Audit Logs</h3>
                {dashboardData.auditLogs.length === 0 ? (
                  <EmptyState
                    icon={ClipboardList}
                    title={lang === 'en' ? 'No audit activity yet' : 'Hakuna shughuli bado'}
                    description={lang === 'en'
                      ? 'Platform actions appear here as they are recorded.'
                      : 'Vitendo vya jukwaa vinaonekana hapa vinaporekodiwa.'}
                  />
                ) : (
                  <div className="h-60 overflow-y-auto border border-brand-border rounded-xl font-mono text-[11px] p-4 bg-brand-beige space-y-2 leading-relaxed">
                    {dashboardData.auditLogs.map((log: any) => (
                      <div key={log.id} className="text-brand-muted-text border-b border-brand-border/60 pb-1.5 flex justify-between items-start gap-3">
                        <div className="min-w-0">
                          <span className="text-primary-green font-bold mr-2">[{log.action.toUpperCase()}]</span>
                          <span>{log.details}</span>
                        </div>
                        <span className="text-brand-muted-text shrink-0 ml-3">{new Date(log.created_at).toLocaleString()}</span>
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
              <div className="bg-white border border-brand-border rounded-2xl p-4 shadow-sm flex flex-col sm:flex-row gap-3 sm:items-end">
                <Input
                  label={lang === 'en' ? 'Search agents' : 'Tafuta mawakala'}
                  hideLabel
                  type="text"
                  value={agentSearch}
                  onChange={(e) => setAgentSearch(e.target.value)}
                  placeholder={lang === 'en' ? 'Search by business name, phone, email, till...' : 'Tafuta kwa jina la biashara, simu, barua pepe...'}
                  className="flex-1"
                />
                <Select
                  label={lang === 'en' ? 'Filter by agent status' : 'Chuja kwa hali ya wakala'}
                  hideLabel
                  value={agentStatusFilter}
                  onChange={(e) => setAgentStatusFilter(e.target.value)}
                  className="sm:w-60"
                >
                  <option value="all">{lang === 'en' ? 'All Statuses' : 'Hali Zote'}</option>
                  <option value="pending">{lang === 'en' ? 'Pending Approval' : 'Wanasubiri Uhakiki'}</option>
                  <option value="active">{lang === 'en' ? 'Active Hubs' : 'Mawakala Wanaofanya Kazi'}</option>
                  <option value="suspended">{lang === 'en' ? 'Suspended Hubs' : 'Waliosimamishwa Kazi'}</option>
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
                      title={lang === 'en' ? 'No agents found' : 'Hakuna mawakala'}
                      description={lang === 'en'
                        ? 'No registered agents match the current search or status filter.'
                        : 'Hakuna mawakala walioandikishwa wanaolingana na utafutaji au kichujio cha hali.'}
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
                          className="bg-white border border-brand-border rounded-2xl shadow-sm hover:shadow-md transition overflow-hidden"
                        >
                          {/* Core Row Header */}
                          <div 
                            onClick={() => setExpandedAgentId(isExpanded ? null : agent.id)}
                            className="p-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 cursor-pointer hover:bg-canvas-muted transition"
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
                              <h3 className="font-extrabold text-brand-dark-text text-sm md:text-base">{agent.business_name}</h3>
                              <p className="text-brand-muted-text text-xs line-clamp-1">{agent.location_address}</p>
                            </div>

                            <div className="flex items-center gap-3 self-stretch md:self-auto justify-between md:justify-end">
                              <div className="text-right hidden md:block">
                                <div className="text-xs font-bold text-status-success">KES {(agent.total_earned || 0).toLocaleString()} {lang === 'en' ? 'earned' : 'iliyopatikana'}</div>
                                <div className="text-[11px] text-brand-muted-text font-mono">{agent.contact_phone} · Till: {agent.mpesa_till_or_paybill}</div>
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
                                  {isExpanded ? (lang === 'en' ? 'Hide Details' : 'Ficha') : (lang === 'en' ? 'View Details' : 'Angalia')}
                                </Button>
                              </div>
                            </div>
                          </div>

                          {/* Expanded Details Body */}
                          {isExpanded && (
                            <div className="border-t border-brand-border bg-canvas-sunken/60 p-5 space-y-4 fade-in text-xs text-brand-muted-text">
                              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                                {/* Column 1: Verification / Details */}
                                <div className="space-y-2">
                                  <span className="text-[11px] font-extrabold text-brand-muted-text uppercase tracking-wider block">Agent Contact Details</span>
                                  <p><b>Business Name:</b> {agent.business_name}</p>
                                  <p><b>Contact Phone:</b> {agent.contact_phone}</p>
                                  <p><b>Contact Email:</b> {agent.contact_email || 'Not Provided'}</p>
                                  <p className="pt-1">
                                    <b>Total Earned:</b>{' '}
                                    <span className="text-emerald-700 font-extrabold">KES {(agent.total_earned || 0).toLocaleString()}</span>
                                    {' '}<span className="text-stone-400">({agent.completed_payouts_count || 0} completed handovers)</span>
                                  </p>
                                </div>

                                {/* Column 2: Location and Map */}
                                <div className="space-y-2">
                                  <span className="text-[11px] font-extrabold text-brand-muted-text uppercase tracking-wider block">Physical Coordinates</span>
                                  <p><b>Full Address:</b> {agent.location_address}</p>
                                  {agent.latitude && agent.longitude ? (
                                    <>
                                      <p><b>Latitude:</b> {parseFloat(agent.latitude).toFixed(6)}</p>
                                      <p><b>Longitude:</b> {parseFloat(agent.longitude).toFixed(6)}</p>
                                      <a 
                                        href={`https://www.google.com/maps/search/?api=1&query=${agent.latitude},${agent.longitude}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-primary-green hover:underline font-bold inline-flex items-center space-x-1"
                                      >
                                        <span>View on Google Maps</span>
                                      </a>
                                    </>
                                  ) : (
                                    <div className="space-y-2">
                                      <p className="text-red-500 font-bold">GPS coordinates unavailable — this agent cannot receive GPS-matched items until fixed</p>
                                      {locationFormAgentId === agent.id ? (
                                        <div className="flex flex-wrap items-end gap-2 p-2 bg-white border border-stone-200 rounded-xl">
                                          <div>
                                            <label htmlFor={`agent-lat-${agent.id}`} className="text-[9px] font-bold text-stone-500 block">Latitude</label>
                                            <input
                                              id={`agent-lat-${agent.id}`}
                                              type="text"
                                              value={locationFormLat}
                                              onChange={(e) => setLocationFormLat(e.target.value)}
                                              placeholder="-1.286389"
                                              className="w-28 border border-stone-200 rounded-lg px-2 py-1 text-xs font-mono"
                                            />
                                          </div>
                                          <div>
                                            <label htmlFor={`agent-lon-${agent.id}`} className="text-[9px] font-bold text-stone-500 block">Longitude</label>
                                            <input
                                              id={`agent-lon-${agent.id}`}
                                              type="text"
                                              value={locationFormLon}
                                              onChange={(e) => setLocationFormLon(e.target.value)}
                                              placeholder="36.817223"
                                              className="w-28 border border-stone-200 rounded-lg px-2 py-1 text-xs font-mono"
                                            />
                                          </div>
                                          <button
                                            type="button"
                                            disabled={adminActionProcessing}
                                            onClick={() => handleSetAgentLocation(agent.id)}
                                            className="bg-primary-green hover:bg-primary-hover text-white text-[10px] font-bold px-3 py-1.5 rounded-lg transition disabled:opacity-50"
                                          >
                                            Save
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => setLocationFormAgentId(null)}
                                            className="bg-stone-100 hover:bg-stone-200 text-stone-600 text-[10px] font-bold px-3 py-1.5 rounded-lg transition"
                                          >
                                            Cancel
                                          </button>
                                          <a
                                            href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(agent.location_address)}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-primary-green hover:underline text-[10px] font-bold"
                                          >
                                            Look up on Google Maps
                                          </a>
                                        </div>
                                      ) : (
                                        <button
                                          type="button"
                                          onClick={() => { setLocationFormAgentId(agent.id); setLocationFormLat(''); setLocationFormLon(''); }}
                                          className="bg-red-50 hover:bg-red-100 text-red-600 border border-red-100 text-[10px] font-extrabold px-3 py-1.5 rounded-lg transition"
                                        >
                                          Set Coordinates Manually
                                        </button>
                                      )}
                                    </div>
                                  )}
                                  <p><b>Date Registered:</b> {new Date(agent.created_at).toLocaleDateString()} {new Date(agent.created_at).toLocaleTimeString()}</p>
                                </div>

                                {/* Column 3: Performance, Finance & Warnings */}
                                <div className="space-y-2">
                                  <span className="text-[11px] font-extrabold text-brand-muted-text uppercase tracking-wider block">Financials, Rating & Warnings</span>
                                  <p><b>Payout Method:</b> {agent.payout_method_type || 'Till Number'}</p>
                                  <p><b>M-Pesa Target:</b> {agent.mpesa_till_or_paybill}</p>
                                  <p><b>Refundable Security Deposit:</b> KES {parseFloat(agent.refundable_deposit || '0').toLocaleString()}</p>
                                  <p className="flex items-center gap-1.5">
                                    <b>Rating Score:</b> 
                                    <span className="bg-amber-50 text-amber-800 font-extrabold px-2 py-0.5 rounded border border-amber-100 flex items-center gap-0.5">
                                      {parseFloat(agent.rating || '5.0').toFixed(1)}
                                    </span>
                                    <span>({agent.rating_count || 0} reviews)</span>
                                  </p>
                                  <div className="bg-red-50 border border-red-100 p-2 rounded-xl space-y-1 mt-1">
                                    <p className="font-bold text-red-800 text-[11px]">Warnings: {agent.warning_count || 0}</p>
                                    {agent.last_warning_reason && (
                                      <p className="text-[10px] text-red-600 italic">"Last: {agent.last_warning_reason}"</p>
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
                                <div className="border-t border-brand-border pt-3 space-y-2">
                                  <span className="text-[11px] font-extrabold text-brand-muted-text uppercase tracking-wider block">Agent Verification Photographs</span>
                                  <p className="text-[11px] text-brand-muted-text flex items-center gap-1.5" aria-busy="true">
                                    <Loader2 className="animate-spin" size={12} aria-hidden="true" /> Loading verification photographs…
                                  </p>
                                </div>
                              ) : agentDocs && agentDocs.id === agent.id ? (
                                (agentDocs.shop_photo_url || agentDocs.id_document_photo_url) ? (
                                  <div className="border-t border-brand-border pt-3 space-y-2">
                                    <span className="text-[11px] font-extrabold text-brand-muted-text uppercase tracking-wider block">Agent Verification Photographs</span>
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
                                          <p className="text-[11px] font-bold text-brand-dark-text">Shop / Business Location Front</p>
                                          <div className="w-32 h-24 rounded-xl border border-brand-border overflow-hidden bg-canvas-muted relative">
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
                                          <p className="text-[11px] font-bold text-brand-dark-text">National ID Document Photo</p>
                                          <div className="w-32 h-24 rounded-xl border border-brand-border overflow-hidden bg-canvas-muted relative">
                                            <img src={agentDocs.id_document_photo_url} alt="ID Document" className="w-full h-full object-cover group-hover:scale-105 transition" />
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                ) : (
                                  <div className="border-t border-brand-border pt-3">
                                    <span className="text-[11px] font-extrabold text-brand-muted-text uppercase tracking-wider block">Agent Verification Photographs</span>
                                    <p className="text-[11px] text-brand-muted-text pt-1">No verification photographs on file for this agent.</p>
                                  </div>
                                )
                              ) : agentDocsError && expandedAgentId === agent.id ? (
                                <div className="border-t border-brand-border pt-3">
                                  <span className="text-[11px] font-extrabold text-brand-muted-text uppercase tracking-wider block">Agent Verification Photographs</span>
                                  <p className="text-[11px] text-status-danger pt-1">{agentDocsError}</p>
                                </div>
                              ) : null}

                              {/* Actions on this Agent */}
                              <div className="border-t border-stone-200/60 pt-4 flex flex-wrap justify-end gap-2">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={adminActionProcessing}
                                  onClick={() => handleWarnAgent(agent.id)}
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
              <div className="bg-white border border-brand-border rounded-2xl p-5 shadow-sm space-y-4">
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

                <div className="flex flex-wrap gap-2 pt-2 border-t border-brand-border">
                  <span className="text-[11px] font-bold text-brand-muted-text self-center uppercase tracking-wider mr-1">Quick Categories:</span>
                  <button
                    onClick={() => setItemCategoryFilter('all')}
                    className={`px-3 py-1.5 text-[11px] font-bold rounded-full border transition cursor-pointer ${
                      itemCategoryFilter === 'all'
                        ? 'bg-primary-green text-white border-primary-green'
                        : 'bg-white text-brand-dark-text border-brand-border hover:border-primary-green'
                    }`}
                  >
                    All Categories
                  </button>
                  {categories.map((cat: any) => (
                    <button
                      key={cat.id}
                      onClick={() => setItemCategoryFilter(cat.id)}
                      className={`px-3 py-1.5 text-[11px] font-bold rounded-full border transition cursor-pointer ${
                        itemCategoryFilter === cat.id
                          ? 'bg-primary-green text-white border-primary-green'
                          : 'bg-white text-brand-dark-text border-brand-border hover:border-primary-green'
                      }`}
                    >
                      {lang === 'en' ? cat.name_en : cat.name_sw}
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
                      title={lang === 'en' ? 'No found items match your filters' : 'Hakuna vitu vinavyolingana'}
                      description={lang === 'en'
                        ? 'Adjust the search, status, category or review-flag filters to see recovered items.'
                        : 'Badilisha vichujio vya utafutaji, hali, aina au ukaguzi ili kuona vitu.'}
                    />
                  );
                }

                return (
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    {filteredItems.map((item: any) => {
                      // Lookup agent
                      const agentObj = dashboardData.agents.find((a: any) => a.id === item.assigned_agent_id);
                      return (
                        <div key={item.id} className="bg-white border border-brand-border rounded-2xl p-5 shadow-sm hover:shadow-md transition flex flex-col md:flex-row gap-5">
                          {/* Image Thumbnail with zoom trigger */}
                          <div 
                            onClick={() => setLightboxImage(item.photo_url)}
                            className="w-full md:w-36 h-36 rounded-2xl bg-canvas-muted border border-brand-border overflow-hidden shrink-0 flex items-center justify-center cursor-zoom-in relative group"
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
                              <span className="text-white text-[10px] font-black bg-stone-900/80 px-2 py-1 rounded-md uppercase tracking-wider">Zoom View</span>
                            </div>
                          </div>

                          {/* Item Details Column */}
                          <div className="flex-1 flex flex-col justify-between space-y-3 min-w-0">
                            <div className="space-y-1.5">
                              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-100 pb-2">
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

                              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                                <div>
                                  <span className="text-[10px] text-stone-400 block">Category</span>
                                  <span className="font-bold text-stone-800">
                                    {categories.find((c: any) => c.id === item.category_id)?.name_en || item.category_id}
                                  </span>
                                </div>
                                <div>
                                  <span className="text-[10px] text-stone-400 block">Date Reported</span>
                                  <span className="font-medium text-stone-800">
                                    {new Date(item.created_at).toLocaleDateString()}
                                  </span>
                                </div>
                                
                                {/* OCR / Description Details */}
                                <div className="col-span-2 pt-1 border-t border-stone-50">
                                  {item.is_description_only || item.isDescriptionOnly ? (
                                    <div>
                                      <span className="text-[10px] text-stone-400 block">Description</span>
                                      <p className="text-stone-700 text-[11px] leading-normal italic font-medium">"{item.description}"</p>
                                    </div>
                                  ) : (
                                    <div className="grid grid-cols-2 gap-2">
                                      <div>
                                        <span className="text-[10px] text-stone-400 block">Extracted Number</span>
                                        <span className="font-mono font-bold text-stone-800 break-all">{item.ocr_extracted_number || 'None'}</span>
                                      </div>
                                      <div>
                                        <span className="text-[10px] text-stone-400 block">Extracted Name</span>
                                        <span className="font-sans font-extrabold text-stone-800 uppercase line-clamp-1">{item.ocr_extracted_name || 'None'}</span>
                                      </div>
                                    </div>
                                  )}
                                </div>

                                {/* Matching Stats & Location details */}
                                <div className="col-span-2 pt-1 border-t border-stone-50 text-[11px]">
                                  <p className="text-stone-500">
                                    <b>Location:</b> {item.location_description}
                                  </p>
                                  {item.latitude && item.longitude && (
                                    <p className="text-stone-400 font-mono text-[10px] mt-0.5">
                                      GPS: {parseFloat(item.latitude).toFixed(4)}, {parseFloat(item.longitude).toFixed(4)}
                                    </p>
                                  )}
                                </div>

                                {/* Finder phone and reputation */}
                                <div className="col-span-2 pt-1.5 border-t border-stone-100 bg-stone-50 p-2 rounded-xl text-[11px]">
                                  <p className="font-bold text-stone-700">Finder Information:</p>
                                  <div className="flex justify-between mt-1 text-stone-600">
                                    <span>Phone: <b>{item.finder_phone}</b></span>
                                    {item.reputation && (
                                      <span>Reputation: <b>{item.reputation.rejected_reports}/{item.reputation.total_reports} rejected</b></span>
                                    )}
                                  </div>
                                </div>

                                {/* Assigned Agent Hub details */}
                                <div className="col-span-2 pt-1.5 border-t border-stone-50 text-[11px]">
                                  <span className="text-[10px] text-stone-400 block">Assigned Physical Agent Station</span>
                                  {agentObj ? (
                                    <div className="mt-0.5 flex justify-between items-center bg-brand-beige p-2 rounded-xl border border-stone-200/50">
                                      <div>
                                        <p className="font-extrabold text-stone-800">{agentObj.business_name}</p>
                                        <p className="text-[10px] text-stone-500 line-clamp-1">{agentObj.location_address}</p>
                                      </div>
                                      {item.agent_assignment_distance_km !== null && (
                                        <span className="bg-stone-100 text-stone-700 font-mono text-[9px] px-2 py-0.5 rounded-md font-bold shrink-0">
                                          {parseFloat(item.agent_assignment_distance_km).toFixed(1)} km
                                        </span>
                                      )}
                                    </div>
                                  ) : (
                                    <span className="text-red-500 font-bold block">No Assigned Agent (Error)</span>
                                  )}
                                </div>
                              </div>
                            </div>

                            {/* Action to correct / review */}
                            {item.flaggedForReview && (
                              <div className="pt-2 border-t border-brand-border flex justify-end">
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
                            <div className="pt-2 border-t border-brand-border flex flex-wrap justify-end gap-2">
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
            <ClaimsAdministration lang={lang} token={token} />
          )}

          {/* TAB CONTENT: LOST REPORTS (PHASE 11A) */}
          {/* Read-only operational visibility. Mounting is what triggers the
              fetch, so entering the tab always shows current data, and leaving
              it aborts any in-flight request. There is no admin action here:
              reports are visible, not editable. */}
          {activeTab === 'lost_reports' && (
            <LostReportsAdministration lang={lang} token={token} />
          )}

          {/* TAB CONTENT 3: OPEN DISPUTES CHECKOUT */}
          {activeTab === 'disputes' && (
            <div className="space-y-4">
              {/* REFUNDS REQUIRING RECONCILIATION (A1 unknown-outcome workflow) */}
              <div className="bg-white border border-status-warning-border rounded-2xl p-5 shadow-sm">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <h3 className="font-extrabold text-sm text-status-warning uppercase tracking-widest">Refunds Requiring Reconciliation</h3>
                    <p className="text-xs text-brand-muted-text mt-1">
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
                  <p className="text-xs text-brand-muted-text py-3" aria-busy="true">Loading&hellip;</p>
                ) : !refundReconcileItems || refundReconcileItems.length === 0 ? (
                  <p className="text-xs text-brand-muted-text py-2">No refunds currently require reconciliation.</p>
                ) : (
                  <div className="space-y-2">
                    {refundReconcileItems.map((item: any) => (
                      <div key={item.claimId} className="border border-brand-border rounded-xl p-3 space-y-2">
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                          <Badge variant="code">Claim: {item.claimId}</Badge>
                          <span className="text-brand-muted-text">Item: {item.itemId || '\u2014'}</span>
                          <span className="text-brand-muted-text">Recipient: {item.ownerPhone}</span>
                          <span className="text-brand-muted-text">Amount: KES {item.refundAmount}</span>
                          <span className="text-brand-muted-text">Waiting since: {item.waitingSince ? new Date(item.waitingSince).toLocaleString() : '\u2014'}</span>
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
                  title={lang === 'en' ? 'No disputes to adjudicate' : 'Hakuna mizozo ya kusuluhisha'}
                  description={lang === 'en'
                    ? 'No ownership disputes have been raised.'
                    : 'Hakuna mizozo ya umiliki iliyoanzishwa.'}
                />
              ) : (
                <div className="space-y-4">
                  {dashboardData.disputes.map((dispute: any) => {
                    const claimants: any[] = Array.isArray(dispute.claimants) ? dispute.claimants : [];
                    const isResolved = !!dispute.resolved_at || !!dispute.resolved_by;
                    const evidenceState = disputeEvidence[dispute.id];
                    const roleLabel = (role: string) => role === 'original'
                      ? (lang === 'en' ? 'Claimant A — original claim' : 'Mdai A — claim ya awali')
                      : (lang === 'en' ? 'Claimant B — contesting claim' : 'Mdai B — claim inayopinga');
                    const roleShort = (role: string) => role === 'original'
                      ? (lang === 'en' ? 'Claimant A' : 'Mdai A')
                      : (lang === 'en' ? 'Claimant B' : 'Mdai B');
                    return (
                    <div key={dispute.id} className="bg-white border border-brand-border rounded-2xl p-5 shadow-sm space-y-4">
                      <div className="flex flex-wrap justify-between items-center gap-2 pb-3 border-b border-brand-border">
                        <div>
                          <span className="text-xs font-mono font-bold text-status-danger">DISPUTE: {dispute.id}</span>
                          <p className="text-[11px] text-brand-muted-text">
                            {lang === 'en' ? 'Raised on' : 'Ilianzishwa'}{' '}
                            {dispute.created_at ? new Date(dispute.created_at).toLocaleString() : '—'}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] font-bold text-brand-muted-text">
                            {lang === 'en' ? 'Item' : 'Bidhaa'}: {dispute.item_id || '—'}
                          </span>
                          <Badge variant={isResolved ? 'neutral' : 'warning'}>
                            {isResolved ? (lang === 'en' ? 'Resolved' : 'Imetatuliwa') : (lang === 'en' ? 'Open' : 'Wazi')}
                          </Badge>
                        </div>
                      </div>

                      {claimants.length === 0 ? (
                        <p className="text-xs text-status-danger">
                          {lang === 'en'
                            ? 'No claimant details were returned for this dispute, so it cannot be adjudicated from here.'
                            : 'Hakuna taarifa za wadai zilizorejeshwa kwa mzozo huu, hivyo hauwezi kusuluhishwa hapa.'}
                        </p>
                      ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          {claimants.map((claimant: any) => (
                            <DisputeClaimantPanel
                              key={claimant.role + ':' + claimant.claim_id}
                              lang={lang}
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
                          {lang === 'en' ? 'Load evidence' : 'Pakia ushahidi'}
                        </Button>
                      </div>

                      {/* Resolution actions. Only offered on an OPEN dispute whose
                          claimant claim IDs actually came back from the API — a
                          resolved dispute is reported as resolved rather than
                          offering buttons that can only fail. */}
                      {isResolved ? (
                        <p className="text-xs text-brand-muted-text border-t border-brand-border pt-3">
                          {lang === 'en' ? 'Resolved' : 'Imemetatuliwa'}
                          {dispute.resolved_at ? ` ${new Date(dispute.resolved_at).toLocaleString()}` : ''}
                          {dispute.resolved_claim_id
                            ? ` — ${lang === 'en' ? 'awarded to claim' : 'ilipatiwa claim'} ${dispute.resolved_claim_id}`
                            : ''}
                          {dispute.resolved_by ? ` (${dispute.resolved_by})` : ''}
                        </p>
                      ) : claimants.length === 0 ? (
                        <p className="text-xs text-status-danger border-t border-brand-border pt-3">
                          {lang === 'en'
                            ? 'Resolution is unavailable: the two claimant claim IDs were not returned for this dispute.'
                            : 'Kusuluhisha hakuwezekani: vitambulisho vya claim havijarejeshwa.'}
                        </p>
                      ) : (
                        <div className="flex flex-wrap justify-end gap-2 pt-2 border-t border-brand-border">
                          {claimants.map((claimant: any) => (
                            <Button
                              key={'award:' + claimant.role}
                              variant={claimant.role === 'original' ? 'primary' : 'accent'}
                              size="sm"
                              disabled={adminActionProcessing || !claimant.claim_id}
                              title={!claimant.claim_id
                                ? (lang === 'en'
                                  ? 'No claim ID is available for this claimant'
                                  : 'Hakuna kitambulisho cha claim kwa mdai huyu')
                                : undefined}
                              onClick={() => handleResolveDispute(dispute, claimant)}
                            >
                              {lang === 'en'
                                ? `Award ${roleShort(claimant.role)}`
                                : `Mpa ushindi ${roleShort(claimant.role)}`}
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
              <div className="bg-white border border-brand-border rounded-2xl shadow-sm p-5 space-y-3">
                <div>
                  <h3 className="text-sm font-extrabold text-brand-dark-text">Pending Settlements</h3>
                  <p className="text-xs text-brand-muted-text">
                    Handover confirmed, payout booked, dispute window still open. Settles automatically, or release now to override.
                  </p>
                </div>
                {(!dashboardData.pendingSettlements || dashboardData.pendingSettlements.length === 0) ? (
                  <p className="text-center text-brand-muted-text text-xs py-4">No claims currently in the dispute window.</p>
                ) : (
                  <div className="space-y-2">
                    {dashboardData.pendingSettlements.map((ps: any) => {
                      const settleAtDate = ps.settleAt ? new Date(ps.settleAt) : null;
                      const isDue = settleAtDate ? settleAtDate.getTime() <= Date.now() : false;
                      return (
                        <div key={ps.claimId} className="flex flex-wrap items-center justify-between gap-2 border border-brand-border rounded-xl p-3 bg-brand-beige/40">
                          <div className="text-xs">
                            <span className="font-mono font-bold text-brand-dark-text">{ps.claimId}</span>
                            <span className="text-brand-muted-text/60 mx-1.5">·</span>
                            <span className="text-brand-muted-text">Item {ps.itemId}</span>
                            <span className="text-brand-muted-text/60 mx-1.5">·</span>
                            <span className={`font-bold ${isDue ? 'text-status-success' : 'text-status-warning'}`}>
                              {settleAtDate ? (isDue ? 'Due now' : `Settles ${settleAtDate.toLocaleString()}`) : 'No settle time set'}
                            </span>
                            {ps.lockedTotalFee !== null && (
                              <span className="text-brand-muted-text"> · KES {ps.lockedTotalFee}</span>
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

              <div className="bg-white border border-brand-border rounded-2xl shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-brand-light-gray text-xs font-extrabold text-brand-muted-text uppercase tracking-widest border-b border-brand-border">
                        <th className="px-5 py-3 font-bold">Transaction Reference</th>
                        <th className="px-5 py-3 font-bold">Type</th>
                        <th className="px-5 py-3 font-bold">Amount</th>
                        <th className="px-5 py-3 font-bold">Claim</th>
                        <th className="px-5 py-3 font-bold">Status</th>
                        <th className="px-5 py-3 font-bold">Date</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-brand-border text-xs text-brand-muted-text font-mono">
                      {dashboardData.ledger.map((entry: any) => (
                        <tr key={entry.id} className="hover:bg-brand-beige/50 transition">
                          <td className="px-5 py-3.5 font-bold text-brand-dark-text">{entry.id}</td>
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
                          <td className="px-5 py-3.5 font-bold text-brand-dark-text">KES {entry.amount}</td>
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
                          <td className="px-5 py-3.5 text-brand-muted-text text-xs whitespace-nowrap">
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
              <p className="text-xs text-brand-muted-text max-w-2xl">
                These items have low OCR confidence, missing details, or require administrator correction.
              </p>

              {selectedReviewItem ? (
                <div className="bg-white border border-brand-border rounded-2xl p-6 md:p-8 shadow-sm space-y-6 max-w-2xl mx-auto">
                  <div className="flex justify-between items-center border-b border-brand-border pb-3">
                    <h3 className="font-extrabold text-brand-dark-text">Reviewing Item: {selectedReviewItem.id}</h3>
                    <Button variant="ghost" size="sm" onClick={() => setSelectedReviewItem(null)}>
                      Back to list
                    </Button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* Left: Finder Photo */}
                    <div className="space-y-2">
                      <span className="text-[11px] font-extrabold text-brand-muted-text uppercase tracking-widest block">Uploaded Photo</span>
                      <div className="border border-brand-border rounded-2xl overflow-hidden bg-brand-light-gray aspect-[4/3] flex items-center justify-center">
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
                        disabled={categoriesLoading}
                      >
                          {categoriesLoading ? (
                            <option value="">Loading categories...</option>
                          ) : (
                            (() => {
                              const validCategories = categories.filter(cat => cat.name_en && cat.name_sw);
                              const invalidCount = categories.length - validCategories.length;
                              if (invalidCount > 0) {
                                console.warn(`[AdminView] Filtered out ${invalidCount} incomplete categories from rendering.`);
                              }
                              return validCategories.map(cat => (
                                <option key={cat.id} value={cat.id}>
                                  {cat.name_en}
                                </option>
                              ));
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
                        <div className="p-2.5 bg-brand-light-gray border border-brand-border rounded-xl text-[11px] font-mono text-brand-muted-text space-y-1">
                          <p className="font-sans font-bold text-brand-dark-text">Assignment Metadata:</p>
                          <p>Method: <span className="font-bold text-brand-dark-text">{selectedReviewItem.agent_assignment_method}</span></p>
                          {selectedReviewItem.agent_assignment_distance_km !== null && (
                            <p>Calculated Distance: <span className="font-bold text-brand-dark-text">{parseFloat(selectedReviewItem.agent_assignment_distance_km).toFixed(2)} km</span></p>
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
                          className="rounded text-primary-green focus:ring-primary-green h-4 w-4"
                        />
                        <label htmlFor="reviewIsDescriptionOnly" className="text-xs font-bold text-brand-dark-text">
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
                          <p className="text-xs text-brand-muted-text">Original OCR: {selectedReviewItem.ocr_extracted_number || 'None'}</p>

                          <Input
                            label="Full Name on Document"
                            id="review-ocr-name"
                            type="text"
                            value={reviewOcrName}
                            onChange={(e) => setReviewOcrName(e.target.value)}
                            placeholder="e.g. JOHN DOE"
                            required
                          />
                          <p className="text-xs text-brand-muted-text">Original OCR: {selectedReviewItem.ocr_extracted_name || 'None'}</p>
                        </>
                      )}

                      <div className="flex gap-2">
                        <Button type="submit" variant="primary" loading={reviewSaving} className="flex-1">
                          <span>Save Correction</span>
                          <ArrowRight size={16} aria-hidden="true" />
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
                          <div key={item.id} className="bg-white border border-brand-border rounded-2xl p-5 shadow-sm flex flex-col justify-between gap-4">
                            <div className="flex gap-4">
                              <div className="w-16 h-16 rounded-xl bg-brand-light-gray border border-brand-border overflow-hidden shrink-0 flex items-center justify-center">
                                <img
                                  src={item.photo_url}
                                  alt="Thumbnail"
                                  className="w-full h-full object-contain"
                                  referrerPolicy="no-referrer"
                                />
                              </div>
                              <div className="space-y-1">
                                <Badge variant="danger">Flagged</Badge>
                                <h3 className="font-extrabold text-brand-dark-text text-xs">Code: {item.id}</h3>
                                <p className="text-brand-muted-text text-xs leading-snug">{item.location_description}</p>
                                <p className="text-brand-muted-text text-[11px] font-mono">Date: {new Date(item.created_at).toLocaleDateString()}</p>
                                {item.agent_assignment_method && (
                                  <div className="mt-1.5 p-1.5 bg-brand-light-gray rounded-lg text-[11px] font-mono text-brand-muted-text">
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
                                    <p className="text-xs text-brand-dark-text font-bold">
                                      Finder: {item.finder_phone}
                                    </p>
                                    <p className="text-[11px] text-brand-muted-text">
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
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-brand-border pb-4">
                <p className="text-xs text-brand-muted-text max-w-2xl">
                  Dhibiti kategoria za bidhaa, bei, na migao ya malipo. / Manage document categories, fees, and disbursement splits.
                </p>
                {!showCategoryForm && (
                  <Button variant="primary" size="sm" onClick={() => resetCategoryForm('create')} className="shrink-0">
                    <span>+ Add New Category (Weka Kategoria Mpya)</span>
                  </Button>
                )}
              </div>

              {showCategoryForm ? (
                <div className="bg-white border border-brand-border rounded-2xl p-6 md:p-8 shadow-sm space-y-6 max-w-2xl mx-auto">
                  <div className="flex justify-between items-center gap-3 border-b border-brand-border pb-3">
                    <h3 className="font-extrabold text-brand-dark-text">
                      {showCategoryForm === 'create' ? 'Create New Category' : `Editing Category: ${catFormId}`}
                    </h3>
                    <Button variant="ghost" size="sm" onClick={() => setShowCategoryForm(null)}>
                      Cancel / Ghairi
                    </Button>
                  </div>

                  <form onSubmit={handleSaveCategory} className="space-y-4">
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

                      {/* Is Sensitive Document */}
                      <div className="space-y-1 flex flex-col justify-end pb-2">
                        <div className="flex items-center space-x-2">
                          <input
                            type="checkbox"
                            id="catFormIsSensitive"
                            checked={catFormIsSensitive}
                            onChange={(e) => setCatFormIsSensitive(e.target.checked)}
                            className="rounded text-primary-green focus:ring-primary-green h-4 w-4"
                          />
                          <label htmlFor="catFormIsSensitive" className="text-xs font-bold text-brand-dark-text">
                            Is Sensitive Document? (Inahitaji OCR/ID ya mmliki)
                          </label>
                        </div>
                      </div>

                      {/* Elevated Review (cash, children's-property style categories) */}
                      <div className="space-y-1 flex flex-col justify-end pb-2">
                        <div className="flex items-center space-x-2">
                          <input
                            type="checkbox"
                            id="catFormElevatedReview"
                            checked={catFormElevatedReview}
                            onChange={(e) => setCatFormElevatedReview(e.target.checked)}
                            className="rounded text-red-600 focus:ring-red-500 h-4 w-4"
                          />
                          <label htmlFor="catFormElevatedReview" className="text-xs font-bold text-brand-dark-text">
                            Elevated Review — force admin approval before this category's items go public
                          </label>
                        </div>
                      </div>

                      {/* P14A (P14-05) — public-recognition masking style. Drives how this
                          category's document-number clue is masked in public posts (see
                          services/publicRecognition.ts). The option VALUES are the canonical
                          enum values the server validates against; only the labels differ. */}
                      <Select
                        className="col-span-3"
                        label="Public Recognition — document-number clue style"
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

                      {/* Flat fee override toggle — decides whether total_fee/finder_share/
                          agent_share/platform_share below win outright (ignoring the Recovery
                          Fee Engine section further down), or whether the engine computes the
                          fee fresh from base/complexity/delay/ceiling every time. Previously
                          this was silently forced on by every save from this form, which meant
                          editing the engine fields below had no effect the moment you saved —
                          it's now an explicit choice. */}
                      <div className="col-span-3 space-y-1">
                        <div className="flex items-center space-x-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                          <input
                            type="checkbox"
                            id="catFormIsAdminModified"
                            checked={catFormIsAdminModified}
                            onChange={(e) => setCatFormIsAdminModified(e.target.checked)}
                            className="rounded text-amber-600 focus:ring-amber-500 h-4 w-4"
                          />
                          <label htmlFor="catFormIsAdminModified" className="text-xs font-bold text-amber-800">
                            Use flat fee override — pin Total/Finder/Agent/Platform fee below exactly, and ignore the Recovery Fee Engine config further down entirely
                          </label>
                        </div>
                      </div>

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
                          <div className="text-xs mt-1 font-semibold">
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
                    <div className={`border rounded-xl p-4 space-y-3 ${catFormIsAdminModified ? 'border-brand-border bg-canvas-muted opacity-60' : 'border-brand-border bg-canvas-sunken'}`}>
                      <p className="text-[11px] font-extrabold text-brand-muted-text uppercase tracking-wider">
                        Recovery Fee Engine Config
                      </p>
                      {catFormIsAdminModified && (
                        <Banner kind="warning">
                          Inactive — "Use flat fee override" is checked above, so this category ignores everything below and uses the flat Total/Finder/Agent/Platform fee instead.
                        </Banner>
                      )}
                      <p className="text-xs text-brand-muted-text leading-tight">
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
                        <p className="text-xs font-bold text-status-danger">
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
                      <div className="rounded-xl border border-brand-border bg-white p-3 space-y-2">
                        {catFormAmountEntered ? (
                        <>
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <span className="text-[11px] font-extrabold text-brand-muted-text uppercase tracking-wider">
                            Calculated split
                          </span>
                          <span className="text-xs text-brand-muted-text">
                            Claim fee{' '}
                            <span className="font-extrabold text-brand-dark-text">{kes(enginePreview.totalFee)}</span>
                          </span>
                        </div>

                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-brand-muted-text uppercase tracking-wider">
                              <th scope="col" className="text-left font-extrabold py-1">Share</th>
                              <th scope="col" className="text-right font-extrabold py-1">Rate</th>
                              <th scope="col" className="text-right font-extrabold py-1">Amount</th>
                            </tr>
                          </thead>
                          <tbody className="text-brand-dark-text">
                            <tr className="border-t border-brand-border">
                              <th scope="row" className="text-left font-semibold py-1">Finder</th>
                              <td className="text-right py-1">{Number(catFormFinderPct) || 0}%</td>
                              <td className="text-right py-1 font-bold">{kes(enginePreview.finderAmount)}</td>
                            </tr>
                            <tr className="border-t border-brand-border">
                              <th scope="row" className="text-left font-semibold py-1">Agent</th>
                              <td className="text-right py-1">{Number(catFormAgentPct) || 0}%</td>
                              <td className="text-right py-1 font-bold">{kes(enginePreview.agentAmount)}</td>
                            </tr>
                            <tr className="border-t border-brand-border">
                              <th scope="row" className="text-left font-semibold py-1">Platform</th>
                              <td className="text-right py-1">{Number(catFormPlatformPct) || 0}%</td>
                              <td className="text-right py-1 font-bold">{kes(enginePreview.platformAmount)}</td>
                            </tr>
                          </tbody>
                          <tfoot>
                            <tr className="border-t border-brand-border text-brand-dark-text">
                              <th scope="row" className="text-left font-extrabold py-1">Total</th>
                              <td />
                              <td className="text-right py-1 font-extrabold">{kes(enginePreviewSplitTotal)}</td>
                            </tr>
                          </tfoot>
                        </table>

                        {enginePreview.finderCapApplied && (
                          <p className="text-xs font-bold text-status-warning bg-status-warning-surface border border-status-warning-border rounded-lg px-2 py-1">
                            Finder reward cap applied — the finder share was trimmed to the cap and the platform share absorbed the difference.
                          </p>
                        )}
                        {enginePreviewSplitTotal !== enginePreview.totalFee && (
                          <p className="text-xs font-bold text-status-danger">
                            The three shares do not reconcile to the claim fee — check the configured percentages before saving.
                          </p>
                        )}
                        {catFormIsAdminModified && (
                          <p className="text-xs font-bold text-status-warning bg-status-warning-surface border border-status-warning-border rounded-lg px-2 py-1 leading-tight">
                            Informational only — the "Use flat fee override" option is checked above, so these engine values are NOT what will be saved. Saving this category persists the flat Total/Finder/Agent/Platform fee instead.
                          </p>
                        )}
                        <p className="text-xs text-brand-muted-text leading-tight">
                          Preview only, with no declared value — so it prices at Base + Complexity + Delay. A finder's declared replacement value can only pull the fee DOWN at the Ceiling % above, never up. The server recomputes this for every real claim; the browser is never the financial authority.
                        </p>
                        </>
                        ) : (
                          <p className="text-xs text-brand-muted-text leading-tight">
                            Enter an amount (Base, Complexity or Delay fee) to see the calculated split — not yet calculable at KES 0.
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex gap-2 pt-2">
                      <Button
                        type="submit"
                        variant="primary"
                        disabled={!splitsMatch}
                        loading={catSaving}
                        className="flex-1"
                      >
                        <span>Save Category / Hifadhi</span>
                        <ArrowRight size={16} aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => setShowCategoryForm(null)}
                      >
                        Cancel / Ghairi
                      </Button>
                    </div>
                  </form>
                </div>
              ) : (
                <div className="bg-white border border-brand-border rounded-2xl overflow-hidden shadow-sm">
                  {adminCategoriesLoading ? (
                    <div className="flex flex-col items-center justify-center py-12 space-y-2">
                      <Loader2 className="animate-spin text-primary-green w-6 h-6" aria-hidden="true" />
                      <p className="text-brand-muted-text text-xs font-bold uppercase tracking-wider">Loading categories...</p>
                    </div>
                  ) : adminCategories.length === 0 ? (
                    <div className="p-4">
                      <EmptyState icon={Package} title="No categories found on the server." />
                    </div>
                  ) : (
                    <div className="overflow-x-auto font-sans">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="bg-brand-light-gray border-b border-brand-border text-brand-muted-text uppercase tracking-wider font-extrabold text-xs">
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
                        <tbody className="divide-y divide-brand-border font-sans">
                          {adminCategories.map((cat) => (
                            <tr key={cat.id} className="hover:bg-brand-beige/50 transition">
                              <td className="py-3 px-4 font-mono font-bold text-brand-dark-text">{cat.id}</td>
                              <td className="py-3 px-4">
                                <div className="flex items-center flex-wrap gap-1.5">
                                  <p className="font-extrabold text-brand-dark-text">{cat.name_en}</p>
                                  {cat.is_admin_modified && (
                                    <Badge variant="warning">Customized</Badge>
                                  )}
                                </div>
                                <p className="text-brand-muted-text text-xs">{cat.name_sw}</p>
                              </td>
                              <td className="py-3 px-4 text-right font-bold text-brand-dark-text">KES {cat.total_fee}</td>
                              <td className="py-3 px-4 text-right text-brand-muted-text">KES {cat.finder_share}</td>
                              <td className="py-3 px-4 text-right text-brand-muted-text">KES {cat.agent_share}</td>
                              <td className="py-3 px-4 text-right text-brand-muted-text">KES {cat.platform_share}</td>
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
                                  <Button
                                    variant="danger"
                                    size="sm"
                                    disabled={cat.item_count > 0}
                                    onClick={() => handleDeleteCategory(cat.id, cat.name_en)}
                                    title={cat.item_count > 0 ? `Cannot delete category because ${cat.item_count} item(s) are currently categorized under it.` : 'Delete Category'}
                                  >
                                    Delete / Futa
                                  </Button>
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
                <p className="text-xs text-brand-muted-text max-w-2xl">
                  Manage users who failed to pay within the 15-minute viewing verification window.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  loading={paymentStrikesLoading}
                  onClick={fetchPaymentStrikes}
                  className="shrink-0"
                >
                  {!paymentStrikesLoading && <RefreshCw size={14} aria-hidden="true" />}
                  <span>Reload list</span>
                </Button>
              </div>

              <div className="bg-white border border-brand-border rounded-2xl overflow-hidden shadow-sm">
                {paymentStrikesLoading ? (
                  <div className="flex flex-col items-center justify-center py-12 space-y-2">
                    <Loader2 className="animate-spin text-primary-green w-6 h-6" aria-hidden="true" />
                    <p className="text-brand-muted-text text-xs font-bold uppercase tracking-wider">Loading strikes...</p>
                  </div>
                ) : paymentStrikes.length === 0 ? (
                  <div className="p-4">
                    <EmptyState icon={ShieldCheck} title="No active payment strikes recorded on the platform." />
                  </div>
                ) : (
                  <div className="overflow-x-auto font-sans">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-brand-light-gray border-b border-brand-border text-brand-muted-text uppercase tracking-wider font-extrabold text-xs">
                          <th className="py-3.5 px-4 font-bold">User Phone Number</th>
                          <th className="py-3.5 px-4 text-center font-bold">Active Strikes Count</th>
                          <th className="py-3.5 px-4 text-center font-bold">Status Limit</th>
                          <th className="py-3.5 px-4 text-center font-bold">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-brand-border font-sans">
                        {paymentStrikes.map((strike) => (
                          <tr key={strike.phone} className="hover:bg-brand-beige/50 transition">
                            <td className="py-3.5 px-4 font-mono font-bold text-brand-dark-text">{strike.phone}</td>
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

      {/* Custom Confirmation Modal */}
      {confirmModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-stone-900/60 fade-in">
          <div className="bg-white border border-stone-200 rounded-xl p-6 shadow-sm max-w-sm w-full space-y-4 fade-in">
            <div className="flex items-start space-x-3 text-amber-600">
              <ShieldAlert className="w-6 h-6 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <h3 className="font-extrabold text-sm text-stone-900 uppercase tracking-wider">
                  {confirmModal.title}
                </h3>
                <p className="text-stone-500 text-xs leading-relaxed font-semibold">
                  {confirmModal.message}
                </p>
              </div>
            </div>
            <div className="flex justify-end space-x-2 pt-2">
              <button
                onClick={() => setConfirmModal(null)}
                className="bg-stone-100 hover:bg-stone-200 text-stone-600 text-xs font-bold px-4 py-2 rounded-xl transition"
              >
                {lang === 'en' ? 'Cancel' : 'Ghairi'}
              </button>
              <button
                onClick={() => {
                  confirmModal.onConfirm();
                  setConfirmModal(null);
                }}
                className="bg-primary-green hover:bg-primary-hover text-white text-xs font-bold px-4 py-2 rounded-xl transition"
              >
                {lang === 'en' ? 'Confirm' : 'Thibitisha'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Lightbox Image Zoom Portal */}
      {lightboxImage && (
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
            }
          }}
        >
          <div className="relative max-w-4xl max-h-[90vh] w-full h-full flex flex-col items-center justify-center">
            <img
              src={lightboxImage}
              alt="Zoomed Photograph"
              className="max-w-full max-h-[80vh] object-contain rounded-2xl"
              referrerPolicy="no-referrer"
            />
            <p className="text-stone-400 text-xs mt-4 font-bold bg-stone-900 px-4 py-2 rounded-full uppercase tracking-wider">
              Click anywhere, or press Escape, to close full screen view
            </p>
          </div>
        </div>
      )}

    </div>
  );
}
