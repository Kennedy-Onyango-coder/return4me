import React, { useCallback, useEffect, useState } from 'react';
// UX-08: ArrowRight left this import list with the Overview's section-link
// cards, which were a second copy of the navigation already beside them.
import { Link2, Unlink, RefreshCw, LayoutDashboard, FileSearch, MapPin, Store, CalendarDays, Clock, Bell, type LucideIcon } from 'lucide-react';
import { Badge, Button, EmptyState, Input, OTPInput, Banner, StatCard, Skeleton, ICON_SIZE } from './ui';
import { getClaimStatusDisplay } from './claimStatus';
import { getVerificationFields } from '../config/verificationProfiles';
import { verificationTranslation } from '../config/verificationTranslations';
// Phase 9C: the customer's lost-report experience (report, list, matches).
import LostReportsSection from './customer/LostReportsSection';
// BATCH 1: the customer notification user layer (active list, History, read
// state, preferences). Reads only the customer-facing API - it never imports the
// delivery ledger, so no provider or retry concept can reach this view.
import NotificationCentre from './customer/NotificationCentre';

interface Props {
  lang: 'en' | 'sw';
  customer: { id: string; full_name: string; phone: string; status: string };
  onSignOut: () => void;
  signingOut?: boolean;
  /**
   * Phase 9C: opens the public /item/:id page, which is where the existing
   * "It's Mine" ownership journey begins. Required (not optional) so a future
   * caller cannot silently render a match card whose CTA does nothing.
   */
  onOpenItem: (itemId: string) => void;
  /**
   * Phase 9C: an authenticated read was rejected with 401. The account surface
   * uses this to fall back to the sign-in card — no private data is shown in
   * the meantime.
   */
  onSessionExpired: () => void;
}

// +254712345678 -> 0712 *** 678. The dashboard shows the account's own number,
// masked in the UI by default — the full number is never needed on screen and
// masking keeps it out of screenshots and shoulder-surfing range.
function maskPhone(phone: string): string {
  const m = /^\+254(\d{9})$/.exec(phone || '');
  if (!m) return phone || '';
  const d = m[1];
  return '0' + d.slice(0, 3) + ' *** ' + d.slice(6);
}

