import React from 'react';
import { User, Package, ShieldCheck } from 'lucide-react';
import Button from './ui/Button';
import SectionHeading from './ui/SectionHeading';
import { ICON_SIZE } from './ui';

// PUBLIC SIGN-IN ENTRY (Phase 8.1)
// =================================
// The audit found the public navigation offering an unlabelled "Account" entry
// (which only ever opened the customer surface) while agent access sat in the
// public navbar as "Agent Portal" — so a visitor could not tell the two
// account types apart, and the internal portal was exposed as a primary public
// destination.
//
// This screen replaces that with ONE public entry point that states plainly
// that Return4me has two kinds of account and lets the visitor pick.
//
// WHAT THIS SCREEN DELIBERATELY DOES NOT DO:
//   * It does not authenticate anyone. It holds no credentials, no state and no
//     session logic — each path hands off to the authentication surface that
//     already exists and is unchanged:
//         Owner / Claimant -> the existing customer surface (/account),
//                             HTTP-cookie session + emailed one-time code.
//         Agent            -> the existing agent surface (/agent_portal),
//                             localStorage bearer token + emailed one-time code.
//   * It does not introduce a second agent registration flow; the agent path
//     opens the existing AgentView, which already contains both "Agent Login"
//     and "Apply to be Agent".

interface SignInViewProps {
  /** Opens the existing customer account surface (/account). */
  onOwnerSignIn: () => void;
  /** Opens the existing agent surface (/agent_portal). */
  onAgentSignIn: () => void;
  /** Opens the public agent journey (Become an Agent). */
  onBecomeAgent: () => void;
}

export default function SignInView({ onOwnerSignIn, onAgentSignIn, onBecomeAgent }: SignInViewProps) {



  return (
    <div className="max-w-5xl mx-auto px-5 sm:px-8 py-10 sm:py-14 fade-in">
      <SectionHeading
        eyebrow={'Sign in'}
        title={'Sign in to Return4me'}
        description={'Return4me has two kinds of account. Choose the one that matches you.'}
      />

      <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* ── Owner / Claimant ───────────────────────────────────────────── */}
        <section
          className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-panel shadow-raised p-6 flex flex-col"
          aria-labelledby="signin-owner-title"
        >
          <span className="inline-flex items-center justify-center w-11 h-11 rounded-standard bg-[var(--appearance-surface-muted)] text-[var(--appearance-text-primary)]">
            <User size={ICON_SIZE.heading} aria-hidden="true" />
          </span>
          <h2 id="signin-owner-title" className="mt-4 text-heading font-bold text-[var(--appearance-text-primary)]">
            {'Owner / Claimant'}
          </h2>
          <p className="mt-2 text-body text-[var(--appearance-text-muted)] leading-relaxed">
            {'For people who lost something, want to claim a found item, or are tracking a claim they already started.'}
          </p>
          <ul className="mt-4 space-y-2 text-body text-[var(--appearance-text-muted)]">
            {[
              'Search for a lost item',
              'Claim a found item you own',
              'Track or continue a claim',
            ].map((line) => (
              <li key={line} className="flex items-start gap-2">
                <span className="mt-2 inline-block w-1.5 h-1.5 rounded-full bg-[var(--appearance-accent)] shrink-0" aria-hidden="true" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
          <div className="mt-6 pt-5 border-t border-[var(--appearance-border)]">
            <Button variant="primary" size="lg" className="w-full" onClick={onOwnerSignIn}>
              {'Continue as Owner / Claimant'}
            </Button>
            <p className="mt-3 text-caption text-[var(--appearance-text-muted)]">
              {'You sign in with your phone number and a one-time code sent to your verified email address.'}
            </p>
          </div>
        </section>

        {/* ── Agent ──────────────────────────────────────────────────────── */}
        <section
          className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-panel shadow-raised p-6 flex flex-col"
          aria-labelledby="signin-agent-title"
        >
          <span className="inline-flex items-center justify-center w-11 h-11 rounded-standard bg-[var(--appearance-surface-muted)] text-[var(--appearance-text-primary)]">
            <Package size={ICON_SIZE.heading} aria-hidden="true" />
          </span>
          <h2 id="signin-agent-title" className="mt-4 text-heading font-bold text-[var(--appearance-text-primary)]">
            {'Agent'}
          </h2>
          <p className="mt-2 text-body text-[var(--appearance-text-muted)] leading-relaxed">
            {'For registered Return4me agents, or anyone applying to become one. Agents receive drop-offs, store items safely and hand them back to verified owners.'}
          </p>
          <div className="mt-4 flex items-start gap-2 text-body text-[var(--appearance-text-muted)]">
            <ShieldCheck size={ICON_SIZE.emphasis} className="mt-0.5 shrink-0 text-[var(--appearance-success)]" aria-hidden="true" />
            <span>
              {'Agent applications are reviewed and vetted before an account is activated.'}
            </span>
          </div>
          <div className="mt-6 pt-5 border-t border-[var(--appearance-border)]">
            <Button variant="accent" size="lg" className="w-full" onClick={onAgentSignIn}>
              {'Continue as Agent'}
            </Button>
            <p className="mt-3 text-caption text-[var(--appearance-text-muted)]">
              {'Sign-in and new applications for agents are handled on the same secure page.'}
            </p>
          </div>
        </section>
      </div>

      <div className="mt-8 bg-[var(--appearance-surface-muted)] border border-[var(--appearance-border)] rounded-panel p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-heading font-bold text-[var(--appearance-text-primary)]">{'Not an agent yet?'}</h2>
          <p className="mt-1 text-body text-[var(--appearance-text-muted)]">
            {'See what the work involves and what is required before you apply.'}
          </p>
        </div>
        <Button variant="outline" size="lg" className="shrink-0" onClick={onBecomeAgent}>
          {'Become an Agent'}
        </Button>
      </div>
    </div>
  );
}
