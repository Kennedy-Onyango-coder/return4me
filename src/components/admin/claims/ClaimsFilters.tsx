import React from 'react';
import { X } from 'lucide-react';
import Button from '../../ui/Button';
import Input from '../../ui/Input';
import Select from '../../ui/Select';
import { CLAIM_STATUS_VALUES } from '../../../config/claimStatuses';
import { presentClaimStatus } from './claimsPresentation';
import type { AdminClaimsListFilters } from '../../../services/adminClaimsApiTypes';

/** Which identifier the free-text search box applies to. Maps 1:1 onto the
 *  three identifier filters the 6E endpoint accepts — the UI never invents a
 *  generic "search everything" parameter the server does not support. */
export type ClaimSearchField = 'claimId' | 'itemId' | 'claimantPhone';

export interface ClaimFilterState {
  searchField: ClaimSearchField;
  search: string;
  status: string;
  hasPaid: string;
  disputeState: string;
  createdFrom: string;
  createdTo: string;
}

export const EMPTY_CLAIM_FILTERS: ClaimFilterState = {
  searchField: 'claimId',
  search: '',
  status: '',
  hasPaid: '',
  disputeState: '',
  createdFrom: '',
  createdTo: '',
};

/** True when any filter would change the request. Drives the "filters applied"
 *  hint, the Reset control's disabled state, and which empty state is shown. */
export function hasActiveClaimFilters(f: ClaimFilterState): boolean {
  return Boolean(f.search.trim() || f.status || f.hasPaid || f.disputeState || f.createdFrom || f.createdTo);
}

/**
 * Translates UI filter state into the API's own parameter names and value
 * vocabulary. Every enum value here is one the endpoint validates; nothing is
 * invented, and the free-text value is placed under the parameter matching the
 * selected search field.
 */
export function toApiFilters(f: ClaimFilterState): AdminClaimsListFilters {
  const filters: AdminClaimsListFilters = {};
  const search = f.search.trim();
  if (search) {
    if (f.searchField === 'itemId') filters.itemId = search;
    else if (f.searchField === 'claimantPhone') filters.claimantPhone = search;
    else filters.claimId = search;
  }
  if (f.status) filters.status = f.status;
  if (f.hasPaid === 'true') filters.hasPaid = true;
  if (f.hasPaid === 'false') filters.hasPaid = false;
  if (f.disputeState === 'none' || f.disputeState === 'open' || f.disputeState === 'resolved') {
    filters.disputeState = f.disputeState;
  }
  if (f.createdFrom) filters.createdFrom = f.createdFrom;
  if (f.createdTo) filters.createdTo = f.createdTo;
  return filters;
}

/**
 * Claims filter bar. Selects apply immediately (they are discrete choices, so
 * debouncing them would only add latency); the free-text search is debounced by
 * the container, which owns the request lifecycle.
 */
