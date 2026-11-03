import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FileSearch, RefreshCw, SearchX } from 'lucide-react';
import Badge from '../../ui/Badge';
import Banner from '../../ui/Banner';
import Button from '../../ui/Button';
import EmptyState from '../../ui/EmptyState';
import SectionHeading from '../../ui/SectionHeading';
import Skeleton from '../../ui/Skeleton';
import { getLostReportItemNameDisplay, getLostReportStatusDisplay } from '../../../config/lostReportPresentation';
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
// PHASE 16.1 (BATCH 1) — CLASSIFICATION IS A WRITE, so it goes through its own
// client. services/adminLostReportsApi.ts is GET-only by contract (and a test
// enforces that), so the mutation lives beside it rather than inside it.
import {
  AdminLostReportClassifyApiError,
  classifyLostReport,
  unclassifyLostReport,
} from '../../../services/adminLostReportClassificationApi';

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

  // PHASE 16.1 (BATCH 1) — show ONLY reports that carry no category yet. It
  // composes with the county filter in the SAME request, so "unclassified
  // reports in Mombasa" is one bounded page query.
  const [unclassifiedOnly, setUnclassifiedOnly] = useState(false);

  // The row currently being classified, or null. This is the duplicate-submit
  // guard: while one classification is in flight every control on THAT row is
  // disabled, and a second click for the same row is dropped before it can
  // become a second request. Other rows stay usable, so the console is not
  // frozen by one slow save.
  const [classifyingId, setClassifyingId] = useState<string | null>(null);
  // Failure and success feedback for the classification action. Deliberately
  // separate from the LIST `error` above: a refused classification must not look
  // like "the list failed to load", and it must not blank the table the operator
  // is working in.
  const [classifyError, setClassifyError] = useState<string | null>(null);
  const [classifyNotice, setClassifyNotice] = useState<string | null>(null);

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
          // PHASE 16.1 (BATCH 1) — omitted entirely when false, so the default
          // request stays byte-identical to the pre-Batch-1 one.
          unclassifiedOnly,
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
    [token, county, unclassifiedOnly],
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

  /**
   * PHASE 16.1 (BATCH 1) — toggling the unclassified-only filter.
   *
   * Same change-of-result-set rule as the county filter: return to the first
   * page. `setOffset(0)` alone is a no-op when the view is already on page one,
   * so `reloadToken` is bumped explicitly — that is what re-runs the ONE load
   * effect (whose dependency list is intentionally the pinned
   * `[offset, reloadToken, token, county]` and therefore does not name this
   * flag; the effect reads the CURRENT `load`, which closes over it).
   */
  const handleUnclassifiedChange = (next: boolean) => {
    setUnclassifiedOnly(next);
    setOffset(0);
    setReloadToken((n) => n + 1);
  };

  /**
   * PHASE 16.1 (BATCH 1) — classify, reclassify, or clear one report's category.
   *
   * `categoryId === null` is the deliberate "return to unclassified" action and
   * is routed through `unclassifyLostReport()`, the only function that ever sends
   * `null`. A real id is routed through `classifyLostReport()`, which refuses a
   * blank value locally rather than letting an empty field clear a category by
   * accident.
   *
   * REQUEST LIFECYCLE
   *   - `classifyingId` is set BEFORE the first await and cleared in `finally`,
   *     so a second click for the same row is dropped here (and every control on
   *     that row is disabled) — no duplicate submission and no double-apply;
   *   - the row is updated from what the SERVER confirmed (`result.categoryId`),
   *     never from what was requested, so the table cannot show a classification
   *     the database did not take;
   *   - the list is then refreshed from the server, because classification also
   *     changes `possible_match_count` (matching only runs once a category
   *     exists) and, with the unclassified filter on, removes the row from the
   *     current result set;
   *   - a failure is shown in its own banner and changes nothing else. An aborted
   *     request stays silent, as everywhere else in this console.
   */
  const handleClassify = async (reportId: string, categoryId: string | null) => {
    if (classifyingId) return;
    setClassifyError(null);
    setClassifyNotice(null);
    setClassifyingId(reportId);
    try {
      const result = categoryId
        ? await classifyLostReport(token, reportId, categoryId)
        : await unclassifyLostReport(token, reportId);

      setRows((previous) =>
        previous.map((row) => (row.id === reportId ? { ...row, category_id: result.categoryId } : row)),
      );
      setClassifyNotice(
        result.categoryId
          ? `Report ${reportId} is now classified.`
          : `Report ${reportId} is now unclassified.`,
      );
      setReloadToken((n) => n + 1);
    } catch (e: any) {
      if (e instanceof AdminLostReportClassifyApiError) {
        if (!e.isAbort) setClassifyError(e.message);
      } else {
        setClassifyError('The classification could not be saved. Please try again.');
      }
    } finally {
      setClassifyingId(null);
    }
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

  // PHASE 16.1 (BATCH 1) — the empty state has to describe the filter that is
  // actually applied. "No lost reports yet" would be a lie while an
  // unclassified-only filter is hiding classified ones.
  const emptyTitle = unclassifiedOnly
    ? (county ? 'No unclassified reports in this county' : 'No unclassified reports')
    : (county ? 'No lost reports in this county' : 'No lost reports yet');
  const emptyDescription = unclassifiedOnly
    ? (county
        ? `Every report in ${county} has a category. Clear the unclassified filter to see them all.`
        : 'Every lost report has a category. Clear the unclassified filter to see them all.')
    : (county
        ? `Nothing has been reported in ${county}. Choose "All Counties" to see every report.`
        : 'When a customer reports something lost, it appears here with its county, area and any possible matches.');

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

        {/* PHASE 16.1 (BATCH 1) — UNCLASSIFIED-ONLY FILTER.
            A checkbox, not a second select: the question is binary ("only
            uncategorised reports?"), and it composes with the county select
            beside it in the same request. */}
        <label
          htmlFor="admin-lost-unclassified"
          className="ml-1 inline-flex items-center gap-2 text-body text-[var(--appearance-text-primary)]"
        >
          <input
            id="admin-lost-unclassified"
            type="checkbox"
            checked={unclassifiedOnly}
            onChange={(e) => handleUnclassifiedChange(e.target.checked)}
            className="h-4 w-4 rounded border-[var(--appearance-border)]"
          />
          {'Unclassified only'}
        </label>
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      {/* PHASE 16.1 (BATCH 1) — classification feedback, kept separate from the
          list error above: a refused reclassification must not look like a
          failed page load, and it must not blank the table. */}
      {classifyError && <Banner kind="error">{classifyError}</Banner>}
      {classifyNotice && (
        <p role="status" aria-live="polite" className="text-small font-semibold text-[var(--appearance-text-primary)]">
          {classifyNotice}
        </p>
      )}

      {loading ? (
        <div className="space-y-3" aria-busy="true">
          <span className="sr-only">{'Loading lost reports…'}</span>
          <Skeleton shape="card" className="w-full" />
          <Skeleton shape="card" className="w-full" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title={emptyTitle}
          description={emptyDescription}
        />
      ) : (
        <ReportsTable
          rows={rows}
          categoryName={categoryName}
          categories={categories}
          classifyingId={classifyingId}
          onClassify={handleClassify}
          thClass={thClass}
          tdClass={tdClass}
        />
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
  rows, categoryName, categories, classifyingId, onClassify, thClass, tdClass,
}: {
  rows: AdminLostReportListView[];
  categoryName: (id: string) => string;
  /** The live category list, for the classify control's options. */
  categories: any[];
  /** The report whose classification is in flight, or null. */
  classifyingId: string | null;
  /** Classify to an id, or clear to null (return to unclassified). */
  onClassify: (reportId: string, categoryId: string | null) => void;
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
            <th scope="col" className={thClass}>{'Item name'}</th>
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
            // PHASE 16.1 (BATCH 1 FOLLOW-UP) — the reporter's own name for the
            // item, resolved ONCE per row through the shared display helper, so
            // the "is a name present?" rule exists in exactly one place.
            const itemName = getLostReportItemNameDisplay(report.item_name);
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
                <td className={tdClass}>
                  {/* PHASE 16.1 (BATCH 1 FOLLOW-UP) — what the reporter said the
                      item was. On an UNCLASSIFIED row this is the only human
                      description of the object, so it is what an operator reads
                      to choose a category. A row with no usable name SAYS so
                      rather than showing an empty cell, and a long name is
                      ellipsised inside a bounded column (the full value stays
                      reachable through `title`) so one verbose report cannot
                      stretch the table. */}
                  {itemName.provided ? (
                    <span className="block max-w-[16rem] truncate font-bold text-stone-900" title={itemName.text}>
                      {itemName.text}
                    </span>
                  ) : (
                    <span className="text-stone-400">{itemName.text}</span>
                  )}
                </td>
                <td className={`${tdClass} font-bold text-stone-900`}>
                  {/* PHASE 16.1 (BATCH 1) — an UNCLASSIFIED report is labelled as
                      such. A blank cell or a raw `null` would read as a rendering
                      bug, and a bold empty cell is exactly what an operator would
                      fail to notice in a triage list. */}
                  {report.category_id ? (
                    <span>{categoryName(report.category_id)}</span>
                  ) : (
                    <Badge variant="warning">{'Unclassified'}</Badge>
                  )}
                  <ClassifyControl
                    reportId={report.id}
                    currentCategoryId={report.category_id}
                    categories={categories}
                    busy={classifyingId === report.id}
                    onClassify={onClassify}
                  />
                </td>
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

/**
 * PHASE 16.1 (BATCH 1) — the per-row classification control.
 *
 * WHY IT IS ITS OWN COMPONENT
 *   Each row needs its OWN pending selection. Holding that in the table would
 *   mean one shared map that a re-render (or a page change) could desynchronise
 *   from the rows it describes. A component per row keeps `selected` local to the
 *   row it belongs to, and re-syncs it whenever the server's value changes after
 *   a refresh.
 *
 * THE TWO ACTIONS
 *   SAVE  — classifies (or RECLASSIFIES) to the chosen category. Disabled while
 *           nothing is chosen, and while the chosen value already equals the
 *           stored one, so a no-op request is never sent.
 *   CLEAR — returns the report to UNCLASSIFIED. Only offered when the report
 *           currently HAS a category, so the destructive direction is never the
 *           default and is never reachable by leaving the select empty.
 *
 * While `busy`, both controls are disabled. That mirrors the parent's
 * `classifyingId` guard, so a double click cannot become a second request.
 */
function ClassifyControl({
  reportId, currentCategoryId, categories, busy, onClassify,
}: {
  reportId: string;
  currentCategoryId: string | null;
  categories: any[];
  busy: boolean;
  onClassify: (reportId: string, categoryId: string | null) => void;
}) {
  const [selected, setSelected] = useState<string>(currentCategoryId || '');

  // The STORED value is the source of truth: after a confirmed change (or any
  // refresh) the control follows it instead of keeping a stale pick.
  useEffect(() => {
    setSelected(currentCategoryId || '');
  }, [currentCategoryId]);

  // Only categories with an English name are offered (the same rule the Finder's
  // select applies), so the control can never present a blank option.
  const options = (categories || []).filter((category: any) => category && category.id && category.name_en);
  const canSave = Boolean(selected) && selected !== (currentCategoryId || '') && !busy;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <label htmlFor={`classify-${reportId}`} className="sr-only">
        {`Item category for ${reportId}`}
      </label>
      <select
        id={`classify-${reportId}`}
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        disabled={busy || options.length === 0}
        className="h-8 max-w-[11rem] rounded-standard border border-[var(--appearance-border)] bg-[var(--appearance-surface)] px-2 text-xs text-[var(--appearance-text-primary)]"
      >
        <option value="">{'Select category'}</option>
        {options.map((category: any) => (
          <option key={category.id} value={category.id}>
            {category.name_en}
          </option>
        ))}
      </select>
      <Button
        variant="secondary"
        size="sm"
        disabled={!canSave}
        onClick={() => onClassify(reportId, selected)}
      >
        {busy ? 'Saving…' : 'Save'}
      </Button>
      {currentCategoryId && (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => onClassify(reportId, null)}
        >
          {'Clear'}
        </Button>
      )}
    </div>
  );
}
