import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileSearch, RefreshCw, SearchX } from 'lucide-react';
import Banner from '../../ui/Banner';
import Button from '../../ui/Button';
import EmptyState from '../../ui/EmptyState';
import SectionHeading from '../../ui/SectionHeading';
import Skeleton from '../../ui/Skeleton';
import ClaimsFilters, {
  EMPTY_CLAIM_FILTERS,
  hasActiveClaimFilters,
  toApiFilters,
  type ClaimFilterState,
} from './ClaimsFilters';
import ClaimsTable from './ClaimsTable';
import ClaimPagination from './ClaimPagination';
import ClaimDetailPanel from './ClaimDetailPanel';
import {
  ADMIN_CLAIMS_PAGE_SIZE,
  fetchAdminClaimDetail,
  fetchAdminClaimsList,
  AdminClaimsApiError,
} from '../../../services/adminClaimsApi';
import type {
  AdminClaimDetailView,
  AdminClaimListView,
  AdminClaimsPagination,
} from '../../../services/adminClaimsApi';

/**
 * Claims Administration — the container.
 *
 * Owns exactly three things: the applied filters, the current page, and the
 * selected claim. Everything else is delegated to focused components.
 *
 * REQUEST DISCIPLINE
 *   - server-side paging: only one page is ever held in memory
 *   - filters are applied to EVERY page request, so page 2 shows the same set
 *   - changing a filter resets the offset to 0
 *   - free-text search is debounced; discrete selects are not
 *   - no polling, no auto-refresh, no per-row request
 *   - detail is fetched only when a claim is actually opened
 *   - every request is AbortController-guarded AND sequence-guarded, so a slow
 *     response for an abandoned filter can never overwrite a newer one
 *   - nothing is logged
 *
 * READ-ONLY: the only write anywhere in this subtree is the audit event the
 * SERVER emits for a detail read. The UI emits no audit-like event of its own.
 */
const SEARCH_DEBOUNCE_MS = 350;

