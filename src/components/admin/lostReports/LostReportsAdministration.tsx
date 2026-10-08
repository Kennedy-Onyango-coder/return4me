import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FileSearch, RefreshCw, SearchX } from 'lucide-react';
import Badge from '../../ui/Badge';
import Banner from '../../ui/Banner';
import Button from '../../ui/Button';
import EmptyState from '../../ui/EmptyState';
import SectionHeading from '../../ui/SectionHeading';
import Skeleton from '../../ui/Skeleton';
import { getLostReportStatusDisplay } from '../../../config/lostReportPresentation';
// PHASE 16.1 (GEO-16-04): the county filter's 47 options come from the ONE
// canonical county source. This component keeps no county list of its own.
import { countiesByUxGroup } from '../../../config/kenyaCounties';
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

function formatDateTime(value: string | null): string {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** "12 Feb 2026, 14:30 — 12 Feb 2026, 17:05", collapsing an identical pair. */
function formatWindow(from: string | null, to: string | null): string {
  const a = formatDateTime(from);
  const b = formatDateTime(to);
  if (!a) return '';
  return b && b !== a ? `${a} — ${b}` : a;
}

/** The 47 canonical counties, grouped for display. Read once — the dataset is static. */
const COUNTY_GROUPS = countiesByUxGroup();

export default function LostReportsAdministration({ token }: {  token: string | null }) {



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
  // PHASE 16.1 (GEO-16-04): the canonical county filter. '' means "All
  // Counties" — the parameter is then omitted from the request entirely.
  const [county, setCounty] = useState<string>('');

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
          // '' (All Counties) is passed through as null so no county parameter
          // is sent at all — the pre-16.1 request shape.
          county: county || null,
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
            : 'The lost-report service could not be reached.',
        );
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [token, county],
  );

  useEffect(() => {
    load(offset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset, reloadToken, token, county]);

  /**
   * PHASE 16.1 (GEO-16-04): changing the county is a change of RESULT SET, so
   * the view returns to the first page before reloading. Clearing the filter
   * ('') restores the unfiltered list. Both paths go through the effect above —
   * there is no second fetch path to drift.
   */
  const handleCountyChange = (value: string) => {
    setCounty(value);
    setOffset(0);
  };

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
    return (match.name_en) || match.name_en || categoryId;
  };

  const thClass = 'px-3 py-2.5 text-left text-caption font-extrabold uppercase tracking-wider text-brand-muted-text whitespace-nowrap';
  const tdClass = 'px-3 py-3 align-top text-xs text-stone-700';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionHeading
          eyebrow={'Operations'}
          title={'Lost Reports'}
          description={'Reports customers have filed for something they lost, newest first. Read-only: this view never changes a report, an item or a claim.'}
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setReloadToken((n) => n + 1)}
          loading={loading}
          aria-label={'Refresh lost reports'}
        >
          <RefreshCw size={14} />
        </Button>
      </div>

      {/* PHASE 16.1 (GEO-16-04) — CANONICAL COUNTY FILTER.
          A select, not free text, over the ONE canonical 47-county dataset
          (config/kenyaCounties.ts): the admin value must be exactly the value
          stored in `lost_reports.county`, and the server re-validates it with
          resolveCountyName() regardless of what this control sends. */}
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="admin-lost-county" className="text-caption font-extrabold uppercase tracking-wider text-[var(--appearance-text-muted)]">
          {'County'}
        </label>
        <select
          id="admin-lost-county"
          value={county}
          onChange={(e) => handleCountyChange(e.target.value)}
          className="h-11 min-w-0 max-w-full rounded-standard border border-[var(--appearance-border)] bg-[var(--appearance-surface)] px-3 text-body text-[var(--appearance-text-primary)] transition-colors focus:border-[var(--appearance-focus)]"
        >
          <option value="">{'All Counties'}</option>
          {COUNTY_GROUPS.map((group) => (
            <optgroup key={group.group} label={group.group}>
              {group.counties.map((c) => (
                <option key={c.code} value={c.name}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      {loading ? (
        <div className="space-y-3" aria-busy="true">
          <span className="sr-only">{'Loading lost reports…'}</span>
          <Skeleton shape="card" className="w-full" />
          <Skeleton shape="card" className="w-full" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title={county
            ? 'No lost reports in this county'
            : 'No lost reports yet'}
          description={county
            ? `Nothing has been reported in ${county}. Choose "All Counties" to see every report.`
            : 'When a customer reports something lost, it appears here with its county, area and any possible matches.'}
        />
      ) : (
        <ReportsTable rows={rows} categoryName={categoryName} thClass={thClass} tdClass={tdClass} />
      )}

      {!loading && rows.length > 0 && (offset > 0 || pagination.hasMore) && (
        <div className="flex items-center justify-between gap-3">
          <Button
            variant="secondary"
            size="sm"
            disabled={offset === 0 || loading}
            onClick={() => setOffset((n) => Math.max(0, n - pagination.limit))}
          >
            {'Previous'}
          </Button>
          <span className="text-xs font-bold text-stone-500">
            {`Showing ${rows.length} report(s)`}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={!pagination.hasMore || loading}
            onClick={() => setOffset((n) => n + pagination.limit)}
          >
            {'Next'}
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
  rows, categoryName, thClass, tdClass,
}: {
  rows: AdminLostReportListView[];
  categoryName: (id: string) => string;
  thClass: string;
  tdClass: string;
}) {


  return (
    <div className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-2xl shadow-sm r4m-scroll-x" role="region" aria-label={'Lost reports table'} tabIndex={0}>
      <table className="min-w-full">
        <caption className="sr-only">
          {'Lost reports, newest first'}
        </caption>
        <thead className="bg-stone-50 border-b border-stone-100">
          <tr>
            <th scope="col" className={thClass}>{'Lost Report'}</th>
            <th scope="col" className={thClass}>{'Category'}</th>
            <th scope="col" className={thClass}>{'County'}</th>
            <th scope="col" className={thClass}>{'Sub-county'}</th>
            <th scope="col" className={thClass}>{'Exact place'}</th>
            <th scope="col" className={thClass}>{'Lost Date/Time'}</th>
            <th scope="col" className={thClass}>{'Created'}</th>
            <th scope="col" className={thClass}>{'Status'}</th>
            <th scope="col" className={thClass}>{'Possible Matches'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((report) => {
            // The EXISTING presentation map. An unknown status falls back to a
            // neutral badge showing the raw token, so an unexpected value can
            // never crash the console or render blank.
            const status = getLostReportStatusDisplay(report.status);
            const place = [report.location_area, report.location_landmark]
              .filter((v): v is string => Boolean(v && String(v).trim()))
              .join(' · ');
            return (
              <tr key={report.id} className="border-b border-stone-100 last:border-0">
                <td className={tdClass}>
                  <Badge variant="code">{report.id}</Badge>
                  {report.has_document_number && (
                    <span className="mt-1.5 block text-caption font-bold uppercase tracking-wider text-brand-muted-text">
                      {'Identifier recorded'}
                    </span>
                  )}
                </td>
                <td className={`${tdClass} font-bold text-stone-900`}>{categoryName(report.category_id)}</td>
                <td className={tdClass}>{report.county}</td>
                <td className={tdClass}>{report.administrative_unit_name || <span className="text-stone-400">-</span>}</td>
                <td className={tdClass}>{place || <span className="text-stone-400">-</span>}</td>
                <td className={tdClass}>{formatWindow(report.lost_at_from, report.lost_at_to)}</td>
                <td className={tdClass}>{formatDateTime(report.created_at)}</td>
                <td className={tdClass}><Badge variant={status.variant}>{status.label}</Badge></td>
                <td className={tdClass}>
                  {report.possible_match_count === null
                    ? <span className="text-stone-400">{'Not applicable'}</span>
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
