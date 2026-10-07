import React, { useEffect, useRef, useState } from 'react';
import { Button, Banner, ICON_SIZE, Spinner } from './ui';

// =============================================================================
// N3 — /activate-email  (public customer email-activation landing page)
// =============================================================================
// THIS IS THE LANDING PAGE FOR THE LINK THE BACKEND EMAILS. The path and the
// `?token=` parameter are fixed by buildCustomerActivationUrl() in
// services/customerAuth.ts — this component does not get to choose either.
//
// WHAT THIS PAGE DELIBERATELY DOES NOT DO
//   - It never creates, stores or fabricates a session. POST
//     /api/customer/activate is the ONLY thing that can set the customer
//     session cookie, and it does so server-side after the token has been
//     atomically consumed. This page simply refrains from claiming otherwise.
//   - It never persists the token. No localStorage, no sessionStorage, no
//     cookie, no analytics, no console output, no state. The token is read
//     from the URL exactly once, inside the request effect, and is not even
//     held in a React state variable — the component's state records only the
//     OUTCOME, never the credential.
//   - It never displays the token. Nothing here echoes it back, and no error
//     copy distinguishes an unknown token from an expired or an already-used
//     one, because the backend deliberately returns one generic failure for
//     all of them and a smarter message here would re-open the token oracle
//     the backend just closed.
//
// EVERY DECISION IS STILL THE BACKEND'S
//   Validity, expiry, single-use consumption, account activation and session
//   creation all happen server-side. This page maps HTTP outcomes to copy; it
//   never decides that an account is activated.
//
// NO RESEND
//   There is no resend-activation endpoint in the product yet (N3 audit), so
//   there is deliberately no resend button here. Inventing one would be a fake
//   control that silently does nothing.

interface Props {
  /** Hands off to the EXISTING /account sign-in surface. */
  onSignIn: () => void;
  /** Returns to the public home surface. */
  onExit: () => void;
  /**
   * Whether the URL carried a token at all. Supplied by App from the parsed
   * route, which knows only presence — never the value.
   */
  hasToken: boolean;
}

/**
 * Outcome states. `working` covers the request; `invalid` covers EVERY
 * unusable-token case the backend collapses into one generic 400 (unknown,
 * wrong purpose, wrong account type, already consumed, expired) plus a link
 * that arrived with no token at all; `unavailable` is the retry-safe
 * transport/server failure.
 */
type ActivationState = 'working' | 'activated' | 'invalid' | 'unavailable';

export default function CustomerActivationView({ onSignIn, onExit, hasToken }: Props) {



  const [state, setState] = useState<ActivationState>('working');
  // A ref, not state: the token is used for exactly one request and must not
  // trigger a re-render, land in a snapshot, or be readable by anything that
  // inspects this component's rendered output.
  const attempted = useRef(false);

  useEffect(() => {
    // React StrictMode runs effects twice in development. The token is
    // single-use server-side, so a second redemption would be reported as a
    // failure to the user who legitimately just succeeded. One attempt only.
    if (attempted.current) return;
    attempted.current = true;

    // No token in the URL: the link is incomplete. Say so without calling the
    // API — there is nothing to redeem, and firing a request would only invite
    // a pointless 400.
    if (!hasToken) {
      setState('invalid');
      return;
    }

    let cancelled = false;
    (async () => {
      // Read the credential at the last possible moment, straight from the
      // location, and hand it straight to the backend. It is not stored.
      const rawToken = (new URLSearchParams(window.location.search).get('token') || '').trim();
      if (!rawToken) {
        if (!cancelled) setState('invalid');
        return;
      }
      try {
        const res = await fetch('/api/customer/activate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ token: rawToken }),
        });
        if (cancelled) return;
        if (res.ok) {
          // The server has activated the account AND set the session cookie.
          // There is no second confirmation step to invent.
          setState('activated');
          return;
        }
        if (res.status === 400) {
          // The backend's single generic failure: invalid, expired, or already
          // used. Deliberately rendered as ONE message — splitting them here
          // would recreate the token oracle the backend refuses to expose.
          setState('invalid');
          return;
        }
        // Rate limited (429) or a server fault (5xx). Neither means the account
        // was activated, so this must NOT be shown as success.
        setState('unavailable');
      } catch {
        // Network failure. The activation may or may not have happened; the
        // only safe thing to say is that we could not complete it.
        if (!cancelled) setState('unavailable');
      }
    })();
    return () => { cancelled = true; };
  }, [hasToken]);

  // ---------------- WORKING ----------------
  if (state === 'working') {
    return (
      <div className="flex-grow flex items-center justify-center w-full py-24">
        <Spinner
          size={ICON_SIZE.feature}
          label={'Activating your account'}
          className="text-[var(--appearance-primary)]"
        />
      </div>
    );
  }

  const activated = state === 'activated';
  const invalid = state === 'invalid';
  // 'unavailable' is the only state that is genuinely retryable, and the only
  // one where a second attempt could plausibly help.
  const retryable = state === 'unavailable';
  return (
    <div className="w-full flex-grow flex items-start justify-center px-4 py-8 sm:py-12">
      <div className="w-full max-w-md space-y-4">
        <div className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-panel shadow-raised p-5 sm:p-6">
          <p className="text-caption font-extrabold uppercase tracking-widest text-[var(--appearance-text-muted)]">
            {'Return4me account'}
          </p>
          <h1 className="mt-1 text-subsection sm:text-section font-extrabold tracking-tight text-[var(--appearance-text-primary)]">
            {activated
              ? 'Your account is ready'
              : invalid
                ? 'This activation link cannot be used'
                : 'We could not activate your account'}
          </h1>

          {/* Announced to assistive tech by the shared Banner primitives:
              success/info are polite status, errors and warnings are assertive
              alerts. The outcome is never signalled by colour alone — each
              state carries a distinct icon and distinct wording. */}
          {activated && (
            <Banner kind="success" className="mt-4">
              {'Your email address is verified and your account is now active. You are signed in.'}
            </Banner>
          )}

          {invalid && (
            <Banner kind="error" className="mt-4">
              {'This activation link is incomplete, has already been used, or has expired. For your security, an activation link can only be used once.'}
            </Banner>
          )}

          {retryable && (
            <Banner kind="warning" className="mt-4">
              {'We could not reach Return4me to complete the activation. Your account has not been activated yet.'}
            </Banner>
          )}

          <p className="mt-4 text-body-large text-[var(--appearance-text-muted)] leading-relaxed">
            {activated
              ? 'You can go to your account now, or continue to Return4me.'
              : invalid
                ? 'If you have just registered, open the activation email on this device and use the link in it. If you have already activated this account, simply sign in.'
                : 'Please try again in a moment. If it keeps failing, open the activation email on this device and use the link in it again.'}
          </p>

          <div className="mt-5 space-y-2">
            <Button type="button" variant="primary" size="lg" className="w-full" onClick={onSignIn}>
              {'Go to sign in'}
            </Button>
            {retryable && (
              <Button
                type="button"
                variant="ghost"
                size="md"
                className="w-full"
                onClick={() => window.location.reload()}
              >
                {'Try again'}
              </Button>
            )}
            <Button type="button" variant="ghost" size="md" className="w-full" onClick={onExit}>
              {'Back to Return4me'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
