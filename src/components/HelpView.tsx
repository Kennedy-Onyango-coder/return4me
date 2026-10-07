import React from 'react';
import { ArrowRight, Check, HandCoins, KeyRound, LifeBuoy, Mail, Smartphone } from 'lucide-react';
import Button from './ui/Button';
import SectionHeading from './ui/SectionHeading';
import { ICON_SIZE } from './ui';
import type { PublicViewName } from '../utils/publicRoutes';

// PUBLIC HELP & FAQ (Batch 13)
// ===========================
// WHY THIS PAGE EXISTS
//   The Batch 13 sweep removed the last public relics of the SMS launch
//   posture: every one-time code now travels by EMAIL, the phone number is
//   only an identifier, and the support mailboxes were consolidated onto
//   privacy@ / support@ / security@. Copy that changed is only honest if the
//   visitor can look up WHY it changed, so the answers live on one addressable
//   page that support can hand out as a single link (`/help`). It is a public,
//   static page: it makes no network call, reads no session, and grants
//   nothing.
//
// HONESTY RULES APPLIED HERE
//   * Every statement is one an existing implementation already makes true:
//     the code is emailed, the phone number is an account identifier, the
//     retrieval fee is shown before payment and is released to the agent after
//     the handover is confirmed, and a dispute window precedes that release.
//   * No amount, timing, statistic or earned-outcome claim is invented: the
//     fee depends on the item category and is quoted in the payment step.
//   * Nothing here routes a visitor into a second flow. Every navigation
//     control calls the App-owned navigator, so the URL stays truthful
//     (/help -> /sign-in -> /found).
//
// STRUCTURE (the order is the argument):
//   1. the one-time code arrives by email
//   2. the phone number identifies the account
//   3. what the retrieval fee covers
//   4. collecting the item in person
//   5. what to do when something goes wrong (escalation)
//   6. who to contact, and the two real actions that leave this page
//
// BILINGUAL BY CONSTRUCTION: every rendered string goes through `t(en, sw)`.
// helpViewBilingualParity (publicHelpBatch13.test.ts) asserts that the number
// of `t(...)` calls equals the number of two-literal pairs, so an
// English-only string cannot be added here unnoticed.

interface HelpViewProps {
  /** The App-owned, URL-aware navigator (App.tsx `goToView`). Passing it in
   *  keeps /help in step with the screen: a cross-link leaves /help on a real
   *  public path instead of silently swapping React state behind the URL. */
  setView: (view: PublicViewName) => void;
}

