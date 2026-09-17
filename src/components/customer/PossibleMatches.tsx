import React from 'react';
import {
  AlertCircle, Calendar, MapPin, Package, RefreshCw, Search, ShieldCheck,
} from 'lucide-react';
import { Badge, Banner, Button, EmptyState, Skeleton } from '../ui';
import {
  REPORT_NOT_ACTIVE_NOTICE,
  type LostReportMatchCandidate,
  type LostReportMatchResponse,
  type LostReportsApiErrorKind,
} from '../../services/lostReportsApi';
import { getMatchReasonText } from '../../config/lostReportPresentation';

// ===========================================================================
// POSSIBLE MATCHES PANEL (Phase 9C)
// ===========================================================================
// Renders the result of GET /api/lost-reports/:id/matches for ONE owned report.
//
// WHAT THIS COMPONENT DELIBERATELY IS
//   * presentational — the fetch/caching lives in LostReportsSection, so a
//     report's matches are loaded once and shared with the list card instead of
//     being requested again by its own panel;
//   * a CONSUMER of the Phase 9B DTO and nothing more. Every field it renders
//     is one of the ten fields that DTO defines. It never asks the server for
//     anything else — no item enrichment, no OCR, no agent lookup, no scoring.
//   * cautious in language. A candidate is presented as a possible match that
//     still requires the normal ownership verification. It never says an item
//     has been found or recovered.
//
// The explanatory sentence is the SERVER's own `disclosure[lang]` (Phase 9B's
// canonical copy) rather than a second, locally-authored paragraph, so the two
// can never contradict each other.

export interface MatchesLoadState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  data?: LostReportMatchResponse;
  /** Only the kind is surfaced: the copy is chosen per kind, never echoed raw. */
  errorKind?: LostReportsApiErrorKind;
}

interface Props {
  lang: 'en' | 'sw';
  /** Live category list (from /api/categories) for human-readable names. */
  categories: any[];
  state: MatchesLoadState;
  onReload: () => void;
  /** Enters the EXISTING claim journey: navigates to the public /item/:id page. */
  onOpenItem: (itemId: string) => void;
  /** Session rejected (401) — hand back to the account surface. */
  onSessionExpired: () => void;
}

