import React, { useCallback, useEffect, useState } from 'react';
import { Link2, Unlink, RefreshCw, LayoutDashboard, FileSearch, ArrowRight, MapPin, Store, CalendarDays, Clock, type LucideIcon } from 'lucide-react';
import { Badge, Button, EmptyState, Input, OTPInput, Banner, StatCard, Skeleton } from './ui';
import { getClaimStatusDisplay } from './claimStatus';
import { getVerificationFields } from '../config/verificationProfiles';
import { verificationTranslation } from '../config/verificationTranslations';
// Phase 9C: the customer's lost-report experience (report, list, matches).
import LostReportsSection from './customer/LostReportsSection';

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
   * Optional one-line purpose, used only by the section cards on the Overview.
   * The section's own page heading keeps using `description`.
   */
  hint?: string;
}

type AccountSectionKey = 'overview' | 'lost' | 'claims';

const ACCOUNT_SECTION_ORDER: AccountSectionKey[] = ['overview', 'lost', 'claims'];

const ACCOUNT_SECTIONS: Record<AccountSectionKey, { icon: LucideIcon; en: AccountSectionCopy; sw: AccountSectionCopy }> = {
  overview: {
    icon: LayoutDashboard,
    en: {
      label: 'Overview',
      title: 'Overview',
      description: 'Keep track of your lost reports and the claims linked to this account, all in one place.',
    },
    sw: {
      label: 'Muhtasari',
      title: 'Muhtasari',
      description: 'Fuatilia ripoti zako za vitu vilivyopotea na claims zilizounganishwa na akaunti hii, mahali pamoja.',
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

  const renderClaimCard = (claim: any) => {
    const disp = getClaimStatusDisplay(claim.status, lang);
    return (
            <li key={claim.id} className="bg-white border border-brand-border rounded-2xl p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1 space-y-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={disp.variant}>{disp.label}</Badge>
              <Badge variant="code">{claim.id}</Badge>
            </div>

            {claim.item && (
              <p className="text-sm font-extrabold text-brand-dark-text break-words">
                {claim.item.document_name_fuzzy || claim.item.category_id}
              </p>
            )}

            {/* The same fields as before, read as one metadata block instead of
                a stack of equal-weight paragraphs. Every value is unchanged. */}
            <dl className="space-y-1.5 text-xs text-brand-muted-text">
              {claim.item && claim.item.location_description && (
                <div className="flex items-start gap-2">
                  <dt className="sr-only">{t('Where it was recorded', 'Ilipowekwa kumbukumbu')}</dt>
                  <MapPin size={13} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-orange" />
                  <dd className="leading-relaxed break-words">{claim.item.location_description}</dd>
                </div>
              )}
              {claim.agent && (
                <div className="flex items-start gap-2">
                  <dt className="sr-only">{t('Holding agent', 'Wakala anayeshikilia')}</dt>
                  <Store size={13} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-orange" />
                  <dd className="leading-relaxed break-words">
                    {claim.agent.business_name}
                    {claim.agent.location_address ? ', ' + claim.agent.location_address : ''}
                  </dd>
                </div>
              )}
              <div className="flex items-start gap-2">
                <dt className="sr-only">{t('When it was claimed', 'Iliyoundwa lini')}</dt>
                <CalendarDays size={13} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-orange" />
                <dd className="leading-relaxed">
                  {t('Claimed', 'Iliyoundwa')} {formatDate(claim.created_at, lang)}
                </dd>
              </div>
              {claim.expires_at && (
                <div className="flex items-start gap-2">
                  <dt className="sr-only">{t('Payment deadline', 'Tarehe ya mwisho ya kulipa')}</dt>
                  <Clock size={13} aria-hidden="true" className="mt-0.5 shrink-0 text-status-warning" />
                  <dd className="leading-relaxed font-semibold text-status-warning">
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
            <Unlink size={16} />
          </Button>
        </div>
      </li>
    );
  };

  return (
    <div className="w-full max-w-5xl mx-auto space-y-6">
      {/*
        PHASE 15 BATCH 1 - PRIVATE DASHBOARD WORKSPACE.
        The navigation below contains exactly the three destinations this surface
        supports: Overview (the account itself), the lost-report experience that
        already lived here, and the claims list that already lived here. Nothing
        was invented for the navigation, and no handler, service call, API path
        or piece of state changed - only where the existing content is rendered.

        Desktop (lg+): a persistent left navigation beside the active section,
        matching the layout language of the already-modernized admin console.
        Below lg: the same items stay a horizontally scrollable strip, so a
        phone never gets a cramped fixed sidebar and no drawer state has to be
        invented. The active item is marked by an accent bar, a tint AND weight
        (never by colour alone) and carries aria-current="page".
      */}
      <div className="lg:grid lg:grid-cols-[236px_minmax(0,1fr)] lg:gap-8 lg:items-start">
        <nav
          className="flex items-stretch overflow-x-auto border-b border-line-subtle [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:sticky lg:top-6 lg:flex-col lg:items-stretch lg:gap-0.5 lg:overflow-visible lg:border-b-0 lg:border-r lg:border-line-subtle lg:pb-1 lg:pr-3"
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
                className={`flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap border-b-2 -mb-px px-3.5 text-xs font-bold transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-orange/40 sm:px-4 lg:w-full lg:mb-0 lg:justify-start lg:rounded-lg lg:border-b-0 lg:border-l-[3px] lg:px-3 lg:py-2.5 ${
                  active
                    ? 'border-primary-green bg-primary-green/10 text-primary-green font-extrabold lg:border-l-primary-green'
                    : 'border-transparent text-brand-muted-text hover:bg-brand-light-gray hover:text-brand-dark-text lg:border-l-transparent'
                }`}
              >
                <Icon size={14} aria-hidden="true" className="shrink-0" />
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
          <div className="space-y-1 border-b border-brand-border pb-3">
            <h1
              id="account-section-heading"
              className="text-xl sm:text-2xl font-extrabold tracking-tight text-brand-dark-text"
            >
              {sectionCopy.title}
            </h1>
            <p className="text-sm text-brand-muted-text leading-relaxed max-w-2xl">{sectionCopy.description}</p>
          </div>

          {/* OVERVIEW - the account's own identity, a summary derived from data
              this component already holds, and the way into the other two
              sections. It makes no request of its own. */}
          {tab === 'overview' && (
            <section className="space-y-6" aria-labelledby="account-section-heading">
              {/* ACCOUNT BAND - the same fields, the same masking and the same
                  single Sign out control this surface already had, promoted to
                  a deliberate account summary. The name is a plain element, not
                  a heading: the page title above owns that role, so a rendered
                  section never carries two of them. */}
              <div className="bg-white border border-brand-border rounded-2xl p-5 sm:p-6">
                <h2 className="text-[11px] font-extrabold uppercase tracking-widest text-brand-muted-text">
                  {t('Your account', 'Akaunti yako')}
                </h2>
                <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-lg sm:text-xl font-extrabold text-brand-dark-text break-words">{customer.full_name}</p>
                    <p className="mt-1 text-sm text-brand-muted-text tabular-nums">{maskPhone(customer.phone)}</p>
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

              {/* ACTIVITY SUMMARY - derived from the claims this component has
                  ALREADY loaded; no request is made here. The lost-report
                  collection is owned by LostReportsSection and is loaded only
                  when that section is opened, so the Overview reports no count
                  it does not have, and never fetches one twice. */}
              <div className="space-y-3">
                <h2 className="text-base font-extrabold text-brand-dark-text">{t('Your activity', 'Shughuli zako')}</h2>
                <div className="grid gap-3 sm:gap-4 sm:grid-cols-2">
                  {claims === null ? (
                    loading ? (
                      <Skeleton shape="card" />
                    ) : (
                      <p className="text-xs text-brand-muted-text leading-relaxed max-w-xl">
                        {t(
                          'Your claims summary is unavailable right now. Open My Claims to try again.',
                          'Muhtasari wa claims zako haupatikani kwa sasa. Fungua Claims Zangu ili kujaribu tena.'
                        )}
                      </p>
                    )
                  ) : (
                    <StatCard
                      icon={Link2}
                      label={t('Claims', 'Claims')}
                      value={claims.length}
                      description={t(
                        `${activeClaims.length} active, ${historyClaims.length} past`,
                        `${activeClaims.length} zinazoendelea, ${historyClaims.length} za nyuma`
                      )}
                    />
                  )}
                </div>
              </div>

              {/* SECTION LINKS - the local section switch established in Batch 1.
                  No route and no shortcut into a workflow: each card opens the
                  section, and the section stays responsible for its own steps. */}
              <div className="space-y-3">
                <h2 className="text-base font-extrabold text-brand-dark-text">{t('Your sections', 'Sehemu zako')}</h2>
                <div className="grid gap-3 sm:gap-4 sm:grid-cols-2">
                  {(['lost', 'claims'] as const).map((key) => {
                    const copy = ACCOUNT_SECTIONS[key][lang];
                    const Icon = ACCOUNT_SECTIONS[key].icon;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setTab(key)}
                        className="group flex min-h-11 items-start gap-3 rounded-2xl border border-brand-border bg-white p-4 text-left transition-colors cursor-pointer hover:border-primary-green focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-orange/40"
                      >
                        <span
                          aria-hidden="true"
                          className="w-9 h-9 shrink-0 rounded-xl bg-primary-green/10 text-primary-green flex items-center justify-center"
                        >
                          <Icon size={17} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-extrabold text-brand-dark-text">{copy.label}</span>
                          {copy.hint && (
                            <span className="mt-1 block text-xs text-brand-muted-text leading-snug">{copy.hint}</span>
                          )}
                        </span>
                        <ArrowRight size={16} aria-hidden="true" className="shrink-0 self-center text-brand-muted-text group-hover:text-primary-green" />
                      </button>
                    );
                  })}
                </div>
              </div>
            </section>
          )}

          {/* MY LOST REPORTS - reporting, the report list, and possible matches.
              The section renders the SAME component with the SAME props; it only
              stops printing its own title, because the page title above is now
              the section's single heading. */}
          {tab === 'lost' && (
            <section
              className="bg-white border border-brand-border rounded-2xl p-4 sm:p-6"
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

      {/* My claims */}
      {tab === 'claims' && (
      <section className="bg-white border border-brand-border rounded-2xl p-4 sm:p-6" aria-labelledby="account-section-heading">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" size="md" onClick={loadClaims} aria-label={t('Refresh', 'Onyesha upya')}>
            <RefreshCw size={16} />
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={() => { if (linkOpen) resetLink(); setLinkOpen(o => !o); }}
          >
            <Link2 size={16} /> {t('Link a claim', 'Unganisha claim')}
          </Button>
        </div>

        {/* Link-a-claim panel */}
        {linkOpen && (
          <div className="mt-4 border border-brand-border rounded-2xl p-4 sm:p-5 bg-brand-light-gray/50">
            <h2 className="text-base font-extrabold text-brand-dark-text">
              {t('Link an existing claim', 'Unganisha claim iliyopo')}
            </h2>
            <p className="mt-1 text-xs text-brand-muted-text leading-relaxed">
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
                <p className="text-xs font-mono text-brand-muted-text break-all">{linkClaimId}</p>

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
                  <Link2 size={16} /> {t('Link a claim', 'Unganisha claim')}
                </Button>
              )}
            />
          </div>
        ) : (
          <div className="mt-5 space-y-6">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 border-b border-brand-border pb-2">
                <h2 className="text-base font-extrabold text-brand-dark-text">
                  {t('Active claims', 'Claims zinazoendelea')}
                </h2>
                <Badge variant="neutral">{activeClaims.length}</Badge>
              </div>
              {activeClaims.length === 0 ? (
                <p className="rounded-xl border border-brand-border bg-brand-light-gray/60 px-4 py-3 text-xs text-brand-muted-text">
                  {t('No active claims.', 'Hakuna claim inayoendelea.')}
                </p>
              ) : (
                <ul className="space-y-3">{activeClaims.map(renderClaimCard)}</ul>
              )}
            </div>
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 border-b border-brand-border pb-2">
                <h2 className="text-base font-extrabold text-brand-dark-text">
                  {t('Claim history', 'Historia ya claims')}
                </h2>
                <Badge variant="neutral">{historyClaims.length}</Badge>
              </div>
              {historyClaims.length === 0 ? (
                <p className="rounded-xl border border-brand-border bg-brand-light-gray/60 px-4 py-3 text-xs text-brand-muted-text">
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
