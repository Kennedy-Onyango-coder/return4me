import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import VerificationForm from '../../components/VerificationForm';
import ClaimVerificationEvidence from '../../components/ClaimVerificationEvidence';
import { verificationProfiles } from '../verificationProfiles';
import { translations } from '../../types';

describe('verification rendering', () => {
  it('renders form labels, placeholders and hints', () => {
    for (const categoryId of Object.keys(verificationProfiles)) {
      const html = renderToStaticMarkup(React.createElement(VerificationForm, {
        categoryId, isSensitiveDocument: true, onSubmit: () => {}, onBack: () => {},
        isConfident: false, setIsConfident: () => {}, ownerIdentifyingDetails: '',
        setOwnerIdentifyingDetails: () => {}, errorMsg: '', isVerifyingClaim: false,
      }));
      expect(html).not.toContain('verify.');
      expect(html).toContain('<form');
    }
  });

  it('renders every known answer and legacy circumstances', () => {
    const answers = Object.fromEntries(Object.values(verificationProfiles).flat()
      .map(field => [field.key, `evidence-${field.key}`]));
    const html = renderToStaticMarkup(React.createElement(ClaimVerificationEvidence, {
      answers: { ...answers, lostDetails: 'Legacy circumstances', secret: 'DO-NOT-RENDER' },
      identifyingDetails: 'Private identifying detail',
    }));
    for (const value of Object.values(answers)) expect(html).toContain(value);
    expect(html).toContain(translations.en.verify.fullName);
    expect(html).toContain('Legacy circumstances');
    expect(html).toContain('Private identifying detail');
    expect(html).not.toContain('DO-NOT-RENDER');
    expect(html).not.toContain('verify.');
  });

  it('omits empty or malformed evidence', () => {
    expect(renderToStaticMarkup(React.createElement(ClaimVerificationEvidence, {
      answers: { fullName: {}, color: '   ' },
    }))).toBe('');
  });
});