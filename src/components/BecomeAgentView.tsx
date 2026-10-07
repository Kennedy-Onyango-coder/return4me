import React from 'react';
import { Package, ShieldCheck, Wallet, Store, Smartphone, IdCard, Mail, ArrowRight, Check, type LucideIcon } from 'lucide-react';
import Button from './ui/Button';
import SectionHeading from './ui/SectionHeading';
import Stepper from './ui/Stepper';
import { ICON_SIZE } from './ui';

// PUBLIC AGENT JOURNEY (Phase 8.1 — refined in UX-10)
// ===================================================
// The audit found "Agent Portal" sitting in the public navigation as a primary
// destination, so a first-time visitor's only route into the agent journey was
// a staff-facing login screen. Agent ACCESS stays exactly where it is — the
// existing /agent_portal surface, untouched. This view is the public
// explanation that leads to it.
//
// UX-10 turns that explanation into a deliberate page: a hero that states the
// role in one breath, the reason the role exists, the three responsibilities,
// the requirements, the REAL approval stages, and one closing action. The
// structure is the argument, in order:
//
//   1. hero             — what an agent is, and the single action to apply
//   2. why it matters   — why a physical holder is the whole product
//   3. responsibilities — the three things an agent actually does
//   4. requirements     — what the application asks for, stated up front
//   5. approval         — the three stages an application goes through
//   6. final CTA        — the same action as the hero, on the brand band
//
// HONESTY RULES APPLIED HERE (unchanged by UX-10):
//   * No invented earnings figures, statistics, testimonials or trust badges.
//     The only economic statement is the one the fee engine already implements:
//     an agent receives a share of the recovery fee for a completed handover
//     (categories.agent_share / agent_pct). No amount is stated.
//   * The requirements listed are exactly what the existing agent registration
//     already asks for: a business name and location, an M-Pesa payout number,
//     a national ID for vetting, and an email address for the activation
//     notice. Nothing is added.
//   * The three approval stages are the ones AgentView already implements and
//     shows to a pending applicant (its "Onboarding Process" panel), in the
//     same order and with the same meaning. No stage is invented here, and no
//     stage timing or outcome is guaranteed.
//   * No photography here yet: the real Return4me agent photograph is already
//     used on the homepage, and asset work is a later phase — inventing an
//     illustration instead would be exactly the template look we are removing.
//
// This is a public explanation of an existing process. It creates no second
// registration flow, makes no network call, and grants nothing.

interface BecomeAgentViewProps {
  /** Opens the existing agent surface (/agent_portal), where sign-in AND
   *  application already live. No second registration flow is created. */
  onContinueToAgentPortal: () => void;
  /** Public cross-link back to the Sign In chooser. */
  onSignIn: () => void;
}

