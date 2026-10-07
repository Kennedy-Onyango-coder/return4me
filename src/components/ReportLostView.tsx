import React, { useEffect, useState } from 'react';
import { Loader2, Search, LogIn, ShieldCheck, MapPin } from 'lucide-react';
import { Button } from './ui';
import LostReportsSection from './customer/LostReportsSection';

// =============================================================================
// PHASE 11A — "REPORT A LOST ITEM" (public entry point)
// =============================================================================
// WHY THIS EXISTS
// The Phase 11 forensic audit found that the public navbar's "I Lost
// Something" destination (/lost) renders the CLAIM/TRACK journey only, while
// the actual lost-item reporting experience lived exclusively inside
// /account -> CustomerDashboard -> LostReportsSection. A visitor who had lost
// something therefore had no discoverable way to report it.
//
// This page is that missing entry point. It is deliberately a THIN SHELL: it
// resolves whether a customer session exists and then either
//   (a) renders the EXISTING customer component (LostReportsSection, which owns
//       LostReportWizard) — there is exactly ONE reporting form in this product,
//       not a second divergent one; or
//   (b) states plainly that signing in is required and hands off to the
//       EXISTING authentication boundary (/account) with a validated return
//       path pointing back here.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   - It introduces no authentication of its own. The session check is the same
//     GET /api/customer/me the account surface already performs, and the sign-in
//     hand-off is the same /account?next= mechanism /item/:id already uses.
//   - It posts nothing. Lost-report creation stays customer-authenticated
//     (POST /api/lost-reports behind requireCustomerAuth); this page cannot and
//     does not create a report.
//   - It makes lost reports public. Nothing here is a discovery surface:
//     unauthenticated visitors see no report data at all, and the server has no
//     public lost-report endpoint to call.
//   - It never renders a protected identifier. No document number, hash,
//     session token or OTP is displayed anywhere on this page.

interface Props {
  /** Hands off to the existing /account authentication boundary. */
  onSignIn: () => void;
  /** Opens the public /item/:id page for a possible match. */
  onOpenItem: (itemId: string) => void;
  /** The "something of mine may already have been found" journey (/lost). */
  onBrowseFound: () => void;
}

export default function ReportLostView({ onSignIn, onOpenItem, onBrowseFound }: Props) {



  // Same three-state model the account surface uses: we do not know yet, the
  // server says there is no session, or there is one. `hasSession` is null only
  // while the check is in flight.
  const [hasSession, setHasSession] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/customer/me');
        if (cancelled) return;
        setHasSession(res.ok);
      } catch {
        // The check could not complete. Fail to the SIGN-IN side: a visitor who
        // is actually authenticated can sign in again, whereas rendering the
        // reporting experience on an unverified assumption would be the wrong
        // direction to fail in.
        if (!cancelled) setHasSession(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ---------------- CHECKING ----------------
  if (hasSession === null) {
    return (
      <div className="flex-grow flex items-center justify-center w-full py-24">
        <Loader2 className="animate-spin text-primary-green" size={26} />
      </div>
    );
  }

  // ---------------- SIGNED IN: the existing reporting experience ----------------
  // The very same component the account dashboard mounts. `startInWizard` opens
  // the existing LostReportWizard immediately, so a visitor who clicked
  // "Report a Lost Item" lands on the form rather than on a list they would have
  // to search through.
  if (hasSession) {
    return (
      <section className="w-full" aria-labelledby="report-lost-heading">
        <div className="mb-5">
          <h2 id="report-lost-heading" className="text-xl sm:text-2xl font-bold text-brand-dark-text">
            {'Report a lost item'}
          </h2>
          <p className="mt-1 text-sm text-brand-muted-text leading-relaxed max-w-2xl">
            {'Tell us what you lost and where. We compare your report with found items that are eligible to be claimed, and show you anything that looks similar.'}
          </p>
        </div>

        <div className="bg-white border border-brand-border rounded-2xl p-4 sm:p-5">
          <LostReportsSection
            startInWizard
            onOpenItem={onOpenItem}
            onSessionExpired={onSignIn}
          />
        </div>
      </section>
    );
  }

  return <SignedOutCard onSignIn={onSignIn} onBrowseFound={onBrowseFound} />;
}

/**
 * The unauthenticated state. It shows WHY an account is needed and what happens
 * to the report, then hands off to the existing authentication surface. No
 * report field, no report list and no identifier is rendered here — this is a
 * prompt, not a form.
 */
function SignedOutCard({ onSignIn, onBrowseFound }: Omit<Props, 'onOpenItem'>) {



  return (
    <section className="w-full" aria-labelledby="report-lost-heading">
      <h2 id="report-lost-heading" className="text-xl sm:text-2xl font-bold text-brand-dark-text">
        {'Report a lost item'}
      </h2>
      <p className="mt-1 text-sm text-brand-muted-text leading-relaxed max-w-2xl">
        {'A Return4me account is required to report something lost. That is what lets us contact you when a possible match appears, and it is why nobody else can file a report on your behalf.'}
      </p>

      <div className="mt-5 bg-white border border-brand-border rounded-2xl p-5 sm:p-6 max-w-xl space-y-4">
        <ul className="space-y-3">
          <li className="flex items-start gap-3">
            <ShieldCheck size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-primary-green" />
            <span className="text-sm text-brand-dark-text leading-relaxed">
              {'Your report is private. Lost reports cannot be browsed — only you see yours.'}
            </span>
          </li>
          <li className="flex items-start gap-3">
            <Search size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-primary-green" />
            <span className="text-sm text-brand-dark-text leading-relaxed">
              {'Anything that looks similar to your report is shown as a possible match — never as a confirmation of ownership.'}
            </span>
          </li>
          <li className="flex items-start gap-3">
            <LogIn size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-primary-green" />
            <span className="text-sm text-brand-dark-text leading-relaxed">
              {'Signing in takes a moment, and you are returned straight here to finish your report.'}
            </span>
          </li>
        </ul>

        <Button variant="primary" size="lg" className="w-full" onClick={onSignIn}>
          <LogIn size={16} aria-hidden="true" />
          {'Sign in to report a lost item'}
        </Button>

        <button
          type="button"
          onClick={onBrowseFound}
          className="w-full inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg text-sm font-bold text-primary-green hover:underline cursor-pointer"
        >
          <MapPin size={14} aria-hidden="true" />
          {'Instead, search items that have been found'}
        </button>
      </div>
    </section>
  );
}
