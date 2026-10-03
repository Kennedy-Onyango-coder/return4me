import React from 'react';
import { Globe, Check } from 'lucide-react';
import Button from './ui/Button';

export type AppLanguage = 'en' | 'sw';
export type LanguageControlLayout = 'toggle' | 'choices';
type LanguageControlTheme = 'light' | 'inverse';

interface LanguageControlProps {
  lang: AppLanguage;
  setLang: (lang: AppLanguage) => void;
  layout: LanguageControlLayout;
  /** Existing localized action label for the target language. */
  toggleLabel: string;
  /** Presentation only; does not affect language state or persistence. */
  theme?: LanguageControlTheme;
}

/**
 * Shared English/Kiswahili presentation control for public and authenticated
 * shells. App remains the sole language authority; this component only renders
 * semantic controls and forwards the selected value.
 */
export default function LanguageControl({
  lang,
  setLang,
  layout,
  toggleLabel,
  theme = 'light',
}: LanguageControlProps) {
  const currentLanguage = lang === 'en' ? 'English' : 'Kiswahili';
  const otherLanguage = lang === 'en' ? 'Kiswahili' : 'English';
  const languageNames: Record<AppLanguage, string> = {
    en: 'English',
    sw: 'Kiswahili',
  };

  // UX-02 — the choices layout keeps its keyboard semantics (`<fieldset>` +
  // `<legend>`, `aria-pressed` on each option, a check MARK rather than colour
  // alone) and drops its LOCAL focus treatment: `focus-visible:outline-none` +
  // `ring-2` was the exact duplicate PI-1/C5 (focusContract.test.ts) removed
  // from the shared primitives, and on this bar it stacked a second ring on top
  // of the global `:focus-visible` indicator. Selection now reads from the
  // semantic primary tokens, so the chosen language is legible in the dark
  // theme too, where a raw `bg-primary-green` pill is a dark-on-dark surface.
  if (layout === 'choices') {
    return (
      <fieldset>
        <legend className="mb-2 px-1 text-caption font-bold uppercase tracking-widest text-[var(--appearance-text-muted)]">
          {lang === 'en' ? 'Select language' : 'Chagua lugha'}
        </legend>
        <div className="grid grid-cols-2 gap-2" aria-label={lang === 'en' ? 'Language selection' : 'Uchaguzi wa lugha'}>
          {(['en', 'sw'] as const).map((language) => {
            const active = lang === language;
            return (
              <button
                key={language}
                type="button"
                onClick={() => language === 'en' ? setLang('en') : setLang('sw')}
                aria-pressed={active}
                className={`inline-flex min-h-[44px] items-center justify-center gap-2 rounded-standard border px-3 text-body font-bold transition-colors ${
                  active
                    ? 'border-[var(--appearance-primary)] bg-[var(--appearance-primary)] text-[var(--appearance-primary-foreground)]'
                    : 'border-[var(--appearance-border)] bg-[var(--appearance-surface)] text-[var(--appearance-text-primary)] hover:border-[var(--appearance-primary)] hover:bg-[var(--appearance-surface-muted)]'
                }`}
              >
                {active && <Check size={16} aria-hidden="true" />}
                <span>{languageNames[language]}</span>
                {active && <span className="sr-only"> ({lang === 'en' ? 'current language' : 'lugha ya sasa'})</span>}
              </button>
            );
          })}
        </div>
      </fieldset>
    );
  }

  // UX-02 — the toggle keeps `size="md"` (44px, the touch floor Batch B/C pin),
  // its full visible language name and its exact accessible name; what it no
  // longer carries is a local focus treatment. `outline-none` + `ring-2` was the
  // duplicated indicator PI-1/C5 removed from the shared primitives, and it
  // stacked a second ring on the global `:focus-visible` outline. The inverse
  // (authenticated shell) surface stays correct without it: the global rule
  // repaints the outline white inside `.bg-primary-green`.
  const inverse = theme === 'inverse';
  return (
    <Button
      variant={inverse ? 'inverse' : 'outline'}
      size="md"
      onClick={() => setLang(lang === 'en' ? 'sw' : 'en')}
      aria-label={`${toggleLabel}. Current language: ${currentLanguage}. Switch to ${otherLanguage}.`}
    >
      <Globe size={16} aria-hidden="true" />
      <span>{currentLanguage}</span>
    </Button>
  );
}