function formatDate(value: string | null | undefined, lang: 'en' | 'sw'): string {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(lang === 'sw' ? 'sw-KE' : 'en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// The payment window is only 15 minutes, so a date alone would be useless for
// it — show the actual deadline time.
function formatDateTime(value: string | null | undefined, lang: 'en' | 'sw'): string {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString(lang === 'sw' ? 'sw-KE' : 'en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

// PHASE 15 BATCH 1: the private dashboard's information architecture. Each entry
// is the navigation label, the section's single page-level heading and its
// description. This is copy only - no request, permission or business rule is
// attached to a section, and the public owner journey on /lost is a different
// surface that this table never touches.
interface AccountSectionCopy {
  label: string;
  title: string;
  description: string;
  /**
   * One-line purpose. UX-08: the Overview reads the section it is sending the
   * customer to next and shows that section's hint as the supporting line
   * under its single next-step action; a section's own page heading keeps
   * using `description`.
   */
  hint?: string;
}

type AccountSectionKey = 'overview' | 'lost' | 'claims' | 'notifications';

// BATCH 1: 'notifications' joins the existing three. It is ordered last because
// it is a passive surface - the customer comes to it deliberately, whereas the
// others carry work in progress.
const ACCOUNT_SECTION_ORDER: AccountSectionKey[] = ['overview', 'lost', 'claims', 'notifications'];

const ACCOUNT_SECTIONS: Record<AccountSectionKey, { icon: LucideIcon; en: AccountSectionCopy; sw: AccountSectionCopy }> = {
  // BATCH 1 - the customer notification user layer. The wording stays in plain
  // service language and names no transport, provider or internal concept.
  notifications: {
    icon: Bell,
    en: {
      label: 'Notifications',
      title: 'Notifications',
      description: 'Updates about your claims, payments and reports, and a record of everything we have told you before.',
      hint: 'See updates and your notification history.',
    },
    sw: {
      label: 'Taarifa',
      title: 'Taarifa',
      description: 'Taarifa kuhusu claims, malipo na ripoti zako, pamoja na kumbukumbu ya taarifa zote ulizopokea awali.',
      hint: 'Tazama taarifa na historia yako.',
    },
  },
  overview: {
    icon: LayoutDashboard,
    en: {
      label: 'Overview',
      title: 'Overview',
      description: 'Where your lost reports and claims stand, and the one next step to take.',
    },
    sw: {
      label: 'Muhtasari',
      title: 'Muhtasari',
      description: 'Hali ya ripoti zako na claims zako, na hatua moja inayofuata ya kuchukua.',
    },
  },
  lost: {
    icon: FileSearch,
    en: {
      label: 'My Lost Reports',
      title: 'My Lost Reports',
      description: 'Reports you have filed with Return4me. Anything that looks similar is shown as a possible match, never as a confirmation.',
      hint: 'File a report and check for possible matches.',
    },
    sw: {
      label: 'Ripoti Zangu',
      title: 'Ripoti zangu za vitu vilivyopotea',
      description: 'Ripoti ulizowasilisha kwa Return4me. Kitu chochote kinachofanana huonyeshwa kama mechi inayowezekana, sio uthibitisho.',
      hint: 'Wasilisha ripoti na uangalie mechi zinazowezekana.',
    },
  },
  claims: {
    icon: Link2,
    en: {
      label: 'My Claims',
      title: 'My Claims',
      description: 'Claims linked to this account, and the verification you must pass before a claim is added.',
      hint: 'See the claims linked to this account.',
    },
    sw: {
      label: 'Claims Zangu',
      title: 'Claims Zangu',
      description: 'Claims zilizounganishwa na akaunti hii, na uthibitisho unaohitajika kabla ya claim kuongezwa.',
      hint: 'Ona claims zilizounganishwa na akaunti hii.',
    },
  },
};

export default function CustomerDashboard({
  lang, customer, onSignOut, signingOut = false, onOpenItem, onSessionExpired,
}: Props) {
  const t = (en: string, sw: string) => (lang === 'sw' ? sw : en);

  // Which dashboard section is open. 'overview' is the default because it is
  // the first section of the dashboard's information architecture and the only
  // place the account's own identity summary is now shown. Every other section
  // is one labelled click away and no section's content or handlers changed.
  // PHASE 15 BATCH 1: this stays local state on purpose - the sections are not
  // routes, so no router and no new URL was introduced for them.
  const [tab, setTab] = useState<AccountSectionKey>('overview');

  const [claims, setClaims] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Linking flow state.
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkStep, setLinkStep] = useState<'claimId' | 'code'>('claimId');
  const [linkClaimId, setLinkClaimId] = useState('');
  const [linkCategory, setLinkCategory] = useState<string>('other-item');
  const [linkCode, setLinkCode] = useState('');
  const [linkAnswers, setLinkAnswers] = useState<Record<string, string>>({});
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const loadClaims = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/customer/claims', { credentials: 'same-origin' });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setClaims(Array.isArray(data.claims) ? data.claims : []);
      setLoadError(null);
    } catch {
      setLoadError(t('Could not load your claims. Please try again.', 'Imeshindwa kupata claims zako. Tafadhali jaribu tena.'));
    } finally {
      setLoading(false);
    }
  }, [lang]);

  useEffect(() => { loadClaims(); }, [loadClaims]);

  const resetLink = () => {
    setLinkStep('claimId');
    setLinkClaimId('');
    setLinkCategory('other-item');
    setLinkCode('');
    setLinkAnswers({});
    setLinkError(null);
    setLinkNotice(null);
  };

  const requestLinkCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setLinkError(null);
    setLinkNotice(null);
    const claimId = linkClaimId.trim().toUpperCase();
    if (!claimId) {
      setLinkError(t('Enter the claim ID.', 'Weka msimbo wa claim.'));
      return;
    }
    setLinkBusy(true);
    try {
      const res = await fetch('/api/customer/claims/link/request-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ claimId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLinkError(data?.error || t('Could not start linking. Please try again.', 'Imeshindwa kuanza kuunganisha. Tafadhali jaribu tena.'));
        return;
      }
      if (data.alreadyLinked) {
        setLinkNotice(t('This claim is already linked to your account.', 'Claim hii tayari imeunganishwa na akaunti yako.'));
        setLinkStep('claimId');
        return;
      }
      setLinkCategory(data.categoryId || 'other-item');
      setLinkClaimId(claimId);
      setLinkCode('');
      setLinkAnswers({});
      setLinkStep('code');
      setLinkNotice(
        data.message ||
        t('A verification code has been sent by SMS.', 'Msimbo wa uthibitisho umetumwa kwa SMS.')
      );
    } catch {
      setLinkError(t('Network error. Please try again.', 'Hitilafu ya mtandao. Tafadhali jaribu tena.'));
    } finally {
      setLinkBusy(false);
    }
  };

  const submitLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setLinkError(null);
    if (!/^\d{4}$/.test(linkCode)) {
      setLinkError(t('Enter the 4-digit code from the SMS.', 'Weka msimbo wa tarakimu 4 kutoka kwa SMS.'));
      return;
    }
    const fields = getVerificationFields(linkCategory);
    for (const field of fields) {
      if (field.required && !(linkAnswers[field.key] || '').trim()) {
        setLinkError(t('Please answer every required question.', 'Tafadhali jibu maswali yote yanayohitajika.'));
        return;
      }
    }
    setLinkBusy(true);
    try {
      const res = await fetch('/api/customer/claims/link/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ claimId: linkClaimId, code: linkCode, securityAnswers: linkAnswers }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLinkError(data?.error || t('Could not link this claim. Please try again.', 'Imeshindwa kuunganisha claim hii. Tafadhali jaribu tena.'));
        return;
      }
      resetLink();
      setLinkOpen(false);
      await loadClaims();
    } catch {
      setLinkError(t('Network error. Please try again.', 'Hitilafu ya mtandao. Tafadhali jaribu tena.'));
    } finally {
      setLinkBusy(false);
    }
  };

  const unlink = async (claimId: string) => {
    setRowBusy(claimId);
    setLoadError(null);
    try {
      const res = await fetch('/api/customer/claims/' + encodeURIComponent(claimId) + '/link', {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!res.ok && res.status !== 404) {
        const data = await res.json().catch(() => ({}));
        setLoadError(data?.error || t('Could not remove this claim. Please try again.', 'Imeshindwa kuondoa claim hii. Tafadhali jaribu tena.'));
        return;
      }
      await loadClaims();
    } catch {
      setLoadError(t('Network error. Please try again.', 'Hitilafu ya mtandao. Tafadhali jaribu tena.'));
    } finally {
      setRowBusy(null);
    }
  };

  const activeClaims = (claims || []).filter((c: any) => c.is_active);
  const historyClaims = (claims || []).filter((c: any) => !c.is_active);
  const linkFields = getVerificationFields(linkCategory);

  // Copy for the active section (navigation label, page title, description).
  // Presentation only: it drives the navigation and the page heading, never
  // any request or handler.
  const sectionCopy = ACCOUNT_SECTIONS[tab][lang];

  // UX-08: the Overview's single next step. It is DERIVED from the claims this
  // component has already loaded - nothing is fetched to decide it - and all it
  // does is open the section that can move the account forward, through the
  // same setTab the navigation uses. No workflow, step or state is entered from
  // here, so the Overview stays a summary and each section keeps owning its own
  // steps.
  const hasWorkInProgress = activeClaims.length > 0;
  const nextSection: AccountSectionKey = hasWorkInProgress ? 'claims' : 'lost';
  const nextCopy = ACCOUNT_SECTIONS[nextSection][lang];
  const NextSectionIcon = ACCOUNT_SECTIONS[nextSection].icon;

  // Current state of an item that is already in progress, read through the
  // shared claim-status vocabulary so the Overview can never describe a status
  // differently from the claims list below it.
  const leadClaimStatus = activeClaims.length > 0
    ? getClaimStatusDisplay(activeClaims[0].status, lang)
    : null;

  const renderClaimCard = (claim: any) => {
    const disp = getClaimStatusDisplay(claim.status, lang);
    return (
      <li key={claim.id} className="rounded-standard border border-[var(--appearance-border)] p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1 space-y-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={disp.variant}>{disp.label}</Badge>
              <Badge variant="code">{claim.id}</Badge>
            </div>

            {claim.item && (
              <p className="text-body font-extrabold text-[var(--appearance-text-primary)] break-words">
                {claim.item.document_name_fuzzy || claim.item.category_id}
              </p>
            )}

            {/* The same fields as before, read as one metadata block instead of
                a stack of equal-weight paragraphs. Every value is unchanged. */}
            <dl className="space-y-1.5 text-small text-[var(--appearance-text-muted)]">
              {claim.item && claim.item.location_description && (
                <div className="flex items-start gap-2">
                  <dt className="sr-only">{t('Where it was recorded', 'Ilipowekwa kumbukumbu')}</dt>
                  <MapPin size={ICON_SIZE.metadata} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--appearance-accent)]" />
                  <dd className="leading-relaxed break-words">{claim.item.location_description}</dd>
                </div>
              )}
              {claim.agent && (
                <div className="flex items-start gap-2">
                  <dt className="sr-only">{t('Holding agent', 'Wakala anayeshikilia')}</dt>
                  <Store size={ICON_SIZE.metadata} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--appearance-accent)]" />
                  <dd className="leading-relaxed break-words">
                    {claim.agent.business_name}
                    {claim.agent.location_address ? ', ' + claim.agent.location_address : ''}
                  </dd>
                </div>
              )}
              <div className="flex items-start gap-2">
                <dt className="sr-only">{t('When it was claimed', 'Iliyoundwa lini')}</dt>
                <CalendarDays size={ICON_SIZE.metadata} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--appearance-accent)]" />
                <dd className="leading-relaxed">
                  {t('Claimed', 'Iliyoundwa')} {formatDate(claim.created_at, lang)}
                </dd>
              </div>
              {claim.expires_at && (
                <div className="flex items-start gap-2">
                  <dt className="sr-only">{t('Payment deadline', 'Tarehe ya mwisho ya kulipa')}</dt>
                  <Clock size={ICON_SIZE.metadata} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--appearance-warning)]" />
                  <dd className="leading-relaxed font-semibold text-[var(--appearance-warning)]">
                    {t('Pay before', 'Lipa kabla ya')} {formatDateTime(claim.expires_at, lang)}
                  </dd>
                </div>
              )}
            </dl>
          </div>

          <Button
            variant="ghost"
            size="md"
            onClick={() => unlink(claim.id)}
            loading={rowBusy === claim.id}
            aria-label={t('Remove from my account', 'Ondoa kwenye akaunti yangu')}
          >
            <Unlink size={ICON_SIZE.ui} aria-hidden="true" />
          </Button>
        </div>
      </li>
    );
  };

  return (
    <div className="w-full space-y-6">
      {/*
        PHASE 15 BATCH 1 - PRIVATE DASHBOARD WORKSPACE.
        The navigation below contains exactly the destinations this surface
        supports: Overview (the account itself), the lost-report experience that
        already lived here, the claims list that already lived here, and the
        notification layer added in Batch 1. Nothing was invented for the
        navigation, and no handler, service call, API path or piece of state
        changed - only where the existing content is rendered.

        Desktop (lg+): a persistent left navigation beside the active section,
        matching the layout language of the already-modernized admin console.
        Below lg: the same items stay a horizontally scrollable strip, so a
        phone never gets a cramped fixed sidebar and no drawer state has to be
        invented. The active item is marked by an accent bar, a tint AND weight
        (never by colour alone) and carries aria-current="page".

        UX-08 unchanged this structure. It moved the whole workspace onto the
        appearance tokens and the type/icon ladders, dropped the two local
        focus rings in favour of the single global focus language, and rewrote
        the Overview's middle band as "where your items stand / what to do
        next" (one primary entry point instead of a second copy of this
        navigation). No destination, handler, request or privacy rule moved.
      */}
      <div className="lg:grid lg:grid-cols-[236px_minmax(0,1fr)] lg:gap-8 lg:items-start">
        <nav
          className="flex items-stretch overflow-x-auto border-b border-[var(--appearance-border)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:sticky lg:top-6 lg:flex-col lg:items-stretch lg:gap-0.5 lg:overflow-visible lg:border-b-0 lg:border-r lg:border-[var(--appearance-border)] lg:pb-1 lg:pr-3"
          aria-label={t('Account sections', 'Sehemu za akaunti')}
        >
          {ACCOUNT_SECTION_ORDER.map((key) => {
            const copy = ACCOUNT_SECTIONS[key][lang];
            const Icon = ACCOUNT_SECTIONS[key].icon;
            const active = tab === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                aria-current={active ? 'page' : undefined}
                className={`flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap border-b-2 -mb-px px-3.5 text-caption font-bold transition-colors cursor-pointer sm:px-4 lg:w-full lg:mb-0 lg:justify-start lg:rounded-standard lg:border-b-0 lg:border-l-[3px] lg:px-3 lg:py-2.5 ${
                  active
                    ? 'border-[var(--appearance-primary)] bg-[var(--appearance-surface-muted)] text-[var(--appearance-primary)] font-extrabold lg:border-l-[var(--appearance-primary)]'
                    : 'border-transparent text-[var(--appearance-text-muted)] hover:bg-[var(--appearance-surface-muted)] hover:text-[var(--appearance-text-primary)] lg:border-l-transparent'
                }`}
              >
                <Icon size={ICON_SIZE.metadata} aria-hidden="true" className="shrink-0" />
                <span>{copy.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="min-w-0 space-y-5">
          {/* PAGE TITLE - the workspace's ONE page-level heading. It belongs to
              the active section, so every rendered section has exactly one, and
              the title/description come from the same table that drives the
              navigation. */}
          <div className="space-y-1 border-b border-[var(--appearance-border)] pb-3">
            <h1
              id="account-section-heading"
              className="text-subsection sm:text-section font-extrabold tracking-tight text-[var(--appearance-text-primary)]"
            >
              {sectionCopy.title}
            </h1>
            <p className="text-body text-[var(--appearance-text-muted)] leading-relaxed max-w-2xl">{sectionCopy.description}</p>
          </div>

          {/* OVERVIEW - the calm recovery workspace: who is signed in, where the
              account's items stand, and the ONE next step. Every value here is
              already in this component's state, so the Overview still makes no
              request of its own and the sections keep owning their own steps. */}
          {tab === 'overview' && (
            <section className="space-y-6" aria-labelledby="account-section-heading">
              {/* IDENTITY BAND - the same fields, the same masking and the same
                  single Sign out control this surface already had. The name is a
                  plain element, not a heading: the page title above owns that
                  role, so a rendered section never carries two of them. */}
              <div className="rounded-panel border border-[var(--appearance-border)] bg-[var(--appearance-surface)] p-5 sm:p-6">
                <p className="text-caption font-extrabold uppercase tracking-widest text-[var(--appearance-text-muted)]">
                  {t('Signed in as', 'Umeingia kama')}
                </p>
                <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-subsection font-extrabold text-[var(--appearance-text-primary)] break-words">{customer.full_name}</p>
                    <p className="mt-1 text-small text-[var(--appearance-text-muted)] tabular-nums">{maskPhone(customer.phone)}</p>
                    <div className="mt-2.5">
                      <Badge variant={customer.status === 'active' ? 'success' : 'danger'}>
                        {customer.status === 'active' ? t('Active', 'Hai') : customer.status}
                      </Badge>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onSignOut}
                    loading={signingOut}
                    className="self-start sm:self-auto shrink-0"
                  >
                    {t('Sign out', 'Toka')}
                  </Button>
                </div>
              </div>

              {/* WHERE YOUR ITEMS STAND - the account's current state, derived
                  from the claims this component has ALREADY loaded; no request
                  is made here. The lost-report collection is owned by
                  LostReportsSection and is loaded only when that section is
                  opened, so the Overview reports no count it does not have, and
                  never fetches one twice. */}
              <div className="space-y-3">
                <h2 className="text-heading font-extrabold text-[var(--appearance-text-primary)]">{t('Where your items stand', 'Hali ya vitu vyako')}</h2>
                <div className="grid gap-3 sm:gap-4 sm:grid-cols-2">
                  {claims === null ? (
                    loading ? (
                      <Skeleton shape="card" />
                    ) : (
                      <p className="text-small text-[var(--appearance-text-muted)] leading-relaxed max-w-xl">
                        {t(
                          'Your claims summary is unavailable right now. Open My Claims to try again.',
                          'Muhtasari wa claims zako haupatikani kwa sasa. Fungua Claims Zangu ili kujaribu tena.'
                        )}
                      </p>
                    )
                  ) : (
                    <StatCard
                      icon={Link2}
                      label={t('Claims linked', 'Claims zilizounganishwa')}
                      value={claims.length}
                      description={t(
                        `${activeClaims.length} active, ${historyClaims.length} past`,
                        `${activeClaims.length} zinazoendelea, ${historyClaims.length} za nyuma`
                      )}
                    />
                  )}
                </div>
                {/* The one line that answers "where is my item". It names the
                    state of an item already in progress using the SAME label and
                    tone the claims list uses, and it is rendered only when there
                    is such an item - it asserts nothing for an empty account. */}
                {leadClaimStatus && (
                  <p className="flex flex-wrap items-center gap-2 text-small text-[var(--appearance-text-secondary)]">
                    <span>{t('In progress now', 'Kinachoendelea sasa')}</span>
                    <Badge variant={leadClaimStatus.variant}>{leadClaimStatus.label}</Badge>
                  </p>
                )}
              </div>

              {/* WHAT TO DO NEXT - ONE primary entry point, and it is the same
                  local section switch the previous cards used: it opens the
                  section, and the section stays responsible for its own steps.
                  The destination follows the state above (something in progress
                  -> the claims list; nothing in progress -> file a report), so
                  the workspace always answers "what now" without asking the
                  customer to work out which section applies. The other
                  destinations stay one labelled click away in the navigation
                  beside this workspace. */}
              <div className="space-y-3">
                <h2 className="text-heading font-extrabold text-[var(--appearance-text-primary)]">{t('What to do next', 'Cha kufanya baadaye')}</h2>
                <div className="space-y-3 rounded-panel border border-[var(--appearance-border)] bg-[var(--appearance-surface)] p-4 sm:p-5">
                  <p className="max-w-2xl text-small leading-relaxed text-[var(--appearance-text-secondary)]">
                    {hasWorkInProgress
                      ? t(
                          'Something of yours is already with us. Open your claims to see where it stands and what we need from you.',
                          'Kitu chako kipo kwetu tayari. Fungua claims zako kuona hali yake kamili na kile tunachohitaji kutoka kwako.'
                        )
                      : t(
                          'Nothing of yours is in progress yet. File a lost report and we will watch the found-item records for anything that looks like it.',
                          'Hakuna kitu chako kinachoendelea bado. Wasilisha ripoti ya kitu kilichopotea na tutafuatilia kumbukumbu za vitu vilivyopatikana kwa chochote kinachofanana.'
                        )}
                  </p>
                  <Button variant="primary" size="md" onClick={() => setTab(nextSection)}>
                    <NextSectionIcon size={ICON_SIZE.ui} aria-hidden="true" />
                    {hasWorkInProgress
                      ? t('View my claims', 'Ona claims zangu')
                      : t('Report a lost item', 'Ripoti kitu kilichopotea')}
                  </Button>
                  {nextCopy.hint && (
                    <p className="text-caption leading-snug text-[var(--appearance-text-muted)]">{nextCopy.hint}</p>
                  )}
                </div>
              </div>
            </section>
          )}

          {/* MY LOST REPORTS - reporting, the report list, and possible matches.
              The section renders the SAME component with the SAME props; it only
              stops printing its own title, because the page title above is now
              the section's single heading. UX-08 changed only this wrapper's
              surface tokens. */}
          {tab === 'lost' && (
            <section
              className="rounded-panel border border-[var(--appearance-border)] bg-[var(--appearance-surface)] p-4 sm:p-6"
              aria-labelledby="account-section-heading"
            >
              <LostReportsSection
                lang={lang}
                onOpenItem={onOpenItem}
                onSessionExpired={onSessionExpired}
                hideHeading
              />
            </section>
          )}

          {/* BATCH 1 - NOTIFICATIONS. The section renders the SAME component with
              the SAME props; it only stops printing its own title, because the
              page title above is already the section's single heading. */}
          {tab === 'notifications' && (
            <section
              className="rounded-panel border border-[var(--appearance-border)] bg-[var(--appearance-surface)] p-4 sm:p-6"
              aria-labelledby="account-section-heading"
            >
              <NotificationCentre lang={lang} />
            </section>
          )}

      {/* My claims — UX-08: same section, same handlers and the same API calls;
          only the surface tokens, the type ladder and the icon sizes changed. */}
      {tab === 'claims' && (
      <section className="rounded-panel border border-[var(--appearance-border)] bg-[var(--appearance-surface)] p-4 sm:p-6" aria-labelledby="account-section-heading">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" size="md" onClick={loadClaims} aria-label={t('Refresh', 'Onyesha upya')}>
            <RefreshCw size={ICON_SIZE.ui} aria-hidden="true" />
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={() => { if (linkOpen) resetLink(); setLinkOpen(o => !o); }}
          >
            <Link2 size={ICON_SIZE.ui} aria-hidden="true" /> {t('Link a claim', 'Unganisha claim')}
          </Button>
        </div>

        {/* Link-a-claim panel. UX-08: the `mt-4 max-w-2xl border` container
            contract is unchanged — only its tokens moved onto the appearance
            surface and the type ladder. */}
        {linkOpen && (
          <div className="mt-4 max-w-2xl border border-[var(--appearance-border)] rounded-panel p-4 sm:p-5 bg-[var(--appearance-surface-muted)]">
            <h2 className="text-heading font-extrabold text-[var(--appearance-text-primary)]">
              {t('Link an existing claim', 'Unganisha claim iliyopo')}
            </h2>
            <p className="mt-1 text-small text-[var(--appearance-text-muted)] leading-relaxed">
              {t(
                'Enter an existing claim ID. To link it we will text a code to the phone number registered on that claim, and ask the ownership questions that were set when the claim was made.',
                'Weka msimbo wa claim uliyo nayo. Ili kuunganisha, tutatuma msimbo kwa nambari ya simu iliyosajiliwa kwenye claim hiyo, na kukuuliza maswali ya umiliki yaliyowekwa wakati claim iliundwa.'
              )}
            </p>

            {linkNotice && <div className="mt-3"><Banner kind="info">{linkNotice}</Banner></div>}
            {linkError && <div className="mt-3"><Banner kind="error">{linkError}</Banner></div>}

            {linkStep === 'claimId' ? (
              <form onSubmit={requestLinkCode} className="mt-3 space-y-3" noValidate>
                <Input
                  label={t('Claim ID', 'Msimbo wa claim')}
                  placeholder="CLM-123456"
                  value={linkClaimId}
                  onChange={(e) => setLinkClaimId(e.target.value)}
                  maxLength={50}
                  autoComplete="off"
                  className="font-mono"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="submit" variant="primary" size="md" loading={linkBusy}>
                    {t('Send code', 'Tuma msimbo')}
                  </Button>
                  <Button type="button" variant="ghost" size="md" onClick={() => { resetLink(); setLinkOpen(false); }}>
                    {t('Cancel', 'Ghairi')}
                  </Button>
                </div>
              </form>
            ) : (
              <form onSubmit={submitLink} className="mt-3 space-y-4" noValidate>
                <p className="text-small font-mono text-[var(--appearance-text-muted)] break-all">{linkClaimId}</p>

                <OTPInput
                  length={4}
                  value={linkCode}
                  onChange={setLinkCode}
                  disabled={linkBusy}
                  label={t('Verification code', 'Msimbo wa uthibitisho')}
                />

                {linkFields.map((field) => {
                  const label = verificationTranslation(lang, field.labelKey);
                  const placeholder = verificationTranslation(lang, field.placeholderKey);
                  const helpText = verificationTranslation(lang, field.helpTextKey);
                  return (
                    <Input
                      key={field.key}
                      label={label + (field.required ? ' *' : '')}
                      hint={helpText || undefined}
                      placeholder={placeholder || undefined}
                      value={linkAnswers[field.key] || ''}
                      onChange={(e) => setLinkAnswers((prev) => ({ ...prev, [field.key]: e.target.value }))}
                      maxLength={field.maxLength}
                      disabled={linkBusy}
                      type={field.type === 'textarea' ? 'text' : field.type}
                    />
                  );
                })}

                <div className="flex flex-wrap items-center gap-2">
                  <Button type="submit" variant="primary" size="md" loading={linkBusy}>
                    {t('Verify and link', 'Thibitisha na unganisha')}
                  </Button>
                  <Button type="button" variant="ghost" size="md" onClick={resetLink} disabled={linkBusy}>
                    {t('Back', 'Rudi')}
                  </Button>
                </div>
              </form>
            )}
          </div>
        )}

        {/* Claims list */}
        {loading ? (
          <div className="mt-4 space-y-3" aria-busy="true">
            <span className="sr-only">{t('Loading your claims', 'Inapakia claims zako')}</span>
            <Skeleton shape="card" className="w-full" />
            <Skeleton shape="card" className="w-full" />
          </div>
        ) : (claims === null || claims.length === 0) ? (
          <div className="mt-4">
            <EmptyState
              icon={Link2}
              title={t('No claims linked yet', 'Hakuna claim iliyounganishwa bado')}
              description={t(
                'Claims are linked one at a time, and only after you prove they are yours. Nothing is added automatically.',
                'Claims huunganishwa moja moja, na tu baada ya kuthibitisha kuwa ni zako. Hakuna kinachoongezwa kiotomatiki.'
              )}
              action={(
                <Button
                  variant="primary"
                  size="md"
                  onClick={() => { if (linkOpen) resetLink(); setLinkOpen(o => !o); }}
                >
                  <Link2 size={ICON_SIZE.ui} aria-hidden="true" /> {t('Link a claim', 'Unganisha claim')}
                </Button>
              )}
            />
          </div>
        ) : (
          <div className="mt-5 space-y-6">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 border-b border-[var(--appearance-border)] pb-2">
                <h2 className="text-heading font-extrabold text-[var(--appearance-text-primary)]">
                  {t('Active claims', 'Claims zinazoendelea')}
                </h2>
                <Badge variant="neutral">{activeClaims.length}</Badge>
              </div>
              {activeClaims.length === 0 ? (
                <p className="rounded-standard border border-[var(--appearance-border)] bg-[var(--appearance-surface-muted)] px-4 py-3 text-small text-[var(--appearance-text-muted)]">
                  {t('No active claims.', 'Hakuna claim inayoendelea.')}
                </p>
              ) : (
                <ul className="space-y-3">{activeClaims.map(renderClaimCard)}</ul>
              )}
            </div>
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 border-b border-[var(--appearance-border)] pb-2">
                <h2 className="text-heading font-extrabold text-[var(--appearance-text-primary)]">
                  {t('Claim history', 'Historia ya claims')}
                </h2>
                <Badge variant="neutral">{historyClaims.length}</Badge>
              </div>
              {historyClaims.length === 0 ? (
                <p className="rounded-standard border border-[var(--appearance-border)] bg-[var(--appearance-surface-muted)] px-4 py-3 text-small text-[var(--appearance-text-muted)]">
                  {t('No past claims yet.', 'Hakuna claim za nyuma bado.')}
                </p>
              ) : (
                <ul className="space-y-3">{historyClaims.map(renderClaimCard)}</ul>
              )}
            </div>
          </div>
        )}
      </section>
      )}
        </div>
      </div>
    </div>
  );
}
