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
  /** Live category list (from /api/categories) for human-readable names. */
  categories: any[];
  state: MatchesLoadState;
  onReload: () => void;
  /** Enters the EXISTING claim journey: navigates to the public /item/:id page. */
  onOpenItem: (itemId: string) => void;
  /** Session rejected (401) — hand back to the account surface. */
  onSessionExpired: () => void;
}

function formatFoundDate(value: string | null): string {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

/** Category name from the live list; falls back to the raw id so a card is never blank. */
export function categoryLabel(categories: any[], categoryId: string): string {
  const match = (categories || []).find((c: any) => c && c.id === categoryId);
  if (!match) return categoryId || '';
  return (match.name_en) || match.name_en || categoryId;
}

/**
 * One candidate. Renders ONLY the Phase 9B public DTO fields, and offers ONE
 * action: open the existing public item page, which is where the existing
 * "It's Mine" ownership journey already begins. Nothing here creates a claim,
 * verifies ownership, or contacts anyone.
 */
function MatchCandidateCard({
  candidate, categories, onOpenItem,
}: {
  candidate: LostReportMatchCandidate;
  categories: any[];
  onOpenItem: (itemId: string) => void;
}) {

  const category = categoryLabel(categories, candidate.category_id);
  const foundDate = formatFoundDate(candidate.found_at);
  // Explanations the engine actually produced, in the order it produced them.
  // An unmapped key renders as nothing rather than as a raw token.
  const reasons = (candidate.match_reasons || [])
    .map((reason) => getMatchReasonText(reason))
    .filter(Boolean);

  return (
    <li className="border border-brand-border rounded-2xl bg-white overflow-hidden">
      <div className="flex flex-col sm:flex-row">
        <div className="sm:w-40 shrink-0 bg-brand-light-gray/60 border-b sm:border-b-0 sm:border-r border-brand-border">
          {candidate.photo_url ? (
            <img
              src={candidate.photo_url}
              alt={`${candidate.document_name_fuzzy || category} — ${'photo from the found-item report'}`}
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
              <Badge variant="warning">{'Sensitive document'}</Badge>
            )}
          </div>

          {candidate.document_name_fuzzy && (
            <p className="text-sm font-extrabold text-brand-dark-text break-words">
              {candidate.document_name_fuzzy}
            </p>
          )}

          <dl className="space-y-1.5 text-xs text-brand-muted-text">
            {/* PHASE 16.1 (GEO-16-03): the canonical county of the candidate,
                taken from the same public DTO. It helps the customer see WHY a
                candidate is plausible without revealing anything finer. */}
            {candidate.found_county && (
              <div className="flex items-start gap-2">
                <dt className="sr-only">{'County'}</dt>
                <MapPin size={13} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-orange" />
                <dd className="leading-relaxed break-words">
                  {'County'}: {candidate.found_county}
                </dd>
              </div>
            )}
            {candidate.location_description && (
              <div className="flex items-start gap-2">
                <dt className="sr-only">{'Where it was recorded'}</dt>
                <MapPin size={13} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-orange" />
                <dd className="leading-relaxed break-words">{candidate.location_description}</dd>
              </div>
            )}
            {foundDate && (
              <div className="flex items-start gap-2">
                <dt className="sr-only">{'When it was recorded'}</dt>
                <Calendar size={13} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-orange" />
                <dd className="leading-relaxed">{'Recorded'} {foundDate}</dd>
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
              <p className="text-caption font-extrabold uppercase tracking-widest text-brand-muted-text">
                {'Why this was suggested'}
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
              {'This may be mine'}
            </Button>
            <p className="mt-2 text-caption text-brand-muted-text leading-relaxed">
              {'This does not confirm ownership. You will complete the normal ownership verification, and any handover happens in person through a Return4me agent.'}
            </p>
          </div>
        </div>
      </div>
    </li>
  );
}

/** Restrained, non-technical copy per failure kind. No limiter values, no internals. */
function errorCopy(kind: LostReportsApiErrorKind | undefined) {

  switch (kind) {
    case 'auth':
      return {
        kind: 'warning' as const,
        text: 'Your session has ended. Please sign in again to see possible matches.',
        retry: false,
      };
    case 'forbidden':
      return {
        kind: 'error' as const,
        text: 'This account cannot view possible matches right now. Please contact support.',
        retry: false,
      };
    case 'not_found':
      // Malformed, unknown AND another customer's report all land here on
      // purpose — one generic sentence, so the UI never becomes an oracle.
      return {
        kind: 'error' as const,
        text: 'We could not find that report on your account.',
        retry: false,
      };
    case 'rate_limited':
      return {
        kind: 'warning' as const,
        text: 'Too many lookups just now. Please wait a few minutes, then try again.',
        retry: true,
      };
    default:
      return {
        kind: 'error' as const,
        text: 'We could not load possible matches. Please try again.',
        retry: true,
      };
  }
}

/** Honest headline for a candidate list — never "we found your item". */
export function matchesHeadline(count: number): string {
  return count === 1
    ? 'One possible match — not confirmed as yours'
    : `${count} possible matches — not confirmed as yours`;
}

export default function PossibleMatches({
  categories, state, onReload, onOpenItem, onSessionExpired,
}: Props) {


  if (state.status === 'loading') {
    return (
      <div className="space-y-3" aria-busy="true">
        <span className="sr-only">{'Loading possible matches…'}</span>
        <Skeleton shape="card" className="w-full" />
        <Skeleton shape="card" className="w-full" />
      </div>
    );
  }

  if (state.status === 'idle') {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" size="md" onClick={onReload}>
          <Search size={16} />
          {'Check for possible matches'}
        </Button>
        <p className="text-xs text-brand-muted-text">
          {'You have not checked this report yet.'}
        </p>
      </div>
    );
  }

  if (state.status === 'error') {
    const copy = errorCopy(state.errorKind);
    return (
      <div className="space-y-3">
        <Banner kind={copy.kind}>{copy.text}</Banner>
        <div className="flex flex-wrap gap-2">
          {copy.retry && (
            <Button variant="secondary" size="md" onClick={onReload}>
              <RefreshCw size={16} />
              {'Try again'}
            </Button>
          )}
          {state.errorKind === 'auth' && (
            <Button variant="secondary" size="md" onClick={onSessionExpired}>
              {'Sign in again'}
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
    return <Banner kind="info">{errorCopy(undefined).text}</Banner>;
  }

  // The report is closed: the server returned no candidates and told us why.
  // Presented honestly — never as a fresh search.
  if (data.notice === REPORT_NOT_ACTIVE_NOTICE) {
    return (
      <Banner kind="info">
        {'Matching is no longer active for this report, so it is not being compared with found items any more.'}
      </Banner>
    );
  }

  const matches = data.matches || [];

  if (matches.length === 0) {
    return (
      <div className="space-y-3">
        <EmptyState
          icon={Search}
          title={'No possible matches yet'}
          description={'We will keep using the information in this report to identify potential matches as eligible found items enter the system.'}
        />
        <div>
          <Button variant="ghost" size="md" onClick={onReload}>
            <RefreshCw size={16} />
            {'Check again'}
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
        <p className="font-bold">{matchesHeadline(matches.length)}</p>
        <p className="mt-1 font-normal leading-relaxed">
          {data.disclosure.en}
        </p>
      </Banner>

      <ul className="space-y-4">
        {matches.map((candidate) => (
          <MatchCandidateCard
            key={candidate.id}
            candidate={candidate}
            categories={categories}
            onOpenItem={onOpenItem}
          />
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="md" onClick={onReload}>
          <RefreshCw size={16} />
          {'Check again'}
        </Button>
        <p className="text-caption text-brand-muted-text flex items-center gap-1.5">
          <ShieldCheck size={13} aria-hidden="true" className="shrink-0 text-primary-green" />
          {'Return4me never shares a finder’s contact details. Everything is arranged through the platform.'}
        </p>
      </div>
    </div>
  );
}



