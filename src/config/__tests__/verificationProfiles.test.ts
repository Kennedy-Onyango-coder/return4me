import { describe, it, expect } from 'vitest';
import { verificationProfiles, getVerificationFields } from '../verificationProfiles';
import { translations } from '../../types';

// Regression guard for the category-specific owner verification form
// (src/components/VerificationForm.tsx). The form renders fields purely
// from these declarative profiles, so a typo'd translation key or a
// malformed profile degrades the claim UX silently — these tests make the
// config fail loudly instead. The privacy assertions also pin down the
// most important security property: verification answers are the ONLY
// thing separating a real owner from a fraudster, and the config must
// never ask a document claimant to type out a full document number.

const LANGUAGES = ['en', 'sw'];

// Every i18n key referenced by the profiles must resolve in BOTH languages.
function fieldTranslationKeys(field: { labelKey: string; placeholderKey?: string; helpTextKey?: string }): string[] {
  const keys = [field.labelKey];
  if (field.placeholderKey) keys.push(field.placeholderKey);
  if (field.helpTextKey) keys.push(field.helpTextKey);
  return keys;
}

function resolveVerifyKey(fullKey: string): string | null {
  // Keys are formatted "verify.subKey" — the "verify" prefix is the nested
  // translation block inside each language's entry in src/types.ts.
  if (!fullKey.startsWith('verify.')) return null;
  return fullKey.slice('verify.'.length);
}

describe('verificationProfiles configuration integrity', () => {
  it('defines a non-empty, un-duplicated field set for every configured category (and the fallback)', () => {
    const categoryIds = Object.keys(verificationProfiles);
    expect(categoryIds.length).toBeGreaterThan(0);
    expect(categoryIds).toContain('other-item');

    for (const [categoryId, fields] of Object.entries(verificationProfiles)) {
      expect(fields.length, `${categoryId} must define at least one field`).toBeGreaterThan(0);
      const keys = fields.map(f => f.key);
      expect(new Set(keys).size, `${categoryId} has duplicate field keys`).toBe(keys.length);
    }
  });

  it('every profile has at least one required field (a verification form must always gate on something)', () => {
    for (const [categoryId, fields] of Object.entries(verificationProfiles)) {
      expect(
        fields.some(f => f.required),
        `${categoryId} must require at least one field`,
      ).toBe(true);
    }
  });

  it.each(LANGUAGES)('all label/placeholder/help keys resolve in the %s translation block', (lang) => {
    const verifyBlock = translations[lang].verify as Record<string, string>;
    const missing: string[] = [];

    for (const fields of Object.values(verificationProfiles)) {
      for (const field of fields) {
        for (const fullKey of fieldTranslationKeys(field)) {
          const subKey = resolveVerifyKey(fullKey);
          if (!subKey) {
            missing.push(`${fullKey} (not namespaced under "verify")`);
          } else if (typeof verifyBlock[subKey] !== 'string' || verifyBlock[subKey].trim() === '') {
            missing.push(`${fullKey} (lang=${lang})`);
          }
        }
      }
    }

    expect(missing, `missing or empty translation keys for ${lang}`).toEqual([]);
  });

  it('never asks a document claimant to type a full document number (last 4 digits only, capped, flagged sensitive)', () => {
    for (const [categoryId, fields] of Object.entries(verificationProfiles)) {
      const numberField = fields.find(f => f.key === 'lastDigits');
      if (!numberField) continue;

      // sensitivity + maxLength only make sense on the document-number field
      expect(
        numberField.sensitive,
        `${categoryId}.lastDigits must be marked sensitive (privacy-masked storage)`,
      ).toBe(true);
      expect(
        numberField.maxLength,
        `${categoryId}.lastDigits must cap input at 4 digits`,
      ).toBe(4);
      // It must be required — an empty "last 4 digits" gives no signal
      expect(numberField.required, `${categoryId}.lastDigits must be required`).toBe(true);
    }
  });
});

describe('getVerificationFields category mapping', () => {
  it('returns the vehicle-logbook profile (plate + name, never an ID-number probe)', () => {
    const fields = getVerificationFields('vehicle-logbook');
    expect(fields.map(f => f.key)).toEqual(['plateNumber', 'fullName']);
    expect(fields.some(f => f.key === 'lastDigits')).toBe(false);
  });

  it('returns the national-id profile with a required last-4-digits question', () => {
    const fields = getVerificationFields('national-id');
    const lastDigits = fields.find(f => f.key === 'lastDigits');
    expect(lastDigits?.required).toBe(true);
    expect(lastDigits?.maxLength).toBe(4);
    expect(lastDigits?.sensitive).toBe(true);
  });

  it('asks a laptop claimant for manufacturer details, not document numbers', () => {
    const fields = getVerificationFields('laptop');
    expect(fields.map(f => f.key)).toContain('manufacturer');
    expect(fields.some(f => f.key === 'lastDigits')).toBe(false);
  });

  it('distinguishes a single key (distinctive marks) from a keyring (count)', () => {
    expect(getVerificationFields('single-key').map(f => f.key)).toContain('distinctiveMarks');
    expect(getVerificationFields('single-key').some(f => f.key === 'keyCount')).toBe(false);

    const bunch = getVerificationFields('bunch-of-keys');
    const keyCount = bunch.find(f => f.key === 'keyCount');
    expect(keyCount?.required).toBe(true);
  });

  it('falls back to the other-item profile for unknown categories', () => {
    const fallback = getVerificationFields('made-up-category-id');
    expect(fallback).toBe(verificationProfiles['other-item']);
    expect(fallback.length).toBeGreaterThan(0);
  });
});