export default function BecomeAgentView({ onContinueToAgentPortal, onSignIn }: BecomeAgentViewProps) {



  /** The ONE action this page exists to produce. The hero and the closing band
   *  both render this exact string, so the wording cannot drift between them. */
  const applyLabel = 'Continue to agent registration';

  // Why a physical holder is the whole product, in three honest statements.
  const whyPoints: Array<{ title: string; body: string }> = [
    {
      title: 'You are the trusted third party',
      body: 'Neither side has to trust a stranger: the finder leaves the item with you and the owner collects it from you. One vetted person in the middle is what makes the exchange safe.',
    },
    {
      title: 'Nothing moves on an unconfirmed identity',
      body: 'Before an item leaves your premises you confirm the owner’s identity and their collection code. The handover is a guarded moment between two people in one place — never an arrangement between strangers.',
    },
    {
      title: 'Your premises become a recovery point',
      body: 'Offices, shops, campuses, matatu SACCOs and places of worship are where lost property actually accumulates. Registering one address gives those items a real place to be held — and a person answerable for them.',
    },
  ];

  // The three things an agent actually does. The economic statement is the one
  // the fee engine implements (a share of the recovery fee) — never an amount.
  const responsibilities: Array<{ icon: LucideIcon; title: string; body: string }> = [
    {
      icon: Package,
      title: 'Receive and store items',
      body: 'Finders drop items off at your premises using a drop-off code. You check the item in and hold it securely until its owner collects it.',
    },
    {
      icon: ShieldCheck,
      title: 'Verify owners in person',
      body: 'Before releasing anything you confirm the owner’s identity and their collection code. Every handover happens face to face, at your premises.',
    },
    {
      icon: Wallet,
      title: 'Earn on completed handovers',
      body: 'When an item is collected, the agent receives a share of the recovery fee for that handover.',
    },
  ];

  // Exactly the fields the existing registration collects (AgentView), so this
  // page never over-promises and never surprises an applicant halfway through.
  const requirements: Array<{ icon: LucideIcon; text: string }> = [
    {
      icon: Store,
      text: 'A business or shop name and a fixed location open to the public',
    },
    {
      icon: Smartphone,
      text: 'An M-Pesa payout number — Till, Paybill, Pochi la Biashara or personal M-Pesa',
    },
    {
      icon: IdCard,
      text: 'A national ID for vetting, plus a photo of the ID document itself',
    },
    {
      icon: Mail,
      text: 'A business email address — your activation notice is sent there',
    },
  ];

  // THE REAL APPROVAL STAGES. These are the stages AgentView already shows to a
  // pending applicant (its "Onboarding Process" panel), in the same order and
  // with the same meaning. Nothing is invented, and the rail states where every
  // application starts rather than pretending to report live progress.
  const approvalSteps = [
    {
      label: 'Details & location',
      description: 'Your business details and location are checked.',
    },
    {
      label: 'Identity review',
      description: 'Your national ID and documents are reviewed securely.',
    },
    {
      label: 'Activation notice',
      description: 'You are notified by email once you are activated.',
    },
  ];

  // Two things AgentView already tells an applicant, repeated here so nobody
  // applies expecting an instant account. Both are stated by the product today.
  const approvalNotes: string[] = [
    'An administrator approves your application before you can receive any item.',
    'You also verify your email address using the link we send you. Approval and email verification are two separate steps, and both must be complete.',
  ];

  return (
    <div className="mx-auto w-full max-w-5xl px-5 py-10 sm:px-8 sm:py-14 fade-in">
      {/* 1. HERO — the role in one breath, with the page's single dominant
          action. The eyebrow and the caption are deliberately quiet: the h1 and
          the button are the only two things competing for attention here. */}
      <section aria-labelledby="agent-hero-heading">
        <p className="text-caption font-extrabold uppercase tracking-widest text-[var(--appearance-text-muted)]">
          {'Agent network'}
        </p>
        <h1
          id="agent-hero-heading"
          className="mt-3 max-w-3xl text-page font-extrabold tracking-tight text-[var(--appearance-text-primary)] sm:text-display"
        >
          {'Become a Return4me agent'}
        </h1>
        <p className="mt-4 max-w-2xl text-body-large leading-relaxed text-[var(--appearance-text-muted)]">
          {'Agents are the physical half of Return4me. You receive the items finders bring in, keep them safe, and hand them back to owners whose identity you have confirmed in person.'}
        </p>
        <div className="mt-6 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          <Button variant="accent" size="lg" onClick={onContinueToAgentPortal}>
            <ArrowRight size={ICON_SIZE.heading} aria-hidden="true" />
            {applyLabel}
          </Button>
          <p className="text-body text-[var(--appearance-text-muted)]">
            {'Registration and agent sign-in happen on the same secure page.'}
          </p>
        </div>
      </section>

      {/* 2. WHY IT MATTERS — the argument for the role, then three statements
          that carry it. Two columns on desktop: the claim on the left, the
          evidence for it on the right. */}
      <section
        aria-labelledby="agent-why-heading"
        className="mt-12 border-t border-[var(--appearance-border)] pt-12 sm:mt-16 sm:pt-16"
      >
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-2 lg:items-start lg:gap-14">
          <SectionHeading
            titleId="agent-why-heading"
            titleClassName="text-section"
            eyebrow={'Why it matters'}
            title={'A found item has nowhere to go without someone holding it'}
            description={'A finder will not hand a phone to a stranger, and an owner cannot collect what nobody is keeping. The record stores the report; an agent is what turns it back into a return.'}
          />
          <ul className="space-y-6">
            {whyPoints.map((point) => (
              <li key={point.title} className="flex items-start gap-3">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-small bg-primary-green/10 text-[var(--appearance-text-primary)]">
                  <Check size={ICON_SIZE.metadata} aria-hidden="true" />
                </span>
                <div>
                  <h3 className="text-body-large font-bold text-[var(--appearance-text-primary)]">{point.title}</h3>
                  <p className="mt-1 text-body leading-relaxed text-[var(--appearance-text-muted)]">{point.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* 3. RESPONSIBILITIES — the role, split into the three things an agent
          does. Three equal cards, one idea each, no ranking between them. */}
      <section
        aria-labelledby="agent-responsibilities-heading"
        className="mt-12 border-t border-[var(--appearance-border)] pt-12 sm:mt-16 sm:pt-16"
      >
        <SectionHeading
          titleId="agent-responsibilities-heading"
          titleClassName="text-section"
          eyebrow={'What you do'}
          title={'Three responsibilities'}
          description={'The role is short to describe and impossible to do casually: hold the item, confirm the owner, complete the handover.'}
        />
        <div className="mt-8 grid grid-cols-1 gap-5 md:grid-cols-3">
          {responsibilities.map((item) => {
            const Icon = item.icon;
            return (
              <section key={item.title} className="rounded-panel border border-[var(--appearance-border)] bg-[var(--appearance-surface)] p-6">
                <span className="flex h-10 w-10 items-center justify-center rounded-small bg-primary-green/10">
                  <Icon size={ICON_SIZE.heading} className="text-[var(--appearance-text-primary)]" aria-hidden="true" />
                </span>
                <h3 className="mt-4 text-body-large font-bold text-[var(--appearance-text-primary)]">{item.title}</h3>
                <p className="mt-2 text-body leading-relaxed text-[var(--appearance-text-muted)]">{item.body}</p>
              </section>
            );
          })}
        </div>
      </section>

      {/* 4. REQUIREMENTS — what the application asks for, before anyone
          commits to it. A quiet sunken surface: it is reference material, not
          a claim, so it carries no brand colour of its own. */}
      <section
        aria-labelledby="agent-requirements-heading"
        className="mt-12 border-t border-[var(--appearance-border)] pt-12 sm:mt-16 sm:pt-16"
      >
        <SectionHeading
          titleId="agent-requirements-heading"
          titleClassName="text-section"
          eyebrow={'Before you apply'}
          title={'What you will need'}
          description={'These are exactly the details the agent application asks for — nothing more is required.'}
        />
        <div className="mt-8 rounded-panel border border-[var(--appearance-border)] bg-[var(--appearance-surface-muted)] p-6 sm:p-8">
          <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            {requirements.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.text} className="flex items-start gap-3">
                  <Icon
                    size={ICON_SIZE.emphasis}
                    className="mt-0.5 shrink-0 text-[var(--appearance-text-primary)]"
                    aria-hidden="true"
                  />
                  <span className="text-body leading-relaxed text-[var(--appearance-text-primary)]">{item.text}</span>
                </li>
              );
            })}
          </ul>
          <p className="mt-6 border-t border-[var(--appearance-border)] pt-5 text-body leading-relaxed text-[var(--appearance-text-muted)]">
            {'Applications are reviewed by our team before an agent account is activated. Vetting protects both owners and agents.'}
          </p>
        </div>
      </section>

      {/* 5. APPROVAL — the three real stages on the shared Stepper rail, plus
          the two facts an applicant should know before they commit. The rail is
          marked at its first stage because that is where every application
          starts: it describes the process, it does not report live progress. */}
      <section
        aria-labelledby="agent-approval-heading"
        className="mt-12 border-t border-[var(--appearance-border)] pt-12 sm:mt-16 sm:pt-16"
      >
        <SectionHeading
          titleId="agent-approval-heading"
          titleClassName="text-section"
          eyebrow={'Approval'}
          title={'How your application is approved'}
          description={'Every application follows the same three stages, in this order. Each stage is carried out by Return4me — there is nothing for you to do between them.'}
        />
        <div className="mt-8 rounded-panel border border-[var(--appearance-border)] bg-[var(--appearance-surface)] p-6 sm:p-8">
          <Stepper
            steps={approvalSteps}
            currentStep={0}
            label={'Agent application approval stages'}
          />
          <ul className="mt-8 space-y-3 border-t border-[var(--appearance-border)] pt-6">
            {approvalNotes.map((note) => (
              <li key={note} className="flex items-start gap-3">
                <Check
                  size={ICON_SIZE.ui}
                  className="mt-1 shrink-0 text-primary-green"
                  aria-hidden="true"
                />
                <span className="text-body leading-relaxed text-[var(--appearance-text-muted)]">{note}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* 6. FINAL CTA — the same action as the hero, restated once, beside the
          secondary route back to the Sign In chooser. The band and its
          white-filled button are the documented FIXED brand-green pairing
          (Batch 3): they are the brand in both themes and must not follow
          data-theme. */}
      <section
        aria-labelledby="agent-cta-heading"
        className="mt-12 rounded-panel bg-primary-green px-6 py-10 text-center sm:mt-16 sm:px-10 sm:py-14"
      >
        <h2 id="agent-cta-heading" className="text-section font-bold tracking-tight text-white">
          {'Ready to apply?'}
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-body sm:text-body-large text-white/80">
          {'Registration and agent sign-in are handled on the same secure page. Your application is reviewed before an account is activated.'}
        </p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <Button
            variant="secondary"
            size="lg"
            onClick={onContinueToAgentPortal}
            className="bg-white hover:bg-brand-light-gray text-primary-green border-white"
          >
            <ArrowRight size={ICON_SIZE.emphasis} aria-hidden="true" />
            {applyLabel}
          </Button>
          <Button variant="inverse" size="lg" onClick={onSignIn}>
            {'Back to Sign In'}
          </Button>
        </div>
      </section>
    </div>
  );
}
