import React, { useEffect, useRef, useState } from 'react';
import { Button, Banner, Spinner } from './ui';

// =============================================================================
// N4 — /activate-agent-email  (public AGENT email-activation landing page)
// =============================================================================
// THIS IS THE LANDING PAGE FOR THE AGENT LINK THE BACKEND EMAILS. The path and
// the `?token=` parameter are fixed by buildAgentActivationUrl() in
// services/customerAuth.ts — this component does not get to choose either.
//
// WHY THIS IS A SEPARATE COMPONENT FROM CustomerActivationView, RATHER THAN A
// PROP ON IT
//   The two flows are NOT the same flow with different copy, and pretending
//   otherwise would produce a page that lies. A customer activation ends with
//   the customer SIGNED IN — the endpoint set a session cookie. An agent
//   activation ends with the agent merely VERIFIED, still unable to touch a
//   single protected agent route, and quite possibly still 'pending'. One
//   component parameterised by a flag would need every success branch to ask
//   "which of these am I?", and the wrong answer on the success path sends a
//   freshly-verified, unapproved applicant into the Agent Hub, where every
//   request 403s.
//
//   What IS shared, deliberately: the token-handling security model below, the
//   StrictMode ref guard, the primitives (Button/Banner/Spinner), the appearance
//   tokens, the bilingual copy convention and the accessibility contract. Those
//   are reproduced exactly, not abstracted, because a shared hook would be the
//   wrong abstraction while the two endpoints still differ in what they are
//   permitted to change.
//
// WHAT THIS PAGE DELIBERATELY DOES NOT DO
//   - It never creates, stores or fabricates a session. POST
//     /api/agents/activate issues NO session at all, by design: verifying a
//     mailbox is not the same as being approved to operate, and the only thing
//     that grants operational authority is requireActiveAgent re-evaluating
//     isAgentActionable() on every protected request.
//   - It never persists the token. No localStorage, no sessionStorage, no
//     cookie, no IndexedDB, no analytics, no console output, no document title,
//     no React state. The token is read from the URL exactly once, inside the
//     request effect, and is not even held in a state variable — the component's
//     state records only the OUTCOME, never the credential.
//   - It never displays the token, and never splits the backend's single generic
//     failure into distinguishable cases, which would recreate the token oracle
//     the backend refuses to expose.
//
// NO RESEND
//   There is no resend-activation endpoint in the product, so there is
//   deliberately no resend button here. Inventing one would be a control that
//   silently does nothing.

interface Props {
  /** Hands off to the EXISTING agent sign-in surface. */
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
 * Outcome states.
 *
 * Note that success is SPLIT IN TWO, unlike the customer page. The backend
 * returns `operational`, which is its own isAgentActionable() verdict, and the
 * difference is the entire point of N4:
 *
 *   verifiedAndOperational -> approved AND verified: genuinely ready to work
 *   verifiedPending        -> email proven, business approval still outstanding
 *
 * Collapsing these into one "success" would tell an unapproved applicant their
 * application is complete and send them to a hub that refuses every request.
 */
type ActivationState =
  | 'working'
  | 'verifiedAndOperational'
  | 'verifiedPending'
  | 'invalid'
  | 'unavailable';

export default function AgentActivationView({ onSignIn, onExit, hasToken }: Props) {



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
        const res = await fetch('/api/agents/activate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ token: rawToken }),
        });
        if (cancelled) return;
        if (res.ok) {
          // Take the SERVER's word for how much this unlocked. `operational` is
          // the backend's own authorization predicate, not a client-side
          // inference, so this page can never claim more access than the
          // server would actually grant on the next protected request.
          const body = (await res.json().catch(() => null)) as { operational?: boolean } | null;
          setState(body && body.operational === true ? 'verifiedAndOperational' : 'verifiedPending');
          return;
        }
        if (res.status === 400) {
          // The backend's single generic failure: invalid, expired, or already
          // used. Deliberately rendered as ONE message — splitting them here
          // would recreate the token oracle the backend refuses to expose.
          setState('invalid');
          return;
        }
        // Rate limited (429) or a server fault (5xx). Neither means the email
        // was verified, so this must NOT be shown as success.
        setState('unavailable');
      } catch {
        // Network failure. Verification may or may not have happened; the only
        // safe thing to say is that we could not complete it.
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
          size={26}
          label={'Verifying your agent email'}
          className="text-primary-green"
        />
      </div>
    );
  }

  const verified = state === 'verifiedAndOperational' || state === 'verifiedPending';
  // The single most important distinction on this page: email proven is NOT the
  // same as approved to operate.
  const operational = state === 'verifiedAndOperational';
  const invalid = state === 'invalid';
  // 'unavailable' is the only state that is genuinely retryable, and the only
  // one where a second attempt could plausibly help.
  const retryable = state === 'unavailable';
  return (
    <div className="w-full flex-grow flex items-start justify-center px-4 py-8 sm:py-12">
      <div className="w-full max-w-md space-y-4">
        {/* aria-labelledby points the landmark at the heading, so a screen reader
            announces WHICH outcome this is rather than just "region". The heading
            is the single element that changes between states. */}
        <div
          role="region"
          aria-labelledby="agent-activation-title"
          className="bg-white border border-brand-border rounded-2xl p-5 sm:p-6"
        >
          <p className="text-caption font-extrabold uppercase tracking-widest text-brand-muted-text">
            {'Return4me agent'}
          </p>
          <h1 id="agent-activation-title" className="mt-1 text-xl sm:text-2xl font-extrabold tracking-tight text-brand-dark-text">
            {operational
              ? 'Your agent email is verified'
              : verified
                ? 'Your email is verified'
                : invalid
                  ? 'This activation link cannot be used'
                  : 'We could not verify your email'}
          </h1>

          {/* Announced to assistive tech by the shared Banner primitives:
              success/info are polite status, errors and warnings are assertive
              alerts. The outcome is never signalled by colour alone — each
              state carries a distinct icon and distinct wording. */}
          {operational && (
            <Banner kind="success" className="mt-4">
              {'Your email address is verified and your agent account is approved. You can now sign in and start work.'}
            </Banner>
          )}

          {verified && !operational && (
            <Banner kind="info" className="mt-4">
              {'Your email address is verified. Your application is still awaiting administrator approval, and you will be able to work once that is complete. Verifying your email does not approve your application by itself.'}
            </Banner>
          )}

          {invalid && (
            <Banner kind="error" className="mt-4">
              {'This activation link is incomplete, has already been used, or has expired. For your security, an activation link can only be used once.'}
            </Banner>
          )}

          {retryable && (
            <Banner kind="warning" className="mt-4">
              {'We could not reach Return4me to complete the verification. Your email has not been verified yet.'}
            </Banner>
          )}

          <p className="mt-4 text-sm text-brand-muted-text leading-relaxed">
            {verified
              ? 'You can go to agent sign in now, or continue to Return4me.'
              : invalid
                ? 'If you have just applied to be an agent, open the activation email on this device and use the link in it.'
                : 'Please try again in a moment. If it keeps failing, open the activation email on this device and use the link in it again.'}
          </p>

          <div className="mt-5 space-y-2">
            <Button type="button" variant="primary" size="lg" className="w-full" onClick={onSignIn}>
              {'Go to agent sign in'}
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

