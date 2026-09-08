import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import VerificationForm from '../../components/VerificationForm';
import ClaimVerificationEvidence from '../../components/ClaimVerificationEvidence';
import { verificationProfiles } from '../verificationProfiles';
import { translations } from '../../types';

describe('verification rendering', () => {
  for (const lang of ['en', 'sw'] as const) {
    it(`renders translated form labels, placeholders and hints in ${lang}`, () => {
      for (const categoryId of Object.keys(verificationProfiles)) {
        const html = renderToStaticMarkup(React.createElement(VerificationForm, {
          lang, categoryId, isSensitiveDocument: true, onSubmit: () => {}, onBack: () => {},
          isConfident: false, setIsConfident: () => {}, ownerIdentifyingDetails: '',
          setOwnerIdentifyingDetails: () => {}, errorMsg: '', isVerifyingClaim: false,
        }));
        expect(html).not.toContain('verify.');
        expect(html).toContain('<form');
      }
    });

    it(`renders every known answer and legacy circumstances in ${lang}`, () => {
      const answers = Object.fromEntries(Object.values(verificationProfiles).flat()
        .map(field => [field.key, `evidence-${field.key}`]));
      const html = renderToStaticMarkup(React.createElement(ClaimVerificationEvidence, {
        lang, answers: { ...answers, lostDetails: 'Legacy circumstances', secret: 'DO-NOT-RENDER' },
        identifyingDetails: 'Private identifying detail',
      }));
      for (const value of Object.values(answers)) expect(html).toContain(value);
      expect(html).toContain(translations[lang].verify.fullName);
      expect(html).toContain('Legacy circumstances');
      expect(html).toContain('Private identifying detail');
      expect(html).not.toContain('DO-NOT-RENDER');
      expect(html).not.toContain('verify.');
    });
  }

  it('omits empty or malformed evidence', () => {
    expect(renderToStaticMarkup(React.createElement(ClaimVerificationEvidence, {
      lang: 'en', answers: { fullName: {}, color: '   ' },
    }))).toBe('');
  });
});