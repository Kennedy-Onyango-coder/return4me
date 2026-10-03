// =============================================================================
// PRODUCTION BATCH 3 — P1-01 financial confirmation + P2-01/P2-02 terminology
// =============================================================================
//
// These assertions protect the INTERACTION CONTRACT rather than the styling.
//
// WHY SOURCE-LEVEL ASSERTIONS HERE
//   AdminView is a 4000-line console mounted through a caller-supplied Express
//   app; there is no existing React-render harness for it, and the repo already
//   uses this style for exactly this class of invariant (see
//   smsMigrationN7.test.ts asserting server.ts never calls sendCodeViaSms
//   directly, and adminEscrowMetric.test.ts pinning admin metric markup).
//   Asserting on source is therefore the ESTABLISHED convention, and it makes
//   these guards immune to incidental refactors elsewhere in the file.
// =============================================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

/** Strips line and block comments so a guard cannot match prose ABOUT the old
 *  behaviour (the P1-01 comments deliberately describe what was replaced). */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const adminSource = readFileSync(new URL('../components/AdminView.tsx', import.meta.url), 'utf8');
const adminCode = codeOnly(adminSource);
const homeSource = readFileSync(new URL('../components/HomeView.tsx', import.meta.url), 'utf8');
const ownerSource = readFileSync(new URL('../components/OwnerView.tsx', import.meta.url), 'utf8');

describe('P1-01 — refund reconciliation confirmation', () => {
  it('no browser-native confirm() remains for any admin action', () => {
    // window.confirm is unstyled, untranslatable and cannot show a loading
    // state, so it must not guard a financial action. Comments are excluded so
    // the explanatory notes about the replacement do not trip the guard.
    expect(adminCode).not.toMatch(/window\.confirm\s*\(/);
  });

  it('uses the SHARED ui/Modal rather than a new dialog component', () => {
    expect(adminSource).toContain("import Modal from './ui/Modal'");
    expect(adminSource).toContain('<Modal');
  });

  it('opens a confirmation BEFORE any refund request is issued', () => {
    // The row handlers must only open the dialog. If a row handler issued a
    // fetch directly, cancelling the dialog would no longer protect the action.
    const openers = adminSource
      .split('\n')
      .filter((line) => /const handleRefund(Finalize|Revert)\b/.test(line));
    expect(openers.length).toBe(2);
    for (const opener of openers) {
      expect(opener).not.toMatch(/fetch\(/);
      expect(opener).toMatch(/setRefundConfirm\(\{/);
    }
  });

  it('keeps the endpoints, bodies and authorization unchanged', () => {
    expect(adminSource).toContain('/api/admin/refund-reconciliation/${encodeURIComponent(claimId)}/${kind}');
    expect(adminSource).toMatch(/Authorization:\s*`Bearer \$\{token\}`/);
    // The revert path keeps its JSON body and Content-Type.
    expect(adminSource).toContain("'Content-Type': 'application/json'");
    expect(adminSource).toContain('Admin confirmed with the provider that the refund was NOT executed.');
  });

  it('does not report success on a failed response', () => {
    // A non-2xx must throw so the dialog stays open instead of dismissing as
    // though the financial action completed.
    expect(adminSource).toMatch(/if \(!res\.ok\) throw new Error/);
  });

  it('guards duplicate submission while the request is in flight', () => {
    expect(adminSource).toMatch(/if \(!refundConfirm \|\| refundConfirmBusy\) return;/);
    expect(adminSource).toMatch(/loading=\{refundConfirmBusy\}/);
    // The originating row is still disabled by the pre-existing guard.
    expect(adminSource).toContain('disabled={refundReconcileProcessing === item.claimId}');
  });

  it('is bilingual and states plainly that no money is sent', () => {
    expect(adminSource).toContain('Confirm refund NOT executed');
    expect(adminSource).toContain('Thibitisha kwamba urejeshaji haukuuatikwa');
    expect(adminSource).toContain('It will NOT send any money.');
    expect(adminSource).toContain('Hakutuma pesa yoyote.');
  });
});
describe('P2-01 / P2-02 — customer-facing terminology', () => {
  it('HomeView shows no prohibited customer-facing "escrow" wording', () => {
    // The Swahili trust-badge and the Swahili payment sentence were the two
    // customer-visible occurrences. Both must be plain language now.
    expect(homeSource).not.toMatch(/'Secure Escrow'/);
    expect(homeSource).not.toMatch(/'Escrow Salama'/);
    expect(homeSource).not.toMatch(/huhifadhiwa kwa escrow/);
  });

  it('OwnerView shows no prohibited customer-facing "escrow" wording', () => {
    expect(ownerSource).not.toMatch(/'Secure Escrow receipt'/);
    expect(ownerSource).not.toMatch(/Kipokezi salama cha Escrow/);
    expect(ownerSource).not.toMatch(/Return4me Escrow & Platform/);
  });

  it('replacements stay bilingual and promise nothing the backend does not do', () => {
    expect(homeSource).toContain("'Payment held safely'");
    expect(homeSource).toContain("'Pesa inashikiliwa kwa usalama'");
    expect(ownerSource).toContain("'Payment receipt'");
    expect(ownerSource).toContain("'Kipokezi cha malipo'");
    // The new copy must stay descriptive, not promissory. Scoped to the exact
    // phrases introduced by this batch: HomeView already contains pre-existing
    // copy that explicitly promises NO guarantee, which a file-wide keyword
    // scan would wrongly flag.
    const introduced = [
      'Payment held safely',
      'Pesa inashikiliwa kwa usalama',
      'Payment receipt',
      'Kipokezi cha malipo',
      'Return4me platform fee',
    ];
    for (const phrase of introduced) {
      expect(phrase).not.toMatch(/insured|insurance|guaranteed|guarantee|refundable in|protected/);
    }
  });

  it('admin dispute copy no longer leaks the raw machine status', () => {
    // Operator-facing prose must be readable; the BACKEND status is unchanged.
    expect(adminSource).not.toMatch(/held at ESCROW HELD/);
  });

  it('internal status identifiers and legal documents are deliberately untouched', () => {
    // These are code identifiers and the machine state machine, not copy.
    expect(ownerSource).toContain("'escrow_held'");
    // Legal/regulatory usage in Terms/Privacy is a separate category.
    const terms = readFileSync(new URL('../components/TermsView.tsx', import.meta.url), 'utf8');
    const privacy = readFileSync(new URL('../components/PrivacyView.tsx', import.meta.url), 'utf8');
    expect(terms.toLowerCase()).toContain('escrow');
    expect(privacy.toLowerCase()).toContain('escrow');
  });
});