export default function ClaimsAdministration({ lang, token }: { lang: 'en' | 'sw'; token: string | null }) {
  const [draftFilters, setDraftFilters] = useState<ClaimFilterState>(EMPTY_CLAIM_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<ClaimFilterState>(EMPTY_CLAIM_FILTERS);
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<AdminClaimListView[]>([]);
  const [pagination, setPagination] = useState<AdminClaimsPagination>({
    limit: ADMIN_CLAIMS_PAGE_SIZE,
    offset: 0,
    hasMore: false,
  });
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [selectedClaimId, setSelectedClaimId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminClaimDetailView | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Sequencing: only the newest request for each surface may commit its result.
  const listRequestId = useRef(0);
  const listAbort = useRef<AbortController | null>(null);
  const detailRequestId = useRef(0);
  const detailAbort = useRef<AbortController | null>(null);

  const loadList = useCallback(
    async (filters: ClaimFilterState, nextOffset: number) => {
      const requestId = ++listRequestId.current;
      listAbort.current?.abort();
      const controller = new AbortController();
      listAbort.current = controller;

      setListLoading(true);
      setListError(null);
      try {
        const page = await fetchAdminClaimsList(token, {
          filters: toApiFilters(filters),
          limit: ADMIN_CLAIMS_PAGE_SIZE,
          offset: nextOffset,
          signal: controller.signal,
        });
        if (requestId !== listRequestId.current) return; // superseded — stay silent
        setRows(page.items);
        setPagination(page.pagination);
      } catch (e: any) {
        if (e instanceof AdminClaimsApiError && e.isAbort) return;
        if (requestId !== listRequestId.current) return;
        setRows([]);
        setListError(
          e instanceof AdminClaimsApiError
            ? e.message
            : lang === 'sw'
              ? 'Huduma ya claims haifikiki.'
              : 'The claims service could not be reached.',
        );
      } finally {
        if (requestId === listRequestId.current) setListLoading(false);
      }
    },
    [token, lang],
  );

  // Re-fetch whenever the applied filters, the page, or an explicit retry change.
  useEffect(() => {
    loadList(appliedFilters, offset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedFilters, offset, reloadToken, token]);

  // Debounce only the free-text search; discrete selects apply immediately.
  useEffect(() => {
    if (
      draftFilters.search === appliedFilters.search &&
      draftFilters.searchField === appliedFilters.searchField
    ) {
      return;
    }
    const handle = setTimeout(() => {
      setOffset(0);
      setAppliedFilters((prev) => ({
        ...prev,
        search: draftFilters.search,
        searchField: draftFilters.searchField,
      }));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftFilters.search, draftFilters.searchField]);

  /** A select/date change: apply at once and return to the first page. */
  const applyImmediateFilters = (next: ClaimFilterState) => {
    setDraftFilters(next);
    setOffset(0);
    setAppliedFilters(next);
  };

  const resetFilters = () => {
    setDraftFilters(EMPTY_CLAIM_FILTERS);
    setOffset(0);
    setAppliedFilters(EMPTY_CLAIM_FILTERS);
  };

  // ---- detail -------------------------------------------------------------
  const loadDetail = useCallback(
    async (claimId: string) => {
      const requestId = ++detailRequestId.current;
      detailAbort.current?.abort();
      const controller = new AbortController();
      detailAbort.current = controller;

      setDetailLoading(true);
      setDetailError(null);
      setDetail(null);
      try {
        const claim = await fetchAdminClaimDetail(token, claimId, controller.signal);
        if (requestId !== detailRequestId.current) return;
        setDetail(claim);
      } catch (e: any) {
        if (e instanceof AdminClaimsApiError && e.isAbort) return;
        if (requestId !== detailRequestId.current) return;
        if (e instanceof AdminClaimsApiError && e.kind === 'not_found') {
          setDetailError(
            lang === 'sw'
              ? `Claim ${claimId} haipatikani. Huenda imeondolewa au kitambulisho si sahihi.`
              : `Claim ${claimId} could not be found. It may have been removed, or the ID is incorrect.`,
          );
        } else {
          setDetailError(
            e instanceof AdminClaimsApiError
              ? e.message
              : lang === 'sw'
                ? 'Maelezo ya claim hayakupakiwa.'
                : 'The claim details could not be loaded.',
          );
        }
      } finally {
        if (requestId === detailRequestId.current) setDetailLoading(false);
      }
    },
    [token, lang],
  );

  // Detail is fetched only when a claim is opened — never for a whole page.
  useEffect(() => {
    if (selectedClaimId) loadDetail(selectedClaimId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClaimId, token]);

  // Abort in-flight work when this surface unmounts (e.g. tab change).
  useEffect(
    () => () => {
      listAbort.current?.abort();
      detailAbort.current?.abort();
    },
    [],
  );

  const filtersActive = hasActiveClaimFilters(appliedFilters);

  return (
    <div className="space-y-4">
      <SectionHeading
        eyebrow={lang === 'sw' ? 'Utawala' : 'Administration'}
        title={lang === 'sw' ? 'Usimamizi wa Claims' : 'Claims Administration'}
        description={
          lang === 'sw'
            ? 'Tafuta na kagua claims zote. Sehemu hii ni ya kusoma tu — hakuna kitendo kinachobadilisha claim.'
            : 'Search and review claims across the platform. This view is read-only — nothing here changes a claim.'
        }
      />

      <ClaimsFilters
        value={draftFilters}
        onChange={applyImmediateFilters}
        onReset={resetFilters}
        lang={lang}
        disabled={listLoading}
      />

      {listError && (
        <Banner kind="error">
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span>{listError}</span>
            <Button variant="outline" size="sm" onClick={() => setReloadToken((n) => n + 1)}>
              <RefreshCw size={14} aria-hidden="true" />
              {lang === 'sw' ? 'Jaribu tena' : 'Retry'}
            </Button>
          </span>
        </Banner>
      )}

      <ListBody
        loading={listLoading}
        error={listError}
        rows={rows}
        lang={lang}
        filtersActive={filtersActive}
        selectedClaimId={selectedClaimId}
        onSelect={setSelectedClaimId}
        onResetFilters={resetFilters}
      />

      <ClaimPagination
        offset={pagination.offset}
        limit={pagination.limit}
        shown={rows.length}
        hasMore={pagination.hasMore}
        loading={listLoading}
        lang={lang}
        onPrevious={() => setOffset((o) => Math.max(0, o - ADMIN_CLAIMS_PAGE_SIZE))}
        onNext={() => setOffset((o) => o + ADMIN_CLAIMS_PAGE_SIZE)}
      />

      <p className="text-[11px] text-brand-muted-text">
        {lang === 'sw'
          ? 'Kila claim inapofunguliwa, mfumo hurekodi tukio la ukaguzi kwa msimamizi aliyeingia.'
          : 'Opening a claim records a server-side audit event against your admin account.'}
      </p>

      <ClaimDetailPanel
        claimId={selectedClaimId}
        claim={detail}
        loading={detailLoading}
        error={detailError}
        lang={lang}
        onClose={() => setSelectedClaimId(null)}
        onRetry={() => selectedClaimId && loadDetail(selectedClaimId)}
        onOpenClaim={setSelectedClaimId}
      />
    </div>
  );
}
/**
 * Loading / empty / error / table — one place, so the three states cannot drift
 * apart between surfaces.
 */
function ListBody({
  loading,
  error,
  rows,
  lang,
  filtersActive,
  selectedClaimId,
  onSelect,
  onResetFilters,
}: {
  loading: boolean;
  error: string | null;
  rows: AdminClaimListView[];
  lang: 'en' | 'sw';
  filtersActive: boolean;
  selectedClaimId: string | null;
  onSelect: (claimId: string) => void;
  onResetFilters: () => void;
}) {
  if (loading) {
    return (
      <div
        className="bg-white border border-brand-border rounded-2xl p-4 space-y-3"
        role="status"
        aria-live="polite"
      >
        <span className="sr-only">{lang === 'sw' ? 'Inapakia claims…' : 'Loading claims…'}</span>
        <Skeleton shape="rect" />
        <Skeleton shape="rect" />
        <Skeleton shape="rect" />
        <Skeleton shape="rect" className="w-3/4" />
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={FileSearch}
        title={lang === 'sw' ? 'Claims hazikupakiwa' : 'Claims could not be loaded'}
        description={
          lang === 'sw'
            ? 'Huduma ya claims haikujibu. Tumia "Jaribu tena" — hakuna taarifa iliyobadilika.'
            : 'The claims service did not respond. Use "Retry" above — nothing was changed.'
        }
      />
    );
  }

  if (rows.length === 0) {
    return filtersActive ? (
      <EmptyState
        icon={SearchX}
        title={lang === 'sw' ? 'Hakuna claim inayolingana' : 'No claims match your filters'}
        description={
          lang === 'sw'
            ? 'Hakuna claim inayolingana na utafutaji au vichujio hivi. Rekebisha vichujio na ujaribu tena.'
            : 'No claims match the current search or filters. Adjust them and try again.'
        }
        action={
          <Button variant="outline" size="sm" onClick={onResetFilters}>
            {lang === 'sw' ? 'Ondoa vichujio' : 'Clear filters'}
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={FileSearch}
        title={lang === 'sw' ? 'Hakuna claims bado' : 'No claims yet'}
        description={
          lang === 'sw'
            ? 'Hakuna claim iliyowasilishwa kwenye mfumo.'
            : 'No claims have been submitted to the platform yet.'
        }
      />
    );
  }

  return (
    <ClaimsTable
      rows={rows}
      lang={lang}
      selectedClaimId={selectedClaimId}
      onSelect={onSelect}
      disabled={false}
    />
  );
}


