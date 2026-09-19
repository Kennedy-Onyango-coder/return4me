import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Link2, Unlink, RefreshCw, LayoutDashboard, FileSearch, type LucideIcon } from 'lucide-react';
import { Badge, Button, EmptyState, Input, OTPInput, Banner } from './ui';
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
}

type AccountSectionKey = 'overview' | 'lost' | 'claims';

const ACCOUNT_SECTION_ORDER: AccountSectionKey[] = ['overview', 'lost', 'claims'];

const ACCOUNT_SECTIONS: Record<AccountSectionKey, { icon: LucideIcon; en: AccountSectionCopy; sw: AccountSectionCopy }> = {
  overview: {
    icon: LayoutDashboard,
    en: {
      label: 'Overview',
      title: 'Overview',
      description: 'Your account at a glance, and the fastest way into your lost reports and claims.',
    },
    sw: {
      label: 'Muhtasari',
      title: 'Muhtasari',
      description: 'Akaunti yako kwa muhtasari, na njia ya haraka kufikia ripoti na claims zako.',
    },
  },
  lost: {
    icon: FileSearch,
    en: {
      label: 'My Lost Reports',
      title: 'My Lost Reports',
      description: 'Reports you have filed with Return4me. Anything that looks similar is shown as a possible match, never as a confirmation.',
    },
    sw: {
      label: 'Ripoti Zangu',
      title: 'Ripoti zangu za vitu vilivyopotea',
      description: 'Ripoti ulizowasilisha kwa Return4me. Kitu chochote kinachofanana huonyeshwa kama mechi inayowezekana, sio uthibitisho.',
    },
  },
  claims: {
    icon: Link2,
    en: {
      label: 'My Claims',
      title: 'My Claims',
      description: 'Claims linked to this account, and the verification you must pass before a claim is added.',
    },
    sw: {
      label: 'Claims Zangu',
      title: 'Claims Zangu',
      description: 'Claims zilizounganishwa na akaunti hii, na uthibitisho unaohitajika kabla ya claim kuongezwa.',
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
      <li key={claim.id} className="border border-brand-border rounded-xl p-4 bg-white">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant={disp.variant}>{disp.label}</Badge>
              <span className="font-mono text-xs text-brand-muted-text break-all">{claim.id}</span>
            </div>
            {claim.item && (
              <p className="mt-2 text-sm font-semibold text-brand-dark-text break-words">
                {claim.item.document_name_fuzzy || claim.item.category_id}
              </p>
            )}
            {claim.item && claim.item.location_description && (
              <p className="mt-0.5 text-xs text-brand-muted-text break-words">{claim.item.location_description}</p>
            )}
            {claim.agent && (
              <p className="mt-1 text-xs text-brand-muted-text break-words">
                {claim.agent.business_name}
                {claim.agent.location_address ? ' · ' + claim.agent.location_address : ''}
              </p>
            )}
            <p className="mt-1.5 text-xs text-brand-muted-text">
              {t('Claimed', 'Iliyoundwa')} {formatDate(claim.created_at, lang)}
            </p>
            {claim.expires_at && (
              <p className="mt-0.5 text-xs font-semibold text-status-warning">
                {t('Pay before', 'Lipa kabla ya')} {formatDateTime(claim.expires_at, lang)}
              </p>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => unlink(claim.id)}
            loading={rowBusy === claim.id}
            aria-label={t('Remove from my account', 'Ondoa kwenye akaunti yangu')}
          >
            <Unlink size={14} />
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

          {/* OVERVIEW - the account's own identity and the way into the other
              two sections. It renders data this component already holds and
              makes no request of its own. */}
          {tab === 'overview' && (
            <section className="space-y-5" aria-labelledby="account-section-heading">
              {/* Identity summary - the same fields and the same Sign out
                  control this surface already rendered, not duplicated. The
                  name is a plain element, not a heading: the page title above
                  owns that role, so a section never renders two of them. */}
              <div className="bg-white border border-brand-border rounded-2xl p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-lg font-extrabold text-brand-dark-text break-words">{customer.full_name}</p>
                    <p className="mt-1 text-sm text-brand-muted-text">{maskPhone(customer.phone)}</p>
                    <div className="mt-2">
                      <Badge variant={customer.status === 'active' ? 'success' : 'danger'}>
                        {customer.status === 'active' ? t('Active', 'Hai') : customer.status}
                      </Badge>
                    </div>
                  </div>
                  <Button variant="outline" size="sm" onClick={onSignOut} loading={signingOut}>
                    {t('Sign out', 'Toka')}
                  </Button>
                </div>
              </div>

              <div className="bg-white border border-brand-border rounded-2xl p-5 space-y-4">
                <p className="text-sm text-brand-muted-text leading-relaxed max-w-2xl">
                  {t(
                    'Your lost reports and the claims linked to this account are managed in their own sections.',
                    'Ripoti zako za vitu vilivyopotea na claims zilizounganishwa na akaunti hii zinasimamiwa katika sehemu zake.'
                  )}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setTab('lost')}>
                    <FileSearch size={14} aria-hidden="true" />
                    {ACCOUNT_SECTIONS.lost[lang].label}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setTab('claims')}>
                    <Link2 size={14} aria-hidden="true" />
                    {ACCOUNT_SECTIONS.claims[lang].label}
                  </Button>
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
              className="bg-white border border-brand-border rounded-2xl p-5"
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
      <section className="bg-white border border-brand-border rounded-2xl p-5" aria-labelledby="account-section-heading">
        <div className="flex items-center justify-end gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={loadClaims} aria-label={t('Refresh', 'Onyesha upya')}>
              <RefreshCw size={14} />
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => { if (linkOpen) resetLink(); setLinkOpen(o => !o); }}
            >
              <Link2 size={14} /> {t('Link a claim', 'Unganisha claim')}
            </Button>
          </div>
        </div>

        {/* Link-a-claim panel */}
        {linkOpen && (
          <div className="mt-4 border border-brand-border rounded-xl p-4 bg-brand-light-gray/50">
            <p className="text-xs text-brand-muted-text leading-relaxed">
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
                <div className="flex items-center gap-2">
                  <Button type="submit" variant="primary" size="sm" loading={linkBusy}>
                    {t('Send code', 'Tuma msimbo')}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => { resetLink(); setLinkOpen(false); }}>
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

                <div className="flex items-center gap-2">
                  <Button type="submit" variant="primary" size="sm" loading={linkBusy}>
                    {t('Verify and link', 'Thibitisha na unganisha')}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={resetLink} disabled={linkBusy}>
                    {t('Back', 'Rudi')}
                  </Button>
                </div>
              </form>
            )}
          </div>
        )}

        {/* Claims list */}
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="animate-spin text-primary-green" size={22} />
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
            />
          </div>
        ) : (
          <div className="mt-4 space-y-5">
            <div>
              <h3 className="text-xs font-extrabold uppercase tracking-wider text-brand-muted-text">
                {t('Active', 'Zinazoendelea')}
              </h3>
              {activeClaims.length === 0 ? (
                <p className="mt-2 text-xs text-brand-muted-text">{t('No active claims.', 'Hakuna claim inayoendelea.')}</p>
              ) : (
                <ul className="mt-2 space-y-3">{activeClaims.map(renderClaimCard)}</ul>
              )}
            </div>
            <div>
              <h3 className="text-xs font-extrabold uppercase tracking-wider text-brand-muted-text">
                {t('History', 'Historia')}
              </h3>
              {historyClaims.length === 0 ? (
                <p className="mt-2 text-xs text-brand-muted-text">{t('No past claims yet.', 'Hakuna claim za nyuma bado.')}</p>
              ) : (
                <ul className="mt-2 space-y-3">{historyClaims.map(renderClaimCard)}</ul>
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
