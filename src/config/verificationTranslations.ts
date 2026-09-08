import { translations } from '../types';

export function verificationTranslation(lang: 'en' | 'sw', key?: string): string {
  if (!key) return '';
  const block: Record<string, string> = translations[lang].verify;
  return block[key.replace(/^verify\./, '')] || key;
}