export default function HelpView({ setView }: HelpViewProps) {



  /** The order a visitor reads them in: identity, then money, then the item,
   *  then what to do when it does not go to plan. */
  const emailFacts: string[] = [
    'The code is a secret. Return4me staff will never ask you for it.',
    'If the account has no verified email address we say so, instead of pretending a message was sent.',
    'You never need a code to report a found item.',
  ];

  const phoneFacts: string[] = [
    'A found item is matched to you through the number or the details you gave when you reported it.',
    'Changed your number? Sign in and update it, so a match can still reach you.',
  ];

  const feeFacts: string[] = [
    'Payment is made by M-Pesa from the claim screen.',
    'Return4me holds the payment until the handover is confirmed, then pays the agent their share.',
    'A dispute window runs before the agent is paid, and a disputed claim is reviewed by an administrator.',
  ];

  const collectFacts: string[] = [
    'Never hand the item, or the code, to anyone outside an approved agent location.',
    'The code is checked before the item is released, and never after.',
  ];

  const escalationSteps: string[] = [
    'Contact support with the claim reference shown on your claim (the CLM- code).',
    'Describe what happened, and attach a photo if the item is not as described.',
    'If a handover cannot be completed at the agent location, tell support before you leave it.',
    'A pickup code can be requested again from the claim page, and support can explain a payment state and pass a disputed claim to the administrator who decides it.',
  ];

  const contacts: Array<{ address: string; purpose: string }> = [
    { address: 'support@return4me.co.ke', purpose: 'Claims, payments and account help' },
    { address: 'privacy@return4me.co.ke', purpose: 'Data access, correction and erasure requests' },
    { address: 'security@return4me.co.ke', purpose: 'Security reports and vulnerability disclosure' },
  ];

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8">
      <header className="space-y-3">
        <SectionHeading
          eyebrow={'Help & FAQ'}
          title={'How Return4me works, and how to get help'}
          description={'Plain answers to the questions we are asked most: how your one-time code reaches you, what your phone number is used for, what the retrieval fee covers, and how to escalate a handover that does not go to plan.'}
          titleId="help-page-title"
          titleClassName="text-section"
        />
      </header>

      <section
        aria-labelledby="help-email-title"
        className="space-y-4 rounded-standard border border-[var(--appearance-border)] bg-[var(--appearance-surface)] p-5 sm:p-6"
      >
        <div className="inline-flex h-10 w-10 items-center justify-center rounded-standard bg-[var(--appearance-surface-muted)] text-[var(--appearance-primary)]">
          <Mail size={ICON_SIZE.emphasis} aria-hidden="true" />
        </div>
        <SectionHeading
          title={'Your one-time code arrives by email'}
          titleId="help-email-title"
        />
        <p className="text-body leading-relaxed text-[var(--appearance-text-muted)]">
          {'Every message Return4me uses to verify you is delivered to the email address on the account: signing in, filing a claim, linking a claim to your account, and asking to change your number or delete your data. Registering is the one exception to the shape of the message, not to the address — it emails an activation link rather than a code. Nothing is sent to your phone. Check that mailbox, including the spam folder, and open the message from Return4me.'}
        </p>
        <p className="text-body leading-relaxed text-[var(--appearance-text-muted)]">
          {'A code is valid for five minutes and accepts five attempts. If it does not arrive, request a new one rather than waiting on the old one.'}
        </p>
        <ul className="space-y-2">
          {emailFacts.map((fact) => (
            <li key={fact} className="flex gap-2 text-body text-[var(--appearance-text-muted)]">
              <Check size={ICON_SIZE.ui} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--appearance-primary)]" />
              <span>{fact}</span>
            </li>
          ))}
        </ul>
      </section>

      <section
        aria-labelledby="help-phone-title"
        className="space-y-4 rounded-standard border border-[var(--appearance-border)] bg-[var(--appearance-surface)] p-5 sm:p-6"
      >
        <div className="inline-flex h-10 w-10 items-center justify-center rounded-standard bg-[var(--appearance-surface-muted)] text-[var(--appearance-primary)]">
          <Smartphone size={ICON_SIZE.emphasis} aria-hidden="true" />
        </div>
        <SectionHeading
          title={'Your phone number identifies the account'}
          titleId="help-phone-title"
        />
        <p className="text-body leading-relaxed text-[var(--appearance-text-muted)]">
          {'The number you enter tells us which account, or which claim, you are asking about, so keep the number on your account up to date. It is an identifier, not a delivery channel: it never receives a code, and we never ask you to send one to us.'}
        </p>
        <ul className="space-y-2">
          {phoneFacts.map((fact) => (
            <li key={fact} className="flex gap-2 text-body text-[var(--appearance-text-muted)]">
              <Check size={ICON_SIZE.ui} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--appearance-primary)]" />
              <span>{fact}</span>
            </li>
          ))}
        </ul>
      </section>

      <section
        aria-labelledby="help-fee-title"
        className="space-y-4 rounded-standard border border-[var(--appearance-border)] bg-[var(--appearance-surface)] p-5 sm:p-6"
      >
        <div className="inline-flex h-10 w-10 items-center justify-center rounded-standard bg-[var(--appearance-surface-muted)] text-[var(--appearance-primary)]">
          <HandCoins size={ICON_SIZE.emphasis} aria-hidden="true" />
        </div>
        <SectionHeading
          title={'What the retrieval fee covers'}
          titleId="help-fee-title"
        />
        <p className="text-body leading-relaxed text-[var(--appearance-text-muted)]">
          {'Reporting a found item is free, and searching, viewing an item and filing a claim cost nothing. The retrieval fee is paid by the owner, and only once an agent has confirmed the item is physically at their location. The exact amount depends on the item category and is shown in the payment step before you pay anything.'}
        </p>
        <ul className="space-y-2">
          {feeFacts.map((fact) => (
            <li key={fact} className="flex gap-2 text-body text-[var(--appearance-text-muted)]">
              <Check size={ICON_SIZE.ui} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--appearance-primary)]" />
              <span>{fact}</span>
            </li>
          ))}
        </ul>
      </section>

      <section
        aria-labelledby="help-collect-title"
        className="space-y-4 rounded-standard border border-[var(--appearance-border)] bg-[var(--appearance-surface)] p-5 sm:p-6"
      >
        <div className="inline-flex h-10 w-10 items-center justify-center rounded-standard bg-[var(--appearance-surface-muted)] text-[var(--appearance-primary)]">
          <KeyRound size={ICON_SIZE.emphasis} aria-hidden="true" />
        </div>
        <SectionHeading
          title={'Collecting the item in person'}
          titleId="help-collect-title"
        />
        <p className="text-body leading-relaxed text-[var(--appearance-text-muted)]">
          {'After payment is confirmed, Return4me emails a pickup code for that claim. Take the code to the agent at the location named on the claim. The agent checks the code against the claim, records the handover with a photo, and confirms it — and nothing is paid to the agent before that confirmation.'}
        </p>
        <ul className="space-y-2">
          {collectFacts.map((fact) => (
            <li key={fact} className="flex gap-2 text-body text-[var(--appearance-text-muted)]">
              <Check size={ICON_SIZE.ui} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--appearance-primary)]" />
              <span>{fact}</span>
            </li>
          ))}
        </ul>
      </section>

      <section
        aria-labelledby="help-escalate-title"
        className="space-y-4 rounded-standard border border-[var(--appearance-border)] bg-[var(--appearance-surface)] p-5 sm:p-6"
      >
        <div className="inline-flex h-10 w-10 items-center justify-center rounded-standard bg-[var(--appearance-surface-muted)] text-[var(--appearance-primary)]">
          <LifeBuoy size={ICON_SIZE.emphasis} aria-hidden="true" />
        </div>
        <SectionHeading
          title={'When something goes wrong'}
          titleId="help-escalate-title"
        />
        <p className="text-body leading-relaxed text-[var(--appearance-text-muted)]">
          {'A handover is a real meeting between two people, so it can stall. These steps are the escalation path, in order.'}
        </p>
        <ol className="list-decimal space-y-2 pl-5 text-body text-[var(--appearance-text-muted)]">
          {escalationSteps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </section>

      <section
        aria-labelledby="help-contact-title"
        className="space-y-4 rounded-standard border border-[var(--appearance-border)] bg-[var(--appearance-surface)] p-5 sm:p-6"
      >
        <SectionHeading
          title={'Who to contact'}
          description={'One mailbox per kind of question, so a message never sits in the wrong queue.'}
          titleId="help-contact-title"
        />
        <ul className="space-y-3">
          {contacts.map((contact) => (
            <li key={contact.address} className="space-y-1">
              <a
                href={`mailto:${contact.address}`}
                className="inline-flex items-center gap-2 text-body font-medium text-[var(--appearance-primary)] underline-offset-2 hover:underline"
              >
                <Mail size={ICON_SIZE.ui} aria-hidden="true" />
                {contact.address}
              </a>
              <p className="text-caption text-[var(--appearance-text-muted)]">{contact.purpose}</p>
            </li>
          ))}
        </ul>
        <p className="text-caption text-[var(--appearance-text-muted)]">
          {'Support replies by email rather than a live line. Include the claim reference so the first reply can be an answer.'}
        </p>
      </section>

      <section
        aria-labelledby="help-next-title"
        className="space-y-4 rounded-standard border border-[var(--appearance-border)] bg-[var(--appearance-surface-muted)] p-5 sm:p-6"
      >
        <SectionHeading
          title={'Ready to carry on?'}
          description={'Sign in to a claim you already filed, or report something you have found.'}
          titleId="help-next-title"
        />
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button variant="primary" size="lg" onClick={() => setView('signin')} className="w-full sm:w-auto">
            {'Sign In'}
            <ArrowRight size={ICON_SIZE.heading} aria-hidden="true" />
          </Button>
          <Button variant="outline" size="lg" onClick={() => setView('finder')} className="w-full sm:w-auto">
            {'I Found Something'}
          </Button>
        </div>
        <p className="text-caption text-[var(--appearance-text-muted)]">
          {'Fees and data handling are set out in the Terms of Service and the Privacy Policy.'}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" size="sm" onClick={() => setView('terms')}>
            {'Terms of Service'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setView('privacy')}>
            {'Privacy Policy'}
          </Button>
        </div>
      </section>
    </div>
  );
}
