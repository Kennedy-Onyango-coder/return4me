import React from 'react';
import { User, Package, ShieldCheck } from 'lucide-react';
import Button from './ui/Button';
import SectionHeading from './ui/SectionHeading';

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
//                             HTTP-cookie session + phone OTP.
//         Agent            -> the existing agent surface (/agent_portal),
//                             localStorage bearer token + phone OTP.
//   * It does not introduce a second agent registration flow; the agent path
//     opens the existing AgentView, which already contains both "Agent Login"
//     and "Apply to be Agent".

interface SignInViewProps {
  lang: 'en' | 'sw';
  /** Opens the existing customer account surface (/account). */
  onOwnerSignIn: () => void;
  /** Opens the existing agent surface (/agent_portal). */
  onAgentSignIn: () => void;
  /** Opens the public agent journey (Become an Agent). */
  onBecomeAgent: () => void;
}

export default function SignInView({ lang, onOwnerSignIn, onAgentSignIn, onBecomeAgent }: SignInViewProps) {
  const sw = lang === 'sw';
  const t = (en: string, swText: string) => (sw ? swText : en);

  return (
    <div className="max-w-5xl mx-auto px-5 sm:px-8 py-10 sm:py-14 fade-in">
      <SectionHeading
        eyebrow={t('Sign in', 'Ingia')}
        title={t('Sign in to Return4me', 'Ingia kwenye Return4me')}
        description={t(
          'Return4me has two kinds of account. Choose the one that matches you.',
          'Return4me ina aina mbili za akaunti. Chagua inayokufaa.',
        )}
      />

      <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* ── Owner / Claimant ───────────────────────────────────────────── */}
        <section
          className="bg-white border border-line-subtle rounded-2xl p-6 flex flex-col"
          aria-labelledby="signin-owner-title"
        >
          <span className="inline-flex items-center justify-center w-11 h-11 rounded-xl bg-canvas-sunken text-ink">
            <User size={20} aria-hidden="true" />
          </span>
          <h2 id="signin-owner-title" className="mt-4 text-heading font-bold text-ink">
            {t('Owner / Claimant', 'Mmiliki / Mdai')}
          </h2>
          <p className="mt-2 text-body text-ink-muted leading-relaxed">
            {t(
              'For people who lost something, want to claim a found item, or are tracking a claim they already started.',
              'Kwa wale waliopoteza kitu, wanaotaka kudai kitu kilichopatikana, au wanafuatilia dai waliloanzisha.',
            )}
          </p>
          <ul className="mt-4 space-y-2 text-body text-ink-muted">
            {[
              t('Search for a lost item', 'Tafuta kitu kilichopotea'),
              t('Claim a found item you own', 'Dai kitu kilichopatikana ambacho ni chako'),
              t('Track or continue a claim', 'Fuatilia au endeleza dai'),
            ].map((line) => (
              <li key={line} className="flex items-start gap-2">
                <span className="mt-2 inline-block w-1.5 h-1.5 rounded-full bg-accent-orange shrink-0" aria-hidden="true" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
          <div className="mt-6 pt-5 border-t border-line-subtle">
            <Button variant="primary" size="lg" className="w-full" onClick={onOwnerSignIn}>
              {t('Continue as Owner / Claimant', 'Endelea kama Mmiliki / Mdai')}
            </Button>
            <p className="mt-3 text-caption text-ink-muted">
              {t(
                'You sign in with your phone number and a one-time code sent by SMS.',
                'Unaingia kwa nambari yako ya simu na msimbo wa mara moja unaotumwa kwa SMS.',
              )}
            </p>
          </div>
        </section>

        {/* ── Agent ──────────────────────────────────────────────────────── */}
        <section
          className="bg-white border border-line-subtle rounded-2xl p-6 flex flex-col"
          aria-labelledby="signin-agent-title"
        >
          <span className="inline-flex items-center justify-center w-11 h-11 rounded-xl bg-canvas-sunken text-ink">
            <Package size={20} aria-hidden="true" />
          </span>
          <h2 id="signin-agent-title" className="mt-4 text-heading font-bold text-ink">
            {t('Agent', 'Wakala')}
          </h2>
          <p className="mt-2 text-body text-ink-muted leading-relaxed">
            {t(
              'For registered Return4me agents, or anyone applying to become one. Agents receive drop-offs, store items safely and hand them back to verified owners.',
              'Kwa mawakala wa Return4me waliosajiliwa, au wale wanaotaka kuwa wakala. Mawakala hupokea vitu, huvihifadhi salama na kuvikabidhi kwa wamiliki waliothibitishwa.',
            )}
          </p>
          <div className="mt-4 flex items-start gap-2 text-body text-ink-muted">
            <ShieldCheck size={18} className="mt-0.5 shrink-0 text-status-success" aria-hidden="true" />
            <span>
              {t(
                'Agent applications are reviewed and vetted before an account is activated.',
                'Maombi ya wakala hukaguliwa na kuthibitishwa kabla akaunti kuwashwa.',
              )}
            </span>
          </div>
          <div className="mt-6 pt-5 border-t border-line-subtle">
            <Button variant="accent" size="lg" className="w-full" onClick={onAgentSignIn}>
              {t('Continue as Agent', 'Endelea kama Wakala')}
            </Button>
            <p className="mt-3 text-caption text-ink-muted">
              {t(
                'Sign-in and new applications for agents are handled on the same secure page.',
                'Kuingia na maombi mapya ya wakala hushughulikiwa kwenye ukurasa mmoja salama.',
              )}
            </p>
          </div>
        </section>
      </div>

      <div className="mt-8 bg-canvas-sunken border border-line-subtle rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-heading font-bold text-ink">{t('Not an agent yet?', 'Bado si wakala?')}</h2>
          <p className="mt-1 text-body text-ink-muted">
            {t(
              'See what the work involves and what is required before you apply.',
              'Ona kazi inayohusika na kile kinachohitajika kabla ya kuomba.',
            )}
          </p>
        </div>
        <Button variant="outline" size="lg" className="shrink-0" onClick={onBecomeAgent}>
          {t('Become an Agent', 'Kuwa Wakala')}
        </Button>
      </div>
    </div>
  );
}
