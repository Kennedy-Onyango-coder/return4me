import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FileSearch, RefreshCw, SearchX } from 'lucide-react';
import Badge from '../../ui/Badge';
import Banner from '../../ui/Banner';
import Button from '../../ui/Button';
import EmptyState from '../../ui/EmptyState';
import SectionHeading from '../../ui/SectionHeading';
import Skeleton from '../../ui/Skeleton';
import { getLostReportStatusDisplay } from '../../../config/lostReportPresentation';
import {
  ADMIN_LOST_REPORTS_PAGE_SIZE,
  AdminLostReportsApiError,
  fetchAdminLostReports,
  type AdminLostReportListView,
  type AdminLostReportsPagination,
} from '../../../services/adminLostReportsApi';

// =============================================================================
// PHASE 11A — LOST REPORTS (ADMIN CONSOLE SECTION)
// =============================================================================
// Read-only operational visibility for lost reports. The Phase 11 forensic
// audit found administrators had no lost-report surface at all; this section is
// that surface and nothing more.
//
// REQUEST DISCIPLINE (mirrors the Claims Administration container)
//   - server-side paging: only one bounded page is ever held in memory;
//   - one request per (page, retry), no polling and no per-row request;
//   - AbortController AND a sequence guard, so a slow response for an abandoned
//     page can never overwrite a newer one;
//   - nothing is logged.
//
// PRIVACY
//   The rows come from the admin-safe DTO, which has no `document_number_hash`
//   and no `customer_id`. Every cell below is written out field by field — the
//   table never spreads a row and never renders raw JSON, so a field added to
//   the API in future cannot appear on screen by accident.

