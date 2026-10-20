// ADMINISTRATOR MANAGEMENT PANEL (one-time second-admin provisioning UI)
// =======================================================================
// The console-side surface for POST /api/admin/provision-admin — the backend
// committed in 6af77c2. This panel adds NO backend behaviour: it cannot widen
// the one-time gate, cannot mint a session for the account it creates, and
// cannot decide availability for itself (there is deliberately no status
// endpoint — the server's answer to the submission IS the authority).
//
// SEPARATION OF DUTIES — why this exists at all: the payout safeguards
// (initiator/approver attestation) become stronger once a second trusted
// administrator exists, because a protected payout action can then be
// reviewed by a different person than the one who submitted it. Provisioning
// that second account is ONE-TIME by design (db.provisionSecondAdmin closes
// the gate with 409 once a second administrator exists), so this panel says
// so plainly instead of pretending it is a reusable form.
//
// CREDENTIAL HYGIENE, ENFORCED HERE
//   * The temporary password lives in component state only, travels in the
//     POST body via services/adminProvisionAdminApi.ts, and is cleared from
//     state the moment the server answers — success, conflict or closure.
//   * It is never logged, never placed in a URL, and never written to
//     localStorage / sessionStorage / IndexedDB (the console's own admin
//     token mechanism is passed in as a prop; this panel creates no new one).
//   * No error path renders a raw exception: every message the operator sees
//     is a fixed, non-sensitive sentence, and the password can never appear
//     in one.
//   * Success does NOT sign the new administrator in. No token is minted for
//     them, no session is created, and the copy tells the operator their
//     colleague must sign in with their own credentials.
import React, { useRef, useState } from 'react';
import { UserPlus } from 'lucide-react';
import Button from '../../ui/Button';
import Badge from '../../ui/Badge';
import Banner from '../../ui/Banner';
import Input from '../../ui/Input';
import { ICON_SIZE } from '../../ui';
import {
  provisionSecondAdmin,
  validateProvisionAdminForm,
  ProvisionAdminApiError,
  PROVISION_ADMIN_LIMITS,
  type ProvisionAdminFieldErrors,
  type ProvisionedAdminDto,
} from '../../../services/adminProvisionAdminApi';

interface AdministratorManagementPanelProps {
  /** The console's existing admin session token. Without it the panel does
   *  not render at all — provisioning is an authenticated-admin action and
   *  this component is not a way around that. */
  token: string | null;
}

/**
 * The "Administrator Management" card. Self-contained: it owns only its own
 * form state, talks only to services/adminProvisionAdminApi.ts, and renders
 * only within the authenticated Admin Console (see the token gate below).
 */
