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
  lang: 'en' | 'sw';
  /** Opens the existing agent surface (/agent_portal), where sign-in AND
   *  application already live. No second registration flow is created. */
  onContinueToAgentPortal: () => void;
  /** Public cross-link back to the Sign In chooser. */
  onSignIn: () => void;
}

export default function BecomeAgentView({ lang, onContinueToAgentPortal, onSignIn }: BecomeAgentViewProps) {
  const sw = lang === 'sw';
  const t = (en: string, swText: string) => (sw ? swText : en);

  /** The ONE action this page exists to produce. The hero and the closing band
   *  both render this exact string, so the wording cannot drift between them. */
  const applyLabel = t('Continue to agent registration', 'Endelea kusajiliwa kama wakala');

  // Why a physical holder is the whole product, in three honest statements.
  const whyPoints: Array<{ title: string; body: string }> = [
    {
      title: t('You are the trusted third party', 'Wewe ndiye mtu wa kati anayeaminika'),
      body: t(
        'Neither side has to trust a stranger: the finder leaves the item with you and the owner collects it from you. One vetted person in the middle is what makes the exchange safe.',
        'Hakuna upande unaolazimika kumwamini mgeni: aliyepata huacha kitu kwako na mmiliki huchukua kwako. Mtu mmoja aliyethibitishwa katikati ndiye hufanya mabadilishano kuwa salama.',
      ),
    },
    {
      title: t('Nothing moves on an unconfirmed identity', 'Hakuna kitu hutoka bila utambulisho kuthibitishwa'),
      body: t(
        'Before an item leaves your premises you confirm the owner’s identity and their collection code. The handover is a guarded moment between two people in one place — never an arrangement between strangers.',
        'Kabla kitu kutoka kwenye eneo lako, unathibitisha utambulisho wa mmiliki na msimbo wake wa kuchukua. Ukabidhaji ni wakati unaolindwa kati ya watu wawili mahali pamoja — sio mpango wa kati ya wageni wawili.',
      ),
    },
    {
      title: t('Your premises become a recovery point', 'Eneo lako huwa kituo cha urejeshaji'),
      body: t(
        'Offices, shops, campuses, matatu SACCOs and places of worship are where lost property actually accumulates. Registering one address gives those items a real place to be held — and a person answerable for them.',
        'Ofisi, maduka, vyuo, SACCO za matatu na nyumba za ibada ndiko mali zilizopotea hukusanyika. Kusajili anwani moja huwapa vitu hivyo mahali halisi pa kuhifadhiwa — na mtu anayewajibika navyo.',
      ),
    },
  ];

  // The three things an agent actually does. The economic statement is the one
  // the fee engine implements (a share of the recovery fee) — never an amount.
  const responsibilities: Array<{ icon: LucideIcon; title: string; body: string }> = [
    {
      icon: Package,
      title: t('Receive and store items', 'Pokea na uhifadhi vitu'),
      body: t(
        'Finders drop items off at your premises using a drop-off code. You check the item in and hold it securely until its owner collects it.',
        'Waliopata huleta vitu kwenye eneo lako kwa kutumia msimbo wa kuwasilisha. Unapokea kitu na kukihifadhi salama hadi mmiliki wake kije kuchukua.',
      ),
    },
    {
      icon: ShieldCheck,
      title: t('Verify owners in person', 'Thibitisha wamiliki ana kwa ana'),
      body: t(
        'Before releasing anything you confirm the owner’s identity and their collection code. Every handover happens face to face, at your premises.',
        'Kabla ya kutoa kitu chochote, unathibitisha utambulisho wa mmiliki na msimbo wake wa kuchukua. Kila ukabidhaji hufanyika ana kwa ana, kwenye eneo lako.',
      ),
    },
    {
      icon: Wallet,
      title: t('Earn on completed handovers', 'Pata mapato kwa ukabidhaji uliokamilika'),
      body: t(
        'When an item is collected, the agent receives a share of the recovery fee for that handover.',
        'Kitu kinapochukuliwa, wakala hupata mgao wa ada ya urejeshaji kwa ukabidhaji huo.',
      ),
    },
  ];

  // Exactly the fields the existing registration collects (AgentView), so this
  // page never over-promises and never surprises an applicant halfway through.
  const requirements: Array<{ icon: LucideIcon; text: string }> = [
    {
      icon: Store,
      text: t(
        'A business or shop name and a fixed location open to the public',
        'Jina la biashara au duka na eneo maalum linalofikiwa na umma',
      ),
    },
    {
      icon: Smartphone,
      text: t(
        'An M-Pesa payout number — Till, Paybill, Pochi la Biashara or personal M-Pesa',
        'Nambari ya M-Pesa ya malipo — Till, Paybill, Pochi la Biashara au M-Pesa ya mtu binafsi',
      ),
    },
    {
      icon: IdCard,
      text: t(
        'A national ID for vetting, plus a photo of the ID document itself',
        'Kitambulisho cha kitaifa kwa uthibitishaji, pamoja na picha ya hati ya kitambulisho',
      ),
    },
    {
      icon: Mail,
      text: t(
        'A business email address — your activation notice is sent there',
        'Barua pepe ya biashara — taarifa ya kuwashwa hutumwa huko',
      ),
    },
  ];

  // THE REAL APPROVAL STAGES. These are the stages AgentView already shows to a
  // pending applicant (its "Onboarding Process" panel), in the same order and
  // with the same meaning. Nothing is invented, and the rail states where every
  // application starts rather than pretending to report live progress.
  const approvalSteps = [
    {
      label: t('Details & location', 'Maelezo na eneo'),
      description: t('Your business details and location are checked.', 'Maelezo ya biashara na eneo lako hukaguliwa.'),
    },
    {
      label: t('Identity review', 'Uhakiki wa utambulisho'),
      description: t('Your national ID and documents are reviewed securely.', 'Kitambulisho chako cha kitaifa na hati hukaguliwa kwa usalama.'),
    },
    {
      label: t('Activation notice', 'Taarifa ya kuwashwa'),
      description: t('You are notified by SMS or email once you are activated.', 'Unaarifiwa kwa SMS au barua pepe mara unapowashwa.'),
    },
  ];

  // Two things AgentView already tells an applicant, repeated here so nobody
  // applies expecting an instant account. Both are stated by the product today.
  const approvalNotes: string[] = [
    t(
      'An administrator approves your application before you can receive any item.',
      'Msimamizi hukubali maombi yako kabla uweze kupokea kitu chochote.',
    ),
    t(
      'You also verify your email address using the link we send you. Approval and email verification are two separate steps, and both must be complete.',
      'Pia huthibitisha barua pepe yako kwa kutumia kiungo tunachokutumia. Uidhinishaji na uthibitishaji wa barua pepe ni hatua mbili tofauti, na zote mbili hukamilika.',
    ),
  ];

  return (
    <div className="mx-auto w-full max-w-5xl px-5 py-10 sm:px-8 sm:py-14 fade-in">
      {/* 1. HERO — the role in one breath, with the page's single dominant
          action. The eyebrow and the caption are deliberately quiet: the h1 and
          the button are the only two things competing for attention here. */}
      <section aria-labelledby="agent-hero-heading">
        <p className="text-caption font-extrabold uppercase tracking-widest text-[var(--appearance-text-muted)]">
          {t('Agent network', 'Mtandao wa mawakala')}
        </p>
        <h1
          id="agent-hero-heading"
          className="mt-3 max-w-3xl text-page font-extrabold tracking-tight text-[var(--appearance-text-primary)] sm:text-display"
        >
          {t('Become a Return4me agent', 'Kuwa wakala wa Return4me')}
        </h1>
        <p className="mt-4 max-w-2xl text-body-large leading-relaxed text-[var(--appearance-text-muted)]">
          {t(
            'Agents are the physical half of Return4me. You receive the items finders bring in, keep them safe, and hand them back to owners whose identity you have confirmed in person.',
            'Mawakala ni sehemu ya kimwili ya Return4me. Unapokea vitu vinavyoletwa na waliopata, unavihifadhi salama, na kuvikabidhi kwa wamiliki ambao umethibitisha utambulisho wao ana kwa ana.',
          )}
        </p>
        <div className="mt-6 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          <Button variant="accent" size="lg" onClick={onContinueToAgentPortal}>
            <ArrowRight size={ICON_SIZE.heading} aria-hidden="true" />
            {applyLabel}
          </Button>
          <p className="text-body text-[var(--appearance-text-muted)]">
            {t(
              'Registration and agent sign-in happen on the same secure page.',
              'Usajili na kuingia kwa wakala hufanyika kwenye ukurasa mmoja salama.',
            )}
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
            eyebrow={t('Why it matters', 'Kwa nini ni muhimu')}
            title={t(
              'A found item has nowhere to go without someone holding it',
              'Kitu kilichopatikana hakina mahali pa kwenda bila mtu kukihifadhi',
            )}
            description={t(
              'A finder will not hand a phone to a stranger, and an owner cannot collect what nobody is keeping. The record stores the report; an agent is what turns it back into a return.',
              'Aliyepata hatamkabidhi mgeni simu, na mmiliki hawezi kuchukua kitu ambacho hakuna anayekihifadhi. Rekodi huhifadhi ripoti; wakala ndiye anayeigeuza kuwa urejeshaji.',
            )}
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
          eyebrow={t('What you do', 'Unachofanya')}
          title={t('Three responsibilities', 'Majukumu matatu')}
          description={t(
            'The role is short to describe and impossible to do casually: hold the item, confirm the owner, complete the handover.',
            'Jukumu hili ni fupi kueleza na haliwezi kufanywa kizembe: hifadhi kitu, thibitisha mmiliki, kamilisha ukabidhaji.',
          )}
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
          eyebrow={t('Before you apply', 'Kabla kuomba')}
          title={t('What you will need', 'Utakachohitaji')}
          description={t(
            'These are exactly the details the agent application asks for — nothing more is required.',
            'Haya ni maelezo ambayo maombi ya wakala huuliza — hakuna kingine kinachohitajika.',
          )}
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
            {t(
              'Applications are reviewed by our team before an agent account is activated. Vetting protects both owners and agents.',
              'Maombi hukaguliwa na timu yetu kabla akaunti ya wakala kuwashwa. Uthibitishaji hulinda wamiliki na mawakala.',
            )}
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
          eyebrow={t('Approval', 'Uidhinishaji')}
          title={t('How your application is approved', 'Maombi yako hukaguliwa vipi')}
          description={t(
            'Every application follows the same three stages, in this order. Each stage is carried out by Return4me — there is nothing for you to do between them.',
            'Kila maombi hupitia hatua tatu sawa, kwa mpangilio huu. Kila hatua hufanywa na Return4me — hakuna unachohitaji kufanya kati yao.',
          )}
        />
        <div className="mt-8 rounded-panel border border-[var(--appearance-border)] bg-[var(--appearance-surface)] p-6 sm:p-8">
          <Stepper
            steps={approvalSteps}
            currentStep={0}
            label={t('Agent application approval stages', 'Hatua za kuidhinisha maombi ya wakala')}
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
          {t('Ready to apply?', 'Uko tayari kuomba?')}
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-body sm:text-body-large text-white/80">
          {t(
            'Registration and agent sign-in are handled on the same secure page. Your application is reviewed before an account is activated.',
            'Usajili na kuingia kwa wakala hushughulikiwa kwenye ukurasa mmoja salama. Maombi yako hukaguliwa kabla akaunti kuwashwa.',
          )}
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
            {t('Back to Sign In', 'Rudi kwenye kuingia')}
          </Button>
        </div>
      </section>
    </div>
  );
}
