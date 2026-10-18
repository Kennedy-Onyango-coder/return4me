import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle, Loader2, ShieldCheck } from 'lucide-react';
import Button from '../ui/Button';
import { agentApi } from '../../services/agentApi';
import { resolveAgentPayoutOutcomeNotice } from '../../config/agentPayoutVerification';
import type { AgentPayoutChangeView, AgentPayoutSettingsResponse } from '../../types/agent';

/**
 * AGENT DASHBOARD BATCH 2 — PAYOUT SETTINGS.
 *
 * WHAT THIS CARD MAY SAY
 * ----------------------
 * The server sends a MASKED destination only, so this component has no access
 * to the full number and no way to display one. It never says a code was sent
 * and never labels the current number "verified": `phone_ownership_verified` is
 * true only when an ACTIVATED change recorded a real phone attestation, which
 * cannot happen while no delivery channel is configured.
 *
 * A SUBMITTED NUMBER IS A REQUEST, NOT A SETTING
 * ----------------------------------------------
 * The form submits a proposal. Until the request has BOTH real phone
 * verification and administrator approval, the current active destination is
 * untouched — and the copy below says so explicitly rather than implying the
 * change took effect.
 *
 * SELF-CONTAINED BY DESIGN
 * ------------------------
 * AgentHub is deliberately hook-free and fetch-free (tests pin that), so this
 * card owns its own data loading and is mounted by AgentView beside the Hub.
 *
 * VISIBLE OUTCOMES (MEDIUM-2)
 * ---------------------------
 * The server's `pending_request` is live-only, so a rejection used to vanish
 * the moment it was recorded. `latest_request` carries the newest request of
 * ANY state, and PayoutChangeOutcomePanel renders rejected / expired / activated
 * outcomes — including the administrator's reason, verbatim and unmasked-by-us
 * (the destination beside it is still the MASKED value).
 */

const STATUS_LABELS: Record<string, string> = {
  pending_verification: 'Awaiting phone verification',
  pending_admin_approval: 'Awaiting administrator approval',
  ready_to_activate: 'Ready to activate',
  activated: 'Active',
  rejected: 'Rejected',
  expired: 'Expired',
};

const OUTCOME_STYLES: Record<string, { border: string; text: string }> = {
  rejected: { border: 'var(--appearance-danger)', text: 'var(--appearance-danger)' },
  expired: { border: 'var(--appearance-warning)', text: 'var(--appearance-text-primary)' },
  activated: { border: 'var(--appearance-success)', text: 'var(--appearance-success)' },
};

/**
 * MEDIUM-2 — THE TERMINAL OUTCOME OF AN AGENT'S OWN REQUEST.
 *
 * Pure, hook-free and data-driven: it renders only the MASKED view the server
 * sent, so it cannot display a full number even if one reached component state.
 * Kept free of effects so this repository's node-only vitest environment can
 * render it with `react-dom/server` and assert what an agent actually reads,
 * including the administrator's rejection reason.
 */