function formatFoundDate(value: string | null, lang: 'en' | 'sw'): string {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(lang === 'sw' ? 'sw-KE' : 'en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

/** Category name from the live list; falls back to the raw id so a card is never blank. */
export function categoryLabel(categories: any[], categoryId: string, lang: 'en' | 'sw'): string {
  const match = (categories || []).find((c: any) => c && c.id === categoryId);
  if (!match) return categoryId || '';
  return (lang === 'sw' ? match.name_sw : match.name_en) || match.name_en || categoryId;
}

/**
 * One candidate. Renders ONLY the Phase 9B public DTO fields, and offers ONE
 * action: open the existing public item page, which is where the existing
 * "It's Mine" ownership journey already begins. Nothing here creates a claim,
 * verifies ownership, or contacts anyone.
 */
function MatchCandidateCard({
  lang, candidate, categories, onOpenItem,
}: {
  lang: 'en' | 'sw';
  candidate: LostReportMatchCandidate;
  categories: any[];
  onOpenItem: (itemId: string) => void;
}) {
  const t = (en: string, sw: string) => (lang === 'sw' ? sw : en);
  const category = categoryLabel(categories, candidate.category_id, lang);
  const foundDate = formatFoundDate(candidate.found_at, lang);
  // Explanations the engine actually produced, in the order it produced them.
  // An unmapped key renders as nothing rather than as a raw token.
  const reasons = (candidate.match_reasons || [])
    .map((reason) => getMatchReasonText(reason, lang))
    .filter(Boolean);

  return (
    <li className="border border-brand-border rounded-2xl bg-white overflow-hidden">
      <div className="flex flex-col sm:flex-row">
        <div className="sm:w-40 shrink-0 bg-brand-light-gray/60 border-b sm:border-b-0 sm:border-r border-brand-border">
          {candidate.photo_url ? (
            <img
              src={candidate.photo_url}
              alt={`${candidate.document_name_fuzzy || category} — ${t(
                'photo from the found-item report',
                'picha kutoka ripoti ya kitu kilichopatikana'
              )}`}
              loading="lazy"
              decoding="async"
              className="w-full h-40 sm:h-full sm:min-h-[176px] object-cover"
            />
          ) : (
            <div className="h-24 sm:h-full sm:min-h-[176px] flex items-center justify-center p-4 text-center">
              <span className="text-xs font-bold text-brand-muted-text leading-snug">
                {candidate.document_name_fuzzy || category}
              </span>
            </div>
          )}
        </div>

        <div className="p-4 sm:p-5 space-y-3 min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="neutral">{category}</Badge>
            {candidate.is_sensitive_document && (
              <Badge variant="warning">{t('Sensitive document', 'Hati nyeti')}</Badge>
            )}
          </div>

          {candidate.document_name_fuzzy && (
            <p className="text-sm font-extrabold text-brand-dark-text break-words">
              {candidate.document_name_fuzzy}
            </p>
          )}

          <dl className="space-y-1.5 text-xs text-brand-muted-text">
            {candidate.location_description && (
              <div className="flex items-start gap-2">
                <dt className="sr-only">{t('Where it was recorded', 'Ilipowekwa kumbukumbu')}</dt>
                <MapPin size={13} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-orange" />
                <dd className="leading-relaxed break-words">{candidate.location_description}</dd>
              </div>
            )}
            {foundDate && (
              <div className="flex items-start gap-2">
                <dt className="sr-only">{t('When it was recorded', 'Ilipowekwa kumbukumbu lini')}</dt>
                <Calendar size={13} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-orange" />
                <dd className="leading-relaxed">{t('Recorded', 'Iliandikwa')} {foundDate}</dd>
              </div>
            )}
          </dl>

          {/* Present only when the server already considered it safe to publish
              (services/publicItemView.ts nulls it for sensitive documents). */}
          {candidate.description && (
            <p className="text-xs text-brand-dark-text leading-relaxed">{candidate.description}</p>
          )}

          {reasons.length > 0 && (
            <div>
              <p className="text-[11px] font-extrabold uppercase tracking-widest text-brand-muted-text">
                {t('Why this was suggested', 'Kwa nini imependekezwa')}
              </p>
              <ul className="mt-1.5 space-y-1">
                {reasons.map((reason) => (
                  <li key={reason} className="flex items-start gap-1.5 text-xs text-brand-muted-text leading-relaxed">
                    <span aria-hidden="true" className="mt-1 size-1.5 rounded-full bg-primary-green shrink-0" />
                    <span>{reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="pt-1">
            <Button
              variant="accent"
              size="md"
              className="w-full sm:w-auto"
              onClick={() => onOpenItem(candidate.id)}
            >
              {t('This may be mine', 'Hii inaweza kuwa yangu')}
            </Button>
            <p className="mt-2 text-caption text-brand-muted-text leading-relaxed">
              {t(
                'This does not confirm ownership. You will complete the normal ownership verification, and any handover happens in person through a Return4me agent.',
                'Hii haithibitishi umiliki. Utakamilisha uthibitisho wa kawaida wa umiliki, na ukabidhishaji hufanyika ana kwa ana kupitia wakala wa Return4me.'
              )}
            </p>
          </div>
        </div>
      </div>
    </li>
  );
}

/** Restrained, non-technical copy per failure kind. No limiter values, no internals. */
function errorCopy(kind: LostReportsApiErrorKind | undefined, lang: 'en' | 'sw') {
  const t = (en: string, sw: string) => (lang === 'sw' ? sw : en);
  switch (kind) {
    case 'auth':
      return {
        kind: 'warning' as const,
        text: t(
          'Your session has ended. Please sign in again to see possible matches.',
          'Kipindi chako kimeisha. Tafadhali ingia tena ili kuona mechi zinazowezekana.'
        ),
        retry: false,
      };
    case 'forbidden':
      return {
        kind: 'error' as const,
        text: t(
          'This account cannot view possible matches right now. Please contact support.',
          'Akaunti hii haiwezi kuona mechi zinazowezekana kwa sasa. Tafadhali wasiliana na usaidizi.'
        ),
        retry: false,
      };
    case 'not_found':
      // Malformed, unknown AND another customer's report all land here on
      // purpose — one generic sentence, so the UI never becomes an oracle.
      return {
        kind: 'error' as const,
        text: t(
          'We could not find that report on your account.',
          'Hatukuipata ripoti hiyo kwenye akaunti yako.'
        ),
        retry: false,
      };
    case 'rate_limited':
      return {
        kind: 'warning' as const,
        text: t(
          'Too many lookups just now. Please wait a few minutes, then try again.',
          'Umeangalia mara nyingi mno hivi karibuni. Tafadhali subiri dakika chache, kisha ujaribu tena.'
        ),
        retry: true,
      };
    default:
      return {
        kind: 'error' as const,
        text: t(
          'We could not load possible matches. Please try again.',
          'Imeshindwa kupata mechi zinazowezekana. Tafadhali jaribu tena.'
        ),
        retry: true,
      };
  }
}

/** Honest headline for a candidate list — never "we found your item". */
export function matchesHeadline(count: number, lang: 'en' | 'sw'): string {
  if (lang === 'sw') {
    return count === 1
      ? 'Mechi moja inayowezekana — haijathibitishwa kuwa yako'
      : `Mechi ${count} zinazowezekana — hazijathibitishwa kuwa zako`;
  }
  return count === 1
    ? 'One possible match — not confirmed as yours'
    : `${count} possible matches — not confirmed as yours`;
}

export default function PossibleMatches({
  lang, categories, state, onReload, onOpenItem, onSessionExpired,
}: Props) {
  const t = (en: string, sw: string) => (lang === 'sw' ? sw : en);

  if (state.status === 'loading') {
    return (
      <div className="space-y-3" aria-busy="true">
        <span className="sr-only">{t('Loading possible matches…', 'Inapakia mechi zinazowezekana…')}</span>
        <Skeleton shape="card" className="w-full" />
        <Skeleton shape="card" className="w-full" />
      </div>
    );
  }

  if (state.status === 'idle') {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" size="sm" onClick={onReload}>
          <Search size={14} />
          {t('Check for possible matches', 'Angalia mechi zinazowezekana')}
        </Button>
        <p className="text-xs text-brand-muted-text">
          {t('You have not checked this report yet.', 'Bado hujaangalia ripoti hii.')}
        </p>
      </div>
    );
  }

  if (state.status === 'error') {
    const copy = errorCopy(state.errorKind, lang);
    return (
      <div className="space-y-3">
        <Banner kind={copy.kind}>{copy.text}</Banner>
        <div className="flex flex-wrap gap-2">
          {copy.retry && (
            <Button variant="secondary" size="sm" onClick={onReload}>
              <RefreshCw size={14} />
              {t('Try again', 'Jaribu tena')}
            </Button>
          )}
          {state.errorKind === 'auth' && (
            <Button variant="secondary" size="sm" onClick={onSessionExpired}>
              {t('Sign in again', 'Ingia tena')}
            </Button>
          )}
        </div>
      </div>
    );
  }

  const data = state.data;
  if (!data) {
    // Defensive: a 'ready' state always carries data. Shown as a plain,
    // non-alarming message rather than crashing the section.
    return <Banner kind="info">{errorCopy(undefined, lang).text}</Banner>;
  }

  // The report is closed: the server returned no candidates and told us why.
  // Presented honestly — never as a fresh search.
  if (data.notice === REPORT_NOT_ACTIVE_NOTICE) {
    return (
      <Banner kind="info">
        {t(
          'Matching is no longer active for this report, so it is not being compared with found items any more.',
          'Ulinganishaji haufanyi kazi tena kwa ripoti hii, kwa hivyo hailinganishwi tena na vitu vilivyopatikana.'
        )}
      </Banner>
    );
  }

  const matches = data.matches || [];

  if (matches.length === 0) {
    return (
      <div className="space-y-3">
        <EmptyState
          icon={Search}
          title={t('No possible matches yet', 'Hakuna mechi zinazowezekana bado')}
          description={t(
            'We will keep using the information in this report to identify potential matches as eligible found items enter the system.',
            'Tutaendelea kutumia taarifa zilizo kwenye ripoti hii kutambua mechi zinazowezekana kadri vitu vilivyopatikana vinavyoingia kwenye mfumo.'
          )}
        />
        <div>
          <Button variant="ghost" size="sm" onClick={onReload}>
            <RefreshCw size={14} />
            {t('Check again', 'Angalia tena')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Phase 9B's own canonical disclosure, served by the API — not a second
          locally-authored paragraph that could drift out of step with it. */}
      <Banner kind="info">
        <p className="font-bold">{matchesHeadline(matches.length, lang)}</p>
        <p className="mt-1 font-normal leading-relaxed">
          {lang === 'sw' ? data.disclosure.sw : data.disclosure.en}
        </p>
      </Banner>

      <ul className="space-y-4">
        {matches.map((candidate) => (
          <MatchCandidateCard
            key={candidate.id}
            lang={lang}
            candidate={candidate}
            categories={categories}
            onOpenItem={onOpenItem}
          />
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onReload}>
          <RefreshCw size={14} />
          {t('Check again', 'Angalia tena')}
        </Button>
        <p className="text-caption text-brand-muted-text flex items-center gap-1.5">
          <ShieldCheck size={13} aria-hidden="true" className="shrink-0 text-primary-green" />
          {t(
            'Return4me never shares a finder’s contact details. Everything is arranged through the platform.',
            'Return4me haitoi mawasiliano ya aliyekipata. Kila kitu hupangwa kupitia jukwaa.'
          )}
        </p>
      </div>
    </div>
  );
}



