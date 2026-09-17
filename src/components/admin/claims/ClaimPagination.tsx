import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import Button from '../../ui/Button';
import { describePageRange } from './claimsPresentation';

/**
 * Server-side pagination control.
 *
 * The 6E contract exposes `limit`, `offset` and `hasMore` — and NO total count.
 * So this control deliberately shows an offset window ("Claims 26–50") instead
 * of a fabricated "Showing 26–50 of 8,432". Next is enabled from `hasMore`
 * alone; Previous from `offset > 0`.
 *
 * Filters are NOT held here: the parent owns them and re-applies them on every
 * page change, so page 2 always shows the same filtered set as page 1.
 */
export default function ClaimPagination({
  offset,
  limit,
  shown,
  hasMore,
  loading,
  lang,
  onPrevious,
  onNext,
}: {
  offset: number;
  limit: number;
  shown: number;
  hasMore: boolean;
  loading: boolean;
  lang: 'en' | 'sw';
  onPrevious: () => void;
  onNext: () => void;
}) {
  const atFirstPage = offset <= 0;
  const disablePrevious = atFirstPage || loading;
  const disableNext = !hasMore || loading;

  return (
    <nav
      aria-label={lang === 'sw' ? 'Kurasa za claim' : 'Claims pages'}
      className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-3 border-t border-brand-border"
    >
      <p className="text-xs text-brand-muted-text" aria-live="polite">
        {describePageRange(offset, shown)}
        <span className="mx-1.5" aria-hidden="true">
          ·
        </span>
        {lang === 'sw' ? 'Kila ukurasa' : 'Per page'}: {limit}
        {hasMore && (
          <>
            <span className="mx-1.5" aria-hidden="true">
              ·
            </span>
            {lang === 'sw' ? 'Kuna zaidi' : 'More available'}
          </>
        )}
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onPrevious}
          disabled={disablePrevious}
          aria-label={lang === 'sw' ? 'Ukurasa uliopita' : 'Previous page'}
        >
          <ChevronLeft size={15} aria-hidden="true" />
          {lang === 'sw' ? 'Nyuma' : 'Previous'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onNext}
          disabled={disableNext}
          aria-label={lang === 'sw' ? 'Ukurasa unaofuata' : 'Next page'}
        >
          {lang === 'sw' ? 'Mbele' : 'Next'}
          <ChevronRight size={15} aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}
