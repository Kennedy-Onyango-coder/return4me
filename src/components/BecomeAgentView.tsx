import React from 'react';
import { Package, ShieldCheck, Wallet, MapPin, Smartphone, IdCard } from 'lucide-react';
import Button from './ui/Button';
import SectionHeading from './ui/SectionHeading';

// PUBLIC AGENT JOURNEY (Phase 8.1)
// ================================
// The audit found "Agent Portal" sitting in the public navigation as a primary
// destination, so a first-time visitor's only route into the agent journey was
// a staff-facing login screen. Agent ACCESS stays exactly where it is — the
// existing /agent_portal surface, untouched. This view is the public
// explanation that leads to it.
//
// HONESTY RULES APPLIED HERE:
//   * No invented earnings figures, statistics, testimonials or trust badges.
//     The only economic statement is the one the fee engine already implements:
//     an agent receives a share of the recovery fee for a completed handover
//     (categories.agent_share / agent_pct). No amount is stated.
//   * The requirements listed are exactly what the existing agent registration
//     already asks for: a business name, an M-Pesa payout number, and a
//     national ID for vetting. Nothing is added.
//   * No photography here yet: the real Return4me agent photograph is already
//     used on the homepage, and asset work is a later phase — inventing an
//     illustration instead would be exactly the template look we are removing.
//
// This is a structural public entry point; a full marketing treatment is a
// later phase.

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

  const responsibilities: Array<{ icon: React.ComponentType<any>; title: string; body: string }> = [
    {
      icon: Package,
      title: t('Receive and store items', 'Pokea na uhifadhi vitu'),
      body: t(
        'Finders drop items off at your premises using a drop-off code. You hold the item securely until its owner collects it.',
        'Waliopata huleta vitu kwenye eneo lako kwa kutumia msimbo wa kuwasilisha. Unahifadhi kitu hicho salama hadi mmiliki wake kije kuchukua.',
      ),
    },
    {
      icon: ShieldCheck,
      title: t('Verify owners in person', 'Thibitisha wamiliki ana kwa ana'),
      body: t(
        'Before releasing anything you confirm the owner’s identity and their collection code. Every handover is physical.',
        'Kabla ya kutoa kitu, unathibitisha utambulisho wa mmiliki na msimbo wake wa kuchukua. Kila ukabidhaji hufanyika ana kwa ana.',
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

  const requirements: Array<{ icon: React.ComponentType<any>; text: string }> = [
    { icon: MapPin, text: t('A physical business location open to the public', 'Eneo la biashara linalofikiwa na umma') },
    { icon: Smartphone, text: t('An M-Pesa number for payouts', 'Nambari ya M-Pesa ya malipo') },
    { icon: IdCard, text: t('A Kenyan national ID for vetting', 'Kitambulisho cha kitaifa cha Kenya kwa uthibitishaji') },
  ];

  return (
    <div className="max-w-5xl mx-auto px-5 sm:px-8 py-10 sm:py-14 fade-in">
      <SectionHeading
        eyebrow={t('Agent network', 'Mtandao wa mawakala')}
        title={t('Become a Return4me agent', 'Kuwa wakala wa Return4me')}
        description={t(
          'Agents are the physical half of Return4me. You receive items that finders bring in, keep them safe, and hand them back to verified owners.',
          'Mawakala ni sehemu ya kimwili ya Return4me. Unapokea vitu vinavyoletwa na waliopata, unavihifadhi salama, na kuvikabidhi kwa wamiliki waliothibitishwa.',
        )}
      />

      <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-5">
        {responsibilities.map((item) => {
          const Icon = item.icon;
          return (
            <section key={item.title} className="bg-white border border-line-subtle rounded-2xl p-6">
              <span className="inline-flex items-center justify-center w-11 h-11 rounded-xl bg-canvas-sunken text-ink">
                <Icon size={20} aria-hidden="true" />
              </span>
              <h2 className="mt-4 text-heading font-bold text-ink">{item.title}</h2>
              <p className="mt-2 text-body text-ink-muted leading-relaxed">{item.body}</p>
            </section>
          );
        })}
      </div>

      {/* What is required — these are exactly the fields the existing agent
          registration already collects, so nothing here over-promises. */}
      <section className="mt-8 bg-canvas-sunken border border-line-subtle rounded-2xl p-6" aria-labelledby="agent-requirements-title">
        <h2 id="agent-requirements-title" className="text-heading font-bold text-ink">
          {t('What you will need', 'Utakachohitaji')}
        </h2>
        <ul className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
          {requirements.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.text} className="flex items-start gap-2.5 text-body text-ink-muted">
                <Icon size={18} className="mt-0.5 shrink-0 text-ink" aria-hidden="true" />
                <span>{item.text}</span>
              </li>
            );
          })}
        </ul>
        <p className="mt-4 text-body text-ink-muted leading-relaxed">
          {t(
            'Applications are reviewed by our team before an agent account is activated. Vetting protects both owners and agents.',
            'Maombi hukaguliwa na timu yetu kabla akaunti ya wakala kuwashwa. Uthibitishaji hulinda wamiliki na mawakala.',
          )}
        </p>
      </section>

      {/* Hand-off to the EXISTING agent surface. Sign-in and application both
          live there; this phase adds no second registration flow. */}
      <section className="mt-8 bg-white border border-line-subtle rounded-2xl p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-5">
        <div>
          <h2 className="text-heading font-bold text-ink">
            {t('Ready to apply?', 'Uko tayari kuomba?')}
          </h2>
          <p className="mt-1 text-body text-ink-muted">
            {t(
              'Registration and agent sign-in are handled on the same secure page.',
              'Usajili na kuingia kwa wakala hushughulikiwa kwenye ukurasa mmoja salama.',
            )}
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-3 shrink-0">
          <Button variant="accent" size="lg" onClick={onContinueToAgentPortal}>
            {t('Continue to agent registration', 'Endelea kusajiliwa kama wakala')}
          </Button>
          <Button variant="outline" size="lg" onClick={onSignIn}>
            {t('Back to Sign In', 'Rudi kwenye kuingia')}
          </Button>
        </div>
      </section>
    </div>
  );
}