export function PayoutChangeOutcomePanel({ request }: { request: AgentPayoutChangeView }) {
  const notice = resolveAgentPayoutOutcomeNotice(request);
  if (!notice) return null;

  const style = OUTCOME_STYLES[notice.kind];
  const Icon = notice.kind === 'activated' ? CheckCircle : notice.kind === 'rejected' ? AlertCircle : ShieldCheck;

  return (
    <div
      role="status"
      aria-live="polite"
      data-outcome={notice.kind}
      className="space-y-2 rounded-standard border bg-[var(--appearance-surface-muted)] p-4"
      style={{ borderColor: style.border }}
    >
      <p className={`text-caption font-extrabold uppercase tracking-widest`} style={{ color: style.text }}>
        {notice.title}
      </p>

      <div className="flex items-start gap-2">
        <Icon size={18} className="mt-0.5 shrink-0" style={{ color: style.text }} aria-hidden={true} />
        <div className="flex-1 space-y-1">
          <p className="text-small font-semibold text-[var(--appearance-text-primary)]">{notice.message}</p>
          <p className="text-caption font-semibold text-[var(--appearance-text-muted)]">
            {'Proposed: '}
            <span className="font-mono">{request.masked_proposed_destination}</span>
          </p>
          {notice.reason && (
            <p className="text-caption font-semibold" style={{ color: 'var(--appearance-danger)' }}>
              {'Reason given by the administrator: '}
              <span>{notice.reason}</span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function PayoutSettingsCard({ token }: { token: string }) {
  const [settings, setSettings] = useState<AgentPayoutSettingsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [proposed, setProposed] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submitNotice, setSubmitNotice] = useState('');

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setLoadError('');
    try {
      setSettings(await agentApi.getPayoutSettings(token));
    } catch (e: any) {
      setLoadError(e?.message || 'Could not load payout settings.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    const value = proposed.trim();
    if (!value) {
      setSubmitError('Enter the Personal M-Pesa number you want to use.');
      return;
    }

    setSubmitting(true);
    setSubmitError('');
    setSubmitNotice('');
    try {
      const result = await agentApi.requestPayoutDestinationChange(token, value);
      setSettings((currentSettings) =>
        currentSettings ? { ...currentSettings, pending_request: result.request } : currentSettings,
      );
      // The full number is cleared from component state as soon as the request
      // is recorded; it is never displayed back.
      setProposed('');
      setSubmitNotice(result.message);
      await load();
    } catch (e: any) {
      setSubmitError(e?.message || 'Could not submit the payout destination change.');
    } finally {
      setSubmitting(false);
    }
  };

  const verification = settings?.verification;
  const verificationUnavailable = verification?.verification_available === false;
  const pending = settings?.pending_request ?? null;
  const current = settings?.payout;
  // MEDIUM-2 — the newest request may be a FINISHED one (rejected, expired or
  // activated). It is rendered only when it is not the live request already
  // shown above, so a terminal outcome never disappears and never doubles up.
  const latest = settings?.latest_request ?? null;
  const latestOutcome = latest && (!pending || latest.id !== pending.id) ? latest : null;

  return (
    <section
      aria-labelledby="agent-payout-settings-heading"
      className="space-y-4 rounded-panel border border-[var(--appearance-border)] bg-[var(--appearance-surface)] p-6 shadow-raised"
    >
      <div className="space-y-1">
        <h2
          id="agent-payout-settings-heading"
          className="text-subsection font-extrabold text-[var(--appearance-text-primary)]"
        >
          Payout settings
        </h2>
        <p className="max-w-2xl text-small text-[var(--appearance-text-muted)]">
          Your payout destination is where Return4me sends your commission. Changing it is a reviewed process:
          a new number is never used until its ownership has been verified by phone and an administrator has
          approved the change.
        </p>
      </div>

      {loading && !settings && (
        <p className="flex items-center gap-2 text-small font-semibold text-[var(--appearance-text-muted)]">
          <Loader2 className="animate-spin" size={16} aria-hidden={true} />
          {'Loading your payout settings…'}
        </p>
      )}

      {loadError && (
        <div
          role="alert"
          aria-live="assertive"
          className="flex items-start gap-2 rounded-standard border border-[var(--appearance-danger)] bg-[var(--appearance-surface-muted)] px-4 py-3 text-small font-semibold text-[var(--appearance-danger)]"
        >
          <AlertCircle size={18} className="mt-0.5 shrink-0" aria-hidden={true} />
          <span className="flex-1">{loadError}</span>
          <button type="button" onClick={() => void load()} className="font-bold underline">
            {'Retry'}
          </button>
        </div>
      )}

      {current && (
        <div className="rounded-standard border border-[var(--appearance-border)] bg-[var(--appearance-surface-muted)] p-4">
          <p className="text-caption font-extrabold uppercase tracking-widest text-[var(--appearance-text-muted)]">
            {'Current payout destination (in use)'}
          </p>
          <p className="mt-1 text-body font-extrabold text-[var(--appearance-text-primary)]">
            {current.method} · <span className="font-mono">{current.masked_destination}</span>
          </p>
          <p className="mt-1 text-caption font-semibold text-[var(--appearance-text-muted)]">
            {current.eligible
              ? 'This number passes the personal M-Pesa format and method check. That is a format check only — it does not confirm who owns the number.'
              : 'This stored destination does not pass the personal M-Pesa format and method check, so a payout to it would be refused. You can request a supported Personal M-Pesa number below.'}
          </p>
          <p className="mt-1 text-caption font-semibold text-[var(--appearance-text-muted)]">
            {current.phone_ownership_verified
              ? 'Phone ownership was verified when this destination was activated.'
              : 'There is no verified phone-ownership record for this destination.'}
          </p>
        </div>
      )}

      {verification && (
        <div className="flex items-start gap-2 rounded-standard border border-[var(--appearance-warning)] bg-[var(--appearance-surface-muted)] px-4 py-3 text-small font-semibold text-[var(--appearance-text-primary)]">
          <ShieldCheck size={18} className="mt-0.5 shrink-0" aria-hidden={true} />
          <div className="space-y-1">
            <p>{verification.message}</p>
            {verificationUnavailable && (
              <p className="text-caption text-[var(--appearance-text-muted)]">
                {'No verification code was sent, and none will be until a delivery channel is configured.'}
              </p>
            )}
          </div>
        </div>
      )}

      {pending && (
        <div className="space-y-2 rounded-standard border border-[var(--appearance-border)] bg-[var(--appearance-surface-muted)] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-caption font-extrabold uppercase tracking-widest text-[var(--appearance-text-muted)]">
              {'Pending change request'}
            </p>
            <span className="rounded-full border border-[var(--appearance-border)] bg-[var(--appearance-surface)] px-3 py-1 text-caption font-extrabold text-[var(--appearance-text-primary)]">
              {STATUS_LABELS[pending.status] ?? pending.status}
            </span>
          </div>

          <p className="text-body font-extrabold text-[var(--appearance-text-primary)]">
            {'Proposed: '}
            <span className="font-mono">{pending.masked_proposed_destination}</span>
          </p>

          <dl className="grid grid-cols-1 gap-1 text-caption font-semibold text-[var(--appearance-text-primary)] sm:grid-cols-3">
            <div>
              <dt className="text-[var(--appearance-text-muted)]">{'Format check'}</dt>
              <dd>{pending.destination_format_eligible ? 'Passed (format only)' : 'Failed'}</dd>
            </div>
            <div>
              <dt className="text-[var(--appearance-text-muted)]">{'Phone ownership'}</dt>
              <dd>{pending.phone_verification === 'verified' ? 'Verified' : 'Not verified'}</dd>
            </div>
            <div>
              <dt className="text-[var(--appearance-text-muted)]">{'Administrator approval'}</dt>
              <dd>
                {pending.admin_approval === 'approved'
                  ? 'Approved'
                  : pending.admin_approval === 'rejected'
                    ? 'Rejected'
                    : 'Not decided'}
              </dd>
            </div>
          </dl>

          {pending.rejection_reason && (
            <p className="text-caption font-semibold text-[var(--appearance-danger)]">
              {'Reason: '}
              {pending.rejection_reason}
            </p>
          )}

          <p className="text-caption font-semibold text-[var(--appearance-text-muted)]">
            {'This request cannot become active until its ownership has been verified by phone AND an administrator has approved it. Your current destination stays in use until then.'}
          </p>

          {pending.can_activate && (
            <p className="text-caption font-bold text-[var(--appearance-success)]">
              {'Both requirements are recorded. This change is ready to activate.'}
            </p>
          )}
        </div>
      )}

      {latestOutcome && <PayoutChangeOutcomePanel request={latestOutcome} />}

      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="space-y-1">
          <label
            htmlFor="agent-payout-proposed-number"
            className="block text-body font-extrabold text-[var(--appearance-text-primary)]"
          >
            {'Propose a replacement Personal M-Pesa number'}
          </label>
          <p id="agent-payout-proposed-number-hint" className="text-caption text-[var(--appearance-text-muted)]">
            {'Enter the Kenyan mobile number that should receive your commission, for example 0712 345 678. Submitting records a request only — it does not change the number in use.'}
          </p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="agent-payout-proposed-number"
            name="payoutDestination"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={proposed}
            onChange={(event) => setProposed(event.target.value)}
            placeholder={'07XX XXX XXX'}
            aria-describedby="agent-payout-proposed-number-hint"
            disabled={submitting}
            className="min-h-11 flex-1 rounded-standard border border-[var(--appearance-border)] bg-[var(--appearance-surface)] px-3 py-2 font-mono text-body text-[var(--appearance-text-primary)] focus:border-[var(--appearance-focus)] disabled:opacity-60"
          />
          <Button type="submit" variant="primary" size="md" disabled={submitting} aria-busy={submitting}>
            {submitting ? (
              <Loader2 className="animate-spin" size={16} aria-hidden={true} />
            ) : (
              <span>{'Submit change request'}</span>
            )}
          </Button>
        </div>

        <p className="text-caption font-semibold text-[var(--appearance-text-muted)]">
          {'Only the Personal M-Pesa payout method is supported. Till Number, Paybill Number and Pochi la Biashara requests are refused.'}
        </p>

        {submitNotice && (
          <div
            role="status"
            aria-live="polite"
            className="flex items-start gap-2 rounded-standard border border-[var(--appearance-success)] bg-[var(--appearance-surface-muted)] px-4 py-3 text-small font-semibold text-[var(--appearance-success)]"
          >
            <CheckCircle size={18} className="mt-0.5 shrink-0" aria-hidden={true} />
            <span className="flex-1">{submitNotice}</span>
          </div>
        )}

        {submitError && (
          <div
            role="alert"
            aria-live="assertive"
            className="flex items-start gap-2 rounded-standard border border-[var(--appearance-danger)] bg-[var(--appearance-surface-muted)] px-4 py-3 text-small font-semibold text-[var(--appearance-danger)]"
          >
            <AlertCircle size={18} className="mt-0.5 shrink-0" aria-hidden={true} />
            <span className="flex-1">{submitError}</span>
            <button
              type="button"
              onClick={() => setSubmitError('')}
              aria-label={'Dismiss error'}
              className="shrink-0 px-1 font-bold leading-none hover:opacity-80"
            >
              ×
            </button>
          </div>
        )}
      </form>
    </section>
  );
}
