import React from 'react';
import { ChevronRight, Flag, ShieldAlert } from 'lucide-react';
import Badge from '../../ui/Badge';
import ClaimStatusBadge from './ClaimStatusBadge';
import ClaimPaymentState from './ClaimPaymentState';
import { formatTimestamp, presentDisputeState } from './claimsPresentation';
import type { AdminClaimListView } from '../../../services/adminClaimsApiTypes';

/**
 * The Claims table.
 *
 * Read-only by construction: a row is a <button> that opens the detail panel and
 * nothing else — there is no approve/reject/refund/settle affordance anywhere on
 * this surface, because no such endpoint is exposed to Phase 6F.
 *
 * Responsive strategy: real table semantics with horizontal scrolling on narrow
 * viewports (the least-lossy option for tabular data). No information is
 * duplicated in a second card layout, and nothing is hidden.
 *
 * Every value comes from the list DTO. The claimant phone is already masked by
 * the server and is rendered verbatim — the UI never tries to unmask it.
 */
const HEAD =
  'px-4 py-2.5 text-[11px] font-extrabold uppercase tracking-wider text-brand-muted-text';

export default function ClaimsTable({
  rows,
  lang,
  selectedClaimId,
  onSelect,
  disabled,
}: {
  rows: AdminClaimListView[];
  lang: 'en' | 'sw';
  selectedClaimId: string | null;
  onSelect: (claimId: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="bg-white border border-brand-border rounded-2xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm border-collapse min-w-[54rem]">
          <caption className="sr-only">
            {lang === 'sw'
              ? 'Claims zinazolingana na utafutaji na vichujio vilivyochaguliwa'
              : 'Claims matching the current search and filters'}
          </caption>
          <thead>
            <tr className="bg-brand-light-gray/70 border-b border-brand-border">
              <th scope="col" className={HEAD}>{lang === 'sw' ? 'Claim' : 'Claim ID'}</th>
              <th scope="col" className={HEAD}>{lang === 'sw' ? 'Hali' : 'Status'}</th>
              <th scope="col" className={HEAD}>{lang === 'sw' ? 'Kitu' : 'Item'}</th>
              <th scope="col" className={HEAD}>{lang === 'sw' ? 'Mdai' : 'Claimant'}</th>
              <th scope="col" className={HEAD}>{lang === 'sw' ? 'Malipo' : 'Payment'}</th>
              <th scope="col" className={HEAD}>{lang === 'sw' ? 'Mzozo' : 'Dispute'}</th>
              <th scope="col" className={HEAD}>{lang === 'sw' ? 'Imeundwa' : 'Created'}</th>
              <th scope="col" className={HEAD}>{lang === 'sw' ? 'Imesasishwa' : 'Updated'}</th>
              <th scope="col" className="w-10 px-2 py-2.5">
                <span className="sr-only">{lang === 'sw' ? 'Fungua' : 'Open'}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <ClaimRow
                key={row.id}
                row={row}
                lang={lang}
                selected={row.id === selectedClaimId}
                onSelect={onSelect}
                disabled={disabled}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** One row. Props are the fields it renders — never a spread of the whole DTO. */
function ClaimRow({
  row,
  lang,
  selected,
  onSelect,
  disabled,
}: {
  row: AdminClaimListView;
  lang: 'en' | 'sw';
  selected: boolean;
  onSelect: (claimId: string) => void;
  disabled: boolean;
}) {
  const dispute = presentDisputeState(row.dispute.state, lang);
  return (
    <tr
      className={`border-b border-brand-border last:border-b-0 transition-colors ${
        selected ? 'bg-brand-light-gray/80' : 'hover:bg-brand-light-gray/40'
      }`}
    >
      <th scope="row" className="px-4 py-3 text-left align-top font-normal">
        <button
          type="button"
          onClick={() => onSelect(row.id)}
          disabled={disabled}
          aria-label={lang === 'sw' ? `Fungua claim ${row.id}` : `Open claim ${row.id}`}
          className="text-left rounded-md focus-visible:outline-2 focus-visible:outline-accent-orange disabled:opacity-60"
        >
          <span className="font-mono text-xs font-bold text-brand-dark-text break-all">{row.id}</span>
          {!row.is_active && (
            <span className="mt-1 block">
              <Badge variant="neutral">{lang === 'sw' ? 'Haifanyi kazi' : 'Inactive'}</Badge>
            </span>
          )}
        </button>
      </th>
      <td className="px-4 py-3 align-top">
        <ClaimStatusBadge status={row.status} lang={lang} />
      </td>
      <td className="px-4 py-3 align-top">
        {row.item ? (
          <span className="flex flex-col gap-1">
            <span className="text-xs text-brand-dark-text">{row.item.category_name_en || row.item.category_id}</span>
            <span className="font-mono text-[11px] text-brand-muted-text break-all">{row.item.id}</span>
            {row.item.is_sensitive_document && (
              <Badge variant="warning" icon={ShieldAlert}>
                {lang === 'sw' ? 'Hati nyeti' : 'Sensitive document'}
              </Badge>
            )}
            {row.item.flagged_for_review && (
              <Badge variant="warning" icon={Flag}>
                {lang === 'sw' ? 'Inahitaji ukaguzi' : 'Flagged for review'}
              </Badge>
            )}
          </span>
        ) : (
          <span className="text-xs text-brand-muted-text">Not available</span>
        )}
      </td>
      <td className="px-4 py-3 align-top">
        <span className="font-mono text-xs text-brand-dark-text">{row.claimant_phone || 'Not available'}</span>
        <span className="mt-0.5 block text-[11px] text-brand-muted-text">
          {lang === 'sw' ? 'Ngazi' : 'Tier'} {row.verification_tier ?? '—'}
        </span>
      </td>
      <td className="px-4 py-3 align-top">
        <ClaimPaymentState hasPaid={row.has_paid} paidAt={row.paid_at} lang={lang} />
      </td>
      <td className="px-4 py-3 align-top">
        {row.dispute.state === 'none' ? (
          <span className="text-xs text-brand-muted-text">{dispute.label}</span>
        ) : (
          <Badge variant={dispute.tone}>{dispute.label}</Badge>
        )}
      </td>
      <td className="px-4 py-3 align-top text-xs text-brand-muted-text whitespace-nowrap">
        {formatTimestamp(row.created_at, lang)}
      </td>
      <td className="px-4 py-3 align-top text-xs text-brand-muted-text whitespace-nowrap">
        {formatTimestamp(row.updated_at, lang)}
      </td>
      <td className="px-2 py-3 align-top">
        <ChevronRight size={16} aria-hidden="true" className="text-brand-muted-text" />
      </td>
    </tr>
  );
}