export default function AdministratorManagementPanel({ token }: AdministratorManagementPanelProps) {
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<ProvisionAdminFieldErrors>({});
  const [formError, setFormError] = useState('');
  // The created account's own server-confirmed identity (whitelisted fields
  // only). null = nothing has been created in this session.
  const [createdAdmin, setCreatedAdmin] = useState<ProvisionedAdminDto | null>(null);
  // The server authoritatively closed the one-time gate (409 with a closure
  // code). Once true the form is gone for good — this panel never reopens it.
  const [closed, setClosed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Double-submit guard #2: a ref flips synchronously, so a second click of a
  // double-click is refused even before React re-renders the disabled button.
  const submittingRef = useRef(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || submittingRef.current) return;

    const errors = validateProvisionAdminForm({ fullName, username, password, confirmPassword });
    setFieldErrors(errors);
    if (errors.fullName || errors.username || errors.password || errors.confirmPassword) {
      return; // client-side refusal; the network is never touched
    }

    submittingRef.current = true;
    setSubmitting(true);
    setFormError('');
    try {
      const admin = await provisionSecondAdmin(token, {
        fullName: fullName.trim(),
        username: username.trim(),
        password,
      });
      // Success: clear EVERY entered value, including the names — the only
      // thing kept is the server's own confirmation, which contains no
      // credentials. The new administrator is told to sign in with their own
      // credentials; this console mints no session for them.
      setCreatedAdmin(admin);
      setFieldErrors({});
      setFullName('');
      setUsername('');
      setPassword('');
      setConfirmPassword('');
    } catch (error) {
      if (error instanceof ProvisionAdminApiError) {
        if (error.kind === 'closed') {
          // The one-time gate has closed (a second administrator now exists,
          // or there is no bootstrap administrator to authorize). Disable the
          // form permanently and say why. Closure is inferred ONLY from this
          // explicit server answer — never from an unrelated network failure.
          setClosed(true);
          setFormError('');
          setFullName('');
          setUsername('');
          setPassword('');
          setConfirmPassword('');
          return;
        }
        if (error.kind === 'conflict') {
          // Username already taken. The gate may still be open, so the form
          // stays usable: the operator corrects the ONE field and retries.
          setFieldErrors({ username: error.message });
          return;
        }
        // validation / unauthorized / forbidden / server / malformed /
        // network — each carries a fixed, non-sensitive sentence.
        setFormError(error.message);
        return;
      }
      // An exception this client did not produce: fixed text only. Nothing
      // about the exception (or the form values) reaches the screen.
      setFormError('Something unexpected went wrong. Nothing was created \u2014 try again, or sign in again if this keeps happening.');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  // AUTHORIZED CONTEXT GATE — without an authenticated admin session token
  // there is no panel: the form cannot render, submit or even explain itself.
  if (!token) return null;

  /** True once the one-time window is spent (closed by the server, or the
   *  account was just created). The form never returns in either case. */
  const gateSpent = closed || createdAdmin !== null;

  return (
    <section
      aria-labelledby="administrator-management-heading"
      className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-2xl p-6 shadow-sm space-y-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h3
          id="administrator-management-heading"
          className="font-extrabold text-caption text-[var(--appearance-text-muted)] uppercase tracking-widest flex items-center gap-2"
        >
          <UserPlus size={ICON_SIZE.ui} aria-hidden="true" />
          {'Administrator Management'}
        </h3>
        <Badge variant={gateSpent ? 'neutral' : 'warning'}>
          {gateSpent ? 'One-time window spent' : 'One-time action'}
        </Badge>
      </div>

      {closed && (
        <Banner kind="warning">
          {'Provisioning is closed: a second administrator already exists (or there is no bootstrap administrator left to authorize it), so this one-time action is no longer available. It can never be repeated.'}
        </Banner>
      )}
      {formError && <Banner kind="error">{formError}</Banner>}
      {createdAdmin && (
        <Banner kind="success">
          <span className="space-y-1 block">
            <span className="block">
              {`Second administrator "${createdAdmin.username}" has been created.`}
            </span>
            <span className="block">
              {'They must sign in with their OWN username and the initial password you set for them \u2014 this console does not sign them in, and no session was created for that account. The initial password is not stored or shown here again; hand it over through a secure channel.'}
            </span>
          </span>
        </Banner>
      )}

      <p className="text-body text-[var(--appearance-text-muted)]">
        {'Create a second trusted administrator so protected payout actions can be reviewed and approved by a different person than the one who submitted them \u2014 the separation of duties the two-administrator payout safeguards rely on.'}
      </p>
      <p className="text-body text-[var(--appearance-text-muted)]">
        {'This is a one-time action: the platform permits it only while exactly one administrator exists, and only that bootstrap administrator may run it. There is no availability check \u2014 the server decides authoritatively when you submit, and the form closes permanently once a second administrator exists.'}
      </p>

      {!gateSpent && (
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <Input
            id="provision-admin-full-name"
            label={'New administrator\u2019s full name'}
            type="text"
            autoComplete="off"
            maxLength={PROVISION_ADMIN_LIMITS.fullName}
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            error={fieldErrors.fullName}
            required
          />
          <Input
            id="provision-admin-username"
            label={'New administrator\u2019s username'}
            type="text"
            autoComplete="off"
            maxLength={PROVISION_ADMIN_LIMITS.username}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            error={fieldErrors.username}
            required
          />
          <Input
            id="provision-admin-password"
            label="Temporary initial password"
            type="password"
            autoComplete="new-password"
            maxLength={PROVISION_ADMIN_LIMITS.password}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={fieldErrors.password}
            hint="Shared with the new administrator out of band; they can change it after signing in."
            required
          />
          <Input
            id="provision-admin-confirm-password"
            label="Confirm temporary password"
            type="password"
            autoComplete="new-password"
            maxLength={PROVISION_ADMIN_LIMITS.password}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            error={fieldErrors.confirmPassword}
            required
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" loading={submitting} disabled={submitting}>
              {'Create second administrator'}
            </Button>
          </div>
          <p className="text-caption text-[var(--appearance-text-muted)]">
            {'The password travels only in this request and is never kept by the console \u2014 not in this browser, not in a link, not in a log.'}
          </p>
        </form>
      )}
    </section>
  );
}
