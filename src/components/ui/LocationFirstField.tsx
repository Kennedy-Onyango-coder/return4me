import React from 'react';
import { MapPin, Loader2 } from 'lucide-react';
import { ICON_SIZE } from './iconSize';
import Button from './Button';

// LOCATION-FIRST FIELD (Phase 2 — location-first ordering on every applicable
// form). The shared shell that guarantees the required interaction order on
// any form that asks for a location:
//
//   1. "Use my location" / "Turn location on" action (browser permission is
//      requested ONLY when the user deliberately presses it — the button's
//      onClick is the caller's detect handler, never an effect).
//   2. A clear explanation of WHY permission is requested.
//   3. A concise success / loading / unavailable / permission-denied state
//      (the caller passes the live status text and loading flag).
//   4. An "OR ENTER MANUALLY" divider.
//   5. The County selector and 6. the Sub-county selector — supplied as
//      `children`, so each form keeps its own state, handlers and validation.
//
// This component owns NO geography state and calls NO service. It only orders
// and presents what the caller already owns, so the shared GPS contract in
// services/browserLocation.ts and each form's county/sub-county logic are
// untouched. It is fully localisable: every string is a bilingual pair.

export interface LocationFirstFieldProps {
  /** Bilingual label for the location action, e.g. ['Use my location', 'Tumia eneo languo']. */
  actionLabel: [string, string];
  /** Why permission is requested, shown as the explanation above the action. */
  explanation: [string, string];
  /** Live status line (loading text, success, denial, unavailable…). Optional. */
  statusMessage?: string;
  /** True while coordinates are being obtained — drives the button spinner. */
  loading?: boolean;
  /** True once a location has been captured, to switch the success copy on. */
  detected?: boolean;
  /** Invoked ONLY when the user presses the action. Never called on mount. */
  onDetect: () => void;
  /** The County and Sub-county selectors, rendered after the divider. */
  children: React.ReactNode;
  /** Optional id for the wrapping region, so tests can assert DOM order. */
  id?: string;
}

export default function LocationFirstField({
  actionLabel,
  explanation,
  statusMessage,
  loading = false,
  detected = false,
  onDetect,
  children,
  id,
}: LocationFirstFieldProps) {
  return (
    <div id={id} className="space-y-3" data-testid="location-first-field">
      {/* 1–3. The location action, its explanation, and its live status — all
          BEFORE the manual selectors, both visually and in the DOM. */}
      <div className="rounded-standard border border-[var(--appearance-border)] bg-[var(--appearance-surface-muted)] p-4 space-y-3">
        <div className="flex gap-2.5">
          <MapPin size={ICON_SIZE.emphasis} aria-hidden="true" className="text-[var(--appearance-accent)] shrink-0 mt-0.5" />
          <div className="space-y-1">
            <h4 className="text-caption font-bold text-[var(--appearance-text-primary)] leading-none">
              {actionLabel[0]}
              <span className="sr-only"> / {actionLabel[1]}</span>
            </h4>
            <p className="text-caption text-[var(--appearance-text-muted)] leading-normal">
              {explanation[0]}
              <span className="sr-only"> {explanation[1]}</span>
            </p>
          </div>
        </div>

        <Button
          type="button"
          variant="accent"
          size="md"
          className="w-full"
          onClick={onDetect}
          loading={loading}
          loadingLabel={actionLabel[1]}
          data-testid="location-action"
        >
          {loading ? null : <MapPin size={ICON_SIZE.ui} aria-hidden="true" />}
          <span>{loading ? actionLabel[1] : actionLabel[0]}</span>
        </Button>

        {/* 3. Concise, honest status. `detected` flips the tone to success. */}
        {statusMessage ? (
          <p
            role="status"
            aria-live="polite"
            data-testid="location-status"
            className={`text-caption leading-normal ${detected ? 'text-[var(--appearance-text-primary)]' : 'text-[var(--appearance-text-muted)]'}`}
          >
            {statusMessage}
          </p>
        ) : null}
      </div>

      {/* 4. The manual-entry divider. */}
      <div className="flex items-center gap-3" aria-hidden="true">
        <span className="h-px flex-1 bg-[var(--appearance-border)]" />
        <span className="text-caption font-bold uppercase tracking-wider text-[var(--appearance-text-muted)]">
          Or enter manually
        </span>
        <span className="h-px flex-1 bg-[var(--appearance-border)]" />
      </div>

      {/* 5–6. County and Sub-county, supplied by the caller. */}
      <div className="space-y-3" data-testid="manual-location-fields">
        {children}
      </div>
    </div>
  );
}
