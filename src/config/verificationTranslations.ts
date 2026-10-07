import { translations } from '../types';

export function verificationTranslation(key?: string): string {
  if (!key) return '';
  const block: Record<string, string> = translations.en.verify;
  return block[key.replace(/^verify\./, '')] || key;
}