import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, MapPin, Plus, RefreshCw, Search } from 'lucide-react';
import { Badge, Banner, Button, EmptyState, Skeleton } from '../ui';
import PossibleMatches, { categoryLabel, type MatchesLoadState } from './PossibleMatches';
import LostReportWizard from './LostReportWizard';
import {
  fetchLostReportMatches,
  listMyLostReports,
  type LostReportView,
} from '../../services/lostReportsApi';
import {
  getLostReportStatusDisplay,
  isSearchingStatus,
} from '../../config/lostReportPresentation';

// ===========================================================================
// MY LOST REPORTS (Phase 9C)
// ===========================================================================
// The authenticated customer's lost-report section: the report list, the
// reporting wizard, and each report's possible matches.
//
// WHY THIS OWNS THE DATA
//   A report's matches are loaded ONCE here and shared with both the list card
//   (which reports whether candidates exist) and the matches panel (which
//   renders them) — so expanding a card never triggers a second request, and
//   re-rendering never triggers one at all.
//
// RATE-LIMIT AWARENESS
//   GET /api/lost-reports/:id/matches is rate-limited per customer by Phase 9B,
//   so the section does NOT fan out indefinitely: it pre-loads matches for at
//   most AUTO_LOAD_MATCH_LIMIT active reports and leaves the rest on an explicit
//   "Check for possible matches" action the customer controls.
//
// WHAT IT NEVER DOES
//   No match is computed here. Every candidate comes from the Phase 9B API; this
//   section performs no scoring, no comparison and no item enrichment.

interface Props {
  lang: 'en' | 'sw';
  /** Enters the existing claim journey (public /item/:id page). */
  onOpenItem: (itemId: string) => void;
  /** 401 from any read — hand back to the account surface. */
  onSessionExpired: () => void;
  /**
   * PHASE 11A — open the reporting wizard immediately instead of the report
   * list. Used by the public /report-lost entry point, where the visitor has
   * explicitly asked to REPORT something and should not have to find the button
   * a second time. Defaults to false, so the account dashboard's behaviour is
   * byte-for-byte unchanged. This adds no second form: it only changes which
   * view of the SAME section is shown first.
   */
  startInWizard?: boolean;
}

/**
 * How many ACTIVE reports have their matches pre-loaded on mount. Bounds the
 * per-customer match-lookup budget (Phase 9B allows 20/15 min in production)
 * while still answering "are there possible matches?" for the realistic case of
 * a customer with one or two open reports.
 */
export const AUTO_LOAD_MATCH_LIMIT = 3;

