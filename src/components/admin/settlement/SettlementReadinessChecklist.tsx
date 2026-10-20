import React from 'react';
import { AlertCircle, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import type { SettlementReadinessView } from './settlementReadiness';

/**
 * PHASE 3 — Pending Settlement readiness checklist.
 *
 * PURE and data-driven: it renders exactly the conditions the server returned
 * from GET /api/admin/claims/:id/settlement-readiness. It never computes a
 * readiness decision of its own and never promises that a payout is possible.
 * The Initiate control stays disabled while the server says `ready === false`
 * (or before a check has succeeded), and the initiation route re-decides every
 * condition regardless.
 */

export type { SettlementReadinessView, SettlementReadinessConditionView } from './settlementReadiness';

export default function SettlementReadinessChecklist({
  readiness,
  loading = false,
  error = null,
}: {
  readiness: SettlementReadinessView | null;
  loading?: boolean;
  error?: string | null;
}) {
  if (loading && !readiness) {
    return (
      <p className="flex items-center gap-2 text-caption font-semibold text-[var(--appearance-text-muted)]">
        <Loader2 className="animate-spin" size={14} aria-hidden={true} />
        {'Checking payout readiness…'}
      </p>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-standard border border-[var(--appearance-warning)] bg-[var(--appearance-surface-muted)] px-3 py-2 text-caption font-semibold text-[var(--appearance-text-primary)]"
      >
        <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden={true} />
        <span>{`Readiness could not be checked: ${error}. The server still decides every condition when you initiate.`}</span>
      </div>
    );
  }

  if (!readiness) return null;

  const failing = readiness.conditions.filter((condition) => !condition.ok);

  return (
    <div
      className="space-y-2 rounded-standard border border-[var(--appearance-border)] bg-[var(--appearance-surface)] p-3"
      data-readiness={readiness.ready ? 'ready' : 'blocked'}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-caption font-extrabold uppercase tracking-widest text-[var(--appearance-text-muted)]">
          {'Payout readiness'}
        </p>
        <p
          className={`text-caption font-extrabold ${
            readiness.ready ? 'text-[var(--appearance-success)]' : 'text-[var(--appearance-danger)]'
          }`}
        >
          {readiness.ready
            ? 'All local checks pass'
            : `${failing.length} condition${failing.length === 1 ? '' : 's'} must be resolved`}
        </p>
      </div>

      {readiness.ready ? (
        <p className="text-caption font-semibold text-[var(--appearance-text-muted)]">
          {'These checks use existing database and configuration state only. They do not contact the provider, read a wallet balance, or prove that a payout will succeed. The server re-checks everything on initiation.'}
        </p>
      ) : (
        <p className="text-caption font-semibold text-[var(--appearance-text-muted)]">
          {'Initiation is disabled while a condition below fails. The server re-checks every condition and would refuse the payout even if this browser control were bypassed.'}
        </p>
      )}

      <ul className="space-y-1.5">
        {readiness.conditions.map((condition) => {
          const Icon = condition.ok ? CheckCircle2 : XCircle;
          return (
            <li key={condition.code} className="flex items-start gap-2 text-caption">
              <Icon
                size={15}
                className={`mt-0.5 shrink-0 ${
                  condition.ok
                    ? 'text-[var(--appearance-success)]'
                    : 'text-[var(--appearance-danger)]'
                }`}
                aria-hidden={true}
              />
              <div className="min-w-0 space-y-0.5">
                <p className="font-bold text-[var(--appearance-text-primary)]">
                  {condition.label}
                  <span className="ml-1.5 font-mono text-[var(--appearance-text-muted)]">
                    {condition.ok ? '' : `[${condition.code}]`}
                  </span>
                </p>
                {!condition.ok && condition.detail && (
                  <p className="font-semibold text-[var(--appearance-text-muted)]">{condition.detail}</p>
                )}
                {!condition.ok && condition.next_action && (
                  <p className="font-bold text-[var(--appearance-text-primary)]">
                    {`Next: ${condition.next_action}`}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
