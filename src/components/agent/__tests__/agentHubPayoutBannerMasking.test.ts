import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import AgentHub, { type AgentHubProps } from '../AgentHub';
import { maskPayoutDestinationForLog } from '../../../config/payoutDestinations';

// =============================================================================
// SEC-002 / AGT-006 — THE HUB PROFILE BANNER NEVER SHOWS A FULL PAYOUT NUMBER.
// =============================================================================
// The banner sits on the agent's landing screen: anyone standing at the counter
// can read it, and any screenshot carries it away. The full destination is not
// needed to recognise one's own payout number, so the banner renders the SAME
// canonical masker the settlement executor writes into its audit rows
// (`maskPayoutDestinationForLog`) rather than a second local policy.
//
// These assertions render the REAL hub (react-dom/server) with an agent profile
// carrying a full number, and pin that the masked form is what reaches the
// markup and that neither spelling of the full number does.
// =============================================================================

const RAW_PHONE = '+254712345678';
const MASKED_PHONE = '+254712***678';

/** Every `t.*` lookup resolves to its own key, so copy is never invented here. */
const t: any = new Proxy({}, { get: (_target, key) => (typeof key === 'string' ? key : undefined) });

const baseProps: AgentHubProps = {
  t,
  agentProfile: {
    business_name: 'Umoja Handover Hub',
    location_address: 'Kimathi Street, Nairobi',
    payout_method_type: 'Personal M-Pesa',
    mpesa_till_or_paybill: RAW_PHONE,
  },
  agentEarnings: null,
  expectedDropoffs: [],
  holdingPickups: [],
  queueError: '',
  queueLoading: false,
  retryQueue: () => {},
  dropoffCodeInput: '',
  setDropoffCodeInput: () => {},
  handleLookupDropoff: () => {},
  verifyingItemId: null,
  setVerifyingItemId: () => {},
  openVerificationPanel: () => {},
  verifyCategoryId: '',
  setVerifyCategoryId: () => {},
  verifyName: '',
  setVerifyName: () => {},
  verifyDocNumber: '',
  setVerifyDocNumber: () => {},
  verifyDescription: '',
  setVerifyDescription: () => {},
  verifyFoundArea: '',
  setVerifyFoundArea: () => {},
  verifyPhysicallyChecked: false,
  setVerifyPhysicallyChecked: () => {},
  verifyReason: '',
  setVerifyReason: () => {},
  verifyReasonDetail: '',
  setVerifyReasonDetail: () => {},
  verifyError: '',
  hasCorrections: () => false,
  handleSubmitVerification: () => {},
  categories: [],
  rejectingItemId: null,
  setRejectingItemId: () => {},
  rejectionReason: '',
  setRejectionReason: () => {},
  rejectionCustomText: '',
  setRejectionCustomText: () => {},
  handleRejectDropoff: () => {},
  actionSuccessMsg: '',
  operationError: '',
  setOperationError: () => {},
  actionProcessing: false,
  processingItemId: null,
  handleConfirmViewing: () => {},
  handleConfirmHandover: () => {},
};

const renderHub = (overrides: Partial<AgentHubProps> = {}) =>
  renderToStaticMarkup(React.createElement(AgentHub, { ...baseProps, ...overrides }));

describe('SEC-002 / AGT-006: the Hub profile banner masks the payout destination', () => {
  it('renders the masked destination and never the full phone number', () => {
    const html = renderHub();

    // The banner itself is still shown, with its method label…
    expect(html).toContain('Umoja Handover Hub');
    expect(html).toContain('Payout via Personal M-Pesa');
    // …and the destination is the canonical masked form.
    expect(html).toContain(MASKED_PHONE);

    // Neither a leading-plus nor a bare-digit spelling of the full number
    // reaches the markup, so a screenshot cannot carry the destination away.
    expect(html).not.toContain(RAW_PHONE);
    expect(html).not.toContain('254712345678');
    expect(html).not.toContain('712345678');
  });

  it('masks a stored value without a leading plus just as firmly', () => {
    const html = renderHub({
      agentProfile: { ...baseProps.agentProfile, mpesa_till_or_paybill: '254712345678' },
    });
    expect(html).toContain('254712***678');
    expect(html).not.toContain('254712345678');
    expect(html).not.toContain('712345678');
  });

  it('masks a till number as well, keeping only the last three digits', () => {
    const html = renderHub({
      agentProfile: { ...baseProps.agentProfile, mpesa_till_or_paybill: '1234567' },
    });
    expect(html).toContain('1***567');
    expect(html).not.toContain('1234567');
  });

  it('states a missing destination instead of rendering an empty banner value', () => {
    for (const stored of ['', '   ', null, undefined]) {
      const html = renderHub({
        agentProfile: { ...baseProps.agentProfile, mpesa_till_or_paybill: stored },
      });
      expect(html, String(stored)).toContain('(none)');
    }
  });

  it('masks a value too short to keep three digits safely', () => {
    for (const stored of ['12345', '123456']) {
      const html = renderHub({
        agentProfile: { ...baseProps.agentProfile, mpesa_till_or_paybill: stored },
      });
      // The whole value is masked; no partial number survives.
      expect(html, stored).not.toContain(stored);
      expect(html).toContain('***');
    }
  });
});

describe('the single canonical masker the banner and the executor share', () => {
  it('keeps the first digits and the last three, and fully masks short values', () => {
    expect(maskPayoutDestinationForLog('+254712345678')).toBe('+254712***678');
    expect(maskPayoutDestinationForLog('254712345678')).toBe('254712***678');
    expect(maskPayoutDestinationForLog('1234567')).toBe('1***567');
    expect(maskPayoutDestinationForLog('123456')).toBe('***');
    expect(maskPayoutDestinationForLog('')).toBe('(none)');
    expect(maskPayoutDestinationForLog(null)).toBe('(none)');
    expect(maskPayoutDestinationForLog(undefined)).toBe('(none)');
    // Embedded whitespace cannot split the digits into a readable whole.
    expect(maskPayoutDestinationForLog('254 712 345 678')).toBe('254712***678');
  });
});