function formatDate(value: string | null, lang: 'en' | 'sw'): string {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(lang === 'sw' ? 'sw-KE' : 'en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

function formatWindow(from: string | null, to: string | null, lang: 'en' | 'sw'): string {
  const opts: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' };
  const fmt = (value: string | null) => {
    if (!value) return '';
    const d = new Date(value);
    return isNaN(d.getTime()) ? '' : d.toLocaleString(lang === 'sw' ? 'sw-KE' : 'en-GB', opts);
  };
  const a = fmt(from);
  const b = fmt(to);
  if (!a) return '';
  return b && b !== a ? `${a} — ${b}` : a;
}

/** One-line "what was lost" summary from the report's own fields. */
export function lostReportSummary(report: LostReportView): string {
  const attributes = [report.brand, report.model, report.colour, report.material]
    .filter((v): v is string => Boolean(v && v.trim()))
    .join(' · ');
  const parts = [attributes, report.description, report.distinctive_marks]
    .filter((v): v is string => Boolean(v && v.trim()));
  return parts.join(' — ');
}

export default function LostReportsSection({ lang, onOpenItem, onSessionExpired, startInWizard = false }: Props) {
  const sw = lang === 'sw';
  const t = (en: string, swText: string) => (sw ? swText : en);

  const [categories, setCategories] = useState<any[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(true);
  const [reports, setReports] = useState<LostReportView[] | null>(null);
  const [reportsLoading, setReportsLoading] = useState(true);
  const [reportsError, setReportsError] = useState<string | null>(null);
  const [matchesByReport, setMatchesByReport] = useState<Record<string, MatchesLoadState>>({});
  const [expandedReport, setExpandedReport] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(startInWizard);
  const [createdReference, setCreatedReference] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // The session-expiry callback is held in a ref rather than listed as a
  // dependency of the loaders below. Both loaders are dependencies of the
  // effect that fetches the report list, and a parent that re-creates the
  // callback on its own re-render would otherwise change their identity and
  // re-trigger the fetch — i.e. a request loop driven by unrelated state
  // changes higher up the tree. The ref keeps fetching tied to `lang` only.
  const onSessionExpiredRef = useRef(onSessionExpired);
  useEffect(() => { onSessionExpiredRef.current = onSessionExpired; }, [onSessionExpired]);

  /** Loads one report's matches into the shared cache. Read-only by design. */
  const loadMatches = useCallback(async (reference: string) => {
    setMatchesByReport((prev) => ({ ...prev, [reference]: { status: 'loading' } }));
    const result = await fetchLostReportMatches(reference);
    if (!mountedRef.current) return;

    if (result.ok && result.data) {
      setMatchesByReport((prev) => ({ ...prev, [reference]: { status: 'ready', data: result.data } }));
      return;
    }
    if (result.error?.kind === 'auth') onSessionExpiredRef.current();
    setMatchesByReport((prev) => ({
      ...prev,
      [reference]: {
        status: 'error',
        errorKind: result.error?.kind,
      },
    }));
  }, []);

  const loadReports = useCallback(async (opts: { isRefresh?: boolean } = {}) => {
    if (opts.isRefresh) setRefreshing(true); else setReportsLoading(true);
    setReportsError(null);

    const result = await listMyLostReports();
    if (!mountedRef.current) return;

    if (!result.ok || !result.data) {
      if (result.error?.kind === 'auth') onSessionExpiredRef.current();
      setReportsError(
        result.error?.kind === 'auth'
          ? t('Your session has ended. Please sign in again.', 'Kipindi chako kimeisha. Tafadhali ingia tena.')
          : t('We could not load your lost reports. Please try again.', 'Imeshindwa kupata ripoti zako. Tafadhali jaribu tena.')
      );
      setReports([]);
      setReportsLoading(false);
      setRefreshing(false);
      return;
    }

    // Newest first — the server returns its own order, which is insertion order.
    const list = [...result.data.lost_reports].sort(
      (a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
    );
    setReports(list);
    setReportsLoading(false);
    setRefreshing(false);

    // Pre-load matches for the first few ACTIVE reports only (see the
    // rate-limit note at the top of this file). Closed reports are never
    // queried: the server would only tell us matching is inactive.
    const activeToPreload = list.filter((report) => isSearchingStatus(report.status)).slice(0, AUTO_LOAD_MATCH_LIMIT);
    for (const report of activeToPreload) {
      setMatchesByReport((prev) => (prev[report.id] ? prev : { ...prev, [report.id]: { status: 'loading' } }));
    }
    for (const report of activeToPreload) {
      // Sequential on purpose: a burst of parallel lookups is exactly what the
      // Phase 9B limiter exists to stop.
      // eslint-disable-next-line no-await-in-loop
      await loadMatches(report.id);
    }
  }, [lang, loadMatches]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/categories');
        if (res.ok) {
          const data = await res.json();
          if (!cancelled && mountedRef.current) setCategories(Array.isArray(data) ? data : []);
        }
      } catch {
        // Category names are cosmetic here; the raw category id is shown
        // instead and nothing else degrades.
      } finally {
        if (!cancelled && mountedRef.current) setCategoriesLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { loadReports(); }, [loadReports]);

  const handleCreated = async (reference: string) => {
    setWizardOpen(false);
    setCreatedReference(reference);
    await loadReports({ isRefresh: true });
    await loadMatches(reference);
  };

  // ---------------- WIZARD MODE ----------------
  if (wizardOpen) {
    return (
      <div className="space-y-5">
        <div>
          <h2 className="text-base font-extrabold text-brand-dark-text">
            {t('Report a lost item', 'Ripoti kitu kilichopotea')}
          </h2>
          <p className="mt-1 text-xs text-brand-muted-text leading-relaxed max-w-xl">
            {t(
              'Tell us what you lost and where. We will compare it with found items that are eligible to be claimed.',
              'Tuambie ulipoteza nini na wapi. Tutalinganisha na vitu vilivyopatikana vinavyostahili kudaiwa.'
            )}
          </p>
        </div>

        <LostReportWizard
          lang={lang}
          categories={categories}
          categoriesLoading={categoriesLoading}
          onCancel={() => setWizardOpen(false)}
          onCreated={handleCreated}
        />
      </div>
    );
  }

  // ---------------- LIST MODE ----------------
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-extrabold text-brand-dark-text">
            {t('My lost reports', 'Ripoti zangu za vitu vilivyopotea')}
          </h2>
          <p className="mt-1 text-xs text-brand-muted-text leading-relaxed max-w-xl">
            {t(
              'Reports you have filed with Return4me. Anything that looks similar to a report is shown as a possible match — never as a confirmation.',
              'Ripoti ulizowasilisha kwa Return4me. Kitu chochote kinachofanana na ripoti huonyeshwa kama mechi inayowezekana — sio uthibitisho.'
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => loadReports({ isRefresh: true })}
            loading={refreshing}
            aria-label={t('Refresh lost reports', 'Onyesha upya ripoti')}
          >
            <RefreshCw size={14} />
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => { setCreatedReference(null); setWizardOpen(true); }}
          >
            <Plus size={14} /> {t('Report something lost', 'Ripoti kitu kilichopotea')}
          </Button>
        </div>
      </div>

      {createdReference && (
        <Banner
          kind="success"
          onDismiss={() => setCreatedReference(null)}
          dismissLabel={t('Dismiss', 'Ondoa')}
        >
          {t('Your report has been submitted.', 'Ripoti yako imetumwa.')}{' '}
          <span className="font-mono font-bold">{createdReference}</span>
          {'. '}
          {t(
            'We will compare it with eligible found items.',
            'Tutalinganisha na vitu vilivyopatikana vinavyostahili.'
          )}
        </Banner>
      )}

      {reportsError && <Banner kind="error">{reportsError}</Banner>}

      {reportsLoading ? (
        <div className="space-y-3" aria-busy="true">
          <span className="sr-only">{t('Loading your lost reports…', 'Inapakia ripoti zako…')}</span>
          <Skeleton shape="card" className="w-full" />
          <Skeleton shape="card" className="w-full" />
        </div>
      ) : (reports || []).length === 0 ? (
        <EmptyState
          icon={Search}
          title={t("You haven't reported a lost item yet", 'Bado hujaripoti kitu kilichopotea')}
          description={t(
            'Reporting something lost lets Return4me compare it with found items that are eligible to be claimed, and show you anything that looks similar.',
            'Kuripoti kitu kilichopotea huruhusu Return4me kulinganisha na vitu vilivyopatikana vinavyostahili kudaiwa, na kukuonyesha kinachofanana.'
          )}
          action={(
            <Button variant="primary" size="md" onClick={() => setWizardOpen(true)}>
              <Plus size={14} /> {t('Report something lost', 'Ripoti kitu kilichopotea')}
            </Button>
          )}
        />
      ) : (
        <ul className="space-y-4">
          {(reports || []).map((report) => (
            <ReportCard
              key={report.id}
              lang={lang}
              report={report}
              categories={categories}
              matchesState={matchesByReport[report.id] || { status: 'idle' }}
              expanded={expandedReport === report.id}
              onToggle={() => setExpandedReport(expandedReport === report.id ? null : report.id)}
              onCheck={() => loadMatches(report.id)}
              onOpenItem={onOpenItem}
              onSessionExpired={onSessionExpired}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One report in the list. Communicates, at a glance: what was lost, its
 * category, where and roughly when, its current state, whether possible matches
 * are available, and the next action.
 *
 * For a CLOSED report (resolved / cancelled / lapsed) the match affordance is
 * not offered at all — the status explanation says matching is no longer active,
 * so an empty result can never be mistaken for a fresh search.
 */
function ReportCard({
  lang, report, categories, matchesState, expanded, onToggle, onCheck, onOpenItem, onSessionExpired,
}: {
  lang: 'en' | 'sw';
  report: LostReportView;
  categories: any[];
  matchesState: MatchesLoadState;
  expanded: boolean;
  onToggle: () => void;
  onCheck: () => void;
  onOpenItem: (itemId: string) => void;
  onSessionExpired: () => void;
}) {
  const sw = lang === 'sw';
  const t = (en: string, swText: string) => (sw ? swText : en);

  const status = getLostReportStatusDisplay(report.status, lang);
  const summary = lostReportSummary(report);
  const category = categoryLabel(categories, report.category_id, lang);
  const window = formatWindow(report.lost_at_from, report.lost_at_to, lang);
  const place = [report.location_area, report.county].filter(Boolean).join(', ');

  // Whether candidates exist is known only after a lookup; the badge states that
  // honestly ("Not checked yet") instead of implying there are none.
  let availability: { variant: 'success' | 'neutral' | 'warning'; icon: any; label: string; spin?: boolean } | null = null;
  if (status.searching) {
    if (matchesState.status === 'loading') {
      availability = { variant: 'neutral', icon: Loader2, label: t('Checking…', 'Inaangalia…'), spin: true };
    } else if (matchesState.status === 'error') {
      availability = { variant: 'warning', icon: AlertTriangle, label: t('Could not check', 'Imeshindwa kuangalia') };
    } else if (matchesState.status === 'ready') {
      const count = (matchesState.data?.matches || []).length;
      availability = count > 0
        ? {
            variant: 'success',
            icon: CheckCircle2,
            label: count === 1
              ? t('1 possible match', 'Mechi 1 inayowezekana')
              : t(`${count} possible matches`, `Mechi ${count} zinazowezekana`),
          }
        : { variant: 'neutral', icon: Search, label: t('No matches yet', 'Hakuna mechi bado') };
    }
  }

  return (
    <li className="bg-white border border-brand-border rounded-2xl p-4 sm:p-5 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-2 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={status.variant}>{status.label}</Badge>
            <Badge variant="code">{report.id}</Badge>
          </div>

          <p className="text-sm font-extrabold text-brand-dark-text break-words">{category}</p>

          {summary && (
            <p className="text-xs text-brand-muted-text leading-relaxed break-words">{summary}</p>
          )}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-brand-muted-text">
            {place && (
              <span className="inline-flex items-center gap-1.5">
                <MapPin size={12} aria-hidden="true" className="shrink-0 text-accent-orange" />
                {place}
              </span>
            )}
            {window && <span>{t('Lost', 'Ilipotea')}: {window}</span>}
            {report.created_at && (
              <span>{t('Reported', 'Iliripotiwa')} {formatDate(report.created_at, lang)}</span>
            )}
          </div>

          {status.description && (
            <p className="text-xs text-brand-muted-text leading-relaxed">{status.description}</p>
          )}
        </div>

        <div className="flex flex-col items-start sm:items-end gap-2 shrink-0">
          {availability && (
            <Badge variant={availability.variant} icon={availability.icon}>
              <span className={availability.spin ? 'motion-safe:animate-pulse' : undefined}>
                {availability.label}
              </span>
            </Badge>
          )}

          {status.searching && (
            <Button
              variant="secondary"
              size="sm"
              onClick={onToggle}
              aria-expanded={expanded}
              aria-controls={`lost-report-matches-${report.id}`}
            >
              <Search size={13} />
              {expanded
                ? t('Hide possible matches', 'Ficha mechi zinazowezekana')
                : t('Possible matches', 'Mechi zinazowezekana')}
            </Button>
          )}
        </div>
      </div>

      {expanded && status.searching && (
        <div id={`lost-report-matches-${report.id}`} className="border-t border-brand-border pt-4">
          <PossibleMatches
            lang={lang}
            categories={categories}
            state={matchesState}
            onReload={onCheck}
            onOpenItem={onOpenItem}
            onSessionExpired={onSessionExpired}
          />
        </div>
      )}
    </li>
  );
}