export default function ClaimsFilters({
  value,
  onChange,
  onReset,
  lang,
  disabled,
}: {
  value: ClaimFilterState;
  onChange: (next: ClaimFilterState) => void;
  onReset: () => void;
  lang: 'en' | 'sw';
  disabled: boolean;
}) {
  const set = (patch: Partial<ClaimFilterState>) => onChange({ ...value, ...patch });
  const active = hasActiveClaimFilters(value);

  return (
    <div className="bg-white border border-brand-border rounded-2xl p-4 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1 sm:col-span-2">
          <label htmlFor="r4m-claims-search-field" className="block text-xs font-bold text-brand-dark-text">
            {lang === 'sw' ? 'Tafuta kwa' : 'Search by'}
          </label>
          <div className="flex gap-2">
            <Select
              id="r4m-claims-search-field"
              hideLabel
              label={lang === 'sw' ? 'Tafuta kwa' : 'Search by'}
              value={value.searchField}
              disabled={disabled}
              onChange={(e) => set({ searchField: e.target.value as ClaimSearchField })}
              className="w-44 shrink-0"
            >
              <option value="claimId">{lang === 'sw' ? 'Kitambulisho cha claim' : 'Claim ID'}</option>
              <option value="itemId">{lang === 'sw' ? 'Kitambulisho cha kitu' : 'Item ID'}</option>
              <option value="claimantPhone">{lang === 'sw' ? 'Simu ya mdai' : 'Claimant phone'}</option>
            </Select>
            <Input
              type="search"
              hideLabel
              label={lang === 'sw' ? 'Tafuta claims' : 'Search claims'}
              placeholder={
                value.searchField === 'claimantPhone'
                  ? '0712 345 678'
                  : value.searchField === 'itemId'
                    ? 'ITEM-…'
                    : 'CLM-…'
              }
              value={value.search}
              disabled={disabled}
              autoComplete="off"
              onChange={(e) => set({ search: e.target.value })}
            />
          </div>
          <p className="text-[11px] text-brand-muted-text">
            {lang === 'sw'
              ? 'Utafutaji unafanywa kwenye seva, si kwenye kivinjari.'
              : 'Search runs on the server, not in the browser.'}
          </p>
        </div>

        <Select
          label={lang === 'sw' ? 'Hali ya claim' : 'Claim status'}
          value={value.status}
          disabled={disabled}
          onChange={(e) => set({ status: e.target.value })}
        >
          <option value="">{lang === 'sw' ? 'Zote' : 'All statuses'}</option>
          {CLAIM_STATUS_VALUES.map((s: string) => (
            <option key={s} value={s}>
              {presentClaimStatus(s, lang).label}
            </option>
          ))}
        </Select>

        <Select
          label={lang === 'sw' ? 'Malipo' : 'Payment'}
          value={value.hasPaid}
          disabled={disabled}
          onChange={(e) => set({ hasPaid: e.target.value })}
        >
          <option value="">{lang === 'sw' ? 'Zote' : 'Paid or not paid'}</option>
          <option value="true">{lang === 'sw' ? 'Imelipwa' : 'Paid'}</option>
          <option value="false">{lang === 'sw' ? 'Haijalipwa' : 'Not paid'}</option>
        </Select>

        <Select
          label={lang === 'sw' ? 'Mzozo' : 'Dispute'}
          value={value.disputeState}
          disabled={disabled}
          onChange={(e) => set({ disputeState: e.target.value })}
        >
          <option value="">{lang === 'sw' ? 'Zote' : 'Any dispute state'}</option>
          <option value="none">{lang === 'sw' ? 'Hakuna' : 'No dispute'}</option>
          <option value="open">{lang === 'sw' ? 'Wazi' : 'Open'}</option>
          <option value="resolved">{lang === 'sw' ? 'Imetatuliwa' : 'Resolved'}</option>
        </Select>

        <Input
          type="date"
          label={lang === 'sw' ? 'Imeundwa kutoka' : 'Created from'}
          value={value.createdFrom}
          disabled={disabled}
          onChange={(e) => set({ createdFrom: e.target.value })}
        />
        <Input
          type="date"
          label={lang === 'sw' ? 'Imeundwa hadi' : 'Created to'}
          value={value.createdTo}
          disabled={disabled}
          onChange={(e) => set({ createdTo: e.target.value })}
        />

        <div className="flex items-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={onReset}
            disabled={disabled || !active}
            aria-label={lang === 'sw' ? 'Ondoa vichujio vyote' : 'Clear all filters'}
          >
            <X size={14} aria-hidden="true" />
            {lang === 'sw' ? 'Ondoa vichujio' : 'Clear filters'}
          </Button>
        </div>
      </div>

      <p className="text-[11px] text-brand-muted-text" aria-live="polite">
        {active
          ? lang === 'sw'
            ? 'Vichujio vinaendelea kutumika kwenye kila ukurasa.'
            : 'Filters stay applied across pages.'
          : lang === 'sw'
            ? 'Hakuna kichujio kinachotumika.'
            : 'No filters applied.'}
      </p>
    </div>
  );
}