function formatDateTime(value: string | null, lang: 'en' | 'sw'): string {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString(lang === 'sw' ? 'sw-KE' : 'en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** "12 Feb 2026, 14:30 — 12 Feb 2026, 17:05", collapsing an identical pair. */
function formatWindow(from: string | null, to: string | null, lang: 'en' | 'sw'): string {
  const a = formatDateTime(from, lang);
  const b = formatDateTime(to, lang);
  if (!a) return '';
  return b && b !== a ? `${a} — ${b}` : a;
}

export default function LostReportsAdministration({ lang, token }: { lang: 'en' | 'sw'; token: string | null }) {
  const sw = lang === 'sw';
  const t = (en: string, swText: string) => (sw ? swText : en);

  const [rows, setRows] = useState<AdminLostReportListView[]>([]);
  const [pagination, setPagination] = useState<AdminLostReportsPagination>({
    limit: ADMIN_LOST_REPORTS_PAGE_SIZE,
    offset: 0,
    hasMore: false,
  });
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [categories, setCategories] = useState<any[]>([]);

  // Only the newest request may commit its result.
  const requestId = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (nextOffset: number) => {
      const id = ++requestId.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setError(null);
      try {
        const page = await fetchAdminLostReports(token, {
          limit: ADMIN_LOST_REPORTS_PAGE_SIZE,
          offset: nextOffset,
          signal: controller.signal,
        });
        if (id !== requestId.current) return; // superseded — stay silent
        setRows(page.items);
        setPagination(page.pagination);
      } catch (e: any) {
        if (e instanceof AdminLostReportsApiError && e.isAbort) return;
        if (id !== requestId.current) return;
        setRows([]);
        setError(
          e instanceof AdminLostReportsApiError
            ? e.message
            : t('The lost-report service could not be reached.', 'Huduma ya ripoti haifikiki.'),
        );
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [token, lang],
  );

  useEffect(() => {
    load(offset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset, reloadToken, token]);

  // Category names are cosmetic here (the raw category id is shown otherwise),
  // so a failure is silently tolerated — exactly as the customer section does.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/categories');
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && Array.isArray(data)) setCategories(data);
      } catch {
        // Category names are optional decoration in this table.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const categoryName = (categoryId: string): string => {
    const match = categories.find((c) => c && c.id === categoryId);
    if (!match) return categoryId;
    return (sw ? match.name_sw : match.name_en) || match.name_en || categoryId;
  };

  const thClass = 'px-3 py-2.5 text-left text-[10px] font-extrabold uppercase tracking-wider text-stone-500 whitespace-nowrap';
  const tdClass = 'px-3 py-3 align-top text-xs text-stone-700';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionHeading
          eyebrow={t('Operations', 'Uendeshaji')}
          title={t('Lost Reports', 'Ripoti za Vitu Vilivyopotea')}
          description={t(
            'Reports customers have filed for something they lost, newest first. Read-only: this view never changes a report, an item or a claim.',
            'Ripoti zilizowasilishwa na wateja kwa vitu vilivyopotea, mpya kwanza. Kusoma pekee: mwonekano huu haubadilishi ripoti, kitu, wala claim.'
          )}
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setReloadToken((n) => n + 1)}
          loading={loading}
          aria-label={t('Refresh lost reports', 'Onyesha upya ripoti')}
        >
          <RefreshCw size={14} />
        </Button>
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      {loading ? (
        <div className="space-y-3" aria-busy="true">
          <span className="sr-only">{t('Loading lost reports…', 'Inapakia ripoti…')}</span>
          <Skeleton shape="card" className="w-full" />
          <Skeleton shape="card" className="w-full" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title={t('No lost reports yet', 'Hakuna ripoti bado')}
          description={t(
            'When a customer reports something lost, it appears here with its county, area and any possible matches.',
            'Mteja anaporipoti kitu kilichopotea, kitaonekana hapa na kaunti, eneo na mechi zinazowezekana.'
          )}
        />
      ) : (
        <ReportsTable lang={lang} rows={rows} categoryName={categoryName} thClass={thClass} tdClass={tdClass} />
      )}

      {!loading && rows.length > 0 && (offset > 0 || pagination.hasMore) && (
        <div className="flex items-center justify-between gap-3">
          <Button
            variant="secondary"
            size="sm"
            disabled={offset === 0 || loading}
            onClick={() => setOffset((n) => Math.max(0, n - pagination.limit))}
          >
            {t('Previous', 'Nyuma')}
          </Button>
          <span className="text-xs font-bold text-stone-500">
            {t(`Showing ${rows.length} report(s)`, `Inaonyesha ripoti ${rows.length}`)}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={!pagination.hasMore || loading}
            onClick={() => setOffset((n) => n + pagination.limit)}
          >
            {t('Next', 'Mbele')}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The table itself, extracted so the container stays readable.
 *
 * EVERY CELL IS WRITTEN OUT EXPLICITLY. There is no `{report}`, no spread and
 * no JSON dump anywhere in this file, so a field added to the API cannot reach
 * the screen without someone deliberately adding a column for it.
 */
function ReportsTable({
  lang, rows, categoryName, thClass, tdClass,
}: {
  lang: 'en' | 'sw';
  rows: AdminLostReportListView[];
  categoryName: (id: string) => string;
  thClass: string;
  tdClass: string;
}) {
  const t = (en: string, swText: string) => (lang === 'sw' ? swText : en);

  return (
    <div className="bg-white border border-stone-100 rounded-2xl shadow-sm overflow-x-auto">
      <table className="min-w-full">
        <caption className="sr-only">
          {t('Lost reports, newest first', 'Ripoti za vitu vilivyopotea, mpya kwanza')}
        </caption>
        <thead className="bg-stone-50 border-b border-stone-100">
          <tr>
            <th scope="col" className={thClass}>{t('Lost Report', 'Ripoti')}</th>
            <th scope="col" className={thClass}>{t('Category', 'Aina')}</th>
            <th scope="col" className={thClass}>{t('County', 'Kaunti')}</th>
            <th scope="col" className={thClass}>{t('Area', 'Eneo')}</th>
            <th scope="col" className={thClass}>{t('Lost Date/Time', 'Muda Uliopotea')}</th>
            <th scope="col" className={thClass}>{t('Created', 'Iliundwa')}</th>
            <th scope="col" className={thClass}>{t('Status', 'Hali')}</th>
            <th scope="col" className={thClass}>{t('Possible Matches', 'Mechi Zinazowezekana')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((report) => {
            // The EXISTING presentation map. An unknown status falls back to a
            // neutral badge showing the raw token, so an unexpected value can
            // never crash the console or render blank.
            const status = getLostReportStatusDisplay(report.status, lang);
            const place = [report.location_area, report.location_landmark]
              .filter((v): v is string => Boolean(v && String(v).trim()))
              .join(' · ');
            return (
              <tr key={report.id} className="border-b border-stone-100 last:border-0">
                <td className={tdClass}>
                  <Badge variant="code">{report.id}</Badge>
                  {report.has_document_number && (
                    <span className="mt-1.5 block text-[10px] font-bold uppercase tracking-wider text-stone-400">
                      {t('Identifier recorded', 'Kitambulisho kimerekodiwa')}
                    </span>
                  )}
                </td>
                <td className={`${tdClass} font-bold text-stone-900`}>{categoryName(report.category_id)}</td>
                <td className={tdClass}>{report.county}</td>
                <td className={tdClass}>{place || <span className="text-stone-400">-</span>}</td>
                <td className={tdClass}>{formatWindow(report.lost_at_from, report.lost_at_to, lang)}</td>
                <td className={tdClass}>{formatDateTime(report.created_at, lang)}</td>
                <td className={tdClass}><Badge variant={status.variant}>{status.label}</Badge></td>
                <td className={tdClass}>
                  {report.possible_match_count === null
                    ? <span className="text-stone-400">{t('Not applicable', 'Haitumiki')}</span>
                    : <span className="inline-flex items-center gap-1.5 font-bold text-stone-900">
                        <FileSearch size={12} aria-hidden="true" className="text-accent-orange" />
                        {report.possible_match_count}
                      </span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
