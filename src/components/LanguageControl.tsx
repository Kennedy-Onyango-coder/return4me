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

  if (layout === 'choices') {
    return (
      <fieldset>
        <legend className="mb-2 px-1 text-xs font-bold uppercase tracking-widest text-[var(--appearance-text-muted)]">
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
                className={`inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border px-3 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-green focus-visible:ring-offset-2 ${
                  active
                    ? 'border-primary-green bg-primary-green text-white'
                    : 'border-[var(--appearance-border)] bg-[var(--appearance-surface)] text-[var(--appearance-text-primary)] hover:border-primary-green hover:bg-[var(--appearance-surface-muted)]'
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

  const inverse = theme === 'inverse';
  return (
    <Button
      variant={inverse ? 'inverse' : 'outline'}
      size="md"
      onClick={() => setLang(lang === 'en' ? 'sw' : 'en')}
      aria-label={`${toggleLabel}. Current language: ${currentLanguage}. Switch to ${otherLanguage}.`}
      className={inverse
        ? 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-dark-text'
        : 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-green focus-visible:ring-offset-2'}
    >
      <Globe size={16} aria-hidden="true" />
      <span>{currentLanguage}</span>
    </Button>
  );
}
